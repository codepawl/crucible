import test from 'node:test';
import assert from 'node:assert/strict';
import { applyScrollFade, scrollFadeEdges } from '../src/studio-scroll-cue.js';

const body = (scrollTop, clientHeight, scrollHeight) => ({ scrollTop, clientHeight, scrollHeight });

test('a body that fits shows no fade on either edge', () => {
  assert.deepEqual(scrollFadeEdges(body(0, 200, 200)), { top: false, bottom: false });
  assert.deepEqual(scrollFadeEdges(body(0, 200, 200.5)), { top: false, bottom: false });
});

test('at the top only the bottom fades, at the end only the top, between them both', () => {
  assert.deepEqual(scrollFadeEdges(body(0, 100, 300)), { top: false, bottom: true });
  assert.deepEqual(scrollFadeEdges(body(100, 100, 300)), { top: true, bottom: true });
  assert.deepEqual(scrollFadeEdges(body(200, 100, 300)), { top: true, bottom: false });
  assert.deepEqual(scrollFadeEdges(body(199.5, 100, 300)), { top: true, bottom: false });
});

test('applyScrollFade writes and clears the data markers', () => {
  const element = { dataset: {}, scrollTop: 40, clientHeight: 100, scrollHeight: 300 };
  assert.deepEqual(applyScrollFade(element), { top: true, bottom: true });
  assert.deepEqual({ ...element.dataset }, { fadeTop: 'true', fadeBottom: 'true' });
  element.scrollTop = 200;
  applyScrollFade(element);
  assert.deepEqual({ ...element.dataset }, { fadeTop: 'true' });
  element.scrollHeight = 100;
  applyScrollFade(element);
  assert.deepEqual({ ...element.dataset }, {});
});
