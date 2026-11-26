// Every keyboard shortcut of Studio in one table. studio.js dispatches key events through it and takes each key label
// (menus, tooltips, the shortcuts dialog, the hint bar) from it, so a keymap preset swaps bindings and nothing else.
//
// A binding is `{ key | code, ctrl?, shift?, alt? }`. `ctrl` means Ctrl or Command. A modifier left out must be up,
// except `shift`: left out it is not looked at, because plain keys such as H or ? also work with Shift held.
import { NUMPAD_FRAME_BINDINGS, NUMPAD_VIEW_BINDINGS } from './studio-numpad.js';

// `mesh` is edit mode: it is looked up before `normal`, which then only answers the keys studio.js lets through.
export const KEYMAP_CONTEXTS = Object.freeze(['normal', 'modal', 'mesh']);

const BINDING_FIELDS = Object.freeze(['key', 'code', 'ctrl', 'shift', 'alt']);

function binding(key, modifiers = {}) {
  return Object.freeze({ key, ...modifiers });
}

function action(id, label, group, context, ...bindings) {
  return Object.freeze({ id, label, group, context, bindings: Object.freeze(bindings.map(item => Object.freeze(item))) });
}

export const DEFAULT_KEYMAP_ACTIONS = Object.freeze([
  action('tool.select', 'Select', 'Tools', 'normal', binding('q')),
  action('tool.translate', 'Pick up to move', 'Tools', 'normal', binding('g')),
  action('tool.rotate', 'Pick up to rotate', 'Tools', 'normal', binding('r')),
  action('tool.scale', 'Pick up to scale', 'Tools', 'normal', binding('s')),
  action('snap.toggle', 'Snapping on or off', 'Tools', 'normal', binding('Tab', { shift: true })),
  action('add.open', 'Add an object or a light', 'Tools', 'normal', binding('a', { shift: true })),
  action('edit.copy', 'Copy', 'Edit', 'normal', binding('c', { ctrl: true, shift: false })),
  action('edit.paste', 'Paste', 'Edit', 'normal', binding('v', { ctrl: true, shift: false })),
  action('edit.duplicate', 'Duplicate', 'Edit', 'normal', binding('d', { shift: true }), binding('d', { ctrl: true })),
  action('edit.join', 'Join the selected objects', 'Edit', 'normal', binding('j', { ctrl: true })),
  action('edit.parent', 'Parent to active object', 'Edit', 'normal', binding('p', { ctrl: true, shift: false })),
  action('edit.clearParent', 'Clear parent', 'Edit', 'normal', binding('p', { alt: true, shift: false })),
  action('edit.delete', 'Delete', 'Edit', 'normal', binding('x'), binding('Delete'), binding('Backspace')),
  action('edit.rename', 'Rename', 'Edit', 'normal', binding('F2')),
  action('edit.deselect', 'Deselect', 'Edit', 'normal', binding('Escape')),
  action('select.all', 'Select all', 'Edit', 'normal', binding('a', { shift: false })),
  // By code, because Option+A types a letter of its own on a Mac, so its key is not "a".
  action('select.none', 'Select none', 'Edit', 'normal', { code: 'KeyA', alt: true }),
  action('select.invert', 'Invert the selection', 'Edit', 'normal', binding('i', { ctrl: true })),
  action('edit.apply', 'Apply transforms', 'Edit', 'normal', binding('a', { ctrl: true, shift: false })),
  action('edit.hide', 'Hide the selection', 'Edit', 'normal', binding('h')),
  action('edit.showAll', 'Show all', 'Edit', 'normal', binding('h', { alt: true })),
  action('edit.resetPosition', 'Reset position', 'Edit', 'normal', binding('g', { alt: true })),
  action('edit.resetRotation', 'Reset rotation', 'Edit', 'normal', binding('r', { alt: true })),
  action('edit.resetScale', 'Reset scale', 'Edit', 'normal', binding('s', { alt: true })),
  action('edit.undo', 'Undo', 'Edit', 'normal', binding('z', { ctrl: true, shift: false })),
  action('edit.redo', 'Redo', 'Edit', 'normal', binding('z', { ctrl: true, shift: true })),
  action('view.frame', 'Frame the selection', 'View', 'normal', binding('f'), binding('.')),
  action('view.front', 'Front view', 'View', 'normal', binding('1')),
  action('view.right', 'Right view', 'View', 'normal', binding('3')),
  action('view.top', 'Top view', 'View', 'normal', binding('7')),
  action('view.projection', 'Perspective or orthographic', 'View', 'normal', binding('5')),
  action('view.properties', 'Show or hide Properties', 'View', 'normal', binding('n')),
  action('view.seeThrough', 'See through the surface', 'View', 'normal', { code: 'KeyZ', alt: true }),
  action('animate.keyframe', 'Insert a keyframe', 'Animate', 'normal', binding('i'), binding('k')),
  action('animate.play', 'Play', 'Animate', 'normal', binding(' ')),
  // Shift left up: Shift+Tab is the snapping key.
  action('mesh.enter', 'Edit the mesh', 'Edit', 'normal', binding('Tab', { shift: false })),
  action('file.open', 'Open', 'File', 'normal', binding('o', { ctrl: true })),
  action('file.save', 'Save', 'File', 'normal', binding('s', { ctrl: true, shift: false })),
  action('file.saveAs', 'Save as', 'File', 'normal', binding('s', { ctrl: true, shift: true })),
  action('settings.open', 'Settings', 'File', 'normal', binding(',', { ctrl: true })),
  action('help.shortcuts', 'Keyboard shortcuts', 'Help', 'normal', binding('?')),
  action('mesh.leave', 'Leave edit mode', 'Edit mode', 'mesh', binding('Tab', { shift: false })),
  action('mesh.escape', 'Clear the selection, then leave', 'Edit mode', 'mesh', binding('Escape')),
  action('mesh.vertexMode', 'Select vertices', 'Edit mode', 'mesh', binding('1')),
  action('mesh.edgeMode', 'Select edges', 'Edit mode', 'mesh', binding('2')),
  action('mesh.faceMode', 'Select faces', 'Edit mode', 'mesh', binding('3')),
  action('mesh.separate', 'Separate the selection', 'Edit mode', 'mesh', binding('p')),
  action('mesh.makeFace', 'Make face or edge', 'Edit mode', 'mesh', binding('f')),
  action('mesh.deleteMenu', 'Open the delete menu', 'Edit mode', 'mesh', binding('x'), binding('Delete'), binding('Backspace')),
  action('mesh.mergeMenu', 'Open the merge menu', 'Edit mode', 'mesh', binding('m')),
  action('mesh.selectNone', 'Select none', 'Edit mode', 'mesh', { code: 'KeyA', alt: true }),
  action('mesh.invertSelection', 'Invert the selection', 'Edit mode', 'mesh', binding('i', { ctrl: true })),
  action('mesh.circleSelect', 'Circle select', 'Edit mode', 'mesh', binding('c')),
  action('mesh.selectLinked', 'Select what is linked under the pointer', 'Edit mode', 'mesh', binding('l', { ctrl: false })),
  action('mesh.selectLinkedSelection', 'Select what is linked to the selection', 'Edit mode', 'mesh', binding('l', { ctrl: true })),
  // Ctrl+Plus and Ctrl+Minus zoom the page in a browser and there is no numpad on a laptop, so the brackets are the first keys.
  action('mesh.growSelection', 'Grow the selection', 'Edit mode', 'mesh', binding(']'), { code: 'NumpadAdd', ctrl: true }),
  action('mesh.shrinkSelection', 'Shrink the selection', 'Edit mode', 'mesh', binding('['), { code: 'NumpadSubtract', ctrl: true }),
  action('mesh.proportional', 'Proportional editing', 'Edit mode', 'mesh', binding('o')),
  action('mesh.boxSelect', 'Box select', 'Edit mode', 'mesh', binding('b')),
  action('mesh.extrude', 'Extrude the picked faces', 'Edit mode', 'mesh', binding('e')),
  action('mesh.inset', 'Inset the picked faces', 'Edit mode', 'mesh', binding('i')),
  action('modal.place', 'Place', 'Holding an object', 'modal', binding('Enter'), binding(' ')),
  action('modal.cancel', 'Put back', 'Holding an object', 'modal', binding('Escape')),
  action('modal.axisX', 'Keep to the X axis', 'Holding an object', 'modal', binding('x', { shift: false })),
  action('modal.axisY', 'Keep to the Y axis', 'Holding an object', 'modal', binding('y', { shift: false })),
  action('modal.axisZ', 'Keep to the Z axis', 'Holding an object', 'modal', binding('z', { shift: false })),
  action('modal.planeX', 'Keep to the YZ plane', 'Holding an object', 'modal', binding('x', { shift: true })),
  action('modal.planeY', 'Keep to the XZ plane, the ground', 'Holding an object', 'modal', binding('y', { shift: true })),
  action('modal.planeZ', 'Keep to the XY plane', 'Holding an object', 'modal', binding('z', { shift: true })),
  action('modal.translate', 'Switch to move', 'Holding an object', 'modal', binding('g')),
  action('modal.rotate', 'Switch to rotate', 'Holding an object', 'modal', binding('r')),
  action('modal.scale', 'Switch to scale', 'Holding an object', 'modal', binding('s')),
]);

