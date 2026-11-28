import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import { invalidField } from './field-error.js';

// Relations place a part against another part's bounds or mate directional ports, so a resized or rotated parent
// keeps attached children aligned cleanly. Solved deterministically in dependency order after geometry exists.

export const RELATION_KINDS = Object.freeze(['attach', 'flush', 'align', 'centered', 'gap', 'level', 'connect']);
export const LEVEL_FACES = Object.freeze(['bottom', 'center', 'top']);
export const RELATION_SIDES = Object.freeze(['+x', '-x', '+y', '-y', '+z', '-z']);
export const RELATION_LIMITS = Object.freeze({ maxPerNode: 8, maxNodes: 4096, maxOffset: 1e6, maxPortsPerNode: 32 });

const AXES = Object.freeze(['x', 'y', 'z']);
const ANCHORS = Object.freeze(['min', 'center', 'max']);
const PORT_FIELDS = Object.freeze(['position', 'normal', 'up', 'radius', 'category']);
const KIND_FIELDS = Object.freeze({
  attach: ['side', 'offset'],
  gap: ['side', 'offset'],
  flush: ['side', 'offset'],
  align: ['axis', 'at', 'offset'],
  centered: ['axes'],
  level: ['at', 'y'],
  connect: ['fromPort', 'toPort', 'offset', 'roll'],
});

function axisIndex(axis) {
  return AXES.indexOf(axis);
}

function sideAxis(side) {
  return axisIndex(side[1]);
}

function relationPath(nodeIndex, index) {
  return `nodes[${nodeIndex}].relations[${index}]`;
}

function assertVector3(value, fieldPath, message) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(number => typeof number === 'number' && Number.isFinite(number))) {
    throw invalidField(fieldPath, value, message);
  }
  return value;
}

