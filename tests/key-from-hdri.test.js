// environment.keyFromHdri places the recipe's key light at the sun of its HDRI, with the sun's colour and strength, and
// takes the sun out of the map, as a scene file does (#2875). The synthetic HDRIs have a sun at a known azimuth and elevation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentEnvironmentKey, agentEnvironmentMap, normalizeAgentLook } from '../src/agent-look.js';
import { createAgentScene } from '../src/agent-scene.js';
import { sunFromEnvironmentMap } from '../src/hdri.js';
import { registerCatalogEnvironment } from '../src/look-catalog.js';
import { createCatalogEnvironmentMap } from '../src/lighting-setups.js';

const WIDTH = 256;
const HEIGHT = 128;
const SKY = [0.3, 0.4, 0.6];
const SUN_COLOR = [500, 450, 350];
const SUN_RADIUS = (3 * Math.PI) / 180;
const DEGREES = Math.PI / 180;
const SUNNY_ID = 'a'.repeat(64);
const SIDE_SUN_ID = 'b'.repeat(64);
const OVERCAST_ID = 'c'.repeat(64);

// A file's column 0.5 faces +X once loaded and column 0.25 faces -Z (src/environment-orientation.js), so the authored
// sun here is placed by file column and elevation and the expected world direction is written out by hand.
function directionOfPixel(column, row) {
  const azimuth = ((column + 0.5) / WIDTH) * 2 * Math.PI;
  const polar = ((row + 0.5) / HEIGHT) * Math.PI;
  return [Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth)];
}

function sunDirectionInFile(columnFraction, elevationDegrees) {
  const azimuth = columnFraction * 2 * Math.PI;
  const elevation = elevationDegrees * DEGREES;
  return [Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)];
}

function authoredSky(sunDirection) {
  const data = new Float32Array(WIDTH * HEIGHT * 3);
  for (let row = 0; row < HEIGHT; row++) {
    for (let column = 0; column < WIDTH; column++) {
      let color = SKY;
      if (sunDirection) {
        const direction = directionOfPixel(column, row);
        const cosine = direction[0] * sunDirection[0] + direction[1] * sunDirection[1] + direction[2] * sunDirection[2];
        if (cosine > Math.cos(SUN_RADIUS)) color = SUN_COLOR;
      }
      data.set(color, (row * WIDTH + column) * 3);
    }
  }
  return { width: WIDTH, height: HEIGHT, data };
}

registerCatalogEnvironment(SUNNY_ID, authoredSky(sunDirectionInFile(0.5, 40)));
registerCatalogEnvironment(SIDE_SUN_ID, authoredSky(sunDirectionInFile(0.25, 25)));
registerCatalogEnvironment(OVERCAST_ID, authoredSky(null));

// File column 0.5 faces +X at 40 degrees up; column 0.25 faces -Z at 25 degrees up.
const SUN_TOWARD_PLUS_X = [Math.cos(40 * DEGREES), Math.sin(40 * DEGREES), 0];
const SUN_TOWARD_MINUS_Z = [0, Math.sin(25 * DEGREES), -Math.cos(25 * DEGREES)];

function angleBetween(first, second) {
  const dot = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  return Math.acos(Math.min(1, dot / (Math.hypot(...first) * Math.hypot(...second))));
}

function lookWith(environment) {
  return normalizeAgentLook({ environment: { hdri: SUNNY_ID, ...environment } }).environment;
}

test('keyFromHdri points the key light at the HDRI sun, wherever the sun is', () => {
  const plusX = agentEnvironmentKey(lookWith({ keyFromHdri: true }));
  assert.ok(angleBetween(plusX.lightDirection, SUN_TOWARD_PLUS_X) < 3 * DEGREES, `${plusX.lightDirection}`);
  const minusZ = agentEnvironmentKey(lookWith({ hdri: SIDE_SUN_ID, keyFromHdri: true }));
  assert.ok(angleBetween(minusZ.lightDirection, SUN_TOWARD_MINUS_Z) < 3 * DEGREES, `${minusZ.lightDirection}`);
});

test('keyFromHdri follows environmentRotation', () => {
  const turned = agentEnvironmentKey(lookWith({ keyFromHdri: true, environmentRotation: Math.PI / 2 }));
  const straight = agentEnvironmentKey(lookWith({ keyFromHdri: true }));
  const azimuthOf = ([x, , z]) => Math.atan2(z, x);
  const turnedBy = Math.abs(azimuthOf(turned.lightDirection) - azimuthOf(straight.lightDirection));
  assert.ok(Math.abs(turnedBy - Math.PI / 2) < 3 * DEGREES, `turned by ${turnedBy}`);
  assert.ok(Math.abs(turned.lightDirection[1] - straight.lightDirection[1]) < 0.03, 'a turn about +Y keeps the elevation');
});

