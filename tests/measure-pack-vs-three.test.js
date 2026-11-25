import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTable, gzipBytes, parseArguments, summarizeDownloads } from '../scripts/measure-pack-vs-three.mjs';

test('summarizeDownloads sorts each file into JavaScript, data or page rows and adds them up', () => {
  const summary = summarizeDownloads([
    { path: 'crucible-scene.js', gzip: 100 },
    { path: 'chunk-abc.js', gzip: 50 },
    { path: 'scene.pack', gzip: 30 },
    { path: 'index.html', gzip: 7 },
    { path: '/', gzip: 3 },
  ]);
  assert.deepEqual(summary, { javascript: 150, data: 30, html: 10, total: 190, files: 5 });
});

test('gzipBytes compresses repeated text far below its length', () => {
  assert.ok(gzipBytes(Buffer.from('a'.repeat(1000))) < 50);
});

test('parseArguments reads --size and refuses an unknown option or a tiny size', () => {
  assert.deepEqual([parseArguments(['--size', '640x480']).width, parseArguments(['--size', '640x480']).height], [640, 480]);
  assert.throws(() => parseArguments(['--fast']), /--fast: unknown option/);
  assert.throws(() => parseArguments(['--size', '10x10']), /each at least 64/);
});

test('formatTable names the date, the three.js version and both columns', () => {
  const page = { javascript: 2000, data: 10, html: 5, total: 2015 };
  const table = formatTable({ size: '800 by 600', packed: page, three: { ...page, javascript: 1000, data: 0, total: 1005 } }, '2026-11-25', '0.187.0');
  assert.match(table, /2026-11-25 .* three\.js 0\.187\.0/);
  assert.match(table, /\| JavaScript \| 2,000 B \| 1,000 B \|/);
  assert.match(table, /\| Total \| 2,015 B \| 1,005 B \|/);
});
