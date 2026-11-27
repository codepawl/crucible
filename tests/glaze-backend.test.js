// The Glaze backend boundary (#901): the WebGL2 implementation issues exactly the GL calls CrucibleRenderer made itself before the boundary existed.
// A recording context stands in for WebGL2; the expected lists below are the calls of the old renderer code, in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asGlazeBackend, backendFor, createGlazeBackend } from '../src/glaze-backend.js';
import { WebGL2GlazeBackend } from '../src/glaze-backend-webgl2.js';
import { createFloatOutput, outputFor, readFloatPixels, readFrame, requireFloatTargets } from '../src/float-output.js';
import { installReversedDepth } from '../src/reversed-depth.js';
import { installRenderPasses, RENDER_PASS_MODES } from '../src/render-passes.js';
import { createCascadedShadows } from '../src/cascaded-shadows.js';
import { createEnvironmentMap, createEnvironmentResources, createEnvironmentResourcesInSlices } from '../src/environment.js';
import { installPostSteps } from '../src/post-steps.js';
import { initializeSplatPlaceholders, createSplatResources, bindSplat, disposeSplatResources } from '../src/splat-renderer.js';
import { resolveEffects } from '../src/effects.js';
import { installMeshBlend } from '../src/mesh-blend.js';
import { drawMeshVolumes } from '../src/mesh-volume-pass.js';
import { installUserPasses } from '../src/user-pass.js';
import { attachGaussianSplats, createGaussianSplats } from '../src/gaussian-splats.js';
import { FogFieldTexture } from '../src/fog-field.js';
import '../src/fog-shader.js';
import { requireFeatureCode } from '../src/shader-registry.js';
import { installLineArt, resolveLineArt } from '../src/line-art.js';
import { copySceneIntoMipChain, drawGlassBackFaces, drawLiquidPass, resolveSceneDepth } from '../src/liquid-renderer.js';

// Constants answer their own name, so the log reads GL_CONSTANT; methods log their call and return a numbered object.
function createRecordingContext(overrides = {}) {
  const calls = [];
  let created = 0;
  const values = { COLOR_BUFFER_BIT: 16384, DEPTH_BUFFER_BIT: 256, checkFramebufferStatus: () => 'FRAMEBUFFER_COMPLETE', ...overrides };
  const context = new Proxy({}, {
    get(target, name) {
      if (name in values) return values[name];
      if (/^[A-Z0-9_]+$/.test(name)) return name;
      return (...args) => {
        calls.push([name, ...args.map((argument) => (argument === null || typeof argument !== 'object' ? argument : argument.label ?? 'data'))]);
        if (name.startsWith('create')) return { label: `${name.slice(6).toLowerCase()}${++created}` };
        return undefined;
      };
    },
  });
  return { context, calls };
}

test('a multisample target allocates the same calls as the renderer did, in the same order', () => {
  const { context, calls } = createRecordingContext();
  const backend = new WebGL2GlazeBackend(context);
  const target = backend.createMultisampleTarget({ width: 64, height: 32, samples: 4, hdr: true });
  assert.deepEqual(calls, [
    ['createFramebuffer'],
    ['bindFramebuffer', 'FRAMEBUFFER', 'framebuffer1'],
    ['createRenderbuffer'],
    ['bindRenderbuffer', 'RENDERBUFFER', 'renderbuffer2'],
    ['renderbufferStorageMultisample', 'RENDERBUFFER', 4, 'RGBA16F', 64, 32],
    ['framebufferRenderbuffer', 'FRAMEBUFFER', 'COLOR_ATTACHMENT0', 'RENDERBUFFER', 'renderbuffer2'],
    ['createRenderbuffer'],
    ['bindRenderbuffer', 'RENDERBUFFER', 'renderbuffer3'],
    ['renderbufferStorageMultisample', 'RENDERBUFFER', 4, 'DEPTH_COMPONENT24', 64, 32],
    ['framebufferRenderbuffer', 'FRAMEBUFFER', 'DEPTH_ATTACHMENT', 'RENDERBUFFER', 'renderbuffer3'],
  ]);
  assert.deepEqual([target.framebuffer.label, target.colorBuffer.label, target.depthBuffer.label], ['framebuffer1', 'renderbuffer2', 'renderbuffer3']);
});

test('a resolve target creates its colour texture, framebuffer and depth texture in the old order', () => {
  const { context, calls } = createRecordingContext();
  const backend = new WebGL2GlazeBackend(context);
  const target = backend.createResolveTarget({ width: 8, height: 4, hdr: false, depth: true });
  const filtering = (filter) => [
    ['texParameteri', 'TEXTURE_2D', 'TEXTURE_MIN_FILTER', filter],
    ['texParameteri', 'TEXTURE_2D', 'TEXTURE_MAG_FILTER', filter],
    ['texParameteri', 'TEXTURE_2D', 'TEXTURE_WRAP_S', 'CLAMP_TO_EDGE'],
    ['texParameteri', 'TEXTURE_2D', 'TEXTURE_WRAP_T', 'CLAMP_TO_EDGE'],
  ];
  assert.deepEqual(calls, [
    ['createTexture'],
    ['bindTexture', 'TEXTURE_2D', 'texture1'],
    ['texImage2D', 'TEXTURE_2D', 0, 'RGBA8', 8, 4, 0, 'RGBA', 'UNSIGNED_BYTE', null],
    ...filtering('LINEAR'),
    ['createFramebuffer'],
    ['bindFramebuffer', 'FRAMEBUFFER', 'framebuffer2'],
    ['framebufferTexture2D', 'FRAMEBUFFER', 'COLOR_ATTACHMENT0', 'TEXTURE_2D', 'texture1', 0],
    ['createTexture'],
    ['bindTexture', 'TEXTURE_2D', 'texture3'],
    ['texImage2D', 'TEXTURE_2D', 0, 'DEPTH_COMPONENT24', 8, 4, 0, 'DEPTH_COMPONENT', 'UNSIGNED_INT', null],
    ...filtering('NEAREST'),
    ['framebufferTexture2D', 'FRAMEBUFFER', 'DEPTH_ATTACHMENT', 'TEXTURE_2D', 'texture3', 0],
  ]);
  assert.equal(target.depthTexture.label, 'texture3');
});

test('a target that is not complete throws the renderer error', () => {
  const { context, calls } = createRecordingContext({ checkFramebufferStatus: () => 'FRAMEBUFFER_UNSUPPORTED' });
  const backend = new WebGL2GlazeBackend(context);
  assert.throws(() => backend.createMultisampleTarget({ width: 1, height: 1, samples: 4, hdr: false }), /Multisample framebuffer allocation failed/);
  assert.throws(() => backend.createResolveTarget({ width: 1, height: 1, hdr: false, depth: false }), /Resolve framebuffer allocation failed/);
  assert.deepEqual(calls.filter(([name]) => name.startsWith('delete')), [['deleteFramebuffer', 'framebuffer1'], ['deleteRenderbuffer', 'renderbuffer2'], ['deleteRenderbuffer', 'renderbuffer3'], ['deleteFramebuffer', 'framebuffer5'], ['deleteTexture', 'texture4']], 'a failed allocation releases what it created');
});

test('resolving a multisample target binds read and draw and blits colour, and depth when asked', () => {
  const { context, calls } = createRecordingContext();
  const backend = new WebGL2GlazeBackend(context);
  backend.resolveMultisample({ source: { label: 'source' }, destination: { label: 'destination' }, width: 640, height: 480, depth: false });
  backend.resolveMultisample({ source: { label: 'source' }, destination: { label: 'destination' }, width: 640, height: 480, depth: true });
  assert.deepEqual(calls, [
    ['bindFramebuffer', 'READ_FRAMEBUFFER', 'source'],
    ['bindFramebuffer', 'DRAW_FRAMEBUFFER', 'destination'],
    ['blitFramebuffer', 0, 0, 640, 480, 0, 0, 640, 480, 16384, 'NEAREST'],
    ['bindFramebuffer', 'READ_FRAMEBUFFER', 'source'],
    ['bindFramebuffer', 'DRAW_FRAMEBUFFER', 'destination'],
    ['blitFramebuffer', 0, 0, 640, 480, 0, 0, 640, 480, 16384 | 256, 'NEAREST'],
  ]);
});

test('a draw is one drawElementsInstanced call over 32-bit indices, offset in bytes', () => {
  const { context, calls } = createRecordingContext();
  const backend = new WebGL2GlazeBackend(context);
  backend.drawIndexedInstanced(36, 5);
  backend.drawIndexedInstanced(12, 3, 24);
  assert.deepEqual(calls, [
    ['drawElementsInstanced', 'TRIANGLES', 36, 'UNSIGNED_INT', 0, 5],
    ['drawElementsInstanced', 'TRIANGLES', 12, 'UNSIGNED_INT', 96, 3],
  ]);
});

