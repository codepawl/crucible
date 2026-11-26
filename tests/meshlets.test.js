import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { extractFrustumPlanes } from '../src/render-culling.js';
import {
  buildGeometryMeshlets,
  addMeshletsToDenseParts,
  cullMeshlets,
  createWebGpuMeshletCuller,
  installClusterCulling,
  MESHLET_CULL_WGSL,
  DEFAULT_MESHLET_MINIMUM_TRIANGLES,
} from '../src/meshlets.js';

function createSphereGeometry(stacks, slices, radius = 1) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let stack = 0; stack <= stacks; stack++) {
    const phi = (stack / stacks) * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let slice = 0; slice <= slices; slice++) {
      const theta = (slice / slices) * Math.PI * 2;
      const x = Math.cos(theta) * sinPhi;
      const y = cosPhi;
      const z = Math.sin(theta) * sinPhi;
      positions.push(x * radius, y * radius, z * radius);
      normals.push(x, y, z);
    }
  }
  const ring = slices + 1;
  for (let stack = 0; stack < stacks; stack++) {
    for (let slice = 0; slice < slices; slice++) {
      const first = stack * ring + slice;
      const second = first + ring;
      indices.push(first, first + 1, second, second, first + 1, second + 1);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

function perspectivePlanes({ eye = [0, 0, 5], target = [0, 0, 0], fov = 45, aspect = 1, near = 0.1, far = 100 } = {}) {
  const view = mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);
  const projection = mat4.perspective(mat4.create(), (fov * Math.PI) / 180, aspect, near, far);
  const viewProjection = mat4.multiply(mat4.create(), projection, view);
  return extractFrustumPlanes(viewProjection, new Float32Array(24));
}

test('buildGeometryMeshlets returns null below minimumTriangles and preserves every triangle above it', async () => {
  const smallSphere = createSphereGeometry(16, 16, 1);
  assert.ok(smallSphere.indices.length / 3 < DEFAULT_MESHLET_MINIMUM_TRIANGLES);
  assert.equal(await buildGeometryMeshlets(smallSphere), null);

  const denseSphere = createSphereGeometry(64, 64, 2);
  const triangleCount = denseSphere.indices.length / 3;
  assert.ok(triangleCount >= DEFAULT_MESHLET_MINIMUM_TRIANGLES);

  const meshlets = await buildGeometryMeshlets(denseSphere);
  assert.ok(meshlets);
  assert.equal(meshlets.triangleCount, triangleCount);
  assert.ok(meshlets.meshletCount >= Math.ceil(triangleCount / 124));
  assert.equal(meshlets.indices.length, denseSphere.indices.length);

  // Every cluster stays within its limits and preserves exact original triangle vertex triples.
  const originalTriangles = new Set();
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
    const base = triangleIndex * 3;
    originalTriangles.add(`${denseSphere.indices[base]},${denseSphere.indices[base + 1]},${denseSphere.indices[base + 2]}`);
  }
  const rebuiltTriangles = new Set();
  let sumCounts = 0;
  for (let clusterIndex = 0; clusterIndex < meshlets.meshletCount; clusterIndex++) {
    const offset = meshlets.offsets[clusterIndex];
    const count = meshlets.counts[clusterIndex];
    assert.ok(count >= 3 && count <= meshlets.maxTriangles * 3);
    assert.equal(count % 3, 0);
    sumCounts += count;
    const sphereRadius = meshlets.spheres[clusterIndex * 4 + 3];
    assert.ok(Number.isFinite(sphereRadius) && sphereRadius > 0);
    for (let index = offset; index < offset + count; index += 3) {
      rebuiltTriangles.add(`${meshlets.indices[index]},${meshlets.indices[index + 1]},${meshlets.indices[index + 2]}`);
    }
  }
  assert.equal(sumCounts, denseSphere.indices.length);
  assert.equal(rebuiltTriangles.size, originalTriangles.size);

  // Repeated calls return the cached WeakMap build when indices and positions match.
  const second = await buildGeometryMeshlets(denseSphere);
  assert.equal(second, meshlets);
});

test('addMeshletsToDenseParts skips sparse and ineligible parts and shares builds per geometry', async () => {
  const sparse = createSphereGeometry(8, 8, 1);
  const sparseParts = [{ name: 'sparse', geometry: sparse, matrix: new Float32Array(16) }];
  assert.equal(await addMeshletsToDenseParts(sparseParts), sparseParts);

  const dense = createSphereGeometry(64, 64, 1);
  const skinnedPart = { name: 'skinned', geometry: dense, skin: {}, matrix: new Float32Array(16) };
  const rigidA = { name: 'rigid-a', geometry: dense, matrix: new Float32Array(16) };
  const rigidB = { name: 'rigid-b', geometry: dense, matrix: new Float32Array(16) };
  const result = await addMeshletsToDenseParts([skinnedPart, rigidA, rigidB]);

  assert.equal(result[0], skinnedPart);
  assert.equal(result[0].meshlets, undefined);
  assert.ok(result[1].meshlets);
  assert.equal(result[1].meshlets, result[2].meshlets);
});

