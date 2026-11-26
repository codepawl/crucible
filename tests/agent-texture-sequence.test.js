import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { normalizeMapSequence, sequenceFrameIds, sequenceFrameIndex, hasStreamedSequence, missingStreamedFrames, supplyStreamedFrame, retainStreamedWindow } from '../src/agent-texture-sequence.js';
import { TEXTURE_SEQUENCE_LIMITS } from '../src/texture-sequence-limits.js';
import { createAgentAssetCatalog } from '../scripts/agent-asset-catalog.mjs';

await loadAllAgentSceneModules();

const FRAME_IDS = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(64));

// Minimal headers that declare a 2x2 size, which is all the catalog reads before the preview decodes a frame.
function readableImages() {
  const png = Buffer.alloc(33, 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(png, 0);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(2, 16);
  png.writeUInt32BE(2, 20);
  const jpeg = Buffer.alloc(32, 2);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x11, 0x00]).copy(jpeg, 0);
  const webp = Buffer.alloc(32, 3);
  webp.write('RIFF', 0, 'latin1');
  webp.writeUInt32LE(webp.length - 8, 4);
  webp.write('WEBP', 8, 'latin1');
  webp.write('VP8X', 12, 'latin1');
  webp.writeUInt32LE(10, 16);
  webp.fill(0, 20, 30);
  webp[24] = 1;
  webp[27] = 1;
  return { png, jpeg, webp };
}

function solidFrame(red) {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([red, 0, 0, 255], offset);
  return { width: 2, height: 2, data };
}

function framePool() {
  return new Map(FRAME_IDS.map((id, index) => [id, solidFrame(index * 60)]));
}

function quadRecipe(sequence) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'screen', map: { sequence } }],
    nodes: [{ id: 'screen', geometry: 'quad', material: 'screen' }],
    camera: { eye: [0, 3, 3], target: [0, 0, 0], fov: 45 },
  };
}

test('frame index is floor(time * fps), looped by default and held on the last frame without loop', () => {
  const looped = { frames: FRAME_IDS, fps: 10, loop: true };
  const held = { ...looped, loop: false };
  assert.equal(sequenceFrameIndex(looped, 0), 0);
  assert.equal(sequenceFrameIndex(looped, 0.099), 0);
  assert.equal(sequenceFrameIndex(looped, 0.1), 1);
  assert.equal(sequenceFrameIndex(looped, 0.3), 3);
  assert.equal(sequenceFrameIndex(looped, 0.4), 0);
  assert.equal(sequenceFrameIndex(looped, null), 0);
  assert.equal(sequenceFrameIndex(held, 0.4), 3);
  assert.equal(sequenceFrameIndex(held, 100), 3);
  assert.equal(sequenceFrameIndex({ frames: FRAME_IDS, fps: 100, loop: false }, 0.03), 3);
});

test('a bad frame ID, frame count, fps or loop is rejected with a message that names the field', () => {
  const good = { frames: FRAME_IDS, fps: 12 };
  assert.deepEqual(normalizeMapSequence({ sequence: { ...good, frames: FRAME_IDS.map(id => id.toUpperCase()) } }).sequence.frames, FRAME_IDS);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, frames: [FRAME_IDS[0], 'not-an-id'] } }), /map\.sequence\.frames\[1\]: got "not-an-id"; expected the 64 hexadecimal characters/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, frames: [FRAME_IDS[0]] } }), /map\.sequence\.frames: got "1 frames"; expected a list of 2 to 4096 catalog image asset IDs/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, fps: 0 } }), /map\.sequence\.fps: got 0; expected a number above 0 and at most 60/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, fps: 61 } }), /map\.sequence\.fps: got 61; expected a number above 0 and at most 60/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, fps: Number.NaN } }), /fps/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, loop: 'yes' } }), /map\.sequence\.loop: got "yes"; expected true or false/);
  assert.throws(() => normalizeMapSequence({ sequence: { ...good, url: 'https://example.com/a.png' } }), /map\.sequence\.url: got "https:\/\/example\.com\/a\.png"; expected no such field; use one of frames, catalog, fps, loop/);
  assert.throws(() => normalizeMapSequence({ url: 'https://example.com/a.png' }), /map\.url: got "https:\/\/example\.com\/a\.png"; expected no such field; use one of sequence/);
});

