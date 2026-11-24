import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { listFrames, main, parseArguments, readPlan } from '../scripts/evidence.mjs';
import { boxMargins, checkClipping, checkContinuity, checkFraming, clipBoxToFrame, describeDropout, findJumps, frameMetrics, projectBounds } from '../scripts/evidence-checks.mjs';

const WIDTH = 40;
const HEIGHT = 40;

/** A WIDTH by HEIGHT RGBA frame filled with one gray level, with `patch` ({ left, top, right, bottom, level }) painted over it. */
function grayFrame(level, patch = null) {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const inPatch = patch && x >= patch.left && x < patch.right && y >= patch.top && y < patch.bottom;
      const value = inPatch ? patch.level : level;
      data.set([value, value, value, 255], (y * WIDTH + x) * 4);
    }
  }
  return { data, width: WIDTH, height: HEIGHT };
}

const SUBJECT_REGION = { left: 10, top: 10, right: 30, bottom: 30 };

test('frame metrics report mean luma, saturation and the pure white and pure black shares', () => {
  const gray = frameMetrics(grayFrame(100));
  assert.equal(gray.meanLuma, 100);
  assert.equal(gray.meanSaturation, 0);
  assert.equal(gray.pixelCount, WIDTH * HEIGHT);
  const red = frameMetrics({ data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1 });
  assert.equal(red.meanSaturation, 255);
  const half = frameMetrics(grayFrame(100, { ...SUBJECT_REGION, level: 255 }), SUBJECT_REGION);
  assert.equal(half.blownShare, 1);
  assert.equal(half.crushedShare, 0);
  assert.throws(() => frameMetrics({ data: new Uint8Array(3), width: 1, height: 1 }), /4 bytes per pixel/);
});

test('a steady clip has no jump and a smooth ramp passes', () => {
  const steady = Array.from({ length: 30 }, () => 120);
  assert.deepEqual(findJumps(steady).jumps, []);
  const ramp = Array.from({ length: 30 }, (_, index) => 100 + index * 2);
  assert.deepEqual(findJumps(ramp).jumps, []);
});

test('a 2-frame dropout in the middle of a clip FAILS the continuity check and names the frames', () => {
  const frames = Array.from({ length: 20 }, (_, index) => {
    const dropped = index === 7 || index === 8;
    return frameMetrics(grayFrame(dropped ? 30 : 120), SUBJECT_REGION);
  });
  const result = checkContinuity(frames);
  assert.equal(result.pass, false);
  assert.deepEqual(result.luma.jumps.map(jump => jump.frame), [7, 9]);
  assert.deepEqual(result.dropouts, [{ firstFrame: 7, lastFrame: 8 }]);
  assert.match(result.detail, /luma frames 7-8: 120\.0 to 30\.0/);
});

const metricsOf = (luma, saturation) => ({ meanLuma: luma, meanSaturation: saturation, blownShare: 0, crushedShare: 0, pixelCount: 1 });

test('the absolute threshold: a single-frame jump of 6 levels FAILS and one of 4 PASSES', () => {
  const clip = jump => Array.from({ length: 12 }, (_, index) => metricsOf(100 + (index >= 6 ? jump : 0), 40));
  const failing = checkContinuity(clip(6));
  assert.equal(failing.pass, false);
  assert.deepEqual(failing.luma.jumps.map(entry => entry.frame), [6]);
  assert.equal(checkContinuity(clip(4)).pass, true);
});

test('the boundary: a jump of exactly 5 levels PASSES (the rule is more than 5) and one just above 5 FAILS', () => {
  const clip = jump => Array.from({ length: 12 }, (_, index) => metricsOf(100 + (index >= 6 ? jump : 0), 40));
  assert.equal(checkContinuity(clip(5)).pass, true);
  assert.deepEqual(findJumps(clip(5).map(metrics => metrics.meanLuma)).jumps, []);
  const justAbove = checkContinuity(clip(5.01));
  assert.equal(justAbove.pass, false);
  assert.deepEqual(justAbove.luma.jumps.map(entry => entry.frame), [6]);
});

test('a dropout of 2 frames is one line labelled with its range, and a 1-frame dropout with its frame', () => {
  const dropoutAt = dropped => Array.from({ length: 20 }, (_, index) => metricsOf(dropped.includes(index) ? 30 : 120, 40));
  const two = checkContinuity(dropoutAt([8, 9]));
  assert.match(two.detail, /luma frames 8-9: 120\.0 to 30\.0/);
  assert.doesNotMatch(two.detail, /luma frame 10/);
  assert.equal(two.detail.match(/luma frame/g).length, 1);
  const one = checkContinuity(dropoutAt([8]));
  assert.match(one.detail, /luma frame 8: 120\.0 to 30\.0/);
  assert.doesNotMatch(one.detail, /luma frames/);
});

