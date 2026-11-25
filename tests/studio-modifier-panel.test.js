import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { MODIFIER_LIMITS } from '../src/studio-modifier-panel.js';
import { MAX_ARRAY_COUNT, MAX_STACK_NODES } from '../src/mesh-operations.js';
import { MAX_BEVEL_SEGMENTS } from '../src/mesh-bevel.js';
import { MAX_SUBDIVISION_LEVELS } from '../src/mesh-subdivide.js';
import { evaluateMeshStack, normalizeMeshStack } from '../src/mesh-recipe.js';
import { createAgentScene } from '../src/agent-scene.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const CAMERA = { eye: [0.8, 1.4, 4.5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };

// A box that sits on the +x side of the mirror plane: half a model.
function halfModelRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries: [
      { id: 'half', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [{ op: 'translate', select: { all: true }, offset: [0.5, 0, 0] }] },
      { id: 'cube', type: 'box' },
    ],
    nodes: [
      { id: 'hero', geometry: 'half', material: 'grey', label: 'Half' },
      { id: 'shape', geometry: 'cube', material: 'grey', label: 'Shape', translation: [3, 0, 0] },
    ],
    camera: CAMERA,
  };
}

function mount(testContext, selected = 'hero') {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: halfModelRecipe(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  studio.renderNow();
  studio.controller.selectNode(selected);
  studio.setActiveTab('modifiers');
  const panel = root.querySelector('.crucible-studio-modifiers');
  return { studio, controller: studio.controller, root, panel };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function addMenuOf(ui) {
  return ui.panel.querySelector('.crucible-studio-modifier-add-menu');
}

function add(ui, operation) {
  dispatch(ui.panel.querySelector('.crucible-studio-modifier-add'), 'click');
  // The click lands on the word inside the row, as a pointer's does.
  const row = addMenuOf(ui).descendants().find(item => item.dataset.modifier === operation);
  dispatch(row.children.at(-1), 'click');
}

function sections(ui) {
  return ui.panel.querySelectorAll('.crucible-studio-modifier');
}

function section(ui, index) {
  return sections(ui)[index];
}

function actionButton(ui, index, action) {
  return section(ui, index).descendants().find(element => element.dataset.action === action);
}

function press(ui, index, action) {
  dispatch(actionButton(ui, index, action), 'click');
}

function typeInto(ui, index, label, value) {
  const input = section(ui, index).descendants().find(element => element.getAttribute('aria-label') === label);
  input.value = String(value);
  dispatch(input, 'change');
}

function stackOf(ui, geometryId) {
  const recipe = ui.controller.exportRecipe();
  const nodeGeometry = recipe.nodes.find(node => node.id === 'hero').geometry;
  return recipe.geometries.find(geometry => geometry.id === (geometryId ?? nodeGeometry)).stack ?? [];
}

function heroPositions(ui) {
  return ui.controller.scene.parts.find(part => part.name === 'hero').geometry.positions;
}

function extentOnX(positions) {
  const xs = Array.from({ length: positions.length / 3 }, (_, vertex) => positions[vertex * 3]);
  return [Math.min(...xs), Math.max(...xs)];
}

// An undo step is one change of the recipe: undo once and the recipe is what it was before.
function assertOneUndoStep(ui, before, change) {
  change();
  assert.notDeepEqual(ui.controller.exportRecipe(), before, 'the change reached the recipe');
  ui.controller.undo();
  assert.deepEqual(ui.controller.exportRecipe(), before, 'one undo gives the recipe back');
  ui.controller.redo();
}

test('the panel limits are the limits of the recipe', () => {
  assert.equal(MODIFIER_LIMITS.subdivisionLevels, MAX_SUBDIVISION_LEVELS);
  assert.equal(MODIFIER_LIMITS.bevelSegments, MAX_BEVEL_SEGMENTS);
  assert.equal(MODIFIER_LIMITS.maxStackNodes, MAX_STACK_NODES);
  assert.equal(MODIFIER_LIMITS.arrayCount, MAX_ARRAY_COUNT);
  assert.doesNotThrow(() => normalizeMeshStack([{ op: 'array', count: MODIFIER_LIMITS.arrayCount }, { op: 'mirror', merge: MODIFIER_LIMITS.distance }]));
  assert.throws(() => normalizeMeshStack([{ op: 'array', count: MAX_ARRAY_COUNT + 1 }]), /count/);
  assert.throws(() => normalizeMeshStack([{ op: 'mirror', merge: MODIFIER_LIMITS.distance + 1 }]), /merge/);
});

test('a stack node can be switched off: it stays in the stack and the stack runs without it', () => {
  assert.deepEqual(normalizeMeshStack([{ op: 'subdivide', levels: 1, enabled: false }, { op: 'subdivide', enabled: true }]).map(node => node.enabled), [false, undefined]);
  assert.throws(() => normalizeMeshStack([{ op: 'subdivide', enabled: 'no' }]), /enabled/);
});

test('a switched-off node is skipped by evaluation, and an agent cannot apply it into the edit log', async () => {
  const scene = createAgentScene({
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [1, 1, 1] }],
    geometries: [{ id: 'm', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'subdivide', levels: 1, enabled: false }] }],
    nodes: [{ id: 'n', geometry: 'm', material: 'grey' }],
    camera: CAMERA,
  });
  const faces = scene.parts.find(part => part.name === 'n').geometry.indices.length / 3;
  assert.equal(faces, 12, 'a box stays 12 triangles while its subdivision is off');
  assert.throws(() => scene.apply([{ type: 'set-mesh-stack', geometry: 'm', apply: 1 }], { expectedRevision: scene.revision }), /stops before stack node 0.*switched off/);
  await settle();
});

