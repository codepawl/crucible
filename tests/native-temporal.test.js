import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEMPORAL_DEFAULTS, chooseNativeTemporal, clampToNeighbourhood, createTemporalAccumulator, measureNeighbourhoods, onlyCameraDiffers, readCameraView, temporalFrameSeed,
} from '../scripts/agent-native-temporal.mjs';
import { readFileSync } from 'node:fs';
import { cookFile, cookModule, cookTest } from './support/cook.js';

const WIDTH = 32;
const HEIGHT = 20;
const PIXEL_COUNT = WIDTH * HEIGHT;
const HALF_WIDTH = 0.8;
const HALF_HEIGHT = 0.5;
const WALL_DISTANCE = 5;
const SEED_BYTE = 28;
const KERNEL_FLAGS_BYTE = 32;
const FILM_EXPOSURE_BYTE = 288;

// A FORMAT-v2 kernel parameter block for a camera at `position` that looks down the negative z axis.
function paramsForCamera(position, { seed = 1, lensShift = [0, 0], orthographic = false, exposure = 1 } = {}) {
  const block = new Uint8Array(336);
  const view = new DataView(block.buffer);
  view.setUint32(SEED_BYTE, seed, true);
  view.setUint32(KERNEL_FLAGS_BYTE, 1 | (orthographic ? 8 : 0), true);
  [position, [0, 0, -1], [HALF_WIDTH, 0, 0], [0, HALF_HEIGHT, 0]].forEach((vector, row) => {
    vector.forEach((value, axis) => view.setFloat32(112 + row * 16 + axis * 4, value, true));
  });
  view.setFloat32(176, lensShift[0], true);
  view.setFloat32(180, lensShift[1], true);
  view.setFloat32(FILM_EXPOSURE_BYTE, exposure, true);
  return block;
}

function wallColor(worldX, worldY) {
  return [0.5 + 0.1 * worldX, 0.5 + 0.1 * worldY, 0.25];
}

// The planes a camera at `position` sees of a wall at z = -distance whose colour is a linear function of the place on it.
function wallFrame(position, { distance = WALL_DISTANCE, lensShift = [0, 0] } = {}) {
  const color = new Float32Array(PIXEL_COUNT * 3);
  const depth = new Float32Array(PIXEL_COUNT);
  const normal = new Float32Array(PIXEL_COUNT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const sensorX = ((x + 0.5) / WIDTH) * 2 - 1 + 2 * lensShift[0];
      const sensorY = 1 - ((y + 0.5) / HEIGHT) * 2 + 2 * lensShift[1];
      const reach = distance + position[2];
      const worldX = position[0] + HALF_WIDTH * sensorX * reach;
      const worldY = position[1] + HALF_HEIGHT * sensorY * reach;
      const pixel = y * WIDTH + x;
      color.set(wallColor(worldX, worldY), pixel * 3);
      depth[pixel] = reach * Math.hypot(HALF_WIDTH * sensorX, HALF_HEIGHT * sensorY, 1);
      normal.set([0, 0, 1], pixel * 3);
    }
  }
  return { color, depth, normal };
}

function flatFrame(value) {
  const frame = wallFrame([0, 0, 0]);
  frame.color.fill(value);
  return frame;
}

function maximumDifference(first, second) {
  let maximum = 0;
  for (let index = 0; index < first.length; index++) {
    maximum = Math.max(maximum, Math.abs(first[index] - second[index]));
  }
  return maximum;
}

test('the first frame passes through and says the history started', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  const frame = wallFrame([0, 0, 0]);
  const result = accumulator.accumulate({ ...frame, kernelParams: paramsForCamera([0, 0, 0]) });
  assert.equal(result.restarted, 'the first frame of the job');
  assert.equal(result.historyShare, 0);
  assert.deepEqual(result.color, frame.color);
  assert.notEqual(result.color, frame.color, 'the result is a new buffer');
});

