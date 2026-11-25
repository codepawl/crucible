import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';

const CAMERA = { eye: [0, 2, 8], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };
const TOLERANCE = 1e-5;

function recipeOf({ geometries, nodes, motion }) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'grey', color: [0.6, 0.6, 0.6] }],
    geometries,
    nodes: nodes.map(node => ({ material: 'grey', ...node })),
    camera: CAMERA,
    ...(motion ? { motion } : {}),
  };
}

function partOf(scene, nodeId) {
  return scene.parts.find(part => part.name === nodeId);
}

function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

/** The world position of every vertex of a part, from the buffers the renderer draws and the part's world matrix. */
function worldPositions(scene, nodeId) {
  const part = partOf(scene, nodeId);
  const positions = part.geometry.positions;
  const points = [];
  for (let index = 0; index < positions.length; index += 3) {
    points.push(transformPoint(part.matrix, positions[index], positions[index + 1], positions[index + 2]));
  }
  return points;
}

/** The drawn normals, turned by the world matrix's inverse transpose, as a renderer lights them. */
function worldNormals(scene, nodeId) {
  const part = partOf(scene, nodeId);
  const matrix = part.matrix;
  const normals = part.geometry.normals;
  const result = [];
  for (let index = 0; index < normals.length; index += 3) {
    const columns = [[matrix[0], matrix[1], matrix[2]], [matrix[4], matrix[5], matrix[6]], [matrix[8], matrix[9], matrix[10]]];
    const [normalX, normalY, normalZ] = [normals[index], normals[index + 1], normals[index + 2]];
    // The inverse transpose of a 3x3 is its cofactor matrix scaled; the direction is what matters.
    const cofactor = [
      cross(columns[1], columns[2]),
      cross(columns[2], columns[0]),
      cross(columns[0], columns[1]),
    ];
    result.push([0, 1, 2].map(axis => cofactor[0][axis] * normalX + cofactor[1][axis] * normalY + cofactor[2][axis] * normalZ));
  }
  return result;
}

