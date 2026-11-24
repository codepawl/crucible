// Draws the line art reference scene with per-node line settings on the GPU and writes the stills the pull request shows.
//   node scripts/smoke-line-art-nodes.mjs [--output <folder>]
// Checks: lines false removes a node's contour, silhouetteOnly drops its inner lines, a node colour paints its lines,
// and the frame without per-node settings is unchanged, from the first frame on. Run it through gpu-lock (a light job).
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import sharp from 'sharp';
import { readPixels, lineStrength, lineMask } from '../bench/reference/line-art-measure.mjs';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argumentsGiven = process.argv.slice(2);
const output = resolve(argumentsGiven.includes('--output') ? argumentsGiven[argumentsGiven.indexOf('--output') + 1] : 'artifacts/line-art-nodes');
const SIZE = { width: 960, height: 540 };
const LINE_WIDTH = 2;
const CASES = {
  off: { width: 0, extra: {} },
  plain: { width: LINE_WIDTH, extra: {} },
  plainAgain: { width: LINE_WIDTH, extra: {} },
  ballOff: { width: LINE_WIDTH, extra: { nodes: { ball: { lines: false } } } },
  stepsSilhouette: { width: LINE_WIDTH, extra: { nodes: { 'step-1': { silhouetteOnly: true }, 'step-2': { silhouetteOnly: true }, 'step-3': { silhouetteOnly: true } } } },
  twinRed: { width: LINE_WIDTH, extra: { nodes: { 'twin-left': { color: [1, 0, 0] } } } },
  subset: { width: LINE_WIDTH, extra: { nodes: { ball: { lines: false }, 'step-1': { silhouetteOnly: true }, 'step-2': { silhouetteOnly: true }, 'step-3': { silhouetteOnly: true }, 'twin-left': { color: [1, 0, 0] } } } },
};

async function drawAll() {
  const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/bench/reference/line-art-harness.html`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu', '--disable-audio-output'] });
  const frames = {};
  try {
    const page = await browser.newPage({ viewport: SIZE });
    page.on('pageerror', error => console.log('PAGE ERROR', error.message));
    await page.goto(url, { timeout: 180000 });
    await page.waitForFunction(() => window.lineArtReady, null, { timeout: 180000 });
    for (const [name, { width, extra }] of Object.entries(CASES)) {
      const frame = await page.evaluate(([lineWidth, extraLines]) => window.drawLineArtScene(lineWidth, extraLines), [width, extra]);
      assert.equal(frame.glError, 0, `${name}: WebGL error ${frame.glError}`);
      frames[name] = Buffer.from(frame.png.split(',')[1], 'base64');
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return frames;
}

function lineCount(strength) {
  return lineMask(strength).reduce((sum, value) => sum + value, 0);
}

function redLinePixels(pixels, strength) {
  let count = 0;
  for (let pixel = 0; pixel < strength.length; pixel++) {
    if (strength[pixel] >= 0.15 && pixels.data[pixel * 3] > pixels.data[pixel * 3 + 1] + 60) count++;
  }
  return count;
}

await mkdir(output, { recursive: true });
const frames = await drawAll();
const pixels = {};
for (const [name, png] of Object.entries(frames)) {
  await writeFile(`${output}/${name}.png`, png);
  pixels[name] = await readPixels(await sharp(png).toBuffer());
}
const strength = Object.fromEntries(Object.keys(CASES).filter(name => name !== 'off').map(name => [name, lineStrength(pixels.off, pixels[name])]));
const counts = Object.fromEntries(Object.entries(strength).map(([name, value]) => [name, lineCount(value)]));
const red = Object.fromEntries(Object.entries(strength).map(([name, value]) => [name, redLinePixels(pixels[name], value)]));
console.log('line pixels', JSON.stringify(counts));
console.log('red line pixels', JSON.stringify(red));

assert.ok(counts.plain > 1000, 'the plain frame draws lines');
// The first lines frame is drawn without any warm-up; a node table bound on the wrong texture unit once blanked the crease guide.
assert.ok(frames.plain.equals(frames.plainAgain), `the first lines frame equals the second (${counts.plain} vs ${counts.plainAgain} line pixels)`);
assert.ok(counts.ballOff < counts.plain - 100, `lines false drops the sphere contour (${counts.ballOff} vs ${counts.plain})`);
assert.ok(counts.stepsSilhouette < counts.plain - 100, `silhouetteOnly drops the inner lines of the steps (${counts.stepsSilhouette} vs ${counts.plain})`);
assert.equal(red.plain, 0, 'the plain frame has no red lines');
assert.ok(red.twinRed > 50, `a node colour paints its lines (${red.twinRed} red pixels)`);
assert.ok(counts.subset < counts.plain && red.subset > 50, 'the combined subset keeps the red lines and drops the rest');
console.log('line art nodes smoke ok');
