import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mat4 } from 'gl-matrix';
import { createFragmentShader, HEIGHT_MAP_FEATURE, SHADER_FEATURES, TANGENT_FEATURE } from '../src/shaders.js';
import {
  applyDetailRoughness,
  bindDetailNormal,
  DETAIL_NORMAL_FEATURE,
  DETAIL_NORMAL_UNIT,
  detailNormalState,
  detailRoughnessDeltaFromNormal,
  reorientNormalValues,
} from '../src/detail-normal-shader.js';
import { HEIGHT_MAP_UNIT, SPLAT_UNITS } from '../src/shader-registry.js';
import { PUDDLE_MASK_UNIT } from '../src/wetness-puddles.js';
import { IRRADIANCE_GRID_TEXTURE_UNIT } from '../src/irradiance-grid.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';
import { groupParts, shaderFeaturesOfParts, CrucibleRenderer } from '../src/renderer.js';
import { materialLayerState } from '../src/material-layers.js';
import { MaterialSnapshot } from '../src/material-snapshot.js';
import { describeIgnoredFeatures } from '../src/path-tracer.js';

await loadAllAgentSceneModules();

const DETAIL_IMAGE_ID = 'b'.repeat(64);
const NORMAL_IMAGE_ID = 'c'.repeat(64);
const SAMPLE_FRAME = { width: 2, height: 2, data: new Uint8ClampedArray([128, 128, 255, 255, 160, 128, 240, 255, 100, 140, 235, 255, 128, 128, 255, 255]) };
const LINEAR_DESCRIPTOR = { image: { width: 4, height: 4 }, colorSpace: 'linear' };
const SRGB_DESCRIPTOR = { image: { width: 4, height: 4 }, colorSpace: 'srgb' };
const IDENTITY_GEOMETRY = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};

function runInFreshProcess(script) {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  return JSON.parse(output.trim().split('\n').pop());
}

function sceneWithDetail(material, extra = {}) {
  return createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'steel', ...material }],
    nodes: [{ id: 'plate', geometry: 'quad', material: 'steel' }],
    camera: { eye: [0, 3, 3], target: [0, 0, 0], fov: 45 },
    ...extra,
  }, {}, { sequenceFrames: new Map([[DETAIL_IMAGE_ID, SAMPLE_FRAME], [NORMAL_IMAGE_ID, SAMPLE_FRAME]]) });
}

test('detail-normal-shader stays out of the static core graph and errors clearly when missing', () => {
  const staticCheck = runInFreshProcess(`
    import { registerHooks } from 'node:module';
    const loaded = [];
    registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });
    const registry = await import('./src/shader-registry.js');
    for (const entry of ['shaders', 'renderer', 'cascaded-shadows', 'agent-scene']) await import('./src/' + entry + '.js');
    console.log(JSON.stringify({ loaded: loaded.some(url => url.includes('detail-normal-shader')), registered: registry.registeredFeatureCode.has('detailNormalMap') }));
  `);
  assert.equal(staticCheck.loaded, false);
  assert.equal(staticCheck.registered, false);

  const missingError = runInFreshProcess(`
    const { createFragmentShader } = await import('./src/shaders.js');
    let message = null;
    try {
      createFragmentShader(['baseMap', 'normalMap', 'detailNormalMap']);
    } catch (error) {
      message = error.message;
    }
    console.log(JSON.stringify({ message }));
  `);
  assert.match(missingError.message, /detail-normal-shader/);
  assert.match(missingError.message, /loadAgentSceneModules/);

  assert.ok(!agentSceneModulesNeeded({ materials: [{ id: 'plain', colorMap: NORMAL_IMAGE_ID }] }).includes('detailNormalShader'));
  assert.ok(agentSceneModulesNeeded({ materials: [{ id: 'steel', detailNormalMap: DETAIL_IMAGE_ID }] }).includes('detailNormalShader'));
  assert.ok(agentSceneModulesNeeded({ materials: [{ id: 'steel', detailUvScale: 8 }] }).includes('assets'));
});

