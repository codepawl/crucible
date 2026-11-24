// Writes a scene file whose GLB is a rigid rig with baked per-node animation (120 nodes by 90 frames at 30 fps by default), for
// `node scripts/render-media.mjs --scene file --config <dir>/scene.json` (#3232). Usage: node scripts/make-baked-rig-scene.mjs <folder>
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildBakedRigGlb } from '../tests/helpers/baked-rig-glb.mjs';

const folder = process.argv[2];
if (!folder) throw new Error('Pass the output folder: node scripts/make-baked-rig-scene.mjs <folder>');
const outputFolder = resolve(folder);
mkdirSync(outputFolder, { recursive: true });
const rig = buildBakedRigGlb();
writeFileSync(join(outputFolder, 'rig.glb'), rig.bytes);
copyFileSync(new URL('../public/hdri/kloofendal_28d_misty_puresky_1k.hdr', import.meta.url), join(outputFolder, 'sky.hdr'));
const description = {
  glb: 'rig.glb',
  hdri: 'sky.hdr',
  hdriOptions: { intensity: 1, showBackground: true },
  exposure: 1,
  eye: [0, 1.6, 7],
  target: [0, 0.4, 0],
  renderer: { ground: false, hdr: true, samples: 4 },
};
writeFileSync(join(outputFolder, 'scene.json'), JSON.stringify(description, null, 2));
console.log(`${rig.nodeCount} nodes, ${rig.frameCount} frames at ${rig.framesPerSecond} fps -> ${join(outputFolder, 'scene.json')}`);
