// Vertex tangents for a normal map, for a glTF primitive that has none. Loaded on demand: a file whose normal-mapped
// primitives all carry TANGENT, or that has no normal map, never imports this module.
//
// The method is the one MikkTSpace uses on a mesh whose vertices are already split at UV seams (every glTF is): a unit
// tangent per triangle, weighted at each corner by the angle of the triangle there, summed per vertex, made perpendicular
// to the vertex normal, with the handedness read from the summed bitangent. Output is glTF's: xyz is the tangent and w
// the sign that makes cross(normal, tangent) * w point up the normal map image (against the glTF v axis, which runs down it).
//
// The work is spread over plain numbers and typed arrays: this runs over every triangle of a scan, and an array per corner and
// per vector, built and dropped, was most of the six seconds it cost on a scene of two million triangles (issue #2842). The
// arithmetic is the same operations in the same order as the version written with vectors, so the bytes it makes are the same.

// Writes the unit direction of (x, y, z) to `target`, or returns false when it has no length. Math.hypot, not a square root,
// so the length rounds the way it always did.
function writeNormalized(target, x, y, z) {
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) return false;
  target[0] = x / length;
  target[1] = y / length;
  target[2] = z / length;
  return true;
}

const unitFirst = new Float64Array(3);
const unitSecond = new Float64Array(3);

