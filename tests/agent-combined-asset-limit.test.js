import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ASSET_LIMITS, assertCombinedAssetBytes, assertCombinedByteTotal, assetBytesLimitMessage, combinedAssetBytes, combinedAssetBytesLimitMessage, configureAssetByteLimit, resetAssetByteLimit, sceneAssetBytesLimitMessage } from '../src/agent-asset-limits.js';

const MEBIBYTE = 1024 * 1024;

function base64OfSize(byteCount) {
  return Buffer.alloc(byteCount).toString('base64');
}

test('combinedAssetBytes counts decoded bytes of every asset field in one call', () => {
  const input = {
    assetData: { a: base64OfSize(10), b: base64OfSize(11) },
    sequenceData: { c: base64OfSize(12) },
    sources: { d: base64OfSize(13) },
    data: base64OfSize(14),
  };
  assert.equal(combinedAssetBytes(input), 60);
  assert.equal(combinedAssetBytes({}), 0);
});

test('combinedAssetBytes counts grid files and look files, which a call also sends (#1246)', () => {
  const input = {
    gridData: { 'a.67vg': base64OfSize(100), 'b.67vg': base64OfSize(101) },
    lookData: { sky: { kind: 'environment', base64: base64OfSize(7) }, grade: { kind: 'look', text: 'abcde' } },
  };
  assert.equal(combinedAssetBytes(input), 100 + 101 + 7 + 5);
  const over = { gridData: { first: base64OfSize(40 * MEBIBYTE), second: base64OfSize(40 * MEBIBYTE) } };
  assert.throws(() => assertCombinedAssetBytes(over), /maxCombinedBytes/);
});

test('a call whose assets are each under maxBytes but together over maxCombinedBytes fails naming limit and total', () => {
  const each = 40 * MEBIBYTE;
  assert.ok(each < AGENT_ASSET_LIMITS.maxBytes);
  const input = { assetData: { first: base64OfSize(each), second: base64OfSize(each) } };
  assert.throws(
    () => assertCombinedAssetBytes(input),
    error => error instanceof RangeError
      && error.message.includes('maxCombinedBytes')
      && error.message.includes(String(AGENT_ASSET_LIMITS.maxCombinedBytes))
      && error.message.includes(String(2 * each)),
  );
});

test('a call at exactly maxCombinedBytes passes', () => {
  const half = AGENT_ASSET_LIMITS.maxCombinedBytes / 2;
  assert.doesNotThrow(() => assertCombinedAssetBytes({ assetData: { first: base64OfSize(half) }, sources: { second: base64OfSize(half) } }));
});

test('the combined limit error names the largest assets, their sizes and how to shrink them (#2841)', () => {
  const namedAssets = [
    { name: 'island_tree_02.glb', bytes: 42 * MEBIBYTE },
    { name: 'island_tree_01.glb', bytes: 66 * MEBIBYTE },
    { name: 'pinnace.glb', bytes: 21 * MEBIBYTE },
    { name: 'rock.glb', bytes: 1 * MEBIBYTE },
  ];
  const message = combinedAssetBytesLimitMessage(130 * MEBIBYTE, namedAssets);
  assert.match(message, /Largest: island_tree_01\.glb 66\.0 MiB, island_tree_02\.glb 42\.0 MiB, pinnace\.glb 21\.0 MiB\./);
  assert.ok(!message.includes('rock.glb'));
  assert.match(message, /gltf-transform simplify/);
  assert.match(message, /meshopt/);
  assert.match(message, /--max-asset-bytes/);
  assert.match(sceneAssetBytesLimitMessage(130 * MEBIBYTE, namedAssets), /Largest: island_tree_01\.glb 66\.0 MiB/);
  assert.throws(
    () => assertCombinedByteTotal(130 * MEBIBYTE, undefined, namedAssets),
    error => error instanceof RangeError && error.message.includes('island_tree_01.glb'),
  );
});

test('the error stays valid when no asset has a name', () => {
  assert.doesNotMatch(combinedAssetBytesLimitMessage(100 * MEBIBYTE), /Largest/);
});

test('--max-asset-bytes raises both limits for the process and rejects values outside 1 MiB to 256 MiB (#2841)', () => {
  try {
    configureAssetByteLimit(128 * MEBIBYTE);
    assert.equal(AGENT_ASSET_LIMITS.maxBytes, 128 * MEBIBYTE);
    assert.equal(AGENT_ASSET_LIMITS.maxCombinedBytes, 128 * MEBIBYTE);
    const input = { assetData: { first: base64OfSize(70 * MEBIBYTE), second: base64OfSize(40 * MEBIBYTE) } };
    assert.doesNotThrow(() => assertCombinedAssetBytes(input));
    assert.match(assetBytesLimitMessage(200 * MEBIBYTE), /128 MiB/);
    for (const bad of [0, 1.5, Number.NaN, 257 * MEBIBYTE, '64']) {
      assert.throws(() => configureAssetByteLimit(bad), /--max-asset-bytes must be a whole number of bytes from 1048576/);
    }
  } finally {
    resetAssetByteLimit();
  }
  assert.equal(AGENT_ASSET_LIMITS.maxCombinedBytes, 64 * MEBIBYTE);
});
