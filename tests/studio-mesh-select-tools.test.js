import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { byDataset, createFakeRenderer, dispatch, FakeNode, installStudioDom } from './support/studio-dom.mjs';
import {
  CIRCLE_BRUSH_DEFAULT_PIXELS,
  CIRCLE_BRUSH_MAX_PIXELS,
  CIRCLE_BRUSH_MIN_PIXELS,
  createMeshEditor,
} from '../src/studio-mesh-edit.js';

// Select none (Alt+A), invert (Ctrl+I) and circle select (C) in edit mode, in vertex, edge and face mode (#3294).
// The box seen from the default camera shows its front, top and right faces: 3 faces, 9 edges and 7 vertices face the camera.
const CAMERA = { eye: [0.8, 1.4, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };
const COUNTS = { vertex: 8, edge: 12, face: 6 };
const NEAR_COUNTS = { vertex: 7, edge: 9, face: 3 };
const MODES = ['vertex', 'edge', 'face'];

function recipeOf() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [{ id: 'shape', type: 'mesh', base: { type: 'box', bevel: 0 } }],
    nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }],
    camera: CAMERA,
  };
}

function mount() {
  const controller = createStudioController({ scene: createAgentScene(recipeOf()), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  const editor = createMeshEditor({ controller, getRenderer: () => ({}), updatePart: () => {} });
  editor.enter();
  return { controller, editor, mesh: meshEditSourceOf(heroPart(controller).geometry).mesh };
}

function heroPart(controller) {
  return controller.scene.parts.find(part => part.name === 'hero');
}

function pixelOfPoint(controller, point) {
  return controller.projectWorldPoint(point);
}

function vertexIndexAt(mesh, point) {
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    if (point.every((component, axis) => Math.abs(mesh.positions[vertex * 3 + axis] - component) < 1e-5)) return vertex;
  }
  throw new Error(`no vertex at ${point}`);
}

function edgeIndexBetween(mesh, first, second) {
  for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
    const ends = [mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]];
    if (ends.includes(first) && ends.includes(second)) return edge;
  }
  throw new Error('no such edge');
}

// A pixel in the middle of the box on screen: with a brush of the largest size it covers the whole mesh.
function centrePixel(controller) {
  return pixelOfPoint(controller, [0, 0, 0]);
}

function selectOne(editor, controller, mesh, mode) {
  editor.setMode(mode);
  const frontTopRight = vertexIndexAt(mesh, [0.5, 0.5, 0.5]);
  const frontTopLeft = vertexIndexAt(mesh, [-0.5, 0.5, 0.5]);
  const cornerPixel = pixelOfPoint(controller, [0.5, 0.5, 0.5]);
  if (mode === 'vertex') {
    editor.pick(cornerPixel.x, cornerPixel.y);
    return frontTopRight;
  }
  if (mode === 'edge') {
    const middle = pixelOfPoint(controller, [0, 0.5, 0.5]);
    editor.pick(middle.x, middle.y);
    return edgeIndexBetween(mesh, frontTopRight, frontTopLeft);
  }
  const front = pixelOfPoint(controller, [0, 0, 0.5]);
  return editor.pick(front.x, front.y);
}

