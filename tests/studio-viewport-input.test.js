import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { overlayCameraMode, targetOwnsWheel } from '../src/studio-viewport-input.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

// The wheel and the camera drags work anywhere over the 3D view, including on the handles and the marks drawn over it (#3464).
const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

function makeRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0.04 }],
    materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
    nodes: [{ id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] }],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

function mountStudio(testContext, options = {}) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: makeRecipe(), renderer: createFakeRenderer(), ...options });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  studio.renderNow();
  const controller = studio.controller;
  return {
    studio,
    controller,
    root,
    viewport,
    canvas: viewport.querySelector('canvas'),
    clientPoint: point => ({ clientX: point.x + VIEWPORT_BOX.left, clientY: point.y + VIEWPORT_BOX.top }),
    distance: () => Math.hypot(...controller.scene.camera.eye.map((value, index) => value - controller.scene.camera.target[index])),
    sunMark: () => root.descendants().find(element => element.getAttribute('data-scene-object') === 'sun' && element.tagName.toLowerCase() === 'circle'),
    handle: axis => root.descendants().find(element => element.getAttribute('data-gizmo-axis') === axis),
  };
}

function dragFrom(ui, target, press, from, to) {
  dispatch(target, 'pointerdown', { ...ui.clientPoint(from), pointerId: 3, ...press });
  dispatch(ui.canvas, 'pointermove', { ...ui.clientPoint(to), pointerId: 3 });
  dispatch(ui.canvas, 'pointerup', { ...ui.clientPoint(to), pointerId: 3 });
}

test('the wheel zooms over a scene mark and over a gizmo handle as it does over the bare canvas', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode('hero');
  ui.studio.renderNow();
  for (const [name, target] of [['canvas', ui.canvas], ['sun mark', ui.sunMark()], ['gizmo handle', ui.handle('x')]]) {
    assert.ok(target, `${name} is drawn`);
    const before = ui.distance();
    const wheel = dispatch(target, 'wheel', { deltaY: 100 });
    assert.equal(wheel.defaultPrevented, true, `${name}: the page does not scroll`);
    assert.ok(ui.distance() > before, `${name}: a wheel step away moves the camera back`);
    const afterOut = ui.distance();
    dispatch(target, 'wheel', { deltaY: -100 });
    assert.ok(ui.distance() < afterOut, `${name}: a wheel step the other way comes closer`);
  }
});

test('the wheel over the scene list, a number field and an open menu leaves the camera alone', testContext => {
  const ui = mountStudio(testContext);
  const before = [...ui.controller.scene.camera.eye];
  const sceneList = ui.root.descendants().find(element => String(element.className).includes('crucible-studio-tree'));
  const numberField = ui.root.descendants().find(element => element.tagName.toLowerCase() === 'input');
  const menu = ui.root.querySelector('#crucible-studio-pop-object');
  for (const target of [sceneList, numberField, menu]) {
    assert.ok(target);
    dispatch(target, 'wheel', { deltaY: 100 });
  }
  assert.deepEqual([...ui.controller.scene.camera.eye], before);
});

test('targetOwnsWheel: a control inside the view that uses the wheel keeps it, and so does anything outside the view', testContext => {
  const ui = mountStudio(testContext);
  const documentReference = ui.canvas.ownerDocument;
  const makeInside = tagName => {
    const element = documentReference.createElement(tagName);
    ui.viewport.append(element);
    return element;
  };
  assert.equal(targetOwnsWheel(ui.canvas, ui.viewport), false);
  assert.equal(targetOwnsWheel(ui.sunMark(), ui.viewport), false);
  for (const tagName of ['input', 'textarea', 'select', 'dialog']) {
    assert.equal(targetOwnsWheel(makeInside(tagName), ui.viewport), true, tagName);
  }
  const marked = makeInside('div');
  marked.setAttribute('data-wheel-owner', 'true');
  const insideMarked = documentReference.createElement('span');
  marked.append(insideMarked);
  assert.equal(targetOwnsWheel(insideMarked, ui.viewport), true, 'a child of an element that marks itself');
  const menu = makeInside('div');
  menu.setAttribute('role', 'menu');
  assert.equal(targetOwnsWheel(menu, ui.viewport), true, 'a menu');
  assert.equal(targetOwnsWheel(ui.root.querySelector('#crucible-studio-pop-object'), ui.viewport), true, 'a panel outside the view');
  assert.equal(targetOwnsWheel(null, ui.viewport), true);
});

