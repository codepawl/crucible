// Shared damped orbit, screen-space pan, wheel zoom, WASD/QE target movement, and reset controller for Crucible viewers.

export const DEFAULT_ORBIT_OPTIONS = /* @__PURE__ */ Object.freeze({
  minPitch: -1.45,
  maxPitch: 1.45,
  minDistance: 0.25,
  maxDistance: 200,
  orbitSpeed: 0.0055,
  panSpeed: 0.0016,
  zoomSpeed: 0.001,
  moveSpeed: 0.9,
  damping: 10,
});

function crossProduct(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalizeVector(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function clampNumber(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function wrapAngleDelta(current, goal) {
  const fullTurn = Math.PI * 2;
  let delta = (goal - current) % fullTurn;
  if (delta > Math.PI) delta -= fullTurn;
  if (delta < -Math.PI) delta += fullTurn;
  return current + delta;
}

function validateVector3(vector, label) {
  if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite)) {
    throw new RangeError(`${label} must be three finite numbers.`);
  }
}

export function orbitFromCamera(eye, target = [0, 0, 0]) {
  validateVector3(eye, 'Orbit eye');
  validateVector3(target, 'Orbit target');
  const offsetX = eye[0] - target[0];
  const offsetY = eye[1] - target[1];
  const offsetZ = eye[2] - target[2];
  const distance = Math.max(1e-5, Math.hypot(offsetX, offsetY, offsetZ));
  const sine = clampNumber(offsetY / distance, -1, 1);
  return {
    yaw: Math.atan2(offsetX, offsetZ),
    pitch: Math.asin(sine),
    distance,
    target: [target[0], target[1], target[2]],
  };
}

export function eyeFromOrbit({ yaw, pitch, distance, target }) {
  const horizontal = Math.cos(pitch) * distance;
  return [
    target[0] + Math.sin(yaw) * horizontal,
    target[1] + Math.sin(pitch) * distance,
    target[2] + Math.cos(yaw) * horizontal,
  ];
}

function resolveViewPose(view, fallbackPose) {
  if (view?.eye !== undefined) {
    return orbitFromCamera(view.eye, view.target ?? fallbackPose.target);
  }
  const yaw = view?.yaw ?? fallbackPose.yaw;
  const pitch = view?.pitch ?? fallbackPose.pitch;
  const distance = view?.distance ?? fallbackPose.distance;
  const target = view?.target ?? fallbackPose.target;
  validateVector3(target, 'Orbit target');
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(distance) || distance <= 0) {
    throw new RangeError('Orbit preset yaw, pitch and positive distance must be finite numbers.');
  }
  return { yaw, pitch, distance, target: [target[0], target[1], target[2]] };
}

