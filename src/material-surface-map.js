import { invalidField } from './field-error.js';
import { weldedMaskNormals } from './mesh-weld-normals.js';
import { rasterizeUvTriangles } from './material-vertex-group-map.js';

// The surface of one mesh drawn into UV space, so a material graph can read its slope or height at each texel with
// {"surface":{"output":"slope"}}. The normal and the position of every texel are the barycentric blend of the corner
// values (the face normal when the mesh has no normals), so a cube keeps hard edges and a sphere stays smooth. The normals
// are welded by position first (mesh-weld-normals.js), so a gentle crease where the mesh splits vertices does not
// show up in the mask as stair steps; shading keeps the split normals. The baked slope and normalY maps are then smoothed in texel space
// (smoothMaskTexels below), so a threshold on them does not follow the triangle edges.
//
//   slope    the angle between the normal and straight up, as a share of a right angle: 0 on a flat surface facing up,
//            1 on a vertical wall and on everything facing down (snow does not settle under an overhang).
//   normalY  the up component of the normal from -1 to 1 written as 0 to 1, 0.5 on a wall, for a custom threshold.
//   height   the up position from 0 at the bottom of the mesh to 1 at its top, or between `range` [low, high] metres.
//
// "Up" is +Y. In "object" space that is the mesh's own +Y. In "world" space the mesh is placed first with the world
// matrix of the part when the scene is built, so the map is baked, not live: moving or turning the part later does
// not change it until the scene is built again.

const RIGHT_ANGLE = Math.PI / 2;

function matrixKey(matrix) {
  return matrix ? Array.from(matrix).join(',') : 'identity';
}

// The inverse transpose of the upper 3 by 3 of a column-major matrix, as cofactors with the sign of the determinant so
// a mirrored part keeps its normals pointing out.
function normalMatrixOf(matrix) {
  const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]];
  const cofactors = [
    m11 * m22 - m12 * m21, m12 * m20 - m10 * m22, m10 * m21 - m11 * m20,
    m02 * m21 - m01 * m22, m00 * m22 - m02 * m20, m01 * m20 - m00 * m21,
    m01 * m12 - m02 * m11, m02 * m10 - m00 * m12, m00 * m11 - m01 * m10,
  ];
  const determinant = m00 * cofactors[0] + m01 * cofactors[1] + m02 * cofactors[2];
  const sign = determinant < 0 ? -1 : 1;
  return cofactors.map(value => value * sign);
}

function placedPositions(positions, matrix) {
  if (!matrix) return positions;
  const placed = new Float32Array(positions.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    for (let axis = 0; axis < 3; axis++) {
      placed[offset + axis] = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
    }
  }
  return placed;
}

function placedNormals(source, positions, normalMatrix) {
  const count = positions.length / 3;
  const normals = new Float32Array(count * 3);
  if (source) {
    for (let offset = 0; offset < normals.length; offset += 3) {
      for (let axis = 0; axis < 3; axis++) {
        normals[offset + axis] = normalMatrix
          ? normalMatrix[axis * 3] * source[offset] + normalMatrix[axis * 3 + 1] * source[offset + 1] + normalMatrix[axis * 3 + 2] * source[offset + 2]
          : source[offset + axis];
      }
    }
  }
  return normals;
}

function faceNormal(positions, corners) {
  const [first, second, third] = corners.map(corner => corner * 3);
  const edgeOne = [positions[second] - positions[first], positions[second + 1] - positions[first + 1], positions[second + 2] - positions[first + 2]];
  const edgeTwo = [positions[third] - positions[first], positions[third + 1] - positions[first + 1], positions[third + 2] - positions[first + 2]];
  return [
    edgeOne[1] * edgeTwo[2] - edgeOne[2] * edgeTwo[1],
    edgeOne[2] * edgeTwo[0] - edgeOne[0] * edgeTwo[2],
    edgeOne[0] * edgeTwo[1] - edgeOne[1] * edgeTwo[0],
  ];
}

// Whether the face of a triangle is steeper than STEEP_FACE_SLOPE (0 flat, 1 vertical), read against the way its vertex normals point.
function faceIsSteep(positions, normals, corners) {
  const face = faceNormal(positions, corners);
  const faceLength = Math.hypot(face[0], face[1], face[2]);
  if (faceLength === 0) return false;
  const first = corners[0] * 3;
  const outward = face[0] * normals[first] + face[1] * normals[first + 1] + face[2] * normals[first + 2] < 0 ? -1 : 1;
  const slope = Math.acos(Math.min(1, Math.max(-1, outward * face[1] / faceLength))) / RIGHT_ANGLE;
  return slope >= STEEP_FACE_SLOPE;
}