function normalizeUnitVector(vector, fieldPath, message) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!(length > 1e-6)) {
    throw invalidField(fieldPath, vector, message);
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function normalizeSinglePort(path, portSpec) {
  if (!portSpec || typeof portSpec !== 'object' || Array.isArray(portSpec)) {
    throw invalidField(path, portSpec, 'an object such as { "position": [0, 0, 0], "normal": [0, 1, 0] }', TypeError);
  }
  for (const key of Object.keys(portSpec)) {
    if (!PORT_FIELDS.includes(key)) {
      throw invalidField(`${path}.${key.slice(0, 48)}`, portSpec[key], `a field a port takes: ${PORT_FIELDS.join(', ')}`, TypeError);
    }
  }
  const position = [...assertVector3(portSpec.position, `${path}.position`, 'three finite numbers [x, y, z] in local space')];
  const rawNormal = assertVector3(portSpec.normal, `${path}.normal`, 'three finite numbers [nx, ny, nz] with nonzero length');
  const normal = normalizeUnitVector(rawNormal, `${path}.normal`, 'a nonzero outward normal direction, such as [0, 1, 0]');
  const result = { position, normal };
  if (portSpec.up !== undefined) {
    const rawUp = assertVector3(portSpec.up, `${path}.up`, 'three finite numbers [ux, uy, uz] perpendicular to normal');
    const unitRawUp = normalizeUnitVector(rawUp, `${path}.up`, 'a nonzero up direction vector');
    const dotValue = unitRawUp[0] * normal[0] + unitRawUp[1] * normal[1] + unitRawUp[2] * normal[2];
    const projected = [
      unitRawUp[0] - dotValue * normal[0],
      unitRawUp[1] - dotValue * normal[1],
      unitRawUp[2] - dotValue * normal[2],
    ];
    result.up = normalizeUnitVector(projected, `${path}.up`, 'an up vector not collinear with normal');
  }
  if (portSpec.radius !== undefined) {
    if (typeof portSpec.radius !== 'number' || !Number.isFinite(portSpec.radius) || portSpec.radius <= 0) {
      throw invalidField(`${path}.radius`, portSpec.radius, 'a positive finite radius in metres');
    }
    result.radius = portSpec.radius;
  }
  if (portSpec.category !== undefined) {
    if (typeof portSpec.category !== 'string' || !portSpec.category || portSpec.category.length > 64) {
      throw invalidField(`${path}.category`, portSpec.category, 'a non-empty string of at most 64 characters');
    }
    result.category = portSpec.category;
  }
  return result;
}

/** Validate optional named directional `ports` on each node and return cloned nodes with unit port directions. */
export function normalizeNodePorts(nodes) {
  if (!nodes.some(node => node.ports !== undefined)) {
    return nodes;
  }
  return nodes.map((node, nodeIndex) => {
    if (node.ports === undefined) return node;
    const path = `nodes[${nodeIndex}].ports`;
    if (!node.ports || typeof node.ports !== 'object' || Array.isArray(node.ports)) {
      throw invalidField(path, node.ports, 'an object mapping port names to { position, normal }', TypeError);
    }
    const entries = Object.entries(node.ports);
    if (entries.length === 0) {
      const cleaned = { ...node };
      delete cleaned.ports;
      return cleaned;
    }
    if (entries.length > RELATION_LIMITS.maxPortsPerNode) {
      throw invalidField(path, entries.length, `at most ${RELATION_LIMITS.maxPortsPerNode} ports per node`);
    }
    const normalizedPorts = {};
    for (const [portName, portSpec] of entries) {
      if (!portName || portName.length > 64 || !/\S/.test(portName)) {
        throw invalidField(`${path}.${portName}`, portName, 'a port name of 1 to 64 non-space characters', TypeError);
      }
      normalizedPorts[portName] = normalizeSinglePort(`${path}.${portName}`, portSpec);
    }
    return { ...node, ports: normalizedPorts };
  });
}

// A level relation names no target: it puts the bottom, centre or top face of the part's own world bounds at a world height.
function normalizeLevel(path, relation) {
  for (const key of Object.keys(relation)) {
    if (!['kind', 'at', 'y'].includes(key)) {
      throw invalidField(`${path}.${key.slice(0, 48)}`, relation[key], 'a field a level relation takes: at, y (it names no "to")', TypeError);
    }
  }
  if (!LEVEL_FACES.includes(relation.at)) {
    throw invalidField(`${path}.at`, relation.at, `one of ${LEVEL_FACES.join(', ')}, the face of the part that sits at height y`, TypeError);
  }
  if (typeof relation.y !== 'number' || !Number.isFinite(relation.y) || Math.abs(relation.y) > RELATION_LIMITS.maxOffset) {
    throw invalidField(`${path}.y`, relation.y, `a finite world height in metres within +-${RELATION_LIMITS.maxOffset}, such as 0.5`);
  }
  return { kind: 'level', at: relation.at, y: relation.y };
}

function normalizeConnect(path, relation) {
  if (typeof relation.to !== 'string' || !relation.to) {
    throw invalidField(`${path}.to`, relation.to, 'the ID of the target node whose port this connects to', TypeError);
  }
  if (typeof relation.fromPort !== 'string' || !relation.fromPort) {
    throw invalidField(`${path}.fromPort`, relation.fromPort, 'a port name declared in this node.ports', TypeError);
  }
  if (typeof relation.toPort !== 'string' || !relation.toPort) {
    throw invalidField(`${path}.toPort`, relation.toPort, `a port name declared in "${relation.to}".ports`, TypeError);
  }
  const offset = relation.offset ?? 0;
  if (typeof offset !== 'number' || !Number.isFinite(offset) || Math.abs(offset) > RELATION_LIMITS.maxOffset) {
    throw invalidField(`${path}.offset`, relation.offset, `a finite offset in metres within +-${RELATION_LIMITS.maxOffset}`);
  }
  const roll = relation.roll ?? 0;
  if (typeof roll !== 'number' || !Number.isFinite(roll) || Math.abs(roll) > 360) {
    throw invalidField(`${path}.roll`, relation.roll, 'a roll angle in degrees within +-360');
  }
  return {
    kind: 'connect',
    to: relation.to,
    fromPort: relation.fromPort,
    toPort: relation.toPort,
    ...(offset !== 0 ? { offset } : {}),
    ...(roll !== 0 ? { roll } : {}),
  };
}

function normalizeRelation(nodeIndex, index, relation) {
  const path = relationPath(nodeIndex, index);
  if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
    throw invalidField(path, relation, 'an object such as { "kind": "attach", "to": "body", "side": "+x" }', TypeError);
  }
  if (!RELATION_KINDS.includes(relation.kind)) {
    throw invalidField(`${path}.kind`, relation.kind, `one of ${RELATION_KINDS.join(', ')}`, TypeError);
  }
  const extraFields = relation.kind === 'connect' ? [] : ['region'];
  const allowed = ['kind', 'to', ...extraFields, ...(KIND_FIELDS[relation.kind] ?? [])];
  for (const key of Object.keys(relation)) {
    if (!allowed.includes(key)) {
      throw invalidField(`${path}.${key.slice(0, 48)}`, relation[key], `a field a ${relation.kind} relation takes: ${allowed.join(', ')}`, TypeError);
    }
  }
  if (relation.kind === 'level') {
    return normalizeLevel(path, relation);
  }
  if (relation.kind === 'connect') {
    return normalizeConnect(path, relation);
  }
  if (typeof relation.to !== 'string' || !relation.to) {
    throw invalidField(`${path}.to`, relation.to, 'the ID of the part it is placed against, such as "body"', TypeError);
  }
  if (relation.region !== undefined && (typeof relation.region !== 'string' || !relation.region || relation.region.length > 128)) {
    throw invalidField(`${path}.region`, relation.region, 'a mesh tag name of 1 to 128 characters, such as "top"', TypeError);
  }
  const offset = relation.offset ?? 0;
  if (!Number.isFinite(offset) || Math.abs(offset) > RELATION_LIMITS.maxOffset) {
    throw invalidField(`${path}.offset`, relation.offset, `a finite number of metres within +-${RELATION_LIMITS.maxOffset}, such as 0.1`);
  }
  const result = { kind: relation.kind, to: relation.to };
  if (relation.region !== undefined) {
    result.region = relation.region;
  }
  if (offset !== 0) {
    result.offset = offset;
  }
  if (KIND_FIELDS[relation.kind].includes('side')) {
    if (!RELATION_SIDES.includes(relation.side)) {
      throw invalidField(`${path}.side`, relation.side, `one of ${RELATION_SIDES.join(', ')}, the face of "${relation.to}" it sits against`, TypeError);
    }
    result.side = relation.side;
  }
  if (relation.kind === 'align') {
    if (!AXES.includes(relation.axis) || !ANCHORS.includes(relation.at)) {
      throw invalidField(AXES.includes(relation.axis) ? `${path}.at` : `${path}.axis`, AXES.includes(relation.axis) ? relation.at : relation.axis, AXES.includes(relation.axis) ? 'min, center or max' : 'x, y or z', TypeError);
    }
    result.axis = relation.axis;
    result.at = relation.at;
  }
  if (relation.kind === 'centered') {
    if (relation.axes !== undefined && (!Array.isArray(relation.axes) || relation.axes.length === 0 || relation.axes.length > 3 || !relation.axes.every(axis => AXES.includes(axis)) || new Set(relation.axes).size !== relation.axes.length)) {
      throw invalidField(`${path}.axes`, relation.axes, 'a list of x, y, z with each at most once, such as ["x", "z"]', TypeError);
    }
    result.axes = relation.axes ? [...relation.axes] : [...AXES];
  }
  return result;
}

