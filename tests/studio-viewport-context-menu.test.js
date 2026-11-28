import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { MODIFIER_CHOICES, addModifier, modifierRefusalOf } from '../src/studio-modifier-panel.js';
import { byText, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const VIEWPORT_BOX = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };

function recipeOf() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.8, 0.25, 0.2] }],
    nodes: [
      { id: 'plank', geometry: 'block', material: 'paint', translation: [-1.5, 0, 0] },
      { id: 'crate', geometry: 'block', material: 'paint', translation: [1.5, 0, 0] },
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
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  studio.renderNow();
  const canvas = viewport.querySelector('canvas');
  const pointOnObject = nodeId => {
    const selectedBefore = studio.controller.selectedNodeIds;
    studio.controller.selectNode(nodeId);
    const point = studio.controller.projectWorldPoint(studio.controller.gizmoHandles().pivot);
    studio.controller.selectNodes(selectedBefore);
    return { clientX: point.x + VIEWPORT_BOX.left, clientY: point.y + VIEWPORT_BOX.top };
  };
  const rightClick = point => {
    dispatch(canvas, 'pointerdown', { button: 2, pointerId: 7, ...point });
    dispatch(canvas, 'pointerup', { button: 2, ...point });
    dom.runTimers();
  };
  return {
    dom,
    root,
    canvas,
    viewport,
    controller: studio.controller,
    pointOnObject,
    rightClick,
    popover: id => root.querySelector(`#crucible-studio-pop-${id}`),
    node: nodeId => studio.exportRecipe().nodes.find(node => node.id === nodeId),
    geometryOf: nodeId => studio.exportRecipe().geometries.find(geometry => geometry.id === studio.exportRecipe().nodes.find(node => node.id === nodeId).geometry),
    press: (key, modifiers = {}) => dispatch(dom.document, 'keydown', { key, ...modifiers }),
  };
}

const EMPTY_SPACE = { clientX: VIEWPORT_BOX.left + 20, clientY: VIEWPORT_BOX.top + 20 };

test('a right click on empty space with nothing selected opens the scene menu, whose Add object row opens the Add menu', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode(null);
  ui.rightClick(EMPTY_SPACE);
  const scene = ui.popover('scene');
  assert.equal(scene.popoverOpen, true);
  assert.equal(ui.popover('object').popoverOpen, false);
  assert.deepEqual(scene.querySelectorAll('button').map(button => button.textContent.replace(/(Ctrl\+V|Alt\+H)$/, '')), ['Add object…', 'Paste', 'Show all']);
  assert.equal(scene.style.left, `${EMPTY_SPACE.clientX}px`);
  byText(scene, 'Add object…').click();
  assert.equal(ui.popover('add').popoverOpen, true);
});

test('a right click on an object that is not selected selects it first and opens the object menu', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNode('crate');
  ui.rightClick(ui.pointOnObject('plank'));
  assert.deepEqual(ui.controller.selectedNodeIds, ['plank']);
  assert.equal(ui.popover('object').popoverOpen, true);
  assert.equal(ui.popover('scene').popoverOpen, false);
});

test('a right click on an object that is already selected keeps the whole selection', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNodes(['plank', 'crate']);
  ui.rightClick(ui.pointOnObject('plank'));
  assert.deepEqual(ui.controller.selectedNodeIds.sort(), ['crate', 'plank']);
  assert.equal(ui.popover('object').popoverOpen, true);
});

test('Add Modifier lists the Modifiers tab choices and adds one the way the tab does, as one undo step', testContext => {
  const ui = mountStudio(testContext);
  ui.rightClick(ui.pointOnObject('plank'));
  byText(ui.popover('object'), 'Add Modifier…').click();
  const submenu = ui.popover('add-modifier');
  assert.equal(submenu.popoverOpen, true);
  assert.deepEqual(submenu.querySelectorAll('button').map(button => button.textContent), MODIFIER_CHOICES.map(choice => choice.title));

  byText(submenu, 'Bevel').click();
  assert.deepEqual(ui.geometryOf('plank').stack, [{ op: 'bevel', width: 0.05, segments: 2 }]);
  assert.equal(ui.geometryOf('plank').type, 'mesh', 'a shape becomes a mesh in the same step');
  assert.match(ui.root.querySelector('.crucible-studio-status').textContent, /Bevel added/);
  assert.equal(ui.geometryOf('crate').type, 'box', 'the other object is untouched');

  ui.controller.undo();
  assert.equal(ui.geometryOf('plank').type, 'box', 'one undo takes the modifier and the mesh conversion back');
});

test('addModifier gives the same stack as the panel, refuses a bad name and an empty selection', testContext => {
  const ui = mountStudio(testContext);
  assert.match(modifierRefusalOf(ui.controller, null), /Select a shape or a mesh/);
  assert.throws(() => addModifier(ui.controller, null, 'bevel'), /Select a shape or a mesh/);
  assert.throws(() => addModifier(ui.controller, 'plank', 'twist'), /Unknown modifier "twist"\. Use one of subdivide, mirror, array, bevel, solidify/);
  addModifier(ui.controller, 'plank', 'mirror');
  addModifier(ui.controller, 'plank', 'array');
  assert.deepEqual(ui.geometryOf('plank').stack.map(node => node.op), ['mirror', 'array']);
});

test('the Menu key and Shift+F10 open the menu at the pointer, also when the right button is not free', testContext => {
  const ui = mountStudio(testContext);
  const point = ui.pointOnObject('crate');
  dispatch(ui.canvas, 'pointermove', point);
  const handled = ui.press('F10', { shiftKey: true });
  assert.equal(handled.defaultPrevented, true);
  assert.deepEqual(ui.controller.selectedNodeIds, ['crate']);
  assert.equal(ui.popover('object').popoverOpen, true);
  ui.popover('object').hidePopover();
  ui.press('ContextMenu');
  assert.equal(ui.popover('object').popoverOpen, true);
});

test('the Menu key does nothing while the pointer is away from the viewport', testContext => {
  const ui = mountStudio(testContext);
  const handled = ui.press('ContextMenu');
  assert.equal(handled.defaultPrevented, false);
  assert.equal(ui.popover('scene').popoverOpen, false);
});

test('arrow keys, Home and End move between the rows of the menus', testContext => {
  const ui = mountStudio(testContext);
  ui.rightClick(ui.pointOnObject('plank'));
  const menu = ui.popover('object');
  const rows = menu.querySelectorAll('button').filter(row => row.getAttribute('aria-disabled') !== 'true');
  rows[0].focus();
  dispatch(menu, 'keydown', { key: 'ArrowDown' });
  assert.equal(ui.dom.document.activeElement, rows[1]);
  dispatch(menu, 'keydown', { key: 'End' });
  assert.equal(ui.dom.document.activeElement, rows.at(-1));
  dispatch(menu, 'keydown', { key: 'ArrowDown' });
  assert.equal(ui.dom.document.activeElement, rows[0], 'it wraps');
  dispatch(menu, 'keydown', { key: 'ArrowUp' });
  assert.equal(ui.dom.document.activeElement, rows.at(-1));
});
