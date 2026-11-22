// The cost profile of scene_inspect: frame time, draw calls and triangles measured over a few real frames.
// It measures the way bench/runtime does: draw calls and triangles come from wrapping the WebGL draw functions, and a
// one-pixel read after each frame waits for the GPU, so frames cannot pile up in its queue and the wait stays outside
// the timed region.

export const PROFILE_FRAME_LIMITS = Object.freeze({ minimum: 1, default: 30, maximum: 120 });
export const HEAVIEST_NODE_COUNT = 5;

const DRAW_FUNCTIONS = Object.freeze(['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']);
const ONE_PIXEL = new Uint8Array(4);

/** Checks the profile fields of a scene_inspect call and returns the frame count; throws a message that says what to pass. */
export function profileFrameCount({ profile, profileFrames }) {
  if (profile !== undefined && typeof profile !== 'boolean') {
    throw new TypeError(`profile must be true or false, got ${JSON.stringify(profile)}. Pass { "profile": true } to measure the scene's cost.`);
  }
  if (profileFrames !== undefined && profile !== true) {
    throw new RangeError('profileFrames only applies with profile: true. Pass { "profile": true, "profileFrames": 30 }, or leave profileFrames out.');
  }
  const frames = profileFrames ?? PROFILE_FRAME_LIMITS.default;
  const { minimum, maximum } = PROFILE_FRAME_LIMITS;
  if (!Number.isInteger(frames) || frames < minimum || frames > maximum) {
    throw new RangeError(`profileFrames must be a whole number from ${minimum} to ${maximum}, got ${JSON.stringify(profileFrames)}. Pass, for example, { "profile": true, "profileFrames": ${PROFILE_FRAME_LIMITS.default} }.`);
  }
  return frames;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function trianglesOfDraw(context, mode, vertexCount) {
  if (mode === context.TRIANGLES) return vertexCount / 3;
  if (mode === context.TRIANGLE_STRIP || mode === context.TRIANGLE_FAN) return Math.max(0, vertexCount - 2);
  return 0;
}

/**
 * Counts the draw calls and triangles the context receives until `release` runs. The wrappers sit on the context object
 * itself, so no other context is touched, and `release` removes them.
 */
export function countDraws(context) {
  const counters = { drawCalls: 0, triangles: 0 };
  const wrapped = [];
  const record = (mode, vertexCount, instances = 1) => {
    counters.drawCalls += 1;
    counters.triangles += trianglesOfDraw(context, mode, vertexCount) * instances;
  };
  const argumentsOf = {
    drawElements: ([mode, count]) => record(mode, count),
    drawArrays: ([mode, , count]) => record(mode, count),
    drawElementsInstanced: ([mode, count, , , instances]) => record(mode, count, instances),
    drawArraysInstanced: ([mode, , count, instances]) => record(mode, count, instances),
  };
  for (const name of DRAW_FUNCTIONS) {
    const original = context[name];
    if (typeof original !== 'function') continue;
    const hadOwn = Object.hasOwn(context, name);
    context[name] = function countedDraw(...drawArguments) {
      argumentsOf[name](drawArguments);
      return original.apply(this, drawArguments);
    };
    wrapped.push({ name, original, hadOwn });
  }
  return {
    counters,
    release() {
      for (const { name, original, hadOwn } of wrapped) {
        if (hadOwn) context[name] = original;
        else delete context[name];
      }
    },
  };
}

/** Reading one pixel waits until the GPU has finished the frame (context.finish returns at once in Chrome). */
function waitForGpu(context) {
  context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, ONE_PIXEL);
}

/**
 * Draws `frames` frames with `drawFrame(frameIndex)` and returns the median milliseconds per frame (CPU submission plus the wait
 * for the GPU), with the draw calls and triangles of one frame. One unmeasured frame comes first so program and buffer
 * uploads stay out of the figures.
 */
export function profileFrames({ context, drawFrame, frames, now = () => performance.now() }) {
  const watcher = countDraws(context);
  try {
    drawFrame(0);
    waitForGpu(context);
    watcher.counters.drawCalls = 0;
    watcher.counters.triangles = 0;
    const milliseconds = [];
    for (let frame = 0; frame < frames; frame++) {
      const started = now();
      drawFrame(frame + 1);
      waitForGpu(context);
      milliseconds.push(now() - started);
    }
    return {
      frames,
      millisecondsPerFrame: roundTo(median(milliseconds), 3),
      millisecondsMinimum: roundTo(Math.min(...milliseconds), 3),
      millisecondsMaximum: roundTo(Math.max(...milliseconds), 3),
      drawCalls: watcher.counters.drawCalls / frames,
      triangles: Math.round(watcher.counters.triangles / frames),
    };
  } finally {
    watcher.release();
  }
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** The nodes that hold the most triangles, from render parts ({ name, geometry }); parts that share a node name add up. */
export function heaviestNodes(parts, count = HEAVIEST_NODE_COUNT) {
  const totals = new Map();
  for (const part of parts) {
    const entry = totals.get(part.name) ?? { id: part.name, triangles: 0, parts: 0 };
    entry.triangles += part.geometry.indices.length / 3;
    entry.parts += 1;
    totals.set(part.name, entry);
  }
  return [...totals.values()].sort((first, second) => second.triangles - first.triangles || (first.id < second.id ? -1 : 1)).slice(0, count);
}
