import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_GLASS_REFRACTION_LAYERS, SHELL_PAIR_LIMIT, planGlassRefractionLayers, projectedShellBounds, screenRectsOverlap } from '../src/glass-back-face.js';
import { drawLiquidPass } from '../src/liquid-renderer.js';

// Column-major orthographic projection mapping x in [-2, 2], y in [-2, 2], z in [2, -10] to NDC.
const ORTHO_VIEW_PROJECTION = new Float32Array([
  0.5, 0, 0, 0,
  0, 0.5, 0, 0,
  0, 0, -1 / 6, 0,
  0, 0, -2 / 3, 1,
]);

// Column-major perspective-like matrix with clipW = -z + 5 (camera at [0, 0, 5]).
const PERSPECTIVE_VIEW_PROJECTION = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, -1, -1,
  0, 0, 0, 5,
]);

function makeShell(minimum, maximum, extra = {}) {
  return { minimum, maximum, ...extra };
}

test('projectedShellBounds computes NDC bounds, marks offscreen invisible, and treats near-plane crossings as visible', () => {
  const inside = projectedShellBounds(makeShell([-1, -1, -1], [1, 1, 1]), ORTHO_VIEW_PROJECTION);
  assert.equal(inside.visible, true);
  assert.equal(inside.left, -0.5);
  assert.equal(inside.right, 0.5);

  const offscreen = projectedShellBounds(makeShell([3, 3, -1], [4, 4, 1]), ORTHO_VIEW_PROJECTION);
  assert.equal(offscreen.visible, false);

  const behindEye = projectedShellBounds(makeShell([-0.5, -0.5, 4.9], [0.5, 0.5, 6.0]), PERSPECTIVE_VIEW_PROJECTION);
  assert.deepEqual(behindEye, { left: -1, right: 1, bottom: -1, top: 1, visible: true });
});

test('screenRectsOverlap detects overlapping projected rectangles cleanly', () => {
  const left = projectedShellBounds(makeShell([-1.5, -1, -1], [-0.5, 1, 1]), ORTHO_VIEW_PROJECTION);
  const right = projectedShellBounds(makeShell([0.5, -1, -1], [1.5, 1, 1]), ORTHO_VIEW_PROJECTION);
  const center = projectedShellBounds(makeShell([-0.6, -0.5, -2], [0.6, 0.5, -1.5]), ORTHO_VIEW_PROJECTION);
  assert.equal(screenRectsOverlap(left, right), false);
  assert.equal(screenRectsOverlap(left, center), true);
  assert.equal(screenRectsOverlap(right, center), true);
});

test('planGlassRefractionLayers returns null for empty, single, nested, over-limit, or separated shells', () => {
  const eye = [0, 0, 5];
  assert.equal(planGlassRefractionLayers([], ORTHO_VIEW_PROJECTION, eye), null);
  assert.equal(planGlassRefractionLayers([makeShell([-1, -1, -1], [1, 1, 1])], ORTHO_VIEW_PROJECTION, eye), null);

  // Separated shells never trigger extra passes.
  assert.equal(planGlassRefractionLayers([
    makeShell([-1.8, -0.5, -1], [-1.0, 0.5, 1]),
    makeShell([1.0, -0.5, -1], [1.8, 0.5, 1]),
  ], ORTHO_VIEW_PROJECTION, eye), null);

  // Nested shells keep the dual back-face path instead of layered draws.
  assert.equal(planGlassRefractionLayers([
    makeShell([-2, -2, -2], [2, 2, 2]),
    makeShell([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]),
  ], ORTHO_VIEW_PROJECTION, eye), null);

  // More than SHELL_PAIR_LIMIT shells stay on the fast path.
  const many = Array.from({ length: SHELL_PAIR_LIMIT + 1 }, (_, index) => makeShell([-0.5, -0.5, -index - 1], [0.5, 0.5, -index]));
  assert.equal(planGlassRefractionLayers(many, ORTHO_VIEW_PROJECTION, eye), null);
});

