import { test } from 'node:test';
import assert from 'node:assert/strict';
import { largeFileGrowthWarnings } from '../scripts/check-large-file-growth.mjs';
import { planChecks } from '../scripts/preflight.mjs';

test('a file over 1500 lines that gains lines warns with the counts and the fix', () => {
  const [warning] = largeFileGrowthWarnings([{ path: 'src/studio.js', baseLines: 5268, headLines: 5300 }]);
  assert.match(warning, /^src\/studio\.js: 5268 lines at the base, 5300 now/);
  assert.match(warning, /own registered module instead of growing this file, see #3381/);
});

test('a big file that shrinks or stays the same is silent', () => {
  assert.deepEqual(largeFileGrowthWarnings([
    { path: 'src/studio.js', baseLines: 5268, headLines: 5200 },
    { path: 'src/renderer.js', baseLines: 3502, headLines: 3502 },
  ]), []);
});

test('a file at or under the limit is silent even when it grows past it later', () => {
  assert.deepEqual(largeFileGrowthWarnings([
    { path: 'src/small.js', baseLines: 200, headLines: 900 },
    { path: 'src/edge.js', baseLines: 1500, headLines: 1600 },
  ]), []);
});

test('a new file already over the limit warns, a new small file does not', () => {
  const warnings = largeFileGrowthWarnings([
    { path: 'src/huge-new.js', baseLines: null, headLines: 1800 },
    { path: 'src/small-new.js', baseLines: null, headLines: 100 },
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^src\/huge-new\.js: new file, 1800 now/);
});

test('only src/*.js files are checked', () => {
  assert.deepEqual(largeFileGrowthWarnings([
    { path: 'docs/big.md', baseLines: 5000, headLines: 5100 },
    { path: 'src/nested/big.js', baseLines: 5000, headLines: 5100 },
  ]), []);
});

test('preflight plans the check as a pass-through step that never fails', () => {
  const check = planChecks(['src/studio.js'], { skipTests: true, baseRef: 'origin/main' }).find(planned => planned.name === 'large file growth');
  assert.equal(check.skipped, null);
  assert.equal(check.failure, undefined);
  assert.deepEqual(check.command, ['node', 'scripts/check-large-file-growth.mjs', '--base', 'origin/main']);
  const skipped = planChecks(['docs/a.md'], { skipTests: true }).find(planned => planned.name === 'large file growth');
  assert.match(skipped.skipped, /no src\/\*\.js file changed/);
});
