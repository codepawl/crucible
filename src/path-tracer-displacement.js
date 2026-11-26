import { HEIGHT_PARALLAX_DEFAULTS, HEIGHT_PARALLAX_LIMITS } from './texture-set-fields.js';

// Path tracer geometric displacement from material.heightMap (#2839).
// Matches the rasterizer's normalized height semantics: texel 1 is the undisplaced surface, texel 0 lies
// heightScale metres below it along the smooth/welded normal, and displacement attenuates from 0.5 * heightFade
// to heightFade metres from the camera eye when provided.

export const MAX_DISPLACEMENT_SUBDIVISIONS = 7;
export const MAX_DISPLACED_TRIANGLES_PER_PART = 65_536;

const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const STANDARD_TAGS = new Set([undefined, 'surface', 'gltf']);
const POSITION_WELD_GRID = 1e5;
const NORMAL_GROUP_GRID = 1e4;
// Exclude only near-opposite back-to-back normals (over ~162 degrees) when welding, so 90-degree corners
// weld cleanly without cracks while double-sided cards do not cancel to zero.
const OPPOSITE_NORMAL_COSINE = -0.95;

function describePart(part, index) {
  return typeof part?.name === 'string' && part.name ? `part "${part.name}"` : `part ${index}`;
}

export function validateCameraEye(eye) {
  if (eye === undefined || eye === null) return null;
  const isTriple = (Array.isArray(eye) || ArrayBuffer.isView(eye)) && eye.length === 3;
  if (!isTriple || !Number.isFinite(eye[0]) || !Number.isFinite(eye[1]) || !Number.isFinite(eye[2])) {
    throw new TypeError(`buildTraceScene option eye must be three finite numbers [x, y, z], got ${JSON.stringify(eye)}. Leave it out for distance-independent displacement.`);
  }
  return [eye[0], eye[1], eye[2]];
}

export function validateDisplacementMaterial(material, label = 'Material') {
  if (!material) return;
  const { scale, fade } = HEIGHT_PARALLAX_LIMITS;
  if (material.heightScale !== undefined) {
    const depth = material.heightScale;
    if (typeof depth !== 'number' || !Number.isFinite(depth) || depth < scale[0] || depth > scale[1]) {
      throw new RangeError(`${label} heightScale must be a finite number from ${scale[0]} to ${scale[1]} metres, got ${JSON.stringify(depth)}.`);
    }
  }
  if (material.heightFade !== undefined && material.heightScale > 0) {
    const fadeDistance = material.heightFade;
    if (typeof fadeDistance !== 'number' || !Number.isFinite(fadeDistance) || fadeDistance < fade[0] || fadeDistance > fade[1]) {
      throw new RangeError(`${label} heightFade must be a finite number from ${fade[0]} to ${fade[1]} metres, got ${JSON.stringify(fadeDistance)}.`);
    }
  }
}

export function heightMapIgnoredNote(part) {
  const material = part?.material ?? {};
  if (!material.heightMap) return null;
  if (!(material.heightScale > 0) || !STANDARD_TAGS.has(material.tag)) return 'heightMap is ignored.';
  const image = material.heightMap.image;
  if (!image?.width || !image?.height || (!image.data && (image.compressed || typeof image !== 'object'))) {
    return 'heightMap is ignored.';
  }
  return null;
}

function wrapTexelIndex(index, size, mode) {
  if (mode === 1) return Math.max(0, Math.min(size - 1, index));
  if (mode === 2) {
    const folded = ((index % (2 * size)) + 2 * size) % (2 * size);
    return folded < size ? folded : 2 * size - 1 - folded;
  }
  return ((index % size) + size) % size;
}

