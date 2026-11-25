import assert from 'node:assert/strict';
import test from 'node:test';
import { CANDIDATES, formatTable, medianOf, parseArguments, runBench } from '../bench/cpu-hot-spots.mjs';

test('every candidate reports a finite time at tiny sizes, sorted slowest first', async () => {
  const report = await runBench({ runs: 1, tiny: true, only: null });
  assert.equal(report.rows.length, CANDIDATES.length);
  for (const row of report.rows) {
    assert.ok(Number.isFinite(row.medianMs) && row.medianMs >= 0, `${row.id} has no time`);
    assert.ok(row.minMs <= row.medianMs && row.medianMs <= row.maxMs, `${row.id} has an inconsistent range`);
  }
  const times = report.rows.map(row => row.medianMs);
  assert.deepEqual(times, [...times].sort((first, second) => second - first));
  assert.match(formatTable(report), /\| 1 \| .* \| \d+\.\d \|/);
});

test('--only runs the named candidates and refuses an unknown one with the list', async () => {
  const report = await runBench({ runs: 1, tiny: true, only: ['bvh-build'] });
  assert.deepEqual(report.rows.map(row => row.id), ['bvh-build']);
  await assert.rejects(runBench({ runs: 1, tiny: true, only: ['nope'] }), /Unknown candidate nope\. Use one of .*bvh-build/);
});

test('arguments are bounded and the median handles even and odd counts', () => {
  assert.equal(parseArguments([]).runs, 5);
  assert.equal(parseArguments(['--runs', '3', '--tiny']).tiny, true);
  assert.throws(() => parseArguments(['--runs', '0']), /whole number from 1 to 50/);
  assert.throws(() => parseArguments(['--runs', '51']), /whole number from 1 to 50/);
  assert.throws(() => parseArguments(['--fast']), /Unknown option --fast/);
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([4, 1, 2, 3]), 2.5);
});
