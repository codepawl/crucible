import { mat4 } from 'gl-matrix';
import { invalidField } from './field-error.js';
import { knownKeys } from './motion-validation.js';
import { meshEditSourceOf } from './agent-mesh.js';
import { normalizeMeshEdits } from './mesh-recipe.js';

// The scene operations that split one mesh object into two and merge several into one:
//   separate-faces { node, faces: [face numbers], id? }   the picked faces become a new node, nothing moves in the world
//   join-meshes    { node, nodes: [node IDs] }            the other nodes' meshes join the mesh of `node`, then those nodes go
// Both write ordinary recipe data (a `delete` edit on a copy of the mesh, a `join` edit that places another geometry), so
// the result replays, saves and undoes like any other edit. A geometry another node still uses is copied first.

export const MAX_JOINED_NODES = 32;
const SEPARATE_FIELDS = ['type', 'node', 'faces', 'id'];
const JOIN_FIELDS = ['type', 'node', 'nodes'];
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

function checkedFaces(faces, faceCount) {
  if (!Array.isArray(faces) || faces.length === 0) {
    throw invalidField('faces', faces, 'a nonempty array of face numbers of the mesh, such as [0, 1, 4]; mesh_inspect or Studio edit mode shows them');
  }
  if (faces.length >= faceCount) {
    throw invalidField('faces', `${faces.length} of ${faceCount} faces`, 'fewer faces than the mesh has: the object keeps at least one face, so pick part of it');
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

function checkedJoinedNode(candidate, node, target) {
  checkedMeshNode(candidate, node, 'nodes', 'join-meshes');
  if (candidate.nodes.some(entry => entry.parent === node.id)) {
    throw invalidField('nodes', node.id, `a node without children, since joining removes it; move the children of ${node.id} to another parent with set-node first`);
  }
  if ((candidate.motion?.tracks ?? []).some(track => track.id === node.id) || (candidate.physics?.bodies ?? []).some(body => body.node === node.id)) {
    throw invalidField('nodes', node.id, `a node without motion tracks or a physics body, since joining removes it; remove those of ${node.id} first`);
  }
  if ((node.material ?? null) !== (target.material ?? null)) {
    throw invalidField('nodes', node.id, `a node with the material of ${target.id} (${target.material ?? 'none'}), but ${node.id} has ${node.material ?? 'none'}; one mesh draws with one material, so give them the same one with set-node first, or keep them as separate objects`);
  }
}

/**
 * The join-meshes operation. The meshes of `operation.nodes` are added to the mesh of `operation.node` (the active one), each
 * placed so it stays where it was in the world, and those nodes are removed. Returns the IDs of the removed nodes.
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
  for (const node of joined) checkedJoinedNode(candidate, node, target);
  const nodesById = new Map(candidate.nodes.map(entry => [entry.id, entry]));
  const inverseTarget = mat4.invert(mat4.create(), worldMatrixOf(target, nodesById));
  if (!inverseTarget) {
    throw invalidField('node', target.id, 'a node whose scale is not 0 on any axis, so other meshes can be placed in its space');
  }
  const joinEdits = joined.map(node => ({
    op: 'join', geometry: node.geometry,
    matrix: Array.from(mat4.multiply(mat4.create(), inverseTarget, worldMatrixOf(node, nodesById)), value => Math.fround(value)),
  }));
  let editedGeometry = targetGeometry;
  if (candidate.nodes.some(entry => entry !== target && entry.geometry === targetGeometry.id)) {
    editedGeometry = { ...structuredClone(targetGeometry), id: freeId(new Set(candidate.geometries.map(entry => entry.id)), `${targetGeometry.id}-${target.id}`) };
    candidate.geometries.push(editedGeometry);
    target.geometry = editedGeometry.id;
  }
  const edits = [...(editedGeometry.edits ?? []), ...joinEdits];
  normalizeMeshEdits(edits);
  editedGeometry.edits = edits;
  const removed = new Set(joined.map(node => node.id));
  candidate.nodes = candidate.nodes.filter(entry => !removed.has(entry.id));
  return removed;
}

/** Runs one of the two operations on the candidate recipe; the nodes a join removes are added to `removedNodes`. */
export function applyMeshPartsOperation(candidate, operation, removedNodes, generateGeometry) {
  if (operation.type === 'separate-faces') {
    separateFaces(candidate, operation, geometryId => editedFaceCount(generateGeometry(geometryId)));
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