for (const mode of MODES) {
  test(`select none clears the ${mode} selection and keeps the mode`, () => {
    const { controller, editor, mesh } = mount();
    const picked = selectOne(editor, controller, mesh, mode);
    assert.deepEqual(editor.selection, { mode, indices: [picked] });
    assert.equal(editor.selectNone(), true);
    assert.deepEqual(editor.selection, { mode, indices: [] });
    assert.equal(editor.selectNone(), false, 'nothing was selected, so nothing changed');
  });

  test(`invert swaps selected and unselected ${mode}s, and twice is the original`, () => {
    const { controller, editor, mesh } = mount();
    const picked = selectOne(editor, controller, mesh, mode);
    assert.equal(editor.invertSelection(), true);
    const inverted = editor.selection.indices;
    assert.equal(inverted.length, COUNTS[mode] - 1);
    assert.equal(inverted.includes(picked), false);
    editor.invertSelection();
    assert.deepEqual(editor.selection, { mode, indices: [picked] });
    editor.selectNone();
    editor.invertSelection();
    assert.equal(editor.selection.indices.length, COUNTS[mode], 'inverting an empty selection selects everything of the mode');
  });

  test(`circle select with a small brush on one ${mode} picks only that ${mode}, and deselect takes it out`, () => {
    const { controller, editor, mesh } = mount();
    const picked = selectOne(editor, controller, mesh, mode);
    editor.selectNone();
    assert.equal(editor.beginCircleSelect(), true);
    const spot = mode === 'vertex' ? pixelOfPoint(controller, [0.5, 0.5, 0.5])
      : mode === 'edge' ? pixelOfPoint(controller, [0, 0.5, 0.5])
        : pixelOfPoint(controller, [0, 0, 0.5]);
    editor.resizeCircleBrush(-100);
    assert.equal(editor.brushRadius, CIRCLE_BRUSH_MIN_PIXELS);
    editor.paintCircle(spot.x, spot.y);
    assert.deepEqual(editor.selection, { mode, indices: [picked] });
    assert.equal(editor.paintCircle(spot.x, spot.y), 0, 'painting the same spot again changes nothing');
    editor.paintCircle(spot.x, spot.y, { deselect: true });
    assert.deepEqual(editor.selection, { mode, indices: [] });
  });

  test(`circle select with the largest brush takes every ${mode} that faces the camera and no other`, () => {
    const { controller, editor } = mount();
    editor.setMode(mode);
    editor.beginCircleSelect();
    editor.resizeCircleBrush(100);
    assert.equal(editor.brushRadius, CIRCLE_BRUSH_MAX_PIXELS);
    const centre = centrePixel(controller);
    editor.paintCircle(centre.x, centre.y);
    assert.equal(editor.selection.indices.length, NEAR_COUNTS[mode]);
    editor.paintCircle(centre.x, centre.y, { deselect: true });
    assert.equal(editor.selection.indices.length, 0);
  });
}

test('the wheel resizes the brush by steps, inside its limits, and a bigger brush reaches a farther vertex', () => {
  const { controller, editor, mesh } = mount();
  editor.setMode('vertex');
  editor.beginCircleSelect();
  assert.equal(editor.brushRadius, CIRCLE_BRUSH_DEFAULT_PIXELS);
  const corner = vertexIndexAt(mesh, [0.5, 0.5, 0.5]);
  const cornerPixel = pixelOfPoint(controller, [0.5, 0.5, 0.5]);
  const outsideCorner = { x: cornerPixel.x + 40, y: cornerPixel.y - 40 };
  editor.paintCircle(outsideCorner.x, outsideCorner.y);
  assert.equal(editor.selection.indices.includes(corner), false, 'the corner is 56 px away from a 25 px brush');
  const grown = editor.resizeCircleBrush(1);
  assert.ok(grown > CIRCLE_BRUSH_DEFAULT_PIXELS);
  assert.ok(editor.resizeCircleBrush(-1) < grown);
  editor.resizeCircleBrush(6);
  editor.paintCircle(outsideCorner.x, outsideCorner.y);
  assert.equal(editor.selection.indices.includes(corner), true, 'a brush of 58 px reaches it');
  assert.throws(() => editor.resizeCircleBrush(Number.NaN), /finite number of wheel steps/);
});

test('circle select needs edit mode, draws the brush circle once the pointer is over the viewport and ends on request', () => {
  const { controller, editor } = mount();
  assert.equal(editor.circleSelecting, false);
  assert.equal(editor.paintCircle(10, 10), 0, 'painting without circle select does nothing');
  editor.beginCircleSelect();
  assert.equal(editor.circleSelecting, true);
  assert.equal(editor.cagePaths().some(path => path.className === 'crucible-studio-cage-brush'), false, 'no circle before the pointer is over the viewport');
  const centre = centrePixel(controller);
  editor.moveCircle(centre.x, centre.y);
  assert.equal(editor.cagePaths().some(path => path.className === 'crucible-studio-cage-brush'), true);
  assert.equal(editor.endCircleSelect(), true);
  assert.equal(editor.endCircleSelect(), false);
  editor.beginCircleSelect();
  editor.leave();
  assert.equal(editor.circleSelecting, false, 'leaving edit mode ends it');
  assert.equal(editor.beginCircleSelect(), false);
});

