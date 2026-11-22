// A file scene lit by an HDRI with a sun takes that sun out of the sky term and lights with it as a shadowed key, and
// the sun's shadow view is fitted to the scene instead of the 7 m studio box at the origin (#2761).
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { createEnvironmentMap, splitHdriSun, sunFromEnvironmentMap } from '../src/hdri.js';
import { sceneFileLighting, sunShadowBounds } from '../src/dense-lods.js';
import { resolveShadowLight } from '../src/shadow-light.js';

const WIDTH = 256;
const HEIGHT = 128;
const SKY = [0.4, 0.5, 0.7];
const SUN = [400, 380, 340];
// Toward the sun: up and to the side, in the map's own frame.
const SUN_DIRECTION = [0.6, 0.6, -0.529];

function directionOf(column, row) {
  const azimuth = ((column + 0.5) / WIDTH - 0.5) * 2 * Math.PI;
  const polar = ((row + 0.5) / HEIGHT) * Math.PI;
  return [Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), -Math.sin(polar) * Math.cos(azimuth)];
}

function skyMap({ sun = true, rotation = 0 } = {}) {
  const length = Math.hypot(...SUN_DIRECTION);
  const toward = SUN_DIRECTION.map(component => component / length);
  const data = new Float32Array(WIDTH * HEIGHT * 3);
  for (let row = 0; row < HEIGHT; row++) {
    for (let column = 0; column < WIDTH; column++) {
      const direction = directionOf(column, row);
      const cosine = direction[0] * toward[0] + direction[1] * toward[1] + direction[2] * toward[2];
      const color = sun && cosine > Math.cos((3 * Math.PI) / 180) ? SUN : SKY;
      data.set(color, (row * WIDTH + column) * 3);
    }
  }
  return createEnvironmentMap({ width: WIDTH, height: HEIGHT, data, intensity: 1, rotation, showBackground: true });
}

function angleBetween(first, second) {
  const dot = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  return Math.acos(Math.min(1, dot / (Math.hypot(...first) * Math.hypot(...second))));
}

test('splitHdriSun takes the sun out of the map and returns it as a key light that carries its energy', () => {
  const map = skyMap();
  const original = Float32Array.from(map.data);
  const before = sunFromEnvironmentMap(map);
  const split = splitHdriSun(map);
  assert.ok(split, 'a sky with a sun splits');
  assert.equal(sunFromEnvironmentMap(split.map), null, 'the map left behind has no sun');
  assert.deepEqual(map.data, original, 'the map passed in is not changed');
  assert.ok(angleBetween(split.environment.lightDirection, SUN_DIRECTION) < 0.03);
  assert.ok(split.environment.keyColor.every(component => component > 0 && component <= 1));
  assert.equal(Math.max(...split.environment.keyColor), 1);
  // The key carries what was taken out of the map: the disc above the sky, not the disc with the sky behind it.
  assert.ok(Math.abs(split.environment.keyIntensity - before.keyIntensity) / before.keyIntensity < 0.1, `${split.environment.keyIntensity} against ${before.keyIntensity}`);
  assert.ok(angleBetween(split.map.sunDisc.direction, SUN_DIRECTION) < 0.03);
  assert.ok(split.map.sunDisc.radiance.every(Number.isFinite));
  assert.equal(split.map.showBackground, true);
});

test('splitHdriSun keeps the map rotation: the key points where the rotated sky puts the sun', () => {
  const turned = splitHdriSun(skyMap({ rotation: Math.PI / 2 }));
  const straight = splitHdriSun(skyMap());
  assert.ok(angleBetween(turned.environment.lightDirection, straight.environment.lightDirection) > 1);
  assert.ok(angleBetween(turned.map.sunDisc.direction, straight.map.sunDisc.direction) < 0.03, 'the disc stays in the map frame');
  assert.equal(turned.map.rotation, Math.PI / 2);
});

test('an overcast sky has no sun to split', () => {
  assert.equal(splitHdriSun(skyMap({ sun: false })), null);
});