test('mirrored winding, buffers, readback and canvas binding wrap the single GL call they replace', () => {
  const { context, calls } = createRecordingContext();
  const backend = new WebGL2GlazeBackend(context);
  backend.setFrontFaceClockwise(true);
  backend.setFrontFaceClockwise(false);
  const buffer = backend.createBuffer();
  backend.uploadBuffer('ARRAY_BUFFER', buffer, new Float32Array(3));
  backend.deleteBuffer(buffer);
  backend.bindCanvasTarget();
  backend.readPixels(0, 0, 2, 2, 'RGBA', 'FLOAT', new Float32Array(16));
  assert.deepEqual(calls, [
    ['frontFace', 'CW'],
    ['frontFace', 'CCW'],
    ['createBuffer'],
    ['bindBuffer', 'ARRAY_BUFFER', 'buffer1'],
    ['bufferData', 'ARRAY_BUFFER', 'data', 'STATIC_DRAW'],
    ['deleteBuffer', 'buffer1'],
    ['bindFramebuffer', 'FRAMEBUFFER', null],
    ['readPixels', 0, 0, 2, 2, 'RGBA', 'FLOAT', 'data'],
  ]);
});

test('the sample count is the largest one the driver offers for colour and depth, within the request and MAX_SAMPLES', () => {
  const { context } = createRecordingContext({
    getParameter: () => 4,
    getInternalformatParameter: (target, format) => (format === 'DEPTH_COMPONENT24' ? [8, 4, 2, 1] : [8, 4, 1]),
  });
  const backend = new WebGL2GlazeBackend(context);
  assert.equal(backend.supportedSampleCount('RGBA8', 16), 4);
  assert.equal(backend.supportedSampleCount('RGBA8', 2), 1);
  assert.equal(backend.supportedSampleCount('RGBA8', 0), 0);
});

test('the canvas opens as WebGL2 and a missing context says what to do', () => {
  const { context } = createRecordingContext();
  const requested = [];
  const backend = createGlazeBackend({ getContext: (type, options) => (requested.push([type, options]), context) }, { transparent: true });
  assert.equal(backend.name, 'webgl2');
  assert.equal(backend.context, context);
  assert.deepEqual(requested, [['webgl2', { antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance', alpha: true }]]);
  assert.throws(() => createGlazeBackend({ getContext: () => null }), /WebGL2 is unavailable\. Enable hardware acceleration/);
});

// The renderer's frame core goes through the boundary: a real frame (headless Chrome, SwiftShader) allocates its targets,
// draws and resolves through the backend, and the backend wraps the context the unported passes still use.
test('a rendered frame allocates, draws and resolves through the backend', async (testContext) => {
  const { withDevServerPage } = await import('./helpers/dev-server-browser.js');
  await withDevServerPage(testContext, async (page) => {
    const result = await page.evaluate(async () => {
      const { box } = await import('/src/geometry.js');
      const { CrucibleRenderer } = await import('/src/renderer.js');
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      document.body.append(canvas);
      const parts = [{ name: 'cube', geometry: box(0, 1), matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1]), material: { id: 'cube', tag: 'surface', color: [0.8, 0.3, 0.2], metallic: 0, roughness: 0.5 } }];
      const renderer = new CrucibleRenderer(canvas, parts, { ground: false, samples: 4, pixelRatio: 1, depth: true });
      const names = ['createMultisampleTarget', 'createResolveTarget', 'resolveMultisample', 'drawIndexedInstanced', 'startProgram', 'createBuffer'];
      const counts = Object.fromEntries(names.map((name) => [name, 0]));
      for (const name of names) {
        const original = renderer.backend[name].bind(renderer.backend);
        renderer.backend[name] = (...args) => (counts[name]++, original(...args));
      }
      renderer.allocateFrameTargets(canvas.width, canvas.height);
      renderer.render({ eye: [0, 2, 4], target: [0, 0.5, 0] });
      const backendIsSharedWithContext = renderer.backend.context === renderer.context;
      const glError = renderer.context.getError();
      renderer.dispose?.();
      return { counts, backendIsSharedWithContext, glError, backendName: renderer.backend.name };
    });
    assert.equal(result.backendName, 'webgl2');
    assert.ok(result.backendIsSharedWithContext);
    assert.equal(result.glError, 0);
    assert.equal(result.counts.createMultisampleTarget, 1);
    assert.equal(result.counts.createResolveTarget, 1);
    assert.ok(result.counts.resolveMultisample >= 1, 'the frame resolves through the backend');
    assert.ok(result.counts.drawIndexedInstanced >= 1, 'the opaque draw goes through the backend');
  });
});

function createRecordingBackend(overrides = {}) {
  const calls = [];
  let created = 0;
  const values = {
    extension: () => ({}),
    createFramebufferTarget: (options) => ({
      framebuffer: { label: `fb${++created}` },
      colorTexture: options.color === false ? null : { label: `color${created}` },
      depthTexture: options.depth && options.depthAsTexture ? { label: `depthTex${created}` } : null,
      depthRenderbuffer: options.depth && !options.depthAsTexture ? { label: `depthRb${created}` } : null,
      complete: true,
    }),
    setFloatDepthTargets: () => true,
    compileProgram: () => ({ label: `program${++created}` }),
    uniformLocation: (_program, name) => `loc:${name}`,
    ...overrides,
  };
  const backend = new Proxy({}, {
    get(_target, name) {
      if (name === 'name') return 'recording';
      return (...args) => {
        calls.push([name, ...args]);
        if (name in values) return values[name](...args);
        return undefined;
      };
    },
  });
  return { backend, calls };
}

test('extension, framebuffer targets, depth targets, uniforms, fullscreen draws, clip control and float readback issue exact WebGL2 calls', () => {
  const clipExtension = {
    LOWER_LEFT_EXT: 'LOWER_LEFT_EXT',
    ZERO_TO_ONE_EXT: 'ZERO_TO_ONE_EXT',
    NEGATIVE_ONE_TO_ONE_EXT: 'NEGATIVE_ONE_TO_ONE_EXT',
    clipControlEXT: (...args) => calls.push(['clipControlEXT', ...args]),
  };
  const { context, calls } = createRecordingContext({
    getExtension: (name) => (name === 'EXT_color_buffer_float' ? { name } : null),
    getUniformLocation: (_program, name) => `uniform:${name}`,
    getProgramParameter: () => true,
    getShaderParameter: () => true,
  });
  const backend = new WebGL2GlazeBackend(context);

  assert.deepEqual(backend.extension('EXT_color_buffer_float'), { name: 'EXT_color_buffer_float' });
  assert.equal(backend.extension('MISSING_EXT'), null);

  const floatTarget = backend.createFramebufferTarget({ width: 16, height: 8, hdr: true, unbind: true });
  assert.equal(floatTarget.complete, true);
  assert.equal(floatTarget.colorTexture.label, 'texture1');
  assert.equal(floatTarget.framebuffer.label, 'framebuffer2');

  const passTarget = backend.createFramebufferTarget({ width: 16, height: 8, hdr: false, depth: true, floatDepth: true });
  assert.equal(passTarget.depthRenderbuffer.label, 'renderbuffer5');

  const depthTarget = backend.createFramebufferTarget({ width: 16, height: 8, color: false, depth: true, floatDepth: true, depthAsTexture: true });
  assert.equal(depthTarget.depthTexture.label, 'texture7');

  const depthComplete = backend.setFloatDepthTargets({
    multisampleDepth: { label: 'msDepth' },
    multisampleSamples: 4,
    depthTexture: { label: 'sceneDepth' },
    framebuffers: [{ label: 'msFb' }, { label: 'resFb' }],
    width: 16,
    height: 8,
  });
  assert.equal(depthComplete, true);

  backend.copyDepth({ source: { label: 'resFb' }, destination: { label: 'copyFb' }, width: 16, height: 8 });
  const program = backend.compileProgram('vs', 'fs');
  const location = backend.uniformLocation(program, 'u');
  backend.useProgram(program);
  backend.uniform1f(location, 1);
  backend.uniform1fv(location, new Float32Array([1, 2]));
  backend.uniform3f(location, 1, 2, 3);
  backend.uniform3fv(location, new Float32Array([1, 2, 3]));
  backend.uniform4fv(location, new Float32Array([1, 2, 3, 4]));
  backend.uniformMatrix4fv(location, new Float32Array(16));
  backend.drawFullscreenTexture({ framebuffer: null, width: 16, height: 8, program, textureUniform: location, texture: floatTarget.colorTexture, depthWriteOnly: false });
  backend.drawFullscreenTexture({ framebuffer: { label: 'resFb' }, width: 16, height: 8, program, textureUniform: location, texture: depthTarget.depthTexture, depthWriteOnly: true });
  backend.setClipControlZeroToOne(clipExtension, true);
  backend.setClipControlZeroToOne(clipExtension, false);
  backend.clearDepthBuffer(0);
  backend.readFloatPixels(floatTarget.framebuffer, 1, 2, 3, 4, new Float32Array(48));
  backend.deleteProgram(program);

  assert.ok(calls.some((call) => call[0] === 'renderbufferStorageMultisample' && call[3] === 'DEPTH_COMPONENT32F'));
  assert.ok(calls.some((call) => call[0] === 'blitFramebuffer' && call[9] === 256));
  assert.ok(calls.some((call) => call[0] === 'clipControlEXT' && call[2] === 'ZERO_TO_ONE_EXT'));
  assert.ok(calls.some((call) => call[0] === 'clipControlEXT' && call[2] === 'NEGATIVE_ONE_TO_ONE_EXT'));

  const readIndex = calls.findIndex((call) => call[0] === 'readPixels');
  assert.deepEqual(calls.slice(readIndex - 1, readIndex + 3), [
    ['bindFramebuffer', 'READ_FRAMEBUFFER', 'framebuffer2'],
    ['readPixels', 1, 2, 3, 4, 'RGBA', 'FLOAT', 'data'],
    ['bindFramebuffer', 'READ_FRAMEBUFFER', null],
    ['deleteProgram', 'program8'],
  ]);
  const depthOnlyStart = calls.findIndex((call) => call[0] === 'depthFunc' && call[1] === 'ALWAYS');
  assert.ok(depthOnlyStart > 0);
  assert.deepEqual(calls.slice(depthOnlyStart, depthOnlyStart + 8), [
    ['depthFunc', 'ALWAYS'],
    ['colorMask', false, false, false, false],
    ['drawArrays', 'TRIANGLES', 0, 3],
    ['colorMask', true, true, true, true],
    ['depthFunc', 'LESS'],
    ['disable', 'DEPTH_TEST'],
    ['clipControlEXT', 'LOWER_LEFT_EXT', 'ZERO_TO_ONE_EXT'],
    ['depthFunc', 'GREATER'],
  ]);
});

test('float-output.js routes through GlazeBackend when given a backend and wraps a raw context for standalone callers', () => {
  const { backend, calls } = createRecordingBackend();
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });

  requireFloatTargets(backend);
  const output = createFloatOutput(backend, 8, 4);
  const pixels = readFloatPixels(backend, output.framebuffer, 8, 4, { x: 1, y: 1, width: 2, height: 2 });
  assert.equal(pixels.length, 16);
  output.dispose();

  const record = { renderer: { backend, context: throwingContext, canvas: { width: 8, height: 4 } } };
  const cached = outputFor(record, { width: 8, height: 4 });
  assert.equal(cached.width, 8);
  const frame = readFrame(record, { width: 8, height: 4 }, 'frame');
  assert.equal(frame.width, 8);
  assert.equal(frame.height, 4);

  const methodNames = calls.map((call) => call[0]);
  assert.ok(methodNames.includes('extension'));
  assert.ok(methodNames.includes('createFramebufferTarget'));
  assert.ok(methodNames.includes('readFloatPixels'));
  assert.ok(methodNames.includes('deleteFramebuffer'));
  assert.ok(methodNames.includes('deleteTexture'));

  const { context, calls: rawCalls } = createRecordingContext({ getExtension: () => ({}) });
  const rawOutput = createFloatOutput(context, 4, 4);
  readFloatPixels(context, rawOutput.framebuffer, 4, 4);
  rawOutput.dispose();
  assert.ok(rawCalls.some((call) => call[0] === 'readPixels'));
  assert.equal(asGlazeBackend(backend), backend);
  assert.equal(backendFor({ backend, context: throwingContext }), backend);
});

