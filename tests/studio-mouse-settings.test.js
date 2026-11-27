import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import {
  DEFAULT_MOUSE_MAP,
  describeRefusedMousePress,
  findMouseRowHolders,
  normalizeMouseOverrides,
  resolveMouseMap,
  withMousePress,
  withSwappedMousePresses,
} from '../src/studio-mouse-map.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const RECIPE = {
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
  materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
  nodes: [{ id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] }],
  camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
};

const PREFERENCES_KEY = 'crucible-studio-preferences';

function memoryStorage(initial = {}) {
  const saved = new Map(Object.entries(initial));
  return { saved, getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
}

function mountStudio(testContext, { sharedDom = null, ...options } = {}) {
  const dom = sharedDom ?? installStudioDom();
  const container = sharedDom ? dom.document.createElement('div') : dom.container;
  if (sharedDom) dom.document.body.append(container);
  const studio = createStudio(container, { recipe: RECIPE, renderer: createFakeRenderer(), ...options });
  testContext.after(() => {
    studio.dispose();
    if (!sharedDom) dom.uninstall();
  });
  const root = container.firstElementChild;
  const settingsDialog = root.querySelector('.crucible-studio-settings-dialog');
  const ui = {
    dom,
    studio,
    root,
    settingsDialog,
    sheet: root.querySelector('.crucible-studio-shortcuts-dialog'),
    mouseRow: rowId => settingsDialog.querySelectorAll('.crucible-studio-mouse-row').find(row => row.dataset.mouseRow === rowId),
    pressButton: rowId => ui.mouseRow(rowId).querySelector('.crucible-studio-mouse-press'),
    note: rowId => ui.mouseRow(rowId).querySelector('.crucible-studio-keyboard-note'),
    noteButton: (rowId, label) => ui.note(rowId).querySelectorAll('button').find(button => button.textContent === label),
    toolButton: label => settingsDialog.querySelectorAll('.crucible-studio-keyboard-actions button').find(button => button.textContent === label),
    startRecording: rowId => ui.pressButton(rowId).click(),
    // A press on the capture button, as a pointer makes it.
    recordPress: (rowId, properties = {}) => {
      if (ui.pressButton(rowId).dataset.recording !== 'true') ui.startRecording(rowId);
      return dispatch(ui.pressButton(rowId), 'pointerdown', { button: 0, cancelable: true, ...properties });
    },
    filterInput: () => settingsDialog.descendants().find(element => element.dataset?.keyboardFilter === 'true'),
  };
  settingsDialog.showModal();
  settingsDialog.querySelectorAll('.crucible-studio-settings-section').find(button => button.dataset.section === 'keys').click();
  return ui;
}

function sheetKeysOf(ui, label) {
  return ui.sheet.querySelectorAll('.crucible-studio-shortcut-item')
    .filter(item => item.querySelector('span').textContent === label)
    .map(item => item.querySelector('.crucible-studio-shortcut-keys').textContent);
}

test('the mouse rows are listed with their press, in their own rows, beside the key rows (#3574)', testContext => {
  const ui = mountStudio(testContext);
  const rows = ui.settingsDialog.querySelectorAll('.crucible-studio-mouse-row');
  assert.deepEqual(rows.map(row => row.dataset.mouseRow), DEFAULT_MOUSE_MAP.map(row => row.id));
  assert.equal(ui.pressButton('pan.spaceLeft').textContent, 'Space + left drag');
  assert.equal(ui.pressButton('undo.back').textContent, 'Back button click');
  assert.equal(ui.pressButton('pivot.middle').textContent, 'Middle click');
  assert.ok(rows.every(row => row.dataset.action === undefined), 'a mouse row is not a key row');
  assert.ok(ui.settingsDialog.querySelectorAll('.crucible-studio-keyboard-row').every(row => row.dataset.action !== 'undo.back'));
});

test('recording waits for a mouse press, keeps the gesture and stores the new button and held keys (#3574)', testContext => {
  const storage = memoryStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  ui.startRecording('undo.back');
  assert.equal(ui.pressButton('undo.back').dataset.recording, 'true');
  assert.match(ui.pressButton('undo.back').textContent, /Press a button/);
  const recorded = dispatch(ui.pressButton('undo.back'), 'pointerdown', { button: 1, altKey: true, cancelable: true });
  assert.equal(recorded.defaultPrevented, true);
  assert.equal(ui.pressButton('undo.back').textContent, 'Alt + middle click');
  assert.equal(ui.mouseRow('undo.back').dataset.changed, 'true');
  assert.deepEqual(JSON.parse(storage.saved.get(PREFERENCES_KEY)).mouseOverrides, { 'undo.back': { button: 1, modifiers: { alt: true } } });
});

test('a held Space counts as a modifier of the recorded press (#3574)', testContext => {
  const ui = mountStudio(testContext);
  ui.startRecording('pan.middle');
  dispatch(ui.pressButton('pan.middle'), 'keydown', { key: ' ', cancelable: true });
  ui.recordPress('pan.middle', { button: 2 });
  assert.equal(ui.pressButton('pan.middle').textContent, 'Space + right drag');
});

test('Escape cancels a recording and leaves the row as it was (#3574)', testContext => {
  const ui = mountStudio(testContext);
  ui.startRecording('undo.back');
  const escape = dispatch(ui.pressButton('undo.back'), 'keydown', { key: 'Escape', cancelable: true });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(ui.pressButton('undo.back').dataset.recording, undefined);
  assert.equal(ui.pressButton('undo.back').textContent, 'Back button click');
  assert.equal(ui.settingsDialog.open, true, 'Settings stays open');
});

test('a press another row holds asks before it takes it, and Swap gives the other row the old press (#3574)', testContext => {
  const ui = mountStudio(testContext);
  ui.recordPress('redo.forward', { button: 3 });
  assert.match(ui.note('redo.forward').textContent, /Used by Undo/);
  assert.equal(ui.pressButton('redo.forward').dataset.pending, 'true');
  ui.noteButton('redo.forward', 'Cancel').click();
  assert.equal(ui.pressButton('redo.forward').textContent, 'Forward button click');
  ui.recordPress('redo.forward', { button: 3 });
  ui.noteButton('redo.forward', 'Swap').click();
  assert.equal(ui.pressButton('redo.forward').textContent, 'Back button click');
  assert.equal(ui.pressButton('undo.back').textContent, 'Forward button click');
});

test('a plain left click and a plain right click are refused for a click row, with a sentence (#3574)', testContext => {
  const ui = mountStudio(testContext);
  ui.recordPress('undo.back', { button: 0 });
  assert.match(ui.note('undo.back').textContent, /Left click selects/);
  assert.equal(ui.pressButton('undo.back').dataset.recording, 'true', 'it keeps waiting for another press');
  ui.recordPress('undo.back', { button: 2 });
  assert.match(ui.note('undo.back').textContent, /Right click opens the object menu/);
  assert.equal(ui.mouseRow('undo.back').dataset.changed, 'false');
  ui.recordPress('undo.back', { button: 2, shiftKey: true });
  assert.equal(ui.pressButton('undo.back').textContent, 'Shift + right click');
});

test('a drag row refuses the Back and Forward buttons (#3574)', testContext => {
  const ui = mountStudio(testContext);
  ui.recordPress('pan.middle', { button: 3 });
  assert.match(ui.note('pan.middle').textContent, /only click/);
  assert.equal(ui.pressButton('pan.middle').dataset.recording, 'true');
});

test('a changed row resets to its default, and Reset shortcuts covers the mouse rows (#3574)', testContext => {
  const storage = memoryStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  assert.equal(ui.toolButton('Reset shortcuts').disabled, true);
  ui.recordPress('undo.back', { button: 1, altKey: true });
  ui.recordPress('redo.forward', { button: 1, ctrlKey: true });
  assert.equal(ui.toolButton('Reset shortcuts').disabled, false);
  ui.mouseRow('undo.back').querySelector('.crucible-studio-keyboard-reset').click();
  assert.equal(ui.pressButton('undo.back').textContent, 'Back button click');
  assert.equal(ui.mouseRow('undo.back').dataset.changed, 'false');
  ui.toolButton('Reset shortcuts').click();
  assert.ok(ui.toolButton('Reset 1 shortcut'));
  ui.toolButton('Reset 1 shortcut').click();
  assert.equal(ui.pressButton('redo.forward').textContent, 'Forward button click');
  assert.deepEqual(JSON.parse(storage.saved.get(PREFERENCES_KEY)).mouseOverrides, {});
});

test('the changes survive a reload, and stored rows that are unknown or invalid are dropped (#3574)', testContext => {
  const storage = memoryStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  ui.recordPress('undo.back', { button: 1, altKey: true });
  ui.settingsDialog.close();
  const next = mountStudio(testContext, { preferenceStorage: storage, sharedDom: ui.dom });
  assert.equal(next.pressButton('undo.back').textContent, 'Alt + middle click');
  const damaged = memoryStorage({
    [PREFERENCES_KEY]: JSON.stringify({
      mouseOverrides: {
        'not.a.row': { button: 1, modifiers: {} },
        'undo.back': { button: 9, modifiers: {} },
        'redo.forward': { button: 0, modifiers: {} },
        'pan.middle': 'middle',
        'orbit.left': { button: 1, modifiers: { shift: 'yes' } },
      },
    }),
  });
  const reloaded = mountStudio(testContext, { preferenceStorage: damaged, sharedDom: ui.dom });
  assert.deepEqual(reloaded.settingsDialog.querySelectorAll('.crucible-studio-mouse-row').map(row => row.dataset.changed), DEFAULT_MOUSE_MAP.map(() => 'false'));
});

test('the filter shows the key row and the mouse row of a name, each under its own group (#3574)', testContext => {
  const ui = mountStudio(testContext);
  const input = ui.filterInput();
  input.value = 'undo';
  dispatch(input, 'input');
  assert.deepEqual(ui.settingsDialog.querySelectorAll('.crucible-studio-keyboard-row').map(row => row.dataset.action), ['edit.undo']);
  assert.deepEqual(ui.settingsDialog.querySelectorAll('.crucible-studio-mouse-row').map(row => row.dataset.mouseRow), ['undo.back']);
  assert.equal(ui.settingsDialog.querySelectorAll('.crucible-studio-keyboard-group').length, 1);
  assert.equal(ui.settingsDialog.querySelectorAll('.crucible-studio-mouse-group').length, 1);
});

test('a rebound Undo shows in the shortcuts sheet and the viewport handler follows it (#3574)', testContext => {
  const ui = mountStudio(testContext);
  assert.deepEqual(sheetKeysOf(ui, 'Undo'), ['Ctrl+Z', 'Back button click']);
  ui.recordPress('undo.back', { button: 1, altKey: true });
  assert.deepEqual(sheetKeysOf(ui, 'Undo'), ['Ctrl+Z', 'Alt + middle click']);
  ui.settingsDialog.close();
  const controller = ui.studio.controller;
  controller.selectNodes(['hero']);
  controller.duplicateSelected();
  const editedCount = controller.exportRecipe().nodes.length;
  dispatch(ui.dom.document, 'pointerup', { button: 3 });
  assert.equal(controller.exportRecipe().nodes.length, editedCount, 'the old Back button no longer undoes');
  const viewport = ui.root.querySelector('.crucible-studio-viewport');
  viewport.box = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };
  const canvas = viewport.querySelector('canvas');
  dispatch(canvas, 'pointerdown', { button: 1, altKey: true, clientX: 400, clientY: 300 });
  dispatch(viewport, 'pointerup', { button: 1, altKey: true, clientX: 400, clientY: 300 });
  assert.equal(controller.exportRecipe().nodes.length, editedCount - 1, 'Alt + middle click undoes once');
});

