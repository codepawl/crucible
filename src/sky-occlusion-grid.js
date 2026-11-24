import { createTracer } from './ray-query.js';
import { buildWorld, cosineDirection, radicalInverse, sceneScale } from './light-bake.js';
import { worldBounds } from './probe-trace.js';
import { isInsideSolid, placeIrradianceGrid } from './irradiance-grid.js';

// Sky light under cover (#3289). A coarse grid over the loaded parts holds how much of the sky each point sees, traced once
// when the scene loads. The shader already reads an irradiance grid's fourth value as occlusion on the light the world gives a
// surface, so this grid carries no light, only that value: the sun and the lights are not scaled, and the grid adds no shader
// code and no uniform. Open ground reads 1 everywhere and draws as it did.

/** The edge of a cell in scene units (metres in a glTF file) before the node limit coarsens it. */
export const SKY_OCCLUSION_CELL_SIZE = 2;
/** The most nodes the grid may hold: its trace is nodes times rays, and its texture is 4 texels per node. */
export const SKY_OCCLUSION_MAXIMUM_NODES = 8192;
/** Cosine-weighted rays from each node; the grid steps by one over this many in a cell that sees only part of the sky. */
export const SKY_OCCLUSION_RAYS = 32;
/** The triangle count past which the trace is left out: the bounding volume build alone takes seconds. */
export const SKY_OCCLUSION_MAXIMUM_TRIANGLES = 2_000_000;
/** The second the trace may take before the scene is drawn without it. */
export const SKY_OCCLUSION_MAXIMUM_SECONDS = 20;

const COEFFICIENTS_PER_NODE = 16;
// The slot the shader reads as occlusion: the constant term of the fourth texel (irradiance-grid.js).
const SKY_SLOT = 12;
const UP = Object.freeze([0, 1, 0]);

/** Origin, cell size and node counts: cells of `cellSize`, made larger until the grid holds at most `maximumNodes` nodes. */
export function skyOcclusionLayout(minimum, maximum, { cellSize = SKY_OCCLUSION_CELL_SIZE, maximumNodes = SKY_OCCLUSION_MAXIMUM_NODES } = {}) {
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
    throw new RangeError(`skyOcclusion cellSize must be a positive number of scene units, got ${cellSize}.`);
  }
  if (!Number.isInteger(maximumNodes) || maximumNodes < 8) {
    throw new RangeError(`skyOcclusion maximumNodes must be a whole number of at least 8, got ${maximumNodes}.`);
  }
  const extent = maximum.map((high, axis) => Math.max(high - minimum[axis], 1e-3));
  const sizeFor = cell => extent.map(length => Math.max(2, Math.ceil(length / cell) + 1));
  let cell = cellSize;
  while (sizeFor(cell).reduce((product, count) => product * count, 1) > maximumNodes) {
    cell *= 1.05;
  }
  return { origin: [...minimum], cellSize: cell, size: sizeFor(cell) };
}

// Cosine-weighted directions about +y from a fixed sequence, so the same scene gives the same bytes.
function fixedUpwardDirections(count) {
  return Array.from({ length: count }, (unused, index) => {
    const direction = [0, 0, 0];
    cosineDirection(UP, (index + 0.5) / count, radicalInverse(index + 1), direction);
    return direction;
  });
}

function isOpaque(part) {
  return !['blend', 'add'].includes(part.material?.alphaMode);
}

function partsBounds(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const bounds = worldBounds(part);
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], bounds.minimum[axis]);
      maximum[axis] = Math.max(maximum[axis], bounds.maximum[axis]);
    }
  }
  return { minimum, maximum };
}

function fillSolidNodes(skyShare, valid, size) {
  const [width, height] = size;
  const strides = [1, width, width * height];
  for (let pass = 0; pass < 12; pass++) {
    const filled = [];
    for (let node = 0; node < valid.length; node++) {
      if (valid[node]) {
        continue;
      }
      const coordinates = [node % width, Math.floor(node / width) % height, Math.floor(node / (width * height))];
      let best = -1;
      for (let axis = 0; axis < 3; axis++) {
        for (const step of [-1, 1]) {
          const moved = coordinates[axis] + step;
          if (moved < 0 || moved >= size[axis]) {
            continue;
          }
          const neighbour = node + step * strides[axis];
          if (valid[neighbour] && (best < 0 || skyShare[neighbour] > skyShare[best])) {
            best = neighbour;
          }
        }
      }
      if (best >= 0) {
        skyShare[node] = skyShare[best];
        filled.push(node);
      }
    }
    if (filled.length === 0) {
      return;
    }
    for (const node of filled) {
      valid[node] = 1;
    }
  }
}

