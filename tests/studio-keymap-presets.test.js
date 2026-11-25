import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_KEYMAP_ACTIONS,
  findKeymapAction,
  findKeymapConflicts,
  findMouseNavigation,
  formatBinding,
  formatShortcutKeys,
  KEYMAP_PRESET_IDS,
  KEYMAP_PRESETS,
  resolveKeymap,
  resolveKeymapPreset,
  SHORTCUT_ROWS,
  shortcutRowsFor,
} from '../src/studio-keymap.js';

const defaults = resolveKeymap();

function keyEvent(key, modifiers = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers };
}

// The keys of each preset, spelled out. A preset sets only these; every other action keeps its default key, so a later
// edit that invents a key fails here. Sources: Autodesk "All Maya Hotkeys" and Maxon "Keyboard Shortcuts" (see studio-keymap.js).
const EXPECTED_PRESET_KEYS = {
  maya: {
    'tool.select': ['Q'],
    'tool.translate': ['W'],
    'tool.rotate': ['E'],
    'tool.scale': ['R'],
    'tool.snap': ['J'],
    'edit.duplicate': ['Ctrl+D'],
    'edit.delete': ['Delete', 'Backspace'],
    'edit.undo': ['Ctrl+Z'],
    'edit.redo': ['Ctrl+Y', 'Ctrl+Shift+Z'],
    'edit.hide': ['Ctrl+H'],
    'edit.showAll': ['Ctrl+Shift+H'],
    'view.frame': ['F'],
    'view.properties': ['Ctrl+A'],
    // Not a vendor key: Ctrl+A is taken above, so Apply moves to the nearest free key.
    'edit.apply': ['Ctrl+Alt+A'],
    'animate.keyframe': ['S'],
    'animate.play': ['Alt+V'],
    'modal.translate': ['W'],
    'modal.rotate': ['E'],
    'modal.scale': ['R'],
  },
  cinema4d: {
    'tool.select': ['9'],
    'tool.translate': ['E'],
    'tool.rotate': ['R'],
    'tool.scale': ['T'],
    'tool.snap': ['Shift+S'],
    'edit.delete': ['Backspace', 'Delete'],
    'edit.deselect': ['Ctrl+Shift+A', 'Esc'],
    'view.frame': ['O', 'S'],
    'view.properties': ['Shift+F5'],
    'animate.keyframe': ['F9'],
    'animate.play': ['F8'],
    'modal.translate': ['E'],
    'modal.rotate': ['R'],
    'modal.scale': ['T'],
  },
};

// The Keymaps table calls the three tools by their plain names, because in Maya and Cinema 4D they do not pick up.
const DOC_ROW_LABELS = { 'tool.translate': 'Move', 'tool.rotate': 'Rotate', 'tool.scale': 'Scale' };

const labelsOf =(keymap, actionId) => keymap.actions.find(item => item.id === actionId).bindings.map(formatBinding);

test('every preset resolves with no two actions on one key, and the default preset is the default keymap', () => {
  assert.deepEqual(KEYMAP_PRESET_IDS, ['crucible', 'maya', 'cinema4d']);
  assert.equal(KEYMAP_PRESETS.crucible.label, 'Blender');
  for (const presetId of KEYMAP_PRESET_IDS) {
    const keymap = resolveKeymapPreset(presetId);
    assert.deepEqual(findKeymapConflicts(keymap.actions), [], presetId);
  }
  assert.deepEqual(resolveKeymapPreset('crucible').actions, defaults.actions);
  assert.throws(() => resolveKeymapPreset('zbrush'), /Unknown keymap preset "zbrush": pass one of crucible, maya, cinema4d/);
});

test('every action is bound in the default keymap and no preset leaves one without a key', () => {
  for (const item of DEFAULT_KEYMAP_ACTIONS) assert.ok(item.bindings.length > 0, item.id);
  for (const presetId of KEYMAP_PRESET_IDS) {
    for (const item of resolveKeymapPreset(presetId).actions) assert.ok(item.bindings.length > 0, `${presetId} ${item.id}`);
  }
});

test('resolveKeymap can leave an action unbound by name, and says which names exist', () => {
  const keymap = resolveKeymap({}, { unbound: ['edit.hide'] });
  assert.deepEqual(keymap.actions.find(item => item.id === 'edit.hide').bindings, []);
  assert.throws(() => resolveKeymap({}, { unbound: ['edit.nothing'] }), /Unknown keymap action "edit.nothing" in unbound/);
});

for (const [presetId, expected] of Object.entries(EXPECTED_PRESET_KEYS)) {
  test(`the ${presetId} preset sets exactly the keys the vendor lists and keeps the default for the rest`, () => {
    assert.deepEqual(Object.keys(KEYMAP_PRESETS[presetId].bindings).sort(), Object.keys(expected).sort());
    const keymap = resolveKeymapPreset(presetId);
    for (const item of DEFAULT_KEYMAP_ACTIONS) {
      const wanted = expected[item.id] ?? item.bindings.map(formatBinding);
      assert.deepEqual(labelsOf(keymap, item.id), wanted, `${presetId} ${item.id}`);
    }
  });
}

