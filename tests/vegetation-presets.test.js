import test from 'node:test';
import assert from 'node:assert/strict';
import { createTree, scatterVegetation, TREE_PRESETS, TREE_PARAMETERS, SPECIES } from '../src/vegetation.js';
import { checkTreeGrowth, MAX_TREE_BRANCHES } from '../src/vegetation-presets.js';
import { normalizeVegetation } from '../src/agent-vegetation.js';
import { TREE_GROWTH_CAPABILITIES } from '../src/agent-vegetation-notes.js';

const groupNode = { id: 'tree' };

function geometryOf(tree) {
  return tree.levels.map(level => level.parts.map(part => [Array.from(part.geometry.positions), Array.from(part.geometry.indices)]));
}

function throwsWith(action, pattern) {
  assert.throws(action, error => {
    assert.match(error.message, pattern);
    return true;
  });
}

test('a species with no overrides and a preset with none grow exactly the species tree', () => {
  assert.deepEqual(geometryOf(createTree({ species: 'broadleaf', tree: {} }, 4)), geometryOf(createTree('broadleaf', 4)));
  assert.deepEqual(geometryOf(createTree({ preset: 'birch' }, 4)), geometryOf(createTree('birch', 4)));
  const preset = createTree({ preset: 'pine' }, 4);
  assert.equal(preset.species, 'conifer');
  assert.equal(preset.preset, 'pine');
});

test('the same seed and parameters grow byte-identical trees, and each parameter changes the tree', () => {
  const tree = { branchAngle: [50, 40], twist: 0.3, growthDirection: [1, 1, 0], tropism: 0.08, leafCount: 7 };
  assert.deepEqual(geometryOf(createTree({ preset: 'oak', tree }, 9)), geometryOf(createTree({ preset: 'oak', tree }, 9)));
  const oak = geometryOf(createTree({ preset: 'oak' }, 9));
  for (const change of [{ branchAngle: 30 }, { twist: 0.4 }, { growthDirection: [1, 0.2, 0], tropism: 0.1 }, { crownShape: 'cone' }, { leafSize: 1.6 }, { radiusFalloff: 0.3 }]) {
    assert.notDeepEqual(geometryOf(createTree({ preset: 'oak', tree: change }, 9)), oak, JSON.stringify(change));
  }
});

test('a preset override replaces only the parameters and levels it names', () => {
  const oak = TREE_PRESETS.oak.tree;
  const first = createTree({ preset: 'oak', tree: { branchAngle: [80] } }, 2);
  const spelled = createTree({ preset: 'oak', tree: { branchAngle: [80, ...oak.branchAngle.slice(1)] } }, 2);
  assert.deepEqual(geometryOf(first), geometryOf(spelled));
  assert.notDeepEqual(geometryOf(first), geometryOf(createTree({ preset: 'oak', tree: { branchAngle: 80 } }, 2)));
  const pine = createTree({ preset: 'pine' }, 2);
  assert.ok(pine.height >= TREE_PRESETS.pine.height[0] && pine.height <= TREE_PRESETS.pine.height[1]);
});

test('levels grow and cut branch generations, and a bare broadleaf still twigs', () => {
  const one = createTree({ species: 'broadleaf', tree: { levels: 1 } }, 5);
  const four = createTree({ species: 'broadleaf', tree: { levels: 4 } }, 5);
  assert.ok(one.levels[0].triangles > 0);
  assert.ok(four.levels[0].triangles > createTree('broadleaf', 5).levels[0].triangles);
  const bare = createTree({ species: 'broadleaf', tree: { levels: 2 } }, 5);
  assert.ok(bare.bareParts(0)[0].geometry.indices.length > 0);
});

