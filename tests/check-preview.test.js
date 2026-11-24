import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodePng } from '../scripts/agent-icon-png.mjs';
import {
  checkExposure, checkNearPlane, checkPreview, checkReferenceRegions, checkSimilarity, checkTemporalStability, exposureStatistics,
  flatShare, luminanceFromPixels, regionComparison, resizePlane, structuralSimilarity,
} from '../scripts/preview-checks.mjs';

const WIDTH = 160;
const HEIGHT = 96;

function plane(width, height, valueAt) {
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) values[row * width + column] = valueAt(column, row);
  }
  return { width, height, values };
}

function hash(column, row, seed = 0) {
  let value = (column * 374761393 + row * 668265263 + seed * 2246822519) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 1274126177) >>> 0;
  return (value ^ (value >>> 16)) / 4294967295;
}

// A smooth, detailed surface: overlapping sine waves, so it can be moved by a fraction of a pixel without aliasing.
function smoothTexture(column, row) {
  return 120 + 50 * Math.sin(column * 0.31 + row * 0.07) + 35 * Math.sin(row * 0.27 - column * 0.11) + 20 * Math.sin((column + row) * 0.19);
}

function gradientFrame(low, high) {
  return plane(WIDTH, HEIGHT, (column, row) => low + ((high - low) * (column + row)) / (WIDTH + HEIGHT - 2));
}

test('luminanceFromPixels weighs green most and resizePlane averages the pixels it covers', () => {
  const pixels = luminanceFromPixels({ width: 2, height: 1, data: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]) });
  assert.ok(pixels.values[1] > pixels.values[0] * 3);
  const resized = resizePlane({ width: 2, height: 2, values: Float32Array.from([0, 100, 100, 200]) }, 1, 1);
  assert.equal(resized.values[0], 100);
  assert.throws(() => luminanceFromPixels({ width: 0, height: 1, data: new Uint8Array(4) }), /positive integer width/);
  assert.throws(() => luminanceFromPixels({ width: 2, height: 2, data: new Uint8Array(4) }), /needs 16 bytes/);
});

test('a frame with the full range of values passes the exposure check', () => {
  const result = checkExposure(gradientFrame(5, 230));
  assert.equal(result.pass, true, result.problems.join('; '));
  assert.ok(Math.abs(result.measured.median - 117.5) < 2);
});

test('a washed-out frame with no dark values fails, as the rejected monk preview did', () => {
  const result = checkExposure(gradientFrame(120, 235));
  assert.equal(result.pass, false);
  assert.match(result.problems[0], /washed out/);
});

test('blown highlights and a frame that is too dark both fail', () => {
  assert.match(checkExposure(gradientFrame(0, 400)).problems.join(' '), /clipped to white/);
  assert.match(checkExposure(gradientFrame(0, 30)).problems.join(' '), /too dark/);
});

test('a frame much brighter than its reference fails even when it looks fine on its own', () => {
  const candidate = gradientFrame(40, 220);
  const reference = gradientFrame(5, 120);
  assert.equal(checkExposure(candidate).pass, true);
  const result = checkExposure(candidate, reference);
  assert.equal(result.pass, false);
  assert.match(result.problems.join(' '), /brighter than the reference/);
  assert.equal(checkExposure(candidate, candidate).pass, true);
});

test('exposureStatistics counts the share of pixels clipped to white', () => {
  const statistics = exposureStatistics(plane(10, 10, column => (column < 3 ? 255 : 100)));
  assert.equal(statistics.brightClippedPercent, 30);
  assert.equal(statistics.median, 100);
});

test('a detailed surface moved smoothly between frames does not count as shimmer', () => {
  const frames = Array.from({ length: 8 }, (_, index) => plane(WIDTH, HEIGHT, (column, row) => smoothTexture(column + index * 1.6, row + index * 0.4)));
  const result = checkTemporalStability(frames);
  assert.equal(result.pass, true, result.problems.join('; '));
  assert.ok(result.measured.shimmerPercent < 0.5);
});

