import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { meshBooleansLoaded, needsMeshBooleans, setManifoldModuleLoader } from '../src/agent-scene.js';
import { createStudio } from '../src/studio.js';
import { createFakeRenderer, installStudioDom } from './support/studio-dom.mjs';

// The load-all preload brings in the mesh code but not the Manifold binary, so a boolean edit is refused until
// Studio itself loads it. Each test file runs in its own process, so this file starts with the binary unloaded.
// The room is loaded without its light bake: the bake has nothing to do with the boolean edit, and under coverage on a
// slow machine it runs past its own time limit, which fails the load for a reason this file does not test.
const demoRoomRecipe = JSON.parse(readFileSync(new URL('./fixtures/demo-room.recipe.json', import.meta.url), 'utf8'));
delete demoRoomRecipe.bake;
const demoRoomText = JSON.stringify(demoRoomRecipe);
const demoRoomNodeCount = JSON.parse(demoRoomText).nodes.length;

function mountStudio(testContext, options = {}) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { ...options, createRenderer: () => createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  return { studio, dom };
}

function statusText(dom) {
  return dom.container.querySelector('.crucible-studio-status').textContent;
}

test('the fixture has a boolean edit and the binary is not loaded yet', () => {
  assert.equal(needsMeshBooleans(JSON.parse(demoRoomText)), true);
  assert.equal(meshBooleansLoaded(), false);
});

test('a boolean module that cannot load says so on screen and keeps the starting scene', async testContext => {
  setManifoldModuleLoader(() => Promise.reject(new Error('module not found')));
  testContext.after(() => setManifoldModuleLoader(() => import('manifold-3d')));
  const { studio, dom } = mountStudio(testContext, { recipe: JSON.parse(demoRoomText) });
  const nodeCountBefore = studio.exportRecipe().nodes.length;
  await assert.rejects(studio.ready, /manifold-3d/);
  assert.match(statusText(dom), /manifold-3d/);
  assert.equal(studio.exportRecipe().nodes.length, nodeCountBefore);
  assert.equal(meshBooleansLoaded(), false);
});

test('a recipe with a boolean edit opens through loadExternalTextFile', async testContext => {
  const { studio } = mountStudio(testContext);
  await studio.loadExternalTextFile(demoRoomText);
  assert.equal(meshBooleansLoaded(), true);
  assert.equal(studio.exportRecipe().nodes.length, demoRoomNodeCount);
});

test('a recipe with a boolean edit opens through openRecipe', async testContext => {
  const { studio } = mountStudio(testContext);
  await studio.openRecipe(JSON.parse(demoRoomText));
  assert.equal(studio.exportRecipe().nodes.length, demoRoomNodeCount);
});

test('a starting recipe with a boolean edit is on screen when ready settles', async testContext => {
  const { studio } = mountStudio(testContext, { recipe: JSON.parse(demoRoomText) });
  await studio.ready;
  assert.equal(studio.exportRecipe().nodes.length, demoRoomNodeCount);
});
