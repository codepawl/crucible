import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { box, cylinder } from '../src/geometry.js';
import { lintMesh } from '../src/mesh-lint.js';
import { makeFace } from '../src/mesh-make-face.js';
import { applyMeshEdits, normalizeMeshEdits } from '../src/mesh-recipe.js';
import { meshFromGeometry } from '../src/mesh.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { createMeshEditor, planMeshBridge, planMeshFill, planMeshGridFill, planMeshMakeFace, planMeshSubdivide, planMeshSymmetrize } from '../src/studio-mesh-edit.js';
import { byText, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const CAMERA = { eye: [0.8, 1.4, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };
const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

function recipeOf({ base = { type: 'box', bevel: 0 }, edits } = {}) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [{ id: 'shape', type: 'mesh', base, ...(edits ? { edits } : {}) }],
    nodes: [{ id: 'hero', geometry: 'shape', material: 'grey' }],
    camera: CAMERA,
  };
}

function mountEditor(recipe = recipeOf()) {
  const controller = createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  const messages = [];
  const editor = createMeshEditor({ controller, announce: message => messages.push(message), getRenderer: () => ({}), updatePart: () => {} });
  editor.enter();
  return { controller, editor, messages };
}

function heroMesh(controller) {
  const part = controller.scene.parts.find(candidate => candidate.name === 'hero');
  return meshEditSourceOf(part.geometry).mesh;
}

function heroLog(controller) {
  return controller.exportRecipe().geometries.find(geometry => geometry.id === 'shape').edits ?? [];
}

function worldPointOf(controller, vertex) {
  const mesh = heroMesh(controller);
  const matrix = controller.scene.parts.find(candidate => candidate.name === 'hero').matrix;
  const x = mesh.positions[vertex * 3];
  const y = mesh.positions[vertex * 3 + 1];
  const z = mesh.positions[vertex * 3 + 2];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function pixelOfVertex(controller, vertex) {
  return controller.projectWorldPoint(worldPointOf(controller, vertex));
}

function pickVertices(controller, editor, vertices) {
  editor.setMode('vertex');
  vertices.forEach((vertex, order) => {
    const pixel = pixelOfVertex(controller, vertex);
    editor.pick(pixel.x, pixel.y, { additive: order > 0 });
  });
}

function selectEdgesInBox(controller, editor, edgeIndices, { additive = false } = {}) {
  const mesh = heroMesh(controller);
  editor.setMode('edge');
  editor.setSeeThrough(true);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const edge of edgeIndices) {
    for (const vertex of [mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]]) {
      const pixel = pixelOfVertex(controller, vertex);
      minX = Math.min(minX, pixel.x);
      minY = Math.min(minY, pixel.y);
      maxX = Math.max(maxX, pixel.x);
      maxY = Math.max(maxY, pixel.y);
    }
  }
  editor.selectInRectangle(minX - 2, minY - 2, maxX + 2, maxY + 2, { additive });
}

function mountStudio(testContext, recipe = recipeOf()) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe, renderer: createFakeRenderer(), preferences: { motion: 'reduced' } });
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
  return { dom, studio, root, viewport, canvas: viewport.querySelector('canvas'), controller: studio.controller, press };
}

