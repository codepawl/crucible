import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  BLOOM_SCATTER,
  MAX_BLOOM_LEVELS,
  bloomMipDimensions,
  bloomPyramidFragment,
  bloomPyramidPlan,
  drawBloomPyramid,
  ensureBloomPyramidTargets,
  releaseBloomPyramidTargets,
} from '../src/bloom-pyramid.js';
import { agentSceneModulesNeeded } from '../src/agent-scene-modules.js';
import { isBloomActive, isDitherActive, resolveEffects } from '../src/effects.js';
import { RenderTargetLedger } from '../src/render-target-ledger.js';
import { CrucibleRenderer } from '../src/renderer.js';

function createMockGlContext() {
  const calls = [];
  const uniformValues = new Map();
  let nextId = 1;
  const context = {
    TEXTURE_2D: 0x0de1,
    RGBA: 0x1908,
    RGBA16F: 0x881a,
    RGBA8: 0x8058,
    HALF_FLOAT: 0x140b,
    UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    DEPTH_TEST: 0x0b71,
    CULL_FACE: 0x0b44,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    ZERO: 0,
    ONE: 1,
    TEXTURE0: 0x84c0,
    TRIANGLES: 0x0004,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    LINK_STATUS: 0x8b82,
    COMPILE_STATUS: 0x8b81,
    createTexture: () => ({ id: nextId++ }),
    deleteTexture: (texture) => calls.push(['deleteTexture', texture.id]),
    createFramebuffer: () => ({ id: nextId++ }),
    deleteFramebuffer: (framebuffer) => calls.push(['deleteFramebuffer', framebuffer.id]),
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    createProgram: () => ({ id: nextId++ }),
    attachShader() {},
    linkProgram() {},
    deleteShader() {},
    getProgramParameter: () => true,
    getUniformLocation: (_, name) => name,
    bindTexture() {},
    texImage2D() {},
    bindFramebuffer() {},
    framebufferTexture2D() {},
    checkFramebufferStatus: () => 0x8cd5,
    disable: (capability) => calls.push(['disable', capability]),
    enable: (capability) => calls.push(['enable', capability]),
    blendFuncSeparate: (...args) => calls.push(['blendFuncSeparate', ...args]),
    bindVertexArray() {},
    useProgram() {},
    activeTexture() {},
    viewport: (...args) => calls.push(['viewport', ...args]),
    uniform1i: (name, value) => uniformValues.set(name, value),
    uniform1f: (name, value) => uniformValues.set(name, value),
    uniform2f: (name, first, second) => uniformValues.set(name, [first, second]),
    drawArrays: () => calls.push(['draw', {
      passMode: uniformValues.get('passMode'),
      mixWeight: uniformValues.get('mixWeight'),
      texelSize: uniformValues.get('texelSize'),
      threshold: uniformValues.get('threshold'),
    }]),
  };
  return { context, calls };
}

test('bloomMipDimensions builds a halving mip chain down to at least 2 px and caps at MAX_BLOOM_LEVELS', () => {
  assert.deepEqual(bloomMipDimensions(540, 960), [
    { width: 540, height: 960 },
    { width: 270, height: 480 },
    { width: 135, height: 240 },
    { width: 67, height: 120 },
    { width: 33, height: 60 },
    { width: 16, height: 30 },
  ]);
  assert.equal(bloomMipDimensions(4096, 4096).length, MAX_BLOOM_LEVELS);
  assert.deepEqual(bloomMipDimensions(1, 1), [{ width: 1, height: 1 }]);
  assert.deepEqual(bloomMipDimensions(3, 3), [{ width: 3, height: 3 }]);
});

test('bloomPyramidPlan increases active spread smoothly across radius 0.1 to 16 without stepping', () => {
  assert.deepEqual(bloomPyramidPlan(1, 16), { activeLevels: 1, upsampleWeights: [] });
  let previousSum = 0;
  for (const radius of [0.1, 0.5, 1, 1.5, 3, 6, 12, 16]) {
    const plan = bloomPyramidPlan(MAX_BLOOM_LEVELS, radius);
    const weightSum = plan.upsampleWeights.reduce((sum, entry) => sum + entry.mixWeight, 0);
    assert.ok(plan.activeLevels >= 2 && plan.activeLevels <= MAX_BLOOM_LEVELS);
    assert.ok(weightSum > previousSum, `radius ${radius} total upsample weight ${weightSum} > ${previousSum}`);
    for (const entry of plan.upsampleWeights) {
      assert.ok(entry.mixWeight > 0 && entry.mixWeight <= BLOOM_SCATTER + 1e-9);
    }
    previousSum = weightSum;
  }
  const justBelow = bloomPyramidPlan(MAX_BLOOM_LEVELS, 0.99);
  const justAbove = bloomPyramidPlan(MAX_BLOOM_LEVELS, 1.01);
  const sumBelow = justBelow.upsampleWeights.reduce((sum, entry) => sum + entry.mixWeight, 0);
  const sumAbove = justAbove.upsampleWeights.reduce((sum, entry) => sum + entry.mixWeight, 0);
  assert.ok(Math.abs(sumAbove - sumBelow) < 0.05, `continuous across radius=1: ${sumBelow} vs ${sumAbove}`);
});

