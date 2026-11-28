// What a render job will cost on this machine, and what it did cost. The estimate comes from the scene's size and the job's
// settings alone, so the same inputs give the same answer. A correction learned from the last few jobs on this machine
// (kept in the jobs folder, never sent anywhere) can move it, within a fixed bound.

import { MAXIMUM_MEMORY_MIB } from '../src/agent-scene-capabilities.js';
import { MAX_TRACE_TRIANGLES } from '../src/path-tracer-scene.js';

const MIB = 1024 ** 2;

/** What scene_capabilities topic jobs says about the estimate and the report. The details are in docs/mcp.md. */
export const RENDER_ESTIMATE_NOTE = 'scene_render_submit returns estimate { seconds, peakMemoryMiB, outputMiB, basis } for this device before the job runs (from the scene size, the settings and the last 16 jobs here; about 2x either way). scene_render_result metrics.report holds measured time and peak memory, the ratio to the estimate, samplesDrawn for the path tracer, and fallbacks (what ran differently and why).';

/** Jobs kept in the history, newest last. Older ones are dropped. */
export const HISTORY_LIMIT = 16;
/** The history may scale the estimate by at most this factor either way, so one odd run cannot make it useless. */
export const CORRECTION_BOUND = 4;
/** The history needs this many runs of the same kind before it changes anything. */
const MINIMUM_HISTORY_RUNS = 2;

/**
 * Seconds and bytes per unit of work, fitted to jobs measured with scripts/measure-render-estimate.mjs. A frame costs a fixed
 * part, a part per pixel and a part per triangle; the scene is built once per job, which dominates large scenes. The path
 * tracer's trace cost is per pixel, sample and bounce, and its acceleration structure costs per triangle.
 */
export const COST_MODEL = Object.freeze({
  startupSeconds: 0.25,
  setupSecondsPerTriangle: 3.3e-6,
  // A placed asset is rebuilt from its glTF parts (skeleton, materials, textures) however few triangles it has.
  setupSecondsPerAssetPart: 1.2e-3,
  drawSecondsPerAssetPart: 3.5e-5,
  // Fitted on one 132 node scene with three placed GLB files (9.8 MiB, thirteen placements) against the same scene without them
  // (#2286): with the files, renderer start took about 5 s longer and each frame after the first about 1 s longer. The per-frame
  // numbers describe slow frames that #3038 tracks; refit them when it lands.
  setupSecondsPerAssetMiB: 0.7,
  drawSecondsPerAssetMiB: 0.09,
  // A motion sample re-poses every node: about 0.4 s a frame for 120 to 130 nodes, paid on each frame after the first.
  motionSampleSecondsPerNode: 3e-3,
  drawFrameSeconds: 0.004,
  drawSecondsPerPixel: 5e-8,
  drawSecondsPerTriangle: 1e-8,
  drawSecondsPerLight: 5e-4,
  passFactor: 0.6,
  imageCaptureSeconds: 0.02,
  videoEncodeSeconds: 0.005,
  pathTracerSecondsPerSampleBounce: Object.freeze({ cpu: 5e-7, gpu: 1e-7, native: 1e-7 }),
  // The first GPU path trace in a runtime compiles its kernel; measured at about 10 s, and later traces do not pay it.
  gpuTracerColdStartSeconds: 9.5,
  pathTracerBuildSecondsPerTriangle: 3.7e-6,
  pathTracerOutputSeconds: 0.03,
  nodeBaseMiB: 185,
  extraMiBPerPart: 1,
  extraMiBPerThousandTriangles: 0.3,
  maximumSceneExtraMiB: 250,
  pathTracerExtraMiB: 30,
  miBPerTexture: 4,
  nodeBytesPerPixel: 24,
  pngBytesPerPixel: 0.65,
  png16BytesPerPixel: 1.95,
  exrBytesPerPixel: 3.5,
  multilayerPassBytesPerPixel: 2,
  matteBytesPerPixel: 0.12,
  videoBytesPerPixel: 0.05,
});

