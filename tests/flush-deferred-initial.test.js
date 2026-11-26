import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { flushOrderOf } from '../src/depth-layer.js';
import { createStudio } from '../src/studio.js';
import { createFakeRenderer, installStudioDom } from './support/studio-dom.mjs';

const HEAVY_OPTIONS = { deferFlushTriangles: 1 };
const OCEAN = { op: 'ocean', coverage: 1, seed: 3, windSpeed: 4, size: 2, resolution: 4 };

function flushRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'wall', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [10, 4, 0.2] },
      { id: 'sign', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [1, 0.5, 0.2] },
    ],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  };
}

function seaRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'box', type: 'box', bevel: 0 },
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, stack: [{ op: 'subdivide', levels: 3 }, OCEAN] },
    ],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }, { id: 'water', color: [0.1, 0.3, 0.5] }],
    nodes: [
      { id: 'wall', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [10, 4, 0.2] },
      { id: 'sign', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [1, 0.5, 0.2] },
      { id: 'surface', geometry: 'sea', material: 'water', translation: [0, -5, 0] },
    ],
    camera: { eye: [30, 20, 30], target: [0, 0, 0] },
    motion: {
      duration: 4,
      tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', keyframes: [{ time: 0, value: 0 }, { time: 4, value: 8 }] }],
    },
  };
}

// One 64x64 grid (8,192 triangles) instanced across 13 separated nodes gives 106,520 triangles (> 100k default threshold)
// with overlapping wall/sign boxes, while keeping the spatial search fast inside unit tests.
function studioHeavyRecipe() {
  const grids = Array.from({ length: 13 }, (_, index) => ({
    id: `grid-${index}`, geometry: 'grid', material: 'paint', translation: [0, 10 + index * 2, 0],
  }));
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'box', type: 'box', bevel: 0 },
      { id: 'grid', type: 'grid', segments: 64 },
    ],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'wall', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [10, 4, 0.2] },
      { id: 'sign', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [1, 0.5, 0.2] },
      ...grids,
    ],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  };
}

function rankSummary(scene) {
  return scene.parts.map(part => [
    part.name,
    flushOrderOf(part)?.ranges.map(range => `${range.rank}:${range.start}:${range.count}`) ?? null,
    flushOrderOf(part)?.geometry ? Array.from(flushOrderOf(part).geometry.indices) : null,
  ]);
}

