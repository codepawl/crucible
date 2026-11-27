// Writes the compact quality-tier table of the home page (site/index.html, between the tier-cards markers) from the tier matrix results.
//   node bench/tiers/make-home-tiers.mjs [results.json]            print the table markup
//   node bench/tiers/make-home-tiers.mjs [results.json] --write    rewrite the table markup in site/index.html
// Every figure is the lowest and highest per-scene median over the scenes of the matrix, and runs marked contended stay out.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { median } from './idle-gate.mjs';
import { equalErrorAssessment, REFERENCE_SAMPLES } from './equal-error.mjs';
import { DEFAULT_RESULTS_PATH, TIER_PLAN, usableCells } from './make-tier-page-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOME_PAGE_PATH = resolve(HERE, '..', '..', 'site', 'index.html');
export const CARDS_START_MARKER = '<!-- tier-cards:start (written by bench/tiers/make-home-tiers.mjs) -->';
export const CARDS_END_MARKER = '<!-- tier-cards:end -->';
export const REGENERATE_COMMAND = 'node bench/tiers/make-home-tiers.mjs --write';

// Bar axis upper bounds verified against the matrix so oversized figures fail loudly.
const FLIP_AXIS_MAXIMUM = 0.6;
const NOISE_TIME_AXIS_MAXIMUM = 4.5;
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
const BLENDER_LABEL = { 'eevee-lowest': 'EEVEE 1 sample', 'eevee-default': 'EEVEE 64 samples' };
const TIER_ICON_ID = { draft: 'ic-zap', realtime: 'ic-gauge', final: 'ic-award' };
const TIER_PURPOSE = { draft: 'Quick edits', realtime: 'Interactive scenes', final: 'Path-traced stills' };

function tierIcon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#${TIER_ICON_ID[name]}"/></svg>`;
}

function fail(message) {
  throw new Error(`make-home-tiers: ${message}`);
}

function medianOfCells(matrix, scene, part, read) {
  const values = usableCells(matrix, scene, part).usable.map(read).filter(value => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) fail(`no figure for ${part.engine} on scene "${scene}"; run score-tiers.py matrix on the results first`);
  return median(values);
}

function roundedRange(values, digits) {
  return { low: Number(Math.min(...values).toFixed(digits)), high: Number(Math.max(...values).toFixed(digits)) };
}

function acrossScenes(matrix, part, read, digits) {
  return roundedRange(matrix.scenes.map(scene => medianOfCells(matrix, scene, part, read)), digits);
}

function countedPoints(matrix, scene, engine) {
  const sampleCounts = [...new Set(matrix.cells.filter(cell => cell.scene === scene && cell.engine === engine && cell.status === 'ok').map(cell => cell.samples))];
  return sampleCounts.map(samples => {
    const part = { engine, samples };
    return {
      samples,
      relMse: medianOfCells(matrix, scene, part, cell => cell.score?.relMse),
      samplingSeconds: medianOfCells(matrix, scene, part, cell => cell.metrics?.samplingSeconds),
      totalSeconds: medianOfCells(matrix, scene, part, cell => cell.metrics?.totalTraceSeconds),
    };
  });
}

function equalNoise(matrix) {
  const assessments = matrix.scenes.map(scene => equalErrorAssessment(scene, (sceneId, engine) => countedPoints(matrix, sceneId, engine))).filter(Boolean);
  const reached = assessments.filter(assessment => assessment.outcome === 'noise');
  if (reached.length === 0) fail('no scene has an equal-noise ratio; it needs 256 and 1024 sample runs of Cook native and Cycles');
  const ratios = reached.map(assessment => assessment.timeRatioSampling);
  return {
    ...roundedRange(ratios, 2),
    reachedCount: reached.length,
    notReached: assessments.filter(assessment => assessment.outcome !== 'noise').map(assessment => assessment.scene),
  };
}