test('a scene file without a directional light is lit by the HDRI sun with no fill; any key it names keeps the map whole', () => {
  const map = skyMap();
  const lit = sceneFileLighting(map, {}, {});
  assert.notEqual(lit.map, map);
  assert.equal(lit.sunSplit, true);
  assert.equal(lit.environment.fillIntensity, 0);
  assert.ok(angleBetween(lit.environment.lightDirection, SUN_DIRECTION) < 0.03);
  const exposure = sceneFileLighting(map, {}, { exposure: 2, fillIntensity: 0.5 });
  assert.equal(exposure.environment.exposure, 2);
  assert.equal(exposure.environment.fillIntensity, 0.5, 'the scene file still wins key by key');

  const glbSun = { keyColor: [15, 15, 15], lightDirection: [0, 1, 0], keyIntensity: 1, fillIntensity: 0 };
  assert.equal(sceneFileLighting(map, glbSun, {}).map, map);
  assert.equal(sceneFileLighting(map, glbSun, {}).sunSplit, false, 'a GLB with its own lights keeps the studio shadow view too');
  assert.deepEqual(sceneFileLighting(map, glbSun, {}).environment, glbSun);
  assert.equal(sceneFileLighting(map, {}, { lightDirection: [0, 1, 0] }).map, map);
  assert.equal(sceneFileLighting(map, {}, { keyIntensity: 0 }).map, map);
  assert.equal(sceneFileLighting(map, {}, {}, { hdriSun: false }).map, map);
  assert.deepEqual(sceneFileLighting(null, {}, {}), { environment: {}, map: null, sunSplit: false });
  assert.equal(sceneFileLighting(skyMap({ sun: false }), {}, {}).environment.fillIntensity, undefined);
});

function partAt(x, z) {
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1]);
  return { geometry: box(0), matrix };
}

test('sunShadowBounds fits the sun shadow view to the scene, with the eye toward the sun', () => {
  const parts = [partAt(0, -8), partAt(36, -47)];
  const sun = [0.3, 0.9, 0.2];
  const bounds = sunShadowBounds(parts, sun);
  assert.ok(bounds.extent > 25, `the view covers the scene, not the 3.5 m studio box (extent ${bounds.extent})`);
  assert.ok(Math.abs(bounds.target[0] - 18) < 2 && Math.abs(bounds.target[2] + 27.5) < 2);
  assert.ok(angleBetween(bounds.eye.map((value, axis) => value - bounds.target[axis]), sun) < 1e-6);
  assert.ok(bounds.near > 0 && bounds.far > bounds.near);
  const light = resolveShadowLight(false, sun, bounds);
  assert.deepEqual(light.eye, bounds.eye, 'the renderer uses the fitted view as given');
  assert.equal(light.extent, bounds.extent);
  assert.deepEqual(sunShadowBounds([], sun), {}, 'no parts keep the studio view');
});

test('splitHdriSun leaves the glare around the sun in the map, so the background has no patch (#2875)', () => {
  const toward = SUN_DIRECTION.map(component => component / Math.hypot(...SUN_DIRECTION));
  const glare = (column, row) => {
    const direction = directionOf(column, row);
    const angle = Math.acos(Math.min(1, direction[0] * toward[0] + direction[1] * toward[1] + direction[2] * toward[2]));
    return 20 * Math.exp(-angle / ((4 * Math.PI) / 180));
  };
  const data = new Float32Array(WIDTH * HEIGHT * 3);
  for (let row = 0; row < HEIGHT; row++) {
    for (let column = 0; column < WIDTH; column++) {
      const direction = directionOf(column, row);
      const cosine = direction[0] * toward[0] + direction[1] * toward[1] + direction[2] * toward[2];
      const isDisc = cosine > Math.cos((1 * Math.PI) / 180);
      const color = isDisc ? [4000, 3800, 3400] : SKY.map(component => component + glare(column, row));
      data.set(color, (row * WIDTH + column) * 3);
    }
  }
  const map = createEnvironmentMap({ width: WIDTH, height: HEIGHT, data, showBackground: true });
  const split = splitHdriSun(map);
  assert.ok(split);
  let largestChange = 0;
  let farthestChange = 0;
  for (let row = 0; row < HEIGHT; row++) {
    for (let column = 0; column < WIDTH; column++) {
      const direction = directionOf(column, row);
      const angle = Math.acos(Math.min(1, direction[0] * toward[0] + direction[1] * toward[1] + direction[2] * toward[2]));
      const offset = (row * WIDTH + column) * 3;
      const change = Math.abs(split.map.data[offset] - map.data[offset]);
      if (angle > (2 * Math.PI) / 180) largestChange = Math.max(largestChange, change);
      if (change > 0) farthestChange = Math.max(farthestChange, angle);
    }
  }
  assert.equal(largestChange, 0, 'nothing beyond the disc changes: the glare stays');
  assert.ok(farthestChange < (2 * Math.PI) / 180, 'only the disc is filled');
  // The disc is filled with the glare at its edge, not with the dark sky far away.
  const centreColumn = Math.round(((Math.atan2(toward[0], -toward[2]) / (2 * Math.PI)) + 0.5) * WIDTH - 0.5);
  const centreRow = Math.round((Math.acos(toward[1]) / Math.PI) * HEIGHT - 0.5);
  const filled = split.map.data[(centreRow * WIDTH + centreColumn) * 3];
  assert.ok(filled > SKY[0] + 5 && filled < 30, `filled with ${filled}`);
});
