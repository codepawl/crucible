import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { FakeNode, byLabel, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

function sceneRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }, { id: 'ball', type: 'sphere', segments: 8, rings: 6 }],
    materials: [
      { id: 'stone', color: [0.3, 0.32, 0.35] },
      { id: 'paint', color: [0.8, 0.25, 0.2] },
      { id: 'moss', color: [0.1, 0.5, 0.2] },
    ],
    nodes: [
      { id: 'ground', geometry: 'cube', material: 'stone', scale: [10, 0.4, 10] },
      { id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] },
      { id: 'orb', geometry: 'ball', material: 'paint', translation: [2, 0.5, 0] },
      { id: 'tree', geometry: 'cube', material: 'moss', translation: [-2, 0.5, 0] },
    ],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  };
}

// The fake browser is removed only after every panel mounted in it has been disposed.
function installDom(testContext) {
  const dom = installStudioDom();
  dom.mountedStudios = [];
  testContext.after(() => {
    for (const studio of dom.mountedStudios) studio.dispose();
    dom.uninstall();
  });
  return dom;
}

// A second panel in the same fake document lets a test compare an edited panel with one built from the same recipe.
function mountPanel(testContext, { recipe = sceneRecipe(), sharedDom = null } = {}) {
  const dom = sharedDom ?? installDom(testContext);
  const container = sharedDom ? dom.document.createElement('div') : dom.container;
  if (sharedDom) dom.document.body.append(container);
  const studio = createStudio(container, { recipe, renderer: createFakeRenderer() });
  dom.mountedStudios.push(studio);
  const root = container.firstElementChild;
  return {
    dom,
    studio,
    root,
    tree: root.querySelector('.crucible-studio-tree'),
    swatchStrip: root.querySelector('.crucible-studio-swatches'),
    search: byLabel(root, 'Filter the scene list'),
    nodeRows: () => root.querySelectorAll('.crucible-studio-tree-row').filter(row => row.dataset.sceneObject === undefined),
    rowByLabel: label => root.querySelectorAll('.crucible-studio-tree-row').find(row => row.querySelector('.crucible-studio-tree-label').textContent === label),
    swatches: () => root.querySelectorAll('.crucible-studio-swatch-btn'),
  };
}

// Tag, attributes, dataset, own text and inline style of every element below this one, in order.
function describeElement(element, depth = 0) {
  const attributes = [...element.attributeMap].sort(([first], [second]) => first.localeCompare(second));
  const self = `${' '.repeat(depth)}${element.tagName} ${JSON.stringify(attributes)} ${JSON.stringify(element.dataset)} ${JSON.stringify(element.style)} ${JSON.stringify(element.ownText)}`;
  return [self, ...element.children.flatMap(child => describeElement(child, depth + 1))];
}

function describePanel(panel) {
  return [...describeElement(panel.tree), ...describeElement(panel.swatchStrip)].join('\n');
}

function countReads(elements, property) {
  const counter = { reads: 0 };
  for (const element of elements) {
    Object.defineProperty(element, property, {
      configurable: true,
      get() {
        counter.reads += 1;
        return 0;
      },
    });
  }
  return counter;
}

// Compared by identity: a failed deepEqual of two DOM nodes prints both element trees and never finishes.
function assertSameElements(actual, expected, message) {
  assert.ok(actual.length === expected.length && actual.every((element, index) => element === expected[index]), message);
}

function rowLabel(row) {
  return row.querySelector('.crucible-studio-tree-label').textContent;
}

test('adding a node builds one row and keeps every other row element', testContext => {
  const panel = mountPanel(testContext);
  const rowsBefore = new Map(panel.nodeRows().map(row => [rowLabel(row), row]));
  panel.studio.controller.addPrimitive('box');
  const rowsAfter = panel.nodeRows();
  assert.equal(rowsAfter.length, rowsBefore.size + 1);
  assert.equal(rowsAfter.filter(row => !rowsBefore.has(rowLabel(row))).length, 1, 'one new row for the new node');
  for (const [label, row] of rowsBefore) {
    assert.ok(panel.rowByLabel(label) === row, `the row of ${label} is the same element`);
  }
});

test('selecting a node only moves the selected mark between two existing rows', testContext => {
  const panel = mountPanel(testContext);
  const rowsBefore = panel.nodeRows();
  panel.studio.selectNode('orb');
  assertSameElements(panel.nodeRows(), rowsBefore, 'every row is the same element');
  assert.deepEqual(rowsBefore.map(row => row.dataset.selected), ['false', 'false', 'true', 'false']);
  assert.equal(panel.rowByLabel('orb').getAttribute('aria-selected'), 'true');
  assert.equal(panel.rowByLabel('hero').getAttribute('aria-selected'), 'false');
});

