import test from 'node:test';
import assert from 'node:assert/strict';
import { BACK_IDENTIFIER_COUNT, BACK_REACH_PER_THICKNESS, SHELL_PAIR_LIMIT, backFaceExit, backIdentifier, drawsBackFaces, glassBackFaceGlsl, glassShellsNested } from '../src/glass-back-face.js';
import { drawGlassBackFaces } from '../src/liquid-renderer.js';
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

const ownLayer = { backDepth, backNormal, backIdentifierAt: () => 1 };
const angleBetween = (first, second) => Math.acos(Math.min(1, first[0] * second[0] + first[1] * second[1] + first[2] * second[2]));

test('the back-face exit bends the ray where it leaves a closed non-spherical shape', () => {
  const front = frontHit(0.7, 0.2);
  const found = backFaceExit({ ...front, viewDirection: [0, 0, 1], indexOfRefraction: 1.5, thickness: 1.2, project, nearest: ownLayer, shapeIdentifier: 1, reversed: false });
  const exact = exactExit(front.position, front.normal, 1.5);
  assert.ok(found, 'the back face is found');
  assert.ok(angleBetween(found.direction, exact.direction) < 0.02, 'exit direction within 1 degree of the exact one');
  assert.ok(Math.hypot(...found.exitPosition.map((value, axis) => value - exact.exitPosition[axis])) < 0.02, 'exit point within 2 cm');
  const estimate = ballLensExit({ ...front, viewDirection: [0, 0, 1], indexOfRefraction: 1.5, radius: 0.6, thickness: 1.2 });
  assert.ok(angleBetween(estimate.direction, exact.direction) > 0.05, 'the sphere estimate is visibly off for this shape');
});

test('a ray that finds no back face returns null so the shader keeps the thickness heuristic', () => {
  const front = frontHit(0.7, 0.2);
  const empty = backFaceExit({ ...front, viewDirection: [0, 0, 1], indexOfRefraction: 1.5, thickness: 1.2, project, nearest: { backDepth: () => 1, backNormal: () => null, backIdentifierAt: () => 1 }, shapeIdentifier: 1, reversed: false });
  assert.equal(empty, null);
});

test('a grazing exit that is totally internally reflected returns null so the ball lens path is used', () => {
  // The inside ray meets the back face at 60 degrees, past the glass critical angle (41.8 degrees).
  const grazingNormal = [0, Math.sin(Math.PI / 3), Math.cos(Math.PI / 3)];
  const found = backFaceExit({ position: [0, 0, 0.3], normal: [0, 0, 1], viewDirection: [0, 0, 1], indexOfRefraction: 1.5, thickness: 1.2, project, nearest: { backDepth: () => project([0, 0, -0.3]).depth, backNormal: () => grazingNormal, backIdentifierAt: () => 1 }, shapeIdentifier: 1, reversed: false });
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
  assert.ok(glassBackFaceGlsl.includes('glassBackFarEnabled > 0.5 && abs(encoded.a * 255.0 - own) > 0.5'), 'the shader checks the identifier only while the second layer is drawn, like backFaceExit');
  assert.ok(glassBackFaceGlsl.includes(`mod(glassBackFirst + instanceEmission.w, ${BACK_IDENTIFIER_COUNT}.0) + 1.0`), 'the shader numbers instances like backIdentifier');
  let cursor = -1;
  for (const step of steps) {
    const next = glassBackFaceGlsl.indexOf(step, cursor + 1);
    assert.ok(next > cursor, `missing or out of order: ${step}`);
    cursor = next;
  }
  assert.ok(source.indexOf('glassBackFaceRay(worldPosition') > source.indexOf('ballLensRay(worldPosition'));
});

// Issue #3340: with one shell inside another the nearest back face can be the inner shell's, so the outer ray reads the farthest layer.
const commonRay = () => ({ ...frontHit(0.7, 0.2), viewDirection: [0, 0, 1], indexOfRefraction: 1.5, thickness: 1.2, project, reversed: false });
const layerDrawnBy = identifier => ({ backDepth, backNormal, backIdentifierAt: () => identifier });

test('without a second layer the nearest back face is the exit, whichever shell drew it', () => {
  const found = backFaceExit({ ...commonRay(), shapeIdentifier: 1, nearest: layerDrawnBy(2) });
  assert.ok(found, 'overlapping shells keep the nearest back face as before');
  assert.deepEqual(found, backFaceExit({ ...commonRay(), shapeIdentifier: 1, nearest: layerDrawnBy(1) }));
});

