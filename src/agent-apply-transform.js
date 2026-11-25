import { quat, vec3 } from 'gl-matrix';
import { invalidField } from './field-error.js';
import { knownKeys } from './motion-validation.js';

// The apply-transform and set-origin operations. Both rewrite the geometry of one node and the node's own transform together,
// so the world position of every vertex stays where it was: apply-transform folds location, rotation and scale into the
// geometry (the node then reads 0, no turn and 1), set-origin moves the point the node turns and scales about.
// The geometry change is written into the node's mesh edit log, so it replays the same everywhere and undoes with the scene.

export const APPLY_TRANSFORM_PARTS = Object.freeze(['location', 'rotation', 'scale']);
export const ORIGIN_TARGETS = Object.freeze(['geometry', 'bottom', 'point']);

// Shapes that become a mesh on their first edit, as the mesh geometry's `base` accepts them.
const SHAPES_THAT_BECOME_A_MESH = new Set(['plane', 'grid', 'box', 'circle', 'sphere', 'icoSphere', 'cylinder', 'cone', 'torus']);
const IDENTITY_ROTATION_TOLERANCE = 1e-12;
const NODE_FIELDS_THAT_BLOCK_EDITING = ['asset', 'instances', 'vegetation', 'clutter', 'grass', 'skin'];

function requireNodeId(operation) {
  if (typeof operation.node !== 'string' || operation.node === '') {
    throw invalidField('node', operation.node, 'the ID of a node to change, such as "crate"', TypeError);
  }
  return operation.node;
}

function uniqueGeometryId(candidate, wanted) {
  const taken = new Set(candidate.geometries.map(geometry => geometry.id));
  let identifier = wanted;
  for (let suffix = 2; taken.has(identifier); suffix += 1) {
    identifier = `${wanted}-${suffix}`;
  }
  return identifier;
}

function nodeToChange(candidate, operation) {
  const nodeId = requireNodeId(operation);
  const node = candidate.nodes.find(candidateNode => candidateNode.id === nodeId);
  if (!node) {
    throw invalidField('node', nodeId, 'the ID of an existing node; scene_inspect lists them');
  }
  const blocking = NODE_FIELDS_THAT_BLOCK_EDITING.find(field => node[field] !== undefined);
  if (blocking) {
    throw invalidField('node', nodeId, `a node with its own geometry, but "${nodeId}" carries ${blocking}, which has no geometry of the recipe to change`);
  }
  if (typeof node.geometry !== 'string') {
    throw invalidField('node', nodeId, `a node that has a geometry, but "${nodeId}" is a group or an empty object; select a shape or a mesh`);
  }
  const driven = (candidate.motion?.tracks ?? []).some(track => track.kind === 'node' && track.id === nodeId);
  if (driven) {
    throw invalidField('node', nodeId, `a node no motion track drives, but a track moves "${nodeId}"; remove its tracks with set-motion removeTracks first, or its transform would move the object again`);
  }
  return node;
}

function geometryOfNode(candidate, node) {
  const geometry = candidate.geometries.find(candidateGeometry => candidateGeometry.id === node.geometry);
  if (!geometry) {
    throw invalidField('node', node.id, `a node whose geometry "${node.geometry}" exists; add the geometry first`);
  }
  if ((geometry.stack ?? []).length > 0) {
    throw invalidField('node', node.id, `a node whose mesh has no modifiers, because they run after the edit log and would give a different shape; apply or remove the modifiers of "${geometry.id}" first with set-mesh-stack`);
  }
  if (geometry.type !== 'mesh' && !SHAPES_THAT_BECOME_A_MESH.has(geometry.type)) {
    throw invalidField('node', node.id, `a node with a mesh or a basic shape (box, sphere, cylinder, cone, plane, circle, torus), but its geometry is a ${geometry.type}`);
  }
  return geometry;
}

/**
 * The mesh geometry whose edit log carries the change for this node alone. A mesh the node owns is changed in place; a shape the
 * node owns becomes a mesh under the same ID (nothing else uses it); a geometry other nodes also use is copied for this node.
 */
