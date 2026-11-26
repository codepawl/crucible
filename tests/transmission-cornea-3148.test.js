import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mat3, mat4 } from 'gl-matrix';

import { createAgentScene } from '../src/agent-scene.js';
import { box } from '../src/geometry.js';
import { isClosedSurface, materialWithDerivedThickness } from '../src/glass-thickness.js';
import { drawLiquidPass } from '../src/liquid-renderer.js';
import { liquidFragmentSource } from '../src/shaders.js';
import '../src/liquid-shader.js';
import '../src/skinning.js';
import { MaterialSnapshot, SNAPSHOT_VALUE_FIELDS } from '../src/material-snapshot.js';
import { CrucibleRenderer, additiveBatchesBehindShells, groupParts } from '../src/renderer.js';

function scaledGeometry(geometry, factor) {
  return {
    positions: geometry.positions.map(value => value * factor),
    normals: new Float32Array(geometry.normals),
    indices: new Uint32Array(geometry.indices),
    uvs: new Float32Array((geometry.positions.length / 3) * 2),
  };
}

function makeMockGlContext() {
  const calls = [];
  const depthMasks = [];
  const cullChanges = [];
  const frontFaces = [];
  const blendFuncs = [];
  const draws = [];
  const constants = {
    DEPTH_TEST: 2929, CULL_FACE: 2884, BLEND: 3042, FRONT: 1028, BACK: 1029,
    CW: 2304, CCW: 2305, TEXTURE_2D: 3553, TEXTURE0: 33984,
    FRAMEBUFFER: 36160, READ_FRAMEBUFFER: 36008, DRAW_FRAMEBUFFER: 36009,
    COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256, COLOR_ATTACHMENT0: 36064,
    DEPTH_ATTACHMENT: 36096, FRAMEBUFFER_COMPLETE: 36053, RGBA8: 32856, RGBA16F: 34842,
    DEPTH_COMPONENT24: 33190, DEPTH_COMPONENT32F: 36012, DEPTH_COMPONENT: 6402,
    FLOAT: 5126, UNSIGNED_INT: 5125, TRIANGLES: 4, NEAREST: 9728, LINEAR: 9729,
    CLAMP_TO_EDGE: 33071, ONE: 1, SRC_ALPHA: 770, ONE_MINUS_SRC_ALPHA: 771, ZERO: 0,
    LESS: 513, GREATER: 516,
  };
  let nextId = 0;
  const context = new Proxy({}, {
    get(_, name) {
      if (name in constants) return constants[name];
      if (typeof name !== 'string' || /^[A-Z_0-9]+$/.test(name)) return 1;
      if (name === 'checkFramebufferStatus') return () => constants.FRAMEBUFFER_COMPLETE;
      if (name === 'getError') return () => 0;
      if (name === 'getParameter') return () => 0;
      return (...args) => {
        calls.push([name, ...args]);
        if (name === 'depthMask') depthMasks.push(args[0]);
        if (name === 'enable' && args[0] === constants.CULL_FACE) cullChanges.push(true);
        if (name === 'disable' && args[0] === constants.CULL_FACE) cullChanges.push(false);
        if (name === 'frontFace') frontFaces.push(args[0]);
        if (name === 'blendFuncSeparate') blendFuncs.push(args);
        if (name === 'drawElementsInstanced') draws.push(args);
        if (name.startsWith('create')) return { id: ++nextId };
        return null;
      };
    },
  });
  return { context, constants, calls, depthMasks, cullChanges, frontFaces, blendFuncs, draws };
}

function makeLiquidBatch({ name = 'glass', depthZ = 0, alphaMode = 'blend', opacity = 0.25, doubleSided = false, mirrored = false, transmission = 1, throughGlass = false }) {
  const layerState = new Float32Array(32);
  layerState[9] = transmission;
  layerState[10] = 1.4;
  layerState[11] = 0.5;
  layerState[12] = 10;
  layerState[13] = 1;
  layerState[14] = 1;
  layerState[15] = 1;
  const matrix = new Float32Array([mirrored ? -1 : 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, depthZ, 1]);
  const instanceData = new Float32Array(42);
  instanceData.set(matrix);
  return {
    alphaMode,
    opacity,
    doubleSided,
    mirrored,
    throughGlass,
    depthTest: true,
    pass: alphaMode === 'add' ? 'opaque' : 'liquid',
    layerState,
    mapState: [],
    textures: [],
    instanceCount: 1,
    indexCount: 36,
    instanceData,
    vertexArray: { name },
    parts: [{ name, geometry: box(0, 1), matrix, material: { color: [1, 1, 1], alphaMode, opacity, throughGlass, mediumContinues: true } }],
  };
}

