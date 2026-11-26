import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { buildNodeWorldMatrices } from '../src/studio-parenting.js';
import { DEFAULT_KEYMAP_ACTIONS, KEYMAP_PRESET_IDS, findKeymapAction, resolveKeymapPreset } from '../src/studio-keymap.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

function makeRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'clay', color: [0.6, 0.5, 0.4] }],
    geometries: [{ id: 'cube', type: 'box' }],
    nodes: [
      { id: 'stand', geometry: 'cube', material: 'clay', translation: [3, 1, -2], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 2, 2] },
      { id: 'propA', geometry: 'cube', material: 'clay', translation: [5, 2, 1], rotation: [0, 0, Math.sin(0.2), Math.cos(0.2)], scale: [0.5, 1.5, 1] },
      { id: 'propB', geometry: 'cube', material: 'clay', translation: [-1, 0.5, 4] },
      { id: 'otherRoot', geometry: 'cube', material: 'clay', translation: [-2, 3, -1], rotation: [Math.sin(0.15), 0, 0, Math.cos(0.15)], scale: [1, 1, 1] },
    ],
    camera: { eye: [4, 4, 8], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  };
}

function worldMatrixOf(controller, nodeId) {
  return Array.from(buildNodeWorldMatrices(controller.exportRecipe().nodes).get(nodeId));
}

function assertSameMatrix(actual, expected, label) {
  for (let index = 0; index < 16; index += 1) {
    assert.ok(Math.abs(actual[index] - expected[index]) < 1e-3, `${label}[${index}]: ${actual[index]} !== ${expected[index]}`);
  }
}

function mountStudio(testContext, recipe = makeRecipe()) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe, renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.lastElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  studio.renderNow();
  return {
    dom,
    studio,
    root,
    controller: studio.controller,
    outlinerTree: root.querySelector('.crucible-studio-tree'),
    rowFor: id => root.querySelectorAll('.crucible-studio-tree-row').find(row => row.dataset.nodeId === id),
    status: () => root.querySelector('.crucible-studio-status').textContent,
    press: (key, modifiers = {}) => dispatch(dom.document, 'keydown', { key, ...modifiers }),
  };
}

test('setting and clearing a parent keeps the object at the same world transform (#3300)', () => {
  const controller = createStudioController({ scene: createAgentScene(makeRecipe()) });
  const beforePropA = worldMatrixOf(controller, 'propA');
  const beforeStand = worldMatrixOf(controller, 'stand');

  controller.updateNodeTransform('propA', { parent: 'stand' });
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'propA').parent, 'stand');
  assertSameMatrix(worldMatrixOf(controller, 'propA'), beforePropA, 'propA kept world transform when parented to rotated scaled stand');

  controller.updateNodeTransform('propA', { parent: 'otherRoot' });
  assertSameMatrix(worldMatrixOf(controller, 'propA'), beforePropA, 'propA kept world transform when reparented between parents');

  controller.updateNodeTransform('propA', { parent: null });
  assert.equal(controller.exportRecipe().nodes.find(node => node.id === 'propA').parent ?? null, null);
  assertSameMatrix(worldMatrixOf(controller, 'propA'), beforePropA, 'propA kept world transform when cleared back to root');
  assertSameMatrix(worldMatrixOf(controller, 'stand'), beforeStand, 'parent stand stayed untouched');

  assert.throws(() => controller.reparentNodes(['stand'], 'stand'), /Cannot parent a node under itself/);
  controller.reparentNodes(['propA'], 'stand');
  assert.throws(() => controller.reparentNodes(['stand'], 'propA'), /Cannot parent a node under itself or its descendant/);
  controller.dispose();
});

