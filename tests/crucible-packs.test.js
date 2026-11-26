import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip } from '../scripts/build-pack-index.mjs';
import { readZip, checkEntryName } from '../bin/crucible-zip-reader.mjs';
import { addPack, checkChecksum, listPacks, loadPins, PACK_LIMITS, RELEASE_URL_PREFIX, removePack, runPacksCommand } from '../bin/crucible-packs.mjs';
import { defaultPacksFolder, resolvePacksOption } from '../bin/crucible-pack-folder.mjs';
import { mcpHelpText } from '../bin/crucible-mcp-flags.mjs';

const RELEASE = 'https://github.com/codepawl/crucible/releases/download/packs-vegetation-scans-1.0.0/vegetation-scans-1.0.0.zip';

function packZip(name = 'vegetation-scans', version = '1.0.0', extra = {}) {
  const files = new Map([
    ['crucible-pack.json', Buffer.from(JSON.stringify({ name, version }))],
    ['textures/bark.png', Buffer.alloc(4096, 7)],
    ['LICENSE', Buffer.from('CC0\n')],
    ...Object.entries(extra),
  ]);
  return createZip(files);
}

function pinFor(bytes, overrides = {}) {
  const pin = { version: '1.0.0', url: RELEASE, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, ...overrides };
  return loadPins({ schemaVersion: 1, packs: { 'vegetation-scans': pin } });
}

function fakeFetch(bytes, { status = 200, chunkBytes = 1000 } = {}) {
  const calls = [];
  const implementation = async (url, init) => {
    calls.push({ url, init });
    const stream = new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkBytes) controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
        controller.close();
      },
    });
    return new Response(stream, { status });
  };
  implementation.calls = calls;
  return implementation;
}

function temporaryRoot() {
  return join(mkdtempSync(join(tmpdir(), 'crucible-packs-')), 'packs');
}

test('the reader returns every file the pack zip writer stored, deflated or not', () => {
  const files = readZip(packZip(), PACK_LIMITS);
  assert.deepEqual(files.map(file => file.name).sort(), ['LICENSE', 'crucible-pack.json', 'textures/bark.png']);
  assert.deepEqual(files.find(file => file.name === 'textures/bark.png').data, Buffer.alloc(4096, 7));
});

test('a cut-off, tampered or oversized zip is refused before any byte is used', () => {
  const zip = packZip();
  assert.throws(() => readZip(zip.subarray(0, zip.length - 30), PACK_LIMITS), /no end record|broken central directory|cut off/);
  const tampered = Buffer.from(zip);
  const dataStart = tampered.indexOf(Buffer.from('textures/bark.png')) + 'textures/bark.png'.length;
  tampered[dataStart + 2] ^= 0xff;
  assert.throws(() => readZip(tampered, PACK_LIMITS), /textures\/bark\.png.*(CRC-32|inflate)/);
  assert.throws(() => readZip(zip, { ...PACK_LIMITS, maximumFiles: 2 }), /holds 3 files, above the limit of 2/);
  assert.throws(() => readZip(zip, { ...PACK_LIMITS, maximumFileBytes: 100 }), /above the limit of 100/);
  assert.throws(() => readZip(zip, { ...PACK_LIMITS, maximumBytes: 1000 }), /more than 1000 bytes/);
});

test('entry names that could leave the pack folder are refused', () => {
  for (const name of ['../evil.js', '/etc/passwd', 'C:/Windows/x', 'a\\b', 'a//b', './x', 'a/../b', 'nul\u0000']) {
    assert.throws(() => checkEntryName(name), /unsafe entry name/, name);
  }
  assert.equal(checkEntryName('textures/bark.png'), 'textures/bark.png');
  assert.throws(() => readZip(createZip(new Map([['../escape.txt', Buffer.from('x')]])), PACK_LIMITS), /unsafe entry name/);
  assert.throws(() => readZip(createZip(new Map([['A.txt', Buffer.from('x')], ['a.txt', Buffer.from('y')]])), PACK_LIMITS), /twice/);
});

