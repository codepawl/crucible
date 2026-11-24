import test from 'node:test';
import assert from 'node:assert/strict';
import { BACK_IDENTIFIER_COUNT, BACK_REACH_PER_THICKNESS, backFaceExit, backIdentifier, drawsBackFaces, glassBackFaceGlsl } from '../src/glass-back-face.js';
import { ballLensExit, refractDirection } from '../src/glass-ball-lens.js';
import { liquidFragmentSource } from '../src/shaders.js';
import '../src/liquid-shader.js';

// Issue #3225: the exit bend comes from the shape's own back faces. An ellipsoid (radii 1.5, 0.6, 0.6) seen along -z by an orthographic camera
// is a closed shape the ball lens estimate (a sphere tangent to the front surface) cannot describe.
const radii = [1.5, 0.6, 0.6];
const cameraDistance = 10;
const project = point => ({ x: (point[0] + 2) / 4, y: (point[1] + 2) / 4, depth: (cameraDistance - point[2]) / 20 });
const backPoint = (x, y) => {
  const px = x * 4 - 2;
  const py = y * 4 - 2;
  const remainder = 1 - (px / radii[0]) ** 2 - (py / radii[1]) ** 2;
  return remainder > 0 ? [px, py, -radii[2] * Math.sqrt(remainder)] : null;
};
const backDepth = (x, y) => {
  const point = backPoint(x, y);
  return point ? project(point).depth : 1;
};
const backNormal = (x, y) => {
  const point = backPoint(x, y);
  if (!point) return null;
  const gradient = [point[0] / radii[0] ** 2, point[1] / radii[1] ** 2, point[2] / radii[2] ** 2];
  const length = Math.hypot(...gradient);
  return gradient.map(value => value / length);
};

function frontHit(px, py) {
  const z = radii[2] * Math.sqrt(1 - (px / radii[0]) ** 2 - (py / radii[1]) ** 2);
  const gradient = [px / radii[0] ** 2, py / radii[1] ** 2, z / radii[2] ** 2];
  const length = Math.hypot(...gradient);
  return { position: [px, py, z], normal: gradient.map(value => value / length) };
}

// The exact exit: intersect the inside ray with the ellipsoid, refract with its true normal.
function exactExit(position, normal, indexOfRefraction) {
  const inside = refractDirection([0, 0, -1], normal, 1 / indexOfRefraction);
  const a = inside.reduce((sum, value, axis) => sum + (value / radii[axis]) ** 2, 0);
  const b = 2 * inside.reduce((sum, value, axis) => sum + (value * position[axis]) / radii[axis] ** 2, 0);
  const distance = -b / a;
  const exitPosition = position.map((value, axis) => value + inside[axis] * distance);
  const gradient = exitPosition.map((value, axis) => value / radii[axis] ** 2);
  const outward = gradient.map(value => value / Math.hypot(...gradient));
  return { exitPosition, direction: refractDirection(inside, outward.map(value => -value), indexOfRefraction) };
}

const angleBetween = (first, second) => Math.acos(Math.min(1, first[0] * second[0] + first[1] * second[1] + first[2] * second[2]));

test('the back-face exit bends the ray where it leaves a closed non-spherical shape', () => {
  const front = frontHit(0.7, 0.2);
  const found = backFaceExit({ ...front, viewDirection: [0, 0, 1], indexOfRefraction: 1.5, thickness: 1.2, project, backDepth, backNormal, shapeIdentifier: 1, backIdentifierAt: () => 1, reversed: false });
  const exact = exactExit(front.position, front.normal, 1.5);
  assert.ok(found, 'the back face is found');
  assert.ok(angleBetween(found.direction, exact.direction) < 0.02, 'exit direction within 1 degree of the exact one');
  assert.ok(Math.hypot(...found.exitPosition.map((value, axis) => value - exact.exitPosition[axis])) < 0.02, 'exit point within 2 cm');
  const estimate = ballLensExit({ ...front, viewDirection: [0, 0, 1], indexOfRefraction: 1.5, radius: 0.6, thickness: 1.2 });
  assert.ok(angleBetween(estimate.direction, exact.direction) > 0.05, 'the sphere estimate is visibly off for this shape');
});

test('a ray that finds no back face returns null so the shader keeps the thickness heuristic', () => {
  const front = frontHit(0.7, 0.2);
  const empty = backFaceExit({ ...front, viewDirection: [0, 0, 1], indexOfRefraction: 1.5, thickness: 1.2, project, backDepth: () => 1, backNormal: () => null, shapeIdentifier: 1, backIdentifierAt: () => 1, reversed: false });
  assert.equal(empty, null);
});

