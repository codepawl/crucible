import { invalidField } from './field-error.js';
import { MAX_MATERIAL_SLOTS, MATERIAL_SLOT_ATTRIBUTE } from './mesh-operations.js';

// Material slots of a recipe mesh. The geometry names the slots (`slots`, a list of material IDs); each face points at one by
// index through the face attribute `material_slot`, which the `material_slot` edit writes and every other edit carries along
// with its faces. The render geometry lists one index range per slot (`materialGroups`) and the scene draws one part per range.

const SLOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

/** The per-face slot indices of a mesh, or undefined when no face was given a slot. */
export function faceSlotsOf(mesh) {
  return mesh.attributes.face[MATERIAL_SLOT_ATTRIBUTE]?.data;
}

/** The `slots` field of a mesh geometry: 1 to MAX_MATERIAL_SLOTS distinct material IDs. */
export function normalizeMaterialSlots(slots) {
  const expected = `a list of 1 to ${MAX_MATERIAL_SLOTS} distinct material IDs, such as ["blade", "handle"]`;
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > MAX_MATERIAL_SLOTS) {
    throw invalidField('slots', Array.isArray(slots) ? `${slots.length} slots` : slots, expected, TypeError);
  }
  slots.forEach((id, index) => {
    if (typeof id !== 'string' || !SLOT_ID_PATTERN.test(id)) throw invalidField(`slots[${index}]`, id, 'a material ID, such as "blade"', TypeError);
  });
  if (new Set(slots).size !== slots.length) throw invalidField('slots', slots, expected, TypeError);
  return slots;
}

/** Every slot of a mesh geometry must name a material of the recipe, so the error lists the IDs that exist. */
export function checkMaterialSlots(meshDefinition, materialIds) {
  if (meshDefinition.slots === undefined) {
    if ((meshDefinition.edits ?? []).some(edit => edit?.op === 'material_slot')) {
      throw invalidField('slots', undefined, 'a list of material IDs that the material_slot edits point at, such as ["blade", "handle"]');
    }
    return;
  }
  normalizeMaterialSlots(meshDefinition.slots).forEach((id, index) => {
    if (!materialIds.has(id)) throw invalidField(`slots[${index}]`, id, `the ID of a material in materials, one of ${[...materialIds].slice(0, 8).join(', ') || 'none yet; add the material first'}`);
  });
}

/**
 * Throws when an edit dropped the slots the mesh had. An edit that rebuilds the mesh from its shape (decimate, remesh and the
 * generators) has no face to copy a slot from; saying so beats drawing the whole mesh in one material.
 */
export function assertSlotsKept(before, after, operation) {
  if (faceSlotsOf(before) && !faceSlotsOf(after)) {
    throw new RangeError(`${operation} cannot keep material slots yet and would drop them. Run ${operation} before the material_slot edits, so the slots are assigned to the finished faces.`);
  }
}

/** A join adds the faces of another mesh, whose slot numbers belong to its own list, so slots on either side are refused until the lists can merge. */
export function refuseSlottedJoin(mesh, other) {
  if (faceSlotsOf(mesh) || faceSlotsOf(other)) {
    throw new RangeError('join cannot combine meshes with material slots yet: the slot numbers of each mesh belong to its own list. Join before the material_slot edits, with slots left off both geometries.');
  }
}

/** Every face must point at a slot of the geometry's list. */
export function checkFaceSlots(mesh, slotCount) {
  const slots = faceSlotsOf(mesh);
  if (!slots) return;
  let highest = 0;
  for (const slot of slots) highest = Math.max(highest, slot);
  if (highest >= slotCount) {
    throw invalidField('slots', `${slotCount} slots`, `a list with at least ${highest + 1} material IDs, because a face points at slot ${highest}; add the missing material IDs to slots, or point those faces at a slot from 0 to ${slotCount - 1}`);
  }
}

/**
 * Orders the triangles of render geometry by slot and records one index range per slot that has triangles:
 * `geometry.materialGroups = [{ slot, start, count }]` (start and count in indices), `geometry.materialSlots` = the IDs.
 * `triangleFaces[t]` is the mesh face of triangle t.
 */
export function groupGeometryBySlot(geometry, triangleFaces, faceSlots, slotIds) {
  const triangleCount = triangleFaces.length;
  const slotOfTriangle = triangle => (faceSlots ? faceSlots[triangleFaces[triangle]] : 0);
  const counts = new Array(slotIds.length).fill(0);
  for (let triangle = 0; triangle < triangleCount; triangle++) counts[slotOfTriangle(triangle)]++;
  const cursors = [];
  const groups = [];
  let start = 0;
  counts.forEach((count, slot) => {
    cursors[slot] = start;
    if (count > 0) groups.push(Object.freeze({ slot, start, count: count * 3 }));
    start += count * 3;
  });
  const sorted = new Uint32Array(geometry.indices.length);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const slot = slotOfTriangle(triangle);
    sorted.set(geometry.indices.subarray(triangle * 3, triangle * 3 + 3), cursors[slot]);
    cursors[slot] += 3;
  }
  geometry.indices = sorted;
  geometry.materialGroups = Object.freeze(groups);
  geometry.materialSlots = Object.freeze([...slotIds]);
}

const slices = new WeakMap();

/** The geometry of one slot: the vertex arrays of `geometry` with only that slot's triangles. One object per geometry and group, so parts can be reused. */
export function geometryOfSlot(geometry, group) {
  let byStart = slices.get(geometry);
  if (!byStart) {
    byStart = new Map();
    slices.set(geometry, byStart);
  }
  if (!byStart.has(group.start)) {
    const { materialGroups, materialSlots, lods, ...rest } = geometry;
    byStart.set(group.start, { ...rest, indices: geometry.indices.subarray(group.start, group.start + group.count) });
  }
  return byStart.get(group.start);
}
