import assert from 'node:assert/strict';
import test from 'node:test';

import { box } from '../src/geometry.js';
import { resolveTraceSubsurface } from '../src/path-tracer-subsurface.js';

// A stand-in WebGL2 context that accepts every call and counts the GL objects it hands out and takes back.
function createFakeContext() {
  class FakeFramebuffer {}
  globalThis.WebGLFramebuffer = FakeFramebuffer;
  const counts = { texture: 0, framebuffer: 0, program: 0, deleted: { texture: 0, framebuffer: 0, program: 0 }, uniforms: new Map() };
  const constants = new Map();
  const handlers = {
    createTexture: () => { counts.texture++; return {}; },
    createFramebuffer: () => { counts.framebuffer++; return new FakeFramebuffer(); },
    createProgram: () => { counts.program++; return { index: counts.program }; },
    deleteTexture: () => { counts.deleted.texture++; },
    deleteFramebuffer: () => { counts.deleted.framebuffer++; },
    deleteProgram: () => { counts.deleted.program++; },
    getParameter: () => 16384,
    getShaderParameter: () => true,
    getProgramParameter: program => program.index !== counts.failingProgram,
    getUniformLocation: (program, name) => ({ name }),
    uniform1i: (location, value) => { if (location?.name) counts.uniforms.set(location.name, value); },
    uniform3fv: (location, value) => { if (location?.name) counts.uniforms.set(location.name, Array.from(value)); },
    getExtension: () => ({}),
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
  };
  const gl = new Proxy({ canvas: {} }, {
    get(target, name) {
      if (name in target) return target[name];
      if (name in handlers) return handlers[name];
      if (/^[A-Z0-9_]+$/.test(name)) {
        if (!constants.has(name)) constants.set(name, constants.size + 1);
        return constants.get(name);
      }
      return () => ({});
    },
  });
  globalThis.OffscreenCanvas = class { getContext() { return gl; } };
  return counts;
}

const counts = createFakeContext();
const { createRealtimeTracer } = await import('../src/path-tracer-realtime.js');
const { createProgressiveTracer } = await import('../src/path-tracer-progressive.js');
const WALL = { name: 'wall', geometry: box(), material: { color: [1, 1, 1], roughness: 1, metallic: 0 } };
const CAMERA = { eye: [0, 0, 3], target: [0, 0, 0], up: [0, 1, 0], fov: 30 };

const TEXTURES_AND_FRAMEBUFFERS = ['texture', 'framebuffer'];

function liveObjects(kinds = ['texture', 'framebuffer', 'program']) {
  return kinds.map(kind => counts[kind] - counts.deleted[kind]);
}

test('a real-time tracer that cannot load its scene gives back the GL objects it made', async () => {
  const before = liveObjects();
  await assert.rejects(createRealtimeTracer({ parts: [] }), /1 to 1024 parts/);
  assert.deepEqual(liveObjects(), before);
});

test('a real-time tracer whose kernel does not build gives back the GL objects it made', async () => {
  const before = liveObjects(TEXTURES_AND_FRAMEBUFFERS);
  const passProgramCount = 5;
  counts.failingProgram = counts.program + passProgramCount + 1;
  await assert.rejects(createRealtimeTracer({ parts: [WALL] }));
  counts.failingProgram = null;
  assert.deepEqual(liveObjects(TEXTURES_AND_FRAMEBUFFERS), before);
});

test('a refused scene update keeps the scene the tracer already has', async () => {
  const tracer = await createRealtimeTracer({ parts: [WALL] });
  const deletedBefore = counts.deleted.texture;
  assert.throws(() => tracer.update({ parts: [] }), /1 to 1024 parts/);
  assert.equal(counts.deleted.texture, deletedBefore, 'the textures of the working scene were deleted');
  assert.doesNotThrow(() => tracer.frame(CAMERA));
  tracer.dispose();
});

test('realtime and progressive tracers apply update({ environment }) without parts', async () => {
  const realtime = await createRealtimeTracer({ parts: [WALL] });
  realtime.frame(CAMERA);
  assert.equal(counts.uniforms.get('uHasSun'), 0);
  realtime.update({ environment: { lightDirection: [0, 1, 0], keyIntensity: 3, keyColor: [1, 1, 1] } });
  realtime.frame(CAMERA);
  assert.equal(counts.uniforms.get('uHasSun'), 1);
  assert.throws(
    () => realtime.update({ environment: { localVolumes: [{ shape: 'sphere', center: [0, 1, 0], radius: 1 }] } }),
    /environment\.localVolumes/,
  );
  assert.doesNotThrow(() => realtime.frame(CAMERA));
  realtime.dispose();

  const progressive = await createProgressiveTracer({ parts: [WALL], camera: CAMERA }, { width: 16, height: 16, maxSeconds: 60 });
  assert.equal(counts.uniforms.get('uHasSun'), 0);
  progressive.update({ environment: { lightDirection: [0, 1, 0], keyIntensity: 2, keyColor: [1, 1, 1] } });
  assert.equal(counts.uniforms.get('uHasSun'), 1);
  progressive.dispose();
});

test('a traced subsurface block that is not three radii in range is refused with the field name', () => {
  assert.throws(() => resolveTraceSubsurface({ weight: 1, radius: 1 }), /subsurface\.radius must be three numbers/);
  assert.throws(() => resolveTraceSubsurface({ weight: 1, radius: [NaN, 1, 1] }), /subsurface\.radius must be three numbers/);
  assert.throws(() => resolveTraceSubsurface({ weight: 1, scale: Infinity }), /subsurface\.scale must be between/);
  assert.throws(() => resolveTraceSubsurface({ weight: NaN }), /subsurface\.weight must be between/);
  assert.deepEqual(resolveTraceSubsurface({ weight: 1, radius: [1, 0.2, 0.1], scale: 0.05 }).meanFreePath.map(value => +value.toFixed(6)), [0.05, 0.01, 0.005]);
  assert.equal(resolveTraceSubsurface({ weight: 0 }), null);
  assert.equal(resolveTraceSubsurface(undefined), null);
});