test('out of range values say which parameter failed and what to pass', () => {
  throwsWith(() => createTree({ preset: 'oak', tree: { branchAngle: 200 } }), /tree\.branchAngle must be a number from 5 to 120/);
  throwsWith(() => createTree({ species: 'birch', tree: { leafs: 3 } }), /tree\.leafs .*use one of levels, branches/);
  throwsWith(() => createTree({ species: 'birch', tree: { gnarliness: [0.1, 0.1, 0.1, 0.1, 0.1] } }), /list of 1 to 4 numbers starting at the trunk/);
  throwsWith(() => createTree({ species: 'birch', tree: { levels: 2.5 } }), /a whole number from 1 to 4/);
  throwsWith(() => createTree({ species: 'birch', tree: { crownShape: 'square' } }), /round, cone, column, umbrella/);
  throwsWith(() => createTree({ species: 'birch', tree: { growthDirection: [0, 0, 0] } }), /not zero/);
  throwsWith(() => createTree({ preset: 'oak', species: 'conifer' }), /oak grows as broadleaf/);
  throwsWith(() => createTree({ preset: 'maple' }), /use one of oak, ash, aspen, birch, pine, palm, bush/);
  throwsWith(() => createTree({ species: 'broadleaf', tree: { levels: 4, branches: 30 } }), new RegExp(`above the limit of ${MAX_TREE_BRANCHES}`));
  throwsWith(() => createTree({ species: 'broadleaf', height: 40, tree: { levels: 4, branches: [12, 6, 5, 5], leafCount: 20 } }), /at most 20000 leaf sites; lower tree.leafCount/);
  assert.ok(createTree({ species: 'bush', height: 1000 }).levels[0].triangles > 0);
});

test('every preset is a small JSON object of checked parameters on a real species', () => {
  assert.deepEqual(Object.keys(TREE_PRESETS), ['oak', 'ash', 'aspen', 'birch', 'pine', 'palm', 'bush']);
  for (const [name, preset] of Object.entries(TREE_PRESETS)) {
    assert.ok(SPECIES[preset.species], name);
    assert.deepEqual(JSON.parse(JSON.stringify(preset)), preset);
    const fail = (path, value, expected) => assert.fail(`${name} ${path} ${value}: ${expected}`);
    checkTreeGrowth(preset.tree, SPECIES[preset.species].levels.length - 1, fail);
    assert.ok(createTree({ preset: name }, 1).levels[0].triangles > 0);
  }
});

test('the recipe takes a preset with overrides and reports errors on the recipe path', () => {
  const vegetation = normalizeVegetation({ preset: 'ash', tree: { branchAngle: [35, 40], leafSize: 1.2 } }, groupNode);
  assert.equal(vegetation.preset, 'ash');
  assert.deepEqual(vegetation.tree, { branchAngle: [35, 40], leafSize: 1.2 });
  throwsWith(() => normalizeVegetation({ preset: 'ash', tree: { leafSize: 9 } }, groupNode), /vegetation\.tree\.leafSize/);
  throwsWith(() => normalizeVegetation({ preset: 'ash', species: 'birch' }, groupNode), /exactly one of species/);
  throwsWith(() => normalizeVegetation({ mix: { broadleaf: 1 }, tree: { levels: 2 }, scatter: { ground: 'ground' } }, groupNode), /nothing with mix/);
  throwsWith(() => normalizeVegetation({ preset: 'kauri' }, groupNode), /vegetation\.preset/);
});

test('a scatter grows every tree from the growth preset', () => {
  const scattered = scatterVegetation({ area: { minX: -12, maxX: 12, minZ: -12, maxZ: 12 }, density: 0.02, mix: { conifer: 1 }, variants: 2, growth: { preset: 'pine' }, seed: 3 });
  assert.ok(scattered.instances.length > 0);
  for (const variant of scattered.variants.conifer) assert.equal(variant.preset, 'pine');
});

test('scene_capabilities topic treeGrowth lists every preset and parameter range', () => {
  assert.deepEqual(Object.keys(TREE_GROWTH_CAPABILITIES.presets), Object.keys(TREE_PRESETS));
  assert.deepEqual(Object.keys(TREE_GROWTH_CAPABILITIES.parameters), Object.keys(TREE_PARAMETERS));
  assert.match(TREE_GROWTH_CAPABILITIES.parameters.branchAngle, /^5-120/);
});
