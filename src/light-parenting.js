// Lights attached to parts (#3239): a light with `parent` follows the world transform of that node on every frame, and an
// area light with `face` is the rectangle of one face of the parent's bounding box, shining outward.
import { invalidField } from './field-error.js';

export const LIGHT_PARENT_FIELDS = Object.freeze(['parent']);
export const SURFACE_LIGHT_FIELDS = Object.freeze(['face', 'faceOffset']);

const LIGHT_LISTS = ['pointLights', 'spotLights', 'areaLights'];
const MAX_PARENT_LENGTH = 256;
const DEFAULT_FACE_OFFSET = 0.002;
const MAX_FACE_OFFSET = 100;

// The axis a face looks along, and the two axes of its rectangle: width along `across`, height along `along`.
const FACES = Object.freeze({
  '+x': { sign: 1, normal: 0, across: 2, along: 1 },
  '-x': { sign: -1, normal: 0, across: 2, along: 1 },
  '+y': { sign: 1, normal: 1, across: 0, along: 2 },
  '-y': { sign: -1, normal: 1, across: 0, along: 2 },
  '+z': { sign: 1, normal: 2, across: 0, along: 1 },
  '-z': { sign: -1, normal: 2, across: 0, along: 1 },
});
export const SURFACE_LIGHT_FACES = Object.freeze(Object.keys(FACES));

/** The `parent` field of a light: a node ID, or the name of a glTF part of a placed asset. Returns {} when unset. */
export function parentFieldFrom(light) {
  if (light.parent === undefined) return {};
  if (typeof light.parent !== 'string' || light.parent.length === 0 || light.parent.length > MAX_PARENT_LENGTH) {
    throw invalidField('parent', light.parent, `a node ID or glTF part name of 1 to ${MAX_PARENT_LENGTH} characters, such as "lamp"; scene_inspect lists the IDs`);
  }
  return { parent: light.parent };
}

/** The `face` and `faceOffset` fields of an area light; a surface light needs a parent and takes its rectangle from the face. */
export function surfaceFieldsFrom(light, numberInRange) {
  if (light.face === undefined) {
    if (light.faceOffset !== undefined) throw invalidField('faceOffset', light.faceOffset, 'a light with face set, or leave faceOffset out');
    return {};
  }
  if (!SURFACE_LIGHT_FACES.includes(light.face)) {
    throw invalidField('face', light.face, `one of ${SURFACE_LIGHT_FACES.join(', ')}: the side of the parent part that shines`);
  }
  if (light.parent === undefined) {
    throw invalidField('parent', undefined, 'the node ID of the part whose face shines; face needs a parent');
  }
  for (const field of ['position', 'direction', 'up', 'width', 'height']) {
    if (light[field] !== undefined) {
      throw invalidField(field, light[field], 'left out: a light with face takes its position, direction and size from that face of the parent');
    }
  }
  return { face: light.face, faceOffset: numberInRange(light.faceOffset ?? DEFAULT_FACE_OFFSET, 0, MAX_FACE_OFFSET, 'faceOffset') };
}

/** Whether any light of the environment names a parent. */
export function environmentHasParentedLights(environment) {
  return LIGHT_LISTS.some(field => environment[field]?.some(light => light.parent !== undefined));
}

/** The environment with each face light given a stand-in size and direction, for checks that run before any part exists. */
export function withStandInLights(environment) {
  if (!environment.areaLights?.some(light => light.face !== undefined)) return environment;
  const areaLights = environment.areaLights.map(light => (light.face === undefined ? light : { ...light, position: [0, 0, 0], direction: [0, 0, 1], width: 1, height: 1 }));
  return { ...environment, areaLights };
}

/**
 * The node a `parent` names: a node with that ID, else the one placed-asset part labelled with that name. Returns the node ID,
 * or null when nothing matches, or an array of IDs when several parts share the name.
 */
function resolveParentId(parent, nodes) {
  if (nodes.some(node => node.id === parent)) return parent;
  const named = nodes.filter(node => node.assetPart && node.label === parent).map(node => node.id);
  if (named.length === 0) return null;
  return named.length === 1 ? named[0] : named;
}

/** Throws a field error for the first light whose parent matches no node, or several parts. Run on the built recipe, asset parts included. */
export function requireKnownLightParents(environment, nodes) {
  for (const field of LIGHT_LISTS) {
    (environment[field] ?? []).forEach((light, index) => {
      if (light.parent === undefined) return;
      const resolved = resolveParentId(light.parent, nodes);
      const path = `environment.${field}[${index}].parent`;
      if (resolved === null) {
        throw invalidField(path, light.parent, 'a node ID or the label of a placed asset part; scene_inspect lists node IDs');
      }
      if (Array.isArray(resolved)) {
        throw invalidField(path, light.parent, `one of the part IDs ${resolved.slice(0, 4).join(', ')}: several parts carry that name`);
      }
    });
  }
}

function transformPoint(matrix, point) {
  return [0, 1, 2].map(axis => matrix[axis] * point[0] + matrix[4 + axis] * point[1] + matrix[8 + axis] * point[2] + matrix[12 + axis]);
}

function transformDirection(matrix, direction) {
  return [0, 1, 2].map(axis => matrix[axis] * direction[0] + matrix[4 + axis] * direction[1] + matrix[8 + axis] * direction[2]);
}

function columnOf(matrix, column) {
  return [matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]];
}

