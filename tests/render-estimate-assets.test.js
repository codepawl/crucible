import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentAssetCatalog, describeCatalogFile, glbImageResidentMiB, glbTriangleCount } from '../scripts/agent-asset-catalog.mjs';
import { estimateRenderJob, sceneSizeFrom } from '../scripts/agent-render-estimate.mjs';
import { normalizeJobSettings } from '../scripts/agent-render-jobs.mjs';
import { readImageDimensions } from '../src/image-header.js';
import { gridGlb } from './fixtures/grid-glb.js';

const ASSET_ID = 'b'.repeat(64);
const emptyScene = { counts: { nodes: 1, parts: 1, materials: 1, vertices: 0 }, look: {}, nodes: [{ id: 'plate', triangles: 0 }], assets: [{ assetId: ASSET_ID, parts: 1 }] };

function texturedDocument(imageCount) {
  return {
    accessors: [{ count: 44000, type: 'VEC3' }, { count: 264000, type: 'SCALAR' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }],
    images: Array.from({ length: imageCount }, () => ({ bufferView: 0, mimeType: 'image/png' })),
  };
}

test('a GLB triangle count comes from accessor counts, per node that uses the mesh', () => {
  assert.equal(glbTriangleCount(texturedDocument(1)), 88000);
  const twoNodes = { ...texturedDocument(0), nodes: [{ mesh: 0 }, { mesh: 0 }] };
  assert.equal(glbTriangleCount(twoNodes), 176000);
  const unindexedStrip = { accessors: [{ count: 10 }], meshes: [{ primitives: [{ mode: 5, attributes: { POSITION: 0 } }] }] };
  assert.equal(glbTriangleCount(unindexedStrip), 8);
  assert.equal(glbTriangleCount({}), 0);
});

