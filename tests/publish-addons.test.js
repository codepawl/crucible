import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PUBLISHED_ADDONS, addonsToPublish } from '../scripts/publish-addons-ci.mjs';

const packages = {
  'packages/served/package.json': JSON.stringify({ name: '@scope/served', version: '1.0.0' }),
  'packages/new/package.json': JSON.stringify({ name: '@scope/new', version: '0.1.0' }),
};
const readText = async path => packages[path];

test('only an addon whose version the registry does not serve is published', async () => {
  const fetchImplementation = async url => ({ ok: url.includes('served'), status: url.includes('served') ? 200 : 404 });
  const pending = await addonsToPublish(['packages/served', 'packages/new'], { fetchImplementation, readText });
  assert.deepEqual(pending, [{ folder: 'packages/new', name: '@scope/new', version: '0.1.0' }]);
});

test('a registry error other than 404 stops the release instead of republishing', async () => {
  const fetchImplementation = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => addonsToPublish(['packages/new'], { fetchImplementation, readText }), /@scope\/new@0\.1\.0 failed: HTTP 503/);
});

test('denoise-oidn and three-bridge are folded into built-in addons instead of separate addon publishes', async () => {
  assert.deepEqual(PUBLISHED_ADDONS, []);
  const core = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(core.exports['./addons/denoise-oidn'], './build/denoise-oidn.js');
  assert.equal(core.exports['./addons/three-bridge'], './build/three-bridge.js');
  assert.equal(core.bin['crucible-oidn-fetch'], './bin/crucible-oidn-fetch.mjs');
});
