import test from 'node:test';
import assert from 'node:assert/strict';
import { WebGL2GlazeBackend } from '../src/glaze-backend-webgl2.js';
import { CrucibleRenderer } from '../src/renderer.js';
import { EFFECT_PRESETS, resolveEffects } from '../src/effects.js';

function createSoftwareBackendContext(rendererName) {
  let extensionLookups = 0;
  return {
    RENDERBUFFER: 0x8d41,
    DEPTH_COMPONENT24: 0x81a6,
    RGBA8: 0x8058,
    RGBA16F: 0x881a,
    SAMPLES: 0x80a9,
    MAX_SAMPLES: 0x8d57,
    getExtensionLookups: () => extensionLookups,
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') {
        extensionLookups += 1;
        return { UNMASKED_RENDERER_WEBGL: 0x9246 };
      }
      return null;
    },
    getParameter(parameter) {
      if (parameter === 0x9246) return rendererName;
      if (parameter === 0x8d57) return 8;
      return 0;
    },
    getInternalformatParameter() {
      return new Int32Array([8, 4, 2]);
    },
  };
}

test('WebGL2GlazeBackend detects and caches software renderers across WARP, SwiftShader and llvmpipe', () => {
  for (const name of [
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Google SwiftShader',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
  ]) {
    const context = createSoftwareBackendContext(name);
    const backend = new WebGL2GlazeBackend(context);
    assert.equal(backend.isSoftwareRenderer(), true, name);
    assert.equal(backend.isSoftwareRenderer(), true, 'second lookup reads cache');
    assert.equal(context.getExtensionLookups(), 1);
  }

  for (const name of ['NVIDIA GeForce RTX 3060', null]) {
    const context = createSoftwareBackendContext(name);
    if (name === null) context.getExtension = () => null;
    const backend = new WebGL2GlazeBackend(context);
    assert.equal(backend.isSoftwareRenderer(), false);
    assert.equal(backend.isSoftwareRenderer(), false);
  }
});

test('CrucibleRenderer caps default MSAA on software renderers while keeping explicit sample counts', () => {
  const defaultStub = {
    benchmark: false,
    samplesExplicit: false,
    baseSamples: 4,
    denseSamples: null,
    shading: 'full',
    hdr: false,
    canvas: { width: 800, height: 600 },
    pixelRatio: 1,
    context: { RGBA8: 0x8058, RGBA16F: 0x881a },
    backend: new WebGL2GlazeBackend(createSoftwareBackendContext('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)')),
  };
  assert.equal(CrucibleRenderer.prototype.chooseMultisampleSamples.call(defaultStub, []), 0);

  const explicitStub = { ...defaultStub, samplesExplicit: true };
  assert.equal(CrucibleRenderer.prototype.chooseMultisampleSamples.call(explicitStub, []), 4);
});

test('resolveEffects returns EFFECT_PRESETS.neutral without allocating when omitted', () => {
  assert.equal(resolveEffects(), EFFECT_PRESETS.neutral);
  assert.equal(resolveEffects(undefined), EFFECT_PRESETS.neutral);
});

test('canDrawDirectly bypasses offscreen FBO and postProgram only when safe', () => {
  const base = {
    benchmark: false,
    hdr: false,
    depth: false,
    transparent: false,
    multisampleSamples: 0,
    reversedDepth: false,
    postStages: [],
    look: null,
    fogFieldOverride: null,
    autoExposureScale: null,
    batches: [{ pass: 'opaque', mapState: [] }],
    postStepsOf: CrucibleRenderer.prototype.postStepsOf,
    localVolumeBuffers: {},
  };
  const cleanFrame = { eye: [0, 1, 3], target: [0, 0, 0] };
  const cleanEnv = { lightDirection: [-3, 6, 4] };
  const noVolume = { density: 0 };

  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call(base, cleanFrame, EFFECT_PRESETS.neutral, cleanEnv, noVolume), true);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call({ ...base, multisampleSamples: 1 }, cleanFrame, EFFECT_PRESETS.neutral, cleanEnv, noVolume), true);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call({ ...base, multisampleSamples: 2 }, cleanFrame, EFFECT_PRESETS.neutral, cleanEnv, noVolume), false);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call({ ...base, depth: true }, cleanFrame, EFFECT_PRESETS.neutral, cleanEnv, noVolume), false);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call({ ...base, hdr: true }, cleanFrame, EFFECT_PRESETS.neutral, cleanEnv, noVolume), false);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call({ ...base, transparent: true }, cleanFrame, EFFECT_PRESETS.neutral, cleanEnv, noVolume), false);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call({ ...base, reversedDepth: true }, cleanFrame, EFFECT_PRESETS.neutral, cleanEnv, noVolume), false);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call({ ...base, postStages: [{}] }, cleanFrame, EFFECT_PRESETS.neutral, cleanEnv, noVolume), false);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call({ ...base, look: {} }, cleanFrame, EFFECT_PRESETS.neutral, cleanEnv, noVolume), false);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call({ ...base, batches: [{ pass: 'liquid', mapState: [] }] }, cleanFrame, EFFECT_PRESETS.neutral, cleanEnv, noVolume), false);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call({ ...base, batches: [{ pass: 'opaque', mapState: { 20: {} } }] }, cleanFrame, EFFECT_PRESETS.neutral, cleanEnv, noVolume), false);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call(base, { ...cleanFrame, fade: 0.5 }, EFFECT_PRESETS.neutral, cleanEnv, noVolume), false);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call(base, cleanFrame, EFFECT_PRESETS.cinematic, cleanEnv, noVolume), false);
  assert.equal(CrucibleRenderer.prototype.canDrawDirectly.call(base, cleanFrame, { ...EFFECT_PRESETS.neutral, dither: true }, cleanEnv, noVolume), false);
});

test('diagnostics getter evaluates lazily on read without String allocations', () => {
  let missChecks = 0;
  const descriptor = Object.getOwnPropertyDescriptor(CrucibleRenderer.prototype, 'diagnostics');
  const stub = {
    diagnosticsCache: [],
    diagnosticsPending: false,
    diagnosticsState: [null, null, null],
    world: false,
    depth: false,
    activeLightDirection: [-3, 6, 4],
    shadowBounds: {},
    partLocations: new Map(),
    studioShadowViewMissingCasters() {
      missChecks += 1;
      return null;
    },
  };
  Object.defineProperty(stub, 'diagnostics', descriptor);

  assert.deepEqual(stub.diagnostics, []);
  assert.equal(missChecks, 0);

  stub.diagnosticsState = [
    { effects: undefined, exposure: undefined },
    { ...EFFECT_PRESETS.neutral, ambientOcclusion: 0.5 },
    null,
  ];
  stub.diagnosticsPending = true;
  assert.equal(missChecks, 0, 'diagnostics work is deferred until read');
  const firstRead = stub.diagnostics;
  assert.equal(missChecks, 1);
  assert.equal(firstRead[0].kind, 'ambient-occlusion-without-depth');
  assert.equal(stub.diagnostics, firstRead, 'subsequent reads return cached diagnostics');
  assert.equal(missChecks, 1);
});
