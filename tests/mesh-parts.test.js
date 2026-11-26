import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

// Issue 3302: separate-faces turns picked faces into their own node, join-meshes merges nodes into one, both in one apply.

function twoBoxScene() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 } },
      { id: 'pillar', type: 'mesh', base: { type: 'box', bevel: 0 } },
    ],
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5] }, { id: 'gold', color: [1, 0.8, 0.2] }],
    nodes: [
      { id: 'a', geometry: 'block', material: 'stone', translation: [1, 0, 0], scale: [2, 1, 1] },
      { id: 'b', geometry: 'pillar', material: 'stone', translation: [-3, 2, 0], rotation: [0, 0.7071068, 0, 0.7071068], scale: [1, 3, 0.5] },
    ],
  };
}

function applyOperations(scene, operations) {
  return scene.apply(operations, { expectedRevision: scene.revision });
}

function trianglesOf(scene, nodeId) {
  const part = scene.parts.find(candidate => candidate.name === nodeId);
  assert.ok(part, `${nodeId} is drawn`);
  return part.geometry.indices.length / 3;
}

// The world-space box around every vertex a node draws.
function worldBounds(scene, nodeId) {
  const part = scene.parts.find(candidate => candidate.name === nodeId);
  const { positions } = part.geometry;
  const matrix = part.matrix;
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * positions[offset] + matrix[4 + axis] * positions[offset + 1] + matrix[8 + axis] * positions[offset + 2] + matrix[12 + axis];
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
  }
  return { low, high };
}

function closeTo(actual, expected) {
  actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-4, `${actual} vs ${expected}`));
}

function unionOf(...boxes) {
  return {
    low: [0, 1, 2].map(axis => Math.min(...boxes.map(box => box.low[axis]))),
    high: [0, 1, 2].map(axis => Math.max(...boxes.map(box => box.high[axis]))),
  };
}

test('separate-faces makes the picked faces their own node and moves nothing', () => {
  const scene = createAgentScene(twoBoxScene());
  const before = worldBounds(scene, 'a');
  applyOperations(scene, [{ type: 'separate-faces', node: 'a', faces: [0], id: 'a-top' }]);
  const recipe = scene.exportRecipe();
  assert.deepEqual(recipe.nodes.map(node => node.id), ['a', 'a-top', 'b']);
  assert.equal(recipe.nodes[1].material, 'stone');
  assert.deepEqual(recipe.nodes[1].translation, [1, 0, 0]);
  assert.deepEqual(recipe.nodes[1].scale, [2, 1, 1]);
  assert.equal(trianglesOf(scene, 'a-top'), 2, 'one quad is two triangles');
  assert.equal(trianglesOf(scene, 'a'), 10, 'five quads stay');
  const together = unionOf(worldBounds(scene, 'a-top'), worldBounds(scene, 'a'));
  closeTo(together.low, before.low);
  closeTo(together.high, before.high);
});

test('separate-faces on a geometry two nodes use copies it, so the other node keeps its faces', () => {
  const recipe = twoBoxScene();
  recipe.nodes[1].geometry = 'block';
  const scene = createAgentScene(recipe);
  applyOperations(scene, [{ type: 'separate-faces', node: 'a', faces: [0, 1], id: 'a-sides' }]);
  assert.equal(trianglesOf(scene, 'b'), 12, 'b still draws the whole box');
  assert.equal(trianglesOf(scene, 'a'), 8);
  assert.equal(trianglesOf(scene, 'a-sides'), 4);
});

test('separate-faces is one revision, so one undo step', () => {
  const scene = createAgentScene(twoBoxScene());
  const before = scene.revision;
  applyOperations(scene, [{ type: 'separate-faces', node: 'a', faces: [0], id: 'a-top' }]);
  assert.equal(scene.revision, before + 1);
});

test('separate-faces refuses bad input and names the fix', () => {
  const scene = createAgentScene(twoBoxScene());
  const refused = (operation, pattern) => assert.throws(() => applyOperations(scene, [{ type: 'separate-faces', ...operation }]), pattern);
  refused({ node: 'nope', faces: [0] }, /existing node/);
  refused({ node: 'a', faces: [] }, /nonempty array of face numbers/);
  refused({ node: 'a', faces: [99] }, /whole face numbers from 0 to 5/);
  refused({ node: 'a', faces: [1, 1] }, /each face number once/);
  refused({ node: 'a', faces: [0, 1, 2, 3, 4, 5] }, /fewer faces/);
  refused({ node: 'a', faces: [0], id: 'b' }, /no node uses yet/);
  refused({ node: 'a', faces: [0], extra: 1 }, /extra/);
});

test('join-meshes keeps every part where it was in the world, with different transforms', () => {
  const scene = createAgentScene(twoBoxScene());
  const first = worldBounds(scene, 'a');
  const second = worldBounds(scene, 'b');
  applyOperations(scene, [{ type: 'join-meshes', node: 'a', nodes: ['b'] }]);
  assert.deepEqual(scene.exportRecipe().nodes.map(node => node.id), ['a']);
  const expected = unionOf(first, second);
  const merged = worldBounds(scene, 'a');
  closeTo(merged.low, expected.low);
  closeTo(merged.high, expected.high);
  assert.equal(trianglesOf(scene, 'a'), 24);
});

