import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

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
      { id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] },
    ],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

const LEFT = 40;
const TOP = 30;

function mountStudio(testContext) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: makeRecipe(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = { left: LEFT, top: TOP, width: 800, height: 600, right: 840, bottom: 630 };
  studio.renderNow();
  const canvas = viewport.querySelector('canvas');
  const controller = studio.controller;
  const positionOf = worldPoint => {
    const point = controller.projectWorldPoint(worldPoint);
    return { clientX: point.x + LEFT, clientY: point.y + TOP };
  };
  const press = (worldPoint, properties) => {
    const position = positionOf(worldPoint);
    dispatch(canvas, 'pointerdown', { ...position, ...properties });
    dispatch(viewport, 'pointerup', { ...position, ...properties });
  };
  return { dom, studio, root, viewport, canvas, controller, positionOf, press };
}

const HERO = [0, 0.5, 0];
const EMPTY_SPACE = [4, 3, 0];

function targetOf(controller) {
  return Array.from(controller.viewCamera.target);
}

test('a middle click on a surface sets the orbit pivot and neither selects nor moves the view angle', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNodes(['ground']);
  const before = ui.controller.viewCamera;
  const beforeOffset = before.eye.map((component, axis) => component - before.target[axis]);
  ui.press(HERO, { button: 1 });
  assert.deepEqual(ui.controller.selectedNodeIds, ['ground'], 'the selection stays');
  assert.notDeepEqual(targetOf(ui.controller), [0, 0.5, 0], 'the target moved to the surface point');
  const after = ui.controller.viewCamera;
  const afterOffset = after.eye.map((component, axis) => component - after.target[axis]);
  afterOffset.forEach((component, axis) => assert.ok(Math.abs(component - beforeOffset[axis]) < 1e-9, 'the eye keeps its offset'));
});

test('a middle click on empty space does nothing to the view and says so', testContext => {
  const ui = mountStudio(testContext);
  const before = targetOf(ui.controller);
  ui.press(EMPTY_SPACE, { button: 1 });
  assert.deepEqual(targetOf(ui.controller), before);
  assert.match(ui.root.textContent, /No surface there to orbit around/);
});

test('an Alt + right click sets the pivot and does not select', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNodes(['ground']);
  ui.press(HERO, { button: 2, altKey: true });
  assert.deepEqual(ui.controller.selectedNodeIds, ['ground']);
  assert.notDeepEqual(targetOf(ui.controller), [0, 0.5, 0]);
});

test('a plain right click still selects what is under it', testContext => {
  const ui = mountStudio(testContext);
  ui.press(HERO, { button: 2 });
  assert.deepEqual(ui.controller.selectedNodeIds, ['hero']);
  assert.deepEqual(targetOf(ui.controller), [0, 0.5, 0]);
});

test('a middle drag pans and does not set the pivot', testContext => {
  const ui = mountStudio(testContext);
  const selectionBefore = [...ui.controller.selectedNodeIds];
  const start = ui.positionOf(HERO);
  dispatch(ui.canvas, 'pointerdown', { ...start, button: 1 });
  dispatch(ui.viewport, 'pointermove', { clientX: start.clientX + 60, clientY: start.clientY + 30 });
  dispatch(ui.viewport, 'pointerup', { clientX: start.clientX + 60, clientY: start.clientY + 30, button: 1 });
  assert.notDeepEqual(targetOf(ui.controller), [0, 0.5, 0], 'a pan moves the target');
  assert.deepEqual(ui.controller.selectedNodeIds, selectionBefore);
});

function makeEdit(ui) {
  ui.controller.selectNodes(['hero']);
  ui.controller.duplicateSelected();
  return ui.controller.exportRecipe().nodes.length;
}

test('the Back button undoes once, the Forward button redoes once, and neither reaches the browser', testContext => {
  const ui = mountStudio(testContext);
  const editedCount = makeEdit(ui);
  const prevented = [];
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick']) {
    const event = dispatch(ui.dom.document, type, { button: 3 });
    prevented.push(event.defaultPrevented);
  }
  assert.deepEqual(prevented, [true, true, true, true, true]);
  assert.equal(ui.controller.exportRecipe().nodes.length, editedCount - 1, 'one click undid exactly one edit');
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick']) {
    assert.equal(dispatch(ui.dom.document, type, { button: 4 }).defaultPrevented, true);
  }
  assert.equal(ui.controller.exportRecipe().nodes.length, editedCount, 'the Forward button redid it');
});

