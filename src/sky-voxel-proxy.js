import { radicalInverse, cosineDirection } from './light-bake.js';

// Sky visibility from a coarse occupancy grid instead of the triangles (#2771). The triangle trace in
// src/floor-sky-visibility.js gives up above the bake's triangle limit and its ray budget grows with the vertex count, so a
// scanned or sculpted file scene (millions of triangles) got no sky occlusion at all and its rooms came out lit by the
// whole sky. Here every triangle marks the cells it passes through, rays march cell by cell, and the result is kept per
// (cell, normal direction): the work grows with the scene's size in cells, not with its triangle or vertex count, so the
// same scene gives the same value whatever its mesh density.

/** The most cells the grid may hold: about 2 MB of occupancy. */
export const PROXY_MAXIMUM_CELLS = 2_000_000;
/** Cosine-weighted rays traced from each (cell, normal direction) pair. */
export const PROXY_RAYS = 32;
/** The fewest (cell, normal direction) pairs a trace may take, however small the scene. */
export const PROXY_MINIMUM_PAIRS = 400_000;
/** The most (cell, normal direction) pairs traced: the ray budget is this times PROXY_RAYS, whatever the triangle count. */
export const PROXY_MAXIMUM_PAIRS = 1_500_000;
// Surface cells are each seen from a few of the normal bins; this many pairs per occupied cell is room for a rough room with props.
const PAIRS_PER_OCCUPIED_CELL = 6;

/**
 * The pair budget of a grid: it grows with the cells the scene occupies, so a large room is not cut off at the cap a small one
 * needs, between PROXY_MINIMUM_PAIRS and PROXY_MAXIMUM_PAIRS (#2771). It reads the grid only, so the same scene gets the same budget.
 */
export function proxyPairBudget(grid) {
  let occupiedCells = 0;
  for (let index = 0; index < grid.occupied.length; index++) occupiedCells += grid.occupied[index];
  return Math.min(PROXY_MAXIMUM_PAIRS, Math.max(PROXY_MINIMUM_PAIRS, occupiedCells * PAIRS_PER_OCCUPIED_CELL));
}
// Normals are grouped on an octahedral map of this many bins a side.
const NORMAL_BINS = 6;
// A ray starts this many cells off the surface so the surface's own cell does not block it.
const START_OFFSET_CELLS = 1.5;
const FIXED_ROTATION = 0.37;

function rejectBadOption(name, value, rule) {
  throw new RangeError(`sky proxy: ${name} must be ${rule}, got ${value}`);
}

/** The world bounds of every vertex of the parts. */
function boundsOfParts(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const { positions } = part.geometry;
    const matrix = part.matrix;
    for (let vertex = 0; vertex < positions.length; vertex += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * positions[vertex] + matrix[4 + axis] * positions[vertex + 1] + matrix[8 + axis] * positions[vertex + 2] + matrix[12 + axis];
        if (value < minimum[axis]) minimum[axis] = value;
        if (value > maximum[axis]) maximum[axis] = value;
      }
    }
  }
  return { minimum, maximum };
}

/** Cubic cells sized so the grid over the bounds holds at most `maximumCells`. */
export function proxyGridLayout(minimum, maximum, maximumCells = PROXY_MAXIMUM_CELLS) {
  if (!(maximumCells >= 8)) rejectBadOption('maximumCells', maximumCells, 'at least 8');
  const spans = [0, 1, 2].map(axis => Math.max(maximum[axis] - minimum[axis], 1e-6));
  let cellSize = Math.cbrt((spans[0] * spans[1] * spans[2]) / maximumCells);
  cellSize = Math.max(cellSize, Math.max(...spans) / 1024);
  let size = spans.map(span => Math.max(1, Math.ceil(span / cellSize)));
  while (size[0] * size[1] * size[2] > maximumCells) {
    cellSize *= 1.05;
    size = spans.map(span => Math.max(1, Math.ceil(span / cellSize)));
  }
  return { minimum: minimum.slice(), cellSize, size };
}