test('a grazing exit that is totally internally reflected returns null so the ball lens path is used', () => {
  // The inside ray meets the back face at 60 degrees, past the glass critical angle (41.8 degrees).
  const grazingNormal = [0, Math.sin(Math.PI / 3), Math.cos(Math.PI / 3)];
  const found = backFaceExit({ position: [0, 0, 0.3], normal: [0, 0, 1], viewDirection: [0, 0, 1], indexOfRefraction: 1.5, thickness: 1.2, project, backDepth: () => project([0, 0, -0.3]).depth, backNormal: () => grazingNormal, shapeIdentifier: 1, backIdentifierAt: () => 1, reversed: false });
  assert.equal(found, null);
  assert.equal(refractDirection([0, 0, -1], grazingNormal.map(value => -value), 1.5), null, 'the same normal and ray are in total internal reflection');
});

test('only closed transmissive parts draw back faces; a cap with a continuing medium keeps the open-cap path', () => {
  assert.equal(drawsBackFaces({ transmission: 1, thickness: 0.4, mediumContinues: false }), true);
  assert.equal(drawsBackFaces({ transmission: 1, thickness: 0.4, mediumContinues: true }), false);
  assert.equal(drawsBackFaces({ transmission: 0, thickness: 0.4, mediumContinues: false }), false);
  assert.equal(drawsBackFaces({ transmission: 1, thickness: 0, mediumContinues: false }), false);
});

test('the shader carries the reference constants and the same exit math, in the same order', () => {
  const source = liquidFragmentSource();
  assert.ok(source.includes(glassBackFaceGlsl));
  assert.ok(glassBackFaceGlsl.includes(`BACK_REACH_PER_THICKNESS = ${BACK_REACH_PER_THICKNESS.toFixed(1)}`));
  // Same steps as backFaceExit: reach of the march, hit distance along the inside ray, the inward (negated) outward normal, TIR leaves the heuristic.
  const steps = ['inside = refract(incident, normal, 1.0 / indexOfRefraction)', 'thickness * BACK_REACH_PER_THICKNESS', 'encoded.xyz * 2.0 - 1.0', 'exitPosition = position + inside * hit.w', 'refract(inside, -normalize(outward), indexOfRefraction)', 'if (dot(direction, direction) < 0.5) return false;'];
  assert.ok(glassBackFaceGlsl.includes('abs(encoded.a * 255.0 - glassBackIdentifier()) > 0.5'), 'the shader checks the identifier like backFaceExit');
  assert.ok(glassBackFaceGlsl.includes(`mod(glassBackFirst + instanceEmission.w, ${BACK_IDENTIFIER_COUNT}.0) + 1.0`), 'the shader numbers instances like backIdentifier');
  let cursor = -1;
  for (const step of steps) {
    const next = glassBackFaceGlsl.indexOf(step, cursor + 1);
    assert.ok(next > cursor, `missing or out of order: ${step}`);
    cursor = next;
  }
  assert.ok(source.indexOf('glassBackFaceRay(worldPosition') > source.indexOf('ballLensRay(worldPosition'));
});

// Issue #3340: a back face drawn by another glass shape is not this ray's exit.
test('a ray does not take its exit from another shape back face (nested or overlapping glass)', () => {
  const front = frontHit(0.7, 0.2);
  const common = { ...front, viewDirection: [0, 0, 1], indexOfRefraction: 1.5, thickness: 1.2, project, backDepth, backNormal, reversed: false };
  assert.ok(backFaceExit({ ...common, shapeIdentifier: 1, backIdentifierAt: () => 1 }), 'its own back face is used');
  assert.equal(backFaceExit({ ...common, shapeIdentifier: 1, backIdentifierAt: () => 2 }), null, 'a back face of shape 2 gives no exit, the ball lens estimate stays');
});

test('instances of one frame get distinct identifiers from 1 to 254 that never read as nothing drawn', () => {
  const identifiers = new Set();
  for (let instance = 0; instance < BACK_IDENTIFIER_COUNT; instance++) identifiers.add(backIdentifier(0, instance));
  assert.equal(identifiers.size, BACK_IDENTIFIER_COUNT);
  assert.equal(Math.min(...identifiers), 1);
  assert.equal(Math.max(...identifiers), BACK_IDENTIFIER_COUNT);
  assert.equal(backIdentifier(3, 2), backIdentifier(4, 1), 'a batch starting at 3 numbers its third instance like a batch starting at 4 its second');
  assert.equal(backIdentifier(0, BACK_IDENTIFIER_COUNT), 1, 'past 254 the numbers wrap');
});
