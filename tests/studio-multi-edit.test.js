import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const LEFT_CUBE = [-2.2, 0.5, 0];
const MIDDLE_CUBE = [0, 0.5, 0];
const RIGHT_CUBE = [2.2, 0.5, 0];

function makeRecipe() {
  return {
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
      { id: 'left', geometry: 'cube', material: 'paint', translation: LEFT_CUBE },
      { id: 'middle', geometry: 'cube', material: 'paint', translation: MIDDLE_CUBE },
      { id: 'right', geometry: 'cube', material: 'paint', translation: RIGHT_CUBE },
    ],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

function mountStudio(testContext) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: makeRecipe(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const viewport = dom.container.firstElementChild.querySelector('.crucible-studio-viewport');
  viewport.box = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
  studio.renderNow();
  const canvas = viewport.querySelector('canvas');
  const controller = studio.controller;
  const click = (worldPoint, modifiers = {}) => {
    const point = controller.projectWorldPoint(worldPoint);
    const position = { clientX: point.x + 40, clientY: point.y + 30 };
    dispatch(canvas, 'pointerdown', { ...position, ...modifiers });
    dispatch(canvas, 'pointerup', { ...position, ...modifiers });
  };
  const pressKey = (key, properties = {}) => dispatch(dom.document, 'keydown', { key, ...properties });
  return { studio, controller, click, pressKey };
}

function pickThree(ui) {
  ui.click(LEFT_CUBE);
  ui.click(MIDDLE_CUBE, { shiftKey: true });
  ui.click(RIGHT_CUBE, { shiftKey: true });
  assert.deepEqual(ui.controller.selectedNodeIds, ['left', 'middle', 'right']);
  assert.equal(ui.controller.selectedNodeId, 'right');
}

function nodeIds(controller) {
  return controller.exportRecipe().nodes.map(node => node.id);
}

function translationOf(controller, nodeId) {
  return controller.exportRecipe().nodes.find(node => node.id === nodeId).translation;
}

test('Shift+click picks three objects and Delete removes all three, one undo brings them back', testContext => {
  const ui = mountStudio(testContext);
  pickThree(ui);
  ui.pressKey('Delete');
  assert.deepEqual(nodeIds(ui.controller), ['ground']);
  assert.deepEqual(ui.controller.selectedNodeIds, []);
  ui.controller.undo();
  assert.deepEqual(nodeIds(ui.controller), ['ground', 'left', 'middle', 'right'], 'one undo restores all three');
  assert.deepEqual(ui.controller.selectedNodeIds, ['left', 'middle', 'right']);
  ui.controller.redo();
  assert.deepEqual(nodeIds(ui.controller), ['ground'], 'one redo removes all three again');
});

test('Duplicate copies every selected object, selects the copies with the copy of the active one active, and one undo removes them', testContext => {
  const ui = mountStudio(testContext);
  pickThree(ui);
  ui.pressKey('D', { shiftKey: true });
  assert.deepEqual(nodeIds(ui.controller), ['ground', 'left', 'middle', 'right', 'left-copy-1', 'middle-copy-1', 'right-copy-1']);
  assert.deepEqual(ui.controller.selectedNodeIds, ['left-copy-1', 'middle-copy-1', 'right-copy-1']);
  assert.equal(ui.controller.selectedNodeId, 'right-copy-1', 'the copy of the active object is active');
  ui.controller.undo();
  assert.deepEqual(nodeIds(ui.controller), ['ground', 'left', 'middle', 'right'], 'one undo removes all three copies');
  ui.controller.redo();
  assert.deepEqual(nodeIds(ui.controller), ['ground', 'left', 'middle', 'right', 'left-copy-1', 'middle-copy-1', 'right-copy-1'], 'one redo brings all three copies back');
});

test('the active object need not be the last picked one for its copy to be active', () => {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: makeRecipe(), renderer: createFakeRenderer() });
  try {
    studio.controller.selectNodes(['left', 'middle', 'right'], { active: 'left' });
    const activeCopy = studio.controller.duplicateSelected();
    assert.equal(activeCopy.id, 'left-copy-1');
    assert.equal(studio.controller.selectedNodeId, 'left-copy-1');
  } finally {
    studio.dispose();
    dom.uninstall();
  }
});