/** The axes (0 for x, 1 for y, 2 for z) decided by a normalized relation. */
export function relationAxes(relation) {
  switch (relation.kind) {
    case 'attach':
    case 'connect':
      return [0, 1, 2];
    case 'gap':
    case 'flush':
      return [sideAxis(relation.side)];
    case 'align':
      return [axisIndex(relation.axis)];
    case 'level':
      return [1];
    default:
      return relation.axes.map(axisIndex);
  }
}

// Depth-first walk over the things a node's world position waits for: its relation targets and its parent chain.
function dependencyOrder(nodesById, relatedIds) {
  const order = [];
  const finished = new Set();
  const path = [];
  const indexById = new Map([...nodesById.keys()].map((id, position) => [id, position]));
  function visit(nodeId) {
    if (finished.has(nodeId)) {
      return;
    }
    const position = path.indexOf(nodeId);
    if (position !== -1) {
      const cycle = [...path.slice(position), nodeId].map(id => id.slice(0, 48));
      throw invalidField(`nodes[${indexById.get(nodeId)}].relations`, cycle, 'relations that form no loop, since each part waits for the next in the list, parents included; remove one relation in the loop with set-node relations, or place one part with translation');
    }
    path.push(nodeId);
    const node = nodesById.get(nodeId);
    if (node.parent !== null && nodesById.has(node.parent)) {
      visit(node.parent);
    }
    for (const relation of node.relations ?? []) {
      if (relation.kind !== 'level') visit(relation.to);
    }
    path.pop();
    finished.add(nodeId);
    if (relatedIds.has(nodeId)) {
      order.push(nodeId);
    }
  }
  for (const nodeId of relatedIds) {
    visit(nodeId);
  }
  return order;
}

