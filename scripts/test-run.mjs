// Shared by the agent test commands (test:affected, test:fast, test:mutation-check): list test files and run a set of
// them with the compact reporter on stdout and the full TAP in artifacts/test-logs/.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArguments } from './test-concurrency.mjs';

export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const reporterUrl = new URL('./test-compact-reporter.mjs', import.meta.url).href;
const hangGuardUrl = new URL('./test-hang-guard.mjs', import.meta.url).href;

export function listTestFiles(folder = repositoryRoot) {
  return readdirSync(join(folder, 'tests'))
    .filter(name => name.endsWith('.test.js'))
    .sort()
    .map(name => `tests/${name}`);
}

function timestampForFileName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Runs the files in one node process. Returns the exit code, the failures the reporter recorded and the TAP log path.
export function runTestFiles(testFiles, { folder = repositoryRoot, quiet = false } = {}) {
  if (testFiles.length === 0) throw new Error('No test files to run. Pass at least one tests/<name>.test.js.');
  const logFolder = join(folder, 'artifacts', 'test-logs');
  mkdirSync(logFolder, { recursive: true });
  const stamp = timestampForFileName();
  const logPath = join(logFolder, `${stamp}.tap`);
  const failuresPath = join(logFolder, `${stamp}.failures.json`);
  const result = spawnSync(process.execPath, [
    '--test', ...testConcurrencyArguments([]), '--import', hangGuardUrl, '--test-timeout=300000',
    `--test-reporter=${reporterUrl}`, '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${logPath}`,
    ...testFiles,
  ], {
    cwd: folder,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...withoutTestContext(process.env), CRUCIBLE_TEST_LOG: logPath, CRUCIBLE_TEST_FAILURES_JSON: failuresPath },
  });
  if (!quiet) process.stdout.write(result.stdout ?? '');
  if (result.stderr) process.stderr.write(result.stderr);
  let failures = [];
  if (existsSync(failuresPath)) {
    failures = JSON.parse(readFileSync(failuresPath, 'utf8'));
    rmSync(failuresPath);
  }
  return { code: result.status ?? 1, failures, logPath };
}

export function isMainModule(moduleUrl) {
  return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === moduleUrl;
}

// node:test sets NODE_TEST_CONTEXT in a test process; a child that inherits it skips its files instead of running them.
function withoutTestContext(environment) {
  const { NODE_TEST_CONTEXT, ...rest } = environment;
  return rest;
}
