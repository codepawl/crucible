import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { createMeshEditor, SEE_THROUGH_SURFACE_OPACITY } from '../src/studio-mesh-edit.js';
import {
  evaluateModifierPreview,
  hasActiveModifiers,
  modifierPreviewState,
  previewPartForCage,
} from '../src/studio-modifier-cage.js';
import { byDataset, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const CAMERA = { eye: [1.6, 1.4, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };

function mirrorSubdivideRecipe({ nodes } = {}) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [
      {
        id: 'half',
        type: 'mesh',
        base: { type: 'box', bevel: 0 },
        edits: [{ op: 'translate', select: { all: true }, offset: [0.6, 0, 0] }],
        stack: [
          { op: 'mirror', axis: 'x', merge: 0.001 },
          { op: 'subdivide', levels: 1 },
        ],
      },
    ],
    nodes: nodes ?? [{ id: 'hero', geometry: 'half', material: 'grey' }],
    camera: CAMERA,
  };
}

function mountEditor(recipe = mirrorSubdivideRecipe()) {
  const controller = createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  const messages = [];
  const editor = createMeshEditor({ controller, announce: message => messages.push(message), getRenderer: () => ({}) });
  return { controller, editor, messages };
}

function heroPart(controller) {
  return controller.scene.parts.find(part => part.name === 'hero');
}

function faceMatching(mesh, predicate) {
  for (let face = 0; face < mesh.faceCount; face += 1) {
    const corners = [];
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner += 1) {
      corners.push(mesh.cornerVertices[corner]);
    }
    if (corners.every(vertex => predicate([mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]]))) {
      return { face, corners };
    }
  }
  throw new Error('no matching cage face');
}

function pixelOfFaceCentre(controller, mesh, corners) {
  const centre = [0, 0, 0];
  for (const vertex of corners) {
    for (let axis = 0; axis < 3; axis += 1) centre[axis] += mesh.positions[vertex * 3 + axis] / corners.length;
  }
  return controller.projectWorldPoint(centre);
}

function extentOnX(positions) {
  let minX = Infinity;
  let maxX = -Infinity;
  for (let offset = 0; offset < positions.length; offset += 3) {
    minX = Math.min(minX, positions[offset]);
    maxX = Math.max(maxX, positions[offset]);
  }
  return [minX, maxX];
}

test('modifier cage helpers validate inputs at their boundaries', () => {
  assert.equal(hasActiveModifiers(undefined), false);
  assert.equal(hasActiveModifiers([]), false);
  assert.equal(hasActiveModifiers([{ op: 'mirror', enabled: false }]), false);
  assert.equal(hasActiveModifiers([{ op: 'mirror' }]), true);
  assert.throws(() => hasActiveModifiers('mirror'), /array stack/);
  assert.throws(() => modifierPreviewState(null, { geometry: { positions: new Float32Array(0) } }), /geometrySpec/);
  assert.throws(() => modifierPreviewState({}, null), /rendered part/);
  assert.throws(() => evaluateModifierPreview(null), /edit state/);
  assert.equal(previewPartForCage(null, null, null), null);
});

