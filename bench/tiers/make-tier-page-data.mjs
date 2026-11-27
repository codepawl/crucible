// Turns the results file of the tier matrix into the figures of /tiers.html across all scenes.
//   node bench/tiers/make-tier-page-data.mjs [results.json] [--scene lit-interior] [--out file.json]
// Defaults: bench/tiers/results/matrix-960.json, lit-interior, bench/tiers/results/tier-page-<scene>.json.
// Every figure is the median of the runs that were not contended, with the lowest and highest beside it.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { equalErrorAssessment, REFERENCE_SAMPLES } from './equal-error.mjs';
import { median } from './idle-gate.mjs';

export const TIER_PAGE_SCHEMA = 'crucible.tier-page/1';
export const DEFAULT_SCENE = 'lit-interior';
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RESULTS_PATH = resolve(HERE, 'results', 'matrix-960.json');
const COOK_SAMPLES = 256;

// What each tier runs and what sits beside it in the reference suite. Time is a frame for real-time tiers and a whole picture for final.
export const TIER_PLAN = [
  { id: 'draft', crucible: { engine: 'glaze-draft', label: 'Glaze draft', timeMeans: 'a frame, draw and pixel read' }, blender: { engine: 'eevee-lowest', label: 'EEVEE, 1 sample', timeMeans: 'a render call' }, timeUnit: 'ms', timeSource: 'primaryMilliseconds', timeScale: 1 },
  { id: 'realtime', crucible: { engine: 'glaze-realtime', label: 'Glaze realtime', timeMeans: 'a frame, draw and pixel read' }, blender: { engine: 'eevee-default', label: 'EEVEE, 64 samples', timeMeans: 'a render call' }, timeUnit: 'ms', timeSource: 'primaryMilliseconds', timeScale: 1 },
  { id: 'realtime-high', planned: true, issues: [901, 902] },
  { id: 'final', crucible: { engine: 'cook-native', label: `Cook native, ${COOK_SAMPLES} samples`, samples: COOK_SAMPLES, timeMeans: 'one picture, setup included' }, blender: { engine: 'cycles', label: `Cycles, ${COOK_SAMPLES} samples`, samples: COOK_SAMPLES, timeMeans: 'one picture, setup included' }, timeUnit: 's', timeSource: 'totalTraceSeconds', timeScale: 1 },
];

function fail(message) {
  throw new Error(`make-tier-page-data: ${message}`);
}

function validateMatrix(matrix) {
  if (!matrix || typeof matrix !== 'object' || !Array.isArray(matrix.cells) || !matrix.conditions || !Array.isArray(matrix.scenes)) {
    fail('the results file needs "cells", "scenes" and "conditions"; pass the matrix-<width>.json that bench/tiers/run-all.mjs writes');
  }
  for (const field of ['card', 'blender', 'node', 'platform', 'date']) {
    if (typeof matrix.conditions[field] !== 'string' || matrix.conditions[field] === '') fail(`conditions.${field} is missing; every figure must name the hardware it was measured on, so rerun with the idle gate or add the field`);
  }
}

export function spread(values, digits) {
  const finite = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (finite.length === 0) return null;
  return { median: median(finite), low: Math.min(...finite), high: Math.max(...finite), runs: finite.length, digits };
}

export function usableCells(matrix, scene, part, { allowMissing = false } = {}) {
  const cells = matrix.cells.filter(cell => cell.status === 'ok' && cell.scene === scene && cell.engine === part.engine && (part.samples === undefined || cell.samples === part.samples));
  const usable = cells.filter(cell => !cell.contended);
  if (usable.length === 0) {
    if (allowMissing) return null;
    fail(`no usable run of ${part.engine}${part.samples ? ` at ${part.samples} samples` : ''} on scene "${scene}" (${cells.length} found, all contended or failed); rerun that cell on an idle card`);
  }
  return { usable, total: cells.length };
}

function figuresOf(matrix, scene, part, plan, options) {
  const found = usableCells(matrix, scene, part, options);
  if (!found) return null;
  const { usable, total } = found;
  const time = spread(usable.map(cell => cell.metrics?.[plan.timeSource] * plan.timeScale), 2);
  const memory = spread(usable.map(cell => cell.metrics?.cardDeltaMebibytes), 0);
  const quality = spread(usable.map(cell => cell.score?.flip), 3);
  if (!time || !memory || !quality) fail(`${part.engine} on "${scene}" lacks a time, a memory or a FLIP figure; run score-tiers.py matrix on the results first`);
  const result = {
    engine: part.engine,
    label: part.label,
    runs: usable.length,
    runsTotal: total,
    time: { ...time, unit: plan.timeUnit, means: part.timeMeans },
    memoryMebibytes: memory,
    flip: quality,
  };
  if (part.engine.startsWith('glaze-')) {
    const throughputMilliseconds = spread(usable.map(cell => cell.metrics?.throughputMilliseconds), 2);
    const firstFrameMilliseconds = spread(usable.map(cell => cell.metrics?.firstFrameMilliseconds), 1);
    if (throughputMilliseconds) result.throughputMilliseconds = throughputMilliseconds;
    if (firstFrameMilliseconds) result.firstFrameMilliseconds = firstFrameMilliseconds;
  }
  if (part.engine === 'cook-native' || part.engine === 'cycles' || part.engine === 'cook-webgpu') {
    const perSampleMilliseconds = spread(usable.map(cell => cell.metrics?.perSampleMilliseconds), 2);
    if (perSampleMilliseconds) result.perSampleMilliseconds = perSampleMilliseconds;
  }
  return result;
}

