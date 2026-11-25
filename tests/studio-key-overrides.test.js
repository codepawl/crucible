import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { findKeymapAction, keyLabel, resolveKeymapPreset } from '../src/studio-keymap.js';
import {
  bindingFromKeyEvent,
  browserReservedNote,
  findBindingHolders,
  normalizeKeyOverrides,
  withActionBindings,
  withPresetOverrides,
  withSwappedBindings,
} from '../src/studio-key-overrides.js';
import { loadStudioPreferences, normalizeStudioPreferences, saveStudioPreferences } from '../src/studio-preferences.js';
import { shortcutSheetGroups } from '../src/studio-help.js';

const press = (keymap, key, extra = {}) => findKeymapAction(keymap, { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra })?.actionId ?? null;

test('an override moves an action to a new key: the old key stops firing and the new one fires (#3390)', () => {
  const keymap = resolveKeymapPreset('crucible', { 'tool.select': { key: 'v', shift: false } });
  assert.equal(press(keymap, 'q'), null);
  assert.equal(press(keymap, 'v'), 'tool.select');
  assert.equal(keyLabel(keymap, 'tool.select'), 'V');
});

test('an override of one preset leaves the others as they were, and null leaves an action without a key (#3390)', () => {
  const overrides = { 'tool.translate': null };
  const crucible = resolveKeymapPreset('crucible', overrides);
  assert.equal(press(crucible, 'g'), null);
  assert.equal(keyLabel(crucible, 'tool.translate'), '');
  assert.equal(press(resolveKeymapPreset('maya'), 'w'), 'tool.translate');
  const maya = resolveKeymapPreset('maya', { 'tool.select': { key: 'v', shift: false } });
  assert.equal(press(maya, 'q'), null);
  assert.equal(press(maya, 'w'), 'tool.translate');
  assert.equal(press(resolveKeymapPreset('crucible'), 'q'), 'tool.select');
});

test('stored overrides are dropped when unknown, malformed, refused by the browser or clashing, and the sound ones stay (#3390)', () => {
  const cleaned = normalizeKeyOverrides({
    crucible: {
      'tool.select': { key: 'v', shift: false },
      'no.such.action': { key: 'z' },
      'tool.rotate': { key: 'k', mood: 'odd' },
      'tool.scale': 'not a binding',
      'view.top': { key: 'w', ctrl: true },
      'edit.hide': [],
    },
    nowhere: { 'tool.select': { key: 'v' } },
    maya: 'broken',
  });
  assert.deepEqual(cleaned, { crucible: { 'tool.select': { key: 'v', shift: false } } });
  assert.deepEqual(normalizeKeyOverrides(null), {});
  assert.deepEqual(normalizeKeyOverrides([1]), {});
  const clashing = normalizeKeyOverrides({ crucible: { 'tool.select': { key: 'g' } } });
  assert.deepEqual(clashing, {}, 'two actions on one key cannot both stay');
});

test('overrides are saved per preset with the preferences and read back; damaged storage gives the defaults (#3390)', () => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const keyOverrides = { crucible: { 'tool.select': { key: 'v', shift: false } }, maya: { 'tool.rotate': null } };
  assert.equal(saveStudioPreferences(storage, { ...normalizeStudioPreferences(null), keyOverrides }), true);
  assert.deepEqual(loadStudioPreferences(storage).keyOverrides, keyOverrides);
  saved.set('crucible-studio-preferences', JSON.stringify({ keyOverrides: { crucible: { 'tool.select': 7 } } }));
  assert.deepEqual(loadStudioPreferences(storage).keyOverrides, {});
});

test('a held combination is found in the same context only, and Swap gives the other action the old key (#3390)', () => {
  const keymap = resolveKeymapPreset('crucible');
  const wanted = { key: 'g', shift: false };
  const holders = findBindingHolders(keymap, 'tool.select', wanted);
  assert.deepEqual(holders.map(holder => holder.id), ['tool.translate']);
  assert.deepEqual(findBindingHolders(keymap, 'mesh.circleSelect', { key: 'q', shift: false }), []);
  const swapped = withSwappedBindings('crucible', {}, keymap, 'tool.select', wanted, holders);
  const after = resolveKeymapPreset('crucible', swapped);
  assert.equal(press(after, 'g'), 'tool.select');
  assert.equal(press(after, 'q'), 'tool.translate');
});

