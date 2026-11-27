import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMarks, describeMarks } from '../src/agent-annotate.js';
import { runAnnotateSession } from '../scripts/annotate-session.mjs';
import { previewHarness } from './support/preview-harness.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const view = { width: 400, height: 200 };
const camera = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 60, near: 0.1, far: 100 };

test('validateMarks enforces bounds for transform marks and per-mark time on every mark kind (#922)', () => {
  const [vectorScale, tinyScale, lassoAtTime, colorAtTime, viewAtTime] = validateMarks([
    { kind: 'transform', x: 10, y: 20, scaleFactor: [1, 2.3456, 1], note: 'tall' },
    { kind: 'transform', x: 20, y: 30, scaleFactor: 0.0001, note: 'tiny' },
    { kind: 'lasso', points: [[10, 10], [100, 10], [100, 80]], time: 0.5 },
    { kind: 'color', x: 50, y: 60, hex: '#3B82F6', time: 1.25 },
    { kind: 'view', camera: { eye: [2, 2, 5], target: [0, 0, 0], fov: 45 }, time: 3600 },
  ], view);
  assert.deepEqual(vectorScale.scaleFactor, [1, 2.346, 1]);
  assert.equal(tinyScale.scaleFactor, 0.0001);
  assert.equal(lassoAtTime.time, 0.5);
  assert.equal(colorAtTime.time, 1.25);
  assert.equal(viewAtTime.time, 3600);

  for (const invalid of [
    [{ kind: 'transform', x: 10, y: 20, deltaPosition: [1000.1, 0, 0] }],
    [{ kind: 'transform', x: 10, y: 20, deltaPosition: [-1001, 0, 0] }],
    [{ kind: 'transform', x: 10, y: 20, deltaPosition: [1, 2] }],
    [{ kind: 'transform', x: 10, y: 20, deltaRotation: [361, 0, 0] }],
    [{ kind: 'transform', x: 10, y: 20, deltaRotation: [0, -361, 0] }],
    [{ kind: 'transform', x: 10, y: 20, scaleFactor: 0 }],
    [{ kind: 'transform', x: 10, y: 20, scaleFactor: -1 }],
    [{ kind: 'transform', x: 10, y: 20, scaleFactor: 100.1 }],
    [{ kind: 'transform', x: 10, y: 20, scaleFactor: [1, 0, 1] }],
    [{ kind: 'transform', x: 10, y: 20, scaleFactor: [1, 101, 1] }],
    [{ kind: 'transform', x: 10, y: 20, scaleFactor: 1 }],
    [{ kind: 'transform', x: 401, y: 20, deltaPosition: [1, 0, 0] }],
    [{ kind: 'transform', x: 10, y: 20, deltaPosition: [1, 0, 0], note: 'a'.repeat(281) }],
    [{ kind: 'pin', x: 10, y: 20, time: -0.01 }],
    [{ kind: 'lasso', points: [[10, 10], [100, 10], [100, 80]], time: 3600.1 }],
    [{ kind: 'color', x: 10, y: 20, hex: '#ff0000', time: Number.NaN }],
    [{ kind: 'view', camera: { eye: [1, 2, 3], target: [0, 0, 0], fov: 45 }, time: '1.5' }],
  ]) {
    assert.throws(() => validateMarks(invalid, view), TypeError, JSON.stringify(invalid));
  }
});

test('describeMarks preserves time across all mark kinds and resolves transform marks on sky (#922)', () => {
  const results = describeMarks([
    { kind: 'transform', x: 380, y: 10, deltaRotation: [0, 90, 0], note: 'sky spin', time: 2.5 },
    { kind: 'lasso', points: [[10, 10], [50, 10], [50, 50]], note: 'group', time: 1.5 },
    { kind: 'view', camera: { eye: [1, 2, 5], target: [0, 0, 0], fov: 40 }, note: 'cam', time: 3 },
  ], camera, { ...view, raycast: () => null });
  assert.deepEqual(results[0], {
    number: 1,
    kind: 'transform',
    pixel: [380, 10],
    deltaRotation: [0, 90, 0],
    note: 'sky spin',
    time: 2.5,
    partId: null,
    point: null,
    normal: null,
    distance: null,
    material: null,
  });
  assert.equal(results[1].time, 1.5);
  assert.equal(results[2].time, 3);
});

