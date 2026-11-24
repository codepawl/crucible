// Camera-facing quads (#3237): a name tag or label that turns to the camera at every sampled time. The node is a plane (a flat
// sheet in XY) whose material carries a text panel; the geometry is rebuilt per camera pose so the sheet always faces the eye.
import { mat4, vec3 } from 'gl-matrix';
import { invalidField } from './field-error.js';

export const TEXT_BILLBOARD_LIMITS = Object.freeze({
  size: Object.freeze([0.001, 1000]),
  screenHeight: Object.freeze([0.002, 1]),
  offset: Object.freeze([-10000, 10000]),
});

const BILLBOARD_FIELDS = ['size', 'screenHeight', 'offset', 'alwaysOnTop'];
const PLANE_TYPES = ['plane', 'grid'];
// Without an explicit offset a tag sits above the world bounding box of the part it hangs from, with this share of its own
// height as clearance, so the label's bottom edge never touches or covers the top of a head, a roof or a tall prop.
export const BILLBOARD_CLEARANCE_SHARE = 0.2;
const PLACEMENT_ITERATIONS = 6;

function checkedNumber(path, value, [minimum, maximum], example) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidField(path, value, `a number from ${minimum} to ${maximum}, such as ${example}`, TypeError);
  }
  return value;
}

/**
 * Validates the `billboard` field of a node: `size` [width, height] in metres, or `screenHeight`, the share of the frame height
 * the tag covers at any distance (the width follows the text panel's shape); `offset` [x, y, z] in world metres from the node,
 * such as [0, 0.4, 0] to hold a name tag above a head. A missing offset is not [0, 0, 0]: a tag whose node has a parent is
 * placed above the top of the parent's world bounding box plus a clearance (see BILLBOARD_CLEARANCE_SHARE), and an
 * explicit offset, even [0, 0, 0], always wins.
 */
export function normalizeBillboard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField('billboard', value, 'an object such as { "size": [1.2, 0.3], "offset": [0, 0.5, 0] } or { "screenHeight": 0.03 }', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!BILLBOARD_FIELDS.includes(key)) throw invalidField(`billboard.${key}`, value[key], `one of ${BILLBOARD_FIELDS.join(', ')}`, TypeError);
  }
  if ((value.size === undefined) === (value.screenHeight === undefined)) {
    throw invalidField('billboard', Object.keys(value), 'exactly one of size (metres, [width, height]) or screenHeight (share of the frame height, such as 0.03)', TypeError);
  }
  const result = {};
  if (value.size !== undefined) {
    if (!Array.isArray(value.size) || value.size.length !== 2) throw invalidField('billboard.size', value.size, 'two numbers [width, height] in metres, such as [1.2, 0.3]', TypeError);
    result.size = value.size.map((component, index) => checkedNumber(`billboard.size[${index}]`, component, TEXT_BILLBOARD_LIMITS.size, 1));
  } else {
    result.screenHeight = checkedNumber('billboard.screenHeight', value.screenHeight, TEXT_BILLBOARD_LIMITS.screenHeight, 0.03);
  }
  if (value.offset !== undefined) {
    const offset = value.offset;
    if (!Array.isArray(offset) || offset.length !== 3) throw invalidField('billboard.offset', offset, 'three numbers [x, y, z] in world metres, such as [0, 0.5, 0]', TypeError);
    result.offset = offset.map((component, index) => checkedNumber(`billboard.offset[${index}]`, component, TEXT_BILLBOARD_LIMITS.offset, 0.5));
  }
  if (value.alwaysOnTop !== undefined && typeof value.alwaysOnTop !== 'boolean') throw invalidField('billboard.alwaysOnTop', value.alwaysOnTop, 'true or false', TypeError);
  if (value.alwaysOnTop) result.alwaysOnTop = true;
  return result;
}

/**
 * A billboard is hidden by a part in front of it, like a Roblox BillboardGui, unless `alwaysOnTop` is set. Drawing through
 * geometry is a material choice (depthTest false, which only blend materials honour), so the pair is checked here and an
 * unpaired one is refused with the fix, instead of the tag silently drawing the other way.
 */