async function waitUntilSettled(scene) {
  const deadline = Date.now() + 5000;
  while (scene.flushPending && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('deferInitialFlush validates that the option is a boolean when provided', () => {
  for (const bad of ['true', 1, null, {}]) {
    assert.throws(
      () => createAgentScene(flushRecipe(), {}, { deferInitialFlush: bad }),
      error => error instanceof TypeError && /deferInitialFlush.*true or false/.test(error.message),
    );
  }
});

test('default createAgentScene ranks synchronously even past deferFlushTriangles', () => {
  const scene = createAgentScene(flushRecipe(), {}, HEAVY_OPTIONS);
  assert.equal(scene.flushPending, false);
  assert.ok(flushOrderOf(scene.parts.find(part => part.name === 'sign')));
  assert.equal(scene.settleFlush(), false);
});

test('deferInitialFlush defers the initial search and settles to byte-identical ranks', async () => {
  const cold = createAgentScene(flushRecipe());
  const scene = createAgentScene(flushRecipe(), {}, { ...HEAVY_OPTIONS, deferInitialFlush: true });
  assert.equal(scene.flushPending, true);
  assert.equal(flushOrderOf(scene.parts.find(part => part.name === 'sign')), null);
  const topologyBefore = scene.topologyRevision;
  await waitUntilSettled(scene);
  assert.equal(scene.flushPending, false);
  assert.equal(scene.topologyRevision, topologyBefore + 1);
  assert.deepEqual(rankSummary(scene), rankSummary(cold));
  assert.deepEqual(scene.inspect().flush, cold.inspect().flush);
});

test('deferInitialFlush still ranks synchronously below deferFlushTriangles', () => {
  const scene = createAgentScene(flushRecipe(), {}, { deferInitialFlush: true, deferFlushTriangles: 100_000 });
  assert.equal(scene.flushPending, false);
  assert.ok(flushOrderOf(scene.parts.find(part => part.name === 'sign')));
});

test('settleFlush right after a deferred initial build drains synchronously to identical ranks', () => {
  const cold = createAgentScene(flushRecipe());
  const scene = createAgentScene(flushRecipe(), {}, { ...HEAVY_OPTIONS, deferInitialFlush: true });
  assert.equal(scene.flushPending, true);
  const topologyBefore = scene.topologyRevision;
  assert.equal(scene.settleFlush(), true);
  assert.equal(scene.flushPending, false);
  assert.equal(scene.topologyRevision, topologyBefore + 1);
  assert.deepEqual(rankSummary(scene), rankSummary(cold));
  assert.deepEqual(scene.inspect().flush, cold.inspect().flush);
});

test('deferInitialFlush on a moving sea scene settles to the cold result at rest and at sampled times', async () => {
  const cold = createAgentScene(seaRecipe());
  const scene = createAgentScene(seaRecipe(), {}, { ...HEAVY_OPTIONS, deferInitialFlush: true });
  assert.equal(scene.flushPending, true);
  await waitUntilSettled(scene);
  assert.equal(scene.flushPending, false);
  assert.deepEqual(rankSummary(scene), rankSummary(cold));
  scene.sampleMotion(2);
  cold.sampleMotion(2);
  assert.deepEqual(rankSummary(scene), rankSummary(cold));
});

test('a failed initial build with deferInitialFlush cancels its pending search without leaking a timer', () => {
  const broken = {
    ...flushRecipe(),
    motion: {
      duration: 1,
      tracks: [{ kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [0, 0, 0] }] }],
      // Eye equal to target fails camera matrix validation inside stagePose after stageRestParts already ran.
    },
    camera: { eye: [0, 0, 0], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  };
  let scheduled = 0;
  let cancelled = 0;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (...args) => {
    scheduled += 1;
    return originalSetTimeout(...args);
  };
  globalThis.clearTimeout = handle => {
    cancelled += 1;
    return originalClearTimeout(handle);
  };
  try {
    assert.throws(() => createAgentScene(broken, {}, { ...HEAVY_OPTIONS, deferInitialFlush: true }));
    assert.equal(cancelled, scheduled);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('Studio defers initial flush on heavy initial and loaded scenes, redraws when settled, and keeps stillScene synchronous', async testContext => {
  const dom = installStudioDom();
  const renderer = createFakeRenderer();
  const heavy = studioHeavyRecipe();
  const studio = createStudio(dom.container, { recipe: heavy, renderer });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });

  // Initial heavy scene in createStudio defers flush and draws unranked first, then redraws once flush settles.
  assert.equal(studio.scene.flushPending, true);
  const framesAfterMount = renderer.frames.length;
  const topologyBefore = studio.scene.topologyRevision;
  for (let round = 0; round < 500 && studio.scene.flushPending; round++) {
    dom.runTimers();
  }
  assert.equal(studio.scene.flushPending, false);
  for (let round = 0; round < 500 && dom.pendingAnimationFrameCount === 0; round++) {
    dom.runTimers();
  }
  assert.equal(studio.scene.topologyRevision, topologyBefore + 1);
  assert.equal(dom.pendingAnimationFrameCount, 1);
  dom.runAnimationFrames(1000);
  assert.equal(renderer.frames.length, framesAfterMount + 1);

  const cold = createAgentScene(heavy);
  assert.deepEqual(rankSummary(studio.scene), rankSummary(cold));

  // Loading another heavy recipe through controller.loadRecipe (scenePoolOptions) also defers initial flush.
  const otherHeavy = { ...heavy, geometries: [{ id: 'box', type: 'box', bevel: 0.01 }, heavy.geometries[1]] };
  studio.loadRecipe(otherHeavy, { recordUndo: false });
  assert.equal(studio.scene.flushPending, true);

  // capturePngDataUrl settles any pending flush on the live scene before taking the still.
  studio.capturePngDataUrl();
  assert.equal(studio.scene.flushPending, false);
  assert.ok(flushOrderOf(studio.scene.parts.find(part => part.name === 'sign')));
  for (let round = 0; round < 10 && (dom.pendingTimerCount > 0 || dom.pendingAnimationFrameCount > 0); round++) {
    dom.runTimers();
    dom.runAnimationFrames(2000 + round * 16);
  }
  assert.equal(dom.pendingTimerCount, 0);

  // buildWebPackPayload builds stillScene synchronously without deferInitialFlush, leaving zero pending flush timers.
  const payload = await studio.buildWebPackPayload();
  assert.ok(payload.packBytes.byteLength > 0);
  assert.equal(dom.pendingTimerCount, 0, 'stillScene ran synchronously with no leftover deferred flush timer');
});