export function sampleHeightTexel(texture, u, v) {
  const { width, height, data } = texture;
  const wrapU = texture.wrapU ?? (texture.repeat ? 0 : 1);
  const wrapV = texture.wrapV ?? (texture.repeat ? 0 : 1);
  const x = u * width - 0.5;
  const y = v * height - 0.5;
  const left = Math.floor(x);
  const top = Math.floor(y);
  const shareX = x - left;
  const shareY = y - top;
  let value = 0;
  for (let corner = 0; corner < 4; corner++) {
    const column = wrapTexelIndex(left + (corner & 1), width, wrapU);
    const row = wrapTexelIndex(top + (corner >> 1), height, wrapV);
    const weight = ((corner & 1) ? shareX : 1 - shareX) * ((corner >> 1) ? shareY : 1 - shareY);
    value += weight * (data[(row * width + column) * 4] / 255);
  }
  return value;
}

function smoothstep(edge0, edge1, value) {
  const fraction = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return fraction * fraction * (3 - 2 * fraction);
}

export function heightFadeAtDistance(distance, fadeDistance) {
  const halfFade = 0.5 * fadeDistance;
  if (distance <= halfFade) return 1;
  if (distance >= fadeDistance) return 0;
  return 1 - smoothstep(halfFade, fadeDistance, distance);
}

function isIdentityMatrix(matrix) {
  for (let index = 0; index < 16; index++) {
    if (matrix[index] !== IDENTITY_MATRIX[index]) return false;
  }
  return true;
}

function upperMatrixStats(matrix) {
  const [m00, m10, m20, , m01, m11, m21, , m02, m12, m22] = matrix;
  const cofactor00 = m11 * m22 - m21 * m12;
  const cofactor10 = m21 * m02 - m01 * m22;
  const cofactor20 = m01 * m12 - m11 * m02;
  const cofactor01 = m20 * m12 - m10 * m22;
  const cofactor11 = m00 * m22 - m20 * m02;
  const cofactor21 = m10 * m02 - m00 * m12;
  const cofactor02 = m10 * m21 - m20 * m11;
  const cofactor12 = m20 * m01 - m00 * m21;
  const cofactor22 = m00 * m11 - m10 * m01;
  const determinant = m00 * cofactor00 + m10 * cofactor10 + m20 * cofactor20;
  if (Math.abs(determinant) <= 1e-12) return null;
  const sign = determinant < 0 ? -1 : 1;
  const normalRows = [
    cofactor00 * sign, cofactor10 * sign, cofactor20 * sign,
    cofactor01 * sign, cofactor11 * sign, cofactor21 * sign,
    cofactor02 * sign, cofactor12 * sign, cofactor22 * sign,
  ];
  const invDet = 1 / determinant;
  const inverseRows = [
    cofactor00 * invDet, cofactor01 * invDet, cofactor02 * invDet,
    cofactor10 * invDet, cofactor11 * invDet, cofactor12 * invDet,
    cofactor20 * invDet, cofactor21 * invDet, cofactor22 * invDet,
  ];
  return { normalRows, inverseRows, mirrored: determinant < 0 };
}

