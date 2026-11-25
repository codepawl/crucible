import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { createTree } from '../src/vegetation.js';

await loadAllAgentSceneModules();

function geometryHash(trees, keys, levelCount = 4, roles = ['bark', 'foliage']) {
  const hash = createHash('sha256');
  for (const tree of trees) {
    for (const level of tree.levels.slice(0, levelCount)) {
      for (const part of level.parts) {
        if (!roles.includes(part.role)) continue;
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
  // The shape of these trees on main before the twigs were added: they draw from their own random stream. Positions, uvs, indices
  // and the bark's normals are the same on main before #2991 foliage shading (hash f8992dc8... and 8b4d41f1...).
  assert.equal(geometryHash(trees, ['positions', 'uvs', 'indices'], 2), 'f8992dc883baa4533128d9d051cd529f30f24d7d37f93425871e7ea64d540148');
  assert.equal(geometryHash(trees, ['normals'], 2, ['bark']), '8b4d41f189acd9ef10638eb13eed6824e80554f8f5f9c02b22d03d2b5ce9bf1b');
  // The foliage's shading normals and colours are pinned apart, so a deliberate shading change (#2991 rounded crown normals, crown
  // depth, clump tint) updates these lines only.
  assert.equal(geometryHash(trees, ['normals'], 2, ['foliage']), '30d034f67c2327faa70ae428dbdc7be1e707b37f508c181dfaece4e97ba718e4');
  assert.equal(geometryHash(trees, ['colors'], 2), 'db629b0801c4874bd840f10d2fc1e9db9d3421692e1ce7a264bd71e197081d4e');
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
