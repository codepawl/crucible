import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createSizeMeasurer, measureThree } from '../scripts/measure-size.mjs';

test('createSizeMeasurer omits brotli by default and memoizes gzip sizes by chunk content', () => {
  const measurer = createSizeMeasurer({ includeBrotli: false });
  const firstChunk = Buffer.from('export const first = "alpha-beta-gamma";\n'.repeat(10));
  const secondChunk = Buffer.from('export const second = "delta-epsilon";\n'.repeat(8));

  const sized = measurer.sizeOfParts([firstChunk, secondChunk]);
  assert.equal(sized.min, firstChunk.length + secondChunk.length);
  assert.equal(sized.gzip, gzipSync(firstChunk, { level: 9 }).length + gzipSync(secondChunk, { level: 9 }).length);
  assert.equal(Object.hasOwn(sized, 'brotli'), false);
  assert.equal(measurer.gzipCache.size, 2);
  assert.equal(measurer.brotliCache.size, 0);

  // An identical copy of firstChunk reuses the cached SHA-256 entry instead of adding a new cache key.
  const copy = Buffer.from(firstChunk);
  const repeated = measurer.sizeOfParts([copy]);
  assert.equal(repeated.gzip, gzipSync(firstChunk, { level: 9 }).length);
  assert.equal(measurer.gzipCache.size, 2);
});

test('createSizeMeasurer includes brotli when refreshing release numbers', () => {
  const measurer = createSizeMeasurer({ includeBrotli: true });
  const chunk = Buffer.from('export const releaseChunk = [1, 2, 3, 4, 5];\n'.repeat(12));
  const sized = measurer.sizeOfParts([chunk]);
  assert.equal(sized.min, chunk.length);
  assert.equal(sized.gzip, gzipSync(chunk, { level: 9 }).length);
  assert.equal(sized.brotli, brotliCompressSync(chunk).length);
  assert.equal(measurer.brotliCache.size, 1);
});

test('chunkSizes avoids duplicate work when there are no lazy chunks', () => {
  const measurer = createSizeMeasurer({ includeBrotli: false });
  const entryText = 'export const x = 42;\n';
  const entryPath = `${process.cwd()}/size-output/entry.js`;
  const result = {
    outputFiles: [{ path: entryPath, text: entryText, contents: Buffer.from(entryText) }],
    metafile: {
      outputs: {
        'size-output/entry.js': { entryPoint: '<stdin>', imports: [] },
      },
    },
  };
  const measured = measurer.chunkSizes(result);
  assert.equal(measured.initial, measured.all);
  assert.equal(measured.initial.min, Buffer.byteLength(entryText));
  assert.equal(measured.initial.gzip, gzipSync(Buffer.from(entryText), { level: 9 }).length);
});

test('measureThree runs three.js scene builds concurrently while preserving SCENES key order', async () => {
  let active = 0;
  let peakActive = 0;
  let callIndex = 0;
  const fakeMeasure = async () => {
    const mine = callIndex++;
    active++;
    peakActive = Math.max(peakActive, active);
    // Resolve the first call slower than the second so out-of-order completion is exercised.
    await new Promise(resolveWait => setTimeout(resolveWait, mine === 0 ? 30 : 5));
    active--;
    return { initial: { min: 100 + mine, gzip: 50 + mine } };
  };

  const three = await measureThree({ includeBrotli: false, measure: fakeMeasure });
  assert.ok(peakActive >= 2, `expected concurrent execution, saw peakActive=${peakActive}`);
  assert.deepEqual(Object.keys(three), ['lit-box', 'gltf-box']);
  assert.deepEqual(three['lit-box'], { min: 100, gzip: 50 });
  assert.deepEqual(three['gltf-box'], { min: 101, gzip: 51 });
});

test('measure-size --json omits brotli from every measured bundle', () => {
  const result = spawnSync(process.execPath, ['scripts/measure-size.mjs', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const measured = JSON.parse(result.stdout);
  assert.ok(measured['entry:core'].gzip > 0);
  for (const [name, entry] of Object.entries(measured)) {
    assert.equal(Object.hasOwn(entry, 'brotli'), false, `${name} should omit brotli on --json`);
  }
});
