import { GROUP_PREFIX, VECTOR_PREFIX, createMeshData } from './mesh-data.js';
import {
  oceanWaves, oceanSurfaceAt, oceanFoamThreshold, prepareOceanBatch, setOceanBatchPoint, oceanBatchSurface, oceanBatchFoamWithMemory,
  MAX_FOAM_MEMORY_SAMPLES,
} from './ocean-waves.js';
import { normalizeWake, wakeAt } from './ocean-wake.js';
import { registerModifierNormalizer, registerModifierRunner } from './mesh-modifiers.js';

export { oceanWaves, oceanSurfaceAt };

export const MAX_OCEAN_RESOLUTION = 16;
export const DEFAULT_FOAM_MEMORY = 0;
export const MAX_OCEAN_WORK = 50_000_000;
const UP_AXES = Object.freeze({ x: 0, y: 1, z: 2 });
const MAX_SEED = 0x7fffffff;
// The surface must rise this fraction of the wind speed (m/s per m/s) for a foamy point to throw full spray.
const SPRAY_RISE_PER_WIND = 0.1;
export const SPRAY_GROUP = 'spray';
export const SPRAY_VELOCITY_VECTOR = 'spray';

/** Displace every vertex by the sea and write the vertex group `foam`; `axis` is the up axis of the sea. A `wake` adds foam and a trough along its points. With `spray: true` it also writes the vertex group `spray` (foam where the surface is rising, 0 to 1) and the vector `spray` (the surface velocity in m/s, along the mesh axes) for particle emitters. */
export function oceanMesh(mesh, { axis, windSpeed, direction, choppiness, size, seed, time, resolution, coverage = 0, foamMemory = DEFAULT_FOAM_MEMORY, wake, spray }) {
  const waves = oceanWaves({ windSpeed, direction, size, seed, resolution });
  const evaluationsPerVertex = waves.length * (foamMemory > 0 ? 1 + MAX_FOAM_MEMORY_SAMPLES : 1);
  if (evaluationsPerVertex * mesh.vertexCount > MAX_OCEAN_WORK) {
    throw new RangeError(`ocean would make ${evaluationsPerVertex * mesh.vertexCount} wave evaluations, over the limit of ${MAX_OCEAN_WORK}. Lower resolution, set foamMemory to 0 or use a coarser grid.`);
  }
  const up = UP_AXES[axis];
  const first = (up + 1) % 3;
  const second = (up + 2) % 3;
  // Wake points are [x, z] for a y-up sea: the two horizontal axes in ascending order.
  const horizontalLow = up === 0 ? 1 : 0;
  const horizontalHigh = up === 2 ? 1 : 2;
  const positions = new Float32Array(mesh.positions);
  const foam = new Float32Array(mesh.vertexCount);
  const sprayWeight = spray ? new Float32Array(mesh.vertexCount) : null;
  const sprayVelocity = spray ? new Float32Array(mesh.vertexCount * 3) : null;
  const foamThreshold = oceanFoamThreshold(waves, { windSpeed, size, choppiness, coverage });
  const fullSprayRise = SPRAY_RISE_PER_WIND * windSpeed;
  const batch = prepareOceanBatch(waves, time, choppiness, foamMemory);
  const surface = {};
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const restX = positions[vertex * 3 + first];
    const restZ = positions[vertex * 3 + second];
    // The wake is anchored to the rest grid: sampling it at the swell-displaced position made the foam and its churn change every frame.
    const wakeX = positions[vertex * 3 + horizontalLow];
    const wakeZ = positions[vertex * 3 + horizontalHigh];
    setOceanBatchPoint(batch, restX, restZ);
    oceanBatchSurface(batch, surface, foamThreshold);
    positions[vertex * 3 + up] += surface.height;
    positions[vertex * 3 + first] += surface.moveX;
    positions[vertex * 3 + second] += surface.moveZ;
    foam[vertex] = oceanBatchFoamWithMemory(batch, foamThreshold, surface.foam);
    if (spray) {
      sprayWeight[vertex] = Math.min(1, Math.max(0, surface.riseSpeed / fullSprayRise));
      sprayVelocity[vertex * 3 + up] = surface.riseSpeed;
      sprayVelocity[vertex * 3 + first] = surface.driftX;
      sprayVelocity[vertex * 3 + second] = surface.driftZ;
    }
    if (wake?.points.length) {
      const trail = wakeAt(wake, wakeX, wakeZ);
      positions[vertex * 3 + up] += trail.offset;
      foam[vertex] = Math.max(foam[vertex], trail.foam);
    }
  }
  const point = { ...mesh.attributes.point, [`${GROUP_PREFIX}foam`]: { data: foam, size: 1 } };
  if (spray) {
    // The wake can raise foam after the surface was sampled, so the spray follows the final foam.
    for (let vertex = 0; vertex < mesh.vertexCount; vertex++) sprayWeight[vertex] = Math.min(sprayWeight[vertex], foam[vertex]);
    point[`${GROUP_PREFIX}${SPRAY_GROUP}`] = { data: sprayWeight, size: 1 };
    point[`${VECTOR_PREFIX}${SPRAY_VELOCITY_VECTOR}`] = { data: sprayVelocity, size: 3 };
  }
  const attributes = { ...mesh.attributes, point };
  return createMeshData({
    positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes,
  });
}