test('a gizmo drag moves all three picked objects together and one undo returns them', testContext => {
  const ui = mountStudio(testContext);
  const { controller } = ui;
  pickThree(ui);
  controller.setTool('translate');
  const handles = controller.gizmoHandles();
  const grab = controller.projectWorldPoint([handles.pivot[0] + handles.handleLength, handles.pivot[1], handles.pivot[2]]);
  const release = controller.projectWorldPoint([handles.pivot[0] + handles.handleLength + 1, handles.pivot[1], handles.pivot[2]]);
  controller.beginGizmoDrag('x', grab.x, grab.y);
  controller.updateGizmoDrag(release.x, release.y);
  assert.equal(controller.endGizmoDrag(), true);
  for (const [nodeId, start] of [['left', LEFT_CUBE], ['middle', MIDDLE_CUBE], ['right', RIGHT_CUBE]]) {
    const moved = translationOf(controller, nodeId);
    assert.ok(Math.abs(moved[0] - start[0] - 1) < 0.02, `${nodeId} moved about 1 m along x, got ${moved[0] - start[0]}`);
    assert.equal(moved[1], start[1]);
    assert.equal(moved[2], start[2]);
  }
  controller.undo();
  for (const [nodeId, start] of [['left', LEFT_CUBE], ['middle', MIDDLE_CUBE], ['right', RIGHT_CUBE]]) {
    assert.deepEqual(translationOf(controller, nodeId), start, `${nodeId} is back after one undo`);
  }
  controller.redo();
  for (const nodeId of ['left', 'middle', 'right']) {
    assert.ok(Math.abs(translationOf(controller, nodeId)[0] - { left: -2.2, middle: 0, right: 2.2 }[nodeId] - 1) < 0.02, `${nodeId} is moved again after one redo`);
  }
});

test('cancelling a grouped drag puts every picked object back and adds no undo step', testContext => {
  const ui = mountStudio(testContext);
  const { controller } = ui;
  pickThree(ui);
  controller.setTool('translate');
  const handles = controller.gizmoHandles();
  const grab = controller.projectWorldPoint([handles.pivot[0] + handles.handleLength, handles.pivot[1], handles.pivot[2]]);
  const release = controller.projectWorldPoint([handles.pivot[0] + handles.handleLength + 1, handles.pivot[1], handles.pivot[2]]);
  controller.beginGizmoDrag('x', grab.x, grab.y);
  controller.updateGizmoDrag(release.x, release.y);
  controller.cancelGizmoDrag();
  assert.deepEqual(translationOf(controller, 'left'), LEFT_CUBE);
  assert.deepEqual(translationOf(controller, 'middle'), MIDDLE_CUBE);
  assert.deepEqual(translationOf(controller, 'right'), RIGHT_CUBE);
  assert.equal(controller.canUndo, false);
});

function makeFamilyController() {
  const recipe = makeRecipe();
  recipe.nodes.push(
    { id: 'parent', geometry: 'cube', material: 'paint', translation: [0, 3, 0] },
    { id: 'child-a', geometry: 'cube', material: 'paint', parent: 'parent', translation: [-1, 0, 0] },
    { id: 'child-b', geometry: 'cube', material: 'paint', parent: 'parent', translation: [1, 0, 0] },
  );
  return createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
}

function worldX(controller, nodeId) {
  const parent = controller.exportRecipe().nodes.find(node => node.id === nodeId).parent;
  return translationOf(controller, nodeId)[0] + (parent ? translationOf(controller, parent)[0] : 0);
}

