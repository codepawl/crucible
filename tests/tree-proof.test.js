import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { TREE_PRESETS } from '../src/vegetation-presets.js';
import { LEVEL_SETTINGS, TREE_LEVEL_DISTANCES } from '../src/vegetation-species.js';
import {
  PRESET_NAMES, fitFraming, formatProofTable, growTree, horizonCells, levelBounds, levelCameraEye, levelProbes, measureTreeLevels,
  BAND_METRIC_NAMES, PHOTO_BANDS, bandFailures, crownMetrics, paintedLeafLengthCentimeters, photoBand, photoTreeMask, segmentSky, solidityFromMask,
} from '../scripts/tree-proof-lib.mjs';

test('the proof covers the seven presets the library ships', () => {
  assert.deepEqual(PRESET_NAMES, Object.keys(TREE_PRESETS));
  assert.deepEqual([...PRESET_NAMES].sort(), ['ash', 'aspen', 'birch', 'bush', 'oak', 'palm', 'pine']);
});

test('level probes sit just inside and just outside every switch distance', () => {
  const probes = levelProbes(TREE_LEVEL_DISTANCES, 0.05);
  assert.equal(probes.length, TREE_LEVEL_DISTANCES.length * 2);
  assert.deepEqual(probes.map(probe => probe.level), [0, 1, 1, 2, 2, 3]);
  assert.deepEqual(probes.map(probe => probe.side), ['below', 'above', 'below', 'above', 'below', 'above']);
  assert.ok(Math.abs(probes[0].distance - 36.1) < 1e-9);
  assert.ok(Math.abs(probes[1].distance - 39.9) < 1e-9);
  for (let index = 1; index < probes.length; index++) assert.ok(probes[index].distance > probes[index - 1].distance);
  assert.equal(probes.at(-1).level, LEVEL_SETTINGS.length - 1);
  assert.throws(() => levelProbes([95, 38]), /increasing distances/);
  assert.throws(() => levelProbes([38], 1.5), /fraction between 0 and 1/);
});

test('solidity is the opaque share of the row span of the crown', () => {
  // Row 0: ##.# is 3 opaque in a span of 4. Row 1 is empty and adds nothing. Row 2: .#.. is 1 in a span of 1.
  const mask = Uint8Array.from([1, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0]);
  assert.deepEqual(solidityFromMask(mask, 4, 3), { opaque: 4, silhouette: 5, solidity: 0.8 });
  assert.equal(solidityFromMask(new Uint8Array(6), 3, 2).solidity, 0);
  assert.equal(solidityFromMask(new Uint8Array(4).fill(1), 2, 2).solidity, 1);
  assert.throws(() => solidityFromMask(new Uint8Array(5), 2, 3), /pass width \* height = 6/);
});

test('the horizon cells are the baked views that rise less than about 14 degrees', () => {
  const cells = horizonCells();
  assert.ok(cells.length > 8 && cells.length < 64);
  assert.equal(horizonCells(2).length, 64);
  assert.equal(horizonCells(0).length, 0);
});

test('painted leaf length follows the card height, the texture and the level scale', () => {
  const [shortest, longest] = paintedLeafLengthCentimeters({ texture: 'sprig', cardHeightMeters: 1.1, leafScale: 1 });
  assert.ok(Math.abs(shortest - 18.9) < 0.1 && Math.abs(longest - 34.4) < 0.1);
  const [scaledShortest] = paintedLeafLengthCentimeters({ texture: 'sprig', cardHeightMeters: 1.1, leafScale: 1.7 });
  assert.ok(Math.abs(scaledShortest / shortest - 1.7) < 1e-9);
  assert.throws(() => paintedLeafLengthCentimeters({ texture: 'moss', cardHeightMeters: 1 }), /texture must be one of/);
  assert.throws(() => paintedLeafLengthCentimeters({ texture: 'sprig', cardHeightMeters: 0 }), /positive number of meters/);
});

test('the framing gives the share the photo shows, and never lets the tree leave the picture', () => {
  const bounds = { minimum: [-2, 0, -2], maximum: [2, 10, 2] };
  const photo = fitFraming({ bounds, aspect: 4 / 3, photoFraction: 0.5, distance: 20 });
  assert.ok(Math.abs(photo.visibleHeight - 20) < 1e-9);
  assert.ok(Math.abs(2 * 20 * Math.tan(photo.fov * Math.PI / 360) - 20) < 1e-9);
  assert.deepEqual([photo.centerX, photo.centerY], [0, 5]);
  const tall = fitFraming({ bounds, aspect: 4 / 3, photoFraction: 1, distance: 20 });
  assert.ok(Math.abs(tall.visibleHeight - 10 / 0.9) < 1e-9, 'a tree as tall as the photo still keeps a margin');
  const wide = fitFraming({ bounds: { minimum: [-20, 0, -1], maximum: [20, 4, 1] }, aspect: 4 / 3, photoFraction: 0.8, distance: 50 });
  assert.ok(Math.abs(wide.visibleHeight - 40 / (4 / 3 * 0.9)) < 1e-9, 'a wide crown widens the view');
});