function transformToWorld(geometry, matrix, normalRows) {
  if (isIdentityMatrix(matrix)) {
    return { positions: new Float32Array(geometry.positions), normals: new Float32Array(geometry.normals) };
  }
  const vertexCount = geometry.positions.length / 3;
  const positions = new Float32Array(geometry.positions.length);
  const normals = new Float32Array(geometry.normals.length);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 3;
    const x = geometry.positions[offset];
    const y = geometry.positions[offset + 1];
    const z = geometry.positions[offset + 2];
    positions[offset] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    positions[offset + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    positions[offset + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    const nx = geometry.normals[offset];
    const ny = geometry.normals[offset + 1];
    const nz = geometry.normals[offset + 2];
    const wx = normalRows[0] * nx + normalRows[3] * ny + normalRows[6] * nz;
    const wy = normalRows[1] * nx + normalRows[4] * ny + normalRows[7] * nz;
    const wz = normalRows[2] * nx + normalRows[5] * ny + normalRows[8] * nz;
    const length = Math.hypot(wx, wy, wz) || 1;
    normals[offset] = wx / length;
    normals[offset + 1] = wy / length;
    normals[offset + 2] = wz / length;
  }
  return { positions, normals };
}

function transformBackToLocal(worldPositions, worldNormals, matrix) {
  if (isIdentityMatrix(matrix)) return { positions: worldPositions, normals: worldNormals };
  const stats = upperMatrixStats(matrix);
  const { inverseRows } = stats;
  const vertexCount = worldPositions.length / 3;
  const positions = new Float32Array(worldPositions.length);
  const normals = new Float32Array(worldNormals.length);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 3;
    const dx = worldPositions[offset] - matrix[12];
    const dy = worldPositions[offset + 1] - matrix[13];
    const dz = worldPositions[offset + 2] - matrix[14];
    positions[offset] = inverseRows[0] * dx + inverseRows[3] * dy + inverseRows[6] * dz;
    positions[offset + 1] = inverseRows[1] * dx + inverseRows[4] * dy + inverseRows[7] * dz;
    positions[offset + 2] = inverseRows[2] * dx + inverseRows[5] * dy + inverseRows[8] * dz;
    const nx = worldNormals[offset];
    const ny = worldNormals[offset + 1];
    const nz = worldNormals[offset + 2];
    // Transpose of upper 3x3 cancels normalMatrix(M) up to positive scalar |det(M)|, keeping unit normals identical in world space.
    const lx = matrix[0] * nx + matrix[1] * ny + matrix[2] * nz;
    const ly = matrix[4] * nx + matrix[5] * ny + matrix[6] * nz;
    const lz = matrix[8] * nx + matrix[9] * ny + matrix[10] * nz;
    const length = Math.hypot(lx, ly, lz) || 1;
    normals[offset] = lx / length;
    normals[offset + 1] = ly / length;
    normals[offset + 2] = lz / length;
  }
  return { positions, normals };
}

function minDistanceToBox(positions, eye) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const dx = eye[0] < minX ? minX - eye[0] : eye[0] > maxX ? eye[0] - maxX : 0;
  const dy = eye[1] < minY ? minY - eye[1] : eye[1] > maxY ? eye[1] - maxY : 0;
  const dz = eye[2] < minZ ? minZ - eye[2] : eye[2] > maxZ ? eye[2] - maxZ : 0;
  return Math.hypot(dx, dy, dz);
}

