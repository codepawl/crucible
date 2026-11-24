import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { editMesh, validateTopology, meshFromGeometry, lintMesh, applyMeshEdits } from '../src/mesh.js';
import { normalizeMeshEdits, MESH_EDIT_OPERATIONS } from '../src/mesh-recipe.js';

const cube = () => meshFromGeometry(box(0, 1));

function run(mesh, edits) {
  const outcome = applyMeshEdits(mesh, edits);
  validateTopology(editMesh(outcome.mesh));
  return outcome;
}

function positionOf(mesh, vertex) {
  return [...mesh.positions.subarray(vertex * 3, vertex * 3 + 3)];
}

function vertexNear(mesh, point) {
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (positionOf(mesh, vertex).every((value, axis) => Math.abs(value - point[axis]) < 1e-5)) return vertex;
  }
  throw new Error(`no vertex near ${point}`);
}

function faceCorners(mesh) {
  const faces = [];
  for (let face = 0; face < mesh.faceCount; face++) {
    faces.push([...mesh.cornerVertices.subarray(mesh.faceOffsets[face], mesh.faceOffsets[face + 1])]);
  }
  return faces;
}

function assertCleanFaces(mesh) {
  const seen = new Set();
  for (const corners of faceCorners(mesh)) {
    assert.ok(corners.length >= 3, `a face with ${corners.length} corners`);
    assert.equal(new Set(corners).size, corners.length, `a face repeats a vertex: ${corners}`);
    const key = [...corners].sort((first, second) => first - second).join(',');
    assert.ok(!seen.has(key), `two faces share the corners ${key}`);
    seen.add(key);
  }
}

// The two ends of the cube's edge along x at the top front.
function topFrontEdge(mesh) {
  const first = vertexNear(mesh, [-0.5, 0.5, 0.5]);
  const second = vertexNear(mesh, [0.5, 0.5, 0.5]);
  return [first, second];
}

test('merge_verts joins two picked vertices into one at their centre', () => {
  const mesh = cube();
  const [first, second] = topFrontEdge(mesh);
  const { mesh: merged, results } = run(mesh, [{ op: 'merge_verts', vertices: [first, second] }]);
  assert.equal(merged.vertexCount, mesh.vertexCount - 1);
  assert.equal(merged.faceCount, mesh.faceCount);
  assert.equal(results[0].mergedVertices, 1);
  vertexNear(merged, [0, 0.5, 0.5]);
  assertCleanFaces(merged);
});

test('merge_verts at first and at last follow the order of the picks', () => {
  const mesh = cube();
  const [first, second] = topFrontEdge(mesh);
  const atFirst = run(mesh, [{ op: 'merge_verts', vertices: [first, second], at: 'first' }]).mesh;
  const atLast = run(mesh, [{ op: 'merge_verts', vertices: [first, second], at: 'last' }]).mesh;
  vertexNear(atFirst, [-0.5, 0.5, 0.5]);
  assert.throws(() => vertexNear(atFirst, [0.5, 0.5, 0.5]));
  vertexNear(atLast, [0.5, 0.5, 0.5]);
  assert.throws(() => vertexNear(atLast, [-0.5, 0.5, 0.5]));
  const reversed = run(mesh, [{ op: 'merge_verts', vertices: [second, first], at: 'first' }]).mesh;
  vertexNear(reversed, [0.5, 0.5, 0.5]);
});

test('merge_verts is deterministic', () => {
  const mesh = cube();
  const [first, second] = topFrontEdge(mesh);
  const edits = [{ op: 'merge_verts', vertices: [first, second], at: 'center' }];
  const once = run(mesh, edits).mesh;
  const twice = run(mesh, edits).mesh;
  assert.deepEqual(Buffer.from(once.positions.buffer), Buffer.from(twice.positions.buffer));
  assert.deepEqual(once.cornerVertices, twice.cornerVertices);
  assert.deepEqual(once.faceOffsets, twice.faceOffsets);
});

test('merge_verts drops the faces that collapse and keeps the mesh valid', () => {
  const mesh = cube();
  const frontCorners = [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]].map(point => vertexNear(mesh, point));
  const { mesh: merged, results } = run(mesh, [{ op: 'merge_verts', vertices: frontCorners, at: 'last' }]);
  assert.equal(results[0].mergedVertices, 2);
  assert.equal(results[0].removedFaces, 1, 'the front quad is left with two corners');
  assert.equal(merged.faceCount, mesh.faceCount - 1);
  assertCleanFaces(merged);
});

