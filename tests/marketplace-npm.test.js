import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addonPackages, firstPartyPackages, npmManifestPath } from '../src/marketplace-npm.js';

test('a plain or scoped npm name becomes its registry manifest path', () => {
  assert.equal(npmManifestPath('hover-controller'), 'hover-controller/latest');
  assert.equal(npmManifestPath('@studio/crucible-hover'), '@studio%2Fcrucible-hover/latest');
});

test('a name that npm would not publish is refused instead of reaching the request', () => {
  for (const name of ['../../-/user', '@a/b/c', 'a/b', 'UPPER', 'a?x=1', 'a#b', '', ' a', 'a'.repeat(215), null, 42]) {
    assert.equal(npmManifestPath(name), null, `refuses ${String(name).slice(0, 20)}`);
  }
});

test('only published @codepawlhq/crucible- companion packages are listed, sorted, without addons or the engine', () => {
  const objects = [
    { package: { name: '@codepawlhq/crucible-three-bridge', version: '0.1.0', description: 'three.js bridge', keywords: ['three'] } },
    { package: { name: '@codepawlhq/crucible', version: '0.21.0', description: 'the engine' } },
    { package: { name: '@codepawlhq/crucible-denoise-oidn', version: '0.2.0' } },
    { package: { name: '@codepawlhq/crucible-hover', version: '1.0.0', keywords: ['crucible-addon'] } },
    { package: { name: '@someone/crucible-denoise', version: '1.0.0' } },
    { package: { name: '@codepawlhq/crucible-../x', version: '1.0.0' } },
    { package: null },
    {},
  ];
  assert.deepEqual(firstPartyPackages(objects), [
    { name: '@codepawlhq/crucible-denoise-oidn', version: '0.2.0', description: '' },
    { name: '@codepawlhq/crucible-three-bridge', version: '0.1.0', description: 'three.js bridge' },
  ]);
});

test('one malformed addon entry is skipped without hiding the rest of the list', () => {
  const objects = [
    { package: { name: 'hover-controller', version: '1.0.0' } },
    { package: null },
    { package: { name: '../bad', version: '2.0.0' } },
    { package: { name: '@studio/crucible-hover', version: '2.0.0', description: 'A hover addon' } },
  ];
  assert.deepEqual(addonPackages(objects), [
    { name: 'hover-controller', version: '1.0.0', description: '', range: null },
    { name: '@studio/crucible-hover', version: '2.0.0', description: 'A hover addon', range: null },
  ]);
});

test('a search result that is not a list gives no packages', () => {
  for (const value of [undefined, null, {}, 'x']) assert.deepEqual(firstPartyPackages(value), []);
});

test('public/_headers CSP connect-src allows registry.npmjs.org for live Marketplace package queries', () => {
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const csp = headers.match(/Content-Security-Policy:\s*(.+)/)?.[1] ?? '';
  const connectSrc = csp.match(/connect-src\s+([^;]+)/)?.[1] ?? '';
  assert.ok(connectSrc.includes('https://registry.npmjs.org'), 'connect-src must include https://registry.npmjs.org');
});
