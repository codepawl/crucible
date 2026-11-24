import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';
import { MAX_WAKE_POINTS, normalizeWake, slamStrength, wakeAt, wakeTrail } from '../src/ocean-wake.js';
import { oceanMesh } from '../src/mesh-ocean-modifier.js';
import { createMeshData } from '../src/mesh-data.js';

await loadPhysicsEngine({ buoyancy: true });

const MOVING_STERN = time => ({ x: 0, z: -4 * time, speed: 4 });

test('a wake trail holds at most 64 points however many are asked for', () => {
  const points = wakeTrail({ sample: MOVING_STERN, time: 30, lifetime: 6, width: 1, strength: 1, count: 5000 });
  assert.ok(points.length <= MAX_WAKE_POINTS, `${points.length} points`);
  assert.ok(points.length > 50, `${points.length} points above the fade threshold`);
});

test('older points are weaker and wider, and the oldest are nearly gone', () => {
  const points = wakeTrail({ sample: MOVING_STERN, time: 30, lifetime: 6, width: 1, strength: 1 });
  for (let index = 1; index < points.length; index++) {
    assert.ok(points[index][2] < points[index - 1][2], 'strength falls with age');
    assert.ok(points[index][3] > points[index - 1][3], 'width grows with age');
  }
  assert.equal(points[0][2], 1);
  assert.ok(points.at(-1)[2] < 0.05);
});

test('the trail is an open V: narrow at the stern, widening and fading with age, and it does not close on itself in a turn', () => {
  const radius = 8;
  const speed = 4;
  const turning = time => ({ x: radius * Math.sin(speed * time / radius), z: radius * (1 - Math.cos(speed * time / radius)), speed });
  const points = wakeTrail({ sample: turning, time: 20, lifetime: 3, width: 1.6, strength: 1 });
  assert.ok(points[0][3] < 1, `stern width ${points[0][3]}`);
  assert.ok(points.at(-1)[3] > 3 * points[0][3], 'the oldest point is much wider than the newest');
  const ages = points.map((_, index) => index);
  assert.deepEqual(ages, [...ages].sort((first, second) => first - second));
  for (let index = 1; index < points.length; index++) {
    assert.ok(points[index][3] > points[index - 1][3] && points[index][2] < points[index - 1][2]);
  }
  const gap = Math.hypot(points[0][0] - points.at(-1)[0], points[0][1] - points.at(-1)[1]);
  assert.ok(gap > points.at(-1)[3] + points[0][3], `the ends are ${gap} m apart, wider than their foam`);
});

test('a hull at rest leaves no wake and the trail starts no earlier than time 0', () => {
  assert.equal(wakeTrail({ sample: () => ({ x: 0, z: 0, speed: 0 }), time: 10, lifetime: 5, width: 1, strength: 1 }).length, 0);
  const underway = wakeTrail({ sample: MOVING_STERN, time: 0, lifetime: 3, width: 1, strength: 1 });
  assert.ok(underway.length > 20, `${underway.length} points at time 0 for a hull already moving`);
});

test('a wake is capped lace with a flat top and an edge, adds no trough, and nothing far away', () => {
  const wake = normalizeWake({ points: [[0, 0, 1, 1]], height: 0.2 });
  assert.ok(Math.abs(wakeAt(wake, 0, 0).foam - 0.8) < 1e-9, 'capped at 0.8, below full white');
  assert.ok(wakeAt(wake, 0.5, 0).foam > 0.75, 'dense across the body of the wake');
  assert.ok(wakeAt(wake, 1.4, 0).foam < 0.55, 'a short edge');
  const faint = normalizeWake({ points: [[0, 0, 0.3, 1]] });
  assert.ok(wakeAt(faint, 0, 0).foam < 0.7 && wakeAt(faint, 0, 0).foam > 0.5, 'a weak point is a thin lace');
  assert.deepEqual(wakeAt(wake, 20, 0), { foam: 0, offset: 0 });
});

