import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ORBIT_OPTIONS,
  attachOrbitControls,
  createOrbitController,
  eyeFromOrbit,
  orbitFromCamera,
} from '../src/orbit-controller.js';
import {
  ORBIT_CONTROL_BINDINGS,
  attachFrameOrbitControls,
  createFrameOrbitController,
  frameOrbitControlScript,
} from '../src/docs-live-controls.js';

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, event = {}) {
      let prevented = false;
      const payload = {
        type,
        preventDefault() {
          prevented = true;
        },
        ...event,
      };
      for (const handler of listeners.get(type) ?? []) handler(payload);
      return prevented;
    },
    setPointerCapture() {},
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

test('orbitFromCamera and eyeFromOrbit round-trip camera vectors', () => {
  const inputEye = [3, 2, 4];
  const inputTarget = [1, 0.5, -1];
  const pose = orbitFromCamera(inputEye, inputTarget);
  const rebuiltEye = eyeFromOrbit(pose);
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(rebuiltEye[axis] - inputEye[axis]) < 1e-6);
  }
  assert.deepEqual(pose.target, inputTarget);
  assert.throws(() => orbitFromCamera([NaN, 0, 0], [0, 0, 0]), RangeError);
});

test('createOrbitController clamps orbit, pan, zoom, pinch, and moveTarget within limits', () => {
  const controller = createOrbitController({
    yaw: 0.4,
    pitch: 0.3,
    distance: 4,
    target: [0, 0, 0],
    minPitch: 0.1,
    maxPitch: 1.2,
    minDistance: 1,
    maxDistance: 8,
    boundsMin: [-2, -1, -2],
    boundsMax: [2, 3, 2],
  });

  controller.orbitBy(-500, 5000);
  assert.equal(controller.state().pitch, 1.2);
  assert.ok(controller.state().yaw > 0.4);

  controller.panBy(2000, -2000);
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(controller.state().target[axis] >= [-2, -1, -2][axis]);
    assert.ok(controller.state().target[axis] <= [2, 3, 2][axis]);
  }

  controller.zoomBy(-50000);
  assert.equal(controller.state().distance, 1);
  controller.pinch(100, 0, 0);
  assert.equal(controller.state().distance, 8);

  controller.moveTarget({ forward: 1, right: 0, up: 10 }, 2);
  assert.equal(controller.state().target[1], 3);

  controller.reset({ immediate: true });
  assert.equal(controller.state().distance, 4);
  assert.deepEqual(controller.state().target, [0, 0, 0]);
});

test('setPreset transitions via shortest yaw path and converges to goal', () => {
  const controller = createOrbitController({
    yaw: 0.1,
    pitch: 0.2,
    distance: 5,
    target: [0, 0, 0],
  });
  controller.setPreset({ yaw: Math.PI * 2 - 0.1, pitch: 0.5, distance: 3, target: [1, 0, 0] });
  assert.equal(controller.isTransitioning(), true);
  const firstStep = controller.step(0.05);
  assert.ok(firstStep.yaw < 0.1);
  for (let stepIndex = 0; stepIndex < 120; stepIndex += 1) {
    controller.step(0.05);
  }
  assert.equal(controller.isTransitioning(), false);
  assert.ok(Math.abs(controller.state().distance - 3) < 1e-3);
  assert.ok(Math.abs(controller.state().target[0] - 1) < 1e-3);
});

