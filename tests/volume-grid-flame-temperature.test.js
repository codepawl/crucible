// Blender's flame remap for grid volumes (#1735): `flame > 0.01 ? ignition + flame * (maximum - ignition) : 0` makes every voxel with flame emit by its
// flame value, whatever its smoke density, which is the orange rim along the smoke edge of a Cycles fire.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bakedGridEmission, decodeVolumeGrid, encodeVolumeGrid, flameToTemperature, floatToHalf, gridTemperature, blackbodyRadiance } from '../src/volume-grid.js';
import { resolveLocalVolumes } from '../src/local-volumes.js';
import { cookGridVolume } from '../src/path-tracer-native-volumes.js';
import '../src/fog-shader.js';
import { requireFeatureCode } from '../src/shader-registry.js';
import { createPostFragment } from '../src/post.js';

const BLENDER_FIRE = { ignition: 1.5, maximum: 3 };

// Four voxels in a row: thick smoke with flame, thin smoke with flame, smoke with no flame, flame below the cut-off. The temperature channel is cool everywhere.
function fourVoxelGrid() {
  return decodeVolumeGrid(encodeVolumeGrid({
    resolution: [4, 1, 1],
    channels: {
      density: Float32Array.of(1, 0.01, 1, 1),
      temperature: Float32Array.of(0.1, 0.1, 0.1, 0.1),
      flame: Float32Array.of(0.5, 0.5, 0, 0.005),
    },
  }));
}

test('the flame remap is 0 up to the 0.01 cut-off, then ignition plus flame times the span', () => {
  assert.equal(flameToTemperature(0, BLENDER_FIRE), 0);
  assert.equal(flameToTemperature(0.01, BLENDER_FIRE), 0);
  assert.equal(flameToTemperature(0.5, BLENDER_FIRE), 2.25);
  assert.equal(flameToTemperature(1, BLENDER_FIRE), 3);
  assert.ok(Math.abs(flameToTemperature(0.0101, BLENDER_FIRE) - 1.5) < 0.02, 'a faint flame already sits at the ignition temperature, not at 0');
});

test('with the remap the emission comes from the flame grid and not from the smoke density', () => {
  const grid = fourVoxelGrid();
  const baked = bakedGridEmission(grid, 1000, BLENDER_FIRE);
  const expected = blackbodyRadiance(2250, [0, 0, 0]);
  for (const voxel of [0, 1]) {
    assert.ok(Math.abs(baked.red[voxel] - expected[0]) <= expected[0] * 1e-6, `voxel ${voxel} red`);
    assert.ok(Math.abs(baked.green[voxel] - expected[1]) <= expected[1] * 1e-6, `voxel ${voxel} green`);
  }
  assert.equal(baked.red[0], baked.red[1], 'density 1 and density 0.01 emit the same');
  assert.equal(baked.red[2], 0, 'no flame, no emission');
  assert.equal(baked.red[3], 0, 'a flame under the cut-off is cold');
});

test('without the remap the grid bakes its temperature channel as before, and the two bakes do not share a cache', () => {
  const grid = fourVoxelGrid();
  const plain = bakedGridEmission(grid, 1000);
  const remapped = bakedGridEmission(grid, 1000, BLENDER_FIRE);
  const cool = blackbodyRadiance(gridTemperature(grid)[2] * 1000, [0, 0, 0]);
  assert.ok(Math.abs(plain.red[2] - cool[0]) <= cool[0] * 1e-6);
  assert.notEqual(plain, remapped);
  assert.equal(bakedGridEmission(grid, 1000), bakedGridEmission(grid, 1000), 'the plain bake is still cached');
  assert.equal(gridTemperature(grid), gridTemperature(grid, null));
});

test('a grid without a flame channel bakes to no emission under the remap', () => {
  const grid = decodeVolumeGrid(encodeVolumeGrid({ resolution: [2, 1, 1], channels: { density: Float32Array.of(1, 1), temperature: Float32Array.of(2, 2) } }));
  assert.equal(bakedGridEmission(grid, 1000, BLENDER_FIRE).red.every(value => value === 0), true);
});

