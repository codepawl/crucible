import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UNLIMITED_RANGE_SCENE_RADIUS_FACTOR,
  areaGroundFootprint,
  areaLightReach,
  circlePolyline,
  effectiveRange,
  pointGroundFootprint,
  pointLightReach,
  spotGroundFootprint,
  spotLightReach,
  sphereSilhouette,
  sunReach,
} from '../src/studio-light-reach.js';
import { convexHull, projectPolylineRuns, readLightReachOptions } from '../src/studio-light-reach-view.js';

const SCENE_RADIUS = 4;

function distance(first, second) {
  return Math.hypot(...first.map((component, axis) => component - second[axis]));
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} is not ${expected}`);
}

function radiusOfRim(rim, center) {
  return Math.max(...rim.map(point => distance(point, center)));
}

test('a point light range sphere grows with its range and falls back to the scene when unlimited', () => {
  const near = pointLightReach({ position: [1, 2, 3], range: 5 }, SCENE_RADIUS);
  const far = pointLightReach({ position: [1, 2, 3], range: 10 }, SCENE_RADIUS);
  assertClose(far.rangeRadius, near.rangeRadius * 2, 'double range');
  for (const circle of far.axisCircles) {
    assertClose(radiusOfRim(circle, far.center), 10, 'every axis circle lies on the range sphere');
  }
  assert.equal(far.axisCircles.length, 3);
  const unlimited = pointLightReach({ position: [0, 1, 0], range: 0 }, SCENE_RADIUS);
  assertClose(unlimited.rangeRadius, SCENE_RADIUS * UNLIMITED_RANGE_SCENE_RADIUS_FACTOR, 'range 0 means unlimited');
  assertClose(pointLightReach({ position: [0, 1, 0] }, SCENE_RADIUS).rangeRadius, unlimited.rangeRadius, 'a missing range means unlimited');
  assertClose(unlimited.sourceRadius, 0.05, 'the default source radius');
  assertClose(effectiveRange(7, SCENE_RADIUS), 7, 'a set range is used as is');
});

test('a sphere silhouette faces the eye and is absent from inside the ball', () => {
  const silhouette = sphereSilhouette([0, 0, 0], 1, [0, 0, 5]);
  assert.ok(silhouette.every(point => Math.abs(point[2] - 0.2) < 1e-9), 'the circle sits between the centre and the eye');
  assertClose(radiusOfRim(silhouette, [0, 0, 0.2]), Math.sqrt(1 - 0.04), 'the circle radius');
  assert.equal(sphereSilhouette([0, 0, 0], 1, [0, 0.5, 0]), null);
});

test('a spot cone follows its angle, range and penumbra', () => {
  const base = { position: [0, 5, 0], direction: [0, -1, 0], angle: 0.5, penumbra: 0.5, range: 6 };
  const cone = spotLightReach(base, SCENE_RADIUS);
  assertClose(cone.length, 6, 'cone length is the range');
  assertClose(cone.rimRadius, 6 * Math.sin(0.5), 'rim radius from the half angle');
  assertClose(radiusOfRim(cone.rim, cone.rimCenter), cone.rimRadius, 'the rim is a circle of that radius');
  assert.ok(cone.rim.every(point => Math.abs(distance(point, cone.apex) - 6) < 1e-9), 'the rim lies on the range sphere');
  assert.equal(cone.edgeLines.length, 4);
  assert.ok(cone.edgeLines.every(([start, end]) => distance(start, cone.apex) === 0 && Math.abs(distance(start, end) - 6) < 1e-9));
  const wider = spotLightReach({ ...base, angle: 1 }, SCENE_RADIUS);
  assertClose(wider.rimRadius, 6 * Math.sin(1), 'a wider angle widens the rim');
  assert.ok(cone.innerRimRadius < cone.rimRadius, 'a penumbra pulls the inner rim inside');
  const hard = spotLightReach({ ...base, penumbra: 0 }, SCENE_RADIUS);
  assertClose(hard.innerRimRadius, hard.rimRadius, 'no penumbra puts the inner rim on the outer one');
  const softest = spotLightReach({ ...base, penumbra: 1 }, SCENE_RADIUS);
  assertClose(softest.innerRimRadius, 0, 'full penumbra fades from the axis');
  const unlimited = spotLightReach({ ...base, range: 0 }, SCENE_RADIUS);
  assertClose(unlimited.length, SCENE_RADIUS * UNLIMITED_RANGE_SCENE_RADIUS_FACTOR, 'unlimited range falls back to the scene');
});

test('a spot cone points along its direction', () => {
  const cone = spotLightReach({ position: [1, 1, 1], direction: [2, 0, 0], angle: 0.4, range: 3 }, SCENE_RADIUS);
  assert.deepEqual(cone.axis, [1, 0, 0]);
  assertClose(cone.rimCenter[0], 1 + 3 * Math.cos(0.4), 'the rim centre lies along the axis');
});

test('an area light rectangle follows width, height, direction and up', () => {
  const light = { position: [0, 2, 0], direction: [0, 0, 1], up: [0, 1, 0], width: 4, height: 2 };
  const reach = areaLightReach(light);
  const [first, second, third] = reach.corners;
  assertClose(distance(first, second), 4, 'width');
  assertClose(distance(second, third), 2, 'height');
  assert.ok(reach.corners.every(corner => Math.abs(corner[2]) < 1e-9), 'the rectangle is perpendicular to its direction');
  assert.equal(reach.rectangle.length, 5);
  assert.deepEqual(reach.rectangle[4], reach.rectangle[0]);
  assert.equal(reach.normalArrow.length, 3);
  assert.ok(reach.normalArrow[0][1][2] > 0, 'the arrow leaves the lit side');
  const taller = areaLightReach({ ...light, height: 6 });
  assertClose(distance(taller.corners[1], taller.corners[2]), 6, 'taller rectangle');
});

test('an area light that looks straight down still has a rectangle', () => {
  const reach = areaLightReach({ position: [0, 3, 0], direction: [0, -1, 0], up: [0, 1, 0], width: 2, height: 2 });
  assert.ok(reach.corners.every(corner => Number.isFinite(corner[0]) && Math.abs(corner[1] - 3) < 1e-9));
});

test('the sun ring wraps the scene in the plane across the light', () => {
  const bounds = { min: [-2, 0, -2], max: [2, 4, 2] };
  const direction = [0, 1, 0];
  const reach = sunReach(bounds, direction);
  assertClose(reach.radius, Math.hypot(4, 4, 4) / 2, 'ring radius is the scene radius');
  assert.ok(reach.ring.every(point => Math.abs(point[1] - 2) < 1e-9), 'the ring is perpendicular to the direction');
  assertClose(radiusOfRim(reach.ring, reach.center), reach.radius, 'the ring is a circle');
  assert.equal(reach.parallelArrows.length, 5);
  for (const arrow of reach.parallelArrows) {
    const [shaftStart, shaftEnd] = arrow[0];
    assert.ok(shaftEnd[1] < shaftStart[1], 'arrows travel away from the sun');
    assert.ok(Math.abs(shaftEnd[0] - shaftStart[0]) < 1e-9);
  }
  const [shaftStart, shaftEnd] = reach.singleArrow[0];
  assert.ok(distance(shaftStart, reach.center) > reach.radius, 'the single arrow starts outside the ring');
  assert.deepEqual(shaftEnd, reach.center);
});

test('the sun ring has the fallback size for an empty scene', () => {
  const reach = sunReach(null, [0, 1, 0]);
  assert.ok(reach.radius > 0);
  assert.deepEqual(reach.center, [0, 0, 0]);
});

test('a point light footprint is a circle on the ground that grows with its range', () => {
  const light = { position: [1, 3, 2], range: 5 };
  const { outline, center } = pointGroundFootprint(light, SCENE_RADIUS);
  assert.deepEqual(center, [1, 0, 2]);
  assertClose(radiusOfRim(outline, center), 4, 'sqrt(range^2 - height^2)');
  assert.ok(outline.every(point => point[1] === 0));
  assert.deepEqual(pointGroundFootprint({ position: [0, 6, 0], range: 5 }, SCENE_RADIUS).outline, []);
});

test('a spot straight down lights a circle of radius height times tan(angle)', () => {
  const light = { position: [0, 4, 0], direction: [0, -1, 0], angle: 0.5, range: 20 };
  const { outline, center } = spotGroundFootprint(light, SCENE_RADIUS);
  assert.ok(outline.length > 8);
  assertClose(radiusOfRim(outline, center), 4 * Math.tan(0.5), 'cone radius on the ground');
  assertClose(center[0], 0, 'centred under the light');
  assert.ok(outline.every(point => Math.abs(point[1]) < 1e-9));
});

test('a tilted spot lights a stretched patch on the far side of its foot', () => {
  const light = { position: [0, 4, 0], direction: [1, -1, 0], angle: 0.4, range: 30 };
  const { outline, center } = spotGroundFootprint(light, SCENE_RADIUS);
  assert.ok(center[0] > 3.5, 'the patch lies out along the tilt');
  const widthAlong = Math.max(...outline.map(point => point[0])) - Math.min(...outline.map(point => point[0]));
  const widthAcross = Math.max(...outline.map(point => point[2])) - Math.min(...outline.map(point => point[2]));
  assert.ok(widthAlong > widthAcross, 'the tilt stretches the patch away from the light');
});

test('a spot whose cone stops short of the ground has no patch', () => {
  const light = { position: [0, 8, 0], direction: [0, -1, 0], angle: 0.5, range: 5 };
  assert.deepEqual(spotGroundFootprint(light, SCENE_RADIUS).outline, []);
});

test('a spot cut by its range is clipped to the range circle on the ground', () => {
  const light = { position: [0, 4, 0], direction: [0, -1, 0], angle: 1.2, range: 5 };
  const { outline, center } = spotGroundFootprint(light, SCENE_RADIUS);
  assertClose(radiusOfRim(outline, center), 3, 'sqrt(range^2 - height^2) caps the patch');
});

test('a spot that opens past the horizon still gets a closed finite patch', () => {
  const light = { position: [0, 2, 0], direction: [1, 0, 0], angle: 1.4, range: 10 };
  const { outline } = spotGroundFootprint(light, SCENE_RADIUS);
  assert.ok(outline.length > 8);
  assert.ok(outline.every(point => point.every(Number.isFinite) && Math.hypot(point[0], point[2]) <= Math.sqrt(96) + 1e-6));
  assert.deepEqual(outline[0], outline.at(-1));
});

test('a spot pointing up or lit from below the ground has no patch', () => {
  assert.deepEqual(spotGroundFootprint({ position: [0, 3, 0], direction: [0, 1, 0], angle: 0.3, range: 10 }, SCENE_RADIUS).outline, []);
  assert.deepEqual(spotGroundFootprint({ position: [0, -1, 0], direction: [0, -1, 0], angle: 0.3, range: 10 }, SCENE_RADIUS).outline, []);
});

test('an area light patch is its rectangle carried to the ground along its direction', () => {
  const light = { position: [0, 3, 0], direction: [0, -1, 0], up: [0, 0, 1], width: 2, height: 4 };
  const { outline, center } = areaGroundFootprint(light, SCENE_RADIUS);
  assert.equal(outline.length, 5);
  assert.ok(outline.every(point => Math.abs(point[1]) < 1e-9));
  assertClose(center[0], 0, 'under the light');
  const xs = outline.map(point => point[0]);
  assertClose(Math.max(...xs) - Math.min(...xs) + (Math.max(...outline.map(point => point[2])) - Math.min(...outline.map(point => point[2]))), 6, 'width plus height');
  assert.deepEqual(areaGroundFootprint({ ...light, direction: [0, 1, 0] }, SCENE_RADIUS).outline, []);
});

test('a circle polyline closes on its first point', () => {
  const circle = circlePolyline([0, 0, 0], [1, 0, 0], [0, 1, 0], 2, 8);
  assert.equal(circle.length, 9);
  assertClose(distance(circle[0], circle[8]), 0, 'the last point is the first');
});

test('the style switch reads the page address and falls back to the first choice', () => {
  assert.deepEqual(readLightReachOptions(''), { style: 'wire', sunArrow: 'parallel' });
  assert.deepEqual(readLightReachOptions('?lightReach=footprint&sunArrow=single'), { style: 'footprint', sunArrow: 'single' });
  assert.deepEqual(readLightReachOptions('?lightReach=nonsense&sunArrow=x'), { style: 'wire', sunArrow: 'parallel' });
});

test('a polyline is cut into runs wherever a point is behind the camera', () => {
  const project = point => ({ x: point[0], y: 0, visible: point[0] >= 0 });
  const runs = projectPolylineRuns(project, [[1, 0, 0], [2, 0, 0], [-1, 0, 0], [3, 0, 0], [4, 0, 0], [5, 0, 0]]);
  assert.deepEqual(runs.map(run => run.map(point => point.x)), [[1, 2], [3, 4, 5]]);
});

test('a convex hull keeps the outer points of a cone and its apex', () => {
  const hull = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }]);
  assert.equal(hull.length, 4);
  assert.ok(!hull.some(point => point.x === 5));
});