test('Add Modifier is a menu: it opens, lists the five, closes after a pick and on Escape', t => {
  const ui = mount(t);
  const button = ui.panel.querySelector('.crucible-studio-modifier-add');
  assert.equal(addMenuOf(ui).hidden, true);
  dispatch(button, 'click');
  assert.equal(addMenuOf(ui).hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(addMenuOf(ui).descendants().filter(item => item.dataset.modifier).map(item => item.dataset.modifier), ['subdivide', 'mirror', 'array', 'bevel', 'solidify']);
  dispatch(ui.panel, 'keydown', { key: 'Escape' });
  assert.equal(addMenuOf(ui).hidden, true);
  add(ui, 'mirror');
  assert.equal(addMenuOf(ui).hidden, true, 'a pick closes the menu');
  assert.deepEqual(stackOf(ui).map(node => node.op), ['mirror']);
});

test('the Modifiers tab lists the five modifiers and adds each as one undo step', t => {
  const ui = mount(t);
  assert.equal(ui.panel.dataset.state, 'ready');
  for (const operation of ['subdivide', 'mirror', 'array', 'bevel', 'solidify']) {
    const before = ui.controller.exportRecipe();
    assertOneUndoStep(ui, before, () => add(ui, operation));
  }
  assert.deepEqual(stackOf(ui).map(node => node.op), ['subdivide', 'mirror', 'array', 'bevel', 'solidify']);
  assert.equal(sections(ui).length, 5);
  assert.deepEqual(sections(ui).map(element => element.dataset.op), ['subdivide', 'mirror', 'array', 'bevel', 'solidify']);
});

test('editing a field is one undo step and the recipe keeps the value', t => {
  const ui = mount(t);
  add(ui, 'subdivide');
  add(ui, 'array');
  const before = ui.controller.exportRecipe();
  assertOneUndoStep(ui, before, () => typeInto(ui, 0, 'Levels', 2));
  assert.equal(stackOf(ui)[0].levels, 2);
  assertOneUndoStep(ui, ui.controller.exportRecipe(), () => typeInto(ui, 1, 'Count', 5));
  assert.equal(stackOf(ui)[1].count, 5);
});

test('a value the recipe refuses is told to the person, changes nothing and leaves no undo step', t => {
  const ui = mount(t);
  add(ui, 'solidify');
  const before = ui.controller.exportRecipe();
  typeInto(ui, 0, 'Thickness', 0);
  assert.deepEqual(ui.controller.exportRecipe(), before);
  assert.equal(section(ui, 0).descendants().find(element => element.getAttribute('aria-label') === 'Thickness').value, '0.1', 'the field shows the recipe value again');
  ui.controller.undo();
  assert.deepEqual(stackOf(ui), [], 'the one undo went to the add, so the refused edit left no step of its own');
});

test('reorder, switch off and remove are one undo step each', t => {
  const ui = mount(t);
  add(ui, 'mirror');
  add(ui, 'subdivide');
  assertOneUndoStep(ui, ui.controller.exportRecipe(), () => press(ui, 1, 'up'));
  assert.deepEqual(stackOf(ui).map(node => node.op), ['subdivide', 'mirror']);
  assertOneUndoStep(ui, ui.controller.exportRecipe(), () => press(ui, 0, 'enable'));
  assert.equal(stackOf(ui)[0].enabled, false);
  assert.equal(section(ui, 0).dataset.enabled, 'false');
  assertOneUndoStep(ui, ui.controller.exportRecipe(), () => press(ui, 0, 'enable'));
  assert.equal(stackOf(ui)[0].enabled, undefined, 'switching back on leaves no flag behind');
  assertOneUndoStep(ui, ui.controller.exportRecipe(), () => press(ui, 0, 'remove'));
  assert.deepEqual(stackOf(ui).map(node => node.op), ['mirror']);
});

test('applying a modifier bakes it into the mesh as one undo step, and the ones around it stay', t => {
  const ui = mount(t);
  add(ui, 'mirror');
  add(ui, 'subdivide');
  assertOneUndoStep(ui, ui.controller.exportRecipe(), () => press(ui, 0, 'apply'));
  const geometry = ui.controller.exportRecipe().geometries.find(candidate => candidate.id === 'half');
  assert.equal(geometry.edits.at(-1).op, 'mirror');
  assert.deepEqual(geometry.stack.map(node => node.op), ['subdivide']);
  assert.equal(sections(ui).length, 1);
});

test('applying a modifier that is not first bakes that one alone', t => {
  const ui = mount(t);
  add(ui, 'subdivide');
  add(ui, 'mirror');
  assertOneUndoStep(ui, ui.controller.exportRecipe(), () => press(ui, 1, 'apply'));
  const geometry = ui.controller.exportRecipe().geometries.find(candidate => candidate.id === 'half');
  assert.deepEqual(geometry.edits.map(edit => edit.op), ['translate', 'mirror']);
  assert.deepEqual(geometry.stack.map(node => node.op), ['subdivide']);
});

test('a switched-off modifier is not applied: the person is told and nothing changes', t => {
  const ui = mount(t);
  add(ui, 'mirror');
  press(ui, 0, 'enable');
  const before = ui.controller.exportRecipe();
  press(ui, 0, 'apply');
  assert.deepEqual(ui.controller.exportRecipe(), before);
});

test('dragging a modifier onto another moves it there in one undo step, and the move buttons do the same', t => {
  const ui = mount(t);
  for (const operation of ['mirror', 'subdivide', 'bevel']) add(ui, operation);
  const dataTransfer = { setData() {}, effectAllowed: '', dropEffect: '' };
  assertOneUndoStep(ui, ui.controller.exportRecipe(), () => {
    dispatch(actionButton(ui, 0, 'drag'), 'dragstart', { dataTransfer });
    dispatch(section(ui, 2), 'dragover', { dataTransfer });
    assert.equal(section(ui, 2).dataset.drop, 'after');
    dispatch(section(ui, 2), 'drop', { dataTransfer });
  });
  assert.deepEqual(stackOf(ui).map(node => node.op), ['subdivide', 'bevel', 'mirror']);
  assert.equal(section(ui, 0).dataset.drop, undefined, 'the drop mark is gone');
  press(ui, 2, 'up');
  assert.deepEqual(stackOf(ui).map(node => node.op), ['subdivide', 'mirror', 'bevel']);
});

test('the first modifier turns a shape into a mesh in the same undo step', t => {
  const ui = mount(t, 'shape');
  const before = ui.controller.exportRecipe();
  assert.equal(before.geometries.find(geometry => geometry.id === 'cube').type, 'box');
  add(ui, 'bevel');
  const after = ui.controller.exportRecipe();
  const geometryId = after.nodes.find(node => node.id === 'shape').geometry;
  const geometry = after.geometries.find(candidate => candidate.id === geometryId);
  assert.equal(geometry.type, 'mesh');
  assert.deepEqual(geometry.stack.map(node => node.op), ['bevel']);
  assert.equal(after.geometries.some(candidate => candidate.id === 'cube'), false, 'nothing else used the shape, so it went');
  add(ui, 'solidify');
  assert.equal(ui.controller.exportRecipe().nodes.find(node => node.id === 'shape').geometry, geometryId, 'the next modifier stays on the same mesh');
  ui.controller.undo();
  ui.controller.undo();
  assert.deepEqual(ui.controller.exportRecipe(), before, 'two undos give the shape back');
});

test('a mesh two objects share is copied before it takes a modifier, and the twin keeps its own', t => {
  const recipe = halfModelRecipe();
  recipe.nodes.push({ id: 'twin', geometry: 'half', material: 'grey', translation: [0, 3, 0] });
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe, renderer: createFakeRenderer() });
  t.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  studio.renderNow();
  studio.controller.selectNode('hero');
  studio.setActiveTab('modifiers');
  const panel = dom.container.firstElementChild.querySelector('.crucible-studio-modifiers');
  dispatch(panel.querySelector('.crucible-studio-modifier-add'), 'click');
  dispatch(panel.querySelector('.crucible-studio-modifier-add-menu').descendants().find(item => item.dataset.modifier === 'mirror'), 'click');
  const after = studio.controller.exportRecipe();
  assert.equal(after.geometries.find(geometry => geometry.id === 'half').stack, undefined, 'the twin still has no modifier');
  assert.notEqual(after.nodes.find(node => node.id === 'hero').geometry, 'half');
});