test('flameTemperature resolves on a grid volume, is refused elsewhere and with a wrong shape, and leaves a volume without it unchanged', () => {
  const base = { shape: 'grid', grid: 'blast.67vg', center: [0, 0, 0], size: [1, 1, 1] };
  const [plain] = resolveLocalVolumes([base]);
  assert.equal('flameTemperature' in plain, false);
  const [withRemap] = resolveLocalVolumes([{ ...base, flameTemperature: BLENDER_FIRE }]);
  assert.deepEqual(withRemap.flameTemperature, BLENDER_FIRE);
  assert.throws(() => resolveLocalVolumes([{ ...base, flameTemperature: { ignition: 3, maximum: 1.5 } }]), /maximum \(1.5\) must be at least ignition \(3\)/);
  assert.throws(() => resolveLocalVolumes([{ ...base, flameTemperature: { ignition: 1.5 } }]), /ignition|maximum/);
  assert.throws(() => resolveLocalVolumes([{ ...base, flameTemperature: { ignition: 1.5, maximum: 3, boost: 2 } }]), /boost is not a field/);
  assert.throws(() => resolveLocalVolumes([{ ...base, flameTemperature: 1500 }]), /must be \{ ignition, maximum \}/);
  assert.throws(() => resolveLocalVolumes([{ shape: 'box', center: [0, 0, 0], size: [1, 1, 1], flameTemperature: BLENDER_FIRE }]), /belongs to shape "grid"/);
});

test('Cook gets the remapped flame as the temperature channel, and the plain channel when there is no remap', () => {
  const gridData = fourVoxelGrid();
  const volume = { gridData, center: [0, 0, 0], size: [1, 1, 1], density: 1, absorption: [1, 1, 1], scatter: 0, anisotropy: 0, emission: [1, 1, 1], emissionStrength: 1, temperatureScale: 1000, blackbodyIntensity: 1 };
  assert.equal(cookGridVolume(volume).channels.temperature, gridData.channels.temperature);
  const remapped = cookGridVolume({ ...volume, flameTemperature: BLENDER_FIRE }).channels.temperature;
  assert.deepEqual(Array.from(remapped), [2.25, 2.25, 0, 0].map(floatToHalf));
  assert.notDeepEqual(Array.from(remapped), Array.from(gridData.channels.temperature));
});

test('Glaze uploads remapped emission temperature in localGridTexture.a and evaluates blackbody after interpolation (#1735)', () => {
  const { localGridTexture } = requireFeatureCode('volumeFog').support;
  const uploads = [];
  const renderer = {
    context: {
      TEXTURE_3D: 1, TEXTURE_MIN_FILTER: 2, TEXTURE_MAG_FILTER: 3, LINEAR: 4,
      TEXTURE_WRAP_S: 5, TEXTURE_WRAP_T: 6, TEXTURE_WRAP_R: 7, CLAMP_TO_EDGE: 8,
      UNPACK_ALIGNMENT: 9, RGBA: 10, HALF_FLOAT: 11, RGBA16F: 12,
      createTexture: () => ({ id: uploads.length + 1 }),
      deleteTexture() {},
      bindTexture() {},
      texParameteri() {},
      pixelStorei() {},
      texImage3D: (...args) => uploads.push(Uint16Array.from(args[9])),
      texSubImage3D: (...args) => uploads.push(Uint16Array.from(args[10])),
    },
  };
  const grid = fourVoxelGrid();
  localGridTexture(renderer, grid);
  localGridTexture(renderer, grid, BLENDER_FIRE);
  const noFlame = decodeVolumeGrid(encodeVolumeGrid({ resolution: [2, 1, 1], channels: { density: Float32Array.of(1, 1), temperature: Float32Array.of(2, 2) } }));
  localGridTexture(renderer, noFlame, BLENDER_FIRE);

  const texelAlpha = (texels, x) => texels[((x + 1) + 6 * (1 + 3 * 1)) * 4 + 3];
  assert.equal(texelAlpha(uploads[0], 0), floatToHalf(0.1), 'without flameTemperature, alpha holds the raw temperature channel');
  assert.equal(texelAlpha(uploads[1], 0), floatToHalf(2.25), 'with flameTemperature, alpha holds the remapped flame temperature');
  assert.equal(texelAlpha(uploads[1], 2), 0, 'cold flame cells write 0 to alpha');
  assert.equal(uploads[2][((1) + 4 * (1 + 3 * 1)) * 4 + 3], 0, 'a grid without a flame channel writes 0 emission temperature under the remap');

  const source = createPostFragment(['local']);
  assert.match(source, /localGridTexel\(index,\s*position\)\.a\s*\*\s*localVolumeGrid\[index\]\.y/);
  assert.match(source, /textureLod\(localGridBlackbodyTable/);
});
