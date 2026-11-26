// Shared by material patterns and material graphs: seeded periodic noise, and the conversions that turn baked values
// into texture descriptors. Texture coordinates run 0 to 1 and every noise is periodic over that square.

export function hashCell(cellX, cellY, seed) {
  let hash = Math.imul(cellX, 0x27d4eb2d) ^ Math.imul(cellY, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  hash = Math.imul(hash ^ (hash >>> 15), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

export const wrapCell = (cell, period) => ((cell % period) + period) % period;
export const smootherStep = value => value * value * value * (value * (value * 6 - 15) + 10);
export const clampUnit = value => Math.min(1, Math.max(0, value));
export const smoothStep = (minimum, maximum, value) => {
  const position = clampUnit((value - minimum) / (maximum - minimum));
  return position * position * (3 - 2 * position);
};

function cornerGradient(cellX, cellY, offsetX, offsetY, seed) {
  const angle = hashCell(cellX, cellY, seed) / 4294967296 * Math.PI * 2;
  return Math.cos(angle) * offsetX + Math.sin(angle) * offsetY;
}

/** Gradient noise in about -1 to 1, periodic over [0, 1) with the given whole number of cells per axis. */
export function gradientNoise(positionU, positionV, cellsU, cellsV, seed = 0) {
  const scaledU = positionU * cellsU;
  const scaledV = positionV * cellsV;
  const floorU = Math.floor(scaledU);
  const floorV = Math.floor(scaledV);
  const fractionU = scaledU - floorU;
  const fractionV = scaledV - floorV;
  const left = wrapCell(floorU, cellsU);
  const right = wrapCell(floorU + 1, cellsU);
  const bottom = wrapCell(floorV, cellsV);
  const top = wrapCell(floorV + 1, cellsV);
  const blendU = smootherStep(fractionU);
  const blendV = smootherStep(fractionV);
  const lower = cornerGradient(left, bottom, fractionU, fractionV, seed) * (1 - blendU)
    + cornerGradient(right, bottom, fractionU - 1, fractionV, seed) * blendU;
  const upper = cornerGradient(left, top, fractionU, fractionV - 1, seed) * (1 - blendU)
    + cornerGradient(right, top, fractionU - 1, fractionV - 1, seed) * blendU;
  return (lower * (1 - blendV) + upper * blendV) * 1.5;
}

/** Fractal sum of gradientNoise in about -1 to 1. Each octave doubles the cells, so it stays periodic. */
export function fractalNoise(positionU, positionV, cellsU, cellsV, seed = 0, octaves = 5, gain = 0.5) {
  let total = 0;
  let amplitude = 1;
  let amplitudeSum = 0;
  for (let octave = 0; octave < octaves; octave++) {
    total += gradientNoise(positionU, positionV, cellsU << octave, cellsV << octave, seed + octave * 131) * amplitude;
    amplitudeSum += amplitude;
    amplitude *= gain;
  }
  return total / amplitudeSum;
}

/** Ridged fractal noise in 0 to 1: sharp crests where the gradient noise crosses zero. */
export function ridgedNoise(positionU, positionV, cellsU, cellsV, seed = 0, octaves = 4) {
  let total = 0;
  let amplitude = 1;
  let amplitudeSum = 0;
  for (let octave = 0; octave < octaves; octave++) {
    const ridge = 1 - Math.abs(gradientNoise(positionU, positionV, cellsU << octave, cellsV << octave, seed + octave * 211));
    total += ridge * ridge * amplitude;
    amplitudeSum += amplitude;
    amplitude *= 0.5;
  }
  return total / amplitudeSum;
}

// Where the feature point of a cell sits inside it, in cell units. A jitter of 1 puts it anywhere in the cell (the hash
// itself), 0 at the cell centre, so the cells form a regular grid.
function featurePointOffset(hashHalf, jitter) {
  const random = hashHalf / 65536;
  return jitter === 1 ? random : 0.5 + (random - 0.5) * jitter;
}

/**
 * Periodic Worley noise: distances to the nearest and second nearest feature point, in cell units, and a hash of the
 * nearest cell. `jitter` (0 to 1, default 1) scales how far each point strays from its cell centre.
 */
export function cellularNoise(positionU, positionV, cells, seed = 0, jitter = 1) {
  const scaledU = positionU * cells;
  const scaledV = positionV * cells;
  const floorU = Math.floor(scaledU);
  const floorV = Math.floor(scaledV);
  let nearest = Infinity;
  let second = Infinity;
  let nearestCell = 0;
  for (let offsetV = -1; offsetV <= 1; offsetV++) {
    for (let offsetU = -1; offsetU <= 1; offsetU++) {
      const cellU = floorU + offsetU;
      const cellV = floorV + offsetV;
      const hash = hashCell(wrapCell(cellU, cells), wrapCell(cellV, cells), seed);
      const pointU = cellU + featurePointOffset(hash & 0xffff, jitter);
      const pointV = cellV + featurePointOffset(hash >>> 16, jitter);
      const distance = Math.hypot(pointU - scaledU, pointV - scaledV);
      if (distance < nearest) {
        second = nearest;
        nearest = distance;
        nearestCell = hash;
      } else if (distance < second) {
        second = distance;
      }
    }
  }
  return { nearest, second, cell: nearestCell };
}

const SMOOTH_DISTANCE_START = 8;
const SMOOTH_NEIGHBOUR_RADIUS = 2;

/**
 * Smooth F1: the distance to the nearest feature point with the hard minimum replaced by a polynomial smooth minimum over
 * the 5 by 5 cells around the position, as Blender's Voronoi Smooth F1 does (its Smoothness is 0 to 1 and is halved). A
 * smoothness of 0 is the plain nearest distance. Periodic like `cellularNoise`.
 */
export function smoothCellularDistance(positionU, positionV, cells, seed = 0, jitter = 1, smoothness = 1) {
  const blend = Math.min(Math.max(smoothness, 0), 1) / 2;
  const scaledU = positionU * cells;
  const scaledV = positionV * cells;
  const floorU = Math.floor(scaledU);
  const floorV = Math.floor(scaledV);
  let smoothDistance = SMOOTH_DISTANCE_START;
  for (let offsetV = -SMOOTH_NEIGHBOUR_RADIUS; offsetV <= SMOOTH_NEIGHBOUR_RADIUS; offsetV++) {
    for (let offsetU = -SMOOTH_NEIGHBOUR_RADIUS; offsetU <= SMOOTH_NEIGHBOUR_RADIUS; offsetU++) {
      const cellU = floorU + offsetU;
      const cellV = floorV + offsetV;
      const hash = hashCell(wrapCell(cellU, cells), wrapCell(cellV, cells), seed);
      const pointU = cellU + featurePointOffset(hash & 0xffff, jitter);
      const pointV = cellV + featurePointOffset(hash >>> 16, jitter);
      const distance = Math.hypot(pointU - scaledU, pointV - scaledV);
      if (blend === 0) {
        smoothDistance = Math.min(smoothDistance, distance);
        continue;
      }
      const share = smoothStep(0, 1, 0.5 + 0.5 * (smoothDistance - distance) / blend);
      smoothDistance = smoothDistance + (distance - smoothDistance) * share - blend * share * (1 - share);
    }
  }
  return smoothDistance;
}

export function linearToSrgbByte(value) {
  const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(clampUnit(encoded) * 255);
}

export function createImage(data, width, height) {
  // Browsers upload ImageData directly; Node only reads the pixels, as tests and tools do.
  return typeof ImageData === 'function' ? new ImageData(data, width, height) : { width, height, data };
}

function writeNormalSample(normalData, offset, slopeAcross, slopeUp) {
  const length = Math.hypot(slopeAcross, slopeUp, 1);
  normalData[offset] = Math.round((-slopeAcross / length * 0.5 + 0.5) * 255);
  normalData[offset + 1] = Math.round((-slopeUp / length * 0.5 + 0.5) * 255);
  normalData[offset + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
  normalData[offset + 3] = 255;
}

function normalMapFromSlopes(resolution, slopeU, slopeV) {
  const normalData = new Uint8ClampedArray(resolution * resolution * 4);
  for (let row = 0; row < resolution; row++) {
    for (let column = 0; column < resolution; column++) {
      const offset = (row * resolution + column) * 4;
      writeNormalSample(normalData, offset, slopeU(column, row), slopeV(column, row));
    }
  }
  return normalData;
}

/** Tangent-space normal map bytes from a height field. Height differences are per texel; scale them so a bump of 1 reads the same at any resolution. */
export function normalMapFromHeights(heights, resolution, bump) {
  const slopeScale = bump * resolution / 64;
  const heightAt = (column, row) => heights[((row + resolution) % resolution) * resolution + ((column + resolution) % resolution)];
  return normalMapFromSlopes(
    resolution,
    (column, row) => (heightAt(column + 1, row) - heightAt(column - 1, row)) * slopeScale,
    (column, row) => (heightAt(column, row + 1) - heightAt(column, row - 1)) * slopeScale,
  );
}

/** The same slope per UV unit (bump / 32) read from a height function of (u, v) by a central difference of half a texel each side.
 * Blender's Bump node reads a footprint of 0.1 pixel, so a joint edge stays one texel thin where two texels each side widen it to three. */
export function normalMapFromHeightFunction(heightAt, resolution, bump) {
  const halfStep = 0.5 / resolution;
  const slopeScale = bump * resolution / 32;
  const normalData = new Uint8ClampedArray(resolution * resolution * 4);
  const topHeights = new Float64Array(resolution);
  for (let row = 0; row < resolution; row++) {
    const v = (row + 0.5) / resolution;
    let leftHeight = heightAt(0.5 / resolution - halfStep, v);
    for (let column = 0; column < resolution; column++) {
      const u = (column + 0.5) / resolution;
      const rightHeight = heightAt(u + halfStep, v);
      const topHeight = row === 0 ? heightAt(u, v - halfStep) : topHeights[column];
      const bottomHeight = heightAt(u, v + halfStep);
      topHeights[column] = bottomHeight;
      const slopeAcross = (rightHeight - leftHeight) * slopeScale;
      const slopeUp = (bottomHeight - topHeight) * slopeScale;
      leftHeight = rightHeight;
      writeNormalSample(normalData, (row * resolution + column) * 4, slopeAcross, slopeUp);
    }
  }
  return normalData;
}