test('the level camera stands exactly the probe distance from the tree base', () => {
  const eye = levelCameraEye({ centerX: 1, centerY: 6, distance: 38 });
  assert.deepEqual(eye.slice(0, 2), [1, 6]);
  assert.ok(Math.abs(Math.hypot(...eye) - 38) < 1e-9);
  assert.throws(() => levelCameraEye({ centerY: 6, distance: 5 }), /distance to the middle of the tree/);
});

test('level bounds cover the parts of that level, and the far crown is wider than the near one', () => {
  const tree = growTree({ preset: 'oak', seed: 4 });
  const near = levelBounds(tree, 0);
  const far = levelBounds(tree, 3);
  assert.ok(near.maximum[1] > 5 && near.minimum[1] < 0.5);
  assert.ok(far.maximum[0] - far.minimum[0] > near.maximum[0] - near.minimum[0]);
});

test('an oak measures four levels with the triangles of its geometry and a solidity between 0 and 1', () => {
  const rows = measureTreeLevels({ preset: 'oak', seed: 4, frameSize: 32 });
  assert.equal(rows.length, LEVEL_SETTINGS.length);
  assert.deepEqual(rows.slice(0, 3).map(row => row.foliageTriangles), [9072, 3024, 1452]);
  for (const row of rows) assert.ok(row.solidity > 0 && row.solidity <= 1);
  assert.ok(rows[2].leafCentimeters[0] > rows[1].leafCentimeters[0], 'the far level paints the same card on bigger quads');
  const [shortest, longest] = rows[0].leafCentimeters;
  assert.ok(shortest > 4 && longest < 13, 'twig cards paint leaves of 5 to 12 cm, an oak leaf');
  assert.ok(rows[1].leafCentimeters[0] > shortest * 1.6);
  const text = formatProofTable(rows);
  assert.match(text, /^preset\s+level\s+foliage tris\s+bark tris\s+solidity\s+leaf cm/);
  assert.equal(text.split('\n').length, rows.length + 1);
});

// ---- Crown metrics and the photo band (#3057) ----

function discMask(width, height, centerX, centerY, radiusX, radiusY) {
  const mask = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      if (((column + 0.5 - centerX) / radiusX) ** 2 + ((row + 0.5 - centerY) / radiusY) ** 2 <= 1) mask[row * width + column] = 1;
    }
  }
  return mask;
}

function clearSquare(mask, width, left, top, side) {
  for (let row = top; row < top + side; row++) {
    for (let column = left; column < left + side; column++) mask[row * width + column] = 0;
  }
}

test('a solid disc is full, has no bays and no sky hole, and is widest in the middle', () => {
  const metrics = crownMetrics(discMask(200, 200, 100, 100, 90, 90), 200, 200);
  assert.ok(metrics.hullFill > 0.98, `hull fill ${metrics.hullFill}`);
  assert.ok(metrics.bayShare < 0.02);
  assert.equal(metrics.skyHole, 0);
  assert.ok(Math.abs(metrics.widthOverHeight - 1) < 0.06);
  assert.ok(Math.abs(metrics.widestRow - 0.5) < 0.05);
});

test('an enclosed sky hole is measured by its side over the crown height', () => {
  const mask = discMask(200, 200, 100, 100, 90, 90);
  clearSquare(mask, 200, 90, 90, 20);
  const metrics = crownMetrics(mask, 200, 200);
  assert.ok(Math.abs(metrics.skyHole - 20 / 180) < 0.01, `sky hole ${metrics.skyHole}`);
  assert.ok(metrics.hullFill < 0.99 && metrics.bayShare < 0.02, 'a hole is not a bay');
});

test('specks of sky at the rim are not interior light, a gap inside the crown is', () => {
  const ragged = discMask(200, 200, 100, 100, 90, 90);
  // Enclosed holes of 6 pixels, a few pixels inside the rim: the ragged edge of a dense crown.
  for (const angle of [0.4, 1.3, 2.2, 3.1, 4.0, 4.9]) {
    clearSquare(ragged, 200, Math.round(100 + Math.cos(angle) * 86) - 3, Math.round(100 + Math.sin(angle) * 86) - 3, 6);
  }
  const edge = crownMetrics(ragged, 200, 200);
  assert.ok(edge.skyHole > 0.02, `the old sky hole sees the specks: ${edge.skyHole}`);
  assert.ok(edge.interiorHole < 0.01 && edge.interiorOpen < 0.005, `interior hole ${edge.interiorHole}, open ${edge.interiorOpen}`);
  const gap = discMask(200, 200, 100, 100, 90, 90);
  clearSquare(gap, 200, 80, 85, 40);
  const inside = crownMetrics(gap, 200, 200);
  assert.ok(Math.abs(inside.interiorHole - 40 / 180) < 0.02, `interior hole ${inside.interiorHole}`);
  assert.ok(inside.interiorOpen > 0.04, `interior open ${inside.interiorOpen}`);
});

