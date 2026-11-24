import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { STUDIO_CSS } from '../src/studio-styles.js';
import { DEFAULT_KEYMAP_ACTIONS, resolveKeymapPreset, KEYMAP_PRESET_IDS } from '../src/studio-keymap.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { SELECTION_HULL_LIMIT } from '../src/studio-controller.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';
import { createFakeWebgl2 } from './support/fake-webgl2.mjs';

function makeRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'floor', type: 'box', bevel: 0 },
      { id: 'cube', type: 'box', bevel: 0.04 },
      { id: 'sphere', type: 'sphere', segments: 16, rings: 12 },
    ],
    materials: [
      { id: 'stone', tag: 'surface', color: [0.3, 0.32, 0.35], roughness: 0.8, metallic: 0 },
      { id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 },
    ],
    nodes: [
      { id: 'ground', geometry: 'floor', material: 'stone', translation: [0, -0.2, 0], scale: [10, 0.4, 10] },
      { id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] },
      { id: 'orb', geometry: 'sphere', material: 'paint', translation: [2.2, 0.5, 0], scale: [0.5, 0.5, 0.5] },
      { id: 'hat', geometry: 'cube', material: 'paint', parent: 'hero', translation: [0, 1, 0], scale: [0.4, 0.2, 0.4] },
      { id: 'ghost', geometry: 'cube', material: 'paint', translation: [-2.2, 0.5, 0], visible: false },
    ],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

function makeController(options = {}) {
  return createStudioController({ scene: createAgentScene(makeRecipe()), viewportWidth: 800, viewportHeight: 600, ...options });
}

test('selectNodes replaces, adds, toggles and removes, and the active node follows the rules', () => {
  const controller = makeController();
  assert.deepEqual(controller.selectNodes(['hero', 'orb']), ['hero', 'orb']);
  assert.equal(controller.selectedNodeId, 'orb', 'the last one of a replace is active');
  controller.selectNodes(['ground'], { mode: 'add' });
  assert.deepEqual(controller.selectedNodeIds, ['hero', 'orb', 'ground']);
  assert.equal(controller.selectedNodeId, 'ground');
  controller.selectNodes(['hero'], { mode: 'add' });
  assert.deepEqual(controller.selectedNodeIds, ['orb', 'ground', 'hero'], 'adding a selected one again makes it the last and the active one');
  assert.equal(controller.selectedNodeId, 'hero');
  controller.selectNodes(['orb'], { mode: 'toggle' });
  assert.deepEqual(controller.selectedNodeIds, ['ground', 'hero']);
  assert.equal(controller.selectedNodeId, 'hero', 'taking out a node that is not active keeps the active one');
  controller.selectNodes(['hero'], { mode: 'toggle' });
  assert.deepEqual(controller.selectedNodeIds, ['ground']);
  assert.equal(controller.selectedNodeId, 'ground', 'taking out the active node leaves the last one still selected active');
  controller.selectNodes(['orb', 'hat'], { mode: 'toggle' });
  assert.deepEqual(controller.selectedNodeIds, ['ground', 'orb', 'hat']);
  assert.equal(controller.selectedNodeId, 'hat');
  controller.selectNodes(['hat', 'ground'], { mode: 'remove' });
  assert.deepEqual(controller.selectedNodeIds, ['orb']);
  assert.equal(controller.selectedNodeId, 'orb');
  controller.selectNodes(['ground', 'hero', 'orb'], { active: 'hero' });
  assert.equal(controller.selectedNodeId, 'hero', 'active names the active node');
  assert.deepEqual(controller.selectedNodeIds, ['ground', 'hero', 'orb'], 'and does not reorder the set');
  controller.selectNodes([]);
  assert.deepEqual(controller.selectedNodeIds, []);
  assert.equal(controller.selectedNodeId, null);
});

test('selectedNodeIds is a copy, and selectNode and the getter behave as before', () => {
  const controller = makeController();
  assert.equal(controller.selectedNodeId, 'ground', 'the first mesh starts selected');
  assert.deepEqual(controller.selectedNodeIds, ['ground']);
  controller.selectNodes(['hero', 'orb']);
  controller.selectedNodeIds.push('ground');
  assert.deepEqual(controller.selectedNodeIds, ['hero', 'orb'], 'changing the copy changes nothing');
  assert.equal(controller.selectNode('hat'), 'hat');
  assert.deepEqual(controller.selectedNodeIds, ['hat'], 'selectNode replaces the whole set');
  assert.equal(controller.selectNode(null), null);
  assert.deepEqual(controller.selectedNodeIds, []);
  assert.throws(() => controller.selectNode('missing'), /Unknown node "missing"/);
  assert.throws(() => controller.selectNode(7), /node ID string or null/);
});