function markPoint(grid, x, y, z, owner) {
  const { minimum, cellSize, size, occupied, owners } = grid;
  const cellX = Math.min(size[0] - 1, Math.max(0, Math.floor((x - minimum[0]) / cellSize)));
  const cellY = Math.min(size[1] - 1, Math.max(0, Math.floor((y - minimum[1]) / cellSize)));
  const cellZ = Math.min(size[2] - 1, Math.max(0, Math.floor((z - minimum[2]) / cellSize)));
  const cell = (cellZ * size[1] + cellY) * size[0] + cellX;
  occupied[cell] = 1;
  if (owners) owners[cell] = owner;
}

// Marks every cell a triangle passes through, sampled at half a cell so the marked cells touch one another.
function markTriangle(grid, corners, owner) {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = corners;
  const longest = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - bx, cy - by, cz - bz), Math.hypot(ax - cx, ay - cy, az - cz));
  const steps = Math.max(1, Math.ceil(longest / (grid.cellSize * 0.5)));
  for (let first = 0; first <= steps; first++) {
    for (let second = 0; second <= steps - first; second++) {
      const weightB = first / steps;
      const weightC = second / steps;
      const weightA = 1 - weightB - weightC;
      markPoint(grid, weightA * ax + weightB * bx + weightC * cx, weightA * ay + weightB * by + weightC * cy, weightA * az + weightB * bz + weightC * cz, owner);
    }
  }
}

/**
 * The occupancy grid of the parts' opaque triangles. `maximumCells` bounds its memory; the cell size follows the scene's
 * bounds, so a larger scene gets coarser cells and the same build time. With `recordOwners` the grid also keeps, per cell,
 * the index of the last part in `parts` that marked it plus one (`grid.owners`, 0 where empty), for the sun bounce's albedo.
 */
export function buildOccupancyGrid(parts, { maximumCells = PROXY_MAXIMUM_CELLS, recordOwners = false } = {}) {
  if (!Array.isArray(parts) || parts.length === 0) rejectBadOption('parts', parts, 'a non-empty array of parts');
  const { minimum, maximum } = boundsOfParts(parts);
  const layout = proxyGridLayout(minimum, maximum, maximumCells);
  const cellCount = layout.size[0] * layout.size[1] * layout.size[2];
  const grid = { ...layout, occupied: new Uint8Array(cellCount), owners: recordOwners ? new Int32Array(cellCount) : null };
  const corners = new Float64Array(9);
  for (const [partIndex, part] of parts.entries()) {
    const { positions, indices } = part.geometry;
    const matrix = part.matrix;
    const triangleCount = indices ? indices.length / 3 : positions.length / 9;
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      for (let slot = 0; slot < 3; slot++) {
        const vertex = indices ? indices[triangle * 3 + slot] : triangle * 3 + slot;
        const x = positions[vertex * 3];
        const y = positions[vertex * 3 + 1];
        const z = positions[vertex * 3 + 2];
        for (let axis = 0; axis < 3; axis++) corners[slot * 3 + axis] = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
      }
      markTriangle(grid, corners, partIndex + 1);
    }
  }
  return grid;
}

/** True when a ray from (x, y, z) along the unit direction leaves the grid without entering an occupied cell. */
export function rayEscapes(grid, x, y, z, directionX, directionY, directionZ) {
  return rayHitDistance(grid, x, y, z, directionX, directionY, directionZ) === Infinity;
}

/**
 * How far a ray from (x, y, z) along the unit direction goes before it enters an occupied cell, or Infinity when it leaves
 * the grid first (what `rayEscapes` tests). The distance is to the cell's face, to within a cell.
 */