test('bloomPyramidFragment implements Karis mip-0 downsample, 13-tap box downsample, and 3x3 tent upsample', () => {
  assert.match(bloomPyramidFragment, /karisWeight/);
  assert.match(bloomPyramidFragment, /centerBox/);
  assert.match(bloomPyramidFragment, /topLeftBox/);
  assert.match(bloomPyramidFragment, /tent \* 0\.0625/);
  assert.match(bloomPyramidFragment, /max\(peak - threshold, 0\.0\)/);
});

test('ensureBloomPyramidTargets and releaseBloomPyramidTargets manage the full HDR mip chain in the ledger', () => {
  const { context } = createMockGlContext();
  const renderer = {
    context,
    hdr: true,
    bloomWidth: 540,
    bloomHeight: 960,
    bloomTargets: [],
    bloomProgram: { id: 99 },
    bloomUniforms: {},
    renderTargets: new RenderTargetLedger(),
  };
  ensureBloomPyramidTargets(renderer);
  assert.equal(renderer.bloomTargets.length, MAX_BLOOM_LEVELS);
  const report = renderer.renderTargets.report();
  assert.equal(report.targets.length, MAX_BLOOM_LEVELS);
  assert.equal(report.targets[0].name, 'bloom0');
  assert.equal(report.targets[0].format, 'RGBA16F');
  assert.equal(report.targets[0].width, 540);
  releaseBloomPyramidTargets(renderer);
  assert.equal(renderer.bloomTargets.length, 0);
  assert.equal(renderer.renderTargets.report().targets.length, 0);
});

test('drawBloomPyramid runs Karis mip-0 downsample, progressive downsamples, and blended tent upsamples', () => {
  const { context, calls } = createMockGlContext();
  const renderer = {
    context,
    hdr: true,
    canvas: { width: 1080, height: 1920 },
    bloomWidth: 540,
    bloomHeight: 960,
    bloomTargets: [],
    bloomProgram: { id: 99 },
    bloomUniforms: Object.fromEntries(['sourceTexture', 'texelSize', 'threshold', 'passMode', 'mixWeight'].map(name => [name, name])),
    renderTargets: new RenderTargetLedger(),
    ensureBloomTargets() { ensureBloomPyramidTargets(this); },
  };
  drawBloomPyramid(renderer, { strength: 1, threshold: 1, radius: 16 }, { id: 1 });
  const draws = calls.filter(([kind]) => kind === 'draw').map(([, info]) => info);
  const plan = bloomPyramidPlan(MAX_BLOOM_LEVELS, 16);
  assert.equal(draws.length, plan.activeLevels + plan.upsampleWeights.length);
  assert.equal(draws[0].passMode, 0);
  assert.deepEqual(draws[0].texelSize, [1 / 1080, 1 / 1920]);
  assert.equal(draws[1].passMode, 1);
  assert.equal(draws.at(-1).passMode, 2);
  const blendEnabledIndex = calls.findIndex(([kind, cap]) => kind === 'enable' && cap === context.BLEND);
  const blendDisabledIndex = calls.findLastIndex(([kind, cap]) => kind === 'disable' && cap === context.BLEND);
  assert.ok(blendEnabledIndex >= 0 && blendDisabledIndex > blendEnabledIndex);

  calls.length = 0;
  drawBloomPyramid(renderer, { strength: 1, threshold: 1, radius: 1 }, { id: 1 });
  const narrowDraws = calls.filter(([kind]) => kind === 'draw').map(([, info]) => info);
  assert.ok(narrowDraws.length < draws.length, 'radius 1 uses fewer pyramid levels than radius 16');
});

test('postStepsOf enables output dither for wide bloom (radius > 1.5) while leaving radius <= 1.5 and non-bloom scenes untouched', () => {
  const stepsOf = effects => CrucibleRenderer.prototype.postStepsOf.call({ transparent: false }, {}, resolveEffects(effects), { density: 0 }, false, null, false);
  assert.equal(isBloomActive(resolveEffects({})), false);
  assert.equal(isDitherActive(resolveEffects({ bloom: { strength: 1, radius: 16 } })), false);
  assert.ok(!stepsOf({}).includes('dither'));
  assert.ok(!stepsOf({ bloom: { strength: 0, radius: 16 } }).includes('dither'));
  assert.ok(!stepsOf({ bloom: { strength: 0.12, radius: 1 } }).includes('dither'));
  assert.ok(!stepsOf({ bloom: { strength: 0.25, radius: 1.5 } }).includes('dither'));
  assert.ok(stepsOf({ bloom: { strength: 1, radius: 1.6 } }).includes('dither'));
  assert.ok(stepsOf({ bloom: { strength: 1, radius: 16 } }).includes('dither'));
  assert.ok(stepsOf({ bloom: { strength: 0.12 } }).includes('bloom'));
});

test('agentSceneModulesNeeded prewarms bloomPyramid for bloom recipes without pulling postSteps', () => {
  const needed = agentSceneModulesNeeded({ effects: { bloom: { strength: 0.3 } } });
  assert.ok(needed.includes('bloomPyramid'));
  assert.equal(needed.includes('postSteps'), false);
});

test('CrucibleRenderer.prototype.drawBloom safely returns false and starts lazy loading when bloomPyramid is not yet loaded', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "import { CrucibleRenderer } from './src/renderer.js'; const ok = CrucibleRenderer.prototype.drawBloom.call({}, { strength: 1, threshold: 1, radius: 4 }, 'frame'); console.log(JSON.stringify({ ok }));",
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false });
});
