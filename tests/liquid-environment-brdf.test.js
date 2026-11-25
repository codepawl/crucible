// A rough transmissive liquid part builds its refraction mip chain and depth target during drawTranslucent.
// Leaving GL's active texture unit on TEXTURE10 (environmentBrdf) caused those binds to overwrite the BRDF LUT
// and turn subsequent lit alphaMode: 'blend' decals black (#3468).
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDevServerPage } from './helpers/dev-server-browser.js';

const IMAGE_WIDTH = 256;
const IMAGE_HEIGHT = 128;

async function renderLiquidAndBlendDecal(page) {
  const task = async ({ imageWidth, imageHeight }) => {
    const { box, sphere } = await import('/src/geometry.js');
    await import('/src/liquid-shader.js');
    const { createEnvironmentMap } = await import('/src/environment.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');

    const canvas = document.createElement('canvas');
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    document.body.append(canvas);

    const copy = document.createElement('canvas');
    copy.width = imageWidth;
    copy.height = imageHeight;
    const copyContext = copy.getContext('2d', { willReadFrequently: true });

    const placed = (scale, x, y, z) => new Float32Array([
      scale[0], 0, 0, 0,
      0, scale[1], 0, 0,
      0, 0, scale[2], 0,
      x, y, z, 1,
    ]);

    const parts = [
      {
        name: 'backdrop',
        geometry: box(0, 1),
        matrix: placed([12, 6, 0.2], 0, 0, -2),
        material: { id: 'backdrop-mat', tag: 'surface', color: [0.04, 0.04, 0.06], metallic: 0, roughness: 0.9 },
      },
      {
        name: 'rough-glass',
        geometry: sphere(24, 16),
        matrix: placed([0.85, 0.85, 0.85], -1.2, 0, 0),
        material: { id: 'glass-mat', tag: 'surface', color: [0.9, 0.95, 1], metallic: 0, roughness: 0.45, alphaMode: 'blend', opacity: 0.6, transmission: 0.85, ior: 1.5, thickness: 0.4 },
      },
      {
        name: 'lit-blend-decal',
        geometry: box(0, 1),
        matrix: placed([1.4, 1.4, 0.1], 1.1, 0, 0),
        material: { id: 'decal-mat', tag: 'surface', color: [0.85, 0.85, 0.85], metallic: 0, roughness: 0.5, alphaMode: 'blend', opacity: 0.9 },
      },
    ];

    const skyData = new Float32Array(8 * 4 * 3).fill(1.4);
    const environmentMap = createEnvironmentMap({ width: 8, height: 4, data: skyData, intensity: 1.5 });
    const environment = { map: environmentMap, keyColor: [0, 0, 0], fillIntensity: 0, ambientIntensity: 1 };
    const renderer = new CrucibleRenderer(canvas, parts, { ground: false, world: false, samples: 1, pixelRatio: 1, depth: true, hdr: true, environment });
    renderer.resize();

    const frame = { eye: [0, 0, 6], target: [0, 0, 0], fov: 35, up: [0, 1, 0], exposure: 1, environment };
    renderer.render(frame);
    renderer.render(frame);

    const context = renderer.context;
    const glError = context.getError();
    context.activeTexture(context.TEXTURE10);
    const boundOnTexture10 = context.getParameter(context.TEXTURE_BINDING_2D);
    const brdfBoundIntact = boundOnTexture10 === renderer.environmentResources?.brdfTexture;

    copyContext.drawImage(canvas, 0, 0, imageWidth, imageHeight);
    const pixels = copyContext.getImageData(0, 0, imageWidth, imageHeight).data;
    const sampleColumn = Math.round(imageWidth * 0.68);
    const sampleRow = Math.round(imageHeight * 0.5);
    const offset = (sampleRow * imageWidth + sampleColumn) * 4;
    const decalRgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];

    renderer.dispose();
    return { glError, brdfBoundIntact, decalRgb };
  };
  return page.evaluate(task, { imageWidth: IMAGE_WIDTH, imageHeight: IMAGE_HEIGHT });
}

test('rough transmissive liquid pass keeps environmentBrdf bound on TEXTURE10 so subsequent blend decals stay lit (#3468)', async (testContext) => {
  await withDevServerPage(testContext, async (page) => {
    const result = await renderLiquidAndBlendDecal(page);
    assert.equal(result.glError, 0, `expected zero WebGL errors, got ${result.glError}`);
    assert.equal(result.brdfBoundIntact, true, 'TEXTURE10 must stay bound to environmentResources.brdfTexture after liquid pass');
    assert.ok(result.decalRgb[0] > 200 && result.decalRgb[1] > 200 && result.decalRgb[2] > 200, `lit blend decal must stay bright under HDRI, got rgb(${result.decalRgb.join(', ')})`);
  });
});
