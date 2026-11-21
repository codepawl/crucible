import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScratchDirectory } from '../scripts/scratch-directory.mjs';

const helperUrl = pathToFileURL(join(import.meta.dirname, '..', 'scripts', 'scratch-directory.mjs')).href;

function runScript(sandbox, body, extraEnvironment = {}) {
  const source = `import { createScratchDirectory } from '${helperUrl}';\n${body}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env, TMPDIR: sandbox, TEMP: sandbox, TMP: sandbox, ...extraEnvironment },
  });
}

function makeSandbox(t) {
  const sandbox = mkdtempSync(join(tmpdir(), 'scratch-directory-sandbox-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  return sandbox;
}

test('createScratchDirectory makes a folder under the temp folder that starts with the prefix', async (t) => {
  const sandbox = makeSandbox(t);
  const directory = await createScratchDirectory('crucible-unit-', sandbox);
  assert.ok(directory.startsWith(join(sandbox, 'crucible-unit-')));
  assert.ok(existsSync(directory));
});

test('createScratchDirectory refuses an empty prefix and says what to pass', async () => {
  await assert.rejects(createScratchDirectory(''), /needs a prefix such as "crucible-smoke-"/);
});

test('a script that ends normally leaves no scratch folder', (t) => {
  const sandbox = makeSandbox(t);
  const result = runScript(sandbox, "const dir = await createScratchDirectory('crucible-a-'); console.log(dir);");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(sandbox), []);
});

test('a script that ends through process.exit or an error leaves no scratch folder', (t) => {
  const sandbox = makeSandbox(t);
  const exited = runScript(sandbox, "await createScratchDirectory('crucible-b-'); process.exit(3);");
  assert.equal(exited.status, 3);
  const thrown = runScript(sandbox, "await createScratchDirectory('crucible-c-'); throw new Error('boom');");
  assert.notEqual(thrown.status, 0);
  assert.deepEqual(readdirSync(sandbox), []);
});

test('CRUCIBLE_KEEP_TEMP=1 keeps the folder and prints where it is', (t) => {
  const sandbox = makeSandbox(t);
  const result = runScript(sandbox, "await createScratchDirectory('crucible-d-');", { CRUCIBLE_KEEP_TEMP: '1' });
  assert.equal(readdirSync(sandbox).length, 1);
  assert.match(result.stderr, /Scratch folder kept: /);
});