test('keyFromHdri gives the key the sun colour and its strength', () => {
  const { keyColor, keyIntensity } = agentEnvironmentKey(lookWith({ keyFromHdri: true }));
  assert.equal(Math.max(...keyColor), 1);
  assert.ok(Math.abs(keyColor[1] / keyColor[0] - 450 / 500) < 0.05, `${keyColor}`);
  assert.ok(Math.abs(keyColor[2] / keyColor[0] - 350 / 500) < 0.05, `${keyColor}`);
  // Sun radiance above the sky, times the disc's solid angle, over pi.
  const sunLuminance = 0.2126 * SUN_COLOR[0] + 0.7152 * SUN_COLOR[1] + 0.0722 * SUN_COLOR[2];
  const skyLuminance = 0.2126 * SKY[0] + 0.7152 * SKY[1] + 0.0722 * SKY[2];
  const expected = ((sunLuminance - skyLuminance) * Math.PI * SUN_RADIUS ** 2) / Math.PI;
  assert.ok(Math.abs(keyIntensity - expected) / expected < 0.2, `${keyIntensity} against ${expected}`);
  const doubled = agentEnvironmentKey(lookWith({ keyFromHdri: true, environmentIntensity: 2 }));
  assert.ok(Math.abs(doubled.keyIntensity / keyIntensity - 2) < 0.01, 'the key scales with the map intensity');
});

test('keyFromHdri takes the sun out of the map and keeps it in the background as a disc', () => {
  const environment = lookWith({ keyFromHdri: true });
  const whole = agentEnvironmentMap(lookWith({}));
  assert.ok(sunFromEnvironmentMap(whole), 'without keyFromHdri the sun stays in the map');
  const split = agentEnvironmentMap(environment);
  assert.equal(sunFromEnvironmentMap(split), null);
  assert.ok(angleBetween(split.sunDisc.direction, SUN_TOWARD_PLUS_X) < 3 * DEGREES);
  assert.equal(agentEnvironmentMap(environment), split, 'the same map comes back, so the renderer keeps its prefiltered textures');
});

test('without keyFromHdri the recipe is lit exactly as before', () => {
  const plain = lookWith({});
  assert.equal(Object.hasOwn(plain, 'keyFromHdri'), false, 'the exported shape does not change');
  assert.equal(agentEnvironmentKey(plain), plain);
  const explicitlyOff = lookWith({ keyFromHdri: false });
  assert.equal(agentEnvironmentKey(explicitlyOff), explicitlyOff);
  const unchanged = createCatalogEnvironmentMap(SUNNY_ID, { intensity: 1, rotation: 0, showBackground: false });
  assert.equal(agentEnvironmentMap(plain), unchanged);
  assert.equal(agentEnvironmentMap(explicitlyOff), unchanged);
});

test('keyFromHdri says what to do when the recipe cannot use it', () => {
  assert.throws(() => normalizeAgentLook({ environment: { keyFromHdri: true } }), /environment\.keyFromHdri.*environment\.hdri/);
  assert.throws(() => lookWith({ keyFromHdri: 'yes' }), /environment\.keyFromHdri.*true or false/);
  assert.throws(() => lookWith({ keyFromHdri: true, sky: { type: 'physical' } }), /environment\.keyFromHdri.*sky/);
  const overcast = lookWith({ hdri: OVERCAST_ID, keyFromHdri: true });
  assert.throws(() => agentEnvironmentKey(overcast), /no distinct sun.*set lightDirection, keyColor and keyIntensity/);
  assert.throws(() => agentEnvironmentMap(overcast), /no distinct sun/);
});

test('a scene lights from the HDRI sun while the recipe keeps the authored key', () => {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'g_box', type: 'box' }],
    materials: [{ id: 'm_box', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'box', geometry: 'g_box', material: 'm_box' }],
    camera: { eye: [0, 2, 10], target: [0, 0, 0] },
    environment: { hdri: SUNNY_ID, keyFromHdri: true, lightDirection: [0, 1, 0] },
  };
  const scene = createAgentScene(recipe);
  assert.ok(angleBetween(scene.environment.lightDirection, SUN_TOWARD_PLUS_X) < 3 * DEGREES);
  const exported = scene.exportRecipe().environment;
  assert.deepEqual(exported.lightDirection, [0, 1, 0], 'the authored value stays in the recipe');
  assert.equal(exported.keyFromHdri, true);
  const withoutIt = createAgentScene({ ...recipe, environment: { hdri: SUNNY_ID, lightDirection: [0, 1, 0] } });
  assert.deepEqual(withoutIt.environment.lightDirection, [0, 1, 0]);
});
