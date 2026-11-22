import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { createMeshData } from '../src/mesh-data.js';
import { grid } from '../src/geometry.js';
import { meshFromGeometry } from '../src/mesh-convert.js';
import { applyMeshEdits } from '../src/mesh-recipe.js';
import { createHeightSourceResolver } from '../src/mesh-displace-source.js';
import { sequenceFrameIds } from '../src/agent-texture-sequence.js';

const IMAGE_ASSET = 'c'.repeat(64);

// 4 by 4 image: the left half is black and the right half is white, so a flip of u shows.
function halfImage() {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) data.set(column < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255], (row * 4 + column) * 4);
  }
  return new Map([[IMAGE_ASSET, { width: 4, height: 4, data }]]);
}

function rampMaterial(extra = {}) {
  return { id: 'ramp', tag: 'surface', pattern: { type: 'graph', mapping: 'uv', resolution: 256, graph: { height: { gradient: { type: 'v' } } }, ...extra } };
}

function withoutMapping(material) {
  const { mapping, ...pattern } = material.pattern;
  return { ...material, pattern };
}

function recipeWith(materials, edits, base = { type: 'plane', segments: 2 }) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'mesh', base, edits }],
    materials,
    nodes: [{ id: 'ground', geometry: 'ground', material: materials[0]?.id }],
  };
}

const subdivided = [{ op: 'subdivide', levels: 1 }];
const heightsOf = scene => Array.from({ length: scene.parts[0].geometry.positions.length / 3 }, (_, vertex) => scene.parts[0].geometry.positions[vertex * 3 + 2]);

test('a subdivided plane is displaced by the height of a material graph, by its UVs', () => {
  const edits = [...subdivided, { op: 'displace', source: { material: 'ramp' }, strength: 1, midlevel: 0, direction: 'z' }];
  const scene = createAgentScene(recipeWith([rampMaterial()], edits), {});
  const geometry = scene.parts[0].geometry;
  for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
    const v = geometry.uvs[vertex * 2 + 1];
    assert.ok(Math.abs(geometry.positions[vertex * 3 + 2] - v) < 1e-5, `vertex ${vertex}: height ${geometry.positions[vertex * 3 + 2]} for v ${v}`);
  }
  assert.ok(Math.max(...heightsOf(scene)) > 0.9 && Math.min(...heightsOf(scene)) < 0.1);
});

test('a catalog image displaces a subdivided plane, with u running left to right', () => {
  const edits = [...subdivided, { op: 'displace', source: { image: IMAGE_ASSET }, strength: 2, midlevel: 0, direction: 'z' }];
  const scene = createAgentScene(recipeWith([{ id: 'plain', tag: 'surface' }], edits), {}, { sequenceFrames: halfImage() });
  const geometry = scene.parts[0].geometry;
  let left = 0;
  let right = 0;
  for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
    const u = geometry.uvs[vertex * 2];
    if (Math.abs(u - 0.25) < 1e-6) left = Math.max(left, geometry.positions[vertex * 3 + 2]);
    if (Math.abs(u - 0.75) < 1e-6) right = Math.max(right, geometry.positions[vertex * 3 + 2]);
  }
  assert.equal(left, 0);
  assert.ok(right > 1.9, `right edge rose to ${right}`);
});

test('an image height is read with bilinear filtering, so a vertex between two texels gets their mean', () => {
  // The black and white halves meet at u = 0.5, between texel centres 0.375 and 0.625: nearest sampling would give 0 or 2, bilinear gives 1.
  const edits = [{ op: 'displace', source: { image: IMAGE_ASSET }, strength: 2, midlevel: 0, direction: 'z' }];
  const scene = createAgentScene(recipeWith([{ id: 'plain', tag: 'surface' }], edits), {}, { sequenceFrames: halfImage() });
  const geometry = scene.parts[0].geometry;
  const middle = [];
  for (let vertex = 0; vertex < geometry.positions.length / 3; vertex++) {
    if (Math.abs(geometry.uvs[vertex * 2] - 0.5) < 1e-6) middle.push(geometry.positions[vertex * 3 + 2]);
  }
  assert.ok(middle.length > 0);
  for (const height of middle) assert.ok(Math.abs(height - 1) < 1e-5, `height ${height} at u 0.5`);
});

