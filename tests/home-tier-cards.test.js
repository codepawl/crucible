import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_RESULTS_PATH } from '../bench/tiers/make-tier-page-data.mjs';
import { HOME_PAGE_PATH, REGENERATE_COMMAND, buildHomeTierFigures, renderTierCards, replaceTierCards } from '../bench/tiers/make-home-tiers.mjs';

const matrix = JSON.parse(readFileSync(DEFAULT_RESULTS_PATH, 'utf8'));
const homePage = readFileSync(HOME_PAGE_PATH, 'utf8');

test('the tier cards of the home page are what the generator writes from the committed matrix', () => {
  assert.equal(replaceTierCards(homePage, renderTierCards(matrix)), homePage, `site/index.html has tier-card figures that differ from bench/tiers/results/matrix-960.json; run: ${REGENERATE_COMMAND}`);
  assert.equal((renderTierCards(matrix).match(/data-tier="/g) ?? []).length, 3);
  assert.ok(!homePage.includes('realtime-high'));
  assert.ok(!homePage.includes('data-status="planned"'));
});

test('the figures are the lowest and highest per-scene median over all six scenes', () => {
  const figures = buildHomeTierFigures(matrix);
  assert.deepEqual(figures.draft.glazeMilliseconds, { low: 0.56, high: 0.95 });
  assert.deepEqual(figures.realtime.blenderMilliseconds, { low: 258, high: 315 });
  assert.deepEqual(figures.final.cookMilliseconds, { low: 1.63, high: 3.96 });
  assert.deepEqual([figures.final.noise.low, figures.final.noise.high, figures.final.noise.reachedCount], [1.06, 2.45, 3]);
});

test('a slower run in the matrix reaches the cards, and a contended run stays out', () => {
  const changed = structuredClone(matrix);
  const draftRuns = changed.cells.filter(cell => cell.engine === 'glaze-draft' && cell.scene === 'metal');
  draftRuns.forEach((cell, index) => { cell.metrics.primaryMilliseconds = [2, 3, 900][index]; });
  draftRuns[2].contended = true;
  assert.match(renderTierCards(changed), /data-glaze-ms="0.56-2.50"/);
});

test('a figure past the bar axis stops the generator and names the constant to raise', () => {
  const worse = structuredClone(matrix);
  for (const cell of worse.cells.filter(item => item.engine === 'eevee-default')) cell.score.flip = 0.9;
  assert.throws(() => renderTierCards(worse), /raise FLIP_AXIS_MAXIMUM/);
});

test('a page without the markers is refused with the markers to add', () => {
  assert.throws(() => replaceTierCards('<ol></ol>', 'x'), /tier-cards:start/);
});