function subdivideOnce(mesh) {
  const { positions, normals, uvs, lightUvs, colors, colorAlpha, indices, triangleMaterial } = mesh;
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  // Each triangle adds at most 3 new edge midpoints; shared edges reuse one vertex index.
  const maxVertices = vertexCount + triangleCount * 3;
  const nextPositions = new Float32Array(maxVertices * 3);
  const nextNormals = new Float32Array(maxVertices * 3);
  const nextUvs = uvs ? new Float32Array(maxVertices * 2) : null;
  const nextLightUvs = lightUvs ? new Float32Array(maxVertices * 2) : null;
  const nextColors = colors ? new Float32Array(maxVertices * 3) : null;
  const nextColorAlpha = colorAlpha ? new Float32Array(maxVertices) : null;
  nextPositions.set(positions);
  nextNormals.set(normals);
  if (nextUvs) nextUvs.set(uvs);
  if (nextLightUvs) nextLightUvs.set(lightUvs);
  if (nextColors) nextColors.set(colors);
  if (nextColorAlpha) nextColorAlpha.set(colorAlpha);

  const nextIndices = new Uint32Array(triangleCount * 12);
  const nextTriangleMaterial = triangleMaterial ? new Uint32Array(triangleCount * 4) : null;
  const edgeMidpoints = new Map();
  let cursor = vertexCount;

  const midpointOf = (first, second) => {
    const low = first < second ? first : second;
    const high = first < second ? second : first;
    const key = low * vertexCount + high;
    const existing = edgeMidpoints.get(key);
    if (existing !== undefined) return existing;
    const index = cursor++;
    edgeMidpoints.set(key, index);
    const out3 = index * 3;
    const a3 = low * 3;
    const b3 = high * 3;
    nextPositions[out3] = 0.5 * (nextPositions[a3] + nextPositions[b3]);
    nextPositions[out3 + 1] = 0.5 * (nextPositions[a3 + 1] + nextPositions[b3 + 1]);
    nextPositions[out3 + 2] = 0.5 * (nextPositions[a3 + 2] + nextPositions[b3 + 2]);
    const nx = nextNormals[a3] + nextNormals[b3];
    const ny = nextNormals[a3 + 1] + nextNormals[b3 + 1];
    const nz = nextNormals[a3 + 2] + nextNormals[b3 + 2];
    const length = Math.hypot(nx, ny, nz);
    if (length > 1e-6) {
      nextNormals[out3] = nx / length;
      nextNormals[out3 + 1] = ny / length;
      nextNormals[out3 + 2] = nz / length;
    } else {
      nextNormals[out3] = nextNormals[a3];
      nextNormals[out3 + 1] = nextNormals[a3 + 1];
      nextNormals[out3 + 2] = nextNormals[a3 + 2];
    }
    const out2 = index * 2;
    const a2 = low * 2;
    const b2 = high * 2;
    if (nextUvs) {
      nextUvs[out2] = 0.5 * (nextUvs[a2] + nextUvs[b2]);
      nextUvs[out2 + 1] = 0.5 * (nextUvs[a2 + 1] + nextUvs[b2 + 1]);
    }
    if (nextLightUvs) {
      nextLightUvs[out2] = 0.5 * (nextLightUvs[a2] + nextLightUvs[b2]);
      nextLightUvs[out2 + 1] = 0.5 * (nextLightUvs[a2 + 1] + nextLightUvs[b2 + 1]);
    }
    if (nextColors) {
      nextColors[out3] = 0.5 * (nextColors[a3] + nextColors[b3]);
      nextColors[out3 + 1] = 0.5 * (nextColors[a3 + 1] + nextColors[b3 + 1]);
      nextColors[out3 + 2] = 0.5 * (nextColors[a3 + 2] + nextColors[b3 + 2]);
    }
    if (nextColorAlpha) nextColorAlpha[index] = 0.5 * (nextColorAlpha[low] + nextColorAlpha[high]);
    return index;
  };

  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const i0 = indices[triangle * 3];
    const i1 = indices[triangle * 3 + 1];
    const i2 = indices[triangle * 3 + 2];
    const m01 = midpointOf(i0, i1);
    const m12 = midpointOf(i1, i2);
    const m20 = midpointOf(i2, i0);
    const out = triangle * 12;
    nextIndices[out] = i0;
    nextIndices[out + 1] = m01;
    nextIndices[out + 2] = m20;
    nextIndices[out + 3] = m01;
    nextIndices[out + 4] = i1;
    nextIndices[out + 5] = m12;
    nextIndices[out + 6] = m20;
    nextIndices[out + 7] = m12;
    nextIndices[out + 8] = i2;
    nextIndices[out + 9] = m01;
    nextIndices[out + 10] = m12;
    nextIndices[out + 11] = m20;
    if (nextTriangleMaterial) {
      nextTriangleMaterial.fill(triangleMaterial[triangle], triangle * 4, triangle * 4 + 4);
    }
  }

  return {
    positions: nextPositions.subarray(0, cursor * 3).slice(),
    normals: nextNormals.subarray(0, cursor * 3).slice(),
    uvs: nextUvs ? nextUvs.subarray(0, cursor * 2).slice() : null,
    lightUvs: nextLightUvs ? nextLightUvs.subarray(0, cursor * 2).slice() : null,
    colors: nextColors ? nextColors.subarray(0, cursor * 3).slice() : null,
    colorAlpha: nextColorAlpha ? nextColorAlpha.subarray(0, cursor).slice() : null,
    indices: nextIndices,
    triangleMaterial: nextTriangleMaterial,
  };
}

