import { clampUnit, smoothStep, createImage } from './material-texture-kit.js';

// Volumetric cloud layer for environment.sky (type: 'physical') (#2799): spherical-shell raymarcher with dual-lobe
// Henyey-Greenstein silver lining, multi-scattering Beer-Powder attenuation, deterministic time/wind advection, and
// an optional baked ground shadow transmittance map.
export const CLOUD_TYPES = Object.freeze(['cumulus', 'stratus', 'cirrus']);
export const CLOUD_FIELDS = Object.freeze(['coverage', 'altitude', 'thickness', 'density', 'type', 'wind', 'seed', 'time', 'shadows']);

const TYPE_DEFAULTS = Object.freeze({
  cumulus: Object.freeze({ altitude: 1500, thickness: 950, density: 0.75 }),
  stratus: Object.freeze({ altitude: 1100, thickness: 480, density: 0.55 }),
  cirrus: Object.freeze({ altitude: 8500, thickness: 400, density: 0.35 }),
});

const CLOUD_LIMITS = Object.freeze({
  coverage: [0, 1, 'a share from 0 (clear) to 1 (overcast), such as 0.48'],
  altitude: [100, 20000, 'metres above ground, such as 1500'],
  thickness: [50, 10000, 'metres, such as 950'],
  density: [0, 4, 'extinction scale from 0 to 4, such as 0.75'],
  windSpeed: [-200, 200, 'metres per second, such as [12, 4]'],
  time: [-1e6, 1e6, 'seconds, such as 15'],
  seed: [0, 0x7fffffff, 'a whole number, such as 1'],
});

const EARTH_RADIUS = 6_371_000;
const MAX_RAY_DISTANCE = 85_000;
const HEMISPHERE_WIDTH = 640;
const HEMISPHERE_ROWS = 160;
const FOUR_PI = Math.PI * 4;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validates `environment.sky.clouds`, filling per-type defaults. Returns null when cleared. */
export function resolveSkyClouds(input, fail) {
  if (input === null || input === false) return null;
  if (!isPlainObject(input)) {
    throw fail('environment.sky.clouds', input, 'an object such as { coverage: 0.5, type: "cumulus" }');
  }
  const unknown = Object.keys(input).filter(key => !CLOUD_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw fail(`environment.sky.clouds.${unknown[0]}`, input[unknown[0]], `one of ${CLOUD_FIELDS.join(', ')}`);
  }
  const type = input.type ?? 'cumulus';
  if (!CLOUD_TYPES.includes(type)) {
    throw fail('environment.sky.clouds.type', type, `one of ${CLOUD_TYPES.join(', ')}`);
  }
  const typeDefaults = TYPE_DEFAULTS[type];
  const resolved = { type };
  for (const [field, [minimum, maximum, hint]] of [
    ['coverage', CLOUD_LIMITS.coverage],
    ['altitude', CLOUD_LIMITS.altitude],
    ['thickness', CLOUD_LIMITS.thickness],
    ['density', CLOUD_LIMITS.density],
    ['time', CLOUD_LIMITS.time],
  ]) {
    const fallback = field === 'coverage' ? 0.48 : field === 'time' ? 0 : typeDefaults[field];
    const value = input[field] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw fail(`environment.sky.clouds.${field}`, value, `a number from ${minimum} to ${maximum}, ${hint}`);
    }
    resolved[field] = value;
  }
  const seed = input.seed ?? 1;
  const [minSeed, maxSeed, seedHint] = CLOUD_LIMITS.seed;
  if (!Number.isInteger(seed) || seed < minSeed || seed > maxSeed) {
    throw fail('environment.sky.clouds.seed', seed, seedHint);
  }
  resolved.seed = seed;
  const wind = input.wind ?? [0, 0];
  const [minWind, maxWind, windHint] = CLOUD_LIMITS.windSpeed;
  if (!Array.isArray(wind) || wind.length !== 2 || wind.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < minWind || value > maxWind)) {
    throw fail('environment.sky.clouds.wind', wind, `two numbers [windX, windZ] in ${minWind} to ${maxWind} ${windHint}`);
  }
  resolved.wind = [wind[0], wind[1]];
  const shadows = input.shadows ?? false;
  if (typeof shadows !== 'boolean') {
    throw fail('environment.sky.clouds.shadows', shadows, 'true or false');
  }
  resolved.shadows = shadows;
  return resolved;
}

