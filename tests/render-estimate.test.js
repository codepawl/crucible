import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRenderJobs, normalizeJobSettings, RENDER_HISTORY_FILE } from '../scripts/agent-render-jobs.mjs';
import { conciseJobResult } from '../scripts/mcp-response-format.mjs';
import { planRenderSize } from '../src/budget.js';
import { MAXIMUM_MEMORY_MIB } from '../src/agent-scene-capabilities.js';
import {
  CORRECTION_BOUND, HISTORY_LIMIT, addKernelCompile, correctionFromHistory, estimateOutputBytes, estimateRenderJob, historyWithJob, jobKind, outputByteBudgetProblem, parseHistory, renderReport, sceneSizeFrom,
} from '../scripts/agent-render-estimate.mjs';

const recipe = { format: 'crucible.scene', materials: [{ id: 'wood', map: 'planks' }, { id: 'steel', normalMap: 'dents' }, { id: 'plain' }] };

function inspection({ nodeCount, trianglesEach, truncated = false, parts = nodeCount }) {
  return {
    counts: { nodes: nodeCount, parts, geometries: 1, materials: 3, vertices: trianglesEach },
    look: { pointLights: 2, spotLights: 1, areaLights: 0 },
    nodes: Array.from({ length: nodeCount }, (_, index) => ({ id: `part-${index}`, triangles: trianglesEach })),
    truncated,
  };
}

function settingsFor(overrides) {
  return normalizeJobSettings({ kind: 'image', width: 640, height: 360, ...overrides }, [], { format: 'crucible.scene' });
}

test('scene size counts every placed node, textures and lights', () => {
  const size = sceneSizeFrom(inspection({ nodeCount: 10, trianglesEach: 1200 }), recipe);
  assert.deepEqual(size, { parts: 10, assetParts: 0, assetMiB: 0, nodes: 10, triangles: 12000, listedTriangles: 12000, materials: 3, textures: 2, lights: 4 });
});

test('a truncated node list is scaled up to the part count', () => {
  const size = sceneSizeFrom(inspection({ nodeCount: 64, trianglesEach: 100, truncated: true, parts: 640 }), recipe);
  assert.equal(size.triangles, 64000);
});

test('with no node list the vertex count stands in for the triangle count', () => {
  const size = sceneSizeFrom({ counts: { parts: 1, vertices: 3000 }, nodes: [] }, {});
  assert.equal(size.triangles, 1500);
});

test('the same scene and settings always give the same estimate', () => {
  const size = sceneSizeFrom(inspection({ nodeCount: 50, trianglesEach: 2000 }), recipe);
  const settings = settingsFor({ kind: 'video', width: 480, height: 270, fps: 12, duration: 2 });
  const first = estimateRenderJob({ size, settings, backend: 'gpu' });
  const second = estimateRenderJob({ size, settings, backend: 'gpu' });
  assert.deepEqual(first, second);
  assert.equal(first.basis, 'scene size');
  assert.equal(first.seconds, first.modelSeconds);
});

test('more triangles, more frames and bigger frames cost more time', () => {
  const small = sceneSizeFrom(inspection({ nodeCount: 5, trianglesEach: 500 }), recipe);
  const large = sceneSizeFrom(inspection({ nodeCount: 300, trianglesEach: 5000 }), recipe);
  const image = settingsFor({});
  const video = settingsFor({ kind: 'video', fps: 12, duration: 4, width: 640, height: 360 });
  const estimate = (size, settings) => estimateRenderJob({ size, settings, backend: 'gpu' });
  assert.ok(estimate(large, image).seconds > estimate(small, image).seconds);
  assert.ok(estimate(small, video).seconds > estimate(small, image).seconds);
  assert.ok(estimate(large, image).peakMemoryMiB > estimate(small, image).peakMemoryMiB);
  assert.ok(estimate(large, settingsFor({ kind: 'video', width: 1920, height: 1080, fps: 24, duration: 5 })).seconds > estimate(large, settingsFor({ kind: 'video', width: 480, height: 270, fps: 24, duration: 5 })).seconds);
});

