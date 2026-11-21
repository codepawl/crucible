// A test file that makes scratch folders and never removes them, run by tests/test-private-temp.test.js (its name has no .test.js, so `node --test` never picks it up).
// The first test passes and the second fails on purpose: the private temp folder must be removed either way.
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('a passing test that leaves a scratch folder behind', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'leaky-fixture-'));
  await writeFile(join(folder, 'data.bin'), Buffer.alloc(1024, 1));
  console.log(`LEAKY_FOLDER=${folder}`);
});

test('a failing test that leaves a scratch folder behind', async () => {
  await mkdtemp(join(tmpdir(), 'leaky-fixture-'));
  // A child process started by the file sees the same private temp folder.
  const childFolder = spawnSync(process.execPath, ['-e', 'console.log(require("node:os").tmpdir())'], { encoding: 'utf8', windowsHide: true });
  console.log(`CHILD_TMPDIR=${childFolder.stdout.trim()}`);
  throw new Error('failing on purpose');
});