test('two separate one-frame dips are two dropouts, and an exit is never reused as the next entry', () => {
  const asMetrics = lumas => lumas.map(luma => metricsOf(luma, 40));
  const apart = checkContinuity(asMetrics([120, 120, 30, 120, 120, 30, 120, 120]));
  assert.deepEqual(apart.dropouts, [{ firstFrame: 2, lastFrame: 2 }, { firstFrame: 5, lastFrame: 5 }]);
  assert.match(apart.detail, /^luma frame 2: 120\.0 to 30\.0 \(90\.0 levels\); luma frame 5: 120\.0 to 30\.0 \(90\.0 levels\)$/);
  const alternating = checkContinuity(asMetrics([120, 30, 120, 30, 120]));
  assert.deepEqual(alternating.dropouts, [{ firstFrame: 1, lastFrame: 1 }, { firstFrame: 3, lastFrame: 3 }]);
  assert.equal(alternating.detail.match(/luma frame/g).length, 2);
});

test('a dropout names its first, last and 3-frame range', () => {
  const dropoutAt = dropped => checkContinuity(Array.from({ length: 12 }, (_, index) => metricsOf(dropped.includes(index) ? 30 : 120, 40))).detail;
  assert.match(dropoutAt([1]), /^luma frame 1:/);
  assert.match(dropoutAt([2, 3, 4]), /^luma frames 2-4:/);
  assert.match(dropoutAt([10, 11]), /^luma frame 10:/);
});

