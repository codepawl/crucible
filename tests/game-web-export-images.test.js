import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentScene } from '../src/agent-scene.js';
import { gameImageIds, loadGameImages } from '../src/game-assets.js';
import { startGame } from '../src/game.js';
import { indexHtml, writeWebBuild } from '../scripts/web-export.mjs';

const IMAGE_ID = 'a189a728a793'.padEnd(64, '0');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function decodedFrame() {
  return { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(200) };
}

function texturedGameRecipe() {
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box' }],
    materials: [{ id: 'paint', color: [1, 1, 1], pattern: { type: 'graph', mapping: 'box', graph: { color: { image: { asset: IMAGE_ID, output: 'color' } } } } }],
    nodes: [{ id: 'creature', geometry: 'block', material: 'paint' }],
  }, {}, { sequenceFrames: new Map([[IMAGE_ID, decodedFrame()]]) });
  scene.apply([{ type: 'set-game', game: { player: { node: 'creature' } } }], { expectedRevision: scene.revision });
  return scene.exportRecipe();
}

// Reading the material's map bakes the graph, the way the real renderer does when it uploads textures.
function standInRenderer(canvas, parts) {
  for (const part of parts) void part.material.map;
  return { render() {}, resize() {}, updateParts() {}, replaceParts() {}, dispose() {} };
}

function withAnimationFrameStubs() {
  const previous = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  return () => {
    globalThis.requestAnimationFrame = previous.request;
    globalThis.cancelAnimationFrame = previous.cancel;
  };
}

test('gameImageIds lists the catalog images a material graph reads (#2832)', () => {
  assert.deepEqual(gameImageIds(texturedGameRecipe()), [IMAGE_ID]);
});

test('loadGameImages fetches and decodes each image by URL and names a missing URL (#2832)', async () => {
  const fetched = [];
  const images = await loadGameImages(texturedGameRecipe(), { [IMAGE_ID]: './assets/a.png' }, async url => { fetched.push(url); return PNG_BYTES; }, async (id, bytes) => {
    assert.equal(id, IMAGE_ID);
    assert.equal(bytes.length, PNG_BYTES.length);
    return decodedFrame();
  });
  assert.deepEqual(fetched, ['./assets/a.png']);
  assert.equal(images.get(IMAGE_ID).width, 2);
  await assert.rejects(loadGameImages(texturedGameRecipe(), {}, async () => PNG_BYTES, async () => decodedFrame()), /imageUrls has no URL for it/);
});

test('a started game builds a material graph from the decoded images, and fails without them (#2832)', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const options = { showStatus: false, replay: { version: 1, samples: 0, events: [] }, createRenderer: standInRenderer };
    await assert.rejects(startGame({}, texturedGameRecipe(), options), /image a189a728a793 was not loaded/);
    const game = await startGame({}, texturedGameRecipe(), { ...options, images: new Map([[IMAGE_ID, decodedFrame()]]) });
    game.dispose();
  } finally {
    restore();
  }
});

test('the web export writes the graph images beside the page and refuses a build without their bytes (#2832)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-image-export-'));
  const buildDirectory = join(directory, 'build');
  await mkdir(buildDirectory);
  await writeFile(join(buildDirectory, 'game.js'), 'export const startGame = () => {};');
  try {
    const recipe = texturedGameRecipe();
    await assert.rejects(writeWebBuild({ recipe, buildDirectory, outputDirectory: join(directory, 'refused') }), /needs the bytes of the catalog images the materials read \(a189a728a793\)/);
    const summary = await writeWebBuild({ recipe, buildDirectory, outputDirectory: join(directory, 'built'), images: new Map([[IMAGE_ID, PNG_BYTES]]) });
    const page = await readFile(join(directory, 'built', 'index.html'), 'utf8');
    assert.ok(page.includes(`const imageUrls = {"${IMAGE_ID}":"./assets/${IMAGE_ID}.png"};`));
    assert.ok(page.includes('assetUrls, imageUrls })'));
    assert.deepEqual([...await readFile(join(directory, 'built', 'assets', `${IMAGE_ID}.png`))], [...PNG_BYTES]);
    assert.equal(summary.files, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the exported page shows an error on screen instead of stalling silently (#2828)', () => {
  const page = indexHtml('game');
  assert.match(page, /addEventListener\('error', event => showFailure/);
  assert.match(page, /addEventListener\('unhandledrejection', event => showFailure/);
  assert.doesNotMatch(page, /imageUrls/);
});