test('pins must name a release asset of this repository with a sha256 and size', () => {
  const shipped = loadPins();
  assert.deepEqual(Object.keys(shipped), ['vegetation-scans'], 'the shipped pin file parses');
  assert.equal(shipped['vegetation-scans'].url, RELEASE_URL_PREFIX + 'vegetation-scans-1.0.0/vegetation-scans-1.0.0.zip');
  const good = { version: '1.0.0', url: RELEASE, sha256: 'a'.repeat(64), bytes: 10 };
  assert.equal(loadPins({ schemaVersion: 1, packs: { 'vegetation-scans': good } })['vegetation-scans'].bytes, 10);
  assert.throws(() => loadPins({ schemaVersion: 1, packs: { 'vegetation-scans': { ...good, url: 'https://example.com/x.zip' } } }), /release asset under https:\/\/github\.com\/codepawl\/crucible/);
  assert.throws(() => loadPins({ schemaVersion: 1, packs: { 'vegetation-scans': { ...good, sha256: 'xyz' } } }), /64 lowercase hex/);
  assert.throws(() => loadPins({ schemaVersion: 1, packs: { 'vegetation-scans': { ...good, bytes: 0 } } }), /bytes must be a whole number/);
  assert.throws(() => loadPins({ schemaVersion: 1, packs: { 'Bad Name': good } }), /not a pack name/);
  assert.throws(() => loadPins({ packs: {} }), /schemaVersion/);
});

test('add downloads the pinned asset, checks it and installs it; list and remove see it', async () => {
  const zip = packZip();
  const pins = pinFor(zip);
  const root = temporaryRoot();
  const fetchImplementation = fakeFetch(zip);
  const result = await addPack('vegetation-scans', { pins, root, fetchImplementation });
  assert.equal(fetchImplementation.calls[0].url, RELEASE);
  assert.equal(result.files, 3);
  assert.deepEqual(readFileSync(join(root, 'vegetation-scans', 'textures', 'bark.png')), Buffer.alloc(4096, 7));
  assert.deepEqual(await listPacks({ pins, root }), [{ folder: 'vegetation-scans', pinnedVersion: '1.0.0', name: 'vegetation-scans', version: '1.0.0' }]);
  await removePack('vegetation-scans', { root });
  assert.equal(existsSync(join(root, 'vegetation-scans')), false);
  await assert.rejects(removePack('vegetation-scans', { root }), /No installed pack "vegetation-scans"/);
});

test('a wrong checksum, a cut-off download or the wrong pack leaves an installed pack unchanged', async () => {
  const zip = packZip();
  const root = temporaryRoot();
  await addPack('vegetation-scans', { pins: pinFor(zip), root, fetchImplementation: fakeFetch(zip) });
  const before = readFileSync(join(root, 'vegetation-scans', 'textures', 'bark.png'));
  const other = packZip('vegetation-scans', '1.0.0', { 'textures/bark.png': Buffer.alloc(4096, 9) });
  await assert.rejects(addPack('vegetation-scans', { pins: pinFor(zip), root, fetchImplementation: fakeFetch(other) }), /has sha256 .* not the pinned .* Nothing was installed/);
  await assert.rejects(addPack('vegetation-scans', { pins: pinFor(zip), root, fetchImplementation: fakeFetch(zip.subarray(0, zip.length - 20)) }), /stopped at \d+ of \d+ bytes\. Nothing was installed/);
  await assert.rejects(addPack('vegetation-scans', { pins: pinFor(zip, { bytes: 100 }), root, fetchImplementation: fakeFetch(zip) }), /larger than the pinned 100 bytes/);
  await assert.rejects(addPack('vegetation-scans', { pins: pinFor(zip), root, fetchImplementation: fakeFetch(zip, { status: 404 }) }), /HTTP 404/);
  const renamed = packZip('other-pack', '1.0.0');
  await assert.rejects(addPack('vegetation-scans', { pins: pinFor(renamed), root, fetchImplementation: fakeFetch(renamed) }), /holds pack other-pack 1\.0\.0, but the pin is vegetation-scans 1\.0\.0/);
  assert.deepEqual(readFileSync(join(root, 'vegetation-scans', 'textures', 'bark.png')), before);
  assert.deepEqual((await listPacks({ pins: pinFor(zip), root })).map(row => row.folder), ['vegetation-scans'], 'no staging folder is left behind');
});

