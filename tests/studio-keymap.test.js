import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_KEYMAP_ACTIONS,
  findKeymapAction,
  findKeymapConflicts,
  formatBinding,
  formatShortcutKeys,
  keyLabel,
  resolveKeymap,
  SHORTCUT_ROWS,
} from '../src/studio-keymap.js';

const defaults = resolveKeymap();

function keyEvent(key, modifiers = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers };
}

test('every action id is unique and every action names a label, a group and a binding', () => {
  const ids = DEFAULT_KEYMAP_ACTIONS.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of DEFAULT_KEYMAP_ACTIONS) {
    assert.ok(item.label && item.group, item.id);
    assert.ok(['normal', 'modal', 'mesh'].includes(item.context), item.id);
    assert.ok(item.bindings.length > 0, item.id);
  }
});

test('no two actions of one context share a binding', () => {
  assert.deepEqual(findKeymapConflicts(DEFAULT_KEYMAP_ACTIONS), []);
});

test('the default keymap is frozen', () => {
  assert.ok(Object.isFrozen(DEFAULT_KEYMAP_ACTIONS));
  assert.ok(Object.isFrozen(DEFAULT_KEYMAP_ACTIONS[0].bindings[0]));
  assert.ok(Object.isFrozen(defaults.actions));
});

test('overrides replace the bindings of the actions they name', () => {
  const keymap = resolveKeymap({ 'tool.select': { key: 'v' }, 'view.frame': [{ code: 'KeyF' }, { key: 'Home' }] });
  assert.deepEqual(keymap.actions.find(item => item.id === 'tool.select').bindings, [{ key: 'v' }]);
  assert.equal(keyLabel(keymap, 'view.frame', 0), 'F');
  assert.equal(keyLabel(keymap, 'view.frame', 1), 'Home');
  assert.equal(findKeymapAction(keymap, keyEvent('v'), 'normal').actionId, 'tool.select');
  assert.equal(findKeymapAction(keymap, keyEvent('q'), 'normal'), null);
});

test('override validation says what to pass', () => {
  assert.throws(() => resolveKeymap({ 'tool.fly': { key: 'w' } }), /Unknown keymap action "tool\.fly": pass one of tool\.select/);
  assert.throws(() => resolveKeymap({ 'tool.select': 'v' }), /binding for "tool\.select".*pass \{ key: "g" \}/);
  assert.throws(() => resolveKeymap({ 'tool.select': { key: 'v', code: 'KeyV' } }), /exactly one of key and code/);
  assert.throws(() => resolveKeymap({ 'tool.select': { key: '' } }), /exactly one of key and code/);
  assert.throws(() => resolveKeymap({ 'tool.select': { key: 'v', meta: true } }), /unknown field "meta"/);
  assert.throws(() => resolveKeymap({ 'tool.select': { key: 'v', ctrl: 'yes' } }), /ctrl must be true or false/);
  assert.throws(() => resolveKeymap({ 'tool.select': [] }), /empty list/);
  assert.throws(() => resolveKeymap(null), /object of \{ actionId: binding \}/);
  assert.throws(() => resolveKeymap({ 'tool.select': { key: 'g' } }), /"tool\.translate" and "tool\.select" share a key|"tool\.select" and "tool\.translate" share a key/);
});

test('the same key may mean different things in the normal and the modal context', () => {
  assert.equal(findKeymapAction(defaults, keyEvent('g'), 'normal').actionId, 'tool.translate');
  assert.equal(findKeymapAction(defaults, keyEvent('g'), 'modal').actionId, 'modal.translate');
  assert.equal(findKeymapAction(defaults, keyEvent('Escape'), 'normal').actionId, 'edit.deselect');
  assert.equal(findKeymapAction(defaults, keyEvent('Escape'), 'modal').actionId, 'modal.cancel');
  assert.equal(findKeymapAction(defaults, keyEvent('x'), 'modal').actionId, 'modal.axisX');
  assert.equal(findKeymapAction(defaults, keyEvent(' '), 'modal').actionId, 'modal.place');
});

