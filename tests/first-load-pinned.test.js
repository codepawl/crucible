import test from 'node:test';
import assert from 'node:assert/strict';
import { findFlushPairs } from '../src/flush-search.js';
import { forgetSearch } from '../src/flush-search-reuse.js';
import { generateTangents } from '../src/gltf-tangents.js';
import { createTrianglePairSet } from '../src/triangle-pair-set.js';
import { flushSearchDigests, tangentDigests } from './support/first-load-fixtures.mjs';

// Recorded by running flushSearchDigests and tangentDigests with the functions of origin/main at 757d822da (before the first-load
// speed-up of #2842), so these pin that the faster code returns what the old code returned, bit for bit.
const FLUSH_SEARCH_ON_MAIN = {
  'all parts': { digest: '82479a986c4cf2fda33a6931772b0e250f7af648af9ec11c3607b03641ee7626', pairs: 2842, tested: 6242 },
  'sheets only': { digest: 'a17b7fb28f5d185d99d0576ced4d2ca90b4255536dd5cd00ccdd36ba51c1471d', pairs: 236, tested: 690 },
  'a pair budget of 5': { digest: '1b811be0387207f58e9abc4b03a4c4492fc763c80c1ee837e7d6def26e5518c4', pairs: 5, tested: 6242 },
  'a tested-pair limit of 40': { digest: '16af01847a7486b87875dd3d84390a48ef0c22f2637e9db950655a568f3c8524', pairs: 16, tested: 40 },
  'a triangle budget that leaves parts out': { digest: 'f5f7cb1d201a6f9ba32b2f969724679936673d44003621b27f24641dc585e557', pairs: 674, tested: 1730 },
  'a search after a part moved': { digest: '829bad837a3d20249559fae073953c085dc19efaaa0d3849f9fb6ca77426d024', pairs: 2842, tested: 6467 },
};

const TANGENTS_ON_MAIN = {
  sphere: '0ab8b895b4ab6b7d9c7f2c991efcdfd1d3fe61fd941159146bde7dcbe33e8fdd',
  quad: 'b0e6bccd2893dafb4bc09edbe7d241e358179dad2d9c63dc8cf2bb13ed4e9d89',
  sphereVertices: 475,
};

test('the flush search returns the pairs, gaps, areas and counts it returned before the first-load speed-up', () => {
  const searches = flushSearchDigests({ findFlushPairs, forgetSearch });
  for (const [name, expected] of Object.entries(FLUSH_SEARCH_ON_MAIN)) {
    assert.deepEqual(searches[name], expected, `search "${name}" changed`);
  }
  assert.deepEqual(Object.keys(searches), Object.keys(FLUSH_SEARCH_ON_MAIN));
});

test('tangents are the bytes they were before the first-load speed-up, degenerate corners included', () => {
  assert.deepEqual(tangentDigests(generateTangents), TANGENTS_ON_MAIN);
});

test('the pair set answers like a Set of pairs, also past the sizes where it grows', () => {
  const pairs = createTrianglePairSet();
  const reference = new Set();
  let seed = 7;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let step = 0; step < 30000; step++) {
    const first = next() % 3000;
    const second = next() % 3000;
    assert.equal(pairs.has(first, second), reference.has(`${first},${second}`));
    assert.equal(pairs.add(first, second), !reference.has(`${first},${second}`));
    reference.add(`${first},${second}`);
    assert.equal(pairs.size, reference.size);
  }
  assert.ok(reference.size > 4096, 'the set had to grow at least once');
});

test('the pair set tells (a, b) from (b, a) and keeps the largest ids', () => {
  const pairs = createTrianglePairSet();
  assert.equal(pairs.add(1, 2), true);
  assert.equal(pairs.has(2, 1), false);
  assert.equal(pairs.add(0xfffffffe, 0xfffffffe), true);
  assert.equal(pairs.has(0xfffffffe, 0xfffffffe), true);
  assert.equal(pairs.add(1, 2), false);
  assert.equal(pairs.size, 2);
});
