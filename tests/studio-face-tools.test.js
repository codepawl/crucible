import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { createStudio } from '../src/studio.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

// E (extrude) and I (inset) on picked faces through the page's keys, clicks and pointer, on a box and a cylinder (#3435).
const CAMERA = { eye: [2.2, 2.4, 4.2], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };
const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

function recipeOf(base) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [{ id: 'shape', type: 'mesh', base }],
    nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }],
    camera: CAMERA,
  };
}

function mountStudio(testContext, base) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: recipeOf(base), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  studio.renderNow();
  studio.controller.selectNode('hero');
  const canvas = viewport.querySelector('canvas');
  const press = (key, properties = {}) => dispatch(dom.document, 'keydown', { key, ...properties });
  const pixelOf = point => {
    const pixel = studio.controller.projectWorldPoint(point);
    return { clientX: VIEWPORT_BOX.left + pixel.x, clientY: VIEWPORT_BOX.top + pixel.y };
  };
  const click = point => {
    const at = pixelOf(point);
    dispatch(canvas, 'pointerdown', { ...at, button: 0 });
    dispatch(viewport, 'pointerup', at);
    studio.renderNow();
  };
  // Where the pointer rests (the tool starts there), then how it moves while the tool is held.
  const hover = at => dispatch(viewport, 'pointermove', at);
  const movePointer = at => dispatch(dom.document, 'pointermove', at);
  const pressButton = button => dispatch(dom.document, 'pointerdown', { button });
  const status = () => root.querySelector('.crucible-studio-status').textContent;
  return { dom, studio, root, press, click, hover, movePointer, pressButton, status, controller: studio.controller };
}

function meshOf(ui) {
  return meshEditSourceOf(ui.controller.scene.parts.find(candidate => candidate.name === 'hero').geometry).mesh;
}

function logOf(ui) {
  return ui.controller.exportRecipe().geometries.find(geometry => geometry.id === 'shape').edits ?? [];
}

function faceCentre(mesh, face) {
  const centre = [0, 0, 0];
  const first = mesh.faceOffsets[face];
  const end = mesh.faceOffsets[face + 1];
  for (let corner = first; corner < end; corner += 1) {
    for (let axis = 0; axis < 3; axis += 1) centre[axis] += mesh.positions[mesh.cornerVertices[corner] * 3 + axis] / (end - first);
  }
  return centre;
}

// The face whose centre lies furthest along `direction`: the top of a box or a cylinder, the side facing +x.
function faceToward(mesh, direction) {
  let best = 0;
  let bestScore = -Infinity;
  for (let face = 0; face < mesh.faceCount; face += 1) {
    const centre = faceCentre(mesh, face);
    const score = centre[0] * direction[0] + centre[1] * direction[1] + centre[2] * direction[2];
    if (score > bestScore) {
      best = face;
      bestScore = score;
    }
  }
  return best;
}

