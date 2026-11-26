import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_TYPES,
  resolveSkyClouds,
  marchSkyClouds,
  bakeCloudShadowMap,
  cloudShadowTransmittance,
} from '../src/sky-clouds.js';
import {
  resolvePhysicalSky,
  createPhysicalSkyMap,
  createCloudShadowMap,
  physicalSunDirection,
} from '../src/physical-sky.js';
import { createAgentScene } from '../src/agent-scene.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';

const fail = (field, got, expected) => new RangeError(`${field}: got ${JSON.stringify(got)}; expected ${expected}`);

test('resolveSkyClouds fills per-type defaults, stays idempotent, and rejects invalid fields', () => {
  assert.deepEqual(CLOUD_TYPES, ['cumulus', 'stratus', 'cirrus']);
  assert.equal(resolveSkyClouds(null, fail), null);
  assert.equal(resolveSkyClouds(false, fail), null);

  const cumulus = resolveSkyClouds({}, fail);
  assert.deepEqual(cumulus, {
    type: 'cumulus',
    coverage: 0.48,
    altitude: 1500,
    thickness: 950,
    density: 0.75,
    wind: [0, 0],
    seed: 1,
    time: 0,
    shadows: false,
  });
  assert.deepEqual(resolveSkyClouds(cumulus, fail), cumulus);

  const cirrus = resolveSkyClouds({ type: 'cirrus', wind: [18, -4], time: 20, shadows: true }, fail);
  assert.equal(cirrus.altitude, 8500);
  assert.equal(cirrus.density, 0.35);
  assert.deepEqual(cirrus.wind, [18, -4]);
  assert.equal(cirrus.shadows, true);

  assert.throws(() => resolveSkyClouds('thick', fail), /environment\.sky\.clouds/);
  assert.throws(() => resolveSkyClouds({ bogus: 1 }, fail), /environment\.sky\.clouds\.bogus/);
  assert.throws(() => resolveSkyClouds({ type: 'nimbus' }, fail), /cumulus, stratus, cirrus/);
  assert.throws(() => resolveSkyClouds({ coverage: 1.5 }, fail), /clouds\.coverage/);
  assert.throws(() => resolveSkyClouds({ altitude: 10 }, fail), /clouds\.altitude/);
  assert.throws(() => resolveSkyClouds({ thickness: 5 }, fail), /clouds\.thickness/);
  assert.throws(() => resolveSkyClouds({ density: -1 }, fail), /clouds\.density/);
  assert.throws(() => resolveSkyClouds({ wind: [10] }, fail), /clouds\.wind/);
  assert.throws(() => resolveSkyClouds({ seed: 1.5 }, fail), /clouds\.seed/);
  assert.throws(() => resolveSkyClouds({ time: Infinity }, fail), /clouds\.time/);
  assert.throws(() => resolveSkyClouds({ shadows: 'yes' }, fail), /clouds\.shadows/);
});

test('clear clouds (coverage 0, density 0, or null) match the clear physical sky byte for byte', () => {
  const clearEnv = {
    sky: resolvePhysicalSky({ type: 'physical', preset: 'golden-hour' }, fail),
    environmentIntensity: 1,
    environmentRotation: 0,
    world: true,
  };
  const clearMap = createPhysicalSkyMap(clearEnv);

  for (const clouds of [{ coverage: 0 }, { density: 0 }, null]) {
    const sky = resolvePhysicalSky({ type: 'physical', preset: 'golden-hour', clouds }, fail);
    const map = createPhysicalSkyMap({ ...clearEnv, sky });
    assert.deepEqual(map.data, clearMap.data);
  }
});

test('marchSkyClouds produces stronger forward-scattered silver lining toward the sun', () => {
  const sky = resolvePhysicalSky({
    type: 'physical',
    sunElevation: 8,
    sunRotation: 0,
    clouds: { coverage: 0.55, density: 1.0, seed: 4 },
  }, fail);
  const sun = physicalSunDirection(sky);
  const normalize = vector => {
    const length = Math.hypot(...vector);
    return vector.map(component => component / length);
  };
  const nearSunDir = normalize([sun[0] + 0.08, sun[1] + 0.22, sun[2]]);
  const awayDir = normalize([-sun[0], Math.max(0.22, sun[1] + 0.2), -sun[2]]);
  const thinCloud = { ...sky.clouds, coverage: 0.9, density: 0.35 };

  const forward = marchSkyClouds(nearSunDir, sun, [3.2, 2.2, 1.3], [0.25, 0.35, 0.65], [0.9, 0.5, 0.25], thinCloud, 0.5);
  const backward = marchSkyClouds(awayDir, sun, [3.2, 2.2, 1.3], [0.25, 0.35, 0.65], [0.9, 0.5, 0.25], thinCloud, 0.5);
  const forwardLum = forward.scattered[0] + forward.scattered[1] + forward.scattered[2];
  const backwardLum = backward.scattered[0] + backward.scattered[1] + backward.scattered[2];
  assert.ok(forwardLum > backwardLum * 1.5, `expected strong forward silver lining (${forwardLum} > ${backwardLum * 1.5})`);
});

