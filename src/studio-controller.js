import { mat4, quat, vec3 } from 'gl-matrix';
import { silhouetteContourSegments, silhouetteRectangleSegments } from './studio-silhouette-mask.js';
import { applyProjection, cameraFieldOfView } from './camera.js';
import { viewportClipPlanes } from './studio-viewport-aids.js';
import { createAgentScene } from './agent-scene.js';
import { createSceneQuery } from './scene-query.js';
import { operationsBetweenRecipes, sameRecipeValue } from './studio-history-diff.js';
import { MAX_POINT_LIGHTS, MAX_AREA_LIGHTS, MAX_SPOT_LIGHTS } from './light-limits.js';
import {
  STUDIO_MATERIAL_PRESETS,
  STUDIO_PRIMITIVE_GROUPS,
  STUDIO_PRIMITIVES,
  STUDIO_TABS,
  STUDIO_TEMPLATES,
  STUDIO_TOOLS,
  STUDIO_VIEW_PRESETS,
  primitiveGeometrySpec,
} from './studio-templates.js';

const AXIS_NAMES = Object.freeze(['x', 'y', 'z']);
const PLANE_AXES = Object.freeze(['xy', 'xz', 'yz']);
const GIZMO_AXES = Object.freeze(['x', 'y', 'z', 'xy', 'xz', 'yz', 'screen', 'uniform', 'surface']);
// The property panels that show one record of the recipe instead of one scene object, and the motion kind that animates it.
const SCENE_RECORD_PANELS = Object.freeze({
  world: Object.freeze({ kind: 'world', record: 'environment', motionKind: 'environment' }),
  quality: Object.freeze({ kind: 'quality', record: 'environment', motionKind: null }),
  effects: Object.freeze({ kind: 'effects', record: 'effects', motionKind: 'effects' }),
  shadow: Object.freeze({ kind: 'shadow', record: 'shadow', motionKind: null }),
});
const SHOT_NAME_PATTERN =/^[A-Za-z0-9_-]{1,24}$/;
const GIZMO_SCREEN_PIXELS = 74;
const ROTATION_RING_SEGMENTS = 32;
const WORLD_BASIS = Object.freeze({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
const AXIS_PARALLEL_LIMIT = 0.002;
const OUTLINE_VERTEX_BUDGET = 4000;
// Above this many triangles the selection is outlined from a pixel mask, not one path entry per triangle redrawn on every camera move.
const SILHOUETTE_TRIANGLE_BUDGET = 8000;
// Past this many triangles even the pixel mask is too slow to fill on every camera move (measured: 168k triangles about 30 ms,
// 1M about 110 ms), so the selection gets the rectangle around it instead.
const CONTOUR_TRIANGLE_BUDGET = 250000;
const RING_EDGE_ON_LIMIT = 0.12;
const RING_RADIUS_FACTOR = 0.92;
const MINIMUM_AXIS_SCREEN_SHARE = 0.8;
const MAXIMUM_AXIS_STRETCH = 3;
const SPAWN_CLEARANCE = 0.75;
const SPAWN_STEP = 1.25;
const SPAWN_ATTEMPTS = 16;
// These lie on the ground under everything else, so they start at the centre whatever stands there.
const GROUND_PRIMITIVES = new Set(['plane', 'terrain']);
const ROTATION_DEGREES_PER_PIXEL = 0.75;
const ROTATION_SNAP_DEGREES = 15;
const TRANSLATION_SNAP_STEP = 0.25;
const MINIMUM_SCALE = 0.05;
const MAXIMUM_SCALE = 100;
const MINIMUM_DISTANCE = 0.25;
const COPY_OFFSET = Object.freeze([0.45, 0, 0.45]);
const MAXIMUM_DISTANCE = 400;
// A framed object fills the view with this much room around it; a point or a tiny object counts as this big.
const FRAME_MARGIN = 1.15;
const FRAME_MINIMUM_RADIUS = 0.25;
const MAXIMUM_ELEVATION = 1.53;
const ROUND_PRECISION = 10000;
const DEGREE_PRECISION = 100;

export function roundValue(value, precision = ROUND_PRECISION) {
  return Math.round(value * precision) / precision;
}

export function roundVector(values, precision = ROUND_PRECISION) {
  return Array.from(values, component => roundValue(component, precision));
}

const SCENE_LIGHT_FIELDS = Object.freeze({ point: 'pointLights', spot: 'spotLights', area: 'areaLights' });

/** True when a motion has no track and nothing else that animates, so it can be dropped from the recipe. */
function motionIsEmpty(motion) {
  return !(
    motion.tracks?.length ||
    motion.ik?.length ||
    motion.layers?.length ||
    motion.drivers?.length ||
    motion.constraints?.length ||
    motion.springs ||
    motion.drive
  );
}

function assertPositiveFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function assertFiniteVector(values, length, label) {
  if (!Array.isArray(values) || values.length !== length || values.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new TypeError(`${label} must be an array of ${length} finite numbers.`);
  }
  return Array.from(values);
}

function validateSceneHandle(scene) {
  if (!scene || typeof scene !== 'object') {
    throw new TypeError('Studio requires a scene object from createAgentScene.');
  }
  for (const method of ['apply', 'exportRecipe', 'inspect']) {
    if (typeof scene[method] !== 'function') {
      throw new TypeError(`Studio scene must provide ${method}().`);
    }
  }
  if (!Array.isArray(scene.parts) || !scene.camera) {
    throw new TypeError('Studio scene must provide parts and camera.');
  }
  return scene;
}

function normalizeQuaternion(rotation) {
  const result = quat.fromValues(rotation[0], rotation[1], rotation[2], rotation[3]);
  if (quat.length(result) < 1e-8) {
    return [0, 0, 0, 1];
  }
  quat.normalize(result, result);
  return roundVector(result);
}

export function quaternionToEulerDegrees(quaternion) {
  const [valueX, valueY, valueZ, valueW] = normalizeQuaternion(quaternion);
  const sinRoll = 2 * (valueW * valueX + valueY * valueZ);
  const cosRoll = 1 - 2 * (valueX * valueX + valueY * valueY);
  const roll = Math.atan2(sinRoll, cosRoll);
  const sinPitch = Math.max(-1, Math.min(1, 2 * (valueW * valueY - valueZ * valueX)));
  const pitch = Math.asin(sinPitch);
  const sinYaw = 2 * (valueW * valueZ + valueX * valueY);
  const cosYaw = 1 - 2 * (valueY * valueY + valueZ * valueZ);
  const yaw = Math.atan2(sinYaw, cosYaw);
  const radiansToDegrees = 180 / Math.PI;
  return [
    roundValue(roll * radiansToDegrees, DEGREE_PRECISION),
    roundValue(pitch * radiansToDegrees, DEGREE_PRECISION),
    roundValue(yaw * radiansToDegrees, DEGREE_PRECISION),
  ];
}

function eulerDegreesToQuaternion(angles) {
  const result = quat.create();
  quat.fromEuler(result, angles[0], angles[1], angles[2]);
  quat.normalize(result, result);
  return roundVector(result);
}

function srgbChannelToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(channel) {
  const clamped = Math.max(0, Math.min(1, channel));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * (clamped ** (1 / 2.4)) - 0.055;
}

export function linearRgbToHex(rgb) {
  const values = Array.isArray(rgb) ? rgb : [0.8, 0.8, 0.8];
  const hex = values.slice(0, 3).map(channel => {
    const byte = Math.max(0, Math.min(255, Math.round(linearChannelToSrgb(channel) * 255)));
    return byte.toString(16).padStart(2, '0');
  });
  return `#${hex.join('')}`;
}

export function hexToLinearRgb(hexText) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hexText).trim());
  if (!match) {
    throw new TypeError(`Color must be a #rrggbb hex string, got ${JSON.stringify(hexText)}.`);
  }
  const value = parseInt(match[1], 16);
  return [
    roundValue(srgbChannelToLinear(((value >> 16) & 255) / 255)),
    roundValue(srgbChannelToLinear(((value >> 8) & 255) / 255)),
    roundValue(srgbChannelToLinear((value & 255) / 255)),
  ];
}

export function directionToSunAngles(direction) {
  const values = Array.isArray(direction) && direction.length === 3 ? direction : [-3, 6, 4];
  const length = Math.hypot(values[0], values[1], values[2]) || 1;
  const horizontal = Math.hypot(values[0], values[2]);
  const elevationDegrees = roundValue(Math.asin(Math.max(-1, Math.min(1, values[1] / length))) * 180 / Math.PI, DEGREE_PRECISION);
  const azimuthDegrees = roundValue(Math.atan2(values[0], values[2]) * 180 / Math.PI, DEGREE_PRECISION);
  return {
    azimuthDegrees,
    elevationDegrees: horizontal < 1e-6 && values[1] > 0 ? 90 : elevationDegrees,
  };
}

export function sunAnglesToDirection(azimuthDegrees, elevationDegrees) {
  const azimuth = (azimuthDegrees * Math.PI) / 180;
  const elevation = (elevationDegrees * Math.PI) / 180;
  const cosineElevation = Math.cos(elevation);
  return [
    roundValue(cosineElevation * Math.sin(azimuth) * 6),
    roundValue(Math.sin(elevation) * 6),
    roundValue(cosineElevation * Math.cos(azimuth) * 6),
  ];
}

function cameraMatrices(camera, aspect, worldMode) {
  const view = mat4.lookAt(mat4.create(), camera.eye, camera.target, camera.up ?? [0, 1, 0]);
  const projection = mat4.create();
  applyProjection(
    projection,
    {
      projection: camera.projection ?? 'perspective',
      fov: camera.fov,
      focalLength: camera.focalLength,
      sensorWidth: camera.sensorWidth,
      orthoScale: camera.orthoScale,
      shift: camera.shift,
      // The same planes the viewport draws with, so what shows can be picked and outlined however far the view is.
      ...viewportClipPlanes({ ...camera, far: camera.far ?? (worldMode ? 600 : 100) }),
    },
    aspect,
    { world: worldMode },
  );
  const viewProjection = mat4.multiply(mat4.create(), projection, view);
  return { view, projection, viewProjection };
}

function projectPointWithMatrix(viewProjection, point, width, height) {
  const worldX = point[0];
  const worldY = point[1];
  const worldZ = point[2];
  const clipX = viewProjection[0] * worldX + viewProjection[4] * worldY + viewProjection[8] * worldZ + viewProjection[12];
  const clipY = viewProjection[1] * worldX + viewProjection[5] * worldY + viewProjection[9] * worldZ + viewProjection[13];
  const clipZ = viewProjection[2] * worldX + viewProjection[6] * worldY + viewProjection[10] * worldZ + viewProjection[14];
  const clipW = viewProjection[3] * worldX + viewProjection[7] * worldY + viewProjection[11] * worldZ + viewProjection[15];
  if (clipW <= 1e-6) {
    return { x: 0, y: 0, depth: 1, visible: false };
  }
  const normalizedX = clipX / clipW;
  const normalizedY = clipY / clipW;
  const normalizedZ = clipZ / clipW;
  return {
    x: (normalizedX * 0.5 + 0.5) * width,
    y: (0.5 - normalizedY * 0.5) * height,
    depth: normalizedZ,
    visible: normalizedZ >= -1 && normalizedZ <= 1,
  };
}

// Every vertex of a mesh on screen as x, y pairs, with one matrix for the whole mesh. False when a vertex is behind the
// camera or outside its depth range, so the caller can leave the object without an outline.
function projectVerticesToScreen(matrix, positions, screen, width, height) {
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const worldX = positions[vertex * 3];
    const worldY = positions[vertex * 3 + 1];
    const worldZ = positions[vertex * 3 + 2];
    const clipW = matrix[3] * worldX + matrix[7] * worldY + matrix[11] * worldZ + matrix[15];
    if (clipW <= 1e-6) {
      return false;
    }
    const depth = (matrix[2] * worldX + matrix[6] * worldY + matrix[10] * worldZ + matrix[14]) / clipW;
    if (depth < -1 || depth > 1) {
      return false;
    }
    const normalizedX = (matrix[0] * worldX + matrix[4] * worldY + matrix[8] * worldZ + matrix[12]) / clipW;
    const normalizedY = (matrix[1] * worldX + matrix[5] * worldY + matrix[9] * worldZ + matrix[13]) / clipW;
    screen[vertex * 2] = (normalizedX * 0.5 + 0.5) * width;
    screen[vertex * 2 + 1] = (0.5 - normalizedY * 0.5) * height;
  }
  return true;
}

function buildNodeWorldMatrices(nodes) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const worldMatrices = new Map();
  function resolveWorldMatrix(nodeId, stack) {
    if (worldMatrices.has(nodeId)) {
      return worldMatrices.get(nodeId);
    }
    const node = byId.get(nodeId);
    if (!node || stack.has(nodeId)) {
      return mat4.create();
    }
    stack.add(nodeId);
    const localMatrix = mat4.fromRotationTranslationScale(
      mat4.create(),
      node.rotation ?? [0, 0, 0, 1],
      node.translation ?? [0, 0, 0],
      node.scale ?? [1, 1, 1],
    );
    const worldMatrix = node.parent
      ? mat4.multiply(mat4.create(), resolveWorldMatrix(node.parent, stack), localMatrix)
      : localMatrix;
    stack.delete(nodeId);
    worldMatrices.set(nodeId, worldMatrix);
    return worldMatrix;
  }
  for (const node of nodes) {
    resolveWorldMatrix(node.id, new Set());
  }
  return worldMatrices;
}