function positionKeyOf(positions, vertex) {
  const offset = vertex * 3;
  return `${Math.round(positions[offset] * POSITION_WELD_GRID)},${Math.round(positions[offset + 1] * POSITION_WELD_GRID)},${Math.round(positions[offset + 2] * POSITION_WELD_GRID)}`;
}

function angleAtCorner(positions, corner, previous, next) {
  const ax = positions[previous * 3] - positions[corner * 3];
  const ay = positions[previous * 3 + 1] - positions[corner * 3 + 1];
  const az = positions[previous * 3 + 2] - positions[corner * 3 + 2];
  const bx = positions[next * 3] - positions[corner * 3];
  const by = positions[next * 3 + 1] - positions[corner * 3 + 1];
  const bz = positions[next * 3 + 2] - positions[corner * 3 + 2];
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return Math.atan2(Math.hypot(cx, cy, cz), ax * bx + ay * by + az * bz);
}

function vertexAngleWeights(positions, indices, vertexCount) {
  const weights = new Float64Array(vertexCount);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const i0 = indices[offset];
    const i1 = indices[offset + 1];
    const i2 = indices[offset + 2];
    weights[i0] += angleAtCorner(positions, i0, i2, i1);
    weights[i1] += angleAtCorner(positions, i1, i0, i2);
    weights[i2] += angleAtCorner(positions, i2, i1, i0);
  }
  return weights;
}

function computeWeldedDisplacementData(positions, normals, indices, heightUvs, heightTexture) {
  const vertexCount = positions.length / 3;
  const groups = new Map();
  const vertexPositionKeys = new Array(vertexCount);
  const rawHeights = new Float64Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const key = positionKeyOf(positions, vertex);
    vertexPositionKeys[vertex] = key;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(vertex);
    rawHeights[vertex] = sampleHeightTexel(heightTexture, heightUvs[vertex * 2], heightUvs[vertex * 2 + 1]);
  }
  const weights = vertexAngleWeights(positions, indices, vertexCount);
  const weldedNormals = new Float32Array(normals);
  const weldedHeights = new Float64Array(rawHeights);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let heightSum = 0;
    for (const vertex of group) heightSum += rawHeights[vertex];
    const meanHeight = heightSum / group.length;
    for (const vertex of group) {
      weldedHeights[vertex] = meanHeight;
      const offset = vertex * 3;
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      for (const other of group) {
        const otherOffset = other * 3;
        const cosine = normals[offset] * normals[otherOffset] + normals[offset + 1] * normals[otherOffset + 1] + normals[offset + 2] * normals[otherOffset + 2];
        if (cosine <= OPPOSITE_NORMAL_COSINE) continue;
        const share = Math.max(weights[other], 1e-6);
        sumX += normals[otherOffset] * share;
        sumY += normals[otherOffset + 1] * share;
        sumZ += normals[otherOffset + 2] * share;
      }
      const length = Math.hypot(sumX, sumY, sumZ);
      if (length > 1e-12) {
        weldedNormals[offset] = sumX / length;
        weldedNormals[offset + 1] = sumY / length;
        weldedNormals[offset + 2] = sumZ / length;
      }
    }
  }
  return { weldedNormals, weldedHeights, vertexPositionKeys };
}