function countedPoints(matrix, scene, engine) {
  const sampleCounts = [...new Set(matrix.cells.filter(cell => cell.status === 'ok' && cell.scene === scene && cell.engine === engine).map(cell => cell.samples))];
  return sampleCounts.map(samples => {
    const usable = usableCells(matrix, scene, { engine, samples }, { allowMissing: true })?.usable ?? [];
    if (usable.length === 0) return null;
    return {
      samples,
      relMse: median(usable.map(cell => cell.score?.relMse).filter(Number.isFinite)),
      samplingSeconds: median(usable.map(cell => cell.metrics?.samplingSeconds).filter(Number.isFinite)),
      totalSeconds: median(usable.map(cell => cell.metrics?.totalTraceSeconds).filter(Number.isFinite)),
    };
  }).filter(Boolean);
}

function buildWebgpuSummary(matrix, scene, plan, nativeFigures) {
  const webgpu = figuresOf(matrix, scene, { engine: 'cook-webgpu', label: `Cook WebGPU, ${COOK_SAMPLES} samples`, samples: COOK_SAMPLES, timeMeans: 'one picture, setup included' }, plan, { allowMissing: true });
  if (!webgpu) return null;
  const cells = usableCells(matrix, scene, { engine: 'cook-webgpu', samples: COOK_SAMPLES }, { allowMissing: true })?.usable ?? [];
  const flipVsNativeValues = cells.map(cell => cell.score?.versusNative?.flip).filter(Number.isFinite);
  if (flipVsNativeValues.length > 0) webgpu.flipVsNative = Number(median(flipVsNativeValues).toFixed(4));
  if (nativeFigures.perSampleMilliseconds && webgpu.perSampleMilliseconds) {
    webgpu.slowdownVsNative = Number((webgpu.perSampleMilliseconds.median / nativeFigures.perSampleMilliseconds.median).toFixed(1));
  }
  return webgpu;
}

function buildEqualErrorSummary(matrix, scene) {
  const assessment = equalErrorAssessment(scene, (sceneId, engine) => countedPoints(matrix, sceneId, engine));
  if (!assessment) return null;
  return {
    outcome: assessment.outcome,
    sampleRatio: assessment.sampleRatio === undefined ? null : Number(assessment.sampleRatio.toFixed(1)),
    perSampleSpeedup: assessment.perSampleSpeedup === undefined ? null : Number(assessment.perSampleSpeedup.toFixed(2)),
    timeRatioSampling: assessment.timeRatioSampling === undefined ? null : Number(assessment.timeRatioSampling.toFixed(2)),
    timeRatioTotal: assessment.timeRatioTotal === undefined ? null : Number(assessment.timeRatioTotal.toFixed(2)),
    targetRelMse: assessment.targetRelMse,
    cookRelMse256: assessment.nativeTrend?.short ?? null,
    cookRelMse1024: assessment.nativeTrend?.long ?? null,
    cyclesRelMse256: assessment.cyclesTrend?.short ?? null,
    cyclesRelMse1024: assessment.cyclesTrend?.long ?? null,
  };
}

function buildSceneTiers(matrix, scene) {
  return TIER_PLAN.map(plan => {
    if (plan.planned) return { id: plan.id, status: 'planned', issues: plan.issues };
    const crucible = figuresOf(matrix, scene, plan.crucible, plan);
    const blender = figuresOf(matrix, scene, plan.blender, plan);
    const tier = { id: plan.id, status: 'measured', crucible, blender };
    if (plan.id === 'final') {
      const webgpu = buildWebgpuSummary(matrix, scene, plan, crucible);
      const equalError = buildEqualErrorSummary(matrix, scene);
      if (webgpu) tier.webgpu = webgpu;
      if (equalError) tier.equalError = equalError;
    }
    return tier;
  });
}

export function buildTierPageData(matrix, { scene = DEFAULT_SCENE } = {}) {
  validateMatrix(matrix);
  if (!matrix.scenes.includes(scene)) fail(`scene "${scene}" is not in the results; pass one of ${matrix.scenes.join(', ')}`);
  const scenes = {};
  for (const sceneName of matrix.scenes) {
    scenes[sceneName] = { tiers: buildSceneTiers(matrix, sceneName) };
  }
  const { card, blender, node, platform, date } = matrix.conditions;
  return {
    schema: TIER_PAGE_SCHEMA,
    scene,
    source: 'bench/tiers/results/matrix-960.json',
    width: matrix.width,
    height: matrix.height,
    referenceSamples: matrix.referenceSamples ?? REFERENCE_SAMPLES,
    conditions: { card, blender, node, platform, date },
    idleGate: {
      totalRuns: matrix.cells.length,
      contendedCount: matrix.cells.filter(cell => cell.contended).length,
    },
    sceneOrder: matrix.scenes,
    tiers: scenes[scene].tiers,
    scenes,
  };
}

async function main(argumentsGiven) {
  const valueAfter = flag => (argumentsGiven.includes(flag) ? argumentsGiven[argumentsGiven.indexOf(flag) + 1] : undefined);
  const resultsPath = resolve(argumentsGiven[0] && !argumentsGiven[0].startsWith('--') ? argumentsGiven[0] : DEFAULT_RESULTS_PATH);
  const scene = valueAfter('--scene') ?? DEFAULT_SCENE;
  const outputPath = resolve(valueAfter('--out') ?? resolve(HERE, 'results', `tier-page-${scene}.json`));
  const matrix = JSON.parse(await readFile(resultsPath, 'utf8'));
  const data = buildTierPageData(matrix, { scene });
  await writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