test('lights and the camera are exclusive with nodes', () => {
  const controller = makeController();
  controller.selectNodes(['hero', 'orb']);
  controller.selectSceneObject('sun');
  assert.deepEqual(controller.selectedNodeIds, []);
  assert.equal(controller.selectedNodeId, null);
  assert.equal(controller.selectedObjectKey, 'sun');
  controller.selectNodes(['hero'], { mode: 'add' });
  assert.equal(controller.selectedObjectKey, null, 'picking a node leaves the sun');
  assert.deepEqual(controller.selectedNodeIds, ['hero']);
  controller.addSceneLight('point');
  assert.deepEqual(controller.selectedNodeIds, []);
  assert.equal(controller.selectedObjectKey, 'point:0');
  controller.selectNodes(['hero', 'orb'], { mode: 'toggle' });
  assert.equal(controller.selectedObjectKey, null);
  assert.deepEqual(controller.selectedNodeIds, ['hero', 'orb']);
});

test('selectAll skips hidden nodes and keeps the active one, and invertSelection swaps the sets', () => {
  const controller = makeController();
  controller.selectNodes(['hero', 'orb'], { active: 'hero' });
  const everyone = controller.selectAll();
  assert.deepEqual([...everyone].sort(), ['ground', 'hat', 'hero', 'orb'], 'the hidden ghost stays out');
  assert.equal(controller.selectedNodeId, 'hero', 'select all keeps the active node');
  controller.selectNodes(['hero', 'orb']);
  assert.deepEqual([...controller.invertSelection()].sort(), ['ground', 'hat']);
  assert.equal(controller.selectedNodeId, 'hat', 'the last node of an inverted set is active');
  controller.selectAll();
  assert.deepEqual(controller.invertSelection(), []);
  assert.equal(controller.selectedNodeId, null);
});

test('selectionRoots drops a node whose ancestor is selected too', () => {
  const controller = makeController();
  controller.selectNodes(['hat', 'hero', 'orb']);
  assert.deepEqual(controller.selectionRoots(), ['hero', 'orb']);
  controller.selectNodes(['hat', 'orb']);
  assert.deepEqual(controller.selectionRoots(), ['hat', 'orb'], 'a child alone is its own root');
  controller.selectNodes([]);
  assert.deepEqual(controller.selectionRoots(), []);
});

test('undo and redo restore the whole set and the active node', () => {
  const controller = makeController();
  controller.selectNodes(['hero', 'orb'], { active: 'hero' });
  controller.updateNodeTransform('hero', { translation: [1, 0.5, 0] });
  controller.selectNodes(['ground']);
  controller.undo();
  assert.deepEqual(controller.selectedNodeIds, ['hero', 'orb']);
  assert.equal(controller.selectedNodeId, 'hero');
  controller.redo();
  assert.deepEqual(controller.selectedNodeIds, ['ground']);
  assert.equal(controller.selectedNodeId, 'ground');
});

test('a node that is deleted, by delete or by undo, leaves the set', () => {
  const controller = makeController();
  controller.selectNodes(['hero', 'orb']);
  controller.deleteSelected();
  assert.deepEqual(controller.selectedNodeIds, [], 'nothing is left selected after a delete, so a second Delete cannot hit a node nobody picked');
  assert.equal(controller.selectedNodeId, null);
  controller.undo();
  assert.deepEqual(controller.selectedNodeIds, ['hero', 'orb'], 'undo brings the node and the set back');
  controller.redo();
  assert.deepEqual(controller.selectedNodeIds, [], 'redo takes the node out again and restores the set it was undone with');
  const added = controller.addPrimitive('box');
  controller.selectNodes([added.id, 'hero']);
  controller.undo();
  assert.ok(!controller.selectedNodeIds.includes(added.id), 'a node an undo removes is never selected');
  controller.selectNodes(['ground', 'hat']);
  controller.loadRecipe({ ...makeRecipe(), nodes: makeRecipe().nodes.filter(node => node.id !== 'hat') });
  assert.deepEqual(controller.selectedNodeIds, ['ground'], 'a node a new recipe lacks falls out of the set');
  assert.equal(controller.selectedNodeId, 'ground');
});

