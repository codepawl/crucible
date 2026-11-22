import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { createTree } from '../src/vegetation.js';

await loadAllAgentSceneModules();

function geometryHash(trees, keys) {
  const hash = createHash('sha256');
  for (const tree of trees) {
    for (const level of tree.levels) {
      for (const part of level.parts) {
        for (const key of keys) {
          const values = part.geometry[key];
          if (values) hash.update(Buffer.from(values.buffer, values.byteOffset, values.byteLength));
        }
      }
    }
  }
  return hash.digest('hex');
}

const triangleCount = geometry => geometry.indices.length / 3;

test('trees in leaf keep the geometry they had before bare twigs existed (#2826)', () => {
  const trees = [['broadleaf', 'mesh', 21], ['broadleaf', 'cards', 3], ['birch', 'mesh', 5]].map(([species, leaves, seed]) => createTree({ species, leaves, height: 8 }, seed));
  // The shape of these trees on main before the twigs were added: they draw from their own random stream.
  assert.equal(geometryHash(trees, ['positions', 'normals', 'uvs', 'indices']), '21489b9af9e6cbacaaf134205eade4a475d962d8dc7b3d44236335a07bafb1a5');
  // Colours are pinned apart, so a deliberate tint change (#2991 leaf clump tint) updates this line only.
  assert.equal(geometryHash(trees, ['colors']), '8a15a8e6f327e4db5464c6cd326ab043d7fe5ec3960e2c886d45fc6eb2bbd450');
});

test('a bare broadleaf grows twigs past its last branch level, near the triangles of the tree in leaf', () => {
  const tree = createTree({ species: 'broadleaf', leaves: 'mesh', height: 8 }, 21);
  assert.equal(typeof tree.bareParts, 'function');
  const bare = tree.bareParts(0);
  assert.equal(bare.length, 1);
  assert.equal(bare[0].role, 'bark');
  assert.equal(bare[0].tintable, false);
  assert.equal(bare[0].material, tree.materials.bark);
  const leafyBark = tree.levels[0].parts.find(part => part.role === 'bark');
  assert.ok(triangleCount(bare[0].geometry) > 4 * triangleCount(leafyBark.geometry), 'hundreds of twigs on top of the limbs');
  for (let level = 0; level < tree.levels.length; level++) {
    assert.ok(triangleCount(tree.bareParts(level)[0].geometry) <= 1.25 * tree.levels[level].triangles, `level ${level} stays near the leafy budget`);
  }
  assert.equal(tree.bareParts(0), bare, 'built once and kept');
  const again = createTree({ species: 'broadleaf', leaves: 'mesh', height: 8 }, 21).bareParts(0)[0].geometry;
  assert.deepEqual(Array.from(again.positions), Array.from(bare[0].geometry.positions), 'the same seed grows the same twigs');
  assert.throws(() => tree.bareParts(4), /bareParts needs a level index from 0 to 3; got 4/);
  assert.equal(createTree({ species: 'birch' }, 2).bareParts, undefined, 'only species with twigs have bare parts');
});

test('a bare broadleaf node draws the twigged bark, a leafy one the plain bark', () => {
  const sceneFor = season => createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    nodes: [{ id: 'oak', vegetation: { species: 'broadleaf', seed: 21, height: 8, leaves: 'mesh', season } }],
    camera: { eye: [0, 2, 14], target: [0, 5, 0] },
  });
  const leafy = sceneFor(0);
  const bare = sceneFor(0.95);
  const tree = createTree({ species: 'broadleaf', leaves: 'mesh', height: 8 }, 21);
  assert.equal(leafy.parts.length, 2);
  assert.equal(bare.parts.length, 1);
  assert.ok(bare.parts[0].name.endsWith('/bark'));
  assert.equal(triangleCount(bare.parts[0].geometry), triangleCount(tree.bareParts(0)[0].geometry));
  assert.equal(triangleCount(leafy.parts.find(part => part.name.endsWith('/bark')).geometry), triangleCount(tree.levels[0].parts[0].geometry));
  assert.equal(bare.inspect().vegetation[0].triangles, triangleCount(tree.bareParts(0)[0].geometry));
});