// The rows of the shortcuts dialog. `{action}` or `{action#1}` (the second binding) is replaced by the formatted
// binding; the mouse rows have no action.
export const SHORTCUT_ROWS = Object.freeze([
  Object.freeze({ keys: '{tool.select}', label: 'Select' }),
  Object.freeze({ keys: '{tool.translate} / {tool.rotate} / {tool.scale}', label: 'Pick up to move / rotate / scale' }),
  Object.freeze({ keys: '{modal.axisX} / {modal.axisY} / {modal.axisZ}', label: 'While holding: keep to that axis' }),
  Object.freeze({ keys: 'Shift + {modal.axisX} / {modal.axisY} / {modal.axisZ}', label: 'While holding: keep to the plane across that axis' }),
  Object.freeze({ keys: '0-9 . -', label: 'While holding: type the amount, Backspace to correct' }),
  Object.freeze({ keys: 'Click or {modal.place} / {modal.cancel}', label: 'While holding: place / put back' }),
  Object.freeze({ keys: '{snap.toggle}', label: 'Snapping on or off' }),
  Object.freeze({ keys: 'Ctrl + drag', label: 'Flip snapping while dragging' }),
  Object.freeze({ keys: '{add.open}', label: 'Add an object or a light' }),
  Object.freeze({ keys: '{edit.copy} / {edit.paste}', label: 'Copy / Paste' }),
  Object.freeze({ keys: '{edit.duplicate} / {edit.duplicate#1}', label: 'Duplicate' }),
  Object.freeze({ keys: '{edit.join}', label: 'Join the selected objects into the last one picked' }),
  Object.freeze({ keys: '{edit.parent} / {edit.clearParent}', label: 'Parent to active object / clear parent' }),
  Object.freeze({ keys: '{edit.delete} / {edit.delete#1}', label: 'Delete' }),
  Object.freeze({ keys: '{edit.deselect}', label: 'Deselect' }),
  Object.freeze({ keys: '{select.all} / {select.none} / {select.invert}', label: 'Select all / none / invert' }),
  Object.freeze({ keys: 'Shift + click', label: 'Add or remove an object from the selection' }),
  Object.freeze({ keys: '{edit.apply}', label: 'Apply location, rotation and scale to the geometry' }),
  Object.freeze({ keys: '{edit.hide} / {edit.showAll}', label: 'Hide the selection / show all' }),
  Object.freeze({ keys: '{edit.resetPosition} / {edit.resetRotation} / {edit.resetScale}', label: 'Reset position / rotation / scale' }),
  Object.freeze({ keys: 'Right click', label: 'Menu of the object under the pointer' }),
  Object.freeze({ keys: '{view.frame} / {view.frame#1}', label: 'Frame the selection' }),
  Object.freeze({ keys: '{view.front} / {view.right} / {view.top}', label: 'Front / Right / Top view' }),
  Object.freeze({ keys: '{view.projection}', label: 'Perspective or orthographic' }),
  Object.freeze({ keys: '{view.properties}', label: 'Show or hide Properties' }),
  Object.freeze({ keys: '{animate.keyframe} / {animate.keyframe#1}', label: 'Insert a keyframe' }),
  Object.freeze({ keys: '{animate.play}', label: 'Play' }),
  Object.freeze({ keys: '{edit.undo} / {edit.redo}', label: 'Undo / Redo' }),
  Object.freeze({ keys: '{file.open} / {file.save}', label: 'Open / Save' }),
  Object.freeze({ keys: '{settings.open}', label: 'Settings' }),
  Object.freeze({ keys: 'Drag X / Y / Z', label: 'Scrub a number' }),
  Object.freeze({ keys: '{mesh.enter}', label: 'Edit the mesh / leave edit mode' }),
  Object.freeze({ keys: '{mesh.vertexMode} / {mesh.edgeMode} / {mesh.faceMode}', label: 'In edit mode: select vertices / edges / faces' }),
  Object.freeze({ keys: '{mesh.separate}', label: 'In edit mode: separate the picked faces into their own object' }),
  Object.freeze({ keys: '{mesh.makeFace}', label: 'In edit mode: make a face or edge from the selection' }),
  Object.freeze({ keys: '{mesh.deleteMenu} / {mesh.mergeMenu}', label: 'In edit mode: dissolve menu / merge menu' }),
  Object.freeze({ keys: '{mesh.selectNone} / {mesh.invertSelection} / {mesh.circleSelect} / {mesh.boxSelect}', label: 'In edit mode: select none / invert / circle select / box select' }),
  Object.freeze({ keys: '{mesh.growSelection} / {mesh.shrinkSelection}', label: 'In edit mode: grow / shrink the selection' }),
  Object.freeze({ keys: '{mesh.selectLinked} / {mesh.selectLinkedSelection}', label: 'In edit mode: select linked under the pointer / from the selection' }),
  Object.freeze({ keys: 'Alt + click / Ctrl + Alt + click', label: 'In edit mode: select a loop / a ring' }),
  Object.freeze({ keys: '{mesh.extrude} / {mesh.inset}', label: 'In edit mode: extrude / inset the picked faces; the pointer sets the amount, click or Enter confirms, Esc cancels' }),
  Object.freeze({ keys: '{mesh.proportional}', label: 'In edit mode: proportional editing on or off; the wheel sets its size while a move is held' }),
  Object.freeze({ keys: '{view.seeThrough}', label: 'See through the surface' }),
  Object.freeze({ keys: '{help.shortcuts}', label: 'This list' }),
]);