function indexNodes(nodes) {
  return new Map(nodes.map(node => [node.id, node]));
}

/**
 * Validate the relations of a list of normalized nodes and return the nodes with each relations list normalized
 * (an empty list is dropped). Throws on unknown fields, unknown or invalid targets, mismatched port categories,
 * two relations deciding the same axis, and cycles.
 */
export function normalizeRelations(nodes) {
  const portsNormalized = normalizeNodePorts(nodes);
  const related = portsNormalized.filter(node => node.relations !== undefined);
  if (related.length === 0) {
    return portsNormalized;
  }
  const nodesById = indexNodes(portsNormalized);
  const indexById = new Map(portsNormalized.map((node, position) => [node.id, position]));
  const result = portsNormalized.map(node => ({ ...node }));
  const resultById = indexNodes(result);
  let relatedCount = 0;
  for (const node of related) {
    const nodeIndex = indexById.get(node.id);
    if (!Array.isArray(node.relations) || node.relations.length > RELATION_LIMITS.maxPerNode) {
      throw invalidField(`nodes[${nodeIndex}].relations`, node.relations, `an array of at most ${RELATION_LIMITS.maxPerNode} relations; merge or drop some`);
    }
    const normalized = node.relations.map((relation, index) => normalizeRelation(nodeIndex, index, relation));
    const target = resultById.get(node.id);
    if (normalized.length === 0) {
      delete target.relations;
      continue;
    }
    relatedCount++;
    if (relatedCount > RELATION_LIMITS.maxNodes) {
      throw invalidField(`nodes[${nodeIndex}].relations`, node.relations, `relations on at most ${RELATION_LIMITS.maxNodes} nodes; group repeated parts or place the rest with translation`);
    }
    const needsGeometry = normalized.some(relation => relation.kind !== 'connect');
    if (needsGeometry && node.geometry === undefined) {
      throw invalidField(`nodes[${nodeIndex}].relations`, node.relations, 'relations on a mesh node, since this node is a group; put them on a mesh node inside the group, or use connect with ports', TypeError);
    }
    const decided = new Map();
    normalized.forEach((relation, index) => {
      const referenced = relation.kind === 'level' ? undefined : nodesById.get(relation.to);
      if (relation.kind !== 'level' && relation.to === node.id) {
        throw invalidField(`${relationPath(nodeIndex, index)}.to`, relation.to, 'the ID of another part, such as "body", not its own node');
      }
      if (!referenced && relation.kind !== 'level') {
        throw invalidField(`${relationPath(nodeIndex, index)}.to`, relation.to, 'the ID of a node in this recipe; list them with scene_inspect, or drop the relation');
      }
      if (relation.kind === 'connect') {
        const ownPort = node.ports?.[relation.fromPort];
        if (!ownPort) {
          const available = Object.keys(node.ports ?? {}).join(', ') || 'none';
          throw invalidField(`${relationPath(nodeIndex, index)}.fromPort`, relation.fromPort, `a port declared in nodes[${nodeIndex}].ports (available: ${available})`);
        }
        const targetPort = referenced.ports?.[relation.toPort];
        if (!targetPort) {
          const available = Object.keys(referenced.ports ?? {}).join(', ') || 'none';
          throw invalidField(`${relationPath(nodeIndex, index)}.toPort`, relation.toPort, `a port declared in "${relation.to}".ports (available: ${available})`);
        }
        if (ownPort.category !== undefined && targetPort.category !== undefined && ownPort.category !== targetPort.category) {
          throw invalidField(`${relationPath(nodeIndex, index)}.fromPort`, ownPort.category, `compatible port category matching "${relation.to}".${relation.toPort} ("${targetPort.category}")`);
        }
      } else if (referenced && referenced.geometry === undefined) {
        throw invalidField(`${relationPath(nodeIndex, index)}.to`, relation.to, 'the ID of a mesh node, such as a box, since this one is a group with no geometry');
      }
      for (const axis of relationAxes(relation)) {
        if (decided.has(axis)) {
          throw invalidField(`${relationPath(nodeIndex, index)}.kind`, relation.kind, `a relation that leaves the ${AXES[axis]} axis to relation ${decided.get(axis)}, which already decides it; keep one relation per axis`);
        }
        decided.set(axis, index);
      }
    });
    target.relations = normalized;
  }
  dependencyOrder(resultById, new Set(related.filter(node => resultById.get(node.id).relations).map(node => node.id)));
  return result;
}

