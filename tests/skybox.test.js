import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentLook } from '../src/agent-look.js';
import { SKYBOX_FACES, createSkyboxMap, registerSkyboxFace, skyboxFaceLookup } from '../src/skybox.js';

const FACE_COLORS = { front: [255, 0, 0], back: [0, 255, 255], left: [0, 255, 0], right: [255, 0, 255], up: [0, 0, 255], down: [255, 255, 0] };

function idFor(face) {
  return (SKYBOX_FACES.indexOf(face) + 1).toString(16).repeat(64);
}

function solidFace(color) {
  const size = 4;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let texel = 0; texel < size * size; texel++) data.set([...color, 255], texel * 4);
  return { width: size, height: size, data };
}

const skybox = Object.fromEntries(SKYBOX_FACES.map(face => [face, idFor(face)]));

test('each axis leaves through its own face and an upright image keeps its top toward +Y', () => {
  assert.equal(skyboxFaceLookup(0, 0, -1).face, 'front');
  assert.equal(skyboxFaceLookup(0, 0, 1).face, 'back');
  assert.equal(skyboxFaceLookup(-1, 0, 0).face, 'left');
  assert.equal(skyboxFaceLookup(1, 0, 0).face, 'right');
  assert.equal(skyboxFaceLookup(0, 1, 0).face, 'up');
  assert.equal(skyboxFaceLookup(0, -1, 0).face, 'down');
  const above = skyboxFaceLookup(0, 0.5, -1);
  const below = skyboxFaceLookup(0, -0.5, -1);
  assert.ok(above.v < 0.5 && below.v > 0.5, 'looking higher reads nearer the top of the image');
  assert.ok(skyboxFaceLookup(0.5, 0, -1).u > 0.5, 'facing front, +X is to the right of the view, so it reads the right half of the image');
  assert.ok(skyboxFaceLookup(1, 0, -0.5).u < 0.5, 'the right face reads from front (its left edge) to back (its right edge)');
  assert.ok(skyboxFaceLookup(-1, 0, 0.5).u < 0.5, 'the left face reads from back (its left edge) to front (its right edge)');
  assert.ok(skyboxFaceLookup(-0.5, 0, 1).u > 0.5, 'the back face reads right to left in x, so -X is its right half');
  assert.ok(skyboxFaceLookup(0, 1, -0.5).v > 0.5, 'the up face has its bottom edge toward the front, -Z');
  assert.ok(skyboxFaceLookup(0, -1, -0.5).v < 0.5, 'the down face has its top edge toward the front, -Z');
});

test('the equirectangular map shows each face where its axis points', () => {
  for (const face of SKYBOX_FACES) registerSkyboxFace(idFor(face), solidFace(FACE_COLORS[face]));
  const environment = { skybox, environmentIntensity: 1, environmentRotation: 0 };
  const map = createSkyboxMap(environment);
  assert.equal(createSkyboxMap(environment), map, 'the same faces give the same map');
  const pixelAt = (column, row) => Array.from(map.data.slice((row * map.width + column) * 3, (row * map.width + column) * 3 + 3), value => Math.round(value));
  const middleRow = map.height / 2;
  assert.deepEqual(pixelAt(map.width / 2, middleRow), [1, 0, 0], 'the centre of the map looks toward -Z, the front face');
  assert.deepEqual(pixelAt(map.width * 3 / 4, middleRow), [1, 0, 1], 'a quarter turn clockwise is +X, the right face');
  assert.deepEqual(pixelAt(map.width / 4, middleRow), [0, 1, 0], 'a quarter turn the other way is -X, the left face');
  assert.deepEqual(pixelAt(0, middleRow), [0, 1, 1], 'the map edge is +Z, the back face');
  assert.deepEqual(pixelAt(10, 1), [0, 0, 1], 'the top row is the up face');
  assert.deepEqual(pixelAt(10, map.height - 2), [1, 1, 0], 'the bottom row is the down face');
});

test('a skybox normalizes, replaces the sky, and every face error names the fix', () => {
  assert.deepEqual(normalizeAgentLook({ environment: { skybox } }).environment.skybox, skybox);
  assert.throws(() => normalizeAgentLook({ environment: { skybox: { ...skybox, up: 'bad' } } }), /environment\.skybox\.up.*64-character ID.*all six faces/);
  assert.throws(() => normalizeAgentLook({ environment: { skybox: { ...skybox, top: skybox.up } } }), /environment\.skybox\.top.*one of the faces/);
  assert.throws(() => normalizeAgentLook({ environment: { skybox: { ...skybox, front: 'https://example.com/front.png' } } }), /environment\.skybox\.front.*no URLs/);
  assert.throws(() => normalizeAgentLook({ environment: { skybox, sky: { type: 'physical' } } }), /remove "hdri" or "sky"/);
});

test('a face is sampled smoothly: a gradient crosses the map with no stair-steps and no jump at the face edge', () => {
  const size = 16;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) data.set([Math.round(column / (size - 1) * 255), 0, 0, 255], (row * size + column) * 4);
  }
  for (const face of SKYBOX_FACES) registerSkyboxFace(idFor(face), face === 'front' ? { width: size, height: size, data } : solidFace([0, 0, 0]));
  const map = createSkyboxMap({ skybox, environmentIntensity: 1, environmentRotation: 0 });
  const row = map.height / 2;
  let largestStep = 0;
  for (let column = map.width / 2 - 200; column < map.width / 2 + 200; column++) {
    largestStep = Math.max(largestStep, Math.abs(map.data[(row * map.width + column + 1) * 3] - map.data[(row * map.width + column) * 3]));
  }
  assert.ok(largestStep < 0.01, `the red channel moved by ${largestStep} between two neighbouring map columns; nearest sampling of 16 texels moves it by about 0.06`);
  assert.ok(map.width >= 2048, 'the map is large enough that a face is not blown up more than a few times');
});