/** Expected combined output size in bytes from frame dimensions, count, format, passes and mattes. */
export function estimateOutputBytes(settings) {
  const width = settings.region?.width ?? settings.width;
  const height = settings.region?.height ?? settings.height;
  const pixels = width * height;
  const frameCount = settings.frameCount ?? 1;
  if (settings.kind === 'video') return Math.ceil(pixels * COST_MODEL.videoBytesPerPixel * frameCount);
  if (settings.kind === 'icons') return Math.ceil(pixels * COST_MODEL.pngBytesPerPixel * frameCount * 2) + 4096;
  const basePerPixel = settings.format === 'exr'
    ? COST_MODEL.exrBytesPerPixel
    : settings.format === 'png16'
      ? COST_MODEL.png16BytesPerPixel
      : COST_MODEL.pngBytesPerPixel;
  const passCount = settings.passes?.length ?? 0;
  const matteCount = settings.mattes?.length ?? 0;
  const frameBytes = settings.multilayer
    ? pixels * (basePerPixel + passCount * COST_MODEL.multilayerPassBytesPerPixel)
    : pixels * basePerPixel * (1 + passCount) + pixels * COST_MODEL.matteBytesPerPixel * matteCount;
  return Math.ceil(frameBytes * frameCount);
}

function textureCount(recipe) {
  const text = JSON.stringify(recipe?.materials ?? []);
  return (text.match(/"(?:map|texture|image|[a-zA-Z]+Map)"s*:/g) ?? []).length;
}

/**
 * The numbers about the scene that the estimate uses, from the scene's inspection result (listing every node) and its recipe.
 * Triangles count each placed node, so ten spheres cost ten spheres even when they share one geometry.
 */
