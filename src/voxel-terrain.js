// Voxel terrain to smooth terrain: a grid of cells, each with an occupancy and a material, becomes a land mesh whose
// vertices carry a blended material colour, plus a water mesh. The occupancy is blurred into a signed field and meshed
// by surface nets (surface-nets.js), so slopes and banks come out smooth instead of stepped. Plain arithmetic in a fixed
// order, so the same input gives the same bytes.

import { placeCellVertices, quadsAroundEdges, splitSaddleVertices } from './surface-nets.js';
import { invalidField } from './field-error.js';

export const VOXEL_TERRAIN_LIMITS = Object.freeze({ maxCellsPerAxis: 512, maxCells: 16_777_216, maxCellSize: 1000, maxSmoothing: 4, defaultSmoothing: 1 });

// Linear RGB colour multipliers. `variation` is how strongly the brightness wanders from cell to cell.
export const VOXEL_TERRAIN_LOOKS = Object.freeze({
  grass: Object.freeze({ color: [0.085, 0.27, 0.04], variation: 0.22 }),
  rock: Object.freeze({ color: [0.2, 0.19, 0.18], variation: 0.38 }),
  sand: Object.freeze({ color: [0.5, 0.38, 0.19], variation: 0.2 }),
  dirt: Object.freeze({ color: [0.2, 0.11, 0.055], variation: 0.2 }),
  snow: Object.freeze({ color: [0.82, 0.86, 0.9], variation: 0.06 }),
  water: Object.freeze({ color: [0.02, 0.2, 0.24], variation: 0 }),
});
const DEFAULT_PALETTE = Object.freeze(['grass', 'rock', 'sand', 'water']);
const WATER_NAME = 'water';
const WATER_DROP = 0.3;
const WETNESS_THRESHOLD = 0.08;
const WATER_MINIMUM_UP = 0.6;
const LAND_MATERIAL = Object.freeze({ tag: 'surface', color: [1, 1, 1], metallic: 0, roughness: 0.92, emission: 0 });
const WATER_MATERIAL = Object.freeze({ tag: 'water', color: [0.02, 0.2, 0.24], metallic: 0.2, roughness: 0.06, emission: 0 });
const EDGE_MODES = ['open', 'closed'];
const SADDLE_FIX_HINT = 'Raise smoothing, or fill the single-cell diagonal contact in the occupancy.';
// Closed edges: the side walls and base get one flat earth colour (linear RGB), cut hard from the top surface colours.
const BOUNDARY_SNAP = 0.25;
const BANK_RUN = 2;
const LEVEL_BUCKET = 0.02;
const WALL_COLOR = Object.freeze([0.2, 0.062, 0.016]);
const COLOR_BLUR_PASSES = 3;
const COLOR_SHARPNESS = 4;
const COLOR_WINDOW = 2;
const COLOR_KERNEL_RADIUS = 1.5;
const COLOR_FALLBACK_RADIUS = 3;

/** Reads and checks the input once. Every error names the field, what was received and what to pass. */
export function normalizeVoxelTerrain(input) {
  if (input === null || typeof input !== 'object') throw invalidField('voxelTerrain', input, 'an object with grid, cellSize, occupancy and materials');
  const grid = gridOf(input.grid);
  const cellCount = grid[0] * grid[1] * grid[2];
  const cellSize = input.cellSize ?? 1;
  if (!Number.isFinite(cellSize) || cellSize <= 0 || cellSize > VOXEL_TERRAIN_LIMITS.maxCellSize) {
    throw invalidField('cellSize', input.cellSize, `a number above 0 and at most ${VOXEL_TERRAIN_LIMITS.maxCellSize}, such as 4`);
  }
  const palette = paletteOf(input.palette ?? DEFAULT_PALETTE, input.looks);
  const origin = input.origin ?? [0, 0, 0];
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite)) throw invalidField('origin', input.origin, 'three numbers, the world position of the grid minimum corner, such as [0, 0, 0]');
  const smoothing = input.smoothing ?? VOXEL_TERRAIN_LIMITS.defaultSmoothing;
  if (!Number.isInteger(smoothing) || smoothing < 0 || smoothing > VOXEL_TERRAIN_LIMITS.maxSmoothing) {
    throw invalidField('smoothing', input.smoothing, `a whole number from 0 to ${VOXEL_TERRAIN_LIMITS.maxSmoothing}`);
  }
  const edges = input.edges ?? 'open';
  if (!EDGE_MODES.includes(edges)) throw invalidField('edges', input.edges, `one of ${EDGE_MODES.join(', ')}`);
  checkOccupancy(input.occupancy, cellCount, grid);
  checkMaterials(input.materials, cellCount, grid, palette.names.length);
  return { grid, cellSize, palette, origin, smoothing, edges, occupancy: input.occupancy, materials: input.materials };
}

