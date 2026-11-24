import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits } from '../src/mesh.js';
import { normalizeMeshEdits, MESH_EDIT_OPERATIONS } from '../src/mesh-recipe.js';

const cube = () => meshFromGeometry(box(0, 1));

function positionsOf(mesh) {
  return Array.from({ length: mesh.vertexCount }, (_, vertex) => [...mesh.positions.subarray(vertex * 3, vertex * 3 + 3)]);
}

function assertClose(actual, expected, message) {
  actual.forEach((component, axis) => assert.ok(Math.abs(component - expected[axis]) < 1e-5, `${message}: got [${actual}] expected [${expected}]`));
}

// The cube spans -0.5 to 0.5; its top face is the four vertices at y = 0.5.
function transformTop(extra) {
  const before = positionsOf(cube());
  const { mesh, results } = applyMeshEdits(cube(), [{ op: 'transform_selection', select: { tag: 'top' }, ...extra }]);
  return { before, after: positionsOf(mesh), results };
}

test('transform_selection is listed with its fields', () => {
  assert.deepEqual(MESH_EDIT_OPERATIONS.transform_selection.fields, ['select', 'pivot', 'rotation', 'scale', 'falloff']);
});

test('rotating the top 90 degrees about the x axis through the origin moves known vertices to known positions', () => {
  const { before, after } = transformTop({ pivot: [0, 0, 0], rotation: { axis: [1, 0, 0], angle: Math.PI / 2 } });
  before.forEach((point, vertex) => {
    // A top vertex (x, 0.5, z) turns to (x, -z, 0.5); the others stay put.
    const expected = point[1] > 0 ? [point[0], -point[2], 0.5] : point;
    assertClose(after[vertex], expected, `vertex ${vertex}`);
  });
});

test('the default pivot is the centre of the selection, so rotating the top 90 degrees about y keeps its centre and unselected vertices still', () => {
  const { before, after } = transformTop({ rotation: { axis: [0, 1, 0], angle: Math.PI / 2 } });
  before.forEach((point, vertex) => {
    // A top vertex (x, 0.5, z) about the axis through (0, 0.5, 0) turns to (z, 0.5, -x).
    assertClose(after[vertex], point[1] > 0 ? [point[2], 0.5, -point[0]] : point, `vertex ${vertex}`);
  });
});

test('scale about a given pivot and about the default centre leaves unselected vertices alone', () => {
  const aboutPivot = transformTop({ pivot: [1, 0.5, 0], scale: 2 });
  aboutPivot.before.forEach((point, vertex) => {
    assertClose(aboutPivot.after[vertex], point[1] > 0 ? [1 + (point[0] - 1) * 2, 0.5, point[2] * 2] : point, `pivot vertex ${vertex}`);
  });
  const aboutCentre = transformTop({ scale: [2, 1, 0.5] });
  aboutCentre.before.forEach((point, vertex) => {
    assertClose(aboutCentre.after[vertex], point[1] > 0 ? [point[0] * 2, 0.5, point[2] * 0.5] : point, `centre vertex ${vertex}`);
  });
  assert.equal(aboutCentre.results[0].movedVertices, 4);
});

test('rotation and scale together scale first, then rotate', () => {
  const { before, after } = transformTop({ scale: 2, rotation: { axis: [0, 1, 0], angle: Math.PI / 2 } });
  before.forEach((point, vertex) => {
    assertClose(after[vertex], point[1] > 0 ? [point[2] * 2, 0.5, -point[0] * 2] : point, `vertex ${vertex}`);
  });
});

