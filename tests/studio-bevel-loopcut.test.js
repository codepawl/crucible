import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { createStudio } from '../src/studio.js';
import {
  MAX_BEVEL_SEGMENTS,
  MAX_LOOP_CUTS,
  bevelSelectionEdges,
  loopCutPreviewSegments,
  meshHasQuads,
  planMeshBevel,
  planMeshLoopCut,
} from '../src/studio-mesh-bevel-loop.js';
import { byText, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const CAMERA = { eye: [2.2, 2.4, 4.2], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };
const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

function recipeOf(base, edits) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [{ id: 'shape', type: 'mesh', base, ...(edits ? { edits } : {}) }],
    nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }],
    camera: CAMERA,
  };
}

function mountStudio(testContext, base, edits) {
  const dom = installStudioDom();
  const renderer = createFakeRenderer();
  const studio = createStudio(dom.container, { recipe: recipeOf(base, edits), renderer });
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
  const click = (point, modifiers = {}) => {
    const at = pixelOf(point);
    dispatch(canvas, 'pointerdown', { ...at, button: 0, ...modifiers });
    dispatch(viewport, 'pointerup', { ...at, ...modifiers });
    studio.renderNow();
    return at;
  };
  const hover = at => dispatch(viewport, 'pointermove', at);
  const movePointer = at => dispatch(dom.document, 'pointermove', at);
  const pressButton = (button, at = { clientX: VIEWPORT_BOX.left + 400, clientY: VIEWPORT_BOX.top + 300 }) => {
    dispatch(dom.document, 'pointerdown', { ...at, button });
  };
  const wheel = deltaY => dispatch(canvas, 'wheel', { deltaY });
  const status = () => root.querySelector('.crucible-studio-status').textContent;
  return { dom, studio, root, viewport, canvas, renderer, press, pixelOf, click, hover, movePointer, pressButton, wheel, status, controller: studio.controller };
}

function meshOf(ui) {
  return meshEditSourceOf(ui.controller.scene.parts.find(candidate => candidate.name === 'hero').geometry).mesh;
}

function logOf(ui) {
  return ui.controller.exportRecipe().geometries.find(geometry => geometry.id === 'shape').edits ?? [];
}

function positionsOf(ui) {
  return Array.from(meshOf(ui).positions);
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

function edgeMidpoint(mesh, edge) {
  const first = mesh.edgeVertices[edge * 2] * 3;
  const second = mesh.edgeVertices[edge * 2 + 1] * 3;
  return [
    (mesh.positions[first] + mesh.positions[second]) / 2,
    (mesh.positions[first + 1] + mesh.positions[second + 1]) / 2,
    (mesh.positions[first + 2] + mesh.positions[second + 2]) / 2,
  ];
}

function edgeToward(mesh, direction) {
  let best = 0;
  let bestScore = -Infinity;
  for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
    const mid = edgeMidpoint(mesh, edge);
    const score = mid[0] * direction[0] + mid[1] * direction[1] + mid[2] * direction[2];
    if (score > bestScore) {
      best = edge;
      bestScore = score;
    }
  }
  return best;
}