function gridOf(value) {
  const message = `three whole numbers from 2 to ${VOXEL_TERRAIN_LIMITS.maxCellsPerAxis} (cells along x, y, z; y is up), such as [256, 64, 256]`;
  if (!Array.isArray(value) || value.length !== 3) throw invalidField('grid', value, message);
  for (const count of value) {
    if (!Number.isInteger(count) || count < 2 || count > VOXEL_TERRAIN_LIMITS.maxCellsPerAxis) throw invalidField('grid', value, message);
  }
  if (value[0] * value[1] * value[2] > VOXEL_TERRAIN_LIMITS.maxCells) {
    throw invalidField('grid', value, `a grid of at most ${VOXEL_TERRAIN_LIMITS.maxCells} cells in all; split the landscape into tiles`);
  }
  return value;
}

function paletteOf(names, looks) {
  if (!Array.isArray(names) || names.length < 1 || names.length > 255 || !names.every(name => typeof name === 'string')) {
    throw invalidField('palette', names, 'a list of 1 to 255 material names, such as ["grass", "rock", "sand", "water"]');
  }
  if (new Set(names).size !== names.length) throw invalidField('palette', names, 'material names that each appear once');
  const known = { ...VOXEL_TERRAIN_LOOKS, ...(looks ?? {}) };
  const resolved = names.map(name => {
    const look = known[name];
    const valid = look && Array.isArray(look.color) && look.color.length === 3 && look.color.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1);
    if (!valid) throw invalidField(`palette["${name}"]`, name, `one of ${Object.keys(VOXEL_TERRAIN_LOOKS).join(', ')}, or a name with looks.${name} = { color: [r, g, b] } in 0 to 1`);
    return { color: look.color, variation: Number.isFinite(look.variation) ? look.variation : 0.15 };
  });
  return { names, looks: resolved, waterIndex: names.indexOf(WATER_NAME) };
}

function checkOccupancy(occupancy, cellCount, grid) {
  const hint = `an array of ${cellCount} numbers from 0 (empty) to 1 (full), x fastest, then y, then z (grid ${grid.join('x')})`;
  if (!ArrayBuffer.isView(occupancy) && !Array.isArray(occupancy)) throw invalidField('occupancy', occupancy, hint);
  if (occupancy.length !== cellCount) throw invalidField('occupancy.length', occupancy.length, hint);
  for (let cell = 0; cell < cellCount; cell++) {
    const value = occupancy[cell];
    if (!(value >= 0 && value <= 1)) throw invalidField(`occupancy[${cell}]`, value, 'a number from 0 (empty) to 1 (full)');
  }
}

function checkMaterials(materials, cellCount, grid, paletteSize) {
  const hint = `an array of ${cellCount} palette indexes, one per cell, in the same order as occupancy (grid ${grid.join('x')})`;
  if (!ArrayBuffer.isView(materials) && !Array.isArray(materials)) throw invalidField('materials', materials, hint);
  if (materials.length !== cellCount) throw invalidField('materials.length', materials.length, hint);
  for (let cell = 0; cell < cellCount; cell++) {
    const index = materials[cell];
    if (!Number.isInteger(index) || index < 0 || index >= paletteSize) throw invalidField(`materials[${cell}]`, index, `a whole number from 0 to ${paletteSize - 1}, an index into palette`);
  }
}

// The padded grid holds one extra cell on every side so the surface reaches the bounds: replicated for open edges,
// empty for closed ones. Padded index (x, y, z) is cell (x - 1, y - 1, z - 1).
function paddedLayout(grid) {
  const dims = grid.map(count => count + 2);
  return { dims, total: dims[0] * dims[1] * dims[2] };
}

function cellIndexOf(grid, x, y, z) {
  return (z * grid[1] + y) * grid[0] + x;
}

function clampIndex(value, count) {
  return Math.min(count - 1, Math.max(0, value));
}

function paddedField(grid, layout, edges, valueOfCell) {
  const [dimsX, dimsY, dimsZ] = layout.dims;
  const field = new Float32Array(layout.total);
  let cursor = 0;
  for (let z = 0; z < dimsZ; z++) {
    for (let y = 0; y < dimsY; y++) {
      for (let x = 0; x < dimsX; x++) {
        const inside = x > 0 && x <= grid[0] && y > 0 && y <= grid[1] && z > 0 && z <= grid[2];
        if (inside || edges === 'open') {
          const cell = cellIndexOf(grid, clampIndex(x - 1, grid[0]), clampIndex(y - 1, grid[1]), clampIndex(z - 1, grid[2]));
          field[cursor] = valueOfCell(cell);
        }
        cursor++;
      }
    }
  }
  return field;
}

// One pass of [1, 2, 1] / 4 along each axis, edges clamped.
function blurField(field, dims, passes) {
  let source = field;
  for (let pass = 0; pass < passes; pass++) {
    for (let axis = 0; axis < 3; axis++) source = blurAlong(source, dims, axis);
  }
  return source;
}

function blurAlong(source, dims, axis) {
  const stride = axis === 0 ? 1 : axis === 1 ? dims[0] : dims[0] * dims[1];
  const count = dims[axis];
  const target = new Float32Array(source.length);
  for (let index = 0; index < source.length; index++) {
    const along = Math.floor(index / stride) % count;
    const before = along > 0 ? source[index - stride] : source[index];
    const after = along < count - 1 ? source[index + stride] : source[index];
    target[index] = 0.25 * before + 0.5 * source[index] + 0.25 * after;
  }
  return target;
}

