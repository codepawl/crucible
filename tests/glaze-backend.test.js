// The Glaze backend boundary (#901): the WebGL2 implementation issues exactly the GL calls CrucibleRenderer made itself before the boundary existed.
// A recording context stands in for WebGL2; the expected lists below are the calls of the old renderer code, in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { asGlazeBackend, backendFor, createGlazeBackend } from '../src/glaze-backend.js';
import { WebGL2GlazeBackend } from '../src/glaze-backend-webgl2.js';
import { createFloatOutput, outputFor, readFloatPixels, readFrame, requireFloatTargets } from '../src/float-output.js';
import { installReversedDepth } from '../src/reversed-depth.js';
import { installRenderPasses, RENDER_PASS_MODES } from '../src/render-passes.js';

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
