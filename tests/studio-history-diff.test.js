import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudioController } from '../src/studio.js';
import { operationsBetweenRecipes } from '../src/studio-history-diff.js';

const HISTORY_STEP = { allowRecordChanges: true };

function makeRecipe({ animated = false } = {}) {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'floor', type: 'box', bevel: 0 },
      { id: 'cube', type: 'box', bevel: 0.04 },
    ],
    materials: [
      { id: 'stone', tag: 'surface', color: [0.3, 0.32, 0.35], roughness: 0.8, metallic: 0 },
      { id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 },
    ],
    nodes: [
      { id: 'ground', geometry: 'floor', material: 'stone', translation: [0, -0.2, 0], scale: [10, 0.4, 10] },
      { id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] },
      { id: 'orb', geometry: 'cube', material: 'paint', translation: [2.2, 0.5, 0], scale: [0.5, 0.5, 0.5] },
    ],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
  if (animated) {
    recipe.motion = {
      duration: 2,
      loop: true,
      tracks: [{ kind: 'node', id: 'hero', property: 'translation', keyframes: [{ time: 0, value: [0, 0.5, 0] }, { time: 2, value: [0, 1.5, 0] }] }],
    };
  }
  return recipe;
}

function makeController({ animated = false } = {}) {
  const scene = createAgentScene(makeRecipe({ animated }));
  return createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });
}

const IN_PLACE_EDITS = {
  'a transform edit': controller => controller.updateNodeTransform('hero', { translation: [1, 2, 3] }),
  'a material edit': controller => controller.updateMaterial('paint', { roughness: 0.9, metallic: 0.5 }),
  'a look edit': controller => controller.updateLook({ environment: { keyIntensity: 2.5, environmentIntensity: 0.4 }, effects: { exposure: 1.25 } }),
  'a light edit': controller => {
    controller.addSceneLight('point');
    controller.selectSceneObject('point:0');
    controller.moveSceneObject('point:0', [1, 2, 3]);
  },
  'a keyframe insert': controller => {
    controller.setMotionTime(1);
    controller.insertNodeKeyframe('orb');
    controller.setMotionTime(1);
    controller.updateNodeTransform('hero', { translation: [1.5, 1.2, 0] });
    controller.insertNodeKeyframe('hero');
  },
};

for (const [name, edit] of Object.entries(IN_PLACE_EDITS)) {
  test(`undo and redo of ${name} restore the recipe without rebuilding the scene`, () => {
    const controller = makeController({ animated: name === 'a keyframe insert' });
    const sceneBefore = controller.scene;
    const snapshots = [controller.exportRecipe()];
    edit(controller);
    const edited = controller.exportRecipe();
    assert.notDeepEqual(edited, snapshots[0]);
    while (controller.canUndo) {
      controller.undo();
    }
    assert.deepEqual(controller.exportRecipe(), snapshots[0], 'full undo restores the first recipe');
    assert.equal(controller.scene, sceneBefore, 'undo applied operations in place');
    while (controller.canRedo) {
      controller.redo();
    }
    assert.deepEqual(controller.exportRecipe(), edited, 'full redo restores the edited recipe');
    assert.equal(controller.scene, sceneBefore, 'redo applied operations in place');
  });
}

test('an undo of an in-place edit keeps the same scene object', () => {
  const controller = makeController();
  const sceneBefore = controller.scene;
  const before = controller.exportRecipe();
  controller.updateNodeTransform('hero', { translation: [4, 0.5, 0] });
  controller.updateMaterial('paint', { roughness: 0.1 });
  controller.undo();
  assert.equal(controller.scene, sceneBefore);
  controller.undo();
  assert.equal(controller.scene, sceneBefore);
  assert.deepEqual(controller.exportRecipe(), before);
  controller.redo();
  controller.redo();
  assert.equal(controller.scene, sceneBefore);
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'hero').translation[0], 4);
});

test('redo of a lens change on a field-of-view camera runs in place, and its undo still restores the recipe', () => {
  const controller = makeController();
  const before = controller.exportRecipe();
  controller.setCameraLensMillimetres(85);
  const edited = controller.exportRecipe();
  assert.equal(edited.camera.focalLength, 85);
  assert.equal(Object.hasOwn(edited.camera, 'fov'), false);
  controller.undo();
  assert.deepEqual(controller.exportRecipe(), before, 'undo restores the field of view');
  const sceneAfterUndo = controller.scene;
  controller.redo();
  assert.deepEqual(controller.exportRecipe(), edited, 'redo restores the focal length');
  assert.equal(controller.scene, sceneAfterUndo, 'redo applied the camera in place');
});

