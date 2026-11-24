import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSpinningBarScene } from './helpers/scene-file-frames.js';

// Needs Chrome, so it is slower than the fast-test limit and stays out of that list. It renders on SwiftShader (--backend cpu), so
// it needs no GPU and gives the same bytes on every run of the same machine.
// scripts/render-media.mjs launches the installed Google Chrome at these paths; elsewhere (Linux CI) it has no browser to drive, so skip.
const INSTALLED_CHROME = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const chromeMissing = !existsSync(INSTALLED_CHROME);

const FRAME_ARGUMENTS = ['--scene', 'file', '--kind', 'stills', '--backend', 'cpu', '--width', '270', '--height', '480', '--fps', '30', '--frames', '0-3'];

function renderRange({ config, camera, output }) {
  const result = spawnSync(process.execPath, ['scripts/render-media.mjs', ...FRAME_ARGUMENTS, '--config', config, '--camera', camera, '--output', output], { encoding: 'utf8', env: { ...process.env, COOK_DISABLE: '1' } });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

async function hashesOf(folder) {
  const names = (await readdir(folder)).filter(name => name.endsWith('.png')).sort();
  const hashes = [];
  for (const name of names) hashes.push([name, createHash('sha256').update(await readFile(join(folder, name))).digest('hex')]);
  return hashes;
}

test('a frame range writes numbered PNGs, blur changes them, and two runs give the same bytes', { skip: chromeMissing && 'needs Google Chrome installed where scripts/render-media.mjs looks for it', timeout: 300000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'frame-range-'));
  try {
    const sharp = await writeSpinningBarScene(join(folder, 'scene'), { name: 'sharp' });
    const blurred = await writeSpinningBarScene(join(folder, 'scene'), { name: 'blurred', motionBlur: { shutter: 0.1, objects: 1 } });
    renderRange({ ...sharp, output: join(folder, 'sharp', 'a.png') });
    renderRange({ ...blurred, output: join(folder, 'blurred-1', 'a.png') });
    renderRange({ ...blurred, output: join(folder, 'blurred-2', 'a.png') });
    const sharpHashes = await hashesOf(join(folder, 'sharp'));
    const firstRun = await hashesOf(join(folder, 'blurred-1'));
    const secondRun = await hashesOf(join(folder, 'blurred-2'));
    assert.deepEqual(firstRun.map(([name]) => name), ['frame-0000.png', 'frame-0001.png', 'frame-0002.png', 'frame-0003.png']);
    assert.deepEqual(firstRun, secondRun, 'two runs of the same range must give identical PNG hashes');
    // Frame 0 sits at time 0, where the shutter has nothing before it, so the bar is sharp there; later frames smear.
    for (let frame = 1; frame < 4; frame++) assert.notEqual(firstRun[frame][1], sharpHashes[frame][1], `frame ${frame} must differ with the shutter on`);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