test('planGlassRefractionLayers orders overlapping shells back-to-front and packs independent pairs', () => {
  const eye = [0, 0, 5];
  const near = makeShell([-0.8, -0.8, 0.2], [0.8, 0.8, 1.2], { name: 'near' });
  const far = makeShell([0.1, -0.4, -2.5], [1.0, 0.4, -1.5], { name: 'far' });
  const two = planGlassRefractionLayers([near, far], ORTHO_VIEW_PROJECTION, eye);
  assert.equal(two.length, 2);
  assert.equal(two[0][0].name, 'far');
  assert.equal(two[1][0].name, 'near');

  // Chain A(far) overlaps B(mid) and B overlaps C(near) even though A and C do not touch on screen: strictly 3 layers.
  const chainA = makeShell([-1.6, -0.5, -4], [-0.4, 0.5, -3], { name: 'A' });
  const chainB = makeShell([-0.6, -0.5, -2], [0.6, 0.5, -1], { name: 'B' });
  const chainC = makeShell([0.4, -0.5, 0.5], [1.6, 0.5, 1.5], { name: 'C' });
  const chain = planGlassRefractionLayers([chainC, chainA, chainB], ORTHO_VIEW_PROJECTION, eye);
  assert.equal(chain.length, 3);
  assert.deepEqual(chain.map(layer => layer.map(item => item.name)), [['A'], ['B'], ['C']]);

  // Two independent pairs on left and right merge into 2 layers total instead of 4.
  const leftFar = makeShell([-1.8, -0.4, -3], [-0.8, 0.4, -2], { name: 'leftFar' });
  const leftNear = makeShell([-1.5, -0.4, 0], [-0.5, 0.4, 1], { name: 'leftNear' });
  const rightFar = makeShell([0.8, -0.4, -3.5], [1.8, 0.4, -2.5], { name: 'rightFar' });
  const rightNear = makeShell([0.5, -0.4, 0.2], [1.5, 0.4, 1.2], { name: 'rightNear' });
  const paired = planGlassRefractionLayers([leftNear, rightFar, leftFar, rightNear], ORTHO_VIEW_PROJECTION, eye);
  assert.equal(paired.length, 2);
  assert.deepEqual(paired[0].map(item => item.name), ['rightFar', 'leftFar']);
  assert.deepEqual(paired[1].map(item => item.name), ['leftNear', 'rightNear']);
});

test('planGlassRefractionLayers caps layer count at MAX_GLASS_REFRACTION_LAYERS without dropping shells', () => {
  const stack = Array.from({ length: MAX_GLASS_REFRACTION_LAYERS + 2 }, (_, index) =>
    makeShell([-0.5, -0.5, -10 + index], [0.5, 0.5, -9.5 + index], { name: `shell-${index}` }),
  );
  const layers = planGlassRefractionLayers(stack, ORTHO_VIEW_PROJECTION, [0, 0, 5]);
  assert.equal(layers.length, MAX_GLASS_REFRACTION_LAYERS);
  const flattened = layers.flat();
  assert.equal(flattened.length, MAX_GLASS_REFRACTION_LAYERS + 2);
});

function createMockGlassRenderer() {
  const calls = [];
  const uniformValues = new Map();
  let nextId = 1;
  const context = new Proxy({
    TEXTURE0: 0x84C0,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    createTexture: () => ({ id: nextId++ }),
    createFramebuffer: () => ({ id: nextId++ }),
    getUniformLocation: (_, name) => name,
    texStorage2D: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    framebufferTexture2D: () => {},
    bindFramebuffer: (target, framebuffer) => calls.push(['bindFramebuffer', framebuffer?.name ?? framebuffer?.id ?? null]),
    blitFramebuffer: (...args) => calls.push(['blitFramebuffer', args[8]]),
    uniform1f: (location, value) => {
      uniformValues.set(location, value);
      calls.push(['uniform1f', location, value]);
    },
    uniform1fv: () => {},
    uniform1i: () => {},
    uniform2f: () => {},
    uniform3f: () => {},
    uniform3fv: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: () => {},
    bindBuffer: (_, buffer) => calls.push(['bindBuffer', buffer?.name ?? null]),
    bufferSubData: (_, offset, data) => calls.push(['bufferSubData', offset, data[12]]),
    drawElementsInstanced: (mode, indexCount, type, offset, instanceCount) => calls.push([
      'draw',
      uniformValues.get('glassBackPass') ?? 0,
      uniformValues.get('glassBackFirst') ?? 0,
      instanceCount,
    ]),
  }, {
    get(target, name) {
      if (name in target) return target[name];
      if (typeof name === 'string' && /^[A-Z_0-9]+$/.test(name)) return 1;
      return () => {};
    },
  });

  const renderer = {
    context,
    canvas: { width: 64, height: 64 },
    liquidProgram: {},
    liquidUniforms: new Proxy({}, { get: (_, name) => name }),
    multisampleFramebuffer: { name: 'msaa' },
    resolveFramebuffer: { name: 'resolve' },
    frameTexture: { name: 'frameColor' },
    viewProjection: ORTHO_VIEW_PROJECTION,
    lightProjection: ORTHO_VIEW_PROJECTION,
    lighting: { keyColor: [1, 1, 1], ambientIntensity: 0.2 },
    reversedDepth: false,
    partsMoveCount: 0,
    batches: [],
    applyEnvironmentUniforms: () => {},
    renderTargets: { record: () => {}, release: () => {} },
  };
  return { renderer, calls };
}