async function editing(testContext, base) {
  const ui = mountStudio(testContext, base);
  ui.press('Tab');
  for (let attempt = 0; attempt < 2000 && ui.root.dataset.meshEdit !== 'true'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(ui.root.dataset.meshEdit, 'true');
  ui.press('3');
  return ui;
}

function pickTopFace(ui) {
  const mesh = meshOf(ui);
  const top = faceToward(mesh, [0, 1, 0]);
  ui.click(faceCentre(mesh, top));
  assert.deepEqual(ui.controller.selectedNodeId, 'hero');
  return { top, centre: faceCentre(mesh, top) };
}

function heightOfTop(ui) {
  const mesh = meshOf(ui);
  return Math.max(...Array.from({ length: mesh.vertexCount }, (_unused, vertex) => mesh.positions[vertex * 3 + 1]));
}

function positionsOf(ui) {
  return Array.from(meshOf(ui).positions);
}

// What the cage draws for the picked faces, which a held tool changes before anything is written.
function drawnPositionsOf(ui) {
  return ui.root.querySelector('.crucible-studio-cage-selected-face')?.getAttribute('d') ?? '';
}

// Press the key with the pointer on the top face, drag it `pixels` up the screen and confirm with a click.
function holdTool(ui, key, centre, pixels) {
  const start = ui.controller.projectWorldPoint(centre);
  const at = { clientX: VIEWPORT_BOX.left + start.x, clientY: VIEWPORT_BOX.top + start.y };
  ui.hover(at);
  ui.press(key);
  ui.movePointer({ clientX: at.clientX, clientY: at.clientY - pixels });
  ui.studio.renderNow();
  return () => ui.pressButton(0);
}

for (const [name, base] of [['box', { type: 'box', bevel: 0 }], ['cylinder', { type: 'cylinder', segments: 8, bevel: 0 }]]) {
  test(`E on the top face of a ${name} holds it at the pointer, a click writes one extrude_face_region and undo and redo agree`, async testContext => {
    const ui = await editing(testContext, base);
    const { centre } = pickTopFace(ui);
    const before = positionsOf(ui);
    const heightBefore = heightOfTop(ui);
    const facesBefore = meshOf(ui).faceCount;
    const drawnBefore = drawnPositionsOf(ui);
    const confirm = holdTool(ui, 'e', centre, 80);
    assert.equal(logOf(ui).length, 0, 'nothing is written while the tool is held');
    assert.notEqual(drawnPositionsOf(ui), drawnBefore, 'the held faces show the distance the pointer sets');
    confirm();
    const log = logOf(ui);
    assert.equal(log.length, 1);
    assert.equal(log[0].op, 'extrude_face_region');
    assert.ok(log[0].offset > 0.05, `the offset follows the pointer, got ${log[0].offset}`);
    assert.ok(meshOf(ui).faceCount > facesBefore, 'the sides of the extrusion are new faces');
    assert.ok(Math.abs(heightOfTop(ui) - (heightBefore + log[0].offset)) < 1e-4, 'the cap stands where it was held');
    const after = positionsOf(ui);
    ui.press('z', { ctrlKey: true });
    assert.deepEqual(positionsOf(ui), before, 'one undo restores the mesh');
    assert.equal(logOf(ui).length, 0);
    ui.press('z', { ctrlKey: true, shiftKey: true });
    assert.deepEqual(positionsOf(ui), after, 'redo gives the same positions');
    assert.equal(logOf(ui).length, 1);
  });

  test(`I on the top face of a ${name} writes one inset_region with the thickness the pointer set, one undo takes it back`, async testContext => {
    const ui = await editing(testContext, base);
    const { centre } = pickTopFace(ui);
    const before = positionsOf(ui);
    const facesBefore = meshOf(ui).faceCount;
    const confirm = holdTool(ui, 'i', centre, 20);
    assert.equal(logOf(ui).length, 0);
    confirm();
    const log = logOf(ui);
    assert.equal(log.length, 1);
    assert.equal(log[0].op, 'inset_region');
    assert.ok(log[0].thickness > 0.01, `the thickness follows the pointer, got ${log[0].thickness}`);
    assert.ok(meshOf(ui).faceCount > facesBefore, 'the rim is new faces');
    const after = positionsOf(ui);
    ui.press('z', { ctrlKey: true });
    assert.deepEqual(positionsOf(ui), before);
    ui.press('z', { ctrlKey: true, shiftKey: true });
    assert.deepEqual(positionsOf(ui), after);
  });
}

test('Esc and a right click put a held extrude or inset back and leave no edit', async testContext => {
  const ui = await editing(testContext, { type: 'box', bevel: 0 });
  const { centre } = pickTopFace(ui);
  const before = drawnPositionsOf(ui);
  holdTool(ui, 'e', centre, 80);
  assert.notEqual(drawnPositionsOf(ui), before);
  ui.press('Escape');
  ui.studio.renderNow();
  assert.equal(drawnPositionsOf(ui), before, 'Esc puts the faces back');
  assert.equal(logOf(ui).length, 0);
  holdTool(ui, 'i', centre, 30);
  assert.notEqual(drawnPositionsOf(ui), before);
  ui.pressButton(2);
  ui.studio.renderNow();
  assert.equal(drawnPositionsOf(ui), before, 'a right click puts the faces back');
  assert.equal(logOf(ui).length, 0);
  assert.equal(ui.controller.exportRecipe().geometries.find(geometry => geometry.id === 'shape').edits, undefined);
  holdTool(ui, 'e', centre, 40);
  ui.press('Enter');
  assert.equal(logOf(ui).length, 1, 'Enter confirms');
});

test('E and I on a pick that is not whole faces say to pick faces and start nothing', async testContext => {
  const ui = await editing(testContext, { type: 'box', bevel: 0 });
  ui.press('1');
  const mesh = meshOf(ui);
  ui.click([mesh.positions[0], mesh.positions[1], mesh.positions[2]]);
  for (const key of ['e', 'i']) {
    ui.press(key);
    assert.match(ui.status(), /Pick whole faces to (extrude|inset): press 3 for face mode/);
  }
  ui.movePointer({ clientX: 300, clientY: 200 });
  ui.pressButton(0);
  assert.equal(logOf(ui).length, 0);
  ui.press('3');
  ui.press('e');
  assert.match(ui.status(), /Pick whole faces to extrude/, 'nothing picked in face mode gets the same notice');
});

test('a held tool refuses nothing else: keys other than Enter and Esc do not reach the object', async testContext => {
  const ui = await editing(testContext, { type: 'box', bevel: 0 });
  const { centre } = pickTopFace(ui);
  holdTool(ui, 'e', centre, 40);
  ui.press('Tab');
  assert.equal(ui.root.dataset.meshEdit, 'true', 'Tab does not leave edit mode while the tool is held');
  ui.press('Escape');
  assert.equal(logOf(ui).length, 0);
});