export function rayHitDistance(grid, x, y, z, directionX, directionY, directionZ) {
  const { minimum, cellSize, size, occupied } = grid;
  let cellX = Math.floor((x - minimum[0]) / cellSize);
  let cellY = Math.floor((y - minimum[1]) / cellSize);
  let cellZ = Math.floor((z - minimum[2]) / cellSize);
  const stepX = directionX > 0 ? 1 : -1;
  const stepY = directionY > 0 ? 1 : -1;
  const stepZ = directionZ > 0 ? 1 : -1;
  const deltaX = directionX !== 0 ? Math.abs(cellSize / directionX) : Infinity;
  const deltaY = directionY !== 0 ? Math.abs(cellSize / directionY) : Infinity;
  const deltaZ = directionZ !== 0 ? Math.abs(cellSize / directionZ) : Infinity;
  const boundaryX = minimum[0] + (cellX + (stepX > 0 ? 1 : 0)) * cellSize;
  const boundaryY = minimum[1] + (cellY + (stepY > 0 ? 1 : 0)) * cellSize;
  const boundaryZ = minimum[2] + (cellZ + (stepZ > 0 ? 1 : 0)) * cellSize;
  let nextX = directionX !== 0 ? (boundaryX - x) / directionX : Infinity;
  let nextY = directionY !== 0 ? (boundaryY - y) / directionY : Infinity;
  let nextZ = directionZ !== 0 ? (boundaryZ - z) / directionZ : Infinity;
  let travelled = 0;
  for (;;) {
    const inside = cellX >= 0 && cellY >= 0 && cellZ >= 0 && cellX < size[0] && cellY < size[1] && cellZ < size[2];
    if (inside && occupied[(cellZ * size[1] + cellY) * size[0] + cellX]) return travelled;
    if (nextX < nextY && nextX < nextZ) {
      travelled = nextX;
      cellX += stepX;
      nextX += deltaX;
    } else if (nextY < nextZ) {
      travelled = nextY;
      cellY += stepY;
      nextY += deltaY;
    } else {
      travelled = nextZ;
      cellZ += stepZ;
      nextZ += deltaZ;
    }
    // Once a ray is outside the grid and moving away on that axis it cannot come back.
    if ((cellX < 0 && stepX < 0) || (cellX >= size[0] && stepX > 0)) return Infinity;
    if ((cellY < 0 && stepY < 0) || (cellY >= size[1] && stepY > 0)) return Infinity;
    if ((cellZ < 0 && stepZ < 0) || (cellZ >= size[2] && stepZ > 0)) return Infinity;
  }
}

// Octahedral bin of a unit normal, and the unit normal at that bin's centre.
function normalBin(x, y, z) {
  const total = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / total;
  let v = z / total;
  if (y < 0) {
    const foldedU = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    const foldedV = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    u = foldedU;
    v = foldedV;
  }
  const column = Math.min(NORMAL_BINS - 1, Math.floor(((u + 1) / 2) * NORMAL_BINS));
  const row = Math.min(NORMAL_BINS - 1, Math.floor(((v + 1) / 2) * NORMAL_BINS));
  return row * NORMAL_BINS + column;
}

function binNormal(bin, out) {
  let u = ((bin % NORMAL_BINS) + 0.5) / NORMAL_BINS * 2 - 1;
  let v = (Math.floor(bin / NORMAL_BINS) + 0.5) / NORMAL_BINS * 2 - 1;
  let y = 1 - Math.abs(u) - Math.abs(v);
  if (y < 0) {
    const unfoldedU = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    const unfoldedV = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    u = unfoldedU;
    v = unfoldedV;
  }
  const length = Math.hypot(u, y, v) || 1;
  out[0] = u / length;
  out[1] = y / length;
  out[2] = v / length;
  return out;
}

function fixedSamples(rays) {
  return Array.from({ length: rays }, (unused, sample) => [(sample + 0.5) / rays, (radicalInverse(sample) + FIXED_ROTATION) % 1]);
}

