// The mouse side of Studio's viewport: which press does what (read from the mouse map), the held Space that turns a left
// drag into a pan, the side buttons, and the click that sets the orbit point. studio.js hands in the few things it owns.
import { findMouseAction } from './studio-mouse-map.js';

// A slider or a switch keeps the focus after a click, but nothing is typed into it, so only the keys it moves with stay its own.
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const SWITCH_KEYS = new Set([...SLIDER_KEYS, 'Enter', ' ']);
const SWITCH_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'color']);

export function isEditableTarget(target, key) {
  const tag = target?.tagName?.toLowerCase?.();
  if (tag === 'input' && target.type === 'range') {
    return SLIDER_KEYS.has(key);
  }
  if (tag === 'input' && SWITCH_INPUT_TYPES.has(target.type)) {
    return SWITCH_KEYS.has(key);
  }
  return tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target?.isContentEditable);
}

const PASS_THROUGH_CLASS_NAMES = new Set(['crucible-studio-dock', 'crucible-studio-popover', 'crucible-studio-view-widget', 'crucible-studio-paused', 'crucible-studio-draft', 'crucible-studio-pass-notice']);

/** Tells whether a pointer event that started on `target` belongs to the viewport, or to a control or panel laid over it. */
export function createViewportTargetFilter(viewportElement, documentReference) {
  return (target, { checkScroll = false } = {}) => {
    for (let node = target; node && node !== viewportElement && node.tagName; node = node.parentNode) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button' || tag === 'a' || tag === 'dialog') return false;
      if (node.getAttribute?.('popover') !== null || node.getAttribute?.('data-view') !== null) return false;
      const classes = String(node.className ?? '').split(/\s+/);
      if (classes.some(name => PASS_THROUGH_CLASS_NAMES.has(name))) {
        return false;
      }
      if (checkScroll) {
        const style = documentReference.defaultView?.getComputedStyle?.(node);
        const overflow = `${style?.overflowX ?? ''}${style?.overflowY ?? ''}`;
        if (/auto|scroll/.test(overflow) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)) return false;
      }
    }
    return true;
  };
}

const CAMERA_MODE_BY_MOUSE_ACTION = Object.freeze({ 'view.orbit': 'orbit', 'view.pan': 'pan' });
const SIDE_BUTTON_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick'];

/**
 * `getMouseMap()` gives the rows in force; it changes when a person rebinds one. The other callbacks: `isConnected()`,
 * `isInputBlocked()` (a dialog is open or an object is held), `getViewportPointer()`, `isPointerActive()`, `isBoundToSpace(event)`,
 * `replayKeyDown(event)`, `localCoordinates(event)`, `announce(text)`, `stopFlight()`, `undo()` and `redo()`.
 */