test('reversed-depth.js routes depth target, clip control, uniforms and depth conversion through renderer.backend', () => {
  const { backend, calls } = createRecordingBackend();
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const renderer = {
    backend,
    context: throwingContext,
    canvas: { width: 32, height: 16 },
    benchmark: false,
    capabilities: {},
    postStages: [],
    multisampleFramebuffer: { label: 'msFb' },
    multisampleDepth: { label: 'msDepth' },
    multisampleSamples: 4,
    resolveFramebuffer: { label: 'resFb' },
    depthTexture: { label: 'depthTex' },
    program: { label: 'mainProgram' },
    projection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]),
    view: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    uniforms: { viewProjection: 'loc:viewProjection' },
    setFlushProjection() {},
    applyEnvironmentUniforms() {},
    applyDepthRank() {},
    resolveFrame() {},
    allocateFrameTargets() {},
    render() {
      this.applyEnvironmentUniforms(null, undefined);
      this.resolveFrame();
    },
  };

  installReversedDepth(renderer, true);
  assert.equal(renderer.reversedDepth, true);
  renderer.allocateFrameTargets(32, 16);
  renderer.render({ eye: [0, 1, 5] });
  renderer.postStages[0].apply(renderer);
  renderer.postStages[0].releaseTargets(throwingContext);
  renderer.postStages[0].dispose(throwingContext);

  const methodNames = calls.map((call) => call[0]);
  assert.ok(methodNames.includes('extension'));
  assert.ok(methodNames.includes('setFloatDepthTargets'));
  assert.ok(methodNames.includes('uniformMatrix4fv'));
  assert.ok(methodNames.includes('uniform4fv'));
  assert.ok(methodNames.includes('clearDepthBuffer'));
  assert.ok(methodNames.includes('setClipControlZeroToOne'));
  assert.ok(methodNames.includes('compileProgram'));
  assert.ok(methodNames.includes('copyDepth'));
  assert.ok(methodNames.includes('drawFullscreenTexture'));
  assert.ok(methodNames.includes('deleteProgram'));
});

test('render-passes.js routes targets, uniforms, fullscreen copy and cleanup through renderer.backend', () => {
  const { backend, calls } = createRecordingBackend();
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const batch = {
    parts: [{ name: 'hero', matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: { id: 'steel', aov: [0.2, 0.4, 0.6] } }],
    layerState: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    textures: ['t0', 't1', 't2', 't3', 't4'],
  };
  const renderer = {
    backend,
    context: throwingContext,
    canvas: { width: 16, height: 16 },
    benchmark: false,
    reversedDepth: true,
    program: { label: 'mainProgram' },
    viewProjection: new Float32Array(16),
    renderTargets: { record() {}, release() {} },
    requireFeatureNames() {},
    drawsInOpaqueLoop: () => true,
    takesObjectIds: () => true,
    createTexture: (descriptor) => descriptor,
    drawAlphaBatch() {},
    batches: [batch],
  };

  installRenderPasses(renderer);
  assert.equal(renderer.passSupport.prepare({ pass: 'aov', passFloat: true }), RENDER_PASS_MODES.aov);
  renderer.passSupport.bindFrame({ passFloat: true }, { fogDensity: 0.01, fogColor: [0.2, 0.3, 0.4] }, { density: 0, color: [0, 0, 0] });
  renderer.passSupport.drawBatch(batch, RENDER_PASS_MODES.aov, {}, 0);
  renderer.passSupport.copyToCanvas();
  renderer.passSupport.dispose(throwingContext);

  const methodNames = calls.map((call) => call[0]);
  assert.ok(methodNames.includes('compileProgram'));
  assert.ok(methodNames.includes('createFramebufferTarget'));
  assert.ok(methodNames.includes('uniformLocation'));
  assert.ok(methodNames.includes('uniform1f'));
  assert.ok(methodNames.includes('uniform1fv'));
  assert.ok(methodNames.includes('uniform3f'));
  assert.ok(methodNames.includes('uniform3fv'));
  assert.ok(methodNames.includes('uniformMatrix4fv'));
  assert.ok(methodNames.includes('drawFullscreenTexture'));
  assert.ok(methodNames.includes('deleteTexture'));
  assert.ok(methodNames.includes('deleteRenderbuffer'));
  assert.ok(methodNames.includes('deleteFramebuffer'));
  assert.ok(methodNames.includes('deleteProgram'));
});

