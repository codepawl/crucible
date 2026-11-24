import assert from 'node:assert/strict';
import test from 'node:test';
import { smoothMaskTexels } from '../src/material-mask-smooth.js';

const MAP = 1024;

function coveredPatch(firstColumn, lastColumn, firstRow, lastRow) {
  const covered = new Uint8Array(MAP * MAP);
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) covered[row * MAP + column] = 1;
  }
  return covered;
}

function fillPatch(texels, covered, valueAt) {
  for (let index = 0; index < texels.length; index++) {
    if (covered[index]) texels[index] = valueAt(index % MAP, Math.floor(index / MAP));
  }
}

test('a sawtooth along a row is rounded by the smoothing', () => {
  const covered = coveredPatch(100, 163, 100, 163);
  const texels = new Uint8Array(MAP * MAP);
  fillPatch(texels, covered, column => (column % 4 < 2 ? 100 : 130));
  smoothMaskTexels(texels, covered, MAP);
  let low = 255;
  let high = 0;
  for (let column = 120; column < 140; column++) {
    low = Math.min(low, texels[130 * MAP + column]);
    high = Math.max(high, texels[130 * MAP + column]);
  }
  assert.ok(high - low < 15, `the sawtooth still swings ${high - low} of the original 30`);
});

test('a jump the mesh means stays hard and uncovered texels stay untouched', () => {
  const covered = coveredPatch(100, 163, 100, 163);
  const texels = new Uint8Array(MAP * MAP);
  texels.fill(77);
  fillPatch(texels, covered, column => (column < 132 ? 10 : 250));
  smoothMaskTexels(texels, covered, MAP);
  assert.ok(texels[130 * MAP + 128] <= 14, `the low side moved to ${texels[130 * MAP + 128]}`);
  assert.ok(texels[130 * MAP + 135] >= 246, `the high side moved to ${texels[130 * MAP + 135]}`);
  assert.equal(texels[130 * MAP + 99], 77, 'a texel outside the covered patch was written');
});

test('a texel on a steep face is never lightened by the smoothing, and the result is deterministic', () => {
  const covered = coveredPatch(100, 163, 100, 163);
  const steepFaces = new Uint8Array(MAP * MAP);
  const first = new Uint8Array(MAP * MAP);
  fillPatch(first, covered, (column, row) => (column === 130 && row === 130 ? 210 : 120));
  steepFaces[130 * MAP + 130] = 1;
  const second = Uint8Array.from(first);
  smoothMaskTexels(first, covered, MAP, steepFaces);
  smoothMaskTexels(second, covered, MAP, steepFaces);
  assert.ok(first[130 * MAP + 130] >= 210, `the steep texel dropped to ${first[130 * MAP + 130]}`);
  assert.deepEqual(first, second);
});

test('two islands one empty column apart pull each other less than a tenth of their difference', () => {
  const covered = coveredPatch(100, 131, 100, 131);
  const second = coveredPatch(133, 164, 100, 131);
  for (let index = 0; index < covered.length; index++) covered[index] |= second[index];
  const texels = new Uint8Array(MAP * MAP);
  fillPatch(texels, covered, column => (column < 132 ? 40 : 230));
  smoothMaskTexels(texels, covered, MAP);
  assert.ok(texels[120 * MAP + 131] <= 56, `the left island edge moved to ${texels[120 * MAP + 131]}`);
  assert.ok(texels[120 * MAP + 133] >= 214, `the right island edge moved to ${texels[120 * MAP + 133]}`);
});