test('texels that change from frame to frame in one corner fail and name that corner', () => {
  const frames = Array.from({ length: 8 }, (_, index) => plane(WIDTH, HEIGHT, (column, row) => {
    const moving = smoothTexture(column + index, row);
    const inUpperRight = column >= WIDTH * 0.6 && row < HEIGHT * 0.35;
    return inUpperRight ? moving + 80 * (hash(column, row, index) - 0.5) : moving;
  }));
  const result = checkTemporalStability(frames);
  assert.equal(result.pass, false);
  assert.equal(result.measured.hotspot, 'upper right');
  assert.match(result.problems[0], /change shape between frames/);
});

// Smooth value noise on a five-pixel grid: detailed like a real surface but with no period, so a match found at the
// wrong offset cannot hide behind a repeating pattern.
function valueNoise(column, row, seed) {
  const cell = 5;
  const gridColumn = Math.floor(column / cell);
  const gridRow = Math.floor(row / cell);
  const fractionX = column / cell - gridColumn;
  const fractionY = row / cell - gridRow;
  const easeX = fractionX * fractionX * (3 - 2 * fractionX);
  const easeY = fractionY * fractionY * (3 - 2 * fractionY);
  const corner = (cornerColumn, cornerRow) => hash(cornerColumn + 1000, cornerRow + 1000, seed);
  const upper = corner(gridColumn, gridRow) + (corner(gridColumn + 1, gridRow) - corner(gridColumn, gridRow)) * easeX;
  const lower = corner(gridColumn, gridRow + 1) + (corner(gridColumn + 1, gridRow + 1) - corner(gridColumn, gridRow + 1)) * easeX;
  // hash() is centred on zero, so this spans 40 to 200.
  return 120 + 160 * (upper + (lower - upper) * easeY);
}

// A camera truck past a near object: the background drifts one pixel a frame while a box close to the lens slides
// nine, more than the search around the camera motion reaches. `flicker` adds texels that change from frame to frame.
function parallaxFrames(flicker = () => 0) {
  return Array.from({ length: 8 }, (_, index) => plane(WIDTH, HEIGHT, (column, row) => {
    const boxLeft = 20 + index * 9;
    const inBox = column >= boxLeft && column < boxLeft + 48 && row >= 24 && row < 72;
    const value = inBox ? valueNoise(column - boxLeft, row - 24, 7) : valueNoise(column + index, row, 3);
    return value + flicker(column, row, index, inBox);
  }));
}

test('a near object that moves faster than the background, as in a truck past a chair, does not count as shimmer', () => {
  const result = checkTemporalStability(parallaxFrames());
  assert.equal(result.pass, true, result.problems.join('; '));
  assert.ok(result.measured.shimmerPercent < 0.5);
});

test('thin edges that blink between frames still fail when the clip also has parallax', () => {
  // One-pixel bright lines in the lower left that show on every other frame, as aliased chair legs and blind slats do.
  const blinkingLines = (column, row, index, inBox) => (!inBox && row >= HEIGHT * 0.6 && column < WIDTH * 0.4 && column % 4 === 0 && index % 2 === 0 ? 90 : 0);
  const lines = checkTemporalStability(parallaxFrames(blinkingLines));
  assert.equal(lines.pass, false);
  assert.equal(lines.measured.hotspot, 'lower left');
  // Specular glints that sparkle on the moving box itself: the box's own motion must not explain them away.
  const glints = (column, row, index, inBox) => (inBox && hash(column, row, index) > 0.35 ? 120 : 0);
  const box = checkTemporalStability(parallaxFrames(glints));
  assert.equal(box.pass, false);
  assert.equal(box.measured.hotspot, 'centre');
});

test('the stability check is skipped for fewer than three frames', () => {
  assert.equal(checkTemporalStability([gradientFrame(0, 200), gradientFrame(0, 200)]).skipped, 'needs at least three frames');
});

test('flatShare counts the blocks without detail', () => {
  const half = plane(WIDTH, HEIGHT, (column, row) => (column < WIDTH / 2 ? 140 : smoothTexture(column, row)));
  assert.ok(Math.abs(flatShare(half) - 0.5) < 0.05);
  assert.equal(flatShare(plane(WIDTH, HEIGHT, smoothTexture)), 0);
});

