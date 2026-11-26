import { groupOf, numberInRange, onlyKeys } from './post-fields.js';

// Local exposure (as in UE5, where a contrast scale of 1 leaves a range alone and less than 1 compresses it):
// shared by the rasterizer shader (post-steps.js) and the path tracer output (path-tracer.js).
export const LOCAL_TONE_TAPS = 24;
export const LOCAL_TONE_PIVOT = 0.18;
// The most the base of a shadow is lifted, in natural-log units (2 stops), so deep blacks stay black.
export const LOCAL_TONE_MAXIMUM_LIFT = 1.386;
// How round the knee between the untouched midtones and the compressed tail is, in squared natural-log units.
export const LOCAL_TONE_KNEE_SOFTNESS = 0.04;

const GOLDEN_ANGLE = 2.3999632;
const LUMINANCE_FLOOR = 0.0001;
const EDGE_VARIANCE = 0.5;
const SPATIAL_FALLOFF = 0.8;
const BASE_LOD_DIVISOR = 3;
const PIVOT_LOG = Math.log(LOCAL_TONE_PIVOT);
const LUMINANCE_WEIGHTS = [0.2126, 0.7152, 0.0722];
const LOCAL_TONE_DEFAULTS = {
  strength: [0.4, 0, 1],
  highlightContrast: [0.6, 0, 1],
  shadowContrast: [0.6, 0, 1],
  detail: [1, 0, 2],
  blurRadius: [0.08, 0.01, 0.25],
  midtoneRange: [1.5, 0, 4],
};

/** Resolves and validates `effects.localToneMapping` fields with bounded defaults. */
export function resolveLocalToneMapping(input) {
  const group = groupOf(input, 'localToneMapping');
  onlyKeys(group, Object.keys(LOCAL_TONE_DEFAULTS), 'localToneMapping');
  const resolved = {};
  for (const [field, [fallback, minimum, maximum]] of Object.entries(LOCAL_TONE_DEFAULTS)) {
    resolved[field] = numberInRange(group[field], fallback, minimum, maximum, `localToneMapping.${field}`);
  }
  return resolved;
}

/** True when local tone mapping changes the frame (non-zero strength and at least one non-identity field). */
export function isLocalToneMappingActive(localToneMapping) {
  if (!localToneMapping || localToneMapping.strength === 0) return false;
  return localToneMapping.highlightContrast !== 1 || localToneMapping.shadowContrast !== 1 || localToneMapping.detail !== 1;
}

function kneeTail(distancePastKnee) {
  return 0.5 * (distancePastKnee + Math.sqrt(distancePastKnee * distancePastKnee + LOCAL_TONE_KNEE_SOFTNESS));
}

/**
 * The curve of the local tone mapping step on one pixel: natural-log luminances in, the mapped natural-log luminance out.
 * Only the base past the knee (`midtoneRange` stops either side of middle grey) is compressed, shadow lift is capped, and detail is added back.
 */
export function localToneMappedLog(baseLog, detailLog, settings) {
  const offset = baseLog - PIVOT_LOG;
  const kneeLog = settings.midtoneRange * Math.LN2;
  const highDrop = kneeTail(offset - kneeLog) * (1 - settings.highlightContrast) * settings.strength;
  const lowWanted = kneeTail(-offset - kneeLog) * (1 - settings.shadowContrast) * settings.strength;
  const lowLift = LOCAL_TONE_MAXIMUM_LIFT * Math.tanh(lowWanted / LOCAL_TONE_MAXIMUM_LIFT);
  return PIVOT_LOG + offset - highDrop + lowLift + detailLog * settings.detail;
}

const clampRange = (value, low, high) => Math.min(high, Math.max(low, value));

function buildLuminanceMips(linear, width, height, exposure) {
  const levelZero = new Float32Array(width * height);
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    const offset = pixelIndex * 3;
    let total = 0;
    for (let channel = 0; channel < 3; channel++) {
      const value = linear[offset + channel];
      if (value > 0 && Number.isFinite(value)) total += value * exposure * LUMINANCE_WEIGHTS[channel];
    }
    levelZero[pixelIndex] = total;
  }
  const levels = [{ data: levelZero, width, height }];
  for (let previous = levels[0]; previous.width > 1 || previous.height > 1; previous = levels[levels.length - 1]) {
    const nextWidth = Math.max(1, previous.width >> 1);
    const nextHeight = Math.max(1, previous.height >> 1);
    const nextData = new Float32Array(nextWidth * nextHeight);
    for (let row = 0; row < nextHeight; row++) {
      const rowZero = row * 2 * previous.width;
      const rowOne = Math.min(row * 2 + 1, previous.height - 1) * previous.width;
      for (let column = 0; column < nextWidth; column++) {
        const columnZero = column * 2;
        const columnOne = Math.min(columnZero + 1, previous.width - 1);
        nextData[row * nextWidth + column] = 0.25 * (
          previous.data[rowZero + columnZero] + previous.data[rowZero + columnOne]
          + previous.data[rowOne + columnZero] + previous.data[rowOne + columnOne]
        );
      }
    }
    levels.push({ data: nextData, width: nextWidth, height: nextHeight });
  }
  return levels;
}