function geometryOwnedBy(candidate, node, geometry) {
  const sharing = candidate.nodes.filter(candidateNode => candidateNode.geometry === geometry.id).length > 1;
  if (geometry.type === 'mesh' && !sharing) {
    return geometry;
  }
  const { id: previousId, ...description } = structuredClone(geometry);
  const meshDescription = geometry.type === 'mesh' ? description : { type: 'mesh', base: description };
  if (!sharing) {
    const own = { id: previousId, ...meshDescription };
    candidate.geometries[candidate.geometries.indexOf(geometry)] = own;
    return own;
  }
  const own = { id: uniqueGeometryId(candidate, `${previousId}-${node.id}`), ...meshDescription };
  candidate.geometries.push(own);
  node.geometry = own.id;
  return own;
}

function appendEdits(geometry, edits) {
  geometry.edits = [...(geometry.edits ?? []), ...edits];
}

function readTransform(node) {
  return {
    translation: vec3.fromValues(...(node.translation ?? [0, 0, 0])),
    rotation: quat.normalize(quat.create(), quat.fromValues(...(node.rotation ?? [0, 0, 0, 1]))),
    scale: vec3.fromValues(...(node.scale ?? [1, 1, 1])),
  };
}

function isIdentityRotation(rotation) {
  return Math.abs(Math.abs(rotation[3]) - 1) < IDENTITY_ROTATION_TOLERANCE;
}

function isUniformScale(scale) {
  return scale[0] === scale[1] && scale[1] === scale[2];
}

function parseParts(operation) {
  knownKeys(operation, ['type', 'node', 'parts'], 'operation');
  const parts = operation.parts ?? APPLY_TRANSFORM_PARTS;
  const valid = Array.isArray(parts) && parts.length > 0 && parts.length <= APPLY_TRANSFORM_PARTS.length
    && parts.every(part => APPLY_TRANSFORM_PARTS.includes(part)) && new Set(parts).size === parts.length;
  if (!valid) {
    throw invalidField('parts', operation.parts, `a list of ${APPLY_TRANSFORM_PARTS.map(part => `"${part}"`).join(', ')} (each once), such as ["scale"]; leave it out to apply all three`, TypeError);
  }
  return new Set(parts);
}

function requireLeaf(candidate, node) {
  const children = candidate.nodes.filter(candidateNode => candidateNode.parent === node.id).map(child => child.id);
  if (children.length > 0) {
    throw invalidField('node', node.id, `a node without children, because applying its transform would move ${children.slice(0, 3).join(', ')}${children.length > 3 ? ' and more' : ''}; apply the children first or move them out of the group`);
  }
}

/** The node's part of the transform that stays after the chosen parts are applied: the geometry offset that keeps its place is the inverse of this applied to the translation. */
function linearPartLeftOnNode(transform, applied) {
  return {
    rotation: applied.has('rotation') ? quat.create() : transform.rotation,
    scale: applied.has('scale') ? vec3.fromValues(1, 1, 1) : transform.scale,
  };
}

function inverseOfLinearPart(linear, vector) {
  const turned = vec3.transformQuat(vec3.create(), vector, quat.invert(quat.create(), linear.rotation));
  return vec3.divide(vec3.create(), turned, linear.scale);
}

function transformSelectionEdit(transform, applied) {
  const edit = { op: 'transform_selection', select: { all: true }, pivot: [0, 0, 0] };
  if (applied.has('scale') && !vec3.equals(transform.scale, vec3.fromValues(1, 1, 1))) {
    edit.scale = [...transform.scale];
  }
  if (applied.has('rotation') && !isIdentityRotation(transform.rotation)) {
    const axis = vec3.create();
    const angle = quat.getAxisAngle(axis, transform.rotation);
    edit.rotation = { axis: [...axis], angle };
  }
  return edit.scale || edit.rotation ? edit : null;
}

/**
 * Apply one `apply-transform` operation to a candidate recipe: `{ type, node, parts? }`, parts being any of location, rotation
 * and scale (all three when left out). The node's transform for those parts becomes none (0, no turn, 1) and its geometry takes
 * it on, so the object looks the same. A mirrored (negative) scale keeps its faces facing outward.
 */
