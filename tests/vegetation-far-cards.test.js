import test from 'node:test';
import assert from 'node:assert/strict';
import { createTree } from '../src/vegetation.js';
import { createLeafPixels } from '../src/vegetation-textures.js';
import { crownSolidity } from '../scripts/tree-proof-lib.mjs';

// The far levels keep each species' own leaf card and the width of level 1 (#3051).
const SEEDS = [1, 4];
const CARD_PRESETS = ['oak', 'ash', 'aspen', 'birch', 'pine', 'palm'];
const WIDTH_PRESETS = ['oak', 'aspen', 'birch', 'pine', 'palm'];
const WIDTH_TOLERANCE = 1.16;
const SOLIDITY_STEP = 0.1;
const FOLIAGE_PART = 1;

function foliageWidth(tree, level) {
  const { positions } = tree.levels[level].parts[FOLIAGE_PART].geometry;
  const minimum = [Infinity, Infinity];
  const maximum = [-Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    [0, 2].forEach((axis, slot) => {
      minimum[slot] = Math.min(minimum[slot], positions[index + axis]);
      maximum[slot] = Math.max(maximum[slot], positions[index + axis]);
    });
  }
  return Math.max(maximum[0] - minimum[0], maximum[1] - minimum[1]);
}

test('far levels draw the species leaf card, not the generic clump card', () => {
  for (const preset of CARD_PRESETS) {
    const tree = createTree({ preset }, 4);
    for (const level of [2, 3]) {
      const part = tree.levels[level].parts[FOLIAGE_PART];
      // Compare by identity: a failing assert.equal on two materials prints a diff of their 64 KB texture pixels, which
      // grew one test run past 27 GB.
      assert.ok(part.material === tree.levels[1].parts[FOLIAGE_PART].material, `${preset} level ${level} must share the leaf card of level 1`);
      assert.ok(part.material !== tree.materials.crown, `${preset} level ${level} drew the clump card`);
      assert.ok(part.geometry.indices.length > 0);
    }
  }
});

test('far levels use fewer, bigger cards than level 1', () => {
  const tree = createTree({ preset: 'palm' }, 4);
  const triangles = level => tree.levels[level].parts[FOLIAGE_PART].geometry.indices.length / 3;
  assert.ok(triangles(2) < triangles(1) && triangles(3) < triangles(1), 'each far level has fewer foliage triangles than level 1');
  assert.ok(triangles(3) >= 100, 'a far palm keeps a card for each of its fronds, not a blob');
});

test('far crowns keep the width of level 1', () => {
  for (const preset of WIDTH_PRESETS) {
    for (const seed of SEEDS) {
      const tree = createTree({ preset }, seed);
      const nearWidth = foliageWidth(tree, 1);
      for (const level of [2, 3]) {
        const ratio = foliageWidth(tree, level) / nearWidth;
        assert.ok(ratio <= WIDTH_TOLERANCE && ratio >= 1 / WIDTH_TOLERANCE, `${preset} seed ${seed} level ${level} is ${ratio.toFixed(2)} times as wide as level 1`);
      }
    }
  }
});

test('crown solidity changes by at most 0.1 across each level switch', () => {
  for (const preset of ['oak', 'birch', 'palm', 'pine']) {
    const tree = createTree({ preset }, 4);
    const solidity = [0, 1, 2, 3].map(level => crownSolidity(tree, level));
    for (let level = 1; level < solidity.length; level++) {
      const step = Math.abs(solidity[level] - solidity[level - 1]);
      assert.ok(step <= SOLIDITY_STEP, `${preset} solidity moves ${step.toFixed(2)} from level ${level - 1} to ${level}`);
    }
  }
});

test('a bush and a tree of mesh leaves keep their crown clumps at the far levels', () => {
  const bush = createTree('bush', 4);
  assert.deepEqual([2, 3].map(level => bush.levels[level].parts[FOLIAGE_PART].geometry.indices.length / 3), [126, 126]);
  for (const level of [2, 3]) assert.equal(bush.levels[level].parts[FOLIAGE_PART].material, bush.materials.crown);
  const mesh = createTree({ preset: 'oak', leaves: 'mesh' }, 4);
  // 29 blobs of 80 triangles each at both far levels. The count follows the oak's crown cells, so it moved from 26 when the oak forked
  // (#3041); the pin moves again with the oak's habit.
  assert.deepEqual([2, 3].map(level => mesh.levels[level].parts[FOLIAGE_PART].geometry.indices.length / 3), [3360, 3360]);
});

// Cards of a leaf-card level, base row first. A plain species and the pine draw three rows of two vertices (six); a twig crown draws
// a flat spray card of two rows (four vertices, two triangles, #3057).
const THREE_ROW_VERTICES = 6;
const SPRAY_VERTICES = 4;
const verticesPerCard = preset => (preset === 'pine' ? THREE_ROW_VERTICES : SPRAY_VERTICES);

