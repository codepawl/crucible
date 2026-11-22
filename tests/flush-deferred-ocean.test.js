import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { flushOrderOf } from '../src/depth-layer.js';

// A threshold of one triangle makes every edit of this small scene count as heavy.
const HEAVY_OPTIONS = { deferFlushTriangles: 1 };
const OCEAN = { op: 'ocean', coverage: 1, seed: 3, windSpeed: 4, size: 2, resolution: 4 };

// Two flush boxes that must be ranked, and a sea whose waves move with an oceanTime track.
function seaRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'box', type: 'box', bevel: 0 },
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'subdivide', levels: 3 }, OCEAN] },
    ],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }, { id: 'water', color: [0.1, 0.3, 0.5] }],
    nodes: [
      { id: 'wall', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [10, 4, 0.2] },
      { id: 'sign', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [1, 0.5, 0.2] },
      { id: 'surface', geometry: 'sea', material: 'water', translation: [0, -5, 0] },
    ],
    camera: { eye: [30, 20, 30], target: [0, 0, 0] },
    motion: {
      duration: 4,
      tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 8 }] }],
    },
  };
}

const addBadge = [{ type: 'add-node', node: { id: 'badge', geometry: 'box', material: 'paint', translation: [1, 0, 0], scale: [1, 0.5, 0.2] } }];

function rankSummary(scene) {
  return scene.parts.map(part => [part.name, flushOrderOf(part)?.ranges.map(range => `${range.rank}:${range.start}:${range.count}`) ?? null]);
}

function seaPositions(scene) {
  return Array.from(scene.parts.find(part => part.name === 'surface').geometry.positions);
}

async function waitForSearch(scene) {
  const deadline = Date.now() + 5000;
  while (scene.flushPending && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function coldScene() {
  const cold = createAgentScene(seaRecipe());
  cold.apply(addBadge, { expectedRevision: 0 });
  return cold;
}

test('an edit of a scene with a moving sea returns with the search of the still parts pending', () => {
  const scene = createAgentScene(seaRecipe(), {}, HEAVY_OPTIONS);
  assert.equal(scene.flushPending, false, 'a new scene is ranked inside its constructor');
  scene.apply(addBadge, { expectedRevision: 0 });
  assert.equal(scene.flushPending, true);
  assert.equal(flushOrderOf(scene.parts.find(part => part.name === 'badge')), null, 'the new part is not ranked until the search runs');
  assert.equal(coldScene().flushPending, false, 'below the threshold the same edit ranks inside the call');
});

test('the settled scene with a moving sea equals the cold result, at rest and at another sea time', async () => {
  const scene = createAgentScene(seaRecipe(), {}, HEAVY_OPTIONS);
  scene.apply(addBadge, { expectedRevision: 0 });
  await waitForSearch(scene);
  assert.equal(scene.flushPending, false);
  const cold = coldScene();
  assert.deepEqual(rankSummary(scene), rankSummary(cold));
  assert.ok(rankSummary(scene).some(([, ranges]) => ranges !== null));
  scene.sampleMotion(2);
  cold.sampleMotion(2);
  assert.notDeepEqual(seaPositions(scene), seaPositions(coldScene()), 'the sea moved to another oceanTime');
  assert.deepEqual(seaPositions(scene), seaPositions(cold));
  assert.deepEqual(rankSummary(scene), rankSummary(cold));
  assert.deepEqual(scene.inspect().flush, cold.inspect().flush);
});

test('a frame sampled while the search is pending is ranked once it settles', () => {
  const scene = createAgentScene(seaRecipe(), {}, HEAVY_OPTIONS);
  scene.apply(addBadge, { expectedRevision: 0 });
  scene.sampleMotion(3);
  assert.equal(scene.flushPending, true, 'seeking does not wait for the search');
  assert.equal(scene.settleFlush(), true);
  const cold = coldScene();
  cold.sampleMotion(3);
  assert.deepEqual(seaPositions(scene), seaPositions(cold));
  assert.deepEqual(rankSummary(scene), rankSummary(cold));
});

test('settleFlush right after an edit of a scene with a moving sea gives every offset', () => {
  const scene = createAgentScene(seaRecipe(), {}, HEAVY_OPTIONS);
  scene.apply(addBadge, { expectedRevision: 0 });
  assert.equal(scene.settleFlush(), true);
  assert.equal(scene.flushPending, false);
  assert.ok(flushOrderOf(scene.parts.find(part => part.name === 'badge')), 'the badge carries its rank');
  assert.equal(flushOrderOf(scene.parts.find(part => part.name === 'surface')), null, 'the moving sea is never ranked');
  assert.deepEqual(rankSummary(scene), rankSummary(coldScene()));
});
