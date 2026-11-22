import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE_FRAME_LIMITS, profileFrameCount, median, countDraws, profileFrames, heaviestNodes } from '../src/render-profile.js';

const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;

function fakeContext() {
  const calls = [];
  return {
    calls, TRIANGLES, TRIANGLE_STRIP, TRIANGLE_FAN: 6, RGBA: 6408, UNSIGNED_BYTE: 5121,
    drawElements(mode, count) { calls.push(['drawElements', mode, count]); },
    drawArrays(mode, first, count) { calls.push(['drawArrays', mode, count]); },
    drawElementsInstanced(mode, count, type, offset, instances) { calls.push(['drawElementsInstanced', mode, count, instances]); },
    drawArraysInstanced(mode, first, count, instances) { calls.push(['drawArraysInstanced', mode, count, instances]); },
    readPixels() { calls.push(['readPixels']); },
  };
}

test('profileFrameCount defaults to 30 and accepts 1 to 120', () => {
  assert.equal(profileFrameCount({ profile: true }), 30);
  assert.equal(profileFrameCount({ profile: true, profileFrames: 1 }), 1);
  assert.equal(profileFrameCount({ profile: true, profileFrames: 120 }), 120);
  assert.deepEqual(PROFILE_FRAME_LIMITS, { minimum: 1, default: 30, maximum: 120 });
});

test('profileFrameCount refuses bad input with a message that says what to pass', () => {
  assert.throws(() => profileFrameCount({ profile: true, profileFrames: 0 }), /from 1 to 120.*Pass, for example/);
  assert.throws(() => profileFrameCount({ profile: true, profileFrames: 121 }), /from 1 to 120/);
  assert.throws(() => profileFrameCount({ profile: true, profileFrames: 2.5 }), /whole number/);
  assert.throws(() => profileFrameCount({ profile: 'yes' }), /profile must be true or false.*"profile": true/);
  assert.throws(() => profileFrameCount({ profileFrames: 10 }), /only applies with profile: true/);
  assert.throws(() => profileFrameCount({ profile: false, profileFrames: 10 }), /only applies with profile: true/);
});

test('median takes the middle value and the mean of the two middle values of an even list', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('countDraws counts calls and triangles of every draw function, strips and instances included', () => {
  const context = fakeContext();
  const watcher = countDraws(context);
  context.drawElements(TRIANGLES, 30);
  context.drawArrays(TRIANGLES, 0, 3);
  context.drawElementsInstanced(TRIANGLES, 6, 5125, 0, 10);
  context.drawArraysInstanced(TRIANGLE_STRIP, 0, 4, 7);
  context.drawArrays(1, 0, 100);
  assert.deepEqual(watcher.counters, { drawCalls: 5, triangles: 10 + 1 + 20 + 14 });
  assert.equal(context.calls.length, 5, 'the original draw functions still run');
  watcher.release();
});

test('countDraws leaves the context as it found it', () => {
  const context = fakeContext();
  const originalDraw = context.drawElements;
  const watcher = countDraws(context);
  assert.notEqual(context.drawElements, originalDraw);
  watcher.release();
  assert.equal(context.drawElements, originalDraw);
  const prototypeContext = Object.create({ drawElements() {} });
  const prototypeWatcher = countDraws(prototypeContext);
  prototypeWatcher.release();
  assert.equal(Object.hasOwn(prototypeContext, 'drawElements'), false);
});

test('profileFrames reports the median frame time and the draws of one frame, after one unmeasured frame', () => {
  const context = fakeContext();
  const clock = [0, 10, 20, 50, 60, 90, 100, 105];
  let tick = 0;
  const drawn = [];
  const result = profileFrames({
    context, frames: 4, now: () => clock[tick++],
    drawFrame: index => { drawn.push(index); context.drawElementsInstanced(TRIANGLES, 300, 5125, 0, 2); context.drawElements(TRIANGLES, 30); },
  });
  assert.deepEqual(drawn, [0, 1, 2, 3, 4]);
  assert.deepEqual(result, { frames: 4, millisecondsPerFrame: 20, millisecondsMinimum: 5, millisecondsMaximum: 30, drawCalls: 2, triangles: 210 });
});

test('profileFrames waits for the GPU after each frame and removes its draw counters when a frame throws', () => {
  const context = fakeContext();
  const originalDraw = context.drawElements;
  assert.throws(() => profileFrames({ context, frames: 3, drawFrame: index => { if (index === 2) throw new Error('lost'); } }), /lost/);
  assert.equal(context.drawElements, originalDraw);
  assert.equal(context.calls.filter(call => call[0] === 'readPixels').length, 2);
});

test('heaviestNodes ranks nodes by triangles, adds parts of one node and keeps five', () => {
  const part = (name, triangles) => ({ name, geometry: { indices: new Uint32Array(triangles * 3) } });
  const parts = [part('a', 10), part('b', 50), part('c', 30), part('b', 5), part('d', 20), part('e', 40), part('f', 1), part('g', 60)];
  assert.deepEqual(heaviestNodes(parts), [
    { id: 'g', triangles: 60, parts: 1 }, { id: 'b', triangles: 55, parts: 2 }, { id: 'e', triangles: 40, parts: 1 },
    { id: 'c', triangles: 30, parts: 1 }, { id: 'd', triangles: 20, parts: 1 },
  ]);
  assert.deepEqual(heaviestNodes([]), []);
});
