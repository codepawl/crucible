// The key markers of the timeline bar sit over the scrub track, so they must land where the range thumb lands.
import { studioIconPath } from './studio-icons.js';

/** Width in pixels of the scrub thumb. The stylesheet draws the thumb at this size, so a marker can be placed under it. */
export const SCRUB_THUMB_WIDTH = 14;

/** A key time moves in steps of this many seconds when it is dragged, and by a tenth of a second per arrow key press. */
export const KEY_TIME_STEP = 0.01;
export const KEY_NUDGE_STEP = 0.1;

function fractionOfDuration(time, duration) {
  if (!(duration > 0)) {
    return 0;
  }
  return Math.min(1, Math.max(0, time / duration));
}

/**
 * Where a key marker's centre lies along the track, as a CSS length. A range thumb does not reach the ends of its
 * track: its centre travels from half a thumb in to half a thumb short of the far end.
 */
export function keyMarkerOffset(time, duration, thumbWidth = SCRUB_THUMB_WIDTH) {
  const fraction = fractionOfDuration(time, duration);
  return `calc(${thumbWidth / 2}px + (100% - ${thumbWidth}px) * ${fraction})`;
}

/** The time under a pointer: the inverse of keyMarkerOffset, for a track that starts at `left` and is `width` wide. */
export function keyTimeFromPointer({ clientX, left, width, duration, thumbWidth = SCRUB_THUMB_WIDTH }) {
  const travel = width - thumbWidth;
  if (!(travel > 0)) {
    return 0;
  }
  const fraction = Math.min(1, Math.max(0, (clientX - left - thumbWidth / 2) / travel));
  return fraction * duration;
}

/** A time snapped to the key step and kept inside the track. */
export function snapKeyTime(time, duration) {
  const snapped = Math.round(time / KEY_TIME_STEP) * KEY_TIME_STEP;
  return Math.min(duration, Math.max(0, Math.round(snapped * 1000) / 1000));
}

/** The label a screen reader hears for a marker. */
export function keyMarkerLabel(time) {
  return `Key at ${time.toFixed(2)} s`;
}

const KEY_DRAG_THRESHOLD_PIXELS = 3;
const KEY_TIME_TOLERANCE = 0.005;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const NUDGE_DIRECTION_BY_KEY = Object.freeze({ ArrowLeft: -1, ArrowRight: 1 });

function sameKeyTime(first, second) {
  return Math.abs(first - second) < KEY_TIME_TOLERANCE;
}

function createDiamondIcon(documentReference) {
  const icon = documentReference.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('class', 'crucible-studio-icon');
  icon.setAttribute('aria-hidden', 'true');
  const path = documentReference.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('d', studioIconPath('keyframe'));
  icon.append(path);
  return icon;
}

/**
 * The key markers over the scrub track: one diamond per time the selected node has a key at. A marker is a button.
 * Clicking selects it and brings the playhead there, dragging along the track retimes it (one controller call, on
 * release; Escape puts it back), the arrow keys nudge it and Delete removes that key alone.
 * `isDeleteKey(event)` says whether a key press is bound to deleting; it is handled here so the object is not deleted.
 */