export function createMouseInput({ documentReference, viewportElement, controller, getMouseMap, isConnected, isInputBlocked, getViewportPointer, isPointerActive, isBoundToSpace, replayKeyDown, localCoordinates, announce, stopFlight, undo, redo }) {
  // Space held with the pointer over the viewport turns a left drag into a pan. A tap with no drag still does what Space is
  // bound to, so that action waits for the key to come up; holding the key long enough to repeat, or Space anywhere but the
  // viewport, runs it at once as before. `dragged` is set by the press that used the key.
  let spaceHold = null;
  const isSpaceEvent = event => event.code === 'Space' || event.key === ' ';
  const spaceBelongsToViewport = event => {
    const tag = event.target?.tagName?.toLowerCase?.();
    return !isEditableTarget(event.target, event.key) && tag !== 'button' && tag !== 'a' && tag !== 'summary' && !isInputBlocked();
  };

  function mousePressOf(event, gesture) {
    return {
      button: event.button ?? 0,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey || event.metaKey,
      spaceHeld: Boolean(spaceHold),
      gesture,
    };
  }

  // True when Space was taken here and must not reach the key handler yet.
  function holdSpaceForPan(event) {
    if (!isSpaceEvent(event) || event.ctrlKey || event.metaKey || event.altKey || !spaceBelongsToViewport(event)) return false;
    if (!event.repeat) {
      spaceHold = { pending: null, dragged: false };
      const bound = isBoundToSpace(event);
      if (!getViewportPointer() || !bound) return false;
      event.preventDefault();
      spaceHold.pending = event;
      return true;
    }
    if (!spaceHold) return false;
    if (spaceHold.dragged || isPointerActive()) {
      event.preventDefault();
      return true;
    }
    const waiting = spaceHold.pending;
    spaceHold.pending = null;
    if (waiting) replayKeyDown(waiting);
    return false;
  }

  function releaseSpace(event) {
    if (!isSpaceEvent(event) || !spaceHold) return;
    const { pending, dragged } = spaceHold;
    spaceHold = null;
    if (pending && !dragged) replayKeyDown(pending);
  }

  // The camera move a press on the viewport starts, or null; a held Space is spent by the drag that uses it.
  function cameraModeOf(event) {
    const dragAction = findMouseAction(getMouseMap(), mousePressOf(event, 'drag'));
    if (spaceHold) {
      spaceHold.pending = null;
      spaceHold.dragged = true;
    }
    return CAMERA_MODE_BY_MOUSE_ACTION[dragAction] ?? null;
  }

  // A camera drag: orbit, pan or zoom. `keymapNavigation` marks one a keymap asked for (Alt and a button), which never also picks.
  // Returns the pointer state the drag keeps while the button is down.
  function startCameraDrag(event, mode, keymapNavigation, captureElement) {
    const coordinates = localCoordinates(event);
    captureElement.setPointerCapture?.(event.pointerId);
    return {
      mode,
      keymapNavigation,
      startX: coordinates.x,
      startY: coordinates.y,
      lastX: coordinates.x,
      lastY: coordinates.y,
      moved: false,
      pointerId: event.pointerId,
    };
  }

  // Moves the camera by what the pointer travelled since the last move; a press that stays within 4 pixels is still a click.
  function dragCamera(pointerState, coordinates) {
    const deltaX = coordinates.x - pointerState.lastX;
    const deltaY = coordinates.y - pointerState.lastY;
    if (Math.hypot(coordinates.x - pointerState.startX, coordinates.y - pointerState.startY) > 4) {
      pointerState.moved = true;
    }
    pointerState.lastX = coordinates.x;
    pointerState.lastY = coordinates.y;
    if (!pointerState.moved || pointerState.mode === null) return;
    if (pointerState.mode === 'pan') {
      controller.orbitCamera({ panX: -deltaX * 0.002, panY: deltaY * 0.002 });
    } else if (pointerState.mode === 'zoom') {
      controller.orbitCamera({ zoomScale: Math.min(1.5, Math.max(0.5, 1 - (deltaX - deltaY) * 0.005)) });
    } else {
      controller.orbitCamera({ deltaAzimuth: -deltaX * 0.008, deltaElevation: deltaY * 0.008 });
    }
  }

  function setOrbitPivotAt(coordinates) {
    const point = controller.surfacePointAt(coordinates.x, coordinates.y);
    if (!point) {
      announce('No surface there to orbit around');
      return;
    }
    stopFlight();
    controller.setOrbitPivot(point);
    announce('Orbiting around that point');
  }

  const clickActions = Object.freeze({
    'view.setPivot': event => {
      if (viewportElement.contains(event.target)) setOrbitPivotAt(localCoordinates(event));
    },
    'edit.undo': () => undo(),
    'edit.redo': () => redo(),
  });

  /** Runs the action a click is mapped to and returns true, or returns false when the click is not in the map. */
  function runClickAction(event) {
    const action = findMouseAction(getMouseMap(), mousePressOf(event, 'click'));
    if (!clickActions[action]) return false;
    clickActions[action](event);
    return true;
  }

  /** True when a right press with these keys is a mapped click, so the object menu stays shut. */
  function claimsRightClick(event) {
    return findMouseAction(getMouseMap(), { ...mousePressOf(event, 'click'), button: 2 }) !== null;
  }

  // The side buttons never turn into Back and Forward while Studio is the page. The action runs on the release only, once per
  // click; the other events of the press are only stopped.
  const onSideButton = event => {
    if (event.button !== 3 && event.button !== 4) return;
    if (!isConnected()) return;
    event.preventDefault();
    if (event.type !== 'pointerup') return;
    const typing = isEditableTarget(documentReference.activeElement, '');
    if (typing || isInputBlocked()) return;
    runClickAction(event);
  };
  for (const eventName of SIDE_BUTTON_EVENTS) documentReference.addEventListener(eventName, onSideButton, true);

  return {
    holdSpaceForPan,
    releaseSpace,
    letGoOfSpace: () => {
      spaceHold = null;
    },
    cameraModeOf,
    startCameraDrag,
    dragCamera,
    runClickAction,
    claimsRightClick,
    dispose: () => {
      for (const eventName of SIDE_BUTTON_EVENTS) documentReference.removeEventListener(eventName, onSideButton, true);
    },
  };
}