export function applyNodeTransform(candidate, operation) {
  const applied = parseParts(operation);
  const node = nodeToChange(candidate, operation);
  const geometry = geometryOfNode(candidate, node);
  const transform = readTransform(node);
  const turnsUnderStretch = applied.has('rotation') && !applied.has('scale') && !isIdentityRotation(transform.rotation) && !isUniformScale(transform.scale);
  if (turnsUnderStretch) {
    throw invalidField('parts', [...applied], 'a list that also has "scale" when the node is stretched unevenly, because turning the geometry alone would shear it; apply scale with rotation, or all three');
  }
  const selection = transformSelectionEdit(transform, applied);
  const edits = selection ? [selection] : [];
  const leftOnNode = linearPartLeftOnNode(transform, applied);
  const locationOffset = applied.has('location') && vec3.length(transform.translation) > 0
    ? inverseOfLinearPart(leftOnNode, transform.translation)
    : null;
  if (locationOffset) {
    edits.push({ op: 'translate', select: { all: true }, offset: [...locationOffset] });
  }
  if (edits.length === 0 && !hasTransformToReset(node, applied)) {
    return { changed: false };
  }
  requireLeaf(candidate, node);
  if (edits.length > 0) {
    appendEdits(geometryOwnedBy(candidate, node, geometry), edits);
  }
  if (applied.has('location')) node.translation = [0, 0, 0];
  if (applied.has('rotation')) node.rotation = [0, 0, 0, 1];
  if (applied.has('scale')) node.scale = [1, 1, 1];
  return { changed: true };
}

function hasTransformToReset(node, applied) {
  return (applied.has('location') && (node.translation ?? [0, 0, 0]).some(component => component !== 0))
    || (applied.has('rotation') && !isIdentityRotation(readTransform(node).rotation))
    || (applied.has('scale') && (node.scale ?? [1, 1, 1]).some(component => component !== 1));
}

function boundsOf(positions) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
      maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
    }
  }
  return { minimum, maximum };
}

function originPoint(operation, geometryPositions) {
  if (operation.to === 'point') {
    const point = operation.point;
    if (!Array.isArray(point) || point.length !== 3 || point.some(component => !Number.isFinite(component))) {
      throw invalidField('point', point, 'three finite numbers in the object\'s own space, such as [0, -0.5, 0]', TypeError);
    }
    return point;
  }
  if (operation.point !== undefined) {
    throw invalidField('point', operation.point, 'left out unless "to" is "point"');
  }
  const { minimum, maximum } = boundsOf(geometryPositions);
  const middle = [0, 1, 2].map(axis => (minimum[axis] + maximum[axis]) / 2);
  return operation.to === 'geometry' ? middle : [middle[0], minimum[1], middle[2]];
}

/**
 * Apply one `set-origin` operation: `{ type, node, to: "geometry" | "bottom" | "point", point? }`. The point the node turns and
 * scales about moves to the middle of the geometry's bounds, the middle of its lowest face, or `point` (all in the object's own,
 * unscaled space). The geometry shifts the other way and the node moves with it, so nothing moves on screen; children stay where
 * they are.
 */
export function setNodeOrigin(candidate, operation, generatePositions) {
  knownKeys(operation, ['type', 'node', 'to', 'point'], 'operation');
  if (!ORIGIN_TARGETS.includes(operation.to)) {
    throw invalidField('to', operation.to, `one of ${ORIGIN_TARGETS.join(', ')}, such as "geometry"`, TypeError);
  }
  const node = nodeToChange(candidate, operation);
  const geometry = geometryOfNode(candidate, node);
  const point = originPoint(operation, operation.to === 'point' ? [] : generatePositions(candidate, geometry.id));
  if (point.every(component => component === 0)) {
    return { changed: false };
  }
  const transform = readTransform(node);
  const shiftOfNode = vec3.transformQuat(vec3.create(), vec3.multiply(vec3.create(), transform.scale, point), transform.rotation);
  appendEdits(geometryOwnedBy(candidate, node, geometry), [{ op: 'translate', select: { all: true }, offset: point.map(component => -component) }]);
  node.translation = [...vec3.add(vec3.create(), transform.translation, shiftOfNode)];
  for (const child of candidate.nodes.filter(candidateNode => candidateNode.parent === node.id)) {
    child.translation = [0, 1, 2].map(axis => (child.translation?.[axis] ?? 0) - point[axis]);
  }
  return { changed: true };
}
