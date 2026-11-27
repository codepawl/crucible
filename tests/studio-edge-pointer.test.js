import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EDGE_POINTER_CLEAR_RADIUS,
  EDGE_POINTER_INSET,
  edgePointerPlacement,
  screenPointOfWorldPoint,
} from '../src/studio-edge-pointer.js';

const WIDTH = 1000;
const HEIGHT = 600;
const CENTRE = { x: 500, y: 300 };

function placementToward(x, y, extra = {}) {
  return edgePointerPlacement({ point: { x, y, visible: true, behind: false }, width: WIDTH, height: HEIGHT, ...extra });
}

function assertNear(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} is not ${expected}`);
}

test('a mark inside the viewport needs no pointer', () => {
  assert.equal(placementToward(10, 10), null);
  assert.equal(placementToward(WIDTH, HEIGHT), null);
  assert.equal(placementToward(CENTRE.x, CENTRE.y), null);
});

test('a mark that the depth range clips has a pointer even while its screen point lies inside', () => {
  const placement = edgePointerPlacement({ point: { x: 700, y: 300, visible: false, behind: false }, width: WIDTH, height: HEIGHT });
  assert.ok(placement);
  assert.equal(placement.angle, 0);
});

test('a mark beyond one side puts the pointer on that side of the inset rectangle, pointing at it', () => {
  const left = placementToward(-400, 300);
  assertNear(left.x, EDGE_POINTER_INSET, 'left edge');
  assertNear(left.y, 300, 'level with the centre');
  assertNear(Math.abs(left.angle), 180, 'points left');

  const right = placementToward(1900, 300);
  assertNear(right.x, WIDTH - EDGE_POINTER_INSET, 'right edge');
  assertNear(right.angle, 0, 'points right');

  const above = placementToward(500, -900);
  assertNear(above.y, EDGE_POINTER_INSET, 'top edge');
  assertNear(above.x, 500, 'above the centre');
  assertNear(above.angle, -90, 'points up');

  const below = placementToward(500, 1500);
  assertNear(below.y, HEIGHT - EDGE_POINTER_INSET, 'bottom edge');
  assertNear(below.angle, 90, 'points down');
});

test('a mark toward a corner puts the pointer on the line from the centre to it, on the inset rectangle', () => {
  const halfWidth = WIDTH / 2 - EDGE_POINTER_INSET;
  const halfHeight = HEIGHT / 2 - EDGE_POINTER_INSET;
  const corners = [
    { x: -5000, y: -5000, expectedX: CENTRE.x - halfWidth, expectedY: CENTRE.y - halfHeight },
    { x: 6000, y: -6000, expectedX: CENTRE.x + halfWidth, expectedY: CENTRE.y - halfHeight },
    { x: 6000, y: 6600, expectedX: CENTRE.x + halfWidth, expectedY: CENTRE.y + halfHeight },
    { x: -4000, y: 6000, expectedX: CENTRE.x - halfWidth, expectedY: CENTRE.y + halfHeight },
  ];
  for (const corner of corners) {
    const placement = placementToward(corner.x, corner.y);
    const onALongSide = Math.abs(Math.abs(placement.x - CENTRE.x) - halfWidth) < 1e-6 || Math.abs(Math.abs(placement.y - CENTRE.y) - halfHeight) < 1e-6;
    assert.ok(onALongSide, 'on the inset rectangle');
    const wantedAngle = (Math.atan2(corner.y - CENTRE.y, corner.x - CENTRE.x) * 180) / Math.PI;
    assertNear(placement.angle, wantedAngle, 'angle along the line to the mark');
    const crossProduct = (placement.x - CENTRE.x) * (corner.y - CENTRE.y) - (placement.y - CENTRE.y) * (corner.x - CENTRE.x);
    assertNear(crossProduct / 1e4, 0, 'on the line from the centre to the mark');
  }
  const exactCorner = placementToward(CENTRE.x + halfWidth * 20, CENTRE.y + halfHeight * 20);
  assertNear(exactCorner.x, CENTRE.x + halfWidth, 'a mark along the diagonal lands in the corner');
  assertNear(exactCorner.y, CENTRE.y + halfHeight, 'a mark along the diagonal lands in the corner');
});

test('a mark behind the view points the way it lies off to the side, not the way its projection falls', () => {
  // The projection of a point behind the eye is the mirror of where it lies; the placement mirrors it back.
  const behindRight = edgePointerPlacement({ point: { x: 300, y: 300, visible: false, behind: true }, width: WIDTH, height: HEIGHT });
  assertNear(behindRight.x, WIDTH - EDGE_POINTER_INSET, 'right edge');
  assertNear(behindRight.angle, 0, 'points right');
  const behindBelowLeft = edgePointerPlacement({ point: { x: 700, y: 200, visible: false, behind: true }, width: WIDTH, height: HEIGHT });
  assert.ok(behindBelowLeft.x < CENTRE.x && behindBelowLeft.y > CENTRE.y);
  assert.ok(Math.abs(behindBelowLeft.angle) > 90);
});

test('a mark straight behind the view still gets a pointer, pointing up', () => {
  const placement = edgePointerPlacement({ point: { x: CENTRE.x, y: CENTRE.y, visible: false, behind: true }, width: WIDTH, height: HEIGHT });
  assertNear(placement.y, EDGE_POINTER_INSET, 'top edge');
  assertNear(placement.angle, -90, 'points up');
});

test('a viewport smaller than the inset keeps the pointer in the middle', () => {
  const placement = edgePointerPlacement({ point: { x: 900, y: 10, visible: true, behind: false }, width: 30, height: 30 });
  assert.ok(Number.isFinite(placement.x) && Number.isFinite(placement.y));
  assertNear(placement.x, 15, 'centre');
  assertNear(placement.y, 15, 'centre');
});

test('a pointer meeting an overlay slides along the edge to the nearest free spot', () => {
  const rightEdgeX = WIDTH - EDGE_POINTER_INSET;
  const widget = { left: WIDTH - 100, top: 0, right: WIDTH, bottom: 300 + 40 };
  const placement = placementToward(5000, 300, { obstacles: [widget] });
  assertNear(placement.x, rightEdgeX, 'still on the right edge');
  assert.ok(placement.y >= widget.bottom + EDGE_POINTER_CLEAR_RADIUS, 'below the overlay');
  assert.ok(placement.y - (widget.bottom + EDGE_POINTER_CLEAR_RADIUS) <= 2, 'at the nearest free spot');
  assertNear(placement.angle, 0, 'still points at the mark');
});

test('a pointer pushed past a corner by an overlay continues round it onto the next edge', () => {
  const widget = { left: WIDTH - 140, top: 0, right: WIDTH, bottom: 150 };
  const placement = placementToward(5000, -5000, { obstacles: [widget] });
  assert.ok(placement.x <= widget.left - EDGE_POINTER_CLEAR_RADIUS + 2 || placement.y >= widget.bottom + EDGE_POINTER_CLEAR_RADIUS - 2);
  const clearOfWidget = placement.x + EDGE_POINTER_CLEAR_RADIUS <= widget.left + 1e-6 || placement.y - EDGE_POINTER_CLEAR_RADIUS >= widget.bottom - 1e-6;
  assert.ok(clearOfWidget, 'clear of the overlay');
});

test('overlays that the pointer is not near leave it where the line put it', () => {
  const readout = { left: 12, top: HEIGHT - 60, right: 220, bottom: HEIGHT - 12 };
  const placement = placementToward(5000, 300, { obstacles: [readout] });
  assertNear(placement.x, WIDTH - EDGE_POINTER_INSET, 'right edge');
  assertNear(placement.y, 300, 'on the line');
});

function pinholeController({ eye, target, projection = 'perspective' }) {
  const forward = target.map((component, axis) => component - eye[axis]);
  const forwardLength = Math.hypot(...forward);
  forward.forEach((component, axis) => { forward[axis] = component / forwardLength; });
  return {
    viewCamera: { eye, target, projection },
    projectWorldPoint(worldPoint) {
      const depth = worldPoint.reduce((sum, component, axis) => sum + (component - eye[axis]) * forward[axis], 0);
      if (depth <= 1e-6) {
        return { x: 0, y: 0, depth: 1, visible: false };
      }
      return { x: WIDTH / 2 + ((worldPoint[0] - eye[0]) / depth) * 500, y: HEIGHT / 2 - ((worldPoint[1] - eye[1]) / depth) * 500, depth: 0.5, visible: true };
    },
  };
}

test('a point in front of the eye projects as the controller projects it', () => {
  const controller = pinholeController({ eye: [0, 0, 0], target: [0, 0, -1] });
  const screenPoint = screenPointOfWorldPoint(controller, [1, 0, -2]);
  assert.equal(screenPoint.behind, false);
  assert.equal(screenPoint.visible, true);
  assertNear(screenPoint.x, 750, 'x');
});

test('a point behind the eye is flagged and, once placed, points to the side it lies on', () => {
  const controller = pinholeController({ eye: [0, 0, 0], target: [0, 0, -1] });
  const behindToTheRight = screenPointOfWorldPoint(controller, [2, 0, 4]);
  assert.equal(behindToTheRight.behind, true);
  const rightPlacement = edgePointerPlacement({ point: behindToTheRight, width: WIDTH, height: HEIGHT });
  assertNear(rightPlacement.angle, 0, 'right of the view is on the right');

  const behindAbove = screenPointOfWorldPoint(controller, [0, 3, 4]);
  const abovePlacement = edgePointerPlacement({ point: behindAbove, width: WIDTH, height: HEIGHT });
  assertNear(abovePlacement.angle, -90, 'above the view is up');
});

test('an orthographic view has no behind: its projection is used as it comes', () => {
  const controller = pinholeController({ eye: [0, 0, 0], target: [0, 0, -1], projection: 'orthographic' });
  controller.projectWorldPoint = () => ({ x: -50, y: 300, depth: 2, visible: false });
  const screenPoint = screenPointOfWorldPoint(controller, [0, 0, 5]);
  assert.equal(screenPoint.behind, false);
  assertNear(screenPoint.x, -50, 'x');
});