test('with a parent and two of its children picked and a child active, the drag moves all three by the same amount', () => {
  const controller = makeFamilyController();
  controller.selectNodes(['parent', 'child-a', 'child-b'], { active: 'child-a' });
  controller.setTool('translate');
  const handles = controller.gizmoHandles();
  const grab = controller.projectWorldPoint([handles.pivot[0] + handles.handleLength, handles.pivot[1], handles.pivot[2]]);
  const release = controller.projectWorldPoint([handles.pivot[0] + handles.handleLength + 1, handles.pivot[1], handles.pivot[2]]);
  controller.beginGizmoDrag('x', grab.x, grab.y);
  controller.updateGizmoDrag(release.x, release.y);
  controller.endGizmoDrag();
  assert.ok(Math.abs(worldX(controller, 'parent') - 1) < 0.02, `the parent moved 1 m, got ${worldX(controller, 'parent')}`);
  assert.ok(Math.abs(worldX(controller, 'child-a') - 0) < 0.02, 'child-a moved 1 m once, not twice');
  assert.ok(Math.abs(worldX(controller, 'child-b') - 2) < 0.02, 'child-b moved 1 m once, not twice');
  assert.deepEqual(translationOf(controller, 'child-a'), [-1, 0, 0], 'a child keeps its place relative to its parent');
  controller.undo();
  assert.deepEqual(translationOf(controller, 'parent'), [0, 3, 0], 'one undo puts the parent back');
  assert.deepEqual(translationOf(controller, 'child-b'), [1, 0, 0]);
});

test('Duplicate puts the copy of a child under the copy of its parent, in the same place relative to it', () => {
  const controller = makeFamilyController();
  controller.selectNodes(['parent', 'child-a'], { active: 'child-a' });
  const activeCopy = controller.duplicateSelected();
  const nodes = controller.exportRecipe().nodes;
  const parentCopy = nodes.find(node => node.id === 'parent-copy-1');
  const childCopy = nodes.find(node => node.id === 'child-a-copy-1');
  assert.equal(activeCopy.id, 'child-a-copy-1');
  assert.equal(childCopy.parent, 'parent-copy-1', 'the child copy hangs from the parent copy, not the original parent');
  assert.deepEqual(childCopy.translation, [-1, 0, 0]);
  assert.deepEqual(parentCopy.translation, [0.45, 3, 0.45]);
  controller.undo();
  assert.equal(controller.exportRecipe().nodes.length, 7, 'one undo removes both copies');
  controller.redo();
  assert.equal(controller.exportRecipe().nodes.length, 9, 'one redo brings both back');
});

function nodeOf(controller, nodeId) {
  return controller.exportRecipe().nodes.find(node => node.id === nodeId);
}

function assertNearVector(actual, expected, tolerance = 0.01, message = '') {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= tolerance, `${message} [${index}]: expected ${expected[index]}, got ${value}`);
  });
}

test('Rotate turns and orbits every selected root around the active pivot as one undo step', testContext => {
  const ui = mountStudio(testContext);
  const { controller } = ui;
  pickThree(ui);
  controller.setTool('rotate');
  const handles = controller.gizmoHandles();
  controller.beginGizmoDrag('y', handles.origin.x, handles.origin.y);
  controller.setGizmoTypedAmount(90);
  assert.equal(controller.endGizmoDrag(), true);

  assertNearVector(translationOf(controller, 'right'), [2.2, 0.5, 0], 0.02, 'active pivot stays in place');
  assertNearVector(translationOf(controller, 'middle'), [2.2, 0.5, 2.2], 0.02, 'middle orbits 90° around active pivot');
  assertNearVector(translationOf(controller, 'left'), [2.2, 0.5, 4.4], 0.02, 'left orbits 90° around active pivot');
  const expectedTurnY = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  for (const id of ['left', 'middle', 'right']) {
    assertNearVector(nodeOf(controller, id).rotation, expectedTurnY, 0.02, `${id} rotated 90° around Y`);
  }

  assert.equal(controller.undo(), true);
  assertNearVector(translationOf(controller, 'left'), LEFT_CUBE, 1e-4, 'one undo returns left position');
  assertNearVector(translationOf(controller, 'middle'), MIDDLE_CUBE, 1e-4, 'one undo returns middle position');
  assertNearVector(nodeOf(controller, 'left').rotation ?? [0, 0, 0, 1], [0, 0, 0, 1], 1e-4, 'one undo clears rotation');

  assert.equal(controller.redo(), true);
  assertNearVector(translationOf(controller, 'left'), [2.2, 0.5, 4.4], 0.02, 'one redo rotates left back');
});

