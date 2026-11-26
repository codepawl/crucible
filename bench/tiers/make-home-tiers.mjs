// Writes the tier cards of the home page (site/index.html, between the tier-cards markers) from the results file of the tier matrix.
//   node bench/tiers/make-home-tiers.mjs [results.json]            print the cards
//   node bench/tiers/make-home-tiers.mjs [results.json] --write    rewrite the cards in site/index.html
// Every figure is the lowest and highest per-scene median over the scenes of the matrix, as in the summary of make-table.mjs, and the runs the
// idle gate marked contended stay out. tests/home-tier-cards.test.js fails when site/index.html differs from what this prints.
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

// The full width of the error bars (FLIP) and of the equal-noise bars (times Cycles' time). A figure past its axis would be cut off.
const FLIP_AXIS_MAXIMUM = 0.6;
const NOISE_TIME_AXIS_MAXIMUM = 4.5;
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
const BLENDER_LABEL = { 'eevee-lowest': 'EEVEE 1 sample', 'eevee-default': 'EEVEE 64 samples' };
// Thin-line sprite icons of the tier names, referencing symbols defined in site/index.html.
const TIER_ICON_ID = {
  draft: 'ic-zap',
  realtime: 'ic-gauge',
  'realtime-high': 'ic-sparkles',
  final: 'ic-award',
};
const tierIcon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#${TIER_ICON_ID[name]}"/></svg>`;
const TIER_ICON = { draft: tierIcon('draft'), realtime: tierIcon('realtime'), 'realtime-high': tierIcon('realtime-high'), final: tierIcon('final') };
const TIER_PURPOSE = { draft: 'A quick look while editing', realtime: 'Interactive use' };

function fail(message) {
  throw new Error(`make-home-tiers: ${message}`);
}

function medianOfCells(matrix, scene, part, read) {
  const values = usableCells(matrix, scene, part).usable.map(read).filter(value => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) fail(`no figure for ${part.engine} on scene "${scene}"; run score-tiers.py matrix on the results first`);
  return median(values);
}

// Figures are rounded to the digits the card prints, so a bar is drawn from the numbers beside it.
function roundedRange(values, digits) {
  return { low: Number(Math.min(...values).toFixed(digits)), high: Number(Math.max(...values).toFixed(digits)) };
}

// Lowest and highest per-scene median of one figure.
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

// Cook native against Cycles at equal noise: the sampling-time ratio over the scenes where both errors fall as 1/N, and the scenes where they do not.
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
const range = (figure, format) => `${format(figure.low)}–${format(figure.high)}`;
const attribute = (figure, format) => `${format(figure.low)}-${format(figure.high)}`;
const words = (figure, format) => `${format(figure.low)} to ${format(figure.high)}`;
const percent = value => `${Number(value.toFixed(1))}%`;

function checkAxis(name, value, axisMaximum, constantName) {
  if (value > axisMaximum) fail(`${name} is ${value}, past the bar axis of ${axisMaximum}; raise ${constantName} in bench/tiers/make-home-tiers.mjs`);
}

// Meter rows are written as a label line over a bar; src/landing.css draws the bar from --share (width) and --from (start of a range).
function meterRow({ ours, label, value, share, from }) {
  const classes = [ours ? 'ours' : '', from === undefined ? '' : 'range'].filter(Boolean).join(' ');
  const classAttribute = classes ? ` class="${classes}"` : '';
  const style = from === undefined ? `--share: ${share}` : `--from: ${from}; --share: ${share}`;
  return `<span><span>${label}</span><span>${value}</span></span><i${classAttribute} style="${style}"></i>`;
}

function meter(ariaLabel, rows) {
  return `          <div class="meter" role="img" aria-label="${ariaLabel}">
            ${rows.join('\n            ')}
          </div>`;
}

const rangeRow = (row, figure, axisMaximum) => meterRow({ ...row, from: percent((figure.low / axisMaximum) * 100), share: percent(((figure.high - figure.low) / axisMaximum) * 100) });