test('with a second layer the exit comes from the layer that holds its own shape', () => {
  const nearest = layerDrawnBy(2);
  assert.ok(backFaceExit({ ...commonRay(), shapeIdentifier: 1, nearest, farthest: layerDrawnBy(1) }), 'the farthest layer holds the outer shell exit');
  assert.ok(backFaceExit({ ...commonRay(), shapeIdentifier: 2, nearest, farthest: layerDrawnBy(1) }), 'the inner shell keeps the nearest layer');
  assert.equal(backFaceExit({ ...commonRay(), shapeIdentifier: 3, nearest, farthest: layerDrawnBy(1) }), null, 'neither layer holds shape 3, the ball lens estimate stays');
  assert.equal(backFaceExit({ ...commonRay(), shapeIdentifier: 1, nearest: layerDrawnBy(0), farthest: layerDrawnBy(1) }), null, 'nothing drawn at the nearest layer means no back face here');
});

const shell = (minimum, maximum) => ({ minimum, maximum });
const outerShell = shell([-1, 0, -1], [1, 2, 1]);

test('the second layer is wanted only when one closed shell is inside another', () => {
  assert.equal(glassShellsNested([outerShell]), false, 'a single shell');
  assert.equal(glassShellsNested([]), false, 'no glass');
  assert.equal(glassShellsNested([outerShell, shell([-0.3, 0.5, -0.3], [0.3, 1.1, 0.3])]), true, 'a small shell inside a large one');
  assert.equal(glassShellsNested([shell([-0.3, 0.5, -0.3], [0.3, 1.1, 0.3]), outerShell]), true, 'in either order');
  assert.equal(glassShellsNested([outerShell, shell([0.5, 0.5, -0.3], [1.5, 1.1, 0.3])]), false, 'overlapping shells that do not nest');
  assert.equal(glassShellsNested([outerShell, shell([3, 0, -1], [5, 2, 1])]), false, 'shells apart');
  const crowd = Array.from({ length: SHELL_PAIR_LIMIT + 1 }, () => outerShell);
  assert.equal(glassShellsNested(crowd), false, 'a crowd is not compared pair by pair');
});

// A recording stand-in for the WebGL context: every method is a no-op, and drawn back-face layers are counted.
function backFaceDraws(shells) {
  const recorded = { draws: 0, clears: 0 };
  const context = new Proxy({}, { get: (_, name) => (name === 'drawElementsInstanced' ? () => recorded.draws++ : name === 'clear' ? () => recorded.clears++ : typeof name === 'string' && /^[A-Z_0-9]+$/.test(name) ? 1 : () => ({})) });
  const renderer = { context, liquidUniforms: new Proxy({}, { get: () => 0 }), reversedDepth: false, multisampleFramebuffer: {}, liquidClipLocations: null };
  const unitBox = { positions: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]) };
  const batches = shells.map(({ minimum, maximum }) => {
    const matrix = new Float32Array([maximum[0] - minimum[0], 0, 0, 0, 0, maximum[1] - minimum[1], 0, 0, 0, 0, maximum[2] - minimum[2], 0, (minimum[0] + maximum[0]) / 2, (minimum[1] + maximum[1]) / 2, (minimum[2] + maximum[2]) / 2, 1]);
    const layerState = new Float32Array(32);
    layerState[9] = 1;
    layerState[11] = 1;
    return { layerState, parts: [{ geometry: unitBox, matrix, material: {} }], instanceCount: 1, indexCount: 36, vertexArray: {}, opacity: 1 };
  });
  const result = drawGlassBackFaces(renderer, batches, 64, 64);
  return { ...recorded, result };
}

test('the renderer draws the second back-face layer for nested glass only', () => {
  const inner = shell([-0.3, 0.5, -0.3], [0.3, 1.1, 0.3]);
  assert.equal(backFaceDraws([]).result, null, 'no glass draws nothing');
  const single = backFaceDraws([outerShell]);
  assert.equal(single.draws, 1, 'one shell: one back-face draw');
  assert.equal(single.result.farLayer, false);
  const overlapping = backFaceDraws([outerShell, shell([0.5, 0.5, -0.3], [1.5, 1.1, 0.3])]);
  assert.equal(overlapping.draws, 2, 'overlapping shells: one back-face draw each, no second layer');
  assert.equal(overlapping.result.farLayer, false);
  const nested = backFaceDraws([outerShell, inner]);
  assert.equal(nested.draws, 4, 'nested shells: the back faces are drawn again for the farthest layer');
  assert.equal(nested.result.farLayer, true);
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
