import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { planChecks } from '../scripts/preflight.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repositoryRoot, 'scripts/check-package-links.mjs');

function makePackage(shippedGuideText) {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-package-links-'));
  mkdirSync(join(folder, 'docs'));
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'demo', files: ['docs/shipped.md', 'docs/also-shipped.md'] }));
  writeFileSync(join(folder, 'docs/shipped.md'), shippedGuideText);
  writeFileSync(join(folder, 'docs/also-shipped.md'), 'Shipped too.\n');
  writeFileSync(join(folder, 'docs/unshipped.md'), 'Only on the site.\n');
  return folder;
}

function runCheck(folder) {
  return spawnSync(process.execPath, [scriptPath, folder], { encoding: 'utf8' });
}

test('a shipped doc that links to a guide that does not ship fails with the file, the line and the site URL fix', () => {
  const folder = makePackage('Intro.\nSee the [guide](unshipped.md).\n');
  try {
    const result = runCheck(folder);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /docs\/shipped\.md:2 links to unshipped\.md/);
    assert.match(result.stdout, /https:\/\/crucible\.codepawl\.com\/<guide>\.md/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('links to a shipped guide and to the site URL pass', () => {
  const folder = makePackage('See [one](also-shipped.md) and [two](https://crucible.codepawl.com/unshipped.md).\n');
  try {
    const result = runCheck(folder);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /0 links to files the package does not ship/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the real tree has no shipped doc that links to a guide that does not ship', () => {
  const result = runCheck(repositoryRoot);
  assert.equal(result.status, 0, result.stdout);
});

test('preflight runs the package link check for a doc change and skips it for source only', () => {
  const docChecks = planChecks(['docs/agent-scene.md']);
  assert.equal(docChecks.find(check => check.name === 'package links').skipped, null);
  const sourceChecks = planChecks(['src/camera.js']);
  assert.match(sourceChecks.find(check => check.name === 'package links').skipped, /no doc or package file list changed/);
});