function frameCard(id, figures) {
  const { glazeMilliseconds: glaze, blenderMilliseconds: blender, glazeFlip, blenderFlip, blenderLabel } = figures;
  checkAxis('A FLIP error', Math.max(glazeFlip.high, blenderFlip.high), FLIP_AXIS_MAXIMUM, 'FLIP_AXIS_MAXIMUM');
  const glazeText = range(glaze, twoDigits);
  const speedMeter = meter(`Glaze ${words(glaze, twoDigits)} ms a frame; ${blenderLabel} ${words(blender, noDigits)} ms a render call`, [
    meterRow({ ours: true, label: 'Crucible Glaze', value: `${glazeText} ms`, share: percent((glaze.high / blender.high) * 100) }),
    meterRow({ ours: false, label: blenderLabel, value: `${range(blender, noDigits)} ms`, share: '100%' }),
  ]);
  const errorMeter = meter(`Error vs Cycles, lower is better: Glaze ${words(glazeFlip, trimmed)}, EEVEE ${words(blenderFlip, trimmed)}`, [
    rangeRow({ ours: true, label: 'Error, Glaze', value: range(glazeFlip, trimmed) }, glazeFlip, FLIP_AXIS_MAXIMUM),
    rangeRow({ ours: false, label: 'Error, EEVEE', value: range(blenderFlip, trimmed) }, blenderFlip, FLIP_AXIS_MAXIMUM),
  ]);
  return `        <li class="tier" data-tier="${id}" data-glaze-ms="${attribute(glaze, twoDigits)}" data-eevee-ms="${attribute(blender, noDigits)}" data-flip-glaze="${attribute(glazeFlip, trimmed)}" data-flip-eevee="${attribute(blenderFlip, trimmed)}">
          <h3>${TIER_ICON[id]}${id}</h3><p>${TIER_PURPOSE[id]}</p>
          <p class="big">${glazeText} <span>ms a frame</span></p>
${speedMeter}
${errorMeter}
        </li>`;
}

const PLANNED_CARD = `        <li class="tier" data-tier="realtime-high" data-status="planned">
          <h3>${TIER_ICON['realtime-high']}realtime-high</h3><p>Better live frames</p>
          <p class="big">Planned <span>not measured</span></p>
          <p>WebGPU, GI cache, upscaling. Issues <a href="https://github.com/codepawl/crucible/issues/901">901</a> and <a href="https://github.com/codepawl/crucible/issues/902">902</a>.</p>
        </li>`;

function finalCard(figures) {
  const { cookMilliseconds: cook, cyclesMilliseconds: cycles, noise, sceneCount } = figures;
  checkAxis('The equal-noise time', noise.high, NOISE_TIME_AXIS_MAXIMUM, 'NOISE_TIME_AXIS_MAXIMUM');
  const cookText = range(cook, twoDigits);
  const reachedText = `${NUMBER_WORDS[noise.reachedCount]} of ${NUMBER_WORDS[sceneCount]}`;
  const notReached = noise.notReached.length > 0 ? `Not reached on ${noise.notReached.join(', ')}. ` : '';
  const speedMeter = meter(`Per sample: Cook native ${words(cook, twoDigits)} ms, Cycles OptiX ${words(cycles, twoDigits)} ms`, [
    meterRow({ ours: true, label: 'Cook native', value: `${cookText} ms`, share: percent((cook.high / cycles.high) * 100) }),
    meterRow({ ours: false, label: 'Cycles OptiX', value: `${range(cycles, twoDigits)} ms`, share: '100%' }),
  ]);
  const noiseMeter = meter(`Time to the same noise, Cycles is 1 times: Cook needs ${words(noise, twoDigits)} times, on ${reachedText} scenes`, [
    meterRow({ ours: false, label: 'Same noise, Cycles', value: '1×', share: percent((1 / NOISE_TIME_AXIS_MAXIMUM) * 100) }),
    rangeRow({ ours: true, label: 'Same noise, Cook', value: `${range(noise, twoDigits)}×` }, noise, NOISE_TIME_AXIS_MAXIMUM),
  ]);
  return `        <li class="tier" data-tier="final" data-cook-ms="${attribute(cook, twoDigits)}" data-cycles-ms="${attribute(cycles, twoDigits)}" data-noise-time-x="${attribute(noise, twoDigits)}">
          <h3>${TIER_ICON.final}final</h3><p>Finished stills</p>
          <p class="big">${cookText} <span>ms per sample</span></p>
${speedMeter}
${noiseMeter}
          <p>Slower to the same noise. ${notReached}Vulkan needs the optional Cook package.</p>
        </li>`;
}

export function renderTierCards(matrix) {
  const figures = buildHomeTierFigures(matrix);
  return [frameCard('draft', figures.draft), frameCard('realtime', figures.realtime), PLANNED_CARD, finalCard(figures.final)].join('\n');
}

// Replaces what sits between the markers of the page with the cards.
export function replaceTierCards(pageHtml, cards) {
  const start = pageHtml.indexOf(CARDS_START_MARKER);
  const end = pageHtml.indexOf(CARDS_END_MARKER);
  if (start === -1 || end === -1 || end < start) fail(`site/index.html needs the lines ${CARDS_START_MARKER} and ${CARDS_END_MARKER} around the tier cards`);
  return `${pageHtml.slice(0, start + CARDS_START_MARKER.length)}\n${cards}\n        ${pageHtml.slice(end)}`;
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
