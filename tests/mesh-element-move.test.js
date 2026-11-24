import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits } from '../src/mesh.js';
import { normalizeMeshEdits } from '../src/mesh-recipe.js';
import { MAX_SELECTED_ELEMENTS } from '../src/mesh-operations.js';

// #3262: translate and transform_selection take vertices ({ verts }) or edges ({ edges }) as well as faces, and every
// edge-taking edit accepts { "edges": [[a, b], ...] }, an edge named by the two vertices it joins.

const cube = () => meshFromGeometry(box(0, 1));

function positionOf(mesh, vertex) {
  return [...mesh.positions.subarray(vertex * 3, vertex * 3 + 3)];
}

function positionsOf(mesh) {
  return Array.from({ length: mesh.vertexCount }, (_, vertex) => positionOf(mesh, vertex));
}

function vertexAt(mesh, x, y, z) {
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const [px, py, pz] = positionOf(mesh, vertex);
    if (Math.abs(px - x) < 1e-6 && Math.abs(py - y) < 1e-6 && Math.abs(pz - z) < 1e-6) return vertex;
  }
  throw new Error(`no vertex at ${x} ${y} ${z}`);
}

// Corners of the unit cube, so a test reads "the top front edge" instead of raw indices.
const corners = mesh => ({
  topFrontLeft: vertexAt(mesh, -0.5, 0.5, 0.5),
  topFrontRight: vertexAt(mesh, 0.5, 0.5, 0.5),
  topBackRight: vertexAt(mesh, 0.5, 0.5, -0.5),
  bottomFrontLeft: vertexAt(mesh, -0.5, -0.5, 0.5),
  bottomFrontRight: vertexAt(mesh, 0.5, -0.5, 0.5),
});

function runOne(edit, mesh = cube()) {
  return applyMeshEdits(mesh, [edit]);
}

function movedVertices(before, after) {
  return before.map((point, vertex) => (point.some((component, axis) => component !== after[vertex][axis]) ? vertex : -1)).filter(vertex => vertex >= 0);
}

test('verts moves exactly the listed vertices by the offset', () => {
  const before = positionsOf(cube());
  const { topFrontLeft } = corners(cube());
  const { mesh, results } = runOne({ op: 'translate', verts: { vertices: [topFrontLeft] }, offset: [0, 0.25, 0] });
  const after = positionsOf(mesh);
  assert.deepEqual(movedVertices(before, after), [topFrontLeft]);
  assert.ok(Math.abs(after[topFrontLeft][1] - 0.75) < 1e-6);
  assert.equal(results[0].movedVertices, 1);
  assert.equal(results[0].selectedVertices, 1);
});

test('verts moves more than the 19 vertices a set_position mask can reach', () => {
  const subdivided = applyMeshEdits(cube(), [{ op: 'subdivide', levels: 2 }]).mesh;
  const listed = Array.from({ length: 60 }, (_, vertex) => vertex);
  const { mesh, results } = runOne({ op: 'translate', verts: { vertices: listed }, offset: [1, 0, 0] }, subdivided);
  assert.equal(results[0].movedVertices, 60);
  assert.deepEqual(movedVertices(positionsOf(subdivided), positionsOf(mesh)), listed);
});

test('edges moves both ends of each edge, and a vertex shared by two edges moves once', () => {
  const start = cube();
  const { topFrontLeft, topFrontRight, topBackRight } = corners(start);
  const before = positionsOf(start);
  const { mesh, results } = runOne({ op: 'translate', edges: { edges: [[topFrontLeft, topFrontRight], [topBackRight, topFrontRight]] }, offset: [0, 1, 0] });
  const after = positionsOf(mesh);
  assert.deepEqual(movedVertices(before, after).sort(), [topFrontLeft, topFrontRight, topBackRight].sort());
  assert.equal(results[0].selectedVertices, 3);
  assert.equal(results[0].movedVertices, 3);
  assert.ok(Math.abs(after[topFrontRight][1] - 1.5) < 1e-6, 'the shared corner moved once, not twice');
});

test('an edge pair reads the same in either order and the edge may be a boundary edge', () => {
  const start = cube();
  const { topFrontLeft, topFrontRight } = corners(start);
  const forward = runOne({ op: 'translate', edges: { edges: [[topFrontLeft, topFrontRight]] }, offset: [0, 1, 0] }).mesh;
  const backward = runOne({ op: 'translate', edges: { edges: [[topFrontRight, topFrontLeft]] }, offset: [0, 1, 0] }).mesh;
  assert.deepEqual(positionsOf(forward), positionsOf(backward));
  const opened = applyMeshEdits(start, [{ op: 'delete', select: { tag: 'top' } }]).mesh;
  const boundary = runOne({ op: 'translate', edges: { edges: [[topFrontLeft, topFrontRight]] }, offset: [0, 1, 0] }, opened);
  assert.equal(boundary.results[0].movedVertices, 2);
});

