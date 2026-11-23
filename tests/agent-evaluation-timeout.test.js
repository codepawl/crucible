import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_TIMEOUT_MS_PER_MIB,
  GRID_VOLUME_TIMEOUT_FACTOR,
  MAXIMUM_ASSET_TIMEOUT_MS,
  assetDataBytes,
  assetTimeoutAllowanceMs,
  slowAssetsNote,
  operationsAddGridVolume,
  previewCallTimeoutMs,
  recipeHasGridVolume,
} from '../scripts/agent-evaluation-timeout.mjs';

const PLAIN_TIMEOUT_MS = 30000;
const BAKE_TIMEOUT_MS = 150000;

test('a grid volume in a created recipe is found, other volumes and recipes are not', () => {
  assert.equal(recipeHasGridVolume({ environment: { localVolumes: [{ shape: 'box' }, { shape: 'grid', grid: 'fireball.bin' }] } }), true);
  assert.equal(recipeHasGridVolume({ environment: { localVolumes: [{ shape: 'box' }, { shape: 'sphere' }] } }), false);
  assert.equal(recipeHasGridVolume({ environment: {} }), false);
  assert.equal(recipeHasGridVolume({}), false);
  assert.equal(recipeHasGridVolume(undefined), false);
});

test('an add-explosion operation counts as adding a grid volume, other operations do not', () => {
  assert.equal(operationsAddGridVolume([{ type: 'add-node' }, { type: 'add-explosion' }]), true);
  assert.equal(operationsAddGridVolume([{ type: 'add-node' }]), false);
  assert.equal(operationsAddGridVolume(undefined), false);
});

test('a call that adds a grid volume gets twice a plain call, and a bake keeps its own longer deadline', () => {
  const plain = previewCallTimeoutMs({ bakes: false, addsGridVolume: false, plainTimeoutMs: PLAIN_TIMEOUT_MS, bakeTimeoutMs: BAKE_TIMEOUT_MS });
  const withGridVolume = previewCallTimeoutMs({ bakes: false, addsGridVolume: true, plainTimeoutMs: PLAIN_TIMEOUT_MS, bakeTimeoutMs: BAKE_TIMEOUT_MS });
  const withBake = previewCallTimeoutMs({ bakes: true, addsGridVolume: true, plainTimeoutMs: PLAIN_TIMEOUT_MS, bakeTimeoutMs: BAKE_TIMEOUT_MS });
  assert.equal(plain, PLAIN_TIMEOUT_MS);
  assert.equal(GRID_VOLUME_TIMEOUT_FACTOR, 2);
  assert.equal(withGridVolume, 2 * plain);
  assert.equal(withBake, BAKE_TIMEOUT_MS);
});

const MEBIBYTE = 1024 ** 2;

test('placed catalog files add time per MiB to a plain or grid-volume call, up to a fixed maximum (#2896)', () => {
  const hero = 12 * MEBIBYTE;
  const plainWithHero = previewCallTimeoutMs({ bakes: false, addsGridVolume: false, plainTimeoutMs: PLAIN_TIMEOUT_MS, bakeTimeoutMs: BAKE_TIMEOUT_MS, assetBytes: hero });
  const gridWithHero = previewCallTimeoutMs({ bakes: false, addsGridVolume: true, plainTimeoutMs: PLAIN_TIMEOUT_MS, bakeTimeoutMs: BAKE_TIMEOUT_MS, assetBytes: hero });
  const hugeAssets = previewCallTimeoutMs({ bakes: false, addsGridVolume: false, plainTimeoutMs: PLAIN_TIMEOUT_MS, bakeTimeoutMs: BAKE_TIMEOUT_MS, assetBytes: 1024 * MEBIBYTE });
  const bakeWithHero = previewCallTimeoutMs({ bakes: true, addsGridVolume: false, plainTimeoutMs: PLAIN_TIMEOUT_MS, bakeTimeoutMs: BAKE_TIMEOUT_MS, assetBytes: hero });
  assert.equal(plainWithHero, PLAIN_TIMEOUT_MS + 12 * ASSET_TIMEOUT_MS_PER_MIB);
  assert.equal(gridWithHero, 2 * PLAIN_TIMEOUT_MS + 12 * ASSET_TIMEOUT_MS_PER_MIB);
  assert.equal(hugeAssets, PLAIN_TIMEOUT_MS + MAXIMUM_ASSET_TIMEOUT_MS);
  assert.equal(bakeWithHero, BAKE_TIMEOUT_MS);
  assert.equal(assetTimeoutAllowanceMs(0), 0);
});

test('the bytes of an assetData map come from its base64 lengths', () => {
  assert.equal(assetDataBytes({ first: Buffer.alloc(3000).toString('base64'), second: Buffer.alloc(1200).toString('base64') }), 4200);
  assert.equal(assetDataBytes(undefined), 0);
});

test('a timed-out call names its three largest assets by size and says what to shrink', () => {
  const note = slowAssetsNote([{ name: 'small.glb', bytes: MEBIBYTE }, { name: 'hero.glb', bytes: 22 * MEBIBYTE }, { name: 'tree.glb', bytes: 3 * MEBIBYTE }, { name: 'rock.glb', bytes: 2 * MEBIBYTE }]);
  assert.match(note, /hero\.glb \(22\.0 MiB\), tree\.glb \(3\.0 MiB\), rock\.glb \(2\.0 MiB\)/);
  assert.doesNotMatch(note, /small\.glb/);
  assert.match(note, /Shrink their textures/);
  assert.equal(slowAssetsNote([]), '');
});