test('a featureless slab that fills the first frames and slides away fails, as the classroom truck did', () => {
  const frames = Array.from({ length: 12 }, (_, index) => {
    const slabEdge = Math.max(0, WIDTH * 0.45 - index * 12);
    return plane(WIDTH, HEIGHT, (column, row) => (column < slabEdge ? 170 : smoothTexture(column + index, row)));
  });
  const result = checkNearPlane(frames);
  assert.equal(result.pass, false);
  assert.equal(result.measured.largestFlatFrame, 0);
  assert.match(result.problems.join(' '), /inside a surface/);
});

test('a wall that appears in one frame fails on the jump, and a steady detailed clip passes', () => {
  const frames = Array.from({ length: 6 }, (_, index) => plane(WIDTH, HEIGHT, (column, row) => (index === 3 && row < HEIGHT * 0.6 ? 90 : smoothTexture(column + index, row))));
  assert.match(checkNearPlane(frames).problems.join(' '), /appears at frame 3/);
  const steady = Array.from({ length: 6 }, (_, index) => plane(WIDTH, HEIGHT, (column, row) => smoothTexture(column + index, row)));
  assert.equal(checkNearPlane(steady).pass, true);
});

test('a still that is almost all featureless fails on its own', () => {
  assert.match(checkNearPlane([plane(WIDTH, HEIGHT, () => 200)]).problems.join(' '), /no detail/);
});

test('structural similarity is one for the same frame and lower for different content', () => {
  const frame = plane(WIDTH, HEIGHT, smoothTexture);
  assert.ok(Math.abs(structuralSimilarity(frame, frame) - 1) < 1e-6);
  const other = plane(WIDTH, HEIGHT, (column, row) => 255 * hash(column, row));
  assert.ok(structuralSimilarity(frame, other) < 0.2);
  assert.equal(checkSimilarity(frame, other, 0.5).pass, false);
  assert.equal(checkSimilarity(frame, other).pass, true);
  assert.throws(() => structuralSimilarity(frame, plane(8, 8, () => 0)), /same size/);
});

// Region checks run on the analysis size, 640 pixels wide, so these frames use it too.
test('a frame that matches its reference in every region passes the region check', () => {
  const reference = plane(640, 384, (column, row) => valueNoise(column, row, 5));
  const shifted = plane(640, 384, (column, row) => valueNoise(column + 1, row, 5));
  const result = checkReferenceRegions(shifted, reference);
  assert.equal(result.pass, true, result.problems.join('; '));
  assert.equal(regionComparison(shifted, reference).length, 12);
});

test('stains broken into blotches in one region fail and name it, as the monk walls did', () => {
  const reference = plane(640, 384, (column, row) => valueNoise(column, row, 5));
  // Coarse multiplicative blotches over the upper left only, the camo pattern of a stain map baked per vertex.
  const blotched = plane(640, 384, (column, row) => {
    const value = valueNoise(column, row, 5);
    if (column >= 160 || row >= 128) return value;
    return value * (0.4 + 1.2 * (hash(Math.floor(column / 24), Math.floor(row / 24), 9) + 0.5));
  });
  const result = checkReferenceRegions(blotched, reference);
  assert.equal(result.pass, false);
  assert.equal(result.measured.worstRegion, 'upper left');
  assert.match(result.problems.join(' '), /upper left \(column 1, row 1\) differs from the reference in patches/);
});

test('a region much darker than the reference fails even when its structure matches', () => {
  const reference = plane(640, 384, (column, row) => valueNoise(column, row, 5));
  const darkCorner = plane(640, 384, (column, row) => valueNoise(column, row, 5) - (column >= 480 && row < 128 ? 60 : 0));
  const result = checkReferenceRegions(darkCorner, reference);
  assert.equal(result.pass, false);
  assert.match(result.problems.join(' '), /upper right .* darker than the reference/);
});