export function checkBillboardMaterials(recipe) {
  for (const node of recipe.nodes.filter(candidate => candidate.billboard)) {
    const material = recipe.materials.find(candidate => candidate.id === node.material);
    if (!material) continue;
    const throughParts = material.depthTest === false;
    if (node.billboard.alwaysOnTop && !(throughParts && material.alphaMode !== 'opaque')) {
      throw invalidField(`nodes.${node.id}.billboard.alwaysOnTop`, true, `a tag whose material ${material.id} sets depthTest false and alphaMode "blend" (only blend materials draw through parts); set both, or remove alwaysOnTop so a part in front hides the tag`);
    }
    if (!node.billboard.alwaysOnTop && throughParts) {
      throw invalidField(`materials.${material.id}.depthTest`, false, `true or left out, because node ${node.id} is a billboard that a part in front hides; set billboard.alwaysOnTop true on the node to draw it through parts`);
    }
  }
}

// Metres the frame is tall at `distance` from the eye.
function frameHeightAt(camera, distance) {
  if (camera.projection === 'orthographic') return camera.orthoScale ?? 4;
  if (typeof camera.fov !== 'number') throw new RangeError('billboard.screenHeight needs a camera with a vertical fov; set camera.fov, or give billboard.size in metres instead.');
  return 2 * distance * Math.tan(camera.fov * Math.PI / 360);
}

function worldQuadSize(node, camera, center, panelAspect) {
  const { size, screenHeight } = node.billboard;
  if (size) return size;
  const height = screenHeight * frameHeightAt(camera, vec3.distance(camera.eye, center));
  return [height * panelAspect, height];
}

function facingAxes(camera, center) {
  const toEye = camera.projection === 'orthographic'
    ? vec3.subtract(vec3.create(), camera.eye, camera.target)
    : vec3.subtract(vec3.create(), camera.eye, center);
  vec3.normalize(toEye, toEye);
  const right = vec3.cross(vec3.create(), camera.up, toEye);
  if (vec3.length(right) < 1e-6) vec3.cross(right, [0, 0, 1], toEye);
  vec3.normalize(right, right);
  const up = vec3.cross(vec3.create(), toEye, right);
  return { toEye, right, up };
}

// Where the sheet is centred. An explicit offset is added to the node's world position. Without one and with the top of the
// parent's world bounding box known, the sheet stands on that top: its lowest corner is BILLBOARD_CLEARANCE_SHARE of its own
// height above it. The sheet's size and tilt depend on where it is, so the height is settled in a few passes.
function sheetCenter(node, worldMatrix, camera, panelAspect, parentTop) {
  const center = vec3.fromValues(worldMatrix[12], worldMatrix[13], worldMatrix[14]);
  if (node.billboard.offset) return vec3.add(center, center, node.billboard.offset);
  if (parentTop === null || parentTop === undefined) return center;
  center[1] = parentTop;
  for (let pass = 0; pass < PLACEMENT_ITERATIONS; pass++) {
    const { right, up } = facingAxes(camera, center);
    const [width, height] = worldQuadSize(node, camera, center, panelAspect);
    center[1] = parentTop + BILLBOARD_CLEARANCE_SHARE * height + (height / 2) * Math.abs(up[1]) + (width / 2) * Math.abs(right[1]);
  }
  return center;
}

// A unit sheet in XY becomes a sheet of `size` that faces the eye, then returns to the node's own space.
function facingGeometry(template, worldMatrix, node, camera, panelAspect, parentTop = null) {
  const center = sheetCenter(node, worldMatrix, camera, panelAspect, parentTop);
  const { toEye, right, up } = facingAxes(camera, center);
  const [width, height] = worldQuadSize(node, camera, center, panelAspect);
  const inverse = mat4.invert(mat4.create(), worldMatrix);
  const positions = new Float32Array(template.positions.length);
  const normals = new Float32Array(template.normals.length);
  const point = vec3.create();
  for (let offset = 0; offset < positions.length; offset += 3) {
    const across = template.positions[offset] * width;
    const down = template.positions[offset + 1] * height;
    for (let axis = 0; axis < 3; axis++) point[axis] = center[axis] + right[axis] * across + up[axis] * down;
    vec3.transformMat4(point, point, inverse);
    positions.set(point, offset);
    for (let axis = 0; axis < 3; axis++) {
      normals[offset + axis] = worldMatrix[axis * 4] * toEye[0] + worldMatrix[axis * 4 + 1] * toEye[1] + worldMatrix[axis * 4 + 2] * toEye[2];
    }
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) normals[offset + axis] /= length;
  }
  return Object.freeze({ ...template, positions, normals });
}