test('new texture, uniform, depth-pass and fullscreen backend methods issue exact WebGL2 calls', () => {
  const anisotropyExtension = { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 'MAX_ANISO', TEXTURE_MAX_ANISOTROPY_EXT: 'TEX_ANISO' };
  const { context, calls } = createRecordingContext({
    getExtension: (name) => (name === 'EXT_texture_filter_anisotropic' ? anisotropyExtension : null),
    getParameter: (parameter) => (parameter === 'MAX_TEXTURE_SIZE' ? 8192 : parameter === 'MAX_ANISO' ? 8 : 0),
    TEXTURE0: 33984,
    NONE: 'NONE',
  });
  const backend = new WebGL2GlazeBackend(context);

  const location = { label: 'u' };
  backend.uniform1i(location, 2);
  backend.uniform1iv(location, new Int32Array([1, 2]));
  backend.uniform2f(location, 3, 4);
  backend.uniform2fv(location, new Float32Array([5, 6]));
  assert.equal(backend.maxTextureSize(), 8192);
  backend.activeTextureUnit(2);
  backend.bindTextureUnit(1, { label: 'tex2d' }, false);
  backend.bindTextureUnit(3, { label: 'texArr' }, true);
  backend.generateMipmap(false);
  backend.generateMipmap(true);
  backend.setTextureMipmaps({ label: 'mipTex' }, true);
  backend.setTextureMipmaps({ label: 'mipTex' }, false);
  const halfFloat = backend.createHalfFloatStorageTexture({ width: 16, height: 8, levels: 3, repeatHorizontal: true });
  assert.equal(halfFloat.label, 'texture1');
  backend.uploadFloatTexture2D(halfFloat, 0, 2, 16, 4, new Float32Array(16 * 4 * 4));
  const depthArray = backend.createTextureArray({ width: 32, height: 32, layers: 3, format: 'depth24', wrap: 'clamp' });
  assert.equal(depthArray.label, 'texture2');
  const colorArray = backend.createTextureArray({
    width: 16,
    height: 16,
    layers: 2,
    format: 'srgb8Alpha8',
    mipmaps: true,
    wrap: 'repeat',
    linear: true,
    data: new Uint8Array(16 * 16 * 4 * 2),
    unpackRaw: true,
    anisotropy: 16,
  });
  assert.equal(colorArray.label, 'texture3');
  assert.throws(() => backend.createTextureArray({ width: 4, height: 4, layers: 1, format: 'bad' }), /Unsupported texture array format/);

  const framebuffer = backend.createFramebuffer();
  backend.beginDepthOnlyPass(framebuffer, 32, 32);
  backend.bindDepthTextureLayer(depthArray, 1, true);
  backend.setFullscreenState();
  backend.beginFullscreenPass(framebuffer, 16, 8, { label: 'prog' });
  backend.drawIntoTextureLevel(framebuffer, halfFloat, 0, 16, 8, 'incomplete');
  backend.finish();

  const { context: failContext } = createRecordingContext({ checkFramebufferStatus: () => 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT' });
  assert.throws(() => new WebGL2GlazeBackend(failContext).drawIntoTextureLevel({ label: 'fb' }, { label: 'tx' }, 0, 4, 4, 'boom'), /boom/);

  assert.ok(calls.some((call) => call[0] === 'activeTexture' && call[1] === 33986));
  assert.ok(calls.some((call) => call[0] === 'bindTexture' && call[1] === 'TEXTURE_2D_ARRAY' && call[2] === 'texArr'));
  assert.ok(calls.some((call) => call[0] === 'texStorage2D' && call[1] === 'TEXTURE_2D' && call[2] === 3 && call[3] === 'RGBA16F'));
  assert.ok(calls.some((call) => call[0] === 'texImage3D' && call[1] === 'TEXTURE_2D_ARRAY' && call[3] === 'DEPTH_COMPONENT24'));
  assert.ok(calls.some((call) => call[0] === 'texStorage3D' && call[1] === 'TEXTURE_2D_ARRAY' && call[2] === 5 && call[3] === 'SRGB8_ALPHA8'));
  assert.ok(calls.some((call) => call[0] === 'texParameterf' && call[1] === 'TEXTURE_2D_ARRAY' && call[2] === 'TEX_ANISO' && call[3] === 8));
  assert.ok(calls.some((call) => call[0] === 'drawBuffers'));
  assert.ok(calls.some((call) => call[0] === 'readBuffer' && call[1] === 'NONE'));
  assert.ok(calls.some((call) => call[0] === 'framebufferTextureLayer' && call[3] === 'texture2' && call[5] === 1));
  assert.ok(calls.some((call) => call[0] === 'clear' && call[1] === 256));
  assert.ok(calls.some((call) => call[0] === 'finish'));
});

test('cascaded-shadows.js routes allocation, pass drawing, uniforms and cleanup through GlazeBackend', () => {
  const { backend, calls } = createRecordingBackend({
    createTextureArray: () => ({ label: 'cascadeTex' }),
    createFramebuffer: () => ({ label: 'cascadeFb' }),
  });
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const cascades = createCascadedShadows({ count: 2, resolution: 256 });
  const drawn = [];
  const renderer = {
    backend,
    context: throwingContext,
    program: { label: 'mainProgram' },
    environment: { sunAngularRadius: 0.01 },
    tintView: { depthRange: 20, uvPerMetre: 0.1, biasPerSlope: 0.001 },
    world: true,
    activeLightDirection: [-3, 6, 4],
    shadowBounds: { target: [0, 0, 0], extent: 10 },
    view: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1]),
    inverseViewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]),
    viewForward: [0, 0, -1],
    renderTargets: { record() {}, release() {} },
    drawShadowCasters: (matrix) => drawn.push(matrix[0]),
  };
  cascades.fitToCamera = () => true;
  cascades.update(renderer, true);
  cascades.bindUniforms(renderer);
  cascades.dispose(throwingContext, renderer.renderTargets);

  assert.equal(drawn.length, 2);
  const methodNames = calls.map((call) => call[0]);
  for (const expected of ['activeTextureUnit', 'createTextureArray', 'createFramebuffer', 'beginDepthOnlyPass', 'bindDepthTextureLayer', 'bindCanvasTarget', 'uniformLocation', 'uniform1i', 'bindTextureUnit', 'uniformMatrix4fv', 'uniform4fv', 'uniform1f', 'uniform3f', 'deleteTexture', 'deleteFramebuffer']) {
    assert.ok(methodNames.includes(expected), `expected ${expected} call`);
  }
});

test('environment.js routes prefiltering, BRDF LUT and irradiance upload through GlazeBackend', async () => {
  const { backend, calls } = createRecordingBackend({
    createHalfFloatStorageTexture: () => ({ label: 'envTex' }),
    createFramebuffer: () => ({ label: 'envFb' }),
  });
  const map = createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(0.5) });
  const whole = createEnvironmentResources(backend, map, { fullscreenVertex: 'vs' });
  whole.dispose();
  const sliced = await createEnvironmentResourcesInSlices(backend, map, { fullscreenVertex: 'vs' }, async () => {});
  sliced.dispose();

  const methodNames = calls.map((call) => call[0]);
  for (const expected of ['extension', 'createHalfFloatStorageTexture', 'uploadFloatTexture2D', 'generateMipmap', 'createFramebuffer', 'compileProgram', 'setFullscreenState', 'useProgram', 'bindTextureUnit', 'uniformLocation', 'uniform1i', 'uniform2f', 'uniform1f', 'drawIntoTextureLevel', 'bindCanvasTarget', 'deleteFramebuffer', 'deleteProgram', 'deleteTexture', 'finish']) {
    assert.ok(methodNames.includes(expected), `expected ${expected} call`);
  }
});

test('post-steps.js routes targets, mipmaps, masks, sun rays and stages through GlazeBackend', () => {
  const { backend, calls } = createRecordingBackend();
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const renderer = installPostSteps({
    backend,
    context: throwingContext,
    postStages: [],
    canvas: { width: 16, height: 9 },
    hdr: true,
    depthTexture: { label: 'depth' },
    inverseViewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    viewForward: [0, 0, -1],
    activeLightDirection: [0, 0, 1],
    lighting: { keyColor: [3, 2, 1] },
    passSupport: { texture: { label: 'ids' }, objectNames: () => ['hero'] },
  });

  const baseEffects = resolveEffects({});
  const stageInputs = [
    ['Glare', { glare: { streaks: 0.5, fogGlow: 0.3 } }],
    ['Local tone mapping', { localToneMapping: { strength: 0.8 } }],
    ['Lens distortion', { lensDistortion: { distortion: 0.2, dispersion: 0.1 } }],
    ['Color balance', { colorBalance: { gain: [1.1, 1, 0.9], mask: { objects: ['hero'], depth: { near: 1, far: 5 } } } }],
    ['Color correction', { colorCorrection: { saturation: 0.2 } }],
    ['Sun rays', { sunRays: { intensity: 0.4 } }],
    ['Stylize', { stylize: { pixelate: 4, mask: { objects: ['hero'] } } }],
    ['Composite', { composite: { background: { color: [0, 0, 0] }, key: { luma: { low: 0.1, high: 0.5 } }, mask: { objects: ['hero'] } } }],
  ];
  for (const [name, input] of stageInputs) {
    const stage = renderer.postStages.find((candidate) => candidate.name === name);
    assert.ok(stage.apply(renderer, { eye: [0, 1, 5], effects: input }, baseEffects, { label: 'source' }), `${name} applied`);
    stage.releaseTargets(throwingContext);
    stage.dispose(throwingContext);
  }

  const methodNames = calls.map((call) => call[0]);
  for (const expected of ['compileProgram', 'uniformLocation', 'createFramebufferTarget', 'beginFullscreenPass', 'bindTextureUnit', 'uniform1i', 'uniform1iv', 'uniform1f', 'uniform2f', 'uniform2fv', 'uniform3f', 'uniform3fv', 'uniformMatrix4fv', 'activeTextureUnit', 'setTextureMipmaps', 'drawFullscreenTriangles', 'deleteTexture', 'deleteFramebuffer', 'deleteProgram']) {
    assert.ok(methodNames.includes(expected), `expected ${expected} call`);
  }
});

