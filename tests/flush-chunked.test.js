import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { flushOrderOf } from '../src/depth-layer.js';
import { resolveFlush, resolveFlushSteps } from '../src/flush-resolve.js';
import { findFlushPairs, findFlushPairsSteps } from '../src/flush-search.js';
import { forgetSearch } from '../src/flush-search-reuse.js';
import { createFlushSearchRunner, drainSteps } from '../src/flush-search-runner.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const SLICE_MILLISECONDS = 8;
const STEP_MILLISECONDS = 1;

function movedTo(x, y, z) {
  const matrix = [...IDENTITY];
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return new Float32Array(matrix);
}

// A flat sheet of quads on y = 0, so two sheets laid one over the other fight.
function sheetGeometry(size) {
  const positions = [];
  const indices = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const base = positions.length / 3;
      positions.push(column, 0, row, column, 0, row + 1, column + 1, 0, row + 1, column + 1, 0, row);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

// New parts and new geometry objects on every call, so two searches never share a cache entry or a draw order.
function fightingParts() {
  return [
    { name: 'base', geometry: sheetGeometry(12), matrix: movedTo(0, 0, 0), material: {} },
    { name: 'patch', geometry: sheetGeometry(4), matrix: movedTo(2.5, 0, 2.5), material: {} },
    { name: 'lower', geometry: sheetGeometry(12), matrix: movedTo(0, 0.001, 0), material: {} },
  ];
}

// A scheduler and a clock that a test moves by hand: every checkpoint of the steps costs STEP_MILLISECONDS.
function createFakeLoop() {
  let clock = 0;
  const queue = [];
  const slices = [];
  let stepsInSlice = 0;
  return {
    slices,
    now: () => clock,
    schedule: callback => {
      queue.push(callback);
      return queue.length;
    },
    cancelSchedule: () => {},
    meter(steps) {
      return (function* metered() {
        let step = steps.next();
        while (!step.done) {
          stepsInSlice++;
          clock += STEP_MILLISECONDS;
          yield;
          step = steps.next();
        }
        return step.value;
      }());
    },
    runUntilIdle() {
      while (queue.length > 0) {
        const callback = queue.shift();
        const startedAt = clock;
        stepsInSlice = 0;
        callback();
        slices.push({ milliseconds: clock - startedAt, steps: stepsInSlice });
      }
    },
    runOneSlice() {
      const callback = queue.shift();
      stepsInSlice = 0;
      callback();
    },
    get queued() {
      return queue.length;
    },
  };
}

function startInSlices(loop, steps, handlers = {}) {
  let result = null;
  const runner = createFlushSearchRunner({
    steps: loop.meter(steps),
    sliceMilliseconds: SLICE_MILLISECONDS,
    now: loop.now,
    schedule: loop.schedule,
    cancelSchedule: loop.cancelSchedule,
    onDone: value => {
      result = value;
      handlers.onDone?.(value);
    },
    onFailure: handlers.onFailure,
  });
  return { runner, result: () => result };
}

function pairsOf(result) {
  return result.pairs.map(pair => `${pair.first},${pair.second},${pair.gap},${pair.area},${pair.flush},${pair.opposite}`);
}

function describeOrder(part) {
  const order = flushOrderOf(part);
  if (!order) return null;
  return { indices: order.indices, ranges: order.ranges, triangleRanks: order.triangleRanks, geometry: order.geometry ?? null };
}

test('drainSteps runs a generator to its end and returns what it returned', () => {
  function* counting() {
    yield;
    yield;
    return 'done';
  }
  assert.equal(drainSteps(counting()), 'done');
});

test('the runner finishes a long search in slices that stay within their budget by one checkpoint', () => {
  const loop = createFakeLoop();
  function* checkpoints() {
    for (let index = 0; index < 100; index++) yield;
    return 'finished';
  }
  const { result } = startInSlices(loop, checkpoints());
  assert.equal(result(), null, 'nothing runs before the first turn of the event loop');
  loop.runUntilIdle();
  assert.equal(result(), 'finished');
  assert.ok(loop.slices.length > 10, `${loop.slices.length} slices`);
  for (const slice of loop.slices) {
    assert.ok(slice.milliseconds <= SLICE_MILLISECONDS + STEP_MILLISECONDS, `a slice took ${slice.milliseconds} ms`);
  }
});

test('the runner reports a finished search once, and cancel stops it for good', () => {
  const loop = createFakeLoop();
  let finished = 0;
  function* checkpoints() {
    for (let index = 0; index < 30; index++) yield;
    return 'finished';
  }
  const kept = startInSlices(loop, checkpoints(), { onDone: () => { finished++; } });
  loop.runOneSlice();
  kept.runner.cancel();
  loop.runUntilIdle();
  assert.equal(finished, 0, 'a cancelled search never reports');
  kept.runner.cancel();
  kept.runner.drain();
  assert.equal(finished, 0);
});

test('drain finishes a search in the middle of its slices at once and reports it once', () => {
  const loop = createFakeLoop();
  let finished = 0;
  function* checkpoints() {
    for (let index = 0; index < 30; index++) yield;
    return 'finished';
  }
  const kept = startInSlices(loop, checkpoints(), { onDone: () => { finished++; } });
  loop.runOneSlice();
  assert.equal(kept.result(), null);
  kept.runner.drain();
  assert.equal(kept.result(), 'finished');
  loop.runUntilIdle();
  kept.runner.drain();
  assert.equal(finished, 1);
});

test('a search that throws tells onFailure and throws on, from a slice and from drain', () => {
  function* failing() {
    yield;
    throw new RangeError('too large to index');
  }
  const failures = [];
  const loop = createFakeLoop();
  startInSlices(loop, failing(), { onFailure: error => failures.push(error.message) });
  assert.throws(() => loop.runOneSlice(), /too large to index/);
  assert.deepEqual(failures, ['too large to index']);
  const second = startInSlices(createFakeLoop(), failing(), { onFailure: error => failures.push(error.message) });
  assert.throws(() => second.runner.drain(), /too large to index/);
  assert.equal(failures.length, 2);
});

test('a search in slices finds the pairs, ranks and cut geometry of the synchronous one', () => {
  forgetSearch();
  const coldParts = fightingParts();
  const coldResult = resolveFlush(coldParts);
  forgetSearch();
  const slicedParts = fightingParts();
  const loop = createFakeLoop();
  const { result } = startInSlices(loop, resolveFlushSteps(slicedParts));
  loop.runUntilIdle();
  assert.ok(coldResult.ranked > 0);
  assert.ok(coldParts.some(part => flushOrderOf(part)?.geometry), 'the scene has a part with faces cut away');
  assert.deepEqual(result(), coldResult);
  coldParts.forEach((coldPart, index) => assert.deepEqual(describeOrder(slicedParts[index]), describeOrder(coldPart), coldPart.name));
  assert.ok(loop.slices.length > 1, 'the search took more than one slice');
  for (const slice of loop.slices) {
    assert.ok(slice.milliseconds <= SLICE_MILLISECONDS + STEP_MILLISECONDS, `a slice took ${slice.milliseconds} ms`);
  }
});

test('a search in slices stops at the pair budget the way the synchronous one does', () => {
  const options = { pairBudget: 40 };
  forgetSearch();
  const cold = findFlushPairs(fightingParts(), options);
  assert.equal(cold.truncated, true, 'the budget is small enough to run out');
  forgetSearch();
  const loop = createFakeLoop();
  const { result } = startInSlices(loop, findFlushPairsSteps(fightingParts(), options));
  loop.runUntilIdle();
  const sliced = result();
  assert.deepEqual(pairsOf(sliced), pairsOf(cold));
  assert.equal(sliced.truncated, true);
  assert.equal(sliced.truncatedAt, cold.truncatedAt);
  assert.equal(sliced.testedPairs, cold.testedPairs);
});

test('a paused search has given no part a rank, however far it got', () => {
  forgetSearch();
  const parts = fightingParts();
  const steps = resolveFlushSteps(parts);
  let step = steps.next();
  let checkpoints = 0;
  while (!step.done) {
    checkpoints++;
    assert.deepEqual(parts.map(part => flushOrderOf(part)), parts.map(() => null), `a part was ranked at checkpoint ${checkpoints}`);
    step = steps.next();
  }
  assert.ok(checkpoints > 3);
  assert.ok(parts.some(part => flushOrderOf(part)));
});

test('another search between two slices leaves both results as a search alone gives them', () => {
  forgetSearch();
  const interleavedParts = fightingParts();
  const steps = findFlushPairsSteps(interleavedParts);
  for (let checkpoint = 0; checkpoint < 4; checkpoint++) steps.next();
  const otherParts = fightingParts().slice(0, 2);
  const otherResult = findFlushPairs(otherParts);
  for (let checkpoint = 0; checkpoint < 4; checkpoint++) steps.next();
  const thirdParts = fightingParts().slice(1);
  const thirdResult = findFlushPairs(thirdParts);
  const interleaved = drainSteps(steps);
  forgetSearch();
  assert.deepEqual(pairsOf(interleaved), pairsOf(findFlushPairs(fightingParts())));
  forgetSearch();
  assert.deepEqual(pairsOf(otherResult), pairsOf(findFlushPairs(fightingParts().slice(0, 2))));
  forgetSearch();
  assert.deepEqual(pairsOf(thirdResult), pairsOf(findFlushPairs(fightingParts().slice(1))));
});

test('a search that reuses an earlier one still matches a cold search when another search runs in between', () => {
  const [base, patch, lower] = fightingParts();
  forgetSearch();
  findFlushPairs([base, lower]);
  const steps = findFlushPairsSteps([base, patch, lower]);
  steps.next();
  steps.next();
  findFlushPairs(fightingParts().slice(0, 1));
  const resumed = drainSteps(steps);
  assert.ok(resumed.searched < resumed.count, 'the search built on the earlier one');
  forgetSearch();
  assert.deepEqual(pairsOf(resumed), pairsOf(findFlushPairs([base, patch, lower])));
});

test('reusing more than 125,000 remembered pairs does not overflow the call stack', () => {
  const size = 260;
  const base = { name: 'base', geometry: sheetGeometry(size), matrix: movedTo(0, 0, 0), material: {} };
  const copy = { name: 'copy', geometry: sheetGeometry(size), matrix: movedTo(0, 0, 0), material: {} };
  // Inside the sheets' box, so the scene's reach is the same and the first search can be reused.
  const patch = { name: 'patch', geometry: sheetGeometry(2), matrix: movedTo(5, 0, 5), material: {} };
  forgetSearch();
  const first = findFlushPairs([base, copy]);
  assert.ok(first.pairs.length > 125_000, `${first.pairs.length} pairs`);
  const second = findFlushPairs([base, copy, patch]);
  assert.ok(second.searched < second.count, 'the second search built on the first');
  assert.ok(second.pairs.length >= first.pairs.length);
});

// The scene's own search runs on the global timer and clock: both are replaced here, so a test moves it slice by slice.
function withHandDrivenTimers(run) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realNow = performance.now;
  const queue = [];
  let clock = 0;
  globalThis.setTimeout = callback => {
    const timer = { callback, cancelled: false };
    queue.push(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => {
    if (timer) timer.cancelled = true;
  };
  performance.now = () => {
    clock += 100;
    return clock;
  };
  const timers = {
    runSlice() {
      const timer = queue.shift();
      if (timer && !timer.cancelled) timer.callback();
    },
    get pending() {
      return queue.filter(timer => !timer.cancelled).length;
    },
  };
  try {
    return run(timers);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    performance.now = realNow;
  }
}

function sceneRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'wall', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [10, 4, 0.2] },
      { id: 'sign', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [1, 0.5, 0.2] },
    ],
  };
}