test('a swap keeps the keys of the other action that were not asked for (#3390)', () => {
  const keymap = resolveKeymapPreset('crucible');
  const wanted = { key: 'Delete', shift: false };
  const holders = findBindingHolders(keymap, 'tool.select', wanted);
  assert.deepEqual(holders.map(holder => holder.id), ['edit.delete']);
  const after = resolveKeymapPreset('crucible', withSwappedBindings('crucible', {}, keymap, 'tool.select', wanted, holders));
  assert.equal(press(after, 'x'), 'edit.delete');
  assert.equal(press(after, 'Backspace'), 'edit.delete');
  assert.equal(press(after, 'q'), 'edit.delete');
  assert.equal(press(after, 'Delete'), 'tool.select');
});

test('keys the browser keeps are refused and others are not (#3390)', () => {
  for (const event of [{ key: 'w', ctrlKey: true }, { key: 'T', ctrlKey: true, shiftKey: true }, { key: 'n', metaKey: true }, { key: 'F11' }, { key: '3', ctrlKey: true }]) {
    assert.match(browserReservedNote(bindingFromKeyEvent(event)), /belongs to the browser/, JSON.stringify(event));
  }
  for (const event of [{ key: 'k', ctrlKey: true }, { key: 'F5' }, { key: 'w' }, { key: 'w', ctrlKey: true, altKey: true }]) {
    assert.equal(browserReservedNote(bindingFromKeyEvent(event)), null, JSON.stringify(event));
  }
});

test('a recorded combination waits for a real key, keeps Shift for letters and takes the physical key under Alt (#3390)', () => {
  assert.equal(bindingFromKeyEvent({ key: 'Shift', shiftKey: true }), null);
  assert.equal(bindingFromKeyEvent({ key: 'Control', ctrlKey: true }), null);
  assert.deepEqual(bindingFromKeyEvent({ key: 'G', shiftKey: true }), { key: 'g', shift: true });
  assert.deepEqual(bindingFromKeyEvent({ key: 'g' }), { key: 'g', shift: false });
  assert.deepEqual(bindingFromKeyEvent({ key: 'k', ctrlKey: true }), { key: 'k', shift: false, ctrl: true });
  assert.deepEqual(bindingFromKeyEvent({ key: '?', shiftKey: true }), { key: '?' });
  assert.deepEqual(bindingFromKeyEvent({ key: 'å', code: 'KeyA', altKey: true }), { code: 'KeyA', shift: false, alt: true });
  assert.deepEqual(bindingFromKeyEvent({ key: 'F2' }), { key: 'F2', shift: false });
});

test('setting an action back to its preset keys removes the override, and one preset set can be cleared (#3390)', () => {
  const changed = withActionBindings('crucible', {}, 'tool.select', [{ key: 'v', shift: false }]);
  assert.deepEqual(Object.keys(changed), ['tool.select']);
  assert.deepEqual(withActionBindings('crucible', changed, 'tool.select', [{ key: 'q' }]), {});
  assert.deepEqual(withActionBindings('crucible', {}, 'edit.hide', null), { 'edit.hide': null });
  assert.deepEqual(withPresetOverrides({ maya: { 'tool.rotate': null } }, 'maya', {}), {});
});

test('the sheet and the settings list read one set of groups, and Settings also lists actions without a key (#3390)', () => {
  const keymap = resolveKeymapPreset('crucible', { 'edit.hide': null });
  const sheetIds = shortcutSheetGroups(keymap).flatMap(group => group.rows).map(row => row.actionId).filter(Boolean);
  const settingsGroups = shortcutSheetGroups(keymap, { includeUnbound: true });
  const settingsIds = settingsGroups.flatMap(group => group.rows).map(row => row.actionId).filter(Boolean);
  assert.ok(!sheetIds.includes('edit.hide'));
  assert.ok(settingsIds.includes('edit.hide'));
  assert.ok(!settingsIds.includes('mesh.noop'));
  for (const id of sheetIds.filter(id => id !== 'mesh.noop')) assert.ok(settingsIds.includes(id), id);
  assert.ok(settingsGroups.find(group => group.title === 'Mouse').rows.every(row => row.actionId === undefined));
});