test('Ctrl+P parents selected objects to the active one and Alt+P clears parents in one undo step each (#3300)', testContext => {
  const ui = mountStudio(testContext);
  const worldBeforeA = worldMatrixOf(ui.controller, 'propA');
  const worldBeforeB = worldMatrixOf(ui.controller, 'propB');

  // Fewer than two objects picked warns cleanly.
  ui.controller.selectNode('propA');
  ui.press('p', { ctrlKey: true });
  assert.match(ui.status(), /Select two or more objects to parent/);

  ui.controller.selectNodes(['propA', 'propB', 'stand'], { active: 'stand' });
  ui.press('p', { ctrlKey: true });
  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propA').parent, 'stand');
  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propB').parent, 'stand');
  assertSameMatrix(worldMatrixOf(ui.controller, 'propA'), worldBeforeA, 'Ctrl+P keeps propA world transform');
  assertSameMatrix(worldMatrixOf(ui.controller, 'propB'), worldBeforeB, 'Ctrl+P keeps propB world transform');

  // Single undo clears both parents at once.
  ui.controller.undo();
  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propA').parent ?? null, null);
  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propB').parent ?? null, null);
  ui.controller.redo();
  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propA').parent, 'stand');
  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propB').parent, 'stand');

  // Alt+P unparents all selected children in one undo step keeping world transforms.
  ui.controller.selectNodes(['propA', 'propB'], { active: 'propB' });
  ui.press('p', { altKey: true });
  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propA').parent ?? null, null);
  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propB').parent ?? null, null);
  assertSameMatrix(worldMatrixOf(ui.controller, 'propA'), worldBeforeA, 'Alt+P keeps propA world transform');
  assertSameMatrix(worldMatrixOf(ui.controller, 'propB'), worldBeforeB, 'Alt+P keeps propB world transform');

  ui.controller.undo();
  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propA').parent, 'stand');
  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propB').parent, 'stand');
});

test('dragging a row in the Scene list onto another row sets parent and onto empty tree clears it (#3300)', testContext => {
  const ui = mountStudio(testContext);
  const worldBeforeA = worldMatrixOf(ui.controller, 'propA');

  const propARow = ui.rowFor('propA');
  const standRow = ui.rowFor('stand');
  dispatch(propARow, 'dragstart');
  assert.equal(propARow.dataset.dragging, 'true');
  dispatch(standRow, 'dragover');
  assert.equal(standRow.dataset.dropTarget, 'true');
  dispatch(standRow, 'drop');
  dispatch(propARow, 'dragend');

  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propA').parent, 'stand');
  assertSameMatrix(worldMatrixOf(ui.controller, 'propA'), worldBeforeA, 'drag-drop parenting keeps world transform');
  assert.equal(standRow.dataset.dropTarget, undefined);

  // Dragging a parent row over its own child is refused without highlighting.
  const newStandRow = ui.rowFor('stand');
  const newPropARow = ui.rowFor('propA');
  dispatch(newStandRow, 'dragstart');
  dispatch(newPropARow, 'dragover');
  assert.equal(newPropARow.dataset.dropTarget, undefined);
  dispatch(newStandRow, 'dragend');

  // Dragging child onto empty Scene list space clears its parent.
  dispatch(newPropARow, 'dragstart');
  dispatch(ui.outlinerTree, 'dragover');
  assert.equal(ui.outlinerTree.dataset.dropRoot, 'true');
  dispatch(ui.outlinerTree, 'drop');
  dispatch(newPropARow, 'dragend');

  assert.equal(ui.studio.exportRecipe().nodes.find(node => node.id === 'propA').parent ?? null, null);
  assertSameMatrix(worldMatrixOf(ui.controller, 'propA'), worldBeforeA, 'drag-drop unparenting keeps world transform');
});

test('keymap registers Ctrl+P and Alt+P without breaking presets (#3300)', () => {
  assert.ok(DEFAULT_KEYMAP_ACTIONS.some(action => action.id === 'edit.parent'));
  assert.ok(DEFAULT_KEYMAP_ACTIONS.some(action => action.id === 'edit.clearParent'));
  for (const presetId of KEYMAP_PRESET_IDS) {
    const keymap = resolveKeymapPreset(presetId);
    assert.equal(findKeymapAction(keymap, { key: 'p', ctrlKey: true }, 'normal')?.actionId, 'edit.parent');
    assert.equal(findKeymapAction(keymap, { key: 'p', altKey: true }, 'normal')?.actionId, 'edit.clearParent');
  }
});
