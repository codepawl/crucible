// Every keyboard shortcut of Studio in one table. studio.js dispatches key events through it and takes each key label
// (menus, tooltips, the shortcuts dialog, the hint bar) from it, so a keymap preset swaps bindings and nothing else.
//
// A binding is `{ key | code, ctrl?, shift?, alt? }`. `ctrl` means Ctrl or Command. A modifier left out must be up,
// except `shift`: left out it is not looked at, because plain keys such as H or ? also work with Shift held.

export const KEYMAP_CONTEXTS = Object.freeze(['normal', 'modal']);

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
  action('tool.snap', 'Snap to a surface', 'Tools', 'normal', binding('t')),
  action('add.open', 'Add an object or a light', 'Tools', 'normal', binding('a', { shift: true })),
  action('edit.copy', 'Copy', 'Edit', 'normal', binding('c', { ctrl: true, shift: false })),
  action('edit.paste', 'Paste', 'Edit', 'normal', binding('v', { ctrl: true, shift: false })),
  action('edit.duplicate', 'Duplicate', 'Edit', 'normal', binding('d', { shift: true }), binding('d', { ctrl: true })),
  action('edit.delete', 'Delete', 'Edit', 'normal', binding('x'), binding('Delete'), binding('Backspace')),
  action('edit.deselect', 'Deselect', 'Edit', 'normal', binding('Escape')),
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
  action('animate.keyframe', 'Insert a keyframe', 'Animate', 'normal', binding('i'), binding('k')),
  action('animate.play', 'Play', 'Animate', 'normal', binding(' ')),
  action('file.open', 'Open', 'File', 'normal', binding('o', { ctrl: true })),
  action('file.save', 'Save', 'File', 'normal', binding('s', { ctrl: true, shift: false })),
  action('file.saveAs', 'Save as', 'File', 'normal', binding('s', { ctrl: true, shift: true })),
  action('settings.open', 'Settings', 'File', 'normal', binding(',', { ctrl: true })),
  action('help.shortcuts', 'Keyboard shortcuts', 'Help', 'normal', binding('?')),
  action('modal.place', 'Place', 'Holding an object', 'modal', binding('Enter'), binding(' ')),
  action('modal.cancel', 'Put back', 'Holding an object', 'modal', binding('Escape')),
  action('modal.axisX', 'Keep to the X axis', 'Holding an object', 'modal', binding('x')),
  action('modal.axisY', 'Keep to the Y axis', 'Holding an object', 'modal', binding('y')),
  action('modal.axisZ', 'Keep to the Z axis', 'Holding an object', 'modal', binding('z')),
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
  Object.freeze({ keys: 'Click or {modal.place} / {modal.cancel}', label: 'While holding: place / put back' }),
  Object.freeze({ keys: '{tool.snap}', label: 'Snap to a surface' }),
  Object.freeze({ keys: 'Shift + drag', label: 'Snap to a step or an angle' }),
  Object.freeze({ keys: '{add.open}', label: 'Add an object or a light' }),
  Object.freeze({ keys: '{edit.copy} / {edit.paste}', label: 'Copy / Paste' }),
  Object.freeze({ keys: '{edit.duplicate} / {edit.duplicate#1}', label: 'Duplicate' }),
  Object.freeze({ keys: '{edit.delete} / {edit.delete#1}', label: 'Delete' }),
  Object.freeze({ keys: '{edit.deselect}', label: 'Deselect' }),
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
  Object.freeze({ keys: '{help.shortcuts}', label: 'This list' }),
]);

function describeBinding(value) {
  return JSON.stringify(value);
}

function validateBinding(actionId, value) {
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

function bindingsOverlap(first, second) {
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
export function resolveKeymap(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Keymap overrides must be an object of { actionId: binding }.');
  }
  const knownIds = new Set(DEFAULT_KEYMAP_ACTIONS.map(item => item.id));
  for (const actionId of Object.keys(overrides)) {
    if (!knownIds.has(actionId)) {
      throw new RangeError(`Unknown keymap action "${actionId}": pass one of ${[...knownIds].join(', ')}.`);
    }
  }
  const actions = DEFAULT_KEYMAP_ACTIONS.map(item => {
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
  return Object.freeze({ actions: Object.freeze(actions) });
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

function formatKeyName(value) {
  if (value.code !== undefined) return value.code.replace(/^(Key|Digit)/, '');
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
  return template.replace(/\{([\w.]+)(?:#(\d+))?\}/g, (_match, actionId, bindingIndex) => keyLabel(keymap, actionId, Number(bindingIndex ?? 0)));
}