function makeLiquidRenderer({ context, batches }) {
  return {
    context,
    canvas: { width: 128, height: 128 },
    batches,
    view: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    viewProjection: new Float32Array(16),
    lightProjection: new Float32Array(16),
    lighting: { keyColor: [1, 1, 1], ambientIntensity: 0.3 },
    multisampleFramebuffer: { id: 'msaa' },
    resolveFramebuffer: { id: 'resolve' },
    frameTexture: { id: 'frameTex' },
    liquidProgram: { id: 'liquidProgram' },
    liquidUniforms: new Proxy({}, { get: () => 0 }),
    withViewTransform: source => source,
    applyEnvironmentUniforms() {},
  };
}

test('tiny GLB meshes (1.2 cm eye scale) keep distinct vertices in isClosedSurface and KHR_materials_volume without thicknessFactor derives thickness (#3148)', () => {
  const tinyBox = scaledGeometry(box(0, 1), 0.0005);
  assert.equal(isClosedSurface(tinyBox.positions, tinyBox.indices, 0.0005), true);

  const glass = { transmission: 1, thickness: 0 };
  const volumeTintOnly = { extensions: { KHR_materials_transmission: { transmissionFactor: 1 }, KHR_materials_volume: { attenuationColor: [0.8, 0.9, 1], attenuationDistance: 1 } } };
  const derived = materialWithDerivedThickness(glass, volumeTintOnly, tinyBox, new Map());
  assert.ok(derived.thickness > 0, 'attenuation-only KHR_materials_volume still derives thickness');
  assert.equal(derived.mediumContinues, false);

  const explicitZero = { extensions: { KHR_materials_volume: { thicknessFactor: 0 } } };
  assert.equal(materialWithDerivedThickness(glass, explicitZero, tinyBox, new Map()), glass, 'explicit thicknessFactor 0 stays thin-walled');
});

test('drawLiquidPass sorts liquids back-to-front, honors doubleSided/mirrored, uses premultiplied blend for coverage, and skips depth writes for blended glass with trailing additive beams (#3148)', () => {
  const gl = makeMockGlContext();
  const frontCornea = makeLiquidBatch({ name: 'cornea', depthZ: -1, alphaMode: 'blend', opacity: 0.25, doubleSided: true, mirrored: true });
  const backLens = makeLiquidBatch({ name: 'lens', depthZ: -3, alphaMode: 'blend', opacity: 0.25 });
  const beam = makeLiquidBatch({ name: 'beam', depthZ: -2, alphaMode: 'add', opacity: 0.8, transmission: 0 });
  const renderer = makeLiquidRenderer({ context: gl.context, batches: [frontCornea, beam, backLens] });

  drawLiquidPass(renderer, {
    frame: { eye: [0, 0, 5] },
    environment: { daylight: 1, lightDirection: [0, 1, 0], fogColor: [0, 0, 0], fogDensity: 0, explosionCenter: [0, 0, 0] },
    assemblyAmount: 0,
    environmentMap: null,
    liquids: [frontCornea, backLens],
    foams: [],
    environmentSpecularUnit: 9,
    maximumDistance: 1e6,
    vertexSource: '',
    fragmentSource: '',
  });

  const drawnVaOrder = gl.calls.filter(([name]) => name === 'bindVertexArray').map(([, vao]) => vao?.name).filter(Boolean);
  assert.deepEqual(drawnVaOrder, ['lens', 'cornea'], 'inner lens draws before outer cornea');
  assert.ok(gl.cullChanges.includes(false), 'doubleSided batch disables CULL_FACE');
  assert.equal(gl.cullChanges.at(-1), true, 'CULL_FACE is restored after doubleSided draw');
  assert.deepEqual(gl.frontFaces, [gl.constants.CW, gl.constants.CCW], 'mirrored glass flips frontFace to CW and restores CCW');
  assert.deepEqual(gl.blendFuncs[0], [gl.constants.ONE, gl.constants.ONE_MINUS_SRC_ALPHA, gl.constants.ONE, gl.constants.ONE_MINUS_SRC_ALPHA], 'covering blended glass uses premultiplied blend');
  assert.deepEqual(gl.depthMasks, [false, true, false, true], 'blended glass skips depth write when additive beams draw after it');
  assert.match(liquidFragmentSource(), /diffuseShare = glass \? color \* \(1\.0 - transmissionShare\) \* \(1\.0 - metallic\) \* glassCoverage/);
});

