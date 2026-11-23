// The camera and the punctual lights of a scene as glTF nodes. The lights are the reverse of readPunctualLights in
// gltf-lights.js: a light shines along its node's -Z axis, point and spot lights keep their intensity in candela, and a
// spot's penumbra is the share of the outer angle the fade covers.
import { quat } from 'gl-matrix';

const LIGHT_EXTENSION = 'KHR_lights_punctual';
// readPunctualLights skips a spot whose inner angle is not below its outer angle, so a hard edge keeps a sliver of fade.
const MINIMUM_PENUMBRA = 1e-6;

function requireFiniteList(values, length, label) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) throw new TypeError(`GLB export ${label} must be ${length} numbers, such as [0, 1, 2].`);
  if (values.length !== length || !Array.from(values).every(Number.isFinite)) {
    throw new RangeError(`GLB export ${label} must be ${length} finite numbers, got ${JSON.stringify(Array.from(values))}.`);
  }
  return Array.from(values);
}

function normalized(vector, label) {
  const length = Math.hypot(...vector);
  if (!(length > 0)) throw new RangeError(`GLB export ${label} cannot be a zero vector. Give it a direction such as [0, -1, 0].`);
  return vector.map(value => value / length);
}

/** A column-major node matrix whose -Z axis looks from `eye` toward `target`, with `up` as the up hint (a roll is already in it). */
function lookAtNodeMatrix(eye, target, up) {
  const backward = normalized(eye.map((value, axis) => value - target[axis]), 'camera eye and target (they are the same point)');
  const upHint = normalized(up, 'camera up');
  const right = normalized([
    upHint[1] * backward[2] - upHint[2] * backward[1],
    upHint[2] * backward[0] - upHint[0] * backward[2],
    upHint[0] * backward[1] - upHint[1] * backward[0],
  ], 'camera up (it points along the view direction)');
  const above = [
    backward[1] * right[2] - backward[2] * right[1],
    backward[2] * right[0] - backward[0] * right[2],
    backward[0] * right[1] - backward[1] * right[0],
  ];
  return [...right, 0, ...above, 0, ...backward, 0, ...eye, 1];
}

/**
 * Writes `{ eye, target, up, fov (degrees, vertical), near, far }` as a perspective camera on its own root node.
 * Returns the node index.
 */
export function writeCamera(writer, camera) {
  const { document } = writer;
  const eye = requireFiniteList(camera.eye, 3, 'camera eye');
  const target = requireFiniteList(camera.target, 3, 'camera target');
  const up = requireFiniteList(camera.up ?? [0, 1, 0], 3, 'camera up');
  const { fov, near = 0.1, far = 1000 } = camera;
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) throw new RangeError(`GLB export camera fov must be a vertical angle in degrees between 0 and 180, got ${fov}.`);
  if (!Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near) {
    throw new RangeError(`GLB export camera needs finite near above 0 and far above near, got near ${near} and far ${far}.`);
  }
  document.cameras = [{ type: 'perspective', name: 'camera', perspective: { yfov: fov * Math.PI / 180, znear: near, zfar: far } }];
  document.nodes.push({ name: 'camera', camera: 0, matrix: lookAtNodeMatrix(eye, target, up) });
  return document.nodes.length - 1;
}

function colorAndIntensity(light, label) {
  const color = requireFiniteList(light.color ?? [1, 1, 1], 3, `${label} color`);
  const intensity = light.intensity ?? 1;
  if (!Number.isFinite(intensity) || intensity < 0 || color.some(value => value < 0 || value > 1)) {
    throw new RangeError(`GLB export ${label} needs a color of 0 to 1 per channel and a finite intensity of 0 or more. Put brightness above 1 in the intensity.`);
  }
  return { color, intensity };
}

function lightDefinition(light, type, label) {
  const { color, intensity } = colorAndIntensity(light, label);
  const definition = { name: label, type, color, intensity };
  if (Number.isFinite(light.range) && light.range > 0) definition.range = light.range;
  return definition;
}

function spotRotation(direction, label) {
  const towardLight = normalized(requireFiniteList(direction, 3, `${label} direction`), `${label} direction`).map(value => -value);
  return Array.from(quat.rotationTo(quat.create(), [0, 0, 1], towardLight));
}

function lightNode(definitionIndex, label, position, rotation) {
  const node = { name: label, translation: requireFiniteList(position, 3, `${label} position`), extensions: { [LIGHT_EXTENSION]: { light: definitionIndex } } };
  if (rotation) node.rotation = rotation;
  return node;
}

/**
 * Writes the point and spot lights (`{ position, color, intensity, range }`, and for a spot `direction`, `angle` and
 * `penumbra`) as KHR_lights_punctual lights on root nodes. Returns the node indexes.
 */
export function writeLights(writer, { pointLights = [], spotLights = [] }) {
  const { document } = writer;
  const definitions = [];
  const nodes = [];
  pointLights.forEach((light, index) => {
    const label = `point light ${index}`;
    definitions.push(lightDefinition(light, 'point', label));
    nodes.push(lightNode(definitions.length - 1, label, light.position));
  });
  spotLights.forEach((light, index) => {
    const label = `spot light ${index}`;
    const outer = light.angle;
    if (!Number.isFinite(outer) || outer <= 0 || outer > Math.PI / 2) throw new RangeError(`GLB export ${label} angle must be radians above 0 and at most ${Math.PI / 2}, got ${outer}.`);
    const penumbra = Math.min(1, Math.max(light.penumbra ?? 0, MINIMUM_PENUMBRA));
    definitions.push({ ...lightDefinition(light, 'spot', label), spot: { innerConeAngle: outer * (1 - penumbra), outerConeAngle: outer } });
    nodes.push(lightNode(definitions.length - 1, label, light.position, spotRotation(light.direction, label)));
  });
  if (!definitions.length) return [];
  writer.addExtension(LIGHT_EXTENSION);
  document.extensions = { ...document.extensions, [LIGHT_EXTENSION]: { lights: definitions } };
  const firstIndex = document.nodes.length;
  document.nodes.push(...nodes);
  return nodes.map((_, offset) => firstIndex + offset);
}