export function sceneSizeFrom(inspection, recipe, { assetFileBytes = 0, byAssetId = new Map() } = {}) {
  const look = inspection?.look ?? {};
  const listed = inspection?.nodes ?? [];
  const listedTriangles = listed.reduce((total, node) => total + (node.triangles ?? 0), 0);
  const scale = inspection?.truncated && listed.length ? (inspection.counts?.parts ?? listed.length) / listed.length : 1;
  // The node list leaves out the parts of placed assets, and generated geometry (vegetation, crowds, arrays) has no node of its own;
  // the resident vertex count covers both, so the larger of the two counts stands.
  // Copies of one placed asset share its geometry in that count, so the part of it that no node lists is counted once per copy.
  const residentTriangles = Math.round((inspection?.counts?.vertices ?? 0) / 2);
  const listedScaled = Math.round(listedTriangles * scale);
  const placements = (inspection?.assets ?? []).filter(placement => typeof placement.assetId === 'string');
  const copiesPerAsset = placements.length / Math.max(1, new Set(placements.map(placement => placement.assetId)).size);
  const generatedTriangles = Math.max(0, residentTriangles - listedScaled) * Math.max(1, copiesPerAsset);
  // The placed files are read from their glTF accessor counts: the inspection holds no triangles of an asset it has not loaded, so a large GLB would count as nothing.
  const placedAssetTriangles = placements.reduce((total, placement) => total + (byAssetId.get(placement.assetId)?.triangles ?? 0), 0);
  const placedAssetTextures = [...new Set(placements.map(placement => placement.assetId))].reduce((total, assetId) => total + (byAssetId.get(assetId)?.textures ?? 0), 0);
  const assetTextureMiB = [...new Set(placements.map(placement => placement.assetId))].reduce((total, assetId) => total + (byAssetId.get(assetId)?.textureMiB ?? 0), 0);
  return {
    parts: inspection?.counts?.parts ?? 0,
    assetParts: placements.reduce((total, placement) => total + (placement.parts ?? 0), 0),
    // Size of the placed GLB files, each counted once: their textures decode and upload however few triangles they have.
    assetMiB: round(assetFileBytes / MIB, 1),
    nodes: inspection?.counts?.nodes ?? listed.length,
    triangles: Math.max(listedScaled + generatedTriangles, listedScaled + placedAssetTriangles),
    // The triangles the node list itself reports, never scaled or guessed: a floor of the real count.
    listedTriangles,
    materials: inspection?.counts?.materials ?? 0,
    textures: textureCount(recipe) + placedAssetTextures,
    // Present only when placed files hold images: their resident size from the image headers, which peakMemoryMiB uses instead of a flat figure per image.
    ...(placedAssetTextures > 0 ? { assetTextures: placedAssetTextures, assetTextureMiB: round(assetTextureMiB, 1) } : {}),
    lights: (look.pointLights ?? 0) + (look.spotLights ?? 0) + (look.areaLights ?? 0) + 1,
  };
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

// A kernel compile shorter than this is lost beside a trace; the native tracer's per-frame note uses the same line.
export const NOTEWORTHY_COMPILE_SECONDS = 1;

/**
 * Adds one traced frame's kernel compile to the job's total. The path tracer report in the metrics describes only the last
 * frame, so without this a film whose first frame compiled for seconds ended with no trace of it (#1949).
 */
export function addKernelCompile(total, frameReport) {
  const seconds = frameReport?.compileSeconds;
  if (!(seconds > 0)) return total;
  const nextCache = total?.pipelineCache === 'cold'
    ? 'cold'
    : frameReport.pipelineCache ?? total?.pipelineCache;
  return {
    seconds: (total?.seconds ?? 0) + seconds,
    frames: (total?.frames ?? 0) + 1,
    ...(nextCache ? { pipelineCache: nextCache } : {}),
  };
}

function kernelCompileFrom(metrics) {
  const compile = metrics.kernelCompile;
  if (!(compile?.seconds >= NOTEWORTHY_COMPILE_SECONDS)) return undefined;
  const seconds = round(compile.seconds, 1);
  const note = compile.pipelineCache === 'cold'
    ? `First render of this scene variant: ${seconds.toFixed(1)} s of the job compiled kernels, which is not trace time and is counted in secondsRatio. Later runs reuse them from Cook's on-disk pipeline cache.`
    : `First render of this scene variant: ${seconds.toFixed(1)} s of the job compiled kernels, which is not trace time and is counted in secondsRatio. A later job of the same variant in this server reuses them.`;
  return {
    seconds,
    frames: compile.frames,
    ...(compile.pipelineCache ? { pipelineCache: compile.pipelineCache } : {}),
    note,
  };
}

function pathTracerFrameSeconds({ size, settings, backend }) {
  const renderer = settings.renderer;
  const secondsPerSampleBounce = COST_MODEL.pathTracerSecondsPerSampleBounce[renderer.backend ?? backend] ?? COST_MODEL.pathTracerSecondsPerSampleBounce.cpu;
  const traceSeconds = settings.width * settings.height * renderer.samples * renderer.bounces * secondsPerSampleBounce;
  return Math.min(renderer.maxSeconds, traceSeconds) + size.triangles * COST_MODEL.pathTracerBuildSecondsPerTriangle + COST_MODEL.pathTracerOutputSeconds;
}

function rasterFrameSeconds({ size, settings }) {
  const drawSeconds = COST_MODEL.drawFrameSeconds + settings.width * settings.height * COST_MODEL.drawSecondsPerPixel
    + size.triangles * COST_MODEL.drawSecondsPerTriangle + size.assetParts * COST_MODEL.drawSecondsPerAssetPart + size.lights * COST_MODEL.drawSecondsPerLight
    + (size.assetMiB ?? 0) * COST_MODEL.drawSecondsPerAssetMiB;
  const outputSeconds = settings.kind === 'video' ? COST_MODEL.videoEncodeSeconds : COST_MODEL.imageCaptureSeconds;
  return drawSeconds * (1 + ((settings.passes?.length ?? 0) + (settings.mattes?.length ?? 0)) * COST_MODEL.passFactor) + outputSeconds;
}

function peakMemoryMiB({ size, settings }) {
  const sceneMiB = Math.min(COST_MODEL.maximumSceneExtraMiB, size.parts * COST_MODEL.extraMiBPerPart + (size.triangles / 1000) * COST_MODEL.extraMiBPerThousandTriangles);
  return COST_MODEL.nodeBaseMiB + sceneMiB + (size.textures - (size.assetTextures ?? 0)) * COST_MODEL.miBPerTexture + (size.assetTextureMiB ?? 0)
    + (settings.renderer ? COST_MODEL.pathTracerExtraMiB : 0) + (settings.width * settings.height * COST_MODEL.nodeBytesPerPixel) / MIB;
}

/** The kind of job a history entry and a new job share: same output kind and same way of rendering. */
export function jobKind(settings, backend) {
  return `${settings.renderer ? `pathTracer-${settings.renderer.backend ?? backend}` : 'raster'}-${settings.kind === 'video' ? 'video' : 'image'}-${backend}`;
}

function medianOf(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function boundedRatio(ratio) {
  return Math.min(CORRECTION_BOUND, Math.max(1 / CORRECTION_BOUND, ratio));
}

/** Median of measured over estimated, from the last runs of the same kind; 1 when there are too few. */
export function correctionFromHistory(history, kind) {
  const runs = (history ?? []).filter(entry => entry.kind === kind && entry.estimatedSeconds > 0 && entry.measuredSeconds > 0);
  if (runs.length < MINIMUM_HISTORY_RUNS) return { seconds: 1, memory: 1, runs: runs.length, secondsClamped: false, memoryFromHistory: false };
  const rawSeconds = medianOf(runs.map(entry => entry.measuredSeconds / entry.estimatedSeconds));
  const seconds = boundedRatio(rawSeconds);
  const memoryRuns = runs.filter(entry => entry.estimatedPeakMemoryMiB > 0 && entry.measuredPeakMemoryMiB > 0);
  const memory = memoryRuns.length >= MINIMUM_HISTORY_RUNS ? boundedRatio(medianOf(memoryRuns.map(entry => entry.measuredPeakMemoryMiB / entry.estimatedPeakMemoryMiB))) : 1;
  return { seconds, memory, runs: runs.length, secondsClamped: seconds !== rawSeconds, memoryFromHistory: memoryRuns.length >= MINIMUM_HISTORY_RUNS };
}

/** Says where the numbers came from: the history is whatever sits in this jobs folder, not a named machine. */
function basisOf(correction, kind) {
  if (correction.runs < MINIMUM_HISTORY_RUNS) return 'scene size';
  const notes = [];
  if (correction.secondsClamped) notes.push(`time factor limited to ${CORRECTION_BOUND}x`);
  if (!correction.memoryFromHistory) notes.push('memory from scene size only');
  return `scene size and the last ${correction.runs} ${kind} jobs in this jobs folder${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

/**
 * Expected time and peak memory of a job. `settings` is the normalized job settings (width, height, kind, frameCount, passes,
 * renderer). The raw size-only numbers are `modelSeconds` and `modelPeakMemoryMiB`; the headline numbers apply the history.
 */
export function estimateRenderJob({ size, settings, backend, memoryBudgetMiB, history = [], gpuTracerWarm = true }) {
  const motionSampleSeconds = settings.motion ? (size.nodes ?? 0) * COST_MODEL.motionSampleSecondsPerNode : 0;
  const frameSeconds = (settings.renderer ? pathTracerFrameSeconds({ size, settings, backend }) : rasterFrameSeconds({ size, settings })) + motionSampleSeconds;
  const coldStartSeconds = settings.renderer?.backend === 'gpu' && !gpuTracerWarm ? COST_MODEL.gpuTracerColdStartSeconds : 0;
  const setupSeconds = size.triangles * COST_MODEL.setupSecondsPerTriangle + size.assetParts * COST_MODEL.setupSecondsPerAssetPart + (size.assetMiB ?? 0) * COST_MODEL.setupSecondsPerAssetMiB;
  const modelSeconds = COST_MODEL.startupSeconds + coldStartSeconds + setupSeconds + frameSeconds * settings.frameCount;
  const modelPeakMemoryMiB = peakMemoryMiB({ size, settings });
  const correction = correctionFromHistory(history, jobKind(settings, backend));
  const estimate = {
    seconds: round(modelSeconds * correction.seconds, 1),
    peakMemoryMiB: Math.round(modelPeakMemoryMiB * correction.memory),
    outputMiB: round(estimateOutputBytes(settings) / MIB, 1),
    framesPerSecond: round(settings.frameCount / Math.max(0.001, modelSeconds * correction.seconds), 2),
    frameSeconds: round(frameSeconds * correction.seconds, 4),
    fixedSeconds: round((modelSeconds - frameSeconds * settings.frameCount) * correction.seconds, 2),
    basis: basisOf(correction, jobKind(settings, backend)),
    modelSeconds: round(modelSeconds, 1),
    modelPeakMemoryMiB: Math.round(modelPeakMemoryMiB),
    scene: size,
  };
  if (memoryBudgetMiB !== undefined) estimate.renderTargetBudgetMiB = memoryBudgetMiB;
  return estimate;
}

/** Facts about what did not run as asked: a budget that shrank the frame, a backend that fell back, a denoiser that was swapped. */
function frameWasReduced(metrics) {
  return Boolean(metrics.width && metrics.requestedWidth && (metrics.width < metrics.requestedWidth || metrics.height < metrics.requestedHeight));
}

/** What to do about a reduced frame: raise --memory when the full frame fits under the server ceiling, else say what to shrink. */
function memoryAdvice(metrics) {
  const running = metrics.memoryBudgetMiB ? `; this server runs with --memory ${metrics.memoryBudgetMiB}` : '';
  const needs = ` The full frame needs a render budget of ${metrics.requiredMemoryMiB} MiB${running}.`;
  const maximumMemoryMiB = metrics.maximumMemoryMiB ?? MAXIMUM_MEMORY_MIB;
  if (metrics.requiredMemoryMiB > maximumMemoryMiB) {
    return `${needs} --memory accepts at most ${maximumMemoryMiB} on this machine, so a restart cannot fit it. Reduce the textures, the geometry, the frame size, or turn off HDR or bloom to render at ${metrics.requestedWidth}x${metrics.requestedHeight}.`;
  }
  return `${needs} Restart it with --memory ${metrics.requiredMemoryMiB} or more to render at ${metrics.requestedWidth}x${metrics.requestedHeight}.`;
}

function fallbacksFrom(settings, metrics) {
  const fallbacks = [];
  if (frameWasReduced(metrics)) {
    const neededBudget = metrics.requiredMemoryMiB ? memoryAdvice(metrics) : '';
    fallbacks.push(`The memory budget reduced the frame from ${metrics.requestedWidth}x${metrics.requestedHeight} to ${metrics.width}x${metrics.height}.${neededBudget}`);
  }
  if (metrics.pathTracer?.backendNote) fallbacks.push(metrics.pathTracer.backendNote);
  if (metrics.pathTracer?.denoiserNote) fallbacks.push(metrics.pathTracer.denoiserNote);
  return fallbacks;
}

/** The one record of a finished job: estimate beside what was measured, the samples drawn and what fell back. */
export function renderReport({ estimate, settings, metrics }) {
  const measuredSeconds = metrics.elapsedSeconds;
  const measuredPeakMemoryMiB = Math.round(((metrics.peakNodeBytes ?? 0) + (metrics.peakBrowserHeap ?? 0)) / MIB);
  const report = {
    measured: { seconds: round(measuredSeconds, 2), peakMemoryMiB: measuredPeakMemoryMiB, frames: settings.frameCount, secondsPerFrame: round(measuredSeconds / settings.frameCount, 3) },
    fallbacks: fallbacksFrom(settings, metrics),
  };
  if (estimate) {
    report.estimate = { seconds: estimate.seconds, peakMemoryMiB: estimate.peakMemoryMiB, basis: estimate.basis };
    report.secondsRatio = round(measuredSeconds / estimate.seconds, 2);
  }
  if (frameWasReduced(metrics)) report.frameReduced = true;
  const kernelCompile = kernelCompileFrom(metrics);
  if (kernelCompile) report.kernelCompile = kernelCompile;
  const traced = metrics.pathTracer;
  if (traced) {
    // The path tracer's report describes the last frame; the samples asked for are in the job's settings.
    if (traced.averageSamples !== undefined) report.samplesDrawn = traced.averageSamples;
    if (settings.renderer) report.samplesRequested = settings.renderer.samples;
    report.noise = noiseFrom(traced);
  }
  return report;
}

/**
 * Path traced frames only. `relative` is the root mean square noise of a pixel over the frame's mean luminance, measured before
 * any denoiser ran (see estimateRelativeNoise). The 0.03 line sits between a 4 sample and a 16 sample trace of the same lit test
 * scene (0.038 and 0.020), where the grain stops being visible at full size.
 */
export const NOISY_RELATIVE_NOISE = 0.03;

function noiseFrom(traced) {
  const relative = traced.estimatedNoise;
  if (!Number.isFinite(relative)) return { relative: null, verdict: 'not measured: it needs at least 2 samples per pixel and a frame that is not black.' };
  const rounded = round(relative, 4);
  if (relative < NOISY_RELATIVE_NOISE) return { relative: rounded, verdict: 'clean enough: no change needed.' };
  const advice = traced.denoised ? 'raise renderer.samples' : 'raise renderer.samples or set renderer.denoise';
  return { relative: rounded, verdict: `noisy: ${advice}.` };
}

/**
 * The size-only model numbers for the frame size a job really ran at. The estimate was made for the requested size, and a
 * memory budget can shrink the frame afterwards, so the measured time is compared with the model at the size that ran.
 */
function modelAtRanSize({ estimate, settings, backend, ranSize }) {
  if (!ranSize || !estimate.scene) return { seconds: estimate.modelSeconds, peakMemoryMiB: estimate.modelPeakMemoryMiB };
  const ranSettings = { ...settings, width: ranSize.width, height: ranSize.height };
  const model = estimateRenderJob({ size: estimate.scene, settings: ranSettings, backend });
  return { seconds: model.modelSeconds, peakMemoryMiB: model.modelPeakMemoryMiB };
}

/**
 * The history with this job added, trimmed to the newest HISTORY_LIMIT entries. `ranSize` is the frame size the job drew at;
 * a reduced job still teaches the estimate, because it is compared with the model at that size.
 */
export function historyWithJob(history, { settings, backend, estimate, report, ranSize }) {
  if (!estimate || !report.measured.seconds) return history;
  const model = modelAtRanSize({ estimate, settings, backend, ranSize: report.frameReduced ? ranSize : undefined });
  const entry = {
    kind: jobKind(settings, backend),
    estimatedSeconds: model.seconds,
    // A compile is paid once per scene variant and process; the estimate is for the render, so the history learns without it.
    measuredSeconds: Math.max(0.01, round(report.measured.seconds - (report.kernelCompile?.seconds ?? 0), 2)),
    estimatedPeakMemoryMiB: model.peakMemoryMiB,
    measuredPeakMemoryMiB: report.measured.peakMemoryMiB,
  };
  return [...history, entry].slice(-HISTORY_LIMIT);
}

/** Accepts only a plain list of well-formed entries from the history file; anything else is treated as no history. */
export function parseHistory(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const numeric = ['estimatedSeconds', 'measuredSeconds', 'estimatedPeakMemoryMiB', 'measuredPeakMemoryMiB'];
    return parsed.filter(entry => entry && typeof entry.kind === 'string' && numeric.every(field => Number.isFinite(entry[field]))).slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * The estimate of `sceneSizeFrom` counts triangles as vertices / 2, which is up to 1.5 times the real count of non-indexed geometry
 * (vertices / 3), and it does not subtract the parts the tracer skips. So the submit check refuses only above this multiple of the
 * cap; a scene between the cap and the margin goes through to the exact check made when the trace starts.
 */
export const TRIANGLE_ESTIMATE_SAFETY_FACTOR = 2;

/**
 * The message of a path traced job the CPU tracer would refuse after it started, or undefined. The CPU tracer (the default
 * backend) flattens the scene and takes at most MAX_TRACE_TRIANGLES triangles in total; the count here is the estimate of
 * `sceneSizeFrom`. Only its generated and truncated part is approximate, so the safety margin applies to that part alone: a scene
 * whose listed nodes (exact counts) are over the cap is refused at once, and otherwise only an estimate clearly over the margin
 * is, with "about" in the message. The gpu and native backends have
 * other bounds, checked when the trace starts. `canChooseBackend` is false when the caller cannot set renderer.backend (a runtime on
 * SwiftShader, or a budget or quality job that picks the renderer), so the advice then names only ways that work.
 */
export function pathTraceTriangleProblem(size, renderer, { canChooseBackend = true, picksRenderer = false } = {}) {
  if (!renderer || (renderer.backend !== undefined && renderer.backend !== 'cpu')) return undefined;
  const listedTriangles = size.listedTriangles ?? 0;
  const exactlyOverCap = listedTriangles > MAX_TRACE_TRIANGLES;
  if (!exactlyOverCap && size.triangles <= MAX_TRACE_TRIANGLES * TRIANGLE_ESTIMATE_SAFETY_FACTOR) return undefined;
  const count = exactlyOverCap ? `${listedTriangles} triangles` : `about ${size.triangles} triangles`;
  const base = `settings.renderer: this scene has ${count} and the cpu path tracer takes at most ${MAX_TRACE_TRIANGLES} in total.`;
  if (picksRenderer) return `${base} Simplify or drop meshes, or leave budget and quality out and pick the renderer yourself.`;
  if (!canChooseBackend) return `${base} Simplify or drop meshes; this runtime has no GPU backend.`;
  return `${base} Simplify or drop meshes, or set renderer.backend to "gpu" or "native", which hold more.`;
}

/** Error message when a job's estimated outputs pass the combined output byte budget, or undefined. */
export function outputByteBudgetProblem(settings, maximumOutputBytes = 128 * MIB) {
  const estimatedBytes = estimateOutputBytes(settings);
  if (estimatedBytes <= maximumOutputBytes) return undefined;
  const width = settings.region?.width ?? settings.width;
  const height = settings.region?.height ?? settings.height;
  const frameCount = settings.frameCount ?? 1;
  const perFrameBytes = Math.max(1, Math.ceil(estimatedBytes / frameCount));
  const fittingFrames = Math.floor(maximumOutputBytes / perFrameBytes);
  const estimatedMiB = round(estimatedBytes / MIB, 1);
  const budgetMiB = round(maximumOutputBytes / MIB, 1);
  if (settings.kind === 'stills' && fittingFrames >= 2) {
    return `settings.stillCount: ${frameCount} frames at ${width}x${height} is estimated at ${estimatedMiB} MiB, over the ${budgetMiB} MiB combined output byte budget. Render in parts of at most ${fittingFrames} frames (each from its own motion.start), lower width and height, or use kind: "video".`;
  }
  return `settings: ${frameCount} frame(s) at ${width}x${height} is estimated at ${estimatedMiB} MiB, over the ${budgetMiB} MiB combined output byte budget. Lower width and height, drop extra passes, or use kind: "video".`;
}