test('a wake roughens the surface in both directions and never flattens or lowers it', () => {
  // The window spans two 5 m churn swells, so its mean is the mean of whole swells.
  const wake = normalizeWake({ points: [[0, 0, 1, 8]], height: 0.2 });
  let lowest = 0;
  let highest = 0;
  let sum = 0;
  let count = 0;
  for (let x = -5; x <= 5; x += 0.25) {
    for (let z = -5; z <= 5; z += 0.25) {
      const { offset } = wakeAt(wake, x, z);
      lowest = Math.min(lowest, offset);
      highest = Math.max(highest, offset);
      sum += offset;
      count++;
    }
  }
  assert.ok(lowest < -0.05 && highest > 0.05, `churn from ${lowest} to ${highest}`);
  assert.ok(highest <= 0.2 && lowest >= -0.2, 'bounded by height');
  assert.ok(Math.abs(sum / count) < 0.03, `mean offset ${sum / count} is near zero, so no calm patch or hole`);
  assert.deepEqual(wakeAt(wake, 0.3, 0.7), wakeAt(wake, 0.3, 0.7), 'repeatable');
});

test('the ocean edit applies the wake to the foam group and the height, the same on every run', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 30, 0, 30]);
  const mesh = createMeshData({ positions, faceOffsets: new Uint32Array([0, 3]), cornerVertices: new Uint32Array([0, 1, 2]) });
  const options = { axis: 'y', windSpeed: 4, direction: 0, choppiness: 0, size: 30, seed: 1, time: 0, resolution: 3 };
  const calm = oceanMesh(mesh, options);
  const wake = normalizeWake({ points: [[0, 0, 1, 1]], height: 0.2 });
  const wet = oceanMesh(mesh, { ...options, wake });
  assert.notEqual(wet.positions[1], calm.positions[1], 'the wake displaces the stern');
  assert.equal(wet.positions[7], calm.positions[7] + wakeAt(wake, 30, 30).offset);
  assert.deepEqual(Array.from(wet.positions), Array.from(oceanMesh(mesh, { ...options, wake }).positions));
});

test('wake fields fail with the field name and what to pass', () => {
  assert.throws(() => normalizeWake({ points: Array.from({ length: 65 }, () => [0, 0, 1, 1]) }), /wake\.points must be an array of at most 64 points/);
  assert.throws(() => normalizeWake({ points: [[0, 0, 2, 1]] }), /wake\.points\[0\] strength must be from 0 to 1, got 2/);
  assert.throws(() => normalizeWake({ height: 5 }), /wake\.height must be a number from 0 to 2/);
  assert.throws(() => normalizeWake({ speed: 1 }), /wake\.speed is unsupported; use points or height/);
});

// The top face of a box, the flat y-up sea the shipped boat clip uses (a bare grid stands upright and has no depth for a wake to cover).
const FLAT_SEA_EDITS = [
  { op: 'subdivide_edges', edges: { all: true }, cuts: 16 },
  { op: 'delete', select: { not: { normal: [0, 1, 0], maxAngle: 10 } } },
  { op: 'subdivide', levels: 1 },
  { op: 'set_position', position: { mul: [{ attr: 'position' }, [48, 1, 48]] } },
];

function boatRecipe(wake, velocity) {
  const boat = { thrust: 6, controls: [{ time: 0, throttle: 1 }] };
  if (wake) boat.wake = wake;
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'hull', type: 'box' },
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: FLAT_SEA_EDITS, stack: [{ op: 'ocean', windSpeed: 3, choppiness: 0, size: 30, seed: 2, resolution: 4 }] },
    ],
    materials: [{ id: 'paint', color: [0.6, 0.5, 0.4] }, { id: 'water', color: [0.02, 0.12, 0.2], tag: 'water' }],
    nodes: [
      { id: 'sea', geometry: 'sea', material: 'water' },
      { id: 'hull', geometry: 'hull', material: 'paint', translation: [0, 0.2, 0], scale: [1.8, 0.7, 3.8] },
    ],
    motion: { duration: 5, tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 0 }, { time: 5, value: 5 }] }] },
    physics: { duration: 5, ocean: { geometry: 'sea' }, bodies: [{ node: 'hull', density: 300, ...(velocity ? { velocity } : {}), float: { points: [[-0.6, 0, -1.4], [0.6, 0, -1.4], [-0.6, 0, 1.4], [0.6, 0, 1.4]], boat } }] },
  };
}

function seaPositions(wake, time, velocity) {
  const scene = createAgentScene(boatRecipe(wake, velocity));
  scene.sampleMotion(time);
  return Array.from(scene.parts[0].geometry.positions);
}

