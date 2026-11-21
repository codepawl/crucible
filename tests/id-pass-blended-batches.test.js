import test from 'node:test';
import assert from 'node:assert/strict';

import { CrucibleRenderer } from '../src/renderer.js';

// A renderer stand-in that borrows the real batch rules: they read only the batch and `drawsInOpaqueLoop`.
const rules = Object.create(CrucibleRenderer.prototype);

function batchOf(alphaMode, extra = {}) {
  return { alphaMode, alphaCutoff: 0.5, parts: [{ name: alphaMode }], ...extra };
}

test('a blended batch takes object IDs, so a matte of its material is not black (#2846)', () => {
  assert.equal(rules.takesObjectIds(batchOf('opaque')), true);
  assert.equal(rules.takesObjectIds(batchOf('mask')), true);
  assert.equal(rules.takesObjectIds(batchOf('blend')), true);
});

test('additive batches and batches of the other draw passes still take no object ID', () => {
  assert.equal(rules.takesObjectIds(batchOf('add')), false);
  assert.equal(rules.takesObjectIds(batchOf('blend', { pass: 'water' })), false);
});

test('the opaque loop itself still skips blended batches', () => {
  assert.equal(rules.drawsInOpaqueLoop(batchOf('blend')), false);
});

test('an ID pass draws a blended batch as a cutout so its see-through texels hide nothing', () => {
  const drawn = rules.idPassBatch(batchOf('blend', { alphaCutoff: 0 }));
  assert.equal(drawn.alphaMode, 'mask');
  assert.equal(drawn.alphaCutoff, 0.5);
  const opaque = batchOf('opaque');
  assert.equal(rules.idPassBatch(opaque), opaque);
});
