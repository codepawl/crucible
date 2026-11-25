import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { createApplyMenus } from '../src/studio-apply-menu.js';
import { byText, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
const QUARTER_TURN_ABOUT_Z = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

function recipeOf() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.8, 0.25, 0.2] }],
    nodes: [
      { id: 'plank', geometry: 'block', material: 'paint', translation: [1, 1, 0], scale: [3, 2, 0.5] },
      { id: 'group', geometry: 'block', material: 'paint', translation: [4, 0, 0] },
      { id: 'member', parent: 'group', geometry: 'block', material: 'paint' },
    ],
    camera: { eye: [0, 2, 8], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
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
  root.querySelector('.crucible-studio-viewport').box = VIEWPORT_BOX;
  studio.renderNow();
  return {
    dom,
    root,
    controller: studio.controller,
    status: () => root.querySelector('.crucible-studio-status').textContent,
    node: nodeId => studio.exportRecipe().nodes.find(node => node.id === nodeId),
    press: (key, modifiers = {}) => dispatch(root, 'keydown', { key, ...modifiers }),
  };
}

function worldBottom(controller, nodeId) {
  const part = controller.scene.parts.find(candidate => candidate.name === nodeId);
  const positions = part.geometry.positions;
  const matrix = part.matrix;
  let lowest = Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    lowest = Math.min(lowest, matrix[1] * positions[index] + matrix[5] * positions[index + 1] + matrix[9] * positions[index + 2] + matrix[13]);
  }
  return lowest;
}

test('Ctrl+A opens the Apply menu on a selected object, and Scale folds the scale into the geometry as one undo step', testContext => {
  const ui = mountStudio(testContext);
  const menu = ui.root.querySelector('#crucible-studio-pop-apply');
  assert.deepEqual(menu.querySelectorAll('button').map(button => button.textContent.replace(/Ctrl\+A$/, '')), ['Location', 'Rotation', 'Scale', 'All transforms']);
  ui.controller.selectNode(null);
  ui.press('a', { ctrlKey: true });
  assert.equal(menu.popoverOpen, false, 'nothing is selected, so there is nothing to apply');
  ui.controller.selectNode('plank');
  ui.press('a', { ctrlKey: true });
  assert.equal(menu.popoverOpen, true);
  const bottomBefore = worldBottom(ui.controller, 'plank');

  byText(menu, 'Scale').click();
  assert.deepEqual(ui.node('plank').scale, [1, 1, 1]);
  assert.deepEqual(ui.node('plank').translation, [1, 1, 0]);
  assert.ok(Math.abs(worldBottom(ui.controller, 'plank') - bottomBefore) < 1e-5, 'it looks the same');
  assert.match(ui.status(), /Scale applied\. The shape is now a mesh/);

  ui.controller.undo();
  assert.deepEqual(ui.node('plank').scale, [3, 2, 0.5], 'one undo gives the scale back');
  assert.equal(ui.controller.exportRecipe().geometries.find(geometry => geometry.id === 'block').type, 'box', 'and the shape');
});

test('the right-click menu of an object has Apply and Set origin rows that open their menus', testContext => {
  const ui = mountStudio(testContext);
  const objectMenu = ui.root.querySelector('#crucible-studio-pop-object');
  const labels = objectMenu.querySelectorAll('button').map(button => button.textContent);
  assert.ok(labels.some(label => label.startsWith('Apply…')) && labels.some(label => label.startsWith('Set origin…')));
  ui.controller.selectNode('plank');
  byText(objectMenu, 'Set origin…').click();
  assert.equal(ui.root.querySelector('#crucible-studio-pop-origin').popoverOpen, true);
});

test('Origin to bottom centre keeps the object in place, and a turn then swings about the bottom', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode('plank');
  const bottomBefore = worldBottom(ui.controller, 'plank');
  const origin = ui.root.querySelector('#crucible-studio-pop-origin');
  byText(origin, 'Origin to bottom centre').click();
  assert.ok(Math.abs(worldBottom(ui.controller, 'plank') - bottomBefore) < 1e-5, 'nothing moved');
  assert.ok(Math.abs(ui.node('plank').translation[1] - bottomBefore) < 1e-5, 'the node now sits at the bottom');
  ui.controller.updateNodeTransform('plank', { rotation: QUARTER_TURN_ABOUT_Z });
  assert.ok(Math.abs(ui.node('plank').translation[1] - bottomBefore) < 1e-5, 'a turn keeps the pivot where it was');
  ui.controller.undo();
  ui.controller.undo();
  assert.deepEqual(ui.node('plank').translation, [1, 1, 0], 'the turn and the origin are two undo steps');
});

test('applying a part that is already at rest says so and adds no undo step', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode('plank');
  const before = JSON.stringify(ui.controller.exportRecipe());
  byText(ui.root.querySelector('#crucible-studio-pop-apply'), 'Rotation').click();
  assert.match(ui.status(), /Nothing to apply/);
  assert.equal(JSON.stringify(ui.controller.exportRecipe()), before);
});

test('applying to an object that has children is refused with the fix', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode('group');
  byText(ui.root.querySelector('#crucible-studio-pop-apply'), 'All transforms').click();
  assert.match(ui.status(), /without children/);
  assert.deepEqual(ui.node('group').translation, [4, 0, 0]);
});

test('Origin to selection moves the origin to the picked vertices and says so when nothing is picked', () => {
  const scene = createAgentScene({ ...recipeOf(), nodes: [{ id: 'plank', geometry: 'block', material: 'paint', translation: [1, 1, 0] }] });
  const controller = createStudioController({ scene, viewportWidth: 800, viewportHeight: 600 });
  controller.selectNode('plank');
  const messages = [];
  const items = new Map();
  const createMenuItem = (label, actionId, onChoose) => {
    const item = { label, click: onChoose, addEventListener() {} };
    items.set(label, item);
    return item;
  };
  const createMenuPopover = (id, ...children) => ({ id, children, addEventListener() {} });
  let editor = { active: true, selectionCentreLocal: () => null };
  const menus = createApplyMenus({
    createMenuPopover,
    createMenuItem,
    controller,
    announce: message => messages.push(message),
    announceError: message => messages.push(`error: ${message}`),
    getMeshEditor: () => editor,
    openPopoverAtMenuPoint: () => {},
  });
  menus.setOrigin('selection');
  assert.match(messages.at(-1), /Pick a vertex, an edge or a face in edit mode first/);
  editor = { active: true, selectionCentreLocal: () => [0.5, 0.5, 0.5] };
  menus.setOrigin('selection');
  assert.deepEqual(controller.exportRecipe().nodes[0].translation.map(value => Number(value.toFixed(6))), [1.5, 1.5, 0.5]);
  assert.equal(messages.at(-1), 'Origin moved to the selection.');
  editor = { active: false, selectionCentreLocal: () => [0.5, 0.5, 0.5] };
  menus.setOrigin('selection');
  assert.match(messages.at(-1), /Pick a vertex/);
});
