// Pure checks behind scripts/evidence.mjs (#3269): frame metrics, the single-frame jump finder, the subject box projected to the
// frame and its margin, and highlight and shadow clipping. No file, browser or sharp access, so tests feed them synthetic buffers.

/** A single-frame step above this many levels (0 to 255) is a jump, whatever the rest of the clip does. */
export const DEFAULT_JUMP_LEVELS = 5;
/** A step above this many times the clip's median step is only a note (never a FAIL) once it is also above MINIMUM_NOTE_LEVELS. */
export const DEFAULT_JUMP_MEDIAN_FACTOR = 3;
/** Below this many levels a step above the median factor is rounding noise and is not even noted. */
export const MINIMUM_NOTE_LEVELS = 2;
/** The subject box must stay at least this many pixels from every frame edge. */
export const DEFAULT_MINIMUM_MARGIN_PIXELS = 8;
/** At most this share of the subject box may be pure white (blown) or pure black (crushed). */
export const DEFAULT_CLIPPING_SHARE = 0.05;

function luma(red, green, blue) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Saturation of one pixel on the 0 to 255 scale (HSV: chroma over the brightest channel). */
function saturation(red, green, blue) {
  const brightest = Math.max(red, green, blue);
  if (brightest === 0) return 0;
  return (255 * (brightest - Math.min(red, green, blue))) / brightest;
}