test('a join edit with a mirroring matrix flips the faces it adds so they face outward', () => {
  const recipe = twoBoxScene();
  recipe.geometries[0].edits = [{ op: 'join', geometry: 'pillar', matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1] }];
  recipe.nodes = [recipe.nodes[0]];
  const scene = createAgentScene(recipe);
  const { positions, indices } = scene.parts.find(part => part.name === 'a').geometry;
  const point = index => [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];
  // Signed volume of the added shell's triangles (the last 12): positive means they wind outward.
  let volume = 0;
  for (let triangle = 12; triangle < indices.length / 3; triangle++) {
    const [first, second, third] = [0, 1, 2].map(corner => point(indices[triangle * 3 + corner]));
    volume += (first[0] * (second[1] * third[2] - second[2] * third[1]) - first[1] * (second[0] * third[2] - second[2] * third[0]) + first[2] * (second[0] * third[1] - second[1] * third[0])) / 6;
  }
  assert.ok(volume > 0, `added shell winds outward, volume ${volume}`);
});

test('a join edit with a flattening matrix or a missing geometry is refused with the fix', () => {
  const flat = twoBoxScene();
  flat.geometries[0].edits = [{ op: 'join', geometry: 'pillar', matrix: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }];
  assert.throws(() => createAgentScene(flat), /does not flatten/);
  const missing = twoBoxScene();
  missing.geometries[0].edits = [{ op: 'join', geometry: 'nowhere' }];
  assert.throws(() => createAgentScene(missing), /ID of a geometry in geometries/);
});

test('join-meshes combines meshes with different materials into one slotted mesh', () => {
  const recipe = twoBoxScene();
  recipe.nodes[1].material = 'gold';
  const scene = createAgentScene(recipe);
  applyOperations(scene, [{ type: 'join-meshes', node: 'a', nodes: ['b'] }]);
  assert.deepEqual(scene.exportRecipe().nodes.map(node => node.id), ['a']);
  const joinedParts = scene.parts.filter(part => part.name === 'a');
  assert.equal(joinedParts.length, 2);
  assert.deepEqual(joinedParts.map(part => part.materialSlot), [0, 1]);
  assert.equal(joinedParts.reduce((total, part) => total + part.geometry.indices.length / 3, 0), 24);
});

test('join-meshes refuses bad input', () => {
  const scene = createAgentScene(twoBoxScene());
  const refused = (operation, pattern) => assert.throws(() => applyOperations(scene, [{ type: 'join-meshes', ...operation }]), pattern);
  refused({ node: 'a', nodes: [] }, /1 to 32 node IDs/);
  refused({ node: 'a', nodes: ['a'] }, /not a itself/);
  refused({ node: 'a', nodes: ['b', 'b'] }, /each node once/);
  refused({ node: 'a', nodes: ['zzz'] }, /existing node/);
});

test('join-meshes is one revision and leaves a geometry another node uses alone', () => {
  const recipe = twoBoxScene();
  recipe.nodes.push({ id: 'c', geometry: 'block', material: 'stone', translation: [0, 5, 0] });
  const scene = createAgentScene(recipe);
  const before = scene.revision;
  applyOperations(scene, [{ type: 'join-meshes', node: 'a', nodes: ['b'] }]);
  assert.equal(trianglesOf(scene, 'c'), 12, 'c is untouched');
  assert.equal(trianglesOf(scene, 'a'), 24);
  assert.equal(scene.revision, before + 1);
});

function joinedBoxNormals({ matrix, firstEdits = [], secondEdits = [{ op: 'weighted_normal' }] }) {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [...firstEdits, { op: 'join', geometry: 'pillar', matrix }] },
      { id: 'pillar', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: secondEdits },
    ],
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'a', geometry: 'block', material: 'stone' }],
  };
  const { positions, normals } = createAgentScene(recipe).parts[0].geometry;
  return { positions, normals, vertexCount: positions.length / 3 };
}

// Every vertex of a joined box carries a unit normal that points away from the box's centre. The first 24 vertices are the
// untouched block, the next 24 the placed shell.
function assertNormalsPointOutward({ positions, normals, vertexCount }) {
  assert.equal(vertexCount, 48);
  for (const [from, to] of [[0, 24], [24, 48]]) {
    const centre = [0, 1, 2].map(axis => { let sum = 0; for (let vertex = from; vertex < to; vertex++) sum += positions[vertex * 3 + axis]; return sum / (to - from); });
    for (let vertex = from; vertex < to; vertex++) {
      const normal = [0, 1, 2].map(axis => normals[vertex * 3 + axis]);
      assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-4, `vertex ${vertex} has a unit normal, got ${normal}`);
      const outward = [0, 1, 2].reduce((sum, axis) => sum + normal[axis] * (positions[vertex * 3 + axis] - centre[axis]), 0);
      assert.ok(outward > 0, `vertex ${vertex} normal points outward, dot ${outward}`);
    }
  }
}

test('a joined mesh with weighted normals keeps unit outward normals under rotation and non-uniform scale', () => {
  assertNormalsPointOutward(joinedBoxNormals({ firstEdits: [{ op: 'weighted_normal' }], matrix: [0, 2, 0, 0, -1, 0, 0, 0, 0, 0, 3, 0, 4, 0, 0, 1] }));
  const half = Math.SQRT1_2;
  assertNormalsPointOutward(joinedBoxNormals({ firstEdits: [{ op: 'weighted_normal' }], matrix: [half, half, 0, 0, -half, half, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1] }));
});

test('a joined mesh with weighted normals keeps outward normals under a mirroring scale', () => {
  assertNormalsPointOutward(joinedBoxNormals({ firstEdits: [{ op: 'weighted_normal' }], matrix: [-2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1] }));
});

test('a normal attribute only one side carries never leaves zero-length normals', () => {
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1];
  assertNormalsPointOutward(joinedBoxNormals({ matrix, firstEdits: [{ op: 'weighted_normal' }], secondEdits: [] }));
  assertNormalsPointOutward(joinedBoxNormals({ matrix }));
});