test('attachOrbitControls wires pointer orbit, pan, pinch, wheel, keyboard, tap, and dispose', () => {
  const canvas = createEventTarget();
  const keyTarget = createEventTarget();
  const controller = createOrbitController({
    ...DEFAULT_ORBIT_OPTIONS,
    yaw: 0,
    pitch: 0.5,
    distance: 6,
    target: [0, 0, 0],
  });
  const interactions = [];
  const taps = [];
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  let queuedCallback = null;
  globalThis.requestAnimationFrame = callback => {
    queuedCallback = callback;
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {
    queuedCallback = null;
  };

  try {
    const binding = attachOrbitControls(canvas, controller, {
      keyTarget,
      reducedMotion: true,
      onInteract: kind => interactions.push(kind),
      onTap: event => taps.push(event.clientX),
    });

    assert.equal(canvas.dispatch('contextmenu'), true);

    canvas.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, button: 0, shiftKey: false });
    canvas.dispatch('pointerup', { pointerId: 1, clientX: 101, clientY: 101, button: 0 });
    assert.deepEqual(taps, [101]);

    canvas.dispatch('pointerdown', { pointerId: 2, clientX: 100, clientY: 100, button: 0, shiftKey: false });
    canvas.dispatch('pointermove', { pointerId: 2, clientX: 140, clientY: 120 });
    canvas.dispatch('pointerup', { pointerId: 2, clientX: 140, clientY: 120 });
    assert.ok(controller.state().yaw < 0);

    canvas.dispatch('pointerdown', { pointerId: 3, clientX: 200, clientY: 200, button: 2, shiftKey: false });
    canvas.dispatch('pointermove', { pointerId: 3, clientX: 230, clientY: 200 });
    canvas.dispatch('pointerup', { pointerId: 3, clientX: 230, clientY: 200 });
    assert.ok(interactions.includes('pan'));

    canvas.dispatch('pointerdown', { pointerId: 4, clientX: 10, clientY: 10, button: 0, shiftKey: false });
    canvas.dispatch('pointerdown', { pointerId: 5, clientX: 50, clientY: 10, button: 0, shiftKey: false });
    canvas.dispatch('pointermove', { pointerId: 5, clientX: 90, clientY: 10 });
    canvas.dispatch('pointerup', { pointerId: 4 });
    canvas.dispatch('pointerup', { pointerId: 5 });
    assert.ok(interactions.includes('pinch'));

    assert.equal(canvas.dispatch('wheel', { deltaY: -120 }), true);
    assert.ok(interactions.includes('zoom'));

    keyTarget.dispatch('keydown', { key: 'w', target: { tagName: 'CANVAS' } });
    assert.equal(typeof queuedCallback, 'function');
    queuedCallback(performance.now() + 32);
    keyTarget.dispatch('keyup', { key: 'w' });
    assert.ok(interactions.includes('move'));

    const beforeBlockedReset = controller.state().yaw;
    keyTarget.dispatch('keydown', { key: 'r', target: { tagName: 'INPUT' } });
    assert.equal(controller.state().yaw, beforeBlockedReset);

    keyTarget.dispatch('keydown', { key: 'r', target: { tagName: 'CANVAS' } });
    assert.equal(controller.state().yaw, 0);
    assert.equal(controller.state().distance, 6);

    canvas.dispatch('pointerdown', { pointerId: 6, clientX: 10, clientY: 10, button: 0, shiftKey: false });
    canvas.dispatch('pointermove', { pointerId: 6, clientX: 50, clientY: 10 });
    canvas.dispatch('pointerup', { pointerId: 6 });
    canvas.dispatch('dblclick');
    assert.equal(controller.state().yaw, 0);

    binding.dispose();
    assert.equal(canvas.listenerCount('pointerdown'), 0);
    assert.equal(keyTarget.listenerCount('keydown'), 0);
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

test('docs-live-controls re-exports shared orbit controller helpers and script text', () => {
  assert.equal(typeof createFrameOrbitController, 'function');
  assert.equal(typeof attachFrameOrbitControls, 'function');
  assert.equal(ORBIT_CONTROL_BINDINGS.orbit, 'Left-drag');
  assert.equal(ORBIT_CONTROL_BINDINGS.pan, 'Right-drag / Middle-drag / Shift-drag');
  assert.equal(ORBIT_CONTROL_BINDINGS.reset, 'R / Double-click');
  assert.match(frameOrbitControlScript, /touchAction/);
  assert.match(frameOrbitControlScript, /tabIndex/);
});
