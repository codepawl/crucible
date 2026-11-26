import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFragmentShader } from '../src/shaders.js';
import '../src/world-material-shader.js';
import { withDevServerPage } from './helpers/dev-server-browser.js';

test('water shader encodes above-water opaque height in alpha, limits refraction to below-water depth, and searches screen-space waterline edges', () => {
  const shader = createFragmentShader(['water', 'vertexColors']);
  assert.match(shader, /alpha = 0\.5 - 0\.498 \* clamp\(max\(worldPosition\.y - waterBody\.x, 0\.0\) \/ 8\.0, 0\.0, 1\.0\);/);
  assert.match(shader, /stored > 0\.5 && stored < 0\.999/);
  assert.match(shader, /sampled\.a > 0\.5 && sampled\.a < 0\.999/);
  assert.match(shader, /waterContactEdgeFoam\(/);
  assert.match(shader, /bool waterSceneEmergent\(/);
});

test('HDR entry points disable compact colour when a scene uses blended water so waterScene alpha is preserved', () => {
  for (const relativePath of ['src/file-scene.js', 'src/crucible-scene.js', 'src/showcase.js', 'scripts/agent-preview-browser.js']) {
    const source = readFileSync(relativePath, 'utf8');
    assert.match(source, /compactColor:\s*!hasBlendedWater/, `${relativePath} keeps RGBA16F for blended water scenes`);
  }
});

test('grazing vertical hulls and rocks draw a steady waterline contact foam rim while open sea, overhangs, and shores behave cleanly', { timeout: 120000 }, async (testContext) => {
  await withDevServerPage(testContext, async (page) => {
    const metrics = await page.evaluate(async () => {
      const { CrucibleRenderer } = await import('/src/renderer.js');
      const { box, sphere } = await import('/src/geometry.js');
      await import('/src/world-material-shader.js');

      const unitBox = box(0, 1);
      const rockGeometry = sphere();
      const flaredBowGeometry = (() => {
        const base = box(0, 4);
        const positions = new Float32Array(base.positions);
        for (let index = 0; index < positions.length; index += 3) {
          const vertical = positions[index + 1];
          if (vertical < -0.005) {
            positions[index] *= 0.25;
            positions[index + 2] *= 0.25;
          }
        }
        return { ...base, positions };
      })();

      const placed = (name, geometry, center, size, material) => ({
        name,
        geometry,
        matrix: new Float32Array([
          size[0], 0, 0, 0,
          0, size[1], 0, 0,
          0, 0, size[2], 0,
          center[0], center[1], center[2], 1,
        ]),
        material,
      });

      const hullMaterial = { tag: 'surface', color: [0.18, 0.12, 0.08], metallic: 0, roughness: 0.75, emission: 0, doubleSided: true };
      const rockMaterial = { tag: 'surface', color: [0.22, 0.21, 0.2], metallic: 0, roughness: 0.85, emission: 0 };
      const bedMaterial = { tag: 'surface', color: [0.06, 0.1, 0.12], metallic: 0, roughness: 0.9, emission: 0 };
      const waterWithFoam = {
        tag: 'water', color: [0.02, 0.08, 0.12], metallic: 0, roughness: 0.1, emission: 0,
        alphaMode: 'blend', opacity: 0.98, waterPreset: 'sea',
        contactFoam: { width: 6, hardness: 0.7, noise: 0.3, drift: 0, rim: true, color: [0.92, 0.95, 0.97] },
      };
      const waterWithoutFoam = {
        tag: 'water', color: [0.02, 0.08, 0.12], metallic: 0, roughness: 0.1, emission: 0,
        alphaMode: 'blend', opacity: 0.98, waterPreset: 'sea',
      };

      const width = 480;
      const height = 270;
      const compareFrames = (partsOn, partsOff, camera) => {
        const drawPixels = (parts) => {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          document.body.append(canvas);
          const renderer = new CrucibleRenderer(canvas, parts, {
            hdr: false,
            depth: false,
            world: true,
            ground: false,
            pixelRatio: 1,
            samples: 1,
            environment: { lightDirection: [-3, 6, 4], keyColor: [3, 2.8, 2.5], skyTop: [0.2, 0.38, 0.52], skyBottom: [0.62, 0.7, 0.67] },
          });
          renderer.render({ ...camera, fov: 45, near: 0.5, far: 500, time: 0 });
          const context = renderer.context;
          const pixels = new Uint8Array(width * height * 4);
          context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
          renderer.dispose?.();
          canvas.remove();
          return pixels;
        };

        const withPixels = drawPixels(partsOn);
        const withoutPixels = drawPixels(partsOff);
        let diffAbove40 = 0;
        let maxDiff = 0;
        let leftFlankDiff = 0;
        for (let row = 0; row < height; row++) {
          for (let column = 0; column < width; column++) {
            const offset = (row * width + column) * 4;
            const channelDiff = Math.max(
              Math.abs(withPixels[offset] - withoutPixels[offset]),
              Math.abs(withPixels[offset + 1] - withoutPixels[offset + 1]),
              Math.abs(withPixels[offset + 2] - withoutPixels[offset + 2])
            );
            if (channelDiff > 40) {
              diffAbove40 += 1;
              if (column < width * 0.48) {
                leftFlankDiff += 1;
              }
            }
            if (channelDiff > maxDiff) {
              maxDiff = channelDiff;
            }
          }
        }
        return { diffAbove40, leftFlankDiff, maxDiff };
      };

      const grazingCamera = { eye: [36, 3.6, 17], target: [0, 0.2, 0], up: [0, 1, 0] };
      const hullParts = (water) => [
        placed('seabed', unitBox, [0, -10.5, 0], [300, 1, 300], bedMaterial),
        placed('hull', unitBox, [0, 0.3, 0], [16, 5.0, 4], hullMaterial),
        placed('flaredBow', flaredBowGeometry, [-14, 0.3, 4], [6, 5.0, 3], hullMaterial),
        placed('rock', rockGeometry, [14, 0.8, 4], [2.5, 2.5, 2.0], rockMaterial),
        placed('water', unitBox, [0, -0.05, 0], [300, 0.1, 300], water),
      ];
      const hull = compareFrames(hullParts(waterWithFoam), hullParts(waterWithoutFoam), grazingCamera);
      const bowOnlyParts = (water) => [
        placed('seabed', unitBox, [0, -10.5, 0], [300, 1, 300], bedMaterial),
        placed('flaredBow', flaredBowGeometry, [0, 0.3, 0], [10, 5.0, 4], hullMaterial),
        placed('water', unitBox, [0, -0.05, 0], [300, 0.1, 300], water),
      ];
      const flaredBow = compareFrames(bowOnlyParts(waterWithFoam), bowOnlyParts(waterWithoutFoam), grazingCamera);

      const openParts = (water) => [
        placed('seabed', unitBox, [0, -10.5, 0], [300, 1, 300], bedMaterial),
        placed('water', unitBox, [0, -0.05, 0], [300, 0.1, 300], water),
      ];
      const openSea = compareFrames(openParts(waterWithFoam), openParts(waterWithoutFoam), { eye: [0, 3.6, 40], target: [0, 0.2, 0], up: [0, 1, 0] });

      const overhangParts = (water) => [
        placed('seabed', unitBox, [0, -10.5, 0], [300, 1, 300], bedMaterial),
        placed('bridge', unitBox, [0, 2.0, 0], [12, 1.0, 4], hullMaterial),
        placed('water', unitBox, [0, -0.05, 0], [300, 0.1, 300], water),
      ];
      const overhang = compareFrames(overhangParts(waterWithFoam), overhangParts(waterWithoutFoam), { eye: [0, 3.6, 40], target: [0, 1.0, 0], up: [0, 1, 0] });

      const shoreParts = (water) => [
        placed('seabed', unitBox, [0, -10.5, 0], [300, 1, 300], bedMaterial),
        placed('shore', unitBox, [-8, -0.2, 0], [16, 2.0, 20], rockMaterial),
        placed('water', unitBox, [0, -0.05, 0], [300, 0.1, 300], water),
      ];
      const shore = compareFrames(shoreParts(waterWithFoam), shoreParts(waterWithoutFoam), { eye: [18, 5, 22], target: [0, 0, 0], up: [0, 1, 0] });

      return { hull, flaredBow, openSea, overhang, shore };
    });

    assert.ok(metrics.hull.diffAbove40 > 350, `expected > 350 waterline rim pixels on grazing hull and rock, got ${metrics.hull.diffAbove40}`);
    assert.ok(metrics.hull.leftFlankDiff > 40, `expected > 40 rim pixels on the grazing hull flank, got ${metrics.hull.leftFlankDiff}`);
    assert.ok(metrics.flaredBow.diffAbove40 > 120, `expected > 120 waterline rim pixels on flared overhanging hull, got ${metrics.flaredBow.diffAbove40}`);
    assert.equal(metrics.openSea.diffAbove40, 0, `expected 0 foam pixels on open sea/horizon, got ${metrics.openSea.diffAbove40}`);
    assert.equal(metrics.openSea.maxDiff, 0, `expected 0 grey-level change on open sea/horizon, got ${metrics.openSea.maxDiff}`);
    assert.equal(metrics.overhang.diffAbove40, 0, `expected 0 high-diff foam pixels on floating overhang, got ${metrics.overhang.diffAbove40}`);
    assert.ok(metrics.shore.diffAbove40 > 200, `expected > 200 foam pixels along shore, got ${metrics.shore.diffAbove40}`);
  });
});