test('entering edit mode on a mesh with mirror and subdivision opens the pre-modifier cage while the evaluated mesh stays live', async t => {
  const dom = installStudioDom();
  const renderer = createFakeRenderer();
  const studio = createStudio(dom.container, { recipe: mirrorSubdivideRecipe(), renderer });
  t.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
  studio.renderNow();
  studio.controller.selectNode('hero');
  dispatch(dom.document, 'keydown', { key: 'Tab' });
  for (let attempt = 0; attempt < 2000 && root.dataset.meshEdit !== 'true'; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(root.dataset.meshEdit, 'true');
  studio.renderNow();

  assert.equal(byDataset(root, 'meshMode', 'face').getAttribute('aria-pressed'), 'true');
  const evaluatedPart = heroPart(studio.controller);
  assert.ok(evaluatedPart.geometry.indices.length / 3 > 12, 'evaluated mirror+subdivide mesh stays on the node');
  assert.equal(meshEditSourceOf(evaluatedPart.geometry).mesh.faceCount, 6, 'edit mode holds the 6-face pre-modifier cage');
  const [minX, maxX] = extentOnX(evaluatedPart.geometry.positions);
  assert.ok(minX < -0.5 && maxX > 0.5, 'mirrored sides are both present on the node');
  const edgePaths = root.querySelectorAll('.crucible-studio-cage-edges');
  assert.ok(edgePaths.length > 0, 'cage edges are drawn in the viewport');
});

test('moving a cage face live-previews the mirror and subdivision stack, cancels cleanly, and commits as 1 undo step', () => {
  const { controller, editor } = mountEditor();
  editor.enter();
  const cageMesh = editor.cage.mesh;
  const outerXFace = faceMatching(cageMesh, point => point[0] > 1.09);
  const pixel = pixelOfFaceCentre(controller, cageMesh, outerXFace.corners);
  assert.equal(editor.pick(pixel.x, pixel.y), outerXFace.face);

  const initialPart = heroPart(controller);
  const [, initialMaxX] = extentOnX(initialPart.geometry.positions);
  const revisionBefore = editor.previewRevision;

  // Live preview during gizmo drag re-evaluates the modifier stack on the cage positions.
  controller.beginGizmoDrag('x', pixel.x, pixel.y);
  controller.setGizmoTypedAmount(0.5);
  assert.ok(editor.previewRevision > revisionBefore, 'previewRevision advances when the stacked preview updates');
  const previewParts = editor.partsToDraw(controller.scene.parts);
  const previewPartsAgain = editor.partsToDraw(controller.scene.parts);
  const previewHero = previewParts.find(part => part.name === 'hero');
  assert.equal(previewHero, previewPartsAgain.find(part => part.name === 'hero'), 'preview keeps stable part identity across frames');
  assert.notEqual(previewHero.geometry, initialPart.geometry, 'preview swaps in re-evaluated modifier geometry');
  const [previewMinX, previewMaxX] = extentOnX(previewHero.geometry.positions);
  assert.ok(previewMaxX > initialMaxX + 0.4, 'positive X face move widens the evaluated mesh');
  assert.ok(previewMinX < -initialMaxX - 0.4, 'mirror modifier reflects the live move across X');

  // Cancel restores both the cage and the original evaluated part with zero undo entries.
  controller.cancelGizmoDrag();
  assert.equal(editor.partsToDraw(controller.scene.parts).find(part => part.name === 'hero'), initialPart);
  assert.equal(controller.canUndo, false);

  // Committed drag appends to the pre-modifier edit log, keeps the stack, and records 1 undo step.
  controller.beginGizmoDrag('x', pixel.x, pixel.y);
  controller.setGizmoTypedAmount(0.5);
  controller.endGizmoDrag();
  assert.equal(controller.canUndo, true);

  const committedRecipe = controller.exportRecipe();
  assert.equal(committedRecipe.geometries[0].edits.length, 2);
  assert.equal(committedRecipe.geometries[0].edits[1].op, 'translate');
  assert.equal(committedRecipe.geometries[0].stack.length, 2, 'modifier stack stays non-destructive');

  const committedPart = heroPart(controller);
  const [committedMinX, committedMaxX] = extentOnX(committedPart.geometry.positions);
  assert.ok(committedMaxX > initialMaxX + 0.4);
  assert.ok(committedMinX < -initialMaxX - 0.4);
  assert.equal(meshEditSourceOf(committedPart.geometry).mesh.faceCount, 6, 'base cage remains 6 faces');

  // 1-step undo reverts both the cage edit and the evaluated modifier mesh; redo reapplies both.
  controller.undo();
  editor.refresh();
  assert.equal(controller.exportRecipe().geometries[0].edits.length, 1);
  assert.deepEqual(Array.from(heroPart(controller).geometry.positions), Array.from(initialPart.geometry.positions));

  controller.redo();
  editor.refresh();
  assert.equal(controller.exportRecipe().geometries[0].edits.length, 2);
  assert.deepEqual(Array.from(heroPart(controller).geometry.positions), Array.from(committedPart.geometry.positions));
});

test('see-through keeps the live modifier preview translucent while dragging', () => {
  const { controller, editor } = mountEditor();
  editor.enter();
  editor.setSeeThrough(true);
  const outerXFace = faceMatching(editor.cage.mesh, point => point[0] > 1.09);
  const pixel = pixelOfFaceCentre(controller, editor.cage.mesh, outerXFace.corners);
  editor.pick(pixel.x, pixel.y);

  controller.beginGizmoDrag('x', pixel.x, pixel.y);
  controller.setGizmoTypedAmount(0.25);
  const drawnHero = editor.partsToDraw(controller.scene.parts).find(part => part.name === 'hero');
  assert.equal(drawnHero.material.alphaMode, 'blend');
  assert.ok(drawnHero.material.opacity <= SEE_THROUGH_SURFACE_OPACITY);
  controller.cancelGizmoDrag();
});

test('extrude, subdivide and dissolve run on the pre-modifier cage, survive save & reload, and undo in 1 step', () => {
  const { controller, editor } = mountEditor();
  editor.enter();
  const outerXFace = faceMatching(editor.cage.mesh, point => point[0] > 1.09);
  const pixel = pixelOfFaceCentre(controller, editor.cage.mesh, outerXFace.corners);
  editor.pick(pixel.x, pixel.y);

  // Held extrude live-previews the modifier stack and commits to the pre-modifier log.
  const beforeExtrude = heroPart(controller).geometry.positions.length;
  assert.equal(editor.beginFaceTool('extrude', pixel.x, pixel.y).ok, true);
  editor.moveFaceTool(pixel.x + 60, pixel.y);
  const previewGeo = editor.partsToDraw(controller.scene.parts).find(part => part.name === 'hero').geometry;
  assert.ok(previewGeo.positions.length >= beforeExtrude);
  editor.finishFaceTool();
  assert.equal(editor.cage.mesh.faceCount, 10, 'extruding 1 face of a box cage adds 4 side faces to the cage');
  assert.equal(controller.exportRecipe().geometries[0].edits.at(-1).op, 'extrude_face_region');

  // Subdivide on a picked cage edge updates the cage topology and re-evaluates the stack.
  editor.setMode('edge');
  editor.pick(pixel.x, pixel.y);
  editor.selectNone();
  editor.setMode('face');
  const topFace = faceMatching(editor.cage.mesh, point => point[1] > 0.49);
  const topPixel = pixelOfFaceCentre(controller, editor.cage.mesh, topFace.corners);
  editor.pick(topPixel.x, topPixel.y);
  const subdivideResult = editor.subdivide();
  assert.equal(subdivideResult.ok, true);
  assert.ok(editor.cage.mesh.faceCount > 10);

  // Save & reload preserves both the cage edits and the modifier stack deterministically.
  const savedJson = JSON.stringify(controller.exportRecipe());
  const expectedPositions = Float32Array.from(heroPart(controller).geometry.positions);
  const expectedIndices = Uint32Array.from(heroPart(controller).geometry.indices);

  const reloaded = mountEditor(JSON.parse(savedJson));
  assert.deepEqual(Array.from(heroPart(reloaded.controller).geometry.positions), Array.from(expectedPositions));
  assert.deepEqual(Array.from(heroPart(reloaded.controller).geometry.indices), Array.from(expectedIndices));
  assert.equal(reloaded.editor.enter().ok, true);
  assert.equal(reloaded.editor.cage.mesh.faceCount, editor.cage.mesh.faceCount);

  // Dissolving the interior vertex created by subdividing restores the outer quad on the cage while keeping the modifier stack live.
  reloaded.editor.setMode('vertex');
  const centreVertex = Array.from({ length: reloaded.editor.cage.mesh.vertexCount }, (_, vertex) => vertex).find(vertex => {
    const x = reloaded.editor.cage.mesh.positions[vertex * 3];
    const y = reloaded.editor.cage.mesh.positions[vertex * 3 + 1];
    const z = reloaded.editor.cage.mesh.positions[vertex * 3 + 2];
    return y > 0.49 && Math.abs(x - 0.6) < 0.05 && Math.abs(z) < 0.05;
  });
  assert.notEqual(centreVertex, undefined);
  const centrePixel = reloaded.controller.projectWorldPoint([
    reloaded.editor.cage.mesh.positions[centreVertex * 3],
    reloaded.editor.cage.mesh.positions[centreVertex * 3 + 1],
    reloaded.editor.cage.mesh.positions[centreVertex * 3 + 2],
  ]);
  reloaded.editor.pick(centrePixel.x, centrePixel.y);
  assert.equal(reloaded.editor.dissolve('vertices').ok, true);
  assert.equal(reloaded.controller.exportRecipe().geometries[0].edits.at(-1).op, 'dissolve_verts');
  assert.equal(reloaded.controller.exportRecipe().geometries[0].stack.length, 2);

  // Undo steps unwind each cage edit one by one.
  const faceCountAfterSubdivide = editor.cage.mesh.faceCount;
  controller.undo();
  editor.refresh();
  assert.equal(editor.cage.mesh.faceCount, 10);
  controller.undo();
  editor.refresh();
  assert.equal(editor.cage.mesh.faceCount, 6);
  controller.redo();
  editor.refresh();
  assert.equal(editor.cage.mesh.faceCount, 10);
  controller.redo();
  editor.refresh();
  assert.equal(editor.cage.mesh.faceCount, faceCountAfterSubdivide);
});

test('entering edit mode on a shared mesh with modifiers copies it for that node in 1 undo step', () => {
  const recipe = mirrorSubdivideRecipe({
    nodes: [
      { id: 'hero', geometry: 'half', material: 'grey' },
      { id: 'twin', geometry: 'half', material: 'grey', translation: [4, 0, 0] },
    ],
  });
  const { controller, editor } = mountEditor(recipe);
  assert.equal(editor.enter().ok, true);
  const afterEnter = controller.exportRecipe();
  const heroGeometryId = afterEnter.nodes.find(node => node.id === 'hero').geometry;
  assert.notEqual(heroGeometryId, 'half');
  assert.equal(afterEnter.nodes.find(node => node.id === 'twin').geometry, 'half');
  assert.equal(afterEnter.geometries.find(geometry => geometry.id === heroGeometryId).stack.length, 2);
  controller.undo();
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'hero').geometry, 'half');
});
