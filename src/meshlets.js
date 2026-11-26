// Per-cluster meshlets and frustum/cone culling for dense single meshes (#2983).
// Built on demand with meshoptimizer's clusterizer (optional peer) and kept out of the core bundle.
import { mat4 } from 'gl-matrix';
import { extractFrustumPlanes } from './render-culling.js';
import { isLiveGeometry, isReindexedGeometry } from './live-geometry.js';

export const DEFAULT_MESHLET_MINIMUM_TRIANGLES = 4096;
export const DEFAULT_MAX_MESHLET_VERTICES = 64;
export const DEFAULT_MAX_MESHLET_TRIANGLES = 124;
export const DEFAULT_MESHLET_CONE_WEIGHT = 0.5;

const MAX_BOUNDED_VERTICES = 256;
const MAX_BOUNDED_TRIANGLES = 512;
const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const meshletsByGeometry = new WeakMap();

let clusterizerPromise = null;

async function resolveClusterizer(suppliedClusterizer) {
  if (suppliedClusterizer) {
    await suppliedClusterizer.ready;
    return suppliedClusterizer;
  }
  clusterizerPromise ??= import('meshoptimizer')
    .then(async module => {
      const clusterizer = module.MeshoptClusterizer;
      if (!clusterizer) throw new Error('The meshoptimizer package did not expose MeshoptClusterizer.');
      await clusterizer.ready;
      return clusterizer;
    })
    .catch(error => {
      clusterizerPromise = null;
      throw new Error(`Meshlet building needs the optional peer dependency meshoptimizer: npm install meshoptimizer (${error.message}).`);
    });
  return clusterizerPromise;
}

function validateGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') throw new TypeError('buildGeometryMeshlets expects a geometry object.');
  const { positions, indices } = geometry;
  if (!(positions instanceof Float32Array) || positions.length === 0 || positions.length % 3 !== 0) {
    throw new TypeError('geometry.positions must be a non-empty Float32Array of XYZ triples.');
  }
  const validIndices = indices instanceof Uint32Array || indices instanceof Uint16Array;
  if (!validIndices || indices.length % 3 !== 0) {
    throw new TypeError('geometry.indices must be a Uint16Array or Uint32Array of triangle triples.');
  }
  return geometry;
}

function requireIntegerInRange(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}, got ${value}.`);
  }
}

function requireUnitInterval(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a finite number from 0 to 1, got ${value}.`);
  }
}

function cacheKeyOf(maxVertices, maxTriangles, coneWeight) {
  return `${maxVertices}:${maxTriangles}:${coneWeight}`;
}

function expandMortonBits(value) {
  let bits = value & 0x3ff;
  bits = (bits | (bits << 16)) & 0x030000ff;
  bits = (bits | (bits << 8)) & 0x0300f00f;
  bits = (bits | (bits << 4)) & 0x030c30c3;
  bits = (bits | (bits << 2)) & 0x09249249;
  return bits;
}

function mortonSortedOrder(boundsList) {
  const meshletCount = boundsList.length;
  const order = new Uint32Array(meshletCount);
  if (meshletCount <= 1) {
    if (meshletCount === 1) order[0] = 0;
    return order;
  }

  let minimumX = Infinity;
  let minimumY = Infinity;
  let minimumZ = Infinity;
  let maximumX = -Infinity;
  let maximumY = -Infinity;
  let maximumZ = -Infinity;
  for (let index = 0; index < meshletCount; index++) {
    const bound = boundsList[index];
    if (bound.centerX < minimumX) minimumX = bound.centerX;
    if (bound.centerY < minimumY) minimumY = bound.centerY;
    if (bound.centerZ < minimumZ) minimumZ = bound.centerZ;
    if (bound.centerX > maximumX) maximumX = bound.centerX;
    if (bound.centerY > maximumY) maximumY = bound.centerY;
    if (bound.centerZ > maximumZ) maximumZ = bound.centerZ;
  }

  const spanX = maximumX - minimumX || 1;
  const spanY = maximumY - minimumY || 1;
  const spanZ = maximumZ - minimumZ || 1;
  const keys = new Uint32Array(meshletCount);
  for (let index = 0; index < meshletCount; index++) {
    const bound = boundsList[index];
    const quantX = Math.min(1023, Math.max(0, Math.floor(((bound.centerX - minimumX) / spanX) * 1023)));
    const quantY = Math.min(1023, Math.max(0, Math.floor(((bound.centerY - minimumY) / spanY) * 1023)));
    const quantZ = Math.min(1023, Math.max(0, Math.floor(((bound.centerZ - minimumZ) / spanZ) * 1023)));
    keys[index] = expandMortonBits(quantX) | (expandMortonBits(quantY) << 1) | (expandMortonBits(quantZ) << 2);
    order[index] = index;
  }
  order.sort((first, second) => keys[first] - keys[second] || first - second);
  return order;
}