test('the path tracer is capped by maxSeconds and the first GPU trace pays for its kernel', () => {
  const size = sceneSizeFrom(inspection({ nodeCount: 20, trianglesEach: 1000 }), recipe);
  const longTrace = settingsFor({ width: 640, height: 360, renderer: { type: 'pathTracer', backend: 'cpu', samples: 1024, bounces: 8, maxSeconds: 5 } });
  assert.ok(estimateRenderJob({ size, settings: longTrace, backend: 'gpu' }).seconds < 5 + 5);
  const gpuTrace = settingsFor({ width: 256, height: 144, renderer: { type: 'pathTracer', backend: 'gpu', samples: 32, bounces: 3, maxSeconds: 30 } });
  const cold = estimateRenderJob({ size, settings: gpuTrace, backend: 'gpu', gpuTracerWarm: false });
  const warm = estimateRenderJob({ size, settings: gpuTrace, backend: 'gpu', gpuTracerWarm: true });
  assert.ok(cold.seconds - warm.seconds > 5);
});

function historyEntry(ratio, kind = 'raster-image-gpu') {
  return { kind, estimatedSeconds: 2, measuredSeconds: 2 * ratio, estimatedPeakMemoryMiB: 200, measuredPeakMemoryMiB: 200 * ratio };
}

test('history needs two runs of the same kind and moves the estimate by their median', () => {
  assert.deepEqual(correctionFromHistory([historyEntry(3)], 'raster-image-gpu'), { seconds: 1, memory: 1, runs: 1, secondsClamped: false, memoryFromHistory: false });
  assert.equal(correctionFromHistory([historyEntry(3), historyEntry(2), historyEntry(1.5)], 'raster-image-gpu').seconds, 2);
  assert.equal(correctionFromHistory([historyEntry(3), historyEntry(2)], 'raster-video-gpu').runs, 0);
  const size = sceneSizeFrom(inspection({ nodeCount: 5, trianglesEach: 500 }), recipe);
  const settings = settingsFor({});
  const base = estimateRenderJob({ size, settings, backend: 'gpu' });
  const corrected = estimateRenderJob({ size, settings, backend: 'gpu', history: [historyEntry(2), historyEntry(2)] });
  assert.equal(corrected.modelSeconds, base.modelSeconds);
  assert.ok(Math.abs(corrected.seconds - base.modelSeconds * 2) < 0.1);
  assert.match(corrected.basis, /last 2 raster-image-gpu jobs/);
});

test('the correction is bounded either way', () => {
  assert.equal(correctionFromHistory([historyEntry(100), historyEntry(100)], 'raster-image-gpu').seconds, CORRECTION_BOUND);
  assert.equal(correctionFromHistory([historyEntry(0.001), historyEntry(0.001)], 'raster-image-gpu').seconds, 1 / CORRECTION_BOUND);
});

test('the history keeps the newest entries only', () => {
  const settings = settingsFor({});
  const estimate = { modelSeconds: 1, modelPeakMemoryMiB: 200 };
  const report = { measured: { seconds: 1.5, peakMemoryMiB: 220 } };
  let history = [];
  for (let run = 0; run < HISTORY_LIMIT + 5; run++) history = historyWithJob(history, { settings, backend: 'gpu', estimate, report });
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0].kind, jobKind(settings, 'gpu'));
  assert.equal(historyWithJob(history, { settings, backend: 'gpu', estimate: undefined, report }), history);
});

test('a damaged history file counts as no history', () => {
  assert.deepEqual(parseHistory('not json'), []);
  assert.deepEqual(parseHistory('{"kind":"x"}'), []);
  assert.deepEqual(parseHistory(JSON.stringify([{ kind: 'x', estimatedSeconds: 'slow' }, historyEntry(2)])), [historyEntry(2)]);
  assert.equal(parseHistory(JSON.stringify(Array.from({ length: 100 }, () => historyEntry(2)))).length, HISTORY_LIMIT);
});

