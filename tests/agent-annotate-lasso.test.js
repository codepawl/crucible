import test from 'node:test';
import assert from 'node:assert/strict';
import { ANNOTATE_LIMITS, validateMarks, describeMarks, pointInPolygon, polygonArea, lassoSamplePixels } from '../src/agent-annotate.js';
import { runAnnotateSession } from '../scripts/annotate-session.mjs';

// The lasso mark of scene_ask_user (#922): an outline the person draws, resolved to the parts under it.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const view = { width: 400, height: 200 };
const camera = { eye: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], fov: 60, near: 0.1, far: 100 };
const square = [[100, 50], [200, 50], [200, 150], [100, 150]];

test('pointInPolygon and polygonArea follow the even-odd rule for a square, a notch and a self-crossing bow tie', () => {
  assert.equal(polygonArea(square), 10000);
  assert.equal(pointInPolygon(square, 150, 100), true);
  assert.equal(pointInPolygon(square, 99, 100), false);
  assert.equal(pointInPolygon(square, 150, 151), false);
  const notch = [[0, 0], [100, 0], [100, 100], [60, 100], [60, 40], [40, 40], [40, 100], [0, 100]];
  assert.equal(pointInPolygon(notch, 50, 70), false, 'the notch cut into the bottom is outside');
  assert.equal(pointInPolygon(notch, 20, 70), true);
  assert.equal(pointInPolygon(notch, 50, 20), true);
  const bowTie = [[0, 0], [100, 100], [100, 0], [0, 100]];
  assert.equal(pointInPolygon(bowTie, 10, 50), true, 'the left lobe of the bow tie');
  assert.equal(pointInPolygon(bowTie, 90, 50), true, 'the right lobe');
  assert.equal(pointInPolygon(bowTie, 50, 10), false, 'the open top between the lobes');
  assert.equal(pointInPolygon(bowTie, 50, 90), false, 'the open bottom between the lobes');
});

test('validateMarks keeps a lasso as rounded points and names the field of a bad one', () => {
  const [lasso] = validateMarks([{ kind: 'lasso', points: [[10.04, 20], [100, 20], [100, 80.96]], note: '  these  ' }], view);
  assert.deepEqual(lasso, { kind: 'lasso', points: [[10, 20], [100, 20], [100, 81]], note: 'these' });
  const lassoWith = fields => [{ kind: 'lasso', points: square, ...fields }];
  assert.throws(() => validateMarks(lassoWith({ points: [[0, 0], [10, 10]] }), view), /mark 1 points must be an array of 3 to 64 \[x, y\] pixels, got 2 points/);
  assert.throws(() => validateMarks(lassoWith({ points: undefined }), view), /mark 1 points must be an array of 3 to 64 .*got undefined/);
  const manyPoints = Array.from({ length: ANNOTATE_LIMITS.maxLassoPoints + 1 }, (unused, index) => [200 + Math.round(90 * Math.cos(index / 65 * 2 * Math.PI)), 100 + Math.round(90 * Math.sin(index / 65 * 2 * Math.PI))]);
  assert.throws(() => validateMarks(lassoWith({ points: manyPoints }), view), /got 65 points/);
  assert.equal(validateMarks(lassoWith({ points: manyPoints.slice(0, 64) }), view).length, 1);
  assert.throws(() => validateMarks(lassoWith({ points: [[0, 0], [401, 0], [0, 10]] }), view), /points\[1\] must be \[x, y\] with x from 0 to 400 and y from 0 to 200/);
  assert.throws(() => validateMarks(lassoWith({ points: [[0, 0], [10, -1], [0, 10]] }), view), /points\[1\]/);
  assert.throws(() => validateMarks(lassoWith({ points: [[0, 0], [10, 'a'], [0, 10]] }), view), /points\[1\]/);
  assert.throws(() => validateMarks(lassoWith({ points: [[0, 0], [10, 10, 5], [0, 10]] }), view), /points\[1\]/);
  assert.throws(() => validateMarks(lassoWith({ points: [[0, 0], [10, 10], [20, 20]] }), view), /outline an area/);
  assert.throws(() => validateMarks(lassoWith({ note: 'x'.repeat(281) }), view), /mark 1 note must be text of at most 280 characters/);
  assert.throws(() => validateMarks([{ kind: 'box', x: 1, y: 1 }], view), /mark 1 kind must be "pin", "lasso", "color" or "view", got "box"/);
  assert.deepEqual(validateMarks([{ kind: 'pin', x: 1, y: 2, note: 'a' }], view), [{ x: 1, y: 2, note: 'a' }]);
  assert.equal(validateMarks(Array(ANNOTATE_LIMITS.maxMarks).fill({ kind: 'lasso', points: square }), view).length, ANNOTATE_LIMITS.maxMarks);
});