test('a still camera averages every frame it has seen, and a moving one holds the newest frame at the minimum weight', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  const kernelParams = paramsForCamera([0, 0, 0]);
  accumulator.accumulate({ ...flatFrame(1), kernelParams });
  const second = accumulator.accumulate({ ...flatFrame(0), kernelParams: paramsForCamera([0, 0, 0], { seed: 2 }) });
  assert.equal(second.restarted, null, 'another seed is not another scene');
  assert.equal(second.historyShare, 1);
  assert.ok(Math.abs(second.color[0] - 1 / 2) < 1e-6);
  const third = accumulator.accumulate({ ...flatFrame(0), kernelParams });
  assert.ok(Math.abs(third.color[0] - 1 / 3) < 1e-6);
  let last = third;
  for (let frame = 0; frame < 20; frame++) {
    last = accumulator.accumulate({ ...flatFrame(0), kernelParams });
  }
  assert.ok(Math.abs(last.color[0] - 1 / 23) < 1e-6, 'the 23 frames of a still camera count the same');
  const beforeStep = last.color[0];
  // The same wall from a camera one pixel to the side: the history is as long, and the camera moved.
  const step = accumulator.accumulate({ ...flatFrame(1), kernelParams: paramsForCamera([0.25, 0, 0]) });
  const share = (step.color[0] - beforeStep) / (1 - beforeStep);
  assert.ok(Math.abs(share - TEMPORAL_DEFAULTS.minimumWeight) < 1e-4, `a long history takes ${TEMPORAL_DEFAULTS.minimumWeight} of the new frame, got ${share}`);
});

// These frames are 32 pixels wide, so a move of whole pixels turns the view by more than a film frame ever does.
const WIDE_VIEW_AGREEMENT = 0.5;

test('a camera that moves sideways finds each surface point where it was in the frame before', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT, viewAgreement: WIDE_VIEW_AGREEMENT });
  accumulator.accumulate({ ...wallFrame([0, 0, 0]), kernelParams: paramsForCamera([0, 0, 0]) });
  // Three pixels right and two up on the wall, so every point that was on screen sat on a pixel centre.
  const moved = wallFrame([0.75, 0.5, 0]);
  const result = accumulator.accumulate({ ...moved, kernelParams: paramsForCamera([0.75, 0.5, 0]) });
  assert.equal(result.restarted, null);
  assert.equal(result.historyShare, ((WIDTH - 3) * (HEIGHT - 2)) / PIXEL_COUNT, 'three columns and two rows were off screen before');
  // The wall's colour is linear in its place, so history fetched at the right place equals the new frame exactly.
  assert.ok(maximumDifference(result.color, moved.color) < 1e-5);
});

test('a camera that moves forward and a shifted lens reproject as the kernel casts its rays', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT, viewAgreement: WIDE_VIEW_AGREEMENT });
  const lensShift = [0.1, -0.05];
  accumulator.accumulate({ ...wallFrame([0, 0, 0], { lensShift }), kernelParams: paramsForCamera([0, 0, 0], { lensShift }) });
  const moved = wallFrame([0.1, 0, -1], { lensShift });
  const result = accumulator.accumulate({ ...moved, kernelParams: paramsForCamera([0.1, 0, -1], { lensShift }) });
  assert.equal(result.historyShare, 1, 'moving closer keeps every point on screen');
  assert.ok(maximumDifference(result.color, moved.color) < 1e-5);
});

test('history fetched at the wrong place would show: a still wall under a moved camera without reprojection differs', () => {
  const first = wallFrame([0, 0, 0]);
  // Three pixels right and two up on the wall, so every point that was on screen sat on a pixel centre.
  const moved = wallFrame([0.75, 0.5, 0]);
  assert.ok(maximumDifference(first.color, moved.color) > 0.01, 'the two frames differ pixel for pixel, so the test above proves the reprojection');
});

