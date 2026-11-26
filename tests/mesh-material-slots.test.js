import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../src/geometry.js';
import { createAgentScene } from '../src/agent-scene.js';
import { meshFromGeometry } from '../src/mesh-convert.js';
import { applyMeshEdits } from '../src/mesh-recipe.js';
import { loadMeshBooleans } from '../src/mesh-boolean.js';
import { groupParts } from '../src/renderer.js';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';
import { MAX_MATERIAL_SLOTS, MATERIAL_SLOT_ATTRIBUTE } from '../src/mesh-operations.js';

// Issue 3384, slice 1: a recipe mesh names material slots and each face points at one by index.

const TOP_TO_SLOT_ONE = { op: 'material_slot', select: { tag: 'top' }, slot: 1 };

function slottedRecipe(overrides = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 }, slots: ['red', 'blue'], edits: [TOP_TO_SLOT_ONE], ...overrides }],
    materials: [{ id: 'red', color: [1, 0, 0] }, { id: 'blue', color: [0, 0, 1] }, { id: 'plain', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'block', geometry: 'block', material: 'plain' }],
  };
}

function boxMesh() {
  return meshFromGeometry(box(0, 1, true));
}

function slotCounts(mesh) {
  const counts = {};
  for (const slot of mesh.attributes.face[MATERIAL_SLOT_ATTRIBUTE].data) counts[slot] = (counts[slot] ?? 0) + 1;
  return counts;
}

function run(edit) {
  return applyMeshEdits(boxMesh(), [TOP_TO_SLOT_ONE, edit], { resolveCutter: () => boxMesh(), resolveJoinMesh: () => boxMesh() }).mesh;
}

test('a mesh with two slots draws as one part per slot, each with its own material', () => {
  const scene = createAgentScene(slottedRecipe());
  const parts = scene.parts.filter(part => part.name === 'block');
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(part => part.materialSlot), [0, 1]);
  assert.deepEqual(parts.map(part => Array.from(part.material.color)), [[1, 0, 0], [0, 0, 1]]);
  // The box has 6 quads, 12 triangles: five quads (10 triangles) in slot 0 and one quad (2 triangles) in slot 1.
  assert.deepEqual(parts.map(part => part.geometry.indices.length / 3), [10, 2]);
  const batches = groupParts(parts);
  assert.equal(batches.length, 2, 'one batch per slot');
  assert.notEqual(batches[0][0].material, batches[1][0].material);
});

test('slot parts keep the node transform', () => {
  const scene = createAgentScene({ ...slottedRecipe(), nodes: [{ id: 'block', geometry: 'block', material: 'plain', translation: [2, 0, 0] }] });
  for (const part of scene.parts.filter(candidate => candidate.name === 'block')) assert.equal(part.matrix[12], 2);
});

test('the glTF export writes one mesh with a primitive and material per slot, and a round trip keeps both', async () => {
  const scene = createAgentScene(slottedRecipe());
  const glb = exportGlb(scene.parts);
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, new DataView(glb).getUint32(12, true))));
  assert.equal(document.meshes.length, 1, 'one mesh');
  assert.equal(document.meshes[0].primitives.length, 2, 'one primitive per slot');
  const parsed = await parseGltf(glb);
  const colors = parsed.parts.map(part => Array.from(part.material.color).map(value => Math.round(value * 100) / 100).join());
  assert.equal(parsed.parts.length, 2);
  assert.deepEqual(colors.sort(), ['0,0,1', '1,0,0']);
  assert.equal(parsed.parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0), 12);
});