test('falloff gives vertices inside the radius a smooth fraction and leaves the radius edge and beyond untouched', () => {
  // The bottom vertices sit 1 below the top. A linear falloff of radius 2 gives them weight 0.5, so scale 3 becomes 2.
  const inside = transformTop({ pivot: [0, 0.5, 0], scale: 3, falloff: { radius: 2, curve: 'linear' } });
  inside.before.forEach((point, vertex) => {
    const expected = point[1] > 0 ? [point[0] * 3, 0.5, point[2] * 3] : [point[0] * 2, 0.5 + (point[1] - 0.5) * 2, point[2] * 2];
    assertClose(inside.after[vertex], expected, `inside vertex ${vertex}`);
  });
  assert.equal(inside.results[0].movedVertices, 8);
  // At exactly the radius the weight is 0, and a vertex past it is not reached.
  const edge = transformTop({ rotation: { axis: [0, 0, 1], angle: 1 }, falloff: { radius: 1, curve: 'linear' } });
  edge.before.forEach((point, vertex) => {
    if (point[1] < 0) assertClose(edge.after[vertex], point, `edge vertex ${vertex}`);
  });
  const outside = transformTop({ rotation: { axis: [0, 0, 1], angle: 1 }, falloff: { radius: 0.5, curve: 'linear' } });
  assert.equal(outside.results[0].movedVertices, 4);
  outside.before.forEach((point, vertex) => {
    if (point[1] < 0) assertClose(outside.after[vertex], point, `outside vertex ${vertex}`);
  });
});

test('falloff rotates by the weighted angle', () => {
  const { before, after } = transformTop({ pivot: [0, 0.5, 0], rotation: { axis: [0, 1, 0], angle: Math.PI }, falloff: { radius: 2, curve: 'linear' } });
  before.forEach((point, vertex) => {
    // Bottom vertices have weight 0.5, so they turn a quarter turn about the vertical axis through the pivot: (x, z) to (z, -x).
    assertClose(after[vertex], point[1] > 0 ? [-point[0], 0.5, -point[2]] : [point[2], point[1], -point[0]], `vertex ${vertex}`);
  });
});

test('bad fields throw errors that name the field and the fix', () => {
  const edit = extra => () => normalizeMeshEdits([{ op: 'transform_selection', ...extra }]);
  assert.throws(edit({}), /edits\[0\]\.rotation.*radians/s);
  assert.throws(edit({ scale: 0 }), /edits\[0\]\.scale.*above 0/s);
  assert.doesNotThrow(edit({ scale: -1 }), 'a negative factor mirrors');
  assert.throws(edit({ scale: [1, -0, 1] }), /edits\[0\]\.scale/, 'minus zero is still zero');
  assert.throws(edit({ scale: -2000 }), /edits\[0\]\.scale/);
  assert.throws(edit({ scale: -1, falloff: { radius: 1 } }), /positive when a falloff is given/);
  assert.throws(edit({ scale: [1, 0, 1] }), /edits\[0\]\.scale/);
  assert.throws(edit({ scale: 5000 }), /edits\[0\]\.scale/);
  assert.throws(edit({ scale: Number.NaN }), /edits\[0\]\.scale/);
  assert.throws(edit({ rotation: { axis: [0, 0, 0], angle: 1 } }), /edits\[0\]\.rotation\.axis/);
  assert.throws(edit({ rotation: { axis: [0, 1, 0], angle: 90 } }), /edits\[0\]\.rotation\.angle.*radians.*1\.5708/s);
  assert.throws(edit({ rotation: { axis: [0, 1, 0] } }), /edits\[0\]\.rotation\.angle/);
  assert.throws(edit({ rotation: { axis: [0, 1, 0], angle: 1, degrees: 5 } }), /edits\[0\]\.rotation\.degrees/);
  assert.throws(edit({ rotation: 1 }), /edits\[0\]\.rotation/);
  assert.throws(edit({ scale: 2, pivot: [0, 0] }), /edits\[0\]\.pivot/);
  assert.throws(edit({ scale: 2, falloff: { radius: 0 } }), /edits\[0\]\.falloff\.radius/);
});

test('an empty selection throws and names the select field', () => {
  assert.throws(() => applyMeshEdits(cube(), [{ op: 'delete', select: { tag: 'top' } }, { op: 'transform_selection', select: { tag: 'top' }, scale: 2 }]), /edits\[1\]\.select/);
});