test('a surface seen from another side than in the frame before starts again', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  accumulator.accumulate({ ...flatFrame(1), kernelParams: paramsForCamera([0, 0, 0]) });
  // 0.25 to the side of a wall 5 away turns the view by under 3 degrees, 0.75 by more than 8.
  const smallStep = accumulator.accumulate({ ...flatFrame(0), kernelParams: paramsForCamera([0.25, 0, 0]) });
  assert.ok(smallStep.historyShare > 0.9, `a small step keeps the history, got ${smallStep.historyShare}`);
  const cut = accumulator.accumulate({ ...flatFrame(0.25), kernelParams: paramsForCamera([1, 0, 0]) });
  assert.equal(cut.restarted, null);
  assert.ok(cut.historyShare < 0.1, `only points far to the side were seen from nearly the same direction, got ${cut.historyShare}`);
  const centrePixel = (HEIGHT / 2) * WIDTH + WIDTH / 2;
  assert.equal(cut.color[centrePixel * 3], 0.25, 'the middle of the picture keeps no light gathered from another side');
});

test('a pixel that shows another surface than the frame before starts again', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT, edgeClampDeviations: 0 });
  const kernelParams = paramsForCamera([0, 0, 0]);
  accumulator.accumulate({ ...flatFrame(1), kernelParams });
  const next = flatFrame(0);
  const nearerPixel = 5 * WIDTH + 7;
  const turnedPixel = 9 * WIDTH + 11;
  const missedPixel = 12 * WIDTH + 3;
  next.depth[nearerPixel] *= 0.5;
  next.normal.set([1, 0, 0], turnedPixel * 3);
  next.depth[missedPixel] = 0;
  const result = accumulator.accumulate({ ...next, kernelParams });
  assert.equal(result.color[nearerPixel * 3], 0, 'a nearer surface has no history');
  assert.equal(result.color[turnedPixel * 3], 0, 'a surface facing another way has no history');
  assert.equal(result.color[missedPixel * 3], 0, 'a ray that hit nothing has no history');
  assert.ok(Math.abs(result.color[0] - 0.5) < 1e-6, 'the other pixels blend');
  assert.equal(result.historyShare, (PIXEL_COUNT - 3) / PIXEL_COUNT);
});

test('the whole image starts again when the scene, the light or the render settings changed', () => {
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  const kernelParams = paramsForCamera([0, 0, 0]);
  accumulator.accumulate({ ...flatFrame(1), kernelParams });
  const changedScene = accumulator.accumulate({ ...flatFrame(0), kernelParams, sceneChanged: true });
  assert.equal(changedScene.restarted, 'the scene changed since the frame before');
  assert.equal(changedScene.color[0], 0);
  const brighter = accumulator.accumulate({ ...flatFrame(1), kernelParams: paramsForCamera([0, 0, 0], { exposure: 2 }) });
  assert.equal(brighter.restarted, 'the light or the render settings changed since the frame before');
  assert.equal(brighter.color[0], 1);
  const orthographic = accumulator.accumulate({ ...flatFrame(0), kernelParams: paramsForCamera([0, 0, 0], { exposure: 2, orthographic: true }) });
  assert.equal(orthographic.restarted, 'an orthographic camera is not reprojected');
  accumulator.accumulate({ ...flatFrame(1), kernelParams });
  accumulator.restart('a new shot began');
  const afterCut = accumulator.accumulate({ ...flatFrame(0), kernelParams });
  assert.equal(afterCut.restarted, 'a new shot began');
  assert.equal(afterCut.color[0], 0);
});

test('onlyCameraDiffers ignores the camera, the seed and the tile origin and nothing else', () => {
  const base = paramsForCamera([0, 0, 0]);
  assert.equal(onlyCameraDiffers(base, paramsForCamera([4, 5, 6], { seed: 99, lensShift: [0.2, 0.1], orthographic: true })), true);
  const otherTile = Uint8Array.from(base);
  otherTile[312] = 7;
  assert.equal(onlyCameraDiffers(base, otherTile), true);
  const otherFlag = Uint8Array.from(base);
  otherFlag[KERNEL_FLAGS_BYTE] |= 2;
  assert.equal(onlyCameraDiffers(base, otherFlag), false);
  const otherBounces = Uint8Array.from(base);
  otherBounces[48] = 3;
  assert.equal(onlyCameraDiffers(base, otherBounces), false);
});