test('the scene shows the frame of its motion time, reports it and seeks deterministically', () => {
  const scene = createAgentScene(quadRecipe({ frames: FRAME_IDS, fps: 10 }), {}, { sequenceFrames: framePool() });
  assert.deepEqual(scene.sequenceTextures().map(texture => texture.index), [0]);
  const descriptor = scene.parts[0].material.map;
  assert.equal(scene.sequenceTextures()[0].descriptor, descriptor);
  scene.sampleMotion(0.25);
  assert.equal(scene.sequenceTextures()[0].index, 2);
  assert.equal(scene.sequenceTextures()[0].image.data[0], 120);
  assert.equal(scene.parts[0].material.map, descriptor, 'the descriptor stays one object for the renderer');
  const reported = scene.inspect().textureSequences;
  assert.deepEqual(reported.map(({ material, frames, fps, loop, index }) => ({ material, frames, fps, loop, index })),
    [{ material: 'screen', frames: 4, fps: 10, loop: true, index: 2 }]);
  scene.sampleMotion(0.05);
  scene.sampleMotion(0.25);
  assert.equal(scene.sequenceTextures()[0].index, 2);
  scene.sampleMotion(null);
  assert.equal(scene.sequenceTextures()[0].index, 0);
});

test('the scene rejects frames that are missing or differ in size, and a map with a pattern', () => {
  assert.throws(() => createAgentScene(quadRecipe({ frames: FRAME_IDS, fps: 10 }), {}, { sequenceFrames: new Map() }), /was not loaded/);
  const mixed = framePool();
  mixed.set(FRAME_IDS[1], { width: 4, height: 4, data: new Uint8ClampedArray(64) });
  assert.throws(() => createAgentScene(quadRecipe({ frames: FRAME_IDS, fps: 10 }), {}, { sequenceFrames: mixed }), /map\.sequence\.frames: got "frames of different sizes in materia.*; expected frames that all measure 2x2/);
  const recipe = quadRecipe({ frames: FRAME_IDS, fps: 10 });
  recipe.materials[0].pattern = { type: 'bricks' };
  assert.throws(() => createAgentScene(recipe, {}, { sequenceFrames: framePool() }), /pattern: got \{"type":"bricks"\}; expected nothing, because a material takes a pattern or a map sequence/);
});

test('an edit can set a sequence and the frame IDs of a recipe are collected for the host', () => {
  const recipe = quadRecipe({ frames: FRAME_IDS, fps: 10 });
  assert.deepEqual(sequenceFrameIds(recipe).sort(), [...FRAME_IDS].sort());
  assert.deepEqual(sequenceFrameIds([{ type: 'set-material', id: 'screen', map: { sequence: { frames: [FRAME_IDS[0], 'zz'], fps: 1 } } }]), [FRAME_IDS[0]]);
});

test('the catalog lists PNG, JPEG and WebP images by content and rejects a mismatched extension', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-sequence-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { png, jpeg, webp } = readableImages();
  await writeFile(join(directory, 'frame-0.png'), png);
  await writeFile(join(directory, 'frame-1.jpg'), jpeg);
  await writeFile(join(directory, 'frame-2.webp'), webp);
  const catalog = await createAgentAssetCatalog(directory);
  const images = catalog.list().assets;
  assert.deepEqual(images.map(asset => [asset.name, asset.kind, asset.mimeType]),
    [['frame-0.png', 'image', 'image/png'], ['frame-1.jpg', 'image', 'image/jpeg'], ['frame-2.webp', 'image', 'image/webp']]);
  assert.deepEqual(await catalog.read(images[0].assetId), png);
  await writeFile(join(directory, 'wrong.png'), jpeg);
  await assert.rejects(createAgentAssetCatalog(directory), /extension must match/);
});