function unpackMeshlets(clusterizer, buffers, boundsList, triangleCount, maxVertices, maxTriangles, coneWeight) {
  const meshletCount = buffers.meshletCount;
  const order = mortonSortedOrder(boundsList);
  const indices = new Uint32Array(triangleCount * 3);
  const offsets = new Uint32Array(meshletCount);
  const counts = new Uint32Array(meshletCount);
  const spheres = new Float32Array(meshletCount * 4);
  const cones = new Float32Array(meshletCount * 8);
  let writeOffset = 0;

  for (let clusterIndex = 0; clusterIndex < meshletCount; clusterIndex++) {
    const sourceCluster = order[clusterIndex];
    const cluster = clusterizer.extractMeshlet(buffers, sourceCluster);
    const vertices = cluster.vertices;
    const triangles = cluster.triangles;
    const indexCount = triangles.length;
    offsets[clusterIndex] = writeOffset;
    counts[clusterIndex] = indexCount;
    for (let localIndex = 0; localIndex < indexCount; localIndex++) {
      indices[writeOffset++] = vertices[triangles[localIndex]];
    }
    const bound = boundsList[sourceCluster];
    const sphereBase = clusterIndex * 4;
    spheres[sphereBase] = bound.centerX;
    spheres[sphereBase + 1] = bound.centerY;
    spheres[sphereBase + 2] = bound.centerZ;
    spheres[sphereBase + 3] = bound.radius;
    const coneBase = clusterIndex * 8;
    cones[coneBase] = bound.coneApexX;
    cones[coneBase + 1] = bound.coneApexY;
    cones[coneBase + 2] = bound.coneApexZ;
    cones[coneBase + 3] = bound.coneCutoff;
    cones[coneBase + 4] = bound.coneAxisX;
    cones[coneBase + 5] = bound.coneAxisY;
    cones[coneBase + 6] = bound.coneAxisZ;
    cones[coneBase + 7] = 0;
  }

  return Object.freeze({
    meshletCount,
    triangleCount,
    indices,
    offsets,
    counts,
    spheres,
    cones,
    maxVertices,
    maxTriangles,
    coneWeight,
  });
}

/**
 * Splits a dense indexed triangle geometry into bounded spatial/normal clusters (`meshlets`) with per-cluster bounding
 * spheres and backface cones. Returns `null` when the mesh has fewer than `minimumTriangles` triangles.
 */
export async function buildGeometryMeshlets(geometry, {
  minimumTriangles = DEFAULT_MESHLET_MINIMUM_TRIANGLES,
  maxVertices = DEFAULT_MAX_MESHLET_VERTICES,
  maxTriangles = DEFAULT_MAX_MESHLET_TRIANGLES,
  coneWeight = DEFAULT_MESHLET_CONE_WEIGHT,
  clusterizer = null,
} = {}) {
  const { positions, indices } = validateGeometry(geometry);
  requireIntegerInRange('minimumTriangles', minimumTriangles, 1, 1e9);
  requireIntegerInRange('maxVertices', maxVertices, 3, MAX_BOUNDED_VERTICES);
  requireIntegerInRange('maxTriangles', maxTriangles, 1, MAX_BOUNDED_TRIANGLES);
  requireUnitInterval('coneWeight', coneWeight);

  const triangleCount = indices.length / 3;
  if (triangleCount < minimumTriangles) return null;

  const canCache = !clusterizer && !isLiveGeometry(geometry) && !isReindexedGeometry(geometry);
  const cacheKey = cacheKeyOf(maxVertices, maxTriangles, coneWeight);
  if (canCache) {
    const cachedByOptions = meshletsByGeometry.get(geometry);
    const cached = cachedByOptions?.get(cacheKey);
    if (cached && cached.indices === indices && cached.positions === positions) return cached.result;
  }

  const resolved = await resolveClusterizer(clusterizer);
  const indices32 = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
  // MeshoptClusterizer takes vertex_positions_stride in float elements (3 per vertex), not bytes.
  const buffers = resolved.buildMeshlets(indices32, positions, 3, maxVertices, maxTriangles, coneWeight);
  const boundsList = resolved.computeMeshletBounds(buffers, positions, 3);
  const result = unpackMeshlets(resolved, buffers, boundsList, triangleCount, maxVertices, maxTriangles, coneWeight);

  if (canCache) {
    let cachedByOptions = meshletsByGeometry.get(geometry);
    if (!cachedByOptions) {
      cachedByOptions = new Map();
      meshletsByGeometry.set(geometry, cachedByOptions);
    }
    cachedByOptions.set(cacheKey, { indices, positions, result });
  }
  return result;
}