async function untilEditing(ui) {
  for (let attempt = 0; attempt < 2000 && ui.root.dataset.meshEdit !== 'true'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(ui.root.dataset.meshEdit, 'true');
}

test('make_face closes an open cylinder end from unsorted vertices and leaves a closed manifold mesh', () => {
  const baseCylinder = meshFromGeometry(cylinder(12, 0));
  const { mesh: openCylinder } = applyMeshEdits(baseCylinder, [{ op: 'delete', select: { tag: 'top' } }]);
  const topVertices = [];
  for (let vertex = 0; vertex < openCylinder.vertexCount; vertex += 1) {
    if (openCylinder.positions[vertex * 3 + 1] > 0.4) {
      topVertices.push(vertex);
    }
  }
  // Reverse/shuffle order to prove boundary-loop tracing orders the loop deterministically.
  const scrambled = [...topVertices].reverse();
  const { mesh: capped, results } = applyMeshEdits(openCylinder, [{ op: 'make_face', vertices: scrambled }]);
  assert.equal(capped.faceCount, openCylinder.faceCount + 1);
  assert.equal(results[0].createdFaces, 1);
  assert.equal(results[0].splitFaces, 0);
  assert.equal(lintMesh(capped).ok, true);
  assert.equal(lintMesh(capped).problems.some(problem => problem.kind === 'boundary-edge'), false);
});

test('make_face closes an open boundary chain and opposite edges with outward winding', () => {
  const cube = meshFromGeometry(box(0, 1));
  const { mesh: openTop } = applyMeshEdits(cube, [{ op: 'delete', select: { tag: 'top' } }]);
  const topVertices = [];
  for (let vertex = 0; vertex < openTop.vertexCount; vertex += 1) {
    if (openTop.positions[vertex * 3 + 1] > 0.4) {
      topVertices.push(vertex);
    }
  }
  const { mesh: closedBox } = applyMeshEdits(openTop, [{ op: 'make_face', vertices: topVertices }]);
  assert.equal(closedBox.faceCount, 6);
  assert.equal(lintMesh(closedBox).ok, true);
  assert.equal(lintMesh(closedBox).problems.length, 0);

  // Also test 3 vertices forming a 2-edge open chain across a missing quad corner.
  const cornerThree = topVertices.slice(0, 3);
  const { mesh: triangulatedCap } = applyMeshEdits(openTop, [{ op: 'make_face', vertices: cornerThree }]);
  assert.equal(triangulatedCap.faceCount, openTop.faceCount + 1);
  assert.equal(lintMesh(triangulatedCap).problems.some(problem => problem.kind === 'inconsistent-winding'), false);
});

test('make_face splits a quad face when two non-adjacent vertices on it are picked, and is deterministic', () => {
  const cube = meshFromGeometry(box(0, 1));
  const topCorners = [];
  for (let vertex = 0; vertex < cube.vertexCount; vertex += 1) {
    if (cube.positions[vertex * 3 + 1] > 0.4) {
      topCorners.push(vertex);
    }
  }
  const diagonalA = topCorners.find(vertex => cube.positions[vertex * 3] < 0 && cube.positions[vertex * 3 + 2] < 0);
  const diagonalB = topCorners.find(vertex => cube.positions[vertex * 3] > 0 && cube.positions[vertex * 3 + 2] > 0);
  const firstRun = applyMeshEdits(cube, [{ op: 'make_face', vertices: [diagonalA, diagonalB] }]);
  const secondRun = applyMeshEdits(cube, [{ op: 'make_face', vertices: [diagonalA, diagonalB] }]);
  assert.equal(firstRun.mesh.faceCount, 7);
  assert.equal(firstRun.results[0].splitFaces, 1);
  assert.equal(firstRun.results[0].createdFaces, 0);
  assert.deepEqual(Array.from(firstRun.mesh.positions), Array.from(secondRun.mesh.positions));
  assert.deepEqual(Array.from(firstRun.mesh.cornerVertices), Array.from(secondRun.mesh.cornerVertices));
});

test('make_face validates inputs and refuses duplicate faces, existing edges, loose edges and collinear vertices', () => {
  const cube = meshFromGeometry(box(0, 1));
  assert.throws(() => normalizeMeshEdits([{ op: 'make_face', vertices: [0] }]), /2 to 4096/);
  assert.throws(() => makeFace(cube, [0, 0]), /listed twice/);
  assert.throws(() => makeFace(cube, [0, 99]), /from 0 to 7/);
  assert.throws(() => makeFace(cube, [0, 1]), /already share an edge/);
  assert.throws(() => makeFace(cube, [0, 7]), /do not share a face; a mesh cannot hold a loose edge/);
  const existingTop = [1, 3, 5, 7];
  assert.throws(() => makeFace(cube, existingTop), /already exists/);
  const { mesh: split } = applyMeshEdits(cube, [{ op: 'subdivide_edges', edges: { all: true }, cuts: 1 }]);
  // Three collinear vertices along one subdivided edge cannot form a face.
  const collinear = [];
  for (let vertex = 0; vertex < split.vertexCount; vertex += 1) {
    if (Math.abs(split.positions[vertex * 3] + 0.5) < 1e-5 && Math.abs(split.positions[vertex * 3 + 1] - 0.5) < 1e-5) {
      collinear.push(vertex);
    }
  }
  assert.equal(collinear.length, 3);
  assert.throws(() => makeFace(split, collinear), /straight line/);
});

test('open end of a cylinder closes with one command (fill and F) and one undo reopens it', () => {
  const openCylinderRecipe = recipeOf({
    base: { type: 'cylinder', segments: 12, bevel: 0 },
    edits: [{ op: 'delete', select: { tag: 'top' } }],
  });
  const { controller, editor } = mountEditor(openCylinderRecipe);
  const meshBefore = heroMesh(controller);
  const topEdges = [];
  for (let edge = 0; edge < meshBefore.edgeCount; edge += 1) {
    const first = meshBefore.edgeVertices[edge * 2];
    const second = meshBefore.edgeVertices[edge * 2 + 1];
    if (meshBefore.positions[first * 3 + 1] > 0.4 && meshBefore.positions[second * 3 + 1] > 0.4) {
      topEdges.push(edge);
    }
  }
  selectEdgesInBox(controller, editor, topEdges);
  assert.equal(editor.selection.indices.length, 12);
  const fillResult = editor.fill();
  assert.equal(fillResult.ok, true);
  assert.equal(heroMesh(controller).faceCount, meshBefore.faceCount + 1);
  assert.equal(lintMesh(heroMesh(controller)).problems.some(problem => problem.kind === 'boundary-edge'), false);
  assert.equal(heroLog(controller).at(-1).op, 'make_face');

  controller.undo();
  editor.refresh();
  assert.equal(heroMesh(controller).faceCount, meshBefore.faceCount);

  // Also works with nothing selected via fill_holes, and via makeFace (F) on the selected loop.
  assert.equal(editor.fill().ok, true);
  assert.equal(heroLog(controller).at(-1).op, 'fill_holes');
  assert.equal(lintMesh(heroMesh(controller)).problems.some(problem => problem.kind === 'boundary-edge'), false);
  controller.undo();
  editor.refresh();

  selectEdgesInBox(controller, editor, topEdges);
  assert.equal(editor.makeFace().ok, true);
  assert.equal(heroMesh(controller).faceCount, meshBefore.faceCount + 1);
});

test('two open loops are bridged cleanly with one command and grid fill closes even loops', () => {
  const tubeRecipe = recipeOf({
    base: { type: 'cylinder', segments: 8, bevel: 0 },
    edits: [
      { op: 'delete', select: { tag: 'top' } },
      { op: 'delete', select: { tag: 'bottom' } },
    ],
  });
  const { controller, editor } = mountEditor(tubeRecipe);
  const mesh = heroMesh(controller);
  // Select the two open boundary edge loops of the uncapped cylinder.
  const openLoopEdges = [];
  const edgeCounts = new Uint32Array(mesh.edgeCount);
  for (const edge of mesh.cornerEdges) {
    edgeCounts[edge] += 1;
  }
  for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
    if (edgeCounts[edge] === 1) {
      openLoopEdges.push(edge);
    }
  }
  const topLoopEdges = openLoopEdges.filter(edge => mesh.positions[mesh.edgeVertices[edge * 2] * 3 + 1] > 0);
  const bottomLoopEdges = openLoopEdges.filter(edge => mesh.positions[mesh.edgeVertices[edge * 2] * 3 + 1] < 0);
  selectEdgesInBox(controller, editor, topLoopEdges);
  selectEdgesInBox(controller, editor, bottomLoopEdges, { additive: true });
  assert.equal(editor.selection.indices.length, 16);
  const bridged = editor.bridge();
  assert.equal(bridged.ok, true);
  assert.equal(heroLog(controller).at(-1).op, 'bridge_edge_loops');
  assert.equal(heroMesh(controller).faceCount, mesh.faceCount + 8);
  assert.equal(lintMesh(heroMesh(controller)).problems.some(problem => problem.kind === 'boundary-edge'), false);

  controller.undo();
  editor.refresh();
  assert.equal(heroMesh(controller).faceCount, mesh.faceCount);

  // Grid fill on the top 8-edge open loop.
  selectEdgesInBox(controller, editor, topLoopEdges);
  assert.equal(editor.gridFill().ok, true);
  assert.equal(heroLog(controller).at(-1).op, 'grid_fill');
  assert.ok(heroMesh(controller).faceCount > mesh.faceCount + 1);
});

