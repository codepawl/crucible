import { backendFor } from './glaze-backend.js';
import { assertClosedMesh } from './local-volume-parts.js';

// The rasterizer's half of a local volume with shape "mesh" and fit "mesh" (issue 807). Before the post pass, each such part is drawn
// without culling into a layer of one float target, and the post shader reads the result per pixel. A ray crosses a closed mesh an even
// number of times, and the length it spends inside is the sum over the back faces of (distance - the distance of each front face):
//   channel R  adds +distance at a back face and -distance at a front face, each clamped to [0, distance of the first surface];
//   channel G  keeps the nearest front face distance (the entry, used to order the volumes).
// That sum is exact for any number of shells and any shape, so there is no shell limit. The post shader then integrates the volume
// over that length in closed form, which is exact because a mesh volume has the same density everywhere inside (no falloff, no noise).
// Geometry far past the far plane is clipped, so a ray can meet a front face and lose its back face; the post shader repairs that.
// The cost is two draws of the part per frame, so a scene without mesh volumes pays nothing.
// Limits: the mesh must be closed and rigid; geometry nearer than the camera's near plane is clipped, so a ray loses the stretch
// between the eye and the near plane; the target is as wide as the canvas and as tall as the canvas times the number of mesh volumes.

const MESH_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec3 position;
uniform mat4 viewProjection;
uniform mat4 model;
out vec3 worldPosition;
void main() {
  vec4 world = model * vec4(position, 1.0);
  worldPosition = world.xyz;
  gl_Position = viewProjection * world;
}`;

const MESH_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec3 worldPosition;
uniform sampler2D sceneDepth;
uniform mat4 inverseViewProjection;
uniform vec3 eye;
uniform float orthographic;
uniform vec2 resolution;
uniform float layerOffset;
uniform float entryPass;
out vec4 result;
void main() {
  vec2 pixel = vec2(gl_FragCoord.x, gl_FragCoord.y - layerOffset);
  vec2 clipXY = pixel / resolution * 2.0 - 1.0;
  vec4 farPoint = inverseViewProjection * vec4(clipXY, 1.0, 1.0);
  vec4 nearPoint = inverseViewProjection * vec4(clipXY, -1.0, 1.0);
  vec3 origin = orthographic > 0.5 ? nearPoint.xyz / nearPoint.w : eye;
  vec3 direction = normalize(farPoint.xyz - origin * farPoint.w);
  float depth = texelFetch(sceneDepth, ivec2(pixel), 0).r;
  vec4 surfacePoint = inverseViewProjection * vec4(clipXY, depth * 2.0 - 1.0, 1.0);
  float surfaceDistance = 1e30;
  if (surfacePoint.w > 0.0) surfaceDistance = max(0.0, dot(surfacePoint.xyz - origin * surfacePoint.w, direction) / surfacePoint.w);
  float distanceAlongRay = clamp(dot(worldPosition - origin, direction), 0.0, surfaceDistance);
  if (entryPass > 0.5) result = vec4(0.0, gl_FrontFacing ? distanceAlongRay : 1e30, 0.0, 0.0);
  else result = vec4(gl_FrontFacing ? -distanceAlongRay : distanceAlongRay, 0.0, 0.0, 0.0);
}`;

const UNIFORM_NAMES = ['viewProjection', 'model', 'sceneDepth', 'inverseViewProjection', 'eye', 'orthographic', 'resolution', 'layerOffset', 'entryPass'];
const NO_ENTRY = 1e30;

// Positive when the triangles wind counter-clockwise seen from outside, which is what the draw's front faces rely on.
function signedVolume(positions, indices) {
  let total = 0;
  for (let corner = 0; corner < indices.length; corner += 3) {
    const a = indices[corner] * 3;
    const b = indices[corner + 1] * 3;
    const thirdVertexOffset = indices[corner + 2] * 3;
    total += positions[a] * (positions[b + 1] * positions[thirdVertexOffset + 2] - positions[b + 2] * positions[thirdVertexOffset + 1])
      + positions[a + 1] * (positions[b + 2] * positions[thirdVertexOffset] - positions[b] * positions[thirdVertexOffset + 2])
      + positions[a + 2] * (positions[b] * positions[thirdVertexOffset + 1] - positions[b + 1] * positions[thirdVertexOffset]);
  }
  return total;
}