test('readCameraView reads the camera the kernel reads', () => {
  const camera = readCameraView(paramsForCamera([1, 2, 3], { lensShift: [0.25, -0.5] }));
  assert.deepEqual(camera.position, [1, 2, 3]);
  assert.deepEqual(camera.forward, [0, 0, -1]);
  assert.ok(Math.abs(camera.rightSquaredLength - HALF_WIDTH * HALF_WIDTH) < 1e-6);
  assert.deepEqual(camera.lensShift, [0.25, -0.5]);
  assert.equal(camera.orthographic, false);
});

test('wrong input is refused with what to pass instead', () => {
  assert.throws(() => createTemporalAccumulator({ width: 0, height: 4 }), /`width` and `height` must be whole numbers of at least 1/);
  assert.throws(() => createTemporalAccumulator({ width: 4, height: 4, minimumWeight: 0 }), /`minimumWeight` must be a number above 0 and at most 1/);
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  const frame = wallFrame([0, 0, 0]);
  assert.throws(() => accumulator.accumulate({ ...frame, color: new Float32Array(4), kernelParams: paramsForCamera([0, 0, 0]) }), /`color` must be a Float32Array of 1920 floats \(3 per pixel\)/);
  assert.throws(() => accumulator.accumulate({ ...frame, kernelParams: new Uint8Array(16) }), /`kernelParams` must be the 336 byte FORMAT-v2 block/);
});

test('each frame of a blended job gets its own seed, and the switch reads the environment', () => {
  assert.equal(temporalFrameSeed(7, 0), 7);
  assert.equal(temporalFrameSeed(7, 5), 12);
  assert.equal(temporalFrameSeed(undefined, 3), 3);
  assert.equal(temporalFrameSeed(4294967295, 2), 1);
  assert.equal(chooseNativeTemporal({}), true);
  assert.equal(chooseNativeTemporal({ JS67_NATIVE_TEMPORAL: 'off' }), false);
});

test('a change of the anamorphic aperture ratio alone is a camera change', () => {
  const first = paramsForCamera([0, 0, 0]);
  const second = paramsForCamera([0, 0, 0]);
  new DataView(second.buffer).setFloat32(320, 2, true);
  assert.equal(onlyCameraDiffers(first, second), true);
  const reserved = paramsForCamera([0, 0, 0]);
  reserved[330] = 1;
  assert.equal(onlyCameraDiffers(first, reserved), false);
});

// The blocks above are built by hand, so this pins the size and layout to the blocks Cook really packs (#1729).
cookTest('a kernel parameter block packed by Cook passes the camera reader and the blend', async () => {
  const { decodePackFile } = await cookModule('pack-file');
  const { kernelParams } = decodePackFile(readFileSync(cookFile('fixtures/room.cookpack')));
  const camera = readCameraView(kernelParams);
  assert.ok(camera.forward.some(value => value !== 0), 'the room camera looks somewhere');
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  const frame = wallFrame([0, 0, 0]);
  const shown = accumulator.accumulate({ ...frame, kernelParams });
  assert.equal(shown.color.length, PIXEL_COUNT * 3);
  assert.notEqual(shown.restarted, null, "the first frame starts the history");
});

function frameWithNearerPixel(nearerPixel, colorValue) {
  const frame = flatFrame(colorValue);
  frame.depth[nearerPixel] *= 0.5;
  return frame;
}

test('a pixel on a depth step takes back clamped history, and starts again with the clamp switched off (#1214)', () => {
  const nearerPixel = 5 * WIDTH + 7;
  const kernelParams = paramsForCamera([0, 0, 0]);
  const withClamp = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  withClamp.accumulate({ ...flatFrame(1), kernelParams });
  const kept = withClamp.accumulate({ ...frameWithNearerPixel(nearerPixel, 0.2), kernelParams });
  assert.equal(kept.historyShare, 1, 'the history of the surface next to it is taken back');
  assert.ok(Math.abs(kept.color[nearerPixel * 3] - 0.2) < 1e-6, 'light brighter than the whole neighbourhood is clamped out, not ghosted in');

  const withoutClamp = createTemporalAccumulator({ width: WIDTH, height: HEIGHT, edgeClampDeviations: 0 });
  withoutClamp.accumulate({ ...flatFrame(1), kernelParams });
  const restarted = withoutClamp.accumulate({ ...frameWithNearerPixel(nearerPixel, 0.2), kernelParams });
  assert.equal(restarted.historyShare, (PIXEL_COUNT - 1) / PIXEL_COUNT);
});