/** The world-space corners of the sheet a billboard node draws, for tests and the report: `{ center, right, up, size }`. */
export function billboardFrame(node, worldMatrix, camera, panelAspect = 1, parentTop = null) {
  const template = { positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]), normals: new Float32Array(12) };
  const geometry = facingGeometry(template, worldMatrix, node, camera, panelAspect, parentTop);
  const world = new Float32Array(12);
  for (let vertex = 0; vertex < 4; vertex++) {
    const point = vec3.fromValues(geometry.positions[vertex * 3], geometry.positions[vertex * 3 + 1], geometry.positions[vertex * 3 + 2]);
    vec3.transformMat4(point, point, worldMatrix);
    world.set(point, vertex * 3);
  }
  return world;
}

function localBounds(template) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < template.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], template.positions[offset + axis]);
      high[axis] = Math.max(high[axis], template.positions[offset + axis]);
    }
  }
  return { low, high };
}

// The nodes a tag hangs over: its parent and everything below the parent, except billboards and hidden nodes. A node that
// draws no recipe geometry (an imported asset, vegetation) adds nothing, so the tag then clears only the geometry that is there.
function partsUnder(recipe, geometries, parentId) {
  const nodesById = new Map(recipe.nodes.map(node => [node.id, node]));
  const underParent = node => {
    for (let cursor = node, depth = 0; cursor && depth < 256; cursor = nodesById.get(cursor.parent), depth++) {
      if (cursor.id === parentId) return true;
    }
    return false;
  };
  return recipe.nodes
    .filter(node => !node.billboard && node.visible !== false && node.geometry !== undefined && geometries.get(node.geometry) && underParent(node))
    .map(node => ({ id: node.id, bounds: localBounds(geometries.get(node.geometry)) }));
}

// The highest world y of those parts at a scene time.
function worldTopOf(parts, follow, time) {
  let top = -Infinity;
  const corner = vec3.create();
  for (const { id, bounds } of parts) {
    const matrix = follow.matrixAt(id, time);
    for (let bits = 0; bits < 8; bits++) {
      vec3.set(corner, bits & 1 ? bounds.high[0] : bounds.low[0], bits & 2 ? bounds.high[1] : bounds.low[1], bits & 4 ? bounds.high[2] : bounds.low[2]);
      top = Math.max(top, vec3.transformMat4(corner, corner, matrix)[1]);
    }
  }
  return top === -Infinity ? null : top;
}

function assertPlane(node, recipe) {
  const geometry = recipe.geometries.find(candidate => candidate.id === node.geometry);
  if (!geometry || !PLANE_TYPES.includes(geometry.type)) {
    throw invalidField(`nodes.${node.id}.billboard`, geometry?.type ?? node.geometry, `a node whose geometry is a plane (a flat sheet the billboard turns to the camera); geometry ${node.geometry} is ${geometry?.type ?? 'missing'}`);
  }
}

/**
 * `follow.matrixAt(nodeId, time)` is the world matrix of a node at a scene time. `sample(time, camera)` returns, for every billboard
 * node, the plane geometry in the node's own space that faces `camera` ({ eye, target, up, fov }) at that time.
 */
export function bakeTextBillboards(recipe, geometries, follow) {
  const billboards = recipe.nodes.filter(node => node.billboard);
  const prepared = billboards.map(node => {
    assertPlane(node, recipe);
    const panel = recipe.materials.find(material => material.id === node.material)?.text;
    const parts = node.billboard.offset || !node.parent ? [] : partsUnder(recipe, geometries, node.parent);
    return { node, template: geometries.get(node.geometry), aspect: panel ? panel.width / panel.height : 1, parts };
  });
  return Object.freeze({
    sample(time, camera) {
      return new Map(prepared.map(({ node, template, aspect, parts }) => [node.id, facingGeometry(template, follow.matrixAt(node.id, time), node, camera, aspect, parts.length ? worldTopOf(parts, follow, time) : null)]));
    },
    report() {
      return { count: prepared.length, nodes: prepared.map(({ node }) => node.id) };
    },
  });
}