test('cullMeshlets culls off-frustum and backfacing clusters while respecting doubleSided, mirrored and non-uniform scale', async () => {
  const denseSphere = createSphereGeometry(64, 64, 2);
  const meshlets = await buildGeometryMeshlets(denseSphere);

  // Looking at the sphere center from z=6 sees roughly the front hemisphere (~50% backface-culled).
  const eyeFront = [0, 0, 6];
  const planesFront = perspectivePlanes({ eye: eyeFront, target: [0, 0, 0], fov: 60 });
  const frontCulled = cullMeshlets(meshlets, { planes: planesFront, eye: eyeFront });
  assert.ok(frontCulled.coneCulled > 0, 'backfacing clusters on the far hemisphere should be cone-culled');
  assert.ok(frontCulled.visibleTriangles < meshlets.triangleCount * 0.75);
  assert.ok(frontCulled.rangeCount < frontCulled.visibleClusters, 'Morton ordering coalesces spatially adjacent clusters');

  // Consecutive visible clusters are coalesced into contiguous index ranges.
  let rangeTriangles = 0;
  for (let rangeIndex = 0; rangeIndex < frontCulled.rangeCount; rangeIndex++) {
    assert.equal(frontCulled.byteOffsets[rangeIndex], frontCulled.firstIndices[rangeIndex] * 4);
    rangeTriangles += frontCulled.counts[rangeIndex] / 3;
  }
  assert.equal(rangeTriangles, frontCulled.visibleTriangles);

  // Looking away from the sphere frustum-culls every cluster.
  const planesAway = perspectivePlanes({ eye: [0, 0, 6], target: [0, 0, 12], fov: 45 });
  const awayResult = cullMeshlets(meshlets, { planes: planesAway, eye: [0, 0, 6] });
  assert.equal(awayResult.visibleClusters, 0);
  assert.equal(awayResult.rangeCount, 0);
  assert.equal(awayResult.frustumCulled, meshlets.meshletCount);

  // doubleSided, mirrored and non-uniform scale skip cone culling.
  assert.equal(cullMeshlets(meshlets, { planes: planesFront, eye: eyeFront, doubleSided: true }).coneCulled, 0);
  assert.equal(cullMeshlets(meshlets, { planes: planesFront, eye: eyeFront, mirrored: true }).coneCulled, 0);
  const nonUniform = new Float32Array([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(cullMeshlets(meshlets, { planes: planesFront, eye: eyeFront, modelMatrix: nonUniform }).coneCulled, 0);

  // Reusing the same output object yields identical counts.
  const reused = cullMeshlets(meshlets, { planes: planesFront, eye: eyeFront, out: frontCulled });
  assert.equal(reused, frontCulled);
  assert.equal(reused.visibleTriangles, rangeTriangles);
});

test('createWebGpuMeshletCuller dispatches compute workgroups and cleans up buffers', async () => {
  const denseSphere = createSphereGeometry(64, 64, 1);
  const meshlets = await buildGeometryMeshlets(denseSphere);
  const createdBuffers = [];
  const calls = [];
  const mockDevice = {
    queue: {
      writeBuffer(buffer, offset, data) {
        calls.push({ kind: 'writeBuffer', buffer, offset, byteLength: data.byteLength });
      },
    },
    createBuffer(descriptor) {
      const buffer = { ...descriptor, destroyed: false, destroy() { this.destroyed = true; } };
      createdBuffers.push(buffer);
      return buffer;
    },
    createShaderModule({ code }) {
      assert.ok(code.includes('@compute @workgroup_size(64)'));
      assert.equal(code, MESHLET_CULL_WGSL);
      return {};
    },
    createComputePipeline(descriptor) {
      assert.equal(descriptor.compute.entryPoint, 'cullClusters');
      return { getBindGroupLayout: () => ({}) };
    },
    createBindGroup({ entries }) {
      assert.equal(entries.length, 6);
      return {};
    },
  };
  const mockEncoder = {
    beginComputePass() {
      return {
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups(count) {
          calls.push({ kind: 'dispatch', count });
        },
        end() {
          calls.push({ kind: 'end' });
        },
      };
    },
  };

  const culler = createWebGpuMeshletCuller(mockDevice, meshlets);
  assert.equal(culler.meshletCount, meshlets.meshletCount);
  assert.equal(createdBuffers.length, 6);

  const planes = perspectivePlanes();
  culler.cull(mockEncoder, { planes, eye: [0, 0, 5] });
  const dispatch = calls.find(entry => entry.kind === 'dispatch');
  assert.equal(dispatch.count, Math.ceil(meshlets.meshletCount / 64));

  culler.dispose();
  assert.ok(createdBuffers.every(buffer => buffer.destroyed));
});

function createMockRenderer(part, { withMultiDraw = true } = {}) {
  const vaoList = [];
  const bufferList = [];
  const multiDrawCalls = [];
  const fallbackDrawCalls = [];
  const batch = {
    parts: [part],
    instanceCount: 1,
    instanceBuffer: { id: 'inst' },
    instanceData: part.matrix,
    cullable: true,
    doubleSided: false,
    mirrored: false,
    vertexArray: { id: 'batch-vao' },
    indexCount: part.geometry.indices.length,
  };
  const context = {
    TRIANGLES: 4,
    UNSIGNED_INT: 5125,
    ELEMENT_ARRAY_BUFFER: 34963,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    createVertexArray() {
      const vao = { deleted: false };
      vaoList.push(vao);
      return vao;
    },
    deleteVertexArray(vao) {
      vao.deleted = true;
    },
    bindVertexArray() {},
    createBuffer() {
      const buffer = { deleted: false };
      bufferList.push(buffer);
      return buffer;
    },
    deleteBuffer(buffer) {
      buffer.deleted = true;
    },
    bindBuffer() {},
    bufferData() {},
    getExtension(name) {
      if (name !== 'WEBGL_multi_draw' || !withMultiDraw) return null;
      return {
        multiDrawElementsWEBGL(mode, counts, countsOffset, type, byteOffsets, offsetsOffset, drawCount) {
          multiDrawCalls.push({
            mode,
            counts: Array.from(counts.slice(countsOffset, countsOffset + drawCount)),
            byteOffsets: Array.from(byteOffsets.slice(offsetsOffset, offsetsOffset + drawCount)),
            drawCount,
          });
        },
      };
    },
  };
  const renderer = {
    context,
    frustumPlanes: new Float32Array(24),
    stats: { drawCalls: 0, trianglesDrawn: 0 },
    bindGeometryAttributes() {},
    pointInstanceAttributes() {},
    backend: {
      drawIndexedInstanced(indexCount, instanceCount, firstIndex = 0) {
        fallbackDrawCalls.push({ indexCount, instanceCount, firstIndex });
      },
    },
    render(frame) {
      const planes = perspectivePlanes({ eye: frame.eye, target: frame.target, fov: 60 });
      this.frustumPlanes.set(planes);
      this.stats = { drawCalls: 0, trianglesDrawn: 0 };
      this.drawBatch(batch, true);
    },
    drawShadowCasters() {
      this.drawBatch(batch, false);
    },
    drawBatch() {
      this.backend.drawIndexedInstanced(batch.indexCount, batch.instanceCount, 0);
    },
    replaceParts() {},
    dispose() {},
  };
  return { renderer, batch, vaoList, bufferList, multiDrawCalls, fallbackDrawCalls };
}

test('installClusterCulling culls via WEBGL_multi_draw, falls back cleanly, disables, and frees GPU buffers', async () => {
  const denseSphere = createSphereGeometry(64, 64, 2);
  const meshlets = await buildGeometryMeshlets(denseSphere);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const part = { name: 'sphere', geometry: denseSphere, material: {}, matrix: identity, meshlets };

  const { renderer, vaoList, bufferList, multiDrawCalls, fallbackDrawCalls } = createMockRenderer(part, { withMultiDraw: true });
  const controller = installClusterCulling(renderer);

  renderer.render({ eye: [0, 0, 6], target: [0, 0, 0] });
  const stats = controller.getStats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.multiDrawUsed, true);
  assert.ok(stats.coneCulled > 0);
  assert.equal(stats.drawnTriangles, renderer.stats.trianglesDrawn);
  assert.equal(multiDrawCalls.length, 1);
  assert.equal(fallbackDrawCalls.length, 0);

  // Disabling sends the original full draw call untouched.
  controller.setEnabled(false);
  renderer.render({ eye: [0, 0, 6], target: [0, 0, 0] });
  assert.equal(fallbackDrawCalls.length, 1);
  assert.equal(fallbackDrawCalls[0].indexCount, denseSphere.indices.length);

  // Fallback without WEBGL_multi_draw issues individual range draws.
  const withoutExtension = createMockRenderer(part, { withMultiDraw: false });
  const fallbackController = installClusterCulling(withoutExtension.renderer);
  withoutExtension.renderer.render({ eye: [0, 0, 6], target: [0, 0, 0] });
  const fallbackStats = fallbackController.getStats();
  assert.equal(fallbackStats.multiDrawUsed, false);
  assert.ok(withoutExtension.fallbackDrawCalls.length >= 1);
  assert.equal(fallbackStats.drawCalls, withoutExtension.fallbackDrawCalls.length);

  // replaceParts and dispose release allocated VAOs and EBOs.
  renderer.replaceParts([]);
  assert.ok(vaoList.every(vao => vao.deleted));
  assert.ok(bufferList.every(buffer => buffer.deleted));
  renderer.dispose();
  fallbackController.dispose();
});

test('installClusterCulling validates input options', async () => {
  await assert.rejects(() => buildGeometryMeshlets(null), /geometry/);
  await assert.rejects(() => buildGeometryMeshlets(createSphereGeometry(8, 8), { minimumTriangles: 0 }), /minimumTriangles/);
  assert.throws(() => cullMeshlets({}, { planes: new Float32Array(24) }), /cullMeshlets/);
  assert.throws(() => createWebGpuMeshletCuller({}, null), /GPUDevice/);
  assert.throws(() => installClusterCulling({}), /CrucibleRenderer/);
});
