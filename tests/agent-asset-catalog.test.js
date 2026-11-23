import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, readdir, readFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { exportGlb } from '../src/export.js';
import { createAgentAssetCatalog, readCatalogFile } from '../scripts/agent-asset-catalog.mjs';
import { AGENT_ASSET_LIMITS, agentAssetDecodeOptions, withCatalogLimitAdvice } from '../src/agent-asset-limits.js';
import { GLTF_CAPABILITIES, parseGltf } from '../src/gltf.js';
import { createClips } from '../src/gltf-animation.js';

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-catalog-'));
  context.after(async () => {
    assert.equal(dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  });
  const bytes = Buffer.from(exportGlb([{ name: 'Cube', geometry: box(0), matrix: mat4.create(), material: { color: [0.2, 0.5, 0.7], roughness: 0.5, metallic: 0 } }]));
  await writeFile(join(directory, 'cube.glb'), bytes);
  return { directory, bytes };
}

function withDocument(bytes, edit) {
  const document = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  edit(document);
  const json = Buffer.from(JSON.stringify(document));
  const length = Math.ceil(json.length / 4) * 4;
  const binary = bytes.subarray(20 + bytes.readUInt32LE(12));
  const result = Buffer.alloc(20 + length + binary.length, 32);
  bytes.copy(result, 0, 0, 20);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(length, 12);
  json.copy(result, 20);
  binary.copy(result, 20 + length);
  return result;
}

test('catalog IDs bind self-contained GLB content and metadata stays detached without paths', async context => {
  const { directory, bytes } = await fixture(context);
  await writeFile(join(directory, 'duplicate.glb'), bytes);
  await writeFile(join(directory, 'ignored.txt'), 'not an asset');
  const catalog = await createAgentAssetCatalog(directory);
  const listing = catalog.list();
  assert.equal(listing.assets.length, 1);
  assert.match(listing.assets[0].assetId, /^[a-f0-9]{64}$/);
  assert.equal(listing.assets[0].meshes, 1);
  assert.doesNotMatch(JSON.stringify(listing), /crucible-catalog-/);
  const id = listing.assets[0].assetId;
  listing.assets[0].name = 'changed';
  assert.equal(catalog.list().assets[0].name, 'cube.glb');
  assert.deepEqual(await catalog.read(id), bytes);
  await assert.rejects(catalog.read('../cube.glb'), /Unknown asset/);
});

test('changed bytes cannot silently reuse a catalog digest', async context => {
  const { directory, bytes } = await fixture(context);
  const catalog = await createAgentAssetCatalog(directory);
  const id = catalog.list().assets[0].assetId;
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  await writeFile(join(directory, 'cube.glb'), changed);
  await assert.rejects(catalog.read(id), /bytes changed/);
});

test('catalog rejects external resources and malformed or over-budget GLBs before browser loading', async context => {
  const { directory, bytes } = await fixture(context);
  await writeFile(join(directory, 'cube.glb'), withDocument(bytes, document => { document.buffers[0].uri = 'https://example.invalid/private'; }));
  await assert.rejects(createAgentAssetCatalog(directory), /embed all/);
  await writeFile(join(directory, 'cube.glb'), Buffer.alloc(AGENT_ASSET_LIMITS.maxBytes + 1));
  await assert.rejects(createAgentAssetCatalog(directory), error => error instanceof RangeError
    && error.message.includes('cube.glb: Asset is 67108865 bytes, over the catalog maxBytes 67108864 (64 MiB)'));
  await writeFile(join(directory, 'cube.glb'), Buffer.alloc(28));
  await assert.rejects(createAgentAssetCatalog(directory), /complete glTF/);
});

