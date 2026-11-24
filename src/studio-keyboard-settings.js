// Settings > Keyboard: every shortcut of the active preset by area, each key a button that records the next combination.
// The list reads the same groups as the Help sheet (studio-help.js) and writes only the per-preset overrides
// (studio-key-overrides.js), so tooltips, menus and the sheet follow through the one keymap lookup.
import { formatBinding } from './studio-keymap.js';
import { sheetLabelOf, shortcutSheetGroups } from './studio-help.js';
import { leadWithActionIcon } from './studio-icons.js';
import {
  bindingFromKeyEvent,
  browserReservedNote,
  findBindingHolders,
  withActionBindings,
  withoutActionOverride,
  withSwappedBindings,
} from './studio-key-overrides.js';

const NOT_SET_LABEL = 'Not set';

/**
 * Builds the section. `getKeymap()`, `getPresetId()` and `getOverrides()` read the keymap in force, its preset and that preset's
 * changes; `onOverridesChange(overrides)` stores new changes and Studio calls `refresh()` once they are in effect.
 * `presetRow` and `showSheetButton` are the existing preset choice and the button that opens the sheet.
 */
export function createKeyboardSection({ documentReference, createElement, createIcon, getKeymap, getPresetId, getOverrides, onOverridesChange, presetRow, showSheetButton }) {
  const state = { recordingId: null, note: null, pending: null, confirmingReset: false, query: '', focusActionId: null, rendering: false };

  const filterInput = createElement(documentReference, 'input', { type: 'search', placeholder: 'Find a shortcut', attributes: { 'aria-label': 'Filter shortcuts' } });
  filterInput.dataset.keyboardFilter = 'true';
  filterInput.addEventListener('input', () => {
    state.query = filterInput.value.trim().toLowerCase();
    render();
  });
  const toolButtons = createElement(documentReference, 'div', { className: 'crucible-studio-keyboard-actions' });
  const tools = createElement(documentReference, 'div', { className: 'crucible-studio-keyboard-tools' }, filterInput, toolButtons);
  const list = createElement(documentReference, 'div', { className: 'crucible-studio-keyboard-list' });
  const element = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-keyboard' },
    createElement(documentReference, 'div', { className: 'crucible-studio-keyboard-head' }, presetRow, tools),
    list,
  );

  function iconButton(label, iconName, className, onClick) {
    const button = createElement(documentReference, 'button', { type: 'button', className, attributes: { 'aria-label': label, title: label } }, createIcon(documentReference, iconName));
    button.addEventListener('click', onClick);
    return button;
  }

  function textButton(label, iconName, onClick, className = '') {
    const button = createElement(documentReference, 'button', { type: 'button', className, textContent: label });
    leadWithActionIcon(button, createIcon(documentReference, iconName), iconName);
    button.addEventListener('click', onClick);
    return button;
  }

  function commit(nextOverrides) {
    state.recordingId = null;
    state.pending = null;
    state.note = null;
    onOverridesChange(nextOverrides);
    render();
  }

  function stopRecording() {
    state.recordingId = null;
    state.pending = null;
    state.note = null;
    render();
  }

  function startRecording(actionId) {
    state.recordingId = actionId;
    state.pending = null;
    state.note = null;
    state.confirmingReset = false;
    state.focusActionId = actionId;
    render();
  }

  function recordKey(actionId, event) {
    if (event.repeat) return;
    const bare = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (bare && event.key === 'Escape') {
      state.focusActionId = actionId;
      stopRecording();
      return;
    }
    if (bare && (event.key === 'Backspace' || event.key === 'Delete')) {
      state.focusActionId = actionId;
      commit(withActionBindings(getPresetId(), getOverrides(), actionId, null));
      return;
    }
    const binding = bindingFromKeyEvent(event);
    if (!binding) return;
    const reserved = browserReservedNote(binding);
    if (reserved) {
      state.note = { actionId, text: reserved };
      state.focusActionId = actionId;
      render();
      return;
    }
    const holders = findBindingHolders(getKeymap(), actionId, binding);
    state.focusActionId = actionId;
    if (holders.length === 0) {
      commit(withActionBindings(getPresetId(), getOverrides(), actionId, [binding]));
      return;
    }
    state.recordingId = null;
    state.note = null;
    state.pending = { actionId, binding, holders };
    render();
  }

  function keysButton(row) {
    const recording = state.recordingId === row.actionId;
    const pending = state.pending?.actionId === row.actionId ? state.pending : null;
    const button = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-keyboard-keys' });
    button.dataset.keyAction = row.actionId;
    if (recording) {
      button.dataset.recording = 'true';
      button.append(createElement(documentReference, 'span', { className: 'crucible-studio-keyboard-dot' }), createElement(documentReference, 'span', { textContent: 'Press keys' }));
      button.setAttribute('aria-label', `${row.label}: press the new keys. Escape cancels, Backspace clears`);
      button.addEventListener('keydown', event => {
        event.preventDefault();
        event.stopPropagation();
        recordKey(row.actionId, event);
      });
      button.addEventListener('blur', () => {
        if (!state.rendering && state.recordingId === row.actionId) stopRecording();
      });
    } else {
      const text = pending ? formatBinding(pending.binding) : row.keys || NOT_SET_LABEL;
      button.textContent = text;
      if (!row.keys && !pending) button.dataset.empty = 'true';
      if (pending) button.dataset.pending = 'true';
      button.setAttribute('aria-label', `${row.label}: ${text}. Change`);
    }
    button.addEventListener('click', () => (recording ? stopRecording() : startRecording(row.actionId)));
    return button;
  }

  function noteLine(iconName, text, ...buttons) {
    const note = createElement(documentReference, 'div', { className: 'crucible-studio-keyboard-note', attributes: { role: 'status' } }, createIcon(documentReference, iconName), createElement(documentReference, 'span', { textContent: text }));
    if (buttons.length > 0) note.append(createElement(documentReference, 'div', { className: 'crucible-studio-keyboard-note-actions' }, ...buttons));
    return note;
  }

  function clashNote(pending) {
    const keymap = getKeymap();
    const names = pending.holders.map(holder => sheetLabelOf(keymap, holder));
    return noteLine(
      'warning',
      `Used by ${names.join(', ')}`,
      textButton('Swap', 'check', () => commit(withSwappedBindings(getPresetId(), getOverrides(), keymap, pending.actionId, pending.binding, pending.holders))),
      textButton('Cancel', 'close', stopRecording),
    );
  }

  function actionRow(row) {
    const changed = row.actionId in getOverrides();
    const pending = state.pending?.actionId === row.actionId ? state.pending : null;
    const note = state.note?.actionId === row.actionId ? state.note : null;
    const controls = createElement(documentReference, 'div', { className: 'crucible-studio-keyboard-controls' });
    if (changed) {
      controls.append(iconButton(`Reset ${row.label} to the preset`, 'reset', 'crucible-studio-keyboard-reset', () => {
        state.focusActionId = row.actionId;
        commit(withoutActionOverride(getOverrides(), row.actionId));
      }));
    }
    controls.append(keysButton(row));
    const name = createElement(documentReference, 'span', { className: 'crucible-studio-keyboard-name' }, createElement(documentReference, 'span', { textContent: row.label }));
    if (changed) name.prepend(createElement(documentReference, 'span', { className: 'crucible-studio-keyboard-changed', attributes: { title: 'Changed from the preset' } }));
    const item = createElement(documentReference, 'div', { className: 'crucible-studio-keyboard-row' }, name, controls);
    item.dataset.action = row.actionId;
    item.dataset.changed = String(changed);
    if (pending) item.append(clashNote(pending));
    else if (note) item.append(noteLine('warning', note.text));
    return item;
  }

  function mouseRow(row) {
    return createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-keyboard-row' },
      createElement(documentReference, 'span', { className: 'crucible-studio-keyboard-name' }, createElement(documentReference, 'span', { textContent: row.label })),
      createElement(documentReference, 'div', { className: 'crucible-studio-keyboard-controls' }, createElement(documentReference, 'span', { className: 'crucible-studio-keyboard-fixed', textContent: row.keys })),
    );
  }

  function renderTools() {
    toolButtons.replaceChildren();
    if (state.confirmingReset) {
      toolButtons.append(
        textButton('Reset keys', 'reset', () => {
          state.confirmingReset = false;
          commit({});
        }, 'crucible-studio-keyboard-confirm'),
        textButton('Keep', 'close', () => {
          state.confirmingReset = false;
          renderTools();
        }),
      );
      return;
    }
    const resetAll = textButton('Reset all', 'reset', () => {
      state.confirmingReset = true;
      renderTools();
    });
    resetAll.disabled = Object.keys(getOverrides()).length === 0;
    toolButtons.append(showSheetButton, resetAll);
  }

  function render() {
    state.rendering = true;
    const scrollTop = list.scrollTop;
    renderTools();
    list.replaceChildren();
    const groups = shortcutSheetGroups(getKeymap(), { includeUnbound: true });
    let shown = 0;
    for (const group of groups) {
      const rows = group.rows.filter(row => state.query === '' || row.label.toLowerCase().includes(state.query));
      if (rows.length === 0) continue;
      shown += rows.length;
      list.append(createElement(
        documentReference,
        'section',
        { className: 'crucible-studio-keyboard-group' },
        createElement(documentReference, 'h4', {}, createIcon(documentReference, group.icon), createElement(documentReference, 'span', { textContent: group.title })),
        createElement(documentReference, 'div', { className: 'crucible-studio-keyboard-rows' }, ...rows.map(row => (row.actionId ? actionRow(row) : mouseRow(row)))),
      ));
    }
    if (shown === 0) list.append(noteLine('search', 'No shortcut has that name'));
    list.scrollTop = scrollTop;
    if (state.focusActionId) {
      const target = list.querySelector(`[data-key-action="${state.focusActionId}"]`);
      state.focusActionId = null;
      target?.focus?.({ preventScroll: true });
      target?.closest?.('.crucible-studio-keyboard-row')?.scrollIntoView?.({ block: 'nearest' });
    }
    state.rendering = false;
  }

  return {
    element,
    refresh: render,
    stopRecording,
  };
}