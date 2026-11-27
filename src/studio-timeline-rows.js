// The Animate timeline's property rows: one row per animated property of the selected object (position, rotation, scale),
// its keys as diamonds. A click selects a key, a drag along the row retimes it, and a small editor under the rows changes its
// time, value and easing or deletes it. Every change is one controller call, so it is one undo step and lands in the recipe.
import { EASING_NAMES } from './easing.js';
import { eulerDegreesToQuaternion, quaternionToEulerDegrees } from './studio-controller.js';
import { KEY_NUDGE_STEP, KEY_TIME_STEP, keyMarkerOffset, keyTimeFromPointer, snapKeyTime } from './studio-timeline-keys.js';

const ROW_TITLES = Object.freeze({ translation: 'Position', rotation: 'Rotation', scale: 'Scale' });
const AXIS_NAMES = Object.freeze(['X', 'Y', 'Z']);
const KEY_TIME_TOLERANCE = 0.005;
const DRAG_THRESHOLD_PIXELS = 3;
const NUDGE_DIRECTION_BY_KEY = Object.freeze({ ArrowLeft: -1, ArrowRight: 1 });
const LINEAR_EASING = 'linear';

function sameTime(first, second) {
  return Math.abs(first - second) < KEY_TIME_TOLERANCE;
}

/** The numbers an editor shows for a key value: rotation as degrees, the rest as they are. */
export function keyValueForEditor(property, value) {
  return property === 'rotation' ? quaternionToEulerDegrees(value) : value;
}

/** The key value a controller stores for editor numbers: the inverse of keyValueForEditor. */
export function keyValueFromEditor(property, numbers) {
  return property === 'rotation' ? eulerDegreesToQuaternion(numbers) : numbers;
}