test('lassoSamplePixels is a fixed grid inside the outline, so the same outline always picks the same pixels', () => {
  const samples = lassoSamplePixels(square);
  assert.equal(samples.length, ANNOTATE_LIMITS.lassoSamplesPerAxis ** 2 + 1);
  assert.ok(samples.every(([x, y]) => x > 100 && x < 200 && y > 50 && y < 150));
  assert.deepEqual(lassoSamplePixels(square), samples);
  const triangle = lassoSamplePixels([[0, 0], [100, 0], [0, 100]]);
  assert.ok(triangle.length > 250 && triangle.length < 330, `about half of 576, got ${triangle.length}`);
  assert.ok(triangle.every(([x, y]) => x + y <= 100));
});

// The camera looks down -z; a ray leaving left of the axis hits the wall, a ray near the axis the lamp, the rest is sky.
function wallLampSky(ray) {
  if (ray.direction[0] < -0.0001) return { id: 'wall', point: [-1, 0, 0], normal: [0, 0, 1], distance: 10, material: 'plaster' };
  if (ray.direction[0] < 0.1) return { id: 'lamp', point: [0.5, 0, 0], normal: [0, 0, 1], distance: 9, material: 'brass' };
  return null;
}

test('describeMarks resolves a lasso to the parts under it, most covered first, and keeps the pin shape for pins', () => {
  const [region, sky, pin] = describeMarks([
    { kind: 'lasso', points: [[100, 50], [300, 50], [300, 150], [100, 150]], note: 'these' },
    { kind: 'lasso', points: [[390, 5], [399, 5], [399, 20]], note: 'sky' },
    { x: 100, y: 100, note: 'pin' },
  ], camera, { ...view, raycast: wallLampSky });
  assert.equal(region.number, 1);
  assert.equal(region.kind, 'lasso');
  assert.deepEqual(region.points, [[100, 50], [300, 50], [300, 150], [100, 150]]);
  assert.deepEqual(region.pixel, [200, 100]);
  assert.deepEqual(region.parts.map(part => part.partId), ['wall', 'lamp']);
  assert.ok(region.parts[0].samples > region.parts[1].samples);
  assert.ok(region.parts.every(part => part.coverage > 0 && part.coverage < 1));
  assert.equal(region.parts[0].material, 'plaster');
  assert.equal(region.partId, 'wall');
  assert.equal(region.material, 'plaster');
  assert.deepEqual(region.normal, [0, 0, 1]);
  assert.equal(sky.partId, null);
  assert.deepEqual(sky.parts, []);
  assert.equal('kind' in pin, false);
  assert.equal(pin.partId, 'wall');
});

test('describeMarks breaks a tie between equally covered parts by part ID', () => {
  const raycast = ray => ({ id: ray.direction[0] < 0 ? 'zebra' : 'apple', point: [0, 0, 0], normal: [0, 1, 0], distance: 1, material: null });
  const lasso = { kind: 'lasso', points: [[100, 50], [300, 50], [300, 150], [100, 150]], note: '' };
  const [mark] = describeMarks([lasso], camera, { ...view, raycast });
  assert.deepEqual(mark.parts.map(part => part.partId).sort(), ['apple', 'zebra']);
  assert.equal(mark.parts[0].samples >= mark.parts[1].samples, true);
});

