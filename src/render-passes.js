import { mat4 } from 'gl-matrix';
import { applyProjection } from './camera.js';
import { fullscreenVertex } from './gl-program.js';
import { backendFor } from './glaze-backend.js';
import { invalidField } from './field-error.js';
import './lighting-pass-shader.js';

// Render passes draw raw material data or isolated lighting/auxiliary terms instead of the lit beauty image.
// The shader branches live in the main fragment shader behind `renderPass` and `lightingPass`, which compile on the first
// pass request; this addon owns the target, the copy to the canvas, the per-pass uniforms and the Cryptomatte manifest.

/** The shader's `renderPassMode` for each pass name. agent-scene-capabilities.js lists the same names. */
export const RENDER_PASS_MODES = Object.freeze({
  albedo: 1, normal: 2, emission: 3, depth: 4, objectId: 5,
  diffuse: 6, glossy: 7, shadow: 8, ao: 9, mist: 10,
  position: 11, velocity: 12, uv: 13, transmission: 14, volume: 15, environment: 16, cryptomatte: 17, aov: 18,
  roughness: 19, metallic: 20, lighting: 21,
});
// Passes drawn as another pass and then finished by their own addon: wireframe is the diffuse pass with polygon edges over it (wireframe-pass.js).
const COMPOSED_PASSES = Object.freeze({ wireframe: 'diffuse' });
// Background pixels: depth reads as the far limit, and shadow, ao and mist as open sky (one), wireframe as light grey for dark edges
// to read against; every other pass reads zero, and object ID zero means no object.
const PASS_BACKGROUNDS = Object.freeze({ depth: [1, 1, 0, 1], shadow: [1, 1, 1, 1], ao: [1, 1, 1, 1], mist: [1, 1, 1, 1], wireframe: [0.82, 0.84, 0.86, 1] });
// Modes above this one run the lit shader (lighting-pass-shader.js).
const LAST_RAW_PASS_MODE = 5;
const DEFAULT_BACKGROUND = Object.freeze([0, 0, 0, 1]);
const IDENTITY_MAT4 = mat4.create();

/** Deterministic non-zero float ID in [1/255, 1] for Cryptomatte object/material IDs, matching cryptoHash() in GLSL. */
export function cryptomatteValue(id) {
  let hash = Math.imul(id >>> 0, 0x9e3779b9) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  return ((hash % 255) + 1) / 255;
}

