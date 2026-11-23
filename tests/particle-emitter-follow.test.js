import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';

test.before(() => loadPhysicsEngine({ buoyancy: true }));

const BOX_VERTICES = 24;
const SIZE = 0.1;

function particleSystem(emitter, extra = {}) {
  return { node: 'spray', seed: 3, count: 4, rate: 1, lifetime: 10, speed: 0, size: SIZE, drag: 0, emitter, ...extra };
}

function movingNodeRecipe(system, nodeExtra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'speck', type: 'box', bevel: 0 }],
    materials: [{ id: 'foam', color: [1, 1, 1] }],
    nodes: [
      { id: 'carrier', geometry: 'speck', material: 'foam', ...nodeExtra },
      { id: 'spray', geometry: 'speck', material: 'foam' },
    ],
    motion: { duration: 10, tracks: [{ kind: 'node', id: 'carrier', property: 'translation', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 10, value: [10, 0, 0] }] }] },
    particles: { gravity: [0, 0, 0], systems: [system] },
  };
}

// With no speed, gravity or drag a particle stays where it was born, so its box is centred on its birth point.
function particleCenters(scene) {
  const positions = scene.parts.find(part => part.name === 'spray').geometry.positions;
  const centers = [];
  for (let first = 0; first < positions.length; first += BOX_VERTICES * 3) {
    const center = [0, 0, 0];
    for (let vertex = 0; vertex < BOX_VERTICES; vertex++) {
      for (let axis = 0; axis < 3; axis++) center[axis] += positions[first + vertex * 3 + axis] / BOX_VERTICES;
    }
    centers.push(center);
  }
  return centers;
}

function assertNear(actual, expected, message) {
  actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-3, `${message}: got [${actual.map(entry => entry.toFixed(4))}], expected [${expected}]`));
}

test('a node on an animation track carries the emitter: births at two times sit at the two node positions (#2829)', () => {
  const scene = createAgentScene(movingNodeRecipe(particleSystem({ shape: 'point', follow: 'carrier', position: [0, 1, 0] })));
  scene.sampleMotion(3);
  const centers = particleCenters(scene);
  assertNear(centers[0], [0, 1, 0], 'born at 0 s');
  assertNear(centers[1], [1, 1, 0], 'born at 1 s');
  assertNear(centers[3], [3, 1, 0], 'born at 3 s');
});

test('without follow the emitter stays at its world position, as before', () => {
  const scene = createAgentScene(movingNodeRecipe(particleSystem({ shape: 'point', position: [0, 1, 0] })));
  scene.sampleMotion(3);
  for (const center of particleCenters(scene).slice(0, 4)) assertNear(center, [0, 1, 0], 'fixed emitter');
});

test('the offset and the launch direction live in the frame of the node: a node turned 90 degrees about y sends +z toward +x', () => {
  const turned = { rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] };
  const recipe = movingNodeRecipe(particleSystem({ shape: 'point', follow: 'carrier', position: [0, 0, 2] }, { count: 1, speed: 1, spread: 0, direction: [0, 0, 1] }), turned);
  delete recipe.motion;
  const scene = createAgentScene(recipe);
  scene.sampleMotion(0);
  assertNear(particleCenters(scene)[0], [2, 0, 0], 'offset 2 m along local +z');
  scene.sampleMotion(1);
  assertNear(particleCenters(scene)[0], [3, 0, 0], 'one second at 1 m/s along local +z');
});

test('shapes box, sphere and disc are placed in the node frame and stay within their size', () => {
  const shapes = [
    { shape: 'box', halfExtents: [0.2, 0.2, 0.2] },
    { shape: 'sphere', radius: 0.3 },
    { shape: 'disc', radius: 0.3 },
  ];
  for (const shape of shapes) {
    const scene = createAgentScene(movingNodeRecipe(particleSystem({ ...shape, follow: 'carrier' }, { count: 4 })));
    scene.sampleMotion(3);
    particleCenters(scene).forEach((center, index) => {
      assert.ok(Math.hypot(center[0] - index, center[1], center[2]) <= 0.35, `${shape.shape} particle ${index} at [${center}]`);
    });
  }
});