test('a side button leaves undo alone while a text field has focus but still stops the browser', testContext => {
  const ui = mountStudio(testContext);
  const editedCount = makeEdit(ui);
  const field = ui.dom.document.createElement('input');
  field.type = 'text';
  ui.root.append(field);
  field.focus();
  const event = dispatch(ui.dom.document, 'pointerup', { button: 3 });
  assert.equal(event.defaultPrevented, true);
  assert.equal(ui.controller.exportRecipe().nodes.length, editedCount);
});

test('side button listeners are gone after dispose', testContext => {
  const ui = mountStudio(testContext);
  ui.studio.dispose();
  assert.equal(dispatch(ui.dom.document, 'mouseup', { button: 3 }).defaultPrevented, false);
});

function holdSpace(ui, properties = {}) {
  dispatch(ui.viewport, 'pointermove', { clientX: LEFT + 400, clientY: TOP + 300 });
  return dispatch(ui.dom.document, 'keydown', { key: ' ', code: 'Space', ...properties });
}

function playIsPressed(ui) {
  return ui.root.querySelectorAll('button').some(button => /^(Pause|Play)/.test(button.getAttribute('aria-label') ?? '') && button.getAttribute('aria-pressed') === 'true');
}

async function prepareTimeline(ui) {
  ui.controller.selectNodes(['hero']);
  dispatch(ui.dom.document, 'keydown', { key: 'k' });
  await ui.dom.settle();
}

test('Space + left drag pans, and the Space tap action does not also run', async testContext => {
  const ui = mountStudio(testContext);
  await prepareTimeline(ui);
  holdSpace(ui);
  const start = { clientX: LEFT + 400, clientY: TOP + 300 };
  dispatch(ui.canvas, 'pointerdown', { ...start, button: 0 });
  dispatch(ui.viewport, 'pointermove', { clientX: start.clientX + 80, clientY: start.clientY + 20 });
  dispatch(ui.viewport, 'pointerup', { clientX: start.clientX + 80, clientY: start.clientY + 20, button: 0 });
  dispatch(ui.dom.document, 'keyup', { key: ' ', code: 'Space' });
  assert.notDeepEqual(targetOf(ui.controller), [0, 0.5, 0], 'a pan moves the target where an orbit would not');
  assert.equal(playIsPressed(ui), false, 'the drag used the key, so it does not play');
});

test('a Space tap with no drag still plays, once the key comes up', async testContext => {
  const ui = mountStudio(testContext);
  await prepareTimeline(ui);
  const keydown = holdSpace(ui);
  assert.equal(keydown.defaultPrevented, true, 'the page does not scroll');
  assert.equal(playIsPressed(ui), false, 'it waits for the key to come up');
  dispatch(ui.dom.document, 'keyup', { key: ' ', code: 'Space' });
  assert.equal(playIsPressed(ui), true);
});

test('holding Space with no drag runs its action at the first repeat and on each repeat after it', async testContext => {
  const ui = mountStudio(testContext);
  await prepareTimeline(ui);
  holdSpace(ui);
  dispatch(ui.dom.document, 'keydown', { key: ' ', code: 'Space', repeat: true });
  assert.equal(playIsPressed(ui), false, 'the waiting press and the first repeat toggle twice, as held keys always did');
  dispatch(ui.dom.document, 'keydown', { key: ' ', code: 'Space', repeat: true });
  assert.equal(playIsPressed(ui), true);
  dispatch(ui.dom.document, 'keyup', { key: ' ', code: 'Space' });
  assert.equal(playIsPressed(ui), true, 'the release after a repeat adds nothing');
});

test('Space in a text field is left to the field, and Space away from the viewport runs at once', async testContext => {
  const ui = mountStudio(testContext);
  await prepareTimeline(ui);
  const field = ui.dom.document.createElement('input');
  field.type = 'text';
  ui.root.append(field);
  dispatch(ui.viewport, 'pointermove', { clientX: LEFT + 400, clientY: TOP + 300 });
  const typed = dispatch(field, 'keydown', { key: ' ', code: 'Space' });
  assert.equal(typed.defaultPrevented, false, 'the field keeps its space');
  dispatch(field, 'keyup', { key: ' ', code: 'Space' });
  assert.equal(playIsPressed(ui), false);
  dispatch(ui.viewport, 'pointerleave', {});
  dispatch(ui.dom.document, 'keydown', { key: ' ', code: 'Space' });
  assert.equal(playIsPressed(ui), true, 'with the pointer elsewhere the key acts on the press, as before');
});