test('shaders without detailNormalMap emit byte-for-byte identical GLSL even after loading the addon', () => {
  const plainHash = runInFreshProcess(`
    import { createHash } from 'node:crypto';
    const { createFragmentShader } = await import('./src/shaders.js');
    const plain = createFragmentShader(['baseMap', 'normalMap']);
    const hashBefore = createHash('sha256').update(plain).digest('hex');
    await import('./src/detail-normal-shader.js');
    const hashAfter = createHash('sha256').update(createFragmentShader(['baseMap', 'normalMap'])).digest('hex');
    console.log(JSON.stringify({ hashBefore, hashAfter }));
  `);
  assert.equal(plainHash.hashBefore, plainHash.hashAfter);

  const reliefHash = createHash('sha256')
    .update(createFragmentShader(['baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap', 'heightMap']))
    .digest('hex');
  assert.equal(reliefHash, 'a2f0b344128aedf32036533821f64a11302a947c334e245ad8bfe5bd4728d985');
});

test('DETAIL_NORMAL_UNIT sits cleanly past HEIGHT_MAP_UNIT and PUDDLE_MASK_UNIT without collisions', () => {
  assert.equal(DETAIL_NORMAL_UNIT, HEIGHT_MAP_UNIT + 2);
  assert.ok(DETAIL_NORMAL_UNIT > PUDDLE_MASK_UNIT);
  assert.ok(DETAIL_NORMAL_UNIT < 32);
  const units = new Map([
    ['irradianceGrid', IRRADIANCE_GRID_TEXTURE_UNIT],
    ['heightMap', HEIGHT_MAP_UNIT],
    ['puddleMask', PUDDLE_MASK_UNIT],
    ...Object.entries(SPLAT_UNITS),
  ]);
  for (const [name, unit] of units) {
    assert.notEqual(unit, DETAIL_NORMAL_UNIT, `detailNormalMap and ${name} cannot share unit ${unit}`);
  }
  for (const entry of readdirSync(new URL('../src/', import.meta.url)).filter(name => name.endsWith('.js'))) {
    const source = readFileSync(new URL(`../src/${entry}`, import.meta.url), 'utf8');
    if (!/(?:TEXTURE0|activeTexture|sampler2D|sampler3D|sampler2DArray|samplerCube)/.test(source)) continue;
    for (const match of source.matchAll(/^(?:export )?const (\w+_UNIT) = (\d+);/gm)) {
      assert.ok(Number(match[2]) < DETAIL_NORMAL_UNIT, `${match[1]} (${entry}) unit ${match[2]} collides with or exceeds DETAIL_NORMAL_UNIT ${DETAIL_NORMAL_UNIT}`);
    }
  }
});

test('detailNormalState and createAgentScene validate bounds, types, procedural tags, and require detailNormalMap', () => {
  const tags = new Set(['water', 'foliage', 'grass', 'terrain', 'floor', 'fire', 'smoke', 'liquid', 'foam']);

  assert.deepEqual(
    detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR }, tags),
    [LINEAR_DESCRIPTOR, 1, 1, 1, 1, 0],
  );
  assert.deepEqual(
    detailNormalState({
      detailNormalMap: LINEAR_DESCRIPTOR,
      detailNormalScale: 1.5,
      detailUvScale: [4, 12],
      detailRoughnessStrength: 0.45,
    }, tags),
    [LINEAR_DESCRIPTOR, 1.5, 1.5, 4, 12, 0.45],
  );

  assert.throws(() => detailNormalState({ detailNormalMap: SRGB_DESCRIPTOR }, tags), /linear/);
  assert.throws(() => detailNormalState({ detailNormalMap: 'not-a-descriptor' }, tags), TypeError);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, tag: 'water' }, tags), /standard PBR material/);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, tag: 'unlit' }, tags), /standard PBR material/);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, boxMapScale: 2 }, tags), /standard PBR material/);

  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, detailNormalScale: [1] }, tags), TypeError);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, detailNormalScale: [Infinity, 1] }, tags), RangeError);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, detailNormalScale: 1e39 }, tags), RangeError);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, detailUvScale: 0 }, tags), RangeError);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, detailUvScale: -2 }, tags), RangeError);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, detailUvScale: 1025 }, tags), RangeError);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, detailUvScale: [8, 0] }, tags), RangeError);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, detailUvScale: '8' }, tags), TypeError);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, detailRoughnessStrength: -0.1 }, tags), RangeError);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, detailRoughnessStrength: 1.2 }, tags), RangeError);
  assert.throws(() => detailNormalState({ detailNormalMap: LINEAR_DESCRIPTOR, detailRoughnessStrength: '0.5' }, tags), TypeError);

  assert.throws(() => detailNormalState({ detailNormalScale: [2, 2] }, tags), /detailNormalMap/);
  assert.throws(() => detailNormalState({ detailUvScale: 8 }, tags), /detailNormalMap/);
  assert.throws(() => detailNormalState({ detailRoughnessStrength: 0.4 }, tags), /detailNormalMap/);

  assert.throws(() => sceneWithDetail({ detailNormalMap: 'bad-id' }), TypeError);
  assert.throws(() => sceneWithDetail({ tag: 'water', detailNormalMap: DETAIL_IMAGE_ID }), /surface tag/);
  assert.throws(() => sceneWithDetail({ pattern: { type: 'checker', colors: [[0.2, 0.2, 0.2], [0.8, 0.8, 0.8]] }, detailNormalMap: DETAIL_IMAGE_ID }), /pattern/);
  assert.throws(() => sceneWithDetail({ detailUvScale: 8 }), /detailNormalMap/);
  assert.throws(() => sceneWithDetail({ detailUvScale: 2048 }), /detailUvScale/);
  assert.throws(() => sceneWithDetail({ detailRoughnessStrength: 1.5 }), /detailRoughnessStrength/);
});

