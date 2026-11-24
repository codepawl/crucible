// A blended material with transmission above 0 draws in the liquid pass; it once dropped its emission there (#3279).
// It draws in headless Chrome (SwiftShader, no GPU) from the Vite dev server, and skips when Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDevServerPage } from './helpers/dev-server-browser.js';
import { liquidFragmentSource } from '../src/shaders.js';
import '../src/liquid-shader.js';

const IMAGE_SIZE = 128;
// Display levels (0 to 255) a glowing pane must add over the same pane without emission.
const GLOW_MINIMUM = 40;
// A Fresnel rim must be brighter than the face-on centre of the same sphere by at least this many display levels.
const RIM_MINIMUM = 20;

test('the liquid program adds the emission of a part, with the Fresnel factor of a graph', () => {
  const source = liquidFragmentSource();
  assert.match(source, /instanceEmission\.rgb \* surface\.z/);
  assert.match(source, /uniform float materialEmissionFresnel/);
});

// Draws a grey wall behind a blended glass sphere and returns the luma of the sphere's centre and of a pixel near its rim.
async function drawPane(page, { transmission, emission, emissionFresnel }) {
  const task = async ({ imageSize, transmission, emission, emissionFresnel }) => {
    const { box, sphere } = await import('/src/geometry.js');
    await import('/src/liquid-shader.js');
    await import('/src/material-layer-shaders.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.width = imageSize;
    canvas.height = imageSize;
    document.body.append(canvas);
    const copy = document.createElement('canvas');
    copy.width = imageSize;
    copy.height = imageSize;
    const copyContext = copy.getContext('2d', { willReadFrequently: true });
    const placed = (scale, x, y, z) => new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, x, y, z, 1]);
    const wall = { name: 'wall', geometry: box(0, 1), matrix: placed([8, 8, 0.1], 0, 0, -1), material: { id: 'wall-material', tag: 'surface', color: [0.05, 0.05, 0.05], metallic: 0, roughness: 0.9 } };
    const glass = {
      name: 'glass',
      geometry: sphere(48, 32),
      matrix: placed([1, 1, 1], 0, 0, 0),
      material: { id: 'glass-material', tag: 'surface', color: [1, 1, 1], metallic: 0, roughness: 0.1, alphaMode: 'blend', opacity: 0.4, transmission, ior: 1.5, thickness: 0.2, emission, emissionFresnel },
    };
    const renderer = new CrucibleRenderer(canvas, [wall, glass], { ground: false, world: true, samples: 1, pixelRatio: 1, depth: true });
    renderer.resize();
    const frame = { eye: [0, 0, 5], target: [0, 0, 0], fov: 30, up: [0, 1, 0], time: 0, wind: 0, exposure: 0.4 };
    renderer.render(frame);
    renderer.render(frame);
    copyContext.drawImage(canvas, 0, 0, imageSize, imageSize);
    const pixels = copyContext.getImageData(0, 0, imageSize, imageSize).data;
    const lumaAt = (column, row) => {
      const index = (row * imageSize + column) * 4;
      return 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    };
    const middle = imageSize / 2;
    // The sphere of radius 1 at 5 m with a 30 degree field fills about 0.7 of the frame: 0.45 of the half width is well inside it, 0.9 near its silhouette.
    const radiusPixels = imageSize * 0.5 * Math.tan(Math.asin(1 / 5)) / Math.tan(15 * Math.PI / 180);
    const result = { centre: lumaAt(middle, middle), rim: lumaAt(Math.round(middle + radiusPixels * 0.93), middle) };
    renderer.dispose();
    return result;
  };
  return page.evaluate(task, { imageSize: IMAGE_SIZE, transmission, emission, emissionFresnel });
}

test('a blended glass sphere with transmission keeps its emission, and a Fresnel emission glows at the rim', async (context) => {
  await withDevServerPage(context, async (page) => {
    const dark = await drawPane(page, { transmission: 0.3, emission: 0, emissionFresnel: 0 });
    const glowing = await drawPane(page, { transmission: 0.3, emission: 100, emissionFresnel: 0 });
    assert.ok(glowing.centre - dark.centre >= GLOW_MINIMUM, `emission lifted the centre by ${glowing.centre - dark.centre} display levels; it must reach ${GLOW_MINIMUM}`);
    const rimmed = await drawPane(page, { transmission: 0.3, emission: 100, emissionFresnel: 1.01 });
    assert.ok(rimmed.rim - rimmed.centre >= RIM_MINIMUM, `the Fresnel rim stood ${rimmed.rim - rimmed.centre} display levels above the centre; it must reach ${RIM_MINIMUM}`);
    const rimmedDark = await drawPane(page, { transmission: 0.3, emission: 0, emissionFresnel: 1.01 });
    assert.ok(rimmed.rim - rimmedDark.rim >= GLOW_MINIMUM, `the Fresnel emission lifted the rim by ${rimmed.rim - rimmedDark.rim} display levels; it must reach ${GLOW_MINIMUM}`);
  });
});