test('splat-renderer.js routes placeholders, texture arrays, bindings and disposal through GlazeBackend', () => {
  const { backend, calls } = createRecordingBackend({
    maxTextureSize: () => 2048,
    createTextureArray: () => ({ label: 'splatArray' }),
  });
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const renderer = {
    backend,
    context: throwingContext,
    program: { label: 'mainProgram' },
    whiteTexture: { label: 'white' },
    splatResources: new Map(),
    maxAnisotropy: 8,
    uniforms: Object.fromEntries([
      'splatColor', 'splatNormal', 'splatPacked', 'splatMask', 'splatEnabled',
      'splatLayer[0]', 'splatTint[0]', 'splatSlope[0]', 'splatHeightRange[0]',
      'splatMaskChannel[0]', 'splatMaskInvert[0]', 'splatBlend', 'splatOptions',
      'splatMaskBounds', 'splatVariation',
    ].map((name) => [name, `loc:${name}`])),
  };
  const material = { layers: [{ scale: 2 }] };
  const support = {
    resolveSize: () => 16,
    buildPixels: () => ({ color: new Uint8Array(16), normal: new Uint8Array(16), packed: new Uint8Array(16) }),
    packParameters: () => ({
      layer: new Float32Array(16),
      tint: new Float32Array(16),
      slope: new Float32Array(16),
      height: new Float32Array(16),
      mask: new Float32Array(4),
      maskInvert: new Float32Array(4),
      blend: new Float32Array(4),
      options: new Float32Array(4),
      maskBounds: new Float32Array(4),
      variation: new Float32Array(4),
    }),
  };

  initializeSplatPlaceholders(renderer);
  const resources = createSplatResources(renderer, material, support);
  bindSplat(renderer, resources);
  bindSplat(renderer, null);
  disposeSplatResources(renderer);

  const methodNames = calls.map((call) => call[0]);
  for (const expected of ['createTextureArray', 'useProgram', 'uniform1i', 'bindTextureUnit', 'uniform1f', 'maxTextureSize', 'uniform4fv', 'uniform1fv', 'deleteTexture']) {
    assert.ok(methodNames.includes(expected), `expected ${expected} call`);
  }
});

test('vertex array, data texture, framebuffer capture, state, draw and multisample attachment methods issue exact WebGL2 calls', () => {
  const originalUseProgramCalls = [];
  let activeFramebuffer = { label: 'msFb' };
  const { context, calls } = createRecordingContext({
    TEXTURE0: 33984,
    COLOR_ATTACHMENT0: 36064,
    COLOR_ATTACHMENT1: 36065,
    isContextLost: () => true,
    getContextAttributes: () => ({ alpha: true }),
    isEnabled: (cap) => cap === 'BLEND',
    getParameter: (parameter) => {
      if (parameter === 'TEXTURE_BINDING_2D') return { label: 'prevTex' };
      if (parameter === 'READ_FRAMEBUFFER_BINDING') return { label: 'prevReadFb' };
      if (parameter === 'PIXEL_PACK_BUFFER_BINDING') return { label: 'prevPackBuf' };
      if (parameter === 'DRAW_FRAMEBUFFER_BINDING') return activeFramebuffer;
      return null;
    },
    useProgram: (program) => {
      originalUseProgramCalls.push(program);
    },
  });
  const backend = new WebGL2GlazeBackend(context);

  const vertexBuffer = backend.createBuffer();
  backend.uploadBuffer('array', vertexBuffer, new Float32Array(9), 'static');
  const indexBuffer = backend.createBuffer();
  backend.uploadBuffer('element', indexBuffer, new Uint16Array(3), 'dynamic');
  backend.updateBuffer(vertexBuffer, new Float32Array(6), 0, 3);
  const vertexArray = backend.createVertexArray([
    { buffer: vertexBuffer, size: 3 },
    { buffer: vertexBuffer, size: 1, integer: true, divisor: 1 },
  ], indexBuffer);
  backend.bindVertexArray(vertexArray);
  backend.drawIndexed(3, true);
  backend.drawIndexed(6, false);
  backend.drawInstancedStrip(4, 5);
  backend.deleteVertexArray(vertexArray);

  const rgTarget = backend.createFramebufferTarget({ width: 8, height: 8, colorFormat: 'rg32f', clamp: true });
  assert.equal(rgTarget.complete, true);
  assert.throws(() => backend.createFramebufferTarget({ width: 4, height: 4, colorFormat: 'bad' }), /Unsupported texture format/);

  assert.equal(backend.isContextLost(), true);
  assert.equal(backend.hasCanvasAlpha(), true);
  assert.equal(backend.isBlendEnabled(), true);
  backend.bindFramebuffer({ label: 'targetFb' });
  backend.setViewport(16, 8, 2, 4);
  backend.clearColorBuffer(0, [0, 1, 0, 0]);
  backend.setRenderState({
    depthTest: false,
    depthWrite: false,
    cullFace: true,
    blend: true,
    blendMode: 'one',
    blendEquation: 'min',
    colorMask: [true, false, false, false],
  });
  backend.setRenderState({ blendMode: 'premultiplied', blendEquation: 'add' });

  const tableTexture = backend.createDataTexture2D({ width: 4, height: 1, format: 'r32f', clamp: false, data: new Float32Array(4) });
  const restoredTexture = backend.createDataTexture2D({ width: 2, height: 2, format: 'rgba8', linear: true, clamp: true, restoreBinding: true });
  backend.uploadDataTexture2D(tableTexture, { width: 4, height: 1, format: 'r32f', data: new Float32Array(4), reallocate: true });
  backend.uploadDataTexture2D(restoredTexture, { y: 1, width: 2, height: 1, format: 'rgba32ui', data: new Uint32Array(8), unit: 10 });
  backend.copyFramebufferToTexture({ label: 'srcFb' }, restoredTexture, 2, 2);
  backend.readIntegerTexture2D(restoredTexture, 2, 2, new Uint32Array(16));

  const renderbuffer = backend.createMultisampleColorAttachment({ label: 'msFb' }, 1, 4, 16, 8);
  assert.equal(renderbuffer.label, 'renderbuffer9');
  backend.clearColorAttachment({ label: 'msFb' }, 1, [0, 0, 0, 0]);
  backend.resolveColorAttachment({ label: 'msFb' }, { label: 'partFb' }, 1, 16, 8);

  let enabled = true;
  const mainProgram = { label: 'mainProg' };
  backend.watchProgramAttachment(1, () => (enabled ? activeFramebuffer : null), (program) => program === mainProgram);
  context.useProgram(mainProgram);
  context.useProgram({ label: 'skyProg' });
  enabled = false;
  context.useProgram(mainProgram);

  assert.equal(originalUseProgramCalls.length, 3);
  assert.ok(calls.some((call) => call[0] === 'bufferData' && call[1] === 'ARRAY_BUFFER' && call[3] === 'STATIC_DRAW'));
  assert.ok(calls.some((call) => call[0] === 'bufferData' && call[1] === 'ELEMENT_ARRAY_BUFFER' && call[3] === 'DYNAMIC_DRAW'));
  assert.ok(calls.some((call) => call[0] === 'bufferSubData' && call[1] === 'ARRAY_BUFFER' && call[2] === 0 && call[4] === 0 && call[5] === 3));
  assert.ok(calls.some((call) => call[0] === 'vertexAttribPointer' && call[1] === 0 && call[2] === 3 && call[3] === 'FLOAT'));
  assert.ok(calls.some((call) => call[0] === 'vertexAttribIPointer' && call[1] === 1 && call[2] === 1 && call[3] === 'UNSIGNED_INT'));
  assert.ok(calls.some((call) => call[0] === 'vertexAttribDivisor' && call[1] === 1 && call[2] === 1));
  assert.ok(calls.some((call) => call[0] === 'drawElements' && call[2] === 3 && call[3] === 'UNSIGNED_SHORT'));
  assert.ok(calls.some((call) => call[0] === 'drawElements' && call[2] === 6 && call[3] === 'UNSIGNED_INT'));
  assert.ok(calls.some((call) => call[0] === 'drawArraysInstanced' && call[1] === 'TRIANGLE_STRIP' && call[3] === 4 && call[4] === 5));
  assert.ok(calls.some((call) => call[0] === 'texImage2D' && call[3] === 'RG32F' && call[7] === 'RG' && call[8] === 'FLOAT'));
  assert.ok(calls.some((call) => call[0] === 'texImage2D' && call[3] === 'R32F' && call[7] === 'RED' && call[8] === 'FLOAT'));
  assert.ok(calls.some((call) => call[0] === 'texSubImage2D' && call[4] === 1 && call[7] === 'RGBA_INTEGER' && call[8] === 'UNSIGNED_INT'));
  assert.ok(calls.some((call) => call[0] === 'copyTexSubImage2D' && call[7] === 2 && call[8] === 2));
  assert.ok(calls.some((call) => call[0] === 'readPixels' && call[5] === 'RGBA_INTEGER' && call[6] === 'UNSIGNED_INT'));
  assert.ok(calls.some((call) => call[0] === 'framebufferRenderbuffer' && call[2] === 36065));
  assert.ok(calls.some((call) => call[0] === 'readBuffer' && call[1] === 36065));
  assert.ok(calls.some((call) => call[0] === 'drawBuffers'));
  assert.ok(calls.some((call) => call[0] === 'blendEquation' && call[1] === 'MIN'));
  assert.ok(calls.some((call) => call[0] === 'blendFuncSeparate'));
});