test('a newer pinned version replaces the installed pack', async () => {
  const root = temporaryRoot();
  const first = packZip('vegetation-scans', '1.0.0');
  await addPack('vegetation-scans', { pins: pinFor(first), root, fetchImplementation: fakeFetch(first) });
  const second = packZip('vegetation-scans', '1.1.0', { 'textures/leaf.png': Buffer.alloc(10, 1) });
  await addPack('vegetation-scans', { pins: pinFor(second, { version: '1.1.0' }), root, fetchImplementation: fakeFetch(second) });
  const rows = await listPacks({ pins: pinFor(second, { version: '1.1.0' }), root });
  assert.equal(rows[0].version, '1.1.0');
  assert.ok(existsSync(join(root, 'vegetation-scans', 'textures', 'leaf.png')));
});

test('checkChecksum accepts only the pinned bytes', () => {
  const bytes = Buffer.from('pack');
  const pin = { name: 'x', sha256: createHash('sha256').update(bytes).digest('hex') };
  assert.equal(checkChecksum(bytes, pin), bytes);
  assert.throws(() => checkChecksum(Buffer.from('other'), pin), /not the pinned/);
});

test('the default folder is ~/.crucible/packs, CRUCIBLE_PACKS_HOME wins, and --packs wins over both', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crucible-home-'));
  assert.equal(defaultPacksFolder({ environment: {}, home }), join(home, '.crucible', 'packs'));
  assert.equal(defaultPacksFolder({ environment: { CRUCIBLE_PACKS_HOME: join(home, 'mine') }, home }), join(home, 'mine'));
  assert.throws(() => defaultPacksFolder({ environment: { CRUCIBLE_PACKS_HOME: 'relative' }, home }), /must be an absolute folder/);
  assert.equal(resolvePacksOption(undefined, { environment: {}, home }), undefined, 'no default folder, no packs');
  await mkdir(join(home, '.crucible', 'packs'), { recursive: true });
  assert.equal(resolvePacksOption(undefined, { environment: {}, home }), join(home, '.crucible', 'packs'));
  assert.equal(resolvePacksOption(join(home, 'flag'), { environment: {}, home }), join(home, 'flag'));
  assert.equal(resolvePacksOption('none', { environment: {}, home }), undefined);
  assert.match(mcpHelpText('0.0.0'), /--packs <absolute folder of data-only packs, or none>/);
  await rm(home, { recursive: true, force: true });
});

test('the command prints usage and errors that say what to do', async () => {
  const root = temporaryRoot();
  const lines = [];
  const errors = [];
  const io = { log: line => lines.push(line), error: line => errors.push(line), root, pins: loadPins({ schemaVersion: 1, packs: {} }) };
  assert.equal(await runPacksCommand([], io), 1);
  assert.match(errors.at(-1), /Usage: crucible packs add <name>/);
  assert.equal(await runPacksCommand(['add', 'vegetation-scans'], io), 1);
  assert.match(errors.at(-1), /pins no packs yet/);
  assert.equal(await runPacksCommand(['add', '../x'], io), 1);
  assert.match(errors.at(-1), /not a pack name/);
  assert.equal(await runPacksCommand(['list'], io), 0);
  assert.match(lines.at(-1), /No packs installed/);
  await mkdir(join(root, 'stray'), { recursive: true });
  await writeFile(join(root, 'stray', 'note.txt'), 'x');
  assert.equal(await runPacksCommand(['list'], io), 0);
  assert.match(lines.at(-1), /stray {2}\(no readable crucible-pack\.json\)/);
  assert.equal(await runPacksCommand(['remove', 'stray'], io), 1, 'a folder without a manifest is not removed');
  assert.ok(existsSync(join(root, 'stray', 'note.txt')));
});
