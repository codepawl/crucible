import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';

import { TranslucentOrder } from '../src/translucent-order.js';

const STRIDE = 42;

function batchOfPanes(depthsAlongZ) {
  const instanceData = new Float32Array(depthsAlongZ.length * STRIDE);
  depthsAlongZ.forEach((z, index) => {
    const matrix = mat4.create();
    mat4.translate(matrix, matrix, [0, 0, z]);
    instanceData.set(matrix, index * STRIDE);
  });
  return { instanceData, instanceCount: depthsAlongZ.length, sortCenter: [0, 0, 0] };
}

// Which pane, by its z, each run draws, in drawing order.
function drawnZ(order, batches, runs) {
  const drawn = [];
  for (let run = 0; run < runs; run++) {
    for (let slot = 0; slot < order.runCounts[run]; slot++) {
      drawn.push(order.gathered[(order.runStarts[run] + slot) * STRIDE + 14]);
    }
  }
  return drawn;
}

function viewFrom(eye) {
  return mat4.lookAt(mat4.create(), eye, [0, 0, 0], [0, 1, 0]);
}

test('a stack of panes draws far to near from the front and from the back (#3236)', () => {
  const batches = [batchOfPanes([0, 1, 2, 3])];
  const order = new TranslucentOrder(STRIDE);
  assert.deepEqual(drawnZ(order, batches, order.sort(batches, viewFrom([0, 0, 10]))), [0, 1, 2, 3]);
  assert.deepEqual(drawnZ(order, batches, order.sort(batches, viewFrom([0, 0, -10]))), [3, 2, 1, 0]);
});

test('panes of different batches interleave by depth instead of drawing batch by batch', () => {
  const red = batchOfPanes([0, 2]);
  const blue = batchOfPanes([1, 3]);
  const order = new TranslucentOrder(STRIDE);
  const runs = order.sort([red, blue], viewFrom([0, 0, 10]));
  assert.equal(runs, 4);
  assert.deepEqual(Array.from(order.runBatches.subarray(0, runs)), [0, 1, 0, 1]);
  assert.deepEqual(drawnZ(order, [red, blue], runs), [0, 1, 2, 3]);
});

test('a batch whose panes are all together stays one run', () => {
  const batches = [batchOfPanes([0, 1, 2]), batchOfPanes([5, 6])];
  const order = new TranslucentOrder(STRIDE);
  assert.equal(order.sort(batches, viewFrom([0, 0, 10])), 2);
});

test('equal depth keeps the given order, frame after frame', () => {
  const first = batchOfPanes([1, 1]);
  const second = batchOfPanes([1]);
  first.instanceData[0] = 1;
  first.instanceData[STRIDE] = 2;
  second.instanceData[0] = 3;
  const order = new TranslucentOrder(STRIDE);
  for (let frame = 0; frame < 3; frame++) {
    const runs = order.sort([first, second], viewFrom([0, 0, 10]));
    assert.equal(runs, 1 + 1);
    assert.deepEqual([order.gathered[0], order.gathered[STRIDE], order.gathered[2 * STRIDE]], [1, 2, 3]);
  }
});

test('the sort uses the centre of the bounds, not the origin of the part', () => {
  const offset = batchOfPanes([0]);
  offset.sortCenter = [0, 0, 5];
  const origin = batchOfPanes([2]);
  const order = new TranslucentOrder(STRIDE);
  const runs = order.sort([offset, origin], viewFrom([0, 0, 10]));
  assert.deepEqual(Array.from(order.runBatches.subarray(0, runs)), [1, 0]);
});

test('sorting reuses its arrays once they are large enough', () => {
  const batches = [batchOfPanes(Array.from({ length: 64 }, (unused, index) => index))];
  const order = new TranslucentOrder(STRIDE);
  order.sort(batches, viewFrom([0, 0, 100]));
  const held = [order.depths, order.order, order.gathered];
  order.sort(batches, viewFrom([0, 0, -100]));
  assert.deepEqual([order.depths, order.order, order.gathered], held);
});