test('fragment shader blends tiled detailNormalMap via RNM, supports fallback without normalMap, and follows heightMap parallax', () => {
  const combined = createFragmentShader(['baseMap', 'normalMap', DETAIL_NORMAL_FEATURE]);
  assert.match(combined, /uniform sampler2D detailNormalMap;/);
  assert.match(combined, /reorientNormal\(/);
  assert.match(combined, /applyDetailTangentNormal\(sampled, USES_NORMAL_MAP\)/);
  assert.match(combined, /mapUV\(detailNormalState\.x\) \* detailNormalScale\.zw/);
  assert.match(combined, /clamp\(roughness \+ detailNormalState\.y \* detailRoughnessDelta, 0\.04, 1\.0\)/);

  const fallback = createFragmentShader(['baseMap', DETAIL_NORMAL_FEATURE]);
  assert.match(fallback, /bool usesAnyNormalMap = USES_NORMAL_MAP \|\| \(!BOX_MAPPED && detailNormalState\.x > 0\.5\);/);
  assert.match(fallback, /float activeNormalFlag = USES_NORMAL_MAP \? hasNormalMap : detailNormalState\.x;/);
  assert.match(fallback, /if \(usesAnyNormalMap\) normal = ensureValidReflection/);
  assert.match(fallback, /if \(usesAnyNormalMap\) occlusion \*=/);

  const tangentFallback = createFragmentShader(['baseMap', DETAIL_NORMAL_FEATURE, TANGENT_FEATURE]);
  assert.equal(tangentFallback.match(/applyDetailTangentNormal\(sampled, USES_NORMAL_MAP\)/g)?.length, 2);

  const parallaxDetail = createFragmentShader(['baseMap', 'normalMap', 'heightMap', DETAIL_NORMAL_FEATURE]);
  assert.match(parallaxDetail, /textureGrad\(detailNormalMap, mapUV\(detailNormalState\.x\) \* detailNormalScale\.zw, mapGradientX\(detailNormalState\.x\) \* detailNormalScale\.zw, mapGradientY\(detailNormalState\.x\) \* detailNormalScale\.zw\)/);
  assert.match(parallaxDetail, /dFdx\(frameCoordinates\)/);
  assert.doesNotMatch(parallaxDetail, /dFdx\(normalCoordinates\)/);
  assert.match(parallaxDetail, /activeNormalFlag > 1\.5 \? vec2\(0\.0\) : parallaxShift/);
});

test('RNM blend math and micro-roughness modulation match expected physical values', () => {
  const flat = [0, 0, 1];
  const tilted = [Math.sin(Math.PI / 6), 0, Math.cos(Math.PI / 6)];
  const ontoFlat = reorientNormalValues(flat, tilted);
  assert.ok(Math.abs(ontoFlat[0] - tilted[0]) < 1e-12 && Math.abs(ontoFlat[2] - tilted[2]) < 1e-12);

  const withFlatDetail = reorientNormalValues(tilted, flat);
  assert.ok(Math.abs(withFlatDetail[0] - tilted[0]) < 1e-12 && Math.abs(withFlatDetail[2] - tilted[2]) < 1e-12);

  const sixty = reorientNormalValues(tilted, tilted);
  assert.ok(Math.abs(sixty[0] - Math.sin(Math.PI / 3)) < 1e-9);
  assert.ok(Math.abs(sixty[1]) < 1e-9);
  assert.ok(Math.abs(sixty[2] - Math.cos(Math.PI / 3)) < 1e-9);

  assert.equal(detailRoughnessDeltaFromNormal(flat), 0);
  assert.equal(applyDetailRoughness(0.3, 0, [0.6, 0, 0.8]), 0.3);
  assert.ok(Math.abs(applyDetailRoughness(0.3, 0.45, [0.6, 0, 0.8]) - 0.57) < 1e-12);
  assert.equal(applyDetailRoughness(0.01, 0.01, flat), 0.04);
  assert.equal(applyDetailRoughness(0.9, 0.8, [1, 0, 0]), 1);
});

test('groupParts, MaterialSnapshot, updateParts, bindDetailNormal, createAgentScene and path tracer integrate cleanly', () => {
  const partA = { name: 'a', geometry: IDENTITY_GEOMETRY, matrix: mat4.create(), material: { color: [0.5, 0.5, 0.5], metallic: 0.9, roughness: 0.3, detailNormalMap: LINEAR_DESCRIPTOR, detailUvScale: 8, detailRoughnessStrength: 0.4 } };
  const partB = { name: 'b', geometry: IDENTITY_GEOMETRY, matrix: mat4.create(), material: { color: [0.5, 0.5, 0.5], metallic: 0.9, roughness: 0.3, detailNormalMap: LINEAR_DESCRIPTOR, detailUvScale: 8, detailRoughnessStrength: 0.4 } };
  const partC = { name: 'c', geometry: IDENTITY_GEOMETRY, matrix: mat4.create(), material: { color: [0.5, 0.5, 0.5], metallic: 0.9, roughness: 0.3, detailNormalMap: LINEAR_DESCRIPTOR, detailUvScale: 16, detailRoughnessStrength: 0.4 } };
  assert.equal(groupParts([partA, partB]).length, 1);
  assert.equal(groupParts([partA, partC]).length, 2);

  assert.equal(MaterialSnapshot.of(partA.material), null);
  assert.equal(MaterialSnapshot.of({ color: [1, 1, 1], detailUvScale: 4 }), null);

  const renderer = Object.create(CrucibleRenderer.prototype);
  const calls = [];
  renderer.shaderFeatures = new Set([DETAIL_NORMAL_FEATURE]);
  renderer.uniforms = { detailNormalScale: 'scale', detailNormalState: 'state', detailNormalMap: 'sampler' };
  renderer.whiteTexture = 'white';
  renderer.createTexture = (descriptor, isNormalMap) => {
    calls.push(['createTexture', descriptor, isNormalMap]);
    return 'detailTex';
  };
  renderer.context = {
    TEXTURE0: 100,
    TEXTURE_2D: 1,
    uniform4f: (...args) => calls.push(['uniform4f', ...args]),
    uniform2f: (...args) => calls.push(['uniform2f', ...args]),
    uniform1i: (...args) => calls.push(['uniform1i', ...args]),
    activeTexture: unit => calls.push(['activeTexture', unit]),
    bindTexture: (target, tex) => calls.push(['bindTexture', target, tex]),
  };
  bindDetailNormal(renderer, { parts: [partA] });
  assert.deepEqual(calls, [
    ['createTexture', LINEAR_DESCRIPTOR, true],
    ['uniform4f', 'scale', 1, 1, 8, 8],
    ['uniform2f', 'state', 1, 0.4],
    ['uniform1i', 'sampler', DETAIL_NORMAL_UNIT],
    ['activeTexture', 100 + DETAIL_NORMAL_UNIT],
    ['bindTexture', 1, 'detailTex'],
    ['activeTexture', 100],
  ]);

  const scene = sceneWithDetail({
    normalMap: NORMAL_IMAGE_ID,
    detailNormalMap: DETAIL_IMAGE_ID,
    detailNormalScale: [1.2, 0.8],
    detailUvScale: 8,
    detailRoughnessStrength: 0.45,
  });
  const builtMaterial = scene.parts[0].material;
  assert.equal(builtMaterial.detailNormalMap.colorSpace, 'linear');
  assert.deepEqual(builtMaterial.detailNormalScale, [1.2, 0.8]);
  assert.deepEqual(builtMaterial.detailUvScale, [8, 8]);
  assert.equal(builtMaterial.detailRoughnessStrength, 0.45);

  const boxScene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }],
    materials: [{ id: 'steel', detailNormalMap: DETAIL_IMAGE_ID, detailUvScale: 4 }],
    nodes: [{ id: 'cube', geometry: 'cube', material: 'steel' }],
    camera: { eye: [2, 2, 2], target: [0, 0, 0], fov: 45 },
  }, {}, { sequenceFrames: new Map([[DETAIL_IMAGE_ID, SAMPLE_FRAME]]) });
  assert.ok(boxScene.parts[0].geometry.uvs instanceof Float32Array);

  scene.apply([{ type: 'set-material', id: 'steel', detailUvScale: 12, detailRoughnessStrength: 0.25 }], { expectedRevision: 0 });
  assert.deepEqual(scene.parts[0].material.detailUvScale, [12, 12]);
  assert.equal(scene.parts[0].material.detailRoughnessStrength, 0.25);

  const mockBatch = {
    instanceBuffer: {}, instanceData: new Float32Array(42),
    castShadow: true, receivesShadow: true, compositeMode: 0,
    alphaMode: 'opaque', alphaCutoff: 0, opacity: 1, doubleSided: false, pass: 'opaque',
  };
  const mockRenderer = Object.create(CrucibleRenderer.prototype);
  const trackedPart = { name: 'a', geometry: IDENTITY_GEOMETRY, matrix: mat4.create(), material: { color: [0.5, 0.5, 0.5], metallic: 0.9, roughness: 0.3 } };
  const initialMapState = [
    null, null, null, null, null, 1, 1, 1, 0, 0.05, 0.085, 0.02, 0, 1, null, 0,
    null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  ];
  mockRenderer.context = { ARRAY_BUFFER: 34962, bindBuffer() {}, bufferSubData() {} };
  mockRenderer.partLocations = new Map([[trackedPart, {
    batch: mockBatch, index: 0, geometry: IDENTITY_GEOMETRY, map: null, normalMatrix: new Float32Array(9),
    layerState: materialLayerState({}),
    skin: null,
    mapState: initialMapState,
  }]]);
  mockRenderer.updateBatches = new Set();
  mockRenderer.updateSkins = new Set();
  mockRenderer.shadowsDirty = false;
  mockRenderer.updateParts([trackedPart]);
  mockRenderer.updateParts([trackedPart]);
  trackedPart.material.detailNormalMap = LINEAR_DESCRIPTOR;
  assert.throws(() => mockRenderer.updateParts([trackedPart]), /Height map or detail normal changes/);

  const ignored = describeIgnoredFeatures(scene.parts, {}, 'cpu');
  assert.ok(ignored.includes('detailNormalMap is ignored.'), `expected path tracer to report detailNormalMap ignored, got ${JSON.stringify(ignored)}`);
});