function cardsOf(tree, level, cardVertices = THREE_ROW_VERTICES) {
  const { positions } = tree.levels[level].parts[FOLIAGE_PART].geometry;
  const cards = [];
  for (let first = 0; first + cardVertices * 3 <= positions.length; first += cardVertices * 3) {
    const vertex = index => [0, 1, 2].map(axis => positions[first + index * 3 + axis]);
    const baseLeft = vertex(0);
    const baseRight = vertex(1);
    const tipLeft = vertex(cardVertices - 2);
    const tipRight = vertex(cardVertices - 1);
    const base = baseLeft.map((value, axis) => (value + baseRight[axis]) / 2);
    const tip = tipLeft.map((value, axis) => (value + tipRight[axis]) / 2);
    const along = tip.map((value, axis) => value - base[axis]);
    const length = Math.hypot(...along);
    const width = Math.hypot(...baseLeft.map((value, axis) => value - baseRight[axis]));
    cards.push({ base, centre: base.map((value, axis) => (value + tip[axis]) / 2), length, width, slope: along[1] / length });
  }
  return cards;
}

const meanOf = (cards, property) => cards.reduce((sum, card) => sum + card[property], 0) / cards.length;

test('far cards stand alone: no two share a base, so none reads as a cross', () => {
  const MINIMUM_BASE_GAP = 0.01;
  const tree = createTree('conifer', 4);
  for (const level of [2, 3]) {
    const cards = cardsOf(tree, level);
    for (let first = 0; first < cards.length; first++) {
      for (let second = first + 1; second < cards.length; second++) {
        const gap = Math.hypot(...cards[first].base.map((value, axis) => value - cards[second].base[axis]));
        assert.ok(gap > MINIMUM_BASE_GAP, `conifer level ${level} has two cards on one base`);
      }
    }
  }
});

test('the centre of a far crown holds at least the share of cards it holds at level 1', () => {
  for (const preset of ['oak', 'birch', 'ash', 'pine']) {
    for (const seed of SEEDS) {
      const tree = createTree({ preset }, seed);
      const { positions } = tree.levels[1].parts[FOLIAGE_PART].geometry;
      let reach = 0;
      for (let index = 0; index < positions.length; index += 3) reach = Math.max(reach, Math.hypot(positions[index], positions[index + 2]));
      const innerShare = level => {
        const cards = cardsOf(tree, level, verticesPerCard(preset));
        return cards.filter(card => Math.hypot(card.centre[0], card.centre[2]) < reach * 0.3).length / cards.length;
      };
      for (const level of [2, 3]) {
        assert.ok(innerShare(level) >= innerShare(1), `${preset} seed ${seed} level ${level} leaves the crown centre bare`);
      }
    }
  }
});

// One tree's mean slope moves by about 0.05 with the seed, because a far level has a tenth of the cards, so the limit holds for the mean of
// several seeds, which is what a forest of that species shows.
test('far cards droop like level 1 on average over eight seeds', () => {
  const SLOPE_TOLERANCE = 0.05;
  const SLOPE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const preset of ['oak', 'ash', 'aspen', 'birch', 'pine']) {
    const differences = { 2: 0, 3: 0 };
    for (const seed of SLOPE_SEEDS) {
      const tree = createTree({ preset }, seed);
      const nearSlope = meanOf(cardsOf(tree, 1, verticesPerCard(preset)), 'slope');
      for (const level of [2, 3]) differences[level] += (meanOf(cardsOf(tree, level, verticesPerCard(preset)), 'slope') - nearSlope) / SLOPE_SEEDS.length;
    }
    for (const level of [2, 3]) {
      assert.ok(Math.abs(differences[level]) <= SLOPE_TOLERANCE, `${preset} level ${level} cards point ${differences[level].toFixed(3)} off level 1 on average`);
    }
  }
});

test('the pine cluster card is 256 px, deterministic and lush without forming a solid disk', () => {
  const pine = createLeafPixels('pine', [56, 102, 48], 1);
  assert.equal(pine.width, 256);
  assert.equal(pine.height, 256);
  assert.ok(Buffer.from(createLeafPixels('pine', [56, 102, 48], 1).data).equals(Buffer.from(pine.data)), 'pine texture is deterministic');
  let opaque = 0;
  for (let offset = 3; offset < pine.data.length; offset += 4) {
    if (pine.data[offset] >= 128) opaque++;
  }
  const share = opaque / (pine.width * pine.height);
  assert.ok(share >= 0.4 && share <= 0.75, `pine opaque share ${share.toFixed(3)} out of [0.40, 0.75]`);
});