test('a boat recipe with wake draws a bounded wake into the sea behind the hull, and without it the sea is untouched', () => {
  const plain = seaPositions(undefined, 4);
  const wet = seaPositions({ height: 0.15 }, 4);
  assert.equal(plain.length, wet.length);
  let changed = 0;
  let largest = 0;
  for (let index = 1; index < plain.length; index += 3) {
    const difference = Math.abs(wet[index] - plain[index]);
    if (difference > 0) changed++;
    largest = Math.max(largest, difference);
  }
  assert.ok(changed > 20, `${changed} vertices moved`);
  assert.ok(largest <= 0.15 * 4 + 1e-6 && largest > 0.01, `largest change ${largest} m`);
  assert.deepEqual(wet, seaPositions({ height: 0.15 }, 4), 'same bake, same sea');
});

test('a hull that starts with a velocity has a wake and white water at its hull from the first frame', () => {
  const plain = seaPositions(undefined, 0, [0, 0, 4]);
  const wet = seaPositions({ height: 0.15 }, 0, [0, 0, 4]);
  let changed = 0;
  for (let index = 1; index < plain.length; index += 3) if (wet[index] !== plain[index]) changed++;
  assert.ok(changed > 20, `${changed} vertices carry the wake at time 0`);
});

test('a boat wake field is checked: lifetime, width, strength and height name what to pass', () => {
  assert.throws(() => createAgentScene(boatRecipe({ lifetime: 0 })), /boat\.wake\.lifetime must be a number from 0\.5 to 60/);
});

test('wakeTrail skips points whose strength is not a number', () => {
  const stern = speed => () => ({ x: 0, z: 0, speed });
  const zeroLifetime = wakeTrail({ sample: stern(3), time: 1, lifetime: 0, width: 1, strength: 1, count: 4 });
  const missingSpeed = wakeTrail({ sample: stern(undefined), time: 1, lifetime: 2, width: 1, strength: 1, count: 4 });
  for (const point of [...zeroLifetime, ...missingSpeed]) assert.ok(point.every(Number.isFinite), `point ${point}`);
  assert.equal(missingSpeed.length, 0);
});

test('a wake point names the field that failed and its limit', () => {
  assert.throws(() => normalizeWake({ points: [[0, 0, 1, 2000]] }), /wake\.points\[0\] width must be above 0 and at most 1000 metres, got 2000/);
  assert.throws(() => normalizeWake({ points: [[0, 0, 1, 0]] }), /width must be above 0 and at most 1000 metres, got 0/);
});

test('a wake point with a hole or a missing entry is refused', () => {
  const holed = [0, 0, 1, 1];
  delete holed[0];
  assert.throws(() => normalizeWake({ points: [[0, 0, 1, 1], holed] }), /wake\.points\[1\] must be four finite numbers/);
  const holedList = [[0, 0, 1, 1], [1, 1, 1, 1]];
  delete holedList[1];
  assert.throws(() => normalizeWake({ points: holedList }), /wake\.points\[1\] must be four finite numbers/);
});

// #2730 keeps a posed sea across edits, but a sea a wake deforms follows the hull, so moving the hull must draw the new wake.
test('moving the hull of a wake draws the wake of the new place, as a scene built there does', () => {
  const scene = createAgentScene(boatRecipe({ height: 0.15 }, [0, 0, 4]));
  const before = Array.from(scene.parts[0].geometry.positions);
  scene.apply([{ type: 'set-node', id: 'hull', translation: [6, 0.2, 0] }], { expectedRevision: scene.revision });
  const moved = boatRecipe({ height: 0.15 }, [0, 0, 4]);
  moved.nodes[1].translation = [6, 0.2, 0];
  const fresh = createAgentScene(moved);
  assert.notDeepEqual(Array.from(scene.parts[0].geometry.positions), before, 'the wake moved with the hull');
  assert.deepEqual(Array.from(scene.parts[0].geometry.positions), Array.from(fresh.parts[0].geometry.positions));
});

