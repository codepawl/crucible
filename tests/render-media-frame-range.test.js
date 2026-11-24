import test from 'node:test';
import assert from 'node:assert/strict';
import { MAXIMUM_FRAME_RANGE_COUNT, framePath, parseFrameRange, parseRenderOptions } from '../scripts/render-media.mjs';

test('--frames reads a first and last frame, both included, or one frame', () => {
  assert.deepEqual(parseFrameRange('0-89'), { first: 0, last: 89, count: 90 });
  assert.deepEqual(parseFrameRange('12'), { first: 12, last: 12, count: 1 });
});

test('--frames refuses input it cannot read and says what to pass', () => {
  assert.throws(() => parseFrameRange('abc'), /such as 0-89/);
  assert.throws(() => parseFrameRange('5-2'), /Pass the smaller number first/);
  assert.throws(() => parseFrameRange('-3'), /such as 0-89/);
  assert.throws(() => parseFrameRange('1.5-3'), /such as 0-89/);
  assert.throws(() => parseFrameRange(`0-${MAXIMUM_FRAME_RANGE_COUNT}`), /several ranges/);
  assert.equal(parseFrameRange(`0-${MAXIMUM_FRAME_RANGE_COUNT - 1}`).count, MAXIMUM_FRAME_RANGE_COUNT);
});

test('frame files are zero padded to four digits, or to the width of the last frame', () => {
  assert.match(framePath('out/a.png', 7, 89, 'png'), /frame-0007\.png$/);
  assert.match(framePath('out/a.png', 7, 123456, 'png'), /frame-000007\.png$/);
  assert.match(framePath('out/a.png', 3, 9, 'jpeg'), /frame-0003\.jpg$/);
});

test('render options keep --frames to stills and refuse a second way to set the time', () => {
  const base = ['--scene', 'file', '--config', 'scene.json'];
  assert.throws(() => parseRenderOptions([...base, '--kind', 'video', '--frames', '0-9']), /needs --kind stills/);
  assert.throws(() => parseRenderOptions([...base, '--kind', 'stills', '--frames', '0-9', '--start', '1']), /drop --start, --time and --duration/);
  assert.throws(() => parseRenderOptions([...base, '--frames', '0-9']), /needs --kind stills/);
});