test('the report puts the estimate, the measurement and what fell back in one record', () => {
  const settings = settingsFor({ width: 1920, height: 1080, renderer: { type: 'pathTracer', backend: 'native', samples: 64 } });
  const metrics = {
    elapsedSeconds: 12.345, peakNodeBytes: 300 * 1024 ** 2, peakBrowserHeap: 100 * 1024 ** 2, requestedWidth: 1920, requestedHeight: 1080, width: 1280, height: 720, requiredMemoryMiB: 250, memoryBudgetMiB: 192,
    pathTracer: { averageSamples: 48, backendNote: 'No native tracer was found. The gpu backend ran instead.', denoiserNote: 'OIDN is not installed; the wavelet denoiser ran.' },
  };
  const report = renderReport({ estimate: { seconds: 10, peakMemoryMiB: 350, basis: 'scene size' }, settings, metrics });
  assert.deepEqual(report.measured, { seconds: 12.35, peakMemoryMiB: 400, frames: 1, secondsPerFrame: 12.345 });
  assert.equal(report.secondsRatio, 1.23);
  assert.equal(report.samplesDrawn, 48);
  assert.equal(report.samplesRequested, 64);
  assert.equal(report.fallbacks.length, 3);
  assert.match(report.fallbacks[0], /1920x1080 to 1280x720/);
  assert.match(report.fallbacks[0], /needs a render budget of 250 MiB; this server runs with --memory 192. Restart it with --memory 250 or more/);
  assert.deepEqual(renderReport({ settings: settingsFor({}), metrics: { elapsedSeconds: 1 } }).fallbacks, []);
});

test('the job store keeps the history file beside its jobs and counts it', async context => {
  const root = await mkdtemp(join(tmpdir(), 'crucible-render-history-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const run = async ({ directory, progress }) => {
    await writeFile(join(directory, 'render.png.partial'), Buffer.from('fixture PNG bytes'));
    await progress({ frames: 1, maximumPendingFrames: 1 });
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }], metrics: {} };
  };
  const first = await createAgentRenderJobs({ root, run });
  await first.close();
  await writeFile(join(root, RENDER_HISTORY_FILE), JSON.stringify([historyEntry(2)]));
  const second = await createAgentRenderJobs({ root, run });
  const { jobId } = await second.submit({ sourceRevision: 0, snapshot: { recipe: { format: 'fixture' } }, settings: { kind: 'image', width: 64, height: 64 } });
  while (second.status(jobId).state !== 'completed') await new Promise(resolve => setTimeout(resolve, 5));
  await second.close();
  assert.equal(JSON.parse(await readFile(join(root, RENDER_HISTORY_FILE), 'utf8')).length, 1);
});

test('placed assets and generated geometry count even though they have no node of their own', () => {
  const cubeOnly = inspection({ nodeCount: 1, trianglesEach: 12 });
  assert.equal(sceneSizeFrom(cubeOnly, recipe).triangles, 12);
  const withAsset = { ...cubeOnly, counts: { ...cubeOnly.counts, vertices: 800000 }, assets: [{ assetId: 'a'.repeat(64), parts: 40 }] };
  assert.equal(sceneSizeFrom(withAsset, recipe).triangles, 400000);
  const tenCopies = { ...withAsset, assets: Array.from({ length: 10 }, () => ({ assetId: 'a'.repeat(64), parts: 40 })) };
  assert.equal(sceneSizeFrom(tenCopies, recipe).triangles, 12 + 399988 * 10);
  const withVegetation ={ ...cubeOnly, counts: { ...cubeOnly.counts, vertices: 150000 }, vegetation: { trees: 300 } };
  assert.equal(sceneSizeFrom(withVegetation, recipe).triangles, 75000);
  const settings = settingsFor({});
  assert.ok(estimateRenderJob({ size: sceneSizeFrom(withAsset, recipe), settings, backend: 'gpu' }).seconds
    > 3 * estimateRenderJob({ size: sceneSizeFrom(cubeOnly, recipe), settings, backend: 'gpu' }).seconds);
});

