import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createStudioController } from '../src/studio.js';

function makeRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'floor', type: 'box', bevel: 0 },
      { id: 'cube', type: 'box', bevel: 0.04 },
    ],
    materials: [
      { id: 'stone', tag: 'surface', color: [0.3, 0.32, 0.35], roughness: 0.8, metallic: 0 },
      { id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 },
    ],
    nodes: [
      { id: 'ground', geometry: 'floor', material: 'stone', translation: [0, -0.2, 0], scale: [10, 0.4, 10] },
      { id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] },
    ],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

function makeController() {
  return createStudioController({ scene: createAgentScene(makeRecipe()), viewportWidth: 800, viewportHeight: 600 });
}

function subtract(first, second) {
  return first.map((component, axis) => component - second[axis]);
}

function normalized(vector) {
  const length = Math.hypot(...vector);
  return vector.map(component => component / length);
}

test('surfacePointAt returns the point under a pixel without touching the selection', () => {
  const controller = makeController();
  controller.selectNodes(['ground']);
  const heroPixel = controller.projectWorldPoint([0, 0.5, 0]);
  const point = controller.surfacePointAt(heroPixel.x, heroPixel.y);
  assert.equal(point.length, 3);
  assert.ok(point.every(Number.isFinite));
  assert.ok(Math.abs(point[0]) <= 0.55 && point[2] > 0 && point[2] <= 0.55, `the point lies on the cube face toward the view: ${point}`);
  assert.deepEqual(controller.selectedNodeIds, ['ground'], 'the selection is the one it was');
});

test('surfacePointAt returns null over empty space', () => {
  const controller = makeController();
  assert.equal(controller.surfacePointAt(400, 5), null);
});

test('setOrbitPivot moves the target to the point and keeps the view angle and distance', () => {
  const controller = makeController();
  const before = controller.viewCamera;
  const beforeOffset = subtract(before.eye, before.target);
  const pivot = [1.5, 0.25, -2];
  controller.setOrbitPivot(pivot);
  const after = controller.viewCamera;
  assert.deepEqual(Array.from(after.target), pivot);
  const afterOffset = subtract(after.eye, after.target);
  assert.ok(Math.abs(Math.hypot(...afterOffset) - Math.hypot(...beforeOffset)) < 1e-9, 'distance is unchanged');
  normalized(afterOffset).forEach((component, axis) => {
    assert.ok(Math.abs(component - normalized(beforeOffset)[axis]) < 1e-9, 'direction is unchanged');
  });
});

test('setOrbitPivot is navigation: it adds no undo step', () => {
  const controller = makeController();
  controller.setOrbitPivot([1, 1, 1]);
  assert.equal(controller.canUndo, false);
});

test('setOrbitPivot refuses a point that is not three finite numbers and says what to pass', () => {
  const controller = makeController();
  assert.throws(() => controller.setOrbitPivot([1, 2]), /three finite numbers/);
  assert.throws(() => controller.setOrbitPivot([1, Number.NaN, 0]), /three finite numbers/);
  assert.throws(() => controller.setOrbitPivot(null), /three finite numbers/);
});