// Andrew's monotone chain over [x, y] points, returned counter-clockwise without the repeated first point.
function convexHull(points) {
  const sorted = [...points].sort((first, second) => first[0] - second[0] || first[1] - second[1]);
  if (sorted.length < 3) {
    return sorted;
  }
  const turn = (origin, first, second) => (first[0] - origin[0]) * (second[1] - origin[1]) - (first[1] - origin[1]) * (second[0] - origin[0]);
  const buildChain = ordered => {
    const chain = [];
    for (const candidate of ordered) {
      while (chain.length >= 2 && turn(chain[chain.length - 2], chain[chain.length - 1], candidate) <= 0) {
        chain.pop();
      }
      chain.push(candidate);
    }
    chain.pop();
    return chain;
  };
  return [...buildChain(sorted), ...buildChain([...sorted].reverse())];
}

function descendantIdsOf(nodes, rootId) {
  const descendants = new Set([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const node of nodes) {
      if (node.parent && descendants.has(node.parent) && !descendants.has(node.id)) {
        descendants.add(node.id);
        added = true;
      }
    }
  }
  return descendants;
}

// A placed catalog scan draws as parts named `<node id>/<index>`, one per mesh of the file; they belong to that node.
const SCAN_PART_SUFFIX = /\/\d+$/;

function ownsPart(nodeIds, part) {
  return nodeIds.has(part.name) || nodeIds.has(part.name.replace(SCAN_PART_SUFFIX, ''));
}

function partClearanceAlongNormal(parts, excludedIds, worldNormal, nodes, worldMatrices) {
  let minimumProjection = Infinity;
  let maximumProjection = -Infinity;
  const point = vec3.create();
  for (const part of parts) {
    if (!ownsPart(excludedIds, part) || !part.geometry?.positions) {
      continue;
    }
    const positions = part.geometry.positions;
    const matrix = part.matrix ?? worldMatrices.get(part.name);
    if (!matrix) {
      continue;
    }
    for (let offset = 0; offset < positions.length; offset += 3) {
      vec3.set(point, positions[offset], positions[offset + 1], positions[offset + 2]);
      vec3.transformMat4(point, point, matrix);
      const projection = vec3.dot(point, worldNormal);
      if (projection < minimumProjection) minimumProjection = projection;
      if (projection > maximumProjection) maximumProjection = projection;
    }
  }
  if (!Number.isFinite(minimumProjection)) {
    return 0.5;
  }
  const pivotMatrix = worldMatrices.get(nodes[0]?.id) ?? parts.find(part => ownsPart(excludedIds, part))?.matrix;
  if (!pivotMatrix) {
    return Math.max(0, (maximumProjection - minimumProjection) * 0.5);
  }
  const pivotProjection = pivotMatrix[12] * worldNormal[0] + pivotMatrix[13] * worldNormal[1] + pivotMatrix[14] * worldNormal[2];
  return Math.max(0, pivotProjection - minimumProjection);
}

function cameraBookmarkPayload(camera) {
  const payload = {
    eye: roundVector(camera.eye),
    target: roundVector(camera.target),
    up: roundVector(camera.up ?? [0, 1, 0]),
  };
  if (camera.focalLength === undefined && camera.fov !== undefined) {
    payload.fov = roundValue(camera.fov, DEGREE_PRECISION);
  }
  if (camera.projection) {
    payload.projection = camera.projection;
  }
  if (camera.orthoScale !== undefined) {
    payload.orthoScale = roundValue(camera.orthoScale);
  }
  if (camera.near !== undefined) {
    payload.near = roundValue(camera.near);
  }
  if (camera.far !== undefined) {
    payload.far = roundValue(camera.far);
  }
  return payload;
}

function buildTimelineShot(name, camera, recipe) {
  const hasMotion = Boolean(recipe.motion || recipe.physics || recipe.cloth);
  const nonLoopingDuration = recipe.motion && !recipe.motion.loop ? recipe.motion.duration : 2;
  const duration = Math.max(0.1, Math.min(2, nonLoopingDuration));
  const shot = { name, duration, camera: cameraBookmarkPayload(camera) };
  if (hasMotion) {
    shot.motionStart = 0;
  }
  return shot;
}

// The camera fields an orbit, a zoom, a pan or a framing moves.
const VIEW_POSE_FIELDS = Object.freeze(['eye', 'target', 'up', 'orthoScale']);

export function hasAnimatedData(recipe) {
  return Boolean(
    recipe.motion ||
    recipe.physics ||
    recipe.cloth ||
    recipe.particles ||
    recipe.environment?.localVolumes?.some(volume => volume?.frames),
  );
}

function resolveRecipeNodeId(partId, recipe) {
  const direct = recipe.nodes.find(node => node.id === partId);
  if (direct) {
    return direct.id;
  }
  const prefixed = recipe.nodes.find(node => partId.startsWith(`${node.id}:`) || partId.startsWith(`${node.id}.`) || partId.startsWith(`${node.id}/`));
  return prefixed ? prefixed.id : null;
}

function uniqueIdentifier(existingIds, prefix) {
  let counter = 1;
  while (existingIds.has(`${prefix}-${counter}`)) {
    counter += 1;
  }
  return `${prefix}-${counter}`;
}

function rayPlaneIntersection(rayOrigin, rayDirection, planePoint, planeNormal) {
  const denominator = vec3.dot(rayDirection, planeNormal);
  if (Math.abs(denominator) < 1e-5) {
    return null;
  }
  const offset = vec3.subtract(vec3.create(), planePoint, rayOrigin);
  const distance = vec3.dot(offset, planeNormal) / denominator;
  if (!Number.isFinite(distance) || distance < 0 || distance > 2000) {
    return null;
  }
  return [
    rayOrigin[0] + rayDirection[0] * distance,
    rayOrigin[1] + rayDirection[1] * distance,
    rayOrigin[2] + rayDirection[2] * distance,
  ];
}

// The three unit axes of a node in world space, read from its world matrix, so the gizmo follows the object.
function worldBasisOf(matrix) {
  const axisAt = (offset, fallback) => {
    const axis = vec3.fromValues(matrix[offset], matrix[offset + 1], matrix[offset + 2]);
    if (vec3.length(axis) < 1e-8) {
      return fallback;
    }
    vec3.normalize(axis, axis);
    return [axis[0], axis[1], axis[2]];
  };
  return { x: axisAt(0, [1, 0, 0]), y: axisAt(4, [0, 1, 0]), z: axisAt(8, [0, 0, 1]) };
}

// Distance along an axis line of the point nearest to a pointer ray. Null when the ray runs along the axis.
function rayAxisParameter(ray, linePoint, lineDirection) {
  const between = vec3.subtract(vec3.create(), ray.origin, linePoint);
  const directionDot = vec3.dot(ray.direction, lineDirection);
  const denominator = 1 - directionDot * directionDot;
  if (denominator < AXIS_PARALLEL_LIMIT) {
    return null;
  }
  const alongLine = vec3.dot(between, lineDirection);
  const alongRay = vec3.dot(between, ray.direction);
  return (alongLine - directionDot * alongRay) / denominator;
}

function signedAngleAround(axis, fromVector, toVector) {
  const crossed = vec3.cross(vec3.create(), fromVector, toVector);
  return Math.atan2(vec3.dot(crossed, axis), vec3.dot(fromVector, toVector));
}

function planeNormalForAxis(axis, camera, basis = WORLD_BASIS) {
  if (axis === 'xy') return basis.z;
  if (axis === 'xz') return basis.y;
  if (axis === 'yz') return basis.x;
  const look = vec3.subtract(vec3.create(), camera.eye, camera.target);
  if (vec3.length(look) < 1e-6) {
    return [0, 0, 1];
  }
  vec3.normalize(look, look);
  return [look[0], look[1], look[2]];
}

function upsertNodeKeyframeTrack(tracks, nodeId, property, time, value) {
  const nextTracks = tracks.map(track => structuredClone(track));
  const existing = nextTracks.find(track => track.kind === 'node' && track.id === nodeId && track.property === property);
  if (!existing) {
    nextTracks.push({
      kind: 'node',
      id: nodeId,
      property,
      keyframes: [{ time: roundValue(time, 1000), value: roundVector(value) }],
    });
    return nextTracks;
  }
  const roundedTime = roundValue(time, 1000);
  const matchIndex = existing.keyframes.findIndex(keyframe => Math.abs(keyframe.time - roundedTime) < 0.005);
  const entry = { time: roundedTime, value: roundVector(value) };
  if (matchIndex >= 0) {
    existing.keyframes[matchIndex] = entry;
  } else {
    existing.keyframes.push(entry);
    existing.keyframes.sort((first, second) => first.time - second.time);
  }
  return nextTracks;
}

// A new object lands beside what is already there, not inside it: the first free spot along X from where it would start.
function freeSpawnTranslation(translation, nodes) {
  const isTaken = offset => nodes.some(node => !node.parent && Math.hypot(
    (node.translation?.[0] ?? 0) - translation[0] - offset,
    (node.translation?.[2] ?? 0) - translation[2],
  ) < SPAWN_CLEARANCE);
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt += 1) {
    const offset = attempt * SPAWN_STEP;
    if (!isTaken(offset)) {
      return [translation[0] + offset, translation[1], translation[2]];
    }
  }
  return translation;
}

function snapVector(values, step = TRANSLATION_SNAP_STEP) {
  return values.map(component => roundValue(Math.round(component / step) * step));
}

/**
 * Headless controller bridging interactive viewport picking, 3D gizmos, scene editing and inspector state to an AgentScene recipe.
 */
