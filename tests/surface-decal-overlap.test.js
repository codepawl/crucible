import test from 'node:test';
import assert from 'node:assert/strict';
import { findSurfaceDecalOverlaps } from '../src/scene-query.js';

function boxGeometry(halfWidth, halfHeight, halfDepth) {
  return {
    positions: Float32Array.of(
      -halfWidth, -halfHeight, -halfDepth,
      halfWidth, -halfHeight, -halfDepth,
      halfWidth, halfHeight, -halfDepth,
      -halfWidth, halfHeight, -halfDepth,
      -halfWidth, -halfHeight, halfDepth,
      halfWidth, -halfHeight, halfDepth,
      halfWidth, halfHeight, halfDepth,
      -halfWidth, halfHeight, halfDepth,
    ),
  };
}

function translation(x, y, z) {
  return Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1);
}

test('findSurfaceDecalOverlaps is exported from scene-query and detects part overlap and clearance gaps', () => {
  const board = { min: [0, 0], max: [2, 1], y: 0, coordinateSpace: 'world' };
  const parts = [
    { id: 'ic-u1', geometry: boxGeometry(0.1, 0.02, 0.1), matrix: translation(0.5, 0.02, 0.5) },
    { id: 'cap-c1', bounds: [1.2, 0, 0.4, 1.3, 0.03, 0.6] },
  ];
  const decals = [
    { id: 'label-u1', bounds: [0.45, 0.45, 0.55, 0.55] },
    { id: 'label-near-cap', bounds: [1.32, 0.45, 1.45, 0.55] },
    { id: 'label-clear', bounds: [0.1, 0.1, 0.3, 0.2] },
  ];

  const overlaps = findSurfaceDecalOverlaps(parts, board, decals, { clearance: 0.05 });
  assert.equal(overlaps.length, 2);
  assert.equal(overlaps[0].decalId, 'label-u1');
  assert.equal(overlaps[0].targetId, 'ic-u1');
  assert.equal(overlaps[0].kind, 'part');
  assert.ok(overlaps[0].clearanceGap < 0);

  assert.equal(overlaps[1].decalId, 'label-near-cap');
  assert.equal(overlaps[1].targetId, 'cap-c1');
  assert.equal(overlaps[1].kind, 'part');
  assert.ok(Math.abs(overlaps[1].clearanceGap - 0.02) < 1e-9);
});

test('touching part and decal edges do not false-positive when clearance is 0', () => {
  const board = { min: [0, 0], max: [1, 1], y: 0, coordinateSpace: 'metres' };
  const parts = [{ id: 'block', bounds: [0.2, 0, 0.2, 0.4, 0.1, 0.4] }];
  const decals = [{ id: 'touching', bounds: [0.4, 0.2, 0.6, 0.4] }];

  assert.deepEqual(findSurfaceDecalOverlaps(parts, board, decals, { clearance: 0 }), []);
  const strict = findSurfaceDecalOverlaps(parts, board, decals, { clearance: 0.01 });
  assert.equal(strict.length, 1);
  assert.equal(strict[0].clearanceGap, 0);
});

test('supports UV coordinateSpace by default and oriented 3D quads (vertical and 45-degree tilted)', () => {
  const wallQuad = {
    origin: [0, 0, 0],
    uAxis: [2, 0, 0],
    vAxis: [0, 2, 0],
  };
  const wallParts = [{ id: 'socket', bounds: [0.9, 0.9, -0.05, 1.1, 1.1, 0.05] }];
  const wallDecals = [{ id: 'plate-title', bounds: { min: [0.4, 0.4], max: [0.6, 0.6] } }];
  const wallHits = findSurfaceDecalOverlaps(wallParts, wallQuad, wallDecals);
  assert.equal(wallHits.length, 1);
  assert.equal(wallHits[0].decalId, 'plate-title');
  assert.ok(Math.abs(wallHits[0].clearanceGap + 0.3) < 1e-6);

  const inverseSqrt2 = Math.SQRT1_2;
  const tiltedQuad = {
    origin: [0, 0, 0],
    uAxis: [1, 0, 0],
    vAxis: [0, inverseSqrt2, inverseSqrt2],
    coordinateSpace: 'metres',
  };
  const tiltedPart = [{ id: 'bracket', bounds: [0.4, 0.5 * inverseSqrt2 - 0.05, 0.5 * inverseSqrt2 - 0.05, 0.6, 0.5 * inverseSqrt2 + 0.05, 0.5 * inverseSqrt2 + 0.05] }];
  const tiltedDecals = [
    { id: 'on-bracket', bounds: [0.45, 0.48, 0.55, 0.52] },
    { id: 'far-away', bounds: [0.1, 0.1, 0.2, 0.2] },
  ];
  const tiltedHits = findSurfaceDecalOverlaps(tiltedPart, tiltedQuad, tiltedDecals);
  assert.equal(tiltedHits.length, 1);
  assert.equal(tiltedHits[0].decalId, 'on-bracket');
  assert.ok(tiltedHits[0].clearanceGap < 0);
});