test('a pixel that took history back at a depth step counts at most edgeHistoryFrames frames (#1214)', () => {
  const nearerPixel = 5 * WIDTH + 7;
  const showThroughStep = edgeHistoryFrames => {
    const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT, edgeHistoryFrames });
    for (let frame = 0; frame < 6; frame++) {
      accumulator.accumulate({ ...flatFrame(0), kernelParams: paramsForCamera([0, 0, 0], { seed: frame + 1 }) });
    }
    const stepped = frameWithNearerPixel(nearerPixel, 0);
    for (let pixel = 0; pixel < PIXEL_COUNT; pixel++) {
      stepped.color.fill(pixel % 2, pixel * 3, pixel * 3 + 3);
    }
    return accumulator.accumulate({ ...stepped, kernelParams: paramsForCamera([0, 0, 0], { seed: 9 }) }).color[nearerPixel * 3];
  };
  assert.ok(showThroughStep(2) > showThroughStep(1000) + 0.01, 'a short history lets the new frame count for more');
});

test('the neighbourhood clamp pulls a colour into the mean plus or minus the deviations of the 3x3 around it (#1214)', () => {
  const width = 3;
  const height = 3;
  const color = new Float32Array(width * height * 3);
  for (let pixel = 0; pixel < 9; pixel++) {
    const value = pixel % 2 === 0 ? 0.2 : 0.4;
    color.set([value, value, value], pixel * 3);
  }
  const { colorStatistics, depthRange } = measureNeighbourhoods({ color, depth: new Float32Array(9).fill(2), width, height });
  assert.ok(Math.abs(colorStatistics[4 * 6] - (5 * 0.2 + 4 * 0.4) / 9) < 1e-6, 'luma mean of the centre pixel');
  assert.deepEqual([depthRange[8], depthRange[9]], [2, 2]);
  const [red, green, blue] = clampToNeighbourhood(5, 5, 5, colorStatistics, 4, 1);
  assert.ok(red < 0.5 && green < 0.5 && blue < 0.5, 'a bright outlier is pulled down to the neighbourhood');
  assert.ok(Math.abs(red - green) < 1e-6 && Math.abs(green - blue) < 1e-6, 'a grey stays grey');
  const inside = clampToNeighbourhood(0.3, 0.3, 0.3, colorStatistics, 4, 1);
  assert.deepEqual(inside.map(value => Number(value.toFixed(6))), [0.3, 0.3, 0.3]);
});

test('createTemporalAccumulator refuses an edge clamp or history cap it cannot use (#1214)', () => {
  assert.throws(() => createTemporalAccumulator({ width: 4, height: 4, edgeClampDeviations: -1 }), /edgeClampDeviations/);
  assert.throws(() => createTemporalAccumulator({ width: 4, height: 4, edgeHistoryFrames: 0 }), /edgeHistoryFrames/);
  assert.doesNotThrow(() => createTemporalAccumulator({ width: 4, height: 4, edgeClampDeviations: 0 }));
});

test('a pixel whose clean corners already reach minimumFetchWeight keeps full unclamped history (#1214)', () => {
  const stepPixel = 5 * WIDTH + 6;
  const targetPixel = 5 * WIDTH + 7;
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT, edgeHistoryFrames: 1, viewAgreement: WIDE_VIEW_AGREEMENT });
  for (let frame = 0; frame < 6; frame++) {
    const initial = flatFrame(1);
    initial.depth[stepPixel] *= 0.5;
    initial.color.fill(10, stepPixel * 3, stepPixel * 3 + 3);
    accumulator.accumulate({ ...initial, kernelParams: paramsForCamera([0, 0, 0], { seed: frame + 1 }) });
  }
  // Shift right by 0.25 of a pixel (0.0625 world units at wall distance 5) so sourceX = x - 0.25:
  // 0.75 of the weight lands on targetPixel (same wall) and 0.25 on stepPixel (nearer step).
  const moved = wallFrame([0.0625, 0, 0]);
  moved.color.fill(0);
  moved.depth[stepPixel] *= 0.5;
  const result = accumulator.accumulate({ ...moved, kernelParams: paramsForCamera([0.0625, 0, 0]) });
  // With 6 clean frames of 1 and 1 new frame of 0 (minimumWeight 0.1 -> share 1/7), value is 6/7.
  // Mixing stepPixel (10) or capping edgeHistoryFrames=1 (share 0.5) would move it far from 6/7.
  assert.ok(Math.abs(result.color[targetPixel * 3] - 6 / 7) < 1e-4, `expected clean 6/7, got ${result.color[targetPixel * 3]}`);
});