function hash3(cellX, cellY, cellZ, seed) {
  let hash = Math.imul(cellX, 0x27d4eb2d) ^ Math.imul(cellY, 0x165667b1) ^ Math.imul(cellZ, 0x85ebca6b) ^ Math.imul(seed, 0x9e3779b1);
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d);
  hash = Math.imul(hash ^ (hash >>> 12), 0x297a2d39);
  return ((hash ^ (hash >>> 15)) >>> 0) / 4294967296;
}

function quintic(fraction) {
  return fraction * fraction * fraction * (fraction * (fraction * 6 - 15) + 10);
}

function lerp(start, end, factor) {
  return start + (end - start) * factor;
}

function valueNoise3(positionX, positionY, positionZ, seed) {
  const floorX = Math.floor(positionX);
  const floorY = Math.floor(positionY);
  const floorZ = Math.floor(positionZ);
  const weightX = quintic(positionX - floorX);
  const weightY = quintic(positionY - floorY);
  const weightZ = quintic(positionZ - floorZ);

  const corner000 = hash3(floorX, floorY, floorZ, seed);
  const corner100 = hash3(floorX + 1, floorY, floorZ, seed);
  const corner010 = hash3(floorX, floorY + 1, floorZ, seed);
  const corner110 = hash3(floorX + 1, floorY + 1, floorZ, seed);
  const corner001 = hash3(floorX, floorY, floorZ + 1, seed);
  const corner101 = hash3(floorX + 1, floorY, floorZ + 1, seed);
  const corner011 = hash3(floorX, floorY + 1, floorZ + 1, seed);
  const corner111 = hash3(floorX + 1, floorY + 1, floorZ + 1, seed);

  const bottomFront = lerp(corner000, corner100, weightX);
  const topFront = lerp(corner010, corner110, weightX);
  const bottomBack = lerp(corner001, corner101, weightX);
  const topBack = lerp(corner011, corner111, weightX);

  return lerp(lerp(bottomFront, topFront, weightY), lerp(bottomBack, topBack, weightY), weightZ);
}

function fbm3(positionX, positionY, positionZ, seed, octaves) {
  let total = 0;
  let amplitude = 0.5;
  let amplitudeSum = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    total += valueNoise3(positionX * frequency, positionY * frequency, positionZ * frequency, seed + octave * 131) * amplitude;
    amplitudeSum += amplitude;
    amplitude *= 0.5;
    frequency *= 2.04;
  }
  return total / amplitudeSum;
}

