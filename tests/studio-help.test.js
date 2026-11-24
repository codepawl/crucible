import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import { balanceSheetColumns, openStudioGuide, sheetColumnCount, shortcutSheetGroups, STUDIO_GUIDE_URL, watchScrolledToEnd } from '../src/studio-help.js';
import { STUDIO_ICON_PATHS } from '../src/studio-icons.js';
import { DEFAULT_KEYMAP_ACTIONS, keyLabel, resolveKeymap, resolveKeymapPreset } from '../src/studio-keymap.js';
import { byText, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const RECIPE = {
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
  materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
  nodes: [{ id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] }],
  camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
};

function mountStudio(testContext, options = {}) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: RECIPE, renderer: createFakeRenderer(), ...options });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  return {
    dom,
    studio,
    root,
    helpMenu: root.querySelector('#crucible-studio-pop-help'),
    helpButton: root.querySelector('button[popovertarget="crucible-studio-pop-help"]'),
    sheet: root.querySelector('.crucible-studio-shortcuts-dialog'),
  };
}

const sheetRows = sheet => sheet.querySelectorAll('.crucible-studio-shortcut-item').map(item => ({
  label: item.querySelector('span').textContent,
  keys: item.querySelector('.crucible-studio-shortcut-keys').textContent,
}));

test('the Help menu is the last menu of the bar and offers the shortcuts and the guide, each with an icon', testContext => {
  const ui = mountStudio(testContext);
  const menuButtons = ui.root.querySelectorAll('.crucible-studio-menus .crucible-studio-menu-button');
  assert.equal(menuButtons.at(-1), ui.helpButton);
  assert.equal(ui.helpButton.textContent, 'Help');
  const labels = ui.helpMenu.querySelectorAll('button').map(button => button.textContent);
  assert.ok(labels.includes('Keyboard shortcuts'));
  assert.ok(labels.includes('Documentation'));
  for (const label of ['Keyboard shortcuts', 'Documentation']) {
    assert.ok(byText(ui.helpMenu, label).querySelector('.crucible-studio-icon'), `${label} leads with an icon`);
  }
  assert.equal(byText(ui.helpMenu, 'Keyboard shortcuts').dataset.shortcut, '?');
});

test('the sheet lists every bound action of the keymap, whichever preset is active', () => {
  for (const presetId of ['crucible', 'maya', 'cinema4d']) {
    const keymap = resolveKeymapPreset(presetId);
    const groups = shortcutSheetGroups(keymap);
    for (const item of keymap.actions) {
      if (item.bindings.length === 0) continue;
      const listed = groups.flatMap(group => group.rows).some(row => keymap.toolKeysGrab ? row.label === item.label : row.label === item.label || ['Move', 'Rotate', 'Scale'].includes(row.label));
      assert.ok(listed, `${presetId}: ${item.id} is on the sheet`);
      const row = groups.flatMap(group => group.rows).find(candidate => candidate.keys === keysOf(keymap, item));
      assert.ok(row, `${presetId}: ${item.id} shows ${keysOf(keymap, item)}`);
    }
  }
});

function keysOf(keymap, item) {
  const labels = [];
  item.bindings.forEach((_binding, index) => {
    const label = keyLabel(keymap, item.id, index);
    if (!labels.includes(label)) labels.push(label);
  });
  return labels.join(', ');
}

test('the groups follow what a person is doing, each with a few rows, in two balanced columns', () => {
  const groups = shortcutSheetGroups(resolveKeymap());
  const names = groups.map(group => group.title);
  for (const expected of ['File', 'History', 'Selection', 'Clipboard and objects', 'Transform and tools', 'View', 'Mesh editing', 'Help and settings']) {
    assert.ok(names.includes(expected), expected);
  }
  for (const group of groups) assert.ok(group.rows.length >= 2 && group.rows.length <= 8, `${group.title} has ${group.rows.length} rows`);
  const [left, right] = balanceSheetColumns(groups);
  assert.deepEqual([...left, ...right].map(group => group.title), names, 'order kept, no group cut or lost');
  const height = column => column.reduce((sum, group) => sum + group.rows.length + 1, 0);
  assert.ok(Math.abs(height(left) - height(right)) <= 8);
});

