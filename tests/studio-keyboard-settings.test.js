import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { STUDIO_CSS } from '../src/studio-styles.js';
import { byDataset, byText, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const RECIPE = {
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
  materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
  nodes: [{ id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] }],
  camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
};

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
    row: actionId => settingsDialog.querySelectorAll('.crucible-studio-keyboard-row').find(row => row.dataset.action === actionId),
    keys: actionId => ui.row(actionId).querySelector('.crucible-studio-keyboard-keys'),
    reset: actionId => ui.row(actionId).querySelector('.crucible-studio-keyboard-reset'),
    note: actionId => ui.row(actionId).querySelector('.crucible-studio-keyboard-note'),
    noteButton: (actionId, label) => ui.note(actionId).querySelectorAll('button').find(button => button.textContent === label),
    toolButton: label => settingsDialog.querySelectorAll('.crucible-studio-keyboard-actions button').find(button => button.textContent === label),
    // Keys reach the scene only while no dialog is open, so the dialog closes first and Settings opens again after.
    press: (key, extra = {}) => {
      const wasOpen = settingsDialog.open;
      if (wasOpen) settingsDialog.close();
      const event = dispatch(dom.document, 'keydown', { key, ...extra });
      if (wasOpen) settingsDialog.showModal();
      return event;
    },
    record: (actionId, key, extra = {}) => {
      if (ui.keys(actionId).dataset.recording !== 'true') ui.keys(actionId).click();
      return dispatch(ui.keys(actionId), 'keydown', { key, cancelable: true, ...extra });
    },
    filterInput: () => settingsDialog.descendants().find(element => element.dataset?.keyboardFilter === 'true'),
    tool: name => byDataset(root, 'tool', name),
    menuItem: (menuId, text) => byText(root.querySelector(`#crucible-studio-pop-${menuId}`), text),
  };
  settingsDialog.showModal();
  settingsDialog.querySelectorAll('.crucible-studio-settings-section').find(button => button.dataset.section === 'keys').click();
  return ui;
}