export function createKeyMarkers({ documentReference, controller, keysElement, trackElement, announce, isDeleteKey, fallbackFocus }) {
  let selectedKeyTime = null;
  let shownNodeId = null;
  let shownSignature = '';
  let dragState = null;
  let suppressClick = false;
  let shownDuration = 4;

  function selectKey(time) {
    selectedKeyTime = time;
    controller.setMotionTime(time);
    renderMarkers(shownDuration);
  }

  function moveKey(nodeId, fromTime, toTime) {
    const previousSelection = selectedKeyTime;
    selectedKeyTime = toTime;
    try {
      controller.moveNodeKeyframe(nodeId, fromTime, toTime);
      controller.setMotionTime(toTime);
    } catch (error) {
      selectedKeyTime = previousSelection;
      announce(error);
    }
  }

  function nudgeKey(nodeId, time, delta, duration) {
    const targetTime = snapKeyTime(time + delta, duration);
    if (!sameKeyTime(targetTime, time)) {
      moveKey(nodeId, time, targetTime);
    }
  }

  function deleteKey(nodeId, time) {
    try {
      controller.deleteNodeKeyframe(nodeId, time);
      selectedKeyTime = null;
      announce(`Deleted key at ${time.toFixed(2)} s`);
    } catch (error) {
      announce(error);
    }
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
    const retimed = commit && finished.moved && !sameKeyTime(finished.previewTime, finished.time);
    if (retimed) {
      moveKey(finished.nodeId, finished.time, finished.previewTime);
    } else {
      finished.marker.style.insetInlineStart = keyMarkerOffset(finished.time, finished.duration);
    }
    renderMarkers(shownDuration);
  }

  function cancelDragOnEscape(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finishDrag(false);
    }
  }

  function moveDrag(event) {
    if (!dragState) {
      return;
    }
    if (!dragState.moved && Math.abs(event.clientX - dragState.startX) < KEY_DRAG_THRESHOLD_PIXELS) {
      return;
    }
    dragState.moved = true;
    const track = trackElement.getBoundingClientRect();
    const rawTime = keyTimeFromPointer({ clientX: event.clientX, left: track.left, width: track.width, duration: dragState.duration });
    dragState.previewTime = snapKeyTime(rawTime, dragState.duration);
    dragState.marker.style.insetInlineStart = keyMarkerOffset(dragState.previewTime, dragState.duration);
  }

  function handleKeydown(event, nodeId, time, duration) {
    const direction = NUDGE_DIRECTION_BY_KEY[event.key];
    if (direction !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      nudgeKey(nodeId, time, direction * (event.shiftKey ? KEY_TIME_STEP : KEY_NUDGE_STEP), duration);
    } else if (isDeleteKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      deleteKey(nodeId, time);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation();
    }
  }

  function createMarker(nodeId, time, duration) {
    const label = keyMarkerLabel(time);
    const marker = documentReference.createElement('button');
    marker.type = 'button';
    marker.className = 'crucible-studio-key';
    marker.title = label;
    marker.dataset.time = String(time);
    marker.setAttribute('aria-label', label);
    marker.setAttribute('aria-pressed', selectedKeyTime !== null && sameKeyTime(time, selectedKeyTime) ? 'true' : 'false');
    marker.style.insetInlineStart = keyMarkerOffset(time, duration);
    marker.append(createDiamondIcon(documentReference));
    marker.addEventListener('click', () => {
      if (!suppressClick) {
        selectKey(time);
      }
    });
    marker.addEventListener('keydown', event => handleKeydown(event, nodeId, time, duration));
    marker.addEventListener('pointerdown', event => {
      if (event.button !== 0) {
        return;
      }
      dragState = { marker, nodeId, time, duration, startX: event.clientX, moved: false, previewTime: time };
      marker.setPointerCapture?.(event.pointerId);
      documentReference.addEventListener('keydown', cancelDragOnEscape, true);
    });
    marker.addEventListener('pointermove', moveDrag);
    marker.addEventListener('pointerup', () => finishDrag(true));
    marker.addEventListener('pointercancel', () => finishDrag(false));
    marker.addEventListener('lostpointercapture', () => finishDrag(false));
    return marker;
  }

  function renderMarkers(duration) {
    shownDuration = duration;
    if (dragState) {
      return;
    }
    const nodeId = controller.selectedNodeId;
    const times = nodeId ? controller.nodeKeyframeTimes(nodeId) : [];
    if (nodeId !== shownNodeId) {
      selectedKeyTime = null;
    }
    shownNodeId = nodeId;
    selectedKeyTime = times.find(time => selectedKeyTime !== null && sameKeyTime(time, selectedKeyTime)) ?? null;
    const signature = [nodeId, duration, selectedKeyTime, ...times].join('|');
    if (signature === shownSignature) {
      return;
    }
    shownSignature = signature;
    const keptFocus = documentReference.activeElement?.closest?.('.crucible-studio-keys') ?? null;
    const markers = times.map(time => createMarker(nodeId, time, duration));
    keysElement.replaceChildren(...markers);
    if (keptFocus) {
      const selectedMarker = markers.find(marker => marker.getAttribute('aria-pressed') === 'true');
      (selectedMarker ?? markers[0] ?? fallbackFocus)?.focus();
    }
  }

  return { sync: renderMarkers };
}