/**
 * A lookup of sky visibility by world point and normal over `grid`. Each (cell, normal bin) pair is traced once, from the
 * cell's centre, by `rays` cosine rays; `maximumPairs` bounds the total work, and `lookup` returns null once it is spent so
 * the caller can report it instead of tracing on.
 */
export function createSkyProxy(grid, { rays = PROXY_RAYS, maximumPairs = proxyPairBudget(grid) } = {}) {
  if (!(rays >= 1 && rays <= 1024)) rejectBadOption('rays', rays, 'between 1 and 1024');
  const samples = fixedSamples(rays);
  const cache = new Map();
  const normal = [0, 0, 0];
  const direction = [0, 0, 0];
  const { minimum, cellSize, size } = grid;
  let pairs = 0;
  function trace(cellX, cellY, cellZ, bin) {
    binNormal(bin, normal);
    const offset = START_OFFSET_CELLS * cellSize;
    const originX = minimum[0] + (cellX + 0.5) * cellSize + normal[0] * offset;
    const originY = minimum[1] + (cellY + 0.5) * cellSize + normal[1] * offset;
    const originZ = minimum[2] + (cellZ + 0.5) * cellSize + normal[2] * offset;
    let escaped = 0;
    for (const [firstUnit, secondUnit] of samples) {
      cosineDirection(normal, firstUnit, secondUnit, direction);
      if (rayEscapes(grid, originX, originY, originZ, direction[0], direction[1], direction[2])) escaped++;
    }
    return escaped / rays;
  }
  function lookup(x, y, z, normalX, normalY, normalZ) {
    const cellX = Math.min(size[0] - 1, Math.max(0, Math.floor((x - minimum[0]) / cellSize)));
    const cellY = Math.min(size[1] - 1, Math.max(0, Math.floor((y - minimum[1]) / cellSize)));
    const cellZ = Math.min(size[2] - 1, Math.max(0, Math.floor((z - minimum[2]) / cellSize)));
    const bin = normalBin(normalX, normalY, normalZ);
    const key = ((cellZ * size[1] + cellY) * size[0] + cellX) * NORMAL_BINS * NORMAL_BINS + bin;
    let value = cache.get(key);
    if (value === undefined) {
      if (pairs >= maximumPairs) return null;
      pairs++;
      value = trace(cellX, cellY, cellZ, bin);
      cache.set(key, value);
    }
    return value;
  }
  return { lookup, get pairs() { return pairs; }, get rays() { return pairs * rays; } };
}

/**
 * Per-vertex sky visibility of one geometry placed by `matrix`, read from `proxy`. Returns the Float32Array, or null when
 * the proxy's pair budget ran out part way.
 */
export function geometrySkyVisibility(proxy, geometry, matrix, strength = 1) {
  const { positions, normals } = geometry;
  const vertexCount = positions.length / 3;
  const visibility = new Float32Array(vertexCount);
  const normalMatrix = matrix;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    const worldX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    const worldY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    const worldZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    const normalX = normals[vertex * 3];
    const normalY = normals[vertex * 3 + 1];
    const normalZ = normals[vertex * 3 + 2];
    let worldNormalX = normalMatrix[0] * normalX + normalMatrix[4] * normalY + normalMatrix[8] * normalZ;
    let worldNormalY = normalMatrix[1] * normalX + normalMatrix[5] * normalY + normalMatrix[9] * normalZ;
    let worldNormalZ = normalMatrix[2] * normalX + normalMatrix[6] * normalY + normalMatrix[10] * normalZ;
    const length = Math.hypot(worldNormalX, worldNormalY, worldNormalZ) || 1;
    worldNormalX /= length;
    worldNormalY /= length;
    worldNormalZ /= length;
    const share = proxy.lookup(worldX, worldY, worldZ, worldNormalX, worldNormalY, worldNormalZ);
    if (share === null) return null;
    visibility[vertex] = 1 - strength * (1 - share);
  }
  return visibility;
}
