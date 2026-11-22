import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { flipNormalGreen, repackMetallicRoughness, sequenceFrameIds, textureMapIds } from '../src/agent-scene-assets.js';
import { namesCatalogTextureMaps, resolveTextureSetNames } from '../src/agent-asset-names.js';
import { classifyTextureMapName, groupTextureSetFiles } from '../src/texture-set-names.js';
import { createAgentAssetCatalog, fingerprintAssetDirectory } from '../scripts/agent-asset-catalog.mjs';
import { describeIgnoredFeatures } from '../src/path-tracer.js';

await loadAllAgentSceneModules();

const IDS = Object.fromEntries(['color', 'normal', 'roughness', 'metallic', 'occlusion', 'height'].map((role, index) => [role, 'abcdef'[index].repeat(64)]));

function frame(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(pixel, offset);
  return { width, height, data };
}

function pool(overrides = {}) {
  return new Map(Object.entries({
    [IDS.color]: frame(2, 2, [200, 100, 50, 255]),
    [IDS.normal]: frame(2, 2, [128, 200, 255, 255]),
    [IDS.roughness]: frame(2, 2, [90, 90, 90, 255]),
    [IDS.metallic]: frame(2, 2, [30, 30, 30, 255]),
    [IDS.occlusion]: frame(2, 2, [220, 220, 220, 255]),
    [IDS.height]: frame(2, 2, [10, 10, 10, 255]),
    ...overrides,
  }));
}

function sceneWith(material, images = pool()) {
  return createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'rock', ...material }],
    nodes: [{ id: 'rock', geometry: 'quad', material: 'rock' }],
    camera: { eye: [0, 3, 3], target: [0, 0, 0], fov: 45 },
  }, {}, { sequenceFrames: images });
}

function fakeImage(kind, fill, width = 2, height = 2) {
  const bytes = Buffer.alloc(40, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes, 0);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return { kind, bytes };
}

test('standard map names are classified, with the normal convention', () => {
  const names = {
    'rock_boulder_dry_diff_1k.png': ['color'], 'rock_boulder_dry_nor_gl_1k.png': ['normal', 'opengl'], 'rock_boulder_dry_nor_dx_1k.png': ['normal', 'directx'],
    'rock_boulder_dry_rough_1k.png': ['roughness'], 'rock_boulder_dry_ao_1k.png': ['occlusion'], 'rock_boulder_dry_disp_1k.png': ['height'],
    'Rock030_1K-PNG_Color.png': ['color'], 'Rock030_1K-PNG_NormalGL.png': ['normal', 'opengl'], 'Rock030_1K-PNG_NormalDX.png': ['normal', 'directx'],
    'Rock030_1K-PNG_AmbientOcclusion.png': ['occlusion'], 'Rock030_1K-PNG_Displacement.png': ['height'], 'metal_plate_albedo.jpg': ['color'],
    'plate_normal.png': ['normal', 'opengl'], 'plate_Metalness.webp': ['metallic'],
  };
  for (const [name, [role, convention]] of Object.entries(names)) {
    const found = classifyTextureMapName(name);
    assert.equal(found?.role, role, name);
    assert.equal(found?.convention, convention, name);
  }
  assert.equal(classifyTextureMapName('screenshot.png'), null);
  assert.equal(classifyTextureMapName('rock_arm_1k.png'), null);
});

test('a folder of map files is one set: OpenGL wins over DirectX, two files for one map are ambiguous, one map is no set', () => {
  const both = groupTextureSetFiles(['a_diff.png', 'a_nor_dx.png', 'a_nor_gl.png', 'a_rough.png']);
  assert.deepEqual(Object.keys(both.maps).sort(), ['color', 'normal', 'roughness']);
  assert.equal(both.maps.normal.filename, 'a_nor_gl.png');
  assert.equal(groupTextureSetFiles(['a_diff.png', 'a_nor_dx.png']).maps.normal.convention, 'directx');
  const twice = groupTextureSetFiles(['a_diff.png', 'b_albedo.png', 'a_rough.png']);
  assert.equal(twice.maps, null);
  assert.match(twice.problem, /2 files for the color map \(a_diff\.png, b_albedo\.png\)/);
  assert.equal(groupTextureSetFiles(['a_diff.png', 'notes.png']).maps, null);
});