test('undo and redo of add primitive keep the same scene object', () => {
  const controller = makeController();
  const sceneBefore = controller.scene;
  const before = controller.exportRecipe();
  controller.addPrimitive('torus');
  const afterAdd = controller.exportRecipe();
  controller.undo();
  assert.equal(controller.scene, sceneBefore, 'undo removed the parts in place');
  assert.deepEqual(controller.exportRecipe(), before);
  controller.redo();
  assert.equal(controller.scene, sceneBefore, 'redo added the parts in place');
  assert.deepEqual(controller.exportRecipe(), afterAdd);
});

test('undo and redo of duplicate keep the same scene object', () => {
  const controller = makeController();
  const sceneBefore = controller.scene;
  const before = controller.exportRecipe();
  controller.selectNode('hero');
  controller.duplicateSelected();
  const afterDuplicate = controller.exportRecipe();
  assert.equal(afterDuplicate.nodes.length, before.nodes.length + 1);
  controller.undo();
  assert.equal(controller.scene, sceneBefore);
  assert.deepEqual(controller.exportRecipe(), before);
  controller.redo();
  assert.equal(controller.scene, sceneBefore);
  assert.deepEqual(controller.exportRecipe(), afterDuplicate);
});

test('undo of deleting a middle node restores the recipe, redo removes it in place', () => {
  const controller = makeController();
  const before = controller.exportRecipe();
  controller.selectNode('hero');
  controller.deleteSelected();
  const afterDelete = controller.exportRecipe();
  assert.deepEqual(afterDelete.nodes.map(node => node.id), ['ground', 'orb']);
  controller.undo();
  assert.deepEqual(controller.exportRecipe(), before, 'a node back in the middle of the list is rebuilt');
  const sceneAfterUndo = controller.scene;
  controller.redo();
  assert.equal(controller.scene, sceneAfterUndo);
  assert.deepEqual(controller.exportRecipe(), afterDelete);
});

test('undo of add, duplicate and delete in a row still restores every recipe', () => {
  const controller = makeController();
  const before = controller.exportRecipe();
  controller.addPrimitive('torus');
  const afterAdd = controller.exportRecipe();
  controller.selectNode('hero');
  controller.duplicateSelected();
  const afterDuplicate = controller.exportRecipe();
  controller.selectNode('orb');
  controller.deleteSelected();
  controller.undo();
  assert.deepEqual(controller.exportRecipe(), afterDuplicate);
  controller.undo();
  assert.deepEqual(controller.exportRecipe(), afterAdd);
  controller.undo();
  assert.deepEqual(controller.exportRecipe(), before);
  controller.redo();
  controller.redo();
  controller.redo();
  assert.equal(controller.exportRecipe().nodes.some(node => node.id === 'orb'), false);
});

test('ten mixed edits undo and redo through the whole stack', () => {
  const controller = makeController();
  const states = [controller.exportRecipe()];
  const edits = [
    () => controller.updateNodeTransform('hero', { translation: [1, 0.5, 0] }),
    () => controller.updateMaterial('stone', { roughness: 0.2 }),
    () => controller.addPrimitive('sphere'),
    () => controller.updateLook({ environment: { viewTransform: 'agx' } }),
    () => controller.updateNodeTransform('orb', { translation: [0, 3, 0] }),
    () => controller.addSceneLight('point'),
    () => controller.updateMaterial('paint', { hexColor: '#3399ff' }),
    () => controller.insertNodeKeyframe('hero'),
    () => controller.updateLook({ effects: { exposure: 1.5 } }),
    () => controller.updateNodeTransform('hero', { scale: [2, 2, 2] }),
  ];
  for (const edit of edits) {
    edit();
    states.push(controller.exportRecipe());
  }
  for (let index = states.length - 2; index >= 0; index -= 1) {
    assert.equal(controller.undo(), true);
    assert.deepEqual(controller.exportRecipe(), states[index], `undo to state ${index}`);
  }
  for (let index = 1; index < states.length; index += 1) {
    assert.equal(controller.redo(), true);
    assert.deepEqual(controller.exportRecipe(), states[index], `redo to state ${index}`);
  }
});

