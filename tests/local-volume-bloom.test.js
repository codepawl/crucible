// A glowing local volume blooms (#1046): the rasterizer composites the volumes before bloom extraction when bloom is on and a volume emits, so the glow spills past the volume.
// It skips when Chrome cannot start. Set LOCAL_VOLUME_BLOOM_ARTIFACTS to a folder to write the before and after still there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.js';
import { launchChrome, skipOrThrow, openBlankPage } from './helpers/dev-server-browser.js';
import { encodePng } from '../src/export-png.js';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes } from '../src/local-volumes.js';

const GLOW = { shape: 'sphere', center: [0, 1.2, 0], radius: 0.8, density: 0, falloff: 0.5, emission: [1, 0.45, 0.12], emissionStrength: 6, steps: 16 };
const HOT = { ...GLOW, emissionStrength: 40 };
const DARK = { ...GLOW, emission: [0, 0, 0], emissionStrength: 1 };
const BLOOM = { strength: 1.2, threshold: 1, radius: 3 };
const SIZE = 256;

test('a volume that emits is flagged for compositing before bloom, one that does not is not', () => {
  const flag = volumes => packLocalVolumes(resolveLocalVolumes(volumes), createLocalVolumeBuffers()).emissive;
  assert.equal(flag([GLOW]), true);
  assert.equal(flag([DARK]), false);
  assert.equal(flag([{ ...GLOW, emissionStrength: 0 }]), false);
  assert.equal(flag([DARK, GLOW]), true);
});

async function startServer(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', data => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`The dev server exited ${code}.`));
    });
  });
  return server;
}

// Renders each of the cases (volume list, bloom settings) with one renderer and returns the RGBA float frames, rows bottom to top.
async function rasterFrames(page, cases) {
  const task = async ({ size, cases: requested }) => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createFloatOutput, readFloatPixels } = await import('/src/float-output.js');
    await import('/src/fog-shader.js');
    await import('/src/bloom-pyramid.js');
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    document.body.append(canvas);
    const material = { color: [0.18, 0.18, 0.18], metallic: 0, roughness: 1, emission: 0 };
    const ground = { name: 'ground', geometry: box(0, 1), matrix: new Float32Array([40, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 40, 0, 0, -0.1, 0, 1]), material };
    const renderer = new CrucibleRenderer(canvas, [ground], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
    const output = createFloatOutput(renderer.context, size, size);
    const camera = { eye: [0, 1.4, 4], target: [0, 1.1, 0], fov: 40 };
    const light = { keyColor: [0.5, 0.5, 0.5], lightDirection: [0.3, 1, 0.4], keyIntensity: 1, fillIntensity: 0.2, skyTop: [0.05, 0.06, 0.08], skyBottom: [0.05, 0.06, 0.08] };
    // Peak of the RGB channels in the composite target that feeds bloom extraction; null when the frame did not composite.
    const compositePeak = () => {
      const target = renderer.localVolumeComposite?.target;
      if (!target) return null;
      const pixels = readFloatPixels(renderer.context, target.framebuffer, size, size);
      let peak = 0;
      for (let index = 0; index < pixels.length; index += 4) peak = Math.max(peak, pixels[index], pixels[index + 1], pixels[index + 2]);
      return peak;
    };
    const peaks = [];
    const frames = requested.map(({ localVolumes, bloom }) => {
      renderer.render({ ...camera, time: 0, environment: { ...light, localVolumes }, effects: { bloom }, outputFramebuffer: output.framebuffer });
      peaks.push(compositePeak());
      return Array.from(readFloatPixels(renderer.context, output.framebuffer, size, size));
    });
    const glError = renderer.context.getError();
    output.dispose();
    renderer.dispose?.();
    return { frames, peaks, glError };
  };
  return page.evaluate(task, { size: SIZE, cases });
}

// Mean green over a ring of pixels around the glowing sphere, outside its edge: rows and columns that the sphere does not cover but the bloom reaches.
function haloMean(frame) {
  let total = 0;
  let count = 0;
  const centerColumn = SIZE / 2;
  const centerRow = Math.round(SIZE * (1 - 0.5 - (1.2 - 1.1) / (2 * Math.tan(20 * Math.PI / 180) * 4)));
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      const distance = Math.hypot(column - centerColumn, (SIZE - 1 - row) - centerRow);
      if (distance < 70 || distance > 100) continue;
      total += frame[(row * SIZE + column) * 4 + 1];
      count++;
    }
  }
  return total / count;
}

function writeStill(path, frames) {
  const pixels = new Uint8Array(SIZE * frames.length * SIZE * 4);
  frames.forEach((frame, index) => {
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        const from = ((SIZE - 1 - row) * SIZE + column) * 4;
        const to = (row * SIZE * frames.length + index * SIZE + column) * 4;
        for (let channel = 0; channel < 3; channel++) pixels[to + channel] = Math.round(Math.max(0, Math.min(1, frame[from + channel])) * 255);
        pixels[to + 3] = 255;
      }
    }
  });
  writeFileSync(path, encodePng(pixels, SIZE * frames.length, SIZE));
}

test('a glowing volume blooms: the ring around it is brighter with bloom on, and a volume that does not glow adds no halo', async context => {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    skipOrThrow(context, 'playwright is not installed');
    return;
  }
  const port = await freePort();
  const server = await startServer(port);
  let browser;
  try {
    try {
      browser = await launchChrome(chromium);
    } catch (error) {
      skipOrThrow(context, `Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    await openBlankPage(page, port);
    const noBloom = { strength: 0 };
    const { frames: [glowOff, glowOn, darkOn, darkOff], peaks: [, , , , hotPeak], glError } = await rasterFrames(page, [
      { localVolumes: [GLOW], bloom: noBloom },
      { localVolumes: [GLOW], bloom: BLOOM },
      { localVolumes: [DARK], bloom: BLOOM },
      { localVolumes: [DARK], bloom: noBloom },
      { localVolumes: [HOT], bloom: BLOOM },
    ]);
    assert.equal(glError, 0);
    context.diagnostic(`the bloom source peaks at ${hotPeak} linear inside a volume with emissionStrength 40`);
    assert.ok(hotPeak > 10, `the composite that feeds bloom keeps linear values above the threshold of 1 (peak above 10): peak ${hotPeak}`);
    const haloOff = haloMean(glowOff);
    const haloOn = haloMean(glowOn);
    context.diagnostic(`the ring around the glow averages ${haloOff.toFixed(4)} without bloom and ${haloOn.toFixed(4)} with it; a volume that does not glow ${haloMean(darkOff).toFixed(4)} and ${haloMean(darkOn).toFixed(4)}`);
    if (process.env.LOCAL_VOLUME_BLOOM_ARTIFACTS) {
      mkdirSync(process.env.LOCAL_VOLUME_BLOOM_ARTIFACTS, { recursive: true });
      writeStill(join(process.env.LOCAL_VOLUME_BLOOM_ARTIFACTS, 'volume-bloom.png'), [glowOn]);
    }
    assert.ok(haloOn - haloOff > 0.005, `bloom lifts the ring around a glowing volume (display values): ${haloOff} to ${haloOn}`);
    assert.ok(haloMean(darkOn) - haloMean(darkOff) < 0.001, 'a volume that does not glow adds no halo');
  } finally {
    await browser?.close();
    server.kill();
  }
});