test('the catalog groups a folder into one textureSet entry and reads its maps by ID', async context => {
  const root = await mkdtemp(join(tmpdir(), 'crucible-texture-set-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'rock'));
  await mkdir(join(root, 'plain'));
  const files = { 'rock_diff.png': 1, 'rock_nor_dx.png': 2, 'rock_rough.png': 3 };
  for (const [name, fill] of Object.entries(files)) await writeFile(join(root, 'rock', name), fakeImage('png', fill, 4, 2).bytes);
  await writeFile(join(root, 'plain', 'photo.png'), fakeImage('png', 9).bytes);
  const before = await fingerprintAssetDirectory(root);
  const catalog = await createAgentAssetCatalog(root);
  const listing = catalog.list();
  assert.equal(listing.textureSets.length, 1);
  const [set] = listing.textureSets;
  assert.equal(set.kind, 'textureSet');
  assert.equal(set.name, 'rock');
  assert.deepEqual(Object.keys(set.maps).sort(), ['color', 'normal', 'roughness']);
  assert.deepEqual([set.maps.color.width, set.maps.color.height], [4, 2]);
  assert.equal(set.maps.normal.convention, 'directx');
  assert.equal(set.maps.color.name, 'rock/rock_diff.png');
  assert.deepEqual(listing.assets, [], 'the maps are not listed one by one');
  const fields = catalog.resolveTextureSet('rock');
  assert.deepEqual(Object.keys(fields).sort(), ['colorMap', 'normalConvention', 'normalMap', 'roughnessMap']);
  assert.equal(fields.normalConvention, 'directx');
  assert.equal((await catalog.read(fields.colorMap)).length, 40);
  await catalog.checkTextureMap('colorMap', fields.colorMap);
  await writeFile(join(root, 'rock', 'rock_ao.png'), fakeImage('png', 4).bytes);
  assert.notEqual(await fingerprintAssetDirectory(root), before, 'a map added to a set folder changes the fingerprint');
});

test('a missing set or a map ID that is not a catalog image says what would fit', async context => {
  const root = await mkdtemp(join(tmpdir(), 'crucible-texture-set-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bark'));
  await writeFile(join(root, 'bark', 'bark_color.png'), fakeImage('png', 1).bytes);
  await writeFile(join(root, 'bark', 'bark_normal.png'), fakeImage('png', 2).bytes);
  const catalog = await createAgentAssetCatalog(root);
  const normalId = catalog.resolveTextureSet('bark').normalMap;
  assert.throws(() => catalog.resolveTextureSet('rock'), /no set matches "rock"\. Texture sets: "bark"\./);
  assert.throws(() => catalog.resolveTextureSet('bar'), /Near names: "bark"/);
  await assert.rejects(catalog.checkTextureMap('normalMap', 'f'.repeat(64)), error => {
    assert.match(error.message, /normalMap must be the asset ID of a catalog image; ffffffffffff is not in the catalog/);
    assert.ok(error.message.includes(normalId), 'names the normal map ID that fits');
    return true;
  });
  await assert.rejects(catalog.checkTextureMap('roughnessMap', 'f'.repeat(64)), /The catalog has no roughness map/);
});

test('textureSet names in a recipe become map fields, and the fields a material sets itself win', async () => {
  const fields = { colorMap: IDS.color, normalMap: IDS.normal, normalConvention: 'directx' };
  const recipe = { materials: [{ id: 'rock', textureSet: 'rock', normalMap: IDS.height }, { id: 'sand', textureSet: 'rock', roughnessMap: IDS.roughness }] };
  assert.equal(namesCatalogTextureMaps(recipe), true);
  assert.equal(namesCatalogTextureMaps({ materials: [{ id: 'flat', color: [1, 0, 0] }] }), false);
  const checked = [];
  await resolveTextureSetNames(recipe, { resolveSet: () => fields, checkMap: async (field, id) => checked.push([field, id]) });
  assert.deepEqual(recipe.materials[0], { id: 'rock', normalMap: IDS.height, colorMap: IDS.color });
  assert.deepEqual(recipe.materials[1], { id: 'sand', roughnessMap: IDS.roughness, colorMap: IDS.color, normalMap: IDS.normal, normalConvention: 'directx' });
  assert.equal(checked.length, 5);
});

test('a DirectX normal map has its green channel flipped on load and an OpenGL one is left alone', () => {
  const flipped = flipNormalGreen(frame(1, 1, [10, 200, 255, 255]));
  assert.deepEqual([...flipped.data], [10, 55, 255, 255]);
  const directx = sceneWith({ normalMap: IDS.normal, normalConvention: 'directx' }).parts[0].material.normalMap;
  assert.deepEqual([...directx.image.data.slice(0, 4)], [128, 55, 255, 255]);
  assert.equal(directx.colorSpace, 'linear');
  const opengl = sceneWith({ normalMap: IDS.normal }).parts[0].material.normalMap;
  assert.deepEqual([...opengl.image.data.slice(0, 4)], [128, 200, 255, 255]);
});

test('grey roughness and metallic images are repacked into the glTF channel layout', () => {
  const packed = repackMetallicRoughness(frame(1, 1, [90, 90, 90, 255]), frame(1, 1, [30, 30, 30, 255]));
  assert.deepEqual([...packed.data], [255, 90, 30, 255]);
  assert.deepEqual([...repackMetallicRoughness(frame(1, 1, [90, 0, 0, 255]), null).data], [255, 90, 255, 255]);
  assert.deepEqual([...repackMetallicRoughness(null, frame(1, 1, [30, 0, 0, 255])).data], [255, 255, 30, 255]);
  assert.throws(() => repackMetallicRoughness(frame(2, 2, [1, 1, 1, 255]), frame(4, 4, [1, 1, 1, 255])), /metallicMap: got "4x4"; expected an image of the roughnessMap size, 2x2/);
  const material = sceneWith({ roughnessMap: IDS.roughness, metallicMap: IDS.metallic }).parts[0].material;
  assert.deepEqual([...material.metallicRoughnessMap.image.data.slice(0, 4)], [255, 90, 30, 255]);
  assert.equal(material.metallicRoughnessMap.colorSpace, 'linear');
});

test('a recipe material with every map gets its textures, defaults its factors to 1 and keeps the textures stable', () => {
  const scene = sceneWith({ colorMap: IDS.color, normalMap: IDS.normal, roughnessMap: IDS.roughness, metallicMap: IDS.metallic, occlusionMap: IDS.occlusion, heightMap: IDS.height });
  const material = scene.parts[0].material;
  assert.deepEqual([...material.map.image.data.slice(0, 3)], [200, 100, 50]);
  assert.equal(material.map.colorSpace, 'srgb');
  assert.deepEqual([...material.occlusionMap.image.data.slice(0, 1)], [220]);
  assert.deepEqual([...material.heightMap.image.data.slice(0, 1)], [10]);
  assert.deepEqual([material.roughness, material.metallic, ...material.color], [1, 1, 1, 1, 1]);
  assert.equal(scene.parts[0].material.normalMap, material.normalMap, 'the descriptor stays one object for the renderer');
  assert.deepEqual(sceneWith({ roughnessMap: IDS.roughness, roughness: 0.4 }).parts[0].material.roughness, 0.4);
  const kinds = scene.inspect().diagnostics.map(problem => problem.kind);
  assert.deepEqual(kinds.filter(kind => kind === 'ignored-material-field'), ['ignored-material-field']);
  assert.match(scene.inspect().diagnostics.find(problem => problem.kind === 'ignored-material-field').message, /heightMap is ignored/);
});

test('the ids of the maps are collected for the host to decode', () => {
  const material = { id: 'rock', colorMap: IDS.color.toUpperCase(), normalMap: IDS.normal, heightMap: 'not-an-id' };
  assert.deepEqual(textureMapIds(material), [IDS.color, IDS.normal]);
  assert.deepEqual(sequenceFrameIds({ materials: [material] }).sort(), [IDS.color, IDS.normal].sort());
  assert.deepEqual(sequenceFrameIds([{ type: 'set-material', id: 'rock', roughnessMap: IDS.roughness }]), [IDS.roughness]);
});

test('bad map fields fail with the field and what to pass', () => {
  assert.throws(() => sceneWith({ normalMap: 'rock_normal.png' }), /normalMap: got "rock_normal.png"; expected the 64 hexadecimal characters of a catalog image asset ID/);
  assert.throws(() => sceneWith({ normalMap: IDS.normal, normalConvention: 'dx' }), /normalConvention: got "dx"; expected one of opengl, directx/);
  assert.throws(() => sceneWith({ colorMap: IDS.color, normalConvention: 'directx' }), /normalConvention: got "directx"; expected a material that sets normalMap/);
  assert.throws(() => sceneWith({ textureSet: 'rock' }), /textureSet: got "rock"; expected a recipe with the maps already filled in/);
  assert.throws(() => sceneWith({ colorMap: IDS.color, pattern: { type: 'bricks' } }), /expected nothing, because a material takes a pattern or catalog maps, not both/);
  assert.throws(() => sceneWith({ colorMap: IDS.color, map: { sequence: { frames: [IDS.color, IDS.normal], fps: 1 } } }), /colorMap: got .*expected nothing, because the colour map is either a map sequence or a catalog colorMap/);
  assert.throws(() => sceneWith({ tag: 'unlit', normalMap: IDS.normal }), /expected a material with the surface tag/);
  const incomplete = pool();
  incomplete.delete(IDS.roughness);
  assert.throws(() => sceneWith({ roughnessMap: IDS.roughness }, incomplete).parts[0].material.metallicRoughnessMap, /Material rock: roughnessMap image aaaa|Material rock: roughnessMap image cccc.* was not loaded/);
});

test('an edit can set a map on an existing material', () => {
  const scene = sceneWith({ color: [0.5, 0.5, 0.5] });
  scene.apply([{ type: 'set-material', id: 'rock', normalMap: IDS.normal }], { expectedRevision: scene.inspect().revision });
  assert.deepEqual([...scene.parts[0].material.normalMap.image.data.slice(0, 4)], [128, 200, 255, 255]);
});

test('a material without the new fields is built exactly as before', () => {
  const scene = sceneWith({ color: [0.2, 0.4, 0.6], roughness: 0.3 });
  const material = scene.parts[0].material;
  for (const field of ['heightMap', 'occlusionMap', 'colorMap', 'roughnessMap', 'metallicMap', 'textureSet', 'normalConvention']) {
    assert.equal(Object.hasOwn(material, field), false, field);
  }
  assert.equal(material.map, undefined);
  assert.equal(material.normalMap, undefined);
  assert.deepEqual([material.roughness, material.metallic, ...material.color], [0.3, 0, 0.2, 0.4, 0.6]);
  assert.deepEqual((scene.inspect().diagnostics ?? []).filter(problem => problem.kind === 'ignored-material-field'), []);
  const plain = sceneWith({});
  assert.deepEqual([plain.parts[0].material.roughness, ...plain.parts[0].material.color], [0.5, 0.5, 0.5, 0.5]);
});

test('a path trace reports the height map as ignored', () => {
  const parts = [{ name: 'rock', material: { heightMap: { image: frame(1, 1, [0, 0, 0, 255]) } } }];
  assert.ok(describeIgnoredFeatures(parts, {}, 'cpu').includes('heightMap is ignored.'));
  assert.ok(!describeIgnoredFeatures([{ name: 'rock', material: {} }], {}, 'cpu').includes('heightMap is ignored.'));
});