/**
 * Traces the grid over `parts`: `{ origin, cellSize, size, data, nodes, solidNodes, rays, seconds }` in the layout of an
 * irradiance grid (`data` holds 16 floats per node, only the sky slot set), or null when the scene is empty or holds more than
 * SKY_OCCLUSION_MAXIMUM_TRIANGLES triangles. Blended and additive parts let the sky through. Each node shoots `rays` cosine-weighted
 * rays up and stores the share that leaves the scene.
 */
export function traceSkyOcclusionGrid(parts, { cellSize, maximumNodes, rays = SKY_OCCLUSION_RAYS, maxSeconds = SKY_OCCLUSION_MAXIMUM_SECONDS } = {}) {
  if (!Number.isInteger(rays) || rays < 1) {
    throw new RangeError(`skyOcclusion rays must be a whole number of at least 1, got ${rays}.`);
  }
  const occluders = parts.filter(isOpaque);
  const triangleCount = occluders.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
  if (triangleCount === 0 || triangleCount > SKY_OCCLUSION_MAXIMUM_TRIANGLES) {
    return null;
  }
  const started = performance.now();
  const { minimum, maximum } = partsBounds(occluders);
  const layout = skyOcclusionLayout(minimum, maximum, { cellSize, maximumNodes });
  const [width, height, depth] = layout.size;
  const nodeCount = width * height * depth;
  const world = buildWorld(occluders);
  const tracer = createTracer(world);
  const lift = sceneScale(world.positions) * 1e-4;
  const directions = fixedUpwardDirections(rays);
  const skyShare = new Float32Array(nodeCount);
  const valid = new Uint8Array(nodeCount);
  const point = [0, 0, 0];
  let solidNodes = 0;
  for (let node = 0; node < nodeCount; node++) {
    if (performance.now() - started > maxSeconds * 1000) {
      return null;
    }
    point[0] = layout.origin[0] + (node % width) * layout.cellSize;
    point[1] = layout.origin[1] + (Math.floor(node / width) % height) * layout.cellSize;
    point[2] = layout.origin[2] + Math.floor(node / (width * height)) * layout.cellSize;
    // Lifted a little so a node on the bottom face of a slab counts as inside it, and a node on a floor as above it.
    point[1] += lift;
    if (isInsideSolid(world, tracer, point)) {
      solidNodes++;
      continue;
    }
    valid[node] = 1;
    let escaped = 0;
    for (const direction of directions) {
      const hit = tracer.trace(point[0], point[1], point[2], direction[0], direction[1], direction[2], Infinity, true);
      if (hit.nearestTriangle < 0) {
        escaped++;
      }
    }
    skyShare[node] = escaped / rays;
  }
  fillSolidNodes(skyShare, valid, layout.size);
  const data = new Float32Array(nodeCount * COEFFICIENTS_PER_NODE);
  for (let node = 0; node < nodeCount; node++) {
    // A node no neighbour could fill (a scene that is solid all through) stays open rather than black.
    data[node * COEFFICIENTS_PER_NODE + SKY_SLOT] = valid[node] ? skyShare[node] : 1;
  }
  return { ...layout, data, nodes: nodeCount, solidNodes, rays, seconds: (performance.now() - started) / 1000 };
}

/**
 * Returns `{ parts, report }`: the parts with the sky grid on every material, or the parts as they were with `report.reason`
 * saying why not (no parts, too many triangles, the trace ran past its time, or a part already carries baked light). The
 * report holds the node count, cell size, the share of nodes under cover (`coveredShare`, below 0.95 of the sky) and the seconds.
 */
export function applySkyOcclusionGrid(parts, options = {}) {
  const unchanged = reason => ({ parts, report: { reason, nodes: 0, seconds: 0 } });
  if (parts.length === 0) {
    return unchanged('no parts');
  }
  if (parts.some(part => part.material?.irradianceGrid || part.material?.lightMap)) {
    return unchanged('baked light');
  }
  const grid = traceSkyOcclusionGrid(parts, options);
  if (!grid) {
    return unchanged('too large or too slow to trace');
  }
  let covered = 0;
  for (let node = 0; node < grid.nodes; node++) {
    if (grid.data[node * COEFFICIENTS_PER_NODE + SKY_SLOT] < 0.95) {
      covered++;
    }
  }
  const { data, ...summary } = grid;
  return {
    parts: placeIrradianceGrid(parts, { ...grid, skyOnly: true, meanRadiance: () => [0, 0, 0] }),
    report: { ...summary, coveredShare: covered / grid.nodes, coarsened: grid.cellSize > (options.cellSize ?? SKY_OCCLUSION_CELL_SIZE) * 1.0001, reason: null },
  };
}