test('overlayCameraMode: middle, right and Shift with the left button pan; a plain left press keeps its own job', () => {
  assert.equal(overlayCameraMode({ button: 1 }), 'pan');
  assert.equal(overlayCameraMode({ button: 2 }), 'pan');
  assert.equal(overlayCameraMode({ button: 0, shiftKey: true }), 'pan');
  assert.equal(overlayCameraMode({ button: 0 }), null);
});

test('a middle, right or Shift+left drag that starts on a scene mark pans the camera like one from the canvas', testContext => {
  const ui = mountStudio(testContext);
  for (const press of [{ button: 1 }, { button: 2 }, { button: 0, shiftKey: true }]) {
    const targetBefore = [...ui.controller.scene.camera.target];
    dragFrom(ui, ui.sunMark(), press, { x: 400, y: 300 }, { x: 480, y: 340 });
    assert.notDeepEqual([...ui.controller.scene.camera.target], targetBefore, `from a mark: ${JSON.stringify(press)}`);
    assert.equal(ui.controller.selectedObjectKey, null, 'a drag does not select the mark');
  }
});

test('a middle, right or Shift+left drag that starts on a gizmo handle pans the camera and does not drag the handle', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode('hero');
  ui.studio.renderNow();
  for (const press of [{ button: 1 }, { button: 2 }, { button: 0, shiftKey: true }]) {
    const targetBefore = [...ui.controller.scene.camera.target];
    const nodesBefore = JSON.stringify(ui.controller.exportRecipe().nodes);
    dragFrom(ui, ui.handle('x'), press, { x: 400, y: 300 }, { x: 480, y: 340 });
    assert.notDeepEqual([...ui.controller.scene.camera.target], targetBefore, `from a handle: ${JSON.stringify(press)}`);
    assert.equal(JSON.stringify(ui.controller.exportRecipe().nodes), nodesBefore, 'the object did not move');
  }
});

test('a right drag that began on a handle opens no menu when the button comes up, and a right click without a drag still does', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode('hero');
  ui.studio.renderNow();
  const menu = ui.root.querySelector('#crucible-studio-pop-object');
  dragFrom(ui, ui.handle('x'), { button: 2 }, { x: 400, y: 300 }, { x: 480, y: 340 });
  dispatch(ui.handle('x'), 'contextmenu', ui.clientPoint({ x: 480, y: 340 }));
  assert.equal(menu.popoverOpen, false, 'a pan is not a request for the menu');

  dispatch(ui.handle('x'), 'pointerdown', { ...ui.clientPoint({ x: 400, y: 300 }), pointerId: 4, button: 2 });
  dispatch(ui.canvas, 'pointerup', { ...ui.clientPoint({ x: 400, y: 300 }), pointerId: 4, button: 2 });
  dispatch(ui.handle('x'), 'contextmenu', ui.clientPoint({ x: 400, y: 300 }));
  assert.equal(menu.popoverOpen, true, 'a click on a handle is a click on the selected object');
  assert.equal(ui.controller.selectedNodeId, 'hero');
});

test('with Maya keys Alt and the left button orbit from a mark and from a handle, and never select or drag them', testContext => {
  const ui = mountStudio(testContext, { preferences: { keymap: 'maya' } });
  ui.controller.selectNode('hero');
  ui.studio.renderNow();
  for (const target of [ui.sunMark(), ui.handle('x')]) {
    const eyeBefore = [...ui.controller.scene.camera.eye];
    dragFrom(ui, target, { button: 0, altKey: true }, { x: 400, y: 300 }, { x: 460, y: 330 });
    assert.notDeepEqual([...ui.controller.scene.camera.eye], eyeBefore);
    assert.equal(ui.controller.selectedObjectKey, null);
  }
});

test('a plain left press on a mark still selects it and on a handle still drags it', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode('hero');
  ui.studio.renderNow();
  const nodesBefore = JSON.stringify(ui.controller.exportRecipe().nodes);
  dispatch(ui.handle('x'), 'pointerdown', { ...ui.clientPoint({ x: 400, y: 300 }), pointerId: 5, button: 0 });
  dispatch(ui.canvas, 'pointermove', { ...ui.clientPoint({ x: 460, y: 300 }), pointerId: 5 });
  dispatch(ui.canvas, 'pointerup', { ...ui.clientPoint({ x: 460, y: 300 }), pointerId: 5 });
  assert.notEqual(JSON.stringify(ui.controller.exportRecipe().nodes), nodesBefore, 'the handle moved the object');
  dispatch(ui.sunMark(), 'pointerdown', { ...ui.clientPoint({ x: 400, y: 300 }), pointerId: 6, button: 0 });
  assert.equal(ui.controller.selectedObjectKey, 'sun');
});