test('a rebound key shows its new label on the sheet', testContext => {
  const original = shortcutSheetGroups(resolveKeymap()).flatMap(group => group.rows).find(row => row.label === 'Save');
  assert.equal(original.keys, 'Ctrl+S');
  const rebound = resolveKeymap({ 'file.save': { key: 'w', ctrl: true } });
  const row = shortcutSheetGroups(rebound).flatMap(group => group.rows).find(candidate => candidate.label === 'Save');
  assert.equal(row.keys, keyLabel(rebound, 'file.save'));
  assert.notEqual(row.keys, 'Ctrl+S');

  const ui = mountStudio(testContext);
  assert.ok(sheetRows(ui.sheet).some(item => item.label === 'Play' && item.keys === 'Space'));
  const keymapControl = ui.root.querySelector('.crucible-studio-settings-dialog').descendants().find(element => element.dataset?.setting === 'keymap');
  keymapControl.value = 'maya';
  dispatch(keymapControl, 'change');
  const mayaPlay = sheetRows(ui.sheet).find(item => item.label === 'Play');
  assert.equal(mayaPlay.keys, keyLabel(resolveKeymapPreset('maya'), 'animate.play'));
});

test('the sheet opens from the menu and returns the focus to the Help button when it closes', testContext => {
  const ui = mountStudio(testContext);
  byText(ui.helpMenu, 'Keyboard shortcuts').click();
  assert.equal(ui.sheet.open, true);
  assert.ok(ui.sheet.querySelectorAll('.crucible-studio-shortcut-group').length >= 5);
  const closeButton = ui.sheet.querySelector('.crucible-studio-shortcuts-head button');
  assert.equal(closeButton.getAttribute('aria-label'), 'Close the shortcuts');
  assert.equal(ui.sheet.querySelectorAll('button').filter(button => button.textContent === 'Done').length, 0);
  closeButton.click();
  assert.equal(ui.sheet.open, false);
  assert.equal(ui.dom.document.activeElement, ui.helpButton);
});

test('Documentation hands the guide address to the host, or opens a tab that cannot reach back', testContext => {
  const hostCalls = [];
  const withHost = mountStudio(testContext, { openExternal: url => hostCalls.push(url) });
  byText(withHost.helpMenu, 'Documentation').click();
  assert.deepEqual(hostCalls, [STUDIO_GUIDE_URL]);

  const tabCalls = [];
  const plain = mountStudio(testContext);
  plain.dom.document.defaultView.open = (...callArguments) => tabCalls.push(callArguments);
  byText(plain.helpMenu, 'Documentation').click();
  assert.equal(tabCalls.length, 1);
  assert.equal(tabCalls[0][0], STUDIO_GUIDE_URL);
  assert.match(tabCalls[0][2], /noopener/);
  assert.equal(STUDIO_GUIDE_URL, 'https://github.com/codepawl/crucible/blob/main/docs/studio.md');
});

test('openStudioGuide does nothing harmful when no window or host exists', () => {
  assert.equal(openStudioGuide({}), null);
});

test('the sheet takes three columns in a wide window and one in a narrow one, and the tallest column is as short as it can be', () => {
  assert.equal(sheetColumnCount(1280), 3);
  assert.equal(sheetColumnCount(900), 2);
  assert.equal(sheetColumnCount(720), 1);
  const groups = shortcutSheetGroups(resolveKeymap());
  const columns = balanceSheetColumns(groups, 3);
  assert.equal(columns.length, 3);
  assert.deepEqual(columns.flat().map(group => group.title), groups.map(group => group.title));
  const height = column => column.reduce((sum, group) => sum + group.rows.length + 1, 0);
  const total = groups.reduce((sum, group) => sum + group.rows.length + 1, 0);
  assert.ok(Math.max(...columns.map(height)) <= Math.ceil(total / 3) + 3);
});

test('no sheet label is long enough to wrap in a third of the dialog, and Documentation leads with a book', testContext => {
  for (const presetId of ['crucible', 'maya', 'cinema4d']) {
    for (const row of shortcutSheetGroups(resolveKeymapPreset(presetId)).flatMap(group => group.rows)) {
      assert.ok(row.label.length + row.keys.length <= 52, `${presetId}: "${row.label}" is too long for one line`);
    }
  }
  const ui = mountStudio(testContext);
  const bookPath = STUDIO_ICON_PATHS.book;
  assert.equal(byText(ui.helpMenu, 'Documentation').querySelector('path').getAttribute('d'), bookPath);
  assert.notEqual(bookPath, STUDIO_ICON_PATHS.help);
});

test('the sheet marks that rows are hidden below until it is scrolled to the end', () => {
  const body = new EventTarget();
  body.dataset = {};
  Object.assign(body, { scrollHeight: 600, clientHeight: 300, scrollTop: 0 });
  const sync = watchScrolledToEnd(body);
  sync();
  assert.equal(body.dataset.more, 'true');
  body.scrollTop = 300;
  body.dispatchEvent(new Event('scroll'));
  assert.equal(body.dataset.more, undefined);
});
