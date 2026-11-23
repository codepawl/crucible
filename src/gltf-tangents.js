// Vertex tangents for a normal map, for a glTF primitive that has none. Loaded on demand: a file whose normal-mapped
// primitives all carry TANGENT, or that has no normal map, never imports this module.
//
// The method is the one MikkTSpace uses on a mesh whose vertices are already split at UV seams (every glTF is): a unit
// tangent per triangle, weighted at each corner by the angle of the triangle there, summed per vertex, made perpendicular
// to the vertex normal, with the handedness read from the summed bitangent. Output is glTF's: xyz is the tangent and w
// the sign that makes cross(normal, tangent) * w point up the normal map image (against the glTF v axis, which runs down it).

function subtract(left, right) {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function crossProduct(left, right) {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}

function normalized(vector) {
  const length = Math.hypot(...vector);
  return length > 0 ? vector.map(value => value / length) : null;
}

function readVector(values, vertex, width) {
  return Array.from(values.subarray(vertex * width, vertex * width + width));
}

/** The angle at one corner of a triangle, between its two edges. */
function cornerAngle(points, corner) {
  const toNext = normalized(subtract(points[(corner + 1) % 3], points[corner]));
  const toPrevious = normalized(subtract(points[(corner + 2) % 3], points[corner]));
  if (!toNext || !toPrevious) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot(toNext, toPrevious))));
}

/** The unit directions of increasing u and of image-up for one triangle, or null when its UVs have no area. */
function triangleDirections(points, coordinates) {
  const firstEdge = subtract(points[1], points[0]);
  const secondEdge = subtract(points[2], points[0]);
  const deltaUFirst = coordinates[1][0] - coordinates[0][0];
  const deltaVFirst = coordinates[1][1] - coordinates[0][1];
  const deltaUSecond = coordinates[2][0] - coordinates[0][0];
  const deltaVSecond = coordinates[2][1] - coordinates[0][1];
  const determinant = deltaUFirst * deltaVSecond - deltaUSecond * deltaVFirst;
  if (Math.abs(determinant) < 1e-20) return null;
  const alongU = [0, 1, 2].map(axis => (firstEdge[axis] * deltaVSecond - secondEdge[axis] * deltaVFirst) / determinant);
  const alongV = [0, 1, 2].map(axis => (secondEdge[axis] * deltaUFirst - firstEdge[axis] * deltaUSecond) / determinant);
  const tangent = normalized(alongU);
  const alongVUnit = normalized(alongV);
  if (!tangent || !alongVUnit) return null;
  return { tangent, imageUp: alongVUnit.map(value => -value) };
}

/**
 * Tangents for every vertex of an indexed triangle mesh: a Float32Array of four values per vertex (x, y, z, handedness).
 * `uvs` is the set the normal map samples. A vertex that no triangle with UV area touches gets four zeros, which the
 * renderer reads as "no tangent" and shades with screen derivatives instead.
 */
export function generateTangents(positions, normals, uvs, indices) {
  const vertexCount = positions.length / 3;
  const tangentSums = new Float64Array(vertexCount * 3);
  const bitangentSums = new Float64Array(vertexCount * 3);
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const corners = [indices[triangle], indices[triangle + 1], indices[triangle + 2]];
    const points = corners.map(vertex => readVector(positions, vertex, 3));
    const directions = triangleDirections(points, corners.map(vertex => readVector(uvs, vertex, 2)));
    if (!directions) continue;
    corners.forEach((vertex, corner) => {
      const weight = cornerAngle(points, corner);
      for (let axis = 0; axis < 3; axis++) {
        tangentSums[vertex * 3 + axis] += directions.tangent[axis] * weight;
        bitangentSums[vertex * 3 + axis] += directions.imageUp[axis] * weight;
      }
    });
  }
  const tangents = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const normal = normalized(readVector(normals, vertex, 3));
    if (!normal) continue;
    const sum = Array.from(tangentSums.subarray(vertex * 3, vertex * 3 + 3));
    const perpendicular = normalized(subtract(sum, normal.map(value => value * dot(sum, normal))));
    if (!perpendicular) continue;
    const bitangentSum = Array.from(bitangentSums.subarray(vertex * 3, vertex * 3 + 3));
    tangents.set(perpendicular, vertex * 4);
    tangents[vertex * 4 + 3] = dot(crossProduct(normal, perpendicular), bitangentSum) < 0 ? -1 : 1;
  }
  return tangents;
}

/** True when `tangents` holds four finite values per vertex and a handedness of 1 or -1 wherever a direction exists. */
export function authoredTangentsUsable(tangents, vertexCount) {
  if (tangents.length !== vertexCount * 4) return false;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const [x, y, z, handedness] = readVector(tangents, vertex, 4);
    if (![x, y, z, handedness].every(Number.isFinite)) return false;
    if (Math.abs(handedness) !== 1 && (x || y || z)) return false;
  }
  return true;
}

/** True when baking this UV transform leaves the u and v directions where they were, so authored tangents still fit. */
export function transformKeepsTangents(transform) {
  return transform.rotation === 0 && transform.scale[0] > 0 && transform.scale[1] > 0;
}