export function createOrbitController(rawOptions = {}) {
  const settings = { ...DEFAULT_ORBIT_OPTIONS, ...rawOptions };
  const initial = resolveViewPose(rawOptions, { yaw: 0.65, pitch: 0.35, distance: 4, target: [0, 0, 0] });
  let limits = {
    minPitch: settings.minPitch,
    maxPitch: settings.maxPitch,
    minDistance: settings.minDistance,
    maxDistance: settings.maxDistance,
    boundsMin: rawOptions.boundsMin ? [...rawOptions.boundsMin] : null,
    boundsMax: rawOptions.boundsMax ? [...rawOptions.boundsMax] : null,
  };
  let home = { yaw: initial.yaw, pitch: initial.pitch, distance: initial.distance, target: [...initial.target] };
  let yaw = initial.yaw;
  let pitch = initial.pitch;
  let distance = initial.distance;
  let target = [...initial.target];
  let goalYaw = yaw;
  let goalPitch = pitch;
  let goalDistance = distance;
  let goalTarget = [...target];
  let transitioning = false;

  function clampPose(pose) {
    pose.pitch = clampNumber(pose.pitch, limits.minPitch, limits.maxPitch);
    pose.distance = clampNumber(pose.distance, limits.minDistance, limits.maxDistance);
    if (limits.boundsMin && limits.boundsMax) {
      for (let axis = 0; axis < 3; axis++) {
        pose.target[axis] = clampNumber(pose.target[axis], limits.boundsMin[axis], limits.boundsMax[axis]);
      }
    }
    return pose;
  }

  function clampCurrent() {
    const clamped = clampPose({ yaw, pitch, distance, target });
    pitch = clamped.pitch;
    distance = clamped.distance;
    target = clamped.target;
  }

  function syncGoalToCurrent() {
    goalYaw = yaw;
    goalPitch = pitch;
    goalDistance = distance;
    goalTarget = [target[0], target[1], target[2]];
    transitioning = false;
  }

  clampCurrent();
  syncGoalToCurrent();

  function orbitBy(deltaX, deltaY) {
    yaw -= deltaX * settings.orbitSpeed;
    pitch += deltaY * settings.orbitSpeed;
    clampCurrent();
    syncGoalToCurrent();
  }

  function panBy(deltaX, deltaY) {
    const currentEye = eyeFromOrbit({ yaw, pitch, distance, target });
    const forward = normalizeVector([
      target[0] - currentEye[0],
      target[1] - currentEye[1],
      target[2] - currentEye[2],
    ]);
    const right = normalizeVector(crossProduct(forward, [0, 1, 0]));
    const up = crossProduct(right, forward);
    const scale = distance * settings.panSpeed;
    for (let axis = 0; axis < 3; axis++) {
      target[axis] = target[axis] - right[axis] * deltaX * scale + up[axis] * deltaY * scale;
    }
    clampCurrent();
    syncGoalToCurrent();
  }

  function zoomBy(deltaY) {
    distance *= Math.exp(deltaY * settings.zoomSpeed);
    clampCurrent();
    syncGoalToCurrent();
  }

  function pinch(distanceRatio, panDeltaX = 0, panDeltaY = 0) {
    if (Number.isFinite(distanceRatio) && distanceRatio > 0) {
      distance *= distanceRatio;
    }
    clampCurrent();
    panBy(panDeltaX, panDeltaY);
  }

  function moveTarget({ forward = 0, right = 0, up = 0 }, seconds = 1) {
    const step = distance * settings.moveSpeed * seconds;
    const forwardDirection = [-Math.sin(yaw), 0, -Math.cos(yaw)];
    const rightDirection = [Math.cos(yaw), 0, -Math.sin(yaw)];
    target[0] += (forwardDirection[0] * forward + rightDirection[0] * right) * step;
    target[1] += up * step;
    target[2] += (forwardDirection[2] * forward + rightDirection[2] * right) * step;
    clampCurrent();
    syncGoalToCurrent();
  }

  function setPreset(view, { immediate = false } = {}) {
    const resolved = clampPose(resolveViewPose(view, { yaw, pitch, distance, target }));
    if (immediate) {
      yaw = resolved.yaw;
      pitch = resolved.pitch;
      distance = resolved.distance;
      target = [...resolved.target];
      syncGoalToCurrent();
      return;
    }
    goalYaw = wrapAngleDelta(yaw, resolved.yaw);
    goalPitch = resolved.pitch;
    goalDistance = resolved.distance;
    goalTarget = [...resolved.target];
    transitioning = true;
  }

  function setHome(view, { apply = false, immediate = true } = {}) {
    const resolved = resolveViewPose(view, home);
    home = { yaw: resolved.yaw, pitch: resolved.pitch, distance: resolved.distance, target: [...resolved.target] };
    if (apply) setPreset(home, { immediate });
  }

  function setLimits(nextLimits = {}) {
    limits = {
      ...limits,
      ...nextLimits,
      boundsMin: nextLimits.boundsMin !== undefined ? (nextLimits.boundsMin ? [...nextLimits.boundsMin] : null) : limits.boundsMin,
      boundsMax: nextLimits.boundsMax !== undefined ? (nextLimits.boundsMax ? [...nextLimits.boundsMax] : null) : limits.boundsMax,
    };
    clampCurrent();
    if (!transitioning) syncGoalToCurrent();
  }

  function reset({ immediate = false } = {}) {
    setPreset(home, { immediate });
  }

  function step(deltaSeconds = 0.016) {
    if (transitioning) {
      const blend = 1 - Math.exp(-settings.damping * clampNumber(deltaSeconds, 0, 0.1));
      yaw += (goalYaw - yaw) * blend;
      pitch += (goalPitch - pitch) * blend;
      distance += (goalDistance - distance) * blend;
      for (let axis = 0; axis < 3; axis++) {
        target[axis] += (goalTarget[axis] - target[axis]) * blend;
      }
      const targetError = Math.hypot(
        goalTarget[0] - target[0],
        goalTarget[1] - target[1],
        goalTarget[2] - target[2],
      );
      const remaining = Math.max(
        Math.abs(goalYaw - yaw),
        Math.abs(goalPitch - pitch),
        Math.abs(goalDistance - distance),
        targetError,
      );
      if (remaining < 1e-4) {
        yaw = goalYaw;
        pitch = goalPitch;
        distance = goalDistance;
        target = [...goalTarget];
        transitioning = false;
      }
      clampCurrent();
    }
    return {
      eye: eyeFromOrbit({ yaw, pitch, distance, target }),
      target: [...target],
      yaw,
      pitch,
      distance,
      active: transitioning,
    };
  }

  return {
    orbitBy,
    panBy,
    zoomBy,
    pinch,
    moveTarget,
    setPreset,
    setHome,
    setLimits,
    reset,
    step,
    camera: () => ({ eye: eyeFromOrbit({ yaw, pitch, distance, target }), target: [...target], up: [0, 1, 0], yaw, pitch, distance }),
    state: () => ({ yaw, pitch, distance, target: [...target] }),
    home: () => ({ yaw: home.yaw, pitch: home.pitch, distance: home.distance, target: [...home.target] }),
    isTransitioning: () => transitioning,
  };
}

function isEditableElement(target) {
  if (!target) return false;
  const tagName = target.tagName?.toUpperCase();
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || Boolean(target.isContentEditable);
}

const MOVEMENT_KEYS = /* @__PURE__ */ new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

