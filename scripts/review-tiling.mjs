// Detects a texture repeating in a grid in a rendered picture, for scene_review `checks: "realism"`. The picture is cut to
// a bounded size, high-passed so smooth shading does not correlate with itself, and its normalised autocorrelation is
// searched for a peak at a lag that a natural picture does not have. Cost is fixed: ANALYSIS_SIZE squared pixels times
// the lags searched, about 30 million multiply-adds, whatever the render size.
import { luminanceFromPixels, resizePlane } from './preview-checks.mjs';

export const TILING_LIMITS = Object.freeze({
  analysisSize: 96,
  // The shortest repeat counted, in analysis pixels: below it a lag is the grain of the picture, not a tile.
  minimumPeriod: 8,
  // Normalised autocorrelation a repeat must reach, and a second peak at twice the lag when that fits in the picture.
  minimumStrength: 0.5,
  minimumHarmonic: 0.3,
  // A flat picture has nothing to repeat.
  minimumContrast: 2,
  blurRadius: 4,
});

function boxBlur(plane, radius) {
  const { width, height, values } = plane;
  const horizontal = new Float32Array(values.length);
  const result = new Float32Array(values.length);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      let sum = 0;
      let count = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const sampled = column + offset;
        if (sampled < 0 || sampled >= width) continue;
        sum += values[row * width + sampled];
        count++;
      }
      horizontal[row * width + column] = sum / count;
    }
  }
  for (let column = 0; column < width; column++) {
    for (let row = 0; row < height; row++) {
      let sum = 0;
      let count = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const sampled = row + offset;
        if (sampled < 0 || sampled >= height) continue;
        sum += horizontal[sampled * width + column];
        count++;
      }
      result[row * width + column] = sum / count;
    }
  }
  return result;
}

/** The plane at analysis size with its smooth part removed. Returns null for a picture too flat to repeat. */
function highPassed(plane, { analysisSize, blurRadius, minimumContrast }) {
  const scale = Math.min(1, analysisSize / Math.max(plane.width, plane.height));
  const small = resizePlane(plane, Math.max(2, Math.round(plane.width * scale)), Math.max(2, Math.round(plane.height * scale)));
  const smooth = boxBlur(small, blurRadius);
  // The blur is cut short at the edges, so the border keeps the smooth part: drop it.
  const width = small.width - 2 * blurRadius;
  const height = small.height - 2 * blurRadius;
  if (width < 4 * blurRadius || height < 4 * blurRadius) return null;
  const detail = new Float32Array(width * height);
  let energy = 0;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const source = (row + blurRadius) * small.width + column + blurRadius;
      const value = small.values[source] - smooth[source];
      detail[row * width + column] = value;
      energy += value * value;
    }
  }
  if (Math.sqrt(energy / detail.length) < minimumContrast / 8) return null;
  return { width, height, values: detail, scale: plane.width / small.width };
}

/** Correlation of the detail with itself shifted by (shiftX, shiftY), normalised by the energy of the two overlapping parts. */
function correlationAt({ width, height, values }, shiftX, shiftY) {
  let product = 0;
  let firstEnergy = 0;
  let secondEnergy = 0;
  for (let row = 0; row < height - shiftY; row++) {
    for (let column = Math.max(0, -shiftX); column < Math.min(width, width - shiftX); column++) {
      const first = values[row * width + column];
      const second = values[(row + shiftY) * width + column + shiftX];
      product += first * second;
      firstEnergy += first * first;
      secondEnergy += second * second;
    }
  }
  const norm = Math.sqrt(firstEnergy * secondEnergy);
  return norm > 0 ? product / norm : 0;
}

/**
 * The strongest repeat of a luminance plane, or null when it has none. `periodX` and `periodY` are in pixels of the
 * original plane (0 along an axis the texture does not repeat on), `strength` is the normalised autocorrelation at that lag.
 */
export function detectTiling(plane, limits = TILING_LIMITS) {
  const detail = highPassed(plane, limits);
  if (detail === null) return null;
  const maxShiftX = Math.floor(detail.width / 2);
  const maxShiftY = Math.floor(detail.height / 2);
  let best = null;
  for (let shiftY = 0; shiftY <= maxShiftY; shiftY++) {
    for (let shiftX = -maxShiftX; shiftX <= maxShiftX; shiftX++) {
      if (shiftY === 0 && shiftX <= 0) continue;
      if (Math.max(Math.abs(shiftX), shiftY) < limits.minimumPeriod) continue;
      const strength = correlationAt(detail, shiftX, shiftY);
      if (strength >= limits.minimumStrength && (best === null || strength > best.strength)) best = { shiftX, shiftY, strength };
    }
  }
  if (best === null) return null;
  const doubledFits = Math.abs(best.shiftX) * 2 <= detail.width - limits.minimumPeriod && best.shiftY * 2 <= detail.height - limits.minimumPeriod;
  if (doubledFits && correlationAt(detail, best.shiftX * 2, best.shiftY * 2) < limits.minimumHarmonic) return null;
  const scale = detail.scale;
  return { periodX: Math.round(Math.abs(best.shiftX) * scale), periodY: Math.round(best.shiftY * scale), strength: best.strength };
}

/** The luminance plane of one cell of a decoded RGBA picture. */
export function cellPlane({ width, data }, { x, y, cellWidth, cellHeight }) {
  const cell = Buffer.alloc(cellWidth * cellHeight * 4);
  for (let row = 0; row < cellHeight; row++) {
    data.copy(cell, row * cellWidth * 4, ((y + row) * width + x) * 4, ((y + row) * width + x + cellWidth) * 4);
  }
  return luminanceFromPixels({ width: cellWidth, height: cellHeight, data: cell });
}
