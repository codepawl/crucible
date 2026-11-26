import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { DIELECTRIC_GRAZING_STATE_INDEX, MATERIAL_LAYER_STATE_LENGTH, dielectricGrazingReflectance, dielectricReflectance, materialLayerState } from '../src/material-layers.js';
import { createFragmentShader } from '../src/shaders.js';
import { environmentShadingGlsl } from '../src/environment-shading.js';
import { CrucibleRenderer, groupParts } from '../src/renderer.js';
import { WebGL2GlazeBackend } from '../src/glaze-backend-webgl2.js';
import { withDevServerPage } from './helpers/dev-server-browser.js';

function drawBatchUniformsFor(material) {
  const renderer = Object.create(CrucibleRenderer.prototype);
  const uniforms = [];
  renderer.uniforms = Object.fromEntries([
    'materialDielectric', 'materialEmissionFresnel', 'materialSoftEdge', 'materialCoat', 'materialSheen',
    'materialAnisotropy', 'materialIridescence', 'lightLinkMask', 'materialToon', 'boxMapScale', 'boxMapAxis',
    'baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap',
    'hasBaseMap', 'hasNormalMap', 'hasMetallicRoughnessMap', 'hasOcclusionMap', 'hasEmissiveMap',
    'normalScale', 'occlusionStrength', 'materialMoss', 'shadowBlind', 'tintBlind', 'compositeMode', 'hasLightMap',
  ].map(name => [name, name]));
  renderer.context = {
    TEXTURE0: 33984,
    activeTexture() {},
    bindTexture() {},
    bindVertexArray() {},
    drawElementsInstanced() {},
    uniform1i(name, value) { uniforms.push([name, value]); },
    uniform1f(name, value) { uniforms.push([name, value]); },
    uniform2f(name, first, second) { uniforms.push([name, first, second]); },
    uniform3f(name, ...values) { uniforms.push([name, ...values]); },
    uniform4f(name, ...values) { uniforms.push([name, ...values]); },
  };
  renderer.backend = new WebGL2GlazeBackend(renderer.context);
  const layerState = materialLayerState(material);
  renderer.drawBatch({
    textures: [{}, {}, {}, {}, {}],
    layerState,
    mapState: [{}, {}, {}, null, {}, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1],
  }, true);
  return uniforms;
}

test('dielectricGrazingReflectance scales F90 by specularFactor and clamps at 1 (#3525)', () => {
  assert.equal(dielectricGrazingReflectance({}), 1);
  assert.equal(dielectricGrazingReflectance({ specular: 0 }), 0);
  assert.equal(dielectricGrazingReflectance({ specular: 0.35, specularColor: [1, 0.2, 0] }), 0.35);
  assert.equal(dielectricGrazingReflectance({ specular: 2.5 }), 1);
  assert.deepEqual(dielectricReflectance({ ior: 1, specular: 1 }), [0, 0, 0]);
  assert.deepEqual(dielectricReflectance({ ior: 1.5, specular: 0 }), [0, 0, 0]);
});

test('materialLayerState and groupParts distinguish F0=0 from ior=1 vs specular=0 (#3525)', () => {
  const zeroIor = materialLayerState({ ior: 1, specular: 1 });
  const zeroSpecular = materialLayerState({ ior: 1.5, specular: 0 });
  assert.equal(zeroIor.length, MATERIAL_LAYER_STATE_LENGTH);
  assert.equal(zeroIor[DIELECTRIC_GRAZING_STATE_INDEX], 1);
  assert.equal(zeroSpecular[DIELECTRIC_GRAZING_STATE_INDEX], 0);
  assert.notDeepEqual(zeroIor, zeroSpecular);

  const geometry = box(0, 1);
  const batches = groupParts([
    { name: 'ior1', geometry, matrix: mat4.create(), material: { color: [0.2, 0.2, 0.2], metallic: 0, roughness: 0.5, ior: 1, specular: 1 } },
    { name: 'spec0', geometry, matrix: mat4.create(), material: { color: [0.2, 0.2, 0.2], metallic: 0, roughness: 0.5, ior: 1.5, specular: 0 } },
  ]);
  assert.equal(batches.length, 2, 'parts with identical F0=[0,0,0] but distinct F90 must batch separately');
});