test('pickAt takes a mode, and a click on empty space clears only a replacing selection', () => {
  const controller = makeController();
  const heroPoint = controller.projectWorldPoint([0, 0.5, 0]);
  const orbPoint = controller.projectWorldPoint([2.2, 0.5, 0]);
  controller.pickAt(heroPoint.x, heroPoint.y);
  assert.deepEqual(controller.selectedNodeIds, ['hero']);
  controller.pickAt(orbPoint.x, orbPoint.y, { mode: 'toggle' });
  assert.deepEqual(controller.selectedNodeIds, ['hero', 'orb']);
  assert.equal(controller.selectedNodeId, 'orb');
  controller.pickAt(12, 12, { mode: 'toggle' });
  assert.deepEqual(controller.selectedNodeIds, ['hero', 'orb'], 'an empty click that toggles keeps the selection');
  controller.pickAt(orbPoint.x, orbPoint.y, { mode: 'toggle' });
  assert.deepEqual(controller.selectedNodeIds, ['hero']);
  controller.pickAt(orbPoint.x, orbPoint.y);
  assert.deepEqual(controller.selectedNodeIds, ['orb'], 'a plain pick replaces');
  controller.pickAt(12, 12);
  assert.deepEqual(controller.selectedNodeIds, []);
  assert.throws(() => controller.pickAt(1, 1, { mode: 'swap' }), /Unknown selection mode "swap"/);
});

test('onChange details carry the whole selection', () => {
  const details = [];
  const controller = makeController({ onChange: detail => details.push(detail) });
  controller.selectNodes(['hero', 'orb']);
  const last = details.at(-1);
  assert.equal(last.kind, 'selection');
  assert.deepEqual(last.selectedNodeIds, ['hero', 'orb']);
  assert.equal(last.selectedNodeId, 'orb');
});

test('selectNodes names what it was given wrong and what to pass instead', () => {
  const controller = makeController();
  assert.throws(() => controller.selectNodes('hero'), /array of node ID strings/);
  assert.throws(() => controller.selectNodes(['hero', 4]), /array of node ID strings/);
  assert.throws(() => controller.selectNodes(['hero', 'missing']), /Unknown node "missing"/);
  assert.throws(() => controller.selectNodes(['hero'], { mode: 'swap' }), /Unknown selection mode "swap". Use one of replace, add, toggle, remove/);
  assert.throws(() => controller.selectNodes(['hero'], { active: 'orb' }), /Active node "orb" is not in the selection/);
  assert.throws(() => controller.selectNodes(['hero'], { active: 3 }), /active must be a node ID string/);
  assert.deepEqual(controller.selectedNodeIds, ['ground'], 'a refused call changes nothing');
});

test('the outline has an active layer and a layer for the rest, and one selection keeps its single layer', () => {
  const controller = makeController();
  controller.selectNode('hero');
  const single = controller.selectionSilhouetteLayers();
  assert.ok(single.active.length >= 6 && single.othersExist === false);
  assert.deepEqual(controller.selectionSilhouette(), single.active, 'a single selection has the one outline it had');
  controller.selectNodes(['hero', 'orb', 'ground'], { active: 'orb' });
  const layers = controller.selectionSilhouetteLayers();
  assert.ok(layers.active.length > 0 && layers.others.length > 0);
  assert.equal(layers.activeExists && layers.othersExist, true);
  assert.equal(controller.selectionSilhouette().length, layers.active.length + layers.others.length, 'the union is both layers');
  const hulls = controller.selectionOutlineLayers();
  assert.equal(hulls.filter(layer => layer.active).length, 1);
  assert.equal(hulls.length, 3);
  controller.selectNodes([]);
  assert.equal(controller.selectionSilhouette(), null);
  assert.deepEqual(controller.selectionOutlineLayers(), []);
});

test('the default keymap binds select all, none and invert, and no preset loses them or breaks', () => {
  const byId = Object.fromEntries(DEFAULT_KEYMAP_ACTIONS.map(item => [item.id, item.bindings]));
  assert.deepEqual(byId['select.all'], [{ key: 'a', shift: false }]);
  assert.deepEqual(byId['select.none'], [{ code: 'KeyA', alt: true }], 'by code, so Option+A on a Mac matches');
  assert.deepEqual(byId['select.invert'], [{ key: 'i', ctrl: true }]);
  for (const presetId of KEYMAP_PRESET_IDS) {
    const keymap = resolveKeymapPreset(presetId);
    assert.ok(keymap.actions.some(item => item.id === 'select.all' && item.bindings.length === 1), `${presetId} keeps select all`);
  }
});


