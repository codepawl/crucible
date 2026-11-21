import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const DESK_PATH = new URL('../public/desk-flat-lay.glb', import.meta.url);
const SKY_PATH = new URL('../public/hdri/kloofendal_28d_misty_puresky_1k.hdr', import.meta.url);
const VIEWER_PATH = new URL('../src/asset-viewer.js', import.meta.url);
const FIVE_MEGABYTES = 5 * 1000 * 1000;
const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

function readGlbDocument(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67, 'desk-flat-lay.glb is a binary glTF');
  const jsonLength = view.getUint32(GLB_HEADER_BYTES, true);
  const jsonStart = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES;
  return JSON.parse(new TextDecoder().decode(bytes.subarray(jsonStart, jsonStart + jsonLength)));
}

test('the asset viewer demo desk is a textured GLB that stays under 5 MB', async () => {
  const bytes = await readFile(DESK_PATH);
  assert.ok(bytes.length < FIVE_MEGABYTES, `desk-flat-lay.glb is ${bytes.length} bytes; keep the demo under 5 MB so the page opens fast`);
  const document = readGlbDocument(bytes);
  assert.ok(document.materials.some(material => material.pbrMetallicRoughness?.baseColorTexture), 'the desk keeps its base color textures');
  assert.ok(document.materials.some(material => material.normalTexture), 'the desk keeps its normal maps');
  assert.ok(document.nodes.length >= 5, 'the desk keeps the table, the camera and the props as separate nodes');
  // Two textures keep an alpha channel and stay PNG: the spectacles' lenses and the soft contact shadows under the props; every other texture is a JPEG.
  const pngImages = document.images.filter(image => image.mimeType === 'image/png');
  assert.ok(pngImages.length <= 2, `${pngImages.length} PNG textures; only the spectacles' and the contact shadow's alpha textures may stay PNG`);
  for (const image of document.images) assert.match(image.mimeType, /^image\/(jpeg|png)$/);
});

test('the viewer opens on the desk lit by the shipped misty sky', async () => {
  const viewer = await readFile(VIEWER_PATH, 'utf8');
  assert.match(viewer, /desk-flat-lay\.glb/);
  assert.match(viewer, /kloofendal_28d_misty_puresky_1k\.hdr/);
  const sky = await readFile(SKY_PATH);
  assert.equal(sky.subarray(0, 10).toString('latin1'), '#?RADIANCE', 'the sky is a Radiance HDR file');
});

test('a narrow canvas frames the demo desk with its own tighter focus box', async () => {
  const viewer = await readFile(VIEWER_PATH, 'utf8');
  assert.match(viewer, /portraitFocus: \{ minimum: \[/, 'the demo declares a portrait focus box for phones');
  assert.match(viewer, /aspect < 1 && setting\.portraitFocus/, 'frame() picks the portrait box on a canvas taller than wide');
});

test('the demo desk and its sky are credited as CC0 Poly Haven assets', async () => {
  const credits = await readFile(new URL('../public/textures/CREDITS.md', import.meta.url), 'utf8');
  for (const name of ['Camera_01', 'wooden_table_02', 'binder_notebook', 'postcard_set_01', 'round_spectacles', 'stationery_supplies', 'kloofendal_28d_misty_puresky']) {
    assert.ok(credits.includes(`polyhaven.com/a/${name}`), `${name} is credited`);
  }
  assert.match(credits, /CC0/);
});