test('bad options throw before the --out folder is created', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'evidence-validate-'));
  try {
    const badRuns = [
      [['--fps', '0'], /--fps must be a whole number/],
      [['--backend', 'tpu'], /--backend must be gpu or cpu/],
      [['--clip', 'abc'], /--clip must be a first and last frame/],
      [['--clip-camera', 'nope'], /--clip-camera "nope" is not one of the cameras/],
      [['--subject', '1,2'], /--subject needs 6 comma-separated numbers/],
      [['--base', 'no-such-ref-3269'], /--base "no-such-ref-3269" is neither a checkout/],
    ];
    for (const [extra, message] of badRuns) {
      const out = join(parent, `out-${extra[0].slice(2)}`);
      await assert.rejects(main(['--issue', '1', '--builtin', 'bar', '--out', out, ...extra]), message, extra[0]);
      assert.equal(existsSync(out), false, `${extra[0]} left the out folder behind`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('a step above 3 times the median step but at most 5 levels is a note, not a failure', () => {
  const values = Array.from({ length: 20 }, (_, index) => index * 0.2 + (index >= 10 ? 4 : 0));
  const result = findJumps(values);
  assert.deepEqual(result.jumps, []);
  assert.deepEqual(result.notes.map(entry => entry.frame), [10]);
  const continuity = checkContinuity(values.map(value => metricsOf(value, 40)));
  assert.equal(continuity.pass, true);
  assert.match(continuity.detail, /note, not a failure: luma frame 10/);
});

test('a steady clip whose saturation settles by 2 levels in its first frames PASSES (the cpu bar clip)', () => {
  const saturation = [35.05, 37.24, 36.82, 36.61, 36.46, 36.1];
  const result = checkContinuity(saturation.map(value => metricsOf(150, value)));
  assert.equal(result.pass, true);
  assert.deepEqual(result.saturation.jumps, []);
});

test('a saturation jump in coloured frames FAILS and is named as saturation', () => {
  const colourFrame = colour => ({ data: Uint8Array.from({ length: 16 }, (_, index) => (index % 4 === 3 ? 255 : colour[index % 4])), width: 2, height: 2 });
  const frames = Array.from({ length: 10 }, (_, index) => frameMetrics(colourFrame(index === 5 ? [160, 120, 120] : [160, 120, 40])));
  assert.ok(Math.abs(frames[0].meanLuma - frames[5].meanLuma) < 12);
  const result = checkContinuity(frames);
  assert.equal(result.pass, false);
  assert.ok(result.saturation.jumps.some(entry => entry.frame === 5));
  assert.match(result.detail, /saturation frame 5/);
});

test('a dropout seen by luma and saturation is one line per measure, and a one-frame dropout reads "frame 7"', () => {
  const dropped = new Set([7, 8]);
  const both = Array.from({ length: 16 }, (_, index) => (dropped.has(index) ? metricsOf(30, 150) : metricsOf(120, 40)));
  const result = checkContinuity(both);
  assert.equal(result.dropouts.length, 1);
  assert.match(result.detail, /luma frames 7-8: 120\.0 to 30\.0/);
  assert.match(result.detail, /saturation frames 7-8: 40\.0 to 150\.0/);
  assert.equal(result.detail.match(/frames? \d/g).length, 2);
  assert.equal(describeDropout({ firstFrame: 7, lastFrame: 7 }), 'frame 7');
  assert.equal(describeDropout({ firstFrame: 7, lastFrame: 8 }), 'frames 7-8');
  const single = checkContinuity(Array.from({ length: 12 }, (_, index) => metricsOf(index === 7 ? 30 : 120, 40)));
  assert.match(single.detail, /luma frame 7: 120\.0 to 30\.0/);
});

test('focal length and aspect: a known point lands on its expected pixel in a non-square frame', () => {
  const point = { min: [2, 1, 0], max: [2, 1, 0] };
  const ninety = projectBounds(point, { eye: [0, 0, 10], target: [0, 0, 0], fov: 90 }, 200, 100);
  assert.ok(Math.abs(ninety.left - 110) < 1e-9, `x ${ninety.left}`);
  assert.ok(Math.abs(ninety.top - 45) < 1e-9, `y ${ninety.top}`);
  const sixty = projectBounds({ min: [5, 0, 0], max: [5, 0, 0] }, { eye: [0, 0, 10], target: [0, 0, 0], fov: 60 }, 200, 100);
  assert.ok(Math.abs(sixty.left - (100 + (50 / Math.tan(Math.PI / 6)) * 0.5)) < 1e-9, `x ${sixty.left}`);
  assert.ok(Math.abs(sixty.top - 50) < 1e-9);
});

test('a subject cut by the frame edge FAILS the framing check with its margin', () => {
  const camera = { eye: [0, 0, 6], target: [0, 0, 0], fov: 45 };
  const inside = projectBounds({ min: [-1, -1, -0.1], max: [1, 1, 0.1] }, camera, 270, 480);
  const passing = checkFraming(inside, 270, 480);
  assert.equal(passing.pass, true);
  const wide = projectBounds({ min: [-3, -1, -0.1], max: [3, 1, 0.1] }, camera, 270, 480);
  const cut = checkFraming(wide, 270, 480);
  assert.equal(cut.pass, false);
  assert.ok(cut.margins.left < 0, `left margin ${cut.margins.left}`);
  assert.match(cut.detail, /leaves the frame at the left, right edge/);
});

test('a subject touching an edge or closer than the required margin FAILS and one behind the camera FAILS', () => {
  assert.equal(checkFraming({ left: 0, top: 50, right: 100, bottom: 100 }, 200, 200).pass, false);
  const near = checkFraming({ left: 5, top: 50, right: 100, bottom: 100 }, 200, 200, { minimumMargin: 8 });
  assert.equal(near.pass, false);
  assert.match(near.detail, /5 px from the left edge; needs at least 8 px/);
  assert.equal(checkFraming({ left: 8, top: 8, right: 192, bottom: 192 }, 200, 200).pass, true);
  const behind = projectBounds({ min: [-1, -1, 7], max: [1, 1, 8] }, { eye: [0, 0, 6], target: [0, 0, 0] }, 200, 200);
  assert.equal(checkFraming(behind, 200, 200).pass, false);
});

test('the projected box of a centred cube is centred and the margins add up', () => {
  const box = projectBounds({ min: [-1, -1, -1], max: [1, 1, 1] }, { eye: [0, 0, 10], target: [0, 0, 0], fov: 45 }, 200, 100);
  const margins = boxMargins(box, 200, 100);
  assert.ok(Math.abs(margins.left - margins.right) < 1e-6);
  assert.ok(Math.abs(margins.top - margins.bottom) < 1e-6);
});

test('blown highlights and crushed shadows over the share limit FAIL', () => {
  const clean = frameMetrics(grayFrame(120), SUBJECT_REGION);
  const blown = frameMetrics(grayFrame(120, { left: 10, top: 10, right: 30, bottom: 20, level: 255 }), SUBJECT_REGION);
  const crushed = frameMetrics(grayFrame(120, { left: 10, top: 10, right: 30, bottom: 20, level: 0 }), SUBJECT_REGION);
  assert.equal(checkClipping([clean, clean]).highlights.pass, true);
  const flagged = checkClipping([clean, blown, crushed], { firstFrame: 4 });
  assert.equal(flagged.highlights.pass, false);
  assert.equal(flagged.highlights.frame, 5);
  assert.equal(flagged.shadows.pass, false);
  assert.equal(flagged.shadows.frame, 6);
});

test('a box is clipped to the frame and one fully outside has no region', () => {
  assert.deepEqual(clipBoxToFrame({ left: -5.5, top: 2.2, right: 12.1, bottom: 50 }, 40, 40), { left: 0, top: 2, right: 13, bottom: 40 });
  assert.equal(clipBoxToFrame({ left: 50, top: 0, right: 60, bottom: 10 }, 40, 40), null);
});

test('--analyze exits 1 on a folder of frames with a 2-frame dropout and 0 on a steady one', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'evidence-analyze-'));
  const originalLog = console.log;
  console.log = () => {};
  try {
    for (const [name, dropped] of [['steady', []], ['dropout', [5, 6]]]) {
      await mkdir(join(folder, name));
      for (let frame = 0; frame < 12; frame += 1) {
        const level = dropped.includes(frame) ? 20 : 120;
        await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: level, g: level, b: level } } }).png().toFile(join(folder, name, `frame-${String(frame).padStart(4, '0')}.png`));
      }
    }
    assert.equal(await main(['--issue', '1', '--analyze', join(folder, 'steady')]), 0);
    assert.equal(await main(['--issue', '1', '--analyze', join(folder, 'dropout')]), 1);
  } finally {
    console.log = originalLog;
    await rm(folder, { recursive: true, force: true });
  }
});

