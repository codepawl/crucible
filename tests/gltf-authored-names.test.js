import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

// Issue #3028: three.js strips periods, slashes and brackets from node names, so `part.name` loses them.
const AUTHORED_NAME = 'Ship_Cargo_-2.5_-0.46_0/bay[1]';

test('a part keeps the authored node name on label while name stays the decoded one (#3028)', async () => {
  const asset = await parseGltf(skinnedStripAsset(document => { document.nodes[1].name = AUTHORED_NAME; }));
  const [part] = asset.parts;
  assert.equal(part.label, AUTHORED_NAME);
  assert.notEqual(part.name, AUTHORED_NAME);
  const node = asset.nodes.find(candidate => candidate.meshIds.length);
  assert.equal(node.label, AUTHORED_NAME);
  assert.equal(node.name, part.name);
  assert.equal(asset.parts.find(candidate => candidate.label === AUTHORED_NAME), part);
  asset.dispose();
});

test('a part of an unnamed node labels itself with its generated name (#3028)', async () => {
  const asset = await parseGltf(skinnedStripAsset(document => { delete document.nodes[1].name; }));
  assert.equal(asset.parts[0].label, asset.parts[0].name);
  asset.dispose();
});