const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

function mountStudio(testContext) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: recipeOf(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  studio.renderNow();
  studio.controller.selectNode('hero');
  const press = (key, properties = {}) => dispatch(dom.document, 'keydown', { key, ...properties });
  const canvas = viewport.querySelector('canvas');
  const screenPoint = point => {
    const pixel = studio.controller.projectWorldPoint(point);
    return { clientX: VIEWPORT_BOX.left + pixel.x, clientY: VIEWPORT_BOX.top + pixel.y };
  };
  return { dom, studio, root, viewport, canvas, press, screenPoint, controller: studio.controller };
}

async function untilEditing(ui) {
  for (let attempt = 0; attempt < 2000 && ui.root.dataset.meshEdit !== 'true'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(ui.root.dataset.meshEdit, 'true');
}

function selectedCount(ui) {
  const selected = ui.root.querySelectorAll('.crucible-studio-cage-selected');
  return selected.length;
}

test('Alt+A, Ctrl+I and C through the page: none and invert in each mode, circle select by drag, Shift and wheel, Esc and right click leave it', async testContext => {
  const ui = mountStudio(testContext);
  ui.press('Tab');
  await untilEditing(ui);

  for (const [key, mode] of [['1', 'vertex'], ['2', 'edge'], ['3', 'face']]) {
    ui.press(key);
    const invert = ui.press('i', { ctrlKey: true });
    assert.equal(invert.defaultPrevented, true, 'Ctrl+I is kept from the browser');
    ui.studio.renderNow();
    assert.ok(selectedCount(ui) > 0, `${mode}: everything is selected after invert`);
    const none = ui.press('a', { code: 'KeyA', altKey: true });
    assert.equal(none.defaultPrevented, true, 'Alt+A is kept from the browser');
    ui.studio.renderNow();
    assert.equal(selectedCount(ui), 0, `${mode}: nothing is selected after Alt+A`);
  }
  assert.equal(ui.controller.selectedNodeId, 'hero', 'select none in edit mode never deselects the object');

  ui.press('1');
  ui.press('c');
  const centre = ui.screenPoint([0, 0, 0]);
  dispatch(ui.canvas, 'wheel', { deltaY: -100, clientX: centre.clientX, clientY: centre.clientY });
  const wheelNotches = 20;
  for (let notch = 0; notch < wheelNotches; notch += 1) dispatch(ui.canvas, 'wheel', { deltaY: -100 });
  dispatch(ui.canvas, 'pointerdown', { ...centre, button: 0 });
  dispatch(ui.viewport, 'pointerup', centre);
  ui.studio.renderNow();
  assert.ok(selectedCount(ui) > 0, 'a drag with a big brush selected vertices');
  assert.ok(ui.root.querySelector('.crucible-studio-cage-brush'), 'the brush circle is drawn');

  dispatch(ui.canvas, 'pointerdown', { ...centre, button: 1 });
  dispatch(ui.viewport, 'pointerup', centre);
  ui.studio.renderNow();
  assert.equal(selectedCount(ui), 0, 'a middle drag deselects what the brush covers');

  dispatch(ui.canvas, 'pointerdown', { ...centre, button: 0 });
  dispatch(ui.viewport, 'pointerup', centre);
  dispatch(ui.canvas, 'pointerdown', { ...centre, button: 0, shiftKey: true });
  dispatch(ui.viewport, 'pointerup', centre);
  ui.studio.renderNow();
  assert.equal(selectedCount(ui), 0, 'Shift with a left drag deselects too');

  ui.press('Escape');
  ui.studio.renderNow();
  assert.equal(ui.root.querySelector('.crucible-studio-cage-brush'), null, 'Esc ends circle select first');
  assert.equal(ui.root.dataset.meshEdit, 'true', 'and does not leave edit mode');

  ui.press('c');
  ui.studio.renderNow();
  dispatch(ui.viewport, 'pointermove', centre);
  ui.studio.renderNow();
  assert.ok(ui.root.querySelector('.crucible-studio-cage-brush'));
  dispatch(ui.canvas, 'contextmenu', { clientX: centre.clientX, clientY: centre.clientY });
  ui.studio.renderNow();
  assert.equal(ui.root.querySelector('.crucible-studio-cage-brush'), null, 'a right click ends circle select');
  assert.equal(ui.root.dataset.meshEdit, 'true');
  assert.ok(byDataset(ui.root, 'meshMode', 'vertex'));
});

// The brush ends when the window loses focus or the page is hidden, and the wheel sums its travel (#3363).
const WHEEL_LINE_MODE = 1;
const WHEEL_PAGE_MODE = 2;

test('the wheel sums its travel: one radius step per 100 pixels, the remainder kept, a turn around starts again', () => {
  const { editor } = mount();
  editor.beginCircleSelect();
  const start = editor.brushRadius;
  editor.wheelCircleBrush(-100);
  const oneNotch = editor.brushRadius;
  assert.ok(oneNotch > start, 'a mouse notch up still gives one step bigger');
  editor.wheelCircleBrush(100);
  assert.equal(editor.brushRadius, start, 'a notch down gives one step back');

  for (let event = 0; event < 30; event += 1) editor.wheelCircleBrush(-10);
  const trackpadRadius = editor.brushRadius;
  editor.wheelCircleBrush(300);
  assert.equal(editor.brushRadius, start, '300 px of trackpad travel is three steps, not thirty');
  editor.wheelCircleBrush(-300);
  assert.equal(editor.brushRadius, trackpadRadius, 'one 300 px event gives the same radius as thirty 10 px events');

  editor.wheelCircleBrush(100);
  editor.wheelCircleBrush(-60);
  const beforeRemainder = editor.brushRadius;
  editor.wheelCircleBrush(-60);
  assert.ok(editor.brushRadius > beforeRemainder, '60 px and 60 px make one step: the remainder was kept');

  const settled = editor.brushRadius;
  editor.wheelCircleBrush(-60);
  editor.wheelCircleBrush(60);
  assert.equal(editor.brushRadius, settled, 'a sign change drops the remainder: 60 px down alone is not a step');
  editor.wheelCircleBrush(50);
  assert.ok(editor.brushRadius < settled, '60 px and 50 px in the same direction are one step');
});

test('the wheel turns lines and pages into pixels, and ignores a zero or broken delta', () => {
  const { editor } = mount();
  editor.beginCircleSelect();
  const start = editor.brushRadius;
  editor.wheelCircleBrush(-3, WHEEL_LINE_MODE);
  const afterNotchInLines = editor.brushRadius;
  assert.ok(afterNotchInLines > start, 'three lines are one notch, so one step');
  editor.wheelCircleBrush(3, WHEEL_LINE_MODE);
  assert.equal(editor.brushRadius, start);
  editor.wheelCircleBrush(-1, WHEEL_PAGE_MODE);
  assert.ok(editor.brushRadius > afterNotchInLines, 'a page is several steps');
  editor.wheelCircleBrush(1, WHEEL_PAGE_MODE);
  assert.equal(editor.brushRadius, start);
  editor.wheelCircleBrush(0);
  editor.wheelCircleBrush(Number.NaN);
  assert.equal(editor.brushRadius, start);
});

test('a new brush session starts with no wheel remainder', () => {
  const { editor } = mount();
  editor.beginCircleSelect();
  const start = editor.brushRadius;
  editor.wheelCircleBrush(-60);
  editor.endCircleSelect();
  editor.beginCircleSelect();
  editor.wheelCircleBrush(-60);
  assert.equal(editor.brushRadius, start, 'the 60 px from the last session do not count');
});

function listenerCount(target, type) {
  return target.listeners.filter(entry => entry.type === type).length;
}

function mountStudioWithWindow(testContext) {
  const dom = installStudioDom();
  const windowTarget = new FakeNode(dom.document, 'window');
  Object.assign(windowTarget, dom.document.defaultView);
  dom.document.defaultView = windowTarget;
  const studio = createStudio(dom.container, { recipe: recipeOf(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  studio.renderNow();
  studio.controller.selectNode('hero');
  const press = (key, properties = {}) => dispatch(dom.document, 'keydown', { key, ...properties });
  return { dom, studio, root, viewport, canvas: viewport.querySelector('canvas'), press, windowTarget };
}

test('circle select ends on window blur and when the page is hidden, and its listeners are removed when it ends', async testContext => {
  const ui = mountStudioWithWindow(testContext);
  ui.press('Tab');
  await untilEditing(ui);
  const brushIsDrawn = () => {
    ui.studio.renderNow();
    dispatch(ui.viewport, 'pointermove', { clientX: 440, clientY: 330 });
    ui.studio.renderNow();
    return ui.root.querySelector('.crucible-studio-cage-brush') !== null;
  };
  const blurListeners = () => listenerCount(ui.windowTarget, 'blur');
  const hiddenListeners = () => listenerCount(ui.dom.document, 'visibilitychange');
  const blurBefore = blurListeners();
  const hiddenBefore = hiddenListeners();

  ui.press('c');
  assert.equal(brushIsDrawn(), true, 'the brush is on');
  assert.equal(blurListeners(), blurBefore + 1, 'a blur listener waits while the brush is on');
  assert.equal(hiddenListeners(), hiddenBefore + 1);
  dispatch(ui.windowTarget, 'blur');
  assert.equal(brushIsDrawn(), false, 'blur ends the brush');
  assert.equal(ui.root.dataset.meshEdit, 'true', 'and stays in edit mode, as Esc does');
  assert.equal(blurListeners(), blurBefore, 'the blur listener is gone');
  assert.equal(hiddenListeners(), hiddenBefore, 'the visibility listener is gone');

  ui.press('c');
  ui.dom.document.hidden = true;
  dispatch(ui.dom.document, 'visibilitychange');
  assert.equal(brushIsDrawn(), false, 'hiding the page ends the brush');
  assert.equal(blurListeners(), blurBefore);

  ui.dom.document.hidden = false;
  ui.press('c');
  dispatch(ui.dom.document, 'visibilitychange');
  assert.equal(brushIsDrawn(), true, 'a page that is visible again does not end it');
  ui.press('Escape');
  assert.equal(blurListeners(), blurBefore, 'Esc removes the listeners too');
  assert.equal(hiddenListeners(), hiddenBefore);

  ui.press('c');
  dispatch(ui.canvas, 'contextmenu', { clientX: 440, clientY: 330 });
  assert.equal(blurListeners(), blurBefore, 'a right click removes them');
  ui.press('c');
  ui.press('Tab');
  assert.equal(blurListeners(), blurBefore, 'leaving edit mode removes them');
});

test('the wheel through the page sums a trackpad gesture', async testContext => {
  const ui = mountStudioWithWindow(testContext);
  ui.press('Tab');
  await untilEditing(ui);
  ui.press('c');
  const radiusAfter = deltas => {
    ui.press('Escape');
    ui.press('c');
    for (const deltaY of deltas) dispatch(ui.canvas, 'wheel', { deltaY });
    ui.studio.renderNow();
    dispatch(ui.viewport, 'pointermove', { clientX: 440, clientY: 330 });
    ui.studio.renderNow();
    return Number(ui.root.querySelector('.crucible-studio-cage-brush').getAttribute('d').match(/a(\d+) /)[1]);
  };
  // The radius stays between sessions, so each gesture is measured from where the last one left it.
  const start = radiusAfter([]);
  const manyEvents = radiusAfter(Array.from({ length: 30 }, () => -10));
  assert.ok(manyEvents > start, 'thirty small events up make the brush bigger');
  assert.equal(radiusAfter([300]), start, 'one 300 px event down is three steps, the same three that thirty small ones made');
  assert.equal(radiusAfter([-300]), manyEvents, 'one 300 px event up gives what thirty 10 px events gave');
});
