import { GRASS_LEVELS } from '../../src/grass.js';

const WIND_REFERENCE_LENGTH = 0.6;

// A CPU port of grassWind in src/world-material-shader.js, for the tip vertex of a blade (the heading is the default, 0).
// The tip moves bladeLength / 0.6 of the metre offset the shader works out; uv.x carries the length in millimetres, 2 per millimetre.
function windTipOffset(x, z, seconds, strength, bladeLength) {
  const lengthShare = bladeLength / WIND_REFERENCE_LENGTH;
  const direction = [0.94, 0.34];
  const along = x * direction[0] + z * direction[1];
  const gust = 0.5 + 0.5 * Math.sin(along * 0.32 - seconds * 1.7 + 2.0 * Math.sin(x * 0.05 - z * 0.04 + seconds * 0.23));
  const push = (0.3 + 0.7 * gust * gust) * strength;
  const flutter = Math.sin(seconds * 4.7 + x * 2.3 + z * 1.9) * strength;
  return [
    (direction[0] * (push * 0.42 + flutter * 0.05) - direction[1] * flutter * 0.04) * lengthShare,
    -push * 0.14 * lengthShare,
    (direction[1] * (push * 0.42 + flutter * 0.05) + direction[0] * flutter * 0.04) * lengthShare,
  ];
}

/** Angles in degrees between each blade's base-to-tip vector and world +Y, sorted, with the wind of `strength` at `seconds` applied to the tip. */
export function bladeAnglesToUp(parts, { strength = 0, seconds = 3 } = {}) {
  const angles = [];
  for (const part of parts) {
    const { positions, uvs } = part.geometry;
    const verticesPerBlade = 2 * GRASS_LEVELS[part.level].segments + 1;
    for (let blade = 0; blade < positions.length / 3 / verticesPerBlade; blade++) {
      const firstVertex = blade * verticesPerBlade * 3;
      const tipVertex = (blade * verticesPerBlade + verticesPerBlade - 1) * 3;
      const world = (vertexOffset, axis) => positions[vertexOffset + axis] + part.matrix[12 + axis];
      const base = [0, 1, 2].map(axis => (world(firstVertex, axis) + world(firstVertex + 3, axis)) / 2);
      const tip = [0, 1, 2].map(axis => world(tipVertex, axis));
      const bladeLength = Math.floor(uvs[tipVertex / 3 * 2] / 2) * 0.001;
      const offset = windTipOffset(tip[0], tip[2], seconds, strength, bladeLength);
      const vector = tip.map((value, axis) => value + offset[axis] - base[axis]);
      angles.push(Math.acos(vector[1] / Math.hypot(...vector)) * 180 / Math.PI);
    }
  }
  return angles.sort((a, b) => a - b);
}

export const meanOf = values => values.reduce((total, value) => total + value, 0) / values.length;
