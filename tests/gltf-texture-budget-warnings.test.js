import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { demoSceneDescription } from '../scripts/render-readme-previews.mjs';

function pngHeaderUri(width, height) {
  const header = new Uint8Array(24);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(4, 0x0d0a1a0a);
  view.setUint32(12, 0x49484452);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return `data:image/png;base64,${Buffer.from(header).toString('base64')}`;
}

function mockImageBitmapWithResize(context) {
  const previousBitmap = globalThis.createImageBitmap;
  const previousSelf = globalThis.self;
  globalThis.self = globalThis;
  globalThis.createImageBitmap = async (blob, options) => ({
    width: options.resizeWidth ?? 16,
    height: options.resizeHeight ?? 16,
    close() {},
  });
  context.after(() => {
    if (previousBitmap) globalThis.createImageBitmap = previousBitmap;
    else delete globalThis.createImageBitmap;
    if (previousSelf) globalThis.self = previousSelf;
    else delete globalThis.self;
  });
}

function buildTexturedDocument(edit) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);
  const bufferBytes = new Uint8Array(positions.byteLength + normals.byteLength + uvs.byteLength + indices.byteLength);
  let offset = 0;
  for (const view of [positions, normals, uvs, indices]) {
    bufferBytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offset);
    offset += view.byteLength;
  }
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Wall' }],
    buffers: [{ uri: `data:application/octet-stream;base64,${Buffer.from(bufferBytes).toString('base64')}`, byteLength: bufferBytes.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength },
      { buffer: 0, byteOffset: positions.byteLength + normals.byteLength, byteLength: uvs.byteLength },
      { buffer: 0, byteOffset: positions.byteLength + normals.byteLength + uvs.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    materials: [{ name: 'WallPlaster', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } }],
    textures: [],
    images: [],
  };
  edit(document);
  return JSON.stringify(document);
}

test('maxTexturePixels warnings report total pixels vs budget and every halved material map slot', async context => {
  mockImageBitmapWithResize(context);
  const gltf = buildTexturedDocument(document => {
    document.images = [
      { name: 'wall_color', uri: pngHeaderUri(16, 16) },
      { name: 'wall_normal', uri: pngHeaderUri(16, 16) },
      { name: 'wall_rough', uri: pngHeaderUri(16, 16) },
      { name: 'roof_coat', uri: pngHeaderUri(16, 16) },
    ];
    document.textures = [
      { source: 0, sampler: 0 },
      { source: 1, sampler: 0 },
      { source: 2, sampler: 0 },
      { source: 3, sampler: 0 },
    ];
    document.materials = [
      {
        name: 'WallPlaster',
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 2 } },
        normalTexture: { index: 1 },
      },
      {
        name: 'RoofTile',
        pbrMetallicRoughness: { metallicRoughnessTexture: { index: 2 } },
        extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatTexture: { index: 3 } } },
      },
      {
        pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
      },
    ];
    document.meshes[0].primitives.push(
      { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 1 },
      { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 2 },
    );
  });

  // 4 images of 16x16 = 1024 total px; budget 500 halves non-color maps (normal, rough, coat) to 8x8 -> 256 + 3*64 = 448 px.
  const asset = await parseGltf(gltf, { maxTexturePixels: 500 });
  const joined = asset.warnings.join('\n');
  assert.match(joined, /Texture budget exceeded: 1024 px total vs maxTexturePixels 500 \(scaled to 448 px\); pass \{ maxTexturePixels: 1024 \} to keep full resolution\./);
  assert.ok(asset.warnings.some(warning => warning.includes('"WallPlaster" normalTexture (wall_normal) 16x16 to 8x8')));
  assert.ok(asset.warnings.some(warning => warning.includes('"WallPlaster" metallicRoughnessTexture (wall_rough) 16x16 to 8x8')));
  assert.ok(asset.warnings.some(warning => warning.includes('"RoofTile" metallicRoughnessTexture (wall_rough) 16x16 to 8x8')));
  assert.ok(asset.warnings.some(warning => warning.includes('"RoofTile" clearcoatTexture (roof_coat) 16x16 to 8x8')));
  assert.ok(!asset.warnings.some(warning => warning.includes('baseColorTexture')), 'unscaled baseColorTexture must not be listed as scaled');
  assert.ok(!asset.warnings.some(warning => warning.includes('material 2')), 'material 2 uses only unscaled baseColorTexture');
  asset.dispose();
});

test('maxTexturePixels emits no budget warnings when textures fit within the budget', async context => {
  mockImageBitmapWithResize(context);
  const gltf = buildTexturedDocument(document => {
    document.images = [{ name: 'wall_color', uri: pngHeaderUri(16, 16) }];
    document.textures = [{ source: 0, sampler: 0 }];
    document.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  });
  const asset = await parseGltf(gltf, { maxTexturePixels: 256 });
  assert.deepEqual(asset.scaledTextures, []);
  assert.deepEqual(asset.warnings, []);
  asset.dispose();
});

test('demo preview scene description allows exported demo textures above 36.3M pixels without halving', () => {
  const description = demoSceneDescription({
    source: 'monk',
    name: 'cook-monk',
    eye: [20, 0.9, -9.5],
    target: [20, 0.9, -19.5],
    fov: 55,
  });
  assert.ok(description.gltfOptions.maxTexturePixels >= 67_108_864, `expected >= 64M pixels, got ${description.gltfOptions.maxTexturePixels}`);
});
