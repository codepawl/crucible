import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
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