function signedDistancesOf(blurred) {
  const distances = new Float32Array(blurred.length);
  for (let index = 0; index < blurred.length; index++) distances[index] = 0.5 - blurred[index];
  return distances;
}

/** Surface nets on one padded field. Returns double-precision positions and quads. */
function meshField(distances, layout, cellSize, paddedOrigin) {
  const grid = { points: layout.dims, edge: cellSize };
  const { cellVertex, positions: cellPositions } = placeCellVertices(distances, grid, paddedOrigin);
  const insidePoints = [];
  const outsidePoints = [];
  const builtQuads = quadsAroundEdges(distances, grid, cellVertex, insidePoints, outsidePoints);
  const split = splitSaddleVertices(builtQuads, insidePoints, cellPositions, outsidePoints, SADDLE_FIX_HINT);
  return { quads: split.quads, positions: split.positions };
}

/** Keeps the quads that pass `keep`, renumbers the vertices they use in first-use order and triangulates them. */
function compactMesh(mesh, keep) {
  const remap = new Map();
  const positions = [];
  const indices = [];
  const gap = (first, second) => {
    let total = 0;
    for (let axis = 0; axis < 3; axis++) {
      const difference = mesh.positions[first * 3 + axis] - mesh.positions[second * 3 + axis];
      total += difference * difference;
    }
    return total;
  };
  const renumber = vertex => {
    if (!remap.has(vertex)) {
      remap.set(vertex, remap.size);
      positions.push(mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]);
    }
    return remap.get(vertex);
  };
  mesh.quads.forEach((quad, quadIndex) => {
    if (!keep(quadIndex)) return;
    const [first, second, third, fourth] = quad.map(renumber);
    const oldGap = (a, b) => gap(quad[a], quad[b]);
    if (oldGap(0, 2) <= oldGap(1, 3)) indices.push(first, second, third, first, third, fourth);
    else indices.push(first, second, fourth, second, third, fourth);
  });
  return { positions, indices: Uint32Array.from(indices) };
}

function pointOf(positions, vertex, cellSize, paddedOrigin) {
  return [0, 1, 2].map(axis => (positions[vertex * 3 + axis] - paddedOrigin[axis]) / cellSize);
}

function sampleField(field, layout, point) {
  const [dimsX, dimsY, dimsZ] = layout.dims;
  const base = point.map((value, axis) => clampIndex(Math.floor(value), layout.dims[axis] - 1));
  const fraction = point.map((value, axis) => Math.min(1, Math.max(0, value - base[axis])));
  let total = 0;
  for (let corner = 0; corner < 8; corner++) {
    const offsetX = corner & 1;
    const offsetY = (corner >> 1) & 1;
    const offsetZ = (corner >> 2) & 1;
    const weight = (offsetX ? fraction[0] : 1 - fraction[0]) * (offsetY ? fraction[1] : 1 - fraction[1]) * (offsetZ ? fraction[2] : 1 - fraction[2]);
    total += weight * field[(clampIndex(base[2] + offsetZ, dimsZ) * dimsY + clampIndex(base[1] + offsetY, dimsY)) * dimsX + clampIndex(base[0] + offsetX, dimsX)];
  }
  return total;
}

function trilinearGradient(blurred, layout, point) {
  const [dimsX, dimsY, dimsZ] = layout.dims;
  const base = point.map((value, axis) => clampIndex(Math.floor(value), layout.dims[axis] - 1));
  const fraction = point.map((value, axis) => Math.min(1, Math.max(0, value - base[axis])));
  const at = (x, y, z) => blurred[(clampIndex(z, dimsZ) * dimsY + clampIndex(y, dimsY)) * dimsX + clampIndex(x, dimsX)];
  const gradient = [0, 0, 0];
  for (let corner = 0; corner < 8; corner++) {
    const offsetX = corner & 1;
    const offsetY = (corner >> 1) & 1;
    const offsetZ = (corner >> 2) & 1;
    const weight = (offsetX ? fraction[0] : 1 - fraction[0]) * (offsetY ? fraction[1] : 1 - fraction[1]) * (offsetZ ? fraction[2] : 1 - fraction[2]);
    if (weight === 0) continue;
    const x = base[0] + offsetX;
    const y = base[1] + offsetY;
    const z = base[2] + offsetZ;
    // The field is 0.5 - blurred, so the outward direction is minus the blurred gradient.
    gradient[0] -= weight * (at(x + 1, y, z) - at(x - 1, y, z));
    gradient[1] -= weight * (at(x, y + 1, z) - at(x, y - 1, z));
    gradient[2] -= weight * (at(x, y, z + 1) - at(x, y, z - 1));
  }
  const length = Math.hypot(...gradient) || 1;
  return gradient.map(component => component / length);
}