test('every numeric option rejects a bad value with an error naming the option and what to pass', () => {
  const bad = [
    [{ margin: 'abc' }, /--margin must be a number from 0 to 1000, got "abc"\. Pass for example --margin 8/],
    [{ margin: '-1' }, /--margin must be/],
    [{ fps: '0' }, /--fps must be a whole number from 1 to 60, got "0"/],
    [{ fps: '29.5' }, /--fps must be a whole number/],
    [{ width: 'wide' }, /--width must be a whole number from 64 to 4096, got "wide"/],
    [{ height: '' }, /--height must be a whole number from 64 to 4096, got ""/],
    [{ 'still-frame': '-2' }, /--still-frame must be a whole number/],
    [{ 'clipping-share': '2' }, /--clipping-share must be a number from 0 to 1, got "2"/],
    [{ clip: '9-3' }, /--clip must be a first and last frame such as 0-29.*"9-3"/],
    [{ clip: 'abc' }, /--clip must be a first and last frame/],
    [{ backend: 'tpu' }, /--backend must be gpu or cpu, got "tpu"/],
  ];
  for (const [options, message] of bad) assert.throws(() => readPlan(options), message, JSON.stringify(options));
  const good = readPlan({ margin: '12', fps: '24', clip: '0-29', 'still-frame': '3' });
  assert.equal(good.margin, 12);
  assert.equal(good.fps, 24);
  assert.equal(good.stillFrame, 3);
  assert.equal(good.clipRange.count, 30);
  assert.equal(readPlan({}).margin, 8);
});

test('--issue must be a positive whole number', () => {
  for (const issue of ['abc', '0', '-3', '3.5', '']) assert.throws(() => parseArguments(['--issue', issue, '--builtin', 'bar']), /--issue must be a positive whole number/, issue);
  assert.equal(parseArguments(['--issue', '3269', '--builtin', 'bar']).issue, '3269');
});

test('an unknown --clip-camera is an error that lists the cameras', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'evidence-camera-'));
  try {
    await assert.rejects(main(['--issue', '1', '--builtin', 'bar', '--clip-camera', 'nope', '--out', folder]), /--clip-camera "nope" is not one of the cameras being rendered \(front, wide\)/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('--analyze numbers frames by the digits in their names, sorts them numerically, ignores other files and checks --region', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'evidence-names-'));
  const lines = [];
  const originalLog = console.log;
  console.log = line => lines.push(line);
  try {
    const level = frame => (frame === 6 || frame === 7 ? 20 : 120);
    for (let frame = 2; frame <= 13; frame += 1) {
      await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: level(frame), g: level(frame), b: level(frame) } } }).png().toFile(join(folder, `frame-${frame}.png`));
    }
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).png().toFile(join(folder, 'readme.png'));
    await writeFile(join(folder, 'notes.txt'), 'not a frame');
    assert.deepEqual(listFrames(folder).map(entry => entry.frame), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.equal(await main(['--issue', '1', '--analyze', folder]), 1);
    assert.match(lines.join('\n'), /luma frames 6-7: 120\.0 to 20\.0/);
    await assert.rejects(main(['--issue', '1', '--analyze', folder, '--region', '0,0,99,99']), /--region "0,0,99,99" must be left,top,right,bottom inside the 16 by 16 frame/);
    assert.equal(await main(['--issue', '1', '--analyze', folder, '--region', '4,4,12,12']), 1);
    await assert.rejects(main(['--issue', '1', '--analyze', join(folder, 'missing')]), /does not exist\. Pass the folder that holds the frame PNGs/);
  } finally {
    console.log = originalLog;
    await rm(folder, { recursive: true, force: true });
  }
});
