import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { FAST_TESTS_PATH, GUARD_TEST_PATTERN, readFastTests, selectFastTests, usesNativeAddon } from '../scripts/fast-tests.mjs';
import { pickFastResults } from '../scripts/record-fast-tests.mjs';
import { planChecks } from '../scripts/preflight.mjs';

const existing = ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js', 'tests/slow.test.js'];
const timings = { 'tests/a.test.js': 100, 'tests/b.test.js': 400, 'tests/c.test.js': 50, 'tests/slow.test.js': 900, 'tests/gone.test.js': 10 };

test('only files recorded under the threshold are picked, and deleted files are dropped', () => {
  const { files, recordedMilliseconds } = selectFastTests(timings, existing, { thresholdMs: 500, budgetMs: 10000 });
  assert.deepEqual(files, ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js']);
  assert.equal(recordedMilliseconds, 550);
});

test('the addon job paths guard runs even when the recorded timings lack it or call it slow', () => {
  const withGuard = [...existing, 'tests/addon-job-paths.test.js'];
  assert.deepEqual(selectFastTests({}, withGuard).files, ['tests/addon-job-paths.test.js']);
  const slow = { ...timings, 'tests/addon-job-paths.test.js': 90000 };
  assert.ok(selectFastTests(slow, withGuard, { thresholdMs: 500, budgetMs: 10000 }).files.includes('tests/addon-job-paths.test.js'));
  assert.ok(!selectFastTests(timings, existing).files.includes('tests/addon-job-paths.test.js'));
  assert.equal(GUARD_TEST_PATTERN.test('tests/addon-job-paths.test.js'), true);
});

test('a file with no recorded time is not run', () => {
  const { files } = selectFastTests({}, existing);
  assert.deepEqual(files, []);
});

test('the budget keeps the fastest files and drops the rest', () => {
  const { files, recordedMilliseconds } = selectFastTests(timings, existing, { thresholdMs: 500, budgetMs: 200 });
  assert.deepEqual(files, ['tests/a.test.js', 'tests/c.test.js']);
  assert.equal(recordedMilliseconds, 150);
});

test('a test that loads the native Cook helper is recognised', () => {
  assert.equal(usesNativeAddon("import { x } from './support/cook.js';"), true);
  assert.equal(usesNativeAddon("const note = './support/cook.js';"), false);
  assert.equal(usesNativeAddon("import { x } from './support/scene.js';"), false);
});

test('preflight runs the fast tests only when the slow pass is skipped', () => {
  const skipped = planChecks(['docs/guide.md'], { skipTests: true }).find(check => check.name === 'fast tests');
  assert.equal(skipped.skipped, null);
  assert.deepEqual(skipped.command, ['node', 'scripts/fast-tests.mjs']);
  const full = planChecks(['docs/guide.md']).find(check => check.name === 'fast tests');
  assert.match(full.skipped, /full unit test pass/);
});

test('the recorder keeps only passing files under the limit, sorted', () => {
  const results = [
    { testFile: 'tests/b.test.js', passed: true, milliseconds: 300 },
    { testFile: 'tests/a.test.js', passed: true, milliseconds: 100 },
    { testFile: 'tests/red.test.js', passed: false, milliseconds: 50 },
    { testFile: 'tests/slow.test.js', passed: true, milliseconds: 700 },
  ];
  assert.deepEqual(pickFastResults(results, 600), { 'tests/a.test.js': 100, 'tests/b.test.js': 300 });
});

test('a missing list reads as null so preflight can skip with a hint', () => {
  assert.equal(readFastTests('/nonexistent-crucible-folder'), null);
});

test('the committed list only names test files that exist', () => {
  const listed = Object.keys(readFastTests());
  assert.ok(listed.length > 100, `${FAST_TESTS_PATH} lists ${listed.length} files; regenerate it with npm run record:fast-tests.`);
  const missing = listed.filter(file => !existsSync(file));
  assert.deepEqual(missing, [], `${FAST_TESTS_PATH} names deleted files; regenerate it with npm run record:fast-tests.`);
});
