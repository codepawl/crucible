import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudio } from '../src/studio.js';
import { createFakeRenderer, installStudioDom } from './support/studio-dom.mjs';

function recipe() {
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

// A threshold of one triangle makes every edit of this small scene count as heavy, so its search is deferred. The page is
// then left quiet: no timer and no frame is queued.
function mountQuietHeavyScene(testContext) {
  const dom = installStudioDom();
  const scene = createAgentScene(recipe(), {}, { deferFlushTriangles: 1 });
  const renderer = createFakeRenderer();
  const studio = createStudio(dom.container, { scene, renderer });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  settleQuietly(dom);
  assert.equal(dom.pendingTimerCount + dom.pendingAnimationFrameCount, 0, 'the idle Studio schedules nothing');
  return { dom, scene, renderer, studio };
}

// Runs timers and frames until nothing is queued, the way a page that has gone quiet would.
function settleQuietly(dom) {
  for (let round = 0; round < 50 && (dom.pendingTimerCount > 0 || dom.pendingAnimationFrameCount > 0); round++) {
    dom.runTimers();
    dom.runAnimationFrames(round * 16);
  }
}

test('a Studio asleep draws once when a deferred search settles, and schedules nothing after', testContext => {
  const { dom, scene, renderer, studio } = mountQuietHeavyScene(testContext);
  studio.controller.addPrimitive('box');
  assert.equal(scene.flushPending, true);
  dom.runAnimationFrames(1000);
  assert.equal(dom.pendingAnimationFrameCount, 0, 'the edit drew its frame');
  const framesBefore = renderer.frames.length;
  const topologyBefore = scene.topologyRevision;

  // The search may take several slices; the viewport is told only when the last one is done.
  for (let round = 0; round < 500 && scene.flushPending; round++) {
    dom.runTimers();
    if (scene.flushPending) assert.equal(dom.pendingAnimationFrameCount, 0, 'no frame while the search is waiting');
  }
  assert.equal(scene.flushPending, false, 'the search settled');
  for (let round = 0; round < 500 && dom.pendingAnimationFrameCount === 0; round++) dom.runTimers();
  assert.equal(scene.topologyRevision, topologyBefore + 1);
  assert.equal(dom.pendingAnimationFrameCount, 1, 'exactly one frame was asked for');
  dom.runAnimationFrames(2000);
  assert.equal(renderer.frames.length, framesBefore + 1, 'and drawn');
  assert.equal(dom.pendingAnimationFrameCount, 0);
  assert.equal(dom.pendingTimerCount, 0, 'no timer is left running');
});

test('a search still waiting when Studio is disposed leaves no timer and asks for no frame', testContext => {
  const { dom, scene, studio } = mountQuietHeavyScene(testContext);
  studio.controller.addPrimitive('box');
  assert.equal(scene.flushPending, true);
  dom.runAnimationFrames(1000);
  studio.dispose();
  // The scene finishes its own search after the Studio is gone; only the Studio's watching has to stop.
  for (let round = 0; round < 500 && (scene.flushPending || dom.pendingTimerCount > 0); round++) dom.runTimers();
  assert.equal(scene.flushPending, false);
  assert.equal(dom.pendingTimerCount, 0, 'no timer is left running');
  assert.equal(dom.pendingAnimationFrameCount, 0, 'a disposed Studio draws nothing');
});

test('loading another scene while a search waits stops watching the old one', testContext => {
  const { dom, scene, studio } = mountQuietHeavyScene(testContext);
  studio.controller.addPrimitive('box');
  assert.equal(scene.flushPending, true);
  studio.loadRecipe({ ...recipe(), nodes: [{ id: 'floor', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [4, 0.1, 4] }] });
  assert.notEqual(studio.controller.scene, scene, 'the recipe built a new scene');
  dom.runAnimationFrames(1000);
  dom.runTimers();
  assert.equal(dom.pendingAnimationFrameCount, 0, 'the old scene settling asks for no frame');
});