export function buildHomeTierFigures(matrix) {
  if (!matrix || !Array.isArray(matrix.cells) || !Array.isArray(matrix.scenes)) fail('the results file needs "cells" and "scenes"; pass the matrix-<width>.json that bench/tiers/run-all.mjs writes');
  const flip = engine => acrossScenes(matrix, { engine }, cell => cell.score?.flip, 3);
  const frame = (engine, digits) => acrossScenes(matrix, { engine }, cell => cell.metrics?.primaryMilliseconds, digits);
  const perSample = engine => acrossScenes(matrix, { engine, samples: REFERENCE_SAMPLES }, cell => cell.metrics?.perSampleMilliseconds, 2);
  const figures = {};
  for (const plan of TIER_PLAN.filter(tier => !tier.planned && tier.id !== 'final')) {
    figures[plan.id] = {
      glazeMilliseconds: frame(plan.crucible.engine, 2),
      blenderMilliseconds: frame(plan.blender.engine, 0),
      glazeFlip: flip(plan.crucible.engine),
      blenderFlip: flip(plan.blender.engine),
      blenderLabel: BLENDER_LABEL[plan.blender.engine],
    };
  }
  const final = TIER_PLAN.find(tier => tier.id === 'final');
  figures.final = {
    cookMilliseconds: perSample(final.crucible.engine),
    cyclesMilliseconds: perSample(final.blender.engine),
    noise: equalNoise(matrix),
    sceneCount: matrix.scenes.length,
  };
  return figures;
}

const twoDigits = value => value.toFixed(2);
const noDigits = value => value.toFixed(0);
const trimmed = value => String(Number(value.toFixed(3)));
const words = (figure, format) => `${format(figure.low)} to ${format(figure.high)}`;
const attribute = (figure, format) => `${format(figure.low)}-${format(figure.high)}`;
const percent = value => `${Number(value.toFixed(1))}%`;

function checkAxis(name, value, axisMaximum, constantName) {
  if (value > axisMaximum) fail(`${name} is ${value}, past the bar axis of ${axisMaximum}; raise ${constantName} in bench/tiers/make-home-tiers.mjs`);
}

function frameRow(id, figures) {
  const { glazeMilliseconds: glaze, blenderMilliseconds: blender, glazeFlip, blenderFlip, blenderLabel } = figures;
  checkAxis('A FLIP error', Math.max(glazeFlip.high, blenderFlip.high), FLIP_AXIS_MAXIMUM, 'FLIP_AXIS_MAXIMUM');
  const glazeText = `${words(glaze, twoDigits)} ms`;
  const blenderText = `${words(blender, noDigits)} ms`;
  const share = percent((glaze.high / blender.high) * 100);
  return `        <li class="tier-row" data-tier="${id}" data-glaze-ms="${attribute(glaze, twoDigits)}" data-eevee-ms="${attribute(blender, noDigits)}" data-flip-glaze="${attribute(glazeFlip, trimmed)}" data-flip-eevee="${attribute(blenderFlip, trimmed)}">
          <div class="tier-name">${tierIcon(id)}<div><strong>${id}</strong><span>${TIER_PURPOSE[id]}</span></div></div>
          <div class="tier-metric">
            <div class="tier-value"><b>${glazeText}</b><span>per frame, Glaze</span></div>
            <span class="tier-bar" role="img" aria-label="Crucible Glaze ${glazeText} per frame versus ${blenderLabel} ${blenderText} per render call"><i style="--share: ${share}"></i></span>
          </div>
          <div class="tier-ref"><b>${blenderText}</b><span>${blenderLabel}</span></div>
        </li>`;
}