function sampleMipBilinear(level, coordinateU, coordinateV) {
  const sampleX = clampRange(clampRange(coordinateU, 0, 1) * level.width - 0.5, 0, level.width - 1);
  const sampleY = clampRange(clampRange(coordinateV, 0, 1) * level.height - 0.5, 0, level.height - 1);
  const left = Math.floor(sampleX);
  const top = Math.floor(sampleY);
  const right = Math.min(level.width - 1, left + 1);
  const bottom = Math.min(level.height - 1, top + 1);
  const fractionX = sampleX - left;
  const fractionY = sampleY - top;
  const topRow = top * level.width;
  const bottomRow = bottom * level.width;
  const topMix = level.data[topRow + left] * (1 - fractionX) + level.data[topRow + right] * fractionX;
  const bottomMix = level.data[bottomRow + left] * (1 - fractionX) + level.data[bottomRow + right] * fractionX;
  return topMix + (bottomMix - topMix) * fractionY;
}

/**
 * Applies local tone mapping on exposure-scaled linear RGB pixels (width * height * 3) before the view transform.
 * Returns a new Float32Array without mutating `linear`.
 */
export function applyLocalToneMapping(linear, width, height, settings, exposure = 1) {
  const pixelCount = width * height;
  const levels = buildLuminanceMips(linear, width, height, exposure);
  const levelZero = levels[0].data;
  const radiusPixels = settings.blurRadius * height;
  const baseLevel = clampRange(Math.log2(radiusPixels / BASE_LOD_DIVISOR), 0, levels.length - 1);
  const lowIndex = Math.floor(baseLevel);
  const highIndex = Math.min(levels.length - 1, lowIndex + 1);
  const levelBlend = baseLevel - lowIndex;
  const tapOffsets = Array.from({ length: LOCAL_TONE_TAPS }, (_, tapIndex) => {
    const ring = Math.sqrt((tapIndex + 0.5) / LOCAL_TONE_TAPS);
    const angle = tapIndex * GOLDEN_ANGLE;
    return [Math.cos(angle) * ring * radiusPixels / width, Math.sin(angle) * ring * radiusPixels / height, 1 - ring * ring * SPATIAL_FALLOFF];
  });
  const output = new Float32Array(pixelCount * 3);
  for (let row = 0; row < height; row++) {
    const centerV = (row + 0.5) / height;
    for (let column = 0; column < width; column++) {
      const pixelIndex = row * width + column;
      const centerU = (column + 0.5) / width;
      const centerLog = Math.log(Math.max(levelZero[pixelIndex], LUMINANCE_FLOOR));
      let sum = centerLog;
      let weightSum = 1;
      for (const [offsetU, offsetV, spatialWeight] of tapOffsets) {
        const tapCoordinateU = centerU + offsetU;
        const tapCoordinateV = centerV + offsetV;
        const lowSample = sampleMipBilinear(levels[lowIndex], tapCoordinateU, tapCoordinateV);
        const tapLuminance = levelBlend === 0 ? lowSample : lowSample + (sampleMipBilinear(levels[highIndex], tapCoordinateU, tapCoordinateV) - lowSample) * levelBlend;
        const difference = Math.log(Math.max(tapLuminance, LUMINANCE_FLOOR)) - centerLog;
        const weight = spatialWeight * Math.exp(-(difference * difference) / EDGE_VARIANCE);
        sum += (centerLog + difference) * weight;
        weightSum += weight;
      }
      const baseLog = sum / weightSum;
      const gain = Math.exp(localToneMappedLog(baseLog, centerLog - baseLog, settings) - centerLog) * exposure;
      const offset = pixelIndex * 3;
      for (let channel = 0; channel < 3; channel++) output[offset + channel] = linear[offset + channel] * gain;
    }
  }
  return output;
}
