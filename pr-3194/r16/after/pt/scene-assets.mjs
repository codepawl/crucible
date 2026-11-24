// The CC0 asphalt (ambientCG Asphalt025A, 1K) the test road wears, and the sky-clouds HDRI, as base64 for the page to decode.
import { readFileSync } from 'node:fs';
const folder = 'C:/Users/nxan2/Documents/crucible/artifacts/2874/assets/Asphalt025A/Asphalt025A_1K-JPG_';
export const textureIds = { color: 'a'.repeat(63) + '1', normal: 'a'.repeat(63) + '2', roughness: 'a'.repeat(63) + '3' };
export const facadeIds = { color: 'b'.repeat(63) + '1', normal: 'b'.repeat(63) + '2', roughness: 'b'.repeat(63) + '3' };
const facadeFolder = 'C:/Users/nxan2/Documents/crucible/artifacts/2874/assets/Facade018A/Facade018A_1K-JPG_';
export const textureFiles = { [textureIds.color]: 'Color', [textureIds.normal]: 'NormalGL', [textureIds.roughness]: 'Roughness' };
export const texturePayload = {
  ...Object.fromEntries(Object.entries(textureFiles).map(([id, name]) => [id, readFileSync(`${folder}${name}.jpg`).toString('base64')])),
  [facadeIds.color]: readFileSync(`${facadeFolder}ColorLight.jpg`).toString('base64'),
  [facadeIds.normal]: readFileSync(`${facadeFolder}NormalGL.jpg`).toString('base64'),
  [facadeIds.roughness]: readFileSync(`${facadeFolder}Roughness.jpg`).toString('base64'),
};
export const skyClouds = readFileSync(process.env.SKY_HDR ?? 'C:/Users/nxan2/Documents/crucible/artifacts/2874/assets/hdri/sky4k.hdr').toString('base64');
// Decodes the payload inside the page: a Map of catalog image id to { width, height, data } and registers the HDRI.
export const pageSetup = `async (payload, hdr, root) => {
  const pool = new Map();
  for (const [id, base64] of Object.entries(payload)) {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { colorSpaceConversion: 'none' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    pool.set(id, { width: bitmap.width, height: bitmap.height, data: new Uint8ClampedArray(pixels.data) });
  }
  const { parseRadianceHdr } = await import(/* @vite-ignore */ root + '/hdri.js');
  const { registerCatalogEnvironment } = await import(/* @vite-ignore */ root + '/look-catalog.js');
  const hdrBytes = Uint8Array.from(atob(hdr), character => character.charCodeAt(0));
  registerCatalogEnvironment('sky-clouds', parseRadianceHdr(hdrBytes.buffer));
  return pool;
}`;