test('the catalog skips an image whose header gives no readable size and keeps a readable one', async context => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-sequence-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { png, jpeg, webp } = readableImages();
  const unreadableWebp = Buffer.from(webp);
  unreadableWebp.write('JUNK', 12, 'latin1');
  await writeFile(join(directory, 'good.png'), png);
  await writeFile(join(directory, 'stub.png'), Buffer.concat([png.subarray(0, 8), Buffer.alloc(32, 1)]));
  await writeFile(join(directory, 'stub.jpg'), Buffer.concat([jpeg.subarray(0, 4), Buffer.alloc(32, 2)]));
  await writeFile(join(directory, 'stub.webp'), unreadableWebp);
  const listing = (await createAgentAssetCatalog(directory)).list();
  assert.deepEqual(listing.assets.map(asset => asset.name), ['good.png']);
  assert.deepEqual(listing.skipped.map(entry => entry.name).sort(), ['stub.jpg', 'stub.png', 'stub.webp']);
  for (const entry of listing.skipped) {
    assert.match(entry.reason, /has no readable size in its header/);
    assert.doesNotMatch(entry.reason, /Resize it/);
  }
});

test('a non-finite time is refused instead of returning a NaN frame index', () => {
  const sequence = { frames: ['a', 'b', 'c'], fps: 10, loop: true };
  for (const time of [NaN, Infinity, -Infinity, '1']) {
    assert.throws(() => sequenceFrameIndex(sequence, time), /time: got .*finite number of seconds/, String(time));
  }
  assert.equal(sequenceFrameIndex(sequence, undefined), 0);
  assert.equal(sequenceFrameIndex(sequence, -1), 0);
});

test('a time so large that frame arithmetic overflows is refused instead of returning NaN', () => {
  const sequence = { frames: ['a', 'b', 'c'], fps: 24, loop: true };
  assert.throws(() => sequenceFrameIndex(sequence, 1e308), /time: got/);
});

function streamedIds(count) {
  return Array.from({ length: count }, (_, index) => index.toString(16).padStart(64, '0'));
}

function streamedRecipe(ids, fps = 30) {
  return quadRecipe({ frames: ids, fps });
}

test('a sequence may list up to the frame cap, and the error past it names the cap and what to pass', () => {
  assert.equal(TEXTURE_SEQUENCE_LIMITS.maxFrames, 4096);
  assert.equal(TEXTURE_SEQUENCE_LIMITS.maxSide, 2048);
  assert.doesNotThrow(() => normalizeMapSequence({ sequence: { frames: streamedIds(4096), fps: 30 } }));
  assert.throws(() => normalizeMapSequence({ sequence: { frames: streamedIds(4097), fps: 30 } }),
    /map\.sequence\.frames: got "4097 frames"; expected a list of 2 to 4096 catalog image asset IDs.*split it into several sequences/);
});

test('a sequence over the whole-sequence limit ships only its first frame and is flagged for the host', () => {
  const whole = streamedIds(TEXTURE_SEQUENCE_LIMITS.wholeSequenceFrames);
  const streamed = streamedIds(TEXTURE_SEQUENCE_LIMITS.wholeSequenceFrames + 1);
  assert.equal(sequenceFrameIds(streamedRecipe(whole)).length, whole.length);
  assert.deepEqual(sequenceFrameIds(streamedRecipe(streamed)), [streamed[0]]);
  assert.equal(hasStreamedSequence(streamedRecipe(whole)), false);
  assert.equal(hasStreamedSequence(streamedRecipe(streamed)), true);
  assert.equal(hasStreamedSequence([{ type: 'set-material', id: 'screen', map: { sequence: { frames: streamed, fps: 1 } } }]), true);
});