/** Deterministic volumetric cloud density (extinction per metre) at world position `(worldX, worldY, worldZ)`. */
export function sampleCloudDensity(worldX, worldY, worldZ, clouds) {
  if (clouds.coverage <= 0 || clouds.density <= 0) return 0;
  const heightFraction = (worldY - clouds.altitude) / clouds.thickness;
  if (heightFraction <= 0 || heightFraction >= 1) return 0;

  const advectedX = worldX - clouds.wind[0] * clouds.time;
  const advectedZ = worldZ - clouds.wind[1] * clouds.time;

  let heightProfile;
  let shape;
  if (clouds.type === 'stratus') {
    heightProfile = smoothStep(0, 0.25, heightFraction) * (1 - smoothStep(0.65, 1, heightFraction));
    const macro = fbm3(advectedX / 3800, heightFraction * 1.4, advectedZ / 3800, clouds.seed, 3);
    const detail = fbm3(advectedX / 1100, heightFraction * 2.2, advectedZ / 1100, clouds.seed + 19, 2);
    shape = macro * 0.72 + detail * 0.28 - 0.06;
  } else if (clouds.type === 'cirrus') {
    heightProfile = smoothStep(0, 0.3, heightFraction) * (1 - smoothStep(0.55, 1, heightFraction));
    const windSpeed = Math.hypot(clouds.wind[0], clouds.wind[1]);
    const dirX = windSpeed > 0.01 ? clouds.wind[0] / windSpeed : 0.86;
    const dirZ = windSpeed > 0.01 ? clouds.wind[1] / windSpeed : 0.51;
    const along = advectedX * dirX + advectedZ * dirZ;
    const across = -advectedX * dirZ + advectedZ * dirX;
    const warp = valueNoise3(along / 4200, 0.3, across / 2200, clouds.seed + 7) - 0.5;
    const streaks = fbm3(along / 7800, heightFraction, (across + warp * 1400) / 1450, clouds.seed + 37, 2);
    const patchMask = valueNoise3(advectedX / 6200, 0.5, advectedZ / 6200, clouds.seed + 53);
    shape = streaks * 0.72 + patchMask * 0.28;
  } else {
    heightProfile = smoothStep(0, 0.14, heightFraction) * (1 - smoothStep(0.55, 1, heightFraction));
    const macro = fbm3(advectedX / 2100, heightFraction * 1.35, advectedZ / 2100, clouds.seed, 4);
    const detail = valueNoise3(advectedX / 620, heightFraction * 2.9, advectedZ / 620, clouds.seed + 29);
    shape = macro - (1 - detail) * 0.34 * (0.35 + 0.65 * heightFraction);
  }

  const threshold = 1 - clouds.coverage;
  const remapped = clampUnit((shape - threshold) / Math.max(0.14, clouds.coverage * 0.78));
  const scaled = remapped * remapped * heightProfile * clouds.density;
  return scaled * (clouds.type === 'cirrus' ? 0.0022 : 0.0055);
}

function henyeyGreenstein(cosine, anisotropy) {
  const squared = anisotropy * anisotropy;
  const denominator = Math.max(1e-4, 1 + squared - 2 * anisotropy * cosine);
  return (1 - squared) / (FOUR_PI * denominator * Math.sqrt(denominator));
}

function shellDistance(directionY, shellHeight) {
  const term = EARTH_RADIUS * directionY;
  const radialDelta = shellHeight * (2 * EARTH_RADIUS + shellHeight);
  return Math.max(0, -term + Math.sqrt(Math.max(0, term * term + radialDelta)));
}

function sunOpticalDepth(sampleX, sampleY, sampleZ, sun, clouds) {
  const sunY = Math.max(0.04, sun[1]);
  const sunScale = 1 / Math.max(0.1, sunY);
  const stepSpan = Math.min(clouds.thickness * 0.65 * sunScale, clouds.thickness * 2.5);
  let opticalDepth = 0;
  let previousRatio = 0;
  for (let step = 1; step <= 4; step++) {
    const ratio = (step / 4) ** 1.4;
    const distance = stepSpan * ratio;
    const weight = stepSpan * (ratio - previousRatio);
    previousRatio = ratio;
    const sunX = sampleX + sun[0] * distance;
    const sunYPos = sampleY + sunY * distance;
    const sunZ = sampleZ + sun[2] * distance;
    if (sunYPos >= clouds.altitude + clouds.thickness) break;
    opticalDepth += sampleCloudDensity(sunX, sunYPos, sunZ, clouds) * weight;
  }
  return opticalDepth;
}

/**
 * Integrates volumetric cloud scattering and transmittance along unit ray `direction`.
 * Returns `{ scattered: [r, g, b], transmittance }`.
 */