function worldMatrixOf(nodeId, nodesById, cache) {
  const cached = cache.get(nodeId);
  if (cached) {
    return cached;
  }
  const node = nodesById.get(nodeId);
  const local = mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale);
  const world = node.parent !== null && nodesById.has(node.parent)
    ? mat4.multiply(local, worldMatrixOf(node.parent, nodesById, cache), local)
    : local;
  cache.set(nodeId, world);
  return world;
}

function targetValue(bounds, axis, anchor) {
  if (anchor === 'min') {
    return bounds.min[axis];
  }
  if (anchor === 'max') {
    return bounds.max[axis];
  }
  return (bounds.min[axis] + bounds.max[axis]) / 2;
}

// Each constraint says: this part's `anchor` on `axis` should sit at `value`.
function constraintsFor(relation, selfBounds, targetBounds) {
  const offset = relation.offset ?? 0;
  const wanted = [];
  if (relation.kind === 'level') {
    const anchor = { bottom: 'min', center: 'center', top: 'max' }[relation.at];
    return [{ axis: 1, anchor, value: relation.y, delta: relation.y - targetValue(selfBounds, 1, anchor) }];
  }
  const sideAnchors = side => {
    const axis = sideAxis(side);
    const outward = side[0] === '+';
    return { axis, outward };
  };
  if (relation.kind === 'gap' || relation.kind === 'attach') {
    const { axis, outward } = sideAnchors(relation.side);
    wanted.push(outward
      ? { axis, anchor: 'min', value: targetBounds.max[axis] + offset }
      : { axis, anchor: 'max', value: targetBounds.min[axis] - offset });
  }
  if (relation.kind === 'attach') {
    const { axis: sideAxisIndex } = sideAnchors(relation.side);
    for (const axis of [0, 1, 2].filter(candidate => candidate !== sideAxisIndex)) {
      wanted.push({ axis, anchor: 'center', value: targetValue(targetBounds, axis, 'center') });
    }
  }
  if (relation.kind === 'flush') {
    const { axis, outward } = sideAnchors(relation.side);
    const anchor = outward ? 'max' : 'min';
    wanted.push({ axis, anchor, value: targetValue(targetBounds, axis, anchor) + offset });
  }
  if (relation.kind === 'align') {
    const axis = axisIndex(relation.axis);
    wanted.push({ axis, anchor: relation.at, value: targetValue(targetBounds, axis, relation.at) + offset });
  }
  if (relation.kind === 'centered') {
    for (const axis of relation.axes.map(axisIndex)) {
      wanted.push({ axis, anchor: 'center', value: targetValue(targetBounds, axis, 'center') });
    }
  }
  return wanted.map(constraint => ({ ...constraint, delta: constraint.value - targetValue(selfBounds, constraint.axis, constraint.anchor) }));
}

function assertFiniteBounds(bounds, path, value) {
  if (!bounds || !bounds.min?.every(Number.isFinite) || !bounds.max?.every(Number.isFinite)) {
    throw invalidField(path, value, 'finite world bounds');
  }
}

function defaultUpForNormal(normal) {
  const candidate = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const dotValue = candidate[0] * normal[0] + candidate[1] * normal[1] + candidate[2] * normal[2];
  const projected = vec3.fromValues(
    candidate[0] - dotValue * normal[0],
    candidate[1] - dotValue * normal[1],
    candidate[2] - dotValue * normal[2],
  );
  return vec3.normalize(projected, projected);
}

function basisFromNormalAndUp(normal, upHint) {
  const forward = vec3.normalize(vec3.create(), normal);
  let up;
  if (upHint) {
    const dotValue = vec3.dot(upHint, forward);
    const projected = vec3.fromValues(
      upHint[0] - dotValue * forward[0],
      upHint[1] - dotValue * forward[1],
      upHint[2] - dotValue * forward[2],
    );
    up = vec3.length(projected) > 1e-6 ? vec3.normalize(projected, projected) : defaultUpForNormal(forward);
  } else {
    up = defaultUpForNormal(forward);
  }
  // Right-handed basis: right = up x forward, so det([right, up, forward]) === +1.
  const right = vec3.cross(vec3.create(), up, forward);
  vec3.normalize(right, right);
  return mat3.fromValues(
    right[0], right[1], right[2],
    up[0], up[1], up[2],
    forward[0], forward[1], forward[2],
  );
}

