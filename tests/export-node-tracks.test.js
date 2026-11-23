// Issue 2130: scene_export_glb writes recipe node tracks as one clip, the camera as a glTF camera and the point and spot
// lights with KHR_lights_punctual, and the importer reads them back with the same duration and values.
import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';
import { omittedFromGlb } from '../src/glb-export-omissions.js';
import { bakeMovingPartTracks, motionClip, MAX_EXPORT_FRAMES, MAX_EXPORT_MOVING_PARTS } from '../src/glb-export-motion.js';

const TOLERANCE = 1e-5;
const QUARTER_TURN = Math.SQRT1_2;
// The bytes of a still two-box export on origin/main before #2130, so a scene without motion, camera and lights is unchanged.
const STILL_EXPORT_SHA256 = '1c954301ae33ae52292a5b1b58f2e443dc5cb98ea6592d7d95ad8dfbeb53bb6c';

function recipeWith(extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }], materials: [{ id: 'paint' }],
    camera: { eye: [3, 2, 4], target: [0, 0.5, 0], fov: 45 },
    nodes: [{ id: 'cube', geometry: 'box', material: 'paint' }, { id: 'still', geometry: 'box', material: 'paint', translation: [3, 0, 0] }],
    motion: { duration: 2, tracks: [
      { kind: 'node', id: 'cube', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [1, 2, 0] }] },
      { kind: 'node', id: 'cube', property: 'rotation', interpolation: 'SMOOTH', keyframes: [{ time: 0, value: [0, 0, 0, 1] }, { time: 2, value: [0, QUARTER_TURN, 0, QUARTER_TURN] }] },
    ] },
    ...extra,
  };
}

function withoutFields(recipe, ...fields) {
  return Object.fromEntries(Object.entries(recipe).filter(([field]) => !fields.includes(field)));
}

function exportOf(scene) {
  const { motion, environment } = scene.exportRecipe();
  const tracks = motion ? bakeMovingPartTracks(scene, motion) : [];
  return exportGlb(scene.parts, {
    ...(tracks.length ? { clips: [motionClip(motion, tracks)] } : {}),
    camera: scene.camera,
    lights: { pointLights: environment.pointLights, spotLights: environment.spotLights },
  });
}

function jsonOf(binary) {
  const view = new DataView(binary);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 20, view.getUint32(12, true))));
}

function closeTo(actual, expected, label) {
  assert.equal(actual.length, expected.length, label);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= TOLERANCE, `${label}: ${Array.from(actual)} is not ${Array.from(expected)}`));
}

test('node tracks export as one clip that re-imports with the same duration and key values', async () => {
  const scene = createAgentScene(recipeWith());
  const asset = await parseGltf(exportOf(scene));
  assert.equal(asset.animations.length, 1);
  const [clip] = asset.animations;
  assert.ok(Math.abs(clip.duration - 2) <= TOLERANCE, `duration ${clip.duration}`);
  assert.deepEqual(clip.tracks.map(track => track.name).sort(), ['cube.position', 'cube.quaternion']);
  const position = clip.tracks.find(track => track.name === 'cube.position');
  const rotation = clip.tracks.find(track => track.name === 'cube.quaternion');
  assert.equal(position.times.length, 61, 'two seconds at 30 frames a second plus the first key');
  closeTo(position.values.subarray(0, 3), [0, 0, 0], 'first translation key');
  closeTo(position.values.subarray(60 * 3), [1, 2, 0], 'last translation key');
  closeTo(rotation.values.subarray(60 * 4), [0, QUARTER_TURN, 0, QUARTER_TURN], 'last rotation key');
  // Every key, not only the ends, is what the scene shows at that time.
  position.times.forEach((time, index) => {
    scene.sampleMotion(time);
    const cube = scene.parts.find(part => part.name === 'cube');
    closeTo(position.values.subarray(index * 3, index * 3 + 3), [cube.matrix[12], cube.matrix[13], cube.matrix[14]], `translation at ${time}`);
  });
});

test('a part the motion never moves gets no track, and a moved group carries its child', () => {
  const scene = createAgentScene(recipeWith());
  assert.deepEqual(new Set(bakeMovingPartTracks(scene, scene.exportRecipe().motion).map(track => track.target)), new Set(['cube']));
  const grouped = createAgentScene(recipeWith({
    nodes: [{ id: 'arm' }, { id: 'hand', parent: 'arm', geometry: 'box', material: 'paint' }],
    motion: { duration: 1, tracks: [{ kind: 'node', id: 'arm', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 4, 0] }] }] },
  }));
  const tracks = bakeMovingPartTracks(grouped, grouped.exportRecipe().motion);
  assert.deepEqual(tracks.map(track => [track.target, track.property]), [['hand', 'translation']]);
  closeTo(tracks[0].keyframes.at(-1).value, [0, 4, 0], 'hand follows its group');
});