test('mesh-blend.js routes attachments, table upload, program hook, fullscreen pass and cleanup through GlazeBackend', () => {
  const { backend, calls } = createRecordingBackend({
    createMultisampleColorAttachment: () => ({ label: 'partRb' }),
    createDataTexture2D: () => ({ label: 'radiusTex' }),
  });
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const batch = { parts: [{ name: 'ground' }, { name: 'rock', blend: { radius: 0.2 } }], cullable: true };
  const renderer = {
    backend,
    context: throwingContext,
    canvas: { width: 16, height: 12 },
    benchmark: false,
    hdr: true,
    depthTexture: { label: 'depthTex' },
    multisampleFramebuffer: { label: 'msFb' },
    multisampleSamples: 4,
    program: { label: 'mainProgram' },
    projection: new Float32Array([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]),
    inverseViewProjection: new Float32Array(16),
    postStages: [],
    renderTargets: { record() {}, release() {} },
    batches: [batch],
    requireFeatureNames() {},
    drawsInOpaqueLoop: () => true,
    render() {
      const result = this.postStages[0].apply(this, { eye: [0, 1, 4] }, {}, { label: 'sourceTex' });
      assert.ok(result);
    },
  };

  installMeshBlend(renderer);
  renderer.render({ eye: [0, 1, 4] });
  renderer.postStages[0].releaseTargets(throwingContext);
  renderer.postStages[0].dispose(throwingContext);

  const methodNames = calls.map((call) => call[0]);
  for (const expected of [
    'watchProgramAttachment', 'createDataTexture2D', 'createMultisampleColorAttachment',
    'createFramebufferTarget', 'clearColorAttachment', 'resolveColorAttachment',
    'compileProgram', 'uniformLocation', 'beginFullscreenPass', 'bindTextureUnit',
    'uniform1i', 'uniformMatrix4fv', 'uniform3fv', 'uniform1f', 'drawFullscreenTriangles',
    'deleteRenderbuffer', 'deleteTexture', 'deleteFramebuffer', 'deleteProgram',
  ]) {
    assert.ok(methodNames.includes(expected), `expected ${expected} call`);
  }
});

test('mesh-volume-pass.js routes geometry buffers, RG32F target, state, draws and disposal through GlazeBackend', () => {
  const { backend, calls } = createRecordingBackend({
    maxTextureSize: () => 4096,
    createBuffer: () => ({ label: 'meshBuf' }),
    createVertexArray: () => ({ label: 'meshVao' }),
    isBlendEnabled: () => false,
  });
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const closedTetrahedron = (offset) => ({
    positions: new Float32Array([offset, 0, 0, offset + 1, 0, 0, offset, 1, 0, offset, 0, 1]),
    normals: new Float32Array(12),
    indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  });
  const renderer = {
    backend,
    context: throwingContext,
    dispose() { this.disposed = true; },
    canvas: { width: 16, height: 12 },
    depthTexture: { label: 'depthTex' },
    viewProjection: new Float32Array(16),
    inverseViewProjection: new Float32Array(16),
    renderTargets: { record() {}, release() {} },
    localVolumeBuffers: { meshParts: [{ label: 'environment.localVolumes[0]', part: { name: 'room', geometry: closedTetrahedron(0) } }] },
  };

  const texture = drawMeshVolumes(renderer, { eye: [0, 0, 5], projection: 'perspective' });
  assert.ok(texture);
  renderer.localVolumeBuffers.meshParts[0].part.geometry = closedTetrahedron(2);
  drawMeshVolumes(renderer, { eye: [0, 0, 5], projection: 'perspective' });
  renderer.dispose();
  assert.equal(renderer.disposed, true);

  const methodNames = calls.map((call) => call[0]);
  for (const expected of [
    'extension', 'compileProgram', 'uniformLocation', 'createBuffer', 'uploadBuffer',
    'createVertexArray', 'maxTextureSize', 'createFramebufferTarget', 'isBlendEnabled',
    'bindFramebuffer', 'setRenderState', 'clearColorBuffer', 'useProgram',
    'bindTextureUnit', 'uniform1i', 'uniformMatrix4fv', 'uniform3fv', 'uniform1f',
    'uniform2f', 'setViewport', 'setFrontFaceClockwise', 'bindVertexArray',
    'drawIndexed', 'deleteVertexArray', 'deleteBuffer', 'deleteTexture',
    'deleteFramebuffer', 'deleteProgram',
  ]) {
    assert.ok(methodNames.includes(expected), `expected ${expected} call`);
  }
});

test('user-pass.js and user-pass-inputs.js route passes, needs captures, LUTs and cleanup through GlazeBackend', () => {
  const { backend, calls } = createRecordingBackend({
    hasCanvasAlpha: () => true,
    createDataTexture2D: () => ({ label: 'passTex' }),
  });
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const renderer = {
    backend,
    context: throwingContext,
    canvas: { width: 16, height: 12 },
    benchmark: false,
    depthTexture: { label: 'depthTex' },
    whiteTexture: { label: 'whiteTex' },
    inverseViewProjection: new Float32Array(16),
    postStages: [],
    pixelGrid: { active: false, latticeOrigin: () => [0, 0] },
    passSupport: {
      framebuffer: { label: 'passFb' },
      texture: { label: 'passIdTex' },
      objectNames: () => ['hero'],
    },
    render() {},
    resolveFrame() {},
  };

  installUserPasses(renderer);
  renderer.userPasses.set([
    {
      name: 'first',
      scale: 0.5,
      offset: [1, 0],
      needs: ['normal', 'objectId'],
      objects: ['hero'],
      luts: { palette: { colors: ['#102030', '#f0f0f0'] } },
      uniforms: { strength: 0.5 },
      fragment: 'vec4 userPass(vec2 uv) { return vec4(normalAt(uv) * strength + texture(palette, uv).rgb + float(objectIdAt(uv) + objectSlotAt(uv)), 1.0); }',
    },
    {
      name: 'second',
      scale: 1,
      fragment: 'vec4 userPass(vec2 uv) { return texture(sceneColor, uv); }',
    },
  ]);
  renderer.render({ eye: [0, 1, 5], time: 1 });
  renderer.resolveFrame({ eye: [0, 1, 5], time: 1 });
  renderer.pixelGrid.active = true;
  renderer.resolveFrame({ eye: [0, 1, 5], time: 2 });
  renderer.postStages[0].releaseTargets(throwingContext);
  renderer.postStages[0].dispose(throwingContext);

  const methodNames = calls.map((call) => call[0]);
  for (const expected of [
    'createDataTexture2D', 'copyFramebufferToTexture', 'compileProgram', 'uniformLocation',
    'setFullscreenState', 'hasCanvasAlpha', 'createFramebufferTarget', 'beginFullscreenPass',
    'uniform2fv', 'bindTextureUnit', 'uniform1i', 'uniformMatrix4fv', 'uniform2f',
    'uniform1f', 'uniform3fv', 'uniform1iv', 'activeTextureUnit', 'drawFullscreenTriangles',
    'deleteTexture', 'deleteFramebuffer', 'deleteProgram',
  ]) {
    assert.ok(methodNames.includes(expected), `expected ${expected} call`);
  }
});

