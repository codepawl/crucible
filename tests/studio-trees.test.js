import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudio, createStudioController } from '../src/studio.js';
import {
  changeSelectedTree,
  nextTreeSeed,
  singleTreeOf,
  treeControlValues,
} from '../src/studio-trees.js';
import { byLabel, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

function recipeWithTree(presetName, nodeId) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    nodes: [{ id: nodeId, label: nodeId, translation: [2, 0, -1], vegetation: { preset: presetName, seed: 1 } }],
    camera: { eye: [0, 6, 22], target: [0, 5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 200 },
  };
}

function mountController(presetName, nodeId) {
  const scene = createAgentScene(recipeWithTree(presetName, nodeId));
  return createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });
}

function treeNodeOf(controller, nodeId) {
  return controller.exportRecipe().nodes.find(node => node.id === nodeId);
}

test('the add menu offers no ready-made tree, and a recipe that holds one still opens, selects and moves it (#3260)', testContext => {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: recipeWithTree('oak', 'old-oak'), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  root.querySelector('.crucible-studio-viewport').box = VIEWPORT_BOX;
  studio.renderNow();

  const addMenuButtons = root.querySelectorAll('#crucible-studio-pop-add button').map(button => button.textContent);
  assert.ok(addMenuButtons.length > 0, 'the add menu still lists its shapes and lights');
  assert.ok(!addMenuButtons.some(text => /tree/i.test(text)), `the add menu has no tree entry, it lists ${addMenuButtons.join(', ')}`);
  assert.equal(root.querySelectorAll('.crucible-studio-tree-picker').length, 0, 'no tree flyout is built');

  const row = root.querySelectorAll('.crucible-studio-tree-row')
    .find(candidate => candidate.dataset.sceneObject === undefined && candidate.textContent.includes('old-oak'));
  assert.ok(row, 'the Scene list shows the tree node of the recipe');
  row.querySelector('.crucible-studio-tree-select').click();
  assert.equal(studio.controller.selectedNodeId, 'old-oak');

  const positionX = byLabel(root, 'Position X');
  positionX.value = '5.5';
  dispatch(positionX, 'change');
  const moved = studio.exportRecipe().nodes.find(node => node.id === 'old-oak');
  assert.deepEqual(moved.translation, [5.5, 0, -1]);
  assert.equal(moved.vegetation.preset, 'oak', 'the tree keeps its vegetation field');
  assert.doesNotThrow(() => createAgentScene(studio.exportRecipe()));
});

test('a tree loaded from a recipe has bounds, so frame and the selection outline can find it', () => {
  const controller = mountController('oak', 'oak-1');
  const bounds = controller.nodeBounds('oak-1');
  assert.ok(bounds, 'the tree node reports bounds');
  assert.ok(bounds.size[1] > 3, 'the bounds cover the whole crown, not a trunk stub');
});

test('height, season, leaf density and seed write the vegetation field, and undo and redo restore it', () => {
  const controller = mountController('birch', 'birch-1');
  const id = 'birch-1';
  const planted = treeNodeOf(controller, id).vegetation;
  changeSelectedTree(controller, id, { height: 14.5 });
  changeSelectedTree(controller, id, { season: 0.6 });
  changeSelectedTree(controller, id, { seed: 4242 });
  changeSelectedTree(controller, id, { leafDensity: 9 });
  const tuned = treeNodeOf(controller, id).vegetation;
  assert.equal(tuned.preset, 'birch');
  assert.equal(tuned.height, 14.5);
  assert.equal(tuned.season, 0.6);
  assert.equal(tuned.seed, 4242);
  assert.equal(tuned.tree.leafCount, 9);
  assert.deepEqual(treeControlValues(tuned), { height: 14.5, season: 0.6, leafDensity: 9, seed: 4242 });

  for (let step = 0; step < 4; step += 1) {
    assert.equal(controller.undo(), true);
  }
  assert.deepEqual(treeNodeOf(controller, id).vegetation, planted);
  for (let step = 0; step < 4; step += 1) {
    assert.equal(controller.redo(), true);
  }
  assert.deepEqual(treeNodeOf(controller, id).vegetation, tuned);
});

test('a slider drag inside an undo group is one undo step', () => {
  const controller = mountController('ash', 'ash-1');
  const id = 'ash-1';
  const planted = treeNodeOf(controller, id).vegetation;
  controller.beginUndoGroup();
  for (const height of [11, 12, 13, 14]) {
    changeSelectedTree(controller, id, { height });
  }
  controller.endUndoGroup();
  assert.equal(controller.undo(), true);
  assert.deepEqual(treeNodeOf(controller, id).vegetation, planted);
});

test('the recipe saved from Studio loads identically through the agent scene path', () => {
  const controller = mountController('pine', 'pine-1');
  changeSelectedTree(controller, 'pine-1', { height: 15, season: 0.35, seed: 77, leafDensity: 4 });
  const saved = JSON.parse(JSON.stringify(controller.exportRecipe()));
  const reloaded = createAgentScene(saved).exportRecipe();
  assert.deepEqual(reloaded, saved);
  assert.deepEqual(createAgentScene(reloaded).exportRecipe(), saved);
});

test('a node that is not a single tree gets no tree controls and refuses a tree edit', () => {
  const controller = mountController('oak', 'oak-1');
  assert.equal(singleTreeOf({ id: 'forest', vegetation: { mix: { broadleaf: 1 }, scatter: { ground: 'hills' } } }), null);
  assert.equal(singleTreeOf({ id: 'plain' }), null);
  assert.throws(() => changeSelectedTree(controller, 'missing', { seed: 2 }), /does not grow a single tree/);
});

test('a new seed differs from the current one and stays a whole number', () => {
  assert.equal(nextTreeSeed(5, () => 0), 1);
  const draws = [0, 0.5];
  assert.equal(nextTreeSeed(1, () => draws.shift()), 50001);
  const seed = nextTreeSeed(10);
  assert.ok(Number.isInteger(seed) && seed !== 10);
});
