// Measures the water volume scene (scripts/water-volume-scene.js) in Chrome: the colour of each bed and dry patch with and without
// water, and writes the picture with its recipe next to it.
//   node scripts/measure-water-volumes.mjs [--root <checkout>] [--out <folder>] [--label before|after]
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openPage } from './measure-water-shadows.mjs';

const WIDTH = 800;
const HEIGHT = 600;

/** Draws the scene with and without water in the checkout at `root`. */
export async function measureWaterVolumes(root = process.cwd()) {
  const { page, close } = await openPage(root);
  try {
    return await page.evaluate(async ({ width, height }) => {
      const scene = await import('/scripts/water-volume-scene.js');
      const result = {};
      for (const [name, withWater] of [['wet', true], ['dry', false]]) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.style.cssText = `width:${width}px;height:${height}px;display:block`;
        document.body.append(canvas);
        result[name] = scene.drawVolumeScene(canvas, withWater);
        canvas.remove();
      }
      return result;
    }, { width: WIDTH, height: HEIGHT });
  } finally {
    await close();
  }
}

/** The largest per-channel difference, in 8-bit levels, between a sample with water and the same sample without. */
export function sampleShift(report, name) {
  return Math.max(...report.wet.samples[name].map((value, channel) => Math.abs(value - report.dry.samples[name][channel])));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argument = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
  const report = await measureWaterVolumes(resolve(argument('root') ?? '.'));
  const label = argument('label') ?? 'run';
  const folder = resolve(argument('out') ?? 'artifacts/3280');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `volumes-${label}.png`), Buffer.from(report.wet.picture.split(',')[1], 'base64'));
  await writeFile(join(folder, `volumes-${label}-no-water.png`), Buffer.from(report.dry.picture.split(',')[1], 'base64'));
  const summary = { label, size: [WIDTH, HEIGHT], camera: report.wet.camera, sun: report.wet.sun, wet: report.wet.samples, dry: report.dry.samples, shift: Object.fromEntries(Object.keys(report.wet.samples).map(name => [name, sampleShift(report, name)])) };
  await writeFile(join(folder, `volumes-${label}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 1));
}
