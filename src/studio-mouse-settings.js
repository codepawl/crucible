// Settings > Keyboard, mouse rows: each press of the mouse map as a button that records the next mouse press, in the look and
// the flow of a key row. The row keeps its gesture (click or drag); only the button and the held keys change.
import {
  describeMouseAction,
  describeRefusedMousePress,
  findMouseRowHolders,
  formatMousePress,
  pressFromPointerEvent,
  withMousePress,
  withoutMouseOverride,
  withSwappedMousePresses,
} from './studio-mouse-map.js';

const MOUSE_BUTTON_COUNT = 5;

/**
 * `getMouseMap()` reads the rows in force, `getOverrides()` the changes and `onOverridesChange(overrides)` stores new ones.
 * `requestRender()` redraws the list. The key section lends its pieces: `noteLine`, `textButton`, `iconButton` and `cancelHint`;
 * `onRecordingStart()` lets it drop its own recording. Returns `row(sheetRow)`, which builds one row, and `cancelRecording()`,
 * which ends a recording without a redraw.
 */
export function createMouseRows({ documentReference, createElement, getMouseMap, getOverrides, onOverridesChange, requestRender, noteLine, textButton, iconButton, cancelHint, onRecordingStart }) {
  const state = { recordingRowId: null, pending: null, note: null, spaceHeld: false, focusRowId: null, rendering: false };
  let swallowNextContextMenu = false;

  function cancelRecording() {
    state.recordingRowId = null;
    state.pending = null;
    state.note = null;
    state.spaceHeld = false;
  }

  function stopRecording() {
    cancelRecording();
    requestRender();
  }

  function commit(nextOverrides) {
    cancelRecording();
    onOverridesChange(nextOverrides);
    requestRender();
  }

  function startRecording(rowId) {
    onRecordingStart();
    cancelRecording();
    state.recordingRowId = rowId;
    state.focusRowId = rowId;
    requestRender();
  }

  function recordPress(row, event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.button >= MOUSE_BUTTON_COUNT) return;
    swallowNextContextMenu = event.button === 2;
    const press = pressFromPointerEvent(event, state.spaceHeld);
    state.focusRowId = row.id;
    const refusal = describeRefusedMousePress({ ...row, ...press });
    if (refusal) {
      state.note = { rowId: row.id, text: refusal };
      requestRender();
      return;
    }
    const holders = findMouseRowHolders(getMouseMap(), row.id, press);
    if (holders.length === 0) {
      commit(withMousePress(getOverrides(), row.id, press));
      return;
    }
    state.recordingRowId = null;
    state.note = null;
    state.pending = { rowId: row.id, press, holders };
    requestRender();
  }

  function listenForPress(button, row) {
    button.addEventListener('pointerdown', event => recordPress(row, event));
    for (const eventName of ['mousedown', 'mouseup', 'auxclick', 'contextmenu']) {
      button.addEventListener(eventName, event => {
        event.preventDefault();
        event.stopPropagation();
      });
    }
    button.addEventListener('keydown', event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.key === ' ') state.spaceHeld = true;
      else if (event.key === 'Escape') {
        state.focusRowId = row.id;
        stopRecording();
      }
    });
    button.addEventListener('keyup', event => {
      event.preventDefault();
      if (event.key === ' ') state.spaceHeld = false;
    });
    button.addEventListener('blur', () => {
      if (!state.rendering && state.recordingRowId === row.id) stopRecording();
    });
  }

  function pressButton(row, text) {
    const recording = state.recordingRowId === row.id;
    const pending = state.pending?.rowId === row.id ? state.pending : null;
    const button = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-mouse-press' });
    button.dataset.mouseRow = row.id;
    if (recording) {
      button.dataset.recording = 'true';
      button.append(createElement(documentReference, 'span', { className: 'crucible-studio-keyboard-dot' }), createElement(documentReference, 'span', { textContent: 'Press a button' }));
      button.setAttribute('aria-label', `${describeMouseAction(row.action)}: press the new mouse button, with any of Shift, Alt, Ctrl or Space held. Escape cancels`);
      listenForPress(button, row);
    } else {
      const shown = pending ? formatMousePress({ ...row, ...pending.press }) : text;
      button.textContent = shown;
      if (pending) button.dataset.pending = 'true';
      button.setAttribute('aria-label', `${describeMouseAction(row.action)}: ${shown}. Change`);
    }
    button.addEventListener('click', () => (recording ? stopRecording() : startRecording(row.id)));
    return button;
  }

  function clashNote(pending, mouseMap) {
    const names = pending.holders.map(holder => describeMouseAction(mouseMap.find(row => row.id === holder.id).action));
    return noteLine(
      'warning',
      `Used by ${names.join(', ')}`,
      textButton('Swap', 'check', () => commit(withSwappedMousePresses(mouseMap, getOverrides(), pending.rowId, pending.press, pending.holders))),
      textButton('Cancel', 'close', stopRecording),
    );
  }

  /** The row for one entry of the sheet that carries a `mouseRowId`. */
  function row({ label, keys, mouseRowId }) {
    const mouseMap = getMouseMap();
    const mapRow = mouseMap.find(candidate => candidate.id === mouseRowId);
    const changed = mouseRowId in getOverrides();
    const pending = state.pending?.rowId === mouseRowId ? state.pending : null;
    const note = state.note?.rowId === mouseRowId ? state.note : null;
    const controls = createElement(documentReference, 'div', { className: 'crucible-studio-keyboard-controls' });
    if (changed) {
      controls.append(iconButton(`Reset ${label} to the default`, 'reset', 'crucible-studio-keyboard-reset', () => {
        state.focusRowId = mouseRowId;
        commit(withoutMouseOverride(getOverrides(), mouseRowId));
      }));
    }
    if (state.recordingRowId === mouseRowId) controls.append(cancelHint());
    controls.append(pressButton(mapRow, keys));
    const name = createElement(documentReference, 'span', { className: 'crucible-studio-keyboard-name' }, createElement(documentReference, 'span', { textContent: label }));
    if (changed) name.prepend(createElement(documentReference, 'span', { className: 'crucible-studio-keyboard-changed', attributes: { title: 'Changed from the default' } }));
    const item = createElement(documentReference, 'div', { className: 'crucible-studio-mouse-row' }, name, controls);
    item.dataset.mouseRow = mouseRowId;
    item.dataset.changed = String(changed);
    if (pending || note) item.dataset.noted = 'true';
    if (pending) item.append(clashNote(pending, mouseMap));
    else if (note) item.append(noteLine('warning', note.text));
    item.addEventListener('contextmenu', event => {
      if (!swallowNextContextMenu) return;
      swallowNextContextMenu = false;
      event.preventDefault();
    });
    return item;
  }

  // The list redraws its buttons between these two calls; the blur that removing the recording button causes is not a stop.
  function beginRender() {
    state.rendering = true;
  }

  // Puts the focus back on the button of the row that was acted on.
  function endRender(list) {
    state.rendering = false;
    const rowId = state.focusRowId;
    state.focusRowId = null;
    if (!rowId) return;
    const target = list.querySelector(`.crucible-studio-mouse-press[data-mouse-row="${rowId}"]`);
    target?.focus?.({ preventScroll: true });
    target?.closest?.('.crucible-studio-mouse-row')?.scrollIntoView?.({ block: 'nearest' });
  }

  return { row, cancelRecording, beginRender, endRender };
}