function matrixDeterminant(matrix) {
  return matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9])
    + matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]);
}

function uploadGeometry(backend, geometry) {
  const positions = geometry.positions instanceof Float32Array ? geometry.positions : new Float32Array(geometry.positions);
  const shortIndices = geometry.indices instanceof Uint16Array;
  const indices = shortIndices || geometry.indices instanceof Uint32Array ? geometry.indices : new Uint32Array(geometry.indices);
  const positionBuffer = backend.createBuffer();
  backend.uploadBuffer('array', positionBuffer, positions);
  const indexBuffer = backend.createBuffer();
  backend.uploadBuffer('element', indexBuffer, indices);
  const vertexArray = backend.createVertexArray([{ buffer: positionBuffer, size: 3 }], indexBuffer);
  return {
    vertexArray,
    buffers: [positionBuffer, indexBuffer],
    count: geometry.indices.length,
    shortIndices,
    insideOut: signedVolume(geometry.positions, geometry.indices) < 0,
  };
}

const wrappedRenderers = new WeakSet();

function createState(renderer, backend) {
  if (!backend.extension('EXT_float_blend')) throw new Error('Local volumes with fit "mesh" need the WebGL extension EXT_float_blend, which this browser does not offer; use fit "bounds"');
  const program = backend.compileProgram(MESH_VERTEX, MESH_FRAGMENT);
  const uniforms = Object.fromEntries(UNIFORM_NAMES.map(name => [name, backend.uniformLocation(program, name)]));
  const state = { program, uniforms, geometries: new Map(), target: null, disposed: false };
  // The renderer's dispose gains this step here, so the core carries no call for a pass most scenes never create.
  if (!wrappedRenderers.has(renderer)) {
    wrappedRenderers.add(renderer);
    const disposeRenderer = renderer.dispose.bind(renderer);
    renderer.dispose = () => {
      if (renderer.meshVolumePass) disposeMeshVolumePass(renderer, renderer.meshVolumePass);
      disposeRenderer();
    };
  }
  return state;
}

function allocateTarget(renderer, backend, state, layers) {
  const width = renderer.canvas.width;
  const height = renderer.canvas.height * layers;
  if (state.target?.width === width && state.target.height === height) return;
  const limit = backend.maxTextureSize();
  if (width > limit || height > limit) {
    throw new RangeError(`${layers} mesh volumes at ${width}x${renderer.canvas.height} need a ${width}x${height} buffer, past this device's limit of ${limit}; use fewer volumes with fit "mesh", a smaller canvas or fit "bounds"`);
  }
  releaseTarget(renderer, backend, state);
  const target = backend.createFramebufferTarget({ width, height, colorFormat: 'rg32f', clamp: true });
  if (!target.complete) {
    backend.deleteFramebuffer(target.framebuffer);
    backend.deleteTexture(target.colorTexture);
    throw new Error('The mesh volume buffer could not be allocated; use fit "bounds" or a smaller canvas');
  }
  state.target = { texture: target.colorTexture, framebuffer: target.framebuffer, width, height };
  renderer.renderTargets.record('meshVolumes', { width, height, format: 'RG32F' });
}

function releaseTarget(renderer, backend, state) {
  if (!state.target) return;
  backend.deleteTexture(state.target.texture);
  backend.deleteFramebuffer(state.target.framebuffer);
  state.target = null;
  renderer.renderTargets.release('meshVolumes');
}

function releaseGeometry(backend, gpu) {
  backend.deleteVertexArray(gpu.vertexArray);
  gpu.buffers.forEach(buffer => backend.deleteBuffer(buffer));
}