function normalsOf(positions, blurred, layout, cellSize, paddedOrigin) {
  const normals = new Float32Array(positions.length);
  const point = [0, 0, 0];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    for (let axis = 0; axis < 3; axis++) point[axis] = (positions[vertex * 3 + axis] - paddedOrigin[axis]) / cellSize;
    normals.set(trilinearGradient(blurred, layout, point), vertex * 3);
  }
  return normals;
}

function planarUvs(positions) {
  const uvs = new Float32Array(positions.length / 3 * 2);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    uvs[vertex * 2] = positions[vertex * 3];
    uvs[vertex * 2 + 1] = positions[vertex * 3 + 2];
  }
  return uvs;
}

// Integer hash to [0, 1): deterministic, no state.
function hashUnit(x, y, z) {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

function smoothUnit(fraction) {
  return fraction * fraction * (3 - 2 * fraction);
}

// Value noise over cell coordinates: smooth brightness drift so flat ground reads as ground.
function valueNoise(x, y, z, frequency) {
  const scaled = [x * frequency, y * frequency, z * frequency];
  const base = scaled.map(Math.floor);
  const fraction = scaled.map((value, axis) => smoothUnit(value - base[axis]));
  let total = 0;
  for (let corner = 0; corner < 8; corner++) {
    const offsets = [corner & 1, (corner >> 1) & 1, (corner >> 2) & 1];
    const weight = offsets.reduce((product, offset, axis) => product * (offset ? fraction[axis] : 1 - fraction[axis]), 1);
    total += weight * hashUnit(base[0] + offsets[0], base[1] + offsets[1], base[2] + offsets[2]);
  }
  return total;
}

/**
 * A smooth weight per land material at every vertex. Each material's occupancy is blurred over a few cells and sampled
 * between cells, so a border between two materials is a smooth curve whatever the cell grid does (a diagonal border is a
 * diagonal line, not a staircase); the weights are then sharpened so the blend between two materials stays about a cell wide.
 * Returns the materials present and, per vertex, their normalised weights (all 0 where no land is near).
 */
function smoothMaterialWeights(positions, input, layout, paddedOrigin) {
  const { grid, cellSize, palette, occupancy, materials } = input;
  const present = [];
  const seen = new Uint8Array(palette.names.length);
  for (let cell = 0; cell < materials.length; cell++) {
    if (occupancy[cell] > 0 && materials[cell] !== palette.waterIndex && !seen[materials[cell]]) {
      seen[materials[cell]] = 1;
      present.push(materials[cell]);
    }
  }
  const vertexCount = positions.length / 3;
  const weights = new Float32Array(vertexCount * present.length);
  present.forEach((material, slot) => {
    const field = paddedField(grid, layout, 'open', cell => (materials[cell] === material ? occupancy[cell] : 0));
    const blurred = blurField(field, layout.dims, COLOR_BLUR_PASSES);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      weights[vertex * present.length + slot] = sampleField(blurred, layout, pointOf(positions, vertex, cellSize, paddedOrigin));
    }
  });
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let total = 0;
    for (let slot = 0; slot < present.length; slot++) {
      const sharpened = weights[vertex * present.length + slot] ** COLOR_SHARPNESS;
      weights[vertex * present.length + slot] = sharpened;
      total += sharpened;
    }
    for (let slot = 0; slot < present.length; slot++) weights[vertex * present.length + slot] = total > 1e-12 ? weights[vertex * present.length + slot] / total : 0;
  }
  return { present, weights };
}

/** Material weights around a vertex, from the smooth per-material fields; the cells near the vertex are the fallback. */
function vertexColors(positions, input, layout, paddedOrigin) {
  const { grid, cellSize, palette, occupancy, materials } = input;
  const colors = new Float32Array(positions.length);
  const dominant = new Uint8Array(positions.length / 3);
  const weights = new Float64Array(palette.names.length);
  const smooth = smoothMaterialWeights(positions, input, layout, paddedOrigin);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const cellPosition = [0, 1, 2].map(axis => (positions[vertex * 3 + axis] - paddedOrigin[axis]) / cellSize - 1);
    weights.fill(0);
    let total = 0;
    smooth.present.forEach((material, slot) => {
      weights[material] = smooth.weights[vertex * smooth.present.length + slot];
      total += weights[material];
    });
    if (total <= 1e-6) {
      weights.fill(0);
      total = accumulateWeights(weights, cellPosition, COLOR_KERNEL_RADIUS, input);
    }
    if (total <= 1e-6) total = accumulateWeights(weights, cellPosition, COLOR_FALLBACK_RADIUS, input);
    const color = [0, 0, 0];
    let variation = 0;
    const strongest = strongestIndex(weights);
    for (let index = 0; index < weights.length; index++) {
      const share = total > 0 ? weights[index] / total : (index === strongest ? 1 : 0);
      for (let channel = 0; channel < 3; channel++) color[channel] += share * palette.looks[index].color[channel];
      variation += share * palette.looks[index].variation;
    }
    const world = [0, 1, 2].map(axis => positions[vertex * 3 + axis]);
    const drift = (valueNoise(world[0] / cellSize, world[1] / cellSize, world[2] / cellSize, 0.35) - 0.5) * 2
      + (valueNoise(world[0] / cellSize, world[1] / cellSize, world[2] / cellSize, 1.7) - 0.5);
    const brightness = Math.max(0.2, 1 + variation * drift);
    for (let channel = 0; channel < 3; channel++) colors[vertex * 3 + channel] = Math.min(1, color[channel] * brightness);
    dominant[vertex] = strongest;
  }
  return { colors, dominant };
}