function makeGlassBatch({ translations, scale = 1, transmission = 1, thickness = 1, name = 'glass' }) {
  const unitBox = { positions: new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]) };
  const layerState = new Float32Array(32);
  layerState[9] = transmission;
  layerState[10] = 1.5;
  layerState[11] = thickness;
  layerState[12] = 4;
  const stride = 24;
  const instanceData = new Float32Array(translations.length * stride);
  const parts = translations.map(([x, y, z], index) => {
    const matrix = new Float32Array([scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, x, y, z, 1]);
    instanceData.set(matrix, index * stride);
    return { geometry: unitBox, matrix, material: {} };
  });
  return {
    layerState,
    mapState: [],
    textures: [],
    opacity: 1,
    vertexArray: {},
    instanceBuffer: { name: `vbo-${name}` },
    instanceData,
    indexCount: 36,
    instanceCount: parts.length,
    parts,
  };
}

test('drawLiquidPass draws overlapping closed glass layers back-to-front with mid-pass color/depth resolves', () => {
  const { renderer, calls } = createMockGlassRenderer();
  const nearBatch = makeGlassBatch({ translations: [[0, 0, 1]], scale: 1.4, name: 'near' });
  const farBatch = makeGlassBatch({ translations: [[0.2, 0, -2]], scale: 0.9, name: 'far' });
  const waterBatch = makeGlassBatch({ translations: [[0, -1, 0]], transmission: 0, thickness: 0, name: 'water' });
  renderer.batches = [nearBatch, farBatch, waterBatch];

  drawLiquidPass(renderer, {
    frame: { eye: [0, 0, 5], liquid: {} },
    environment: { daylight: 1, lightDirection: [0, 1, 0], fogColor: [0, 0, 0], fogDensity: 0, explosionCenter: [0, 0, 0], liquid: {} },
    assemblyAmount: 1,
    environmentMap: null,
    liquids: renderer.batches,
    foams: [],
    environmentSpecularUnit: 1,
    maximumDistance: 10,
    vertexSource: '',
    fragmentSource: '',
  });

  // Color + depth resolves: 1 initial (before layer 0) + 1 before layer 1 + 1 before non-closed water batch = 3 color blits.
  const colorBlits = calls.filter(([name, mask]) => name === 'blitFramebuffer' && mask === 0x4000);
  const depthBlits = calls.filter(([name, mask]) => name === 'blitFramebuffer' && mask === 0x0100);
  assert.equal(colorBlits.length, 3);
  assert.equal(depthBlits.length, 3);

  // Draw order: layer 0 back (far: first=1), layer 0 front (far: first=1), layer 1 back (near: first=0), layer 1 front (near: first=0), water front.
  const draws = calls.filter(([name]) => name === 'draw');
  assert.deepEqual(draws, [
    ['draw', 1, 1, 1],
    ['draw', 0, 1, 1],
    ['draw', 1, 0, 1],
    ['draw', 0, 0, 1],
    ['draw', 0, 0, 1],
  ]);
});

test('drawLiquidPass slices and restores multi-instance buffers when instances overlap in one batch', () => {
  const { renderer, calls } = createMockGlassRenderer();
  // Instance 0 is near (x=0, z=1); instance 1 is far (x=0.3, z=-2). Layers draw instance 1 first, then instance 0.
  const sharedBatch = makeGlassBatch({ translations: [[0, 0, 1], [0.3, 0, -2]], scale: 1.2, name: 'shared' });
  renderer.batches = [sharedBatch];

  drawLiquidPass(renderer, {
    frame: { eye: [0, 0, 5], liquid: {} },
    environment: { daylight: 1, lightDirection: [0, 1, 0], fogColor: [0, 0, 0], fogDensity: 0, explosionCenter: [0, 0, 0], liquid: {} },
    assemblyAmount: 1,
    environmentMap: null,
    liquids: renderer.batches,
    foams: [],
    environmentSpecularUnit: 1,
    maximumDistance: 10,
    vertexSource: '',
    fragmentSource: '',
  });

  // Instance 1 (x = 0.3) draws back + front, restoring slot 0 (x = 0) after each slice; instance 0 needs no upload.
  const uploads = calls.filter(([name]) => name === 'bufferSubData').map(([, offset, tx]) => [offset, Number(tx.toFixed(2))]);
  assert.deepEqual(uploads, [
    [0, 0.3],
    [0, 0],
    [0, 0.3],
    [0, 0],
  ]);
  const draws = calls.filter(([name]) => name === 'draw');
  assert.equal(draws.length, 4);
  assert.ok(draws.every(([, , , count]) => count === 1));
});