function mountStudio(testContext) {
  const dom = installStudioDom();
  const renderer = createFakeRenderer();
  const studio = createStudio(dom.container, { recipe: makeRecipe(), renderer });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
  studio.renderNow();
  const canvas = viewport.querySelector('canvas');
  const gizmo = viewport.querySelector('.crucible-studio-gizmo');
  const controller = studio.controller;
  const click = (worldPoint, modifiers = {}) => {
    const point = Array.isArray(worldPoint) ? controller.projectWorldPoint(worldPoint) : worldPoint;
    const position = { clientX: point.x + 40, clientY: point.y + 30 };
    dispatch(canvas, 'pointerdown', { ...position, ...modifiers });
    dispatch(canvas, 'pointerup', { ...position, ...modifiers });
  };
  const pressKey = (key, properties = {}, target = dom.document) => dispatch(target, 'keydown', { key, ...properties });
  return { dom, studio, controller, root, canvas, gizmo, click, pressKey };
}

const HERO = [0, 0.5, 0];
const ORB = [2.2, 0.5, 0];
const GROUND_EDGE = [3.5, -0.2, 2.5];

test('in the viewport a plain click replaces, Shift or Ctrl toggles, and empty space clears', testContext => {
  const ui = mountStudio(testContext);
  ui.click(HERO);
  assert.deepEqual(ui.controller.selectedNodeIds, ['hero']);
  ui.click(ORB, { shiftKey: true });
  assert.deepEqual(ui.controller.selectedNodeIds, ['hero', 'orb']);
  assert.equal(ui.controller.selectedNodeId, 'orb', 'the object Shift+click added is active');
  ui.click(GROUND_EDGE, { ctrlKey: true });
  assert.deepEqual(ui.controller.selectedNodeIds, ['hero', 'orb', 'ground'], 'Ctrl+click does the same');
  ui.click(ORB, { metaKey: true });
  assert.deepEqual(ui.controller.selectedNodeIds, ['hero', 'ground'], 'Command+click on a selected object takes it out');
  ui.click({ x: 12, y: 12 }, { shiftKey: true });
  assert.deepEqual(ui.controller.selectedNodeIds, ['hero', 'ground'], 'Shift+click on empty space keeps the selection');
  ui.click(HERO);
  assert.deepEqual(ui.controller.selectedNodeIds, ['hero'], 'a plain click replaces');
  ui.click({ x: 12, y: 12 });
  assert.deepEqual(ui.controller.selectedNodeIds, [], 'a click on empty space clears');
});

test('the outline of three selected objects has two strengths, the active one on top', testContext => {
  const ui = mountStudio(testContext);
  ui.controller.selectNodes(['hero', 'orb', 'ground'], { active: 'orb' });
  ui.studio.renderNow();
  const paths = ui.gizmo.querySelectorAll('.crucible-studio-selection-silhouette');
  assert.deepEqual(paths.map(path => path.getAttribute('data-layer')), ['others', 'active'], 'the rest first, the active one over it');
  const filters = ui.gizmo.descendants().filter(element => element.tagName.toLowerCase() === 'filter');
  assert.equal(new Set(filters.map(filter => filter.getAttribute('id'))).size, 2, 'each layer has its own filter');
  assert.deepEqual(paths.map(path => path.getAttribute('filter')), filters.map(filter => `url(#${filter.getAttribute('id')})`));
  const colours = ui.gizmo.querySelectorAll('.crucible-studio-silhouette-colour');
  assert.deepEqual(colours.map(colour => colour.getAttribute('data-layer')).sort(), ['active', 'others']);
  ui.controller.selectNode('hero');
  ui.studio.renderNow();
  assert.deepEqual(ui.gizmo.querySelectorAll('.crucible-studio-selection-silhouette').map(path => path.getAttribute('data-layer')), ['active']);
});