test('a notch open to the sky is a bay, not a sky hole', () => {
  const mask = discMask(200, 200, 100, 100, 90, 90);
  for (let row = 10; row < 100; row++) {
    for (let column = 90; column < 110; column++) mask[row * 200 + column] = 0;
  }
  const metrics = crownMetrics(mask, 200, 200);
  assert.ok(metrics.bayShare > 0.05, `bay share ${metrics.bayShare}`);
  assert.equal(metrics.skyHole, 0);
});

test('width over height follows the crown, and the trunk under it is left out', () => {
  const crown = discMask(300, 300, 150, 100, 140, 70);
  for (let row = 170; row < 300; row++) {
    for (let column = 145; column < 155; column++) crown[row * 300 + column] = 1;
  }
  const metrics = crownMetrics(crown, 300, 300);
  assert.ok(Math.abs(metrics.widthOverHeight - 2) < 0.05, `width over height ${metrics.widthOverHeight}`);
  assert.ok(metrics.hullFill > 0.97, 'the trunk would pull the hull down');
  assert.throws(() => crownMetrics(new Uint8Array(100), 10, 10), /no opaque pixel/);
  assert.throws(() => crownMetrics(new Uint8Array(99), 10, 10), /pass width \* height = 100/);
});

test('sky segmentation keeps the tree, drops blue and grey sky and a separate neighbour', () => {
  const width = 60;
  const height = 40;
  const rgb = new Uint8Array(width * height * 3);
  const paint = (column, row, color) => rgb.set(color, (row * width + column) * 3);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) paint(column, row, column < 30 ? [150, 190, 235] : [215, 215, 215]);
  }
  for (let row = 5; row < 30; row++) {
    for (let column = 10; column < 25; column++) paint(column, row, [40, 90, 30]);
    for (let column = 35; column < 45; column++) paint(column, row, [200, 200, 60]);
  }
  for (let row = 33; row < 38; row++) {
    for (let column = 50; column < 55; column++) paint(column, row, [30, 30, 30]);
  }
  const mask = segmentSky(rgb, width, height);
  assert.equal(mask[10 * width + 15], 1, 'the green crown is tree');
  assert.equal(mask[2 * width + 5], 0, 'the blue sky is sky');
  assert.equal(mask[2 * width + 50], 0, 'the grey sky is sky');
  assert.equal(mask[35 * width + 52], 0, 'a speck apart from the tree is dropped');
  assert.throws(() => segmentSky(new Uint8Array(10), 4, 4), /pass width \* height \* 3 = 48/);
});

test('a photo crop must be four fractions inside the picture', async () => {
  await assert.rejects(photoTreeMask('missing.jpg', [0.5, 0, 0.8, 1]), /crop must be \[left, top, width, height\]/);
  await assert.rejects(photoTreeMask('missing.jpg', [0, 0, 0, 1]), /fractions of the photo/);
});

test('a photo band spans the in-leaf photos only, widened a little, and a bare photo does not move it', () => {
  const leaf = { kind: 'leaf', hullFill: 0.8, bayShare: 0.1, interiorHole: 0.02, interiorOpen: 0.05, widthOverHeight: 1.0, widestRow: 0.4 };
  const other = { ...leaf, hullFill: 0.9, bayShare: 0.2, interiorHole: 0.04, interiorOpen: 0.1, widthOverHeight: 1.2, widestRow: 0.5 };
  const bare = { ...leaf, kind: 'bare', hullFill: 0.2 };
  const band = photoBand([leaf, other, bare], 0.1);
  assert.deepEqual(band.hullFill.map(value => Number(value.toFixed(3))), [0.79, 0.91]);
  assert.deepEqual(bandFailures(leaf, band), []);
  assert.deepEqual(bandFailures({ ...leaf, hullFill: 0.7, interiorHole: 0.09 }, band), ['hullFill', 'interiorHole']);
  assert.throws(() => photoBand([bare]), /no in-leaf photo/);
});

test('option A, the rejected oak crown, fails the oak photo band', () => {
  const { width, height, runs } = JSON.parse(readFileSync(new URL('./fixtures/tree-crown-option-a.json', import.meta.url), 'utf8'));
  const mask = new Uint8Array(width * height);
  let position = 0;
  runs.forEach((length, index) => {
    if (index % 2 === 1) mask.fill(1, position, position + length);
    position += length;
  });
  assert.equal(position, width * height);
  const metrics = crownMetrics(mask, width, height);
  const failures = bandFailures(metrics, PHOTO_BANDS.oak);
  assert.ok(failures.includes('hullFill') && failures.includes('bayShare'), `option A failed only on ${failures.join(', ')}`);
  const insideBand = Object.fromEntries(BAND_METRIC_NAMES.map(name => [name, (PHOTO_BANDS.oak[name][0] + PHOTO_BANDS.oak[name][1]) / 2]));
  assert.deepEqual(bandFailures(insideBand, PHOTO_BANDS.oak), []);
});

test('every twig texture kind is sized like the oak twig card', () => {
  const oak = paintedLeafLengthCentimeters({ texture: 'twig', cardHeightMeters: 1, leafScale: 1 });
  for (const texture of ['twig-birch', 'twig-aspen', 'twig-ash']) assert.deepEqual(paintedLeafLengthCentimeters({ texture, cardHeightMeters: 1, leafScale: 1 }), oak);
});