function finalRow(figures) {
  const { cookMilliseconds: cook, cyclesMilliseconds: cycles, noise } = figures;
  checkAxis('The equal-noise time', noise.high, NOISE_TIME_AXIS_MAXIMUM, 'NOISE_TIME_AXIS_MAXIMUM');
  const cookText = `${words(cook, twoDigits)} ms`;
  const cyclesText = `${words(cycles, twoDigits)} ms`;
  const share = percent((cook.high / cycles.high) * 100);
  return `        <li class="tier-row" data-tier="final" data-cook-ms="${attribute(cook, twoDigits)}" data-cycles-ms="${attribute(cycles, twoDigits)}" data-noise-time-x="${attribute(noise, twoDigits)}">
          <div class="tier-name">${tierIcon('final')}<div><strong>final</strong><span>${TIER_PURPOSE.final}</span></div></div>
          <div class="tier-metric">
            <div class="tier-value"><b>${cookText}</b><span>per sample, Cook</span></div>
            <span class="tier-bar" role="img" aria-label="Cook native ${cookText} per sample versus Cycles OptiX ${cyclesText} per sample"><i style="--share: ${share}"></i></span>
          </div>
          <div class="tier-ref"><b>${cyclesText}</b><span>Cycles OptiX</span></div>
        </li>`;
}

function renderFootnotes(matrix, figures) {
  const { draft, realtime, final } = figures;
  const { noise, sceneCount } = final;
  const reachedText = `${NUMBER_WORDS[noise.reachedCount] ?? noise.reachedCount} of ${NUMBER_WORDS[sceneCount] ?? sceneCount}`;
  const notReached = noise.notReached.length > 0 ? ` (not reached on ${noise.notReached.join(', ')})` : '';
  const resolution = matrix.width && matrix.height ? `${matrix.width}x${matrix.height}` : '960x540';
  const measuredDate = matrix.conditions?.date ?? '2026-11-11';
  const referenceSamples = matrix.referenceSamples ?? REFERENCE_SAMPLES;
  return `      <div class="tier-notes">
        <p class="fine">Six scenes at ${resolution} on RTX 3060 (${measuredDate}). Bars compare Crucible to the slowest scene of each reference.</p>
        <p class="fine">Error vs Cycles ${referenceSamples} samples (FLIP, lower is closer): draft ${words(draft.glazeFlip, trimmed)} (EEVEE ${words(draft.blenderFlip, trimmed)}), realtime ${words(realtime.glazeFlip, trimmed)} (EEVEE ${words(realtime.blenderFlip, trimmed)}). Cook native takes ${words(noise, twoDigits)}x Cycles time for equal noise on ${reachedText} scenes${notReached} and uses optional @codepawlhq/cook. EEVEE times are one whole render call (scene sync, ray tracing off, no GI). <a href="/benchmark.html">Full tier breakdown</a>, <a href="https://github.com/codepawl/crucible/blob/main/bench/tiers/results/matrix-960.table.md">raw matrix</a>.</p>
      </div>`;
}

export function renderTierCards(matrix) {
  const figures = buildHomeTierFigures(matrix);
  const rows = [frameRow('draft', figures.draft), frameRow('realtime', figures.realtime), finalRow(figures.final)].join('\n');
  return `      <ol class="tier-table">
        <li class="tier-row tier-row-head" aria-hidden="true"><span>Tier</span><span>Crucible</span><span>Blender reference</span></li>
${rows}
      </ol>
${renderFootnotes(matrix, figures)}`;
}

// Replaces what sits between the markers of the page with the compact tier table.
export function replaceTierCards(pageHtml, cards) {
  const start = pageHtml.indexOf(CARDS_START_MARKER);
  const end = pageHtml.indexOf(CARDS_END_MARKER);
  if (start === -1 || end === -1 || end < start) fail(`site/index.html needs the lines ${CARDS_START_MARKER} and ${CARDS_END_MARKER} around the tier cards`);
  return `${pageHtml.slice(0, start + CARDS_START_MARKER.length)}\n${cards}\n      ${pageHtml.slice(end)}`;
}

async function main(argumentsGiven) {
  const resultsArgument = argumentsGiven.find(argument => !argument.startsWith('--'));
  const matrix = JSON.parse(await readFile(resolve(resultsArgument ?? DEFAULT_RESULTS_PATH), 'utf8'));
  const cards = renderTierCards(matrix);
  if (!argumentsGiven.includes('--write')) {
    console.log(cards);
    return;
  }
  const page = await readFile(HOME_PAGE_PATH, 'utf8');
  await writeFile(HOME_PAGE_PATH, replaceTierCards(page, cards));
  console.log(`wrote the tier cards in ${HOME_PAGE_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
