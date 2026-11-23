import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';
import { createAgentAssetCatalog } from '../scripts/agent-asset-catalog.mjs';
import { padded, readGlb, writeGlb } from '../scripts/agent-glb-io.mjs';
import { KTX2_EXTENSION, KTX2_MISSING_ADVICE, encodeRgbaPng, loadDefaultKtx2Transcoder, transcodeKtx2Glb, usesKtx2, validateKtx2Glb } from '../scripts/agent-ktx2.mjs';
import { geometryOnlyGlb } from '../scripts/agent-query-asset.mjs';
import { chooseKtx2Target, createPreviewKtx2Decoder, transcodeKtx2Buffer } from '../scripts/agent-preview-ktx2.js';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';

const execFileAsync = promisify(execFile);
const FIXTURES = new URL('./fixtures/ktx2/', import.meta.url);
const WITHOUT_TRANSCODER_SCRIPT = new URL('./fixtures/ktx2/catalog-without-transcoder.mjs', import.meta.url);

// Both fixtures are 40x40 test images from the three.js examples (MIT): one ETC1S and one UASTC.
const KTX2_FIXTURES = [
  { name: '2d_etc1s.ktx2', firstPixel: [181, 148, 16, 255] },
  { name: '2d_uastc.ktx2', firstPixel: [186, 151, 0, 255] },
];

async function texturedBoxGlb(ktx2Name) {
  const ktx2 = await readFile(new URL(ktx2Name, FIXTURES));
  const geometry = box(0);
  geometry.uvs = new Float32Array(geometry.positions.length / 3 * 2).map((_, index) => (index % 7) / 7);
  const plain = Buffer.from(exportGlb([{ name: 'Cube', geometry, matrix: mat4.create(), material: { color: [1, 1, 1], roughness: 0.5, metallic: 0 } }]));
  const { document, binary } = readGlb(plain);
  const start = padded(binary, 0).length;
  document.bufferViews.push({ buffer: 0, byteOffset: start, byteLength: ktx2.length });
  document.images = [{ bufferView: document.bufferViews.length - 1, mimeType: 'image/ktx2' }];
  document.textures = [{ extensions: { [KTX2_EXTENSION]: { source: 0 } } }];
  document.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  document.extensionsUsed = [KTX2_EXTENSION];
  document.extensionsRequired = [KTX2_EXTENSION];
  const body = padded(Buffer.concat([padded(binary, 0), ktx2]), 0);
  document.buffers[0].byteLength = body.length;
  return writeGlb(document, body);
}

function decodePng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  let offset = 8;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const scanlines = inflateSync(Buffer.concat(compressed));
  const rowBytes = width * 4;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row++) scanlines.copy(pixels, row * rowBytes, row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1));
  return { width, height, pixels };
}

function imagePng(glb) {
  const { document, binary } = readGlb(glb);
  const view = document.bufferViews[document.images[0].bufferView];
  return { document, png: binary.subarray(view.byteOffset, view.byteOffset + view.byteLength) };
}