export function createStudioController({
  scene: initialScene,
  assets = null,
  viewportWidth = 960,
  viewportHeight = 540,
  maxHistory = 32,
  onChange,
} = {}) {
  let currentScene = validateSceneHandle(initialScene);
  let moveSnapStep = TRANSLATION_SNAP_STEP;
  let rotateSnapDegrees = ROTATION_SNAP_DEGREES;
  let gizmoPixels = GIZMO_SCREEN_PIXELS;
  let width = assertPositiveFinite(viewportWidth, 'viewportWidth');
  let height = assertPositiveFinite(viewportHeight, 'viewportHeight');
  if (!Number.isInteger(maxHistory) || maxHistory < 1 || maxHistory > 128) {
    throw new RangeError(`maxHistory must be an integer from 1 to 128, got ${JSON.stringify(maxHistory)}.`);
  }
  if (onChange !== undefined && typeof onChange !== 'function') {
    throw new TypeError('onChange must be a function when provided.');
  }

  let selectedNodeId = currentScene.exportRecipe().nodes.find(node => node.geometry !== undefined)?.id
    ?? currentScene.exportRecipe().nodes[0]?.id
    ?? null;
  let selectedObjectKey = null;
  let copiedNode = null;
  let pasteCount = 0;
  let activeTool = 'translate';
  let activeTab = 'node';
  let motionTime = currentScene.motionTime ?? 0;
  let queryCache = null;
  let dragState = null;
  const undoStack = [];
  const redoStack = [];
  let undoGroupOpen = false;
  let undoGroupRecorded = false;

  function notify(detail = {}) {
    if (onChange) {
      onChange({
        revision: currentScene.revision,
        selectedNodeId,
        tool: activeTool,
        activeTab,
        motionTime,
        ...detail,
      });
    }
  }

  function invalidateQuery() {
    if (queryCache) {
      queryCache.query.dispose();
      queryCache = null;
    }
  }

  function ensureQuery() {
    if (queryCache && queryCache.topologyRevision === currentScene.topologyRevision) {
      return queryCache.query;
    }
    invalidateQuery();
    const query = createSceneQuery(currentScene.parts);
    queryCache = { topologyRevision: currentScene.topologyRevision, query };
    return query;
  }

  // A step that did not touch the camera keeps the viewport where the person left it when it is undone:
  // orbiting is navigation, not an edit, so it must not be rolled back with the edit before it.
  function pushUndoSnapshot(recipe, { restoresCamera = false } = {}) {
    if (undoGroupOpen) {
      if (undoGroupRecorded) {
        const groupEntry = undoStack[undoStack.length - 1];
        groupEntry.restoresCamera = groupEntry.restoresCamera || restoresCamera;
        return;
      }
      undoGroupRecorded = true;
    }
    undoStack.push({ recipe, restoresCamera, selection: currentSelection() });
    while (undoStack.length > maxHistory) {
      undoStack.shift();
    }
    redoStack.length = 0;
  }

  function currentSelection() {
    return { nodeId: selectedNodeId, objectKey: selectedObjectKey };
  }

  function beginUndoGroup() {
    if (!undoGroupOpen) {
      undoGroupOpen = true;
      undoGroupRecorded = false;
    }
  }

  function endUndoGroup() {
    undoGroupOpen = false;
    undoGroupRecorded = false;
  }

  function applySceneOperations(operations, { recordUndo = true } = {}) {
    const before = recordUndo ? currentScene.exportRecipe() : null;
    currentScene.apply(operations, { expectedRevision: currentScene.revision });
    if (before) {
      const restoresCamera = operations.some(operation => operation.type === 'set-camera');
      pushUndoSnapshot(before, { restoresCamera });
    }
  }

  function stepHistory(sourceStack, targetStack) {
    endUndoGroup();
    const entry = sourceStack.pop();
    const currentRecipe = currentScene.exportRecipe();
    targetStack.push({ recipe: currentRecipe, restoresCamera: entry.restoresCamera, selection: currentSelection() });
    // The step brings back what was selected with it, so an object that returns is the one in hand again;
    // settleSelectionAndMotion drops a selection the restored recipe no longer holds.
    selectedNodeId = entry.selection.nodeId;
    selectedObjectKey = entry.selection.objectKey;
    const nextRecipe = entry.restoresCamera || currentRecipe.camera === undefined
      ? entry.recipe
      : { ...entry.recipe, camera: currentRecipe.camera };
    if (!restoreRecipeInPlace(currentRecipe, nextRecipe)) {
      swapRecipe(nextRecipe);
    }
  }

  // Applies the difference as scene operations on the scene already built, which takes milliseconds where a rebuild
  // freezes a large scene. The exported recipe must match the target exactly, or the caller rebuilds from it.
  function restoreRecipeInPlace(currentRecipe, targetRecipe) {
    const operations = operationsBetweenRecipes(currentRecipe, targetRecipe);
    if (operations === null) {
      return false;
    }
    try {
      if (operations.length > 0) {
        invalidateQuery();
        dragState = null;
        currentScene.apply(operations, { expectedRevision: currentScene.revision });
      }
    } catch {
      return false;
    }
    if (!sameRecipeValue(currentScene.exportRecipe(), targetRecipe)) {
      return false;
    }
    settleSelectionAndMotion();
    return true;
  }
  // A camera motion track wins over the recipe camera, so on such a scene an orbit written to the recipe could never show.
  // There the viewport takes this pose of its own and the recipe stays as it is.
  let freeViewPose = null;
  let drivenCameraCache = { scene: null, revision: -1, driven: false };

  function cameraIsDriven() {
    if (drivenCameraCache.scene !== currentScene || drivenCameraCache.revision !== currentScene.revision) {
      // Any camera track or driver makes the scene stage its own eye, target and up, whichever field it animates.
      const motion = currentScene.exportRecipe().motion;
      const driven = (motion?.tracks ?? []).some(track => track.kind === 'camera') || (motion?.drivers ?? []).some(driver => driver.target?.kind === 'camera');
      drivenCameraCache = { scene: currentScene, revision: currentScene.revision, driven };
    }
    return drivenCameraCache.driven;
  }

  /** The camera the viewport looks through: the scene camera, or the free view while a track drives the scene camera. */
  function viewCamera() {
    const sceneCamera = currentScene['camera'];
    return freeViewPose && cameraIsDriven() ? { ...sceneCamera, ...freeViewPose } : sceneCamera;
  }

  function moveView(posePatch, { recordUndo = false } = {}) {
    if (cameraIsDriven()) {
      const nextPose = { ...(freeViewPose ?? {}) };
      for (const field of VIEW_POSE_FIELDS) {
        if (posePatch[field] !== undefined) {
          nextPose[field] = structuredClone(posePatch[field]);
        }
      }
      freeViewPose = nextPose;
    } else {
      applySceneOperations([{ type: 'set-camera', ...posePatch }], { recordUndo });
    }
    // Only a move that went into undo changed the scene; a free orbit or the free view of a driven camera is navigation.
    notify({ kind: 'camera', edited: recordUndo && !cameraIsDriven() });
    return viewCamera();
  }

  /** Leaves the free view, so the viewport looks through the animated camera again. */
  function lookThroughSceneCamera() {
    freeViewPose = null;
    notify({ kind: 'camera' });
    return viewCamera();
  }

  function swapRecipe(recipeInput) {
    invalidateQuery();
    // A drag in progress belongs to the scene it began on.
    dragState = null;
    // `assets` is the host's pool of decoded catalog assets. It outlives each scene, so undo and redo rebuild from it.
    currentScene = createAgentScene(recipeInput, {}, assets ? { assets } : {});
    settleSelectionAndMotion();
  }

  // Keeps the selection, the motion time and the free view valid for whichever recipe the scene now holds.
  function settleSelectionAndMotion() {
    const recipe = currentScene.exportRecipe();
    // A node that is gone leaves nothing selected: falling back to another node would aim the next Delete at an object nobody picked.
    if (selectedNodeId && !recipe.nodes.some(node => node.id === selectedNodeId)) {
      selectedNodeId = null;
    }
    if (selectedObjectKey && !lightKeysOf(recipe.environment).concat('camera', 'sun').includes(selectedObjectKey)) {
      selectedObjectKey = null;
    }
    if (motionTime > 0 && hasAnimatedData(recipe)) {
      const limit = recipe.motion?.duration ?? motionTime;
      motionTime = Math.max(0, Math.min(limit, motionTime));
      currentScene.sampleMotion(motionTime);
    } else {
      motionTime = 0;
    }
    if (!cameraIsDriven()) {
      freeViewPose = null;
    }
  }

  function selectedWorldMatrix() {
    if (!selectedNodeId) {
      return null;
    }
    const matchingPart = currentScene.parts.find(part => part.name === selectedNodeId);
    if (matchingPart?.matrix) {
      return matchingPart.matrix;
    }
    const recipe = currentScene.exportRecipe();
    return buildNodeWorldMatrices(recipe.nodes).get(selectedNodeId) ?? null;
  }

  function selectedPivotWorld() {
    const matrix = selectedWorldMatrix();
    if (!matrix) {
      return null;
    }
    return [matrix[12], matrix[13], matrix[14]];
  }

  function worldLengthPerPixel(pivot) {
    const camera = viewCamera();
    const distance = pivot ? Math.max(0.5, vec3.distance(camera.eye, pivot)) : 5;
    if (camera.projection === 'orthographic') {
      return (camera.orthoScale ?? 4) / height;
    }
    const fieldOfViewDegrees = cameraFieldOfView(camera, width / height);
    return (2 * distance * Math.tan((fieldOfViewDegrees * Math.PI) / 360)) / height;
  }

  function projectWorldPoint(worldPoint) {
    const coordinates = assertFiniteVector(worldPoint, 3, 'worldPoint');
    const { viewProjection } = cameraMatrices(viewCamera(), width / height, Boolean(currentScene.environment?.world));
    return projectPointWithMatrix(viewProjection, coordinates, width, height);
  }

  function screenRay(pixelX, pixelY) {
    if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) {
      throw new TypeError('screenRay requires finite pixelX and pixelY numbers.');
    }
    const { viewProjection } = cameraMatrices(viewCamera(), width / height, Boolean(currentScene.environment?.world));
    const inverse = mat4.invert(mat4.create(), viewProjection);
    if (!inverse) {
      throw new Error('Cannot unproject ray from a singular camera matrix.');
    }
    const normalizedX = (pixelX / width) * 2 - 1;
    const normalizedY = 1 - (pixelY / height) * 2;
    const nearPoint = vec3.transformMat4(vec3.create(), [normalizedX, normalizedY, -1], inverse);
    const farPoint = vec3.transformMat4(vec3.create(), [normalizedX, normalizedY, 1], inverse);
    const direction = vec3.subtract(vec3.create(), farPoint, nearPoint);
    vec3.normalize(direction, direction);
    return {
      origin: [nearPoint[0], nearPoint[1], nearPoint[2]],
      direction: [direction[0], direction[1], direction[2]],
    };
  }

  function selectNode(nodeId) {
    if (nodeId !== null && typeof nodeId !== 'string') {
      throw new TypeError('selectNode expects a node ID string or null.');
    }
    if (nodeId !== null) {
      const exists = currentScene.exportRecipe().nodes.some(node => node.id === nodeId);
      if (!exists) {
        throw new RangeError(`Unknown node "${nodeId}". Select an existing node ID from scene.exportRecipe().nodes.`);
      }
    }
    selectedNodeId = nodeId;
    selectedObjectKey = null;
    notify({ kind: 'selection' });
    return selectedNodeId;
  }

  /**
   * How the handles behave for this person: the step a Shift drag snaps a move to (scene units), the angle it snaps a
   * turn to (degrees) and how long the handles are drawn (screen pixels). A field left out keeps its value.
   */
  function setInteractionSettings(settings = {}) {
    const next = {
      moveSnapStep: settings.moveSnapStep ?? moveSnapStep,
      rotateSnapDegrees: settings.rotateSnapDegrees ?? rotateSnapDegrees,
      gizmoPixels: settings.gizmoPixels ?? gizmoPixels,
    };
    for (const [name, value] of Object.entries(next)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive number, got ${JSON.stringify(value)}.`);
      }
    }
    const changed = next.moveSnapStep !== moveSnapStep || next.rotateSnapDegrees !== rotateSnapDegrees || next.gizmoPixels !== gizmoPixels;
    moveSnapStep = next.moveSnapStep;
    rotateSnapDegrees = next.rotateSnapDegrees;
    gizmoPixels = next.gizmoPixels;
    if (changed) {
      notify({ kind: 'tool' });
    }
    return next;
  }

  function setTool(tool) {
    if (!STUDIO_TOOLS.includes(tool)) {
      throw new RangeError(`Unknown Studio tool "${String(tool)}". Use one of ${STUDIO_TOOLS.join(', ')}.`);
    }
    activeTool = tool;
    notify({ kind: 'tool' });
    return activeTool;
  }

  function setActiveTab(tab) {
    if (!STUDIO_TABS.includes(tab)) {
      throw new RangeError(`Unknown Studio tab "${String(tab)}". Use one of ${STUDIO_TABS.join(', ')}.`);
    }
    activeTab = tab;
    notify({ kind: 'tab' });
    return activeTab;
  }

  function pickAt(pixelX, pixelY) {
    const ray = screenRay(pixelX, pixelY);
    const hit = ensureQuery().raycast(ray);
    if (!hit) {
      selectedNodeId = null;
      selectedObjectKey = null;
      notify({ kind: 'pick', hit: null });
      return null;
    }
    const recipe = currentScene.exportRecipe();
    const resolvedId = resolveRecipeNodeId(hit.id, recipe);
    selectedNodeId = resolvedId;
    selectedObjectKey = null;
    const result = {
      id: resolvedId ?? hit.id,
      partId: hit.id,
      point: Array.from(hit.point),
      normal: Array.from(hit.normal),
      distance: hit.distance,
    };
    notify({ kind: 'pick', hit: result });
    return result;
  }

  function gizmoHandles() {
    const pivot = selectedPivotWorld();
    if (!pivot) {
      return null;
    }
    const handleLength = Math.max(0.25, worldLengthPerPixel(pivot) * gizmoPixels);
    const origin = projectWorldPoint(pivot);
    const planeExtent = handleLength * 0.4;
    const basis = worldBasisOf(selectedWorldMatrix());
    const planeCorner = (alongX, alongY, alongZ) => projectWorldPoint([
      pivot[0] + basis.x[0] * alongX + basis.y[0] * alongY + basis.z[0] * alongZ,
      pivot[1] + basis.x[1] * alongX + basis.y[1] * alongY + basis.z[1] * alongZ,
      pivot[2] + basis.x[2] * alongX + basis.y[2] * alongY + basis.z[2] * alongZ,
    ]);
    // An axis that points at the camera would shrink to a stub nobody can grab, so it is drawn longer in the scene
    // until it covers a fair share of the handle size on screen.
    const axisTip = direction => {
      const tipAt = length => planeCorner(direction[0] * length, direction[1] * length, direction[2] * length);
      const tip = tipAt(handleLength);
      if (!tip.visible || !origin.visible) {
        return tip;
      }
      const screenLength = Math.hypot(tip.x - origin.x, tip.y - origin.y);
      const wantedLength = gizmoPixels * MINIMUM_AXIS_SCREEN_SHARE;
      if (screenLength >= wantedLength || screenLength < 1e-3) {
        return tip;
      }
      const stretched = tipAt(handleLength * Math.min(MAXIMUM_AXIS_STRETCH, wantedLength / screenLength));
      return stretched.visible ? stretched : tip;
    };
    const ringPoints = axis => {
      const points = [];
      for (let step = 0; step <= ROTATION_RING_SEGMENTS; step += 1) {
        const angle = (step / ROTATION_RING_SEGMENTS) * Math.PI * 2;
        const cosine = Math.cos(angle) * handleLength * RING_RADIUS_FACTOR;
        const sine = Math.sin(angle) * handleLength * RING_RADIUS_FACTOR;
        const localOffset = axis === 'x'
          ? [0, cosine, sine]
          : axis === 'y'
            ? [cosine, 0, sine]
            : [cosine, sine, 0];
        points.push(planeCorner(localOffset[0], localOffset[1], localOffset[2]));
      }
      return points;
    };
    return {
      pivot,
      basis,
      handleLength,
      origin,
      axes: {
        x: axisTip([1, 0, 0]),
        y: axisTip([0, 1, 0]),
        z: axisTip([0, 0, 1]),
      },
      planes: {
        xy: [origin, planeCorner(planeExtent, 0, 0), planeCorner(planeExtent, planeExtent, 0), planeCorner(0, planeExtent, 0)],
        xz: [origin, planeCorner(planeExtent, 0, 0), planeCorner(planeExtent, 0, planeExtent), planeCorner(0, 0, planeExtent)],
        yz: [origin, planeCorner(0, planeExtent, 0), planeCorner(0, planeExtent, planeExtent), planeCorner(0, 0, planeExtent)],
      },
      rings: {
        x: ringPoints('x'),
        y: ringPoints('y'),
        z: ringPoints('z'),
      },
    };
  }

  // Screen outline of the selection: the convex hull of its projected vertices, so the selected object reads in the viewport.
  function selectionOutline() {
    return selectedNodeId ? nodeOutline(selectedNodeId) : null;
  }

  // World-space box around a node and its children: { min, max, size }, or null when it draws nothing.
  function nodeBounds(nodeId) {
    if (typeof nodeId !== 'string' || nodeId === '') {
      throw new TypeError('nodeBounds requires a node id string.');
    }
    const memberIds = descendantIdsOf(currentScene.exportRecipe().nodes, nodeId);
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    const point = vec3.create();
    for (const part of currentScene.parts) {
      if (!ownsPart(memberIds, part) || !part.matrix || !part.geometry?.positions) {
        continue;
      }
      const positions = part.geometry.positions;
      for (let offset = 0; offset < positions.length; offset += 3) {
        vec3.set(point, positions[offset], positions[offset + 1], positions[offset + 2]);
        vec3.transformMat4(point, point, part.matrix);
        for (let axis = 0; axis < 3; axis += 1) {
          minimum[axis] = Math.min(minimum[axis], point[axis]);
          maximum[axis] = Math.max(maximum[axis], point[axis]);
        }
      }
    }
    if (minimum[0] === Infinity) {
      return null;
    }
    return { min: minimum, max: maximum, size: maximum.map((value, axis) => value - minimum[axis]) };
  }

  // The same outline for any node, so the viewport can point at an object that is not the selection.
  function nodeOutline(nodeId) {
    if (typeof nodeId !== 'string' || nodeId === '') {
      throw new TypeError('nodeOutline requires a node id string.');
    }
    const memberIds = descendantIdsOf(currentScene.exportRecipe().nodes, nodeId);
    const memberParts = currentScene.parts.filter(part => ownsPart(memberIds, part) && part.matrix && part.geometry?.positions);
    const totalVertices = memberParts.reduce((count, part) => count + part.geometry.positions.length / 3, 0);
    if (totalVertices === 0) {
      return null;
    }
    const stride = Math.max(1, Math.ceil(totalVertices / OUTLINE_VERTEX_BUDGET));
    const point = vec3.create();
    const screenPoints = [];
    for (const part of memberParts) {
      const positions = part.geometry.positions;
      for (let offset = 0; offset < positions.length; offset += 3 * stride) {
        vec3.set(point, positions[offset], positions[offset + 1], positions[offset + 2]);
        vec3.transformMat4(point, point, part.matrix);
        const projected = projectWorldPoint([point[0], point[1], point[2]]);
        if (!projected.visible) {
          return null;
        }
        screenPoints.push([projected.x, projected.y]);
      }
    }
    const hull = convexHull(screenPoints);
    return hull.length >= 3 ? hull : null;
  }

  let silhouetteCache = { scene: null, key: '', triangles: null, contour: null };

  // The selection's parts with their vertices on screen, or null when it draws nothing or part of it is behind the camera.
  function projectSelectionMeshes() {
    const memberIds = descendantIdsOf(currentScene.exportRecipe().nodes, selectedNodeId);
    const memberParts = currentScene.parts.filter(part => ownsPart(memberIds, part) && part.matrix && part.geometry?.positions && part.geometry.indices?.length);
    if (memberParts.length === 0) {
      return null;
    }
    const { viewProjection } = cameraMatrices(viewCamera(), width / height, Boolean(currentScene.environment?.world));
    const partMatrix = mat4.create();
    const meshes = [];
    for (const part of memberParts) {
      const positions = part.geometry.positions;
      const screen = new Float32Array((positions.length / 3) * 2);
      mat4.multiply(partMatrix, viewProjection, part.matrix);
      if (!projectVerticesToScreen(partMatrix, positions, screen, width, height)) {
        return null;
      }
      meshes.push({ screen, indices: part.geometry.indices });
    }
    return meshes;
  }

  function refreshSilhouetteCache() {
    const camera = viewCamera();
    const key = [currentScene.revision, selectedNodeId, width, height, camera.eye, camera.target, camera.fov, camera.focalLength, camera.orthoScale, camera.projection].join('|');
    if (silhouetteCache.scene === currentScene && silhouetteCache.key === key) {
      return;
    }
    silhouetteCache = { scene: currentScene, key, ...computeSelectionShape() };
  }

  // The selected object's triangles on screen, as a flat list of x, y pairs (six numbers a triangle), all wound the same
  // way so a filled drawing of them has no holes where a back face meets a front face. The viewport draws the edge of
  // that shape, which follows a star or a letter where the hull would cut across. Null when there is nothing to draw,
  // or part of the object is behind the camera. An object with more triangles than the budget has none: it is outlined
  // by selectionContour instead.
  function selectionSilhouette() {
    if (!selectedNodeId) {
      return null;
    }
    refreshSilhouetteCache();
    return silhouetteCache.triangles;
  }

  // The edge of a dense selection (a scan) on screen: flat x1, y1, x2, y2 line segments along the border of the shape its
  // triangles cover, exact to the pixel, so a draw needs no path entry per triangle. Past CONTOUR_TRIANGLE_BUDGET it is the
  // four sides of the rectangle around the selection. Null for a selection that selectionSilhouette draws, and for none.
  function selectionContour() {
    if (!selectedNodeId) {
      return null;
    }
    refreshSilhouetteCache();
    return silhouetteCache.contour;
  }

  function computeSelectionShape() {
    const meshes = projectSelectionMeshes();
    if (!meshes) {
      return { triangles: null, contour: null };
    }
    const triangleCount = meshes.reduce((count, mesh) => count + mesh.indices.length / 3, 0);
    if (triangleCount > SILHOUETTE_TRIANGLE_BUDGET) {
      const contour = triangleCount > CONTOUR_TRIANGLE_BUDGET ? silhouetteRectangleSegments(meshes) : silhouetteContourSegments(meshes, width, height);
      return { triangles: null, contour };
    }
    const triangles = [];
    for (const { screen, indices } of meshes) {
      for (let offset = 0; offset < indices.length; offset += 3) {
        const first = indices[offset] * 2;
        let second = indices[offset + 1] * 2;
        let third = indices[offset + 2] * 2;
        const signedArea = (screen[second] - screen[first]) * (screen[third + 1] - screen[first + 1]) - (screen[third] - screen[first]) * (screen[second + 1] - screen[first + 1]);
        if (signedArea === 0) {
          continue;
        }
        if (signedArea < 0) {
          [second, third] = [third, second];
        }
        triangles.push(screen[first], screen[first + 1], screen[second], screen[second + 1], screen[third], screen[third + 1]);
      }
    }
    return { triangles: triangles.length ? triangles : null, contour: null };
  }

  function computeSnapTranslation(nodeId, pixelX, pixelY) {
    const recipe = currentScene.exportRecipe();
    const targetNode = recipe.nodes.find(node => node.id === nodeId);
    if (!targetNode) {
      return null;
    }
    const excluded = descendantIdsOf(recipe.nodes, nodeId);
    const supportParts = currentScene.parts.filter(part => !ownsPart(excluded, part));
    if (supportParts.length === 0) {
      return null;
    }
    const ray = screenRay(pixelX, pixelY);
    const snapQuery = createSceneQuery(supportParts);
    let hit = null;
    try {
      hit = snapQuery.raycast(ray);
    } finally {
      snapQuery.dispose();
    }
    if (!hit) {
      return null;
    }
    const worldMatrices = buildNodeWorldMatrices(recipe.nodes);
    const clearance = partClearanceAlongNormal(currentScene.parts, excluded, hit.normal, [targetNode], worldMatrices);
    const worldTarget = [
      hit.point[0] + hit.normal[0] * clearance,
      hit.point[1] + hit.normal[1] * clearance,
      hit.point[2] + hit.normal[2] * clearance,
    ];
    if (!targetNode.parent) {
      return roundVector(worldTarget);
    }
    const parentWorld = worldMatrices.get(targetNode.parent);
    const inverseParent = parentWorld ? mat4.invert(mat4.create(), parentWorld) : null;
    if (!inverseParent) {
      return roundVector(worldTarget);
    }
    const localTarget = vec3.transformMat4(vec3.create(), worldTarget, inverseParent);
    return roundVector(localTarget);
  }

  function snapSelectedToAt(pixelX, pixelY, { recordUndo = true } = {}) {
    if (!selectedNodeId) {
      throw new RangeError('Select a node before snapping it to a surface.');
    }
    const translation = computeSnapTranslation(selectedNodeId, pixelX, pixelY);
    if (!translation) {
      return null;
    }
    applySceneOperations([{ type: 'set-node', id: selectedNodeId, translation }], { recordUndo });
    notify({ kind: 'transform', nodeId: selectedNodeId });
    return translation;
  }

  function beginGizmoDrag(axis, pixelX, pixelY) {
    if (!selectedNodeId) {
      throw new RangeError('Select a node before starting a gizmo drag.');
    }
    if (!GIZMO_AXES.includes(axis)) {
      throw new RangeError(`Unsupported gizmo axis "${String(axis)}". Use ${GIZMO_AXES.join(', ')}.`);
    }
    if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) {
      throw new TypeError('beginGizmoDrag requires finite pixel coordinates.');
    }
    const recipe = currentScene.exportRecipe();
    const node = recipe.nodes.find(candidate => candidate.id === selectedNodeId);
    const handles = gizmoHandles();
    const worldMatrices = buildNodeWorldMatrices(recipe.nodes);
    const parentWorld = node.parent ? worldMatrices.get(node.parent) : null;
    let axisScreen = [1, 0];
    if (AXIS_NAMES.includes(axis) && handles) {
      const axisPoint = handles.axes[axis];
      const deltaX = axisPoint.x - handles.origin.x;
      const deltaY = axisPoint.y - handles.origin.y;
      const length = Math.hypot(deltaX, deltaY);
      if (length > 1) {
        axisScreen = [deltaX / length, deltaY / length];
      }
    }
    const basePivot = handles?.pivot ?? Array.from(node.translation ?? [0, 0, 0]);
    const isPlanar = PLANE_AXES.includes(axis) || axis === 'screen';
    const basis = handles?.basis ?? WORLD_BASIS;
    const planeNormal = isPlanar ? planeNormalForAxis(axis, viewCamera(), basis) : null;
    const startRay = screenRay(pixelX, pixelY);
    let planeStartPoint = basePivot;
    if (planeNormal) {
      planeStartPoint = rayPlaneIntersection(startRay.origin, startRay.direction, basePivot, planeNormal) ?? basePivot;
    }
    const axisWorld = AXIS_NAMES.includes(axis) ? basis[axis] : null;
    const axisStartParameter = axisWorld ? rayAxisParameter(startRay, basePivot, axisWorld) : null;
    let ringStartVector = null;
    if (axisWorld && Math.abs(vec3.dot(startRay.direction, axisWorld)) > RING_EDGE_ON_LIMIT) {
      const ringHit = rayPlaneIntersection(startRay.origin, startRay.direction, basePivot, axisWorld);
      ringStartVector = ringHit ? vec3.subtract(vec3.create(), ringHit, basePivot) : null;
    }
    const worldPerPixel = worldLengthPerPixel(basePivot);
    const toolMode = axis === 'surface' ? 'snap' : activeTool === 'select' ? 'translate' : activeTool;
    dragState = {
      nodeId: selectedNodeId,
      tool: toolMode,
      axis,
      startX: pixelX,
      startY: pixelY,
      baseRecipe: recipe,
      basePivot,
      baseTranslation: Array.from(node.translation ?? [0, 0, 0]),
      baseRotation: normalizeQuaternion(node.rotation ?? [0, 0, 0, 1]),
      baseScale: Array.from(node.scale ?? [1, 1, 1]),
      parentInverse: parentWorld ? mat4.invert(mat4.create(), parentWorld) : null,
      axisScreen,
      axisWorld,
      axisStartParameter,
      ringStartVector,
      planeNormal,
      planeStartPoint,
      worldPerPixel,
      changed: false,
      deltaLabel: '',
      baseOutline: nodeOutline(selectedNodeId),
      wrappedDegrees: 0,
      turnedDegrees: 0,
      sweepDegrees: 0,
    };
    return { nodeId: dragState.nodeId, tool: dragState.tool, axis: dragState.axis };
  }

  /**
   * What a drag has changed so far, in screen points: the `outline` the object had when the drag began and, for a move,
   * the pivot then (`from`) and now (`to`). Null until the drag has changed something.
   */
  function dragTrace() {
    if (!dragState || !dragState.changed) {
      return null;
    }
    const moves = dragState.tool === 'translate' || dragState.tool === 'snap';
    const pivot = moves ? selectedPivotWorld() : null;
    return {
      tool: dragState.tool,
      axis: dragState.axis,
      outline: dragState.baseOutline,
      from: pivot ? projectWorldPoint(Array.from(dragState.basePivot)) : null,
      to: pivot ? projectWorldPoint(Array.from(pivot)) : null,
    };
  }

  /**
   * The turn in progress while a rotation ring is dragged, in screen points: the `centre`, and an `arc` that runs along
   * the ring from where the drag began to where the object has turned. Null when no ring is being dragged.
   */
  function rotationSweep() {
    if (!dragState || dragState.tool !== 'rotate' || !dragState.ringStartVector) {
      return null;
    }
    const pivot = dragState.basePivot;
    const radius = Math.max(0.25, worldLengthPerPixel(pivot) * gizmoPixels) * RING_RADIUS_FACTOR;
    const startDirection = vec3.normalize(vec3.create(), dragState.ringStartVector);
    const shownDegrees = Math.max(-360, Math.min(360, dragState.sweepDegrees));
    const stepCount = Math.max(1, Math.ceil((Math.abs(shownDegrees) / 360) * ROTATION_RING_SEGMENTS));
    const turn = quat.create();
    const direction = vec3.create();
    const arc = [];
    for (let step = 0; step <= stepCount; step += 1) {
      quat.setAxisAngle(turn, dragState.axisWorld, (((shownDegrees * step) / stepCount) * Math.PI) / 180);
      vec3.transformQuat(direction, startDirection, turn);
      arc.push(projectWorldPoint(Array.from(vec3.scaleAndAdd(vec3.create(), pivot, direction, radius))));
    }
    return { axis: dragState.axis, degrees: dragState.sweepDegrees, centre: projectWorldPoint(Array.from(pivot)), arc };
  }

  function toNodeLocalDelta(worldDelta, parentInverse) {
    if (!parentInverse) {
      return worldDelta;
    }
    const rotated = vec3.fromValues(worldDelta[0], worldDelta[1], worldDelta[2]);
    const linearInverse = mat4.clone(parentInverse);
    linearInverse[12] = 0;
    linearInverse[13] = 0;
    linearInverse[14] = 0;
    vec3.transformMat4(rotated, rotated, linearInverse);
    return [rotated[0], rotated[1], rotated[2]];
  }

  function updateGizmoDrag(pixelX, pixelY, { shiftKey = false } = {}) {
    if (!dragState) {
      return null;
    }
    if (!Number.isFinite(pixelX) || !Number.isFinite(pixelY)) {
      throw new TypeError('updateGizmoDrag requires finite pixel coordinates.');
    }
    const deltaX = pixelX - dragState.startX;
    const deltaY = pixelY - dragState.startY;
    const axisIndex = AXIS_NAMES.indexOf(dragState.axis);
    if (dragState.tool === 'snap' || dragState.axis === 'surface') {
      const translation = computeSnapTranslation(dragState.nodeId, pixelX, pixelY);
      if (!translation) {
        return null;
      }
      applySceneOperations([{ type: 'set-node', id: dragState.nodeId, translation }], { recordUndo: false });
      dragState.changed = true;
      dragState.deltaLabel = 'Snapped to surface';
      notify({ kind: 'transform', nodeId: dragState.nodeId, live: true, deltaLabel: dragState.deltaLabel });
      return { translation };
    }
    if (dragState.tool === 'translate' && dragState.planeNormal) {
      const ray = screenRay(pixelX, pixelY);
      const hitPoint = rayPlaneIntersection(ray.origin, ray.direction, dragState.basePivot, dragState.planeNormal);
      if (!hitPoint) {
        return null;
      }
      const rawWorldDelta = [
        hitPoint[0] - dragState.planeStartPoint[0],
        hitPoint[1] - dragState.planeStartPoint[1],
        hitPoint[2] - dragState.planeStartPoint[2],
      ];
      const maxJump = Math.max(12, vec3.distance(viewCamera().eye, dragState.basePivot) * 4);
      const deltaLength = Math.hypot(...rawWorldDelta);
      if (deltaLength > maxJump) {
        const factor = maxJump / deltaLength;
        rawWorldDelta[0] *= factor;
        rawWorldDelta[1] *= factor;
        rawWorldDelta[2] *= factor;
      }
      const localDelta = toNodeLocalDelta(rawWorldDelta, dragState.parentInverse);
      const rawTranslation = [
        dragState.baseTranslation[0] + localDelta[0],
        dragState.baseTranslation[1] + localDelta[1],
        dragState.baseTranslation[2] + localDelta[2],
      ];
      const translation = roundVector(shiftKey ? snapVector(rawTranslation, moveSnapStep) : rawTranslation);
      applySceneOperations([{ type: 'set-node', id: dragState.nodeId, translation }], { recordUndo: false });
      dragState.changed = true;
      dragState.deltaLabel = `${dragState.axis.toUpperCase()} ${deltaLength.toFixed(2)} m`;
      notify({ kind: 'transform', nodeId: dragState.nodeId, live: true, deltaLabel: dragState.deltaLabel });
      return { translation };
    }
    if (dragState.tool === 'translate' && axisIndex >= 0) {
      const axisParameter = dragState.axisStartParameter === null
        ? null
        : rayAxisParameter(screenRay(pixelX, pixelY), dragState.basePivot, dragState.axisWorld);
      const maxTravel = Math.max(12, vec3.distance(viewCamera().eye, dragState.basePivot) * 4);
      const pixelTravel = (deltaX * dragState.axisScreen[0] + deltaY * dragState.axisScreen[1]) * dragState.worldPerPixel;
      const exactTravel = axisParameter === null ? pixelTravel : axisParameter - dragState.axisStartParameter;
      const steppedTravel = shiftKey ? Math.round(exactTravel / moveSnapStep) * moveSnapStep : exactTravel;
      const travel = Math.max(-maxTravel, Math.min(maxTravel, steppedTravel));
      const worldDelta = [dragState.axisWorld[0] * travel, dragState.axisWorld[1] * travel, dragState.axisWorld[2] * travel];
      const localDelta = toNodeLocalDelta(worldDelta, dragState.parentInverse);
      const rawTranslation = [
        dragState.baseTranslation[0] + localDelta[0],
        dragState.baseTranslation[1] + localDelta[1],
        dragState.baseTranslation[2] + localDelta[2],
      ];
      const translation = roundVector(rawTranslation);
      applySceneOperations([{ type: 'set-node', id: dragState.nodeId, translation }], { recordUndo: false });
      dragState.changed = true;
      dragState.deltaLabel = `${dragState.axis.toUpperCase()} ${travel >= 0 ? '+' : ''}${travel.toFixed(2)} m`;
      notify({ kind: 'transform', nodeId: dragState.nodeId, live: true, deltaLabel: dragState.deltaLabel });
      return { translation };
    }
    if (dragState.tool === 'rotate') {
      let rawDegrees = (deltaX - deltaY) * ROTATION_DEGREES_PER_PIXEL;
      if (dragState.ringStartVector) {
        const ray = screenRay(pixelX, pixelY);
        const ringHit = rayPlaneIntersection(ray.origin, ray.direction, dragState.basePivot, dragState.axisWorld);
        if (ringHit) {
          const ringVector = vec3.subtract(vec3.create(), ringHit, dragState.basePivot);
          const wrappedDegrees = (signedAngleAround(dragState.axisWorld, dragState.ringStartVector, ringVector) * 180) / Math.PI;
          // The angle between two directions stops at half a turn, so the steps are added up to follow a longer turn.
          const step = wrappedDegrees - dragState.wrappedDegrees;
          dragState.wrappedDegrees = wrappedDegrees;
          dragState.turnedDegrees += step > 180 ? step - 360 : step < -180 ? step + 360 : step;
          rawDegrees = dragState.turnedDegrees;
        }
      }
      const degrees = shiftKey ? Math.round(rawDegrees / rotateSnapDegrees) * rotateSnapDegrees : rawDegrees;
      dragState.sweepDegrees = degrees;
      const radians = (degrees * Math.PI) / 180;
      const axisVector = axisIndex === 0 ? [1, 0, 0] : axisIndex === 1 ? [0, 1, 0] : [0, 0, 1];
      // The turn is about the object's own axis, so it is applied after the node's rotation.
      const deltaQuaternion = quat.setAxisAngle(quat.create(), axisVector, radians);
      const nextQuaternion = quat.multiply(quat.create(), dragState.baseRotation, deltaQuaternion);
      const rotation = normalizeQuaternion(nextQuaternion);
      applySceneOperations([{ type: 'set-node', id: dragState.nodeId, rotation }], { recordUndo: false });
      dragState.changed = true;
      dragState.deltaLabel = `${(axisIndex >= 0 ? dragState.axis : 'z').toUpperCase()} ${degrees >= 0 ? '+' : ''}${degrees.toFixed(1)}°`;
      notify({ kind: 'transform', nodeId: dragState.nodeId, live: true, deltaLabel: dragState.deltaLabel });
      return { rotation };
    }
    if (dragState.tool === 'scale') {
      const signedPixels = PLANE_AXES.includes(dragState.axis) || dragState.axis === 'uniform' || dragState.axis === 'screen'
        ? deltaX - deltaY
        : deltaX * dragState.axisScreen[0] + deltaY * dragState.axisScreen[1];
      // Away from an axis handle, one handle length of drag doubles the size.
      let rawFactor = 1 + signedPixels / gizmoPixels;
      if (axisIndex >= 0 && dragState.axisStartParameter !== null && Math.abs(dragState.axisStartParameter) > 1e-3) {
        const axisParameter = rayAxisParameter(screenRay(pixelX, pixelY), dragState.basePivot, dragState.axisWorld);
        if (axisParameter !== null) {
          rawFactor = axisParameter / dragState.axisStartParameter;
        }
      }
      const factor = Math.max(MINIMUM_SCALE, Math.min(MAXIMUM_SCALE, rawFactor));
      const affectsAxis = index => {
        if (dragState.axis === 'uniform' || dragState.axis === 'screen') return true;
        if (index === axisIndex) return true;
        return PLANE_AXES.includes(dragState.axis) && dragState.axis.includes(AXIS_NAMES[index]);
      };
      const scale = roundVector(dragState.baseScale.map((component, index) => (
        affectsAxis(index) ? Math.max(MINIMUM_SCALE, Math.min(MAXIMUM_SCALE, component * factor)) : component
      )));
      applySceneOperations([{ type: 'set-node', id: dragState.nodeId, scale }], { recordUndo: false });
      dragState.changed = true;
      dragState.deltaLabel = `×${factor.toFixed(2)}`;
      notify({ kind: 'transform', nodeId: dragState.nodeId, live: true, deltaLabel: dragState.deltaLabel });
      return { scale };
    }
    return null;
  }

  function endGizmoDrag() {
    if (!dragState) {
      return false;
    }
    const { baseRecipe, changed } = dragState;
    dragState = null;
    if (changed) {
      pushUndoSnapshot(baseRecipe);
      notify({ kind: 'transformCommit', deltaLabel: '' });
    } else {
      notify({ kind: 'transformCancel', deltaLabel: '' });
    }
    return changed;
  }

  // Puts the object back where the drag found it. Nothing is added to undo: the drag never happened.
  function cancelGizmoDrag() {
    if (!dragState) {
      return false;
    }
    const { nodeId, baseTranslation, baseRotation, baseScale, changed } = dragState;
    dragState = null;
    if (changed && currentScene.exportRecipe().nodes.some(node => node.id === nodeId)) {
      applySceneOperations([{ type: 'set-node', id: nodeId, translation: baseTranslation, rotation: baseRotation, scale: baseScale }], { recordUndo: false });
    }
    notify({ kind: 'transformCancel', deltaLabel: '' });
    return true;
  }

  /** The axis of the selected object that points most nearly at the camera: the one a turn in the screen plane goes around. */
  function axisFacingView() {
    const worldMatrix = selectedWorldMatrix();
    const basis = worldMatrix ? worldBasisOf(worldMatrix) : WORLD_BASIS;
    const camera = viewCamera();
    const viewDirection = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), camera.target, camera.eye));
    let facingAxis = 'y';
    let strongest = -1;
    for (const axis of AXIS_NAMES) {
      const alignment = Math.abs(vec3.dot(viewDirection, basis[axis]));
      if (alignment > strongest) {
        strongest = alignment;
        facingAxis = axis;
      }
    }
    return facingAxis;
  }

  function updateNodeTransform(nodeId, patch) {
    if (!patch || typeof patch !== 'object') {
      throw new TypeError('updateNodeTransform expects a patch object.');
    }
    const operation = { type: 'set-node', id: nodeId };
    if (patch.label !== undefined) {
      if (typeof patch.label !== 'string' || patch.label.length > 256) {
        throw new TypeError('Node label must be a string of at most 256 characters.');
      }
      operation.label = patch.label.trim() || nodeId;
    }
    if (patch.parent !== undefined) {
      if (patch.parent !== null) {
        const recipe = currentScene.exportRecipe();
        if (!recipe.nodes.some(node => node.id === patch.parent)) {
          throw new RangeError(`Unknown parent node "${String(patch.parent)}".`);
        }
        if (descendantIdsOf(recipe.nodes, nodeId).has(patch.parent)) {
          throw new RangeError('Cannot parent a node under itself or its descendant.');
        }
      }
      operation.parent = patch.parent;
    }
    if (patch.translation !== undefined) {
      operation.translation = roundVector(assertFiniteVector(patch.translation, 3, 'translation'));
    }
    if (patch.rotationDegrees !== undefined) {
      operation.rotation = eulerDegreesToQuaternion(assertFiniteVector(patch.rotationDegrees, 3, 'rotationDegrees'));
    } else if (patch.rotation !== undefined) {
      operation.rotation = normalizeQuaternion(assertFiniteVector(patch.rotation, 4, 'rotation'));
    }
    if (patch.scale !== undefined) {
      const scale = assertFiniteVector(patch.scale, 3, 'scale');
      if (scale.some(component => component <= 0)) {
        throw new RangeError('Node scale components must stay positive.');
      }
      operation.scale = roundVector(scale);
    }
    for (const flagField of ['visible', 'castShadow', 'receiveShadow']) {
      if (patch[flagField] !== undefined) {
        if (typeof patch[flagField] !== 'boolean') {
          throw new TypeError(`Node ${flagField} must be true or false.`);
        }
        operation[flagField] = patch[flagField];
      }
    }
    applySceneOperations([operation]);
    notify({ kind: patch.parent !== undefined ? 'topology' : 'transform', nodeId });
    return operation;
  }

  function addPrimitive(primitiveType, options = {}) {
    const spec = primitiveGeometrySpec(primitiveType);
    const recipe = currentScene.exportRecipe();
    const geometryIds = new Set(recipe.geometries.map(item => item.id));
    const nodeIds = new Set(recipe.nodes.map(item => item.id));
    const materialIds = new Set(recipe.materials.map(item => item.id));
    const baseName = primitiveType.toLowerCase();
    const geometryId = uniqueIdentifier(geometryIds, `geo-${baseName}`);
    const nodeId = uniqueIdentifier(nodeIds, baseName);
    let materialId = options.materialId && materialIds.has(options.materialId) ? options.materialId : null;
    const operations = [
      { type: 'add-geometry', geometry: { id: geometryId, ...spec.geometry } },
    ];
    if (!materialId) {
      materialId = uniqueIdentifier(materialIds, 'mat');
      operations.push({
        type: 'add-material',
        material: {
          id: materialId,
          tag: 'surface',
          color: options.color ?? [0.68, 0.44, 0.34],
          roughness: 0.48,
          metallic: 0.04,
        },
      });
    }
    const labelNumber = nodeId.split('-').pop();
    const nodeRecord = {
      id: nodeId,
      label: options.label ?? `${spec.labelPrefix} ${labelNumber}`,
      geometry: geometryId,
      material: materialId,
      translation: options.translation ?? (GROUND_PRIMITIVES.has(primitiveType) ? spec.translation : freeSpawnTranslation(spec.translation, recipe.nodes)),
      rotation: options.rotation ?? spec.rotation,
      scale: options.scale ?? spec.scale,
    };
    if (options.parent) {
      nodeRecord.parent = options.parent;
    }
    operations.push({ type: 'add-node', node: nodeRecord });
    applySceneOperations(operations);
    selectedNodeId = nodeId;
    selectedObjectKey = null;
    notify({ kind: 'topology', nodeId });
    return nodeRecord;
  }

  // A new light becomes the selection, as a new mesh does, so its panel and its handle are there to edit at once.
  function selectAddedLight(lightType, count) {
    selectedObjectKey = `${lightType}:${count - 1}`;
    selectedNodeId = null;
    notify({ kind: 'selection' });
    return count;
  }

  function addSceneLight(lightType = 'point') {
    const environment = currentScene.exportRecipe().environment ?? {};
    if (lightType === 'point') {
      const existing = environment.pointLights ?? [];
      if (existing.length >= MAX_POINT_LIGHTS) {
        throw new RangeError(`Scene already reached the limit of ${MAX_POINT_LIGHTS} point lights.`);
      }
      const nextLights = [...existing, { position: [2.2, 3.0, 2.2], color: [1, 0.96, 0.9], intensity: 2.5, radius: 0.14, range: 14, castShadow: true }];
      updateLook({ environment: { pointLights: nextLights } });
      return selectAddedLight('point', nextLights.length);
    }
    if (lightType === 'spot') {
      const existing = environment.spotLights ?? [];
      if (existing.length >= MAX_SPOT_LIGHTS) {
        throw new RangeError(`Scene already reached the limit of ${MAX_SPOT_LIGHTS} spot lights.`);
      }
      const nextLights = [...existing, { position: [2.8, 3.8, 2.8], direction: [-2.8, -3.2, -2.8], angle: 0.65, penumbra: 0.25, color: [1, 0.96, 0.9], intensity: 4, radius: 0.12, range: 16, castShadow: true }];
      updateLook({ environment: { spotLights: nextLights } });
      return selectAddedLight('spot', nextLights.length);
    }
    if (lightType === 'area') {
      const existing = environment.areaLights ?? [];
      if (existing.length >= MAX_AREA_LIGHTS) {
        throw new RangeError(`Scene already reached the limit of ${MAX_AREA_LIGHTS} area lights.`);
      }
      const nextLights = [...existing, { position: [0, 3.2, 0], direction: [0, -1, 0], up: [0, 0, 1], width: 2, height: 2, color: [1, 0.96, 0.9], intensity: 4 }];
      updateLook({ environment: { areaLights: nextLights } });
      return selectAddedLight('area', nextLights.length);
    }
    throw new RangeError(`Unsupported light type "${String(lightType)}". Use point, spot or area.`);
  }

  // The camera and the lights are not recipe nodes, so Studio lists them as scene objects backed by recipe.camera and recipe.environment.
  function lightKeysOf(environment) {
    return Object.entries(SCENE_LIGHT_FIELDS).flatMap(([lightType, field]) => (environment?.[field] ?? []).map((_, index) => `${lightType}:${index}`));
  }

  function sceneObjectKeys() {
    return ['camera', 'sun', ...lightKeysOf(currentScene.exportRecipe().environment)];
  }

  function parseLightKey(key) {
    const match = /^(point|spot|area):(\d+)$/.exec(String(key));
    return match ? { lightType: match[1], index: Number(match[2]), field: SCENE_LIGHT_FIELDS[match[1]] } : null;
  }

  function assertSceneObjectKey(key) {
    if (!sceneObjectKeys().includes(key)) {
      throw new RangeError(`Unknown scene object "${String(key)}". Pass one of: ${sceneObjectKeys().join(', ')}.`);
    }
  }

  /** The properties of one scene object that a motion track or driver animates. */
  function drivenPropertiesOf(motionKind, motionId) {
    const motion = currentScene.exportRecipe().motion;
    const matchesTarget = target => target?.kind === motionKind && (motionId === undefined || target.id === motionId);
    const properties = new Set();
    for (const track of motion?.tracks ?? []) {
      if (matchesTarget(track)) {
        properties.add(track.property);
      }
    }
    for (const driver of motion?.drivers ?? []) {
      if (matchesTarget(driver.target)) {
        properties.add(driver.target.property);
      }
    }
    return properties;
  }

  // A camera track or driver stages the eye, target and up whichever field it animates, so those three are always driven then.
  function drivenCameraProperties() {
    const properties = drivenPropertiesOf('camera');
    if (cameraIsDriven()) {
      ['eye', 'target', 'up'].forEach(field => properties.add(field));
    }
    return properties;
  }

  // The world, quality, effects and shadow panels read one record of the recipe and are not objects of the scene tree.
  function describeSceneRecord(key) {
    const { kind, record, motionKind } = SCENE_RECORD_PANELS[key];
    const recipe = currentScene.exportRecipe();
    const drivenProperties = motionKind ? drivenPropertiesOf(motionKind) : new Set();
    return { key, kind, source: structuredClone(recipe[record] ?? {}), drivenProperties };
  }

  /**
   * What the property panel needs of one scene object: its kind, a copy of the recipe record that holds its fields
   * (the camera, the environment for the sun, or one light) and the fields a motion track or driver animates.
   */
  function describeSceneObject(key) {
    if (Object.hasOwn(SCENE_RECORD_PANELS, key)) {
      return describeSceneRecord(key);
    }
    assertSceneObjectKey(key);
    const recipe = currentScene.exportRecipe();
    if (key === 'camera') {
      return { key, kind: 'camera', source: structuredClone(recipe.camera), drivenProperties: drivenCameraProperties() };
    }
    if (key === 'sun') {
      return { key, kind: 'sun', source: structuredClone(recipe.environment ?? {}), drivenProperties: drivenPropertiesOf('sun') };
    }
    const light = parseLightKey(key);
    return { key, kind: light.lightType, source: structuredClone(recipe.environment[light.field][light.index]), drivenProperties: drivenPropertiesOf('light', key) };
  }

  function lightLabel(lightType, index) {
    const name = `${lightType[0].toUpperCase()}${lightType.slice(1)} light`;
    return index === 0 ? name : `${name} ${index + 1}`;
  }

  /** The camera, the sun and every light, in that order, read from the sampled scene so positions follow playback. */
  function listSceneObjects() {
    const sampledCamera = currentScene.camera;
    const sampledEnvironment = currentScene.environment;
    const objects = [
      { key: 'camera', kind: 'camera', label: 'Camera', position: [...sampledCamera.eye], driven: cameraIsDriven() },
      {
        key: 'sun',
        kind: 'sun',
        label: 'Sun',
        position: null,
        direction: Array.from(vec3.normalize(vec3.create(), sampledEnvironment.lightDirection ?? [0, 1, 0])),
        driven: drivenPropertiesOf('sun').size > 0,
      },
    ];
    for (const [lightType, field] of Object.entries(SCENE_LIGHT_FIELDS)) {
      (sampledEnvironment[field] ?? []).forEach((light, index) => {
        const key = `${lightType}:${index}`;
        objects.push({ key, kind: lightType, label: lightLabel(lightType, index), position: [...light.position], driven: drivenPropertiesOf('light', key).size > 0 });
      });
    }
    return objects;
  }

  function selectSceneObject(key) {
    assertSceneObjectKey(key);
    selectedObjectKey = key;
    selectedNodeId = null;
    notify({ kind: 'selection' });
    return selectedObjectKey;
  }

  function editableLight(key, action) {
    const light = parseLightKey(key);
    if (!light) {
      throw new RangeError(`"${String(key)}" cannot be ${action}: the camera and the sun are always part of a scene. Pass a light key such as point:0, spot:0 or area:0.`);
    }
    assertSceneObjectKey(key);
    return light;
  }

  /** Moves a point, spot or area light. A light whose position a motion track or driver animates is refused, since the motion would win. */
  function moveSceneObject(key, position) {
    const light = editableLight(key, 'moved');
    const nextPosition = roundVector(assertFiniteVector(position, 3, 'position'));
    if (drivenPropertiesOf('light', key).has('position')) {
      throw new RangeError(`The ${key} light position is animated by a motion track or driver, so a move would not show. Remove that motion or edit its keyframes.`);
    }
    const lights = structuredClone(currentScene.exportRecipe().environment[light.field]);
    lights[light.index].position = nextPosition;
    updateLook({ environment: { [light.field]: lights } });
    return nextPosition;
  }

  function roundPatchValue(value) {
    if (typeof value === 'number') {
      return roundValue(value);
    }
    return Array.isArray(value) && value.every(component => typeof component === 'number') ? roundVector(value) : value;
  }

  /**
   * Sets fields of a point, spot or area light. A field the patch sets to undefined is removed. A field that a motion
   * track or driver animates is refused, since the motion would win. recordUndo false leaves the step to a gesture's undo group.
   */
  function updateSceneLight(key, patch, { recordUndo = true } = {}) {
    const light = editableLight(key, 'edited');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('updateSceneLight expects a patch object such as { intensity: 3 }.');
    }
    const drivenFields = drivenPropertiesOf('light', key);
    const blockedField = Object.keys(patch).find(field => drivenFields.has(field));
    if (blockedField) {
      throw new RangeError(`The ${key} light ${blockedField} is animated by a motion track or driver, so an edit would not show. Remove that motion or edit its keyframes.`);
    }
    const lights = structuredClone(currentScene.exportRecipe().environment[light.field]);
    const nextLight = { ...lights[light.index] };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete nextLight[field];
      } else {
        nextLight[field] = roundPatchValue(value);
      }
    }
    lights[light.index] = nextLight;
    applySceneOperations([{ type: 'set-environment', environment: { [light.field]: lights } }], { recordUndo });
    notify({ kind: 'look' });
    return structuredClone(nextLight);
  }

  function lightIdAfterDelete(id, deleted) {
    const parsed = parseLightKey(id);
    if (!parsed || parsed.lightType !== deleted.lightType || parsed.index <= deleted.index) {
      return id;
    }
    return `${parsed.lightType}:${parsed.index - 1}`;
  }

  // Lights are addressed by their index, so removing one drops its motion and renumbers the lights after it.
  function motionAfterLightDelete(motion, key, deleted) {
    const isDeleted = target => target?.kind === 'light' && target.id === key;
    const renumber = target => (target?.kind === 'light' ? { ...target, id: lightIdAfterDelete(target.id, deleted) } : target);
    const tracks = (motion.tracks ?? []).filter(track => !isDeleted(track)).map(renumber);
    const next = { ...motion, tracks };
    if (motion.drivers) {
      next.drivers = motion.drivers.filter(driver => !isDeleted(driver.target)).map(driver => ({ ...driver, target: renumber(driver.target) }));
    }
    return next;
  }

  function deleteSceneObject(key) {
    const light = editableLight(key, 'deleted');
    const recipe = currentScene.exportRecipe();
    const operations = [];
    if (recipe.motion && (recipe.motion.tracks ?? []).concat((recipe.motion.drivers ?? []).map(driver => driver.target)).some(target => target?.kind === 'light' && parseLightKey(target.id)?.lightType === light.lightType)) {
      const nextMotion = motionAfterLightDelete(recipe.motion, key, light);
      operations.push({ type: 'set-motion', motion: motionIsEmpty(nextMotion) ? null : nextMotion });
    }
    const lights = recipe.environment[light.field].filter((_, index) => index !== light.index);
    operations.push({ type: 'set-environment', environment: { [light.field]: lights } });
    applySceneOperations(operations);
    selectedObjectKey = selectedObjectKey === key || selectedObjectKey === null ? null : lightIdAfterDelete(selectedObjectKey, light);
    notify({ kind: 'look' });
    return key;
  }

  function selectedSourceNode(action) {
    if (!selectedNodeId) {
      throw new RangeError(`Select a node before ${action} it.`);
    }
    const source = currentScene.exportRecipe().nodes.find(node => node.id === selectedNodeId);
    if (!source) {
      throw new RangeError(`Unknown node "${selectedNodeId}".`);
    }
    return source;
  }

  // One undo step that adds a copy of `source`, shifted aside by `offsetSteps` offsets, and selects it.
  function addNodeCopy(source, offsetSteps) {
    const recipe = currentScene.exportRecipe();
    const existingIds = new Set(recipe.nodes.map(node => node.id));
    const copyId = uniqueIdentifier(existingIds, `${source.id}-copy`);
    const cloned = structuredClone(source);
    cloned.id = copyId;
    cloned.label = `${source.label ?? source.id} copy`;
    cloned.translation = roundVector([
      (source.translation?.[0] ?? 0) + COPY_OFFSET[0] * offsetSteps,
      source.translation?.[1] ?? 0,
      (source.translation?.[2] ?? 0) + COPY_OFFSET[2] * offsetSteps,
    ]);
    // The parent may be gone by the time a copy is pasted.
    if (cloned.parent !== undefined && !existingIds.has(cloned.parent)) {
      delete cloned.parent;
    }
    applySceneOperations([{ type: 'add-node', node: cloned }]);
    selectedNodeId = copyId;
    selectedObjectKey = null;
    notify({ kind: 'topology', nodeId: copyId });
    return cloned;
  }

  function duplicateSelected() {
    return addNodeCopy(selectedSourceNode('duplicating'), 1);
  }

  /** Remembers the selected node, as it is now, for pasteCopy. The scene is not touched. */
  function copySelected() {
    copiedNode = structuredClone(selectedSourceNode('copying'));
    pasteCount = 0;
    return structuredClone(copiedNode);
  }

  /** Adds a copy of the node copySelected remembered; it still works after the original is deleted or the selection moved. */
  function pasteCopy() {
    if (!copiedNode) {
      throw new RangeError('Copy a node before pasting: select one and use copySelected().');
    }
    pasteCount += 1;
    return addNodeCopy(copiedNode, pasteCount);
  }

  function deleteSelected() {
    if (!selectedNodeId) {
      throw new RangeError('Select a node before deleting it.');
    }
    const recipe = currentScene.exportRecipe();
    if (!recipe.nodes.some(node => node.id === selectedNodeId)) {
      throw new RangeError(`Unknown node "${selectedNodeId}".`);
    }
    const removed = descendantIdsOf(recipe.nodes, selectedNodeId);
    const operations = [];
    if (recipe.motion?.tracks?.some(track => track.kind === 'node' && removed.has(track.id))) {
      const remainingTracks = recipe.motion.tracks.filter(track => !(track.kind === 'node' && removed.has(track.id)));
      const nextMotion = { ...recipe.motion, tracks: remainingTracks };
      operations.push({ type: 'set-motion', motion: motionIsEmpty(nextMotion) ? null : nextMotion });
    }
    if (recipe.environment?.lines?.nodes && Object.keys(recipe.environment.lines.nodes).some(id => removed.has(id))) {
      const nextLineNodes = Object.fromEntries(Object.entries(recipe.environment.lines.nodes).filter(([id]) => !removed.has(id)));
      operations.push({ type: 'set-environment', environment: { lines: { ...recipe.environment.lines, nodes: nextLineNodes } } });
    }
    operations.push({ type: 'remove-node', id: selectedNodeId, recursive: true });
    applySceneOperations(operations);
    // Nothing is selected afterwards, so a second Delete cannot remove an object nobody picked.
    selectedNodeId = null;
    notify({ kind: 'topology', nodeId: null });
    return null;
  }

  function updateMaterial(materialId, patch) {
    if (!patch || typeof patch !== 'object') {
      throw new TypeError('updateMaterial expects a patch object.');
    }
    const operation = { type: 'set-material', id: materialId };
    if (patch.hexColor !== undefined) {
      operation.color = hexToLinearRgb(patch.hexColor);
    } else if (patch.color !== undefined) {
      operation.color = roundVector(assertFiniteVector(patch.color, 3, 'color'));
    }
    if (patch.emissiveHex !== undefined) {
      operation.emissiveColor = hexToLinearRgb(patch.emissiveHex);
    } else if (patch.emissiveColor !== undefined) {
      operation.emissiveColor = roundVector(assertFiniteVector(patch.emissiveColor, 3, 'emissiveColor'));
    }
    for (const scalarField of ['roughness', 'metallic', 'clearcoat', 'clearcoatRoughness', 'emission', 'opacity']) {
      if (patch[scalarField] !== undefined) {
        if (typeof patch[scalarField] !== 'number' || !Number.isFinite(patch[scalarField])) {
          throw new TypeError(`Material ${scalarField} must be a finite number.`);
        }
        operation[scalarField] = roundValue(patch[scalarField]);
      }
    }
    if (patch.doubleSided !== undefined) {
      if (typeof patch.doubleSided !== 'boolean') {
        throw new TypeError('Material doubleSided must be true or false.');
      }
      operation.doubleSided = patch.doubleSided;
    }
    applySceneOperations([operation]);
    notify({ kind: 'material', materialId });
    return operation;
  }

  function createMaterial({ color = [0.72, 0.72, 0.72], roughness = 0.42, metallic = 0.05, assignToNodeId = selectedNodeId } = {}) {
    const recipe = currentScene.exportRecipe();
    const existingIds = new Set(recipe.materials.map(item => item.id));
    const materialId = uniqueIdentifier(existingIds, 'mat');
    const materialRecord = { id: materialId, tag: 'surface', color, roughness, metallic };
    const operations = [{ type: 'add-material', material: materialRecord }];
    if (assignToNodeId && recipe.nodes.some(node => node.id === assignToNodeId && node.geometry !== undefined)) {
      operations.push({ type: 'set-node', id: assignToNodeId, material: materialId });
    }
    applySceneOperations(operations);
    notify({ kind: 'material', materialId });
    return materialRecord;
  }

  function assignNodeMaterial(nodeId, materialId) {
    const recipe = currentScene.exportRecipe();
    if (!recipe.nodes.some(node => node.id === nodeId && node.geometry !== undefined)) {
      throw new RangeError(`Node "${String(nodeId)}" has no geometry to paint.`);
    }
    if (!recipe.materials.some(material => material.id === materialId)) {
      throw new RangeError(`Unknown material "${String(materialId)}".`);
    }
    applySceneOperations([{ type: 'set-node', id: nodeId, material: materialId }]);
    notify({ kind: 'material', materialId, nodeId });
    return materialId;
  }

  function applyMaterialPreset(materialId, presetName) {
    const preset = STUDIO_MATERIAL_PRESETS[presetName];
    if (!preset) {
      throw new RangeError(`Unknown material preset "${String(presetName)}". Use ${Object.keys(STUDIO_MATERIAL_PRESETS).join(', ')}.`);
    }
    return updateMaterial(materialId, {
      color: [...preset.color],
      roughness: preset.roughness,
      metallic: preset.metallic,
      clearcoat: preset.clearcoat ?? 0,
      clearcoatRoughness: preset.clearcoatRoughness ?? 0.1,
      opacity: preset.opacity ?? 1,
      emission: preset.emission ?? 0,
      ...(preset.emissiveColor ? { emissiveColor: [...preset.emissiveColor] } : {}),
    });
  }

  function updateLook({ environment, effects } = {}) {
    const operations = [];
    if (environment !== undefined) {
      operations.push({ type: 'set-environment', environment });
    }
    if (effects !== undefined) {
      operations.push({ type: 'set-effects', effects });
    }
    if (operations.length === 0) {
      return;
    }
    applySceneOperations(operations);
    notify({ kind: 'look' });
  }

  /** Sets fields of the shadow box (target, extent, distance, near, far) as one undo step; a box the renderer cannot use is refused. */
  function updateSceneShadow(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('updateSceneShadow expects a patch object such as { extent: 5 }.');
    }
    const roundedPatch = Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, roundPatchValue(value)]));
    applySceneOperations([{ type: 'set-shadow', shadow: roundedPatch }]);
    notify({ kind: 'look' });
    return structuredClone(currentScene.exportRecipe().shadow);
  }

  function setSunAngles({ azimuthDegrees, elevationDegrees, keyIntensity } = {}) {
    const currentEnvironment = currentScene.exportRecipe().environment ?? {};
    const currentAngles = directionToSunAngles(currentEnvironment.lightDirection);
    const nextAzimuth = azimuthDegrees ?? currentAngles.azimuthDegrees;
    const nextElevation = elevationDegrees ?? currentAngles.elevationDegrees;
    const patch = { lightDirection: sunAnglesToDirection(nextAzimuth, nextElevation) };
    if (keyIntensity !== undefined) {
      if (typeof keyIntensity !== 'number' || !Number.isFinite(keyIntensity) || keyIntensity < 0) {
        throw new RangeError('keyIntensity must be a non-negative finite number.');
      }
      patch.keyIntensity = roundValue(keyIntensity);
    }
    updateLook({ environment: patch });
    return patch;
  }

  function orbitCamera({ deltaAzimuth = 0, deltaElevation = 0, zoomScale = 1, panX = 0, panY = 0, recordUndo = false } = {}) {
    const camera = viewCamera();
    const offset = vec3.subtract(vec3.create(), camera.eye, camera.target);
    const radius = Math.max(MINIMUM_DISTANCE, Math.min(MAXIMUM_DISTANCE, vec3.length(offset) * zoomScale));
    const currentHorizontal = Math.hypot(offset[0], offset[2]);
    const azimuth = Math.atan2(offset[0], offset[2]) + deltaAzimuth;
    const elevation = Math.max(-MAXIMUM_ELEVATION, Math.min(MAXIMUM_ELEVATION, Math.atan2(offset[1], currentHorizontal) + deltaElevation));
    const upVector = camera.up ?? [0, 1, 0];
    const forward = vec3.normalize(vec3.create(), [-offset[0], -offset[1], -offset[2]]);
    const right = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), forward, upVector));
    const cameraUp = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), right, forward));
    const panOffset = [
      (right[0] * panX + cameraUp[0] * panY) * radius,
      (right[1] * panX + cameraUp[1] * panY) * radius,
      (right[2] * panX + cameraUp[2] * panY) * radius,
    ];
    const nextTarget = [
      camera.target[0] + panOffset[0],
      camera.target[1] + panOffset[1],
      camera.target[2] + panOffset[2],
    ];
    const horizontal = Math.cos(elevation) * radius;
    const nextEye = [
      nextTarget[0] + Math.sin(azimuth) * horizontal,
      nextTarget[1] + Math.sin(elevation) * radius,
      nextTarget[2] + Math.cos(azimuth) * horizontal,
    ];
    const operation = { eye: roundVector(nextEye), target: roundVector(nextTarget) };
    if (camera.projection === 'orthographic' && zoomScale !== 1) {
      operation.orthoScale = roundValue(Math.max(0.25, Math.min(100, (camera.orthoScale ?? 4) * zoomScale)));
    }
    return moveView(operation, { recordUndo });
  }

  function updateCamera(patch) {
    if (!patch || typeof patch !== 'object') {
      throw new TypeError('updateCamera expects a camera patch object.');
    }
    applySceneOperations([{ type: 'set-camera', ...patch }]);
    notify({ kind: 'camera', edited: true });
    return viewCamera();
  }

  /**
   * Sets camera fields from the property panel. A field the patch sets to undefined is removed, which set-camera cannot do,
   * so that edit goes through a reload of the recipe, still as one undo step.
   */
  function updateSceneCamera(patch) {
    if (!patch || typeof patch !== 'object') {
      throw new TypeError('updateSceneCamera expects a camera patch object.');
    }
    const patchFields = Object.keys(patch);
    if (patchFields.length === 1 && patchFields[0] === 'projection') {
      // Switching projection also converts the lens, which toggleCameraProjection knows how to do.
      return (viewCamera().projection ?? 'perspective') === patch.projection ? viewCamera() : toggleCameraProjection();
    }
    if (!Object.values(patch).includes(undefined)) {
      return updateCamera(patch);
    }
    const recipe = currentScene.exportRecipe();
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete recipe.camera[field];
      } else {
        recipe.camera[field] = value;
      }
    }
    loadRecipe(recipe);
    notify({ kind: 'camera', edited: true });
    return viewCamera();
  }

  function setCameraViewPreset(presetName) {
    if (!STUDIO_VIEW_PRESETS.includes(presetName)) {
      throw new RangeError(`Unknown camera view "${String(presetName)}". Use ${STUDIO_VIEW_PRESETS.join(', ')}.`);
    }
    const camera = viewCamera();
    const distance = Math.max(MINIMUM_DISTANCE, vec3.distance(camera.eye, camera.target));
    const unitDirections = {
      front: [0, 0, 1],
      back: [0, 0, -1],
      right: [1, 0, 0],
      left: [-1, 0, 0],
      top: [0.002, 1, 0.002],
      isometric: [1, 0.72, 1],
    };
    const unit = vec3.normalize(vec3.create(), unitDirections[presetName]);
    const eye = roundVector([
      camera.target[0] + unit[0] * distance,
      camera.target[1] + unit[1] * distance,
      camera.target[2] + unit[2] * distance,
    ]);
    return moveView({ eye, up: [0, 1, 0] }, { recordUndo: true });
  }

  function toggleCameraProjection() {
    const camera = viewCamera();
    const aspect = width / height;
    const distance = Math.max(0.5, vec3.distance(camera.eye, camera.target));
    const currentFov = roundValue(cameraFieldOfView(camera, aspect), DEGREE_PRECISION);
    if (camera.projection === 'orthographic') {
      return updateCamera({ projection: 'perspective', fov: currentFov });
    }
    const orthoScale = roundValue(Math.max(0.5, 2 * distance * Math.tan((currentFov * Math.PI) / 360)));
    return updateCamera({ projection: 'orthographic', orthoScale, fov: currentFov });
  }

  function setCameraLensMillimetres(focalLength) {
    assertPositiveFinite(focalLength, 'focalLength');
    return updateCamera({ projection: 'perspective', focalLength: roundValue(focalLength, DEGREE_PRECISION), sensorWidth: 36 });
  }

  // The bounds of the selection, or of every object when nothing is selected.
  function framedBounds() {
    if (selectedNodeId) {
      return nodeBounds(selectedNodeId);
    }
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    const point = vec3.create();
    for (const part of currentScene.parts) {
      const positions = part.matrix && part.geometry?.positions;
      for (let offset = 0; positions && offset < positions.length; offset += 3) {
        vec3.set(point, positions[offset], positions[offset + 1], positions[offset + 2]);
        vec3.transformMat4(point, point, part.matrix);
        for (let axis = 0; axis < 3; axis += 1) {
          minimum[axis] = Math.min(minimum[axis], point[axis]);
          maximum[axis] = Math.max(maximum[axis], point[axis]);
        }
      }
    }
    return minimum[0] === Infinity ? null : { min: minimum, max: maximum };
  }

  /**
   * The camera that frames the selection (or the whole scene when nothing is selected): it keeps the direction it looks
   * from and stands back just far enough for the object to fit the view. Returns a set-camera patch and changes nothing.
   */
  function frameSelectionPose() {
    const camera = viewCamera();
    const bounds = framedBounds();
    const target = bounds ? bounds.min.map((value, axis) => (value + bounds.max[axis]) / 2) : selectedPivotWorld() ?? [...camera.target];
    const radius = bounds ? Math.max(FRAME_MINIMUM_RADIUS, vec3.distance(bounds.min, bounds.max) / 2) : FRAME_MINIMUM_RADIUS;
    const offset = vec3.subtract(vec3.create(), camera.eye, camera.target);
    const direction = vec3.normalize(vec3.create(), offset);
    if (vec3.length(direction) < 1e-6) {
      vec3.set(direction, 0.5, 0.4, 0.8);
      vec3.normalize(direction, direction);
    }
    const aspect = width / height;
    const narrowSide = Math.min(1, aspect);
    const pose = {};
    let distance = vec3.length(offset);
    if (camera.projection === 'orthographic') {
      pose.orthoScale = roundValue(Math.max(0.25, Math.min(100, (radius * 2 * FRAME_MARGIN) / narrowSide)));
      distance = Math.max(distance, radius * 2);
    } else {
      const halfAngle = Math.atan(Math.tan((cameraFieldOfView(camera, aspect) * Math.PI) / 360) * narrowSide);
      distance = (radius * FRAME_MARGIN) / Math.sin(halfAngle);
    }
    distance = Math.max(MINIMUM_DISTANCE, Math.min(MAXIMUM_DISTANCE, distance));
    pose.target = roundVector(target);
    pose.eye = roundVector([target[0] + direction[0] * distance, target[1] + direction[1] * distance, target[2] + direction[2] * distance]);
    return pose;
  }

  function frameSelection() {
    return moveViewportCamera(frameSelectionPose());
  }

  // Moves the viewport camera without an undo step, as an orbit does. A flight to a framed object calls it once a frame.
  function moveViewportCamera(patch) {
    return moveView(patch);
  }

  function listBookmarks() {
    return structuredClone(currentScene.exportRecipe().timeline?.shots ?? []);
  }

  function saveBookmark(name) {
    if (typeof name !== 'string' || !SHOT_NAME_PATTERN.test(name)) {
      throw new RangeError('Bookmark name must be 1 to 24 letters, digits, - or _.');
    }
    const recipe = currentScene.exportRecipe();
    const existingShots = recipe.timeline?.shots ?? [];
    const shot = buildTimelineShot(name, viewCamera(), recipe);
    const nextShots = existingShots.some(candidate => candidate.name === name)
      ? existingShots.map(candidate => (candidate.name === name ? shot : candidate))
      : [...existingShots, shot];
    applySceneOperations([{ type: 'set-timeline', timeline: { shots: nextShots } }]);
    notify({ kind: 'bookmark', name });
    return structuredClone(shot);
  }

  function applyBookmark(name) {
    const recipe = currentScene.exportRecipe();
    const shot = recipe.timeline?.shots?.find(candidate => candidate.name === name);
    if (!shot) {
      throw new RangeError(`Unknown camera bookmark "${String(name)}".`);
    }
    const camera = updateCamera(structuredClone(shot.camera ?? {}));
    return cameraIsDriven() ? moveView(shot.camera ?? {}) : camera;
  }

  function removeBookmark(name) {
    const recipe = currentScene.exportRecipe();
    const existingShots = recipe.timeline?.shots ?? [];
    if (!existingShots.some(candidate => candidate.name === name)) {
      throw new RangeError(`Unknown camera bookmark "${String(name)}".`);
    }
    const remaining = existingShots.filter(candidate => candidate.name !== name);
    applySceneOperations([{ type: 'set-timeline', timeline: remaining.length > 0 ? { shots: remaining } : null }]);
    notify({ kind: 'bookmark', removed: name });
    return remaining;
  }

  function setMotionTime(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
      throw new RangeError(`Motion time must be between 0 and 3600 seconds, got ${JSON.stringify(seconds)}.`);
    }
    const recipe = currentScene.exportRecipe();
    if (!hasAnimatedData(recipe)) {
      if (seconds === 0) {
        motionTime = 0;
        notify({ kind: 'motion' });
        return motionTime;
      }
      throw new RangeError('Add a keyframe or motion track before scrubbing timeline.');
    }
    motionTime = currentScene.sampleMotion(seconds);
    notify({ kind: 'motion' });
    return motionTime;
  }

  function insertNodeKeyframe(nodeId = selectedNodeId) {
    if (!nodeId) {
      throw new RangeError('Select a node before inserting a keyframe.');
    }
    const recipe = currentScene.exportRecipe();
    const node = recipe.nodes.find(candidate => candidate.id === nodeId);
    if (!node) {
      throw new RangeError(`Unknown node "${String(nodeId)}".`);
    }
    const duration = Math.max(4, recipe.motion?.duration ?? 4, motionTime);
    let tracks = recipe.motion?.tracks ?? [];
    tracks = upsertNodeKeyframeTrack(tracks, nodeId, 'translation', motionTime, node.translation ?? [0, 0, 0]);
    tracks = upsertNodeKeyframeTrack(tracks, nodeId, 'rotation', motionTime, node.rotation ?? [0, 0, 0, 1]);
    tracks = upsertNodeKeyframeTrack(tracks, nodeId, 'scale', motionTime, node.scale ?? [1, 1, 1]);
    const nextMotion = { ...(recipe.motion ?? {}), duration, loop: recipe.motion?.loop ?? true, tracks };
    applySceneOperations([{ type: 'set-motion', motion: nextMotion }]);
    if (motionTime > 0) {
      motionTime = currentScene.sampleMotion(motionTime);
    }
    notify({ kind: 'motion', nodeId });
    return nextMotion;
  }

  function undo() {
    if (undoStack.length === 0) {
      return false;
    }
    stepHistory(undoStack, redoStack);
    notify({ kind: 'undo' });
    return true;
  }

  function redo() {
    if (redoStack.length === 0) {
      return false;
    }
    stepHistory(redoStack, undoStack);
    notify({ kind: 'redo' });
    return true;
  }

  function loadRecipe(recipeInput, { recordUndo = true } = {}) {
    const before = recordUndo ? currentScene.exportRecipe() : null;
    endUndoGroup();
    freeViewPose = null;
    swapRecipe(recipeInput);
    if (before) {
      pushUndoSnapshot(before, { restoresCamera: true });
    }
    notify({ kind: 'load' });
    return currentScene.revision;
  }

  return Object.freeze({
    get scene() { return currentScene; },
    get viewCamera() { return viewCamera(); },
    get cameraDriven() { return cameraIsDriven(); },
    get freeView() { return Boolean(freeViewPose) && cameraIsDriven(); },
    lookThroughSceneCamera,
    get selectedNodeId() { return selectedNodeId; },
    get tool() { return activeTool; },
    get activeTab() { return activeTab; },
    get motionTime() { return motionTime; },
    get viewportWidth() { return width; },
    get viewportHeight() { return height; },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    setViewportSize(nextWidth, nextHeight) {
      width = assertPositiveFinite(nextWidth, 'viewportWidth');
      height = assertPositiveFinite(nextHeight, 'viewportHeight');
      notify({ kind: 'resize' });
    },
    get selectedObjectKey() { return selectedObjectKey; },
    selectNode,
    listSceneObjects,
    selectSceneObject,
    moveSceneObject,
    describeSceneObject,
    updateSceneLight,
    deleteSceneObject,
    setTool,
    setActiveTab,
    projectWorldPoint,
    screenRay,
    pickAt,
    gizmoHandles,
    rotationSweep,
    dragTrace,
    setInteractionSettings,
    get interactionSettings() { return { moveSnapStep, rotateSnapDegrees, gizmoPixels }; },
    selectionOutline,
    selectionSilhouette,
    selectionContour,
    nodeOutline,
    nodeBounds,
    beginGizmoDrag,
    updateGizmoDrag,
    endGizmoDrag,
    cancelGizmoDrag,
    axisFacingView,
    get dragging() { return Boolean(dragState); },
    snapSelectedToAt,
    updateNodeTransform,
    addPrimitive,
    addSceneLight,
    duplicateSelected,
    copySelected,
    pasteCopy,
    get canPaste() { return copiedNode !== null; },
    deleteSelected,
    updateMaterial,
    createMaterial,
    assignNodeMaterial,
    applyMaterialPreset,
    updateLook,
    updateSceneShadow,
    setSunAngles,
    orbitCamera,
    updateCamera,
    updateSceneCamera,
    setCameraViewPreset,
    toggleCameraProjection,
    setCameraLensMillimetres,
    frameSelection,
    frameSelectionPose,
    moveViewportCamera,
    listBookmarks,
    saveBookmark,
    applyBookmark,
    removeBookmark,
    setMotionTime,
    insertNodeKeyframe,
    beginUndoGroup,
    endUndoGroup,
    undo,
    redo,
    loadRecipe,
    exportRecipe() {
      return currentScene.exportRecipe();
    },
    dispose() {
      invalidateQuery();
    },
  });
}

export {
  STUDIO_MATERIAL_PRESETS,
  STUDIO_PRIMITIVE_GROUPS,
  STUDIO_PRIMITIVES,
  STUDIO_TABS,
  STUDIO_TEMPLATES,
  STUDIO_TOOLS,
  STUDIO_VIEW_PRESETS,
};