test('a hidden node rebuilds its own row and no other', testContext => {
  const panel = mountPanel(testContext);
  const rowsBefore = new Map(panel.nodeRows().map(row => [rowLabel(row), row]));
  panel.studio.controller.updateNodeTransform('hero', { visible: false });
  assert.ok(panel.rowByLabel('hero') !== rowsBefore.get('hero'));
  assert.equal(panel.rowByLabel('hero').querySelector('.crucible-studio-tree-select').dataset.hidden, 'true');
  for (const label of ['ground', 'orb', 'tree']) {
    assert.ok(panel.rowByLabel(label) === rowsBefore.get(label), `the row of ${label} is the same element`);
  }
});

test('a recoloured material repaints the row badges without rebuilding the rows', testContext => {
  const panel = mountPanel(testContext);
  const rowsBefore = panel.nodeRows();
  const badgeOf = label => panel.rowByLabel(label).querySelector('.crucible-studio-tree-badge');
  const fillBefore = badgeOf('hero').style.fill;
  panel.studio.controller.updateMaterial('paint', { color: [0.1, 0.2, 0.9] });
  assertSameElements(panel.nodeRows(), rowsBefore, 'every row is the same element');
  assert.notEqual(badgeOf('hero').style.fill, fillBefore);
  assert.equal(badgeOf('orb').style.fill, badgeOf('hero').style.fill);
});

test('the strip scrolls to the pressed swatch only when the pressed swatch moved', testContext => {
  const panel = mountPanel(testContext);
  panel.studio.selectNode('hero');
  const swatchesBefore = panel.swatches();
  const reads = countReads(swatchesBefore, 'offsetLeft');
  panel.studio.selectNode('orb');
  assert.equal(reads.reads, 0, 'hero and orb share a material, so nothing scrolls');
  panel.studio.controller.updateNodeTransform('orb', { translation: [3, 0.5, 0] });
  assert.equal(reads.reads, 0, 'a move leaves the strip alone');
  panel.studio.selectNode('tree');
  assert.ok(reads.reads > 0, 'the pressed swatch moved to another material');
  assert.deepEqual(panel.swatches().map(swatch => swatch.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  assertSameElements(panel.swatches(), swatchesBefore, 'the swatch elements stay');
});

test('the Scene list measures its rows once, not once per edit', testContext => {
  const dom = installDom(testContext);
  testContext.after(() => {
    delete FakeNode.prototype.offsetHeight;
  });
  dom.document.defaultView.getComputedStyle = () => ({ paddingTop: '4px', paddingBottom: '0px' });
  const measured = { reads: 0 };
  Object.defineProperty(FakeNode.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      measured.reads += 1;
      return 28;
    },
  });
  const properties = new Map();
  const panel = mountPanel(testContext, { sharedDom: dom });
  panel.tree.clientHeight = 90;
  panel.tree.style.removeProperty = name => properties.delete(name);
  panel.tree.style.setProperty = (name, value) => properties.set(name, value);
  const controller = panel.studio.controller;
  controller.addPrimitive('box');
  const readsAfterFirstFit = measured.reads;
  assert.ok(readsAfterFirstFit > 0);
  controller.addPrimitive('box');
  controller.addPrimitive('sphere');
  panel.studio.selectNode('hero');
  assert.equal(measured.reads, readsAfterFirstFit, 'no more reads of the row height');
  assert.ok(parseFloat(properties.get('--studio-tree-row-size')) >= 28, 'the rows of a list that scrolls grow to fill whole rows');
  dom.observers.resize.find(observer => observer.observed.includes(panel.tree)).callback([]);
  assert.ok(measured.reads > readsAfterFirstFit, 'a resize measures again');
  const readsAfterResize = measured.reads;
  panel.search.value = 'orb';
  dispatch(panel.search, 'input');
  assert.ok(measured.reads > readsAfterResize, 'a list whose first row is another kind is measured again');
});

test('after a run of edits the Scene list and the swatches equal a freshly built panel', testContext => {
  const panel = mountPanel(testContext);
  const controller = panel.studio.controller;
  controller.addPrimitive('box');
  controller.addPrimitive('sphere');
  panel.studio.selectNode('orb');
  controller.updateNodeTransform('hero', { visible: false });
  controller.updateMaterial('paint', { color: [0.1, 0.2, 0.9] });
  controller.updateNodeTransform('tree', { parent: 'hero' });
  controller.updateNodeTransform('ground', { label: 'floor' });
  controller.undo();
  controller.undo();
  controller.redo();
  controller.createMaterial({ color: [0.9, 0.9, 0.1] });
  panel.studio.selectNode('ground');
  const fresh = mountPanel(testContext, { recipe: panel.studio.exportRecipe(), sharedDom: panel.dom });
  fresh.studio.selectNode(controller.selectedNodeId);
  assert.equal(describePanel(panel), describePanel(fresh));
});

