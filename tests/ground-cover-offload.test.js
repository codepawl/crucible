import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { groundCoverParts, normalizeGroundCover } from '../src/ground-cover.js';
import { addGroundCoverToAsset, growGroundCover } from '../src/ground-cover-offload.js';
import { kernelStats, resetKernelStats } from '../src/kernel-offload.js';
import { createInProcessWorker, digestOf } from './support/kernel-offload-fixture.mjs';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const EYE = [0, 3, 8];

function squarePart(name, half, y) {
  const positions = new Float32Array([-half, y, -half, -half, y, half, half, y, half, half, y, -half]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return { name, geometry: { positions, indices }, matrix: IDENTITY, material: { name, tag: 'surface', color: [0.2, 0.3, 0.1] } };
}

// A lawn with a slab on it, so the mask skips blades and the standing triangles matter to the bytes.
const sceneParts = () => [squarePart('Lawn', 4, 0), squarePart('Slab', 1, 0.1)];
const entries = () => normalizeGroundCover([{ surfaces: 'Lawn', length: 0.12, density: 300, seed: 7 }]);

test('ground cover grown on a worker has the same bytes as the main-thread build', async () => {
  resetKernelStats();
  const requested = [];
  const onMainThread = groundCoverParts(sceneParts(), entries(), EYE);
  const onWorker = await growGroundCover(sceneParts(), entries(), EYE, { createWorker: () => createInProcessWorker(requested), available: true });
  assert.ok(onMainThread.length > 0, 'the lawn grows blades');
  assert.deepEqual(requested, ['groundCover']);
  assert.equal(kernelStats().worker, 1);
  assert.equal(onWorker.length, onMainThread.length);
  assert.equal(digestOf(onWorker), digestOf(onMainThread));
});

test('a host without workers builds the same bytes inline', async () => {
  const requested = [];
  const inline = await growGroundCover(sceneParts(), entries(), EYE, { createWorker: () => createInProcessWorker(requested), available: false });
  assert.deepEqual(requested, []);
  assert.equal(digestOf(inline), digestOf(groundCoverParts(sceneParts(), entries(), EYE)));
});

test('a surface name that matches nothing raises the same error from the worker', async () => {
  const missing = normalizeGroundCover([{ surfaces: 'Nowhere' }]);
  await assert.rejects(
    growGroundCover(sceneParts(), missing, EYE, { createWorker: () => createInProcessWorker([]), available: true }),
    { name: 'TypeError', message: /environment\.groundCover\[0\]\.surfaces/ },
  );
});

test('the scene file adds its ground cover through the kernel, and an empty list adds nothing', async () => {
  const requested = [];
  const asset = { parts: sceneParts() };
  await addGroundCoverToAsset(asset, [{ surfaces: 'Lawn', length: 0.12, density: 300, seed: 7 }], EYE, { createWorker: () => createInProcessWorker(requested), available: true });
  assert.deepEqual(requested, ['groundCover']);
  assert.equal(digestOf(asset.parts.slice(2)), digestOf(groundCoverParts(sceneParts(), entries(), EYE)));
  const bare = { parts: sceneParts() };
  await addGroundCoverToAsset(bare, [], EYE, { createWorker: () => createInProcessWorker(requested), available: true });
  assert.equal(bare.parts.length, 2);
});

// src/file-scene.js is a page script that starts on import and needs WebGL, so a test cannot run it here. This pins its one
// wiring: it hands the field to addGroundCoverToAsset and never calls the inline grower itself.
test('src/file-scene.js grows ground cover through ground-cover-offload.js, not the inline grower', () => {
  const source = readFileSync(new URL('../src/file-scene.js', import.meta.url), 'utf8');
  assert.ok(source.includes("import('./ground-cover-offload.js')"));
  assert.match(source, /await addGroundCoverToAsset\(/);
  assert.doesNotMatch(source, /groundCoverParts/);
});