test('cancelling a grouped rotate drag restores all positions and rotations with no undo step', testContext => {
  const ui = mountStudio(testContext);
  const { controller } = ui;
  pickThree(ui);
  controller.setTool('rotate');
  const handles = controller.gizmoHandles();
  controller.beginGizmoDrag('y', handles.origin.x, handles.origin.y);
  controller.setGizmoTypedAmount(45);
  controller.cancelGizmoDrag();
  assert.deepEqual(translationOf(controller, 'left'), LEFT_CUBE);
  assert.deepEqual(translationOf(controller, 'middle'), MIDDLE_CUBE);
  assertNearVector(nodeOf(controller, 'left').rotation ?? [0, 0, 0, 1], [0, 0, 0, 1], 1e-4);
  assert.equal(controller.canUndo, false);
});

test('Scale uniformly and along one axis scales every selected root around the active pivot as one undo step', testContext => {
  const ui = mountStudio(testContext);
  const { controller } = ui;
  pickThree(ui);
  controller.setTool('scale');
  const handles = controller.gizmoHandles();
  controller.beginGizmoDrag('uniform', handles.origin.x, handles.origin.y);
  controller.setGizmoTypedAmount(2);
  assert.equal(controller.endGizmoDrag(), true);

  assertNearVector(translationOf(controller, 'right'), [2.2, 0.5, 0], 0.02);
  assertNearVector(translationOf(controller, 'middle'), [-2.2, 0.5, 0], 0.02);
  assertNearVector(translationOf(controller, 'left'), [-6.6, 0.5, 0], 0.02);
  for (const id of ['left', 'middle', 'right']) {
    assertNearVector(nodeOf(controller, id).scale, [2, 2, 2], 0.02, `${id} scaled uniformly`);
  }

  controller.undo();
  assertNearVector(translationOf(controller, 'left'), LEFT_CUBE, 1e-4);
  assertNearVector(nodeOf(controller, 'left').scale ?? [1, 1, 1], [1, 1, 1], 1e-4);

  controller.redo();
  assertNearVector(translationOf(controller, 'left'), [-6.6, 0.5, 0], 0.02);
  assertNearVector(nodeOf(controller, 'left').scale, [2, 2, 2], 0.02);

  controller.undo();
  controller.beginGizmoDrag('x', handles.origin.x, handles.origin.y);
  controller.setGizmoTypedAmount(2);
  controller.endGizmoDrag();
  assertNearVector(translationOf(controller, 'middle'), [-2.2, 0.5, 0], 0.02);
  assertNearVector(nodeOf(controller, 'middle').scale, [2, 1, 1], 0.02, 'axis scale affects only X');
  assertNearVector(nodeOf(controller, 'right').scale, [2, 1, 1], 0.02);
});

test('with parent and child selected, Rotate and Scale transform the parent once and preserve child local pose', () => {
  const controller = makeFamilyController();
  controller.selectNodes(['parent', 'child-a', 'child-b'], { active: 'child-a' });
  controller.setTool('rotate');
  let handles = controller.gizmoHandles();
  controller.beginGizmoDrag('y', handles.origin.x, handles.origin.y);
  controller.setGizmoTypedAmount(90);
  controller.endGizmoDrag();
  assert.deepEqual(translationOf(controller, 'child-a'), [-1, 0, 0], 'child keeps local translation relative to parent');
  assertNearVector(nodeOf(controller, 'child-a').rotation ?? [0, 0, 0, 1], [0, 0, 0, 1], 1e-4, 'child is not rotated twice');
  assertNearVector(nodeOf(controller, 'parent').rotation, [0, Math.SQRT1_2, 0, Math.SQRT1_2], 0.02, 'parent rotated once');

  controller.undo();
  controller.setTool('scale');
  handles = controller.gizmoHandles();
  controller.beginGizmoDrag('uniform', handles.origin.x, handles.origin.y);
  controller.setGizmoTypedAmount(2);
  controller.endGizmoDrag();
  assert.deepEqual(translationOf(controller, 'child-a'), [-1, 0, 0]);
  assertNearVector(nodeOf(controller, 'child-a').scale ?? [1, 1, 1], [1, 1, 1], 1e-4, 'child is not scaled twice');
  assertNearVector(nodeOf(controller, 'parent').scale, [2, 2, 2], 0.02);
  assert.deepEqual(translationOf(controller, 'parent'), [1, 3, 0], 'parent scales away from active child pivot');
});