test('checkPreview resizes the reference to the frame and passes a good clip', () => {
  const frames = Array.from({ length: 6 }, (_, index) => plane(WIDTH, HEIGHT, (column, row) => smoothTexture(column + index * 0.5, row)));
  const reference = plane(WIDTH * 2, HEIGHT * 2, (column, row) => smoothTexture(column / 2, row / 2));
  const report = checkPreview({ frames, reference, referenceFrame: 0 });
  assert.equal(report.pass, true, JSON.stringify(report.results.flatMap(result => result.problems)));
  assert.deepEqual(report.results.map(result => result.name), ['exposure', 'shimmer', 'near-plane', 'similarity', 'regions']);
  assert.throws(() => checkPreview({ frames: [] }), /at least one frame/);
});

function runCommand(argumentsList) {
  return spawnSync(process.execPath, ['scripts/check-preview.mjs', ...argumentsList], { encoding: 'utf8' });
}

function writeStill(directory, name, valueAt) {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4, 255);
  for (let row = 0; row < HEIGHT; row++) {
    for (let column = 0; column < WIDTH; column++) {
      const value = Math.max(0, Math.min(255, Math.round(valueAt(column, row))));
      data.fill(value, (row * WIDTH + column) * 4, (row * WIDTH + column) * 4 + 3);
    }
  }
  const path = join(directory, name);
  writeFileSync(path, encodePng({ width: WIDTH, height: HEIGHT, data }));
  return path;
}

test('the command passes a good PNG, fails a washed-out one against its reference and rejects bad options', () => {
  const directory = mkdtempSync(join(tmpdir(), 'check-preview-'));
  const good = writeStill(directory, 'good.png', (column, row) => smoothTexture(column, row) - 60 + row);
  const washed = writeStill(directory, 'washed.png', (column, row) => 170 + smoothTexture(column, row) / 4);
  const passed = runCommand([good]);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /^PASS exposure/m);
  const failed = runCommand([washed, '--reference', good]);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAIL exposure/);
  const json = JSON.parse(runCommand([good, '--json']).stdout);
  assert.equal(json.pass, true);
  assert.equal(runCommand([]).status, 2);
  assert.match(runCommand([good, '--frames', '0']).stderr, /--frames needs a positive number/);
  assert.match(runCommand([good, '--colour']).stderr, /Unknown option --colour/);
});

test('--lossless measures the frames in the folder instead of the clip, and rejects a missing or empty folder', () => {
  const directory = mkdtempSync(join(tmpdir(), 'check-preview-lossless-'));
  const clipStandIn = writeStill(directory, 'clip-stand-in.png', (column, row) => smoothTexture(column, row) - 60 + row);
  const framesFolder = join(directory, 'frames');
  mkdirSync(framesFolder);
  for (let index = 0; index < 6; index++) {
    writeStill(framesFolder, `frame-${String(index).padStart(4, '0')}.png`, (column, row) => smoothTexture(column + index * 0.5, row) - 60 + row);
  }
  const fromCandidate = JSON.parse(runCommand([clipStandIn, '--json']).stdout);
  assert.equal(fromCandidate.frames, 1);
  assert.equal(fromCandidate.framesFrom, 'candidate');
  assert.equal(fromCandidate.results.find(result => result.name === 'shimmer'), undefined, 'one frame cannot be checked for shimmer');
  const fromLossless = JSON.parse(runCommand([clipStandIn, '--lossless', framesFolder, '--json']).stdout);
  assert.equal(fromLossless.frames, 6);
  assert.equal(fromLossless.framesFrom, 'lossless');
  assert.ok(fromLossless.results.find(result => result.name === 'shimmer'), 'six lossless frames are checked for shimmer');
  assert.match(runCommand([clipStandIn, '--lossless', framesFolder]).stdout, /PASS .* \(6 frames read from /);
  assert.match(runCommand([clipStandIn, '--lossless', clipStandIn]).stderr, /--lossless needs a folder of PNG frames/);
  const emptyFolder = join(directory, 'empty');
  mkdirSync(emptyFolder);
  assert.match(runCommand([clipStandIn, '--lossless', emptyFolder]).stderr, /has no PNG frames/);
});