test('A, Alt+A and Ctrl+I select all, none and invert, and do nothing while a field has the keys', testContext => {
  const ui = mountStudio(testContext);
  ui.pressKey('a');
  assert.deepEqual([...ui.controller.selectedNodeIds].sort(), ['ground', 'hat', 'hero', 'orb']);
  const held = ui.pressKey('a', { altKey: true, code: 'KeyA' });
  assert.equal(held.defaultPrevented, true, 'Alt+A is taken from the browser');
  assert.deepEqual(ui.controller.selectedNodeIds, []);
  ui.controller.selectNodes(['hero']);
  const inverted = ui.pressKey('i', { ctrlKey: true });
  assert.equal(inverted.defaultPrevented, true);
  assert.deepEqual([...ui.controller.selectedNodeIds].sort(), ['ground', 'hat', 'orb']);
  ui.pressKey('å', { altKey: true, code: 'KeyA' });
  assert.deepEqual(ui.controller.selectedNodeIds, [], 'Option+A on a Mac types a different letter and still matches by code');
  const field = ui.root.querySelectorAll('input').find(input => input.type === 'text' || input.type === undefined || input.type === '');
  assert.ok(field, 'the Properties panel has a text field');
  ui.controller.selectNodes(['hero']);
  dispatch(field, 'keydown', { key: 'a' });
  dispatch(field, 'keydown', { key: 'a', altKey: true, code: 'KeyA' });
  dispatch(field, 'keydown', { key: 'i', ctrlKey: true });
  assert.deepEqual(ui.controller.selectedNodeIds, ['hero'], 'typing in a field changes no selection');
  ui.pressKey('a', { shiftKey: true });
  assert.deepEqual(ui.controller.selectedNodeIds, ['hero'], 'Shift+A still opens the Add menu, not select all');
});

test('the Properties head counts the selection from two objects on', testContext => {
  const ui = mountStudio(testContext);
  const count = ui.root.querySelector('.crucible-studio-selection-count');
  assert.ok(count, 'the head has a count');
  ui.controller.selectNode('hero');
  assert.equal(count.hidden, true, 'one selected object needs no count');
  ui.controller.selectNodes(['orb', 'ground'], { mode: 'add' });
  assert.equal(count.hidden, false);
  assert.equal(count.textContent, '3 selected');
  assert.ok(count.querySelector('.crucible-studio-icon'), 'an icon leads the count');
  ui.controller.selectNodes(['orb'], { mode: 'remove' });
  assert.equal(count.textContent, '2 selected');
  ui.controller.selectNode(null);
  assert.equal(count.hidden, true);
});

test('the shortcuts list has a row for select all, none and invert', testContext => {
  const ui = mountStudio(testContext);
  ui.pressKey('?');
  const text = ui.root.textContent;
  assert.match(text, /A \/ Alt\+A \/ Ctrl\+I/);
  assert.match(text, /Select all \/ none \/ invert/);
});

test('the embedder API selects several nodes', testContext => {
  const ui = mountStudio(testContext);
  assert.deepEqual(ui.studio.selectNodes(['hero', 'orb']), ['hero', 'orb']);
  assert.deepEqual(ui.studio.selectedNodeIds, ['hero', 'orb']);
  assert.deepEqual([...ui.studio.selectAll()].sort(), ['ground', 'hat', 'hero', 'orb']);
  assert.deepEqual(ui.studio.invertSelection(), []);
  const heroPoint = ui.controller.projectWorldPoint(HERO);
  ui.studio.pickAt(heroPoint.x, heroPoint.y, { mode: 'add' });
  assert.deepEqual(ui.studio.selectedNodeIds, ['hero']);
});

test('selectNodes takes a null or missing options argument, and names a non-object one', () => {
  const controller = makeController();
  assert.deepEqual(controller.selectNodes(['hero'], null), ['hero']);
  assert.deepEqual(controller.selectNodes(['orb'], undefined), ['orb']);
  for (const wrong of ['add', 3, true]) {
    assert.throws(() => controller.selectNodes(['hero'], wrong), error => error instanceof TypeError && /options must be an object/.test(error.message) && /mode/.test(error.message));
  }
  assert.deepEqual(controller.selectedNodeIds, ['orb'], 'a refused call changes nothing');
});

function makeCrowdController(count) {
  const recipe = makeRecipe();
  recipe.nodes = Array.from({ length: count }, (_, index) => ({
    id: `crowd-${index}`,
    geometry: 'cube',
    material: 'paint',
    translation: [(index % 10) * 0.4 - 2, 0.3, Math.floor(index / 10) * 0.4 - 1],
    scale: [0.1, 0.1, 0.1],
  }));
  return createStudioController({ scene: createAgentScene(recipe), viewportWidth: 800, viewportHeight: 600 });
}