test('the press rules: refused presses, holders, swaps and stored changes (#3574)', () => {
  assert.equal(describeRefusedMousePress({ button: 0, modifiers: {}, gesture: 'click' }) !== null, true);
  assert.equal(describeRefusedMousePress({ button: 0, modifiers: { alt: true }, gesture: 'click' }), null);
  assert.equal(describeRefusedMousePress({ button: 0, modifiers: {}, gesture: 'drag' }), null);
  const map = resolveMouseMap({});
  assert.deepEqual(findMouseRowHolders(map, 'redo.forward', { button: 3, modifiers: {} }).map(row => row.id), ['undo.back']);
  assert.deepEqual(findMouseRowHolders(map, 'pan.middle', { button: 1, modifiers: {} }).map(row => row.id), [], 'a click row does not hold a drag press');
  const swapped = withSwappedMousePresses(map, {}, 'redo.forward', { button: 3, modifiers: {} }, [map.find(row => row.id === 'undo.back')]);
  assert.deepEqual(swapped, { 'redo.forward': { button: 3, modifiers: {} }, 'undo.back': { button: 4, modifiers: {} } });
  assert.deepEqual(withMousePress({ 'undo.back': { button: 1, modifiers: {} } }, 'undo.back', { button: 3, modifiers: {} }), {}, 'a press equal to the default removes the change');
  const clashing = normalizeMouseOverrides({ 'undo.back': { button: 1, modifiers: { alt: true } }, 'redo.forward': { button: 1, modifiers: { alt: true } } });
  assert.deepEqual(clashing, {}, 'two changes on one press both go back to their defaults');
  assert.deepEqual(normalizeMouseOverrides('nonsense'), {});
});