test('placed asset files and motion sampling add time that triangle counts alone miss (#2286)', () => {
  const withoutAssets = sceneSizeFrom(inspection({ nodeCount: 120, trianglesEach: 1000 }), recipe);
  const withAssets = sceneSizeFrom(inspection({ nodeCount: 120, trianglesEach: 1000 }), recipe, { assetFileBytes: 10 * 1024 ** 2 });
  assert.equal(withoutAssets.assetMiB, 0);
  assert.equal(withAssets.assetMiB, 10);
  assert.equal(withAssets.nodes, 120);
  const still = { ...settingsFor({}), frameCount: 8 };
  const moving = { ...still, motion: { start: 0 } };
  const seconds = (size, settings) => estimateRenderJob({ size, settings, backend: 'gpu' }).seconds;
  assert.ok(seconds(withAssets, still) - seconds(withoutAssets, still) > 8 * 0.5, 'ten MiB of placed files costs setup and a part of every frame');
  assert.ok(seconds(withoutAssets, moving) - seconds(withoutAssets, still) > 1, 'a moving camera samples every node on every frame');
  assert.equal(estimateRenderJob({ size: withAssets, settings: still, backend: 'gpu' }).scene.assetMiB, 10);
});

test('the concise result keeps seconds, the estimate ratio and fallbacks, and drops the rest of the report', () => {
  const settings = settingsFor({ renderer: { type: 'pathTracer', backend: 'native', samples: 64 } });
  const metrics = { elapsedSeconds: 3, peakNodeBytes: 2 ** 28, peakBrowserHeap: 2 ** 26, pathTracer: { averageSamples: 64, backendNote: 'The gpu backend ran instead.' } };
  const report = renderReport({ estimate: { seconds: 2.5, peakMemoryMiB: 300, basis: 'scene size' }, settings, metrics });
  const result = { jobId: 'x', sourceRevision: 1, artifacts: [{ filename: 'render.png', sha256: 'y' }], metrics: { pathTracer: metrics.pathTracer, report } };
  const concise = conciseJobResult(result);
  assert.deepEqual(concise.metrics.report, { seconds: 3, secondsRatio: 1.2, fallbacks: ['The gpu backend ran instead.'] });
  assert.ok(JSON.stringify(concise.metrics.report).length < 120);
  const quiet = conciseJobResult({ ...result, metrics: { report: renderReport({ settings: settingsFor({}), metrics: { elapsedSeconds: 1 } }) } });
  assert.deepEqual(quiet.metrics.report, { seconds: 1 });
});

test('a job that ran at a smaller size than requested is compared with the model at the size that ran (#2286)', () => {
  const settings = settingsFor({ width: 1920, height: 1080 });
  const size = sceneSizeFrom(inspection({ nodeCount: 5, trianglesEach: 500 }), recipe);
  const estimate = estimateRenderJob({ size, settings, backend: 'gpu' });
  const reduced = renderReport({ estimate, settings, metrics: { elapsedSeconds: 1, requestedWidth: 1920, requestedHeight: 1080, width: 960, height: 540 } });
  assert.equal(reduced.frameReduced, true);
  const [entry] = historyWithJob([], { settings, backend: 'gpu', estimate, report: reduced, ranSize: { width: 960, height: 540 } });
  const atRanSize = estimateRenderJob({ size, settings: { ...settings, width: 960, height: 540 }, backend: 'gpu' });
  assert.equal(entry.estimatedSeconds, atRanSize.modelSeconds);
  assert.ok(entry.estimatedSeconds < estimate.modelSeconds);
  assert.equal(entry.estimatedPeakMemoryMiB, atRanSize.modelPeakMemoryMiB);
  const normal = renderReport({ estimate, settings, metrics: { elapsedSeconds: 1, requestedWidth: 1920, requestedHeight: 1080, width: 1920, height: 1080 } });
  assert.equal(historyWithJob([], { settings, backend: 'gpu', estimate, report: normal })[0].estimatedSeconds, estimate.modelSeconds);
});