function strongestIndex(weights) {
  let strongest = 0;
  for (let index = 1; index < weights.length; index++) {
    if (weights[index] > weights[strongest]) strongest = index;
  }
  return strongest;
}

function accumulateWeights(weights, cellPosition, radius, { grid, palette, occupancy, materials }) {
  const centre = cellPosition.map(Math.round);
  let total = 0;
  for (let z = centre[2] - COLOR_WINDOW; z <= centre[2] + COLOR_WINDOW; z++) {
    for (let y = centre[1] - COLOR_WINDOW; y <= centre[1] + COLOR_WINDOW; y++) {
      for (let x = centre[0] - COLOR_WINDOW; x <= centre[0] + COLOR_WINDOW; x++) {
        const distance = Math.hypot(x - cellPosition[0], y - cellPosition[1], z - cellPosition[2]);
        if (distance >= radius) continue;
        const cell = cellIndexOf(grid, clampIndex(x, grid[0]), clampIndex(y, grid[1]), clampIndex(z, grid[2]));
        const material = materials[cell];
        if (material === palette.waterIndex || occupancy[cell] <= 0) continue;
        const weight = occupancy[cell] * (radius - distance);
        weights[material] += weight;
        total += weight;
      }
    }
  }
  return total;
}

function identityMatrix() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function geometryOf(compact, normals, uvs, colors = null) {
  const geometry = { positions: Float32Array.from(compact.positions), normals, uvs, indices: compact.indices };
  if (colors) geometry.colors = colors;
  return geometry;
}

// The padding cells lie half a cell outside the grid, so the outermost vertices can sit up to half a cell beyond it.
// They are pressed onto the boundary, which keeps the mesh inside the grid bounds. A vertex that falls just short of a
// side (within a quarter cell, along x or z) is pressed onto it too, so the boundary of the surface lies exactly on the box.
function clampToBounds(positions, { grid, cellSize, origin }) {
  for (let offset = 0; offset < positions.length; offset++) {
    const axis = offset % 3;
    const low = origin[axis];
    const high = origin[axis] + grid[axis] * cellSize;
    positions[offset] = Math.min(high, Math.max(low, positions[offset]));
    if (axis === 1) continue;
    if (positions[offset] - low <= BOUNDARY_SNAP * cellSize) positions[offset] = low;
    else if (high - positions[offset] <= BOUNDARY_SNAP * cellSize) positions[offset] = high;
  }
}

// The sides of the grid box a wall can stand on: [axis, 0 for the low side or 1 for the high side].
const WALL_SIDES = Object.freeze([[0, 0], [0, 1], [2, 0], [2, 1]]);

function landPart(input, layout, paddedOrigin) {
  const { grid, palette, occupancy, materials, smoothing, edges, cellSize } = input;
  // The surface is always meshed with the outer cells continued outward, so it runs smoothly to the grid bounds.
  // `edges: 'closed'` then adds the walls and the base below that surface's boundary instead of rounding the border.
  const solid = paddedField(grid, layout, 'open', cell => (materials[cell] === palette.waterIndex ? 0 : occupancy[cell]));
  const blurred = blurField(solid, layout.dims, smoothing);
  const mesh = meshField(signedDistancesOf(blurred), layout, cellSize, paddedOrigin);
  if (mesh.quads.length === 0) return null;
  const compact = compactMesh(mesh, () => true);
  clampToBounds(compact.positions, input);
  const normals = normalsOf(compact.positions, blurred, layout, cellSize, paddedOrigin);
  const { colors, dominant } = vertexColors(compact.positions, input, layout, paddedOrigin);
  const walled = edges === 'closed' ? addWalls(compact, normals, colors, dominant, input) : { positions: compact.positions, normals, colors, dominant, indices: compact.indices, wallTriangles: 0 };
  const geometry = geometryOf({ positions: walled.positions, indices: walled.indices }, walled.normals, planarUvs(walled.positions), walled.colors);
  return { part: { name: 'Voxel terrain', geometry, matrix: identityMatrix(), material: { ...LAND_MATERIAL } }, dominant: walled.dominant, wallTriangles: walled.wallTriangles };
}