test('throughGlass additive beams skip pre-glass attenuation, split batches, validate booleans, and suppress liquid depth writes (#3148)', () => {
  assert.ok(SNAPSHOT_VALUE_FIELDS.includes('throughGlass'));
  const regularMat = { color: [1, 1, 1], metallic: 0, roughness: 1, alphaMode: 'add' };
  const brightMat = { ...regularMat, throughGlass: true };
  assert.equal(MaterialSnapshot.of(brightMat).matches({ ...brightMat }), true);
  assert.equal(MaterialSnapshot.of(brightMat).matches(regularMat), false);

  const regularPart = { name: 'regular', geometry: box(0, 1), matrix: mat4.create(), material: regularMat };
  const brightPart = { name: 'bright', geometry: box(0, 1), matrix: mat4.create(), material: brightMat };
  assert.equal(groupParts([regularPart, brightPart]).length, 2, 'throughGlass splits batches');
  assert.throws(() => groupParts([{ ...regularPart, material: { ...regularMat, throughGlass: 'yes' } }]), TypeError);

  const scene = createAgentScene({
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'beam', color: [1, 0.8, 0.2], alphaMode: 'add', throughGlass: true }],
    nodes: [{ id: 'beam-node', geometry: 'box', material: 'beam' }],
  });
  assert.equal(scene.parts[0].material.throughGlass, true);

  const shell = makeLiquidBatch({ name: 'opaque-glass', depthZ: -2, alphaMode: 'opaque', opacity: 1 });
  const behindRegular = makeLiquidBatch({ name: 'behind-regular', depthZ: -5, alphaMode: 'add', opacity: 1, transmission: 0, throughGlass: false });
  const behindBright = makeLiquidBatch({ name: 'behind-bright', depthZ: -5, alphaMode: 'add', opacity: 1, transmission: 0, throughGlass: true });
  const picked = additiveBatchesBehindShells({ view: mat4.create() }, [behindRegular, behindBright], [shell]);
  assert.deepEqual(picked.map(batch => batch.parts[0].name), ['behind-regular'], 'throughGlass beam skips pre-glass pass');

  const gl = makeMockGlContext();
  const renderer = makeLiquidRenderer({ context: gl.context, batches: [shell, behindBright] });
  drawLiquidPass(renderer, {
    frame: { eye: [0, 0, 5] },
    environment: { daylight: 1, lightDirection: [0, 1, 0], fogColor: [0, 0, 0], fogDensity: 0, explosionCenter: [0, 0, 0] },
    assemblyAmount: 0,
    environmentMap: null,
    liquids: [shell],
    foams: [],
    environmentSpecularUnit: 9,
    maximumDistance: 1e6,
    vertexSource: '',
    fragmentSource: '',
  });
  assert.deepEqual(gl.depthMasks, [false, true], 'throughGlass beam suppresses depth writes even on opaque-mode glass');
});

