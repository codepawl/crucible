const MAXIMUM_SHOWN_CHARACTERS = 40;

// A short, safe rendering of a rejected value for an error message: JSON for plain data, cut to a fixed length.
export function describeReceived(value) {
  let text;
  if (value === undefined) {
    text = 'undefined';
  } else if (typeof value === 'number' || typeof value === 'bigint') {
    text = String(value);
  } else if (typeof value === 'function' || typeof value === 'symbol') {
    text = typeof value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = Object.prototype.toString.call(value);
    }
  }
  return text.length > MAXIMUM_SHOWN_CHARACTERS ? `${text.slice(0, MAXIMUM_SHOWN_CHARACTERS - 3)}...` : text;
}

// Builds the validation error an agent-facing check throws: the field path, the value received and what is accepted,
// with an example or a range. withFieldPrefix turns the path into a full recipe path for entries of a list.
export function invalidField(path, value, expected, ErrorType = RangeError) {
  if (/^one of\s*$/.test(expected)) {
    expected = 'an ID that exists, but none is defined yet; add one first';
  }
  const error = new ErrorType(`${path}: got ${describeReceived(value)}; expected ${expected}.`);
  error.fieldPath = path;
  return error;
}

// Runs a check on one entry of a list and puts the list position in front of the field path of any field error it
// raises, so "emissiveColor: ..." becomes "materials[2].emissiveColor: ...".
export function withFieldPrefix(prefix, check) {
  try {
    return check();
  } catch (error) {
    if (typeof error?.fieldPath === 'string' && error.message.startsWith(error.fieldPath)) {
      error.message = `${prefix}.${error.message}`;
      error.fieldPath = `${prefix}.${error.fieldPath}`;
    }
    throw error;
  }
}

const THREE_SLIP_RULES = [
  [['isMaterial', 'isMeshStandardMaterial', 'isMeshPhysicalMaterial', 'isMeshBasicMaterial', 'isMeshLambertMaterial', 'isMeshPhongMaterial', 'isShaderMaterial'],
    'a material { tag: "surface", color: [r, g, b], metallic, roughness } (or emission for unlit); see packages/three-compat or crucible/addons/three-bridge'],
  [['isBufferGeometry', 'isGeometry'],
    'box(), sphere(), cylinder(), torus() or { positions, normals, indices }; see packages/three-compat or crucible/addons/three-bridge'],
  [['isCamera', 'isPerspectiveCamera', 'isOrthographicCamera'],
    'a camera frame { eye, target, up, fov, near, far } (or projection: "orthographic", orthographicHeight); see packages/three-compat'],
  [['isLight', 'isDirectionalLight', 'isPointLight', 'isSpotLight', 'isAmbientLight', 'isHemisphereLight', 'isRectAreaLight'],
    'lights on environment ({ lightDirection, keyIntensity, pointLights, spotLights, areaLights, ambientIntensity }); see packages/three-compat'],
  [['isScene', 'isGroup', 'isMesh', 'isObject3D'],
    'parts [{ name, geometry, matrix, material }], createSceneGraph(definitions) or a JSON recipe; see packages/three-compat or fromThreeObject in crucible/addons/three-bridge'],
  [['isTexture'], 'a texture { image, colorSpace } (or catalog map in a recipe)'],
  [['isColor'], 'linear [r, g, b] numbers from 0 to 1'],
  [['isVector3'], 'a [x, y, z] array'],
  [['isMatrix4'], 'a 16-number column-major matrix (pass matrix.elements)'],
  [['isEuler'], 'a 16-number matrix or unit quaternion [x, y, z, w]'],
  [['isQuaternion'], 'a unit quaternion [x, y, z, w]'],
];

/** Returns an error message naming the Crucible equivalent if `value` carries a three.js `is*` flag, else null. */
export function threeSlipMessage(value) {
  if (!value || typeof value !== 'object') return null;
  for (const [flags, replacement] of THREE_SLIP_RULES) {
    const matched = flags.find(flag => value[flag] === true);
    if (!matched) continue;
    const typeName = value.constructor?.name;
    const name = typeName && typeName !== 'Object' ? `THREE.${typeName}` : matched.slice(2);
    return `Got a three.js ${name} object; Crucible takes ${replacement}.`;
  }
  return null;
}

/** Throws a TypeError naming the Crucible equivalent when a three.js object is passed directly to a core API. */
export function rejectThreeObject(value, context = '') {
  const detail = threeSlipMessage(value);
  if (!detail) return;
  throw new TypeError(context ? `${context}: ${detail}` : detail);
}
