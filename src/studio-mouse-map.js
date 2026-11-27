// What each mouse press does in the Studio viewport, as a table of rows a person can change. Everything here is a pure
// function over plain objects, so the pointer handler, the Settings section and the tests share one set of rules.
// Overrides keep the shape of the key overrides: `{ rowId: { button, modifiers } | null }`, where null leaves the row unbound.

export const MOUSE_BUTTON_NAMES = Object.freeze(['left', 'middle', 'right', 'back', 'forward']);
export const MOUSE_MODIFIER_NAMES = Object.freeze(['shift', 'alt', 'ctrl', 'space']);
export const MOUSE_GESTURES = Object.freeze(['click', 'drag']);
export const MOUSE_ACTION_IDS = Object.freeze(['view.orbit', 'view.pan', 'view.setPivot', 'edit.undo', 'edit.redo']);

const MOUSE_ACTION_LABELS = Object.freeze({
  'view.orbit': 'Orbit',
  'view.pan': 'Pan',
  'view.setPivot': 'Orbit around the point under the pointer',
  'edit.undo': 'Undo',
  'edit.redo': 'Redo',
});

function mouseRow(id, button, modifierNames, gesture, action) {
  const modifiers = Object.fromEntries(modifierNames.map(name => [name, true]));
  return Object.freeze({ id, button, modifiers: Object.freeze(modifiers), gesture, action });
}

export const DEFAULT_MOUSE_MAP = Object.freeze([
  mouseRow('orbit.left', 0, [], 'drag', 'view.orbit'),
  mouseRow('pan.shiftLeft', 0, ['shift'], 'drag', 'view.pan'),
  mouseRow('pan.right', 2, [], 'drag', 'view.pan'),
  mouseRow('pan.middle', 1, [], 'drag', 'view.pan'),
  mouseRow('pan.spaceLeft', 0, ['space'], 'drag', 'view.pan'),
  mouseRow('pivot.middle', 1, [], 'click', 'view.setPivot'),
  mouseRow('pivot.altRight', 2, ['alt'], 'click', 'view.setPivot'),
  mouseRow('undo.back', 3, [], 'click', 'edit.undo'),
  mouseRow('redo.forward', 4, [], 'click', 'edit.redo'),
]);

function heldModifierNames(modifiers) {
  return MOUSE_MODIFIER_NAMES.filter(name => modifiers?.[name] === true);
}

/**
 * Checks one row and returns it with the modifiers reduced to the ones that are held. Throws a RangeError or TypeError
 * that names what failed and what to pass.
 */
export function validateMouseRow(row) {
  if (row === null || typeof row !== 'object') {
    throw new TypeError(`Mouse row must be an object with id, button, modifiers, gesture and action; got ${typeof row}.`);
  }
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new TypeError('Mouse row id must be a non-empty string such as "pan.middle".');
  }
  if (!Number.isInteger(row.button) || row.button < 0 || row.button >= MOUSE_BUTTON_NAMES.length) {
    throw new RangeError(`Mouse row "${row.id}" has button ${String(row.button)}: pass 0 to ${MOUSE_BUTTON_NAMES.length - 1} (${MOUSE_BUTTON_NAMES.join(', ')}).`);
  }
  if (row.modifiers === null || typeof row.modifiers !== 'object' || Array.isArray(row.modifiers)) {
    throw new TypeError(`Mouse row "${row.id}" needs modifiers as an object such as { shift: true }; pass {} for none.`);
  }
  for (const [name, value] of Object.entries(row.modifiers)) {
    if (!MOUSE_MODIFIER_NAMES.includes(name)) {
      throw new RangeError(`Mouse row "${row.id}" has modifier "${name}": pass any of ${MOUSE_MODIFIER_NAMES.join(', ')}.`);
    }
    if (typeof value !== 'boolean') {
      throw new TypeError(`Mouse row "${row.id}" modifier "${name}" must be true or false; got ${typeof value}.`);
    }
  }
  if (!MOUSE_GESTURES.includes(row.gesture)) {
    throw new RangeError(`Mouse row "${row.id}" has gesture "${String(row.gesture)}": pass ${MOUSE_GESTURES.join(' or ')}.`);
  }
  if (!MOUSE_ACTION_IDS.includes(row.action)) {
    throw new RangeError(`Mouse row "${row.id}" has action "${String(row.action)}": pass one of ${MOUSE_ACTION_IDS.join(', ')}.`);
  }
  const modifiers = Object.fromEntries(heldModifierNames(row.modifiers).map(name => [name, true]));
  return Object.freeze({ id: row.id, button: row.button, modifiers: Object.freeze(modifiers), gesture: row.gesture, action: row.action });
}