async function catalogFolder(context, files) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-ktx2-'));
  context.after(async () => {
    assert.equal(dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes);
  return directory;
}

for (const { name, firstPixel } of KTX2_FIXTURES) {
  test(`a GLB with a ${name} texture becomes a plain GLB with a PNG image and no extension`, async () => {
    const source = await texturedBoxGlb(name);
    assert.equal(usesKtx2(readGlb(source).document), true);
    const result = await transcodeKtx2Glb(source, { filename: 'lamp.glb' });
    assert.equal(result.images, 1);
    const { document, png } = imagePng(result.bytes);
    assert.equal(usesKtx2(document), false);
    assert.equal(document.extensionsUsed, undefined);
    assert.equal(document.extensionsRequired, undefined);
    assert.equal(document.images[0].mimeType, 'image/png');
    assert.equal(document.textures[0].source, 0);
    assert.equal(document.textures[0].extensions, undefined);
    const decoded = decodePng(png);
    assert.equal(decoded.width, 40);
    assert.equal(decoded.height, 40);
    assert.deepEqual([...decoded.pixels.subarray(0, 4)], firstPixel);
  });
}

test('the PNG writer round-trips RGBA pixels', () => {
  const pixels = Uint8Array.from({ length: 2 * 3 * 4 }, (unused, index) => index * 9);
  const decoded = decodePng(encodeRgbaPng(2, 3, pixels));
  assert.deepEqual([decoded.width, decoded.height], [2, 3]);
  assert.deepEqual([...decoded.pixels], [...pixels]);
});

test('the catalog validates a KTX2 GLB, keeps KHR_texture_basisu by default and transcodes on demand', async context => {
  const source = await texturedBoxGlb('2d_uastc.ktx2');
  const directory = await catalogFolder(context, { 'lamp.glb': source });
  const catalog = await createAgentAssetCatalog(directory);
  const listed = catalog.list();
  assert.equal(listed.skipped, undefined);
  assert.equal(listed.assets.length, 1);
  assert.equal(listed.assets[0].images, 1);
  const read = await catalog.read(listed.assets[0].assetId);
  assert.equal(usesKtx2(readGlb(read).document), true);
  assert.deepEqual(read, source);
  assert.equal(await catalog.size(listed.assets[0].assetId), read.length);
  const fallback = await catalog.read(listed.assets[0].assetId, { transcodeKtx2: true });
  const { document, png } = imagePng(fallback);
  assert.equal(usesKtx2(document), false);
  assert.deepEqual([...decodePng(png).pixels.subarray(0, 4)], [186, 151, 0, 255]);
});

test('a damaged KTX2 image is skipped with the reason instead of failing the catalog', async context => {
  const damaged = await texturedBoxGlb('2d_uastc.ktx2');
  const { document, binary } = readGlb(damaged);
  const view = document.bufferViews[document.images[0].bufferView];
  const body = Buffer.from(binary);
  body.fill(0x7f, view.byteOffset + 12, view.byteOffset + 80);
  const directory = await catalogFolder(context, { 'damaged.glb': writeGlb(document, body) });
  const listed = (await createAgentAssetCatalog(directory)).list();
  assert.equal(listed.assets.length, 0);
  assert.match(listed.skipped[0].reason, /^damaged\.glb: .*KTX2/);
});

test('an image that is not KTX2 is refused with the texture named on both validation and PNG fallback', async () => {
  const source = await texturedBoxGlb('2d_uastc.ktx2');
  const { document, binary } = readGlb(source);
  const body = Buffer.from(binary);
  body.fill(0, document.bufferViews[document.images[0].bufferView].byteOffset, document.bufferViews[document.images[0].bufferView].byteOffset + 4);
  const bad = writeGlb(document, body);
  await assert.rejects(validateKtx2Glb(bad, { filename: 'lamp.glb' }), /lamp\.glb texture 0: image 0 is not a KTX2 file/);
  await assert.rejects(transcodeKtx2Glb(bad, { filename: 'lamp.glb' }), /lamp\.glb texture 0: image 0 is not a KTX2 file/);
});

test('without the transcoder the catalog skips the file and says to install three or re-export', async context => {
  const directory = await catalogFolder(context, { 'lamp.glb': await texturedBoxGlb('2d_uastc.ktx2') });
  const { stdout } = await execFileAsync(process.execPath, [WITHOUT_TRANSCODER_SCRIPT.pathname.replace(/^\/([A-Za-z]:)/, '$1'), directory]);
  const listed = JSON.parse(stdout);
  assert.equal(listed.assets.length, 0);
  assert.equal(listed.skipped.length, 1);
  assert.match(listed.skipped[0].reason, /^lamp\.glb: .*Basis transcoder is not installed/);
  assert.ok(listed.skipped[0].reason.includes(KTX2_MISSING_ADVICE));
  assert.match(KTX2_MISSING_ADVICE, /npm install three.*instead of KTX2/);
});

test('chooseKtx2Target picks GPU-compressed formats with DXT alignment and RGBA32 fallback', () => {
  assert.equal(chooseKtx2Target({ isUastc: true, width: 40, height: 40, hasAlpha: false, workerConfig: { astcSupported: true, bptcSupported: true } }).glFormat, 0x93b0);
  assert.equal(chooseKtx2Target({ isUastc: false, width: 40, height: 40, hasAlpha: false, workerConfig: { etc2Supported: true, bptcSupported: true } }).glFormat, 0x9274);
  assert.equal(chooseKtx2Target({ isUastc: false, width: 40, height: 40, hasAlpha: true, workerConfig: { etc2Supported: true, bptcSupported: true } }).glFormat, 0x9278);
  assert.equal(chooseKtx2Target({ isUastc: true, width: 40, height: 40, hasAlpha: false, workerConfig: { bptcSupported: true, dxtSupported: true } }).glFormat, 0x8e8c);
  assert.equal(chooseKtx2Target({ isUastc: true, width: 40, height: 40, hasAlpha: true, workerConfig: { dxtSupported: true } }).glFormat, 0x83f3);
  assert.equal(chooseKtx2Target({ isUastc: false, width: 42, height: 40, hasAlpha: false, workerConfig: { dxtSupported: true } }).glFormat, null);
  assert.equal(chooseKtx2Target({ isUastc: true, width: 40, height: 40, hasAlpha: false, workerConfig: {} }).glFormat, null);
});

test('transcodeKtx2Buffer keeps full GPU-compressed mip chains and falls back cleanly to RGBA8', async () => {
  const transcoder = await loadDefaultKtx2Transcoder();
  const uastc = await readFile(new URL('2d_uastc.ktx2', FIXTURES));
  const etc1s = await readFile(new URL('2d_etc1s.ktx2', FIXTURES));
  const bc7 = transcodeKtx2Buffer(transcoder, uastc.buffer.slice(uastc.byteOffset, uastc.byteOffset + uastc.byteLength), { bptcSupported: true });
  assert.equal(bc7.isCompressedTexture, true);
  assert.equal(bc7.format, 0x8e8c);
  assert.deepEqual(bc7.mipmaps.map(level => [level.width, level.height]), [[40, 40], [20, 20], [10, 10], [5, 5], [2, 2], [1, 1]]);
  const etc2 = transcodeKtx2Buffer(transcoder, etc1s.buffer.slice(etc1s.byteOffset, etc1s.byteOffset + etc1s.byteLength), { etc2Supported: true });
  assert.equal(etc2.isCompressedTexture, true);
  assert.equal(etc2.format, 0x9274);
  const rgba = transcodeKtx2Buffer(transcoder, uastc.buffer.slice(uastc.byteOffset, uastc.byteOffset + uastc.byteLength), {});
  assert.equal(rgba.isCompressedTexture, false);
  assert.equal(rgba.image.width, 40);
  assert.equal(rgba.image.height, 40);
  assert.deepEqual([...rgba.image.data.subarray(0, 4)], [186, 151, 0, 255]);
});

test('geometryOnlyGlb strips KHR_texture_basisu and EXT_texture_webp while keeping other extensions', async () => {
  const source = await texturedBoxGlb('2d_uastc.ktx2');
  const { document, binary } = readGlb(source);
  document.extensionsUsed = ['KHR_texture_basisu', 'EXT_texture_webp', 'KHR_lights_punctual'];
  document.extensionsRequired = ['KHR_texture_basisu'];
  const stripped = readGlb(geometryOnlyGlb(writeGlb(document, binary)));
  assert.equal(stripped.document.images, undefined);
  assert.equal(stripped.document.textures, undefined);
  assert.equal(stripped.document.samplers, undefined);
  assert.deepEqual(stripped.document.extensionsUsed, ['KHR_lights_punctual']);
  assert.equal(stripped.document.extensionsRequired, undefined);
});

test('exportGlb preserves unchanged KTX2 image bytes from parseGltf without decompressing', async () => {
  const ktx2 = await readFile(new URL('2d_uastc.ktx2', FIXTURES));
  const source = await texturedBoxGlb('2d_uastc.ktx2');
  const transcoder = await loadDefaultKtx2Transcoder();
  const decoder = createPreviewKtx2Decoder({
    loadTranscoder: async () => transcoder,
    probeConfig: () => ({ bptcSupported: true }),
  });
  const asset = await parseGltf(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength), { decoders: { ktx2: decoder } });
  try {
    assert.equal(asset.textureFormats[0].format, 'bc7');
    const exported = Buffer.from(exportGlb(asset.parts));
    const { document, binary } = readGlb(exported);
    assert.equal(usesKtx2(document), true);
    assert.equal(document.images[0].mimeType, 'image/ktx2');
    const view = document.bufferViews[document.images[0].bufferView];
    assert.deepEqual(binary.subarray(view.byteOffset, view.byteOffset + view.byteLength), ktx2);
  } finally {
    asset.dispose();
  }
});