test('the foam of a static wake point holds still while the sea moves under it', () => {
  const gridSize = 24;
  const positions = [];
  for (let row = 0; row <= gridSize; row++) {
    for (let column = 0; column <= gridSize; column++) positions.push(column * 0.5, 0, row * 0.5);
  }
  const triangle = new Uint32Array([0, 1, gridSize + 1]);
  const mesh = createMeshData({ positions: new Float32Array(positions), faceOffsets: new Uint32Array([0, 3]), cornerVertices: triangle });
  const wake = normalizeWake({ points: [[6, 6, 1, 3]], height: 0.4 });
  const options = { axis: 'y', windSpeed: 10, direction: 0, choppiness: 2, size: 70, seed: 23, resolution: 6, foamMemory: 0, coverage: -1, wake };
  const seaOnly = time => oceanMesh(mesh, { ...options, wake: undefined, time });
  const withWake = time => oceanMesh(mesh, { ...options, time });
  const foamOf = data => Array.from(data.attributes.point['group:foam'].data);
  const nearPoint = [];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    if (Math.hypot(positions[vertex * 3] - 6, positions[vertex * 3 + 2] - 6) < 3) nearPoint.push(vertex);
  }
  assert.ok(nearPoint.length > 20);
  for (const vertex of nearPoint) {
    const expected = wakeAt(wake, positions[vertex * 3], positions[vertex * 3 + 2]);
    for (const time of [0, 0.7, 1.9, 5.3]) {
      assert.ok(Math.abs(foamOf(withWake(time))[vertex] - Math.max(foamOf(seaOnly(time))[vertex], expected.foam)) < 1e-5, `vertex ${vertex} at ${time}s keeps the foam of its rest position`);
      const rise = withWake(time).positions[vertex * 3 + 1] - seaOnly(time).positions[vertex * 3 + 1];
      assert.ok(Math.abs(rise - expected.offset) < 1e-5, `vertex ${vertex} at ${time}s has the wake offset of its rest position, got ${rise} not ${expected.offset}`);
    }
  }
});

test('slam foam scales with closing speed and forward speed and fades with the decay time', () => {
  const pulseAtOneSecond = moment => (Math.abs(moment - 1) < 0.01 ? 3 : 0);
  const options = { closingSpeedAt: pulseAtOneSecond, forwardSpeedAt: () => 3.3, decay: 0.5, fullSpeed: 1.5, fullForward: 3, step: 0.01 };
  assert.equal(slamStrength({ ...options, time: 0.5 }), 0, 'nothing before the slam');
  assert.equal(slamStrength({ ...options, time: 1 }), 1, 'a hard slam at speed is full foam');
  assert.ok(Math.abs(slamStrength({ ...options, time: 1.5 }) - Math.exp(-1)) < 0.03, 'it fades by e every decay');
  assert.equal(slamStrength({ ...options, time: 4 }), 0, 'and is gone after four decays');
  const steady = { ...options, time: 2, closingSpeedAt: () => 1.25 };
  assert.equal(slamStrength(steady), 0.5, 'half the full closing speed is half the foam');
  assert.ok(Math.abs(slamStrength({ ...steady, closingSpeedAt: () => 0.875 }) - 0.25) < 1e-9, 'a quarter of the closing speed is a quarter of the foam');
  assert.equal(slamStrength({ ...steady, closingSpeedAt: () => 30 }), 1, 'the burst is capped at full');
  assert.equal(slamStrength({ ...steady, closingSpeedAt: () => 2, forwardSpeedAt: () => 1.8 }), 0.5, 'half the forward speed is half the foam');
  assert.equal(slamStrength({ ...steady, closingSpeedAt: () => 2, forwardSpeedAt: () => 0 }), 0, 'a hull at rest makes no burst');
  assert.equal(slamStrength({ ...steady, closingSpeedAt: () => 0 }), 0, 'a hull rising or riding the swell makes none');
  assert.equal(slamStrength({ ...steady, closingSpeedAt: () => 0.4 }), 0, 'ripple under the dead zone makes none');
});

function boatOnSwell(windSpeed, bootWake, thrust = 6) {
  const recipe = boatRecipe(bootWake);
  recipe.geometries[1].stack[0].windSpeed = windSpeed;
  recipe.geometries[1].stack[0].choppiness = 1;
  recipe.physics.bodies[0].float.boat = { thrust, controls: [{ time: 0, throttle: thrust > 0 ? 1 : 0 }], ...(bootWake ? { wake: bootWake } : {}) };
  return createAgentScene(recipe);
}

function wakeFoamAround(windSpeed, wake, times, thrust) {
  const wet = boatOnSwell(windSpeed, wake, thrust);
  const { slamSpeed, ...withoutSlam } = wake;
  const dry = boatOnSwell(windSpeed, withoutSlam, thrust);
  const changes = [];
  let energy = 0;
  for (const time of times) {
    wet.sampleMotion(time);
    dry.sampleMotion(time);
    const wetSea = wet.parts[0].geometry.positions;
    const drySea = dry.parts[0].geometry.positions;
    for (let vertex = 0; vertex < wetSea.length / 3; vertex++) {
      const change = Math.abs(wetSea[vertex * 3 + 1] - drySea[vertex * 3 + 1]);
      energy += change;
      changes.push({ time, x: wetSea[vertex * 3], z: wetSea[vertex * 3 + 2], change });
    }
  }
  return { energy, changes, wet };
}