test('subdivide and symmetrize commands act cleanly in edit mode with undo', () => {
  const { controller, editor } = mountEditor();
  const faceBefore = heroMesh(controller).faceCount;
  editor.setMode('face');
  const frontPixel = controller.projectWorldPoint([0, 0, 0.5]);
  editor.pick(frontPixel.x, frontPixel.y);
  assert.equal(editor.subdivide().ok, true);
  assert.equal(heroLog(controller).at(-1).op, 'subdivide_edges');
  assert.ok(heroMesh(controller).faceCount > faceBefore);
  controller.undo();
  editor.refresh();
  assert.equal(heroMesh(controller).faceCount, faceBefore);

  // Move one corner on -X and symmetrize +X to -X to restore symmetry.
  const movedRecipe = recipeOf({
    edits: [{ op: 'translate', verts: { vertices: [0] }, offset: [-0.4, 0, 0] }],
  });
  const asymmetric = mountEditor(movedRecipe);
  assert.equal(asymmetric.editor.symmetrize({ axis: 'x', keep: 'positive' }).ok, true);
  assert.equal(heroLog(asymmetric.controller).at(-1).op, 'symmetrize');
  const symmetricMesh = heroMesh(asymmetric.controller);
  for (let vertex = 0; vertex < symmetricMesh.vertexCount; vertex += 1) {
    assert.ok(Math.abs(symmetricMesh.positions[vertex * 3]) <= 0.5001);
  }
  asymmetric.controller.undo();
  asymmetric.editor.refresh();
  assert.equal(heroLog(asymmetric.controller).length, 1);
});