test('the annotate page offers the lasso tool and returns a validated lasso mark on Send', async () => {
  const opened = Promise.withResolvers();
  const session = runAnnotateSession({ png: PNG, width: view.width, height: view.height, waitMs: 5000, open: async url => opened.resolve(url) });
  const url = await opened.promise;
  assert.match(await (await fetch(`${url}app.js`)).text(), /pointerdown/);
  const page = await (await fetch(url)).text();
  assert.match(page, /id="tool-lasso"/);
  assert.match(page, /"maxLassoPoints":64/);
  const send = marks => fetch(`${url}send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marks, image: PNG }) });
  assert.equal((await send([{ kind: 'lasso', points: [[0, 0], [10, 10]], note: '' }])).status, 400);
  assert.equal((await send([{ kind: 'lasso', points: square, note: 'these' }])).status, 200);
  assert.deepEqual((await session).marks, [{ kind: 'lasso', points: square, note: 'these' }]);
});

// Columns of the picture are three parts: two on "stone" (one marked, one outside the lasso), one on unique "bronze".
function columns(rayDirections) {
  return ray => {
    const found = rayDirections.find(([limit]) => ray.direction[0] < limit);
    if (!found) return null;
    const [, id, material] = found;
    return { id, point: [0, 0, 0], normal: [0, 1, 0], distance: 5, material };
  };
}
const lassoRegion = { kind: 'lasso', points: [[100, 50], [300, 50], [300, 150], [100, 150]], note: 'make these blue' };

test('a lasso part lists the unmarked parts on its material in materialSharedWith, sorted by ID', () => {
  const raycast = columns([[-0.0001, 'plinth', 'stone'], [1, 'statue', 'bronze']]);
  const partMaterials = { zeta: 'stone', plinth: 'stone', alpha: 'stone', statue: 'bronze', lamp: 'brass' };
  const [mark] = describeMarks([lassoRegion], camera, { ...view, raycast, partMaterials });
  const plinth = mark.parts.find(part => part.partId === 'plinth');
  const statue = mark.parts.find(part => part.partId === 'statue');
  assert.deepEqual(plinth.materialSharedWith, ['alpha', 'zeta']);
  assert.equal('materialSharedWithMore' in plinth, false);
  assert.equal('materialSharedWith' in statue, false, 'a unique material has no field');
});

test('a part whose material is shared only with parts inside the same mark gets no materialSharedWith', () => {
  const raycast = columns([[-0.0001, 'left', 'stone'], [1, 'right', 'stone']]);
  const [mark] = describeMarks([lassoRegion], camera, { ...view, raycast, partMaterials: { left: 'stone', right: 'stone' } });
  assert.equal(mark.parts.some(part => 'materialSharedWith' in part), false);
});

test('materialSharedWith lists at most 8 IDs and counts the rest in materialSharedWithMore', () => {
  const raycast = columns([[1, 'plinth', 'stone']]);
  const partMaterials = { plinth: 'stone' };
  for (let index = 0; index < 11; index++) partMaterials[`floor-${String(index).padStart(2, '0')}`] = 'stone';
  const [mark] = describeMarks([lassoRegion], camera, { ...view, raycast, partMaterials });
  const [plinth] = mark.parts;
  assert.deepEqual(plinth.materialSharedWith, ['floor-00', 'floor-01', 'floor-02', 'floor-03', 'floor-04', 'floor-05', 'floor-06', 'floor-07']);
  assert.equal(plinth.materialSharedWithMore, 3);
  partMaterials['floor-11'] = 'other';
  delete partMaterials['floor-10'];
  delete partMaterials['floor-09'];
  delete partMaterials['floor-08'];
  const [exact] = describeMarks([lassoRegion], camera, { ...view, raycast, partMaterials });
  assert.equal(exact.parts[0].materialSharedWith.length, 8);
  assert.equal('materialSharedWithMore' in exact.parts[0], false, 'exactly 8 needs no count');
});

test('a part under 15 percent of the picked pixels is marked edge: true and stays listed', () => {
  // The sliver is the strip of rays right of x = 0.46 at the far right of the outline.
  const raycast = ray => ({ id: ray.direction[0] > 0.46 ? 'floor' : 'plinth', point: [0, 0, 0], normal: [0, 1, 0], distance: 5, material: 'stone' });
  const [mark] = describeMarks([lassoRegion], camera, { ...view, raycast });
  const floor = mark.parts.find(part => part.partId === 'floor');
  const plinth = mark.parts.find(part => part.partId === 'plinth');
  assert.ok(floor && floor.coverage > 0 && floor.coverage < ANNOTATE_LIMITS.edgeCoverage, `floor coverage ${floor?.coverage}`);
  assert.equal(floor.edge, true);
  assert.deepEqual(plinth.materialSharedWith, undefined, 'no partMaterials given, so nothing is claimed');
  assert.equal('edge' in plinth, false);
  const atThreshold = describeMarks([lassoRegion], camera, { ...view, raycast: () => ({ id: 'only', point: [0, 0, 0], normal: [0, 1, 0], distance: 1, material: null }) })[0];
  assert.equal('edge' in atThreshold.parts[0], false, 'full coverage is not an edge');
  assert.equal(ANNOTATE_LIMITS.edgeCoverage, 0.15);
});

test('a pin result gains materialSharedWith only when partMaterials shows other parts on its material', () => {
  const pin = { x: 100, y: 100, note: 'pin' };
  const expected = { number: 1, pixel: [100, 100], note: 'pin', partId: 'wall', point: [-1, 0, 0], normal: [0, 0, 1], distance: 10, material: 'plaster' };
  assert.deepEqual(describeMarks([pin], camera, { ...view, raycast: wallLampSky })[0], expected);
  assert.deepEqual(describeMarks([pin], camera, { ...view, raycast: wallLampSky, partMaterials: { wall: 'plaster', other: 'paint' } })[0], expected, 'a unique material has no field');
  assert.deepEqual(
    describeMarks([pin], camera, { ...view, raycast: wallLampSky, partMaterials: { wall: 'plaster', zeta: 'plaster', alpha: 'plaster' } })[0],
    { ...expected, materialSharedWith: ['alpha', 'zeta'] },
  );
});

test('a pin on empty sky has no materialSharedWith, and a pin list caps it at 8 with a count of the rest', () => {
  const sky = { x: 100, y: 100, note: 'sky' };
  assert.equal('materialSharedWith' in describeMarks([sky], camera, { ...view, raycast: () => null, partMaterials: { wall: 'plaster' } })[0], false);
  const raycast = () => ({ id: 'plinth', point: [0, 0, 0], normal: [0, 1, 0], distance: 5, material: 'stone' });
  const partMaterials = { plinth: 'stone' };
  for (let index = 0; index < 11; index++) partMaterials[`floor-${String(index).padStart(2, '0')}`] = 'stone';
  const [pin] = describeMarks([{ x: 100, y: 100, note: 'pin' }], camera, { ...view, raycast, partMaterials });
  assert.equal(pin.materialSharedWith.length, 8);
  assert.equal(pin.materialSharedWith[0], 'floor-00');
  assert.equal(pin.materialSharedWithMore, 3);
});