test('a streamed sequence decodes frames on demand, holds two at a time and shows the pixels of its own frame', () => {
  const ids = streamedIds(300);
  const pixelOf = index => (index * 7) % 256;
  const firstFrame = new Map([[ids[0], solidFrame(pixelOf(0))]]);
  const scene = createAgentScene(streamedRecipe(ids), {}, { sequenceFrames: firstFrame });
  const sequences = scene.sequenceTextures();
  assert.equal(sequences[0].streamed, true);
  const frameBytes = 2 * 2 * 4;
  let peakDecodedBytes = 0;
  for (let index = 0; index < ids.length; index++) {
    const time = index / 30;
    scene.sampleMotion(time);
    assert.equal(sequences[0].index, index);
    const missing = missingStreamedFrames(sequences, time);
    assert.deepEqual(missing, index === 0 ? [] : [ids[index]], 'only the frame of this time is requested, once');
    if (index > 0) {
      assert.throws(() => sequences[0].image, /frame \d+ not decoded"; expected frame \d+ \(\w+\) of streamed material screen supplied by the host/, 'a frame that was not supplied is never drawn silently');
    }
    for (const id of missing) supplyStreamedFrame(sequences, id, solidFrame(pixelOf(ids.indexOf(id))));
    const retained = retainStreamedWindow(sequences, time, TEXTURE_SEQUENCE_LIMITS.maxDecodedBytes);
    peakDecodedBytes = Math.max(peakDecodedBytes, retained);
    assert.equal(sequences[0].image.data[0], pixelOf(index), `frame ${index} shows the pixels of its own image`);
  }
  assert.ok(peakDecodedBytes <= 2 * frameBytes, `at most two frames stay decoded, held ${peakDecodedBytes} bytes`);
  assert.equal(scene.inspect().textureSequences[0].decodedFrames, 2);
});

test('a streamed frame of another size, or a window over the byte limit, is refused with the limit and what to change', () => {
  const ids = streamedIds(70);
  const scene = createAgentScene(streamedRecipe(ids), {}, { sequenceFrames: new Map([[ids[0], solidFrame(0)]]) });
  const sequences = scene.sequenceTextures();
  assert.throws(() => supplyStreamedFrame(sequences, ids[1], { width: 4, height: 4, data: new Uint8ClampedArray(64) }),
    /different|4x4 frame in material screen.*frames that all measure 2x2/);
  scene.sampleMotion(1 / 30);
  supplyStreamedFrame(sequences, ids[1], solidFrame(9));
  assert.throws(() => retainStreamedWindow(sequences, 1 / 30, 8), /map\.sequence\.frames: got "[\d.e-]+ MiB of decoded st.*; expected at most [\d.e-]+ MiB; use frames of at most 2048 pixels a side/);
});

test('a looped streamed sequence wraps back to frame 0, which is decoded again on demand', () => {
  const ids = streamedIds(70);
  const scene = createAgentScene(streamedRecipe(ids, 10), {}, { sequenceFrames: new Map([[ids[0], solidFrame(5)]]) });
  const sequences = scene.sequenceTextures();
  for (const index of [1, 2]) {
    scene.sampleMotion(index / 10);
    for (const id of missingStreamedFrames(sequences, index / 10)) supplyStreamedFrame(sequences, id, solidFrame(index));
    retainStreamedWindow(sequences, index / 10, TEXTURE_SEQUENCE_LIMITS.maxDecodedBytes);
  }
  scene.sampleMotion(70 / 10);
  assert.deepEqual(missingStreamedFrames(sequences, 7), [ids[0]]);
});

test('map.sequence works on unlit materials and drives emissiveMap when emission is positive (#3434)', () => {
  const unlitRecipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'screen', tag: 'unlit', map: { sequence: { frames: FRAME_IDS, fps: 10 } } }],
    nodes: [{ id: 'screen', geometry: 'quad', material: 'screen' }],
    camera: { eye: [0, 3, 3], target: [0, 0, 0], fov: 45 },
  };
  const unlitScene = createAgentScene(unlitRecipe, {}, { sequenceFrames: framePool() });
  const unlitMaterial = unlitScene.parts[0].material;
  assert.equal(unlitMaterial.tag, 'unlit');
  assert.equal(unlitMaterial.map, unlitScene.sequenceTextures()[0].descriptor);
  assert.equal(unlitMaterial.emissiveMap, undefined);

  const emissiveRecipe = {
    ...unlitRecipe,
    materials: [{ id: 'screen', tag: 'surface', color: [0, 0, 0], emissiveColor: [1, 1, 1], emission: 2, map: { sequence: { frames: FRAME_IDS, fps: 10 } } }],
  };
  const emissiveScene = createAgentScene(emissiveRecipe, {}, { sequenceFrames: framePool() });
  const emissiveMaterial = emissiveScene.parts[0].material;
  const descriptor = emissiveScene.sequenceTextures()[0].descriptor;
  assert.equal(emissiveMaterial.map, descriptor);
  assert.equal(emissiveMaterial.emissiveMap, descriptor);
  emissiveScene.apply([{ type: 'set-material', id: 'screen', emission: 0 }], { expectedRevision: emissiveScene.revision });
  assert.equal(emissiveScene.parts[0].material.emissiveMap, undefined);
});