test('merge_verts collapse merges each connected group at its own centre and leaves apart groups apart', () => {
  const mesh = cube();
  const frontPair = topFrontEdge(mesh);
  const backPair = [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5]].map(point => vertexNear(mesh, point));
  const { mesh: collapsed, results } = run(mesh, [{ op: 'merge_verts', vertices: [...frontPair, ...backPair], at: 'collapse' }]);
  assert.equal(results[0].mergedVertices, 2);
  assert.equal(collapsed.vertexCount, mesh.vertexCount - 2);
  vertexNear(collapsed, [0, 0.5, 0.5]);
  vertexNear(collapsed, [0, -0.5, -0.5]);
  const center = run(mesh, [{ op: 'merge_verts', vertices: [...frontPair, ...backPair], at: 'center' }]).mesh;
  assert.equal(center.vertexCount, mesh.vertexCount - 3);
});

test('merge_verts collapse refuses vertices that share no edge', () => {
  const mesh = cube();
  const apart = [[-0.5, 0.5, 0.5], [0.5, -0.5, -0.5]].map(point => vertexNear(mesh, point));
  assert.throws(() => run(mesh, [{ op: 'merge_verts', vertices: apart, at: 'collapse' }]), /share an edge for collapse/);
  assert.equal(run(mesh, [{ op: 'merge_verts', vertices: apart, at: 'center' }]).mesh.vertexCount, mesh.vertexCount - 1);
});

test('merge_verts names what to pass when the picked list is wrong', () => {
  const mesh = cube();
  assert.throws(() => normalizeMeshEdits([{ op: 'merge_verts' }]), /edits\[0\]\.vertices/);
  assert.throws(() => normalizeMeshEdits([{ op: 'merge_verts', vertices: [3] }]), /2 to 4096 different whole vertex indices/);
  assert.throws(() => normalizeMeshEdits([{ op: 'merge_verts', vertices: [1, 2], at: 'cursor' }]), /one of "center", "first", "last", "collapse"/);
  assert.throws(() => run(mesh, [{ op: 'merge_verts', vertices: [0, 0] }]), /listed twice/);
  assert.throws(() => run(mesh, [{ op: 'merge_verts', vertices: [0, 999] }]), /from 0 to \d+/);
  assert.ok(MESH_EDIT_OPERATIONS.merge_verts.fields.includes('at'));
});

test('dissolving an edge loop with its straight vertices leaves clean faces', () => {
  const sliced = run(cube(), [{ op: 'loop_cut', name: 'cut', edges: { along: [0, 1, 0] } }]).mesh;
  const loop = [];
  for (let edge = 0; edge < sliced.edgeCount; edge++) {
    const first = sliced.edgeVertices[edge * 2];
    const second = sliced.edgeVertices[edge * 2 + 1];
    if (Math.abs(sliced.positions[first * 3 + 1]) < 1e-6 && Math.abs(sliced.positions[second * 3 + 1]) < 1e-6) loop.push([first, second]);
  }
  assert.equal(loop.length, 4);
  const { mesh: dissolved, results } = run(sliced, [{ op: 'dissolve_edges', edges: { edges: loop }, removeStraight: true }]);
  assert.equal(dissolved.faceCount, 6);
  assert.equal(dissolved.vertexCount, 8);
  assert.equal(results[0].removedStraight, 4);
  assertCleanFaces(dissolved);
  assert.deepEqual(lintMesh(dissolved).problems, []);
  assert.ok(faceCorners(dissolved).every(corners => corners.length === 4));
  const kept = run(sliced, [{ op: 'dissolve_edges', edges: { edges: loop } }]).mesh;
  assert.equal(kept.vertexCount, 12);
});

test('dissolve_edges removeStraight removes the two ends of a single cube edge, which are left with two edges', () => {
  const mesh = cube();
  const [first, second] = topFrontEdge(mesh);
  const outcome = run(mesh, [{ op: 'dissolve_edges', edges: { edges: [[first, second]] }, removeStraight: true }]);
  assertCleanFaces(outcome.mesh);
  assert.equal(outcome.mesh.faceCount, mesh.faceCount - 1);
  assert.equal(outcome.results[0].removedStraight, 2);
  assert.equal(outcome.mesh.vertexCount, mesh.vertexCount - 2);
  assert.throws(() => normalizeMeshEdits([{ op: 'dissolve_edges', edges: { all: true }, removeStraight: 'yes' }]), /removeStraight/);
});
