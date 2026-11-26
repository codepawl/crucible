import { mat4 } from 'gl-matrix';
import { invalidField } from './field-error.js';
import { knownKeys } from './motion-validation.js';
import { meshEditSourceOf } from './agent-mesh.js';
import { MAX_MATERIAL_SLOTS } from './mesh-operations.js';
import { normalizeMeshEdits } from './mesh-recipe.js';

// The scene operations that split one mesh object into two, merge several into one, and assign a material slot to faces:
//   separate-faces        { node, faces: [face numbers], id? }          the picked faces become a new node, nothing moves
//   join-meshes           { node, nodes: [node IDs] }                   the other nodes' meshes join `node`, preserving materials
//   assign-face-material  { node, faces: [face numbers], slot|material } points the picked faces at a material slot
// Each writes ordinary recipe data (edits and geometry slots), so the result replays, saves and undoes like any other edit.
// A geometry another node still uses is copied first.

export const MAX_JOINED_NODES = 32;
export const MAX_ASSIGN_FACES = 65536;
const SEPARATE_FIELDS = ['type', 'node', 'faces', 'id'];
const JOIN_FIELDS = ['type', 'node', 'nodes'];
const ASSIGN_FACE_MATERIAL_FIELDS = ['type', 'node', 'faces', 'slot', 'material'];
// Nodes whose mesh is not the whole story: a placement, a growth or a skin has its own source, so cutting the mesh would not cut them.
const UNSUPPORTED_NODE_FIELDS = ['instances', 'asset', 'vegetation', 'clutter', 'grass', 'relations', 'skin', 'faceImages', 'decal', 'billboard'];

function nodeNamed(candidate, nodeId, field) {
  const node = typeof nodeId === 'string' ? candidate.nodes.find(entry => entry.id === nodeId) : undefined;
  if (!node) {
    throw invalidField(field, nodeId, `the ID of an existing node, one of ${candidate.nodes.slice(0, 8).map(entry => entry.id).join(', ') || 'none yet'}; scene_inspect lists them`);
  }
  return node;
}

function checkedMeshNode(candidate, node, field, operationType) {
  const unsupported = UNSUPPORTED_NODE_FIELDS.find(name => node[name] !== undefined);
  if (unsupported) {
    throw invalidField(field, node.id, `a plain mesh node; ${node.id} uses ${unsupported}, which ${operationType} cannot carry over`);
  }
  if (node.geometry === undefined) {
    throw invalidField(field, node.id, 'a node with a mesh geometry; a group or a light has no faces to work on');
  }
  return node;
}

function meshGeometryOfNode(candidate, node, field) {
  const geometry = candidate.geometries.find(entry => entry.id === node.geometry);
  if (!geometry || geometry.type !== 'mesh') {
    throw invalidField(field, node.id, `a node whose geometry is a mesh, but ${node.id} draws ${geometry ? `a ${geometry.type}` : 'a missing geometry'}; enter edit mode on it once (Tab in Studio) or give it a mesh geometry first`);
  }
  return geometry;
}