function partEligibleForMeshlets(part) {
  if (!part || typeof part !== 'object' || part.meshlets) return false;
  if (part.skin || part.morph || part.crowd || part.flushOrder) return false;
  return Boolean(part.geometry?.positions && part.geometry?.indices);
}

/**
 * Attaches `meshlets` to every eligible rigid part with at least `minimumTriangles` triangles, sharing one cluster build
 * across parts that share a geometry. Returns `parts` unchanged when nothing reaches the threshold.
 */
export async function addMeshletsToDenseParts(parts, options = {}) {
  if (!Array.isArray(parts)) throw new TypeError('parts must be an array of scene parts.');
  const { minimumTriangles = DEFAULT_MESHLET_MINIMUM_TRIANGLES } = options;
  requireIntegerInRange('minimumTriangles', minimumTriangles, 1, 1e9);

  const builtByGeometry = new Map();
  let anyAttached = false;
  const nextParts = new Array(parts.length);

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!partEligibleForMeshlets(part) || part.geometry.indices.length / 3 < minimumTriangles) {
      nextParts[index] = part;
      continue;
    }
    if (!builtByGeometry.has(part.geometry)) {
      builtByGeometry.set(part.geometry, await buildGeometryMeshlets(part.geometry, options));
    }
    const meshlets = builtByGeometry.get(part.geometry);
    if (meshlets) {
      anyAttached = true;
      nextParts[index] = { ...part, meshlets };
    } else {
      nextParts[index] = part;
    }
  }
  return anyAttached ? nextParts : parts;
}

function largestColumnLength(matrix) {
  const first = matrix[0] * matrix[0] + matrix[1] * matrix[1] + matrix[2] * matrix[2];
  const second = matrix[4] * matrix[4] + matrix[5] * matrix[5] + matrix[6] * matrix[6];
  const third = matrix[8] * matrix[8] + matrix[9] * matrix[9] + matrix[10] * matrix[10];
  return Math.sqrt(Math.max(first, second, third));
}

function isUniformPositiveScale(matrix, maximumScale) {
  const lengthX = Math.hypot(matrix[0], matrix[1], matrix[2]);
  const lengthY = Math.hypot(matrix[4], matrix[5], matrix[6]);
  const lengthZ = Math.hypot(matrix[8], matrix[9], matrix[10]);
  const smallest = Math.min(lengthX, lengthY, lengthZ);
  if (!(smallest > 0)) return false;
  if (maximumScale - smallest > 1e-4 * Math.max(1, maximumScale)) return false;
  const determinant =
    matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9])
    + matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]);
  return determinant > 0;
}

const scratchInverse = mat4.create();

function ensureCullOutput(out, meshletCount) {
  if (out && out.counts?.length >= meshletCount && out.firstIndices?.length >= meshletCount && out.byteOffsets?.length >= meshletCount) {
    return out;
  }
  return {
    firstIndices: new Uint32Array(meshletCount),
    byteOffsets: new Int32Array(meshletCount),
    counts: new Int32Array(meshletCount),
    rangeCount: 0,
    visibleClusters: 0,
    totalClusters: meshletCount,
    visibleTriangles: 0,
    totalTriangles: 0,
    frustumCulled: 0,
    coneCulled: 0,
  };
}

/**
 * Culls `meshlets` against six normalized inward frustum planes and, when valid, each cluster's normal cone.
 * Consecutive visible clusters are coalesced into contiguous index ranges so GPU submission uses fewer draws.
 */