function describeBinding(value) {
  return JSON.stringify(value);
}

export function validateBinding(actionId, value) {
  const expected = 'pass { key: "g" } or { code: "KeyG" } with optional boolean ctrl, shift and alt';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Keymap binding for "${actionId}" is ${describeBinding(value)}: ${expected}.`);
  }
  for (const field of Object.keys(value)) {
    if (!BINDING_FIELDS.includes(field)) {
      throw new TypeError(`Keymap binding for "${actionId}" has an unknown field "${field}": ${expected}.`);
    }
  }
  const hasKey = typeof value.key === 'string' && value.key !== '';
  const hasCode = typeof value.code === 'string' && value.code !== '';
  if (hasKey === hasCode) {
    throw new TypeError(`Keymap binding for "${actionId}" needs exactly one of key and code as a non-empty string: ${expected}.`);
  }
  for (const flag of ['ctrl', 'shift', 'alt']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') {
      throw new TypeError(`Keymap binding for "${actionId}" has ${flag}: ${describeBinding(value[flag])}; ${flag} must be true or false.`);
    }
  }
  return Object.freeze({ ...value });
}

function shiftsOverlap(first, second) {
  return first === undefined || second === undefined || first === second;
}

export function bindingsOverlap(first, second) {
  return (first.key?.toLowerCase() ?? null) === (second.key?.toLowerCase() ?? null)
    && (first.code ?? null) === (second.code ?? null)
    && Boolean(first.ctrl) === Boolean(second.ctrl)
    && Boolean(first.alt) === Boolean(second.alt)
    && shiftsOverlap(first.shift, second.shift);
}

/** Every pair of actions of one context that a single key press would reach. Empty for a sound keymap. */
export function findKeymapConflicts(actions) {
  const conflicts = [];
  for (let firstIndex = 0; firstIndex < actions.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < actions.length; secondIndex += 1) {
      const first = actions[firstIndex];
      const second = actions[secondIndex];
      if (first.context !== second.context) continue;
      const overlaps = first.bindings.some(left => second.bindings.some(right => bindingsOverlap(left, right)));
      if (overlaps) conflicts.push([first.id, second.id]);
    }
  }
  return conflicts;
}

/**
 * The keymap in force: the defaults, with `overrides` (`{ actionId: binding }`, or an array of bindings for an action
 * with several keys) replacing the bindings of the actions it names.
 */
export function resolveKeymap(overrides = {}, { unbound = [], toolKeysGrab = true, mouse = [] } = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Keymap overrides must be an object of { actionId: binding }.');
  }
  const knownIds = new Set(DEFAULT_KEYMAP_ACTIONS.map(item => item.id));
  for (const actionId of Object.keys(overrides)) {
    if (!knownIds.has(actionId)) {
      throw new RangeError(`Unknown keymap action "${actionId}": pass one of ${[...knownIds].join(', ')}.`);
    }
  }
  for (const actionId of unbound) {
    if (!knownIds.has(actionId)) {
      throw new RangeError(`Unknown keymap action "${actionId}" in unbound: pass one of ${[...knownIds].join(', ')}.`);
    }
  }
  const actions = DEFAULT_KEYMAP_ACTIONS.map(item => {
    if (unbound.includes(item.id)) return Object.freeze({ ...item, bindings: Object.freeze([]) });
    if (!(item.id in overrides)) return item;
    const replacement = Array.isArray(overrides[item.id]) ? overrides[item.id] : [overrides[item.id]];
    if (replacement.length === 0) {
      throw new TypeError(`Keymap override for "${item.id}" is an empty list: pass at least one binding.`);
    }
    return Object.freeze({ ...item, bindings: Object.freeze(replacement.map(value => validateBinding(item.id, value))) });
  });
  const conflicts = findKeymapConflicts(actions);
  if (conflicts.length > 0) {
    const [first, second] = conflicts[0];
    throw new RangeError(`Keymap actions "${first}" and "${second}" share a key in the same context: give one of them another binding.`);
  }
  return Object.freeze({ actions: Object.freeze(actions), toolKeysGrab, mouse: Object.freeze(mouse.map(item => Object.freeze({ ...item }))) });
}

function bindingMatchesEvent(value, event) {
  const keyMatches = value.code === undefined
    ? typeof event.key === 'string' && event.key.toLowerCase() === value.key.toLowerCase()
    : event.code === value.code;
  if (!keyMatches) return false;
  if (Boolean(event.ctrlKey || event.metaKey) !== Boolean(value.ctrl)) return false;
  if (Boolean(event.altKey) !== Boolean(value.alt)) return false;
  return value.shift === undefined || Boolean(event.shiftKey) === value.shift;
}

/** The action a key event triggers in a context, with the binding that matched, or null. */
export function findKeymapAction(keymap, event, context = 'normal') {
  for (const item of keymap.actions) {
    if (item.context !== context) continue;
    const matched = item.bindings.find(value => bindingMatchesEvent(value, event));
    if (matched) return { actionId: item.id, binding: matched };
  }
  return null;
}

const NUMPAD_SYMBOL_LABELS = Object.freeze({
  NumpadAdd: 'Numpad +',
  NumpadSubtract: 'Numpad -',
  NumpadDecimal: 'Numpad .',
  NumpadMultiply: 'Numpad *',
  NumpadDivide: 'Numpad /',
  NumpadEnter: 'Numpad Enter',
});

function formatKeyName(value) {
  if (value.code !== undefined) {
    if (NUMPAD_SYMBOL_LABELS[value.code]) return NUMPAD_SYMBOL_LABELS[value.code];
    const numpadDigit = /^Numpad(\d)$/.exec(value.code);
    if (numpadDigit) return `Numpad ${numpadDigit[1]}`;
    return value.code.replace(/^(Key|Digit)/, '');
  }
  if (value.key === ' ') return 'Space';
  if (value.key === 'Escape') return 'Esc';
  return value.key.length === 1 ? value.key.toUpperCase() : value.key;
}

/** The label menus show for a binding, such as "Ctrl+Shift+Z". */
export function formatBinding(value) {
  const parts = [];
  if (value.ctrl) parts.push('Ctrl');
  if (value.shift) parts.push('Shift');
  if (value.alt) parts.push('Alt');
  parts.push(formatKeyName(value));
  return parts.join('+');
}

function findAction(keymap, actionId) {
  const found = keymap.actions.find(item => item.id === actionId);
  if (!found) {
    throw new RangeError(`Unknown keymap action "${actionId}": pass one of ${keymap.actions.map(item => item.id).join(', ')}.`);
  }
  return found;
}

/** The label of one binding of an action: the first by default, `bindingIndex` 1 for the second key. */
export function keyLabel(keymap, actionId, bindingIndex = 0) {
  const found = findAction(keymap, actionId);
  const value = found.bindings[bindingIndex];
  return value ? formatBinding(value) : '';
}

/** The text of a shortcuts dialog row's keys, with its `{action}` and `{action#1}` placeholders filled in. */
export function formatShortcutKeys(keymap, template) {
  const filled = template.replace(/\{([\w.]+)(?:#(\d+))?\}/g, (_match, actionId, bindingIndex) => keyLabel(keymap, actionId, Number(bindingIndex ?? 0)));
  // An action a preset leaves with one key has no second label: its slot leaves the row instead of showing "F / ".
  return filled.split(' / ').filter(part => part.trim() !== '').join(' / ');
}

/** The last binding of an action, the key a tooltip names when an action has a long and a short one. */
export function lastKeyLabel(keymap, actionId) {
  const { bindings } = findAction(keymap, actionId);
  const value = bindings[bindings.length - 1];
  return value ? formatBinding(value) : '';
}

// Alt with a mouse button drives the camera in Maya and in Cinema 4D alike: left orbits, middle pans, right zooms.
const ALT_MOUSE_NAVIGATION = Object.freeze([
  Object.freeze({ button: 0, alt: true, mode: 'orbit' }),
  Object.freeze({ button: 1, alt: true, mode: 'pan' }),
  Object.freeze({ button: 2, alt: true, mode: 'zoom' }),
]);

// Maya: Autodesk, "All Maya Hotkeys", https://help.autodesk.com/cloudhelp/2025/ENU/Maya-KeyboardShortcuts/files/GUID-30CACC9D-8FBE-4B85-8A8F-C5ADF32DDD4E.htm
// Only keys that page lists are set. Delete is not on it, so Delete and Backspace stay and X goes (Maya's X is a snap key).
// The page's "Show Last Hidden" is Ctrl+Shift+H; Studio's action shows everything.
const MAYA_BINDINGS = Object.freeze({
  'tool.select': binding('q'),
  'tool.translate': binding('w'),
  'tool.rotate': binding('e'),
  'tool.scale': binding('r'),
  'snap.toggle': binding('j'),
  'edit.duplicate': binding('d', { ctrl: true }),
  'edit.delete': [binding('Delete'), binding('Backspace')],
  'edit.undo': binding('z', { ctrl: true, shift: false }),
  'edit.redo': [binding('y', { ctrl: true }), binding('z', { ctrl: true, shift: true })],
  'edit.hide': binding('h', { ctrl: true, shift: false }),
  'edit.showAll': binding('h', { ctrl: true, shift: true }),
  'view.frame': binding('f'),
  'view.properties': binding('a', { ctrl: true }),
  // Ctrl+A is taken by view.properties in this preset, so Apply takes the nearest free key.
  'edit.apply': binding('a', { ctrl: true, alt: true }),
  'animate.keyframe': binding('s'),
  'animate.play': binding('v', { alt: true }),
  'modal.translate': binding('w'),
  'modal.rotate': binding('e'),
  'modal.scale': binding('r'),
});

// Cinema 4D: Maxon, "Keyboard Shortcuts", https://help.maxon.net/c4d/en-us/Content/html/Shortcuts.html
// Only keys that page lists are set. Frame has two: O (object) and S (elements), so S must say Shift is up, or it would
// also be Shift+S, the snapping key.
const CINEMA_4D_BINDINGS = Object.freeze({
  'tool.select': binding('9'),
  'tool.translate': binding('e'),
  'tool.rotate': binding('r'),
  'tool.scale': binding('t'),
  'snap.toggle': binding('s', { shift: true }),
  'edit.delete': [binding('Backspace'), binding('Delete')],
  'edit.deselect': [binding('a', { ctrl: true, shift: true }), binding('Escape')],
  'view.frame': [binding('o'), binding('s', { shift: false })],
  'view.properties': binding('F5', { shift: true }),
  'animate.keyframe': binding('F9'),
  'animate.play': binding('F8'),
  'modal.translate': binding('e'),
  'modal.rotate': binding('r'),
  'modal.scale': binding('t'),
});

/**
 * The keymaps a person can pick. `crucible` is the default, the keys of Blender. In `maya` and `cinema4d` a tool key only
 * selects the tool (`toolKeysGrab` false), because those programs show handles to drag instead of picking the object up.
 * `mouse` is extra camera navigation on top of the drag, middle drag and wheel that every preset keeps.
 */
export const KEYMAP_PRESETS = Object.freeze({
  crucible: Object.freeze({ label: 'Blender', bindings: Object.freeze({}), toolKeysGrab: true, mouse: Object.freeze([]) }),
  maya: Object.freeze({ label: 'Maya', bindings: MAYA_BINDINGS, toolKeysGrab: false, mouse: ALT_MOUSE_NAVIGATION }),
  cinema4d: Object.freeze({ label: 'Cinema 4D', bindings: CINEMA_4D_BINDINGS, toolKeysGrab: false, mouse: ALT_MOUSE_NAVIGATION }),
});

export const KEYMAP_PRESET_IDS = Object.freeze(Object.keys(KEYMAP_PRESETS));

/**
 * The keymap of a preset, resolved over the defaults. `overrides` is what a person changed in that preset:
 * `{ actionId: binding | [bindings] | null }`, where null leaves the action without a key.
 */
export function resolveKeymapPreset(presetId, overrides = {}, { numberPad = false } = {}) {
  const preset = KEYMAP_PRESETS[presetId];
  if (!preset) {
    throw new RangeError(`Unknown keymap preset "${presetId}": pass one of ${KEYMAP_PRESET_IDS.join(', ')}.`);
  }
  const bindings = { ...preset.bindings };
  if (numberPad) {
    for (const [actionId, numpadBinding] of Object.entries(NUMPAD_VIEW_BINDINGS)) {
      if (!(actionId in bindings)) bindings[actionId] = numpadBinding;
    }
    if (!('view.frame' in bindings)) bindings['view.frame'] = NUMPAD_FRAME_BINDINGS;
  }
  const unbound = new Set(preset.unbound ?? []);
  for (const [actionId, replacement] of Object.entries(overrides)) {
    if (replacement === null) {
      delete bindings[actionId];
      unbound.add(actionId);
    } else {
      bindings[actionId] = replacement;
      unbound.delete(actionId);
    }
  }
  return resolveKeymap(bindings, { unbound: [...unbound], toolKeysGrab: preset.toolKeysGrab, mouse: preset.mouse });
}

/** The camera move a mouse press starts under this keymap ('orbit', 'pan' or 'zoom'), or null for the default drag. */
export function findMouseNavigation(keymap, event) {
  const matched = keymap.mouse.find(item => item.button === event.button && Boolean(item.alt) === Boolean(event.altKey));
  return matched ? matched.mode : null;
}

const MOUSE_ROW_WORDS = Object.freeze({ orbit: 'Orbit', pan: 'Pan', zoom: 'Zoom' });
const MOUSE_BUTTON_WORDS = Object.freeze(['left', 'middle', 'right']);

/** The rows of the shortcuts dialog for a keymap: a preset where tool keys only select a tool has no "holding" rows. */
export function shortcutRowsFor(keymap) {
  const rows = SHORTCUT_ROWS.flatMap(row => {
    if (keymap.toolKeysGrab) return [row];
    if (row.label.startsWith('While holding')) return [];
    if (row.label === 'Pick up to move / rotate / scale') return [Object.freeze({ ...row, label: 'Move / Rotate / Scale tool' })];
    return [row];
  });
  const mouseRows = keymap.mouse.map(item => Object.freeze({
    keys: `Alt + ${MOUSE_BUTTON_WORDS[item.button]} drag`,
    label: MOUSE_ROW_WORDS[item.mode],
  }));
  return Object.freeze([...rows, ...mouseRows]);
}