function cross(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

function distanceBetween(first, second) {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

/** Every point of one list has a point of the other within the tolerance, both ways: the same surface, whatever the vertex order or welding. */
function assertSamePoints(actual, expected, tolerance = TOLERANCE) {
  for (const [from, to, label] of [[actual, expected, 'after has no match before'], [expected, actual, 'before has no match after']]) {
    for (const point of from) {
      const nearest = Math.min(...to.map(other => distanceBetween(point, other)));
      assert.ok(nearest <= tolerance, `${label}: point ${point.map(value => value.toFixed(4))} is ${nearest} from the other surface`);
    }
  }
}

function direction(vector) {
  const length = Math.hypot(...vector);
  return vector.map(component => component / length);
}

/** Share of triangles whose winding faces away from the object's centre: 1 for a convex solid that faces outward. */
function outwardShare(scene, nodeId) {
  const part = partOf(scene, nodeId);
  const points = worldPositions(scene, nodeId);
  const centre = [0, 1, 2].map(axis => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
  const indices = part.geometry.indices;
  let outward = 0;
  for (let corner = 0; corner < indices.length; corner += 3) {
    const [first, second, third] = [points[indices[corner]], points[indices[corner + 1]], points[indices[corner + 2]]];
    const normal = cross(second.map((value, axis) => value - first[axis]), third.map((value, axis) => value - first[axis]));
    const toFace = first.map((value, axis) => value - centre[axis]);
    if (normal[0] * toFace[0] + normal[1] * toFace[1] + normal[2] * toFace[2] > 0) outward += 1;
  }
  return outward / (indices.length / 3);
}

const QUARTER_TURN_ABOUT_Y = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const QUARTER_TURN_ABOUT_Z = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
const SLANTED_SHAPE = { id: 'cone-shape', type: 'cone', radiusTop: 0.2, radiusBottom: 1, segments: 12 };
const TILTED = [0.2, 0.4, 0.1, Math.sqrt(1 - 0.04 - 0.16 - 0.01)];

function stretchedCone(extra = {}) {
  return createAgentScene(recipeOf({
    geometries: [SLANTED_SHAPE],
    nodes: [{ id: 'cone', geometry: 'cone-shape', translation: [1, 2, -0.5], rotation: TILTED, scale: [2, 0.5, 3], ...extra }],
  }));
}

test('apply-transform folds all three parts into the geometry: the node reads 0, no turn and 1, and the vertices stay in the world', () => {
  const scene = stretchedCone();
  const before = worldPositions(scene, 'cone');
  const normalsBefore = worldNormals(scene, 'cone');
  const pointsBefore = before;
  change(scene, [{ type: 'apply-transform', node: 'cone' }]);
  const node = scene.exportRecipe().nodes[0];
  assert.deepEqual(node.scale, [1, 1, 1]);
  assert.deepEqual(node.translation, [0, 0, 0]);
  assert.deepEqual(node.rotation, [0, 0, 0, 1]);
  assertSamePoints(worldPositions(scene, 'cone'), before);
  const normalsAfter = worldNormals(scene, 'cone');
  const pointsAfter = worldPositions(scene, 'cone');
  pointsAfter.forEach((point, index) => {
    const after = direction(normalsAfter[index]);
    const matches = pointsBefore.flatMap((other, otherIndex) => (distanceBetween(point, other) <= TOLERANCE ? [direction(normalsBefore[otherIndex])] : []));
    const best = Math.max(...matches.map(was => after[0] * was[0] + after[1] * was[1] + after[2] * was[2]));
    assert.ok(best > 0.999, `normal ${index} points away from every normal the surface had there (best cosine ${best}): a stretched slanted side needs its normal rebuilt`);
  });
});

test('apply-transform of one part leaves the others on the node', () => {
  const scene = stretchedCone({ rotation: [0, 0, 0, 1] });
  const before = worldPositions(scene, 'cone');
  change(scene, [{ type: 'apply-transform', node: 'cone', parts: ['scale'] }]);
  const node = scene.exportRecipe().nodes[0];
  assert.deepEqual(node.scale, [1, 1, 1]);
  assert.deepEqual(node.translation, [1, 2, -0.5]);
  assertSamePoints(worldPositions(scene, 'cone'), before);
});

test('applying location alone moves the geometry by the inverse of the turn and scale that stay on the node', () => {
  const scene = createAgentScene(recipeOf({
    geometries: [SLANTED_SHAPE],
    nodes: [{ id: 'cone', geometry: 'cone-shape', translation: [1, 2, -0.5], rotation: QUARTER_TURN_ABOUT_Y, scale: [2, 0.5, 3] }],
  }));
  const before = worldPositions(scene, 'cone');
  change(scene, [{ type: 'apply-transform', node: 'cone', parts: ['location'] }]);
  const node = scene.exportRecipe().nodes[0];
  assert.deepEqual(node.translation, [0, 0, 0]);
  assert.deepEqual(node.scale, [2, 0.5, 3]);
  assertSamePoints(worldPositions(scene, 'cone'), before);
});

test('applying rotation under an uneven stretch is refused because it would shear', () => {
  const scene = stretchedCone();
  assert.throws(() => change(scene, [{ type: 'apply-transform', node: 'cone', parts: ['rotation'] }]), /also has "scale"/);
  const before = worldPositions(scene, 'cone');
  change(scene, [{ type: 'apply-transform', node: 'cone', parts: ['rotation', 'scale'] }]);
  assert.deepEqual(scene.exportRecipe().nodes[0].translation, [1, 2, -0.5]);
  assertSamePoints(worldPositions(scene, 'cone'), before);
});

test('a mirroring scale in the edit log keeps the faces outward; two mirrored axes do not flip them again', () => {
  for (const [scale, label] of [[[1.5, -2, 1], 'one mirrored axis'], [[-1.5, -2, 1], 'two mirrored axes'], [[-1, -1, -1], 'three mirrored axes']]) {
    const scene = createAgentScene(recipeOf({
      geometries: [{ id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [{ op: 'transform_selection', select: { all: true }, pivot: [0, 0, 0], scale }] }],
      nodes: [{ id: 'block', geometry: 'block' }],
    }));
    const points = worldPositions(scene, 'block');
    assert.ok(Math.abs(Math.max(...points.map(point => point[1])) - Math.abs(scale[1]) / 2) < TOLERANCE, `${label}: the box is scaled`);
    assert.equal(outwardShare(scene, 'block'), 1, `${label}: every face points outward`);
  }
});

test('a mirroring scale is refused with a falloff, and zero is still refused', () => {
  const recipe = recipeOf({ geometries: [{ id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 } }], nodes: [{ id: 'block', geometry: 'block' }] });
  const scene = createAgentScene(recipe);
  const edit = scale => [{ type: 'edit-mesh', geometry: 'block', edits: [{ op: 'transform_selection', pivot: [0, 0, 0], scale, falloff: { radius: 1 } }] }];
  assert.throws(() => change(scene, edit([-1, 1, 1])), /positive when a falloff is given/);
  assert.throws(() => change(scene, [{ type: 'edit-mesh', geometry: 'block', edits: [{ op: 'transform_selection', scale: [0, 1, 1] }] }]), /scale/);
});

test('a geometry other nodes use is copied for the selected node only', () => {
  const scene = createAgentScene(recipeOf({
    geometries: [{ id: 'post', type: 'box', bevel: 0 }],
    nodes: [{ id: 'first', geometry: 'post', scale: [1, 3, 1] }, { id: 'second', geometry: 'post', translation: [4, 0, 0], scale: [1, 3, 1] }],
  }));
  const secondBefore = worldPositions(scene, 'second');
  change(scene, [{ type: 'apply-transform', node: 'first' }]);
  const recipe = scene.exportRecipe();
  const [first, second] = recipe.nodes;
  assert.notEqual(first.geometry, 'post');
  assert.equal(second.geometry, 'post');
  assert.deepEqual(second.scale, [1, 3, 1]);
  assert.equal(recipe.geometries.find(geometry => geometry.id === 'post').type, 'box');
  assertSamePoints(worldPositions(scene, 'second'), secondBefore);
});

test('a mesh the node owns keeps its ID and gains edits; a shape the node owns becomes a mesh under its own ID', () => {
  const scene = createAgentScene(recipeOf({
    geometries: [{ id: 'own', type: 'mesh', base: { type: 'box', bevel: 0 } }, { id: 'ball', type: 'sphere' }],
    nodes: [{ id: 'cube', geometry: 'own', scale: [2, 1, 1] }, { id: 'ball', geometry: 'ball', translation: [3, 0, 0], scale: [1, 2, 1] }],
  }));
  change(scene, [{ type: 'apply-transform', node: 'cube' }, { type: 'apply-transform', node: 'ball' }]);
  const recipe = scene.exportRecipe();
  assert.equal(recipe.geometries.find(geometry => geometry.id === 'own').edits.length, 1);
  const ball = recipe.geometries.find(geometry => geometry.id === 'ball');
  assert.equal(ball.type, 'mesh');
  assert.equal(ball.base.type, 'sphere');
});

test('apply-transform is refused with a sentence that says what to do', () => {
  const grouped = createAgentScene(recipeOf({
    geometries: [{ id: 'block', type: 'box' }, { id: 'words', type: 'text', text: 'Hi', size: 0.6, depth: 0.1 }],
    nodes: [{ id: 'parent', geometry: 'block', scale: [2, 2, 2] }, { id: 'child', parent: 'parent', geometry: 'block' }, { id: 'label', geometry: 'words', scale: [2, 2, 2] }],
  }));
  assert.throws(() => change(grouped, [{ type: 'apply-transform', node: 'parent' }]), /without children/);
  assert.throws(() => change(grouped, [{ type: 'apply-transform', node: 'label' }]), /basic shape/);
  assert.throws(() => change(grouped, [{ type: 'apply-transform', node: 'missing' }]), /existing node/);
  assert.throws(() => change(grouped, [{ type: 'apply-transform', node: 'child', parts: ['scale', 'scale'] }]), /each once/);
  assert.throws(() => change(grouped, [{ type: 'apply-transform', node: 'child', extra: 1 }]), /extra/);
});

test('apply-transform is refused for a mesh with modifiers', () => {
  const stacked = createAgentScene(recipeOf({
    geometries: [{ id: 'half', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'mirror', axis: 'x' }] }],
    nodes: [{ id: 'half', geometry: 'half', scale: [2, 1, 1] }],
  }));
  assert.throws(() => change(stacked, [{ type: 'apply-transform', node: 'half' }]), /modifiers/);
});