test('replaceParts swaps materials in place on existing textured and skinned parts without replace-textured-parts, and drawTranslucent frees targets when liquids drop to 0 (#3148)', () => {
  const { context } = makeMockGlContext();
  const geometry = scaledGeometry(box(0, 1), 1);
  const map = { image: { width: 2, height: 2 }, colorSpace: 'srgb' };
  const glassMaterial = { tag: 'gltf', color: [1, 1, 1], metallic: 0, roughness: 0.08, alphaMode: 'blend', opacity: 0.25, transmission: 1, ior: 1.4, thickness: 0.5, map };
  const plainMaterial = { tag: 'gltf', color: [0.4, 0.6, 0.9], metallic: 0, roughness: 0.4, alphaMode: 'opaque', opacity: 1, transmission: 0, map };
  const part = { name: 'cornea', geometry, matrix: mat4.create(), material: glassMaterial };

  const renderer = Object.create(CrucibleRenderer.prototype);
  Object.assign(renderer, {
    context,
    canvas: { width: 64, height: 64, clientWidth: 64, clientHeight: 64 },
    groundPart: null,
    batching: true,
    benchmark: true,
    hdr: false,
    depth: false,
    multisampleSamples: 1,
    denseSamples: null,
    memoryBudgetMiB: 64,
    memoryBudgetFollowsScene: false,
    geometryBytes: 0,
    textureBytes: 0,
    buffers: [],
    batches: [],
    geometryBuffers: new Map(),
    textures: new Map([[map, { id: 'gpuTex' }], [null, { id: 'white' }]]),
    partLocations: new Map(),
    updateBatches: new Set(),
    updateSkins: new Set(),
    renderTargets: { record() {}, release() {} },
    backend: { createBuffer: () => ({}), uploadBuffer() {} },
    requireShaderFeatures() {},
    createCullingState: () => ({ cullable: false, bounds: { center: [0, 0, 0], radius: 1 }, levelGeometries: [geometry], levelDraws: [], levelErrors: [0], selection: null, shadowLevels: null, swayReach: 0 }),
    releaseLevelDraws() {},
    pointInstanceAttributes() {},
    updateParts: CrucibleRenderer.prototype.updateParts,
  });

  renderer.batches.push(renderer.uploadBatch([part]));
  assert.equal(renderer.batches[0].pass, 'liquid');

  // Swap from transmission to plain without replace-textured-parts.
  part.material = plainMaterial;
  renderer.replaceParts([part]);
  assert.equal(renderer.batches[0].pass, 'opaque');

  // Swap back to transmission.
  part.material = glassMaterial;
  renderer.replaceParts([part]);
  assert.equal(renderer.batches[0].pass, 'liquid');

  // Adding a brand new textured part with an un-uploaded map still requires replace-textured-parts.
  const newMap = { image: { width: 2, height: 2 }, colorSpace: 'srgb' };
  const newPart = { name: 'new-textured', geometry, matrix: mat4.create(), material: { ...plainMaterial, map: newMap } };
  assert.throws(() => renderer.replaceParts([part, newPart]), /import replace-textured-parts/);

  // Removing a skinned part still throws existing-rigid error.
  const location = renderer.partLocations.get(part);
  location.skin = { jointMatrices: new Float32Array(16) };
  assert.throws(() => renderer.replaceParts([]), /existing rigid/);

  // Swapping material on an unchanged skinned part stays allowed.
  const vertexCount = geometry.positions.length / 3;
  const skinnedGeo = { ...geometry, skinIndices: new Uint16Array(vertexCount * 4), skinWeights: new Float32Array(vertexCount * 4) };
  for (let i = 0; i < vertexCount; i++) skinnedGeo.skinWeights[i * 4] = 1;
  const skinPose = { jointMatrices: new Float32Array(16) };
  skinPose.jointMatrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const skinnedPart = { name: 'skinned-cornea', geometry: skinnedGeo, matrix: mat4.create(), skin: skinPose, material: glassMaterial };
  renderer.skinTextures = new Map([[skinPose, { texture: { id: 'skinTex' }, width: 4, height: 1, data: new Float32Array(16), pose: skinPose }]]);
  renderer.influenceTextures = new Map([[skinnedGeo, { texture: { id: 'infTex' } }]]);
  renderer.batches = [renderer.uploadBatch([skinnedPart])];
  renderer.partLocations.delete(part);
  skinnedPart.material = plainMaterial;
  renderer.replaceParts([skinnedPart]);
  assert.equal(renderer.batches[0].pass, 'opaque');

  // drawTranslucent releases stale liquid targets when no liquid/foam batches remain.
  let releasedDepth = false;
  let releasedChain = false;
  renderer.glassBackCache = { stale: true };
  renderer.refractionDepth = { release: () => { releasedDepth = true; } };
  renderer.refractionChain = { release: () => { releasedChain = true; } };
  renderer.activateEnvironment = () => null;
  renderer.drawTranslucent({}, {}, 0, null);
  assert.equal(renderer.glassBackCache, null);
  assert.equal(releasedDepth, true);
  assert.equal(releasedChain, true);
});