const addBadge = [{ type: 'add-node', node: { id: 'badge', geometry: 'box', material: 'paint', translation: [1, 0, 0], scale: [1, 0.5, 0.2] } }];
const addSecond = [{ type: 'add-node', node: { id: 'second', geometry: 'box', material: 'paint', translation: [-1, 0, 0], scale: [1, 0.5, 0.2] } }];

function rankSummary(scene) {
  return scene.parts.map(part => [part.name, flushOrderOf(part)?.ranges.map(range => `${range.rank}:${range.start}:${range.count}`) ?? null]);
}

function coldScene(...edits) {
  const scene = createAgentScene(sceneRecipe());
  edits.forEach((operations, revision) => scene.apply(operations, { expectedRevision: revision }));
  return scene;
}

test('an edit of a scene waits across several slices and changes no part until the search ends', () => {
  withHandDrivenTimers(timers => {
    const scene = createAgentScene(sceneRecipe(), {}, { deferFlushTriangles: 1 });
    const orderBefore = scene.parts.map(part => flushOrderOf(part));
    scene.apply(addBadge, { expectedRevision: 0 });
    const topologyBefore = scene.topologyRevision;
    let slices = 0;
    while (scene.flushPending) {
      slices++;
      assert.deepEqual(scene.parts.filter(part => part.name !== 'badge').map(part => flushOrderOf(part)), orderBefore, `a part changed after ${slices} slices`);
      assert.equal(flushOrderOf(scene.parts.find(part => part.name === 'badge')), null);
      timers.runSlice();
      assert.ok(slices < 1000, 'the search never ends');
    }
    assert.ok(slices > 3, `${slices} slices`);
    assert.equal(scene.topologyRevision, topologyBefore + 1);
    assert.deepEqual(rankSummary(scene), rankSummary(coldScene(addBadge)));
  });
});