/**
 * The action a press starts: among the rows of the same button and gesture whose modifiers are all held, the one with the
 * most modifiers wins (Shift + left drag pans where a plain left drag orbits). Returns the action id, or null.
 */
export function findMouseAction(map, { button, shiftKey = false, altKey = false, ctrlKey = false, spaceHeld = false, gesture }) {
  const held = { shift: Boolean(shiftKey), alt: Boolean(altKey), ctrl: Boolean(ctrlKey), space: Boolean(spaceHeld) };
  let best = null;
  let bestModifierCount = -1;
  for (const row of map) {
    if (row.button !== button || row.gesture !== gesture) continue;
    const required = heldModifierNames(row.modifiers);
    if (!required.every(name => held[name])) continue;
    if (required.length > bestModifierCount) {
      best = row;
      bestModifierCount = required.length;
    }
  }
  return best ? best.action : null;
}

function pressKey(row) {
  return `${row.gesture}:${row.button}:${heldModifierNames(row.modifiers).join('+')}`;
}

/** The groups of rows that share a press, as lists of row ids. Two rows on one press cannot both run. */
export function findMouseMapConflicts(map) {
  const idsByPress = new Map();
  for (const row of map) {
    const key = pressKey(row);
    idsByPress.set(key, [...(idsByPress.get(key) ?? []), row.id]);
  }
  return [...idsByPress.values()].filter(ids => ids.length > 1);
}

/**
 * The map with a person's changes applied. `overrides` is `{ rowId: { button, modifiers } | null }`; a row keeps its gesture
 * and action, and null leaves it unbound. Returns `{ map, unbound, conflicts }`: the rows in force, the ids left without a
 * press, and the groups of row ids that now share one press (reported, not thrown, so Settings can show them).
 */
export function applyMouseOverrides(map, overrides = {}) {
  const knownIds = map.map(row => row.id);
  for (const rowId of Object.keys(overrides)) {
    if (!knownIds.includes(rowId)) {
      throw new RangeError(`Unknown mouse row "${rowId}": pass one of ${knownIds.join(', ')}.`);
    }
  }
  const unbound = [];
  const rows = [];
  for (const row of map) {
    const override = overrides[row.id];
    if (override === null) {
      unbound.push(row.id);
    } else if (override === undefined) {
      rows.push(validateMouseRow(row));
    } else {
      rows.push(validateMouseRow({ ...row, button: override.button, modifiers: override.modifiers }));
    }
  }
  return { map: Object.freeze(rows), unbound, conflicts: findMouseMapConflicts(rows) };
}

const MODIFIER_WORDS = Object.freeze({ shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl', space: 'Space' });

/** The words for a row's press, such as "Shift + left drag" or "Back button click". */
export function formatMousePress(row) {
  const buttonName = MOUSE_BUTTON_NAMES[row.button];
  const buttonWords = row.button >= 3 ? `${buttonName} button` : buttonName;
  const modifierWords = heldModifierNames(row.modifiers).map(name => MODIFIER_WORDS[name]);
  const press = `${buttonWords} ${row.gesture}`;
  if (modifierWords.length === 0) return `${press[0].toUpperCase()}${press.slice(1)}`;
  return `${modifierWords.join(' + ')} + ${press}`;
}

export function describeMouseAction(actionId) {
  return MOUSE_ACTION_LABELS[actionId] ?? actionId;
}