function rotationQuaternionOfMatrix(matrix) {
  const col0 = vec3.normalize(vec3.create(), [matrix[0], matrix[1], matrix[2]]);
  const col1 = vec3.normalize(vec3.create(), [matrix[4], matrix[5], matrix[6]]);
  const col2 = vec3.normalize(vec3.create(), [matrix[8], matrix[9], matrix[10]]);
  const rotationMatrix = mat3.fromValues(
    col0[0], col0[1], col0[2],
    col1[0], col1[1], col1[2],
    col2[0], col2[1], col2[2],
  );
  return quat.normalize(quat.create(), quat.fromMat3(quat.create(), rotationMatrix));
}

function solveConnectRelation({ node, nodeIndex, relation, target, targetWorld, parentWorld }) {
  const selfPort = node.ports[relation.fromPort];
  const targetPort = target.ports[relation.toPort];
  const worldTargetPos = vec3.transformMat4(vec3.create(), targetPort.position, targetWorld);
  const targetNormalMatrix = mat3.normalFromMat4(mat3.create(), targetWorld);
  if (!targetNormalMatrix) {
    throw invalidField(`${relationPath(nodeIndex, 0)}.to`, relation.to, 'a target transform with non-zero scale');
  }
  const worldTargetNormal = vec3.normalize(
    vec3.create(),
    vec3.transformMat3(vec3.create(), targetPort.normal, targetNormalMatrix),
  );
  const matingNormal = vec3.negate(vec3.create(), worldTargetNormal);
  const worldTargetUp = targetPort.up
    ? vec3.transformMat3(vec3.create(), targetPort.up, targetNormalMatrix)
    : undefined;

  const selfBasis = basisFromNormalAndUp(selfPort.normal, selfPort.up);
  const targetBasis = basisFromNormalAndUp(matingNormal, worldTargetUp);
  if (relation.roll) {
    const rollRadians = (relation.roll * Math.PI) / 180;
    const rollQuat = quat.setAxisAngle(quat.create(), matingNormal, rollRadians);
    const rollMat = mat3.fromQuat(mat3.create(), rollQuat);
    mat3.multiply(targetBasis, rollMat, targetBasis);
  }

  const worldRotationMatrix = mat3.multiply(mat3.create(), targetBasis, mat3.transpose(mat3.create(), selfBasis));
  const worldRotationQuat = quat.normalize(quat.create(), quat.fromMat3(quat.create(), worldRotationMatrix));
  const parentRotationQuat = rotationQuaternionOfMatrix(parentWorld);
  const localRotation = quat.normalize(
    quat.create(),
    quat.multiply(quat.create(), quat.invert(quat.create(), parentRotationQuat), worldRotationQuat),
  );
  node.rotation = [localRotation[0], localRotation[1], localRotation[2], localRotation[3]];

  const localWithoutTranslation = mat4.fromRotationTranslationScale(mat4.create(), node.rotation, [0, 0, 0], node.scale);
  const worldWithoutTranslation = mat4.multiply(mat4.create(), parentWorld, localWithoutTranslation);
  const worldSelfPortAtOrigin = vec3.transformMat4(vec3.create(), selfPort.position, worldWithoutTranslation);
  const offset = relation.offset ?? 0;
  const targetPoint = vec3.scaleAndAdd(vec3.create(), worldTargetPos, worldTargetNormal, offset);
  const worldTranslation = vec3.subtract(vec3.create(), targetPoint, worldSelfPortAtOrigin);
  const inverseParent = mat4.invert(mat4.create(), parentWorld);
  if (!inverseParent) {
    throw invalidField(`${relationPath(nodeIndex, 0)}.to`, node.parent, 'a parent transform with nonzero scale');
  }
  const localTranslation = vec3.transformMat4(vec3.create(), worldTranslation, inverseParent);
  node.translation = [localTranslation[0], localTranslation[1], localTranslation[2]];
}