// Walls hang from the boundary edges of the top surface that lie on a side of the grid box, using the very vertices of that
// boundary (so the wall's top edge is the smooth surface, not a per-cell height), and a flat base closes the bottom. Wall and
// base vertices are their own copies with one flat earth colour and flat outward normals, so a top colour never reaches a wall.
// The wall triangles are listed last in the index buffer.
function addWalls(compact, normals, colors, dominant, { grid, cellSize, origin }) {
  const positions = compact.positions;
  const indices = compact.indices;
  const directed = new Set();
  for (let corner = 0; corner < indices.length; corner++) {
    const triangleStart = corner - (corner % 3);
    directed.add(`${indices[corner]},${indices[triangleStart + (corner + 1) % 3]}`);
  }
  const low = origin.slice();
  const high = origin.map((value, axis) => value + grid[axis] * cellSize);
  const onSide = (vertex, [axis, side]) => positions[vertex * 3 + axis] === (side === 0 ? low[axis] : high[axis]);
  const sharedSide = (first, second) => WALL_SIDES.findIndex(wallSide => onSide(first, wallSide) && onSide(second, wallSide));
  const extraPositions = [];
  const extraNormals = [];
  const extraSources = [];
  const vertexCount = positions.length / 3;
  const copies = new Map();
  const copyOf = (vertex, side, bottom) => {
    const key = `${vertex},${side},${bottom}`;
    if (!copies.has(key)) {
      copies.set(key, vertexCount + extraSources.length);
      extraPositions.push(positions[vertex * 3], bottom ? low[1] : positions[vertex * 3 + 1], positions[vertex * 3 + 2]);
      const [axis, direction] = WALL_SIDES[side];
      const normal = [0, 0, 0];
      normal[axis] = direction === 0 ? -1 : 1;
      extraNormals.push(...normal);
      extraSources.push(vertex);
    }
    return copies.get(key);
  };
  const wallIndices = [];
  for (let corner = 0; corner < indices.length; corner++) {
    const triangleStart = corner - (corner % 3);
    const from = indices[corner];
    const to = indices[triangleStart + (corner + 1) % 3];
    if (directed.has(`${to},${from}`)) continue;
    const side = sharedSide(from, to);
    if (side < 0) continue;
    const quad = [copyOf(from, side, false), copyOf(to, side, false), copyOf(to, side, true), copyOf(from, side, true)];
    // (from, to, bottom of to) is a counter-clockwise triangle seen from outside when its normal points away from the box.
    const [axis, direction] = WALL_SIDES[side];
    const alongAxis = axis === 0 ? 2 : 0;
    const travel = positions[to * 3 + alongAxis] - positions[from * 3 + alongAxis];
    // The normal of (from, to, bottom of to) is travel x down, which has this component along the wall's axis.
    const normalAlongAxis = axis === 0 ? travel : -travel;
    const facesOutward = (direction === 0 ? -1 : 1) * normalAlongAxis > 0;
    wallIndices.push(...(facesOutward ? [quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]] : [quad[0], quad[2], quad[1], quad[0], quad[3], quad[2]]));
  }
  const baseCorners = [[low[0], low[2]], [high[0], low[2]], [high[0], high[2]], [low[0], high[2]]].map(([x, z]) => {
    extraPositions.push(x, low[1], z);
    extraNormals.push(0, -1, 0);
    extraSources.push(0);
    return vertexCount + extraSources.length - 1;
  });
  wallIndices.push(baseCorners[0], baseCorners[1], baseCorners[2], baseCorners[0], baseCorners[2], baseCorners[3]);
  const total = vertexCount + extraSources.length;
  const joinedPositions = new Float32Array(total * 3);
  joinedPositions.set(positions);
  joinedPositions.set(extraPositions, vertexCount * 3);
  const joinedNormals = new Float32Array(total * 3);
  joinedNormals.set(normals);
  joinedNormals.set(extraNormals, vertexCount * 3);
  const joinedColors = new Float32Array(total * 3);
  joinedColors.set(colors);
  for (let slot = 0; slot < extraSources.length; slot++) joinedColors.set(WALL_COLOR, (vertexCount + slot) * 3);
  const joinedDominant = new Uint8Array(total);
  joinedDominant.set(dominant);
  extraSources.forEach((source, slot) => { joinedDominant[vertexCount + slot] = dominant[source]; });
  return {
    positions: joinedPositions,
    normals: joinedNormals,
    colors: joinedColors,
    dominant: joinedDominant,
    indices: Uint32Array.from([...indices, ...wallIndices]),
    wallTriangles: wallIndices.length / 3,
  };
}

// A ground cell that is only partly full has no room for the water that lies against it, because a cell holds one
// material. Such a cell counts as water-filled when water touches it from above or from the side, and so does every
// partly full cell joined to it at the same height, so the water surface reaches the shore instead of ending on a
// column of cells.
function floodedCells({ grid, palette, occupancy, materials }) {
  const flooded = new Uint8Array(occupancy.length);
  const queue = [];
  const isWater = cell => materials[cell] === palette.waterIndex && occupancy[cell] > 0;
  const tryFlood = cell => {
    if (flooded[cell] || isWater(cell) || occupancy[cell] <= 0 || occupancy[cell] >= 1) return;
    flooded[cell] = 1;
    queue.push(cell);
  };
  const neighbours = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
  const spread = (cell, offsets) => {
    const x = cell % grid[0];
    const y = Math.floor(cell / grid[0]) % grid[1];
    const z = Math.floor(cell / (grid[0] * grid[1]));
    for (const [stepX, stepY, stepZ] of offsets) {
      const nextX = x + stepX;
      const nextY = y + stepY;
      const nextZ = z + stepZ;
      if (nextX >= 0 && nextX < grid[0] && nextY >= 0 && nextY < grid[1] && nextZ >= 0 && nextZ < grid[2]) tryFlood(cellIndexOf(grid, nextX, nextY, nextZ));
    }
  };
  for (let cell = 0; cell < occupancy.length; cell++) {
    if (isWater(cell)) spread(cell, neighbours);
  }
  for (let head = 0; head < queue.length; head++) spread(queue[head], neighbours.slice(0, 4));
  return flooded;
}