test('declared clip metadata stays bounded even when a GLB contains many animation declarations', async context => {
  const { directory, bytes } = await fixture(context);
  await writeFile(join(directory, 'cube.glb'), withDocument(bytes, document => {
    document.animations = Array.from({ length: 100000 }, () => ({ name: 'x'.repeat(100) }));
  }));
  const catalog = await createAgentAssetCatalog(directory);
  const listing = catalog.list();
  assert.equal(listing.assets[0].animationCount, 100000);
  assert.equal(listing.assets[0].animations.length, 16);
  assert.equal(listing.assets[0].animationsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(listing)) < 4096);
  await assert.rejects(catalog.read(listing.assets[0].assetId), /100000 animation clips, over the catalog maxClips 256/);
});

test('catalog rejects linked assets and requires an explicitly absolute directory', async context => {
  const { directory } = await fixture(context);
  await assert.rejects(createAgentAssetCatalog('relative-assets'), /absolute/);
  await symlink(join(directory, 'cube.glb'), join(directory, 'linked.glb'), 'file');
  await assert.rejects(createAgentAssetCatalog(directory), /without links/);
});

test('the catalog limits are the documented values and never exceed the loadGltf defaults', () => {
  assert.deepEqual({ ...AGENT_ASSET_LIMITS }, {
    maxBytes: 64 * 1024 * 1024, maxAssets: 256, maxCombinedBytes: 64 * 1024 * 1024, maxVertices: 1_000_000, maxParts: 4096,
    maxTexturePixels: 4_194_304, maxJoints: 1024, maxClips: 256,
  });
  const defaults = GLTF_CAPABILITIES.limits;
  const { allowExternalResources, ...decodeLimits } = agentAssetDecodeOptions();
  assert.equal(allowExternalResources, false);
  for (const [name, value] of Object.entries(decodeLimits)) {
    assert.ok(value <= defaults[name], `${name} ${value} is above the loadGltf default ${defaults[name]}`);
    assert.equal(value, AGENT_ASSET_LIMITS[name]);
  }
});

test('no MCP script writes an asset limit as a literal number', async () => {
  const names = (await readdir(new URL('../scripts/', import.meta.url))).filter(name => /^agent-.*\.(mjs|js)$/.test(name));
  for (const name of names) {
    const source = await readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /maxVertices: 250000|maximumVertices: 250000|MAXIMUM_ASSET_BYTES = 16|MAXIMUM_BYTES = 16/, name);
  }
});

test('a decode limit error names the catalog limit and the value the file hit, with no code-only advice', async context => {
  const { bytes } = await fixture(context);
  const tight = { ...agentAssetDecodeOptions(), maxVertices: 4 };
  const failure = await parseGltf(new Uint8Array(bytes).buffer, tight).then(() => null, error => error);
  assert.ok(failure instanceof RangeError);
  const advised = withCatalogLimitAdvice(failure);
  assert.match(advised.message, /vertices \d+, over maxVertices 4/);
  assert.match(advised.message, new RegExp(`MCP catalog limits are maxBytes ${AGENT_ASSET_LIMITS.maxBytes}, maxVertices ${AGENT_ASSET_LIMITS.maxVertices}`));
  assert.doesNotMatch(advised.message, /Fix: pass/);
  const other = new Error('unrelated');
  assert.equal(withCatalogLimitAdvice(other), other);
});

test('a Radiance .hdr and a .cube file are listed as environment and look entries and read back by ID', async context => {
  const { directory } = await fixture(context);
  const radiance = await readFile(new URL('../assets/looks/studio-softbox.hdr', import.meta.url));
  const cube = await readFile(new URL('../assets/looks/noir.cube', import.meta.url));
  await writeFile(join(directory, 'room.hdr'), radiance);
  await writeFile(join(directory, 'grade.cube'), cube);
  const catalog = await createAgentAssetCatalog(directory);
  const entries = Object.fromEntries(catalog.list().assets.map(entry => [entry.name, entry]));
  assert.equal(entries['room.hdr'].kind, 'environment');
  assert.equal(entries['grade.cube'].kind, 'look');
  assert.deepEqual(await catalog.read(entries['room.hdr'].assetId), radiance);
});