function heightBounds(positions, range) {
  if (range) return range;
  let low = Infinity;
  let high = -Infinity;
  for (let offset = 1; offset < positions.length; offset += 3) {
    low = Math.min(low, positions[offset]);
    high = Math.max(high, positions[offset]);
  }
  return [low, high];
}

function surfaceValue(output, upNormal, upPosition, bounds) {
  if (output === 'slope') return Math.acos(Math.min(1, Math.max(-1, upNormal))) / RIGHT_ANGLE;
  if (output === 'normalY') return 0.5 + 0.5 * upNormal;
  const span = bounds[1] - bounds[0];
  return span > 0 ? (upPosition - bounds[0]) / span : 0;
}

// Smoothing of a baked surface mask in texel space. A coarse terrain mesh gives a slope that is linear inside each
// triangle, so a threshold on it (a snow edge) bends at every triangle edge and the outline follows the triangles. After
// the bake every covered texel is replaced by a mean of its neighbours: three box passes along rows, then along columns,
// which together approximate a Gaussian whose reach is a few texels. A run of texels stops at a gap in the map and at a
// jump between two neighbours (a cliff top, a cube edge: a value the mesh means), so a hard edge stays hard. The mesh, its
// triangle count and its normals are not touched; the cost is a sliding sum per pass, the same for any reach, and the
// answer depends only on the map.

// Two neighbouring texels further apart than this (of 255) belong to a jump the mesh means: the blur does not cross it.
// A gentle terrain triangle changes by a few units per texel.
const JUMP_BETWEEN_TEXELS = 100;
// One box pass reaches this many texels each way at a 1024 map (three passes act like a Gaussian of about 4 texels), scaled with the map.
const BOX_RADIUS_AT_1024 = 4;
const BOX_PASSES = 3;
// The steep marks are only a ramp, so one pass of twice the reach does.
const STEEP_SHARE_PASSES = 1;
// The blurred steep marks reach their full share at one over this, so a steep texel near the border of its face is already held.
const STEEP_SHARE_GAIN = 5;

// A face steeper than this (0 flat, 1 vertical; 72 degrees) is never lightened by the smoothing: no snow stays on it, so the
// blur must not give it any.
const STEEP_FACE_SLOPE = 0.8;

// One box pass from source to target over [start, end): each value becomes the mean of the values within `radius`, cut at both ends of the run.
function boxPass(source, target, start, end, radius) {
  let windowStart = start;
  let windowEnd = Math.min(end, start + radius + 1);
  let sum = 0;
  for (let index = windowStart; index < windowEnd; index++) sum += source[index];
  for (let index = start; index < end; index++) {
    target[index] = sum / (windowEnd - windowStart);
    if (index + 1 + radius < end) {
      sum += source[windowEnd];
      windowEnd++;
    }
    if (index + 1 - radius > windowStart) {
      sum -= source[windowStart];
      windowStart++;
    }
  }
}

// Blurs the run [start, end) of `line` with `passes` box passes that alternate between `line` and `scratch`, and returns
// the one that holds the result.
function blurRun(line, scratch, start, end, radius, passes) {
  let source = line;
  let target = scratch;
  for (let pass = 0; pass < passes; pass++) {
    boxPass(source, target, start, end, radius);
    [source, target] = [target, source];
  }
  return source;
}

// Blurs every run of covered texels along one line of the map (a row with `step` 1, a column with `step` resolution).
function blurLine(texels, covered, line, scratch, first, step, length, radius, passes, jumpLimit) {
  let runStart = -1;
  let previous = 0;
  for (let position = 0; position <= length; position++) {
    const texel = first + position * step;
    const inside = position < length && covered[texel] === 1;
    const value = inside ? texels[texel] : 0;
    const jump = inside && runStart >= 0 && Math.abs(value - previous) > jumpLimit;
    if (runStart >= 0 && (!inside || jump)) {
      const result = blurRun(line, scratch, runStart, position, radius, passes);
      for (let index = runStart; index < position; index++) texels[first + index * step] = result[index];
      runStart = -1;
    }
    if (inside) {
      if (runStart < 0) runStart = position;
      line[position] = value;
      previous = value;
    }
  }
}