export function cullMeshlets(meshlets, {
  planes,
  eye = null,
  modelMatrix = IDENTITY_MATRIX,
  doubleSided = false,
  mirrored = false,
  cullCones = true,
  margin = 0,
  out = null,
} = {}) {
  if (!meshlets || !Number.isInteger(meshlets.meshletCount) || !meshlets.spheres || !meshlets.cones || !meshlets.offsets || !meshlets.counts) {
    throw new TypeError('cullMeshlets expects a meshlets object returned by buildGeometryMeshlets.');
  }
  if (!planes || planes.length < 24) {
    throw new TypeError('cullMeshlets expects 24 plane floats (6 normalized inward frustum planes).');
  }
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0) {
    throw new RangeError(`margin must be a non-negative finite number, got ${margin}.`);
  }

  const meshletCount = meshlets.meshletCount;
  const result = ensureCullOutput(out, meshletCount);
  const { spheres, cones, offsets, counts } = meshlets;
  const { firstIndices, byteOffsets, counts: rangeCounts } = result;
  const worldScale = largestColumnLength(modelMatrix);

  let canCullCones = Boolean(cullCones && !doubleSided && !mirrored && eye && eye.length >= 3 && isUniformPositiveScale(modelMatrix, worldScale));
  let localEyeX = 0;
  let localEyeY = 0;
  let localEyeZ = 0;
  if (canCullCones) {
    const inverted = mat4.invert(scratchInverse, modelMatrix);
    if (!inverted) {
      canCullCones = false;
    } else {
      const eyeX = eye[0];
      const eyeY = eye[1];
      const eyeZ = eye[2];
      localEyeX = inverted[0] * eyeX + inverted[4] * eyeY + inverted[8] * eyeZ + inverted[12];
      localEyeY = inverted[1] * eyeX + inverted[5] * eyeY + inverted[9] * eyeZ + inverted[13];
      localEyeZ = inverted[2] * eyeX + inverted[6] * eyeY + inverted[10] * eyeZ + inverted[14];
    }
  }

  const m0 = modelMatrix[0];
  const m1 = modelMatrix[1];
  const m2 = modelMatrix[2];
  const m4 = modelMatrix[4];
  const m5 = modelMatrix[5];
  const m6 = modelMatrix[6];
  const m8 = modelMatrix[8];
  const m9 = modelMatrix[9];
  const m10 = modelMatrix[10];
  const m12 = modelMatrix[12];
  const m13 = modelMatrix[13];
  const m14 = modelMatrix[14];

  let rangeCount = 0;
  let previousEnd = -1;
  let visibleClusters = 0;
  let visibleTriangles = 0;
  let frustumCulled = 0;
  let coneCulled = 0;

  for (let clusterIndex = 0; clusterIndex < meshletCount; clusterIndex++) {
    const sphereBase = clusterIndex * 4;
    const centerX = spheres[sphereBase];
    const centerY = spheres[sphereBase + 1];
    const centerZ = spheres[sphereBase + 2];
    const worldX = m0 * centerX + m4 * centerY + m8 * centerZ + m12;
    const worldY = m1 * centerX + m5 * centerY + m9 * centerZ + m13;
    const worldZ = m2 * centerX + m6 * centerY + m10 * centerZ + m14;
    const worldRadius = spheres[sphereBase + 3] * worldScale + margin;

    let outside = false;
    for (let plane = 0; plane < 6; plane++) {
      const planeBase = plane * 4;
      if (planes[planeBase] * worldX + planes[planeBase + 1] * worldY + planes[planeBase + 2] * worldZ + planes[planeBase + 3] < -worldRadius) {
        outside = true;
        break;
      }
    }
    if (outside) {
      frustumCulled++;
      continue;
    }

    if (canCullCones) {
      const coneBase = clusterIndex * 8;
      const cutoff = cones[coneBase + 3];
      if (cutoff < 1) {
        const deltaX = cones[coneBase] - localEyeX;
        const deltaY = cones[coneBase + 1] - localEyeY;
        const deltaZ = cones[coneBase + 2] - localEyeZ;
        const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
        if (distanceSquared > 1e-12) {
          const alignment = deltaX * cones[coneBase + 4] + deltaY * cones[coneBase + 5] + deltaZ * cones[coneBase + 6];
          if (alignment >= cutoff * Math.sqrt(distanceSquared)) {
            coneCulled++;
            continue;
          }
        }
      }
    }

    const indexOffset = offsets[clusterIndex];
    const indexCount = counts[clusterIndex];
    if (rangeCount > 0 && indexOffset === previousEnd) {
      rangeCounts[rangeCount - 1] += indexCount;
      previousEnd += indexCount;
    } else {
      firstIndices[rangeCount] = indexOffset;
      byteOffsets[rangeCount] = indexOffset * 4;
      rangeCounts[rangeCount] = indexCount;
      rangeCount++;
      previousEnd = indexOffset + indexCount;
    }
    visibleClusters++;
    visibleTriangles += indexCount / 3;
  }

  result.rangeCount = rangeCount;
  result.visibleClusters = visibleClusters;
  result.totalClusters = meshletCount;
  result.visibleTriangles = visibleTriangles;
  result.totalTriangles = meshlets.triangleCount;
  result.frustumCulled = frustumCulled;
  result.coneCulled = coneCulled;
  return result;
}