const afterSettling = [1.5, 2, 2.5, 3, 3.5, 4, 4.5];

test('a hull resting on calm water makes no slam foam, and one slamming into a swell at speed makes bursts', () => {
  const wake = { height: 0.15, slamSpeed: 0.5 };
  const calm = wakeFoamAround(1, { ...wake, slamSpeed: 1.5 }, [3.5, 4, 4.5], 6).energy;
  assert.equal(calm, 0, 'calm water makes no burst');
  const swell = wakeFoamAround(14, wake, afterSettling, 6).energy;
  assert.ok(swell > 3 * Math.max(calm, 0.01), 'swell ' + swell + ' against calm ' + calm);
  assert.equal(swell, wakeFoamAround(14, wake, afterSettling, 6).energy, 'the same bake gives the same foam');
  const anchored = wakeFoamAround(14, wake, afterSettling, 0).energy;
  assert.ok(anchored < swell / 2, 'a hull only drifting makes far less than one under way: ' + anchored + ' against ' + swell);
});

test('a harder slamSpeed asks for a harder hit, and the fields are checked', () => {
  const gentle = wakeFoamAround(14, { height: 0.15, slamSpeed: 0.3 }, afterSettling, 6).energy;
  const stiff = wakeFoamAround(14, { height: 0.15, slamSpeed: 20 }, afterSettling, 6).energy;
  assert.ok(gentle > 1.5 * stiff, 'gentle ' + gentle + ' against stiff ' + stiff);
  assert.throws(() => boatOnSwell(14, { slamSpeed: 0 }), /slamSpeed/);
  assert.throws(() => boatOnSwell(14, { slamForward: 0 }), /slamForward/);
  assert.throws(() => boatOnSwell(14, { slamSpeed: 1, slamDecay: 99 }), /slamDecay/);
});

test('slam foam stays within a bounded distance of the hull', () => {
  const wake = { height: 0.15, slamSpeed: 0.3, width: 1.2 };
  const withSlam = wakeFoamAround(14, wake, afterSettling, 6);
  const hull = boatOnSwell(14, wake, 6);
  let farthest = 0;
  let changedVertices = 0;
  for (const time of afterSettling) {
    hull.sampleMotion(time);
    const [hullX, hullZ] = [hull.parts[1].matrix[12], hull.parts[1].matrix[14]];
    for (const { time: changeTime, x, z, change } of withSlam.changes) {
      if (changeTime !== time || change < 1e-6) continue;
      changedVertices++;
      farthest = Math.max(farthest, Math.hypot(x - hullX, z - hullZ));
    }
  }
  assert.ok(changedVertices > 0, 'the swell run makes some foam');
  assert.ok(farthest < 12, 'slam foam reached ' + farthest + ' m from the hull');
});

test('a boat wake without slamSpeed keeps the sea byte for byte as before', () => {
  const plain = boatOnSwell(14, { height: 0.15 });
  const explicitlyOff = boatOnSwell(14, { height: 0.15, slamForward: 7 });
  for (const time of afterSettling) {
    plain.sampleMotion(time);
    explicitlyOff.sampleMotion(time);
    assert.deepEqual(Array.from(plain.parts[0].geometry.positions), Array.from(explicitlyOff.parts[0].geometry.positions));
  }
});

test('the wake surface changes smoothly from one sea vertex to the next, so foam lace does not zigzag (#3070)', () => {
  const height = 0.1;
  const wake = normalizeWake({ points: [[0, 0, 1, 20]], height });
  const cell = 0.44;
  let largestStep = 0;
  for (let x = -4; x <= 4; x += 0.11) {
    for (let z = -4; z <= 4; z += 0.11) {
      const here = wakeAt(wake, x, z).offset;
      largestStep = Math.max(largestStep, Math.abs(here - wakeAt(wake, x + cell, z).offset), Math.abs(here - wakeAt(wake, x, z + cell).offset));
    }
  }
  // Swells 5 m long rise at most 0.44 of their height over 0.44 m; a hash per vertex jumps by up to twice the height.
  assert.ok(largestStep < 0.5 * height, `neighbouring vertices differ by ${largestStep} m of a ${height} m wake`);
});