test('the hull outline fallback draws the active node and at most the limit of the others', () => {
  const controller = makeCrowdController(60);
  controller.selectNodes(Array.from({ length: 60 }, (_, index) => `crowd-${index}`), { active: 'crowd-59' });
  const hulls = controller.selectionOutlineLayers();
  assert.equal(hulls.length, SELECTION_HULL_LIMIT + 1, 'the cap counts the others, and the active one comes on top of it');
  assert.equal(hulls.filter(layer => layer.active).length, 1, 'the active node always has its hull');
  controller.selectNodes(['crowd-0', 'crowd-1'], { active: 'crowd-1' });
  assert.equal(controller.selectionOutlineLayers().length, 2, 'a small selection is outlined in full');
  controller.selectNodes(Array.from({ length: 60 }, (_, index) => `crowd-${index}`), { active: 'crowd-0' });
  assert.ok(controller.selectionOutlineLayers().some(layer => layer.active), 'the active node is outlined even when it is the first of many');
});

test('the Scene list marks every selected row, the active one apart, and Shift or Ctrl click toggles a row', testContext => {
  const ui = mountStudio(testContext);
  const rowFor = id => ui.root.querySelectorAll('.crucible-studio-tree-row').find(row => row.dataset.sceneObject === undefined && row.textContent.includes(id));
  const press = (id, modifiers = {}) => dispatch(rowFor(id).querySelector('.crucible-studio-tree-select'), 'click', modifiers);
  ui.controller.selectNodes(['hero', 'orb', 'ground'], { active: 'orb' });
  for (const id of ['hero', 'orb', 'ground']) {
    assert.equal(rowFor(id).getAttribute('aria-selected'), 'true', `${id} is selected`);
    assert.equal(rowFor(id).dataset.selected, 'true');
  }
  assert.equal(rowFor('hat').getAttribute('aria-selected'), 'false');
  assert.equal(rowFor('orb').getAttribute('aria-current'), 'true', 'the active row says so');
  assert.equal(rowFor('hero').getAttribute('aria-current'), null);
  assert.equal(rowFor('orb').dataset.active, 'true');
  assert.notEqual(rowFor('hero').dataset.active, 'true');
  press('hat');
  assert.deepEqual(ui.controller.selectedNodeIds, ['hat'], 'a plain click replaces, as before');
  press('orb', { shiftKey: true });
  assert.deepEqual(ui.controller.selectedNodeIds, ['hat', 'orb']);
  assert.equal(ui.controller.selectedNodeId, 'orb');
  press('hero', { ctrlKey: true });
  assert.deepEqual(ui.controller.selectedNodeIds, ['hat', 'orb', 'hero']);
  press('orb', { metaKey: true });
  assert.deepEqual(ui.controller.selectedNodeIds, ['hat', 'hero'], 'Command+click on a selected row takes it out');
  assert.equal(rowFor('orb').getAttribute('aria-selected'), 'false');
  assert.equal(rowFor('hero').getAttribute('aria-current'), 'true');
  assert.equal(rowFor('hat').getAttribute('aria-current'), null, 'only one row is current');
});

test('the stylesheet gives the active row more weight than the other selected rows, with no border', () => {
  const selected = /\.crucible-studio-tree-row\[data-selected="true"\]\s*{([^}]*)}/.exec(STUDIO_CSS);
  const active = /\.crucible-studio-tree-row\[data-active="true"\]\s*{([^}]*)}/.exec(STUDIO_CSS);
  assert.ok(selected && active, 'both rules exist');
  const share = rule => Number(/var\(--studio-text\) (\d+)%/.exec(rule[1])?.[1]);
  assert.ok(share(active) > share(selected) && share(selected) > 6, 'active > selected > the 6 percent hover');
  assert.doesNotMatch(selected[1] + active[1], /border|box-shadow/);
});

test('select all and invert leave no pill over the viewport, the Properties head carries the count', testContext => {
  const ui = mountStudio(testContext);
  const status = ui.root.querySelector('.crucible-studio-status');
  ui.pressKey('a');
  assert.equal(status.textContent, '', 'select all announces nothing');
  assert.equal(ui.root.querySelector('.crucible-studio-selection-count').textContent, '4 selected');
  ui.controller.selectNodes(['hero']);
  ui.pressKey('i', { ctrlKey: true });
  assert.equal(status.textContent, '', 'invert announces nothing');
});

