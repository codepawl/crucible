import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PRIVATE_TEMP_PREFIX,
  privateTempFolderName,
  removePrivateTempFolder,
  usePrivateTempFolder,
} from '../scripts/test-private-temp.mjs';

const repositoryRoot = join(import.meta.dirname, '..');
const guardPath = join(repositoryRoot, 'scripts', 'test-hang-guard.mjs');
const leakyFixturePath = join(repositoryRoot, 'tests', 'fixtures', 'leaky-temp-test-file.js');

function makeSandbox(t) {
  const sandbox = mkdtempSync(join(tmpdir(), 'private-temp-sandbox-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  return sandbox;
}

function runLeakyFixture(sandbox, extraEnvironment = {}) {
  // The runner this test runs in marks its environment; a nested runner must not think it is already inside one.
  const { NODE_TEST_CONTEXT: _outerRunner, TMPDIR: _tmpdir, TEMP: _temp, TMP: _tmp, ...baseEnvironment } = process.env;
  const result = spawnSync(
    process.execPath,
    ['--test', '--import', pathToFileURL(guardPath).href, leakyFixturePath],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      env: { ...baseEnvironment, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox, ...extraEnvironment },
    },
  );
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

test('the folder name carries the process id so a sweep only touches what this process made', () => {
  assert.equal(privateTempFolderName(1234, 99), `${PRIVATE_TEMP_PREFIX}1234-99`);
});

test('usePrivateTempFolder points all three temp variables at one new folder and removePrivateTempFolder deletes it', (t) => {
  const sandbox = makeSandbox(t);
  const environment = {};
  const folder = usePrivateTempFolder(environment, sandbox, 42, 7);
  assert.equal(dirname(folder), sandbox);
  assert.equal(basename(folder), privateTempFolderName(42, 7));
  assert.deepEqual([environment.TMPDIR, environment.TEMP, environment.TMP], [folder, folder, folder]);
  writeFileSync(join(folder, 'inner.txt'), 'x');
  removePrivateTempFolder(folder);
  assert.equal(existsSync(folder), false);
  removePrivateTempFolder(folder);
});

test('a test file that never removes its scratch folders leaves nothing in the temp folder, pass or fail', (t) => {
  const sandbox = makeSandbox(t);
  const result = runLeakyFixture(sandbox);
  assert.match(result.output, /LEAKY_FOLDER=/, result.output);
  assert.notEqual(result.status, 0, 'the fixture has a failing test, so the file must still report failure');
  assert.deepEqual(readdirSync(sandbox), [], `the file left folders behind in ${sandbox}`);
});

test('a child process the file starts uses the same private temp folder', (t) => {
  const sandbox = makeSandbox(t);
  const result = runLeakyFixture(sandbox);
  const reported = /CHILD_TMPDIR=(.+)/.exec(result.output)?.[1]?.trim();
  assert.ok(reported, result.output);
  assert.equal(dirname(reported), sandbox);
  assert.ok(basename(reported).startsWith(PRIVATE_TEMP_PREFIX));
});

test('CRUCIBLE_KEEP_TEST_TEMP=1 keeps the folder so a person can read what a test wrote', (t) => {
  const sandbox = makeSandbox(t);
  runLeakyFixture(sandbox, { CRUCIBLE_KEEP_TEST_TEMP: '1' });
  const kept = readdirSync(sandbox);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].startsWith(PRIVATE_TEMP_PREFIX));
});