test('in Maya and Cinema 4D a tool key only selects the tool, and in the default preset it picks the object up', () => {
  assert.equal(resolveKeymapPreset('crucible').toolKeysGrab, true);
  assert.equal(resolveKeymapPreset('maya').toolKeysGrab, false);
  assert.equal(resolveKeymapPreset('cinema4d').toolKeysGrab, false);
});

test('a preset key finds its action, and a key it freed finds none', () => {
  const maya = resolveKeymapPreset('maya');
  assert.equal(findKeymapAction(maya, keyEvent('r')).actionId, 'tool.scale');
  assert.equal(findKeymapAction(maya, keyEvent('s')).actionId, 'animate.keyframe');
  assert.equal(findKeymapAction(maya, keyEvent('x')), null, 'Maya leaves X free');
  assert.equal(findKeymapAction(maya, keyEvent('h', { ctrlKey: true })).actionId, 'edit.hide');
  assert.equal(findKeymapAction(maya, keyEvent('H', { ctrlKey: true, shiftKey: true })).actionId, 'edit.showAll');
  assert.equal(findKeymapAction(maya, keyEvent('v', { altKey: true })).actionId, 'animate.play');
  assert.equal(findKeymapAction(maya, keyEvent('r'), 'modal').actionId, 'modal.scale');
  const cinema = resolveKeymapPreset('cinema4d');
  assert.equal(findKeymapAction(cinema, keyEvent('s')).actionId, 'view.frame');
  assert.equal(findKeymapAction(cinema, keyEvent('S', { shiftKey: true })).actionId, 'tool.snap');
  assert.equal(findKeymapAction(cinema, keyEvent('F9')).actionId, 'animate.keyframe');
  assert.equal(findKeymapAction(cinema, keyEvent('x')), null, 'Cinema 4D leaves X free');
});

test('Alt with a mouse button navigates in Maya and Cinema 4D only', () => {
  const press = (keymap, button, altKey) => findMouseNavigation(keymap, { button, altKey });
  for (const presetId of ['maya', 'cinema4d']) {
    const keymap = resolveKeymapPreset(presetId);
    assert.deepEqual([0, 1, 2].map(button => press(keymap, button, true)), ['orbit', 'pan', 'zoom'], presetId);
    assert.deepEqual([0, 1, 2].map(button => press(keymap, button, false)), [null, null, null], presetId);
  }
  assert.deepEqual([0, 1, 2].map(button => press(defaults, button, true)), [null, null, null]);
});

test('the shortcuts dialog follows the preset: no holding rows where tools do not pick up, and the mouse rows appear', () => {
  assert.deepEqual(shortcutRowsFor(defaults), SHORTCUT_ROWS);
  const maya = resolveKeymapPreset('maya');
  const mayaRows = shortcutRowsFor(maya);
  assert.ok(!mayaRows.some(row => row.label.startsWith('While holding')));
  assert.ok(mayaRows.some(row => row.label === 'Move / Rotate / Scale tool'));
  assert.deepEqual(mayaRows.slice(-3).map(row => [row.keys, row.label]), [['Alt + left drag', 'Orbit'], ['Alt + middle drag', 'Pan'], ['Alt + right drag', 'Zoom']]);
  assert.equal(formatShortcutKeys(maya, '{tool.translate} / {tool.rotate} / {tool.scale}'), 'W / E / R');
  assert.equal(formatShortcutKeys(maya, '{edit.duplicate} / {edit.duplicate#1}'), 'Ctrl+D', 'a missing second key leaves the row');
  assert.equal(formatShortcutKeys(resolveKeymapPreset('cinema4d'), '{view.frame} / {view.frame#1}'), 'O / S');
});

test('docs/studio.md names both sources and every key that differs in a preset', () => {
  const doc = readFileSync(new URL('../docs/studio.md', import.meta.url), 'utf8');
  const section = doc.split(/^## Keymaps$/m)[1].split(/^## /m)[0];
  assert.ok(section.includes('(https://help.autodesk.com/cloudhelp/2025/ENU/Maya-KeyboardShortcuts/'), 'the Maya source link is in the section');
  assert.ok(section.includes('(https://help.maxon.net/c4d/en-us/Content/html/Shortcuts.html)'), 'the Cinema 4D source link is in the section');
  const rows = section.split('\n').filter(line => line.startsWith('|')).slice(2);
  for (const [presetId, expected] of Object.entries(EXPECTED_PRESET_KEYS)) {
    for (const [actionId, labels] of Object.entries(expected)) {
      if (actionId.startsWith('modal.')) continue;
      const actionLabel = DOC_ROW_LABELS[actionId] ?? DEFAULT_KEYMAP_ACTIONS.find(item => item.id === actionId).label;
      const row = rows.find(line => line.split('|')[1].trim() === actionLabel);
      assert.ok(row, `${actionId} has a row in the Keymaps table`);
      const cell = row.split('|')[presetId === 'maya' ? 3 : 4];
      for (const label of labels) assert.ok(cell.includes(label), `${presetId} ${actionId} lists ${label} (row: ${row})`);
    }
  }
});
