import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUN_MARK_DISTANCE_FACTOR,
  SUN_MARK_FALLBACK_RADIUS,
  SUN_MARK_RAY_SHARE,
  markIsOnFarSide,
  pointOnSphereUnderRay,
  sceneSphereOf,
  sunAnglesUnderRay,
  sunMarkPosition,
  sunMarkSphereOf,
  sunRayEnd,
} from '../src/studio-sun-mark.js';

const WIDE_BOUNDS = { min: [-3, 0, -4], max: [3, 2, 4] };
const UP_AND_AWAY = [0, 0.6, 0.8];
const INVERSE_ROOT_THREE = 1 / Math.sqrt(3);

function assertClose(actual, expected, message) {
  actual.forEach((component, axis) => {
    assert.ok(Math.abs(component - expected[axis]) < 1e-9, `${message}: ${actual} is not ${expected}`);
  });
}

test('the sphere of the scene is centred on its bounds and reaches the corner of the box', () => {
  const sphere = sceneSphereOf(WIDE_BOUNDS);
  assertClose(sphere.center, [0, 1, 0], 'centre');
  assert.ok(Math.abs(sphere.radius - Math.hypot(6, 2, 8) / 2) < 1e-9);
});

test('an empty scene gets the named fallback radius around the origin', () => {
  const sphere = sceneSphereOf(null);
  assertClose(sphere.center, [0, 0, 0], 'centre');
  assert.equal(sphere.radius, SUN_MARK_FALLBACK_RADIUS);
});

test('the mark stands out from the scene centre toward the sun, farther than the scene reaches', () => {
  const { center, radius } = sceneSphereOf(WIDE_BOUNDS);
  const mark = sunMarkPosition(WIDE_BOUNDS, UP_AND_AWAY);
  const offset = mark.map((component, axis) => component - center[axis]);
  assert.ok(Math.abs(Math.hypot(...offset) - radius * SUN_MARK_DISTANCE_FACTOR) < 1e-9);
  assertClose(offset.map(component => component / Math.hypot(...offset)), UP_AND_AWAY, 'direction');
});

test('the mark moves when the bounds or the direction change, and for nothing else', () => {
  const first = sunMarkPosition(WIDE_BOUNDS, UP_AND_AWAY);
  assertClose(sunMarkPosition({ min: [...WIDE_BOUNDS.min], max: [...WIDE_BOUNDS.max] }, [...UP_AND_AWAY]), first, 'same inputs');
  assert.notDeepEqual(sunMarkPosition({ min: [-6, 0, -8], max: [6, 4, 8] }, UP_AND_AWAY), first);
  assert.notDeepEqual(sunMarkPosition(WIDE_BOUNDS, [0.6, 0.8, 0]), first);
});

test('the ray leaves the mark and points back toward the scene centre by a share of the scene radius', () => {
  const sphere = sceneSphereOf(WIDE_BOUNDS);
  const mark = sunMarkPosition(WIDE_BOUNDS, UP_AND_AWAY);
  const end = sunRayEnd(WIDE_BOUNDS, UP_AND_AWAY);
  const length = Math.hypot(...end.map((component, axis) => component - mark[axis]));
  assert.ok(Math.abs(length - sphere.radius * SUN_MARK_RAY_SHARE) < 1e-9);
  const markFromCentre = Math.hypot(...mark.map((component, axis) => component - sphere.center[axis]));
  const endFromCentre = Math.hypot(...end.map((component, axis) => component - sphere.center[axis]));
  assert.ok(endFromCentre < markFromCentre, 'the end is nearer the scene than the mark');
});

test('a ray that hits the sphere gives the near point, and from inside the far one', () => {
  const sphere = { center: [0, 0, 0], radius: 2 };
  assertClose(pointOnSphereUnderRay({ origin: [0, 0, 10], direction: [0, 0, -1] }, sphere), [0, 0, 2], 'front hit');
  assertClose(pointOnSphereUnderRay({ origin: [0, 0, 0.5], direction: [0, 0, -1] }, sphere), [0, 0, -2], 'inside hit');
});

test('a ray that misses the sphere takes the nearest point on its silhouette, so the drag keeps turning', () => {
  const sphere = { center: [0, 0, 0], radius: 2 };
  const nearMiss = pointOnSphereUnderRay({ origin: [3, 0, 10], direction: [0, 0, -1] }, sphere);
  assertClose(nearMiss, [2, 0, 0], 'silhouette');
  const farMiss = pointOnSphereUnderRay({ origin: [30, 30, 10], direction: [0, 0, -1] }, sphere);
  const farDirection = farMiss.map(component => component / 2);
  assertClose(farDirection, [Math.SQRT1_2, Math.SQRT1_2, 0], 'silhouette direction');
});

test('a drag turns the sun to the pointer point and keeps it between 4 and 88 degrees', () => {
  const sphere = { center: [0, 0, 0], radius: 2 };
  const level = sunAnglesUnderRay({ origin: [0, 0, 10], direction: [0, 0, -1] }, sphere);
  assert.deepEqual(level, { azimuthDegrees: 0, elevationDegrees: 4 }, 'a point at the horizon is lifted to 4 degrees');
  const overhead = sunAnglesUnderRay({ origin: [0, 10, 0.001], direction: [0, -1, 0] }, sphere);
  assert.equal(overhead.elevationDegrees, 88, 'a point straight above is held at 88 degrees');
  const diagonal = sunAnglesUnderRay({ origin: [10, 10, 10], direction: [-INVERSE_ROOT_THREE, -INVERSE_ROOT_THREE, -INVERSE_ROOT_THREE] }, sphere);
  assert.ok(Math.abs(diagonal.azimuthDegrees - 45) < 0.5);
  assert.ok(Math.abs(diagonal.elevationDegrees - 35.26) < 0.5);
  const below = sunAnglesUnderRay({ origin: [0, -10, 0.5], direction: [0, 1, 0] }, sphere);
  assert.equal(below.elevationDegrees, 4, 'a point below the horizon is held at 4 degrees');
});

test('the sphere of the drag is the scene sphere scaled to the mark distance', () => {
  const scene = sceneSphereOf(WIDE_BOUNDS);
  const drag = sunMarkSphereOf(WIDE_BOUNDS);
  assertClose(drag.center, scene.center, 'centre');
  assert.ok(Math.abs(drag.radius - scene.radius * SUN_MARK_DISTANCE_FACTOR) < 1e-9);
});

test('a mark on the half of the sphere turned away from the eye keeps the far hit', () => {
  const sphere = { center: [0, 0, 0], radius: 2 };
  const eye = [0, 0, 10];
  assert.equal(markIsOnFarSide([0, 0, 2], sphere, eye), false);
  assert.equal(markIsOnFarSide([0, 0, -2], sphere, eye), true);
  const ray = { origin: eye, direction: [0, 0, -1] };
  assertClose(pointOnSphereUnderRay(ray, sphere, { farSide: true }), [0, 0, -2], 'far hit');
  assertClose(pointOnSphereUnderRay(ray, sphere, { farSide: false }), [0, 0, 2], 'near hit');
  assertClose(pointOnSphereUnderRay({ origin: [3, 0, 10], direction: [0, 0, -1] }, sphere, { farSide: true }), [2, 0, 0], 'a miss ignores the side');
});
