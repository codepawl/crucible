import { normalizePathTracerOptions, PATH_TRACER_LIMITS } from './path-tracer.js';

// What both backends of the real-time tracer (path-tracer-realtime.js, path-tracer-realtime-webgpu.js) read from the options.

export const REALTIME_BACKENDS = ['gpu', 'webgpu'];
const DEFAULT_BOUNCES = 2;
const DEFAULT_RESOLUTION_DIVISOR = 2;
const CACHE_CELLS_ACROSS_SCENE = 200;
const CACHE_LEVEL_CELLS = 64;
const SCENE_EXTENT_SCALE = 1e4;
const MAX_FILTER_ITERATIONS = 16;
// Sub-micron cells underflow float32 GPU uniforms and overflow 32-bit integer spatial hash coordinates.
const MINIMUM_CACHE_CELL_SIZE = 1e-6;

// The history blend is 1 over the history length, capped by historyLimit: below 1 the new sample would weigh more than 1.
function requirePositiveNumber(value, name, minimum = 0) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value < minimum) {
    throw new RangeError(`The real-time path tracer option ${name} must be a finite number ${minimum > 0 ? `of at least ${minimum}` : 'above 0'}, got ${value}. Pass a larger value or leave it out for the default.`);
  }
}

function requireFilterIterations(value) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 0 || value > MAX_FILTER_ITERATIONS) {
    throw new RangeError(`The real-time path tracer option filterIterations must be a whole number from 0 to ${MAX_FILTER_ITERATIONS}, got ${value}. Leave it out for the default.`);
  }
}

function requireOutputSize(value, name) {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`The real-time path tracer option ${name} must be a whole number of pixels from 1, got ${value}. Leave it out for the default.`);
  }
}

// The tracing size is the output size over resolutionDivisor; name those options when it leaves the tracer's range.
function requireTraceSizeInRange(traceSize, outputSize, name) {
  const { minimum, maximum } = PATH_TRACER_LIMITS[name];
  if (traceSize < minimum || traceSize > maximum) {
    throw new RangeError(`The real-time path tracer traces ${name} ${traceSize} (option ${name} ${outputSize} over resolutionDivisor), and it must be from ${minimum} to ${maximum}. Change ${name} or resolutionDivisor.`);
  }
}

/** The output and tracing sizes and the normalized tracer options of `createRealtimeTracer`'s raw options. */
export function resolveRealtimeOptions(rawOptions) {
  requirePositiveNumber(rawOptions.resolutionDivisor, 'resolutionDivisor');
  requirePositiveNumber(rawOptions.historyLimit, 'historyLimit', 1);
  requirePositiveNumber(rawOptions.cacheCellSize, 'cacheCellSize', MINIMUM_CACHE_CELL_SIZE);
  requireFilterIterations(rawOptions.filterIterations);
  requireOutputSize(rawOptions.width, 'width');
  requireOutputSize(rawOptions.height, 'height');
  const resolutionDivisor = rawOptions.resolutionDivisor ?? DEFAULT_RESOLUTION_DIVISOR;
  const outputWidth = rawOptions.width ?? 960;
  const outputHeight = rawOptions.height ?? 540;
  const traceWidth = Math.max(1, Math.ceil(outputWidth / resolutionDivisor));
  const traceHeight = Math.max(1, Math.ceil(outputHeight / resolutionDivisor));
  requireTraceSizeInRange(traceWidth, outputWidth, 'width');
  requireTraceSizeInRange(traceHeight, outputHeight, 'height');
  const backend = rawOptions.backend ?? 'gpu';
  if (!REALTIME_BACKENDS.includes(backend)) throw new RangeError(`The real-time path tracer backend must be one of ${REALTIME_BACKENDS.join(', ')}.`);
  const options = normalizePathTracerOptions({
    seed: rawOptions.seed, lightSelection: rawOptions.lightSelection ?? 'importance', bounces: rawOptions.bounces ?? DEFAULT_BOUNCES,
    width: traceWidth, height: traceHeight, samples: 1, backend: 'gpu', denoise: false,
  });
  options.radianceCache = true;
  return {
    backend, outputWidth, outputHeight, traceWidth, traceHeight, options,
    historyLimit: rawOptions.historyLimit, filterIterations: rawOptions.filterIterations, cacheCellSize: rawOptions.cacheCellSize,
    followPartMotion: rawOptions.followPartMotion ?? true,
  };
}

/** The cache cell size and the distance at which cells start to grow, for a scene of `farDistance`. */
export function cacheCellSizes(traceScene, cacheCellSize) {
  const extent = traceScene.farDistance / SCENE_EXTENT_SCALE;
  const cellSize = Math.max(MINIMUM_CACHE_CELL_SIZE, cacheCellSize ?? extent / CACHE_CELLS_ACROSS_SCENE);
  return { cellSize, levelDistance: cellSize * CACHE_LEVEL_CELLS };
}

/** Adds, once, the note that the real-time tracers start camera rays at the eye and so ignore camera.clipStart. */
export function noteIgnoredClipStart(notes, view) {
  if (view.clipStart > 0 && notes.length === 0) notes.push('camera.clipStart is ignored by the real-time tracers: camera rays start at the eye, so geometry between the eye and the clip start is drawn.');
}

/** True when two cameras (as `createCamera` returns them) look the same way. */
export function viewsMatch(first, second) {
  if (!first || !second) return false;
  const keys = ['eye', 'forward', 'right', 'above'];
  return keys.every(key => first[key].every((value, axis) => value === second[key][axis])) && first.halfWidth === second.halfWidth && first.halfHeight === second.halfHeight;
}