function lengthOf(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalizedOrFallback(vector, fallbackVector) {
  const length = lengthOf(vector);
  return length > 1e-9 ? vector.map(component => component / length) : fallbackVector;
}

function crossOf(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** The rectangle of one face of a box of `bounds` under `matrix`: where it is, which way it shines, how large it is. */
export function surfaceLightFrame(face, faceOffset, bounds, matrix) {
  const { sign, normal, across, along } = FACES[face];
  const center = [0, 1, 2].map(axis => (bounds.min[axis] + bounds.max[axis]) / 2);
  center[normal] = sign > 0 ? bounds.max[normal] : bounds.min[normal];
  const normalColumn = columnOf(matrix, normal);
  const worldNormal = normalizedOrFallback(normalColumn.map(component => component * sign), [0, 1, 0]);
  const acrossColumn = columnOf(matrix, across);
  const worldAcross = normalizedOrFallback(acrossColumn, [1, 0, 0]);
  // The rectangle's width axis is up x normal, so up = normal x across makes width run along the part's own axis.
  const up = normalizedOrFallback(crossOf(worldNormal, worldAcross), [0, 1, 0]);
  const position = transformPoint(matrix, center).map((component, axis) => component + worldNormal[axis] * faceOffset);
  return {
    position,
    direction: worldNormal,
    up,
    width: Math.max(0.001, (bounds.max[across] - bounds.min[across]) * lengthOf(acrossColumn)),
    height: Math.max(0.001, (bounds.max[along] - bounds.min[along]) * lengthOf(columnOf(matrix, along))),
  };
}

function resolvedLight(light, frameOf, nodes) {
  const parentId = resolveParentId(light.parent, nodes);
  const frame = typeof parentId === 'string' ? frameOf(parentId) : null;
  if (!frame) return light;
  const { parent, face, faceOffset, ...fields } = light;
  if (face !== undefined) {
    if (!frame.bounds) return light;
    return { ...fields, ...surfaceLightFrame(face, faceOffset ?? DEFAULT_FACE_OFFSET, frame.bounds, frame.matrix) };
  }
  const resolved = { ...fields, position: transformPoint(frame.matrix, light.position ?? [0, 0, 0]) };
  if (light.direction) resolved.direction = normalizedOrFallback(transformDirection(frame.matrix, light.direction), light.direction);
  if (light.up) resolved.up = normalizedOrFallback(transformDirection(frame.matrix, light.up), light.up);
  return resolved;
}

/**
 * A copy of the environment with every parented light in world space at the pose `frameOf(nodeId)` gives ({ matrix, bounds }),
 * without the parent, face and faceOffset fields. An environment with no parented light is returned as it is.
 */
export function resolveParentedLights(environment, nodes, frameOf) {
  if (!environmentHasParentedLights(environment)) return environment;
  const resolved = { ...environment };
  for (const field of LIGHT_LISTS) {
    if (environment[field]?.some(light => light.parent !== undefined)) {
      resolved[field] = environment[field].map(light => (light.parent === undefined ? light : resolvedLight(light, frameOf, nodes)));
    }
  }
  return resolved;
}

const boundsOfGeometry = new WeakMap();

/** The local bounding box of a geometry, kept per geometry object. */
export function geometryBounds(geometry) {
  let bounds = boundsOfGeometry.get(geometry);
  if (!bounds) {
    bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (let offset = 0; offset < geometry.positions.length; offset += 3) {
      for (let axis = 0; axis < 3; axis++) {
        bounds.min[axis] = Math.min(bounds.min[axis], geometry.positions[offset + axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], geometry.positions[offset + axis]);
      }
    }
    boundsOfGeometry.set(geometry, bounds);
  }
  return bounds;
}

/**
 * The environment a light bake reads: parented lights placed by the part matrices of the bake (`worldMatrices`, by part name),
 * else by the pose `graph`. Bounds come from the parts' own geometry.
 */
export function bakeEnvironmentOf(environment, recipe, sourceRestParts, worldMatrices, graph) {
  if (!environmentHasParentedLights(environment)) return environment;
  const partsByName = new Map(sourceRestParts.map(part => [part.name, part]));
  return resolveParentedLights(environment, recipe.nodes, nodeId => {
    const matrix = worldMatrices.get(nodeId) ?? graph.getNode(nodeId)?.worldMatrix;
    const part = partsByName.get(nodeId);
    return matrix ? { matrix, bounds: part ? geometryBounds(part.geometry) : undefined } : null;
  });
}

/**
 * The environment with every light that names a parent placed at that node's pose now (#3239): the parts' matrices, which hold
 * the motion tracks, physics and glTF clips of the pose last published, else the node graph's.
 */
export function environmentAtPose(stagedState, environment) {
  const partMatrices = new Map(stagedState.restParts.map(part => [part.name, part.matrix]));
  const graph = stagedState.poseGraph ?? stagedState.graph;
  const nodesById = new Map(stagedState.recipe.nodes.map(node => [node.id, node]));
  return resolveParentedLights(environment, stagedState.recipe.nodes, nodeId => {
    const matrix = partMatrices.get(nodeId) ?? graph.getNode(nodeId)?.worldMatrix;
    const geometryId = nodesById.get(nodeId)?.geometry;
    return matrix ? { matrix, bounds: geometryId ? stagedState.geometryRecords.get(geometryId)?.bounds : undefined } : null;
  });
}
