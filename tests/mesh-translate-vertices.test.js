import assert from 'node:assert/strict';
import test from 'node:test';
import { grid } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits } from '../src/mesh.js';
import { FALLOFF_CURVES, spatialFalloffWeights } from '../src/mesh-ops.js';

const SPACING = 0.1;

function plane() {
  return meshFromGeometry(grid(10));
}

function vertexAt(mesh, x, y) {
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    if (Math.abs(mesh.positions[vertex * 3] - x) < 1e-5 && Math.abs(mesh.positions[vertex * 3 + 1] - y) < 1e-5) return vertex;
  }
  throw new Error(`no vertex at ${x}, ${y}`);
}

function liftOf(before, after, vertex) {
  return after.positions[vertex * 3 + 2] - before.positions[vertex * 3 + 2];
}

test('moving one vertex of a dense plane with a falloff raises a smooth hill that fades to nothing at the radius', () => {
  const before = plane();
  const centre = vertexAt(before, 0, 0);
  const radius = 0.35;
  const { mesh: after } = applyMeshEdits(before, [{ op: 'translate', verts: { vertices: [centre] }, offset: [0, 0, 0.4], falloff: { radius, curve: 'smooth' } }]);
  assert.ok(Math.abs(liftOf(before, after, centre) - 0.4) < 1e-5, 'the picked vertex moves the whole offset');
  let raised = 0;
  for (let vertex = 0; vertex < before.vertexCount; vertex += 1) {
    const distance = Math.hypot(before.positions[vertex * 3], before.positions[vertex * 3 + 1]);
    const lift = liftOf(before, after, vertex);
    if (distance > radius) {
      assert.equal(lift, 0, `vertex ${vertex} at ${distance.toFixed(2)} is outside the radius and stays`);
      continue;
    }
    if (vertex === centre) continue;
    raised += 1;
    const expected = 0.4 * FALLOFF_CURVES.smooth(distance / radius);
    assert.ok(Math.abs(lift - expected) < 1e-5, `vertex ${vertex} rises by the smooth curve at ${distance.toFixed(2)}`);
    assert.ok(lift > 0 && lift < 0.4);
  }
  assert.ok(raised >= 20, `a hill: ${raised} neighbours rise`);
  const near = liftOf(before, after, vertexAt(before, SPACING, 0));
  const middle = liftOf(before, after, vertexAt(before, 2 * SPACING, 0));
  const far = liftOf(before, after, vertexAt(before, 3 * SPACING, 0));
  assert.ok(near > middle && middle > far && far > 0, 'neighbours rise less the farther they are');
});

test('the curve picks the shape of the hill: constant lifts every vertex in the radius the same', () => {
  const before = plane();
  const centre = vertexAt(before, 0, 0);
  const { mesh: after } = applyMeshEdits(before, [{ op: 'translate', verts: { vertices: [centre] }, offset: [0, 0, 0.2], falloff: { radius: 0.25, curve: 'constant' } }]);
  assert.ok(Math.abs(liftOf(before, after, vertexAt(before, 2 * SPACING, 0)) - 0.2) < 1e-5);
  assert.equal(liftOf(before, after, vertexAt(before, 3 * SPACING, 0)), 0);
});

test('a vertex selection without a falloff moves only those vertices (counted in movedVertices)', () => {
  const before = plane();
  const centre = vertexAt(before, 0, 0);
  const { mesh: after, results } = applyMeshEdits(before, [{ op: 'translate', verts: { vertices: [centre] }, offset: [0, 0, 0.3] }]);
  assert.equal(results[0].movedVertices, 1);
  assert.ok(Math.abs(liftOf(before, after, centre) - 0.3) < 1e-5);
});

test('the preview weights are the weights the replayed edit applies', () => {
  const before = plane();
  const centre = vertexAt(before, 0, 0);
  const falloff = { radius: 0.35, curve: 'sphere' };
  const weights = spatialFalloffWeights(before.positions, before.vertexCount, new Set([centre]), falloff);
  const { mesh: after } = applyMeshEdits(before, [{ op: 'translate', verts: { vertices: [centre] }, offset: [0, 0, 1], falloff }]);
  for (let vertex = 0; vertex < before.vertexCount; vertex += 1) {
    assert.ok(Math.abs(liftOf(before, after, vertex) - (weights.get(vertex) ?? 0)) < 1e-5);
  }
});