// Blurs a Float32Array map in place along rows, then columns, over its covered texels.
function blurMap(values, covered, resolution, radius, passes, jumpLimit) {
  const line = new Float32Array(resolution);
  const scratch = new Float32Array(resolution);
  for (let row = 0; row < resolution; row++) blurLine(values, covered, line, scratch, row * resolution, 1, resolution, radius, passes, jumpLimit);
  for (let column = 0; column < resolution; column++) blurLine(values, covered, line, scratch, column, resolution, resolution, radius, passes, jumpLimit);
}

/**
 * Blur the covered texels of a mask map in place (`texels` is a Uint8Array, one value per texel). `steepFaces` (optional,
 * one byte per texel) marks texels on a steep face. The marks are blurred too, into a share from 0 to 1 that grows
 * smoothly toward a steep face, and a texel keeps that share of the lightening it would lose, so a steep face keeps its
 * value and the texels around it fade from kept to blurred without a step at a triangle edge. Uncovered texels are
 * neither read nor written.
 */
export function smoothMaskTexels(texels, covered, resolution, steepFaces) {
  const radius = Math.max(1, Math.round(BOX_RADIUS_AT_1024 * Math.min(1, resolution / 1024)));
  const blurred = Float32Array.from(texels);
  blurMap(blurred, covered, resolution, radius, BOX_PASSES, JUMP_BETWEEN_TEXELS);
  let keptShare;
  if (steepFaces) {
    keptShare = Float32Array.from(steepFaces);
    blurMap(keptShare, covered, resolution, 2 * radius, STEEP_SHARE_PASSES, Infinity);
  }
  for (let texel = 0; texel < texels.length; texel++) {
    if (!covered[texel]) continue;
    const lost = keptShare ? Math.min(1, STEEP_SHARE_GAIN * keptShare[texel]) * Math.max(0, texels[texel] - blurred[texel]) : 0;
    texels[texel] = Math.round(blurred[texel] + lost);
  }
}

const mapsByGeometry = new WeakMap();

/**
 * One surface output of a render geometry as `{ width, height, data }` RGBA bytes with the value (0 to 255) in the red
 * channel. \`worldMatrix\` (16 numbers, column-major) places the mesh first when \`space\` is "world"; it is ignored in
 * "object" space. Cached per geometry, settings and matrix, so a part keeps the same map between rebuilds. Throws, with
 * what to pass instead, when the mesh has no UVs.
 */
export function surfaceMap(geometry, settings, resolution, nodeId, worldMatrix) {
  if (!geometry.uvs) {
    throw invalidField('surface', settings.output, `a mesh with UVs (node ${nodeId} has none); add UVs with a uv mesh edit`);
  }
  const matrix = settings.space === 'world' ? worldMatrix : undefined;
  let maps = mapsByGeometry.get(geometry);
  if (!maps) {
    maps = new Map();
    mapsByGeometry.set(geometry, maps);
  }
  const key = `${settings.output}|${settings.space}|${settings.range ? settings.range.join(',') : ''}|${resolution}|${matrixKey(matrix)}`;
  const remembered = maps.get(key);
  if (remembered) return remembered;
  const positions = placedPositions(geometry.positions, matrix);
  const normals = placedNormals(weldedMaskNormals(geometry), geometry.positions, matrix ? normalMatrixOf(matrix) : undefined);
  const bounds = settings.output === 'height' ? heightBounds(positions, settings.range) : undefined;
  const hasNormals = Boolean(geometry.normals);
  const map = rasterizeUvTriangles(geometry, resolution, positions.length / 3, (corners, weightA, weightB, weightC) => {
    let normalX;
    let normalY;
    let normalZ;
    let upPosition = 0;
    if (hasNormals) {
      const [first, second, third] = corners.map(corner => corner * 3);
      normalX = weightA * normals[first] + weightB * normals[second] + weightC * normals[third];
      normalY = weightA * normals[first + 1] + weightB * normals[second + 1] + weightC * normals[third + 1];
      normalZ = weightA * normals[first + 2] + weightB * normals[second + 2] + weightC * normals[third + 2];
    } else {
      [normalX, normalY, normalZ] = faceNormal(positions, corners);
    }
    const length = Math.hypot(normalX, normalY, normalZ);
    const upNormal = length > 0 ? normalY / length : 0;
    if (bounds) upPosition = weightA * positions[corners[0] * 3 + 1] + weightB * positions[corners[1] * 3 + 1] + weightC * positions[corners[2] * 3 + 1];
    return surfaceValue(settings.output, upNormal, upPosition, bounds);
  }, settings.output === 'height' ? undefined : { flagOfTriangle: corners => (hasNormals && faceIsSteep(positions, normals, corners) ? 1 : 0), afterFill: smoothMaskTexels });
  maps.set(key, map);
  return map;
}