function manyNodesRecipe(count) {
  const recipe = sceneRecipe();
  recipe.nodes = Array.from({ length: count }, (unused, index) => ({ id: `n${index}`, geometry: 'cube', material: 'paint', translation: [index, 0.5, 0] }));
  return recipe;
}

function movedRows(panel) {
  return panel.nodeRows().filter(row => (row.moves ?? 0) > 0).map(rowLabel);
}

function resetMoves(panel) {
  for (const row of panel.nodeRows()) row.moves = 0;
}

test('hiding or deleting a row detaches no other row', testContext => {
  const panel = mountPanel(testContext, { recipe: manyNodesRecipe(8) });
  resetMoves(panel);
  panel.studio.controller.updateNodeTransform('n1', { visible: false });
  assert.deepEqual(movedRows(panel), [], 'hiding n1 moved no row');
  panel.studio.selectNode('n3');
  panel.studio.controller.deleteSelected();
  assert.equal(panel.nodeRows().length, 7);
  assert.deepEqual(movedRows(panel), [], 'deleting n3 moved no row');
});

test('reparenting one row moves that row and its children only, and a reverse reload stays within the row count', testContext => {
  const panel = mountPanel(testContext, { recipe: manyNodesRecipe(8) });
  resetMoves(panel);
  panel.studio.controller.updateNodeTransform('n1', { parent: 'n5' });
  assert.deepEqual(movedRows(panel), [], 'the reparented row is rebuilt at its new depth, no other row moves');
  assert.deepEqual(panel.nodeRows().map(rowLabel), ['n0', 'n2', 'n3', 'n4', 'n5', 'n1', 'n6', 'n7']);
  resetMoves(panel);
  const reversed = panel.studio.exportRecipe();
  reversed.nodes.reverse();
  panel.studio.controller.loadRecipe(reversed);
  assert.ok(movedRows(panel).length <= 8);
  assert.equal(panel.nodeRows().length, 8);
});

test('a focused row keeps focus across an add, a hide of another row and a selection change, and a rebuilt row gets it back', testContext => {
  const panel = mountPanel(testContext, { recipe: manyNodesRecipe(6) });
  const focusedButton = panel.rowByLabel('n4').querySelector('.crucible-studio-tree-select');
  focusedButton.focus();
  const controller = panel.studio.controller;
  controller.addPrimitive('box');
  assert.ok(panel.dom.document.activeElement === focusedButton, 'an add keeps focus');
  controller.updateNodeTransform('n1', { visible: false });
  assert.ok(panel.dom.document.activeElement === focusedButton, 'hiding another row keeps focus');
  panel.studio.selectNode('n2');
  assert.ok(panel.dom.document.activeElement === focusedButton, 'a selection change keeps focus');
  controller.updateNodeTransform('n4', { visible: false });
  const rebuiltButton = panel.rowByLabel('n4').querySelector('.crucible-studio-tree-select');
  assert.ok(rebuiltButton !== focusedButton, 'the focused row itself was rebuilt');
  assert.ok(panel.dom.document.activeElement === rebuiltButton, 'focus moved to the rebuilt row');
});

test('a click on a row after the rows shifted selects that row\'s node', testContext => {
  const panel = mountPanel(testContext, { recipe: manyNodesRecipe(6) });
  panel.studio.controller.updateNodeTransform('n1', { visible: false });
  panel.studio.selectNode('n3');
  panel.studio.controller.deleteSelected();
  panel.studio.controller.updateNodeTransform('n5', { parent: 'n0' });
  for (const label of ['n4', 'n5', 'n0']) {
    panel.rowByLabel(label).querySelector('.crucible-studio-tree-select').click();
    assert.equal(panel.studio.controller.selectedNodeId, label);
  }
});

test('disposing Studio removes its font and window listeners', testContext => {
  const dom = installDom(testContext);
  const listeners = new Set();
  dom.document.fonts = {
    addEventListener: (type, listener) => listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
  };
  const panel = mountPanel(testContext, { sharedDom: dom });
  assert.equal(listeners.size, 1);
  panel.studio.dispose();
  assert.equal(listeners.size, 0);
  dom.mountedStudios.length = 0;
});