test('Copy and Paste copy all selected objects as one undo step, keep hierarchy and work after deletion', testContext => {
  const ui = mountStudio(testContext);
  const { controller } = ui;
  pickThree(ui);
  const returned = controller.copySelected();
  assert.equal(returned.id, 'right', 'copySelected keeps returning the active node clone');
  assert.equal(controller.canPaste, true);

  const activePasted = controller.pasteCopy();
  assert.equal(activePasted.id, 'right-copy-1');
  assert.deepEqual(nodeIds(controller), ['ground', 'left', 'middle', 'right', 'left-copy-1', 'middle-copy-1', 'right-copy-1']);
  assert.deepEqual(controller.selectedNodeIds, ['left-copy-1', 'middle-copy-1', 'right-copy-1']);
  assert.equal(controller.selectedNodeId, 'right-copy-1');

  controller.undo();
  assert.deepEqual(nodeIds(controller), ['ground', 'left', 'middle', 'right'], 'one undo removes all pasted objects');
  assert.deepEqual(controller.selectedNodeIds, ['left', 'middle', 'right']);

  controller.redo();
  assert.deepEqual(nodeIds(controller), ['ground', 'left', 'middle', 'right', 'left-copy-1', 'middle-copy-1', 'right-copy-1']);

  controller.selectNodes(['left', 'middle', 'right']);
  controller.deleteSelected();
  const secondPaste = controller.pasteCopy();
  assert.equal(secondPaste.id, 'right-copy-2');
  assertNearVector(translationOf(controller, 'left-copy-2'), [LEFT_CUBE[0] + 0.9, LEFT_CUBE[1], LEFT_CUBE[2] + 0.9], 1e-4);

  const family = makeFamilyController();
  family.selectNodes(['parent', 'child-a'], { active: 'child-a' });
  family.copySelected();
  const pastedChild = family.pasteCopy();
  assert.equal(pastedChild.id, 'child-a-copy-1');
  assert.equal(pastedChild.parent, 'parent-copy-1');
  assert.deepEqual(pastedChild.translation, [-1, 0, 0]);
});