test('seeking to the same motionTime twice gives byte-identical particle data, whatever was visited between', () => {
  const scene = createAgentScene(movingNodeRecipe(particleSystem({ shape: 'sphere', radius: 0.3, follow: 'carrier' }, { count: 40, rate: 8 })));
  const bytesAt = time => {
    scene.sampleMotion(time);
    return Buffer.from(scene.parts.find(part => part.name === 'spray').geometry.positions.buffer.slice(0));
  };
  const first = bytesAt(4);
  bytesAt(9);
  bytesAt(0.5);
  assert.deepEqual(bytesAt(4), first);
  const fresh = createAgentScene(movingNodeRecipe(particleSystem({ shape: 'sphere', radius: 0.3, follow: 'carrier' }, { count: 40, rate: 8 })));
  fresh.sampleMotion(4);
  assert.deepEqual(Buffer.from(fresh.parts.find(part => part.name === 'spray').geometry.positions.buffer.slice(0)), first);
});

test('a float.boat hull carries the emitter: each particle sits at the bow of the hull where it was born', () => {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'hull', type: 'box' },
      { id: 'speck', type: 'box', bevel: 0 },
      { id: 'sea', type: 'mesh', base: { type: 'grid', segments: 8 }, edits: [], stack: [{ op: 'ocean', windSpeed: 3, choppiness: 0, size: 30, seed: 2, resolution: 4 }] },
    ],
    materials: [{ id: 'paint', color: [0.6, 0.5, 0.4] }],
    nodes: [
      { id: 'sea', geometry: 'sea', material: 'paint' },
      { id: 'hull', geometry: 'hull', material: 'paint', translation: [0, 0.2, 0], scale: [1.8, 0.7, 3.8] },
      { id: 'spray', geometry: 'speck', material: 'paint' },
    ],
    physics: { duration: 5, ocean: { geometry: 'sea' }, bodies: [{ node: 'hull', density: 300, float: { points: [[-0.6, 0, -1.4], [0.6, 0, -1.4], [-0.6, 0, 1.4], [0.6, 0, 1.4]], boat: { thrust: 6, controls: [{ time: 0, throttle: 1 }] } } }] },
    particles: { gravity: [0, 0, 0], systems: [particleSystem({ shape: 'point', follow: 'hull', position: [0, 0, -0.5] }, { count: 4 })] },
  };
  const scene = createAgentScene(recipe);
  const hullAt = time => {
    scene.sampleMotion(time);
    return Array.from(scene.parts.find(part => part.name === 'hull').matrix);
  };
  const bowAt = time => {
    const matrix = hullAt(time);
    return [0, 1, 2].map(row => matrix[12 + row] + matrix[8 + row] * -0.5);
  };
  const expected = [0, 1, 2, 3].map(bowAt);
  scene.sampleMotion(3);
  const centers = particleCenters(scene);
  centers.forEach((center, index) => assertNear(center, expected[index], `particle ${index}`));
  assert.ok(expected[3][2] < expected[0][2] - 3, 'the hull sailed on, so the births are spread along its track');
});

test('an unknown node id fails with the node ids, and a mesh emitter or the system node cannot follow', () => {
  assert.throws(
    () => createAgentScene(movingNodeRecipe(particleSystem({ shape: 'point', follow: 'ship' }))),
    /particles\.systems\[0\]\.emitter\.follow: got "ship"; expected the ID of a node in the recipe[^]*known nodes: carrier, spray/,
  );
  assert.throws(
    () => createAgentScene(movingNodeRecipe(particleSystem({ shape: 'mesh', mesh: 'carrier', follow: 'carrier' }))),
    /emitter\.follow: .*left out on a mesh emitter/,
  );
  assert.throws(
    () => createAgentScene(movingNodeRecipe(particleSystem({ shape: 'point', follow: 'spray' }))),
    /emitter\.follow: .*another node than the system node/,
  );
});
