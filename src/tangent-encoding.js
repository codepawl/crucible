// A vertex tangent (xyz, with handedness w of 1 or -1, as glTF stores it) travels to the vertex shader in the fourth float of the
// normal attribute, so it costs no attribute slot (slot 9 stays free on Safari, see #2042). The tangent is perpendicular to the
// normal, so one angle around the normal describes it: the code is the angle plus an offset that keeps its size above
// TANGENT_CODE_MINIMUM, signed by the handedness. A geometry without tangents leaves the fourth float at the attribute default
// of 1, which is below the minimum and selects the screen-derivative frame in the shader.

export const TANGENT_CODE_MINIMUM = 1.5;
const TANGENT_CODE_OFFSET = 2 + Math.PI;

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function crossProduct(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

/** The two unit vectors the shader and the encoder both measure the tangent angle from. `normal` must be a unit vector. */
export function tangentReferenceAxes(normal) {
  const helper = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const first = crossProduct(helper, normal);
  const firstLength = Math.hypot(...first);
  const unitFirst = first.map(value => value / firstLength);
  return [unitFirst, crossProduct(normal, unitFirst)];
}

/** The code for one vertex, or 0 (no tangent) when the normal or the tangent has no usable direction. */
export function encodeTangentCode(normal, tangent, handedness) {
  const normalLength = Math.hypot(...normal);
  if (!(normalLength > 1e-8) || !tangent.every(Number.isFinite)) return 0;
  const unitNormal = normal.map(value => value / normalLength);
  const [first, second] = tangentReferenceAxes(unitNormal);
  const alongFirst = dot(tangent, first);
  const alongSecond = dot(tangent, second);
  if (Math.hypot(alongFirst, alongSecond) < 1e-8) return 0;
  const angle = Math.atan2(alongSecond, alongFirst);
  return (angle + TANGENT_CODE_OFFSET) * (handedness < 0 ? -1 : 1);
}

/** The tangent frame a code describes, `{ tangent, handedness }`, or null for a vertex without one. Mirrors the vertex shader. */
export function decodeTangentCode(normal, code) {
  if (Math.abs(code) <= TANGENT_CODE_MINIMUM) return null;
  const [first, second] = tangentReferenceAxes(normal);
  const angle = Math.abs(code) - TANGENT_CODE_OFFSET;
  const tangent = first.map((value, axis) => Math.cos(angle) * value + Math.sin(angle) * second[axis]);
  return { tangent, handedness: code < 0 ? -1 : 1 };
}

/** Four floats per vertex, the normal and its tangent code: the normal attribute of a geometry that has `tangents` (four floats per vertex). */
export function packNormalsWithTangents(normals, tangents) {
  const vertexCount = normals.length / 3;
  const packed = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const normal = [normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]];
    const tangent = [tangents[vertex * 4], tangents[vertex * 4 + 1], tangents[vertex * 4 + 2]];
    packed.set(normal, vertex * 4);
    packed[vertex * 4 + 3] = encodeTangentCode(normal, tangent, tangents[vertex * 4 + 3]);
  }
  return packed;
}

/** Throws with what to pass when `tangents` is not four floats for each of the `vertexCount` vertices. */
export function validateGeometryTangents(tangents, vertexCount) {
  if (!(tangents instanceof Float32Array) || tangents.length !== vertexCount * 4) {
    throw new TypeError(`Geometry tangents must be a Float32Array of four values (x, y, z, handedness) for each of the ${vertexCount} vertices.`);
  }
}
