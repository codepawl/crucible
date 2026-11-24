// Writes the canopy street (#3289) as scene files for `node scripts/render-media.mjs --scene file --config <folder>/<camera>-<name>.json`.
// Cameras: wide, under (a canopy from below), eave (the eave from below) and ground (the street under a canopy and in the open). Names: scene-main (sun and HDRI, sky occlusion off), scene-occluded (the
// same with `skyOcclusion` on), scene-sky-main and scene-sky-occluded (key and fill lights off, so a pixel is the sky light
// alone), open-main and open-occluded (the street with nothing over it). Usage: node scripts/make-canopy-street-scene.mjs <folder>
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCanopyStreetGlb } from '../tests/helpers/canopy-street-glb.mjs';

const folder = process.argv[2];
if (!folder) throw new Error('Pass the output folder: node scripts/make-canopy-street-scene.mjs <folder>');
const outputFolder = resolve(folder);
mkdirSync(outputFolder, { recursive: true });
writeFileSync(join(outputFolder, 'street.glb'), buildCanopyStreetGlb());
writeFileSync(join(outputFolder, 'street-open.glb'), buildCanopyStreetGlb({ cover: false }));
copyFileSync(new URL('../public/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr', import.meta.url), join(outputFolder, 'sky.hdr'));

// `wide` shows the whole street; `under` stands in the street and looks up at the nearest canopy and the eave.
const cameras = { wide: { eye: [0, 1.8, 24], target: [0, 3, 0] }, under: { eye: [1, 1.5, 0], target: [-1, 3.2, -6] }, eave: { eye: [-12, 1.5, 9], target: [-12, 4, 2.5] }, ground: { eye: [4, 4.5, 8], target: [4, 0, -4] } };
function sceneDescription({ skyOcclusion, skyOnly, open }, camera) {
  const environment = {
    ...(skyOcclusion ? { skyOcclusion: true } : {}),
    ...(skyOnly ? { keyIntensity: 0, fillIntensity: 0 } : {}),
  };
  return {
    glb: open ? 'street-open.glb' : 'street.glb', hdri: 'sky.hdr', hdriOptions: { intensity: 1, showBackground: true }, hdriSun: !skyOnly, exposure: 1, ...camera,
    renderer: { ground: false, hdr: true, samples: 4, environment },
  };
}
const variants = { 'scene-main': {}, 'scene-occluded': { skyOcclusion: true }, 'scene-sky-main': { skyOnly: true }, 'scene-sky-occluded': { skyOnly: true, skyOcclusion: true }, 'open-main': { open: true }, 'open-occluded': { open: true, skyOcclusion: true } };
for (const [cameraName, camera] of Object.entries(cameras)) {
  for (const [name, options] of Object.entries(variants)) {
    writeFileSync(join(outputFolder, `${cameraName}-${name}.json`), JSON.stringify(sceneDescription(options, camera), null, 2));
  }
}
console.log(`Wrote ${Object.keys(variants).length * Object.keys(cameras).length} scene files to ${outputFolder}`);
