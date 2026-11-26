import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAIN_DEFAULTS,
  RAIN_LIMITS,
  resolveRain,
  sampleRainIntensity,
  generateRainSeedData,
  generateSplashSeedData,
  installRain,
} from '../src/rain.js';

test('resolveRain fills defaults, validates bounds, and freezes config', () => {
  const defaulted = resolveRain();
  assert.equal(defaulted.intensity, RAIN_DEFAULTS.intensity);
  assert.equal(defaulted.density, RAIN_DEFAULTS.density);
  assert.equal(defaulted.splashes, true);
  assert.equal(Object.isFrozen(defaulted), true);

  assert.throws(() => resolveRain('bad'), /plain configuration object/);
  assert.throws(() => resolveRain({ unknownField: 1 }), /Unknown rain field/);
  assert.throws(() => resolveRain({ intensity: 1.5 }), /rain\.intensity/);
  assert.throws(() => resolveRain({ density: RAIN_LIMITS.minDensity - 1 }), /rain\.density/);
  assert.throws(() => resolveRain({ volume: [1, 10, 10] }), /rain\.volume\[0\]/);
  assert.throws(() => resolveRain({ splashes: 'yes' }), /rain\.splashes/);
  assert.throws(() => resolveRain({ intensityCurve: [{ time: 0, value: 0 }] }), /intensityCurve/);
  assert.throws(() => resolveRain({ intensityCurve: [{ time: 2, value: 0 }, { time: 1, value: 1 }] }), /must not decrease/);
});

test('sampleRainIntensity and seed generators are deterministic on backward and forward seeks', () => {
  const rain = resolveRain({
    intensity: 0.4,
    intensityCurve: [
      { time: 0, value: 0.2 },
      { time: 2, value: 1.0 },
      { time: 4, value: 0.0 },
    ],
  });
  assert.equal(sampleRainIntensity(rain, -1), 0.2);
  assert.ok(Math.abs(sampleRainIntensity(rain, 1) - 0.6) < 1e-6);
  assert.ok(Math.abs(sampleRainIntensity(rain, 3) - 0.5) < 1e-6);
  assert.equal(sampleRainIntensity(rain, 10), 0.0);

  const staticRain = resolveRain({ intensity: 0.75 });
  assert.equal(sampleRainIntensity(staticRain, 12.5), 0.75);

  const firstSeeds = generateRainSeedData(200, 42);
  const secondSeeds = generateRainSeedData(200, 42);
  assert.deepEqual(firstSeeds, secondSeeds);
  assert.ok(firstSeeds.every(value => value >= 0 && value < 1));

  const firstSplashes = generateSplashSeedData(80, 42);
  const secondSplashes = generateSplashSeedData(80, 42);
  assert.deepEqual(firstSplashes, secondSplashes);
  assert.ok(firstSplashes.every(value => value >= 0 && value < 1));
});

