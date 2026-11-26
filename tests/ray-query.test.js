import assert from 'node:assert/strict';
import test from 'node:test';
import { createTracer } from '../src/ray-query.js';
import { buildTriangleBvh } from '../src/triangle-bvh.js';

// A small deterministic generator, so the rays are the same on every run.
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// Random flat triangles inside a unit cube, enough of them that the tree has several levels.
function triangleSoup(random, triangleCount) {
  const positions = new Float32Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const centre = [random() * 4 - 2, random() * 4 - 2, random() * 4 - 2];
    for (let corner = 0; corner < 3; corner++) {
      for (let axis = 0; axis < 3; axis++) positions[triangle * 9 + corner * 3 + axis] = centre[axis] + (random() - 0.5);
      indices[triangle * 3 + corner] = triangle * 3 + corner;
    }
  }
  return { positions, indices };
}

// Every triangle tested in turn, with the same arithmetic as the tree walk.
function bruteForceNearest(positions, indices, origin, direction) {
  let nearestDistance = Infinity;
  let nearestTriangle = -1;
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const corner = index => [0, 1, 2].map(axis => positions[indices[triangle * 3 + index] * 3 + axis]);
    const [first, second, third] = [corner(0), corner(1), corner(2)];
    const edgeFirst = [0, 1, 2].map(axis => second[axis] - first[axis]);
    const edgeSecond = [0, 1, 2].map(axis => third[axis] - first[axis]);
    const cross = (left, right) => [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
    const dot = (left, right) => left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
    const pivot = cross(direction, edgeSecond);
    const determinant = dot(edgeFirst, pivot);
    if (determinant === 0) continue;
    const offset = [0, 1, 2].map(axis => origin[axis] - first[axis]);
    const firstWeight = dot(offset, pivot) / determinant;
    const query = cross(offset, edgeFirst);
    const secondWeight = dot(direction, query) / determinant;
    const distance = dot(edgeSecond, query) / determinant;
    if (firstWeight < 0 || firstWeight > 1 || secondWeight < 0 || firstWeight + secondWeight > 1) continue;
    if (distance < 0 || distance >= nearestDistance) continue;
    nearestDistance = distance;
    nearestTriangle = triangle;
  }
  return { nearestDistance, nearestTriangle };
}

function randomRay(random) {
  const direction = [random() - 0.5, random() - 0.5, random() - 0.5];
  const length = Math.hypot(...direction);
  return { origin: [random() * 5 - 2.5, random() * 5 - 2.5, random() * 5 - 2.5], direction: direction.map(value => value / length) };
}

test('the tracer finds the same nearest triangle and distance as testing every triangle', () => {
  const random = seededRandom(7);
  const { positions, indices } = triangleSoup(random, 120);
  const tracer = createTracer({ positions, indices, triangleOwner: new Uint32Array(120), bvh: buildTriangleBvh(positions, indices) });
  let hits = 0;
  for (let ray = 0; ray < 400; ray++) {
    const { origin, direction } = randomRay(random);
    const expected = bruteForceNearest(positions, indices, origin, direction);
    const result = tracer.trace(...origin, ...direction, Infinity, false);
    assert.equal(result.nearestTriangle, expected.nearestTriangle, `ray ${ray} nearest triangle`);
    assert.equal(result.nearestDistance, expected.nearestDistance, `ray ${ray} nearest distance`);
    if (expected.nearestTriangle >= 0) hits++;
  }
  assert.ok(hits > 50 && hits < 400, `the rays both hit and miss (${hits} hits)`);
});

test('the tracer respects the distance limit and reports an any-hit query as a hit that lies within it', () => {
  const random = seededRandom(11);
  const { positions, indices } = triangleSoup(random, 80);
  const tracer = createTracer({ positions, indices, triangleOwner: new Uint32Array(80), bvh: buildTriangleBvh(positions, indices) });
  for (let ray = 0; ray < 300; ray++) {
    const { origin, direction } = randomRay(random);
    const nearest = bruteForceNearest(positions, indices, origin, direction);
    const limit = 1.5;
    const limited = tracer.trace(...origin, ...direction, limit, false);
    assert.equal(limited.nearestTriangle >= 0, nearest.nearestDistance < limit, `ray ${ray} limited hit`);
    const anyHit = tracer.trace(...origin, ...direction, Infinity, true);
    assert.equal(anyHit.nearestTriangle >= 0, nearest.nearestTriangle >= 0, `ray ${ray} any hit`);
    assert.ok(anyHit.nearestDistance >= nearest.nearestDistance);
  }
});
