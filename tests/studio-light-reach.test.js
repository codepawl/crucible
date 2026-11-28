import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import {
  MAX_AREA_SIZE,
  MAX_LIGHT_RANGE,
  MAX_SPOT_HALF_ANGLE,
  MIN_AREA_SIZE,
  MIN_LIGHT_RANGE,
  MIN_SPOT_HALF_ANGLE,
  SUN_RING_CLEARANCE,
  UNLIMITED_RANGE_SCENE_RADIUS_FACTOR,
  aimDirectionFromHit,
  areaGroundFootprint,
  areaHeightFromHit,
  areaLightReach,
  areaReachHandles,
  areaWidthFromHit,
  circlePolyline,
  effectiveRange,
  pointGroundFootprint,
  pointRangeFromHit,
  pointReachHandles,
  spotAngleFromHit,
  spotGroundFootprint,
  spotRangeFromHit,
  spotReachHandles,
  sunReach,
} from '../src/studio-light-reach.js';
import { projectPolylineRuns, renderLightReach } from '../src/studio-light-reach-view.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const SCENE_RADIUS = 4;
const VIEWPORT_BOX = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 };

function distance(first, second) {
  return Math.hypot(...first.map((component, axis) => component - second[axis]));
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} is not ${expected}`);
}

function radiusOfRim(rim, center) {
  return Math.max(...rim.map(point => distance(point, center)));
}

function makeLightStudioRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'floor', type: 'box', bevel: 0 },
      { id: 'cube', type: 'box', bevel: 0.04 },
    ],
    materials: [
      { id: 'stone', tag: 'surface', color: [0.3, 0.32, 0.35], roughness: 0.8, metallic: 0 },
    ],
    nodes: [
      { id: 'ground', geometry: 'floor', material: 'stone', translation: [0, -0.2, 0], scale: [10, 0.4, 10] },
      { id: 'hero', geometry: 'cube', material: 'stone', translation: [0, 0.5, 0] },
    ],
    camera: { eye: [0, 6, 12], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: {
      setup: 'studio',
      lightDirection: [-2, 5, 3],
      pointLights: [{ position: [3, 2, 0], color: [1, 1, 1], intensity: 4, range: 6 }],
      spotLights: [{ position: [-2, 4, 2], direction: [2, -4, -2], color: [1, 1, 1], intensity: 8, angle: 0.45, penumbra: 0.2, range: 9 }],
      areaLights: [{ position: [0, 3, -3], direction: [0, -1, 0.5], up: [0, 1, 0], color: [1, 1, 1], intensity: 5, width: 2.4, height: 1.4 }],
    },
  };
}

function mountLightStudio(testContext, recipe = makeLightStudioRecipe()) {
  const dom = installStudioDom();
  const renderer = createFakeRenderer();
  const studio = createStudio(dom.container, { recipe, renderer });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  const viewport = root.querySelector('.crucible-studio-viewport');
  viewport.box = VIEWPORT_BOX;
  studio.renderNow();
  return {
    dom,
    studio,
    controller: studio.controller,
    root,
    viewport,
    gizmo: viewport.querySelector('.crucible-studio-gizmo'),
    status: () => root.querySelector('.crucible-studio-status').textContent,
  };
}

function findReachHandle(gizmo, key, handleKind) {
  return gizmo.querySelectorAll('.crucible-studio-light-reach-hit')
    .find(element => element.getAttribute('data-reach-object') === key && element.getAttribute('data-light-reach-handle') === handleKind);
}

test('effective range uses set range or falls back to a multiple of scene radius', () => {
  assertClose(effectiveRange(7, SCENE_RADIUS), 7, 'a set range is used as is');
  assertClose(effectiveRange(0, SCENE_RADIUS), SCENE_RADIUS * UNLIMITED_RANGE_SCENE_RADIUS_FACTOR, 'range 0 means unlimited');
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
  assert.equal(reach.normalArrow.length, 2);
  assert.ok(reach.normalArrow[0][1][2] > 0, 'the arrow leaves the lit side');
  const taller = areaLightReach({ ...light, height: 6 });
  assertClose(distance(taller.corners[1], taller.corners[2]), 6, 'taller rectangle');
});

test('an area light that looks straight down still has a rectangle', () => {
  const reach = areaLightReach({ position: [0, 3, 0], direction: [0, -1, 0], up: [0, 1, 0], width: 2, height: 2 });
  assert.ok(reach.corners.every(corner => Number.isFinite(corner[0]) && Math.abs(corner[1] - 3) < 1e-9));
});

test('the sun ring lies flat on the ground and shows a single direction arrow from its mark', () => {
  const bounds = { min: [-2, 0.5, -1], max: [2, 4, 1] };
  const direction = [3 / Math.hypot(3, 4, 4), 4 / Math.hypot(3, 4, 4), 4 / Math.hypot(3, 4, 4)];
  const reach = sunReach(bounds, direction);
  const expectedRadius = (Math.hypot(4, 2) / 2) * SUN_RING_CLEARANCE;
  assertClose(reach.radius, expectedRadius, 'horizontal radius with clearance');
  assert.ok(reach.ring.every(point => Math.abs(point[1] - 0.5) < 1e-9), 'the ring is horizontal at the lowest height');
  assertClose(reach.center[0], 0, 'centred under the scene');
  assertClose(radiusOfRim(reach.ring, reach.center), expectedRadius, 'the ring is a circle');
  const [shaftStart, shaftEnd] = reach.singleArrow[0];
  const sceneCentre = [0, 2.25, 0];
  assertClose(distance(shaftStart, shaftEnd), 0.55 * distance(shaftStart, sceneCentre), 'the single arrow covers 55 percent of the way');
  assert.equal(reach.singleArrow.length, 2, 'one shaft and one head');
  assert.deepEqual(reach.singleArrowTip, shaftEnd, 'the handle tip matches the arrow head');
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

function segmentsCross(startA, endA, startB, endB) {
  const side = (origin, target, point) => (target[0] - origin[0]) * (point[2] - origin[2]) - (target[2] - origin[2]) * (point[0] - origin[0]);
  return side(startA, endA, startB) * side(startA, endA, endB) < 0 && side(startB, endB, startA) * side(startB, endB, endA) < 0;
}

test('the stills spot lights a closed convex patch inside its cone and range with exact corners', () => {
  const light = { position: [-3, 4, 2.5], direction: [3, -4, -2.5], angle: 0.5, range: 7 };
  const { outline } = spotGroundFootprint(light, SCENE_RADIUS);
  const axisLength = Math.hypot(3, 4, 2.5);
  for (const point of outline) {
    assertClose(point[1], 0, 'on the ground');
    const offset = [point[0] + 3, point[1] - 4, point[2] - 2.5];
    const reach = Math.hypot(...offset);
    assert.ok(reach <= 7 + 1e-6, `within range: ${reach}`);
    const angle = Math.acos((offset[0] * 3 - offset[1] * 4 - offset[2] * 2.5) / (reach * axisLength));
    assert.ok(angle <= 0.5 + 1e-6, `inside the cone: ${angle}`);
  }
  assert.deepEqual(outline[0], outline.at(-1));
  for (let first = 0; first < outline.length - 1; first += 1) {
    for (let second = first + 2; second < outline.length - 1; second += 1) {
      assert.ok(!segmentsCross(outline[first], outline[first + 1], outline[second], outline[second + 1]), `segments ${first} and ${second} cross`);
    }
  }
  const atRangeLimit = outline.filter(point => Math.abs(Math.hypot(point[0] + 3, 4, point[2] - 2.5) - 7) < 1e-6);
  assert.ok(atRangeLimit.length >= 3, 'the range circle bounds part of the patch');
  const cornerWhereEdgeMeetsRange = outline.some(point => Math.abs(Math.hypot(point[0] + 3, 4, point[2] - 2.5) - 7) < 1e-6 && Math.abs(Math.acos((((point[0] + 3) * 3) - 4 * -4 + (point[2] - 2.5) * -2.5) / (7 * axisLength)) - 0.5) < 1e-4);
  assert.ok(cornerWhereEdgeMeetsRange, 'the conic and the range circle meet at an exact corner');
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

test('a polyline is cut into runs wherever a point is behind the camera', () => {
  const project = point => ({ x: point[0], y: 0, visible: point[0] >= 0 });
  const runs = projectPolylineRuns(project, [[1, 0, 0], [2, 0, 0], [-1, 0, 0], [3, 0, 0], [4, 0, 0], [5, 0, 0]]);
  assert.deepEqual(runs.map(run => run.map(point => point.x)), [[1, 2], [3, 4, 5]]);
});

test('reach handle positions and drag math follow light properties and clamp cleanly', () => {
  const pointHandles = pointReachHandles({ position: [0, 3, 0], range: 5 }, SCENE_RADIUS, [0, 6, 10]);
  assertClose(distance(pointHandles.rangeHandle, [0, 3, 0]), 5, 'point range handle lies on range sphere');
  assertClose(pointHandles.rangeHandle[1], 0, 'point range handle sits on ground');
  assertClose(pointRangeFromHit([0, 3, 0], [6, 0, 0]).range, Math.hypot(6, 3), 'point range from hit');
  assertClose(pointRangeFromHit([0, 3, 0], [0, 0, 0]).range, 3.05, 'point range stays above ground height');
  assertClose(pointRangeFromHit([0, 3, 0], [500, 0, 0]).range, MAX_LIGHT_RANGE, 'point range clamps at max');
  assertClose(pointRangeFromHit([0, 0, 0], [0, 0, 0]).range, MIN_LIGHT_RANGE, 'point range clamps at min');

  const spot = { position: [0, 4, 0], direction: [0, -1, 0], angle: 0.4, range: 12 };
  const spotHandles = spotReachHandles(spot, SCENE_RADIUS, [0, 6, 10]);
  assert.ok(Math.hypot(spotHandles.aimHandle[0], spotHandles.aimHandle[1], spotHandles.aimHandle[2]) < 1e-6);
  assertClose(distance(spotHandles.angleHandle, spotHandles.aimHandle), 4 * Math.tan(0.4), 'angle handle sits on cone ground rim');
  const aimPatch = aimDirectionFromHit([0, 4, 0], [3, 0, 0]);
  assertClose(aimPatch.direction[0], 0.6, 'aim X');
  assertClose(aimPatch.direction[1], -0.8, 'aim Y');
  assertClose(aimPatch.direction[2], 0, 'aim Z');
  assert.equal(aimDirectionFromHit([0, 4, 0], [0, 4, 0]), null);
  assertClose(spotAngleFromHit(spot, [4, 0, 0]).angle, Math.PI / 4, 'spot angle from 45-deg hit');
  assertClose(spotAngleFromHit(spot, [0, 0, 0]).angle, MIN_SPOT_HALF_ANGLE, 'spot angle min clamp');
  assertClose(spotAngleFromHit(spot, [100, 50, 0]).angle, MAX_SPOT_HALF_ANGLE, 'spot angle max clamp');
  assertClose(spotRangeFromHit([0, 4, 0], [3, 0, 0]).range, 5, 'spot range from hit');

  const area = { position: [0, 3, 0], direction: [0, -1, 0], up: [0, 0, 1], width: 2, height: 4 };
  const areaHandles = areaReachHandles(area, SCENE_RADIUS, [0, 6, 10]);
  assertClose(distance(areaHandles.widthHandle, area.position), 1, 'half width');
  assertClose(distance(areaHandles.heightHandle, area.position), 2, 'half height');
  assertClose(areaWidthFromHit(area.position, areaHandles.frame.right, [3, 3, 0]).width, 6, 'area width drag');
  assertClose(areaWidthFromHit(area.position, areaHandles.frame.right, [0, 3, 0]).width, MIN_AREA_SIZE, 'area width min');
  assertClose(areaHeightFromHit(area.position, areaHandles.frame.height, [0, 3, 200]).height, MAX_AREA_SIZE, 'area height max');
});

test('renderLightReach draws footprint with interactive handles for selected lights and faint outlines for others', testContext => {
  const { controller, gizmo, studio } = mountLightStudio(testContext);
  assert.equal(gizmo.querySelectorAll('.crucible-studio-light-reach-line[data-role="faint"]').length, 3);
  assert.equal(gizmo.querySelectorAll('.crucible-studio-light-reach-hit').length, 0);

  controller.selectSceneObject('spot:0');
  studio.renderNow();
  assert.equal(gizmo.querySelectorAll('.crucible-studio-light-reach-line[data-role="faint"]').length, 2);
  assert.ok(findReachHandle(gizmo, 'spot:0', 'aim'));
  assert.ok(findReachHandle(gizmo, 'spot:0', 'angle'));
  assert.ok(findReachHandle(gizmo, 'spot:0', 'range'));

  controller.selectSceneObject('point:0');
  studio.renderNow();
  assert.ok(findReachHandle(gizmo, 'point:0', 'range'));

  controller.selectSceneObject('area:0');
  studio.renderNow();
  assert.ok(findReachHandle(gizmo, 'area:0', 'aim'));
  assert.ok(findReachHandle(gizmo, 'area:0', 'area-width'));
  assert.ok(findReachHandle(gizmo, 'area:0', 'area-height'));

  controller.selectSceneObject('sun');
  studio.renderNow();
  assert.ok(findReachHandle(gizmo, 'sun', 'sun-direction'));
  assert.equal(gizmo.querySelector('.crucible-studio-light-reach').getAttribute('data-style'), 'footprint');
});

test('dragging reach handles edits light and sun properties in the viewport as one undo step', testContext => {
  const { controller, gizmo, viewport, studio } = mountLightStudio(testContext);
  controller.setTool('select');

  const dragByWorldDelta = (key, handleKind, worldPointAtTarget) => {
    studio.renderNow();
    const handle = findReachHandle(gizmo, key, handleKind);
    assert.ok(handle, `missing ${handleKind} handle for ${key}`);
    const startX = Number(handle.getAttribute('cx'));
    const startY = Number(handle.getAttribute('cy'));
    const endScreen = controller.projectWorldPoint(worldPointAtTarget);
    assert.ok(endScreen.visible);
    dispatch(handle, 'pointerdown', { button: 0, clientX: startX, clientY: startY, pointerId: 1 });
    dispatch(viewport, 'pointermove', { clientX: (startX + endScreen.x) / 2, clientY: (startY + endScreen.y) / 2, pointerId: 1 });
    dispatch(viewport, 'pointermove', { clientX: endScreen.x, clientY: endScreen.y, pointerId: 1 });
    dispatch(viewport, 'pointerup', { button: 0, clientX: endScreen.x, clientY: endScreen.y, pointerId: 1 });
  };

  controller.selectSceneObject('spot:0');
  const beforeSpotAim = [...controller.exportRecipe().environment.spotLights[0].direction];
  dragByWorldDelta('spot:0', 'aim', [1.5, 0, 1]);
  assert.notDeepEqual(controller.exportRecipe().environment.spotLights[0].direction, beforeSpotAim);
  controller.undo();
  assert.deepEqual(controller.exportRecipe().environment.spotLights[0].direction, beforeSpotAim);

  const beforeSpotAngle = controller.exportRecipe().environment.spotLights[0].angle;
  dragByWorldDelta('spot:0', 'angle', [-2, 0, -2]);
  assert.notEqual(controller.exportRecipe().environment.spotLights[0].angle, beforeSpotAngle);
  controller.undo();
  assert.equal(controller.exportRecipe().environment.spotLights[0].angle, beforeSpotAngle);

  const beforeSpotRange = controller.exportRecipe().environment.spotLights[0].range;
  dragByWorldDelta('spot:0', 'range', [5, 0, -3]);
  assert.notEqual(controller.exportRecipe().environment.spotLights[0].range, beforeSpotRange);
  controller.undo();
  assert.equal(controller.exportRecipe().environment.spotLights[0].range, beforeSpotRange);

  controller.selectSceneObject('point:0');
  const beforePointRange = controller.exportRecipe().environment.pointLights[0].range;
  dragByWorldDelta('point:0', 'range', [-2, 0, 0]);
  assert.notEqual(controller.exportRecipe().environment.pointLights[0].range, beforePointRange);
  controller.undo();
  assert.equal(controller.exportRecipe().environment.pointLights[0].range, beforePointRange);

  controller.selectSceneObject('area:0');
  const beforeAreaWidth = controller.exportRecipe().environment.areaLights[0].width;
  dragByWorldDelta('area:0', 'area-width', [3.2, 3, -3]);
  assert.notEqual(controller.exportRecipe().environment.areaLights[0].width, beforeAreaWidth);
  controller.undo();
  assert.equal(controller.exportRecipe().environment.areaLights[0].width, beforeAreaWidth);

  const beforeAreaHeight = controller.exportRecipe().environment.areaLights[0].height;
  dragByWorldDelta('area:0', 'area-height', [0, 5.2, -3]);
  assert.notEqual(controller.exportRecipe().environment.areaLights[0].height, beforeAreaHeight);
  controller.undo();
  assert.equal(controller.exportRecipe().environment.areaLights[0].height, beforeAreaHeight);

  controller.selectSceneObject('sun');
  studio.renderNow();
  const beforeSunDirection = [...controller.exportRecipe().environment.lightDirection];
  const sunDot = gizmo.querySelectorAll('.crucible-studio-light-reach-hit')
    .find(element => element.getAttribute('data-reach-object') === 'sun' && element.getAttribute('data-light-reach-handle') === 'sun-direction' && element.getAttribute('cx') !== null);
  assert.ok(sunDot, 'missing sun arrow tip handle');
  const sunX = Number(sunDot.getAttribute('cx'));
  const sunY = Number(sunDot.getAttribute('cy'));
  dispatch(sunDot, 'pointerdown', { button: 0, clientX: sunX, clientY: sunY, pointerId: 2 });
  dispatch(viewport, 'pointermove', { clientX: sunX + 80, clientY: sunY + 35, pointerId: 2 });
  dispatch(viewport, 'pointerup', { button: 0, clientX: sunX + 80, clientY: sunY + 35, pointerId: 2 });
  assert.notDeepEqual(controller.exportRecipe().environment.lightDirection, beforeSunDirection);
  controller.undo();
  assert.deepEqual(controller.exportRecipe().environment.lightDirection, beforeSunDirection);
});

test('dragging a reach handle whose property is driven refuses the drag and announces why', testContext => {
  const recipe = makeLightStudioRecipe();
  recipe.motion = {
    duration: 2,
    loop: false,
    tracks: [{ kind: 'light', id: 'spot:0', property: 'direction', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [2, -4, -2] }, { time: 2, value: [-2, -4, -2] }] }],
  };
  const { controller, gizmo, status, studio } = mountLightStudio(testContext, recipe);
  controller.selectSceneObject('spot:0');
  studio.renderNow();
  const handle = findReachHandle(gizmo, 'spot:0', 'aim');
  assert.ok(handle);
  dispatch(handle, 'pointerdown', {
    button: 0,
    clientX: Number(handle.getAttribute('cx')),
    clientY: Number(handle.getAttribute('cy')),
    pointerId: 3,
  });
  assert.match(status(), /animated by a motion track or driver/i);
});