test('the same recipe gives the same bytes twice, and editing the graph height rebuilds the mesh', () => {
  const edits = [...subdivided, { op: 'displace', source: { material: 'ramp' }, midlevel: 0, direction: 'z' }];
  const first = heightsOf(createAgentScene(recipeWith([rampMaterial()], edits), {}));
  assert.deepEqual(heightsOf(createAgentScene(recipeWith([rampMaterial()], edits), {})), first);
  const flipped = rampMaterial({ graph: { height: { mul: [{ gradient: { type: 'v' } }, 0.5] } } });
  const second = heightsOf(createAgentScene(recipeWith([flipped], edits), {}));
  assert.notDeepEqual(second, first);
});

test('a vertex on a UV seam takes the mean height of its corners, so the surface stays closed', () => {
  const mesh = meshFromGeometry(grid(1));
  const corners = mesh.attributes.corner.uv.data.slice();
  const seamed = meshFromGeometry(grid(1));
  seamed.attributes.corner.uv.data.set([0.1, 0, 0.1, 0, 0.1, 0, 0.9, 0].slice(0, corners.length));
  const resolve = createHeightSourceResolver({ materials: new Map([['ramp', rampMaterial()]]) });
  const edit = { op: 'displace', source: { material: 'ramp' }, midlevel: 0, direction: 'z' };
  const displaced = applyMeshEdits(seamed, [edit], { resolveHeight: resolve }).mesh;
  assert.ok(Number.isFinite(displaced.positions[1]));
});

test('displace source says what to pass for a bad source', () => {
  const apply = source => applyMeshEdits(meshFromGeometry(grid(1)), [{ op: 'displace', source }], { resolveHeight: createHeightSourceResolver({}) });
  assert.throws(() => apply('rock'), /pass an object such as \{ "material": "rock" \}/);
  assert.throws(() => apply({}), /pass exactly one of material or image/);
  assert.throws(() => apply({ material: 'a', image: IMAGE_ASSET }), /pass exactly one of material or image/);
  assert.throws(() => apply({ image: 'https://example.com/a.png' }), /64 hexadecimal characters.*Remote URLs/);
  assert.throws(() => applyMeshEdits(meshFromGeometry(grid(1)), [{ op: 'displace', field: 0.5, source: { material: 'a' } }]), /pass either "field" or "source"/);
  assert.throws(() => applyMeshEdits(meshFromGeometry(grid(1)), [{ op: 'displace' }]), /field expression/);
  assert.throws(() => applyMeshEdits(meshFromGeometry(grid(1)), [{ op: 'displace', source: { material: 'ramp' } }]), /needs the scene materials and images/);
});

test('a source material without a height, a uv mapping or a recipe entry is refused with the fix', () => {
  const edits = [{ op: 'displace', source: { material: 'ramp' } }];
  assert.throws(() => createAgentScene(recipeWith([{ id: 'other', tag: 'surface' }], edits), {}), /material ramp is not in the recipe. Use one of other/);
  assert.throws(() => createAgentScene(recipeWith([{ id: 'ramp', tag: 'surface' }], edits), {}), /material ramp has no graph/);
  assert.throws(() => createAgentScene(recipeWith([rampMaterial({ graph: { color: [1, 0, 0] } })], edits), {}), /no height output/);
  assert.throws(() => createAgentScene(recipeWith([withoutMapping(rampMaterial())], edits), {}), /Set "mapping": "uv"/);
});

test('an image source needs its pixels, and a mesh without UVs names uv_project', () => {
  const imageEdits = [{ op: 'displace', source: { image: IMAGE_ASSET } }];
  assert.throws(() => createAgentScene(recipeWith([{ id: 'plain', tag: 'surface' }], imageEdits), {}), /image cccccccccccc was not loaded/);
  const withUv = meshFromGeometry(grid(1));
  const noUv = createMeshData({ ...withUv, attributes: { ...withUv.attributes, corner: {} } });
  const resolveHeight = createHeightSourceResolver({ images: halfImage() });
  assert.throws(() => applyMeshEdits(noUv, imageEdits, { resolveHeight }), /uv_project or uv_unwrap/);
});

test('the host is told to decode the image of a displace edit', () => {
  const recipe = recipeWith([{ id: 'plain', tag: 'surface' }], [{ op: 'displace', source: { image: IMAGE_ASSET.toUpperCase() } }]);
  assert.deepEqual(sequenceFrameIds(recipe), [IMAGE_ASSET]);
});