function normalizeOcean(edit, normalized, index, { finiteNumber, integerInRange }) {
  normalized.axis = edit.axis ?? 'y';
  if (!Object.hasOwn(UP_AXES, normalized.axis)) throw new TypeError(`Mesh edit ${index} (axis must be x, y or z)`);
  normalized.windSpeed = edit.windSpeed === undefined ? 10 : finiteNumber(edit.windSpeed, index, 'windSpeed', { minimum: 0, maximum: 60, exclusiveMinimum: true });
  normalized.direction = edit.direction === undefined ? 0 : finiteNumber(edit.direction, index, 'direction', { minimum: -3600, maximum: 3600 });
  normalized.choppiness = edit.choppiness === undefined ? 1 : finiteNumber(edit.choppiness, index, 'choppiness', { minimum: 0, maximum: 4 });
  normalized.size = edit.size === undefined ? 100 : finiteNumber(edit.size, index, 'size', { minimum: 1, maximum: 10_000 });
  normalized.seed = edit.seed === undefined ? 0 : integerInRange(edit.seed, index, 'seed', 0, MAX_SEED);
  normalized.time = edit.time === undefined ? 0 : finiteNumber(edit.time, index, 'time', { minimum: -1e6, maximum: 1e6 });
  normalized.coverage = edit.coverage === undefined ? 0 : finiteNumber(edit.coverage, index, 'coverage', { minimum: -1, maximum: 1 });
  normalized.foamMemory = edit.foamMemory === undefined ? DEFAULT_FOAM_MEMORY : finiteNumber(edit.foamMemory, index, 'foamMemory', { minimum: 0, maximum: 30 });
  normalized.resolution = edit.resolution === undefined ? 8 : integerInRange(edit.resolution, index, 'resolution', 1, MAX_OCEAN_RESOLUTION);
  if (edit.spray !== undefined) {
    if (typeof edit.spray !== 'boolean') throw new TypeError(`Mesh edit ${index} (spray must be true or false, such as spray: true to write the spray group and velocity, not ${JSON.stringify(edit.spray)})`);
    normalized.spray = edit.spray;
  }
  if (edit.wake !== undefined) normalized.wake = normalizeWake(edit.wake, `Mesh edit ${index} wake`);
}

registerModifierNormalizer('ocean', normalizeOcean);
registerModifierRunner('ocean', (mesh, edit) => ({ mesh: oceanMesh(mesh, edit), result: {} }));