// The angle at the corner of `points` at offset `corner`, between its edges to the corners at offsets `next` and `previous`.
function cornerAngle(points, corner, next, previous) {
  const x = points[corner];
  const y = points[corner + 1];
  const z = points[corner + 2];
  if (!writeNormalized(unitFirst, points[next] - x, points[next + 1] - y, points[next + 2] - z)) return 0;
  if (!writeNormalized(unitSecond, points[previous] - x, points[previous + 1] - y, points[previous + 2] - z)) return 0;
  const cosine = unitFirst[0] * unitSecond[0] + unitFirst[1] * unitSecond[1] + unitFirst[2] * unitSecond[2];
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

// The unit directions of increasing u and of image-up of the triangle read last, left here by writeTriangleDirections.
const triangleTangent = new Float64Array(3);
const triangleImageUp = new Float64Array(3);
const alongU = new Float64Array(3);
const alongV = new Float64Array(3);

// The three corners (x, y, z each) and their UVs (u, v each) of the triangle read last.
const trianglePoints = new Float64Array(9);
const triangleCoordinates = new Float64Array(6);

function readTriangle(positions, uvs, indices, triangle) {
  for (let corner = 0; corner < 3; corner++) {
    const vertex = indices[triangle + corner];
    trianglePoints[corner * 3] = positions[vertex * 3];
    trianglePoints[corner * 3 + 1] = positions[vertex * 3 + 1];
    trianglePoints[corner * 3 + 2] = positions[vertex * 3 + 2];
    triangleCoordinates[corner * 2] = uvs[vertex * 2];
    triangleCoordinates[corner * 2 + 1] = uvs[vertex * 2 + 1];
  }
}

// Fills triangleTangent and triangleImageUp for the triangle read last, or returns false when its UVs have no area.
function writeTriangleDirections() {
  const deltaUFirst = triangleCoordinates[2] - triangleCoordinates[0];
  const deltaVFirst = triangleCoordinates[3] - triangleCoordinates[1];
  const deltaUSecond = triangleCoordinates[4] - triangleCoordinates[0];
  const deltaVSecond = triangleCoordinates[5] - triangleCoordinates[1];
  const determinant = deltaUFirst * deltaVSecond - deltaUSecond * deltaVFirst;
  if (Math.abs(determinant) < 1e-20) return false;
  for (let axis = 0; axis < 3; axis++) {
    const firstEdge = trianglePoints[3 + axis] - trianglePoints[axis];
    const secondEdge = trianglePoints[6 + axis] - trianglePoints[axis];
    alongU[axis] = (firstEdge * deltaVSecond - secondEdge * deltaVFirst) / determinant;
    alongV[axis] = (secondEdge * deltaUFirst - firstEdge * deltaUSecond) / determinant;
  }
  if (!writeNormalized(triangleTangent, alongU[0], alongU[1], alongU[2])) return false;
  if (!writeNormalized(triangleImageUp, alongV[0], alongV[1], alongV[2])) return false;
  for (let axis = 0; axis < 3; axis++) triangleImageUp[axis] = -triangleImageUp[axis];
  return true;
}

// Adds the triangle read last to the sums of its three vertices, weighted by its angle at each.
function addTriangleToSums(indices, triangle, tangentSums, bitangentSums) {
  for (let corner = 0; corner < 3; corner++) {
    const weight = cornerAngle(trianglePoints, corner * 3, ((corner + 1) % 3) * 3, ((corner + 2) % 3) * 3);
    const vertex = indices[triangle + corner];
    for (let axis = 0; axis < 3; axis++) {
      tangentSums[vertex * 3 + axis] += triangleTangent[axis] * weight;
      bitangentSums[vertex * 3 + axis] += triangleImageUp[axis] * weight;
    }
  }
}

const vertexNormal = new Float64Array(3);
const vertexPerpendicular = new Float64Array(3);

// The tangent of one vertex: its summed direction made perpendicular to its normal, with the handedness of its summed bitangent.
// A vertex with no normal or no direction keeps its zeros.
function writeVertexTangent(tangents, vertex, normals, tangentSums, bitangentSums) {
  if (!writeNormalized(vertexNormal, normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2])) return;
  const sumX = tangentSums[vertex * 3];
  const sumY = tangentSums[vertex * 3 + 1];
  const sumZ = tangentSums[vertex * 3 + 2];
  const alongNormal = sumX * vertexNormal[0] + sumY * vertexNormal[1] + sumZ * vertexNormal[2];
  const rejectedX = sumX - vertexNormal[0] * alongNormal;
  const rejectedY = sumY - vertexNormal[1] * alongNormal;
  const rejectedZ = sumZ - vertexNormal[2] * alongNormal;
  if (!writeNormalized(vertexPerpendicular, rejectedX, rejectedY, rejectedZ)) return;
  tangents[vertex * 4] = vertexPerpendicular[0];
  tangents[vertex * 4 + 1] = vertexPerpendicular[1];
  tangents[vertex * 4 + 2] = vertexPerpendicular[2];
  const crossX = vertexNormal[1] * vertexPerpendicular[2] - vertexNormal[2] * vertexPerpendicular[1];
  const crossY = vertexNormal[2] * vertexPerpendicular[0] - vertexNormal[0] * vertexPerpendicular[2];
  const crossZ = vertexNormal[0] * vertexPerpendicular[1] - vertexNormal[1] * vertexPerpendicular[0];
  const alongBitangent = crossX * bitangentSums[vertex * 3] + crossY * bitangentSums[vertex * 3 + 1] + crossZ * bitangentSums[vertex * 3 + 2];
  tangents[vertex * 4 + 3] = alongBitangent < 0 ? -1 : 1;
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
    readTriangle(positions, uvs, indices, triangle);
    if (!writeTriangleDirections()) continue;
    addTriangleToSums(indices, triangle, tangentSums, bitangentSums);
  }
  const tangents = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) writeVertexTangent(tangents, vertex, normals, tangentSums, bitangentSums);
  return tangents;
}

/** True when `tangents` holds four finite values per vertex and a handedness of 1 or -1 wherever a direction exists. */
export function authoredTangentsUsable(tangents, vertexCount) {
  if (tangents.length !== vertexCount * 4) return false;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const x = tangents[vertex * 4];
    const y = tangents[vertex * 4 + 1];
    const z = tangents[vertex * 4 + 2];
    const handedness = tangents[vertex * 4 + 3];
    if (![x, y, z, handedness].every(Number.isFinite)) return false;
    if (Math.abs(handedness) !== 1 && (x || y || z)) return false;
  }
  return true;
}

/** True when baking this UV transform leaves the u and v directions where they were, so authored tangents still fit. */
export function transformKeepsTangents(transform) {
  return transform.rotation === 0 && transform.scale[0] > 0 && transform.scale[1] > 0;
}