test('drawBatch uploads F0 in materialDielectric.rgb and grazing F90 in materialDielectric.w', () => {
  const zero = drawBatchUniformsFor({ specular: 0 }).find(entry => entry[0] === 'materialDielectric');
  assert.deepEqual(zero.slice(1), [0, 0, 0, 0]);

  const half = drawBatchUniformsFor({ specular: 0.5, specularColor: [1, 0.5, 0] }).find(entry => entry[0] === 'materialDielectric');
  assert.ok(Math.abs(half[1] - 0.02) < 1e-9);
  assert.ok(Math.abs(half[2] - 0.01) < 1e-9);
  assert.equal(half[3], 0);
  assert.equal(half[4], 0.5);

  const boosted = drawBatchUniformsFor({ specular: 2 }).find(entry => entry[0] === 'materialDielectric');
  assert.ok(Math.abs(boosted[1] - 0.08) < 1e-9);
  assert.equal(boosted[4], 1);
});

test('fragment shader and environmentShadingGlsl propagate grazing F90 while keeping metals at 1.0', () => {
  const withEnv = createFragmentShader(['environmentMap']);
  assert.match(withEnv, /uniform vec4 materialDielectric;/);
  assert.match(withEnv, /vec3 fresnel\(float cosine, vec3 reflectance, float grazing\)/);
  assert.match(withEnv, /return reflectance \+ \(vec3\(grazing\) - reflectance\) \* weight;/);
  assert.match(withEnv, /float grazingReflectance = mix\(materialDielectric\.w, 1\.0, metallic\);/);
  assert.match(withEnv, /fresnel\(max\(dot\(normal, viewDirection\), 0\.001\), vec3\(0\.04\), 1\.0\)/);
  assert.match(withEnv, /multipleScatterGain\(brdfLookup, baseReflectance, grazingReflectance\)/);

  const withoutEnv = createFragmentShader(['studioLighting']);
  assert.match(withoutEnv, /vec3 multipleScatterGain\(vec2 lookup, vec3 baseReflectance, float grazingReflectance\)/);
  assert.match(withoutEnv, /vec3 environmentLighting\(vec3 normal, vec3 specularNormal, vec3 baseReflectance, vec3 viewDirection, vec3 reflected, vec3 color, float metallic, float roughness, float occlusion, float ambient, float specularWeight\)/);

  assert.match(environmentShadingGlsl, /vec3 averageFresnel = baseReflectance \+ \(vec3\(grazingReflectance\) - baseReflectance\) \/ 21\.0;/);
  assert.match(environmentShadingGlsl, /vec3 fittedColor = \(baseReflectance \* fitted\.x \+ grazingReflectance \* fitted\.y\) \* specularWeight;/);
  assert.match(environmentShadingGlsl, /vec3 singleScatter = baseReflectance \* lookup\.x \+ grazingReflectance \* lookup\.y;/);
});