test('the outline of the rest of the selection is wider than a hairline and apart from the active one by width', () => {
  const edgeWidths = [...STUDIO_CSS.matchAll(/\.crucible-studio-selection-outline(?:\[data-layer="(others)"\])?\s*{([^}]*)}/g)]
    .map(match => ({ layer: match[1] ?? 'active', width: Number(/stroke-width:\s*([\d.]+)/.exec(match[2])?.[1]) }));
  const widthOf = layer => edgeWidths.find(entry => entry.layer === layer && Number.isFinite(entry.width))?.width;
  assert.ok(widthOf('others') >= 1.5, 'the rest is at least 1.5 px');
  assert.ok(widthOf('active') >= widthOf('others') * 2, 'the active outline is at least twice as wide, so the two read apart at a glance');
  assert.doesNotMatch(STUDIO_CSS, /selection-outline\[data-layer="others"\]\s*{[^}]*40%/, 'the rest is no longer faded to 40 percent');
});

test('the outline carries a casing of the viewport dark, which does not follow the UI theme', () => {
  assert.match(STUDIO_CSS, /\.crucible-studio-silhouette-casing\s*{\s*flood-color: var\(--studio-trace-edge\);/);
  assert.match(STUDIO_CSS, /\.crucible-studio-selection-outline-casing\s*{[^}]*stroke: var\(--studio-trace-edge\);/);
  assert.doesNotMatch(STUDIO_CSS, /(?:silhouette-casing|outline-casing)[^}]*--studio-bg/, 'the light theme must not pale the ring');
  const root = /\n\.crucible-studio\s*{([^}]*)}/.exec(STUDIO_CSS)[1];
  assert.match(root, /--studio-trace-edge:\s*#17161a;/, 'declared on the root, so the mask filters outside the gizmo resolve it too');
  assert.doesNotMatch(STUDIO_CSS, /\[data-theme="light"\][^{]*{[^}]*--studio-trace-edge/);
});

test('the outline filters grow the active ring to at least twice the others, on the shape and mask paths alike', testContext => {
  const ui = mountDenseStudio(testContext, null);
  ui.studio.controller.selectNodes(['hat', 'orb'], { active: 'hat' });
  ui.studio.renderNow();
  const radii = steps => steps.filter(step => step.getAttribute('result') === 'grown').map(step => Number(step.getAttribute('radius')));
  const [others, active] = radii(ui.gizmo.querySelectorAll('feMorphology'));
  assert.ok(others >= 1.5, 'the others keep at least 1.5 px');
  assert.ok(active >= others * 2, `active ${active} against others ${others}`);
  const maskFilters = ui.viewport.querySelectorAll('.crucible-studio-mask-filters feMorphology');
  const maskRadii = radii(maskFilters);
  assert.deepEqual(maskRadii.slice(0, 2), [active, others], 'the mask filters use the same pair');
});

function makeDenseRecipe() {
  const recipe = makeRecipe();
  recipe.geometries.push({ id: 'dense-ball', type: 'sphere', segments: 96, rings: 64 });
  recipe.nodes.push({ id: 'dense', geometry: 'dense-ball', material: 'paint', translation: [0, 1, 0] });
  return recipe;
}

test('past the triangle budget the mask has others beside it, and the active object keeps a layer of its own when it fits', () => {
  const controller = createStudioController({ scene: createAgentScene(makeDenseRecipe()), viewportWidth: 800, viewportHeight: 600 });
  controller.selectNodes(['dense', 'hero'], { active: 'hero' });
  assert.equal(controller.selectionMaskSource().othersExist, true);
  const small = controller.selectionSilhouetteLayers();
  assert.ok(small.active.length >= 6, 'a small active object is drawn from its own shape over the mask');
  assert.equal(small.others, null, 'the dense rest is left to the mask');
  assert.equal(controller.selectionSilhouette(), null, 'the whole selection still has no path outline');

  controller.selectNodes(['dense', 'hero'], { active: 'dense' });
  assert.equal(controller.selectionSilhouetteLayers().active, null, 'a dense active object has no path');
  assert.ok(controller.selectionOutline().length >= 3, 'its hull is what goes over the mask');

  controller.selectNodes(['dense']);
  assert.equal(controller.selectionMaskSource().othersExist, false, 'one object over the budget is the mask alone');
  assert.equal(controller.selectionSilhouetteLayers().active, null);
});

function mountDenseStudio(testContext, webgl) {
  const dom = installStudioDom();
  if (webgl) {
    const createElement = dom.document.createElement.bind(dom.document);
    dom.document.createElement = tagName => {
      const element = createElement(tagName);
      if (tagName === 'canvas') element.getContext = () => webgl;
      return element;
    };
  }
  const studio = createStudio(dom.container, { recipe: makeDenseRecipe(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const viewport = dom.container.firstElementChild.querySelector('.crucible-studio-viewport');
  viewport.box = { left: 40, top: 30, width: 800, height: 600, right: 840, bottom: 630 };
  studio.renderNow();
  return { studio, viewport, gizmo: viewport.querySelector('.crucible-studio-gizmo') };
}

test('with several selected the mask draws at the width of the others and the active object is drawn over it', testContext => {
  const { context } = createFakeWebgl2();
  const ui = mountDenseStudio(testContext, context);
  const mask = () => ui.viewport.querySelector('.crucible-studio-selection-mask');
  const layerOf = selector => ui.gizmo.querySelectorAll(selector).map(element => element.getAttribute('data-layer'));

  ui.studio.controller.selectNodes(['dense', 'hero'], { active: 'hero' });
  ui.studio.renderNow();
  assert.match(mask().style.filter, /-mask-others\)$/, 'the mask is outlined at the others strength');
  assert.deepEqual(layerOf('.crucible-studio-selection-silhouette'), ['active'], 'the active shape lies over the mask');
  assert.equal(layerOf('.crucible-studio-selection-outline').length, 0);

  ui.studio.controller.selectNodes(['dense', 'hero'], { active: 'dense' });
  ui.studio.renderNow();
  assert.match(mask().style.filter, /-mask-others\)$/);
  assert.equal(layerOf('.crucible-studio-selection-silhouette').length, 0, 'a dense active object has no path');
  assert.equal(layerOf('.crucible-studio-selection-outline').length, 0, 'its true silhouette is a second mask, not a hull');

  ui.studio.controller.selectNodes(['dense']);
  ui.studio.renderNow();
  assert.match(mask().style.filter, /-mask\)$/, 'one selected object keeps the active width');
  assert.equal(layerOf('.crucible-studio-selection-silhouette').length + layerOf('.crucible-studio-selection-outline').length, 0);
});

test('a dense active object among others gets a second mask of its own at the active width', testContext => {
  const { context } = createFakeWebgl2();
  const ui = mountDenseStudio(testContext, context);
  const masks = () => ui.viewport.querySelectorAll('.crucible-studio-selection-mask');
  const { controller } = ui.studio;

  controller.selectNodes(['dense', 'hero'], { active: 'dense' });
  const source = controller.selectionActiveMaskSource();
  assert.equal(source.parts.length, 1, 'only the active object is in it');
  assert.equal(source.parts[0].geometry, controller.selectionMaskSource().parts.find(part => part.geometry.indices.length > 3 * 8000).geometry);
  ui.studio.renderNow();
  assert.equal(masks().length, 2);
  assert.match(masks()[0].style.filter, /-mask-others\)$/, 'the rest of the selection at the lower strength');
  assert.match(masks()[1].style.filter, /-mask\)$/, 'the active object at its own strength');
  assert.equal(masks()[1].hidden, false);

  controller.selectNodes(['dense', 'hero'], { active: 'hero' });
  assert.equal(controller.selectionActiveMaskSource(), null, 'an active object inside the budget keeps its path');
  ui.studio.renderNow();
  assert.equal(masks()[1].hidden, true, 'the second mask hides when it is not needed');

  controller.selectNodes(['dense']);
  assert.equal(controller.selectionActiveMaskSource(), null, 'one dense object alone is the first mask at the active width');
  controller.selectNodes([]);
  assert.equal(controller.selectionActiveMaskSource(), null);
});

test('without a mask a dense selection keeps its hull outlines, the active one on top', testContext => {
  const ui = mountDenseStudio(testContext, null);
  ui.studio.controller.selectNodes(['dense', 'hero'], { active: 'hero' });
  ui.studio.renderNow();
  assert.equal(ui.gizmo.querySelectorAll('.crucible-studio-selection-silhouette').length, 0);
  assert.deepEqual(ui.gizmo.querySelectorAll('.crucible-studio-selection-outline').map(element => element.getAttribute('data-layer')), ['others', 'active']);
});