test('cumulus, stratus, and cirrus differ visually and advect deterministically with wind and time', () => {
  const baseEnv = { environmentIntensity: 1, environmentRotation: 0, world: true };
  const clearMap = createPhysicalSkyMap({ ...baseEnv, sky: resolvePhysicalSky({ type: 'physical', preset: 'golden-hour' }, fail) });

  const maps = {};
  for (const type of CLOUD_TYPES) {
    const sky = resolvePhysicalSky({ type: 'physical', preset: 'golden-hour', clouds: { type, wind: [25, 10], time: 0 } }, fail);
    const map = createPhysicalSkyMap({ ...baseEnv, sky });
    assert.notDeepEqual(map.data, clearMap.data, `${type} clouds should modify clear sky radiance`);
    maps[type] = map;
  }
  assert.notDeepEqual(maps.cumulus.data, maps.stratus.data);
  assert.notDeepEqual(maps.cumulus.data, maps.cirrus.data);

  // Moving time with non-zero wind shifts clouds deterministically; repeating the same time returns identical cached bytes.
  const skyT1 = resolvePhysicalSky({ type: 'physical', preset: 'golden-hour', clouds: { type: 'cumulus', wind: [35, 15], time: 120 } }, fail);
  const skyT1Repeat = resolvePhysicalSky({ type: 'physical', preset: 'golden-hour', clouds: { type: 'cumulus', wind: [35, 15], time: 120 } }, fail);
  const mapT1 = createPhysicalSkyMap({ ...baseEnv, sky: skyT1 });
  const mapT1Repeat = createPhysicalSkyMap({ ...baseEnv, sky: skyT1Repeat });
  assert.equal(mapT1, mapT1Repeat, 'same cloud state hits cached environment map');
  assert.notEqual(mapT1, maps.cumulus);
  assert.notDeepEqual(mapT1.data, maps.cumulus.data);

  // Changing time with zero wind produces identical radiance bytes.
  const calmT0 = createPhysicalSkyMap({ ...baseEnv, sky: resolvePhysicalSky({ type: 'physical', sunElevation: 25, clouds: { type: 'cumulus', wind: [0, 0], time: 0 } }, fail) });
  const calmT90 = createPhysicalSkyMap({ ...baseEnv, sky: resolvePhysicalSky({ type: 'physical', sunElevation: 25, clouds: { type: 'cumulus', wind: [0, 0], time: 90 } }, fail) });
  assert.deepEqual(calmT0.data, calmT90.data);
});

test('cloud shadow map is deterministic, 255 everywhere when clear, and casts shadows under clouds', () => {
  const clearSky = resolvePhysicalSky({ type: 'physical', sunElevation: 40 }, fail);
  assert.equal(createCloudShadowMap(clearSky), null);

  const zeroSky = resolvePhysicalSky({ type: 'physical', sunElevation: 40, clouds: { coverage: 0, shadows: true } }, fail);
  const zeroMap = bakeCloudShadowMap(zeroSky.clouds, physicalSunDirection(zeroSky), { resolution: 32, extent: 500 });
  assert.equal(zeroMap.colorSpace, 'linear');
  assert.deepEqual(zeroMap.bounds, [-500, -500, 500, 500]);
  for (let index = 0; index < zeroMap.image.data.length; index += 4) {
    assert.equal(zeroMap.image.data[index], 255);
  }

  const overcastSky = resolvePhysicalSky({
    type: 'physical',
    sunElevation: 45,
    clouds: { coverage: 0.72, density: 1.8, shadows: true, wind: [20, 0], time: 5 },
  }, fail);
  const shadowMapA = createCloudShadowMap(overcastSky, { resolution: 64, extent: 1500 });
  const shadowMapB = createCloudShadowMap(overcastSky, { resolution: 64, extent: 1500 });
  assert.deepEqual(shadowMapA.image.data, shadowMapB.image.data);

  let minimum = 255;
  let maximum = 0;
  for (let index = 0; index < shadowMapA.image.data.length; index += 4) {
    const channel = shadowMapA.image.data[index];
    if (channel < minimum) minimum = channel;
    if (channel > maximum) maximum = channel;
  }
  assert.ok(minimum < 220, `expected shadowed texels under cloud cover, got min ${minimum}`);
  assert.ok(maximum > minimum, `expected spatial variation in cloud shadows (${maximum} > ${minimum})`);

  const transmittance = cloudShadowTransmittance(overcastSky.clouds, physicalSunDirection(overcastSky), 0, 0);
  assert.ok(transmittance >= 0 && transmittance <= 1);

  const envMap = createPhysicalSkyMap({ sky: overcastSky, environmentIntensity: 1, environmentRotation: 0, world: true });
  assert.ok(envMap.cloudShadowMap, 'shadows:true attaches cloudShadowMap onto physical sky map');
  assert.equal(envMap.cloudShadowMap.colorSpace, 'linear');
});

test('recipe environment.sky accepts clouds through agent-scene end to end', async () => {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'stone', color: [0.6, 0.6, 0.6] }],
    nodes: [{ id: 'rock', geometry: 'box', material: 'stone' }],
    environment: {
      world: true,
      sky: {
        type: 'physical',
        preset: 'golden-hour',
        clouds: { type: 'cumulus', coverage: 0.55, density: 0.9, shadows: true },
      },
    },
  };
  await loadAgentSceneModules(recipe);
  const scene = createAgentScene(recipe);
  assert.equal(scene.environment.sky.clouds.type, 'cumulus');
  assert.equal(scene.environment.sky.clouds.shadows, true);
  assert.equal(scene.environment.sky.clouds.altitude, 1500);
});