test('WebGL2 render removes grazing sky rim when specular=0 while preserving specular=1 and metals (#3525)', async (context) => {
  await withDevServerPage(context, async (page) => {
    const result = await page.evaluate(async () => {
      const { box } = await import('/src/geometry.js');
      const { createEnvironmentMap } = await import('/src/environment.js');
      const { CrucibleRenderer } = await import('/src/renderer.js');

      const width = 300;
      const height = 180;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      document.body.append(canvas);

      const copy = document.createElement('canvas');
      copy.width = width;
      copy.height = height;
      const copyContext = copy.getContext('2d', { willReadFrequently: true });

      const skyData = new Float32Array(32 * 16 * 3);
      for (let row = 0; row < 16; row++) {
        const color = row < 8 ? [1.6, 2.1, 2.8] : [0.05, 0.05, 0.06];
        for (let column = 0; column < 32; column++) {
          skyData.set(color, (row * 32 + column) * 3);
        }
      }
      const map = createEnvironmentMap({ width: 32, height: 16, data: skyData, intensity: 1, showBackground: false });
      const environment = {
        map,
        keyColor: [0.35, 0.34, 0.32],
        keyIntensity: 0.35,
        lightDirection: [1, 1.5, 4],
        fillIntensity: 0,
        ambientIntensity: 1,
      };

      const placed = (scale, x, y, z) => new Float32Array([
        scale[0], 0, 0, 0,
        0, scale[1], 0, 0,
        0, 0, scale[2], 0,
        x, y, z, 1,
      ]);

      const geometry = box(0.03, 2);
      const parts = [
        { name: 'spec0', geometry, matrix: placed([1.2, 1.4, 1.2], -1.65, 0.7, 0), material: { tag: 'surface', color: [0.04, 0.06, 0.12], metallic: 0, roughness: 0.5, specular: 0 } },
        { name: 'spec1', geometry, matrix: placed([1.2, 1.4, 1.2], 0, 0.7, 0), material: { tag: 'surface', color: [0.04, 0.06, 0.12], metallic: 0, roughness: 0.5, specular: 1 } },
        { name: 'metal0', geometry, matrix: placed([1.2, 1.4, 1.2], 1.65, 0.7, 0), material: { tag: 'surface', color: [0.65, 0.45, 0.15], metallic: 1, roughness: 0.4, specular: 0 } },
      ];

      const luminance = (pixels, x, y) => {
        const offset = (y * width + x) * 4;
        return 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
      };

      const measureMode = (shading, useEnvironment) => {
        const activeEnvironment = useEnvironment ? environment : { keyColor: [0.35, 0.34, 0.32], keyIntensity: 0.35, lightDirection: [1, 1.5, 4], fillIntensity: 0, ambientIntensity: 1 };
        const renderer = new CrucibleRenderer(canvas, parts, {
          ground: false,
          world: false,
          samples: 1,
          pixelRatio: 1,
          hdr: true,
          shading,
          environment: activeEnvironment,
        });
        renderer.resize();
        const frame = { eye: [0, 1.54, 4.9], target: [0, 1.02, 0], fov: 32, up: [0, 1, 0], exposure: 1, environment: activeEnvironment };
        renderer.render(frame);
        renderer.render(frame);
        const glError = renderer.context.getError();
        copyContext.drawImage(canvas, 0, 0);
        const pixels = copyContext.getImageData(0, 0, width, height).data;
        renderer.dispose();
        // Top grazing face sits near row 66 (y = 0.367 * 180) and front face sits near row 100.
        return {
          glError,
          spec0Top: luminance(pixels, 50, 66),
          spec1Top: luminance(pixels, 150, 66),
          metalTop: luminance(pixels, 250, 66),
          spec0Front: luminance(pixels, 50, 100),
          spec1Front: luminance(pixels, 150, 100),
        };
      };

      return {
        full: measureMode('full', true),
        light: measureMode('light', true),
        studio: measureMode('full', false),
      };
    });

    for (const [modeName, metrics] of Object.entries(result)) {
      assert.equal(metrics.glError, 0, `${modeName} WebGL error`);
      const minimumSpread = modeName === 'studio' ? 5 : 20;
      const minimumMetal = modeName === 'studio' ? 55 : 140;
      assert.ok(metrics.spec1Top - metrics.spec0Top > minimumSpread, `${modeName}: specular=0 grazing top (${metrics.spec0Top.toFixed(1)}) must be much darker than specular=1 (${metrics.spec1Top.toFixed(1)})`);
      assert.ok(metrics.metalTop > minimumMetal, `${modeName}: metal with specular=0 must keep bright metallic grazing reflection (${metrics.metalTop.toFixed(1)})`);
    }
  });
});