/** Deterministic 8-hex-character FNV-1a manifest hash for a Cryptomatte object or material name. */
export function cryptomatteHashHex(name) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index++) {
    hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Copies a pass texture to the canvas byte for byte: one texel per pixel, no filtering, no grading.
const passCopyFragment = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
out vec4 outputColor;
void main() { outputColor = vec4(texelFetch(sourceTexture, ivec2(gl_FragCoord.xy), 0).rgb, 1.0); }`;

// A float target keeps the pass values as half floats (frame.passFloat) for 16-bit PNG and EXR output; the shader writes the same values.
// With reversed-Z (reversed-depth.js) the beauty pass keeps depth in a 32-bit float buffer, so a pass draws into the same format.
function createPassTarget(backend, width, height, float = false, floatDepth = false) {
  if (float && !backend.extension('EXT_color_buffer_float')) throw new Error('16-bit PNG and EXR output need EXT_color_buffer_float. Use format png.');
  const created = backend.createFramebufferTarget({ width, height, hdr: float, depth: true, floatDepth });
  if (!created.complete) {
    backend.deleteFramebuffer(created.framebuffer);
    backend.deleteRenderbuffer(created.depthRenderbuffer);
    backend.deleteTexture(created.colorTexture);
    throw new Error('Render pass framebuffer allocation failed. Choose a lower quality preset.');
  }
  return { texture: created.colorTexture, depth: created.depthRenderbuffer, framebuffer: created.framebuffer, float, floatDepth };
}

/**
 * Lets `renderer.render({ ...camera, pass })` draw one pass. Passes draw without multisampling into their own target,
 * so object IDs and normals stay exact at silhouettes. Only opaque and cutout parts appear (plus transmissive parts in
 * the `transmission` pass). `passDepthRange` is the number of metres that depth values 0 to 65535 span (default 100).
 */
export function installRenderPasses(renderer) {
  if (renderer.passSupport) return renderer;
  let fallbackBackend = null;
  function backend() {
    if (renderer.backend && typeof renderer.backend.name === 'string' && typeof renderer.backend.createFramebufferTarget === 'function') return renderer.backend;
    return fallbackBackend ??= backendFor(renderer);
  }
  let target = null;
  let copyProgram = null;
  let copyTextureUniform = null;
  let cachedProgram = null;
  let passUniforms = null;
  let frameMaterials = null;
  const deltaBuffer = new Float32Array(8 * 16);
  const materialIdBuffer = new Float32Array(32);

  function uniformsFor(program) {
    if (cachedProgram === program && passUniforms) return passUniforms;
    const activeBackend = backend();
    cachedProgram = program;
    passUniforms = {
      passFloatOutput: activeBackend.uniformLocation(program, 'passFloatOutput'),
      passCurrentViewProjection: activeBackend.uniformLocation(program, 'passCurrentViewProjection'),
      passPreviousViewProjection: activeBackend.uniformLocation(program, 'passPreviousViewProjection'),
      passObjectDeltas: activeBackend.uniformLocation(program, 'passObjectDeltas[0]'),
      passVolumeDensity: activeBackend.uniformLocation(program, 'passVolumeDensity'),
      passVolumeColor: activeBackend.uniformLocation(program, 'passVolumeColor'),
      passMaterialIds: activeBackend.uniformLocation(program, 'passMaterialIds[0]'),
      passTransmission: activeBackend.uniformLocation(program, 'passTransmission'),
      passMaterialAov: activeBackend.uniformLocation(program, 'passMaterialAov'),
      hasPassAuxMap: activeBackend.uniformLocation(program, 'hasPassAuxMap'),
    };
    return passUniforms;
  }

  function releaseTargets() {
    if (!target) return;
    const activeBackend = backend();
    activeBackend.deleteTexture(target.texture);
    activeBackend.deleteRenderbuffer(target.depth);
    activeBackend.deleteFramebuffer(target.framebuffer);
    renderer.renderTargets.release('passColor', 'passDepth');
    target = null;
  }

  function dispose() {
    releaseTargets();
    if (copyProgram) backend().deleteProgram(copyProgram);
    copyProgram = null;
    cachedProgram = null;
    passUniforms = null;
  }

  function prepare(frame) {
    const mode = RENDER_PASS_MODES[COMPOSED_PASSES[frame.pass] ?? frame.pass];
    if (!mode) throw new RangeError(`Unknown render pass: ${frame.pass}. Use ${[...Object.keys(RENDER_PASS_MODES), ...Object.keys(COMPOSED_PASSES)].join(', ')}.`);
    if (renderer.benchmark) throw new Error('Render passes are unavailable in benchmark mode.');
    if (mode === RENDER_PASS_MODES.velocity) validateVelocityPassInputs(frame);
    const depthRange = frame.passDepthRange ?? 1;
    if (!Number.isFinite(depthRange) || depthRange <= 0) throw new RangeError('Pass depth range must be positive and finite.');
    const activeBackend = backend();
    renderer.requireFeatureNames(mode > LAST_RAW_PASS_MODE ? ['renderPass', 'lightingPass'] : ['renderPass']);
    if (!copyProgram) {
      copyProgram = activeBackend.compileProgram(fullscreenVertex, passCopyFragment);
      copyTextureUniform = activeBackend.uniformLocation(copyProgram, 'sourceTexture');
    }
    const float = frame.passFloat === true;
    const floatDepth = renderer.reversedDepth === true;
    if (target && (target.float !== float || target.floatDepth !== floatDepth)) releaseTargets();
    if (!target) {
      const { width, height } = renderer.canvas;
      target = createPassTarget(activeBackend, width, height, float, floatDepth);
      renderer.renderTargets.record('passColor', { width, height, format: float ? 'RGBA16F' : 'RGBA8' });
      renderer.renderTargets.record('passDepth', { width, height, format: floatDepth ? 'DEPTH_COMPONENT32F' : 'DEPTH_COMPONENT24' });
    }
    return mode;
  }

  function copyToCanvas() {
    // An addon finishes the pass in its target first, while the depth state of the pass is still set (wireframe-pass.js).
    renderer.passSupport.overlay?.();
    backend().drawFullscreenTexture({
      framebuffer: null,
      width: renderer.canvas.width,
      height: renderer.canvas.height,
      program: copyProgram,
      textureUniform: copyTextureUniform,
      texture: target.texture,
    });
  }

  function drawsInPass(batch, passMode) {
    return renderer.drawsInOpaqueLoop(batch) || (passMode === RENDER_PASS_MODES.transmission && batch.layerState[9] > 0);
  }

  // Part names by object ID minus one, in the order the object ID pass numbers them (draw order, grouped by geometry).
  function objectParts() {
    return renderer.batches.filter(batch => renderer.takesObjectIds(batch)).flatMap(batch => batch.parts);
  }

  function objectNames() {
    return objectParts().map(part => part.name);
  }

  // Object IDs by owning node, so a prop made of several parts reads as one entry. A part of a placed asset names its
  // placement in `group`; any other part is its own node.
  function objectNodes() {
    // No prototype, so a node named "constructor" or "__proto__" is an ordinary entry.
    const nodes = Object.create(null);
    objectParts().forEach((part, index) => {
      const key = part.group ?? part.name;
      if (!nodes[key]) nodes[key] = [];
      nodes[key].push(index + 1);
    });
    return nodes;
  }

  function materialTable() {
    const table = new Map();
    for (const batch of renderer.batches) {
      if (!renderer.takesObjectIds(batch)) continue;
      for (const part of batch.parts) {
        const material = part.material;
        const key = material.id ?? material.name ?? material;
        if (!table.has(key)) {
          const id = table.size + 1;
          const name = typeof key === 'string' ? key : `material-${id}`;
          table.set(key, { id, name });
        }
      }
    }
    return table;
  }

  function cryptomatteManifest() {
    const objects = Object.fromEntries(objectNames().map((name, index) => [name, { id: index + 1, hash: cryptomatteHashHex(name), value: cryptomatteValue(index + 1) }]));
    const materials = Object.fromEntries([...materialTable().values()].map(({ id, name }) => [name, { id, hash: cryptomatteHashHex(name), value: cryptomatteValue(id) }]));
    return { objects, materials };
  }

  function previousViewProjectionFor(frame) {
    if (frame.previousViewProjection) return frame.previousViewProjection;
    if (!frame.previousCamera) return renderer.viewProjection;
    const aspect = renderer.canvas.width / renderer.canvas.height;
    const camera = frame.previousCamera;
    const view = mat4.lookAt(mat4.create(), camera.eye, camera.target ?? [0, 1.2, 0], camera.up ?? [0, 1, 0]);
    const projection = applyProjection(mat4.create(), camera, aspect);
    return mat4.multiply(mat4.create(), projection, view);
  }

  // The velocity pass reads the previous camera, its view projection and the object motion matrices. Name the one that is not
  // what the pass reads, instead of failing inside gl-matrix or the texture upload later.
  function validateVelocityPassInputs(frame) {
    const eye = frame.previousCamera?.eye;
    if (frame.previousCamera && !(typeof eye?.length === 'number' && eye.length === 3 && Array.from(eye).every(Number.isFinite))) {
      throw invalidField('frame.previousCamera.eye', eye, '[x, y, z] as three finite numbers');
    }
    const viewProjection = frame.previousViewProjection;
    if (viewProjection && (typeof viewProjection.length !== 'number' || viewProjection.length !== 16 || !Array.from(viewProjection).every(Number.isFinite))) {
      throw invalidField('frame.previousViewProjection', viewProjection, 'sixteen finite numbers');
    }
    const matrices = frame.objectMotion?.matrices;
    if (matrices && !(matrices instanceof Float32Array)) {
      throw invalidField('frame.objectMotion.matrices', matrices, 'the Float32Array from packObjectMotion');
    }
  }

  function bindFrame(frame, environment, volume) {
    const activeBackend = backend();
    const uniforms = uniformsFor(renderer.program);
    const density = volume.density > 0 ? volume.density : (environment.fogDensity ?? 0.006);
    const color = volume.density > 0 ? volume.color : (environment.fogColor ?? [0.35, 0.43, 0.43]);
    activeBackend.uniform1f(uniforms.passFloatOutput, frame.passFloat ? 1 : 0);
    activeBackend.uniformMatrix4fv(uniforms.passCurrentViewProjection, renderer.viewProjection);
    activeBackend.uniformMatrix4fv(uniforms.passPreviousViewProjection, previousViewProjectionFor(frame));
    activeBackend.uniform1f(uniforms.passVolumeDensity, density);
    activeBackend.uniform3fv(uniforms.passVolumeColor, color);
    frameMaterials = materialTable();
  }

  function drawBatch(batch, passMode, frame, objectBase) {
    const materials = frameMaterials ?? materialTable();
    const activeBackend = backend();
    const uniforms = uniformsFor(renderer.program);
    const count = Math.min(batch.parts.length, 8);
    for (let index = 0; index < 8; index++) {
      const slot = deltaBuffer.subarray(index * 16, (index + 1) * 16);
      if (index < count && frame.objectMotion?.matrices) {
        const motionIndex = (objectBase + index) * 16;
        if (motionIndex + 16 <= frame.objectMotion.matrices.length) {
          slot.set(frame.objectMotion.matrices.subarray(motionIndex, motionIndex + 16));
          continue;
        }
      }
      if (index < count && frame.previousMatrices) {
        const name = batch.parts[index].name;
        const previous = frame.previousMatrices instanceof Map ? frame.previousMatrices.get(name) : frame.previousMatrices[name];
        const inverse = mat4.create();
        if (previous && mat4.invert(inverse, batch.parts[index].matrix)) {
          mat4.multiply(slot, previous, inverse);
          continue;
        }
      }
      slot.set(IDENTITY_MAT4);
    }
    activeBackend.uniformMatrix4fv(uniforms.passObjectDeltas, deltaBuffer);
    materialIdBuffer.fill(1);
    for (let index = 0; index < Math.min(batch.parts.length, 32); index++) {
      const material = batch.parts[index].material;
      materialIdBuffer[index] = materials.get(material.id ?? material.name ?? material)?.id ?? 1;
    }
    activeBackend.uniform1fv(uniforms.passMaterialIds, materialIdBuffer);
    activeBackend.uniform1f(uniforms.passTransmission, batch.layerState[9] ?? 0);
    const firstMaterial = batch.parts[0].material;
    const aov = firstMaterial.aov ?? (firstMaterial.aovMap ? [1, 1, 1] : [0, 0, 0]);
    activeBackend.uniform3f(uniforms.passMaterialAov, aov[0], aov[1], aov[2]);
    const auxDescriptor = passMode === RENDER_PASS_MODES.aov ? firstMaterial.aovMap
      : passMode === RENDER_PASS_MODES.transmission ? firstMaterial.transmissionMap
      : null;
    activeBackend.uniform1f(uniforms.hasPassAuxMap, auxDescriptor ? 1 : 0);
    const savedEmissiveTexture = batch.textures[4];
    if (auxDescriptor) batch.textures[4] = renderer.createTexture(auxDescriptor);
    try {
      const culled = passMode !== RENDER_PASS_MODES.objectId && passMode !== RENDER_PASS_MODES.cryptomatte;
      renderer.drawAlphaBatch(batch, true, culled);
    } finally {
      batch.textures[4] = savedEmissiveTexture;
    }
  }

  renderer.passSupport = {
    overlay: null,
    prepare,
    get framebuffer() { return target?.framebuffer ?? null; },
    // The pass colour of the last pass frame; object motion blur reads the object IDs from it.
    get texture() { return target?.texture ?? null; },
    background: pass => PASS_BACKGROUNDS[pass] ?? DEFAULT_BACKGROUND,
    copyToCanvas,
    drawsInPass,
    bindFrame,
    drawBatch,
    objectNames,
    objectNodes,
    cryptomatteManifest,
    releaseTargets,
    dispose,
  };
  return renderer;
}