export const MESHLET_CULL_WGSL = /* wgsl */ `
struct CullUniforms {
  planes: array<vec4<f32>, 6>,
  modelMatrix: mat4x4<f32>,
  localEyeAndCones: vec4<f32>,
  scaleAndMargin: vec4<f32>,
};

struct ClusterMeta {
  firstIndex: u32,
  indexCount: u32,
  pad0: u32,
  pad1: u32,
};

struct ClusterCone {
  apexAndCutoff: vec4<f32>,
  axisAndPad: vec4<f32>,
};

struct DrawIndexedIndirect {
  indexCount: u32,
  instanceCount: u32,
  firstIndex: u32,
  baseVertex: i32,
  firstInstance: u32,
};

struct CullStats {
  visibleClusters: atomic<u32>,
  visibleTriangles: atomic<u32>,
  frustumCulled: atomic<u32>,
  coneCulled: atomic<u32>,
};

@group(0) @binding(0) var<uniform> uniforms: CullUniforms;
@group(0) @binding(1) var<storage, read> spheres: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> cones: array<ClusterCone>;
@group(0) @binding(3) var<storage, read> clusters: array<ClusterMeta>;
@group(0) @binding(4) var<storage, read_write> indirectDraws: array<DrawIndexedIndirect>;
@group(0) @binding(5) var<storage, read_write> stats: CullStats;

@compute @workgroup_size(64)
fn cullClusters(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let clusterIndex = globalId.x;
  let meshletCount = u32(uniforms.scaleAndMargin.z);
  if (clusterIndex >= meshletCount) {
    return;
  }

  let meta = clusters[clusterIndex];
  let sphere = spheres[clusterIndex];
  let worldCenter = (uniforms.modelMatrix * vec4<f32>(sphere.xyz, 1.0)).xyz;
  let worldRadius = sphere.w * uniforms.scaleAndMargin.x + uniforms.scaleAndMargin.y;

  var visible = true;
  for (var planeIndex: u32 = 0u; planeIndex < 6u; planeIndex = planeIndex + 1u) {
    let plane = uniforms.planes[planeIndex];
    if (dot(plane.xyz, worldCenter) + plane.w < -worldRadius) {
      visible = false;
      atomicAdd(&stats.frustumCulled, 1u);
      break;
    }
  }

  if (visible && uniforms.localEyeAndCones.w > 0.5) {
    let cone = cones[clusterIndex];
    let cutoff = cone.apexAndCutoff.w;
    if (cutoff < 1.0) {
      let delta = cone.apexAndCutoff.xyz - uniforms.localEyeAndCones.xyz;
      let distanceSquared = dot(delta, delta);
      if (distanceSquared > 1e-12) {
        let alignment = dot(delta, cone.axisAndPad.xyz);
        if (alignment >= cutoff * sqrt(distanceSquared)) {
          visible = false;
          atomicAdd(&stats.coneCulled, 1u);
        }
      }
    }
  }

  indirectDraws[clusterIndex] = DrawIndexedIndirect(
    meta.indexCount,
    select(0u, 1u, visible),
    meta.firstIndex,
    0,
    0u
  );
  if (visible) {
    atomicAdd(&stats.visibleClusters, 1u);
    atomicAdd(&stats.visibleTriangles, meta.indexCount / 3u);
  }
}
`;

/**
 * Allocates WebGPU buffers and a `@compute` pipeline that writes one `DrawIndexedIndirect` record per cluster.
 * Call `cull(encoder, { planes, eye, modelMatrix, ... })` before a render pass reads `indirectBuffer`.
 */