export function attachOrbitControls(canvas, controller, options = {}) {
  const keyTarget = options.keyTarget ?? canvas;
  const pointers = new Map();
  const pressedKeys = new Set();
  let dragMode = 'orbit';
  let tapStart = null;
  let keyFrame = 0;
  let lastTimestamp = 0;

  function prefersReducedMotion() {
    return options.reducedMotion ?? (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  }

  function notifyChange(kind) {
    options.onInteract?.(kind);
    options.onChange?.(controller.camera(), kind);
  }

  function scheduleStepFrame(callback) {
    if (typeof globalThis.requestAnimationFrame === 'function') return globalThis.requestAnimationFrame(callback);
    return globalThis.setTimeout(() => callback(Date.now()), 16);
  }

  function cancelStepFrame(id) {
    if (!id) return;
    if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(id);
    else globalThis.clearTimeout(id);
  }

  function pairMetrics() {
    const [first, second] = [...pointers.values()];
    return {
      distance: Math.hypot(first.x - second.x, first.y - second.y) || 1,
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    };
  }

  function runKeyboardStep(timestamp) {
    keyFrame = 0;
    if (!pressedKeys.size) return;
    const seconds = Math.min(0.1, Math.max(0.001, (timestamp - lastTimestamp) / 1000));
    lastTimestamp = timestamp;
    const axis = (positive, negative) => Number(pressedKeys.has(positive)) - Number(pressedKeys.has(negative));
    const forward = axis('w', 's') + axis('arrowup', 'arrowdown');
    const right = axis('d', 'a') + axis('arrowright', 'arrowleft');
    const up = axis('e', 'q');
    if (forward !== 0 || right !== 0 || up !== 0) {
      controller.moveTarget({ forward, right, up }, seconds);
      notifyChange('move');
    }
    keyFrame = scheduleStepFrame(runKeyboardStep);
  }

  const onContextMenu = event => event.preventDefault();

  const onPointerDown = event => {
    if (options.shouldHandlePointer && !options.shouldHandlePointer(event)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragMode = event.button === 2 || event.button === 1 || event.shiftKey ? 'pan' : 'orbit';
    tapStart = pointers.size === 1 && event.button === 0 && !event.shiftKey
      ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
      : null;
    canvas.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    if (tapStart && tapStart.pointerId === event.pointerId) {
      if (Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y) > 4) tapStart.moved = true;
    }
    if (pointers.size === 2) {
      const before = pairMetrics();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const after = pairMetrics();
      controller.pinch(before.distance / after.distance, after.x - before.x, after.y - before.y);
      notifyChange('pinch');
      return;
    }
    const deltaX = event.clientX - previous.x;
    const deltaY = event.clientY - previous.y;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (dragMode === 'pan') controller.panBy(deltaX, deltaY);
    else controller.orbitBy(deltaX, deltaY);
    notifyChange(dragMode);
  };

  const onPointerUp = event => {
    pointers.delete(event.pointerId);
    if (tapStart && tapStart.pointerId === event.pointerId && !tapStart.moved) {
      options.onTap?.(event);
    }
    tapStart = null;
  };

  const onPointerCancel = event => {
    pointers.delete(event.pointerId);
    tapStart = null;
  };

  const onWheel = event => {
    if (options.shouldHandlePointer && !options.shouldHandlePointer(event)) return;
    event.preventDefault();
    controller.zoomBy(event.deltaY);
    notifyChange('zoom');
  };

  const onDoubleClick = event => {
    if (options.shouldHandlePointer && !options.shouldHandlePointer(event)) return;
    controller.reset({ immediate: prefersReducedMotion() });
    notifyChange('reset');
  };

  const onKeyDown = event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableElement(event.target)) return;
    if (options.shouldHandleKey && !options.shouldHandleKey(event)) return;
    const key = event.key.toLowerCase();
    if (key === 'r') {
      event.preventDefault();
      controller.reset({ immediate: prefersReducedMotion() });
      notifyChange('reset');
      return;
    }
    if (!MOVEMENT_KEYS.has(key)) return;
    event.preventDefault();
    if (pressedKeys.has(key)) return;
    pressedKeys.add(key);
    if (!keyFrame) {
      lastTimestamp = performance.now();
      keyFrame = scheduleStepFrame(runKeyboardStep);
    }
  };

  const onKeyUp = event => {
    pressedKeys.delete(event.key.toLowerCase());
    if (!pressedKeys.size && keyFrame) {
      cancelStepFrame(keyFrame);
      keyFrame = 0;
    }
  };

  const onBlur = () => {
    pressedKeys.clear();
    if (keyFrame) {
      cancelStepFrame(keyFrame);
      keyFrame = 0;
    }
  };

  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onPointerCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDoubleClick);
  keyTarget.addEventListener('keydown', onKeyDown);
  keyTarget.addEventListener('keyup', onKeyUp);
  keyTarget.addEventListener('blur', onBlur);

  function dispose() {
    onBlur();
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('lostpointercapture', onPointerCancel);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDoubleClick);
    keyTarget.removeEventListener('keydown', onKeyDown);
    keyTarget.removeEventListener('keyup', onKeyUp);
    keyTarget.removeEventListener('blur', onBlur);
  }

  return { controller, dispose };
}