// Water is a flat top. The sides of the water volume, where it runs into a bank, are not drawn.
function facesUp({ quads, positions }, quadIndex) {
  const [first, second, third, fourth] = quads[quadIndex].map(vertex => positions.slice(vertex * 3, vertex * 3 + 3));
  const diagonalA = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
  const diagonalB = [fourth[0] - second[0], fourth[1] - second[1], fourth[2] - second[2]];
  const normal = [
    diagonalA[1] * diagonalB[2] - diagonalA[2] * diagonalB[1],
    diagonalA[2] * diagonalB[0] - diagonalA[0] * diagonalB[2],
    diagonalA[0] * diagonalB[1] - diagonalA[1] * diagonalB[0],
  ];
  return normal[1] / (Math.hypot(...normal) || 1) >= WATER_MINIMUM_UP;
}

// The water volume is blurred together with the bank, so near the bank its surface climbs and dips around the real level.
// Each body (a set of connected triangles) is set to the one level most of its vertices share, so the sheet is truly flat
// and its shoreline is where that plane meets the ground, with no step between sections at slightly different heights.
function levelWaterBodies(positions, indices, cellSize) {
  const vertexCount = positions.length / 3;
  const parent = Array.from({ length: vertexCount }, (_, vertex) => vertex);
  const rootOf = vertex => {
    let root = vertex;
    while (parent[root] !== root) root = parent[root];
    while (parent[vertex] !== root) {
      const next = parent[vertex];
      parent[vertex] = root;
      vertex = next;
    }
    return root;
  };
  for (let offset = 0; offset < indices.length; offset += 3) {
    parent[rootOf(indices[offset + 1])] = rootOf(indices[offset]);
    parent[rootOf(indices[offset + 2])] = rootOf(indices[offset]);
  }
  const bucketSize = LEVEL_BUCKET * cellSize;
  const buckets = new Map();
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const root = rootOf(vertex);
    const bucket = Math.round(positions[vertex * 3 + 1] / bucketSize);
    const counts = buckets.get(root) ?? new Map();
    const entry = counts.get(bucket) ?? { count: 0, total: 0 };
    entry.count++;
    entry.total += positions[vertex * 3 + 1];
    counts.set(bucket, entry);
    buckets.set(root, counts);
  }
  const levels = new Map();
  for (const [root, counts] of buckets) {
    let best = null;
    for (const [bucket, entry] of counts) {
      if (best === null || entry.count > best.count || (entry.count === best.count && bucket > best.bucket)) best = { ...entry, bucket };
    }
    levels.set(root, best.total / best.count);
  }
  for (let vertex = 0; vertex < vertexCount; vertex++) positions[vertex * 3 + 1] = levels.get(rootOf(vertex));
}

// The water mesh ends on cell boundaries, so where the ground there is still below the water level the sheet stops short and
// leaves a stair step. A flat strip is added around the outline, at the level of each boundary vertex and `BANK_RUN` cells wide;
// it lies under the neighbouring land, so the depth test hides it there and the visible shoreline is the flat water plane
// crossing the smooth ground.
function extendUnderBanks(compact, cellSize) {
  const positions = Array.from(compact.positions);
  const indices = Array.from(compact.indices);
  const vertexCount = positions.length / 3;
  const directed = new Set();
  for (let corner = 0; corner < indices.length; corner++) {
    directed.add(`${indices[corner]},${indices[corner - (corner % 3) + (corner + 1) % 3]}`);
  }
  const outward = new Map();
  const boundaryEdges = [];
  for (let corner = 0; corner < indices.length; corner++) {
    const triangleStart = corner - (corner % 3);
    const from = indices[corner];
    const to = indices[triangleStart + (corner + 1) % 3];
    if (directed.has(`${to},${from}`)) continue;
    const opposite = indices[triangleStart + (corner + 2) % 3];
    const edgeX = positions[to * 3] - positions[from * 3];
    const edgeZ = positions[to * 3 + 2] - positions[from * 3 + 2];
    const length = Math.hypot(edgeX, edgeZ);
    if (length === 0) continue;
    let normalX = -edgeZ / length;
    let normalZ = edgeX / length;
    const towardOpposite = (positions[opposite * 3] - positions[from * 3]) * normalX + (positions[opposite * 3 + 2] - positions[from * 3 + 2]) * normalZ;
    if (towardOpposite > 0) {
      normalX = -normalX;
      normalZ = -normalZ;
    }
    boundaryEdges.push([from, to]);
    for (const vertex of [from, to]) {
      const sum = outward.get(vertex) ?? [0, 0];
      outward.set(vertex, [sum[0] + normalX, sum[1] + normalZ]);
    }
  }
  const outerOf = new Map();
  for (const [vertex, [sumX, sumZ]] of outward) {
    const length = Math.hypot(sumX, sumZ);
    if (length < 1e-6) continue;
    outerOf.set(vertex, positions.length / 3);
    positions.push(positions[vertex * 3] + sumX / length * BANK_RUN * cellSize, positions[vertex * 3 + 1], positions[vertex * 3 + 2] + sumZ / length * BANK_RUN * cellSize);
  }
  for (const [from, to] of boundaryEdges) {
    if (!outerOf.has(from) || !outerOf.has(to)) continue;
    const quad = [from, to, outerOf.get(to), outerOf.get(from)];
    // Each triangle is wound to face up on its own, so a strip that folds at a sharp corner never shows its back.
    for (const [first, second, third] of [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]]) {
      const [ax, az] = [positions[second * 3] - positions[first * 3], positions[second * 3 + 2] - positions[first * 3 + 2]];
      const [bx, bz] = [positions[third * 3] - positions[first * 3], positions[third * 3 + 2] - positions[first * 3 + 2]];
      const upward = az * bx - ax * bz;
      if (upward > 0) indices.push(first, second, third);
      else if (upward < 0) indices.push(first, third, second);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), vertexCount };
}