export function marchSkyClouds(direction, sun, sunRadiance, ambientZenith, ambientHorizon, clouds, jitter = 0.5) {
  if (direction[1] <= 0.005 || clouds.coverage <= 0 || clouds.density <= 0) {
    return { scattered: [0, 0, 0], transmittance: 1 };
  }
  const distanceStart = shellDistance(direction[1], clouds.altitude);
  const distanceEnd = Math.min(shellDistance(direction[1], clouds.altitude + clouds.thickness), MAX_RAY_DISTANCE);
  if (distanceEnd <= distanceStart) {
    return { scattered: [0, 0, 0], transmittance: 1 };
  }

  const steps = clouds.type === 'cumulus' ? 10 : 8;
  const stepLength = (distanceEnd - distanceStart) / steps;
  const sunCosine = direction[0] * sun[0] + direction[1] * sun[1] + direction[2] * sun[2];
  const forwardPhase = henyeyGreenstein(sunCosine, 0.82);
  const backPhase = henyeyGreenstein(sunCosine, -0.22);
  const phase = (0.74 * forwardPhase + 0.26 * backPhase) * 3.1;
  const horizonFade = smoothStep(0.005, 0.085, direction[1]);

  let transmittance = 1;
  let scatteredRed = 0;
  let scatteredGreen = 0;
  let scatteredBlue = 0;

  for (let step = 0; step < steps; step++) {
    const rayDistance = distanceStart + (step + jitter) * stepLength;
    const sampleX = direction[0] * rayDistance;
    const radialRadius = EARTH_RADIUS + direction[1] * rayDistance;
    const horizontalSquared = (direction[0] * rayDistance) ** 2 + (direction[2] * rayDistance) ** 2;
    const worldY = Math.sqrt(Math.max(0, radialRadius * radialRadius + horizontalSquared)) - EARTH_RADIUS;
    const sampleZ = direction[2] * rayDistance;

    const sigma = sampleCloudDensity(sampleX, worldY, sampleZ, clouds);
    if (sigma <= 1e-6) continue;

    const stepOptical = sigma * stepLength;
    const stepTransmittance = Math.exp(-stepOptical);
    const sunDepth = sunOpticalDepth(sampleX, worldY, sampleZ, sun, clouds) * 1.65;
    const powder = 1 - 0.5 * Math.exp(-stepOptical * 2.4);
    const directTerm = (Math.exp(-sunDepth) + 0.24 * Math.exp(-sunDepth * 0.25)) * powder * phase;

    const heightShare = clampUnit((worldY - clouds.altitude) / clouds.thickness);
    const ambientWeight = 0.16 + 0.48 * heightShare;
    const stepScatterWeight = (1 - stepTransmittance) * transmittance;

    const lightRed = sunRadiance[0] * directTerm + lerp(ambientHorizon[0], ambientZenith[0], heightShare) * ambientWeight;
    const lightGreen = sunRadiance[1] * directTerm + lerp(ambientHorizon[1], ambientZenith[1], heightShare) * ambientWeight;
    const lightBlue = sunRadiance[2] * directTerm + lerp(ambientHorizon[2], ambientZenith[2], heightShare) * ambientWeight;

    scatteredRed += lightRed * stepScatterWeight;
    scatteredGreen += lightGreen * stepScatterWeight;
    scatteredBlue += lightBlue * stepScatterWeight;
    transmittance *= stepTransmittance;
    if (transmittance < 0.015) {
      transmittance = 0;
      break;
    }
  }

  return {
    scattered: [scatteredRed * horizonFade, scatteredGreen * horizonFade, scatteredBlue * horizonFade],
    transmittance: 1 - (1 - transmittance) * horizonFade,
  };
}

/**
 * Renders the upper hemisphere cloud grid (`512x128`) and returns a bilinear sampler
 * `sample(rowFraction, columnFraction)` over polar `[0, 1]` and azimuth `[0, 1)`.
 */
