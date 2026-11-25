import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { WATER_VOLUME_LIMIT, findWaterBody } from '../src/world-material-shader.js';
import { createFragmentShader } from '../src/shaders.js';
import { box } from '../src/geometry.js';
import { measureWaterVolumes, sampleShift } from '../scripts/measure-water-volumes.mjs';

const unitBox = box(0, 1);

function waterSheet(centre, width, depth) {
  const matrix = new Float32Array([width, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, depth, 0, centre[0], centre[1] - 0.05, centre[2], 1]);
  return { name: 'water', geometry: unitBox, matrix, material: { tag: 'water' } };
}

test('each flat water part is a volume with its own level and footprint, so bodies at different levels keep their own', () => {
  const lake = waterSheet([-2, 0, 0], 8, 8);
  const terrace = waterSheet([-2, 2.5, 10], 6, 4);
  const body = findWaterBody([terrace, lake]);
  assert.equal(body.level, 0, 'the widest body still sets the optics and level');
  assert.deepEqual(body.volumes.map(volume => Math.round(volume.level * 100) / 100), [0, 2.5]);
  const [lakeVolume, terraceVolume] = body.volumes;
  assert.deepEqual([lakeVolume.minimumX, lakeVolume.maximumX, lakeVolume.minimumZ, lakeVolume.maximumZ], [-6, 2, -4, 4]);
  assert.deepEqual([terraceVolume.minimumX, terraceVolume.maximumX, terraceVolume.minimumZ, terraceVolume.maximumZ], [-5, 1, 8, 12]);
});

test('a water part that is not flat adds no volume and the list is capped at the widest bodies', () => {
  const ribbon = { ...waterSheet([0, 0, 0], 4, 40), matrix: new Float32Array([4, 0, 0, 0, 0, 3, 0, 0, 0, 0, 40, 0, 0, 0, 0, 1]) };
  assert.equal(findWaterBody([ribbon]), null);
  const sheets = Array.from({ length: WATER_VOLUME_LIMIT + 3 }, (_, index) => waterSheet([index * 20, index, 0], 6 + index, 6 + index));
  const volumes = findWaterBody(sheets).volumes;
  assert.equal(volumes.length, WATER_VOLUME_LIMIT);
  assert.equal(Math.round(volumes[0].level), WATER_VOLUME_LIMIT + 2);
});

test('the shader tints only where a water volume holds the surface', () => {
  const source = createFragmentShader(['water']);
  assert.ok(source.includes('float waterLevelAt(vec3 point)'));
  assert.ok(source.includes('worldPosition.y < (waterSurfaceLevel = waterLevelAt(worldPosition))'));
  assert.ok(!source.includes('worldPosition.y < waterBody.x'), 'the level is no longer a global uniform');
  assert.ok(!createFragmentShader([]).includes('waterVolume'));
});

// Draws two basins and two dry patches in Chrome, so it runs only when asked:
//   RENDER_TESTS=1 node --test tests/water-volumes.test.js
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const enabled = process.env.RENDER_TESTS === '1' && existsSync(chromePath);

test('dry ground below the water level keeps its colour while the beds under water keep the tint', { skip: !enabled, timeout: 240000 }, async () => {
  const report = await measureWaterVolumes();
  assert.ok(sampleShift(report, 'dryBelowBothLevels') <= 1, 'dry patch below both levels');
  assert.ok(sampleShift(report, 'dryBelowHighLevelOnly') <= 1, 'dry patch below the high level only');
  assert.ok(sampleShift(report, 'lowBasinBed') > 20, 'the bed under the low water is tinted');
  assert.ok(sampleShift(report, 'highBasinBed') > 20, 'the bed under the high water is tinted');
});

test('sheets beyond the cap are reported once with how many were dropped', () => {
  const sheets = Array.from({ length: WATER_VOLUME_LIMIT + 2 }, (_, index) => waterSheet([index * 20, index, 0], 6 + index, 6 + index));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  try {
    findWaterBody(sheets);
    findWaterBody(sheets);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1, 'the per-frame call reports the same drop once');
  assert.match(warnings[0], /2 water sheets beyond the 8 widest/);
});

test('the water volumes cost 10 uniform vectors: 8 footprints, 2 packed levels and the count', () => {
  const source = createFragmentShader(['water']);
  assert.ok(source.includes('uniform vec4 waterVolumes[8];'));
  assert.ok(source.includes('uniform vec4 waterVolumeLevels[2];'));
});
