// Runs the unit tests that are cheap, so `npm run preflight -- --skip-tests` (the pre-push hook) still catches the
// cheap failures that otherwise cost a CI round: docs import paths, JSON examples in docs, change-note format.
// Which files are cheap comes from config/fast-tests.json, written by scripts/record-fast-tests.mjs (wall time per file, node start-up included).
// Usage: node scripts/fast-tests.mjs [--threshold-ms 500] [--budget-ms 120000]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importsFile } from './import-specifiers.mjs';
import { isMainModule, listTestFiles, repositoryRoot, runTestFiles } from './test-run.mjs';

export const DEFAULT_THRESHOLD_MS = 1000;
export const DEFAULT_BUDGET_MS = 120000;
export const FAST_TESTS_PATH = 'config/fast-tests.json';
// Guard tests always run, even when the recorded timings omit them or call them slow: a new src file missing from cook-addon.yml paths fails CI otherwise (#2938).
export const GUARD_TEST_PATTERN = /^tests\/addon-job-paths[^/]*\.test\.js$/;

// Picks the files recorded under `thresholdMs`, fastest first, until their recorded times add up to `budgetMs`.
// Files missing from `existingFiles` (renamed or deleted since the timings were recorded) are dropped.
export function selectFastTests(timings, existingFiles, { thresholdMs = DEFAULT_THRESHOLD_MS, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const existing = new Set(existingFiles);
  const candidates = Object.entries(timings)
    .filter(([file, milliseconds]) => existing.has(file) && milliseconds < thresholdMs)
    .sort(([firstFile, firstMs], [secondFile, secondMs]) => firstMs - secondMs || firstFile.localeCompare(secondFile));
  const files = [];
  let recordedMilliseconds = 0;
  for (const [file, milliseconds] of candidates) {
    if (recordedMilliseconds + milliseconds > budgetMs) break;
    files.push(file);
    recordedMilliseconds += milliseconds;
  }
  const guardFiles = existingFiles.filter(file => GUARD_TEST_PATTERN.test(file));
  return { files: [...new Set([...files, ...guardFiles])].sort(), recordedMilliseconds };
}

// The native Cook tests are recorded at 0 ms on CI, where they skip for lack of a GPU or the built addon, but they run for real here.
export function usesNativeAddon(sourceText, importerPath = 'tests/example.test.js') {
  return importsFile(sourceText, importerPath, 'tests/support/cook.js');
}

export function readFastTests(folder = repositoryRoot) {
  const path = join(folder, FAST_TESTS_PATH);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function numberAfter(arguments_, flag, fallback) {
  const index = arguments_.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(arguments_[index + 1]);
  if (!(value > 0)) throw new Error(`${flag} needs a positive number of milliseconds, for example ${flag} ${fallback}.`);
  return value;
}

function main(arguments_) {
  const timings = readFastTests();
  if (timings === null) {
    console.log(`Skipping the fast tests: ${FAST_TESTS_PATH} is missing. Make it with npm run record:fast-tests, or run npm test for the full pass.`);
    return;
  }
  const thresholdMs = numberAfter(arguments_, '--threshold-ms', DEFAULT_THRESHOLD_MS);
  const budgetMs = numberAfter(arguments_, '--budget-ms', DEFAULT_BUDGET_MS);
  const { files, recordedMilliseconds } = selectFastTests(timings, listTestFiles().filter(file => !usesNativeAddon(readFileSync(join(repositoryRoot, file), 'utf8'), file)), { thresholdMs, budgetMs });
  if (files.length === 0) {
    console.log(`No test file is recorded under ${thresholdMs} ms in ${FAST_TESTS_PATH}; nothing to run.`);
    return;
  }
  console.log(`Running ${files.length} fast test file(s), each recorded under ${thresholdMs} ms (${Math.round(recordedMilliseconds / 1000)} s of single-file time, budget ${Math.round(budgetMs / 1000)} s; they run side by side).`);
  const startedAt = Date.now();
  const { code } = runTestFiles(files);
  console.log(`Fast tests took ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);
  process.exit(code);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
