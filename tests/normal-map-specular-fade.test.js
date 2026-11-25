// #3111: a normal map that holds a sub-pixel bevel (the rim of a mapped sphere) made every light sparkle once per pixel along the
// silhouette of a metal surface. The pixel test draws such a sphere in headless Chrome (SwiftShader on CI, whatever GL Chrome gets on a
// developer machine) and counts the bright rim pixels. It skips where Chrome cannot start on a developer machine and fails on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFragmentShader } from '../src/shaders.js';
import { withDevServerPage } from './helpers/dev-server-browser.js';

const FADE = 'normalMapSpecularFade';

// Measured on this scene (Chrome on Metal): 129 rim pixels without the fade, 25 with it. The limit sits between the two, below half of the unfixed count.
const MAXIMUM_SPECKLE_PIXELS = 60;

test('a shader without a normal map carries none of the specular fade code', () => {
  for (const features of [[], ['baseMap'], ['metallicRoughnessMap', 'occlusionMap']]) {
    assert.equal(createFragmentShader(features).includes(FADE), false, `features ${features.join(',') || 'none'}`);
  }
});

// Draws metal spheres whose normal map is a disc of sphere normals with a one-texel bevel, lit by three point lights, and returns the
// rim pixels (a ring from 5 px inside to 1 px outside the silhouette) whose luminance is more than 25 above the median of their 5x5 neighbourhood.
async function countRimSpeckle(page, margin = 25, roughness = 0.25) {
  return page.evaluate(async ({ brightnessMargin, roughness }) => {
    const { grid } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const TEXELS = 256;
    const DISC_RADIUS = 120;
    const map = document.createElement('canvas');
    map.width = TEXELS;
    map.height = TEXELS;
    const context = map.getContext('2d');
    const pixels = context.createImageData(TEXELS, TEXELS);
    for (let row = 0; row < TEXELS; row++) {
      for (let column = 0; column < TEXELS; column++) {
        const x = (column + 0.5 - TEXELS / 2) / DISC_RADIUS;
        const y = (TEXELS / 2 - row - 0.5) / DISC_RADIUS;
        const radius = Math.hypot(x, y);
        let normal = [0, 0, 1];
        if (radius <= 1) normal = [x, y, Math.sqrt(Math.max(1 - radius * radius, 0.0025))];
        const length = Math.hypot(...normal);
        for (let channel = 0; channel < 3; channel++) pixels.data[(row * TEXELS + column) * 4 + channel] = Math.round((normal[channel] / length * 0.5 + 0.5) * 255);
        pixels.data[(row * TEXELS + column) * 4 + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
    const SIZE = 128;
    const canvas = document.createElement('canvas');
    canvas.style.width = `${SIZE}px`;
    canvas.style.height = `${SIZE}px`;
    document.body.append(canvas);
    const metal = { tag: 'surface', color: [0.9, 0.9, 0.95], metallic: 1, roughness, emission: 0, normalMap: { image: map, colorSpace: 'linear', minFilter: 9987, magFilter: 9729 } };
    const quad = { name: 'mapped sphere', geometry: grid(1), matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), material: metal };
    const sky = [0.05, 0.05, 0.06];
    const environment = {
      skyTop: sky,
      skyBottom: sky,
      lightDirection: [0.3, 0.5, 1],
      pointLights: [{ position: [-1.5, 1.5, 2], intensity: 12 }, { position: [1.5, 1.5, 2], intensity: 12 }, { position: [0, -2, 2], intensity: 12 }],
    };
    const renderer = new CrucibleRenderer(canvas, [quad], { samples: 1, pixelRatio: 1, ground: false });
    renderer.resize();
    const frame = { eye: [0, 0, 1.43], target: [0, 0, 0], fov: 40, environment };
    renderer.render(frame);
    renderer.render(frame);
    const raw = new Uint8Array(SIZE * SIZE * 4);
    renderer.context.readPixels(0, 0, SIZE, SIZE, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, raw);
    const luminance = (x, y) => {
      const offset = ((SIZE - 1 - y) * SIZE + x) * 4;
      return 0.2126 * raw[offset] + 0.7152 * raw[offset + 1] + 0.0722 * raw[offset + 2];
    };
    const half = SIZE / 2;
    const radiusInPixels = DISC_RADIUS / TEXELS * half / (1.43 * Math.tan(20 * Math.PI / 180));
    let speckle = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const distance = Math.hypot(x + 0.5 - half, y + 0.5 - half);
        if (distance < radiusInPixels - 5 || distance > radiusInPixels + 1) continue;
        const neighbours = [];
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) neighbours.push(luminance(Math.min(SIZE - 1, Math.max(0, x + dx)), Math.min(SIZE - 1, Math.max(0, y + dy))));
        neighbours.sort((a, b) => a - b);
        if (luminance(x, y) - neighbours[12] > brightnessMargin) speckle++;
      }
    }
    return speckle;
  }, { brightnessMargin: margin, roughness });
}

test('metal with a bevelled normal map keeps a clean rim instead of one bright pixel per light', async (context) => {
  await withDevServerPage(context, async (page) => {
    const speckle = await countRimSpeckle(page);
    assert.ok(speckle <= MAXIMUM_SPECKLE_PIXELS, `${speckle} bright rim pixels, at most ${MAXIMUM_SPECKLE_PIXELS} expected; the direct specular of a normal-mapped shader must fade where the mapped normal varies across the pixel (NORMAL_MAP_SPECULAR_CODE in src/shaders.js)`);
  });
});

// #3142: at the narrowest highlight the material allows (roughness 0.075) the linear fade alone still left a bead wherever the normal
// turns fast across a pixel. Measured on this scene (GPU Chrome, bright means 25 above the neighbourhood median): 97 pixels before the
// knee of the fade, 67 after. The limit sits between the two. The linear fade cannot be rendered beside the cubic one in the same run
// (no switch in the shader, and a test-only one would add code to every normal-mapped shader), so the limit stays fixed.
const NARROW_HIGHLIGHT_ROUGHNESS = 0.075;
const MAXIMUM_NARROW_HIGHLIGHT_SPECKLE_PIXELS = 80;

test('a narrow highlight on a normal-mapped silhouette leaves fewer beads than the linear fade alone', async (context) => {
  await withDevServerPage(context, async (page) => {
    const speckle = await countRimSpeckle(page, 25, NARROW_HIGHLIGHT_ROUGHNESS);
    assert.ok(speckle <= MAXIMUM_NARROW_HIGHLIGHT_SPECKLE_PIXELS, `measured ${speckle} bright rim pixels at roughness ${NARROW_HIGHLIGHT_ROUGHNESS}, at most ${MAXIMUM_NARROW_HIGHLIGHT_SPECKLE_PIXELS} expected (on the GPU that set the limit: 97 with the linear fade alone, 67 with the knee); the specular fade must close where the normal variance across a pixel is large.`);
  });
});