test('a recipe without slots builds the same geometry, with no groups and no extra parts', () => {
  const plain = createAgentScene({ ...slottedRecipe(), geometries: [{ id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 } }] });
  const parts = plain.parts.filter(part => part.name === 'block');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].materialSlot, undefined);
  assert.equal(parts[0].geometry.materialGroups, undefined);
  assert.equal(parts[0].geometry.materialSlots, undefined);
  assert.equal(parts[0].geometry.indices.length, 36);
  const sameEditsWithoutSlots = createAgentScene({ ...slottedRecipe(), geometries: [{ id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: [{ op: 'tag', select: { tag: 'top' }, name: 'lid' }] }] });
  assert.deepEqual(Array.from(sameEditsWithoutSlots.parts[0].geometry.indices), Array.from(parts[0].geometry.indices));
  assert.deepEqual(Array.from(sameEditsWithoutSlots.parts[0].geometry.positions), Array.from(parts[0].geometry.positions));
});

test('edits that copy or split faces carry the slot of the face they came from', async () => {
  await loadMeshBooleans();
  const expectations = {
    extrusion: [{ op: 'extrude_face_region', select: { tag: 'top' }, offset: 0.3 }, { 0: 5, 1: 5 }],
    individual_extrusion: [{ op: 'extrude_individual', select: { tag: 'top' }, offset: 0.3 }, { 0: 5, 1: 5 }],
    inset: [{ op: 'inset_region', select: { tag: 'top' }, thickness: 0.1 }, { 0: 5, 1: 5 }],
    subdivide: [{ op: 'subdivide', levels: 1 }, { 0: 20, 1: 4 }],
    mirror: [{ op: 'mirror', axis: 'x' }, { 0: 10, 1: 2 }],
    array: [{ op: 'array', count: 2, offset: [3, 0, 0] }, { 0: 10, 1: 2 }],
    solidify: [{ op: 'solidify', thickness: 0.1 }, { 0: 10, 1: 2 }],
    delete: [{ op: 'delete', select: { tag: 'bottom' } }, { 0: 4, 1: 1 }],
    triangulate: [{ op: 'triangulate' }, { 0: 10, 1: 2 }],
    loop_cut: [{ op: 'loop_cut', edges: { along: [0, 1, 0] } }, { 0: 9, 1: 1 }],
    bevel: [{ op: 'bevel', edges: { all: true }, width: 0.05 }, { 0: 25, 1: 1 }],
    weld: [{ op: 'weld' }, { 0: 5, 1: 1 }],
    boolean: [{ op: 'boolean', operation: 'difference', cutter: { type: 'box' }, translation: [0.5, 0.5, 0.5], scale: [0.5, 0.5, 0.5] }, null],
  };
  for (const [name, [edit, counts]] of Object.entries(expectations)) {
    const kept = slotCounts(run(edit));
    if (counts) assert.deepEqual(kept, counts, name);
    // A boolean makes new faces for the cut, which start in slot 0; the faces it keeps keep theirs.
    else assert.ok(kept[1] >= 1 && kept[0] >= 1, name);
  }
});

test('an edit that cannot keep slots throws and says what to do instead of dropping them', async () => {
  await loadMeshBooleans();
  const refused = [
    { op: 'decimate', ratio: 0.5 },
    { op: 'remesh', resolution: 8 },
    { op: 'screw', axis: 'y', angle: 90, steps: 4 },
    { op: 'wireframe', thickness: 0.05 },
    { op: 'convex_hull' },
    { op: 'bounding_box' },
  ];
  for (const edit of refused) assert.throws(() => run(edit), new RegExp(`${edit.op} cannot keep material slots yet.*before the material_slot edits`), edit.op);
  assert.throws(() => run({ op: 'join', geometry: 'other' }), /join cannot combine meshes with material slots yet/);
});

test('the same edits without slots still run, so refusing only concerns meshes that have slots', () => {
  for (const edit of [{ op: 'decimate', ratio: 0.5 }, { op: 'remesh', resolution: 8 }, { op: 'bounding_box' }]) {
    assert.doesNotThrow(() => applyMeshEdits(boxMesh(), [edit]), edit.op);
  }
});

