import assert from 'node:assert/strict';
import test from 'node:test';
import { generateCutterGeometry } from '../src/agent-scene.js';
import { generateMeshGeometry } from '../src/agent-mesh.js';
import { smoothMaskTexels, surfaceMap } from '../src/material-surface-map.js';

const MAP = 1024;
const SNOW_BELOW = Math.round(0.67 * 255);

function coveredPatch(firstColumn, lastColumn, firstRow, lastRow) {
  const covered = new Uint8Array(MAP * MAP);
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) covered[row * MAP + column] = 1;
  }
  return covered;
}

function fillPatch(texels, covered, valueAt) {
  for (let index = 0; index < texels.length; index++) {
    if (covered[index]) texels[index] = valueAt(index % MAP, Math.floor(index / MAP));
  }
}

test('a sawtooth along a row is rounded by the smoothing', () => {
  const covered = coveredPatch(100, 163, 100, 163);
  const texels = new Uint8Array(MAP * MAP);
  fillPatch(texels, covered, column => (column % 4 < 2 ? 100 : 130));
  smoothMaskTexels(texels, covered, MAP);
  let low = 255;
  let high = 0;
  for (let column = 120; column < 140; column++) {
    low = Math.min(low, texels[130 * MAP + column]);
    high = Math.max(high, texels[130 * MAP + column]);
  }
  assert.ok(high - low <= 2, `the sawtooth still swings ${high - low} of the original 30`);
});

test('a jump the mesh means stays hard and uncovered texels stay untouched', () => {
  const covered = coveredPatch(100, 163, 100, 163);
  const texels = new Uint8Array(MAP * MAP);
  texels.fill(77);
  fillPatch(texels, covered, column => (column < 132 ? 10 : 250));
  smoothMaskTexels(texels, covered, MAP);
  assert.equal(texels[130 * MAP + 131], 10, 'the low side of the jump moved');
  assert.equal(texels[130 * MAP + 132], 250, 'the high side of the jump moved');
  assert.equal(texels[130 * MAP + 99], 77, 'a texel outside the covered patch was written');
});

test('two islands one empty column apart do not pull each other', () => {
  const covered = coveredPatch(100, 131, 100, 131);
  const second = coveredPatch(133, 164, 100, 131);
  for (let index = 0; index < covered.length; index++) covered[index] |= second[index];
  const texels = new Uint8Array(MAP * MAP);
  fillPatch(texels, covered, column => (column < 132 ? 40 : 230));
  smoothMaskTexels(texels, covered, MAP);
  assert.equal(texels[120 * MAP + 131], 40);
  assert.equal(texels[120 * MAP + 133], 230);
});

test('the inside of a steep face is never lightened, the texels around it fade to the blur, and the result is repeatable', () => {
  const covered = coveredPatch(100, 227, 100, 163);
  const steepFaces = new Uint8Array(MAP * MAP);
  const first = new Uint8Array(MAP * MAP);
  fillPatch(first, covered, column => (column < 160 ? 215 : 120));
  fillPatch(steepFaces, covered, column => (column < 160 ? 1 : 0));
  const second = Uint8Array.from(first);
  smoothMaskTexels(first, covered, MAP, steepFaces);
  smoothMaskTexels(second, covered, MAP, steepFaces);
  assert.deepEqual(first, second);
  for (let column = 100; column < 150; column++) assert.ok(first[130 * MAP + column] >= 215, `the steep texel at column ${column} fell to ${first[130 * MAP + column]}`);
  const fade = [];
  for (let column = 156; column < 190; column++) fade.push(first[130 * MAP + column]);
  const largestStep = Math.max(...fade.slice(1).map((value, index) => Math.abs(value - fade[index])));
  assert.ok(largestStep < 60, `the value still jumps by ${largestStep} of the original 95 between two neighbours next to the steep face`);
});

// The snow patches of tile m0 and m2 of the six-tile snow mountain set (a 112 by 72 sphere displaced by noise, 15,904
// triangles), as snow texel counts and stepped corners inside a 96 by 96 window of the 1024 slope map, measured on main
// before the smoothing. A first attempt that chose normals per triangle lost half of the snow in these windows.
const TILE_RECIPES = {
  m0: { seeds: [5, 17, 31] },
  m2: { seeds: [25, 37, 51] },
};
const GUARD_WINDOWS = [
  { tile: 'm0', column: 384, row: 0, mainSnow: 3171, mainCorners: 142 },
  { tile: 'm0', column: 432, row: 0, mainSnow: 2959, mainCorners: 173 },
  { tile: 'm2', column: 528, row: 288, mainSnow: 1555, mainCorners: 264 },
];
const WINDOW_SIDE = 96;

function tileSlopeMap(tile) {
  const [coarse, ridges, fine] = TILE_RECIPES[tile].seeds;
  const noise = (scale, seed, octaves) => ({ noise: { scale, seed, octaves } });
  const edits = [
    { op: 'uv_project', mode: 'sphere', axis: 'x' },
    { op: 'displace', field: { add: [{ mul: [{ floor: { mul: [noise(3, coarse, 2), 4] } }, 0.15] }, { mul: [noise(3, coarse, 2), 0.4] }] }, strength: 0.26, midlevel: 0.5 },
    { op: 'displace', field: { sub: [1, { mul: [2, { abs: { sub: [noise(7, ridges, 3), 0.5] } }] }] }, strength: 0.078, midlevel: 0.5 },
    { op: 'displace', field: noise(22, fine, 2), strength: 0.013, midlevel: 0.5 },
  ];
  const base = { type: 'sphere', segments: 112, rings: 72 };
  const geometry = generateMeshGeometry(() => generateCutterGeometry(base, 500000), edits, { maxVertices: 500000 });
  return surfaceMap(geometry, { output: 'slope', space: 'object' }, MAP, tile, undefined);
}

function windowSnowAndCorners(map, { column, row }) {
  const isSnow = (x, y) => map.data[(y * MAP + x) * 4] < SNOW_BELOW;
  let snow = 0;
  let corners = 0;
  for (let y = row; y < row + WINDOW_SIDE; y++) {
    for (let x = column; x < column + WINDOW_SIDE; x++) {
      if (isSnow(x, y)) snow++;
      if (x === column + WINDOW_SIDE - 1 || y === row + WINDOW_SIDE - 1) continue;
      const lit = [isSnow(x, y), isSnow(x + 1, y), isSnow(x, y + 1), isSnow(x + 1, y + 1)].filter(Boolean).length;
      if (lit === 1 || lit === 3) corners++;
    }
  }
  return { snow, corners };
}

test('snow patches on a coarse terrain tile keep most of their snow and lose stepped corners against main', () => {
  const maps = { m0: tileSlopeMap('m0'), m2: tileSlopeMap('m2') };
  for (const window of GUARD_WINDOWS) {
    const { snow, corners } = windowSnowAndCorners(maps[window.tile], window);
    const where = `${window.tile} window at ${window.column},${window.row}`;
    assert.ok(snow >= 0.65 * window.mainSnow, `${where} keeps ${snow} snow texels of main's ${window.mainSnow}`);
    assert.ok(snow <= 1.1 * window.mainSnow, `${where} has ${snow} snow texels, more than main's ${window.mainSnow}`);
    assert.ok(corners <= 0.9 * window.mainCorners, `${where} still has ${corners} stepped corners of main's ${window.mainCorners}`);
  }
});

test('the same tile bakes to the same slope map every time', () => {
  assert.deepEqual(tileSlopeMap('m0').data, tileSlopeMap('m0').data);
});
