// Triplanar splat layers on a tilted face (#2937): a side plane stretches the texture by 1 / sin(slope), so a 30 degree face
// must stay on the top plane even though the slope range (12 to 32 degrees) has already started fading side planes in.
// The layer texture is red in the top half and blue in the bottom half, and the test point is chosen so the top plane reads
// red and the side plane reads blue there. A flat terrain at the same point tells which colour the top plane gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDevServerPage } from './helpers/dev-server-browser.js';

const TEXTURE_SCALE_METRES = 1.5;
const SLOPE_DEGREES = 30;

// A point z on the tilted face where the top plane's v sits at 0.25 and the side plane's v sits at 0.75 of a texture period.
function findProbeDistance(slopeTangent) {
  let best = { error: Infinity, distance: 0 };
  for (let distance = 0.5 * TEXTURE_SCALE_METRES; distance < 6 * TEXTURE_SCALE_METRES; distance += 0.0005) {
    const topPhase = (distance / TEXTURE_SCALE_METRES) % 1;
    const sidePhase = ((distance * slopeTangent) / TEXTURE_SCALE_METRES) % 1;
    const error = Math.abs(topPhase - 0.25) + Math.abs(sidePhase - 0.75);
    if (error < best.error) best = { error, distance };
  }
  return best.distance;
}

async function redShareAtProbe(page, { slopeDegrees, probeDistance }) {
  const task = async ({ slopeDegrees, probeDistance, scale }) => {
    await import('/src/splat-shader.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createTerrain } = await import('/src/terrain.js');
    const image = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) };
    for (let row = 0; row < 64; row++) {
      for (let column = 0; column < 64; column++) image.data.set(row < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255], (row * 64 + column) * 4);
    }
    const flat = (fill) => ({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).map((_, index) => fill[index % 4]) });
    const layer = {
      color: { image, colorSpace: 'srgb' },
      normal: { image: flat([128, 128, 255, 255]), colorSpace: 'linear' },
      roughness: { image: flat([200, 200, 200, 255]), colorSpace: 'linear' },
      height: { image: flat([0, 0, 0, 255]), colorSpace: 'linear' },
      scale,
      triplanar: true,
    };
    const material = { color: [1, 1, 1], metallic: 0, roughness: 1, layers: [layer], splat: { antiTiling: 0, parallax: 0, variation: 0, triplanarStart: 12, triplanarEnd: 32 } };
    const slopeTangent = Math.tan((slopeDegrees * Math.PI) / 180);
    const measure = (height) => {
      const terrain = createTerrain({ size: 20, resolution: 80, chunks: 1, levels: 1, material, seed: 1, height });
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      document.body.append(canvas);
      const renderer = new CrucibleRenderer(canvas, terrain.parts, { world: true, hdr: true, depth: true, ground: false, samples: 1, pixelRatio: 1 });
      const target = [0, terrain.heightAt(0, probeDistance), probeDistance];
      const normal = [0, Math.cos((slopeDegrees * Math.PI) / 180), Math.sin((slopeDegrees * Math.PI) / 180)];
      const eye = height(0, 0) === 0 ? [target[0], target[1] + 2, target[2]] : [0, target[1] + 2 * normal[1], target[2] + 2 * normal[2]];
      renderer.render({ eye, target, up: [0, 0, -1], fov: 20, time: 0 });
      renderer.render({ eye, target, up: [0, 0, -1], fov: 20, time: 0.1 });
      const copy = document.createElement('canvas');
      copy.width = 32;
      copy.height = 32;
      const copyContext = copy.getContext('2d');
      copyContext.drawImage(canvas, 0, 0);
      const pixel = copyContext.getImageData(16, 16, 1, 1).data;
      return pixel[0] / Math.max(pixel[0] + pixel[2], 1);
    };
    return { flatShare: measure(() => 0), slopedShare: measure((x, z) => -z * slopeTangent) };
  };
  return page.evaluate(task, { slopeDegrees, probeDistance, scale: TEXTURE_SCALE_METRES });
}

test('a 30 degree face under a triplanar layer keeps the top plane, whose texture is not stretched', async context => {
  await withDevServerPage(context, async page => {
    const slopeTangent = Math.tan((SLOPE_DEGREES * Math.PI) / 180);
    const { flatShare, slopedShare } = await redShareAtProbe(page, { slopeDegrees: SLOPE_DEGREES, probeDistance: findProbeDistance(slopeTangent) });
    assert.ok(Math.abs(flatShare - 0.5) > 0.3, `the flat reference must read one colour, got a red share of ${flatShare}`);
    assert.ok(Math.abs(slopedShare - flatShare) < 0.25, `the 30 degree face reads the top plane's colour (red share ${flatShare}), got ${slopedShare}`);
  });
});
