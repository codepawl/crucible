import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spinningBarGlb } from '../fixtures/spinning-bar-glb.js';

/** The scene file of the spinning bar with the given motion blur, written with its GLB, sky and a camera dolly into `folder`. */
export async function writeSpinningBarScene(folder, { motionBlur = null, name = 'scene' } = {}) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'bar.glb'), spinningBarGlb());
  await copyFile(new URL('../../assets/looks/sky-clouds.hdr', import.meta.url), join(folder, 'sky.hdr'));
  const description = {
    glb: 'bar.glb',
    hdri: 'sky.hdr',
    eye: [0, 0.4, 6],
    target: [0, 0, 0],
    renderer: { ground: false, hdr: true, samples: 1, pixelRatio: 1, memoryBudgetMiB: 512 },
    frame: { exposure: 1, ...(motionBlur ? { effects: { motionBlur } } : {}) },
  };
  const config = join(folder, `${name}.json`);
  await writeFile(config, JSON.stringify(description));
  const frames = Array.from({ length: 91 }, (_, index) => [[index * 0.01, 0.4, 6], [0, 0, 0]]);
  const camera = join(folder, 'camera.json');
  await writeFile(camera, JSON.stringify({ fps: 30, frames }));
  return { config, camera };
}
