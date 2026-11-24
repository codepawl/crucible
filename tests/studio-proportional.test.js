import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { markLiveGeometry } from '../src/live-geometry.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { byDataset, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';
import { MAX_PROPORTIONAL_SEEDS, PROPORTIONAL_CURVES, createProportionalSettings, proportionalCirclePath } from '../src/studio-proportional.js';
import { createMeshEditor, planMeshMove } from '../src/studio-mesh-edit.js';
import { FALLOFF_CURVES } from '../src/mesh-ops.js';
import { meshFromGeometry } from '../src/mesh.js';
import { grid } from '../src/geometry.js';

const CAMERA = { eye: [0, 0, 3], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };

function recipeOfPlane() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [{ id: 'shape', type: 'mesh', base: { type: 'grid', segments: 10 } }],
    nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }],
    camera: CAMERA,
  };
}

function mount() {
  const controller = createStudioController({ scene: createAgentScene(recipeOfPlane()), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  const updatePart = (renderer, part, positions, normals) => {
    part.geometry.positions.set(positions);
    if (normals) part.geometry.normals.set(normals);
    markLiveGeometry(part.geometry);
  };
  const proportional = createProportionalSettings();
  const editor = createMeshEditor({ controller, getRenderer: () => ({}), updatePart, proportional });
  return { controller, editor, proportional };
}

function heroPart(controller) {
  return controller.scene.parts.find(part => part.name === 'hero');
}

function editorMesh(controller) {
  return meshEditSourceOf(heroPart(controller).geometry).mesh;
}

function centreVertex(controller) {
  const mesh = editorMesh(controller);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    if (Math.abs(mesh.positions[vertex * 3]) < 1e-5 && Math.abs(mesh.positions[vertex * 3 + 1]) < 1e-5) return vertex;
  }
  throw new Error('the plane has no centre vertex');
}

function pickCentre(controller, editor) {
  editor.enter();
  editor.setMode('vertex');
  const vertex = centreVertex(controller);
  const pixel = controller.projectWorldPoint([0, 0, 0]);
  editor.pick(pixel.x, pixel.y);
  assert.deepEqual(editor.selection.indices, [vertex]);
  return vertex;
}

function logOf(controller) {
  return controller.exportRecipe().geometries.find(geometry => geometry.id === 'shape').edits ?? [];
}

function holdMove(controller, deltaX, deltaY) {
  const origin = controller.gizmoHandles().origin;
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  return () => controller.updateGizmoDrag(origin.x + deltaX, origin.y + deltaY);
}

test('a held move with proportional on writes one translate with the radius and curve, naming the vertex it moved', () => {
  const { controller, editor, proportional } = mount();
  const vertex = pickCentre(controller, editor);
  proportional.setEnabled(true);
  proportional.setRadius(0.3);
  proportional.setCurve('linear');
  holdMove(controller, 40, -30)();
  controller.endGizmoDrag();
  assert.equal(logOf(controller).length, 1);
  const [entry] = logOf(controller);
  assert.equal(entry.op, 'translate');
  assert.deepEqual(entry.select, { vertices: [vertex] });
  assert.deepEqual(entry.falloff, { radius: 0.3, curve: 'linear' });
});

test('the hill: neighbours of the moved vertex follow by the curve weight and nothing outside the radius moves', () => {
  const { controller, editor, proportional } = mount();
  const before = Float32Array.from(editorMesh(controller).positions);
  const centre = pickCentre(controller, editor);
  proportional.setEnabled(true);
  proportional.setRadius(0.35);
  holdMove(controller, 50, 20)();
  controller.endGizmoDrag();
  const after = editorMesh(controller).positions;
  const shift = vertex => [0, 1, 2].map(axis => after[vertex * 3 + axis] - before[vertex * 3 + axis]);
  const centreShift = shift(centre);
  assert.ok(Math.hypot(...centreShift) > 0.05, 'the picked vertex moved');
  let reached = 0;
  for (let vertex = 0; vertex < before.length / 3; vertex += 1) {
    const distance = Math.hypot(before[vertex * 3], before[vertex * 3 + 1]);
    const moved = shift(vertex);
    if (distance > 0.35) {
      assert.deepEqual(moved, [0, 0, 0], `vertex ${vertex} is outside the radius`);
    } else if (vertex !== centre) {
      reached += 1;
      const weight = FALLOFF_CURVES.smooth(distance / 0.35);
      moved.forEach((component, axis) => assert.ok(Math.abs(component - weight * centreShift[axis]) < 5e-4, `vertex ${vertex} follows with weight ${weight.toFixed(3)}`));
    }
  }
  assert.ok(reached >= 20, `${reached} neighbours follow`);
});

test('without proportional editing the same move is a set_position of the one vertex, as before', () => {
  const { controller, editor } = mount();
  pickCentre(controller, editor);
  holdMove(controller, 30, 10)();
  controller.endGizmoDrag();
  assert.equal(logOf(controller)[0].op, 'set_position');
});

test('the radius changed while the move is held widens the hill and is the radius the edit stores', () => {
  const { controller, editor, proportional } = mount();
  pickCentre(controller, editor);
  proportional.setEnabled(true);
  proportional.setRadius(0.15);
  const update = holdMove(controller, 40, 0);
  update();
  const before = Float32Array.from(editor.cage.positions);
  assert.equal(editor.holdingMove, true);
  proportional.setRadius(0.5);
  editor.reweighDrag();
  const wider = editor.cage.positions;
  let changed = 0;
  for (let index = 0; index < wider.length; index += 1) if (Math.abs(wider[index] - before[index]) > 1e-6) changed += 1;
  assert.ok(changed > 0, 'vertices that were outside 0.15 follow now');
  controller.endGizmoDrag();
  assert.equal(logOf(controller)[0].falloff.radius, 0.5);
  assert.equal(editor.holdingMove, false);
});

test('planMeshMove: whole faces keep their face selection, other picks name their vertices, and a long pick is refused', () => {
  const mesh = meshFromGeometry(grid(10));
  const falloff = { radius: 0.4, curve: 'sphere' };
  const faceVertices = [...mesh.cornerVertices.subarray(mesh.faceOffsets[0], mesh.faceOffsets[1])];
  const face = planMeshMove(mesh, faceVertices, [0, 0, 0.2], falloff);
  assert.equal(face.op, 'translate');
  assert.deepEqual(face.select, { faces: [0] });
  assert.deepEqual(face.falloff, falloff);
  const single = planMeshMove(mesh, [7], [0, 0, 0.2], falloff);
  assert.deepEqual(single.select, { vertices: [7] });
  assert.equal(planMeshMove(mesh, [7], [0, 0, 0.2]).op, 'set_position');
  const many = Array.from({ length: MAX_PROPORTIONAL_SEEDS + 1 }, (_, vertex) => vertex);
  assert.throws(() => planMeshMove({ ...mesh, vertexCount: 1000 }, many, [0, 0, 1], falloff), /at most 256 vertices/);
});

test('the settings validate what they are given and the wheel step scales the radius', () => {
  const changes = [];
  const settings = createProportionalSettings({ onChange: () => changes.push(1) });
  assert.equal(settings.falloff(), null);
  settings.setEnabled(true);
  assert.deepEqual(settings.falloff(), { radius: 0.5, curve: 'smooth' });
  settings.resize(1);
  assert.equal(settings.radius, 0.575);
  settings.resize(-2);
  assert.ok(settings.radius < 0.5);
  for (let step = 0; step < 100; step += 1) settings.resize(-1);
  assert.equal(settings.radius, 0.01, 'the radius stops at its lower limit');
  assert.throws(() => settings.setRadius(0), /number above 0/);
  assert.throws(() => settings.setCurve('bumpy'), /one of smooth, sphere, root, sharp, linear, constant/);
  assert.equal(PROPORTIONAL_CURVES.length, 6);
  assert.ok(changes.length > 5);
});

test('the reach circle is a closed path of points facing the camera', () => {
  const project = point => ({ x: 400 + point[0] * 100, y: 300 - point[1] * 100, visible: true });
  const path = proportionalCirclePath([0, 0, 0], 1, [0, 0, -1], project);
  assert.match(path, /^M500\.0 300\.0L/);
  assert.ok(path.endsWith('Z'));
  assert.equal(path.split('L').length, 64);
  assert.equal(proportionalCirclePath([0, 0, 0], 1, [0, 0, -1], () => ({ x: 0, y: 0, visible: false })), '');
});

function outputOf(popover) {
  return popover.descendants().find(element => element.tagName?.toLowerCase() === 'output');
}

const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

async function untilEditing(root) {
  for (let attempt = 0; attempt < 2000 && root.dataset.meshEdit !== 'true'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(root.dataset.meshEdit, 'true');
}

test('O, the wheel and the popover through the page', async testContext => {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: recipeOfPlane(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  const canvas = viewport.querySelector('canvas');
  studio.renderNow();
  const { controller } = studio;
  controller.selectNode('hero');
  const press = (key, properties = {}) => dispatch(dom.document, 'keydown', { key, ...properties });
  const toggle = byDataset(root, 'proportional', 'toggle');
  const group = byDataset(root, 'meshGroup', 'true');
  assert.equal(group.hidden, true, 'the toggle is part of edit mode only');

  press('Tab');
  await untilEditing(root);
  assert.equal(group.hidden, false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.match(toggle.title, /Proportional editing \(O\)/);

  press('o');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true', 'O turns it on');
  studio.renderNow();
  assert.equal(root.querySelector('.crucible-studio-proportional-reach'), null, 'no circle until something is picked');

  press('1');
  const centre = controller.projectWorldPoint([0, 0, 0]);
  const point = { clientX: VIEWPORT_BOX.left + centre.x, clientY: VIEWPORT_BOX.top + centre.y };
  dispatch(canvas, 'pointerdown', { ...point, button: 0 });
  dispatch(viewport, 'pointerup', point);
  studio.renderNow();
  assert.ok(root.querySelector('.crucible-studio-proportional-reach'), 'the radius circle is drawn around the pick');

  const popover = root.descendants().find(element => element.id === 'crucible-studio-pop-proportional');
  assert.ok(popover, 'the popover exists');
  const curveButtons = popover.descendants().filter(element => element.dataset.proportionalCurve !== undefined);
  assert.deepEqual(curveButtons.map(button => button.dataset.proportionalCurve), PROPORTIONAL_CURVES.map(curve => curve.id));
  curveButtons.find(button => button.dataset.proportionalCurve === 'sharp').click();
  assert.equal(curveButtons.find(button => button.dataset.proportionalCurve === 'sharp').getAttribute('aria-pressed'), 'true');
  const slider = byDataset(popover, 'proportionalSize', 'true');
  slider.value = '0.5';
  dispatch(slider, 'input');
  const sizeReadout = outputOf(popover).textContent;
  assert.ok(Number(sizeReadout) > 0.05 && Number(sizeReadout) < 5, `the slider sets a size (${sizeReadout})`);

  // The wheel zooms until a move is held, then sets the radius.
  const eyeBefore = [...controller.exportRecipe().camera.eye];
  const radiusBefore = Number(outputOf(popover).textContent);
  const origin = controller.gizmoHandles().origin;
  controller.beginGizmoDrag('screen', origin.x, origin.y);
  controller.updateGizmoDrag(origin.x + 30, origin.y);
  dispatch(canvas, 'wheel', { deltaY: -100 });
  const radiusAfter = Number(outputOf(popover).textContent);
  assert.ok(radiusAfter > radiusBefore, `the wheel widens the radius (${radiusBefore} to ${radiusAfter})`);
  assert.deepEqual(controller.exportRecipe().camera.eye, eyeBefore, 'and does not zoom');
  controller.endGizmoDrag();
  const [entry] = controller.exportRecipe().geometries.find(geometry => geometry.id === 'shape').edits;
  assert.deepEqual(entry.falloff, { radius: radiusAfter, curve: 'sharp' });

  press('o');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false', 'O again turns it off');
});