test('baking leaves the scene at the pose it had', () => {
  const scene = createAgentScene(recipeWith());
  scene.sampleMotion(0.5);
  const before = Array.from(scene.parts[0].matrix);
  bakeMovingPartTracks(scene, scene.exportRecipe().motion);
  assert.equal(scene.motionTime, 0.5);
  assert.deepEqual(Array.from(scene.parts[0].matrix), before);
});

test('the camera is written as a glTF perspective camera looking at the target', () => {
  const json = jsonOf(exportOf(createAgentScene(recipeWith())));
  assert.equal(json.cameras.length, 1);
  assert.ok(Math.abs(json.cameras[0].perspective.yfov - 45 * Math.PI / 180) <= TOLERANCE);
  assert.equal(json.cameras[0].perspective.znear, 0.1);
  const node = json.nodes.find(candidate => candidate.camera === 0);
  closeTo(node.matrix.slice(12, 15), [3, 2, 4], 'camera position');
  const forward = [-node.matrix[8], -node.matrix[9], -node.matrix[10]];
  const length = Math.hypot(3, 1.5, 4);
  closeTo(forward, [-3 / length, -1.5 / length, -4 / length], 'camera looks down its -Z axis at the target');
});

test('point and spot lights re-import through the importer with the same fields', async () => {
  const pointLights = [{ position: [0, 2, 1], color: [1, 0.5, 0.25], intensity: 5, range: 8 }];
  const spotLights = [{ position: [1, 3, 0], direction: [0.6, -0.8, 0], color: [1, 0.5, 0.2], intensity: 9, angle: 0.5, penumbra: 0.3, range: 0 }];
  const scene = createAgentScene({ ...withoutFields(recipeWith(), 'motion'), environment: { pointLights, spotLights } });
  const asset = await parseGltf(exportOf(scene));
  assert.deepEqual(asset.warnings, []);
  const [point] = asset.lights.pointLights;
  closeTo(point.position, pointLights[0].position, 'point position');
  closeTo(point.color, pointLights[0].color, 'point color');
  assert.equal(point.intensity, 5);
  assert.equal(point.range, 8);
  const [spot] = asset.lights.spotLights;
  closeTo(spot.position, spotLights[0].position, 'spot position');
  closeTo(spot.direction, [0.6, -0.8, 0], 'spot direction');
  assert.ok(Math.abs(spot.angle - 0.5) <= TOLERANCE && Math.abs(spot.penumbra - 0.3) <= TOLERANCE, `${spot.angle} ${spot.penumbra}`);
  closeTo(spot.color, [1, 0.5, 0.2], 'spot color');
  assert.equal(spot.intensity, 9);
});

test('a scene with no motion, camera or lights exports the same bytes as before', () => {
  const scene = createAgentScene(withoutFields(recipeWith(), 'camera', 'motion'));
  const plain = exportGlb(scene.parts);
  const json = jsonOf(plain);
  assert.equal(json.animations, undefined);
  assert.equal(json.cameras, undefined);
  assert.equal(json.extensions, undefined);
  assert.equal(createHash('sha256').update(new Uint8Array(plain)).digest('hex'), STILL_EXPORT_SHA256);
});

test('a motion longer than the frame limit fails and says what to pass instead', () => {
  const scene = createAgentScene(recipeWith());
  const seconds = MAX_EXPORT_FRAMES / 30 + 1;
  assert.throws(() => bakeMovingPartTracks(scene, { duration: seconds, tracks: [] }), error => error instanceof RangeError && /motionTime/.test(error.message) && /motion.duration/.test(error.message));
});

test('more moving parts than the limit fails and says what to pass instead', () => {
  const children = Array.from({ length: MAX_EXPORT_MOVING_PARTS + 1 }, (_, index) => ({ id: `part${index}`, parent: 'group', geometry: 'box', material: 'paint' }));
  const motion = { duration: 1, tracks: [{ kind: 'node', id: 'group', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 1, 0] }] }] };
  const scene = createAgentScene(recipeWith({ nodes: [{ id: 'group' }, ...children], motion }));
  assert.throws(() => bakeMovingPartTracks(scene, motion), error => error instanceof RangeError && /motionTime/.test(error.message));
});

test('omitted shrinks to what the file does not carry', () => {
  const recipe = {
    camera: {}, environment: { pointLights: [{}], spotLights: [{}], areaLights: [{}] },
    motion: { tracks: [{ kind: 'node', id: 'a', property: 'translation' }, { kind: 'node', id: 'a', property: 'opacity' }, { kind: 'material', id: 'm', property: 'emission' }, { kind: 'camera', property: 'fov' }] },
  };
  assert.deepEqual(omittedFromGlb(recipe, { nodeTracks: true, camera: true, lights: true }), ['motion tracks (3: camera 1, material 1, node 1)', 'area lights (1)']);
  assert.deepEqual(omittedFromGlb(recipe), ['motion tracks (4: camera 1, material 1, node 2)', 'camera', 'lights (3)']);
  assert.deepEqual(omittedFromGlb({ motion: { tracks: [{ kind: 'node', id: 'bone', property: 'rotation' }] } }, { boneIds: ['bone'] }), []);
});