test('operationsBetweenRecipes returns operations only for differences a scene operation can set', () => {
  const base = makeRecipe();
  assert.deepEqual(operationsBetweenRecipes(base, structuredClone(base)), []);
  const moved = structuredClone(base);
  moved.nodes[1].translation = [9, 9, 9];
  assert.deepEqual(operationsBetweenRecipes(base, moved), [{ type: 'set-node', id: 'hero', translation: [9, 9, 9] }]);

  const extraNode = structuredClone(base);
  extraNode.nodes.push({ id: 'extra', geometry: 'cube', material: 'paint' });
  assert.deepEqual(operationsBetweenRecipes(base, extraNode, HISTORY_STEP), [{ type: 'add-node', node: extraNode.nodes[3] }], 'a node added at the tail is an add');

  assert.equal(operationsBetweenRecipes(base, extraNode), null, 'loading a file with another set of nodes still builds a new scene');

  const insertedNode =structuredClone(base);
  insertedNode.nodes.splice(1, 0, { id: 'extra', geometry: 'cube', material: 'paint' });
  assert.equal(operationsBetweenRecipes(base, insertedNode, HISTORY_STEP), null, 'a node inserted in the middle needs a rebuild');

  const reordered = structuredClone(base);
  reordered.nodes.reverse();
  assert.equal(operationsBetweenRecipes(base, reordered, HISTORY_STEP), null, 'a reordered list needs a rebuild');

  const otherGeometry = structuredClone(base);
  otherGeometry.geometries[1].bevel = 0.2;
  assert.equal(operationsBetweenRecipes(base, otherGeometry), null, 'a changed geometry needs a rebuild');

  const removedField = structuredClone(base);
  delete removedField.nodes[2].scale;
  assert.equal(operationsBetweenRecipes(base, removedField), null, 'a field a patch cannot remove needs a rebuild');

  const withMotion = makeRecipe({ animated: true });
  assert.equal(operationsBetweenRecipes(withMotion, base), null, 'clearing a section needs a rebuild');
  const shorterMotion = structuredClone(withMotion);
  shorterMotion.motion.duration = 3;
  assert.deepEqual(operationsBetweenRecipes(withMotion, shorterMotion), [{ type: 'set-motion', motion: shorterMotion.motion }]);
});

test('operationsBetweenRecipes orders removals, patches and additions so the scene accepts them', () => {
  const base = makeRecipe();
  base.nodes.push({ id: 'child', parent: 'orb', geometry: 'cube', material: 'paint' });
  const target = makeRecipe();
  target.geometries.splice(1, 1);
  target.geometries.push({ id: 'ball', type: 'sphere' });
  target.materials.splice(1, 1);
  target.materials.push({ id: 'glass', tag: 'surface', color: [1, 1, 1], roughness: 0.1, metallic: 0 });
  target.nodes = [target.nodes[0], { id: 'globe', geometry: 'ball', material: 'glass' }];
  target.nodes[0].translation = [0, -1, 0];
  const operations = operationsBetweenRecipes(base, target, HISTORY_STEP);
  assert.deepEqual(operations.map(operation => operation.type), [
    'remove-node', 'remove-node', 'remove-node', 'remove-material', 'remove-geometry',
    'set-node', 'add-geometry', 'add-material', 'add-node',
  ]);
  assert.deepEqual(operations.slice(0, 3).map(operation => operation.id), ['child', 'hero', 'orb'], 'children go before their parents');
  const scene = createAgentScene(base);
  scene.apply(operations, { expectedRevision: scene.revision });
  assert.deepEqual(scene.exportRecipe().nodes.map(node => node.id), ['ground', 'globe']);
  assert.deepEqual(scene.exportRecipe().geometries.map(geometry => geometry.id), ['floor', 'ball']);
});

test('operationsBetweenRecipes adds geometry and material before the node that uses them', () => {
  const base = makeRecipe();
  const target = structuredClone(base);
  target.geometries.push({ id: 'ball', type: 'sphere' });
  target.materials.push({ id: 'glass', tag: 'surface', color: [1, 1, 1], roughness: 0.1, metallic: 0 });
  target.nodes.push({ id: 'globe', geometry: 'ball', material: 'glass' });
  const types = operationsBetweenRecipes(base, target, HISTORY_STEP).map(operation => operation.type);
  assert.deepEqual(types, ['add-geometry', 'add-material', 'add-node']);
});
