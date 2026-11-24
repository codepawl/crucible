import { createMeshQueryIndex, withoutDegenerateTriangles } from '../src/mesh-query.js';

// Bakes a tangent-space normal map of a high-poly mesh onto a low-poly mesh, in the tangent basis glTF requires:
// the interpolated vertex normal N, the interpolated TANGENT xyz made perpendicular to N, and a bitangent of
// cross(N, T) * w, where w is the handedness of the TANGENT. The map is read with v running down the image, so texel
// row y sits at v = (y + 0.5) / resolution. The basis is written here from that definition and does not call the
// renderer's shader code, so the measurement against the renderer is not circular.
//
// Each texel casts a ray from `cage` above the low surface along its interpolated normal, against it, and takes the
// interpolated vertex normal of the first high triangle the ray meets. A texel the ray misses stays flat (0, 0, 1).
// The bake is deterministic: the same meshes and options give the same bytes.

const FLAT_NORMAL = Object.freeze([0, 0, 1]);
const DILATION_PASSES = 8;

const subtract = (left, right) => left.map((value, axis) => value - right[axis]);
const dot = (left, right) => left.reduce((total, value, axis) => total + value * right[axis], 0);
const cross = (left, right) => [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];

function normalized(vector) {
  const length = Math.hypot(...vector);
  return length === 0 ? null : vector.map(value => value / length);
}

function readVector(array, index, width) {
  return Array.from(array.subarray(index * width, index * width + width));
}

function mixed(array, width, corners, weights) {
  return [0, 1, 2].map(axis => corners.reduce((total, vertex, corner) => total + weights[corner] * array[vertex * width + axis], 0));
}

/** Weights of `point` in the triangle `first`, `second`, `third` (2D or 3D, the point on the triangle's plane). */
export function barycentricWeights(point, first, second, third) {
  const edgeOne = subtract(second, first);
  const edgeTwo = subtract(third, first);
  const toPoint = subtract(point, first);
  const oneOne = dot(edgeOne, edgeOne);
  const oneTwo = dot(edgeOne, edgeTwo);
  const twoTwo = dot(edgeTwo, edgeTwo);
  const pointOne = dot(toPoint, edgeOne);
  const pointTwo = dot(toPoint, edgeTwo);
  const denominator = oneOne * twoTwo - oneTwo * oneTwo;
  if (Math.abs(denominator) < 1e-30) return null;
  const secondWeight = (twoTwo * pointOne - oneTwo * pointTwo) / denominator;
  const thirdWeight = (oneOne * pointTwo - oneTwo * pointOne) / denominator;
  return [1 - secondWeight - thirdWeight, secondWeight, thirdWeight];
}

/** Area-weighted vertex normals of an indexed triangle mesh. */
export function smoothVertexNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let corner = 0; corner < indices.length; corner += 3) {
    const [first, second, third] = [indices[corner], indices[corner + 1], indices[corner + 2]];
    const faceNormal = cross(subtract(readVector(positions, second, 3), readVector(positions, first, 3)), subtract(readVector(positions, third, 3), readVector(positions, first, 3)));
    for (const vertex of [first, second, third]) for (let axis = 0; axis < 3; axis++) normals[vertex * 3 + axis] += faceNormal[axis];
  }
  for (let vertex = 0; vertex < normals.length / 3; vertex++) {
    const unit = normalized(readVector(normals, vertex, 3));
    if (unit) normals.set(unit, vertex * 3);
  }
  return normals;
}

/** The tangent frame of one texel of the low mesh, from the weights of its triangle corners. Null where the tangent is missing. */
export function texelFrame(low, corners, weights) {
  const normal = normalized(mixed(low.normals, 3, corners, weights));
  const rawTangent = mixed(low.tangents, 4, corners, weights);
  if (!normal || Math.hypot(...rawTangent) === 0) return null;
  const tangent = normalized(subtract(rawTangent, normal.map(value => value * dot(rawTangent, normal))));
  if (!tangent) return null;
  const strongest = corners[weights.indexOf(Math.max(...weights))];
  const handedness = low.tangents[strongest * 4 + 3] < 0 ? -1 : 1;
  const bitangent = cross(normal, tangent).map(value => value * handedness);
  return { normal, tangent, bitangent, position: mixed(low.positions, 3, corners, weights) };
}

function highNormalAt(high, index, frame, cage) {
  const origin = frame.position.map((value, axis) => value + frame.normal[axis] * cage);
  const hit = index.firstHit(origin, frame.normal.map(value => -value), cage * 2);
  if (!hit) return null;
  const point = origin.map((value, axis) => value - frame.normal[axis] * hit.distance);
  const corners = [high.indices[hit.triangle * 3], high.indices[hit.triangle * 3 + 1], high.indices[hit.triangle * 3 + 2]];
  const weights = barycentricWeights(point, ...corners.map(vertex => readVector(high.positions, vertex, 3)));
  if (!weights) return null;
  return normalized(mixed(high.normals, 3, corners, weights));
}

