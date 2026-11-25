import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { boundsGrownByParts, farthestDepthOfBounds, fittedNearPlane, nearestDepthOfBounds, sceneBoundsOfParts } from '../src/near-plane-fit.js';

function boxPart(translation, size = 2) {
  const half = size / 2;
  const positions = new Float32Array([-half, -half, -half, half, half, half]);
  return { geometry: { positions }, matrix: mat4.fromTranslation(mat4.create(), translation) };
}

function lookingDownNegativeZ() {
  return mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
}

test('scene bounds cover every part with a small padding', () => {
  const bounds = sceneBoundsOfParts([boxPart([0, 0, -50]), boxPart([10, 0, -60])]);
  assert.ok(bounds.minimum[2] < -61);
  assert.ok(bounds.maximum[2] > -49);
});

test('a part that can leave its bounds disables the fit', () => {
  assert.equal(sceneBoundsOfParts([{ ...boxPart([0, 0, -50]), skin: {} }]), null);
  assert.equal(sceneBoundsOfParts([{ ...boxPart([0, 0, -50]), crowd: {} }]), null);
});

test('a reader that only needs where the scene ends boxes a skinned part where it rests', () => {
  const parts = [boxPart([0, 0, -50]), { ...boxPart([0, 0, -80]), skin: {} }];
  const bounds = sceneBoundsOfParts(parts, { includeMoving: true });
  assert.ok(bounds.minimum[2] < -81, 'the skinned part is inside the box');
  assert.equal(sceneBoundsOfParts([{ ...boxPart([0, 0, -50]), skin: {} }, { geometry: { positions: new Float32Array(6) } }], { includeMoving: true }), null, 'a part with no placement still gives no box');
  const view = lookingDownNegativeZ();
  assert.ok(farthestDepthOfBounds(bounds, view) > 81 && farthestDepthOfBounds(bounds, view) < 90, 'the far end is the farthest corner along the view');
});

test('the near plane stays at the default when the eye is inside the scene and moves out when it is far', () => {
  const view = lookingDownNegativeZ();
  const close = sceneBoundsOfParts([boxPart([0, 0, 0])]);
  assert.equal(fittedNearPlane(close, view, 100), 0.1);
  const far = sceneBoundsOfParts([boxPart([0, 0, -80])]);
  const near = fittedNearPlane(far, view, 10000);
  assert.ok(near > 50 && near < nearestDepthOfBounds(far, view));
});

test('the near plane never passes one percent of the far plane', () => {
  const bounds = sceneBoundsOfParts([boxPart([0, 0, -500])]);
  assert.equal(fittedNearPlane(bounds, lookingDownNegativeZ(), 100), 1);
});

test('a moved part grows the fitted box, so the near plane never passes it (#2403)', () => {
  const view = lookingDownNegativeZ();
  const fitted = sceneBoundsOfParts([boxPart([0, 0, -80])]);
  const movedCloser = boxPart([0, 0, -5]);
  const grown = boundsGrownByParts(fitted, [movedCloser]);
  assert.ok(fittedNearPlane(fitted, view, 10000) > 5, 'the old box alone would cut the moved part');
  assert.ok(fittedNearPlane(grown, view, 10000) < 4, 'the grown box keeps the part in front of the plane');
  assert.ok(grown.minimum[2] <= fitted.minimum[2] && grown.maximum[2] >= -4, 'the box only grows');
  assert.equal(boundsGrownByParts(fitted, []), fitted, 'no moved part leaves the box as it is');
  assert.equal(boundsGrownByParts(fitted, [{ ...movedCloser, skin: {} }]), null, 'a part that can leave its box stops the fit');
});