function createMockGlRenderer() {
  const programs = [];
  const vaos = [];
  const buffers = [];
  const drawCalls = [];
  const renderedFrames = [];

  const context = {
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    LINK_STATUS: 35714,
    COMPILE_STATUS: 35713,
    ARRAY_BUFFER: 34962,
    ELEMENT_ARRAY_BUFFER: 34963,
    STATIC_DRAW: 35044,
    FLOAT: 5126,
    TRIANGLES: 4,
    UNSIGNED_SHORT: 5123,
    DEPTH_TEST: 2929,
    BLEND: 3042,
    CULL_FACE: 2884,
    SRC_ALPHA: 770,
    ONE_MINUS_SRC_ALPHA: 771,
    ONE: 1,
    getExtension() { return null; },
    createProgram() {
      const program = { deleted: false };
      programs.push(program);
      return program;
    },
    deleteProgram(program) { program.deleted = true; },
    createShader() { return {}; },
    deleteShader() {},
    shaderSource() {},
    compileShader() {},
    attachShader() {},
    linkProgram() {},
    getProgramParameter() { return true; },
    getShaderParameter() { return true; },
    isContextLost() { return false; },
    getUniformLocation(_program, name) { return { name }; },
    createVertexArray() {
      const vao = { deleted: false };
      vaos.push(vao);
      return vao;
    },
    deleteVertexArray(vao) { vao.deleted = true; },
    bindVertexArray() {},
    createBuffer() {
      const buffer = { deleted: false };
      buffers.push(buffer);
      return buffer;
    },
    deleteBuffer(buffer) { buffer.deleted = true; },
    bindBuffer() {},
    bufferData() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    vertexAttribDivisor() {},
    useProgram() {},
    uniformMatrix4fv() {},
    uniform3fv() {},
    uniform2fv() {},
    uniform2f() {},
    uniform1f() {},
    enable() {},
    disable() {},
    blendFuncSeparate() {},
    depthMask() {},
    drawElementsInstanced(mode, count, type, offset, instanceCount) {
      drawCalls.push({ mode, count, type, offset, instanceCount });
    },
  };

  const renderer = {
    context,
    viewProjection: new Float32Array(16),
    viewForward: [0, 0, -1],
    lighting: { keyColor: [1, 1, 1], ambientColor: [0.3, 0.35, 0.4] },
    renderingPass: false,
    benchmark: false,
    render(frame) {
      renderedFrames.push(frame);
      this.drawBlendBatches(frame);
    },
    drawBlendBatches() {},
    dispose() {},
  };

  return { renderer, programs, vaos, buffers, drawCalls, renderedFrames };
}

test('installRain draws streaks and splashes scaled by intensity, pairs wetness, and cleans up on dispose', () => {
  const { renderer, programs, vaos, buffers, drawCalls, renderedFrames } = createMockGlRenderer();
  assert.throws(() => installRain({}), /CrucibleRenderer/);
  installRain(renderer);
  // Installing twice is a no-op.
  assert.equal(installRain(renderer), renderer);

  renderer.render({
    eye: [0, 1.8, 5],
    time: 1.2,
    rain: { intensity: 0.5, density: 1000, splashes: true, splashCount: 200, wetness: 0.8 },
  });

  assert.equal(drawCalls.length, 2);
  assert.equal(drawCalls[0].instanceCount, 500);
  assert.equal(drawCalls[1].instanceCount, 100);
  assert.ok(Math.abs(renderedFrames[0].environment.wetness - 0.4) < 1e-6);

  // Zero intensity skips draws cleanly without compiling or issuing empty instanced draws.
  drawCalls.length = 0;
  renderer.render({ eye: [0, 1.8, 5], time: 2.0, rain: { intensity: 0, wetness: 0.8 } });
  assert.equal(drawCalls.length, 0);
  assert.equal(renderedFrames[1].environment.wetness, 0);

  // Explicit environment.wetness wins over rain.wetness.
  renderer.render({
    eye: [0, 1.8, 5],
    time: 2.5,
    environment: { wetness: 0.9 },
    rain: { intensity: 0.5, density: 1000, splashes: false, wetness: 0.2 },
  });
  assert.equal(drawCalls.length, 1);
  assert.equal(renderedFrames[2].environment.wetness, 0.9);

  renderer.dispose();
  assert.ok(programs.length === 2 && programs.every(program => program.deleted));
  assert.ok(vaos.length === 2 && vaos.every(vao => vao.deleted));
  assert.ok(buffers.length === 5 && buffers.every(buffer => buffer.deleted));
});

test('installRain evaluates intensityCurve across seeks without accumulating state', () => {
  const { renderer, drawCalls } = createMockGlRenderer();
  installRain(renderer);
  const animated = resolveRain({
    density: 1000,
    splashes: false,
    intensityCurve: [
      { time: 0, value: 0.2 },
      { time: 2, value: 1.0 },
    ],
  });
  renderer.render({ eye: [0, 1.8, 5], time: 0, rain: animated });
  renderer.render({ eye: [0, 1.8, 5], time: 2, rain: animated });
  renderer.render({ eye: [0, 1.8, 5], time: 0, rain: animated });
  assert.deepEqual(drawCalls.map(entry => entry.instanceCount), [200, 1000, 200]);
  renderer.dispose();
});