test('mirror half a model, then smooth it with subdivision: the whole model appears, then it gets more faces', t => {
  const ui = mount(t);
  const [halfMin, halfMax] = extentOnX(heroPositions(ui));
  assert.ok(Math.abs(halfMin) < 1e-6 && Math.abs(halfMax - 1) < 1e-6, 'the model starts as half: x from 0 to 1');
  add(ui, 'mirror');
  const [mirroredMin, mirroredMax] = extentOnX(heroPositions(ui));
  assert.ok(Math.abs(mirroredMin + 1) < 1e-6 && Math.abs(mirroredMax - 1) < 1e-6, `mirrored it spans x from -1 to 1, saw ${mirroredMin} to ${mirroredMax}`);
  const mirroredTriangles = ui.controller.scene.parts.find(part => part.name === 'hero').geometry.indices.length / 3;
  add(ui, 'subdivide');
  const [smoothMin, smoothMax] = extentOnX(heroPositions(ui));
  const smoothTriangles = ui.controller.scene.parts.find(part => part.name === 'hero').geometry.indices.length / 3;
  assert.ok(smoothTriangles > mirroredTriangles, 'subdivision adds faces');
  assert.ok(Math.abs(smoothMin + smoothMax) < 1e-6, 'the mirrored result stays symmetric about x = 0');
  press(ui, 1, 'enable');
  const [offMin, offMax] = extentOnX(heroPositions(ui));
  assert.ok(Math.abs(offMin + 1) < 1e-6 && Math.abs(offMax - 1) < 1e-6, 'switching subdivision off gives the mirrored model back');
});

test('the panel asks for a shape or a mesh when the selection has none, and follows the selection', t => {
  const ui = mount(t);
  ui.controller.selectNode(null);
  ui.studio.renderNow();
  ui.studio.setActiveTab('modifiers');
  assert.equal(ui.panel.dataset.state, 'empty');
  assert.equal(ui.panel.querySelector('.crucible-studio-modifier-add').disabled, true);
  ui.controller.selectNode('hero');
  assert.equal(ui.panel.dataset.state, 'ready');
  assert.equal(ui.panel.querySelector('.crucible-studio-modifier-add').disabled, false);
});

test('evaluateMeshStack reports a switched-off node without running it', () => {
  const mesh = { vertexCount: 8, faceCount: 6 };
  const evaluated = evaluateMeshStack(mesh, [{ op: 'weld', distance: 0.1, enabled: false }]);
  assert.equal(evaluated.mesh, mesh);
  assert.deepEqual(evaluated.results, [{ op: 'weld', enabled: false, after: { vertices: 8, faces: 6 } }]);
});
