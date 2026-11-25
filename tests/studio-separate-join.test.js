import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';
import { createMeshEditor } from '../src/studio-mesh-edit.js';
import { DEFAULT_KEYMAP_ACTIONS, findKeymapAction, resolveKeymap } from '../src/studio-keymap.js';

// Issue 3302: P in edit mode separates the picked faces into a new object, Ctrl+J joins the selected objects, each one undo step.

const CAMERA = { eye: [0.8, 1.4, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };

function recipeOf() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [{ id: 'shape', type: 'mesh', base: { type: 'box', bevel: 0 } }, { id: 'ball', type: 'sphere' }],
    nodes: [
      { id: 'hero', geometry: 'shape', material: 'grey', translation: [0, 0, 0], scale: [2, 1, 1] },
      { id: 'friend', geometry: 'shape', material: 'grey', translation: [3, 0, 0] },
    ],
    camera: CAMERA,
  };
}

function mount() {
  const controller = createStudioController({ scene: createAgentScene(recipeOf()), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('hero');
  const messages = [];
  const editor = createMeshEditor({ controller, announce: message => messages.push(message), getRenderer: () => ({}), updatePart: () => {} });
  return { controller, editor, messages };
}

function partOf(controller, nodeId) {
  return controller.scene.parts.find(part => part.name === nodeId);
}

function pickFace(controller, editor, predicate) {
  const mesh = meshEditSourceOf(partOf(controller, 'hero').geometry).mesh;
  for (let face = 0; face < mesh.faceCount; face += 1) {
    const corners = [];
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner += 1) corners.push(mesh.cornerVertices[corner]);
    const centre = [0, 1, 2].map(axis => corners.reduce((sum, vertex) => sum + mesh.positions[vertex * 3 + axis], 0) / corners.length);
    if (!predicate(centre)) continue;
    const matrix = partOf(controller, 'hero').matrix;
    const world = [0, 1, 2].map(axis => matrix[axis] * centre[0] + matrix[4 + axis] * centre[1] + matrix[8 + axis] * centre[2] + matrix[12 + axis]);
    const pixel = controller.projectWorldPoint(world);
    editor.pick(pixel.x, pixel.y);
    return face;
  }
  throw new Error('no such face');
}

test('separating the picked face makes a new object in one undo step and the world does not change', () => {
  const { controller, editor } = mount();
  editor.enter();
  const triangles = partOf(controller, 'hero').geometry.indices.length / 3;
  pickFace(controller, editor, centre => centre[2] > 0.49);
  assert.equal(editor.selection.indices.length, 1);
  const result = editor.separateSelection();
  assert.equal(result.ok, true);
  const recipe = controller.exportRecipe();
  const part = recipe.nodes.find(node => node.id === result.nodeId);
  assert.deepEqual(part.scale, [2, 1, 1], 'same transform, so nothing moves');
  assert.equal(partOf(controller, result.nodeId).geometry.indices.length / 3, 2);
  assert.equal(partOf(controller, 'hero').geometry.indices.length / 3, triangles - 2);
  assert.equal(editor.active, true, 'edit mode stays on the object');
  controller.undo();
  assert.equal(controller.exportRecipe().nodes.some(node => node.id === result.nodeId), false, 'one undo takes the new object away');
  assert.equal(partOf(controller, 'hero').geometry.indices.length / 3, triangles, 'and gives the faces back');
});

test('separating with nothing picked says what to do and changes nothing', () => {
  const { controller, editor, messages } = mount();
  editor.enter();
  const nodeCount = controller.exportRecipe().nodes.length;
  assert.equal(editor.separateSelection().ok, false);
  assert.match(messages.at(-1), /Pick the faces to separate first/);
  assert.equal(controller.exportRecipe().nodes.length, nodeCount);
});

test('the keymap binds P in edit mode and Ctrl+J in object mode, and J alone stays free', () => {
  const keymap = resolveKeymap();
  assert.equal(findKeymapAction(keymap, { key: 'p' }, 'mesh').actionId, 'mesh.separate');
  assert.equal(findKeymapAction(keymap, { key: 'j', ctrlKey: true }, 'normal').actionId, 'edit.join');
  assert.equal(findKeymapAction(keymap, { key: 'p' }, 'normal'), null);
  assert.ok(DEFAULT_KEYMAP_ACTIONS.some(action => action.id === 'edit.join'));
});

function mountStudio(testContext) {
  const dom = installStudioDom();
  const recipe = recipeOf();
  recipe.nodes.push({ id: 'orb', geometry: 'ball', material: 'grey', translation: [0, 3, 0] });
  const studio = createStudio(dom.container, { recipe, renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  studio.renderNow();
  return { studio, dom };
}

test('Ctrl+J joins the selected objects into the last one picked as one undo step, a shape included', async testContext => {
  const { studio, dom } = mountStudio(testContext);
  const { controller } = studio;
  controller.selectNodes(['hero', 'friend', 'orb'], { active: 'orb' });
  const before = controller.exportRecipe();
  const event = dispatch(dom.document, 'keydown', { key: 'j', ctrlKey: true });
  assert.equal(event.defaultPrevented, true);
  for (let attempt = 0; attempt < 200 && controller.exportRecipe().nodes.length !== 1; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  const after = controller.exportRecipe();
  assert.deepEqual(after.nodes.map(node => node.id), ['orb']);
  const joinedEdits = after.geometries.find(geometry => geometry.id === after.nodes[0].geometry).edits.filter(edit => edit.op === 'join');
  assert.equal(joinedEdits.length, 2);
  assert.equal(controller.selectedNodeId, 'orb');
  controller.undo();
  assert.deepEqual(controller.exportRecipe().nodes.map(node => node.id), before.nodes.map(node => node.id), 'one undo brings all three back');
});

test('Ctrl+J with one object selected says what to do and changes nothing', async testContext => {
  const { studio, dom } = mountStudio(testContext);
  studio.controller.selectNode('hero');
  dispatch(dom.document, 'keydown', { key: 'j', ctrlKey: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(studio.controller.exportRecipe().nodes.length, 3);
});