function recomputeDisplacedNormals(displacedPositions, baseNormals, indices, vertexPositionKeys, mirrored) {
  const vertexCount = displacedPositions.length / 3;
  const groups = new Map();
  const vertexGroups = new Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 3;
    const normalKey = `${Math.round(baseNormals[offset] * NORMAL_GROUP_GRID)},${Math.round(baseNormals[offset + 1] * NORMAL_GROUP_GRID)},${Math.round(baseNormals[offset + 2] * NORMAL_GROUP_GRID)}`;
    const key = `${vertexPositionKeys[vertex]}:${normalKey}`;
    let group = groups.get(key);
    if (!group) {
      group = { sumX: 0, sumY: 0, sumZ: 0 };
      groups.set(key, group);
    }
    vertexGroups[vertex] = group;
  }
  const windingSign = mirrored ? -1 : 1;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const i0 = indices[offset];
    const i1 = indices[offset + 1];
    const i2 = indices[offset + 2];
    const p0 = i0 * 3;
    const p1 = i1 * 3;
    const p2 = i2 * 3;
    const e1x = displacedPositions[p1] - displacedPositions[p0];
    const e1y = displacedPositions[p1 + 1] - displacedPositions[p0 + 1];
    const e1z = displacedPositions[p1 + 2] - displacedPositions[p0 + 2];
    const e2x = displacedPositions[p2] - displacedPositions[p0];
    const e2y = displacedPositions[p2 + 1] - displacedPositions[p0 + 1];
    const e2z = displacedPositions[p2 + 2] - displacedPositions[p0 + 2];
    const fx = (e1y * e2z - e1z * e2y) * windingSign;
    const fy = (e1z * e2x - e1x * e2z) * windingSign;
    const fz = (e1x * e2y - e1y * e2x) * windingSign;
    if (Math.hypot(fx, fy, fz) === 0) continue;
    for (const vertex of [i0, i1, i2]) {
      const group = vertexGroups[vertex];
      group.sumX += fx;
      group.sumY += fy;
      group.sumZ += fz;
    }
  }
  const normals = new Float32Array(displacedPositions.length);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 3;
    const group = vertexGroups[vertex];
    const length = Math.hypot(group.sumX, group.sumY, group.sumZ);
    if (length > 1e-12) {
      normals[offset] = group.sumX / length;
      normals[offset + 1] = group.sumY / length;
      normals[offset + 2] = group.sumZ / length;
    } else {
      normals[offset] = baseNormals[offset];
      normals[offset + 1] = baseNormals[offset + 1];
      normals[offset + 2] = baseNormals[offset + 2];
    }
  }
  return normals;
}

export function subdivisionLevelForCap(baseTriangles, triangleCap) {
  let level = 0;
  let current = baseTriangles;
  while (level < MAX_DISPLACEMENT_SUBDIVISIONS && current * 4 <= triangleCap) {
    current *= 4;
    level++;
  }
  return level;
}

