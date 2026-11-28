import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createWatchIgnore } from '../scripts/vite-watch-ignore.mjs';

const checkoutRoot = path.resolve('/projects/crucible');
const worktreeRoot = path.join(checkoutRoot, '.claude', 'worktrees', 'lane');

test('the checkout server skips the agent worktrees inside it', () => {
  const ignore = createWatchIgnore(checkoutRoot);
  assert.equal(ignore(path.join(checkoutRoot, '.claude')), true);
  assert.equal(ignore(path.join(worktreeRoot, 'src', 'studio.js')), true);
  assert.equal(ignore(path.join(checkoutRoot, 'src', 'studio.js')), false);
});

test('a server started inside a worktree still watches its own files', () => {
  const ignore = createWatchIgnore(worktreeRoot);
  assert.equal(ignore(path.join(worktreeRoot, 'src', 'studio.js')), false);
  assert.equal(ignore(path.join(worktreeRoot, '.claude', 'worktrees', 'nested', 'src', 'studio.js')), true);
});

test('a folder that only starts with .claude is still watched', () => {
  const ignore = createWatchIgnore(checkoutRoot);
  assert.equal(ignore(path.join(checkoutRoot, '.claude-notes', 'todo.md')), false);
});
