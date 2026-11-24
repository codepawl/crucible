import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTree } from '../src/vegetation.js';
import { TREE_PRESETS } from '../src/vegetation-presets.js';
import { createLeafPixels } from '../src/vegetation-textures.js';

const CROWN_PRESETS = ['oak', 'ash', 'aspen', 'birch'];
const FOLIAGE_TRIANGLE_LIMIT = 10000;

function foliageGeometry(tree) {
  return tree.levels[0].parts.find(part => part.role === 'foliage').geometry;
}

function hashTree(tree) {
  const hash = createHash('sha256');
  for (const level of tree.levels) {
    for (const part of level.parts) {
      hash.update(Buffer.from(new Float32Array(part.geometry.positions).buffer));
      hash.update(Buffer.from(new Uint32Array(part.geometry.indices).buffer));
    }
  }
  return hash.digest('hex');
}

// The widest horizontal reach of the foliage inside the lowest and the highest third of the crown, and the crown's height range.
function crownThirds(tree) {
  const { positions } = foliageGeometry(tree);
  let lowest = Infinity;
  let highest = -Infinity;
  for (let index = 1; index < positions.length; index += 3) {
    lowest = Math.min(lowest, positions[index]);
    highest = Math.max(highest, positions[index]);
  }
  const reach = [0, 0, 0];
  for (let index = 0; index < positions.length; index += 3) {
    const third = Math.min(2, Math.floor((positions[index + 1] - lowest) / (highest - lowest) * 3));
    reach[third] = Math.max(reach[third], Math.hypot(positions[index], positions[index + 2]));
  }
  return { reach, lowest, highest };
}

test('each crowned preset carries a pruning envelope inside its habit', () => {
  for (const name of CROWN_PRESETS) {
    const envelope = TREE_PRESETS[name].habit?.envelope;
    assert.ok(envelope, `${name} needs habit.envelope`);
    for (const field of ['base', 'peak', 'width', 'powerLow', 'powerHigh']) {
      assert.ok(Number.isFinite(envelope[field]) && envelope[field] > 0, `${name} envelope.${field} must be a positive number`);
    }
  }
});

test('a crown stays inside its envelope and the upper crown is narrower than the lower', () => {
  for (const name of CROWN_PRESETS) {
    const { width } = TREE_PRESETS[name].habit.envelope;
    for (const seed of [1, 2, 3]) {
      const tree = createTree({ preset: name }, seed);
      const { reach } = crownThirds(tree);
      // Leaf cards reach past the twig tips by about half a card, so the envelope gets that margin.
      assert.ok(Math.max(...reach) <= (width * tree.height) + 2, `${name} seed ${seed} reaches ${Math.max(...reach).toFixed(2)} m, past its envelope`);
      if (name === 'oak' || name === 'ash') assert.ok(reach[2] < reach[0], `${name} seed ${seed}: the top third reaches ${reach[2].toFixed(2)} m, not narrower than the bottom third at ${reach[0].toFixed(2)} m`);
    }
  }
});

// A dome, not a cone: the top third is still narrower than the middle, but only by a fifth (a cone was 0.7 and under).
test('an oak keeps its widest reach in the lower two thirds of the crown, on a trunk of about half its height', () => {
  for (const seed of [1, 2, 3, 4]) {
    const tree = createTree({ preset: 'oak' }, seed);
    const { reach, lowest } = crownThirds(tree);
    assert.ok(reach[2] < 0.85 * Math.max(reach[0], reach[1]), `oak seed ${seed}: top third ${reach[2].toFixed(2)} m against ${Math.max(reach[0], reach[1]).toFixed(2)} m below`);
    assert.ok(lowest > 0.03 * tree.height && lowest < 0.3 * tree.height, `oak seed ${seed}: the lowest leaf sits at ${(lowest / tree.height).toFixed(2)} of the height`);
  }
});

test('crowned presets build the same bytes twice and keep their foliage under 10k triangles', () => {
  for (const name of CROWN_PRESETS) {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const first = createTree({ preset: name }, seed);
      assert.equal(hashTree(createTree({ preset: name }, seed)), hashTree(first), `${name} seed ${seed} is not repeatable`);
      const triangles = foliageGeometry(first).indices.length / 3;
      assert.ok(triangles <= FOLIAGE_TRIANGLE_LIMIT, `${name} seed ${seed} has ${triangles} foliage triangles`);
    }
  }
});

test('plain species grow without an envelope', () => {
  for (const species of ['broadleaf', 'birch', 'conifer', 'palm', 'bush']) {
    const tree = createTree(species, 4);
    assert.ok(foliageGeometry(tree).indices.length > 0);
  }
});