function freeId(taken, wanted) {
  let candidate = wanted;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${wanted}-${suffix}`;
  return candidate;
}

function checkedFaces(faces, faceCount, { allowAll = false, maxCount = faceCount } = {}) {
  if (!Array.isArray(faces) || faces.length === 0) {
    throw invalidField('faces', faces, 'a nonempty array of face numbers of the mesh, such as [0, 1, 4]; mesh_inspect or Studio edit mode shows them');
  }
  if (!allowAll && faces.length >= faceCount) {
    throw invalidField('faces', `${faces.length} of ${faceCount} faces`, 'fewer faces than the mesh has: the object keeps at least one face, so pick part of it');
  }
  if (faces.length > maxCount) {
    throw invalidField('faces', `${faces.length} faces`, `at most ${maxCount} faces at once`);
  }
  const seen = new Set();
  for (const face of faces) {
    if (!Number.isInteger(face) || face < 0 || face >= faceCount) {
      throw invalidField('faces', face, `whole face numbers from 0 to ${faceCount - 1}`);
    }
    if (seen.has(face)) throw invalidField('faces', face, 'each face number once');
    seen.add(face);
  }
  return [...seen].sort((first, second) => first - second);
}

function withEdit(geometry, edit) {
  const edits = [...(geometry.edits ?? []), edit];
  normalizeMeshEdits(edits);
  return edits;
}

/**
 * The separate-faces operation. The picked faces of `operation.node` become a new node with the same transform, parent and
 * material, so nothing moves in the world; the node keeps the other faces. `faceCountOf(geometryId)` is the face count of the
 * mesh the edit log builds (the numbers a pick uses). Returns the new node's ID and geometry ID.
 */
function separateFaces(candidate, rawOperation, faceCountOf) {
  knownKeys(rawOperation, SEPARATE_FIELDS, 'operation');
  const node = checkedMeshNode(candidate, nodeNamed(candidate, rawOperation.node, 'node'), 'node', 'separate-faces');
  const source = meshGeometryOfNode(candidate, node, 'node');
  const faces = checkedFaces(rawOperation.faces, faceCountOf(source.id));
  const takenNodes = new Set(candidate.nodes.map(entry => entry.id));
  if (rawOperation.id !== undefined && (typeof rawOperation.id !== 'string' || takenNodes.has(rawOperation.id))) {
    throw invalidField('id', rawOperation.id, 'an ID no node uses yet, or leave id out to name it after the object');
  }
  const partNodeId = rawOperation.id ?? freeId(takenNodes, `${node.id}-part`);
  const takenGeometries = new Set(candidate.geometries.map(entry => entry.id));
  const partGeometry = { ...structuredClone(source), id: freeId(takenGeometries, `${source.id}-${partNodeId}`) };
  partGeometry.edits = withEdit(source, { op: 'delete', select: { not: { faces } } });
  takenGeometries.add(partGeometry.id);
  const keepFaces = { op: 'delete', select: { faces } };
  if (candidate.nodes.some(entry => entry !== node && entry.geometry === source.id)) {
    const remainder = { ...structuredClone(source), id: freeId(takenGeometries, `${source.id}-${node.id}`) };
    remainder.edits = withEdit(source, keepFaces);
    candidate.geometries.push(remainder);
    node.geometry = remainder.id;
  } else {
    source.edits = withEdit(source, keepFaces);
  }
  candidate.geometries.push(partGeometry);
  const { id: ignoredId, label: ignoredLabel, ...shared } = node;
  const partNode = { ...structuredClone(shared), id: partNodeId, geometry: partGeometry.id };
  candidate.nodes.splice(candidate.nodes.indexOf(node) + 1, 0, partNode);
  return { nodeId: partNodeId, geometryId: partGeometry.id };
}

function worldMatrixOf(node, nodesById) {
  const local = mat4.fromRotationTranslationScale(mat4.create(), node.rotation ?? [0, 0, 0, 1], node.translation ?? [0, 0, 0], node.scale ?? [1, 1, 1]);
  const parent = node.parent === null || node.parent === undefined ? null : nodesById.get(node.parent);
  return parent ? mat4.multiply(local, worldMatrixOf(parent, nodesById), local) : local;
}

function checkedJoinedNode(candidate, node) {
  checkedMeshNode(candidate, node, 'nodes', 'join-meshes');
  if (candidate.nodes.some(entry => entry.parent === node.id)) {
    throw invalidField('nodes', node.id, `a node without children, since joining removes it; move the children of ${node.id} to another parent with set-node first`);
  }
  if ((candidate.motion?.tracks ?? []).some(track => track.id === node.id) || (candidate.physics?.bodies ?? []).some(body => body.node === node.id)) {
    throw invalidField('nodes', node.id, `a node without motion tracks or a physics body, since joining removes it; remove those of ${node.id} first`);
  }
}

function slotsOfNode(node, geometry) {
  if (geometry.slots !== undefined) return [...geometry.slots];
  return node.material !== undefined ? [node.material] : [];
}

function ownGeometryCopy(candidate, node, geometry) {
  if (!candidate.nodes.some(entry => entry !== node && entry.geometry === geometry.id)) return geometry;
  const copy = { ...structuredClone(geometry), id: freeId(new Set(candidate.geometries.map(entry => entry.id)), `${geometry.id}-${node.id}`) };
  candidate.geometries.push(copy);
  node.geometry = copy.id;
  return copy;
}

/**
 * The join-meshes operation. The meshes of `operation.nodes` are added to the mesh of `operation.node` (the active one), each
 * placed so it stays where it stood in the world, and those nodes are removed. Nodes with different materials or material slots
 * merge into one slotted mesh preserving each face's material. Returns the IDs of the removed nodes.
 */
function joinNodeMeshes(candidate, rawOperation) {
  knownKeys(rawOperation, JOIN_FIELDS, 'operation');
  const target = checkedMeshNode(candidate, nodeNamed(candidate, rawOperation.node, 'node'), 'node', 'join-meshes');
  const targetGeometry = meshGeometryOfNode(candidate, target, 'node');
  if (!Array.isArray(rawOperation.nodes) || rawOperation.nodes.length === 0 || rawOperation.nodes.length > MAX_JOINED_NODES) {
    throw invalidField('nodes', rawOperation.nodes, `1 to ${MAX_JOINED_NODES} node IDs to join into ${target.id}, such as ["wheel"]`);
  }
  if (new Set(rawOperation.nodes).size !== rawOperation.nodes.length || rawOperation.nodes.includes(target.id)) {
    throw invalidField('nodes', rawOperation.nodes, `each node once, and not ${target.id} itself, which is the one they join into`);
  }
  const joined = rawOperation.nodes.map(nodeId => nodeNamed(candidate, nodeId, 'nodes'));
  for (const node of joined) checkedJoinedNode(candidate, node);
  const targetSlots = slotsOfNode(target, targetGeometry);
  const joinedEntries = joined.map(node => {
    const geometry = meshGeometryOfNode(candidate, node, 'nodes');
    return { node, geometry, slots: slotsOfNode(node, geometry) };
  });
  const anySlotted = targetGeometry.slots !== undefined || joinedEntries.some(entry => entry.geometry.slots !== undefined);
  const combinedSlots = [];
  for (const id of [...targetSlots, ...joinedEntries.flatMap(entry => entry.slots)]) {
    if (!combinedSlots.includes(id)) combinedSlots.push(id);
  }
  if (combinedSlots.length > 0) {
    const missingMaterial = [
      ...(targetSlots.length === 0 ? [target] : []),
      ...joinedEntries.filter(entry => entry.slots.length === 0).map(entry => entry.node),
    ];
    if (missingMaterial.length > 0) {
      throw invalidField('nodes', missingMaterial[0].id, `a node with a material so joined faces keep their material; set material on ${missingMaterial[0].id} first`);
    }
  }
  const needsSlots = anySlotted || combinedSlots.length > 1;
  if (needsSlots && combinedSlots.length > MAX_MATERIAL_SLOTS) {
    throw invalidField('nodes', rawOperation.nodes, `at most ${MAX_MATERIAL_SLOTS} distinct materials across joined meshes, got ${combinedSlots.length}`);
  }
  const nodesById = new Map(candidate.nodes.map(entry => [entry.id, entry]));
  const inverseTarget = mat4.invert(mat4.create(), worldMatrixOf(target, nodesById));
  if (!inverseTarget) {
    throw invalidField('node', target.id, 'a node whose scale is not 0 on any axis, so other meshes can be placed in its space');
  }
  const joinEdits = joinedEntries.map(({ node, slots }) => ({
    op: 'join', geometry: node.geometry,
    matrix: Array.from(mat4.multiply(mat4.create(), inverseTarget, worldMatrixOf(node, nodesById)), value => Math.fround(value)),
    ...(needsSlots ? { slotMap: slots.map(id => combinedSlots.indexOf(id)) } : {}),
  }));
  const editedGeometry = ownGeometryCopy(candidate, target, targetGeometry);
  if (needsSlots) {
    editedGeometry.slots = combinedSlots;
    if (target.material === undefined) target.material = combinedSlots[0];
  }
  const edits = [...(editedGeometry.edits ?? []), ...joinEdits];
  normalizeMeshEdits(edits);
  editedGeometry.edits = edits;
  const removed = new Set(joined.map(node => node.id));
  candidate.nodes = candidate.nodes.filter(entry => !removed.has(entry.id));
  return removed;
}

/**
 * The assign-face-material operation: points `operation.faces` of `operation.node` at a material slot (by `slot` index or
 * `material` ID, adding a slot when needed). A shared geometry is copied first.
 */
function assignFaceMaterial(candidate, rawOperation, faceCountOf) {
  knownKeys(rawOperation, ASSIGN_FACE_MATERIAL_FIELDS, 'operation');
  const node = checkedMeshNode(candidate, nodeNamed(candidate, rawOperation.node, 'node'), 'node', 'assign-face-material');
  const source = meshGeometryOfNode(candidate, node, 'node');
  const faces = checkedFaces(rawOperation.faces, faceCountOf(source.id), { allowAll: true, maxCount: MAX_ASSIGN_FACES });
  const hasSlot = rawOperation.slot !== undefined;
  const hasMaterial = rawOperation.material !== undefined;
  if (hasSlot === hasMaterial) {
    throw invalidField(hasSlot ? 'material' : 'slot', hasSlot ? rawOperation.material : rawOperation.slot, 'either slot (a whole slot number from 0 up) or material (the ID of a material in materials), not both');
  }
  let targetSlot;
  let nextSlots = source.slots ? [...source.slots] : undefined;
  if (hasSlot) {
    const maximumSlot = nextSlots ? nextSlots.length - 1 : 0;
    if (!Number.isInteger(rawOperation.slot) || rawOperation.slot < 0 || rawOperation.slot > maximumSlot) {
      throw invalidField('slot', rawOperation.slot, nextSlots ? `a whole number from 0 to ${maximumSlot}` : '0 (or pass material: "<id>" to add a slot), because this mesh has no slots list yet');
    }
    targetSlot = rawOperation.slot;
  } else {
    const materialIds = new Set(candidate.materials.map(entry => entry.id));
    if (typeof rawOperation.material !== 'string' || !materialIds.has(rawOperation.material)) {
      throw invalidField('material', rawOperation.material, `the ID of a material in materials, one of ${[...materialIds].slice(0, 8).join(', ') || 'none yet; add the material first'}`);
    }
    if (nextSlots) {
      const existingIndex = nextSlots.indexOf(rawOperation.material);
      if (existingIndex >= 0) {
        targetSlot = existingIndex;
      } else {
        if (nextSlots.length >= MAX_MATERIAL_SLOTS) {
          throw invalidField('material', rawOperation.material, `one of the ${MAX_MATERIAL_SLOTS} existing slots (${nextSlots.join(', ')}): a mesh holds at most ${MAX_MATERIAL_SLOTS} slots`);
        }
        nextSlots.push(rawOperation.material);
        targetSlot = nextSlots.length - 1;
      }
    } else if (node.material === rawOperation.material) {
      return;
    } else if (node.material === undefined) {
      nextSlots = [rawOperation.material];
      targetSlot = 0;
    } else {
      nextSlots = [node.material, rawOperation.material];
      targetSlot = 1;
    }
  }
  if (!nextSlots) return;
  const editedGeometry = ownGeometryCopy(candidate, node, source);
  editedGeometry.slots = nextSlots;
  editedGeometry.edits = withEdit(editedGeometry, { op: 'material_slot', select: { faces }, slot: targetSlot });
}

/** Runs one of the mesh-parts operations on the candidate recipe; the nodes a join removes are added to `removedNodes`. */
export function applyMeshPartsOperation(candidate, operation, removedNodes, generateGeometry) {
  if (operation.type === 'separate-faces') {
    separateFaces(candidate, operation, geometryId => editedFaceCount(generateGeometry(geometryId)));
    return;
  }
  if (operation.type === 'assign-face-material') {
    assignFaceMaterial(candidate, operation, geometryId => editedFaceCount(generateGeometry(geometryId)));
    return;
  }
  for (const joinedId of joinNodeMeshes(candidate, operation)) removedNodes.add(joinedId);
}

/** The face count of the mesh a geometry's edit log builds: what a face number of separate-faces counts from. */
function editedFaceCount(geometry) {
  const source = meshEditSourceOf(geometry);
  if (!source) throw new TypeError('This geometry has no editable mesh. Use a recipe geometry with type "mesh".');
  return source.mesh.faceCount;
}