test('command planners validate selections and options with clear errors', () => {
  const { controller } = mountEditor();
  const mesh = heroMesh(controller);
  assert.throws(() => planMeshMakeFace(mesh, 'vertex', new Set([0])), /at least two vertices/);
  assert.throws(() => planMeshFill(mesh, 'vertex', new Set([0, 1])), /at least three vertices/);
  assert.throws(() => planMeshGridFill(mesh, 'edge', new Set()), /closed boundary loop/);
  assert.throws(() => planMeshBridge(mesh, 'edge', new Set()), /two open boundary loops/);
  assert.throws(() => planMeshBridge(mesh, 'edge', new Set([0]), { segments: 0 }), /segments/);
  assert.throws(() => planMeshSubdivide(mesh, 'edge', new Set()), /at least one edge/);
  assert.throws(() => planMeshSubdivide(mesh, 'edge', new Set([0]), { cuts: 99 }), /cuts/);
  assert.throws(() => planMeshSymmetrize(mesh, 'face', new Set(), { axis: 'w' }), /axis/);
  assert.throws(() => planMeshSymmetrize(mesh, 'face', new Set(), { keep: 'both' }), /keep/);
});

test('F shortcut and Mesh tools menu work through Studio DOM and F still frames outside edit mode', async testContext => {
  const openBoxRecipe = recipeOf({ edits: [{ op: 'delete', select: { tag: 'top' } }] });
  const ui = mountStudio(testContext, openBoxRecipe);
  const eyeBefore = [...ui.controller.viewCamera.eye];
  ui.press('f');
  assert.notDeepEqual([...ui.controller.viewCamera.eye], eyeBefore, 'F frames outside edit mode');

  ui.press('Tab');
  await untilEditing(ui);
  // Pick the 4 top vertices in vertex mode using F to close the open face.
  ui.press('1');
  const mesh = heroMesh(ui.controller);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    if (mesh.positions[vertex * 3 + 1] > 0.4) {
      const pixel = pixelOfVertex(ui.controller, vertex);
      const click = { clientX: VIEWPORT_BOX.left + pixel.x, clientY: VIEWPORT_BOX.top + pixel.y, shiftKey: true };
      dispatch(ui.canvas, 'pointerdown', click);
      dispatch(ui.viewport, 'pointerup', click);
    }
  }
  ui.press('f');
  assert.equal(heroMesh(ui.controller).faceCount, 6);
  assert.equal(heroLog(ui.controller).at(-1).op, 'make_face');

  ui.press('z', { ctrlKey: true });
  assert.equal(heroMesh(ui.controller).faceCount, 5);

  // Open Mesh tools menu from the rail button and invoke Fill, Subdivide, Symmetrize.
  const toolsPopover = ui.root.querySelector('#crucible-studio-pop-mesh-tools');
  assert.ok(toolsPopover);
  byText(toolsPopover, 'Fill').click();
  assert.equal(heroMesh(ui.controller).faceCount, 6);

  // Pick a face and click Subdivide in Mesh tools.
  ui.press('3');
  const frontPixel = ui.controller.projectWorldPoint([0, 0, 0.5]);
  const pickFront = { clientX: VIEWPORT_BOX.left + frontPixel.x, clientY: VIEWPORT_BOX.top + frontPixel.y };
  dispatch(ui.canvas, 'pointerdown', pickFront);
  dispatch(ui.viewport, 'pointerup', pickFront);
  byText(toolsPopover, 'Subdivide').click();
  assert.equal(heroLog(ui.controller).at(-1).op, 'subdivide_edges');

  // Symmetrize submenu works from Mesh tools.
  const symmetrizePopover = ui.root.querySelector('#crucible-studio-pop-mesh-symmetrize');
  assert.ok(symmetrizePopover);
  byText(symmetrizePopover, '+X to -X').click();
  assert.equal(heroLog(ui.controller).at(-1).op, 'symmetrize');

  // Right click in edit mode opens the Mesh tools menu.
  const emptySpot = { clientX: VIEWPORT_BOX.left + 12, clientY: VIEWPORT_BOX.top + 12, button: 2 };
  dispatch(ui.canvas, 'pointerdown', emptySpot);
  dispatch(ui.viewport, 'pointerup', emptySpot);
  ui.dom.runTimers();
  assert.equal(toolsPopover.popoverOpen, true);

  // Help shortcuts sheet includes Make face or edge on F.
  const sheetText = ui.root.querySelector('.crucible-studio-shortcuts-dialog').textContent;
  assert.match(sheetText, /Make face or edge/);
});
