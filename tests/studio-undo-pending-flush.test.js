import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { flushOrderOf } from '../src/depth-layer.js';
import { createStudioController } from '../src/studio.js';

// A threshold of one triangle makes every edit of this small scene count as heavy, so its search is deferred.
const HEAVY_OPTIONS = { deferFlushTriangles: 1 };

// A sign that lies flush on a wall, so the two must be ranked.
function flushRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'wall', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [10, 4, 0.2] },
      { id: 'sign', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [1, 0.5, 0.2] },
    ],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  };
}

function rankSummary(scene) {
  return scene.parts.map(part => [part.name, flushOrderOf(part)?.ranges.map(range => `${range.rank}:${range.start}:${range.count}`) ?? null]);
}

function mountHeavyScene() {
  const scene = createAgentScene(flushRecipe(), {}, HEAVY_OPTIONS);
  const controller = createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });
  return { scene, controller };
}

function settle(scene) {
  if (scene.flushPending) {
    scene.settleFlush();
  }
  assert.equal(scene.flushPending, false);
}

// Before undo edited the scene in place it threw the scene away, so a search in flight could never land on it.
test('an undo while the search of the add is pending leaves the ranks of the scene before the add', () => {
  const { scene, controller } = mountHeavyScene();
  const cold = createAgentScene(flushRecipe());
  controller.addPrimitive('box');
  assert.equal(scene.flushPending, true, 'the search of the add is still running');
  controller.undo();
  assert.equal(controller.scene, scene, 'the undo edited the same scene');
  settle(scene);
  assert.ok(rankSummary(scene).some(([, ranges]) => ranges !== null), 'the wall and the sign are ranked');
  assert.deepEqual(rankSummary(scene), rankSummary(cold));
  assert.deepEqual(scene.inspect().flush, cold.inspect().flush);
});

test('a redo while the search is pending leaves the ranks of the scene with the added box', () => {
  const { scene, controller } = mountHeavyScene();
  controller.addPrimitive('box');
  const afterAdd = controller.exportRecipe();
  controller.undo();
  controller.redo();
  assert.equal(controller.scene, scene, 'undo and redo edited the same scene');
  assert.deepEqual(controller.exportRecipe(), afterAdd);
  settle(scene);
  const cold = createAgentScene(afterAdd);
  assert.deepEqual(rankSummary(scene), rankSummary(cold));
  assert.deepEqual(scene.inspect().flush, cold.inspect().flush);
});