test('falloff pulls neighbours of a vertex selection by the curve, the selected vertex fully', () => {
  const start = cube();
  const { topFrontLeft, topFrontRight, bottomFrontLeft } = corners(start);
  const { mesh } = runOne({ op: 'translate', verts: { vertices: [topFrontLeft] }, offset: [0, 0, 1], falloff: { radius: 2, curve: 'linear', connected: true } });
  assert.ok(Math.abs(positionOf(mesh, topFrontLeft)[2] - 1.5) < 1e-6);
  assert.ok(Math.abs(positionOf(mesh, topFrontRight)[2] - 1.0) < 1e-5, 'a neighbour one edge away moves by half the offset');
  assert.ok(positionOf(mesh, bottomFrontLeft)[2] > 0.5);
});

test('transform_selection turns and scales a vertex selection and an edge selection', () => {
  const start = cube();
  const { topFrontLeft, topFrontRight } = corners(start);
  const edge = runOne({ op: 'transform_selection', edges: { edges: [[topFrontLeft, topFrontRight]] }, scale: [2, 1, 1] }).mesh;
  assert.ok(Math.abs(positionOf(edge, topFrontLeft)[0] + 1) < 1e-6);
  assert.ok(Math.abs(positionOf(edge, topFrontRight)[0] - 1) < 1e-6);
  const turned = runOne({ op: 'transform_selection', verts: { vertices: [topFrontLeft, topFrontRight] }, pivot: [0, 0.5, 0.5], rotation: { axis: [0, 0, 1], angle: Math.PI } }).mesh;
  assert.ok(Math.abs(positionOf(turned, topFrontLeft)[0] - 0.5) < 1e-5);
  assert.ok(Math.abs(positionOf(turned, topFrontRight)[0] + 0.5) < 1e-5);
});

test('the face form still works and a vertex move of a face\'s vertices gives the same positions', () => {
  const start = cube();
  const topVertices = positionsOf(start).map((point, vertex) => (point[1] > 0 ? vertex : -1)).filter(vertex => vertex >= 0);
  const byFaces = runOne({ op: 'translate', select: { tag: 'top' }, offset: [0.1, 0.2, 0.3] }).mesh;
  const byVertices = runOne({ op: 'translate', verts: { vertices: topVertices }, offset: [0.1, 0.2, 0.3] }).mesh;
  assert.deepEqual(Array.from(byVertices.positions), Array.from(byFaces.positions));
});

test('an old recipe normalizes and runs as before: select defaults to every face and no new key appears', () => {
  const [normalized] = normalizeMeshEdits([{ op: 'translate', offset: [1, 0, 0] }]);
  assert.deepEqual(normalized, { op: 'translate', select: { all: true }, offset: [1, 0, 0] });
  const [transform] = normalizeMeshEdits([{ op: 'transform_selection', select: { tag: 'top' }, scale: 2 }]);
  assert.deepEqual(Object.keys(transform).sort(), ['op', 'scale', 'select']);
  const { mesh, results } = runOne({ op: 'translate', offset: [1, 0, 0] });
  assert.equal(results[0].movedVertices, 8);
  assert.equal(results[0].selectedVertices, undefined);
  assert.equal(results[0].selected, 6);
  assert.ok(positionsOf(mesh).every((point, vertex) => Math.abs(point[0] - positionOf(cube(), vertex)[0] - 1) < 1e-6));
});

// Every op that takes an edge rule accepts vertex pairs. The cube's top front edge is one edge of the mesh.
test('bevel, loop_cut, dissolve_edges and subdivide_edges accept an edge rule of vertex pairs', () => {
  const start = cube();
  const { topFrontLeft, topFrontRight, bottomFrontLeft, bottomFrontRight } = corners(start);
  const topFront = { edges: [[topFrontLeft, topFrontRight]] };
  const verticalFront = { edges: [[topFrontLeft, bottomFrontLeft], [topFrontRight, bottomFrontRight]] };
  const bevel = runOne({ op: 'bevel', edges: topFront, width: 0.1 });
  assert.equal(bevel.results[0].edges, 1);
  const cut = runOne({ op: 'loop_cut', edges: { edges: [[topFrontLeft, bottomFrontLeft]] } });
  assert.ok(cut.mesh.vertexCount > start.vertexCount);
  const dissolved = runOne({ op: 'dissolve_edges', edges: topFront });
  assert.equal(dissolved.mesh.faceCount, start.faceCount - 1);
  const subdivided = runOne({ op: 'subdivide_edges', edges: verticalFront });
  assert.ok(subdivided.mesh.vertexCount > start.vertexCount);
  assert.deepEqual(subdivided.mesh.positions.length / 3, subdivided.mesh.vertexCount);
});