test('heightMap + detailNormalMap compose cleanly, detail-only batches pass empty height state, and dispose frees detail textures', () => {
  const heightDescriptor = { image: { width: 4, height: 4 }, colorSpace: 'linear' };
  const combinedPart = {
    name: 'combined',
    geometry: IDENTITY_GEOMETRY,
    matrix: mat4.create(),
    material: {
      color: [0.5, 0.5, 0.5],
      metallic: 0.9,
      roughness: 0.3,
      heightMap: heightDescriptor,
      heightScale: 0.04,
      heightFade: 12,
      heightSteps: 16,
      detailNormalMap: LINEAR_DESCRIPTOR,
      detailUvScale: 8,
      detailRoughnessStrength: 0.45,
    },
  };
  const detailOnlyPart = {
    name: 'detailOnly',
    geometry: IDENTITY_GEOMETRY,
    matrix: mat4.create(),
    material: {
      color: [0.5, 0.5, 0.5],
      metallic: 0.9,
      roughness: 0.3,
      detailNormalMap: LINEAR_DESCRIPTOR,
      detailUvScale: 8,
      detailRoughnessStrength: 0.45,
    },
  };

  const features = shaderFeaturesOfParts([combinedPart, detailOnlyPart]);
  assert.ok(features.has(HEIGHT_MAP_FEATURE));
  assert.ok(features.has(DETAIL_NORMAL_FEATURE));

  const baseState = [
    null, null, null, null, null, 1, 1, 1, 0, 0.05, 0.085, 0.02, 0, 1, null, 0,
    null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
  ];
  const combinedMapState = [...baseState, heightDescriptor, 0.04, 12, 16, LINEAR_DESCRIPTOR, 1, 1, 8, 8, 0.45];
  const detailOnlyMapState = [...baseState, LINEAR_DESCRIPTOR, 1, 1, 8, 8, 0.45];

  const heightCalls = [];
  const mixedRenderer = Object.create(CrucibleRenderer.prototype);
  mixedRenderer.shaderFeatures = features;
  mixedRenderer.uniforms = {
    heightState: 'uHeightState',
    heightMap: 'uHeightMap',
    detailNormalScale: 'uDetailScale',
    detailNormalState: 'uDetailState',
    detailNormalMap: 'uDetailMap',
  };
  mixedRenderer.whiteTexture = 'white';
  mixedRenderer.createTexture = () => 'detailTex';
  mixedRenderer.context = {
    TEXTURE0: 100,
    TEXTURE_2D: 1,
    uniform4f: (...args) => heightCalls.push(['uniform4f', ...args]),
    uniform2f: (...args) => heightCalls.push(['uniform2f', ...args]),
    uniform1i: (...args) => heightCalls.push(['uniform1i', ...args]),
    activeTexture: unit => heightCalls.push(['activeTexture', unit]),
    bindTexture: (target, tex) => heightCalls.push(['bindTexture', target, tex]),
  };

  mixedRenderer.bindHeightParallax({ parts: [combinedPart], heightTexture: 'heightTex', mapState: combinedMapState });
  assert.ok(heightCalls.some(call => call[0] === 'uniform4f' && call[1] === 'uHeightState' && call[2] === 0.04 && call[3] === 12 && call[4] === 16 && call[5] === 1));
  assert.ok(heightCalls.some(call => call[0] === 'bindTexture' && call[2] === 'heightTex'));

  heightCalls.length = 0;
  bindDetailNormal(mixedRenderer, { parts: [combinedPart] });
  assert.ok(heightCalls.some(call => call[0] === 'uniform4f' && call[1] === 'uDetailScale' && call[4] === 8 && call[5] === 8));
  assert.ok(heightCalls.some(call => call[0] === 'uniform2f' && call[1] === 'uDetailState' && call[2] === 1 && call[3] === 0.45));

  heightCalls.length = 0;
  mixedRenderer.bindHeightParallax({ parts: [detailOnlyPart], heightTexture: null, mapState: detailOnlyMapState });
  assert.ok(heightCalls.some(call => call[0] === 'uniform4f' && call[1] === 'uHeightState' && call[2] === 0 && call[5] === 0));
  assert.ok(heightCalls.every(call => !(call[0] === 'uniform4f' && call[1] === 'uHeightState' && call[2] === 8)));

  const deletedTextures = [];
  const disposableRenderer = Object.create(CrucibleRenderer.prototype);
  disposableRenderer.context = {
    deleteTexture: texture => deletedTextures.push(texture),
    deleteBuffer() {},
    deleteProgram() {},
    deleteVertexArray() {},
    deleteFramebuffer() {},
  };
  disposableRenderer.renderTargets = { release() {} };
  disposableRenderer.batches = [];
  disposableRenderer.buffers = [];
  disposableRenderer.textures = new Map([[LINEAR_DESCRIPTOR, 'detailTex']]);
  disposableRenderer.dispose();
  assert.deepEqual(deletedTextures, ['detailTex']);
  assert.equal(disposableRenderer.textures.size, 0);
});