test('a pixel on a depth step with matching depth and a turned normal keeps clamped history, while a flat surface still drops it (#1214)', () => {
  const neighbourPixel = 5 * WIDTH + 6;
  const turnedPixel = 5 * WIDTH + 7;
  const kernelParams = paramsForCamera([0, 0, 0]);

  const onStep = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  onStep.accumulate({ ...flatFrame(0.5), kernelParams });
  const stepFrame = flatFrame(0.5);
  stepFrame.depth[neighbourPixel] *= 0.5;
  stepFrame.normal.set([1, 0, 0], turnedPixel * 3);
  const kept = onStep.accumulate({ ...stepFrame, kernelParams });
  assert.equal(kept.historyShare, 1, 'turned normal on a depth step is rescued');

  const onFlat = createTemporalAccumulator({ width: WIDTH, height: HEIGHT });
  const centerPixel = (HEIGHT / 2) * WIDTH + WIDTH / 2;
  onFlat.accumulate({ ...flatFrame(0.5), kernelParams });
  const flatTurned = flatFrame(0.5);
  flatTurned.normal.set([1, 0, 0], centerPixel * 3);
  const dropped = onFlat.accumulate({ ...flatTurned, kernelParams });
  assert.equal(dropped.historyShare, (PIXEL_COUNT - 1) / PIXEL_COUNT, 'turned normal without a depth step still restarts');
});

test('depth-step rescues weight texels closer to the expected depth above the opposite surface (#1214)', () => {
  const nearCorner = 5 * WIDTH + 6;
  const farCorner = 5 * WIDTH + 7;
  // Moving left by 0.125 world units (0.5 px at wall distance 5) makes sourceX = 6.5 (equal bilinear weight on nearCorner and farCorner).
  const accumulator = createTemporalAccumulator({ width: WIDTH, height: HEIGHT, edgeClampDeviations: 10, viewAgreement: WIDE_VIEW_AGREEMENT });
  const pastFrame = flatFrame(0.2);
  const expectedDepth = pastFrame.depth[farCorner];
  pastFrame.depth[nearCorner] = expectedDepth * 1.02;
  pastFrame.normal.set([1, 0, 0], nearCorner * 3);
  pastFrame.depth[farCorner] = expectedDepth * 2;
  pastFrame.color.fill(0.8, farCorner * 3, farCorner * 3 + 3);
  accumulator.accumulate({ ...pastFrame, kernelParams: paramsForCamera([0, 0, 0]) });

  const nextFrame = wallFrame([-0.125, 0, 0]);
  nextFrame.color.fill(0.5);
  nextFrame.color.fill(0.2, nearCorner * 3, nearCorner * 3 + 3);
  nextFrame.color.fill(0.8, (farCorner + 1) * 3, (farCorner + 1) * 3 + 3);
  nextFrame.depth[farCorner + 1] = expectedDepth * 2;
  const blended = accumulator.accumulate({ ...nextFrame, kernelParams: paramsForCamera([-0.125, 0, 0]) });
  // Equal bilinear weights on nearCorner (0.2, ~1.02x expectedDepth -> weight ~1.0) and farCorner (0.8, 2x expectedDepth -> weight 0.5):
  // unweighted history would be 0.50 (blended 0.50); depth weighting pulls history to ~0.40 (blended ~0.45 < 0.48).
  assert.ok(blended.color[farCorner * 3] < 0.48, `expected near-depth corner to dominate, got ${blended.color[farCorner * 3]}`);
});
