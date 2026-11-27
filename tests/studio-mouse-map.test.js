import assert from 'node:assert/strict';
import test from 'node:test';
import { findMouseNavigation, KEYMAP_PRESET_IDS, resolveKeymapPreset } from '../src/studio-keymap.js';
import {
  applyMouseOverrides,
  DEFAULT_MOUSE_MAP,
  findMouseAction,
  findMouseMapConflicts,
  formatMousePress,
  validateMouseRow,
} from '../src/studio-mouse-map.js';

const press = (button, gesture, held = {}) => findMouseAction(DEFAULT_MOUSE_MAP, { button, gesture, ...held });

test('the default map resolves every documented press', () => {
  assert.equal(press(0, 'drag'), 'view.orbit');
  assert.equal(press(0, 'drag', { shiftKey: true }), 'view.pan');
  assert.equal(press(2, 'drag'), 'view.pan');
  assert.equal(press(1, 'drag'), 'view.pan');
  assert.equal(press(0, 'drag', { spaceHeld: true }), 'view.pan');
  assert.equal(press(1, 'click'), 'view.setPivot');
  assert.equal(press(2, 'click', { altKey: true }), 'view.setPivot');
  assert.equal(press(3, 'click'), 'edit.undo');
  assert.equal(press(4, 'click'), 'edit.redo');
});

test('a plain left or right click is not in the map, so it keeps selecting', () => {
  assert.equal(press(0, 'click'), null);
  assert.equal(press(2, 'click'), null);
  assert.equal(press(0, 'click', { shiftKey: true }), null);
});

test('the row with the most held modifiers wins and extra modifiers do not hide a row', () => {
  assert.equal(press(0, 'drag', { shiftKey: true, spaceHeld: true }), 'view.pan');
  assert.equal(press(0, 'drag', { ctrlKey: true }), 'view.orbit');
  assert.equal(press(1, 'click', { shiftKey: true }), 'view.setPivot');
});

test('the default map is frozen and has no two rows on one press', () => {
  assert.equal(Object.isFrozen(DEFAULT_MOUSE_MAP), true);
  assert.equal(DEFAULT_MOUSE_MAP.every(row => Object.isFrozen(row) && Object.isFrozen(row.modifiers)), true);
  assert.deepEqual(findMouseMapConflicts(DEFAULT_MOUSE_MAP), []);
  assert.equal(new Set(DEFAULT_MOUSE_MAP.map(row => row.id)).size, DEFAULT_MOUSE_MAP.length);
});

test('a row that is malformed throws an error that says what to pass', () => {
  const base = DEFAULT_MOUSE_MAP[0];
  assert.throws(() => validateMouseRow({ ...base, button: 7 }), /button 7: pass 0 to 4/);
  assert.throws(() => validateMouseRow({ ...base, button: 1.5 }), /pass 0 to 4/);
  assert.throws(() => validateMouseRow({ ...base, modifiers: { meta: true } }), /modifier "meta": pass any of shift, alt, ctrl, space/);
  assert.throws(() => validateMouseRow({ ...base, modifiers: { shift: 'yes' } }), /must be true or false/);
  assert.throws(() => validateMouseRow({ ...base, modifiers: null }), /needs modifiers as an object/);
  assert.throws(() => validateMouseRow({ ...base, gesture: 'hover' }), /pass click or drag/);
  assert.throws(() => validateMouseRow({ ...base, action: 'view.zoom' }), /pass one of view.orbit/);
  assert.throws(() => validateMouseRow({ ...base, id: '' }), /non-empty string/);
  assert.throws(() => validateMouseRow(null), /must be an object/);
});

test('an override moves a row to another press and keeps its gesture and action', () => {
  const { map, unbound, conflicts } = applyMouseOverrides(DEFAULT_MOUSE_MAP, {
    'pivot.middle': { button: 0, modifiers: { ctrl: true, alt: false } },
  });
  assert.deepEqual(unbound, []);
  assert.deepEqual(conflicts, []);
  assert.equal(findMouseAction(map, { button: 0, ctrlKey: true, gesture: 'click' }), 'view.setPivot');
  assert.equal(findMouseAction(map, { button: 1, gesture: 'click' }), null);
  assert.deepEqual(map.find(row => row.id === 'pivot.middle').modifiers, { ctrl: true });
  assert.equal(DEFAULT_MOUSE_MAP.find(row => row.id === 'pivot.middle').button, 1, 'the defaults are untouched');
});

test('a null override leaves the row without a press and is listed as unbound', () => {
  const { map, unbound } = applyMouseOverrides(DEFAULT_MOUSE_MAP, { 'undo.back': null });
  assert.deepEqual(unbound, ['undo.back']);
  assert.equal(findMouseAction(map, { button: 3, gesture: 'click' }), null);
  assert.equal(findMouseAction(map, { button: 4, gesture: 'click' }), 'edit.redo');
});

test('two rows moved onto one press are reported as a conflict, not thrown', () => {
  const { conflicts } = applyMouseOverrides(DEFAULT_MOUSE_MAP, { 'redo.forward': { button: 3, modifiers: {} } });
  assert.deepEqual(conflicts, [['undo.back', 'redo.forward']]);
});

test('an override for an unknown row or a bad press throws', () => {
  assert.throws(() => applyMouseOverrides(DEFAULT_MOUSE_MAP, { 'pan.nowhere': null }), /Unknown mouse row "pan.nowhere": pass one of orbit.left/);
  assert.throws(() => applyMouseOverrides(DEFAULT_MOUSE_MAP, { 'pan.middle': { button: 9, modifiers: {} } }), /pass 0 to 4/);
});

test('rows read as words for the shortcuts dialog', () => {
  const words = Object.fromEntries(DEFAULT_MOUSE_MAP.map(row => [row.id, formatMousePress(row)]));
  assert.deepEqual(words, {
    'orbit.left': 'Left drag',
    'pan.shiftLeft': 'Shift + left drag',
    'pan.right': 'Right drag',
    'pan.middle': 'Middle drag',
    'pan.spaceLeft': 'Space + left drag',
    'pivot.middle': 'Middle click',
    'pivot.altRight': 'Alt + right click',
    'undo.back': 'Back button click',
    'redo.forward': 'Forward button click',
  });
});

for (const presetId of KEYMAP_PRESET_IDS) {
  test(`${presetId}: an unmoved Alt + right press sets the pivot and a moved one keeps the preset navigation`, () => {
    const keymap = resolveKeymapPreset(presetId);
    const altRight = { button: 2, altKey: true };
    assert.equal(findMouseAction(DEFAULT_MOUSE_MAP, { ...altRight, gesture: 'click' }), 'view.setPivot');
    const dragMode = findMouseNavigation(keymap, altRight);
    assert.equal(dragMode, presetId === 'crucible' ? null : 'zoom', 'the preset still owns the Alt drag');
  });
}
