import { createHash } from 'node:crypto';
import { createTerrain } from '../../src/terrain.js';

export const MASK_RESOLUTION = 64;
export const MASK_OUTPUTS = ['slope', 'normalY', 'height'];
export const MASK_SPACES = ['object', 'world'];

// Tilted and moved, so a world-space bake differs from an object-space one.
const COS = Math.cos(0.5);
const SIN = Math.sin(0.5);
export const WORLD_MATRIX = [COS, SIN, 0, 0, -SIN, COS, 0, 0, 0, 0, 1, 0, 3, -2, 5, 1];

/** Fresh chunk geometries of a small terrain: every call builds new objects, so nothing is cached for them. */
export function terrainChunkGeometries() {
  const terrain = createTerrain({ size: 64, chunks: 2, resolution: 8, levels: 3, height: { amplitude: 20, mountainAmplitude: 60, featureSize: 200 }, seed: 7 });
  return terrain.parts.map(part => part.geometry).filter(geometry => geometry.uvs);
}

export function maskCases() {
  return MASK_OUTPUTS.flatMap(output => MASK_SPACES.map(space => ({ output, space })));
}

/** One digest over every map, in a fixed order, so two runs compare by a single string. */
export function digestOfMaps(maps) {
  const hash = createHash('sha256');
  for (const map of maps) {
    hash.update(`${map.width}x${map.height};`);
    hash.update(map.data);
  }
  return hash.digest('hex');
}

export function allMasks(geometries, surfaceMap) {
  return geometries.flatMap(geometry => maskCases().map(settings => surfaceMap(geometry, settings, MASK_RESOLUTION, 'terrain', WORLD_MATRIX)));
}