/** The part of `box` ({ left, top, right, bottom } in pixels) that lies inside a width by height frame, as whole pixels, or null when none does. */
export function clipBoxToFrame(box, width, height) {
  const left = Math.max(0, Math.floor(box.left));
  const top = Math.max(0, Math.floor(box.top));
  const right = Math.min(width, Math.ceil(box.right));
  const bottom = Math.min(height, Math.ceil(box.bottom));
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/**
 * Mean luma, mean saturation (both 0 to 255) and the share of pure white and pure black pixels over `region` of an RGBA image
 * (`image.data` has 4 bytes a pixel). Without a region the whole frame is measured.
 */
export function frameMetrics(image, region = null) {
  const { data, width, height } = image;
  if (data.length !== width * height * 4) throw new Error(`Image data holds ${data.length} bytes but a ${width} by ${height} RGBA image needs ${width * height * 4}. Pass 4 bytes per pixel.`);
  const area = region ?? { left: 0, top: 0, right: width, bottom: height };
  let lumaSum = 0;
  let saturationSum = 0;
  let blown = 0;
  let crushed = 0;
  let count = 0;
  for (let y = area.top; y < area.bottom; y += 1) {
    for (let x = area.left; x < area.right; x += 1) {
      const offset = (y * width + x) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const level = Math.round(luma(red, green, blue));
      lumaSum += level;
      saturationSum += saturation(red, green, blue);
      if (level === 255) blown += 1;
      if (level === 0) crushed += 1;
      count += 1;
    }
  }
  if (count === 0) throw new Error('The measured region has no pixels. Pass a region inside the frame.');
  return { meanLuma: lumaSum / count, meanSaturation: saturationSum / count, blownShare: blown / count, crushedShare: crushed / count, pixelCount: count };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Every frame whose value differs from the frame before by more than `levels` (a jump: it FAILS a check). A smaller step that is
 * above `medianFactor` times the clip's median step, and above two levels, is only a note. `values[i]` belongs to frame
 * `firstFrame + i`. A 2-frame dropout shows as two jumps, one into it and one out of it; `dropouts` pairs them.
 */
export function findJumps(values, { levels = DEFAULT_JUMP_LEVELS, medianFactor = DEFAULT_JUMP_MEDIAN_FACTOR, firstFrame = 0 } = {}) {
  const steps = [];
  for (let index = 1; index < values.length; index += 1) steps.push(Math.abs(values[index] - values[index - 1]));
  const medianStep = median(steps);
  const jumps = [];
  const notes = [];
  for (let index = 1; index < values.length; index += 1) {
    const step = steps[index - 1];
    const entry = { frame: firstFrame + index, from: values[index - 1], to: values[index], step };
    if (step > levels) jumps.push(entry);
    else if (step > medianFactor * medianStep && step > MINIMUM_NOTE_LEVELS) notes.push(entry);
  }
  return { jumps, notes, medianStep, dropouts: pairDropouts(jumps, levels) };
}

/**
 * A jump one way followed within a few frames by a jump back the other way to about the level before it: the frames between are a
 * dropout or a flash. Each jump is used once, so an exit is never also the entry of the next dropout.
 */
function pairDropouts(jumps, levels, longestDropoutFrames = 4) {
  const dropouts = [];
  let index = 0;
  while (index < jumps.length) {
    const into = jumps[index];
    const out = jumps[index + 1];
    const isReturn = out !== undefined
      && Math.sign(into.to - into.from) === -Math.sign(out.to - out.from)
      && out.frame - into.frame <= longestDropoutFrames
      && Math.abs(out.to - into.from) <= levels;
    if (isReturn) {
      dropouts.push({ firstFrame: into.frame, lastFrame: out.frame - 1 });
      index += 2;
    } else {
      index += 1;
    }
  }
  return dropouts;
}

/** A camera's view and projection matrices pieces: eye, target, up and vertical field of view in degrees. */
function subtract(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function cross(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

function dot(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  if (length === 0) throw new Error('The camera eye and target are the same point. Move the eye away from the target.');
  return vector.map(component => component / length);
}

/**
 * The pixel box of a world-space axis-aligned `bounds` ({ min: [x, y, z], max: [x, y, z] }) seen by a perspective camera
 * ({ eye, target, up = [0, 1, 0], fov = 45 }) in a width by height frame. `behindCamera` is true when a corner is at or behind the
 * eye, where the box has no finite projection and cannot be inside the frame.
 */
export function projectBounds(bounds, camera, width, height) {
  const eye = camera.eye;
  const forward = normalize(subtract(camera.target, eye));
  const right = normalize(cross(forward, camera.up ?? [0, 1, 0]));
  const up = cross(right, forward);
  const focalPixels = height / 2 / Math.tan(((camera.fov ?? 45) * Math.PI) / 360);
  let left = Infinity;
  let top = Infinity;
  let rightEdge = -Infinity;
  let bottom = -Infinity;
  let behindCamera = false;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const relative = subtract([x, y, z], eye);
        const depth = dot(relative, forward);
        if (depth <= 1e-6) {
          behindCamera = true;
          continue;
        }
        const pixelX = width / 2 + (focalPixels * dot(relative, right)) / depth;
        const pixelY = height / 2 - (focalPixels * dot(relative, up)) / depth;
        left = Math.min(left, pixelX);
        rightEdge = Math.max(rightEdge, pixelX);
        top = Math.min(top, pixelY);
        bottom = Math.max(bottom, pixelY);
      }
    }
  }
  return { left, top, right: rightEdge, bottom, behindCamera };
}

/** The pixels between a subject box and each frame edge (negative when it crosses the edge) and the smallest of them. */
export function boxMargins(box, width, height) {
  const margins = { left: box.left, top: box.top, right: width - box.right, bottom: height - box.bottom };
  return { ...margins, smallest: Math.min(margins.left, margins.top, margins.right, margins.bottom) };
}

/** PASS when the whole subject box is inside the frame by at least `minimumMargin` pixels on every side. */
export function checkFraming(box, width, height, { minimumMargin = DEFAULT_MINIMUM_MARGIN_PIXELS } = {}) {
  if (box.behindCamera) return { pass: false, margins: null, detail: 'part of the subject is at or behind the camera, so it cannot be framed. Move the camera back.' };
  const margins = boxMargins(box, width, height);
  const edges = ['left', 'top', 'right', 'bottom'].filter(edge => margins[edge] < minimumMargin);
  const rounded = Object.fromEntries(Object.entries(margins).map(([edge, value]) => [edge, Math.round(value * 10) / 10]));
  if (margins.smallest < 0) return { pass: false, margins: rounded, detail: `subject leaves the frame at the ${edges.filter(edge => margins[edge] < 0).join(', ')} edge (${rounded.smallest} px); needs at least ${minimumMargin} px` };
  if (margins.smallest < minimumMargin) return { pass: false, margins: rounded, detail: `subject is ${rounded.smallest} px from the ${edges.join(', ')} edge; needs at least ${minimumMargin} px` };
  return { pass: true, margins: rounded, detail: `smallest margin ${rounded.smallest} px (needs ${minimumMargin})` };
}

/** PASS when no frame has more than `maximumShare` of the subject box at pure white (blown) or pure black (crushed). */
export function checkClipping(metricsPerFrame, { maximumShare = DEFAULT_CLIPPING_SHARE, firstFrame = 0 } = {}) {
  let worstBlown = { frame: firstFrame, share: 0 };
  let worstCrushed = { frame: firstFrame, share: 0 };
  metricsPerFrame.forEach((metrics, index) => {
    if (metrics.blownShare > worstBlown.share) worstBlown = { frame: firstFrame + index, share: metrics.blownShare };
    if (metrics.crushedShare > worstCrushed.share) worstCrushed = { frame: firstFrame + index, share: metrics.crushedShare };
  });
  const percent = share => `${(share * 100).toFixed(1)}%`;
  return {
    highlights: { pass: worstBlown.share <= maximumShare, ...worstBlown, detail: `blown highlights at most ${percent(worstBlown.share)} (frame ${worstBlown.frame}), limit ${percent(maximumShare)}` },
    shadows: { pass: worstCrushed.share <= maximumShare, ...worstCrushed, detail: `crushed shadows at most ${percent(worstCrushed.share)} (frame ${worstCrushed.frame}), limit ${percent(maximumShare)}` },
  };
}

/** "frame 7" for a one-frame dropout, "frames 7-8" for a longer one. */
export function describeDropout({ firstFrame, lastFrame }) {
  return firstFrame === lastFrame ? `frame ${firstFrame}` : `frames ${firstFrame}-${lastFrame}`;
}

/** "frame 7" for a plain jump, the dropout's own label ("frames 7-8") for the jump into a dropout. */
function describeJumpFrames(entry, dropout) {
  return dropout ? describeDropout(dropout) : `frame ${entry.frame}`;
}

/**
 * PASS when neither mean luma nor mean saturation jumps more than the limit between frames; the detail names each jump frame and its
 * levels, each dropout once, and (without failing) any smaller step above 3 times the median step.
 */
export function checkContinuity(metricsPerFrame, { firstFrame = 0, ...jumpOptions } = {}) {
  const lumaResult = findJumps(metricsPerFrame.map(metrics => metrics.meanLuma), { ...jumpOptions, firstFrame });
  const saturationResult = findJumps(metricsPerFrame.map(metrics => metrics.meanSaturation), { ...jumpOptions, firstFrame });
  // A dropout is reported once, under its range ("frames 8-9"); the jump back out of it is not a second line.
  const describe = (name, result) => {
    const dropoutByEntry = new Map(result.dropouts.map(dropout => [dropout.firstFrame, dropout]));
    const exitFrames = new Set(result.dropouts.map(dropout => dropout.lastFrame + 1));
    return result.jumps
      .filter(entry => dropoutByEntry.has(entry.frame) || !exitFrames.has(entry.frame))
      .map(entry => `${name} ${describeJumpFrames(entry, dropoutByEntry.get(entry.frame))}: ${entry.from.toFixed(1)} to ${entry.to.toFixed(1)} (${entry.step.toFixed(1)} levels)`);
  };
  const describeNotes = (name, entries) => entries.map(entry => `${name} frame ${entry.frame}: ${entry.from.toFixed(1)} to ${entry.to.toFixed(1)} (${entry.step.toFixed(1)} levels)`);
  const lines = [...describe('luma', lumaResult), ...describe('saturation', saturationResult)];
  const noteLines = [...describeNotes('luma', lumaResult.notes), ...describeNotes('saturation', saturationResult.notes)];
  const dropouts = [...new Map([...lumaResult.dropouts, ...saturationResult.dropouts].map(dropout => [describeDropout(dropout), dropout])).values()];
  const pass = lumaResult.jumps.length === 0 && saturationResult.jumps.length === 0;
  const noteText = noteLines.length ? ` (note, not a failure: ${noteLines.join('; ')})` : '';
  const detail = pass ? `no single-frame jump over ${jumpOptions.levels ?? DEFAULT_JUMP_LEVELS} levels in ${metricsPerFrame.length} frames (median luma step ${lumaResult.medianStep.toFixed(2)})${noteText}` : `${lines.join('; ')}${noteText}`;
  return { pass, luma: lumaResult, saturation: saturationResult, dropouts, detail };
}
