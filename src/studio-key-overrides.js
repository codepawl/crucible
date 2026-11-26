// What a person changed in a keymap preset: `{ actionId: binding | [bindings] | null }`, kept per preset. Everything here is
// a pure function over those objects, so the Settings section, the preferences and the tests share one set of rules.
// The keymap itself stays the single lookup: `resolveKeymapPreset(presetId, overrides)` gives the keys in force.
import {
  bindingsOverlap,
  DEFAULT_KEYMAP_ACTIONS,
  formatBinding,
  KEYMAP_PRESET_IDS,
  resolveKeymapPreset,
  validateBinding,
} from './studio-keymap.js';

const MODIFIER_KEY_NAMES = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'CapsLock', 'NumLock', 'Fn', 'Hyper', 'Super']);
const KNOWN_ACTION_IDS = new Set(DEFAULT_KEYMAP_ACTIONS.map(item => item.id));
const FIELD_ORDER = Object.freeze(['key', 'code', 'ctrl', 'shift', 'alt']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalBinding(value) {
  const fields = {};
  for (const field of FIELD_ORDER) {
    if (value[field] === undefined) continue;
    if ((field === 'ctrl' || field === 'alt') && value[field] === false) continue;
    fields[field] = field === 'key' ? value.key.toLowerCase() : value[field];
  }
  return JSON.stringify(fields);
}

function sameBindings(first, second) {
  const left = first.map(canonicalBinding).sort();
  const right = second.map(canonicalBinding).sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * The binding a key press records, or null while only modifiers are down. A letter keeps its Shift state exactly; a symbol
 * such as "?" already carries its Shift in the character. With Alt the physical key is recorded, because Option on a Mac types
 * another letter.
 */
export function bindingFromKeyEvent(event) {
  if (typeof event.key !== 'string' || MODIFIER_KEY_NAMES.has(event.key)) return null;
  const modifiers = {};
  if (event.ctrlKey || event.metaKey) modifiers.ctrl = true;
  if (event.altKey) modifiers.alt = true;
  const physicalKey = (event.altKey && /^(Key|Digit)/.test(event.code ?? '')) || /^Numpad/.test(event.code ?? '');
  if (physicalKey) return { code: event.code, shift: Boolean(event.shiftKey), ...modifiers };
  const isSymbol = event.key.length === 1 && event.key.toLowerCase() === event.key.toUpperCase() && !/\d/.test(event.key) && event.key !== ' ';
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return isSymbol ? { key, ...modifiers } : { key, shift: Boolean(event.shiftKey), ...modifiers };
}

// Combinations a page never receives: the browser acts on them before any script sees the key.
function isBrowserReserved(value) {
  const key = (value.key ?? '').toLowerCase();
  if (value.ctrl && !value.alt) {
    if (['w', 't', 'n', 'tab', 'pageup', 'pagedown'].includes(key)) return true;
    if (/^[1-9]$/.test(key) && !value.shift) return true;
    if (key === 'q' && value.shift) return true;
  }
  if (!value.ctrl && !value.alt && key === 'f11') return true;
  return Boolean(value.alt) && !value.ctrl && key === 'f4';
}

/** A short note for a refused combination, or null when the page can receive it. */
export function browserReservedNote(value) {
  return isBrowserReserved(value) ? `${formatBinding(value)} belongs to the browser` : null;
}

/** The other actions of the same context that a press of `binding` would reach. */
export function findBindingHolders(keymap, actionId, binding) {
  const target = keymap.actions.find(item => item.id === actionId);
  if (!target) throw new RangeError(`Unknown keymap action "${actionId}": pass one of ${keymap.actions.map(item => item.id).join(', ')}.`);
  return keymap.actions.filter(item => item.id !== actionId && item.context === target.context && item.bindings.some(held => bindingsOverlap(held, binding)));
}

function presetBindingsOf(presetId, actionId, options) {
  return resolveKeymapPreset(presetId, {}, options).actions.find(item => item.id === actionId).bindings;
}

/** `overrides` with the action set to `bindings` (a list, or null for no key). A result equal to the preset's own keys removes the override. */
export function withActionBindings(presetId, overrides, actionId, bindings, options) {
  const next = { ...overrides };
  const presetBindings = presetBindingsOf(presetId, actionId, options);
  const equalsPreset = bindings === null ? presetBindings.length === 0 : sameBindings(bindings, presetBindings);
  if (equalsPreset) delete next[actionId];
  else if (bindings === null) next[actionId] = null;
  else next[actionId] = bindings.length === 1 ? { ...bindings[0] } : bindings.map(item => ({ ...item }));
  return next;
}

/** `overrides` without the action: it goes back to the preset's keys. */
export function withoutActionOverride(overrides, actionId) {
  const next = { ...overrides };
  delete next[actionId];
  return next;
}

/** The overrides of a swap: the action takes `binding`, and the first holder keeps its other keys and takes the action's old ones. */
export function withSwappedBindings(presetId, overrides, keymap, actionId, binding, holders, options) {
  const previous = keymap.actions.find(item => item.id === actionId).bindings;
  let next = withActionBindings(presetId, overrides, actionId, [binding], options);
  holders.forEach((holder, index) => {
    const kept = holder.bindings.filter(held => !bindingsOverlap(held, binding));
    const given = index === 0 ? [...kept, ...previous] : kept;
    next = withActionBindings(presetId, next, holder.id, given.length > 0 ? given : null, options);
  });
  return next;
}

function cleanReplacement(actionId, replacement) {
  if (replacement === null) return null;
  const list = Array.isArray(replacement) ? replacement : [replacement];
  if (list.length === 0) throw new TypeError(`Keymap override for "${actionId}" is an empty list.`);
  const validated = list.map(item => {
    const checked = validateBinding(actionId, item);
    if (isBrowserReserved(checked)) throw new RangeError(`Keymap override for "${actionId}" uses a key the browser keeps.`);
    return { ...checked };
  });
  return Array.isArray(replacement) ? validated : validated[0];
}

function cleanPresetOverrides(presetId, candidate, options) {
  const clean = {};
  if (!isPlainObject(candidate)) return clean;
  for (const [actionId, replacement] of Object.entries(candidate)) {
    if (!KNOWN_ACTION_IDS.has(actionId)) continue;
    try {
      clean[actionId] = cleanReplacement(actionId, replacement);
    } catch {
      // A malformed or refused entry is dropped; the rest of the preset's changes stay.
    }
  }
  try {
    resolveKeymapPreset(presetId, clean, options);
  } catch {
    // Entries that share a key cannot all hold: the preset goes back to its own keys.
    return {};
  }
  return clean;
}

/** The stored key changes that are sound, per preset. Unknown presets, unknown actions, malformed or refused bindings and clashes are dropped. */
export function normalizeKeyOverrides(value, options) {
  const result = {};
  if (!isPlainObject(value)) return result;
  for (const presetId of KEYMAP_PRESET_IDS) {
    const clean = cleanPresetOverrides(presetId, value[presetId], options);
    if (Object.keys(clean).length > 0) result[presetId] = clean;
  }
  return result;
}

/** `allOverrides` with one preset's changes replaced; an empty set removes the preset's entry. */
export function withPresetOverrides(allOverrides, presetId, presetOverrides) {
  const next = { ...allOverrides };
  if (Object.keys(presetOverrides).length === 0) delete next[presetId];
  else next[presetId] = presetOverrides;
  return next;
}