export function createWebGpuMeshletCuller(device, meshlets) {
  if (!device || typeof device.createComputePipeline !== 'function' || typeof device.createBuffer !== 'function') {
    throw new TypeError('createWebGpuMeshletCuller expects a WebGPU GPUDevice.');
  }
  if (!meshlets || !Number.isInteger(meshlets.meshletCount) || meshlets.meshletCount < 1) {
    throw new TypeError('createWebGpuMeshletCuller expects non-empty meshlets from buildGeometryMeshlets.');
  }

  const STORAGE = (globalThis.GPUBufferUsage?.STORAGE ?? 0x0080);
  const UNIFORM = (globalThis.GPUBufferUsage?.UNIFORM ?? 0x0040);
  const INDIRECT = (globalThis.GPUBufferUsage?.INDIRECT ?? 0x0100);
  const COPY_DST = (globalThis.GPUBufferUsage?.COPY_DST ?? 0x0008);
  const COPY_SRC = (globalThis.GPUBufferUsage?.COPY_SRC ?? 0x0004);

  const meshletCount = meshlets.meshletCount;
  const clusterMeta = new Uint32Array(meshletCount * 4);
  for (let clusterIndex = 0; clusterIndex < meshletCount; clusterIndex++) {
    clusterMeta[clusterIndex * 4] = meshlets.offsets[clusterIndex];
    clusterMeta[clusterIndex * 4 + 1] = meshlets.counts[clusterIndex];
  }

  const uniformData = new Float32Array(48);
  const uniformBuffer = device.createBuffer({ size: uniformData.byteLength, usage: UNIFORM | COPY_DST });
  const sphereBuffer = device.createBuffer({ size: meshlets.spheres.byteLength, usage: STORAGE | COPY_DST });
  const coneBuffer = device.createBuffer({ size: meshlets.cones.byteLength, usage: STORAGE | COPY_DST });
  const metaBuffer = device.createBuffer({ size: clusterMeta.byteLength, usage: STORAGE | COPY_DST });
  const indirectBuffer = device.createBuffer({ size: meshletCount * 20, usage: STORAGE | INDIRECT | COPY_SRC });
  const statsBuffer = device.createBuffer({ size: 16, usage: STORAGE | COPY_DST | COPY_SRC });
  const zeroStats = new Uint32Array(4);

  device.queue.writeBuffer(sphereBuffer, 0, meshlets.spheres);
  device.queue.writeBuffer(coneBuffer, 0, meshlets.cones);
  device.queue.writeBuffer(metaBuffer, 0, clusterMeta);

  const module = device.createShaderModule({ code: MESHLET_CULL_WGSL });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'cullClusters' } });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: sphereBuffer } },
      { binding: 2, resource: { buffer: coneBuffer } },
      { binding: 3, resource: { buffer: metaBuffer } },
      { binding: 4, resource: { buffer: indirectBuffer } },
      { binding: 5, resource: { buffer: statsBuffer } },
    ],
  });

  function cull(encoder, { planes, eye = null, modelMatrix = IDENTITY_MATRIX, doubleSided = false, mirrored = false, cullCones = true, margin = 0 } = {}) {
    if (!planes || planes.length < 24) throw new TypeError('cull expects 24 plane floats.');
    uniformData.set(planes.subarray(0, 24), 0);
    uniformData.set(modelMatrix.subarray(0, 16), 24);

    const worldScale = largestColumnLength(modelMatrix);
    let canCullCones = Boolean(cullCones && !doubleSided && !mirrored && eye && eye.length >= 3 && isUniformPositiveScale(modelMatrix, worldScale));
    if (canCullCones) {
      const inverted = mat4.invert(scratchInverse, modelMatrix);
      if (!inverted) {
        canCullCones = false;
      } else {
        const eyeX = eye[0];
        const eyeY = eye[1];
        const eyeZ = eye[2];
        uniformData[40] = inverted[0] * eyeX + inverted[4] * eyeY + inverted[8] * eyeZ + inverted[12];
        uniformData[41] = inverted[1] * eyeX + inverted[5] * eyeY + inverted[9] * eyeZ + inverted[13];
        uniformData[42] = inverted[2] * eyeX + inverted[6] * eyeY + inverted[10] * eyeZ + inverted[14];
      }
    }
    uniformData[43] = canCullCones ? 1 : 0;
    uniformData[44] = worldScale;
    uniformData[45] = margin;
    uniformData[46] = meshletCount;
    uniformData[47] = 0;

    device.queue.writeBuffer(uniformBuffer, 0, uniformData);
    device.queue.writeBuffer(statsBuffer, 0, zeroStats);

    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(meshletCount / 64));
    pass.end();
  }

  function dispose() {
    uniformBuffer.destroy();
    sphereBuffer.destroy();
    coneBuffer.destroy();
    metaBuffer.destroy();
    indirectBuffer.destroy();
    statsBuffer.destroy();
  }

  return { cull, indirectBuffer, statsBuffer, meshletCount, dispose };
}

function emptyClusterStats() {
  return {
    enabled: true,
    drawnTriangles: 0,
    totalTriangles: 0,
    visibleClusters: 0,
    totalClusters: 0,
    frustumCulled: 0,
    coneCulled: 0,
    drawCalls: 0,
    multiDrawUsed: false,
  };
}

function createGpuResourcesForBatch(renderer, batch, meshlets) {
  const context = renderer.context;
  const part = batch.parts[0];
  const vertexArray = context.createVertexArray();
  context.bindVertexArray(vertexArray);
  renderer.bindGeometryAttributes(part.geometry, part.material);
  const indexBuffer = context.createBuffer();
  context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, indexBuffer);
  context.bufferData(context.ELEMENT_ARRAY_BUFFER, meshlets.indices, context.STATIC_DRAW);
  context.bindBuffer(context.ARRAY_BUFFER, batch.instanceBuffer);
  renderer.pointInstanceAttributes();
  context.bindVertexArray(null);
  return { vertexArray, indexBuffer, meshlets };
}

function releaseGpuResources(context, resourcesByBatch) {
  for (const resource of resourcesByBatch.values()) {
    context.deleteVertexArray(resource.vertexArray);
    context.deleteBuffer(resource.indexBuffer);
  }
  resourcesByBatch.clear();
}