test('Ctrl+C and Ctrl+V paste multiple selected objects from keyboard and announce the count', testContext => {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: makeRecipe(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const canvas = dom.container.firstElementChild.querySelector('canvas');
  const status = () => dom.container.firstElementChild.querySelector('.crucible-studio-status').textContent;
  studio.controller.selectNodes(['left', 'middle'], { active: 'left' });
  dispatch(canvas, 'keydown', { key: 'c', ctrlKey: true });
  assert.equal(status(), 'Copied 2 objects');
  dispatch(canvas, 'keydown', { key: 'v', ctrlKey: true });
  assert.equal(status(), 'Pasted 2 objects');
  assert.deepEqual(studio.controller.selectedNodeIds, ['left-copy-1', 'middle-copy-1']);
  assert.equal(studio.controller.selectedNodeId, 'left-copy-1');
});

test('Properties card marks differing object, shape and material fields as Mixed and edits all selected nodes in one undo step', testContext => {
  const recipe = makeRecipe();
  recipe.geometries = [
    { id: 'floor', type: 'box', bevel: 0 },
    { id: 'cube-a', type: 'box', bevel: 0.02 },
    { id: 'cube-b', type: 'box', bevel: 0.1 },
  ];
  recipe.materials.push({ id: 'brass', tag: 'surface', color: [0.9, 0.7, 0.2], roughness: 0.2, metallic: 0.9, doubleSided: true });
  recipe.nodes = [
    { id: 'ground', geometry: 'floor', material: 'stone', translation: [0, -0.2, 0], scale: [10, 0.4, 10] },
    { id: 'left', label: 'Left', geometry: 'cube-a', material: 'paint', translation: LEFT_CUBE, castShadow: true },
    { id: 'middle', label: 'Middle', geometry: 'cube-b', material: 'brass', translation: MIDDLE_CUBE, castShadow: false },
    { id: 'right', label: 'Right', geometry: 'cube-b', material: 'brass', parent: 'ground', translation: RIGHT_CUBE, castShadow: true },
  ];

  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe, renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const byLabel = text => [
    ...root.querySelectorAll('input'),
    ...root.querySelectorAll('select'),
    ...root.querySelectorAll('button'),
  ].find(element => element.getAttribute('aria-label') === text);
  const fieldOf = element => {
    let current = element;
    while (current && !String(current.className ?? '').split(/\s+/).includes('crucible-studio-field')) {
      current = current.parentNode;
    }
    return current;
  };

  studio.controller.selectNodes(['left', 'middle', 'right']);

  // Object panel: differing fields show Mixed, shared fields show their values.
  assert.equal(byLabel('Node label').value, '');
  assert.equal(byLabel('Node label').placeholder, 'Mixed');
  assert.equal(byLabel('Node label').dataset.mixed, 'true');
  assert.equal(byLabel('Parent node').value, '__mixed__');
  assert.equal(byLabel('Parent node').dataset.mixed, 'true');

  assert.equal(byLabel('Position X').value, '');
  assert.equal(byLabel('Position X').placeholder, 'Mixed');
  assert.equal(byLabel('Position X').dataset.mixed, 'true');
  assert.equal(byLabel('Position Y').value, '0.5');
  assert.equal(byLabel('Position Y').dataset.mixed, 'false');
  assert.equal(byLabel('Position Z').value, '0');
  assert.equal(byLabel('Position Z').dataset.mixed, 'false');

  assert.equal(byLabel('Bevel').value, '');
  assert.equal(byLabel('Bevel').placeholder, 'Mixed');
  assert.equal(byLabel('Bevel').dataset.mixed, 'true');

  const castButton = root.querySelectorAll('button').find(button => button.textContent.startsWith('Casts shadow'));
  assert.equal(castButton.textContent, 'Casts shadow (Mixed)');
  assert.equal(castButton.getAttribute('aria-pressed'), 'mixed');

  // Editing shared Position Y moves all 3 nodes while preserving each node's X!
  byLabel('Position Y').value = '2.5';
  dispatch(byLabel('Position Y'), 'change');
  assertNearVector(translationOf(studio.controller, 'left'), [-2.2, 2.5, 0], 1e-4);
  assertNearVector(translationOf(studio.controller, 'middle'), [0, 2.5, 0], 1e-4);
  assertNearVector(translationOf(studio.controller, 'right'), [2.2, 2.5, 0], 1e-4);
  studio.controller.undo();
  assertNearVector(translationOf(studio.controller, 'left'), LEFT_CUBE, 1e-4);
  assertNearVector(translationOf(studio.controller, 'right'), RIGHT_CUBE, 1e-4);

  // Editing mixed Position X sets X on all 3 nodes as one undo step and clears Mixed on X.
  byLabel('Position X').value = '3';
  dispatch(byLabel('Position X'), 'change');
  assertNearVector(translationOf(studio.controller, 'left'), [3, 0.5, 0], 1e-4);
  assertNearVector(translationOf(studio.controller, 'middle'), [3, 0.5, 0], 1e-4);
  assertNearVector(translationOf(studio.controller, 'right'), [3, 0.5, 0], 1e-4);
  assert.equal(byLabel('Position X').value, '3');
  assert.equal(byLabel('Position X').dataset.mixed, 'false');
  studio.controller.undo();
  assert.equal(byLabel('Position X').placeholder, 'Mixed');

  // Editing mixed Bevel updates all 3 shapes in one undo step.
  byLabel('Bevel').value = '0.2';
  dispatch(byLabel('Bevel'), 'change');
  const geometriesAfterBevel = new Map(studio.controller.exportRecipe().geometries.map(geometry => [geometry.id, geometry]));
  for (const id of ['left', 'middle', 'right']) {
    assert.equal(geometriesAfterBevel.get(nodeOf(studio.controller, id).geometry).bevel, 0.2);
  }
  assert.equal(byLabel('Bevel').value, '0.2');
  studio.controller.undo();
  assert.equal(byLabel('Bevel').placeholder, 'Mixed');

  // Editing Casts shadow applies to all 3 in one undo step.
  castButton.click();
  for (const id of ['left', 'middle', 'right']) {
    assert.equal(nodeOf(studio.controller, id).castShadow, false);
  }
  assert.equal(castButton.textContent, 'Casts shadow');
  assert.equal(castButton.getAttribute('aria-pressed'), 'false');
  studio.controller.undo();
  assert.equal(castButton.textContent, 'Casts shadow (Mixed)');

  // Material panel: differing materials show Mixed on Assigned material, Color, Roughness, Metallic, Double sided.
  assert.equal(byLabel('Assigned material').value, '__mixed__');
  const roughnessContainer = fieldOf(byLabel('Roughness'));
  assert.equal(roughnessContainer.dataset.mixed, 'true');
  assert.equal(roughnessContainer.querySelector('output').textContent, 'Mixed');
  const colorContainer = fieldOf(byLabel('Base color'));
  assert.equal(colorContainer.dataset.mixed, 'true');
  assert.equal(colorContainer.querySelector('.crucible-studio-mixed-tag').textContent, 'Mixed');
  const doubleSidedButton = root.querySelectorAll('button').find(button => button.textContent.startsWith('Double sided'));
  assert.equal(doubleSidedButton.textContent, 'Double sided (Mixed)');
  assert.equal(doubleSidedButton.getAttribute('aria-pressed'), 'mixed');

  // Editing Roughness applies across both distinct materials in one undo step.
  byLabel('Roughness').value = '0.66';
  dispatch(byLabel('Roughness'), 'input');
  const materialsById = () => new Map(studio.controller.exportRecipe().materials.map(material => [material.id, material]));
  assert.equal(materialsById().get('paint').roughness, 0.66);
  assert.equal(materialsById().get('brass').roughness, 0.66);
  assert.equal(roughnessContainer.dataset.mixed, 'false');
  assert.equal(roughnessContainer.querySelector('output').textContent, '0.66');
  studio.controller.undo();
  assert.equal(materialsById().get('paint').roughness, 0.4);
  assert.equal(materialsById().get('brass').roughness, 0.2);
  assert.equal(roughnessContainer.querySelector('output').textContent, 'Mixed');

  // Assigning one material via dropdown applies to all selected geometry nodes in one undo step.
  byLabel('Assigned material').value = 'stone';
  dispatch(byLabel('Assigned material'), 'change');
  for (const id of ['left', 'middle', 'right']) {
    assert.equal(nodeOf(studio.controller, id).material, 'stone');
  }
  assert.equal(byLabel('Assigned material').value, 'stone');
  assert.equal(roughnessContainer.querySelector('output').textContent, '0.80');
  studio.controller.undo();
  assert.equal(nodeOf(studio.controller, 'left').material, 'paint');
  assert.equal(nodeOf(studio.controller, 'middle').material, 'brass');

  // Editing Base color updates both distinct materials in one undo step and clears Mixed.
  const colorInput = byLabel('Base color');
  colorInput.value = '#3366cc';
  dispatch(colorInput, 'input');
  assert.equal(colorContainer.dataset.mixed, 'false');
  assert.equal(colorContainer.querySelector('.crucible-studio-mixed-tag').hidden, true);
  assertNearVector(materialsById().get('paint').color, materialsById().get('brass').color, 1e-3);
  studio.controller.undo();
  assert.equal(colorContainer.dataset.mixed, 'true');
  assert.equal(colorContainer.querySelector('.crucible-studio-mixed-tag').hidden, false);

  // Clicking Double sided applies across both materials in one undo step (inverting the active material's state).
  doubleSidedButton.click();
  assert.equal(materialsById().get('paint').doubleSided, false);
  assert.equal(materialsById().get('brass').doubleSided, false);
  assert.equal(doubleSidedButton.textContent, 'Double sided');
  assert.equal(doubleSidedButton.getAttribute('aria-pressed'), 'false');
  studio.controller.undo();
  assert.equal(doubleSidedButton.textContent, 'Double sided (Mixed)');

  // Clicking a palette swatch assigns that material to all selected geometry nodes in one undo step.
  byLabel('Material stone').click();
  for (const id of ['left', 'middle', 'right']) {
    assert.equal(nodeOf(studio.controller, id).material, 'stone');
  }
  studio.controller.undo();
  assert.equal(nodeOf(studio.controller, 'left').material, 'paint');
  assert.equal(nodeOf(studio.controller, 'middle').material, 'brass');
});
