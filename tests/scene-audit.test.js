import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { box, sphere } from '../src/geometry.js';
import { auditScene } from '../src/scene-audit.js';

function invertedBoxGeometry() {
  const geometry = box(0);
  const flipped = new Uint16Array(geometry.indices.length);
  for (let index = 0; index < geometry.indices.length; index += 3) {
    flipped[index] = geometry.indices[index];
    flipped[index + 1] = geometry.indices[index + 2];
    flipped[index + 2] = geometry.indices[index + 1];
  }
  return { ...geometry, indices: flipped };
}

function rotatedYMatrix(translation, angleRadians) {
  const matrix = mat4.create();
  mat4.translate(matrix, matrix, translation);
  mat4.rotateY(matrix, matrix, angleRadians);
  return matrix;
}

test('auditScene passes clean non-overlapping grounded parts and handles rotated near neighbors without false positives', () => {
  const unitBox = box(0);
  const floor = {
    id: 'floor',
    ground: true,
    geometry: unitBox,
    matrix: mat4.fromScaling(mat4.fromTranslation(mat4.create(), [0, -0.5, 0]), [20, 1, 20]),
  };
  const crateA = {
    id: 'crate-a',
    geometry: unitBox,
    matrix: rotatedYMatrix([0, 0.5, 0], Math.PI / 4),
  };
  // Separated along X diagonal so AABBs overlap slightly if padded, but SAT OBBs have positive clearance.
  const crateB = {
    id: 'crate-b',
    geometry: unitBox,
    matrix: rotatedYMatrix([1.45, 0.5, 0], Math.PI / 4),
  };
  const report = auditScene([floor, crateA, crateB]);
  assert.equal(report.ok, true, JSON.stringify(report.findings));
  assert.equal(report.stats.instanceCount, 3);
});

test('auditScene detects coplanar, intersection, floating, and inverted-shell (winding and negative-scale)', () => {
  const unitBox = box(0);
  const inverted = invertedBoxGeometry();
  const floor = {
    id: 'floor',
    ground: true,
    geometry: unitBox,
    matrix: mat4.fromScaling(mat4.fromTranslation(mat4.create(), [0, -0.5, 0]), [30, 1, 30]),
  };
  const basePlate = { id: 'plate-a', geometry: unitBox, matrix: mat4.fromTranslation(mat4.create(), [0, 0.5, 0]) };
  // Exact same top plane + overlapping interior volume -> both coplanar and intersection.
  const overlappingPlate = { id: 'plate-b', geometry: unitBox, matrix: mat4.fromTranslation(mat4.create(), [0.2, 0.5, 0]) };
  const floatingProp = { id: 'floating-prop', geometry: unitBox, matrix: mat4.fromTranslation(mat4.create(), [10, 3.0, 0]) };
  const invertedWinding = { id: 'inverted-winding', geometry: inverted, matrix: mat4.fromTranslation(mat4.create(), [-6, 0.5, 0]) };
  const negativeMirror = {
    id: 'negative-mirror',
    geometry: unitBox,
    matrix: mat4.fromRotationTranslationScale(mat4.create(), [0, 0, 0, 1], [-10, 0.5, 0], [-1, 1, 1]),
  };

  const report = auditScene([floor, basePlate, overlappingPlate, floatingProp, invertedWinding, negativeMirror]);
  assert.equal(report.ok, false);
  assert.ok(report.counts.coplanar >= 1);
  assert.ok(report.counts.intersection >= 1);
  assert.ok(report.counts.floating >= 1);
  assert.equal(report.counts['inverted-shell'], 2);
});

test('auditScene scales to 2,048 instanced parts and 4M+ triangles without truncation in under 2 seconds', () => {
  const coarseBox = box(0);
  const denseTemplate = sphere(40, 30);
  assert.ok(denseTemplate.indices.length / 3 >= 2000);

  const count = 2048;
  const instanceMatrices = new Float32Array(count * 16);
  const cols = 64;
  for (let index = 0; index < count; index++) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const x = col * 3;
    const z = row * 3;
    const y = index === 100 ? 4.5 : 0.5;
    mat4.fromTranslation(instanceMatrices.subarray(index * 16, index * 16 + 16), [x, y, z]);
  }
  const floor = {
    id: 'ground-plane',
    ground: true,
    geometry: coarseBox,
    matrix: mat4.fromScaling(mat4.fromTranslation(mat4.create(), [96, -0.5, 48]), [240, 1, 240]),
  };
  const intersectingOne = { id: 'overlap-1', geometry: coarseBox, matrix: mat4.fromTranslation(mat4.create(), [0.25, 0.5, 0]) };

  const report = auditScene([floor, { id: 'columns', geometry: denseTemplate, instanceMatrices }, intersectingOne]);
  assert.equal(report.stats.instanceCount, count + 2);
  assert.ok(report.stats.totalTriangles > 4_000_000, `Expected >4M triangles, got ${report.stats.totalTriangles}`);
  assert.ok(report.stats.elapsedMs < 2000, `Expected <2000 ms, took ${report.stats.elapsedMs} ms`);
  assert.ok(report.counts.floating >= 1);
  assert.ok(report.counts.intersection >= 1);
});
