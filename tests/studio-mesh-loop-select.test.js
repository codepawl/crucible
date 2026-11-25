import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { createStudio } from '../src/studio.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

// Loop, ring, linked, grow and shrink through the page's keys and clicks, on a cylinder of 8 sides (#3293).
const CAMERA = { eye: [0, 2, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };
const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
const SIDES = 8;

function recipeOf() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [{ id: 'shape', type: 'mesh', base: { type: 'cylinder', segments: SIDES, bevel: 0 } }],
    nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }],
    camera: CAMERA,
  };
}

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
  const canvas = viewport.querySelector('canvas');
  const press = (key, properties = {}) => dispatch(dom.document, 'keydown', { key, ...properties });
  const screenPoint = point => {
    const pixel = studio.controller.projectWorldPoint(point);
    return { clientX: VIEWPORT_BOX.left + pixel.x, clientY: VIEWPORT_BOX.top + pixel.y };
  };
  const click = (point, modifiers = {}) => {
    const at = screenPoint(point);
    dispatch(canvas, 'pointerdown', { ...at, button: 0, ...modifiers });
    dispatch(viewport, 'pointerup', { ...at, ...modifiers });
    studio.renderNow();
  };
  const hover = point => dispatch(viewport, 'pointermove', screenPoint(point));
  return { dom, studio, root, viewport, press, click, hover, controller: studio.controller };
}

async function untilEditing(ui) {
  for (let attempt = 0; attempt < 2000 && ui.root.dataset.meshEdit !== 'true'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(ui.root.dataset.meshEdit, 'true');
}

function meshOf(ui) {
  const part = ui.controller.scene.parts.find(candidate => candidate.name === 'hero');
  return meshEditSourceOf(part.geometry).mesh;
}

// How many subpaths of one selection path are drawn: one per edge in edge mode, one per face (each ends in Z) in face mode.
function selectedDrawn(ui, mode) {
  const path = ui.root.querySelector(`.crucible-studio-cage-selected-${mode}`);
  if (!path) return 0;
  return (path.getAttribute('d') ?? '').split('M').length - 1;
}

function pointOfVertex(mesh, vertex) {
  return [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
}

// The point halfway along an edge, in world space (the node sits at the origin).
function midpointOfEdge(mesh, edge) {
  const first = pointOfVertex(mesh, mesh.edgeVertices[edge * 2]);
  const second = pointOfVertex(mesh, mesh.edgeVertices[edge * 2 + 1]);
  return first.map((component, axis) => (component + second[axis]) / 2);
}

// The edge nearest the camera of one kind: 'ring' joins two vertices of the top ring, 'upright' joins the two rings.
function edgeFacingCamera(mesh, kind) {
  const topHeight = Math.max(...Array.from({ length: mesh.vertexCount }, (_unused, vertex) => mesh.positions[vertex * 3 + 1]));
  let best = null;
  for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
    const first = pointOfVertex(mesh, mesh.edgeVertices[edge * 2]);
    const second = pointOfVertex(mesh, mesh.edgeVertices[edge * 2 + 1]);
    const isUpright = Math.abs(first[1] - second[1]) > 0.5;
    const isOnRing = first[1] === topHeight && second[1] === topHeight && Math.hypot(first[0], first[2]) > 0.1 && Math.hypot(second[0], second[2]) > 0.1;
    if (kind === 'upright' ? !isUpright : !isOnRing) continue;
    const towardCamera = midpointOfEdge(mesh, edge)[2];
    if (best === null || towardCamera > best.towardCamera) best = { edge, towardCamera };
  }
  return best.edge;
}

async function editing(testContext) {
  const ui = mountStudio(testContext);
  ui.press('Tab');
  await untilEditing(ui);
  ui.press('2');
  ui.mesh = meshOf(ui);
  ui.ringEdgePoint = midpointOfEdge(ui.mesh, edgeFacingCamera(ui.mesh, 'ring'));
  ui.uprightEdgePoint = midpointOfEdge(ui.mesh, edgeFacingCamera(ui.mesh, 'upright'));
  return ui;
}

test('one Ctrl+Alt+click on an upright edge of a cylinder selects the ring of 8 edges round it', async testContext => {
  const ui = await editing(testContext);
  ui.click(ui.uprightEdgePoint);
  assert.equal(selectedDrawn(ui, 'edge'), 1, 'a plain click picks one edge');
  ui.click(ui.uprightEdgePoint, { altKey: true, ctrlKey: true });
  assert.equal(selectedDrawn(ui, 'edge'), SIDES, 'the ring runs round the cylinder');
});

test('one Alt+click in face mode near an upright edge selects the band of 8 faces round the cylinder', async testContext => {
  const ui = await editing(testContext);
  ui.press('3');
  ui.click([0.09, 0, 0.96]);
  assert.equal(selectedDrawn(ui, 'face'), 1, 'a plain click picks one face');
  ui.click([0.09, 0, 0.96], { altKey: true });
  assert.equal(selectedDrawn(ui, 'face'), SIDES);
});

test('Alt+click on an edge of the cylinder end stops at the corners where 3 edges meet, and Alt+Shift+click adds to the selection', async testContext => {
  const ui = await editing(testContext);
  ui.click(ui.ringEdgePoint, { altKey: true });
  assert.equal(selectedDrawn(ui, 'edge'), 2, 'the loop is cut short at a 3-valent corner');
  ui.click(ui.uprightEdgePoint, { altKey: true, ctrlKey: true, shiftKey: true });
  assert.equal(selectedDrawn(ui, 'edge'), 2 + SIDES, 'Shift adds the ring');
});

test('L selects what is linked under the pointer and Ctrl+L what is linked to the selection', async testContext => {
  const ui = await editing(testContext);
  ui.hover(ui.ringEdgePoint);
  ui.press('l');
  ui.studio.renderNow();
  assert.equal(selectedDrawn(ui, 'edge'), ui.mesh.edgeCount, 'the cylinder is one piece, so all its edges');
  ui.press('a', { code: 'KeyA', altKey: true });
  ui.click(ui.ringEdgePoint);
  const event = ui.press('l', { ctrlKey: true });
  ui.studio.renderNow();
  assert.equal(event.defaultPrevented, true, 'Ctrl+L is kept from the address bar');
  assert.equal(selectedDrawn(ui, 'edge'), ui.mesh.edgeCount);
});

test('the brackets and Ctrl with the numpad plus and minus grow and shrink the selection', async testContext => {
  const ui = await editing(testContext);
  ui.click(ui.ringEdgePoint);
  const grown = ui.press(']');
  ui.studio.renderNow();
  assert.equal(grown.defaultPrevented, true);
  const afterGrow = selectedDrawn(ui, 'edge');
  assert.ok(afterGrow > 1, `grow adds the edges next to the edge (${afterGrow})`);
  ui.press('[');
  ui.studio.renderNow();
  assert.equal(selectedDrawn(ui, 'edge'), 1, 'shrink takes them away again');
  ui.press('+', { code: 'NumpadAdd', ctrlKey: true });
  ui.studio.renderNow();
  assert.equal(selectedDrawn(ui, 'edge'), afterGrow, 'Ctrl+Numpad plus grows');
  ui.press('-', { code: 'NumpadSubtract', ctrlKey: true });
  ui.studio.renderNow();
  assert.equal(selectedDrawn(ui, 'edge'), 1, 'Ctrl+Numpad minus shrinks');
});