test('an event finds its action by key and modifiers', () => {
  const find = (key, modifiers) => findKeymapAction(defaults, keyEvent(key, modifiers), 'normal')?.actionId ?? null;
  assert.equal(find('s', { ctrlKey: true }), 'file.save');
  assert.equal(find('s', { metaKey: true }), 'file.save');
  assert.equal(find('S', { ctrlKey: true, shiftKey: true }), 'file.saveAs');
  assert.equal(find('Z', { ctrlKey: true, shiftKey: true }), 'edit.redo');
  assert.equal(find('z', { ctrlKey: true }), 'edit.undo');
  assert.equal(find('D', { shiftKey: true }), 'edit.duplicate');
  assert.equal(find('d', { ctrlKey: true }), 'edit.duplicate');
  assert.equal(find('d'), null);
  assert.equal(find('h', { altKey: true }), 'edit.showAll');
  assert.equal(find('H', { shiftKey: true }), 'edit.hide');
  assert.equal(find('h'), 'edit.hide');
  assert.equal(find('g', { altKey: true }), 'edit.resetPosition');
  assert.equal(find('Delete'), 'edit.delete');
  assert.equal(find('Backspace'), 'edit.delete');
  assert.equal(find('?', { shiftKey: true }), 'help.shortcuts');
  assert.equal(find(',', { ctrlKey: true }), 'settings.open');
  assert.equal(find('c', { ctrlKey: true, shiftKey: true }), null);
  assert.equal(find('q', { ctrlKey: true }), null);
  assert.equal(find('q', { altKey: true }), null);
});

test('a binding with a code matches the physical key', () => {
  const keymap = resolveKeymap({ 'tool.select': { code: 'KeyQ' } });
  assert.equal(findKeymapAction(keymap, { code: 'KeyQ', key: 'a' }, 'normal').actionId, 'tool.select');
  assert.equal(findKeymapAction(keymap, { code: 'KeyW', key: 'q' }, 'normal'), null);
  assert.equal(formatBinding({ code: 'KeyQ', ctrl: true }), 'Ctrl+Q');
});

test('bindings are labelled as the menus show them', () => {
  assert.equal(formatBinding({ key: 'z', ctrl: true, shift: true }), 'Ctrl+Shift+Z');
  assert.equal(formatBinding({ key: 'h', alt: true }), 'Alt+H');
  assert.equal(formatBinding({ key: ' ' }), 'Space');
  assert.equal(formatBinding({ key: 'Escape' }), 'Esc');
  assert.equal(formatBinding({ key: ',', ctrl: true }), 'Ctrl+,');
  assert.equal(keyLabel(defaults, 'edit.duplicate'), 'Shift+D');
  assert.equal(keyLabel(defaults, 'edit.duplicate', 1), 'Ctrl+D');
  assert.equal(keyLabel(defaults, 'edit.copy', 5), '');
  assert.throws(() => keyLabel(defaults, 'nope'), /Unknown keymap action "nope"/);
});

test('shortcut dialog rows fill their placeholders from the keymap', () => {
  assert.equal(formatShortcutKeys(defaults, 'Click or {modal.place} / {modal.cancel}'), 'Click or Enter / Esc');
  assert.equal(formatShortcutKeys(defaults, '{edit.duplicate} / {edit.duplicate#1}'), 'Shift+D / Ctrl+D');
  const known = new Set(DEFAULT_KEYMAP_ACTIONS.map(item => item.id));
  for (const row of SHORTCUT_ROWS) {
    for (const [, actionId] of row.keys.matchAll(/\{([\w.]+)(?:#\d+)?\}/g)) {
      assert.ok(known.has(actionId), `${row.label}: ${actionId}`);
    }
  }
});

test('the Keys table of docs/studio.md lists exactly the keys of the table', () => {
  const doc = readFileSync(new URL('../docs/studio.md', import.meta.url), 'utf8');
  const section = doc.split(/^## Keys$/m)[1].split(/^## /m)[0];
  const rows = section.split('\n').filter(line => line.startsWith('|')).slice(2);
  const mouseWords = new Set(['Click', 'Right click', 'right click']);
  const documented = new Set();
  for (const row of rows) {
    const keyCell = row.split('|')[1].trim();
    for (const token of keyCell.split(/,\s+|\s+or\s+/)) {
      if (!mouseWords.has(token)) documented.add(token);
    }
  }
  const tabled = new Set();
  for (const item of DEFAULT_KEYMAP_ACTIONS) {
    for (const value of item.bindings) tabled.add(formatBinding(value));
  }
  assert.deepEqual([...tabled].filter(label => !documented.has(label)), [], 'in the table but not in docs/studio.md');
  assert.deepEqual([...documented].filter(label => !tabled.has(label)), [], 'in docs/studio.md but not in the table');
});