test('gaussian-splats.js routes textures, buffers, VAOs, states, draws, update and detach through GlazeBackend', () => {
  const { backend, calls } = createRecordingBackend({
    maxTextureSize: () => 4096,
    createDataTexture2D: () => ({ label: 'splatTex' }),
    createBuffer: () => ({ label: 'orderBuf' }),
    createVertexArray: () => ({ label: 'splatVao' }),
    isContextLost: () => false,
    readIntegerTexture2D: (_texture, _width, _height, destination) => destination.fill(0),
  });
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const renderer = {
    backend,
    context: throwingContext,
    canvas: { width: 32, height: 24 },
    multisampleFramebuffer: { label: 'msFb' },
    projection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]),
    view: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    hdr: false,
    drawBlendBatches() {},
    dispose() {},
  };
  const splatData = (alphaCut, extra = {}) => createGaussianSplats({
    count: 1,
    positions: new Float32Array([0, 0, -4]),
    scales: new Float32Array([0.1, 0.1, 0.1]),
    rotations: new Float32Array([1, 0, 0, 0]),
    colors: new Uint8Array([200, 100, 50, 255]),
    bounds: { minimum: [-1, -1, -5], maximum: [1, 1, -3] },
  }, { alphaCut, ...extra });

  const detachBlended = attachGaussianSplats(renderer, splatData(undefined));
  const detachStylized = attachGaussianSplats(renderer, splatData(0.5, { palette: ['#101010', '#f0f0f0'], outline: { width: 2, color: '#000000' } }));
  renderer.drawBlendBatches({ eye: [0, 0, 0], exposure: 1 });
  detachBlended.update({ positions: new Float32Array([0.5, 0, -4]) });
  detachBlended();
  detachStylized();

  const methodNames = calls.map((call) => call[0]);
  for (const expected of [
    'compileProgram', 'uniformLocation', 'createDataTexture2D', 'createBuffer', 'uploadBuffer',
    'createVertexArray', 'bindFramebuffer', 'setViewport', 'setRenderState', 'useProgram',
    'uniformMatrix4fv', 'uniform2f', 'uniform1f', 'uniform1i', 'uniform3fv', 'updateBuffer',
    'bindTextureUnit', 'bindVertexArray', 'drawInstancedStrip', 'activeTextureUnit',
    'isContextLost', 'readIntegerTexture2D', 'uploadDataTexture2D', 'deleteTexture',
    'deleteBuffer', 'deleteVertexArray', 'deleteProgram',
  ]) {
    assert.ok(methodNames.includes(expected), `expected ${expected} call`);
  }
});

test('storage targets, 3D textures, attributes, clearColorAndDepth, blit strings and instanced triangles issue exact WebGL2 calls', () => {
  const { context, calls } = createRecordingContext({
    getAttribLocation: (_program, name) => (name === 'startPoint' ? 0 : 1),
  });
  const backend = new WebGL2GlazeBackend(context);

  const storageTarget = backend.createFramebufferTarget({
    width: 16,
    height: 16,
    colorFormat: 'rgba16f',
    depth: true,
    floatDepth: true,
    depthAsTexture: true,
    storage: true,
    levels: 4,
    linear: true,
    clamp: true,
  });
  assert.equal(storageTarget.complete, true);
  backend.blitTarget({ label: 'src' }, { label: 'dst' }, 16, 16, 'color');
  backend.blitTarget({ label: 'src' }, { label: 'dst' }, 16, 16, 'depth');
  backend.uniform4f({ label: 'u4' }, 1, 2, 3, 4);
  const texture3d = backend.createTexture3D({ width: 4, height: 4, depth: 4, data: new Uint16Array(256) });
  backend.uploadTexture3D(texture3d, { width: 4, height: 4, depth: 4, data: new Uint16Array(256) });
  backend.bindTextureUnit(8, texture3d, '3d');
  backend.clearColorAndDepth([0, 0, 0, 0], 1);
  backend.setRenderState({ depthFunc: 'greater', cullMode: 'front', blend: true, blendMode: 'alpha' });
  assert.equal(backend.attribLocation({ label: 'prog' }, 'startPoint'), 0);
  backend.bindArrayBuffer({ label: 'buf' });
  backend.bindVertexAttributes({ label: 'buf' }, [{ location: 0, size: 3, stride: 24, offset: 0, divisor: 1 }]);
  backend.setConstantAttribute1f(1, 0);
  backend.drawInstancedTriangles(6, 3);

  assert.ok(calls.some((call) => call[0] === 'texStorage2D' && call[2] === 4 && call[3] === 'RGBA16F'));
  assert.ok(calls.some((call) => call[0] === 'texStorage2D' && call[2] === 1 && call[3] === 'DEPTH_COMPONENT32F'));
  assert.ok(calls.some((call) => call[0] === 'texParameteri' && call[2] === 'TEXTURE_MIN_FILTER' && call[3] === 'LINEAR_MIPMAP_LINEAR'));
  assert.ok(calls.some((call) => call[0] === 'blitFramebuffer' && call[9] === 16384));
  assert.ok(calls.some((call) => call[0] === 'blitFramebuffer' && call[9] === 256));
  assert.ok(calls.some((call) => call[0] === 'uniform4f' && call[2] === 1 && call[5] === 4));
  assert.ok(calls.some((call) => call[0] === 'texImage3D' && call[1] === 'TEXTURE_3D' && call[3] === 'RGBA16F'));
  assert.ok(calls.some((call) => call[0] === 'texSubImage3D' && call[1] === 'TEXTURE_3D'));
  assert.ok(calls.some((call) => call[0] === 'bindTexture' && call[1] === 'TEXTURE_3D' && call[2] === texture3d.label));
  assert.ok(calls.some((call) => call[0] === 'clearColor' && call[1] === 0 && call[4] === 0));
  assert.ok(calls.some((call) => call[0] === 'clear' && call[1] === (16384 | 256)));
  assert.ok(calls.some((call) => call[0] === 'depthFunc' && call[1] === 'GREATER'));
  assert.ok(calls.some((call) => call[0] === 'cullFace' && call[1] === 'FRONT'));
  assert.ok(calls.some((call) => call[0] === 'blendFuncSeparate' && call[1] === 'SRC_ALPHA'));
  assert.ok(calls.some((call) => call[0] === 'vertexAttribPointer' && call[2] === 3 && call[5] === 24));
  assert.ok(calls.some((call) => call[0] === 'vertexAttribDivisor' && call[1] === 0 && call[2] === 1));
  assert.ok(calls.some((call) => call[0] === 'disableVertexAttribArray' && call[1] === 1));
  assert.ok(calls.some((call) => call[0] === 'vertexAttrib1f' && call[1] === 1 && call[2] === 0));
  assert.ok(calls.some((call) => call[0] === 'drawArraysInstanced' && call[1] === 'TRIANGLES' && call[3] === 6 && call[4] === 3));
});

test('fog-shader.js and fog-field.js route field textures, 3D grid textures, composite passes and cleanup through GlazeBackend', () => {
  const { backend, calls } = createRecordingBackend({
    createDataTexture2D: () => ({ label: 'fieldTex' }),
    createTexture3D: () => ({ label: 'gridTex3d' }),
  });
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const fogSupport = requireFeatureCode('volumeFog').support;
  const post = {
    program: { label: 'postProg' },
    uniforms: new Proxy({}, { get: (target, name) => (name in target ? target[name] : `loc:${String(name)}`) }),
  };
  const grid = { resolution: [2, 2, 2], channels: { density: new Float32Array(8).fill(0.5), temperature: new Float32Array(8).fill(1500) } };
  const renderer = {
    backend,
    context: throwingContext,
    canvas: { width: 32, height: 24 },
    shadowTexture: { label: 'shadowTex' },
    depthTexture: { label: 'depthTex' },
    whiteTexture: { label: 'whiteTex' },
    lightProjection: new Float32Array(16),
    inverseViewProjection: new Float32Array(16),
    lighting: { keyColor: [1, 1, 1], ambientIntensity: 0.3 },
    sceneParts: [],
    fogLightBuffers: {
      count: 1,
      positions: new Float32Array(32),
      colors: new Float32Array(32),
      directions: new Float32Array(32),
      cones: new Float32Array(32),
    },
    localVolumeBuffers: {
      count: 1,
      kind: 'grid',
      noiseOctaves: false,
      gridDetail: false,
      gridShutter: 0,
      blurred: true,
      centers: new Float32Array(32),
      extents: new Float32Array(32),
      absorption: new Float32Array(32),
      emission: new Float32Array(32),
      steps: new Float32Array(32),
      axes: new Float32Array(96),
      meshParts: [],
      grid: new Float32Array(32),
      rampSetup: new Float32Array(32),
      rampColors: new Float32Array(32),
      gridVolume: { gridData: grid, temperatureScale: 1, flameTemperature: { ignition: 1000, maximum: 3000 } },
    },
  };

  const volume = {
    density: 0.4,
    minimum: [-1, -1, -1],
    maximum: [1, 1, 1],
    color: [1, 1, 1],
    ambient: [0.1, 0.1, 0.1],
    drift: [0, 0, 0],
    steps: 12,
    anisotropy: 0.2,
    noiseAmount: 0.2,
    noiseScale: 0.5,
    maxDistance: 50,
    heightFalloff: 0,
    field: { width: 2, height: 2, data: new Float32Array(16) },
  };
  const frame = { eye: [0, 1, 4], projection: 'perspective' };
  const environment = { lightDirection: [0, 1, 0], skyTop: [0.2, 0.3, 0.4], skyBottom: [0.5, 0.6, 0.7] };

  fogSupport.bindUniforms(renderer, post, volume, environment, frame);
  fogSupport.bindUniforms(renderer, post, volume, environment, frame);
  const texture = fogSupport.compositeLocalVolumes(renderer, frame, environment, { label: 'srcTex' });
  assert.ok(texture);
  renderer.localVolumeBuffers.gridVolume.gridData = { ...grid, channels: { density: new Float32Array(8).fill(0.8), temperature: new Float32Array(8).fill(1800) } };
  renderer.localVolumeBuffers.kind = 'both';
  fogSupport.compositeLocalVolumes(renderer, frame, environment, { label: 'srcTex' });
  renderer.fogFieldTexture.dispose();
  fogSupport.releaseLocalVolumeComposite(renderer, true);

  assert.ok(FogFieldTexture);
  const methodNames = calls.map((call) => call[0]);
  for (const expected of [
    'bindTextureUnit', 'uniform1i', 'uniformMatrix4fv', 'uniform3fv', 'uniform1f',
    'createDataTexture2D', 'uploadDataTexture2D', 'activeTextureUnit', 'uniformLocation',
    'uniform4fv', 'compileProgram', 'createFramebufferTarget', 'beginFullscreenPass',
    'setTextureMipmaps', 'uniform2f', 'createTexture3D', 'uploadTexture3D',
    'drawFullscreenTriangles', 'deleteTexture', 'deleteFramebuffer', 'deleteProgram',
  ]) {
    assert.ok(methodNames.includes(expected), `expected ${expected} call`);
  }
});

