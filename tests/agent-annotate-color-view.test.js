import test from 'node:test';
import assert from 'node:assert/strict';
import { ANNOTATE_LIMITS, colorFromHex, hexFromColor, validateMarks, validateViewCamera, describeMarks } from '../src/agent-annotate.js';
import { runAnnotateSession } from '../scripts/annotate-session.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const view = { width: 400, height: 200 };
const camera = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 60, near: 0.1, far: 100 };

test('colorFromHex and hexFromColor round-trip sRGB hex and linear RGB cleanly (#922)', () => {
  assert.deepEqual(colorFromHex('#FF0000'), [1, 0, 0]);
  assert.equal(hexFromColor([1, 0, 0]), '#ff0000');
  assert.equal(hexFromColor(colorFromHex('#3B82F6')), '#3b82f6');
  assert.throws(() => colorFromHex('3b82f6'), /#rrggbb/);
  assert.throws(() => colorFromHex('#123'), /#rrggbb/);
});

test('validateMarks validates color marks with [r, g, b] or #rrggbb hex and enforces bounds (#922)', () => {
  const [fromVector, fromHex, fromUpperHex] = validateMarks([
    { kind: 'color', x: 100.04, y: 50, color: [1, 0, 0], note: '  brighter red  ' },
    { kind: 'color', x: 200, y: 100, color: '#00FF00' },
    { kind: 'color', x: 250, y: 120, hex: '#3B82F6', note: 'accent' },
  ], view);
  assert.deepEqual(fromVector, { kind: 'color', x: 100, y: 50, color: [1, 0, 0], hex: '#ff0000', note: 'brighter red' });
  assert.deepEqual(fromHex, { kind: 'color', x: 200, y: 100, color: [0, 1, 0], hex: '#00ff00', note: '' });
  assert.equal(fromUpperHex.hex, '#3b82f6');
  assert.deepEqual(fromUpperHex.color, colorFromHex('#3b82f6'));

  assert.throws(() => validateMarks([{ kind: 'color', x: 10, y: 10 }], view), /mark 1 color must be/);
  assert.throws(() => validateMarks([{ kind: 'color', x: 10, y: 10, color: [1.1, 0, 0] }], view), /mark 1 color/);
  assert.throws(() => validateMarks([{ kind: 'color', x: 10, y: 10, color: [-0.01, 0, 0] }], view), /mark 1 color/);
  assert.throws(() => validateMarks([{ kind: 'color', x: 10, y: 10, color: [Number.NaN, 0, 0] }], view), /mark 1 color/);
  assert.throws(() => validateMarks([{ kind: 'color', x: 10, y: 10, color: [1, 0] }], view), /mark 1 color/);
  assert.throws(() => validateMarks([{ kind: 'color', x: 10, y: 10, color: '#zzzzzz' }], view), /mark 1 color must be a "#rrggbb"/);
  assert.throws(() => validateMarks([{ kind: 'color', x: 10, y: 10, color: '#ff0000', hex: '#00ff00' }], view), /hex must match color/);
  assert.throws(() => validateMarks([{ kind: 'color', x: 401, y: 10, color: [1, 0, 0] }], view), /mark 1 x/);
  assert.throws(() => validateMarks([{ kind: 'color', x: 10, y: 10, color: [1, 0, 0], note: 'a'.repeat(281) }], view), /280 characters/);
});

test('validateMarks validates view marks and camera bounds cleanly (#922)', () => {
  const [saved] = validateMarks([
    { kind: 'view', camera: { eye: [1.2345, 2, 3], target: [0, 0.5, 0], fov: 45, up: [0, 1, 0] }, note: '  hero shot  ' },
  ], view);
  assert.deepEqual(saved, {
    kind: 'view',
    camera: { eye: [1.235, 2, 3], target: [0, 0.5, 0], fov: 45 },
    note: 'hero shot',
  });
  assert.deepEqual(validateViewCamera({ eye: [0, 0, 5], target: [0, 0, 0], fov: ANNOTATE_LIMITS.minViewFov }), { eye: [0, 0, 5], target: [0, 0, 0], fov: 5 });
  assert.deepEqual(validateViewCamera({ eye: [0, 0, 5], target: [0, 0, 0], fov: ANNOTATE_LIMITS.maxViewFov }), { eye: [0, 0, 5], target: [0, 0, 0], fov: 120 });

  assert.throws(() => validateMarks([{ kind: 'view' }], view), /mark 1 camera must be an object/);
  assert.throws(() => validateMarks([{ kind: 'view', camera: { eye: [1, 2], target: [0, 0, 0], fov: 45 } }], view), /camera\.eye/);
  assert.throws(() => validateMarks([{ kind: 'view', camera: { eye: [1, Infinity, 3], target: [0, 0, 0], fov: 45 } }], view), /camera\.eye/);
  assert.throws(() => validateMarks([{ kind: 'view', camera: { eye: [1, 2, 3], target: ['0', 0, 0], fov: 45 } }], view), /camera\.target/);
  assert.throws(() => validateMarks([{ kind: 'view', camera: { eye: [1, 2, 3], target: [1, 2, 3], fov: 45 } }], view), /not be the same point/);
  assert.throws(() => validateMarks([{ kind: 'view', camera: { eye: [1, 2, 3], target: [0, 0, 0], fov: 4.9 } }], view), /fov must be a number from 5 to 120/);
  assert.throws(() => validateMarks([{ kind: 'view', camera: { eye: [1, 2, 3], target: [0, 0, 0], fov: 120.1 } }], view), /fov must be a number from 5 to 120/);
  assert.throws(() => validateMarks([{ kind: 'view', camera: { eye: [1, 2, 3], target: [0, 0, 0], fov: Number.NaN } }], view), /fov/);
  assert.throws(() => validateMarks([{ kind: 'view', camera: { eye: [1, 2, 3], target: [0, 0, 0], fov: 45, up: [0, 0, 0] } }], view), /camera\.up/);
  assert.throws(() => validateMarks([{ kind: 'view', camera: { eye: [1, 2, 3], target: [0, 0, 0], fov: 45 }, note: 'x'.repeat(281) }], view), /280 characters/);
  assert.throws(() => validateMarks([{ kind: 'unknown', x: 1, y: 1 }], view), /kind must be "pin", "lasso", "color", "view" or "transform", got "unknown"/);
  assert.throws(() => validateMarks(Array(ANNOTATE_LIMITS.maxMarks + 1).fill({ kind: 'view', camera: { eye: [1, 2, 3], target: [0, 0, 0], fov: 45 } }), view), /at most 16 marks/);
});

test('describeMarks resolves color marks with hit part, shared material warning, and returns view marks without raycasting (#922)', () => {
  let raycastCalls = 0;
  const raycast = ray => {
    raycastCalls += 1;
    if (ray.direction[0] < 0) return { id: 'statue', point: [-0.5, 1.2, 0], normal: [0, 0, 1], distance: 9.5, material: 'stone' };
    return null;
  };
  const partMaterials = { statue: 'stone', floor: 'stone', plinth: 'stone' };
  const marks = describeMarks([
    { kind: 'color', x: 100, y: 100, color: [0.8, 0.2, 0.1], hex: '#e77c59', note: 'make terracotta' },
    { kind: 'color', x: 350, y: 20, color: [0, 0, 1], hex: '#0000ff', note: 'sky color' },
    { kind: 'view', camera: { eye: [3, 2, 5], target: [0, 1, 0], fov: 35 }, note: 'wide frame' },
  ], camera, { ...view, raycast, partMaterials });

  assert.equal(raycastCalls, 2, 'view mark does not trigger raycast');
  assert.deepEqual(marks[0], {
    number: 1,
    kind: 'color',
    pixel: [100, 100],
    color: [0.8, 0.2, 0.1],
    hex: '#e77c59',
    note: 'make terracotta',
    partId: 'statue',
    point: [-0.5, 1.2, 0],
    normal: [0, 0, 1],
    distance: 9.5,
    material: 'stone',
    materialSharedWith: ['floor', 'plinth'],
  });
  assert.deepEqual(marks[1], {
    number: 2,
    kind: 'color',
    pixel: [350, 20],
    color: [0, 0, 1],
    hex: '#0000ff',
    note: 'sky color',
    partId: null,
    point: null,
    normal: null,
    distance: null,
    material: null,
  });
  assert.deepEqual(marks[2], {
    number: 3,
    kind: 'view',
    camera: { eye: [3, 2, 5], target: [0, 1, 0], fov: 35 },
    note: 'wide frame',
  });
});

test('the annotate page renders Pin, Lasso, Color, Save view controls and handles color, view and live render (#922)', async () => {
  const opened = Promise.withResolvers();
  const renderedCameras = [];
  const session = runAnnotateSession({
    png: PNG,
    width: view.width,
    height: view.height,
    camera,
    waitMs: 5000,
    renderView: async nextCamera => {
      renderedCameras.push(nextCamera);
      return PNG;
    },
    open: async url => opened.resolve(url),
  });
  const url = await opened.promise;
  const page = await (await fetch(url)).text();
  for (const id of ['tool-pin', 'tool-lasso', 'tool-color', 'tool-view', 'color-picker', 'view-fov', 'capture-view', 'reset-view']) {
    assert.ok(page.includes(`id="${id}"`), `missing ${id}`);
  }
  const renderBad = await fetch(`${url}render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ camera: { eye: [0, 0, 0], target: [0, 0, 0], fov: 45 } }) });
  assert.equal(renderBad.status, 400);
  const renderOk = await fetch(`${url}render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ camera: { eye: [2, 3, 4], target: [0, 0, 0], fov: 50 } }) });
  assert.equal(renderOk.status, 200);
  assert.equal(renderOk.headers.get('content-type'), 'image/png');
  assert.deepEqual(renderedCameras, [{ eye: [2, 3, 4], target: [0, 0, 0], up: [0, 1, 0], fov: 50 }]);

  const send = body => fetch(`${url}send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send({ marks: [{ kind: 'color', x: 10, y: 20, color: [2, 0, 0] }], image: PNG })).status, 400);
  assert.equal((await send({ marks: [{ kind: 'view', camera: { eye: [1, 2, 3], target: [0, 0, 0], fov: 130 } }], image: PNG })).status, 400);

  const ok = await send({
    marks: [
      { kind: 'color', x: 100, y: 120, hex: '#3B82F6', note: 'coat blue' },
      { kind: 'view', camera: { eye: [2, 3, 4], target: [0, 0, 0], fov: 50 }, note: 'framing' },
    ],
    camera: { eye: [2, 3, 4], target: [0, 0, 0], fov: 50 },
    image: PNG,
  });
  assert.equal(ok.status, 200);
  const result = await session;
  assert.equal(result.outcome, 'sent');
  assert.equal(result.marks[0].kind, 'color');
  assert.equal(result.marks[0].hex, '#3b82f6');
  assert.deepEqual(result.marks[0].color, colorFromHex('#3b82f6'));
  assert.deepEqual(result.marks[1], { kind: 'view', camera: { eye: [2, 3, 4], target: [0, 0, 0], fov: 50 }, note: 'framing' });
  assert.deepEqual(result.camera, { eye: [2, 3, 4], target: [0, 0, 0], up: [0, 1, 0], fov: 50 });
});