test('validation says what to pass for a bad slot list, a bad slot number and a missing material', () => {
  assert.throws(() => createAgentScene(slottedRecipe({ slots: [] })), /slots.*1 to 16 distinct material IDs/);
  assert.throws(() => createAgentScene(slottedRecipe({ slots: ['red', 'red'] })), /slots.*distinct material IDs/);
  const tooMany = Array.from({ length: MAX_MATERIAL_SLOTS + 1 }, (_, index) => `m${index}`);
  assert.throws(() => createAgentScene(slottedRecipe({ slots: tooMany })), /slots.*1 to 16 distinct/);
  assert.throws(() => createAgentScene(slottedRecipe({ slots: ['red', 'green'] })), /slots\[1\].*"green".*one of red, blue, plain/);
  assert.throws(() => createAgentScene(slottedRecipe({ edits: [{ ...TOP_TO_SLOT_ONE, slot: 16 }] })), /edits\[0\]\.slot.*whole number from 0 to 15/);
  assert.throws(() => createAgentScene(slottedRecipe({ slots: ['red'] })), /list with at least 2 material IDs, because a face points at slot 1/);
  assert.throws(() => createAgentScene(withoutSlotsList()), /slots.*material_slot edits point at/);
});

test('separate-faces keeps the slots of the faces it takes, and join-meshes merges slotted meshes', () => {
  const scene = createAgentScene({
    ...slottedRecipe(),
    geometries: [
      { id: 'block', type: 'mesh', base: { type: 'box', bevel: 0 }, slots: ['red', 'blue'], edits: [TOP_TO_SLOT_ONE] },
      { id: 'plain', type: 'mesh', base: { type: 'box', bevel: 0 } },
    ],
    nodes: [{ id: 'block', geometry: 'block', material: 'plain' }, { id: 'other', geometry: 'plain', material: 'plain', translation: [3, 0, 0] }],
  });
  const slotsDrawn = id => scene.parts.filter(part => part.name === id).map(part => part.materialSlot);
  assert.deepEqual(slotsDrawn('block'), [0, 1]);
  scene.apply([{ type: 'separate-faces', node: 'block', faces: [0, 1, 2, 3, 4], id: 'piece' }], { expectedRevision: scene.revision });
  const drawnSlots = [...slotsDrawn('block'), ...slotsDrawn('piece')];
  assert.ok(drawnSlots.every(slot => slot === 0 || slot === 1) && drawnSlots.includes(1), 'both nodes draw by slot');
  const triangles = ['block', 'piece'].flatMap(id => scene.parts.filter(part => part.name === id)).reduce((total, part) => total + part.geometry.indices.length / 3, 0);
  assert.equal(triangles, 12);
  scene.apply([{ type: 'join-meshes', node: 'block', nodes: ['other'] }], { expectedRevision: scene.revision });
  assert.deepEqual(slotsDrawn('block'), [0, 2]);
  assert.equal(scene.parts.filter(part => part.name === 'block').reduce((total, part) => total + part.geometry.indices.length / 3, 0), 14);
});

function withoutSlotsList() {
  const recipe = slottedRecipe();
  delete recipe.geometries[0].slots;
  return recipe;
}

test('a node with material slots is one body for physics, one entry of world bounds, and refuses a skin', async () => {
  const scene = createAgentScene(slottedRecipe());
  const { bodyGeometriesOf } = await import('../src/game-physics.js');
  const recipe = scene.exportRecipe();
  const bodyGeometry = bodyGeometriesOf(recipe, scene.parts).get('block');
  assert.equal(bodyGeometry.indices.length / 3, 12, 'the collider reads every slot, not the last one');
  assert.equal(scene.worldBounds().filter(entry => entry.name === 'block').length, 1);
  const skinned = slottedRecipe();
  skinned.armatures = [{ id: 'rig', bones: [{ name: 'root', parent: null, head: [0, 0, 0], tail: [0, 0.5, 0] }] }];
  skinned.nodes[0].skin = { armature: 'rig' };
  assert.throws(() => createAgentScene(skinned), /nodes.block.skin.*no material slots.*remove skin, or remove slots from block/);
});