function waterPart(input, layout, paddedOrigin) {
  const { grid, palette, occupancy, materials, smoothing, edges, cellSize } = input;
  if (palette.waterIndex < 0) return null;
  const hasWater = materials.some((material, cell) => material === palette.waterIndex && occupancy[cell] > 0);
  if (!hasWater) return null;
  const flooded = floodedCells(input);
  const volume = paddedField(grid, layout, edges, cell => (flooded[cell] ? 1 : occupancy[cell]));
  const blurred = blurField(volume, layout.dims, smoothing);
  const mesh = meshField(signedDistancesOf(blurred), layout, cellSize, paddedOrigin);
  const wetness = blurField(paddedField(grid, layout, edges, cell => (flooded[cell] ? 1 : materials[cell] === palette.waterIndex ? occupancy[cell] : 0)), layout.dims, smoothing);
  // A water quad is kept where the water cells' own blurred occupancy is present at its vertices. Over land the water
  // surface stays a little under the land mesh, so the shoreline is where the land crosses the water, not a grid edge.
  const keep = quadIndex => {
    let total = 0;
    for (const vertex of mesh.quads[quadIndex]) total += sampleField(wetness, layout, pointOf(mesh.positions, vertex, cellSize, paddedOrigin));
    return total / 4 >= WETNESS_THRESHOLD && facesUp(mesh, quadIndex);
  };
  const compact = compactMesh(mesh, keep);
  if (compact.indices.length === 0) return null;
  clampToBounds(compact.positions, input);
  levelWaterBodies(compact.positions, compact.indices, cellSize);
  for (let vertex = 0; vertex < compact.positions.length / 3; vertex++) compact.positions[vertex * 3 + 1] -= WATER_DROP * cellSize;
  const extended = extendUnderBanks(compact, cellSize);
  clampToBounds(extended.positions, input);
  const normals = new Float32Array(extended.positions.length);
  for (let vertex = 0; vertex < extended.positions.length / 3; vertex++) normals[vertex * 3 + 1] = 1;
  const geometry = geometryOf(extended, normals, planarUvs(extended.positions));
  return { name: 'Voxel water', geometry, matrix: identityMatrix(), material: { ...WATER_MATERIAL } };
}

/**
 * Mesh a voxel landscape. `grid` is the cell count along x, y (up) and z; `occupancy` holds 0 to 1 per cell and
 * `materials` a palette index per cell, both x fastest, then y, then z. Returns `{ parts, materialIds, bounds, stats }`:
 * a land part whose vertex colours blend the materials of the cells around each vertex (no seam between grass and rock)
 * and, when the palette has water cells, a water part at the top of each water body.
 */
export function createVoxelTerrain(input) {
  const normalized = normalizeVoxelTerrain(input);
  const { grid, cellSize, origin } = normalized;
  const layout = paddedLayout(grid);
  const paddedOrigin = origin.map(value => value - cellSize / 2);
  const started = performance.now();
  const land = landPart(normalized, layout, paddedOrigin);
  const water = waterPart(normalized, layout, paddedOrigin);
  const parts = [land?.part, water].filter(Boolean);
  if (parts.length === 0) throw invalidField('occupancy', 'no surface', 'at least one cell with occupancy above 0.5 whose neighbour is emptier; the grid is empty or full');
  const bounds = { min: [...origin], max: origin.map((value, axis) => value + grid[axis] * cellSize) };
  const vertexTotal = parts.reduce((total, part) => total + part.geometry.positions.length / 3, 0);
  const triangleTotal = parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
  return { parts, materialIds: land?.dominant ?? new Uint8Array(0), palette: normalized.palette.names, bounds, stats: { vertices: vertexTotal, triangles: triangleTotal, wallTriangles: land?.wallTriangles ?? 0, milliseconds: performance.now() - started } };
}
