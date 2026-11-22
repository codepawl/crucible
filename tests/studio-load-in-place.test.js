import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudioController } from '../src/studio.js';
import { sameRecipeValue } from '../src/studio-history-diff.js';

// Written the way a file or an agent writes it: no defaults, so it is not the recipe the scene exports.
function fileRecipe(heroX) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }],
    materials: [{ id: 'paint', color: [0.8, 0.25, 0.2] }],
    nodes: [
      { id: 'ground', geometry: 'cube', material: 'paint', scale: [10, 0.4, 10] },
      { id: 'hero', geometry: 'cube', material: 'paint', translation: [heroX, 0.5, 0] },
    ],
  };
}

function controllerOn(recipe) {
  return createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
}

test('loading a file that only turns one node keeps the scene and the parts of the other nodes', () => {
  const controller = controllerOn(fileRecipe(0));
  const sceneBefore = controller.scene;
  const groundBefore = sceneBefore.parts.find(part => part.name === 'ground');
  controller.loadRecipe(fileRecipe(3));
  assert.equal(controller.scene, sceneBefore, 'the difference was applied to the scene already built');
  assert.equal(controller.scene.parts.find(part => part.name === 'ground'), groundBefore);
  assert.deepEqual(controller.exportRecipe().nodes.find(node => node.id === 'hero').translation, [3, 0.5, 0]);
  assert.ok(sameRecipeValue(controller.exportRecipe(), createAgentScene(fileRecipe(3)).exportRecipe()), 'the scene holds what a fresh build of the file holds');
  assert.equal(controller.canUndo, true);
  controller.undo();
  assert.deepEqual(controller.exportRecipe().nodes.find(node => node.id === 'hero').translation, [0, 0.5, 0]);
});

test('an in-place apply that throws leaves the built scene on screen, never a half-applied one', () => {
  const guarded = Object.create(createAgentScene(fileRecipe(0)), {
    apply: { value: () => { throw new RangeError('simulated failure inside apply'); } },
  });
  const guardedController = createStudioController({ scene: guarded, viewportWidth: 800, viewportHeight: 600 });
  guardedController.loadRecipe(fileRecipe(3));
  assert.notEqual(guardedController.scene, guarded, 'the built scene replaced it');
  assert.deepEqual(guardedController.exportRecipe().nodes.find(node => node.id === 'hero').translation, [3, 0.5, 0]);
  assert.ok(sameRecipeValue(guardedController.exportRecipe(), createAgentScene(fileRecipe(3)).exportRecipe()));
});

test('loading a file with another set of nodes builds a new scene', () => {
  const controller = controllerOn(fileRecipe(0));
  const sceneBefore = controller.scene;
  const bigger = fileRecipe(0);
  bigger.nodes.push({ id: 'extra', geometry: 'cube', material: 'paint', translation: [5, 0.5, 0] });
  controller.loadRecipe(bigger);
  assert.notEqual(controller.scene, sceneBefore);
  assert.deepEqual(controller.exportRecipe().nodes.map(node => node.id), ['ground', 'hero', 'extra']);
});