function memoryStorage() {
  const saved = new Map();
  return { saved, getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
}

test('Settings > Keyboard lists the actions in the Help sheet groups, each with its key as a button, mouse rows without one (#3390)', testContext => {
  const ui = mountStudio(testContext);
  const titles = ui.settingsDialog.querySelectorAll('.crucible-studio-keyboard-group h4').map(heading => heading.textContent);
  const sheetTitles = ui.sheet.querySelectorAll('.crucible-studio-shortcut-group h3').map(heading => heading.textContent);
  assert.deepEqual(titles, sheetTitles);
  assert.equal(ui.keys('tool.select').textContent, 'Q');
  assert.equal(ui.keys('edit.delete').textContent, 'X, Delete, Backspace');
  assert.ok(ui.settingsDialog.querySelectorAll('.crucible-studio-keyboard-group h4').every(heading => heading.querySelector('.crucible-studio-icon')));
  assert.ok(ui.settingsDialog.querySelectorAll('.crucible-studio-keyboard-fixed').length > 0, 'mouse rows are shown');
  assert.equal(ui.settingsDialog.querySelectorAll('.crucible-studio-keyboard-fixed').some(span => span.closest('button')), false);
});

test('a recorded key replaces the old one everywhere: events, the Help sheet, the tooltip and the stored settings (#3390)', testContext => {
  const storage = memoryStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  ui.keys('tool.select').click();
  assert.equal(ui.keys('tool.select').dataset.recording, 'true');
  assert.match(ui.keys('tool.select').textContent, /Press keys/);
  const recorded = ui.record('tool.select', 'v');
  assert.equal(recorded.defaultPrevented, true);
  assert.equal(ui.keys('tool.select').textContent, 'V');
  assert.equal(ui.row('tool.select').dataset.changed, 'true');
  ui.press('r');
  assert.equal(ui.studio.controller.tool, 'rotate');
  ui.press('q');
  assert.equal(ui.studio.controller.tool, 'rotate', 'the old key no longer selects');
  ui.press('v');
  assert.equal(ui.studio.controller.tool, 'select', 'the new key does');
  assert.match(ui.tool('select').getAttribute('aria-label'), /\(V\)|V/);
  assert.doesNotMatch(ui.tool('select').getAttribute('aria-label'), /\bQ\b/);
  const sheetKeys = ui.sheet.querySelectorAll('.crucible-studio-shortcut-item').find(item => item.querySelector('span').textContent === 'Select');
  assert.equal(sheetKeys.querySelector('.crucible-studio-shortcut-keys').textContent, 'V');
  assert.deepEqual(JSON.parse(storage.saved.get('crucible-studio-preferences')).keyOverrides, { crucible: { 'tool.select': { key: 'v', shift: false } } });
});

test('the changes belong to the preset and survive a reload (#3390)', testContext => {
  const storage = memoryStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  ui.record('tool.select', 'v');
  ui.settingsDialog.close();
  const next = mountStudio(testContext, { preferenceStorage: storage, sharedDom: ui.dom });
  assert.equal(next.keys('tool.select').textContent, 'V');
  const preset = next.settingsDialog.querySelectorAll('select').find(select => select.dataset.setting === 'keymap');
  preset.value = 'maya';
  dispatch(preset, 'change');
  assert.equal(next.keys('tool.select').textContent, 'Q', 'another preset keeps its own keys');
  assert.equal(next.row('tool.select').dataset.changed, 'false');
  preset.value = 'crucible';
  dispatch(preset, 'change');
  assert.equal(next.keys('tool.select').textContent, 'V');
});

test('Escape cancels a recording and Backspace clears the binding; a lone modifier waits (#3390)', testContext => {
  const ui = mountStudio(testContext);
  ui.keys('tool.select').click();
  dispatch(ui.keys('tool.select'), 'keydown', { key: 'Shift', shiftKey: true });
  assert.equal(ui.keys('tool.select').dataset.recording, 'true', 'still waiting');
  dispatch(ui.keys('tool.select'), 'keydown', { key: 'Escape' });
  assert.equal(ui.keys('tool.select').textContent, 'Q');
  assert.equal(ui.row('tool.select').dataset.changed, 'false');
  ui.record('tool.select', 'Backspace');
  assert.equal(ui.keys('tool.select').dataset.empty, 'true');
  assert.equal(ui.keys('tool.select').textContent, 'Not set');
  ui.press('r');
  ui.press('q');
  assert.equal(ui.studio.controller.tool, 'rotate', 'a cleared action has no key');
  assert.equal(ui.row('tool.select').dataset.changed, 'true');
  ui.keys('tool.select').click();
  assert.equal(ui.keys('tool.select').dataset.recording, 'true', 'a cleared action can be bound again');
});

test('a key another action holds shows "Used by" with Swap and Cancel, and nothing is saved until one is chosen (#3390)', testContext => {
  const storage = memoryStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  ui.record('tool.select', 'g');
  const note = ui.note('tool.select');
  assert.match(note.textContent, /Used by Pick up to move/);
  assert.ok(note.querySelector('.crucible-studio-icon'), 'the outcome leads with an icon');
  assert.equal(ui.keys('tool.select').dataset.pending, 'true');
  assert.equal(storage.saved.has('crucible-studio-preferences'), false, 'nothing saved yet');
  ui.press('r');
  ui.press('q');
  assert.equal(ui.studio.controller.tool, 'select', 'the old binding still stands while the clash waits');
  ui.noteButton('tool.select', 'Cancel').click();
  assert.equal(ui.note('tool.select'), null);
  assert.equal(ui.keys('tool.select').textContent, 'Q');
  ui.record('tool.select', 'g');
  ui.noteButton('tool.select', 'Swap').click();
  assert.equal(ui.keys('tool.select').textContent, 'G');
  assert.equal(ui.keys('tool.translate').textContent, 'Q');
  ui.press('r');
  ui.press('q');
  assert.equal(ui.studio.controller.tool, 'translate');
});

test('a combination the browser keeps is refused inline and nothing changes (#3390)', testContext => {
  const ui = mountStudio(testContext);
  ui.record('tool.select', 'w', { ctrlKey: true });
  assert.match(ui.note('tool.select').textContent, /Ctrl\+W belongs to the browser/);
  assert.ok(ui.note('tool.select').querySelector('.crucible-studio-icon'));
  assert.equal(ui.keys('tool.select').dataset.recording, 'true', 'still recording, so another key can be tried');
  dispatch(ui.keys('tool.select'), 'keydown', { key: 'k', ctrlKey: true });
  assert.equal(ui.keys('tool.select').textContent, 'Ctrl+K');
  assert.equal(ui.note('tool.select'), null);
});

test('a changed row has a reset button that returns it to the preset, and Reset keys asks first (#3390)', testContext => {
  const storage = memoryStorage();
  const ui = mountStudio(testContext, { preferenceStorage: storage });
  assert.equal(ui.reset('tool.select'), null, 'a row at the preset has no reset');
  assert.equal(ui.toolButton('Reset keys').disabled, true);
  ui.record('tool.select', 'v');
  ui.record('tool.rotate', 'b');
  ui.reset('tool.select').click();
  assert.equal(ui.keys('tool.select').textContent, 'Q');
  assert.equal(ui.row('tool.select').dataset.changed, 'false');
  assert.equal(ui.keys('tool.rotate').textContent, 'B');
  ui.toolButton('Reset keys').click();
  assert.equal(ui.keys('tool.rotate').textContent, 'B', 'nothing happens before the confirm');
  ui.toolButton('Keep').click();
  assert.ok(ui.toolButton('Reset keys'));
  ui.toolButton('Reset keys').click();
  ui.toolButton('Reset 1 key').click();
  assert.equal(ui.keys('tool.rotate').textContent, 'R');
  assert.deepEqual(JSON.parse(storage.saved.get('crucible-studio-preferences')).keyOverrides, {});
  ui.press('r');
  assert.equal(ui.studio.controller.tool, 'rotate');
});

test('the filter keeps the actions whose name matches and the groups that still have rows (#3390)', testContext => {
  const ui = mountStudio(testContext);
  const input = ui.filterInput();
  input.value = 'undo';
  dispatch(input, 'input');
  const rows = ui.settingsDialog.querySelectorAll('.crucible-studio-keyboard-row');
  assert.deepEqual(rows.map(row => row.dataset.action), ['edit.undo']);
  assert.equal(ui.settingsDialog.querySelectorAll('.crucible-studio-keyboard-group').length, 1);
  input.value = 'zzzz';
  dispatch(input, 'input');
  assert.equal(ui.settingsDialog.querySelectorAll('.crucible-studio-keyboard-row').length, 0);
  assert.ok(ui.settingsDialog.querySelector('.crucible-studio-keyboard-note'));
});

test('menu key labels follow a rebound key at once (#3390)', testContext => {
  const ui = mountStudio(testContext);
  assert.equal(ui.menuItem('new', 'Save').dataset.shortcut, 'Ctrl+S');
  ui.record('file.save', 'k', { ctrlKey: true });
  assert.equal(ui.menuItem('new', 'Save').dataset.shortcut, 'Ctrl+K');
  ui.record('edit.hide', 'j');
  assert.equal(ui.menuItem('edit', 'Hide').dataset.shortcut, 'J');
});

test('the Keyboard section uses only tokens for colour and spacing and nothing selectable (#3390)', () => {
  const block = STUDIO_CSS.slice(STUDIO_CSS.indexOf('.crucible-studio-keyboard {'), STUDIO_CSS.indexOf('/* New scene: a chooser'));
  assert.ok(block.length > 500);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'no literal colour');
  for (const match of block.matchAll(/(?:gap|padding[a-z-]*|margin[a-z-]*):\s*([^;]+);/g)) {
    assert.match(match[1], /var\(--studio-space-\d+\)|^0|auto|calc/, `spacing "${match[1]}" comes from the scale`);
  }
  assert.doesNotMatch(block, /border-(top|bottom):|<hr/);
});