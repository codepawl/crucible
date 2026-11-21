import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, lstat, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sameFile } from '../scripts/file-identity.mjs';

test('a path stat and a handle stat of one file are the same file on this machine', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-file-identity-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'a.bin');
  await writeFile(path, 'abc');
  const handle = await open(path, 'r');
  try {
    assert.equal(sameFile(await lstat(path), await handle.stat()), true);
  } finally {
    await handle.close();
  }
});

test('Windows: an unreported path device still requires the same inode (Node 22.13.1)', () => {
  assert.equal(sameFile({ dev: 0, ino: 42 }, { dev: 2365167705, ino: 42 }, 'win32'), true);
});

test('a different inode is a different file on every platform', () => {
  assert.equal(sameFile({ dev: 0, ino: 42 }, { dev: 2365167705, ino: 43 }, 'win32'), false);
  assert.equal(sameFile({ dev: 7, ino: 42 }, { dev: 7, ino: 43 }, 'linux'), false);
});

test('two reported devices that differ are different files, Windows included', () => {
  assert.equal(sameFile({ dev: 1, ino: 42 }, { dev: 2, ino: 42 }, 'win32'), false);
  assert.equal(sameFile({ dev: 1, ino: 42 }, { dev: 2, ino: 42 }, 'linux'), false);
});

test('outside Windows a path dev of 0 still has to match', () => {
  assert.equal(sameFile({ dev: 0, ino: 42 }, { dev: 9, ino: 42 }, 'linux'), false);
  assert.equal(sameFile({ dev: 0, ino: 42 }, { dev: 9, ino: 42 }, 'darwin'), false);
});
