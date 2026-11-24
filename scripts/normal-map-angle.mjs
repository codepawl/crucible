// Angle between two normal passes, for measuring a normal map against the high-poly mesh it was baked from.
// A normal pass stores the world normal as n * 0.5 + 0.5 in red, green and blue, and zero where nothing is drawn
// (see "normal" in render-passes.js). Both functions here are pure: pass in RGBA float arrays, get numbers back.

const PERCENTILE_NINETY_FIVE = 0.95;

/** The unit normal stored in pixel `pixel` of a normal pass, or null where the pass is empty (all three channels zero). */
export function decodePassNormal(pixels, pixel) {
  const red = pixels[pixel * 4];
  const green = pixels[pixel * 4 + 1];
  const blue = pixels[pixel * 4 + 2];
  if (red === 0 && green === 0 && blue === 0) return null;
  const x = red * 2 - 1;
  const y = green * 2 - 1;
  const z = blue * 2 - 1;
  const length = Math.hypot(x, y, z);
  if (length === 0) return null;
  return [x / length, y / length, z / length];
}

/** Pixels where both passes drew something, as a Uint8Array of 0 and 1. The two silhouettes differ, so only the overlap is compared. */
export function sharedCoverage(passA, passB, pixelCount) {
  const mask = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    mask[pixel] = decodePassNormal(passA, pixel) && decodePassNormal(passB, pixel) ? 1 : 0;
  }
  return mask;
}

/** `mask` with every pixel within `radius` pixels (square neighbourhood) of an uncovered pixel or the image edge cleared. */
export function erodeMask(mask, width, height, radius) {
  if (!Number.isInteger(radius) || radius < 0) throw new RangeError(`radius must be a whole number of pixels from 0 up; got ${radius}.`);
  const eroded = new Uint8Array(mask.length);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      let covered = 1;
      for (let rowOffset = -radius; rowOffset <= radius && covered; rowOffset++) {
        for (let columnOffset = -radius; columnOffset <= radius; columnOffset++) {
          const neighbourRow = row + rowOffset;
          const neighbourColumn = column + columnOffset;
          const inside = neighbourRow >= 0 && neighbourRow < height && neighbourColumn >= 0 && neighbourColumn < width;
          if (!inside || !mask[neighbourRow * width + neighbourColumn]) {
            covered = 0;
            break;
          }
        }
      }
      eroded[row * width + column] = covered;
    }
  }
  return eroded;
}

/** The angle in degrees between the two passes at every pixel, 0 outside `mask`. */
export function pixelAngles(passA, passB, mask) {
  const angles = new Float32Array(mask.length);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (!mask[pixel]) continue;
    const first = decodePassNormal(passA, pixel);
    const second = decodePassNormal(passB, pixel);
    const cosine = Math.min(1, Math.max(-1, first[0] * second[0] + first[1] * second[1] + first[2] * second[2]));
    angles[pixel] = Math.acos(cosine) * 180 / Math.PI;
  }
  return angles;
}

/** Mean and 95th percentile (nearest rank) of the angles inside `mask`, with how many pixels that is. Throws on an empty mask. */
export function angleStatistics(angles, mask) {
  const inside = [];
  for (let pixel = 0; pixel < mask.length; pixel++) if (mask[pixel]) inside.push(angles[pixel]);
  if (inside.length === 0) throw new RangeError('The mask covers no pixel, so there is no angle to measure. Pass two passes that draw the same object.');
  inside.sort((left, right) => left - right);
  const total = inside.reduce((sum, value) => sum + value, 0);
  const rank = Math.max(1, Math.ceil(inside.length * PERCENTILE_NINETY_FIVE));
  return { pixels: inside.length, meanDegrees: total / inside.length, p95Degrees: inside[rank - 1] };
}

/** Angle statistics of `passA` against `passB` over the pixels both draw. */
export function measureNormalPassAngle(passA, passB, pixelCount) {
  const mask = sharedCoverage(passA, passB, pixelCount);
  return angleStatistics(pixelAngles(passA, passB, mask), mask);
}

/** The most the generated-tangent path may differ from the spec pass, in mean degrees: it must draw what the glTF definition says. */
export const TANGENT_GATE_MEAN_DEGREES = 0.5;

/** Whether `statistics` (from angleStatistics) is within the tangent gate. */
export function meetsTangentGate(statistics) {
  return statistics.meanDegrees <= TANGENT_GATE_MEAN_DEGREES;
}