test('detects 2D and 3D wire crossings, trace width, diagonal near-misses, and heightRange culling', () => {
  const board = { min: [0, 0], max: [1, 1], y: 0, coordinateSpace: 'metres' };
  const wires = [
    { id: 'trace-2d', points: [[0.1, 0.5], [0.9, 0.5]], width: 0.04 },
    { id: 'wire-3d-above', points: [[0.1, 0.5, 0.2], [0.9, 0.5, 0.2]], radius: 0.005 },
    { id: 'wire-diagonal', points: [[0.1, 0.2], [0.2, 0.1]] },
  ];
  const decals = [
    { id: 'crosses-trace', bounds: [0.4, 0.46, 0.6, 0.54] },
    { id: 'near-trace-width', bounds: [0.4, 0.525, 0.6, 0.56] },
    { id: 'near-diagonal', bounds: [0.16, 0.16, 0.22, 0.22] },
  ];

  const hits = findSurfaceDecalOverlaps([], board, decals, {
    wires,
    heightRange: [-0.02, 0.05],
    clearance: 0.02,
    checkBorder: false,
    checkDecals: false,
  });

  const keys = hits.map(hit => `${hit.decalId}:${hit.targetId}:${hit.kind}`);
  assert.ok(keys.includes('crosses-trace:trace-2d:wire'));
  assert.ok(keys.includes('near-trace-width:trace-2d:wire'));
  assert.ok(keys.includes('near-diagonal:wire-diagonal:wire'));
  assert.equal(hits.some(hit => hit.targetId === 'wire-3d-above'), false, 'high 3D wire culled by heightRange');
});

test('detects board border violations and respects checkBorder and ignore filters', () => {
  const board = { min: [0, 0], max: [1, 1], y: 0, coordinateSpace: 'metres' };
  const decals = [
    { id: 'overhang', bounds: [-0.02, 0.2, 0.2, 0.3] },
    { id: 'too-close-edge', bounds: [0.97, 0.4, 0.99, 0.6] },
  ];

  const borderHits = findSurfaceDecalOverlaps([], board, decals, { clearance: 0.03 });
  assert.equal(borderHits.length, 2);
  assert.equal(borderHits[0].decalId, 'overhang');
  assert.equal(borderHits[0].kind, 'border');
  assert.ok(Math.abs(borderHits[0].clearanceGap + 0.02) < 1e-9);
  assert.equal(borderHits[1].decalId, 'too-close-edge');
  assert.ok(Math.abs(borderHits[1].clearanceGap - 0.01) < 1e-9);

  assert.deepEqual(findSurfaceDecalOverlaps([], board, decals, { clearance: 0.03, checkBorder: false }), []);
  assert.deepEqual(findSurfaceDecalOverlaps([], board, decals, { clearance: 0.03, ignore: ['border'] }), []);
});