test('apply-transform on a node already at rest changes nothing', () => {
  const scene = createAgentScene(recipeOf({ geometries: [{ id: 'block', type: 'box' }], nodes: [{ id: 'block', geometry: 'block' }] }));
  change(scene, [{ type: 'apply-transform', node: 'block' }]);
  assert.equal(scene.exportRecipe().geometries[0].type, 'box');
});

test('set-origin to the bounds centre keeps the object in place and centres the geometry on the node', () => {
  const scene = createAgentScene(recipeOf({
    geometries: [{ id: 'cone-shape', type: 'cone', radiusTop: 0, radiusBottom: 0.8, segments: 12 }],
    nodes: [{ id: 'cone', geometry: 'cone-shape', translation: [1, 0, 0], rotation: QUARTER_TURN_ABOUT_Y, scale: [2, 3, 1] }],
  }));
  const before = worldPositions(scene, 'cone');
  change(scene, [{ type: 'set-origin', node: 'cone', to: 'geometry' }]);
  assertSamePoints(worldPositions(scene, 'cone'), before);
  const local = partOf(scene, 'cone').geometry.positions;
  for (let axis = 0; axis < 3; axis += 1) {
    const values = Array.from({ length: local.length / 3 }, (_, vertex) => local[vertex * 3 + axis]);
    assert.ok(Math.abs((Math.min(...values) + Math.max(...values)) / 2) < TOLERANCE, `axis ${axis} is centred on the new origin`);
  }
});