test('line-art.js routes guides, node table, outlines, polylines and cleanup through GlazeBackend', () => {
  const { backend, calls } = createRecordingBackend({
    createDataTexture2D: () => ({ label: 'nodeTex' }),
    createBuffer: () => ({ label: 'polyBuf' }),
    createVertexArray: () => ({ label: 'polyVao' }),
    attribLocation: (_program, name) => (name === 'startPoint' ? 0 : name === 'endPoint' ? 1 : 2),
  });
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const renderer = {
    backend,
    context: throwingContext,
    canvas: { width: 32, height: 24 },
    benchmark: false,
    hdr: true,
    depthTexture: { label: 'depthTex' },
    program: { label: 'mainProgram' },
    uniforms: {},
    shaderFeatures: new Set(['toon']),
    batches: [{ label: 'b1' }],
    projection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]),
    view: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]),
    postStages: [],
    passSupport: {
      framebuffer: { label: 'passFb' },
      objectNodes: () => ({ hero: [1] }),
    },
    requireFeatureNames() {},
    rebuildMainProgram() {},
    render(frame) {
      if (frame.pass) return;
      for (const stage of this.postStages) stage.apply(this, frame, {}, { label: 'sourceTex' });
    },
  };

  installLineArt(renderer);
  renderer.rebuildMainProgram();
  renderer.render({
    lines: resolveLineArt({
      width: 2,
      toon: 3,
      nodes: { hero: { color: [1, 0, 0] } },
      polylines: [
        { points: [[0, 0, 0], [1, 0, 0]], color: [0, 0, 0], width: 2, style: 'solid' },
        { points: [[0, 1, 0], [1, 1, 0]], color: [0, 0, 1], width: 2, style: 'dashed', dashLength: 6, gapLength: 4 },
      ],
    }),
  });
  renderer.render({
    lines: resolveLineArt({
      boundaries: false,
      creaseAngle: 0,
      depthJump: 0,
      polylines: [{ points: [[0, 0, 0], [1, 0, 0]], color: [0, 0, 0], width: 2 }],
    }),
  });
  renderer.postStages[0].releaseTargets(throwingContext);
  renderer.postStages[0].dispose(throwingContext);

  const methodNames = calls.map((call) => call[0]);
  for (const expected of [
    'uniformLocation', 'useProgram', 'uniform1f', 'blitTarget', 'createFramebufferTarget',
    'beginFullscreenPass', 'compileProgram', 'bindTextureUnit', 'uniform1i',
    'createDataTexture2D', 'uploadDataTexture2D', 'uniform3fv', 'uniform3f',
    'drawFullscreenTriangles', 'createVertexArray', 'setRenderState', 'uniformMatrix4fv',
    'uniform2f', 'attribLocation', 'createBuffer', 'uploadBuffer', 'bindVertexAttributes',
    'setConstantAttribute1f', 'drawInstancedTriangles', 'deleteTexture',
    'deleteFramebuffer', 'deleteBuffer', 'deleteProgram', 'deleteVertexArray',
  ]) {
    assert.ok(methodNames.includes(expected), `expected ${expected} call`);
  }
});

test('liquid-renderer.js routes mip chain, scene depth, back faces, glass draws, foams and release through GlazeBackend', () => {
  const { backend, calls } = createRecordingBackend();
  const throwingContext = new Proxy({}, { get() { throw new Error('raw context touched'); } });
  const unitBox = { positions: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]) };
  const makeBatch = (scale, zPositions = [0], closed = true) => {
    const layerState = new Float32Array(32);
    layerState[9] = 1;
    layerState[10] = 1.5;
    layerState[11] = closed ? 1 : 0;
    layerState[12] = 10;
    layerState[13] = 1;
    layerState[14] = 1;
    layerState[15] = 1;
    return {
      alphaMode: 'blend',
      opacity: 0.5,
      doubleSided: true,
      mirrored: true,
      layerState,
      mapState: [],
      textures: [],
      instanceCount: zPositions.length,
      indexCount: 36,
      instanceBuffer: zPositions.length > 1 ? { label: 'instBuf' } : null,
      instanceData: zPositions.length > 1 ? new Float32Array(42 * zPositions.length) : null,
      vertexArray: { label: 'glassVao' },
      parts: zPositions.map((z) => ({
        name: 'glass',
        geometry: unitBox,
        matrix: new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, z, 1]),
        material: { mediumContinues: !closed },
      })),
    };
  };
  const overlapping = makeBatch(0.5, [-2, 0]);
  const thinPane = makeBatch(0.5, [1], false);
  const outer = makeBatch(2, [0]);
  const inner = makeBatch(0.5, [0]);
  const renderer = {
    backend,
    context: throwingContext,
    canvas: { width: 32, height: 24 },
    hdr: true,
    reversedDepth: true,
    multisampleFramebuffer: { label: 'msFb' },
    resolveFramebuffer: { label: 'resFb' },
    frameTexture: { label: 'frameTex' },
    view: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]),
    lightProjection: new Float32Array(16),
    lighting: { keyColor: [1, 1, 1], ambientIntensity: 0.3 },
    batches: [overlapping, thinPane],
    renderTargets: { record() {}, release() {} },
    withViewTransform: (source) => source,
    applyEnvironmentUniforms() {},
  };

  assert.ok(copySceneIntoMipChain(renderer, 32, 24));
  assert.ok(resolveSceneDepth(renderer, 32, 24));
  drawLiquidPass(renderer, {
    frame: { eye: [0, 0, 5] },
    environment: { daylight: 1, lightDirection: [0, 1, 0], fogColor: [0, 0, 0], fogDensity: 0, explosionCenter: [0, 0, 0] },
    assemblyAmount: 0,
    environmentMap: null,
    liquids: [overlapping, thinPane],
    foams: [{ vertexArray: { label: 'foamVao' }, indexCount: 6, instanceCount: 1 }],
    environmentSpecularUnit: 9,
    maximumDistance: 100,
    vertexSource: 'vs',
    fragmentSource: 'fs',
  });
  renderer.batches = [outer, inner];
  const backFaces = drawGlassBackFaces(renderer, [outer, inner], 32, 24);
  assert.equal(backFaces.farLayer, true);
  renderer.refractionChain.release();
  renderer.refractionDepth.release();

  const methodNames = calls.map((call) => call[0]);
  for (const expected of [
    'activeTextureUnit', 'createFramebufferTarget', 'blitTarget', 'bindTextureUnit',
    'generateMipmap', 'compileProgram', 'uniformLocation', 'useProgram', 'uniform1i',
    'bindFramebuffer', 'setViewport', 'clearColorAndDepth', 'setRenderState', 'uniform1f',
    'setFrontFaceClockwise', 'bindVertexArray', 'updateBuffer', 'bindArrayBuffer',
    'drawIndexedInstanced', 'uniformMatrix4fv', 'uniform3fv', 'uniform2f', 'uniform4f',
    'uniform3f', 'deleteTexture', 'deleteFramebuffer',
  ]) {
    assert.ok(methodNames.includes(expected), `expected ${expected} call`);
  }
});