// A part whose geometry was replaced or removed no longer draws, so its buffers go.
function pruneGeometries(backend, state, meshParts) {
  const inUse = new Set(meshParts.map(({ part }) => part.geometry));
  for (const [geometry, gpu] of state.geometries) {
    if (inUse.has(geometry)) continue;
    releaseGeometry(backend, gpu);
    state.geometries.delete(geometry);
  }
}

function drawPart(backend, state, part) {
  let gpu = state.geometries.get(part.geometry);
  if (!gpu) {
    gpu = uploadGeometry(backend, part.geometry);
    state.geometries.set(part.geometry, gpu);
  }
  const matrix = part.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  backend.uniformMatrix4fv(state.uniforms.model, matrix);
  backend.setFrontFaceClockwise(gpu.insideOut !== matrixDeterminant(matrix) < 0);
  backend.bindVertexArray(gpu.vertexArray);
  backend.drawIndexed(gpu.count, gpu.shortIndices);
}

/**
 * Draws every fit "mesh" volume of the frame into the mesh buffer: layer n holds the volume with slice n, R the length inside along
 * each pixel's ray and G the nearest entry. The caller rebinds the post framebuffer afterwards through the restore this makes.
 * Returns the texture, or null when the frame has no such volume.
 */
export function drawMeshVolumes(renderer, frame) {
  const backend = backendFor(renderer);
  const meshParts = renderer.localVolumeBuffers?.meshParts ?? [];
  if (meshParts.length === 0) {
    if (renderer.meshVolumePass) pruneGeometries(backend, renderer.meshVolumePass, meshParts);
    return null;
  }
  const state = (renderer.meshVolumePass ??= createState(renderer, backend));
  for (const { part, label } of meshParts) assertClosedMesh(part, label);
  pruneGeometries(backend, state, meshParts);
  allocateTarget(renderer, backend, state, meshParts.length);
  const { width, height } = renderer.canvas;
  const blendWasOn = backend.isBlendEnabled();
  backend.bindFramebuffer(state.target.framebuffer);
  backend.setRenderState({ depthTest: false, cullFace: false, blend: true, blendMode: 'one', colorMask: [true, true, true, true] });
  backend.clearColorBuffer(0, [0, NO_ENTRY, 0, 0]);
  backend.useProgram(state.program);
  backend.bindTextureUnit(1, renderer.depthTexture);
  backend.uniform1i(state.uniforms.sceneDepth, 1);
  backend.uniformMatrix4fv(state.uniforms.viewProjection, renderer.viewProjection);
  backend.uniformMatrix4fv(state.uniforms.inverseViewProjection, renderer.inverseViewProjection);
  backend.uniform3fv(state.uniforms.eye, frame.eye);
  backend.uniform1f(state.uniforms.orthographic, frame.projection === 'orthographic' ? 1 : 0);
  backend.uniform2f(state.uniforms.resolution, width, height);
  meshParts.forEach(({ part }, slice) => {
    backend.setViewport(width, height, 0, slice * height);
    backend.uniform1f(state.uniforms.layerOffset, slice * height);
    backend.uniform1f(state.uniforms.entryPass, 0);
    backend.setRenderState({ blendEquation: 'add', colorMask: [true, false, false, false] });
    drawPart(backend, state, part);
    backend.uniform1f(state.uniforms.entryPass, 1);
    backend.setRenderState({ blendEquation: 'min', colorMask: [false, true, false, false] });
    drawPart(backend, state, part);
  });
  backend.setFrontFaceClockwise(false);
  backend.setRenderState({ colorMask: [true, true, true, true], blendEquation: 'add', blend: blendWasOn });
  backend.bindVertexArray(null);
  backend.bindFramebuffer(frame.outputFramebuffer ?? null);
  backend.setViewport(width, height);
  return state.target.texture;
}

function disposeMeshVolumePass(renderer, state) {
  if (state.disposed) return;
  state.disposed = true;
  const backend = backendFor(renderer);
  releaseTarget(renderer, backend, state);
  state.geometries.forEach(gpu => releaseGeometry(backend, gpu));
  state.geometries.clear();
  backend.deleteProgram(state.program);
  if (renderer.meshVolumePass === state) renderer.meshVolumePass = null;
}
