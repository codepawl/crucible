import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { box, cylinder, sphere } from '../src/geometry.js';
import { meshFromGeometry, lintMesh } from '../src/mesh.js';
import { loadMeshBooleans, meshBoolean } from '../src/mesh-boolean.js';
import { transformMesh } from '../src/mesh-recipe.js';

await loadMeshBooleans();

// The digests were recorded by running these cases on origin/main before the faster rebuild (#3457), so they pin the
// output of the old code: every array of the result mesh, byte for byte, plus its face and cutter-face counts.
function meshDigest({ mesh, cutterFaces }) {
  const hash = createHash('sha256');
  const feed = array => {
    hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
    hash.update('|');
  };
  for (const key of ['positions', 'faceOffsets', 'cornerVertices', 'edgeVertices', 'cornerEdges']) feed(mesh[key]);
  for (const domain of Object.keys(mesh.attributes).sort()) {
    for (const name of Object.keys(mesh.attributes[domain]).sort()) {
      hash.update(`${domain}.${name}:${mesh.attributes[domain][name].size}:`);
      feed(mesh.attributes[domain][name].data);
    }
  }
  hash.update(`cut${cutterFaces},f${mesh.faceCount}`);
  return hash.digest('hex').slice(0, 16);
}

const placed = (mesh, translation, scale = [1, 1, 1]) => transformMesh(mesh, { translation, rotation: [0, 0, 0, 1], scale });

const CASES = [
  ['box union with a tag', 'union', () => [meshFromGeometry(box(0, 1)), placed(meshFromGeometry(box(0, 1)), [0.5, 0, 0])], { cutTag: 'cut' }, '49f83086fcd914e6'],
  ['box difference without a tag', 'difference', () => [meshFromGeometry(box(0, 1)), placed(meshFromGeometry(box(0, 1)), [0.5, 0.2, 0.1])], {}, 'd178d1a622be379d'],
  ['sphere with a cylinder through it', 'difference', () => [meshFromGeometry(sphere(48, 24)), placed(meshFromGeometry(cylinder(32, 0, 1)), [0.2, 0, 0], [0.4, 3, 0.4])], { cutTag: 'hole' }, '97ae0934da606c58'],
  ['bevelled box union a sphere', 'union', () => [meshFromGeometry(box(0.1, 3)), placed(meshFromGeometry(sphere(24, 12)), [0.3, 0.3, 0.3], [0.8, 0.8, 0.8])], { cutTag: 'cut' }, '9997ef9a9757461f'],
  ['sphere intersect a cylinder', 'intersect', () => [meshFromGeometry(sphere(48, 24)), placed(meshFromGeometry(cylinder(32, 0, 1)), [0.2, 0, 0], [0.4, 3, 0.4])], { cutTag: 'hole' }, '08a336c5deec9feb'],
];

for (const [name, operation, build, options, expected] of CASES) {
  test(`the ${name} rebuilds the same mesh as before`, () => {
    const [mesh, cutter] = build();
    assert.equal(meshDigest(meshBoolean(mesh, cutter, operation, options)), expected);
  });
}

test('lintMesh can leave out the topology metrics when only the problems matter', () => {
  const mesh = meshFromGeometry(box(0, 1));
  const full = lintMesh(mesh);
  const problemsOnly = lintMesh(mesh, { topology: false });
  assert.ok(full.valence && full.quadQuality && typeof full.topologyScore === 'number');
  assert.equal('valence' in problemsOnly, false);
  assert.equal('quadQuality' in problemsOnly, false);
  assert.equal('topologyScore' in problemsOnly, false);
  assert.deepEqual(problemsOnly.problems, full.problems);
  assert.equal(problemsOnly.ok, full.ok);
});