async function editing(testContext, base, edits) {
  const ui = mountStudio(testContext, base, edits);
  ui.press('Tab');
  for (let attempt = 0; attempt < 2000 && ui.root.dataset.meshEdit !== 'true'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(ui.root.dataset.meshEdit, 'true');
  return ui;
}

test('planMeshBevel and planMeshLoopCut validate inputs with clear errors', async testContext => {
  const ui = await editing(testContext, { type: 'box', bevel: 0 });
  const mesh = meshOf(ui);
  assert.equal(meshHasQuads(mesh), true);
  assert.throws(() => bevelSelectionEdges(mesh, 'edge', new Set()), /Pick at least one edge or face/);
  assert.throws(() => planMeshBevel(mesh, 'edge', new Set([0]), { width: 0 }), /above 0/);
  assert.throws(() => planMeshBevel(mesh, 'edge', new Set([0]), { width: 0.1, segments: 99 }), /from 1 to 16/);
  assert.throws(() => planMeshLoopCut(mesh, -1), /from 0 to/);
  assert.throws(() => planMeshLoopCut(mesh, 0, { cuts: 0 }), /from 1 to 16/);
  assert.throws(() => planMeshLoopCut(mesh, 0, { cuts: 1, factor: 1 }), /strictly between 0 and 1/);

  const multiCut = planMeshLoopCut(mesh, 0, { cuts: 3, factor: 0.25 });
  assert.equal(multiCut.op, 'loop_cut');
  assert.equal(multiCut.cuts, 3);
  assert.equal('factor' in multiCut, false);

  const singleCut = planMeshLoopCut(mesh, 0, { cuts: 1, factor: 0.3 });
  assert.deepEqual(singleCut, { op: 'loop_cut', edges: { edges: [[mesh.edgeVertices[0], mesh.edgeVertices[1]]] }, cuts: 1, factor: 0.3 });
});

test('Ctrl+B bevels selected edges with live preview, wheel/+- segments, undo/redo and save/reload round-trip', async testContext => {
  const ui = await editing(testContext, { type: 'box', bevel: 0 });
  ui.press('2');
  const mesh = meshOf(ui);
  const frontTopEdge = edgeToward(mesh, [0, 1, 1]);
  const start = ui.click(edgeMidpoint(mesh, frontTopEdge));
  const beforePositions = positionsOf(ui);
  const facesBefore = mesh.faceCount;
  const cageBefore = ui.root.querySelector('.crucible-studio-cage-edges')?.getAttribute('d') ?? '';

  ui.hover(start);
  ui.press('b', { ctrlKey: true });
  assert.match(ui.status(), /Bevel:/);
  ui.movePointer({ clientX: start.clientX + 45, clientY: start.clientY });
  ui.studio.renderNow();

  assert.equal(logOf(ui).length, 0, 'nothing written while bevel is held');
  const cageDuring = ui.root.querySelector('.crucible-studio-cage-edges')?.getAttribute('d') ?? '';
  assert.notEqual(cageDuring, cageBefore, 'live bevel preview updates the cage');

  // Wheel up and + increase segments; wheel down and - decrease segments.
  ui.wheel(-100);
  ui.press('+');
  ui.studio.renderNow();
  assert.match(ui.status(), /3 segments/);
  ui.wheel(100);
  ui.press('-');
  ui.studio.renderNow();
  assert.match(ui.status(), /1 segment/);

  // Raise segments to 3 and confirm with click.
  ui.press('+');
  ui.press('+');
  ui.pressButton(0);
  const log = logOf(ui);
  assert.equal(log.length, 1);
  assert.equal(log[0].op, 'bevel');
  assert.equal(log[0].segments, 3);
  assert.ok(log[0].width > 0.05);
  assert.ok(meshOf(ui).faceCount > facesBefore);

  const afterPositions = positionsOf(ui);
  const savedRecipe = ui.controller.exportRecipe();

  // One undo restores original mesh; redo reproduces beveled mesh.
  ui.press('z', { ctrlKey: true });
  assert.deepEqual(positionsOf(ui), beforePositions);
  assert.equal(logOf(ui).length, 0);
  ui.press('z', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(positionsOf(ui), afterPositions);
  assert.equal(logOf(ui).length, 1);

  // Save and reload reproduces the exact same beveled geometry.
  ui.studio.loadRecipe(savedRecipe);
  ui.studio.renderNow();
  assert.deepEqual(positionsOf(ui), afterPositions);
});

test('Ctrl+B in face mode bevels face edges, clamps segments to 1..16, and Esc/right-click cancel cleanly', async testContext => {
  const ui = await editing(testContext, { type: 'box', bevel: 0 });
  ui.press('3');
  const topFace = faceToward(meshOf(ui), [0, 1, 0]);
  const start = ui.click(faceCentre(meshOf(ui), topFace));
  const cageBefore = ui.root.querySelector('.crucible-studio-cage-edges')?.getAttribute('d') ?? '';

  ui.hover(start);
  ui.press('b', { ctrlKey: true });
  ui.movePointer({ clientX: start.clientX + 40, clientY: start.clientY });
  ui.studio.renderNow();
  assert.notEqual(ui.root.querySelector('.crucible-studio-cage-edges')?.getAttribute('d'), cageBefore);

  // Other keys do not leave edit mode while bevel is held.
  ui.press('Tab');
  assert.equal(ui.root.dataset.meshEdit, 'true');

  // Esc puts everything back.
  ui.press('Escape');
  ui.studio.renderNow();
  assert.equal(ui.root.querySelector('.crucible-studio-cage-edges')?.getAttribute('d'), cageBefore);
  assert.equal(logOf(ui).length, 0);

  // Right click also cancels cleanly.
  ui.hover(start);
  ui.press('b', { ctrlKey: true });
  ui.movePointer({ clientX: start.clientX + 35, clientY: start.clientY });
  ui.pressButton(2);
  ui.studio.renderNow();
  assert.equal(logOf(ui).length, 0);

  // Segment upper bound clamps at MAX_BEVEL_SEGMENTS (16), Enter confirms.
  ui.hover(start);
  ui.press('b', { ctrlKey: true });
  ui.movePointer({ clientX: start.clientX + 30, clientY: start.clientY });
  for (let step = 0; step < 25; step += 1) ui.press('+');
  ui.press('Enter');
  assert.equal(logOf(ui).length, 1);
  assert.equal(logOf(ui)[0].segments, MAX_BEVEL_SEGMENTS);
  assert.equal(logOf(ui)[0].edges.edges.length, 4);
});

test('Ctrl+R loop cut previews ring on hover, adjusts cuts, slides on click, confirms 1 undo step, and round-trips', async testContext => {
  const ui = await editing(testContext, { type: 'box', bevel: 0 });
  const meshBefore = meshOf(ui);
  const beforePositions = positionsOf(ui);
  const verticalEdge = edgeToward(meshBefore, [1, 0, 1]);
  const hoverAt = ui.pixelOf(edgeMidpoint(meshBefore, verticalEdge));

  ui.hover(hoverAt);
  ui.press('r', { ctrlKey: true });
  ui.studio.renderNow();
  assert.match(ui.status(), /Loop cut:/);
  const singleCutPath = ui.root.querySelector('.crucible-studio-cage-loop-cut')?.getAttribute('d') ?? '';
  assert.ok(singleCutPath.length > 0, 'loop cut preview line draws over hovered ring');

  // Wheel / + increases cuts and draws more segments.
  ui.wheel(-100);
  ui.press('+');
  ui.studio.renderNow();
  assert.match(ui.status(), /3 cuts/);
  const multiCutPath = ui.root.querySelector('.crucible-studio-cage-loop-cut')?.getAttribute('d') ?? '';
  assert.ok(multiCutPath.split('M').length > singleCutPath.split('M').length);

  // Reduce back to 1 cut, click to lock & slide, move pointer, click to confirm.
  ui.press('-');
  ui.wheel(100);
  assert.match(ui.status(), /1 cut/);
  ui.pressButton(0, hoverAt);
  assert.equal(logOf(ui).length, 0, 'first click locks the loop without committing');
  assert.match(ui.status(), /slide/);

  ui.movePointer({ clientX: hoverAt.clientX, clientY: hoverAt.clientY - 35 });
  ui.studio.renderNow();
  ui.pressButton(0, { clientX: hoverAt.clientX, clientY: hoverAt.clientY - 35 });

  const log = logOf(ui);
  assert.equal(log.length, 1);
  assert.equal(log[0].op, 'loop_cut');
  assert.equal(log[0].cuts, 1);
  assert.ok(log[0].factor > 0.5 && log[0].factor < 1, `slide moved factor upward, got ${log[0].factor}`);
  assert.equal(meshOf(ui).faceCount, meshBefore.faceCount + 4);

  const afterPositions = positionsOf(ui);
  const savedRecipe = ui.controller.exportRecipe();

  // Undo / redo.
  ui.press('z', { ctrlKey: true });
  assert.deepEqual(positionsOf(ui), beforePositions);
  ui.press('z', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(positionsOf(ui), afterPositions);

  // Save & reload round-trip.
  ui.studio.loadRecipe(savedRecipe);
  ui.studio.renderNow();
  assert.deepEqual(positionsOf(ui), afterPositions);
});

test('Ctrl+R multi-cut omits factor in recipe, clamps to 1..16, and Esc/right-click cancel in hover and slide', async testContext => {
  const ui = await editing(testContext, { type: 'box', bevel: 0 });
  const mesh = meshOf(ui);
  const hoverAt = ui.pixelOf(edgeMidpoint(mesh, edgeToward(mesh, [1, 0, 1])));

  // Esc cancels during hover.
  ui.hover(hoverAt);
  ui.press('r', { ctrlKey: true });
  ui.studio.renderNow();
  assert.ok(ui.root.querySelector('.crucible-studio-cage-loop-cut'));
  ui.press('Escape');
  ui.studio.renderNow();
  assert.equal(ui.root.querySelector('.crucible-studio-cage-loop-cut'), null);
  assert.equal(logOf(ui).length, 0);

  // Right click cancels during slide phase.
  ui.hover(hoverAt);
  ui.press('r', { ctrlKey: true });
  ui.pressButton(0, hoverAt);
  ui.movePointer({ clientX: hoverAt.clientX, clientY: hoverAt.clientY + 20 });
  ui.pressButton(2, hoverAt);
  ui.studio.renderNow();
  assert.equal(logOf(ui).length, 0);

  // Multi-cut clamps to MAX_LOOP_CUTS (16) and omits factor when confirmed with Enter.
  ui.hover(hoverAt);
  ui.press('r', { ctrlKey: true });
  for (let step = 0; step < 25; step += 1) ui.press('+');
  ui.press('Enter');
  const log = logOf(ui);
  assert.equal(log.length, 1);
  assert.equal(log[0].op, 'loop_cut');
  assert.equal(log[0].cuts, MAX_LOOP_CUTS);
  assert.equal('factor' in log[0], false);
  assert.equal(loopCutPreviewSegments(mesh, { edges: new Map([[0, mesh.edgeVertices[0]]]), quads: [] }, 2, 0.5).length, 0);
});

test('Bevel refuses empty picks and boundary edges, works from Mesh tools menu, and B still starts box select', async testContext => {
  const openUi = await editing(testContext, { type: 'box', bevel: 0 }, [{ op: 'delete', select: { tag: 'top' } }]);
  openUi.press('b', { ctrlKey: true });
  assert.match(openUi.status(), /Pick at least one edge or face to bevel/);

  openUi.press('2');
  const openMesh = meshOf(openUi);
  const topRimEdge = edgeToward(openMesh, [0, 1, 1]);
  openUi.click(edgeMidpoint(openMesh, topRimEdge));
  openUi.press('b', { ctrlKey: true });
  assert.match(openUi.status(), /two faces|two consistently wound faces/);
  assert.equal(logOf(openUi).length, 1, 'boundary bevel refusal leaves only the initial delete edit');

  // B without Ctrl still arms box select.
  openUi.press('b');
  assert.match(openUi.status(), /Drag a rectangle/);
  openUi.press('Escape');

  // Mesh tools menu starts Loop cut and Bevel.
  const toolsPopover = openUi.root.querySelector('#crucible-studio-pop-mesh-tools');
  assert.ok(byText(toolsPopover, 'Bevel'));
  assert.ok(byText(toolsPopover, 'Loop cut'));
  byText(toolsPopover, 'Loop cut').click();
  assert.match(openUi.status(), /Loop cut:/);
  openUi.press('Escape');
});

test('Loop cut refuses pure-triangle meshes and both tools refuse a full 64-edit log', async testContext => {
  const triUi = await editing(testContext, { type: 'icoSphere', subdivisions: 1 });
  triUi.press('r', { ctrlKey: true });
  assert.match(triUi.status(), /Loop cut needs quad faces/);
  assert.equal(logOf(triUi).length, 0);
});

test('Bevel and Loop cut refuse a mesh whose 64-edit log is full', async testContext => {
  const fullEdits = Array.from({ length: 64 }, () => ({ op: 'translate', select: { tag: 'top' }, offset: [0, 0.001, 0] }));
  const fullUi = await editing(testContext, { type: 'box', bevel: 0 }, fullEdits);
  fullUi.press('r', { ctrlKey: true });
  assert.match(fullUi.status(), /64 edits/);
  fullUi.press('b', { ctrlKey: true });
  assert.match(fullUi.status(), /64 edits/);
});