test('supports hollow frame decals so inner labels stay clear while edge crossings flag', () => {
  const board = { min: [0, 0], max: [1, 1], y: 0, coordinateSpace: 'metres' };
  const parts = [
    { id: 'inside-component', bounds: [0.3, 0, 0.3, 0.4, 0.05, 0.4] },
    { id: 'cross-frame', bounds: [0.75, 0, 0.4, 0.85, 0.05, 0.6] },
  ];
  const decals = [
    { id: 'silkscreen-frame', bounds: [0.2, 0.2, 0.8, 0.8], hollow: true, strokeWidth: 0.01 },
    { id: 'inner-title', bounds: [0.45, 0.45, 0.6, 0.55] },
    { id: 'outer-cross', bounds: [0.15, 0.45, 0.25, 0.55] },
  ];

  const hits = findSurfaceDecalOverlaps(parts, board, decals, {
    ignore: (id, kind) => kind === 'part' && id === 'outside-ignored',
    checkBorder: false,
  });

  const pairs = hits.map(hit => `${hit.decalId}->${hit.targetId}`);
  assert.equal(pairs.includes('silkscreen-frame->inside-component'), false, 'part strictly inside hollow frame does not overlap');
  assert.equal(pairs.includes('inner-title->silkscreen-frame'), false, 'label inside hollow frame does not overlap');
  assert.ok(pairs.includes('silkscreen-frame->cross-frame'), 'part crossing frame stroke overlaps');
  assert.ok(pairs.includes('outer-cross->silkscreen-frame') || pairs.includes('silkscreen-frame->outer-cross'), 'decal crossing hollow frame overlaps');
});

test('detects sibling solid decal overlaps once, ignores Set/Array ids, and applies deterministic sort + maxOverlaps', () => {
  const board = { min: [0, 0], max: [1, 1], y: 0, coordinateSpace: 'metres' };
  const decals = [
    { id: 'alpha', bounds: [0.2, 0.2, 0.5, 0.5] },
    { id: 'beta', bounds: [0.4, 0.4, 0.7, 0.7] },
    { id: 'gamma', bounds: [0.45, 0.45, 0.6, 0.6] },
  ];

  const hits = findSurfaceDecalOverlaps([], board, decals, { checkBorder: false });
  assert.equal(hits.length, 3);
  assert.ok(hits.every(hit => hit.kind === 'decal'));
  assert.ok(hits[0].clearanceGap <= hits[1].clearanceGap && hits[1].clearanceGap <= hits[2].clearanceGap);

  const limited = findSurfaceDecalOverlaps([], board, decals, { checkBorder: false, maxOverlaps: 1 });
  assert.equal(limited.length, 1);

  const ignored = findSurfaceDecalOverlaps([], board, decals, { checkBorder: false, ignore: new Set(['gamma']) });
  assert.equal(ignored.length, 1);
  assert.deepEqual(findSurfaceDecalOverlaps([], board, decals, { checkBorder: false, checkDecals: false }), []);
});

test('rejects invalid inputs with explicit actionable errors', () => {
  const validQuad = { min: [0, 0], max: [1, 1] };
  assert.throws(() => findSurfaceDecalOverlaps('bad', validQuad, []), /parts must be an Array/);
  assert.throws(() => findSurfaceDecalOverlaps([], null, []), /surfaceQuad must be an object/);
  assert.throws(() => findSurfaceDecalOverlaps([], { origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0.5, 0.5, 0] }, []), /orthogonal/);
  assert.throws(() => findSurfaceDecalOverlaps([], { min: [1, 0], max: [0, 1] }, []), /strictly greater/);
  assert.throws(() => findSurfaceDecalOverlaps([], validQuad, [], { bogus: 1 }), /Unsupported findSurfaceDecalOverlaps option/);
  assert.throws(() => findSurfaceDecalOverlaps([], validQuad, [], { clearance: -0.1 }), /clearance/);
  assert.throws(() => findSurfaceDecalOverlaps([], validQuad, [], { heightRange: [2, 1] }), /heightRange/);
  assert.throws(() => findSurfaceDecalOverlaps([], validQuad, [{ id: '', bounds: [0, 0, 0.1, 0.1] }]), /non-empty string/);
  assert.throws(() => findSurfaceDecalOverlaps([], validQuad, [{ id: 'a', bounds: [0.5, 0, 0.1, 0.1] }]), /must not exceed maximum/);
  assert.throws(() => findSurfaceDecalOverlaps([], validQuad, [], { wires: [{ id: 'w', points: [[0, 0], [1, 1]], radius: 0.1, width: 0.2 }] }), /both radius and width/);
});