test('an edit in the middle of a paused search restarts it, and the end equals a cold search of the final scene', () => {
  withHandDrivenTimers(timers => {
    const scene = createAgentScene(sceneRecipe(), {}, { deferFlushTriangles: 1 });
    scene.apply(addBadge, { expectedRevision: 0 });
    timers.runSlice();
    timers.runSlice();
    assert.equal(scene.flushPending, true);
    scene.apply(addSecond, { expectedRevision: 1 });
    assert.equal(timers.pending, 1, 'the paused search was dropped and one new search waits');
    while (scene.flushPending) timers.runSlice();
    assert.deepEqual(rankSummary(scene), rankSummary(coldScene(addBadge, addSecond)));
  });
});

test('settleFlush in the middle of a paused search returns the whole result at once', () => {
  withHandDrivenTimers(timers => {
    const scene = createAgentScene(sceneRecipe(), {}, { deferFlushTriangles: 1 });
    scene.apply(addBadge, { expectedRevision: 0 });
    timers.runSlice();
    assert.equal(scene.flushPending, true);
    const topologyBefore = scene.topologyRevision;
    assert.equal(scene.settleFlush(), true);
    assert.equal(scene.flushPending, false);
    assert.equal(scene.topologyRevision, topologyBefore + 1);
    assert.deepEqual(rankSummary(scene), rankSummary(coldScene(addBadge)));
    assert.equal(timers.pending, 0, 'no timer is left behind');
  });
});