test('extrude_edges, split_edges and crease take the pairs too', () => {
  const opened = applyMeshEdits(cube(), [{ op: 'delete', select: { tag: 'top' } }]).mesh;
  const { topFrontLeft, topFrontRight } = corners(cube());
  const pairs = { edges: [[topFrontLeft, topFrontRight]] };
  assert.ok(runOne({ op: 'extrude_edges', edges: pairs, offset: [0, 1, 0] }, opened).mesh.vertexCount > opened.vertexCount);
  assert.equal(runOne({ op: 'split_edges', edges: pairs }).results[0].splitEdges, 1);
  assert.equal(runOne({ op: 'subdivide', levels: 1, crease: pairs }).results[0].levels, 1);
});

test('one selection per edit: select, verts and edges together are refused with what to pass', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'translate', select: { all: true }, verts: { all: true }, offset: [0, 1, 0] }]), /edits\[0\]\.verts: got .*exactly one of select \(faces\), verts \(vertices\) or edges/);
  assert.throws(() => normalizeMeshEdits([{ op: 'transform_selection', verts: { all: true }, edges: { all: true }, scale: 2 }]), /edits\[0\]\.edges: got .*exactly one of select/);
  assert.throws(() => normalizeMeshEdits([{ op: 'extrude_individual', verts: { all: true }, offset: 1 }]), /one of the fields extrude_individual takes/);
});

test('bad vertex and edge selections say what was passed and what to pass', () => {
  assert.throws(() => normalizeMeshEdits([{ op: 'translate', verts: [0, 1], offset: [0, 1, 0] }]), /edits\[0\]\.verts: got \[0,1\]; expected a vertex rule/);
  assert.throws(() => normalizeMeshEdits([{ op: 'translate', verts: { vertices: [-1] }, offset: [0, 1, 0] }]), /edits\[0\]\.verts\.vertices: got \[-1\]; expected an array of 1 to 4096 whole vertex indices/);
  assert.throws(() => normalizeMeshEdits([{ op: 'translate', edges: [[0, 1]], offset: [0, 1, 0] }]), /edits\[0\]\.edges: got \[\[0,1\]\]; expected an edge rule/);
  assert.throws(() => normalizeMeshEdits([{ op: 'translate', edges: { edges: [[1, 1]] }, offset: [0, 1, 0] }]), /edits\[0\]\.edges\.edges: .*two different whole vertex indices/);
  assert.throws(() => normalizeMeshEdits([{ op: 'translate', edges: { edges: [] }, offset: [0, 1, 0] }]), /expected an array of 1 to 4096 vertex pairs/);
  assert.throws(() => runOne({ op: 'translate', verts: { vertices: [99] }, offset: [0, 1, 0] }), /Mesh edit 0 \(translate\): Vertex 99 does not exist/);
  assert.throws(() => runOne({ op: 'translate', edges: { edges: [[0, 99]] }, offset: [0, 1, 0] }), /names vertex 99, but the mesh has 8 vertices/);
  assert.throws(() => runOne({ op: 'bevel', edges: { edges: [[0, 99]] }, width: 0.1 }), /names vertex 99/);
  const { topFrontLeft, bottomFrontRight } = corners(cube());
  assert.throws(() => runOne({ op: 'translate', edges: { edges: [[topFrontLeft, bottomFrontRight]] }, offset: [0, 1, 0] }), /not an edge of this mesh: no face joins those two vertices/);
  assert.throws(() => runOne({ op: 'translate', verts: { inside: { min: [9, 9, 9], max: [10, 10, 10] } }, offset: [0, 1, 0] }), /edits\[0\]\.verts: got .*at least one vertex/);
});

test(`a selection lists at most ${MAX_SELECTED_ELEMENTS} vertices or edge pairs`, () => {
  const tooMany = Array.from({ length: MAX_SELECTED_ELEMENTS + 1 }, (_, index) => index);
  assert.throws(() => normalizeMeshEdits([{ op: 'translate', verts: { vertices: tooMany }, offset: [0, 1, 0] }]), /1 to 4096 whole vertex indices/);
  const pairs = tooMany.map(index => [index, index + 1]);
  assert.throws(() => normalizeMeshEdits([{ op: 'translate', edges: { edges: pairs }, offset: [0, 1, 0] }]), /1 to 4096 vertex pairs/);
  assert.throws(() => runOne({ op: 'bevel', edges: { edges: pairs }, width: 0.1 }), /1 to 4096 vertex pairs/);
  const allowed = tooMany.slice(0, MAX_SELECTED_ELEMENTS);
  assert.doesNotThrow(() => normalizeMeshEdits([{ op: 'translate', verts: { vertices: allowed }, offset: [0, 1, 0] }]));
});

test('the same edits give the same geometry every time', () => {
  const edits = [{ op: 'translate', edges: { edges: [[0, 1]] }, offset: [0.1, 0.2, 0.3] }, { op: 'translate', verts: { vertices: [2, 3] }, offset: [0, 0, 0.5] }];
  const first = applyMeshEdits(cube(), edits).mesh;
  const second = applyMeshEdits(cube(), edits).mesh;
  assert.deepEqual(Array.from(first.positions), Array.from(second.positions));
});