export function displacePartGeometry(part, geometry, heightTexture, { triangleCap = MAX_DISPLACED_TRIANGLES_PER_PART, eye = null } = {}) {
  const material = part.material ?? {};
  const heightScale = material.heightScale ?? 0;
  if (!(heightScale > 0) || !heightTexture) return geometry;
  const heightUvs = heightTexture.uvSet === 1 ? geometry.lightUvs : geometry.uvs;
  if (!heightUvs) return geometry;
  const matrix = part.matrix ?? IDENTITY_MATRIX;
  const stats = isIdentityMatrix(matrix) ? { normalRows: null, mirrored: false } : upperMatrixStats(matrix);
  if (!stats) return geometry;

  const world = transformToWorld(geometry, matrix, stats.normalRows);
  const fadeDistance = material.heightFade ?? HEIGHT_PARALLAX_DEFAULTS.fade;
  if (eye && minDistanceToBox(world.positions, eye) >= fadeDistance) return geometry;

  const level = subdivisionLevelForCap(geometry.indices.length / 3, triangleCap);
  let mesh = {
    positions: world.positions,
    normals: world.normals,
    uvs: geometry.uvs ? new Float32Array(geometry.uvs) : null,
    lightUvs: geometry.lightUvs ? new Float32Array(geometry.lightUvs) : null,
    colors: geometry.colors ? new Float32Array(geometry.colors) : null,
    colorAlpha: geometry.colorAlpha ? new Float32Array(geometry.colorAlpha) : null,
    indices: new Uint32Array(geometry.indices),
    triangleMaterial: geometry.triangleMaterial ? new Uint32Array(geometry.triangleMaterial) : null,
  };
  for (let pass = 0; pass < level; pass++) mesh = subdivideOnce(mesh);

  const activeUvs = heightTexture.uvSet === 1 ? mesh.lightUvs : mesh.uvs;
  const { weldedNormals, weldedHeights, vertexPositionKeys } = computeWeldedDisplacementData(
    mesh.positions, mesh.normals, mesh.indices, activeUvs, heightTexture,
  );
  const displacedPositions = new Float32Array(mesh.positions.length);
  const vertexCount = mesh.positions.length / 3;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 3;
    const wx = mesh.positions[offset];
    const wy = mesh.positions[offset + 1];
    const wz = mesh.positions[offset + 2];
    const fade = eye ? heightFadeAtDistance(Math.hypot(eye[0] - wx, eye[1] - wy, eye[2] - wz), fadeDistance) : 1;
    const displacement = (weldedHeights[vertex] - 1) * heightScale * fade;
    displacedPositions[offset] = wx + weldedNormals[offset] * displacement;
    displacedPositions[offset + 1] = wy + weldedNormals[offset + 1] * displacement;
    displacedPositions[offset + 2] = wz + weldedNormals[offset + 2] * displacement;
  }
  const displacedNormals = recomputeDisplacedNormals(displacedPositions, mesh.normals, mesh.indices, vertexPositionKeys, stats.mirrored);
  const local = transformBackToLocal(displacedPositions, displacedNormals, matrix);

  return {
    ...geometry,
    positions: local.positions,
    normals: local.normals,
    indices: mesh.indices,
    ...(mesh.uvs ? { uvs: mesh.uvs } : {}),
    ...(mesh.lightUvs ? { lightUvs: mesh.lightUvs } : {}),
    ...(mesh.colors ? { colors: mesh.colors } : {}),
    ...(mesh.colorAlpha ? { colorAlpha: mesh.colorAlpha } : {}),
    ...(mesh.triangleMaterial ? { triangleMaterial: mesh.triangleMaterial } : {}),
  };
}

export function displaceTraceParts(parts, geometries, limits, options, validatePart, resolveTexture) {
  const eye = validateCameraEye(options?.eye);
  const resolvedMaps = new Array(parts.length).fill(null);
  let totalBaseTriangles = 0;
  let eligibleCount = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const geometry = geometries[index];
    validatePart(part, geometry);
    const material = part.material ?? {};
    validateDisplacementMaterial(material, describePart(part, index));
    totalBaseTriangles += geometry.indices.length / 3;
    if (material.heightMap && material.heightScale > 0 && STANDARD_TAGS.has(material.tag)) {
      const texture = resolveTexture(material.heightMap);
      const hasUvs = texture && (texture.uvSet === 1 ? Boolean(geometry.lightUvs) : Boolean(geometry.uvs));
      if (hasUvs) {
        resolvedMaps[index] = texture;
        eligibleCount++;
      }
    }
  }
  if (eligibleCount === 0) return geometries;

  const extraBudget = Math.max(0, limits.unique - totalBaseTriangles);
  const perPartExtra = Math.floor(extraBudget / eligibleCount);
  return geometries.map((geometry, index) => {
    const texture = resolvedMaps[index];
    if (!texture) return geometry;
    const baseTriangles = geometry.indices.length / 3;
    const triangleCap = Math.min(MAX_DISPLACED_TRIANGLES_PER_PART, baseTriangles + perPartExtra);
    return displacePartGeometry(parts[index], geometry, texture, { triangleCap, eye });
  });
}
