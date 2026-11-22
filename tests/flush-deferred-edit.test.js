import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { flushOrderOf } from '../src/depth-layer.js';
import { loadAllAgentSceneModules } from '../src/agent-scene-modules.js';

await loadAllAgentSceneModules();

// A threshold of one triangle makes every edit of this small scene count as heavy.
const HEAVY_OPTIONS = { deferFlushTriangles: 1 };

function recipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'wall', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [10, 4, 0.2] },
      { id: 'sign', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [1, 0.5, 0.2] },
    ],
  };
}

const addBadge = [{ type: 'add-node', node: { id: 'badge', geometry: 'box', material: 'paint', translation: [1, 0, 0], scale: [1, 0.5, 0.2] } }];

function rankSummary(scene) {
  return scene.parts.map(part => [part.name, flushOrderOf(part)?.ranges.map(range => `${range.rank}:${range.start}:${range.count}`) ?? null]);
}

// Waits for the search to finish on its own, slice after slice, instead of for a fixed time.
async function nextTurn(scene) {
  const deadline = Date.now() + 5000;
  while (scene.flushPending && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('a heavy edit returns with the search pending and the parts not yet ranked', () => {
  const scene = createAgentScene(recipe(), {}, HEAVY_OPTIONS);
  assert.equal(scene.flushPending, false, 'a new scene is ranked inside its constructor');
  assert.ok(flushOrderOf(scene.parts.find(part => part.name === 'sign')));
  scene.apply(addBadge, { expectedRevision: 0 });
  assert.equal(scene.flushPending, true);
  assert.equal(flushOrderOf(scene.parts.find(part => part.name === 'badge')), null, 'the new part is not ranked until the search runs');
});

test('the deferred search finishes on its own and equals the cold synchronous result', async () => {
  const scene = createAgentScene(recipe(), {}, HEAVY_OPTIONS);
  scene.apply(addBadge, { expectedRevision: 0 });
  const topologyPending = scene.topologyRevision;
  await nextTurn(scene);
  assert.equal(scene.flushPending, false);
  assert.equal(scene.topologyRevision, topologyPending + 1, 'the renderer is told to regroup the ranked parts');
  const cold = createAgentScene(recipe());
  cold.apply(addBadge, { expectedRevision: 0 });
  assert.equal(cold.flushPending, false, 'below the threshold an edit ranks inside the call');
  assert.deepEqual(rankSummary(scene), rankSummary(cold));
  assert.ok(rankSummary(scene).some(([, ranges]) => ranges !== null));
  assert.deepEqual(scene.inspect().flush, cold.inspect().flush);
});

test('settleFlush ranks a pending edit at once, so a render started right after an edit includes the offsets', () => {
  const scene = createAgentScene(recipe(), {}, HEAVY_OPTIONS);
  scene.apply(addBadge, { expectedRevision: 0 });
  assert.equal(scene.flushPending, true);
  assert.equal(scene.settleFlush(), true);
  assert.equal(scene.flushPending, false);
  assert.ok(flushOrderOf(scene.parts.find(part => part.name === 'badge')), 'the badge carries its rank');
  assert.equal(scene.settleFlush(), false, 'nothing is left to settle');
});

test('inspect settles a pending search before it reports what the ranking left over', () => {
  const scene = createAgentScene(recipe(), {}, HEAVY_OPTIONS);
  scene.apply(addBadge, { expectedRevision: 0 });
  const inspection = scene.inspect();
  assert.equal(scene.flushPending, false);
  assert.ok(inspection.flush.ranked > 0);
});

test('a second edit before the search runs replaces the pending one and ranks the newest parts', async () => {
  const scene = createAgentScene(recipe(), {}, HEAVY_OPTIONS);
  scene.apply(addBadge, { expectedRevision: 0 });
  const addSecond = [{ type: 'add-node', node: { id: 'second', geometry: 'box', material: 'paint', translation: [-1, 0, 0], scale: [1, 0.5, 0.2] } }];
  scene.apply(addSecond, { expectedRevision: 1 });
  await nextTurn(scene);
  assert.equal(scene.flushPending, false);
  const cold = createAgentScene(recipe());
  cold.apply(addBadge, { expectedRevision: 0 });
  cold.apply(addSecond, { expectedRevision: 1 });
  assert.deepEqual(rankSummary(scene), rankSummary(cold));
});