/**
 * Installs per-cluster meshlet culling on a `CrucibleRenderer` (WebGL2 with `WEBGL_multi_draw` when present and single-draw
 * range fallback otherwise). Single-instance rigid batches whose `parts[0].meshlets` is set are culled per frame.
 */
export function installClusterCulling(renderer, { enabled = true, cullCones = true, cullShadows = true } = {}) {
  if (!renderer || typeof renderer.render !== 'function' || typeof renderer.drawBatch !== 'function' || !renderer.backend) {
    throw new TypeError('installClusterCulling expects a CrucibleRenderer instance.');
  }
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be true or false.');

  const context = renderer.context;
  const multiDraw = context.getExtension?.('WEBGL_multi_draw') ?? null;
  const originalRender = renderer.render.bind(renderer);
  const originalDrawShadowCasters = renderer.drawShadowCasters?.bind(renderer);
  const originalDrawBatch = renderer.drawBatch.bind(renderer);
  const originalReplaceParts = renderer.replaceParts?.bind(renderer);
  const originalDispose = renderer.dispose.bind(renderer);
  const originalDrawIndexedInstanced = renderer.backend.drawIndexedInstanced.bind(renderer.backend);

  const gpuResources = new Map();
  const shadowPlanes = new Float32Array(24);
  const cullOutputByMeshlets = new WeakMap();

  let active = enabled;
  let lastStats = { ...emptyClusterStats(), enabled };
  let frameStats = { ...emptyClusterStats(), enabled };
  let activeEye = null;
  let activeOrthographic = false;
  let activeShadowPlanes = null;
  let activeBatchContext = null;
  let frameExtraDrawCalls = 0;
  let frameExtraTriangles = 0;

  function drawBatchWithMeshlets(batchContext, drawCallCount, rangeCount, firstIndices, byteOffsets, counts) {
    if (rangeCount === 0) return;
    const { batch, meshlets } = batchContext;
    if (rangeCount === 1 && firstIndices[0] === 0 && counts[0] === meshlets.triangleCount * 3) {
      originalDrawIndexedInstanced(counts[0], drawCallCount, 0);
      frameStats.drawCalls += 1;
      return;
    }
    let resource = gpuResources.get(batch);
    if (!resource || resource.meshlets !== meshlets) {
      if (resource) {
        context.deleteVertexArray(resource.vertexArray);
        context.deleteBuffer(resource.indexBuffer);
      }
      resource = createGpuResourcesForBatch(renderer, batch, meshlets);
      gpuResources.set(batch, resource);
    }

    context.bindVertexArray(resource.vertexArray);
    if (multiDraw && rangeCount > 1) {
      multiDraw.multiDrawElementsWEBGL(context.TRIANGLES, counts, 0, context.UNSIGNED_INT, byteOffsets, 0, rangeCount);
      frameExtraDrawCalls += 1;
      for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex++) {
        frameExtraTriangles += counts[rangeIndex] / 3;
      }
      frameStats.multiDrawUsed = true;
      frameStats.drawCalls += 1;
      return;
    }
    for (let rangeIndex = 0; rangeIndex < rangeCount; rangeIndex++) {
      originalDrawIndexedInstanced(counts[rangeIndex], drawCallCount, firstIndices[rangeIndex]);
      frameStats.drawCalls += 1;
    }
  }

  renderer.render = function renderWithClusterCulling(frame) {
    const previousEye = activeEye;
    const previousOrthographic = activeOrthographic;
    const previousExtraCalls = frameExtraDrawCalls;
    const previousExtraTriangles = frameExtraTriangles;
    if (!frame?.reflectionTarget) {
      frameStats = { ...emptyClusterStats(), enabled: active };
      frameExtraDrawCalls = 0;
      frameExtraTriangles = 0;
    }
    activeEye = frame?.eye ?? null;
    activeOrthographic = frame?.projection === 'orthographic';
    try {
      originalRender(frame);
      if (!frame?.reflectionTarget) {
        if (renderer.stats && (frameExtraDrawCalls > 0 || frameExtraTriangles > 0)) {
          renderer.stats = {
            ...renderer.stats,
            drawCalls: renderer.stats.drawCalls + frameExtraDrawCalls,
            trianglesDrawn: renderer.stats.trianglesDrawn + frameExtraTriangles,
          };
        }
        lastStats = { ...frameStats };
      }
    } finally {
      activeEye = previousEye;
      activeOrthographic = previousOrthographic;
      if (frame?.reflectionTarget) {
        frameExtraDrawCalls = previousExtraCalls;
        frameExtraTriangles = previousExtraTriangles;
      }
    }
  };

  if (originalDrawShadowCasters) {
    renderer.drawShadowCasters = function drawShadowsWithClusterCulling(lightMatrix = renderer.lightProjection, resolution = null, mainMap = false) {
      const previousShadowPlanes = activeShadowPlanes;
      activeShadowPlanes = extractFrustumPlanes(lightMatrix, shadowPlanes);
      try {
        return originalDrawShadowCasters(lightMatrix, resolution, mainMap);
      } finally {
        activeShadowPlanes = previousShadowPlanes;
      }
    };
  }

  renderer.drawBatch = function drawBatchWithClusterCulling(batch, textured = false, selection = null, levelSet = batch) {
    const part = batch.parts?.[0];
    const meshlets = part?.meshlets;
    const eligible = active
      && meshlets
      && batch.instanceCount === 1
      && batch.cullable
      && !batch.skin
      && !batch.morph
      && !batch.crowd
      && !batch.flushOrder
      && (!activeShadowPlanes || cullShadows);

    if (!eligible) {
      return originalDrawBatch(batch, textured, selection, levelSet);
    }
    const previousContext = activeBatchContext;
    activeBatchContext = { batch, meshlets, part };
    try {
      return originalDrawBatch(batch, textured, selection, levelSet);
    } finally {
      activeBatchContext = previousContext;
    }
  };

  renderer.backend.drawIndexedInstanced = function drawIndexedWithClusterCulling(indexCount, instanceCount, firstIndex = 0) {
    const batchContext = activeBatchContext;
    if (!batchContext || firstIndex !== 0 || instanceCount !== 1 || indexCount !== batchContext.meshlets.triangleCount * 3) {
      return originalDrawIndexedInstanced(indexCount, instanceCount, firstIndex);
    }
    const { batch, meshlets } = batchContext;
    const planes = activeShadowPlanes ?? renderer.frustumPlanes;
    const eye = activeShadowPlanes ? null : activeEye;
    const useCones = cullCones && !activeShadowPlanes && !activeOrthographic;
    const modelMatrix = batch.parts[0].matrix ?? batch.instanceData.subarray(0, 16);
    const margin = batch.swayReach ? batch.swayReach * Math.abs(renderer.windState?.strength ?? 0) : 0;
    const cullResult = cullMeshlets(meshlets, {
      planes,
      eye,
      modelMatrix,
      doubleSided: batch.doubleSided,
      mirrored: batch.mirrored,
      cullCones: useCones,
      margin,
      out: cullOutputByMeshlets.get(meshlets),
    });
    cullOutputByMeshlets.set(meshlets, cullResult);

    if (!activeShadowPlanes) {
      frameStats.drawnTriangles += cullResult.visibleTriangles;
      frameStats.totalTriangles += cullResult.totalTriangles;
      frameStats.visibleClusters += cullResult.visibleClusters;
      frameStats.totalClusters += cullResult.totalClusters;
      frameStats.frustumCulled += cullResult.frustumCulled;
      frameStats.coneCulled += cullResult.coneCulled;
    }

    drawBatchWithMeshlets(batchContext, instanceCount, cullResult.rangeCount, cullResult.firstIndices, cullResult.byteOffsets, cullResult.counts);
  };

  if (originalReplaceParts) {
    renderer.replaceParts = function replacePartsWithClusterCulling(parts, options) {
      releaseGpuResources(context, gpuResources);
      return originalReplaceParts(parts, options);
    };
  }

  renderer.dispose = function disposeWithClusterCulling() {
    releaseGpuResources(context, gpuResources);
    renderer.render = originalRender;
    if (originalDrawShadowCasters) renderer.drawShadowCasters = originalDrawShadowCasters;
    renderer.drawBatch = originalDrawBatch;
    if (originalReplaceParts) renderer.replaceParts = originalReplaceParts;
    renderer.backend.drawIndexedInstanced = originalDrawIndexedInstanced;
    renderer.dispose = originalDispose;
    return originalDispose();
  };

  return {
    getStats() {
      return { ...lastStats };
    },
    isEnabled() {
      return active;
    },
    setEnabled(value) {
      if (typeof value !== 'boolean') throw new TypeError('setEnabled expects true or false.');
      active = value;
      lastStats.enabled = value;
    },
    dispose() {
      releaseGpuResources(context, gpuResources);
      renderer.render = originalRender;
      if (originalDrawShadowCasters) renderer.drawShadowCasters = originalDrawShadowCasters;
      renderer.drawBatch = originalDrawBatch;
      if (originalReplaceParts) renderer.replaceParts = originalReplaceParts;
      renderer.backend.drawIndexedInstanced = originalDrawIndexedInstanced;
      renderer.dispose = originalDispose;
    },
  };
}