test('the catalog reports a GLB triangle and image count without reading its buffers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'estimate-assets-'));
  try {
    await writeFile(join(directory, 'grid.glb'), gridGlb(11));
    const catalog = await createAgentAssetCatalog(directory);
    const entry = catalog.list().assets.find(candidate => candidate.name === 'grid.glb');
    const described = await catalog.describeSize(entry.assetId);
    assert.equal(described.triangles, 200);
    assert.equal(described.images, 0);
    assert.equal(describeCatalogFile('x.glb', { bytes: glbWithImage(pngHeader(2, 2)).bytes, document: texturedDocument(2), assetId: ASSET_ID }).images, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an estimate counts the triangles and textures of a placed GLB (#3321)', () => {
  const settings = normalizeJobSettings({ kind: 'video', width: 448, height: 504, fps: 24, duration: 5 }, [], { format: 'crucible.scene' });
  const withoutFootprint = sceneSizeFrom(emptyScene, {});
  assert.equal(withoutFootprint.triangles, 0);
  assert.equal(withoutFootprint.textures, 0);
  const byAssetId = new Map([[ASSET_ID, { triangles: 88000, textures: 1, textureMiB: 4 }]]);
  const withFootprint = sceneSizeFrom(emptyScene, {}, { byAssetId });
  assert.equal(withFootprint.triangles, 88000);
  assert.equal(withFootprint.textures, 1);
  const before = estimateRenderJob({ size: withoutFootprint, settings, backend: 'gpu' });
  const after = estimateRenderJob({ size: withFootprint, settings, backend: 'gpu' });
  assert.ok(after.peakMemoryMiB > before.peakMemoryMiB);
  assert.ok(after.seconds > before.seconds);
  const manyImages = sceneSizeFrom(emptyScene, {}, { byAssetId: new Map([[ASSET_ID, { triangles: 88000, textures: 6, textureMiB: 24 }]]) });
  assert.ok(estimateRenderJob({ size: manyImages, settings, backend: 'gpu' }).peakMemoryMiB > after.peakMemoryMiB);
});

test('copies of one placed GLB count its triangles each and its textures once', () => {
  const copies = { ...emptyScene, assets: [1, 2, 3].map(() => ({ assetId: ASSET_ID, parts: 1 })) };
  const size = sceneSizeFrom(copies, {}, { byAssetId: new Map([[ASSET_ID, { triangles: 1000, textures: 2 }]]) });
  assert.equal(size.triangles, 3000);
  assert.equal(size.textures, 2);
});

const DEFAULT_MEMORY_MIB = 192;

function pngHeader(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/** A GLB whose only content is one embedded image: the header of a PNG of the given size, with no pixel data behind it. */
function glbWithImage(image, imageView = { buffer: 0, byteOffset: 0, byteLength: image.length }) {
  const document = { asset: { version: '2.0' }, images: [{ bufferView: 0, mimeType: 'image/png' }], bufferViews: [imageView], buffers: [{ byteLength: image.length }] };
  const json = Buffer.from(JSON.stringify(document));
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const padded = Buffer.concat([image, Buffer.alloc((4 - (image.length % 4)) % 4)]);
  const prefix = Buffer.alloc(20);
  prefix.writeUInt32LE(0x46546c67, 0);
  prefix.writeUInt32LE(2, 4);
  prefix.writeUInt32LE(12 + 8 + paddedJson.length + 8 + padded.length, 8);
  prefix.writeUInt32LE(paddedJson.length, 12);
  prefix.writeUInt32LE(0x4e4f534a, 16);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(padded.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  const bytes = Buffer.concat([prefix, paddedJson, binaryHeader, padded]);
  return { bytes, document };
}

function peakMemoryOf(textureMiB) {
  const settings = normalizeJobSettings({ kind: 'video', width: 448, height: 504, fps: 24, duration: 5 }, [], { format: 'crucible.scene' });
  const byAssetId = new Map([[ASSET_ID, { triangles: 100, textures: 1, textureMiB }]]);
  return estimateRenderJob({ size: sceneSizeFrom(emptyScene, {}, { byAssetId }), settings, backend: 'gpu' }).peakMemoryMiB;
}

test('image sizes come from the embedded headers, with mips, and a 4096 square image refuses the default memory budget (#3321)', () => {
  const large = glbWithImage(pngHeader(4096, 4096));
  const small = glbWithImage(pngHeader(2, 2));
  const largeMiB = glbImageResidentMiB(large.bytes, large.document);
  assert.ok(Math.abs(largeMiB - (4096 * 4096 * 4 * 4) / 3 / 1048576) < 0.001);
  assert.ok(glbImageResidentMiB(small.bytes, small.document) < 0.001);
  assert.ok(peakMemoryOf(largeMiB) > DEFAULT_MEMORY_MIB);
  assert.ok(peakMemoryOf(glbImageResidentMiB(small.bytes, small.document)) <= DEFAULT_MEMORY_MIB);
});

test('an image with no readable header or no buffer view counts the 4 MiB fallback', () => {
  const unreadable = glbWithImage(Buffer.alloc(64));
  assert.equal(glbImageResidentMiB(unreadable.bytes, unreadable.document), 4);
  const noView = { ...unreadable.document, images: [{ mimeType: 'image/png' }] };
  assert.equal(glbImageResidentMiB(unreadable.bytes, noView), 4);
});

test('the header read stays bounded: a view of megabytes is read for 16 KiB at most', () => {
  const large = glbWithImage(Buffer.concat([pngHeader(8, 8), Buffer.alloc(5 * 1048576)]));
  assert.ok(glbImageResidentMiB(large.bytes.subarray(0, large.bytes.length), large.document) < 0.001);
});

test('a view with a negative, fractional or non-numeric byteOffset counts the fallback', () => {
  const image = glbWithImage(pngHeader(4096, 4096));
  for (const byteOffset of [-4, 1.5, 'x', null, Number.NaN]) {
    const document = { ...image.document, bufferViews: [{ buffer: 0, byteOffset, byteLength: 33 }] };
    assert.equal(glbImageResidentMiB(image.bytes, document), byteOffset === null ? (4096 * 4096 * 4 * 4) / 3 / 1048576 : 4, String(byteOffset));
  }
});

test('a JPEG frame header (SOF0) and a KTX2 header give their sizes', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x04, 0x00, 0x02, 0x00, 0x01, 0x01, 0x11, 0x00]);
  assert.deepEqual(readImageDimensions(jpeg), { width: 512, height: 1024 });
  const jpegGlb = glbWithImage(jpeg);
  assert.ok(Math.abs(glbImageResidentMiB(jpegGlb.bytes, jpegGlb.document) - (512 * 1024 * 4 * 4) / 3 / 1048576) < 0.001);
  const ktx2 = Buffer.alloc(80);
  Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ktx2);
  ktx2.writeUInt32LE(2048, 20);
  ktx2.writeUInt32LE(1024, 24);
  const ktx2Glb = glbWithImage(ktx2);
  assert.ok(Math.abs(glbImageResidentMiB(ktx2Glb.bytes, ktx2Glb.document) - (2048 * 1024 * 4 * 4) / 3 / 1048576) < 0.001);
});