test('after set-origin to the bottom, a turn swings the object about its bottom centre', () => {
  const scene = createAgentScene(recipeOf({
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    nodes: [{ id: 'block', geometry: 'block', translation: [0, 1, 0], scale: [1, 2, 1] }],
  }));
  change(scene, [{ type: 'set-origin', node: 'block', to: 'bottom' }]);
  assert.ok(Math.abs(scene.exportRecipe().nodes[0].translation[1]) < TOLERANCE, 'the node now sits on the ground, under the box');
  change(scene, [{ type: 'set-node', id: 'block', rotation: QUARTER_TURN_ABOUT_Z }]);
  const points = worldPositions(scene, 'block');
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  // The box is 1 wide and 2 tall with its bottom centre at the origin. A quarter turn about Z lays it along -x, touching the origin.
  assert.ok(Math.abs(Math.max(...xs) - 0.0) < 0.5 + TOLERANCE && Math.abs(Math.min(...xs) + 2) < TOLERANCE, `it lies along -x from the pivot: ${Math.min(...xs)} to ${Math.max(...xs)}`);
  assert.ok(Math.abs(Math.min(...ys) + 0.5) < TOLERANCE && Math.abs(Math.max(...ys) - 0.5) < TOLERANCE, 'and is half a metre either side of the pivot in y');
});

test('set-origin to a point leaves the object and its children where they were', () => {
  const scene = createAgentScene(recipeOf({
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    nodes: [
      { id: 'parent', geometry: 'block', translation: [1, 0, 0], rotation: QUARTER_TURN_ABOUT_Z, scale: [2, 2, 2] },
      { id: 'child', parent: 'parent', geometry: 'block', translation: [0, 1, 0], scale: [0.2, 0.2, 0.2] },
    ],
  }));
  const parentBefore = worldPositions(scene, 'parent');
  const childBefore = worldPositions(scene, 'child');
  change(scene, [{ type: 'set-origin', node: 'parent', to: 'point', point: [0.25, -0.5, 0] }]);
  assertSamePoints(worldPositions(scene, 'parent'), parentBefore);
  assertSamePoints(worldPositions(scene, 'child'), childBefore);
});

test('set-origin names what to pass when its fields are wrong', () => {
  const scene = createAgentScene(recipeOf({ geometries: [{ id: 'block', type: 'box' }], nodes: [{ id: 'block', geometry: 'block' }] }));
  assert.throws(() => change(scene, [{ type: 'set-origin', node: 'block', to: 'middle' }]), /one of geometry, bottom, point/);
  assert.throws(() => change(scene, [{ type: 'set-origin', node: 'block', to: 'point', point: [1, 2] }]), /three finite numbers/);
  assert.throws(() => change(scene, [{ type: 'set-origin', node: 'block', to: 'geometry', point: [1, 2, 3] }]), /left out unless/);
});

test('a mesh whose edit log is full cannot take another apply and says so', () => {
  const edits = Array.from({ length: 64 }, () => ({ op: 'translate', offset: [0.001, 0, 0] }));
  const scene = createAgentScene(recipeOf({ geometries: [{ id: 'full', type: 'mesh', base: { type: 'box', bevel: 0 }, edits }], nodes: [{ id: 'full', geometry: 'full', scale: [2, 1, 1] }] }));
  assert.throws(() => change(scene, [{ type: 'apply-transform', node: 'full' }]), /at most 64 edits/);
});

function change(scene, operations) {
  return scene.apply(operations, { expectedRevision: scene.revision });
}