export function renderCloudHemisphere(sun, sunRadiance, ambientZenith, ambientHorizon, clouds) {
  const cellCount = HEMISPHERE_WIDTH * HEMISPHERE_ROWS;
  const grid = new Float32Array(cellCount * 4);
  const halfPi = Math.PI * 0.5;
  const twoPi = Math.PI * 2;

  for (let row = 0; row < HEMISPHERE_ROWS; row++) {
    const polar = ((row + 0.5) / HEMISPHERE_ROWS) * halfPi;
    const sinPolar = Math.sin(polar);
    const cosPolar = Math.cos(polar);
    for (let column = 0; column < HEMISPHERE_WIDTH; column++) {
      const azimuth = ((column + 0.5) / HEMISPHERE_WIDTH - 0.5) * twoPi;
      const direction = [sinPolar * Math.sin(azimuth), cosPolar, -sinPolar * Math.cos(azimuth)];
      const jitter = ((column * 73 + row * 37) % 16) / 16 + 0.03;
      const { scattered, transmittance } = marchSkyClouds(direction, sun, sunRadiance, ambientZenith, ambientHorizon, clouds, jitter);
      const offset = (row * HEMISPHERE_WIDTH + column) * 4;
      grid[offset] = scattered[0];
      grid[offset + 1] = scattered[1];
      grid[offset + 2] = scattered[2];
      grid[offset + 3] = transmittance;
    }
  }

  return function sampleCloudHemisphere(polarFraction, azimuthFraction) {
    const clampedPolar = Math.min(1, Math.max(0, polarFraction));
    const gridRow = clampedPolar * HEMISPHERE_ROWS - 0.5;
    const row0 = Math.max(0, Math.min(HEMISPHERE_ROWS - 1, Math.floor(gridRow)));
    const row1 = Math.min(HEMISPHERE_ROWS - 1, row0 + 1);
    const rowWeight = Math.max(0, Math.min(1, gridRow - row0));

    const wrappedAzimuth = azimuthFraction - Math.floor(azimuthFraction);
    const gridColumn = wrappedAzimuth * HEMISPHERE_WIDTH - 0.5;
    const baseColumn = Math.floor(gridColumn);
    const column0 = ((baseColumn % HEMISPHERE_WIDTH) + HEMISPHERE_WIDTH) % HEMISPHERE_WIDTH;
    const column1 = (column0 + 1) % HEMISPHERE_WIDTH;
    const columnWeight = gridColumn - baseColumn;

    const index00 = (row0 * HEMISPHERE_WIDTH + column0) * 4;
    const index10 = (row0 * HEMISPHERE_WIDTH + column1) * 4;
    const index01 = (row1 * HEMISPHERE_WIDTH + column0) * 4;
    const index11 = (row1 * HEMISPHERE_WIDTH + column1) * 4;

    const sampleChannel = channel => {
      const top = lerp(grid[index00 + channel], grid[index10 + channel], columnWeight);
      const bottom = lerp(grid[index01 + channel], grid[index11 + channel], columnWeight);
      return lerp(top, bottom, rowWeight);
    };
    return [sampleChannel(0), sampleChannel(1), sampleChannel(2), sampleChannel(3)];
  };
}

/** Sun transmittance through the cloud layer down to ground point `(worldX, 0, worldZ)`. */
export function cloudShadowTransmittance(clouds, sun, worldX, worldZ) {
  if (!clouds || clouds.coverage <= 0 || clouds.density <= 0) return 1;
  const sunY = Math.max(0.05, sun[1]);
  const entryDistance = clouds.altitude / sunY;
  const spanDistance = clouds.thickness / sunY;
  const steps = 5;
  const stepLength = spanDistance / steps;
  let opticalDepth = 0;
  for (let step = 0; step < steps; step++) {
    const distance = entryDistance + (step + 0.5) * stepLength;
    const sampleX = worldX + sun[0] * distance;
    const sampleY = sunY * distance;
    const sampleZ = worldZ + sun[2] * distance;
    opticalDepth += sampleCloudDensity(sampleX, sampleY, sampleZ, clouds) * stepLength;
  }
  return Math.exp(-opticalDepth);
}

/** Bakes a deterministic 2D linear RGBA8 cloud shadow transmittance map centered around the origin. */
export function bakeCloudShadowMap(clouds, sun, { resolution = 256, extent = 1000 } = {}) {
  const data = new Uint8ClampedArray(resolution * resolution * 4);
  for (let row = 0; row < resolution; row++) {
    const worldZ = ((row + 0.5) / resolution * 2 - 1) * extent;
    for (let column = 0; column < resolution; column++) {
      const worldX = ((column + 0.5) / resolution * 2 - 1) * extent;
      const value = Math.round(clampUnit(cloudShadowTransmittance(clouds, sun, worldX, worldZ)) * 255);
      const offset = (row * resolution + column) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return {
    image: createImage(data, resolution, resolution),
    colorSpace: 'linear',
    bounds: Object.freeze([-extent, -extent, extent, extent]),
  };
}