// A small seeded generator keeps the run the same every time.
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function applyRandomEdit(panel, random, step) {
  const controller = panel.studio.controller;
  const recipe = panel.studio.exportRecipe();
  const nodeIds = recipe.nodes.map(node => node.id);
  const pick = list => list[Math.floor(random() * list.length)];
  const operations = {
    add: () => controller.addPrimitive(pick(['box', 'sphere'])),
    select: () => panel.studio.selectNode(pick(nodeIds)),
    hide: () => controller.updateNodeTransform(pick(nodeIds), { visible: random() < 0.5 }),
    rename: () => controller.updateNodeTransform(pick(nodeIds), { label: `renamed-${step}` }),
    reparent: () => controller.updateNodeTransform(pick(nodeIds), { parent: random() < 0.3 ? null : pick(nodeIds) }),
    duplicate: () => controller.duplicateSelected(),
    delete: () => controller.deleteSelected(),
    undo: () => controller.undo(),
    redo: () => controller.redo(),
    recolour: () => controller.updateMaterial(pick(recipe.materials).id, { color: [random(), random(), random()] }),
    newMaterial: () => controller.createMaterial({ color: [random(), random(), random()] }),
    assign: () => controller.assignNodeMaterial(controller.selectedNodeId, pick(recipe.materials).id),
    filter: () => {
      panel.search.value = pick(['', 'n', 'e', 'renamed']);
      dispatch(panel.search, 'input');
    },
    reload: () => {
      const reordered = structuredClone(recipe);
      reordered.nodes.sort(() => random() - 0.5);
      controller.loadRecipe(reordered);
    },
  };
  const name = pick(Object.keys(operations));
  try {
    operations[name]();
  } catch {
    // An edit the controller refuses (a cycle, no selection) changes nothing; the panel must still match.
  }
  return name;
}

test('across random edits the kept panel equals a freshly mounted one', testContext => {
  const dom = installDom(testContext);
  for (const seed of [11, 23, 37]) {
    const random = seededRandom(seed);
    const panel = mountPanel(testContext, { recipe: manyNodesRecipe(5), sharedDom: dom });
    for (let step = 0; step < 80; step += 1) {
      const operation = applyRandomEdit(panel, random, step);
      // Mounting a panel is the slow part, so the comparison runs every fifth step and at the end.
      if (step % 5 !== 4) continue;
      const fresh = mountPanel(testContext, { recipe: panel.studio.exportRecipe(), sharedDom: panel.dom });
      fresh.studio.selectNode(panel.studio.controller.selectedNodeId);
      fresh.search.value = panel.search.value;
      dispatch(fresh.search, 'input');
      assert.equal(describePanel(panel), describePanel(fresh), `seed ${seed} step ${step} after ${operation}`);
      fresh.studio.dispose();
      panel.dom.mountedStudios.splice(panel.dom.mountedStudios.indexOf(fresh.studio), 1);
      fresh.root.remove();
    }
  }
});

test('the list keeps the offset the person scrolled to across adds, hides and deletes', testContext => {
  const panel = mountPanel(testContext, { recipe: manyNodesRecipe(8) });
  panel.tree.scrollTop = 120;
  panel.studio.controller.addPrimitive('box');
  assert.equal(panel.tree.scrollTop, 120);
  panel.studio.controller.updateNodeTransform('n2', { visible: false });
  assert.equal(panel.tree.scrollTop, 120);
  panel.studio.selectNode('n4');
  panel.studio.controller.deleteSelected();
  assert.equal(panel.tree.scrollTop, 120);
});

test('moving the last row to the front moves that one row', testContext => {
  const panel = mountPanel(testContext, { recipe: manyNodesRecipe(4) });
  resetMoves(panel);
  const reordered = panel.studio.exportRecipe();
  reordered.nodes.unshift(reordered.nodes.pop());
  panel.studio.controller.loadRecipe(reordered);
  assert.deepEqual(panel.nodeRows().map(rowLabel), ['n3', 'n0', 'n1', 'n2']);
  assert.deepEqual(movedRows(panel), ['n3']);
});

test('the fake browser refuses focus for a detached, hidden or disabled element', testContext => {
  const panel = mountPanel(testContext, { recipe: manyNodesRecipe(3) });
  const document = panel.dom.document;
  const anchor = panel.rowByLabel('n0').querySelector('.crucible-studio-tree-select');
  anchor.focus({ preventScroll: true });
  assert.ok(document.activeElement === anchor);
  const detached = document.createElement('button');
  detached.focus();
  assert.ok(document.activeElement === anchor, 'a detached element takes no focus');
  const hiddenButton = panel.rowByLabel('n1').querySelector('.crucible-studio-tree-select');
  hiddenButton.hidden = true;
  hiddenButton.focus();
  assert.ok(document.activeElement === anchor, 'a hidden element takes no focus');
  const disabledButton = panel.rowByLabel('n2').querySelector('.crucible-studio-tree-select');
  disabledButton.disabled = true;
  disabledButton.focus();
  assert.ok(document.activeElement === anchor, 'a disabled element takes no focus');
});