test('MCP runtime keeps KTX2 GPU-compressed in preview, walkmap and exportGlb while transcoding for exportWeb', { timeout: 180000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'crucible-mcp-ktx2-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const assetsDir = join(root, 'assets');
  const jobsDir = join(root, 'jobs');
  await mkdir(assetsDir);
  await mkdir(jobsDir);
  const ktx2Glb = await texturedBoxGlb('2d_uastc.ktx2');
  const pngGlb = (await transcodeKtx2Glb(ktx2Glb, { filename: 'png-box.glb' })).bytes;
  await writeFile(join(assetsDir, 'ktx2-box.glb'), ktx2Glb);
  await writeFile(join(assetsDir, 'png-box.glb'), pngGlb);
  const runtime = createAgentRuntime({
    backend: 'cpu',
    memory: 96,
    assets: assetsDir,
    jobs: jobsDir,
    previewUrl: new URL('../build/mcp/preview.js', import.meta.url),
  });
  try {
    const listed = await runtime.assetCatalog();
    assert.equal(listed.skipped, undefined);
    const ktx2Entry = listed.assets.find(entry => entry.name === 'ktx2-box.glb');
    const pngEntry = listed.assets.find(entry => entry.name === 'png-box.glb');
    assert.ok(ktx2Entry && pngEntry);

    const ktx2Session = await runtime.createAsset({
      recipe: { format: 'crucible.asset', schemaVersion: 1, assetId: ktx2Entry.assetId },
    });
    const ktx2Inspect = await runtime.inspect({ sessionId: ktx2Session.sessionId, profile: true, profileFrames: 4 });
    assert.ok(ktx2Inspect.profile.drawCalls > 0);
    const ktx2Look = await runtime.look({ sessionId: ktx2Session.sessionId, width: 128, height: 128 });
    assert.deepEqual([...Buffer.from(ktx2Look.data, 'base64').subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const exportedGlb = await runtime.exportGlb({ sessionId: ktx2Session.sessionId });
    const exportedBytes = await readFile(exportedGlb.path);
    assert.equal(usesKtx2(readGlb(exportedBytes).document), true);
    assert.equal(readGlb(exportedBytes).document.images[0].mimeType, 'image/ktx2');

    const pngSession = await runtime.createAsset({
      recipe: { format: 'crucible.asset', schemaVersion: 1, assetId: pngEntry.assetId },
    });
    const pngInspect = await runtime.inspect({ sessionId: pngSession.sessionId, profile: true, profileFrames: 4 });
    assert.ok(ktx2Inspect.profile.textureBytes < pngInspect.profile.textureBytes,
      `Expected KTX2 VRAM (${ktx2Inspect.profile.textureBytes}) < PNG VRAM (${pngInspect.profile.textureBytes})`);

    const walk = await runtime.walkMap({ assetId: ktx2Entry.assetId, min: [-2, -2], max: [2, 2], cellSize: 1 });
    assert.ok(walk.rows > 0 && Array.isArray(walk.grid) && walk.grid.length === walk.rows);

    const gameSession = await runtime.create({
      recipe: {
        format: 'crucible.scene', schemaVersion: 1,
        geometries: [], materials: [],
        nodes: [{ id: 'crate', asset: { id: ktx2Entry.assetId } }],
        game: { player: { node: 'crate' }, physics: false },
      },
    });
    const web = await runtime.exportWeb({ sessionId: gameSession.sessionId });
    const copiedGlb = await readFile(join(web.directory, 'assets', `${ktx2Entry.assetId}.glb`));
    assert.equal(usesKtx2(readGlb(copiedGlb).document), false);
  } finally {
    await runtime.close();
  }
});