test('jobs that always run reduced still move the next estimate toward the measured time (#2286)', () => {
  const settings = settingsFor({ width: 1080, height: 1080 });
  const size = sceneSizeFrom(inspection({ nodeCount: 5, trianglesEach: 500 }), recipe);
  const ranSize = { width: 985, height: 985 };
  const measuredSeconds = 12;
  const first = estimateRenderJob({ size, settings, backend: 'gpu' });
  assert.ok(measuredSeconds / first.seconds > 3);
  let history = [];
  for (let run = 0; run < 2; run++) {
    const report = renderReport({ estimate: first, settings, metrics: { elapsedSeconds: measuredSeconds, requestedWidth: 1080, requestedHeight: 1080, ...ranSize } });
    history = historyWithJob(history, { settings, backend: 'gpu', estimate: first, report, ranSize });
  }
  assert.equal(history.length, 2);
  const next = estimateRenderJob({ size, settings, backend: 'gpu', history });
  assert.ok(next.seconds > first.seconds * 2);
  assert.ok(Math.abs(Math.log(measuredSeconds / next.seconds)) < Math.abs(Math.log(measuredSeconds / first.seconds)));
});

test('the basis names the jobs folder, a clamped time factor and missing memory history', () => {
  const size = sceneSizeFrom(inspection({ nodeCount: 5, trianglesEach: 500 }), recipe);
  const settings = settingsFor({});
  const basis = estimateRenderJob({ size, settings, backend: 'gpu', history: [historyEntry(100), historyEntry(100)] }).basis;
  assert.match(basis, /in this jobs folder/);
  assert.match(basis, /time factor limited to 4x/);
  assert.doesNotMatch(basis, /memory from scene size only/);
  const noMemory = [{ ...historyEntry(2), measuredPeakMemoryMiB: 0 }, { ...historyEntry(2), measuredPeakMemoryMiB: 0 }];
  assert.match(estimateRenderJob({ size, settings, backend: 'gpu', history: noMemory }).basis, /memory from scene size only/);
  assert.doesNotMatch(estimateRenderJob({ size, settings, backend: 'gpu', history: [historyEntry(1.5), historyEntry(1.5)] }).basis, /\(/);
});

test('the reduced-frame fallback never asks for a --memory value over the ceiling (#1313)', () => {
  const plan = planRenderSize({ width: 1920, height: 1080, samples: 4, memoryBudgetMiB: 384, hdr: true, bloom: true, geometryBytes: 100e6, textureBytes: 150e6 });
  assert.ok(plan.reduced);
  assert.ok(plan.requiredMemoryMiB > MAXIMUM_MEMORY_MIB);
  const metrics = { elapsedSeconds: 1, requestedWidth: 1920, requestedHeight: 1080, width: plan.width, height: plan.height, requiredMemoryMiB: plan.requiredMemoryMiB, memoryBudgetMiB: 384 };
  const [fallback] = renderReport({ settings: settingsFor({}), metrics }).fallbacks;
  assert.doesNotMatch(fallback, /Restart it with --memory/);
  assert.match(fallback, new RegExp(`--memory accepts at most ${MAXIMUM_MEMORY_MIB}`));
  assert.match(fallback, /Reduce the textures, the geometry, the frame size/);
  const [reachable] = renderReport({ settings: settingsFor({}), metrics: { ...metrics, requiredMemoryMiB: MAXIMUM_MEMORY_MIB, memoryBudgetMiB: 192 } }).fallbacks;
  assert.match(reachable, new RegExp(`Restart it with --memory ${MAXIMUM_MEMORY_MIB} or more`));
});

test('estimateRenderJob reports outputMiB and outputByteBudgetProblem catches oversized stills at submit (#2199)', () => {
  const size = sceneSizeFrom(inspection({ nodeCount: 5, trianglesEach: 500 }), recipe);
  const fitting = normalizeJobSettings({ kind: 'stills', width: 1280, height: 720, fps: 24, stillCount: 224 }, [], { format: 'crucible.scene' });
  const compactEstimate = estimateRenderJob({ size, settings: fitting, backend: 'gpu' });
  assert.ok(compactEstimate.outputMiB > 100 && compactEstimate.outputMiB <= 128);
  assert.equal(outputByteBudgetProblem(fitting), undefined);

  const smallSequence = normalizeJobSettings({ kind: 'stills', width: 640, height: 360, fps: 24, stillCount: 300 }, [], { format: 'crucible.scene' });
  assert.equal(outputByteBudgetProblem(smallSequence), undefined);

  const oversized = normalizeJobSettings({ kind: 'stills', width: 1280, height: 720, fps: 24, stillCount: 288 }, [], { format: 'crucible.scene' });
  const problem = outputByteBudgetProblem(oversized);
  assert.match(problem, /128 MiB/);
  assert.match(problem, /224 frames/);
  assert.match(problem, /motion\.start/);

  const multiPass = normalizeJobSettings({ kind: 'stills', width: 1280, height: 720, fps: 24, stillCount: 120, passes: ['depth', 'normal'] }, [], { format: 'crucible.scene' });
  assert.ok(estimateOutputBytes(multiPass) > estimateOutputBytes(fitting));
  assert.match(outputByteBudgetProblem(multiPass), /combined output byte budget/);

  const partialResult = conciseJobResult({ jobId: 'job-1', state: 'failed', reason: 'Job exceeds its combined output byte budget.', sourceRevision: 1, artifacts: [{ filename: 'frame-0.png', sha256: 'z' }] });
  assert.equal(partialResult.state, 'failed');
  assert.match(partialResult.reason, /combined output byte budget/);
});

test('a film whose first frame compiled kernels says so after its last frame, apart from trace time (#1949)', () => {
  const frames = [{ compileSeconds: 7.04 }, { compileSeconds: 0 }, {}, { compileSeconds: 0.002 }];
  const kernelCompile = frames.reduce(addKernelCompile, undefined);
  assert.equal(kernelCompile.frames, 2);
  const settings = settingsFor({ renderer: { type: 'pathTracer', backend: 'native', samples: 16 } });
  const metrics = { elapsedSeconds: 9, pathTracer: frames.at(-1), kernelCompile };
  const estimate = { modelSeconds: 2, modelPeakMemoryMiB: 200, seconds: 2, peakMemoryMiB: 200, basis: 'scene size' };
  const report = renderReport({ estimate, settings, metrics });
  assert.equal(report.kernelCompile.seconds, 7);
  assert.match(report.kernelCompile.note, /^First render of this scene variant: 7\.0 s of the job compiled kernels/);
  assert.match(report.kernelCompile.note, /counted in secondsRatio/);
  const concise = conciseJobResult({ jobId: 'x', sourceRevision: 1, artifacts: [], metrics: { report } });
  assert.equal(concise.metrics.report.kernelCompile, report.kernelCompile.note);
  // The estimate history learns the render without the one-time compile.
  assert.equal(historyWithJob([], { settings, backend: 'gpu', estimate, report })[0].measuredSeconds, 2);
});

test('a job whose compile stayed under a second, or that compiled nothing, carries no compile note', () => {
  const settings = settingsFor({});
  assert.equal(addKernelCompile(undefined, { compileSeconds: 0 }), undefined);
  assert.equal(renderReport({ settings, metrics: { elapsedSeconds: 1, kernelCompile: { seconds: 0.4, frames: 1 } } }).kernelCompile, undefined);
  assert.equal('kernelCompile' in renderReport({ settings, metrics: { elapsedSeconds: 1 } }), false);
});