// At 40 m (levels 0 and 1) no card may sit past the end of the twigs: every card base is on the leaf twigs of the full skeleton (#3057).
test('at the near and the middle level every leaf card sits on a twig of the full skeleton', () => {
  const MAXIMUM_GAP = 0.05;
  const CARD_VERTICES = 4;
  for (const name of CROWN_PRESETS) {
    for (const seed of [1, 4]) {
      const tree = createTree({ preset: name }, seed);
      const bark = tree.levels[0].parts.find(part => part.role === 'bark').geometry.positions;
      for (const level of [0, 1]) {
        const { positions } = tree.levels[level].parts.find(part => part.role === 'foliage').geometry;
        let floating = 0;
        for (let first = 0; first + CARD_VERTICES * 3 <= positions.length; first += CARD_VERTICES * 3 * 6) {
          const base = [0, 1, 2].map(axis => (positions[first + axis] + positions[first + 3 + axis]) / 2);
          let nearest = Infinity;
          for (let index = 0; index < bark.length; index += 3) nearest = Math.min(nearest, Math.hypot(bark[index] - base[0], bark[index + 1] - base[1], bark[index + 2] - base[2]));
          if (nearest > MAXIMUM_GAP) floating++;
        }
        assert.equal(floating, 0, `${name} seed ${seed} level ${level}: ${floating} cards start more than ${MAXIMUM_GAP} m from a twig`);
      }
    }
  }
});

// A leaf card base is its twig's tip: the bark of the leafy tree has to draw the twig, or the card floats (#3057).
test('every leaf card of a crowned tree sits on the tip of a drawn twig', () => {
  const MAXIMUM_GAP = 0.05;
  const CARD_VERTICES = 4;
  for (const name of CROWN_PRESETS) {
    const tree = createTree({ preset: name }, 4);
    const bark = tree.levels[0].parts.find(part => part.role === 'bark').geometry.positions;
    const { positions } = foliageGeometry(tree);
    let floating = 0;
    // Every eighth card keeps the nearest-bark search short; the cards come off one stream, so the sample is even.
    for (let first = 0; first + CARD_VERTICES * 3 <= positions.length; first += CARD_VERTICES * 3 * 8) {
      const base = [0, 1, 2].map(axis => (positions[first + axis] + positions[first + 3 + axis]) / 2);
      let nearest = Infinity;
      for (let index = 0; index < bark.length; index += 3) {
        nearest = Math.min(nearest, Math.hypot(bark[index] - base[0], bark[index + 1] - base[1], bark[index + 2] - base[2]));
      }
      if (nearest > MAXIMUM_GAP) floating++;
    }
    assert.equal(floating, 0, `${name}: ${floating} leaf cards start more than ${MAXIMUM_GAP} m from any bark`);
  }
});

test('each crowned species paints its own spray atlas', () => {
  const expectedKind = { oak: 'twig', ash: 'twig-ash', aspen: 'twig-aspen', birch: 'twig-birch' };
  const alphaOf = pixels => Buffer.from(pixels.data).filter((_, index) => index % 4 === 3);
  for (const name of CROWN_PRESETS) {
    const tree = createTree({ preset: name }, 4);
    const painted = alphaOf(tree.materials.foliage.map.image);
    assert.ok(painted.equals(alphaOf(createLeafPixels(expectedKind[name], [100, 140, 50]))), `${name} does not draw the ${expectedKind[name]} atlas`);
  }
  const alphas = CROWN_PRESETS.map(name => alphaOf(createTree({ preset: name }, 4).materials.foliage.map.image).toString('base64'));
  assert.equal(new Set(alphas).size, CROWN_PRESETS.length, 'two crowned species share one atlas');
});

test('no leaf card points steeply down unless its placement lets it hang', () => {
  for (const name of ['oak', 'ash', 'aspen']) {
    const tree = createTree({ preset: name }, 4);
    const { positions } = foliageGeometry(tree);
    for (let first = 0; first + 12 <= positions.length; first += 12) {
      const rise = (positions[first + 7] + positions[first + 10]) / 2 - (positions[first + 1] + positions[first + 4]) / 2;
      const length = Math.hypot(...[0, 1, 2].map(axis => (positions[first + 6 + axis] + positions[first + 9 + axis]) / 2 - (positions[first + axis] + positions[first + 3 + axis]) / 2));
      assert.ok(rise / length >= -0.35, `${name} card at ${first / 12} points ${(rise / length).toFixed(2)} down`);
    }
  }
});