function invalidateSubtree(nodeId, childrenByParent, cache) {
  cache.delete(nodeId);
  const children = childrenByParent.get(nodeId);
  if (!children) return;
  for (const childId of children) {
    invalidateSubtree(childId, childrenByParent, cache);
  }
}

/**
 * Solve every relation and return nodes whose translations and rotations satisfy them (unrelated nodes are returned as is).
 * `worldBounds(node, worldMatrix, region)` returns the axis-aligned world bounds `{ min, max }` of a mesh node, or of
 * the faces carrying the tag `region`, and throws a message that names the tag when it does not exist.
 */
export function solveRelations(nodes, worldBounds) {
  const related = nodes.filter(node => node.relations?.length);
  if (related.length === 0) {
    return nodes;
  }
  const result = nodes.map(node => ({ ...node }));
  const nodesById = indexNodes(result);
  const nodeIndexById = new Map(nodes.map((node, index) => [node.id, index]));
  const childrenByParent = new Map();
  for (const node of result) {
    if (node.parent !== null) {
      if (!childrenByParent.has(node.parent)) childrenByParent.set(node.parent, []);
      childrenByParent.get(node.parent).push(node.id);
    }
  }
  const cache = new Map();
  const identity = mat4.create();
  for (const nodeId of dependencyOrder(nodesById, new Set(related.map(node => node.id)))) {
    const node = nodesById.get(nodeId);
    const nodeIndex = nodeIndexById.get(nodeId);
    const parentWorld = node.parent !== null && nodesById.has(node.parent) ? worldMatrixOf(node.parent, nodesById, cache) : identity;
    if (node.relations.length === 1 && node.relations[0].kind === 'connect') {
      const connectRelation = node.relations[0];
      const target = nodesById.get(connectRelation.to);
      solveConnectRelation({
        node,
        nodeIndex,
        relation: connectRelation,
        target,
        targetWorld: worldMatrixOf(target.id, nodesById, cache),
        parentWorld,
      });
      if (!node.translation.every(Number.isFinite) || !node.rotation.every(Number.isFinite)) {
        throw invalidField(`nodes[${nodeIndex}].translation`, node.translation, 'finite numbers after connect solve');
      }
      invalidateSubtree(nodeId, childrenByParent, cache);
      continue;
    }

    const delta = [0, 0, 0];
    const selfBounds = worldBounds(node, worldMatrixOf(nodeId, nodesById, cache), undefined);
    assertFiniteBounds(selfBounds, `nodes[${nodeIndex}]`, node.id);
    node.relations.forEach((relation, index) => {
      if (relation.kind === 'level') {
        for (const constraint of constraintsFor(relation, selfBounds, undefined)) {
          delta[constraint.axis] = constraint.delta;
        }
        return;
      }
      const target = nodesById.get(relation.to);
      let targetBounds;
      try {
        targetBounds = worldBounds(target, worldMatrixOf(target.id, nodesById, cache), relation.region);
      } catch (error) {
        throw invalidField(`${relationPath(nodeIndex, index)}.${relation.region === undefined ? 'to' : 'region'}`, relation.region ?? relation.to, `a target that can be measured (${error.message})`);
      }
      assertFiniteBounds(targetBounds, `${relationPath(nodeIndex, index)}.${relation.region === undefined ? 'to' : 'region'}`, relation.region ?? relation.to);
      for (const constraint of constraintsFor(relation, selfBounds, targetBounds)) {
        delta[constraint.axis] = constraint.delta;
      }
    });
    const inverse = mat4.invert(mat4.create(), parentWorld);
    if (!inverse) {
      throw invalidField(`nodes[${nodeIndexById.get(node.parent)}].scale`, nodesById.get(node.parent).scale, `a scale with no zero axis, since the relations of nodes[${nodeIndex}] cannot be solved under it, such as [1, 1, 1]`);
    }
    const local = vec3.transformMat4(vec3.create(), delta, inverse);
    const origin = vec3.transformMat4(vec3.create(), [0, 0, 0], inverse);
    node.translation = node.translation.map((value, axis) => value + local[axis] - origin[axis]);
    if (!node.translation.every(Number.isFinite)) {
      throw invalidField(`nodes[${nodeIndex}].translation`, node.translation, 'finite numbers, but its relations produce a translation outside the number range; reduce offsets or part sizes');
    }
    invalidateSubtree(nodeId, childrenByParent, cache);
  }
  return result;
}
