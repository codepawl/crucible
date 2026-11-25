import test from 'node:test';
import assert from 'node:assert/strict';
import { BEVEL_RADIUS_SHARE_HIGH, BEVEL_RADIUS_SHARE_LOW, BODY_REACH_PER_THICKNESS, ballLensExit, ballLensGlsl, bevelSlabShare } from '../src/glass-ball-lens.js';
import { glassBodyDepth } from '../src/glass-back-face.js';
import { liquidFragmentSource } from '../src/shaders.js';
import '../src/liquid-shader.js';

// Issue #3256: a thick transmissive box has a bevel of small radius (0.156 m) on a body 1.3 m deep. The ball lens exit read that radius as a
// small glass ball and minified the wall behind the bevel into stripes; next to a deep body the bevel keeps the slab exit instead.
const project = point => ({ x: (point[0] + 2) / 4, y: (point[1] + 2) / 4, depth: (10 - point[2]) / 20 });
const halfSize = 0.65;
// The back faces of a box of half size 0.65 seen along -z by an orthographic camera: a flat face at z = -0.65 behind the square.
const boxBackDepth = (x, y) => (Math.abs(x * 4 - 2) < halfSize && Math.abs(y * 4 - 2) < halfSize ? project([0, 0, -halfSize]).depth : 1);
const boxBack = { backDepth: boxBackDepth, backNormal: () => [0, 0, -1], backIdentifierAt: (x, y) => (boxBackDepth(x, y) < 1 ? 1 : 0) };
const normalize = vector => vector.map(value => value / Math.hypot(...vector));
const angleBetween = (first, second) => Math.acos(Math.min(1, first[0] * second[0] + first[1] * second[1] + first[2] * second[2]));

const bevelRadius = 0.12 * 1.3;
const bevelFragment = { position: [0, 0.55, 0.62], normal: normalize([0, 0.4, 0.9]), viewDirection: [0, 0, 1] };
const bevelOptics = { indexOfRefraction: 1.3, radius: bevelRadius, thickness: 0.2 };
const bodyDepthOfBevel = fragment => glassBodyDepth({ ...fragment, thickness: 0.2, nearest: boxBack, project, reversed: false });
// Further round the bevel the surface faces more sideways, where the old exit bent the ray most.
const steepBevelFragment = { position: [0, 0.58, 0.55], normal: normalize([0, 0.8, 0.6]), viewDirection: [0, 0, 1] };
const flatPane = fragment => ballLensExit({ ...fragment, indexOfRefraction: 1.3, radius: 1e6, thickness: 0.2 });

test('the body depth is the distance along the inward normal to the nearest back face', () => {
  const depth = bodyDepthOfBevel(bevelFragment);
  assert.ok(Math.abs(depth - (0.62 + halfSize) / 0.9) < 0.05, `expected about ${(0.62 + halfSize) / 0.9}, got ${depth}`);
});

test('a body deeper than the search reach counts as at least that deep, and no back face means unknown', () => {
  const steep = { ...bevelFragment, normal: normalize([0, 0.9, 0.4]) };
  assert.equal(glassBodyDepth({ ...steep, thickness: 0.1, nearest: boxBack, project, reversed: false }), 0.1 * BODY_REACH_PER_THICKNESS);
  const nothingDrawn = { ...boxBack, backIdentifierAt: () => 0 };
  assert.ok(Number.isNaN(glassBodyDepth({ ...bevelFragment, thickness: 0.2, nearest: nothingDrawn, project, reversed: false })));
});

test('a bevel on a deep body takes the slab exit while without the body depth it bent like a small ball', () => {
  const bodyDepth = bodyDepthOfBevel(steepBevelFragment);
  const withBody = ballLensExit({ ...steepBevelFragment, ...bevelOptics, bodyDepth });
  const slab = flatPane(steepBevelFragment);
  assert.ok(angleBetween(withBody.direction, slab.direction) < 1e-6, 'the exit direction is the slab one');
  assert.ok(Math.hypot(...withBody.exitPosition.map((value, axis) => value - slab.exitPosition[axis])) < 1e-6, 'the exit point is the slab one');
  const ballLike = ballLensExit({ ...steepBevelFragment, ...bevelOptics });
  assert.ok(angleBetween(ballLike.direction, slab.direction) > 0.05, 'without the body depth the small radius still bends the ray like a ball');
});

test('a closed ball keeps the ball lens exit', () => {
  const ballRadius = 0.65;
  const ballBack = { backDepth: (x, y) => { const px = x * 4 - 2; const py = y * 4 - 2; const rest = ballRadius ** 2 - px * px - py * py; return rest > 0 ? project([px, py, -Math.sqrt(rest)]).depth : 1; }, backNormal: () => [0, 0, -1], backIdentifierAt: () => 1 };
  for (const angle of [0, 0.4, 0.8]) {
    const normal = [Math.sin(angle), 0, Math.cos(angle)];
    const position = normal.map(value => value * ballRadius);
    const fragment = { position, normal, viewDirection: [0, 0, 1] };
    const bodyDepth = glassBodyDepth({ ...fragment, thickness: 2 * ballRadius, nearest: ballBack, project, reversed: false });
    assert.ok(bodyDepth > 0 && bevelSlabShare(ballRadius, bodyDepth) < 0.01, `at ${angle} rad the radius is a large share of the body (${(ballRadius / bodyDepth).toFixed(2)})`);
    const optics = { indexOfRefraction: 1.5, radius: ballRadius, thickness: 2 * ballRadius };
    assert.deepEqual(ballLensExit({ ...fragment, ...optics, bodyDepth }), ballLensExit({ ...fragment, ...optics }));
  }
});

test('the slab share runs from the bevel share to the ball share and ignores an unknown body', () => {
  assert.equal(bevelSlabShare(BEVEL_RADIUS_SHARE_LOW, 1), 1);
  assert.equal(bevelSlabShare(BEVEL_RADIUS_SHARE_HIGH, 1), 0);
  assert.equal(bevelSlabShare(0.5, 1), 0);
  assert.ok(bevelSlabShare(0.22, 1) > 0 && bevelSlabShare(0.22, 1) < 1);
  for (const unknown of [Number.NaN, 0, -1, Infinity]) assert.equal(bevelSlabShare(0.1, unknown), 0);
});

test('the shader follows the reference: it passes the body depth, found only where back faces exist', () => {
  assert.match(ballLensGlsl, /float bevelSlabShare\(float radius, float bodyDepth\)/);
  assert.match(ballLensGlsl, /max\(smoothstep\(1\.0, 1\.0 \+ SPHERE_SLAB_BLEND_BAND, sphereChord \/ slabChord\), bevelSlabShare\(radius, bodyDepth\)\)/);
  assert.match(ballLensGlsl, new RegExp(`BEVEL_RADIUS_SHARE_LOW = ${BEVEL_RADIUS_SHARE_LOW.toFixed(2)}`));
  const liquid = liquidFragmentSource();
  assert.match(liquid, /glassBackEnabled > 0\.5 \? glassBodyDepth\(worldPosition, normal, thickness\) : 0\.0/);
  assert.ok(liquid.indexOf('glassBodyDepth(worldPosition') < liquid.indexOf('ballLensRay(worldPosition'));
});