test('annotate session renders Transform and timeline controls, validates /render motionTime, and accepts transform marks (#922)', async () => {
  const opened = Promise.withResolvers();
  const renderedCalls = [];
  const session = runAnnotateSession({
    png: PNG,
    width: view.width,
    height: view.height,
    camera,
    motion: { duration: 4, time: 1 },
    waitMs: 5000,
    renderView: async (nextCamera, motionTime) => {
      renderedCalls.push({ camera: nextCamera, motionTime });
      return PNG;
    },
    open: async url => opened.resolve(url),
  });
  const url = await opened.promise;
  const page = await (await fetch(url)).text();
  for (const id of ['tool-transform', 'transform-options', 'tf-dx', 'tf-dy', 'tf-dz', 'tf-rx', 'tf-ry', 'tf-rz', 'tf-s', 'motion-options', 'motion-scrub', 'motion-time']) {
    assert.ok(page.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.match(page, /"motion":\{"duration":4,"time":1\}/);
  const badTimeRender = await fetch(`${url}render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camera: { eye: [0, 0, 5], target: [0, 0, 0], fov: 45 }, motionTime: 3601 }),
  });
  assert.equal(badTimeRender.status, 400);
  const okTimeRender = await fetch(`${url}render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camera: { eye: [0, 0, 5], target: [0, 0, 0], fov: 45 }, motionTime: 2.3456 }),
  });
  assert.equal(okTimeRender.status, 200);
  assert.equal(renderedCalls[0].motionTime, 2.346);

  const sendResponse = await fetch(`${url}send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      marks: [
        { kind: 'transform', x: 100, y: 100, deltaPosition: [0.5, 0, 0], note: 'slide', time: 2.3456 },
        { x: 200, y: 100, note: 'pin', time: 0 },
      ],
      image: PNG,
    }),
  });
  assert.equal(sendResponse.status, 200);
  const result = await session;
  assert.equal(result.outcome, 'sent');
  assert.equal(result.marks[0].kind, 'transform');
  assert.deepEqual(result.marks[0].deltaPosition, [0.5, 0, 0]);
  assert.equal(result.marks[0].time, 2.346);
  assert.equal(result.marks[1].time, 0);
});

test('previewHarness annotateFrame reports motion and pickMarks resolves per-mark timestamps against animated poses (#922)', async () => {
  const { preview } = previewHarness();
  const staticRecipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    camera: { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 45 },
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.8, 0.2, 0.2], roughness: 0.5 }],
    nodes: [{ id: 'mover', geometry: 'box', material: 'paint', translation: [0, 0, 0], scale: [1, 1, 1] }],
  };
  preview.create({ recipe: staticRecipe, sessionId: 'static-s', backend: 'cpu', memoryBudgetMiB: 64 });
  const staticFrame = preview.annotateFrame({ sessionId: 'static-s' });
  assert.equal('motion' in staticFrame, false);

  const movingRecipe = {
    ...staticRecipe,
    motion: {
      duration: 4,
      loop: false,
      tracks: [{
        kind: 'node',
        id: 'mover',
        property: 'translation',
        keyframes: [
          { time: 0, value: [-2, 0, 0] },
          { time: 2, value: [2, 0, 0] },
        ],
      }],
    },
  };
  preview.create({ recipe: movingRecipe, sessionId: 'moving-s', backend: 'cpu', memoryBudgetMiB: 64 });
  const movingFrame = preview.annotateFrame({ sessionId: 'moving-s', motionTime: 0 });
  assert.equal(movingFrame.motion.duration, 4);
  assert.equal(movingFrame.motion.time, 0);

  // At t=0 the box sits on the left (x=-2, ~pixel x=34% of width); at t=2 it moves to the right (x=+2, ~pixel x=66%).
  const leftPixelX = Math.round(movingFrame.width * 0.34);
  const rightPixelX = Math.round(movingFrame.width * 0.66);
  const midPixelY = Math.round(movingFrame.height * 0.5);
  const picked = await preview.pickMarks({
    sessionId: 'moving-s',
    camera: movingFrame.camera,
    width: movingFrame.width,
    height: movingFrame.height,
    motionTime: 0,
    marks: [
      { kind: 'transform', x: leftPixelX, y: midPixelY, deltaPosition: [0, 1, 0], note: 'lift at start', time: 0 },
      { kind: 'transform', x: rightPixelX, y: midPixelY, deltaRotation: [0, 45, 0], note: 'turn at t=2', time: 2 },
      { kind: 'transform', x: rightPixelX, y: midPixelY, scaleFactor: 1.5, note: 'miss at t=0', time: 0 },
    ],
  });
  assert.equal(picked.marks[0].partId, 'mover');
  assert.equal(picked.marks[0].time, 0);
  assert.deepEqual(Array.from(picked.marks[0].deltaPosition), [0, 1, 0]);
  assert.equal(picked.marks[1].partId, 'mover');
  assert.equal(picked.marks[1].time, 2);
  assert.deepEqual(Array.from(picked.marks[1].deltaRotation), [0, 45, 0]);
  assert.equal(picked.marks[2].partId, null, 'at t=0 the mover is on the left, not the right');
});