function dilate(pixels, covered, resolution) {
  for (let pass = 0; pass < DILATION_PASSES; pass++) {
    const additions = [];
    for (let row = 0; row < resolution; row++) {
      for (let column = 0; column < resolution; column++) {
        const texel = row * resolution + column;
        if (covered[texel]) continue;
        const neighbour = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]
          .map(([columnOffset, rowOffset]) => [column + columnOffset, row + rowOffset])
          .find(([neighbourColumn, neighbourRow]) => neighbourColumn >= 0 && neighbourColumn < resolution && neighbourRow >= 0 && neighbourRow < resolution && covered[neighbourRow * resolution + neighbourColumn]);
        if (neighbour) additions.push([texel, neighbour[1] * resolution + neighbour[0]]);
      }
    }
    for (const [texel, source] of additions) {
      pixels.copyWithin(texel * 4, source * 4, source * 4 + 4);
      covered[texel] = 1;
    }
  }
}

function encodeTexel(local) {
  return local.map(value => Math.round(Math.min(1, Math.max(0, value * 0.5 + 0.5)) * 255));
}

/**
 * `low` is { positions, normals, uvs, indices, tangents } with four tangent values per vertex (x, y, z, handedness);
 * `high` is { positions, normals, indices }. Returns { width, height, data } as RGBA bytes with row 0 at v = 0, and
 * how many texels were covered by a low triangle and how many of those found a high surface.
 * Options: resolution (default 512) and cage (distance above the low surface the rays start from).
 */
export function bakeTangentSpaceNormalMap(low, high, { resolution = 512, cage } = {}) {
  if (!Number.isInteger(resolution) || resolution < 1 || resolution > 4096) throw new RangeError(`resolution must be a whole number from 1 to 4096; got ${resolution}.`);
  if (low.tangents.length !== low.positions.length / 3 * 4) throw new RangeError('low.tangents needs four values per vertex; pass the result of generateTangents or the glTF TANGENT.');
  if (!(cage > 0)) throw new RangeError(`cage must be a positive distance in the mesh's units; got ${cage}.`);
  const clean = withoutDegenerateTriangles({ positions: high.positions, indices: high.indices });
  const highMesh = { positions: new Float32Array(clean.positions), normals: high.normals, indices: clean.indices };
  const index = createMeshQueryIndex({ positions: highMesh.positions, indices: highMesh.indices });
  const data = new Uint8ClampedArray(resolution * resolution * 4);
  const covered = new Uint8Array(resolution * resolution);
  for (let texel = 0; texel < resolution * resolution; texel++) data.set([128, 128, 255, 255], texel * 4);
  let coveredTexels = 0;
  let hitTexels = 0;
  try {
    for (let corner = 0; corner < low.indices.length; corner += 3) {
      const corners = [low.indices[corner], low.indices[corner + 1], low.indices[corner + 2]];
      const points = corners.map(vertex => readVector(low.uvs, vertex, 2).map(value => value * resolution));
      const firstColumn = Math.max(0, Math.floor(Math.min(...points.map(point => point[0]))));
      const lastColumn = Math.min(resolution - 1, Math.ceil(Math.max(...points.map(point => point[0]))));
      const firstRow = Math.max(0, Math.floor(Math.min(...points.map(point => point[1]))));
      const lastRow = Math.min(resolution - 1, Math.ceil(Math.max(...points.map(point => point[1]))));
      for (let row = firstRow; row <= lastRow; row++) {
        for (let column = firstColumn; column <= lastColumn; column++) {
          const texel = row * resolution + column;
          if (covered[texel]) continue;
          const weights = barycentricWeights([column + 0.5, row + 0.5], ...points);
          if (!weights || weights.some(weight => !(weight >= -1e-9))) continue;
          covered[texel] = 1;
          coveredTexels++;
          const frame = texelFrame(low, corners, weights);
          const highNormal = frame && highNormalAt(highMesh, index, frame, cage);
          if (highNormal) hitTexels++;
          const local = highNormal ? [dot(highNormal, frame.tangent), dot(highNormal, frame.bitangent), dot(highNormal, frame.normal)] : FLAT_NORMAL;
          data.set([...encodeTexel(local), 255], texel * 4);
        }
      }
    }
  } finally {
    index.dispose();
  }
  dilate(data, covered, resolution);
  return { width: resolution, height: resolution, data, coveredTexels, hitTexels };
}
