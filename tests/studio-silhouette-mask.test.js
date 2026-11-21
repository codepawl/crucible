import assert from 'node:assert/strict';
import test from 'node:test';
import { silhouetteContourSegments } from '../src/studio-silhouette-mask.js';

function quad(screen, indices, left, top, right, bottom) {
  const base = screen.length / 2;
  screen.push(left, top, right, top, right, bottom, left, bottom);
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function pointOnContour(contour, x, y) {
  for (let offset = 0; offset < contour.length; offset += 4) {
    const [x1, y1, x2, y2] = contour.slice(offset, offset + 4);
    const onVertical = x1 === x2 && x === x1 && y >= Math.min(y1, y2) && y <= Math.max(y1, y2);
    const onHorizontal = y1 === y2 && y === y1 && x >= Math.min(x1, x2) && x <= Math.max(x1, x2);
    if (onVertical || onHorizontal) {
      return true;
    }
  }
  return false;
}

test('the contour of one square is its four sides', () => {
  const screen = [];
  const indices = [];
  quad(screen, indices, 10, 10, 20, 20);
  const contour = silhouetteContourSegments([{ screen: new Float32Array(screen), indices }], 100, 100);
  assert.equal(contour.length, 16, 'four runs of four numbers');
  assert.ok(pointOnContour(contour, 10, 15) && pointOnContour(contour, 20, 15));
  assert.ok(pointOnContour(contour, 15, 10) && pointOnContour(contour, 15, 20));
  assert.equal(pointOnContour(contour, 15, 15), false, 'nothing crosses the inside');
});

test('a U shape is outlined around its notch, not across it as a hull would', () => {
  const screen = [];
  const indices = [];
  quad(screen, indices, 10, 10, 20, 40);
  quad(screen, indices, 40, 10, 50, 40);
  quad(screen, indices, 10, 30, 50, 40);
  const contour = silhouetteContourSegments([{ screen: new Float32Array(screen), indices }], 100, 100);
  assert.ok(pointOnContour(contour, 20, 20), 'the inner wall of the left arm');
  assert.ok(pointOnContour(contour, 30, 30), 'the floor of the notch');
  assert.equal(pointOnContour(contour, 30, 10), false, 'no line closes the top of the notch');
});

test('a hole inside the shape gets its own edge', () => {
  const screen = [];
  const indices = [];
  quad(screen, indices, 10, 10, 50, 20);
  quad(screen, indices, 10, 40, 50, 50);
  quad(screen, indices, 10, 20, 20, 40);
  quad(screen, indices, 40, 20, 50, 40);
  const contour = silhouetteContourSegments([{ screen: new Float32Array(screen), indices }], 100, 100);
  assert.ok(pointOnContour(contour, 30, 20) && pointOnContour(contour, 20, 30), 'the rim of the hole');
});

test('a triangle thinner than a pixel is not dropped', () => {
  const screen = new Float32Array([10.1, 10.1, 10.4, 10.1, 10.2, 10.4]);
  const contour = silhouetteContourSegments([{ screen, indices: [0, 1, 2] }], 100, 100);
  assert.ok(contour && contour.length > 0);
});

test('nothing on screen has no contour', () => {
  const screen = new Float32Array([200, 200, 210, 200, 205, 210]);
  assert.equal(silhouetteContourSegments([{ screen, indices: [0, 1, 2] }], 100, 100), null);
});

test('a shape larger than the mask budget is outlined at its true size', () => {
  const screen = [];
  const indices = [];
  quad(screen, indices, 0, 0, 3000, 2000);
  const contour = silhouetteContourSegments([{ screen: new Float32Array(screen), indices }], 3000, 2000);
  const rights = Array.from({ length: contour.length / 4 }, (_, index) => contour[index * 4]);
  assert.ok(Math.max(...rights) >= 2999 && Math.max(...rights) <= 3002);
});

test('a long triangle thinner than a pixel stays one unbroken line, as a rope does', () => {
  const screen = new Float32Array([10, 10, 60, 40, 60.2, 40.1]);
  const contour = silhouetteContourSegments([{ screen, indices: [0, 1, 2] }], 100, 100);
  const columns = new Set();
  for (let offset = 0; offset < contour.length; offset += 4) {
    for (let column = Math.floor(Math.min(contour[offset], contour[offset + 2])); column <= Math.ceil(Math.max(contour[offset], contour[offset + 2])); column += 1) {
      columns.add(column);
    }
  }
  for (let column = 10; column < 60; column += 1) {
    assert.ok(columns.has(column), `column ${column} has part of the line`);
  }
});
