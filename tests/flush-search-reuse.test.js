import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { flushOrderOf } from '../src/depth-layer.js';
import { findFlushPairs } from '../src/flush-search.js';
import { forgetSearch } from '../src/flush-search-reuse.js';
import { markLiveGeometry } from '../src/live-geometry.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const GRID_SIZE = 40;
const PATCH_SIZE = 4;

function movedTo(x, y, z) {
  const matrix = [...IDENTITY];
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return matrix;
}

// A flat sheet of quads on y = 0, so two sheets laid one over the other fight.
function sheetGeometry(size) {
  const positions = [];
  const indices = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const base = positions.length / 3;
      positions.push(column, 0, row, column, 0, row + 1, column + 1, 0, row + 1, column + 1, 0, row);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const sheet = sheetGeometry(GRID_SIZE);
const patch = sheetGeometry(PATCH_SIZE);

function sheetPart(name, matrix, geometry = sheet) {
  return { name, geometry, matrix: new Float32Array(matrix), material: {} };
}

function coldSearch(parts) {
  forgetSearch();
  return findFlushPairs(parts);
}

function pairsOf(result) {
  return result.pairs.map(pair => `${pair.first},${pair.second},${pair.gap},${pair.area},${pair.flush},${pair.opposite}`);
}

test('adding a part searches only the triangles near it and finds the pairs a cold search finds', () => {
  const base = sheetPart('base', IDENTITY);
  const lower = sheetPart('lower', movedTo(0, 0.001, 0));
  forgetSearch();
  const first = findFlushPairs([base, lower]);
  assert.ok(first.pairs.length > 0, 'two sheets one millimetre apart fight');
  assert.equal(first.searched, first.count, 'the first search is cold and looks at everything');

  const far = sheetPart('far', movedTo(GRID_SIZE / 2, 0.0005, GRID_SIZE / 2), patch);
  const edited = [base, lower, far];
  const incremental = findFlushPairs(edited);
  assert.ok(incremental.searched < incremental.count / 2, `searched ${incremental.searched} of ${incremental.count} triangles`);
  assert.deepEqual(pairsOf(incremental), pairsOf(coldSearch(edited)));
});

test('a part added before the others and one that grows the scene still match a cold search', () => {
  const base = sheetPart('base', IDENTITY);
  const lower = sheetPart('lower', movedTo(0, 0.001, 0));
  forgetSearch();
  findFlushPairs([base, lower]);

  const first = sheetPart('first', movedTo(5, 0.0007, 5));
  const withFirst = [first, base, lower];
  assert.deepEqual(pairsOf(findFlushPairs(withFirst)), pairsOf(coldSearch(withFirst)));

  const distant = sheetPart('distant', movedTo(900, 0, 900));
  const grown = [first, base, lower, distant];
  assert.deepEqual(pairsOf(findFlushPairs(grown)), pairsOf(coldSearch(grown)));
});

test('removing and moving parts match a cold search', () => {
  const base = sheetPart('base', IDENTITY);
  const lower = sheetPart('lower', movedTo(0, 0.001, 0));
  const extra = sheetPart('extra', movedTo(3, 0.0004, 3));
  forgetSearch();
  findFlushPairs([base, lower, extra]);

  const withoutLower = [base, extra];
  assert.deepEqual(pairsOf(findFlushPairs(withoutLower)), pairsOf(coldSearch(withoutLower)));

  forgetSearch();
  findFlushPairs([base, lower, extra]);
  const moved = [base, lower, sheetPart('extra', movedTo(3, 0.0009, 4))];
  const incremental = findFlushPairs(moved);
  assert.deepEqual(pairsOf(incremental), pairsOf(coldSearch(moved)));
});

test('a live geometry rewritten in place is searched again, not remembered by its object', () => {
  const base = sheetPart('base', IDENTITY);
  const liveGeometry = markLiveGeometry({ positions: Float32Array.from(patch.positions), indices: patch.indices });
  const cloth = sheetPart('cloth', movedTo(1, 0.002, 1), liveGeometry);
  forgetSearch();
  const before = findFlushPairs([base, cloth]);
  for (let offset = 1; offset < liveGeometry.positions.length; offset += 3) liveGeometry.positions[offset] = 0.0007;
  const warm = findFlushPairs([base, cloth]);
  assert.notEqual(pairsOf(warm).join(), pairsOf(before).join(), 'the pairs follow the new positions');
  assert.deepEqual(pairsOf(warm), pairsOf(coldSearch([base, cloth])));
});

test('two scenes searched in turn each match a cold search', () => {
  const sceneA = [sheetPart('base', IDENTITY), sheetPart('lower', movedTo(0, 0.001, 0))];
  const sceneB = [sheetPart('base', IDENTITY), sheetPart('lower', movedTo(0, 0.002, 0)), sheetPart('patch', movedTo(2, 0.0003, 2), patch)];
  forgetSearch();
  findFlushPairs(sceneA);
  assert.deepEqual(pairsOf(findFlushPairs(sceneB)), pairsOf(coldSearch(sceneB)));
  findFlushPairs(sceneB);
  assert.deepEqual(pairsOf(findFlushPairs(sceneA)), pairsOf(coldSearch(sceneA)));
});

test('a search with other budgets does not build on a remembered one', () => {
  const parts = [sheetPart('base', IDENTITY), sheetPart('lower', movedTo(0, 0.001, 0))];
  forgetSearch();
  findFlushPairs(parts);
  const tight = findFlushPairs(parts, { pairBudget: 10 });
  assert.equal(tight.truncated, true);
  assert.equal(tight.pairs.length, 10);
});

function summaryOf(result) {
  return JSON.stringify([pairsOf(result), result.truncated, result.truncatedAt ?? null, result.unchecked.map(part => part.name)]);
}

test('a small testedPairLimit truncates a warm search exactly where a cold one truncates', () => {
  const base = sheetPart('base', IDENTITY, patch);
  const lower = sheetPart('lower', movedTo(0, 0.001, 0), patch);
  forgetSearch();
  const probe = findFlushPairs([base, lower]);
  const limit = probe.testedPairs + 2;
  const options = { testedPairLimit: limit };
  forgetSearch();
  findFlushPairs([base, lower], options);
  const edited = [base, lower, sheetPart('third', movedTo(0, 0.0005, 0), sheetGeometry(1))];
  const warm = findFlushPairs(edited, options);
  forgetSearch();
  const cold = findFlushPairs(edited, options);
  assert.equal(cold.truncated, true, 'the limit is small enough that the cold search stops');
  assert.equal(summaryOf(warm), summaryOf(cold));
});

test('flipping doubleSided between searches matches a cold search for a pair that faces opposite ways', () => {
  const faceDown = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const top = sheetPart('top', IDENTITY, patch);
  const under = sheetPart('under', faceDown, patch);
  forgetSearch();
  const single = findFlushPairs([top, under]);
  assert.equal(single.pairs.length, 0, 'a back-to-back pair of single sided faces is culled');
  under.material.doubleSided = true;
  const warm = findFlushPairs([top, under]);
  assert.ok(warm.pairs.length > 0);
  assert.equal(summaryOf(warm), summaryOf(coldSearch([top, under])));
  under.material.doubleSided = false;
  assert.equal(summaryOf(findFlushPairs([top, under])), summaryOf(coldSearch([top, under])));
});

test('random edits of a few parts always match a cold search', () => {
  let seed = 20261121;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const faceDown = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const makePart = index => {
    const matrix = random() < 0.3 ? faceDown : IDENTITY;
    const placed = [...matrix];
    placed[12] = Math.floor(random() * 3);
    placed[13] = Math.floor(random() * 3) * 0.001;
    placed[14] = Math.floor(random() * 3);
    return sheetPart(`part-${index}`, placed, patch);
  };
  let parts = [makePart(0), makePart(1), makePart(2)];
  const scenes = [];
  const warmResults = [];
  forgetSearch();
  for (let step = 0; step < 24; step++) {
    const choice = Math.floor(random() * 5);
    if (choice === 0 || parts.length < 2) parts = [...parts, makePart(100 + step)];
    else if (choice === 1) parts = parts.filter((part, index) => index !== Math.floor(random() * parts.length));
    else if (choice === 2) parts = parts.map((part, index) => (index === 0 ? makePart(200 + step) : part));
    else if (choice === 3) parts = [...parts].reverse();
    else parts[Math.floor(random() * parts.length)].material.doubleSided = random() < 0.5;
    scenes.push(parts.map(part => ({ ...part, material: { ...part.material } })));
    warmResults.push(summaryOf(findFlushPairs(parts)));
  }
  scenes.forEach((scene, step) => {
    assert.equal(warmResults[step], summaryOf(coldSearch(scene)), `step ${step}`);
  });
});

test('an unchanged scene is not searched again', () => {
  const parts = [sheetPart('base', IDENTITY), sheetPart('lower', movedTo(0, 0.001, 0))];
  forgetSearch();
  findFlushPairs(parts);
  assert.equal(findFlushPairs(parts).searched, 0);
});

test('a scene edit that adds a node leaves the draw orders of the untouched parts as they were', () => {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box' }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'floor', geometry: 'slab', material: 'paint', scale: [10, 0.2, 10] },
      { id: 'rug', geometry: 'slab', material: 'paint', translation: [0, 0.0005, 0], scale: [4, 0.2, 4] },
    ],
  };
  forgetSearch();
  const scene = createAgentScene(recipe);
  const before = scene.parts.map(part => [part, flushOrderOf(part)]);
  assert.ok(before.some(([, order]) => order), 'the rug fights the floor, so a part has an order');
  scene.apply([{ type: 'add-node', node: { id: 'box', geometry: 'slab', material: 'paint', translation: [2, 3, 2] } }], { expectedRevision: scene.revision });
  for (const [part, order] of before) {
    assert.equal(flushOrderOf(part), order, `${part.name} keeps its order object, so the renderer keeps its batch`);
  }
});