export function createTimelineRows({ documentReference, createElement, createIcon, createIconButton, controller, announce, isDeleteKey }) {
  let selection = null;
  let shownSignature = '';
  let shownDuration = 4;
  let dragState = null;
  let suppressClick = false;
  let playheads = [];

  const rowsElement = createElement(documentReference, 'div', { className: 'crucible-studio-keyrows', attributes: { role: 'group', 'aria-label': 'Keys' } });
  const timeInput = createElement(documentReference, 'input', { type: 'number', step: String(KEY_TIME_STEP), min: '0', attributes: { 'aria-label': 'Key time in seconds' } });
  const valueInputs = AXIS_NAMES.map(axis => createElement(documentReference, 'input', { type: 'number', step: '0.05', attributes: { 'aria-label': `Key ${axis}` } }));
  const easingSelect = createElement(documentReference, 'select', { attributes: { 'aria-label': 'Key easing' } });
  const deleteButton = createIconButton('remove', 'Delete key', { className: 'crucible-studio-mini-btn' });
  const editorElement = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-keyeditor', hidden: true, attributes: { role: 'group', 'aria-label': 'Key' } },
    timeInput,
    ...valueInputs,
    easingSelect,
    deleteButton,
  );

  function selectedProperty() {
    return controller.nodePropertyKeys().find(entry => entry.property === selection?.property) ?? null;
  }

  function selectedKey() {
    return selectedProperty()?.keys.find(key => sameTime(key.time, selection.time)) ?? null;
  }

  function run(change) {
    try {
      change();
    } catch (error) {
      announce(error);
    }
  }

  function selectKey(property, time) {
    selection = { property, time };
    run(() => controller.setMotionTime(time));
    sync(shownDuration);
  }

  function retimeKey(nodeId, property, fromTime, toTime) {
    if (sameTime(fromTime, toTime)) {
      return;
    }
    run(() => {
      controller.updatePropertyKeyframe(nodeId, property, fromTime, { time: toTime });
      selection = { property, time: toTime };
      controller.setMotionTime(toTime);
    });
  }

  function deleteKey(nodeId, property, time) {
    run(() => {
      controller.deletePropertyKeyframe(nodeId, property, time);
      selection = null;
      announce(`Deleted the ${ROW_TITLES[property].toLowerCase()} key at ${time.toFixed(2)} s`);
    });
  }

  function finishDrag(commit) {
    const finished = dragState;
    if (!finished) {
      return;
    }
    dragState = null;
    documentReference.removeEventListener('keydown', cancelDragOnEscape, true);
    if (finished.moved) {
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      }, 0);
    }
    if (commit && finished.moved) {
      retimeKey(finished.nodeId, finished.property, finished.time, finished.previewTime);
    } else {
      finished.marker.style.insetInlineStart = keyMarkerOffset(finished.time, finished.duration);
    }
    sync(shownDuration, { force: finished.moved });
  }

  function cancelDragOnEscape(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finishDrag(false);
    }
  }

  function moveDrag(event) {
    if (!dragState || (!dragState.moved && Math.abs(event.clientX - dragState.startX) < DRAG_THRESHOLD_PIXELS)) {
      return;
    }
    dragState.moved = true;
    const lane = dragState.lane.getBoundingClientRect();
    const rawTime = keyTimeFromPointer({ clientX: event.clientX, left: lane.left, width: lane.width, duration: dragState.duration });
    dragState.previewTime = snapKeyTime(rawTime, dragState.duration);
    dragState.marker.style.insetInlineStart = keyMarkerOffset(dragState.previewTime, dragState.duration);
  }

  function handleKeydown(event, nodeId, property, time, duration) {
    const direction = NUDGE_DIRECTION_BY_KEY[event.key];
    if (direction !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      retimeKey(nodeId, property, time, snapKeyTime(time + direction * (event.shiftKey ? KEY_TIME_STEP : KEY_NUDGE_STEP), duration));
    } else if (isDeleteKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      deleteKey(nodeId, property, time);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation();
    }
  }

  function createKeyMarker({ nodeId, property, time, duration, lane }) {
    const label = `${ROW_TITLES[property]} key at ${time.toFixed(2)} s`;
    const marker = createElement(documentReference, 'button', {
      type: 'button',
      className: 'crucible-studio-lane-key',
      title: label,
      dataset: { property, time: String(time) },
      attributes: { 'aria-label': label, 'aria-pressed': selection?.property === property && sameTime(selection.time, time) ? 'true' : 'false' },
    }, createIcon(documentReference, 'keyframe'));
    marker.style.insetInlineStart = keyMarkerOffset(time, duration);
    marker.addEventListener('click', () => {
      if (!suppressClick) {
        selectKey(property, time);
      }
    });
    marker.addEventListener('keydown', event => handleKeydown(event, nodeId, property, time, duration));
    marker.addEventListener('pointerdown', event => {
      if (event.button !== 0) {
        return;
      }
      dragState = { marker, lane, nodeId, property, time, duration, startX: event.clientX, moved: false, previewTime: time };
      marker.setPointerCapture?.(event.pointerId);
      documentReference.addEventListener('keydown', cancelDragOnEscape, true);
    });
    marker.addEventListener('pointermove', moveDrag);
    marker.addEventListener('pointerup', () => finishDrag(true));
    marker.addEventListener('pointercancel', () => finishDrag(false));
    marker.addEventListener('lostpointercapture', () => finishDrag(false));
    return marker;
  }

  function createRow(nodeId, entry, duration) {
    const lane = createElement(documentReference, 'div', { className: 'crucible-studio-keylane' });
    const playhead = createElement(documentReference, 'span', { className: 'crucible-studio-keyplayhead', attributes: { 'aria-hidden': 'true' } });
    playheads.push(playhead);
    lane.append(playhead, ...entry.keys.map(key => createKeyMarker({ nodeId, property: entry.property, time: key.time, duration, lane })));
    return createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-keyrow', dataset: { property: entry.property } },
      createElement(documentReference, 'span', { className: 'crucible-studio-keyrow-title', textContent: ROW_TITLES[entry.property] }),
      lane,
    );
  }

  function placePlayheads(duration) {
    for (const playhead of playheads) {
      playhead.style.insetInlineStart = keyMarkerOffset(controller.motionTime, duration);
    }
  }

  function easingOptionsFor(currentEasing) {
    const names = [LINEAR_EASING, ...EASING_NAMES.filter(name => name !== LINEAR_EASING)];
    if (!names.includes(currentEasing)) {
      names.push(currentEasing);
    }
    return names.map(name => createElement(documentReference, 'option', { value: name, textContent: name }));
  }

  function syncEditor() {
    const entry = selection ? selectedProperty() : null;
    const key = entry ? selectedKey() : null;
    editorElement.hidden = !key;
    if (!key) {
      return;
    }
    const easing = key.easing ?? LINEAR_EASING;
    const numbers = keyValueForEditor(entry.property, key.value);
    timeInput.value = String(key.time);
    valueInputs.forEach((input, index) => {
      input.value = String(numbers[index]);
    });
    easingSelect.replaceChildren(...easingOptionsFor(easing));
    easingSelect.value = easing;
    easingSelect.disabled = !entry.canEase;
  }

  function editSelectedKey(buildPatch) {
    const nodeId = controller.selectedNodeId;
    if (!nodeId || !selection) {
      return;
    }
    const { property, time } = selection;
    run(() => {
      const patch = buildPatch(property);
      controller.updatePropertyKeyframe(nodeId, property, time, patch);
      if (patch.time !== undefined) {
        selection = { property, time: patch.time };
        controller.setMotionTime(patch.time);
      }
    });
    sync(shownDuration, { force: true });
  }

  timeInput.addEventListener('change', () => editSelectedKey(() => ({ time: snapKeyTime(Number(timeInput.value), Math.max(shownDuration, Number(timeInput.value))) })));
  valueInputs.forEach(input => input.addEventListener('change', () => editSelectedKey(property => ({
    value: keyValueFromEditor(property, valueInputs.map(valueInput => Number(valueInput.value))),
  }))));
  easingSelect.addEventListener('change', () => editSelectedKey(() => ({ easing: easingSelect.value === LINEAR_EASING ? null : easingSelect.value })));
  deleteButton.addEventListener('click', () => {
    if (selection) {
      deleteKey(controller.selectedNodeId, selection.property, selection.time);
    }
  });

  /** Rebuilds the rows when the selected object's keys, the duration or the selected key change, and moves the playheads. */
  function sync(duration, { force = false } = {}) {
    shownDuration = duration;
    if (dragState) {
      return;
    }
    const nodeId = controller.selectedNodeId;
    const entries = nodeId ? controller.nodePropertyKeys(nodeId) : [];
    if (selection && !selectedKey()) {
      selection = null;
    }
    const signature = JSON.stringify([nodeId, duration, selection, entries]);
    if (force || signature !== shownSignature) {
      shownSignature = signature;
      playheads = [];
      const keptFocus = documentReference.activeElement?.closest?.('.crucible-studio-keyrows') ?? null;
      rowsElement.replaceChildren(...entries.map(entry => createRow(nodeId, entry, duration)));
      syncEditor();
      if (keptFocus) {
        (rowsElement.querySelector('.crucible-studio-lane-key[aria-pressed="true"]') ?? rowsElement.querySelector('.crucible-studio-lane-key'))?.focus();
      }
    }
    rowsElement.hidden = entries.length === 0;
    placePlayheads(duration);
  }

  return { rowsElement, editorElement, sync };
}
