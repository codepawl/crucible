import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTierPageData, DEFAULT_RESULTS_PATH } from '../bench/tiers/make-tier-page-data.mjs';
import { describeConditions, describeSceneBreakdown, describeTier, describeTierForScene, describeTierOverview } from '../src/tiers-model.js';

const matrix = JSON.parse(readFileSync(DEFAULT_RESULTS_PATH, 'utf8'));
const committed = JSON.parse(readFileSync(new URL('../bench/tiers/results/tier-page-lit-interior.json', import.meta.url), 'utf8'));

test('the committed page data is exactly what the generator writes from the committed matrix', () => {
  assert.deepEqual(buildTierPageData(matrix, { scene: 'lit-interior' }), committed);
});

test('the page data names the hardware of the matrix and marks realtime-high as planned', () => {
  assert.equal(committed.conditions.card, matrix.conditions.card);
  assert.equal(committed.conditions.date, matrix.conditions.date);
  const planned = committed.tiers.find(tier => tier.id === 'realtime-high');
  assert.equal(planned.status, 'planned');
  assert.equal(planned.crucible, undefined);
});

test('a contended run stays out of the median', () => {
  const copy = structuredClone(matrix);
  const draftCells = copy.cells.filter(cell => cell.scene === 'lit-interior' && cell.engine === 'glaze-draft');
  draftCells[0].contended = true;
  draftCells[0].metrics.primaryMilliseconds = 9999;
  const draft = buildTierPageData(copy).tiers.find(tier => tier.id === 'draft');
  assert.equal(draft.crucible.runs, 2);
  assert.ok(draft.crucible.time.high < 9999);
});

test('input errors say what to pass instead', () => {
  assert.throws(() => buildTierPageData({}), /needs "cells", "scenes" and "conditions"/);
  assert.throws(() => buildTierPageData(matrix, { scene: 'nowhere' }), /pass one of lit-interior/);
  const noCard = structuredClone(matrix);
  delete noCard.conditions.card;
  assert.throws(() => buildTierPageData(noCard), /conditions\.card is missing/);
  const allContended = structuredClone(matrix);
  for (const cell of allContended.cells) if (cell.engine === 'cycles') cell.contended = true;
  assert.throws(() => buildTierPageData(allContended), /no usable run of cycles at 256 samples/);
});

test('the page rows come from the data: bars are shares of the larger figure and ranges print', () => {
  const draft = describeTier(committed, 'draft');
  const time = draft.rows.find(row => row.id === 'time');
  assert.equal(time.blender.share, 1);
  assert.ok(time.crucible.share > 0 && time.crucible.share < 0.05);
  assert.match(time.crucible.value, /^0\.95 ms$/);
  assert.match(time.crucible.range, /^0\.65 to 1\.12$/);
  const final = describeTier(committed, 'final');
  const error = final.rows.find(row => row.id === 'flip');
  assert.equal(error.crucible.share, 1, 'Cook native has the larger error at equal samples and the page must show it');
  assert.deepEqual(describeTier(committed, 'realtime-high'), { id: 'realtime-high', status: 'planned', issues: [901, 902], rows: [] });
  assert.throws(() => describeTier(committed, 'ultra'), /pass one of draft, realtime, realtime-high, final/);
});

test('the conditions line carries card, software, size and date', () => {
  const conditions = describeConditions(committed);
  assert.match(conditions.hardware, /RTX 3060/);
  assert.equal(conditions.size, '960 by 540');
  assert.equal(conditions.date, '2026-11-27');
  assert.match(conditions.software, /Blender 5\.3\.0, Node 24\.19\.0, win32/);
});

test('times keep about three significant figures', () => {
  const realtime = describeTier(committed, 'realtime').rows.find(row => row.id === 'time');
  assert.equal(realtime.blender.value, '315 ms');
  assert.equal(describeTier(committed, 'draft').rows.find(row => row.id === 'time').blender.value, '55.2 ms');
  assert.equal(describeTier(committed, 'final').rows.find(row => row.id === 'time').crucible.value, '1.19 s');
});

test('all six scenes and detailed tier breakdowns are exposed cleanly', () => {
  assert.deepEqual(committed.sceneOrder, matrix.scenes);
  assert.equal(Object.keys(committed.scenes).length, 6);
  const metalDraft = describeTierForScene(committed, 'draft', 'metal');
  assert.equal(metalDraft.rows.find(row => row.id === 'time').crucible.value, '0.64 ms');

  const draftOverview = describeTierOverview(committed, 'draft', 'lit-interior');
  assert.equal(draftOverview.summaryStats.length, 3);
  assert.ok(draftOverview.details.some(item => item.label === 'Queued back to back'));
  assert.ok(draftOverview.details.some(item => item.label === 'First frame cold start'));

  const finalOverview = describeTierOverview(committed, 'final', 'lit-interior');
  assert.ok(finalOverview.details.some(item => item.label === 'Per-sample render speed'));
  assert.ok(finalOverview.details.some(item => item.label.includes('Cook WebGPU')));
  assert.ok(finalOverview.details.some(item => item.label.includes('Time to Cycles 256-sample noise')));

  const breakdown = describeSceneBreakdown(committed, 'final');
  assert.equal(breakdown.length, 6);
  assert.equal(breakdown.find(entry => entry.scene === 'outdoor-hdri').extra, 'Bias floor at 1,024 spp');
});