test('an .hdr that is not Radiance data and a .cube that is not a 3D look are refused', async context => {
  const { directory } = await fixture(context);
  await writeFile(join(directory, 'fake.hdr'), Buffer.alloc(64, 1));
  await assert.rejects(createAgentAssetCatalog(directory), /Radiance/);
  await rm(join(directory, 'fake.hdr'));
  await writeFile(join(directory, 'fake.cube'), 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n'.padEnd(64, ' '));
  await assert.rejects(createAgentAssetCatalog(directory), /LUT_3D_SIZE/);
});

const KENNEY_BOAT_FOLDER = new URL('./fixtures/kenney-boat/', import.meta.url);

async function boatFixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-catalog-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await cp(KENNEY_BOAT_FOLDER, directory, { recursive: true });
  return directory;
}

test('a Kenney GLB loads with the colormap that sits next to it, embedded into the stored asset', async context => {
  const directory = await boatFixture(context);
  const catalog = await createAgentAssetCatalog(directory);
  const listing = catalog.list();
  assert.equal(listing.assets.length, 1);
  assert.equal(listing.assets[0].images, 1);
  const stored = await catalog.read(listing.assets[0].assetId);
  const jsonLength = stored.readUInt32LE(12);
  const document = JSON.parse(stored.subarray(20, 20 + jsonLength).toString('utf8'));
  assert.equal(document.images[0].uri, undefined);
  assert.equal(document.images[0].mimeType, 'image/png');
  const view = document.bufferViews[document.images[0].bufferView];
  const binaryStart = 20 + jsonLength + 8;
  const pngStart = binaryStart + view.byteOffset;
  assert.deepEqual(stored.subarray(pngStart, pngStart + 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(view.byteOffset % 4, 0);
  assert.equal(document.buffers[0].byteLength, stored.length - binaryStart);
  assert.equal(listing.assets[0].assetId, createHash('sha256').update(stored).digest('hex'));
});

test('a GLB texture that is missing, remote, outside the folder or not an image is refused with the file and the fix (a missing one is skipped, see #2072)', async context => {
  const directory = await boatFixture(context);
  const boat = await readFile(join(directory, 'boat-fishing-small.glb'));
  const attempts = [
    ['https://example.invalid/colormap.png', /remote or embedded address.*relative path/],
    ['data:image/png;base64,AAAA', /remote or embedded address/],
    ['../colormap.png', /leaves the GLB's folder.*relative path/],
    ['Textures/../../colormap.png', /leaves the GLB's folder/],
    ['%2e%2e/colormap.png', /leaves the GLB's folder/],
    ['/etc/colormap.png', /leaves the GLB's folder/],
    ['C:\\colormap.png', /remote or embedded address/],
  ];
  for (const [uri, message] of attempts) {
    await writeFile(join(directory, 'boat-fishing-small.glb'), withDocument(boat, document => { document.images[0].uri = uri; }));
    await assert.rejects(createAgentAssetCatalog(directory), message, uri);
  }
  await writeFile(join(directory, 'Textures', 'notes.png'), 'not an image');
  await writeFile(join(directory, 'boat-fishing-small.glb'), withDocument(boat, document => { document.images[0].uri = 'Textures/notes.png'; }));
  await assert.rejects(createAgentAssetCatalog(directory), /not a PNG, JPEG or WebP/);
});

test('a GLB whose texture is missing is skipped with the fix while the good GLB still lists, and naming it directly keeps the error (#2072)', async context => {
  const directory = await boatFixture(context);
  const boat = await readFile(join(directory, 'boat-fishing-small.glb'));
  await writeFile(join(directory, 'bad.glb'), withDocument(boat, document => { document.images[0].uri = 'Textures/absent.png'; }));
  const listing = (await createAgentAssetCatalog(directory)).list();
  assert.deepEqual(listing.assets.map(asset => asset.name), ['boat-fishing-small.glb']);
  assert.deepEqual(listing.skipped, [{
    name: 'bad.glb',
    reason: "bad.glb: image \"Textures/absent.png\" was not found next to the GLB. Copy that file into the GLB's folder at the same relative path.",
  }]);
  await assert.rejects(readCatalogFile(directory, 'bad.glb'), /bad\.glb: image "Textures\/absent\.png" was not found next to the GLB\. Copy that file into the GLB's folder/);
});

test('a texture folder that links out of the catalog folder is refused', async context => {
  const directory = await boatFixture(context);
  const outside = await mkdtemp(join(tmpdir(), 'crucible-outside-'));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await cp(join(directory, 'Textures', 'colormap.png'), join(outside, 'colormap.png'));
  await rm(join(directory, 'Textures'), { recursive: true });
  try {
    await symlink(outside, join(directory, 'Textures'), 'junction');
  } catch (error) {
    context.skip(`links are not allowed here: ${error.code}`);
    return;
  }
  await assert.rejects(createAgentAssetCatalog(directory), /leaves the GLB's folder|without links/);
});

test('sibling textures stay inside the asset byte bound', async context => {
  const directory = await boatFixture(context);
  const boat = await readFile(join(directory, 'boat-fishing-small.glb'));
  const huge = Buffer.alloc(AGENT_ASSET_LIMITS.maxBytes - boat.length + 8);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(huge);
  await writeFile(join(directory, 'Textures', 'colormap.png'), huge);
  await assert.rejects(createAgentAssetCatalog(directory), error => error instanceof RangeError && /boat-fishing-small\.glb: with its images next to it the asset reaches/.test(error.message));
});

test('size() reports the bytes read() returns for a GLB with sibling images (#1282)', async context => {
  const directory = await boatFixture(context);
  const catalog = await createAgentAssetCatalog(directory);
  const { assetId } = catalog.list().assets[0];
  const onDisk = (await readFile(join(directory, 'boat-fishing-small.glb'))).length;
  const stored = await catalog.read(assetId);
  assert.ok(stored.length > onDisk, 'the stored GLB embeds the colormap, so it is larger than the file');
  assert.equal(await catalog.size(assetId), stored.length);
});

test('size() equals read().length for a pack file entry of a GLB with sibling images (#1282)', async context => {
  const directory = await boatFixture(context);
  const directoryCatalog = await createAgentAssetCatalog(directory);
  const metadata = directoryCatalog.list().assets[0];
  const packFile = { assetId: metadata.assetId, directory, filename: 'boat-fishing-small.glb', metadata };
  const packCatalog = await createAgentAssetCatalog(null, [packFile]);
  const stored = await packCatalog.read(metadata.assetId);
  assert.equal(await packCatalog.size(metadata.assetId), stored.length);
});

function pngHeaderOnly(width, height, salt = 0) {
  const header = Buffer.alloc(33);
  header[30] = salt;
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  return header;
}

test('an .hdr over 8 MiB and a .cube over 4 MiB are skipped with their own advice and the other assets stay listed (#1313)', async context => {
  const { directory } = await fixture(context);
  const mebibyte = 1024 * 1024;
  const radiance = await readFile(new URL('../assets/looks/studio-softbox.hdr', import.meta.url));
  await writeFile(join(directory, 'huge.hdr'), Buffer.concat([radiance, Buffer.alloc(8 * mebibyte)]));
  await writeFile(join(directory, 'huge.cube'), Buffer.concat([Buffer.from('LUT_3D_SIZE 2\n'), Buffer.alloc(4 * mebibyte)]));
  await writeFile(join(directory, 'room.hdr'), radiance);
  const listing = (await createAgentAssetCatalog(directory)).list();
  assert.deepEqual(listing.assets.map(asset => asset.name).sort(), ['cube.glb', 'room.hdr']);
  assert.deepEqual(listing.skipped.map(entry => entry.name).sort(), ['huge.cube', 'huge.hdr']);
  const reasons = Object.fromEntries(listing.skipped.map(entry => [entry.name, entry.reason]));
  assert.match(reasons['huge.hdr'], /at most 8 MiB; this one is 8\.\d MiB\. Use a 2k or smaller HDRI\./);
  assert.doesNotMatch(reasons['huge.hdr'], /LUT/);
  assert.match(reasons['huge.cube'], /at most 4 MiB; this one is 4\.\d MiB\. Use a smaller LUT/);
  assert.doesNotMatch(reasons['huge.cube'], /HDRI/);
});

test('a 2k HDRI of the size Poly Haven ships is listed, so the advice in the message is a size the catalog accepts (#1313)', async context => {
  const { directory } = await fixture(context);
  const radiance = await readFile(new URL('../assets/looks/studio-softbox.hdr', import.meta.url));
  const studioSmall2kBytes = 6673807;
  await writeFile(join(directory, 'studio-2k.hdr'), Buffer.concat([radiance, Buffer.alloc(studioSmall2kBytes - radiance.length)]));
  const listing = (await createAgentAssetCatalog(directory)).list();
  assert.ok(listing.assets.some(asset => asset.name === 'studio-2k.hdr' && asset.kind === 'environment'));
  assert.equal('skipped' in listing, false);
});

test('a catalog with nothing skipped has no skipped field (#1313)', async context => {
  const { directory } = await fixture(context);
  assert.equal('skipped' in (await createAgentAssetCatalog(directory)).list(), false);
});

test('an image whose header declares a frame over the sequence limits is skipped before any decode (#1313)', async context => {
  const { directory } = await fixture(context);
  await writeFile(join(directory, 'huge.png'), pngHeaderOnly(16000, 16000));
  await writeFile(join(directory, 'wide.png'), pngHeaderOnly(2049, 8));
  await writeFile(join(directory, 'ok.png'), pngHeaderOnly(2048, 2048));
  const listing = (await createAgentAssetCatalog(directory)).list();
  assert.deepEqual(listing.assets.map(asset => asset.name).sort(), ['cube.glb', 'ok.png']);
  const reasons = Object.fromEntries(listing.skipped.map(entry => [entry.name, entry.reason]));
  assert.match(reasons['huge.png'], /16000x16000; frames are at most 2048 pixels on a side/);
  assert.match(reasons['wide.png'], /2049x8; frames are at most 2048/);
});

test('image files count against the frame cap, not the 64 file cap of the other assets (#1852)', async context => {
  const { directory } = await fixture(context);
  for (let index = 0; index < 100; index++) await writeFile(join(directory, `frame-${String(index).padStart(3, '0')}.png`), pngHeaderOnly(2, 2, index));
  const listing = (await createAgentAssetCatalog(directory)).list();
  assert.equal(listing.assets.filter(asset => asset.kind === 'image').length, 100);
});

function packGlb(name, assetId) {
  return { directory: tmpdir(), filename: name, assetId, metadata: Object.freeze({ assetId, name, bytes: 10, kind: 'glb' }) };
}

test('resolveName finds a GLB by its exact name, including a pack path (#1843)', async context => {
  const { directory } = await fixture(context);
  const catalog = await createAgentAssetCatalog(directory, [packGlb('farm/sheep.glb', 'e'.repeat(64))]);
  assert.equal(catalog.resolveName('cube.glb'), catalog.list().assets.find(asset => asset.name === 'cube.glb').assetId);
  assert.equal(catalog.resolveName('farm/sheep.glb'), 'e'.repeat(64));
});

test('resolveName refuses two GLBs with one name and says to pass the id (#1843)', async context => {
  const { directory } = await fixture(context);
  const catalog = await createAgentAssetCatalog(directory, [packGlb('sheep.glb', 'e'.repeat(64)), packGlb('sheep.glb', 'f'.repeat(64))]);
  assert.throws(() => catalog.resolveName('sheep.glb'), /2 catalog GLBs are named "sheep\.glb".*Pass asset\.id/);
});

test('resolveName refuses an unknown or non-string name with a hint (#1843)', async context => {
  const { directory } = await fixture(context);
  const catalog = await createAgentAssetCatalog(directory);
  assert.throws(() => catalog.resolveName('cub'), /Near names: "cube\.glb"/);
  assert.throws(() => catalog.resolveName('tree.glb'), /Run scene_asset_catalog/);
  assert.throws(() => catalog.resolveName(7), TypeError);
});

test('an unnamed clip has the same name in the catalog as in the decoded asset (#2075)', async context => {
  const { directory, bytes } = await fixture(context);
  const animations = [{ channels: [], samplers: [] }, { name: 'Walk', channels: [], samplers: [] }, { name: '', channels: [], samplers: [] }];
  await writeFile(join(directory, 'cube.glb'), withDocument(bytes, document => { document.animations = animations; }));
  const catalog = await createAgentAssetCatalog(directory);
  const listed = catalog.list().assets[0].animations.map(clip => clip.name);
  assert.deepEqual(listed, ['animation_0', 'Walk', 'animation_2']);
  const decoded = createClips({ animations }, () => undefined, () => undefined).map(clip => clip.name);
  assert.deepEqual(decoded, listed);
});

async function writeCatalogStubs(directory, { glbs, hdrs, notes }) {
  for (let index = 0; index < glbs; index += 1) {
    const variant = exportGlb([{ name: 'Cube', geometry: box(0), matrix: mat4.create(), material: { color: [(index + 1) / 97, 0.5, 0.7], roughness: 0.5, metallic: 0 } }]);
    await writeFile(join(directory, `variant-${String(index).padStart(3, '0')}.glb`), Buffer.from(variant));
  }
  for (let index = 0; index < hdrs; index += 1) await writeFile(join(directory, `sky-${String(index).padStart(3, '0')}.hdr`), Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n${String(index)}\u0000\u0000\u0000\u0000`, 'latin1'));
  for (let index = 0; index < notes; index += 1) await writeFile(join(directory, index === 0 ? 'SOURCES.md' : `notes-${index}.txt`), 'credits');
}

test('a catalog folder with more than 64 asset files indexes them all, and .md and .txt files are not counted (#2989)', async context => {
  const { directory } = await fixture(context);
  await writeCatalogStubs(directory, { glbs: 30, hdrs: 45, notes: 5 });
  const catalog = await createAgentAssetCatalog(directory);
  const listing = catalog.list();
  assert.equal(listing.assets.length, 76, 'cube plus 30 GLB variants plus 45 HDRs');
  assert.equal(listing.maximumAssets, AGENT_ASSET_LIMITS.maxAssets);
  assert.ok(!listing.assets.some(asset => /\.(md|txt)$/.test(asset.name)));
});

test('the catalog index stays bounded: past its cap the error counts files by extension and names them (#2989)', async context => {
  const { directory } = await fixture(context);
  await writeCatalogStubs(directory, { glbs: 0, hdrs: AGENT_ASSET_LIMITS.maxAssets, notes: 3 });
  await assert.rejects(createAgentAssetCatalog(directory), error => {
    assert.ok(error instanceof RangeError);
    assert.ok(error.message.includes(`has ${AGENT_ASSET_LIMITS.maxAssets + 1} files other than images (1 .glb, ${AGENT_ASSET_LIMITS.maxAssets} .hdr)`), error.message);
    assert.match(error.message, /Counted: cube\.glb, sky-000\.hdr/);
    assert.match(error.message, /and \d+ more/);
    assert.match(error.message, /Move the GLB, BVH, HDR and CUBE files the project does not use out of the --assets directory/);
    return true;
  });
});