test('a palm draws curved feathery 256 px frond ribbons cleanly across all four levels', () => {
  const frond = createLeafPixels('frond', [66, 118, 40], 1);
  assert.equal(frond.width, 256);
  assert.equal(frond.height, 256);
  assert.ok(Buffer.from(createLeafPixels('frond', [66, 118, 40], 1).data).equals(Buffer.from(frond.data)), 'frond texture is deterministic');
  let opaque = 0;
  for (let offset = 3; offset < frond.data.length; offset += 4) {
    if (frond.data[offset] >= 128) opaque++;
  }
  const share = opaque / (frond.width * frond.height);
  assert.ok(share >= 0.3 && share <= 0.75, `frond opaque share ${share.toFixed(3)} must read as feathery leaflets`);

  const palm = createTree({ preset: 'palm' }, 4);
  const foliageTris = palm.levels.map(level => level.parts[FOLIAGE_PART].geometry.indices.length / 3);
  const barkTris = palm.levels.map(level => level.parts[0].geometry.indices.length / 3);
  const totalTris = palm.levels.map(level => level.triangles);
  for (let level = 0; level < 3; level++) {
    assert.ok(foliageTris[level] > foliageTris[level + 1], `palm foliage tris did not fall: ${foliageTris}`);
    assert.ok(totalTris[level] > totalTris[level + 1], `palm total tris did not fall: ${totalTris}`);
    assert.ok(barkTris[level + 1] <= barkTris[level], `palm bark tris popped up: ${barkTris}`);
  }
  assert.ok(foliageTris[3] >= 100, `palm level 3 keeps full frond ribbons (${foliageTris[3]} tris)`);
  for (let level = 0; level < 4; level++) {
    assert.equal(palm.levels[level].parts[FOLIAGE_PART].material, palm.materials.foliage);
  }
  for (const seed of SEEDS) {
    const seeded = createTree({ preset: 'palm' }, seed);
    const nearWidth = foliageWidth(seeded, 1);
    for (const level of [2, 3]) {
      const ratio = foliageWidth(seeded, level) / nearWidth;
      assert.ok(ratio <= 1.08 && ratio >= 1 / 1.08, `palm seed ${seed} level ${level} width ratio ${ratio.toFixed(3)}`);
    }
  }
  const solidity = [0, 1, 2, 3].map(level => crownSolidity(palm, level));
  for (let level = 0; level < solidity.length; level++) {
    assert.ok(solidity[level] >= 0.55, `palm level ${level} solidity ${solidity[level].toFixed(2)} is too sparse`);
    if (level > 0) assert.ok(Math.abs(solidity[level] - solidity[level - 1]) <= 0.08, `palm solidity jumped ${solidity[level - 1].toFixed(2)} -> ${solidity[level].toFixed(2)}`);
  }
});

test('the pine keeps its fanned pair at far levels, two cards to a site, so none stands edge-on', () => {
  const tree = createTree({ preset: 'pine' }, 4);
  for (const level of [2, 3]) {
    const cards = cardsOf(tree, level);
    assert.ok(cards.length > 0 && cards.length % 2 === 0, `pine level ${level} has ${cards.length} cards, not whole pairs`);
    for (let index = 0; index < cards.length; index += 2) {
      const gap = Math.hypot(...cards[index].base.map((value, axis) => value - cards[index + 1].base[axis]));
      assert.ok(gap < 1e-6, `pine level ${level} card ${index} is not paired with the next`);
    }
  }
});

// A twig crown draws a flat spray card (two triangles) at every level. Its near level crosses a pair on each site; far away a crossed
// pair reads as a plus sign, so a far level draws one card to a site and keeps the leaf area of level 1 with a larger, rarer card.
test('a twig crown draws one spray card to a site at the far levels and keeps the leaf area of level 1', () => {
  const AREA_TOLERANCE = 0.25;
  const cardArea = card => card.length * card.width;
  for (const preset of ['oak', 'birch', 'ash', 'aspen']) {
    const tree = createTree({ preset }, 4);
    const near = cardsOf(tree, 1, SPRAY_VERTICES);
    const nearArea = near.reduce((sum, card) => sum + cardArea(card), 0);
    for (const level of [2, 3]) {
      const geometry = tree.levels[level].parts[FOLIAGE_PART].geometry;
      assert.equal(geometry.indices.length / 3, 2 * (geometry.positions.length / 3 / SPRAY_VERTICES), `${preset} level ${level} is not made of two-triangle spray cards`);
      const cards = cardsOf(tree, level, SPRAY_VERTICES);
      assert.ok(cards.length > 0 && cards.length < near.length, `${preset} level ${level} has ${cards.length} cards against ${near.length} at level 1`);
      const bases = new Set(cards.map(card => card.base.map(value => value.toFixed(5)).join(',')));
      assert.equal(bases.size, cards.length, `${preset} level ${level} has two cards on one base`);
      const area = cards.reduce((sum, card) => sum + cardArea(card), 0);
      assert.ok(Math.abs(area / nearArea - 1) <= AREA_TOLERANCE, `${preset} level ${level} spray area is ${(area / nearArea).toFixed(2)} times that of level 1`);
    }
  }
});
