import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { FAST_TESTS_PATH, GUARD_TEST_PATTERN, readFastTests, selectFastTests, usesNativeAddon } from '../scripts/fast-tests.mjs';
import { createBrowserDetector } from '../scripts/browser-tests.mjs';
import * as recorder from '../scripts/record-fast-tests.mjs';

const { pickFastResults } = recorder;
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

test('a file that finishes fast only because its tests skipped is not recorded as fast', () => {
  const results = [
    { testFile: 'tests/real.test.js', passed: true, skipped: false, milliseconds: 100 },
    { testFile: 'tests/skipped.test.js', passed: true, skipped: true, milliseconds: 217 },
  ];
  assert.deepEqual(pickFastResults(results, 600), { 'tests/real.test.js': 100 });
  assert.equal(recorder.countSkippedTests(['# tests 1', '# pass 0', '# skipped 1', '# todo 0'].join('\n')), 1);
  assert.equal(recorder.countSkippedTests(['# tests 3', '# pass 3', '# skipped 0'].join('\n')), 0);
  assert.equal(recorder.countSkippedTests(''), 0);
});

test('a file the full pass times as slow is not run as fast, even when the recorded list says it is fast', () => {
  const fullPassTimings = { 'tests/b.test.js': 99586, 'tests/a.test.js': 120 };
  const { files } = selectFastTests(timings, existing, { thresholdMs: 500, budgetMs: 10000, fullPassTimings });
  assert.deepEqual(files, ['tests/a.test.js', 'tests/c.test.js']);
});

test('the committed fast list names no file the full pass times as slow', () => {
  const fullPassTimings = JSON.parse(readFileSync('config/test-timings.json', 'utf8'));
  const slowListed = Object.keys(readFastTests()).filter(file => (fullPassTimings[file] ?? 0) >= 5000);
  assert.deepEqual(slowListed, [], `${FAST_TESTS_PATH} lists files that take 5000 ms or more where they run; regenerate it with npm run record:fast-tests.`);
});

const sourcesByPath = {
  'tests/plain.test.js': "import assert from 'node:assert/strict';\nimport { helper } from './support/plain-helper.js';",
  'tests/support/plain-helper.js': 'export const helper = 1;',
  'tests/direct-browser.test.js': "const { chromium } = await import('playwright');",
  'tests/through-helper.test.js': "import { open } from './support/browser-helper.js';",
  'tests/support/browser-helper.js': "import { launchPage } from '../../scripts/page-launcher.mjs';",
  'scripts/page-launcher.mjs': "export const args = ['--headless=new'];",
  'tests/spawns-script.test.js': "const smoke = new URL('../scripts/smoke-thing.mjs', import.meta.url);",
  'scripts/smoke-thing.mjs': "const executablePath = process.env.CHROME_PATH;",
  'tests/mentions-only.test.js': "const note = 'path tracing and render jobs are only named here';",
};
const readFixtureSource = path => sourcesByPath[path] ?? null;
const fixtureFiles = Object.keys(sourcesByPath).filter(file => file.endsWith('.test.js'));
const fixtureTimings = Object.fromEntries(fixtureFiles.map(file => [file, 200]));

test('a test that imports a browser helper, names a browser script or launches playwright is not a fast test', () => {
  const { files, browserTests } = selectFastTests(fixtureTimings, fixtureFiles, { readSource: readFixtureSource });
  assert.deepEqual(files, ['tests/mentions-only.test.js', 'tests/plain.test.js']);
  assert.deepEqual(browserTests.map(entry => entry.file).sort(), ['tests/direct-browser.test.js', 'tests/spawns-script.test.js', 'tests/through-helper.test.js']);
});

test('the reason names the browser launcher and the import chain that leads to it', () => {
  const { browserTests } = selectFastTests(fixtureTimings, fixtureFiles, { readSource: readFixtureSource });
  const reason = browserTests.find(entry => entry.file === 'tests/through-helper.test.js').reason;
  assert.match(reason, /starts Chrome/);
  assert.match(reason, /tests\/through-helper\.test\.js -> tests\/support\/browser-helper\.js -> scripts\/page-launcher\.mjs/);
});

test('a browser word that only appears in a comment does not make a test a browser test', () => {
  const sources = {
    'tests/line-comment.test.js': "// playwright is not used here\nconst answer = 1; // chromium and --headless are only named\n",
    'tests/block-comment.test.js': "/*\n * Starts no browser: puppeteer, crucible-mcp.mjs and CHROME_PATH are only mentioned.\n */\nconst answer = 2;",
    'tests/string-with-slashes.test.js': "const address = 'https://example.test/a'; const { chromium } = await import('playwright');",
    'tests/real-import.test.js': "// note\nimport { chromium } from 'playwright';",
  };
  const browserReason = createBrowserDetector(path => sources[path] ?? null);
  assert.equal(browserReason('tests/line-comment.test.js'), null);
  assert.equal(browserReason('tests/block-comment.test.js'), null);
  assert.match(browserReason('tests/string-with-slashes.test.js'), /launches a browser through playwright/);
  assert.match(browserReason('tests/real-import.test.js'), /launches a browser through playwright/);
});

test('a regular expression with slashes is not read as a comment, so a real launch after it is still found', () => {
  const sources = {
    'tests/escaped-slashes.test.js': "const r = /a\\/\\/b/; import { chromium } from 'playwright';",
    'tests/url-pattern.test.js': "const pattern = /https?:\\/\\//; const page = await import('playwright');",
    'tests/class-slashes.test.js': "const pattern = /[//]/;\nimport { chromium } from 'playwright';",
    'tests/division.test.js': "const half = total / 2; // playwright is not used\n",
    'tests/regex-after-paren.test.js': "if (ready) /a\\/\\//.test(url); import('playwright');",
  };
  const browserReason = createBrowserDetector(path => sources[path] ?? null);
  assert.match(browserReason('tests/escaped-slashes.test.js'), /launches a browser through playwright/);
  assert.match(browserReason('tests/url-pattern.test.js'), /launches a browser through playwright/);
  assert.match(browserReason('tests/class-slashes.test.js'), /launches a browser through playwright/);
  assert.equal(browserReason('tests/division.test.js'), null);
  assert.match(browserReason('tests/regex-after-paren.test.js'), /launches a browser through playwright/);
});

test('without a source reader nothing is dropped, so the browser check is opt in per caller', () => {
  assert.deepEqual(selectFastTests(fixtureTimings, fixtureFiles).files, [...fixtureFiles].sort());
});

test('the committed fast list names no file that starts a browser', () => {
  const listed = readFastTests();
  const existingFiles = Object.keys(listed).filter(file => existsSync(file));
  const { browserTests } = selectFastTests(listed, existingFiles, { thresholdMs: Infinity, budgetMs: Infinity, readSource: path => (existsSync(path) ? readFileSync(path, 'utf8') : null) });
  const message = browserTests.map(entry => `${entry.file} ${entry.reason}`).join('\n');
  assert.deepEqual(browserTests, [], `${FAST_TESTS_PATH} lists tests that start a browser; remove them or run npm run record:fast-tests:\n${message}`);
});
