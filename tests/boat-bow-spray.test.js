import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';
import { createBoatBowSpray } from '../src/boat-bow-spray.js';
import { normalizeBoat } from '../src/physics-boat.js';

await loadPhysicsEngine({ buoyancy: true });

const FLAT_SEA_EDITS = [
  { op: 'subdivide_edges', edges: { all: true }, cuts: 16 },
  { op: 'delete', select: { not: { normal: [0, 1, 0], maxAngle: 10 } } },
  { op: 'subdivide', levels: 1 },
  { op: 'set_position', position: { mul: [{ attr: 'position' }, [48, 1, 48]] } },
];

function boatOnSeaRecipe({ windSpeed = 14, choppiness = 1, thrust = 6, wake = { height: 0.15, slamSpeed: 0.5 }, velocity } = {}) {
  const boat = { thrust, controls: [{ time: 0, throttle: thrust > 0 ? 1 : 0 }], ...(wake ? { wake } : {}) };
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'hull', type: 'box' },
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: FLAT_SEA_EDITS, stack: [{ op: 'ocean', windSpeed, choppiness, size: 30, seed: 2, resolution: 4 }] },
    ],
    materials: [
      { id: 'paint', color: [0.6, 0.5, 0.4] },
      { id: 'water', color: [0.02, 0.12, 0.2], tag: 'water' },
    ],
    nodes: [
      { id: 'sea', geometry: 'sea', material: 'water' },
      { id: 'hull', geometry: 'hull', material: 'paint', translation: [0, 0.2, 0], scale: [1.8, 0.7, 3.8] },
    ],
    camera: { eye: [8, 3, -6], target: [0, 0.5, 0], up: [0, 1, 0] },
    motion: {
      duration: 5,
      tracks: [{ kind: 'geometry', id: 'sea', property: 'oceanTime', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 0 }, { time: 5, value: 5 }] }],
    },
    physics: {
      duration: 5,
      ocean: { geometry: 'sea' },
      bodies: [{
        node: 'hull',
        density: 300,
        ...(velocity ? { velocity } : {}),
        float: { points: [[-0.6, 0, -1.4], [0.6, 0, -1.4], [-0.6, 0, 1.4], [0.6, 0, 1.4]], boat },
      }],
    },
  };
}

function makeSyntheticSpray({ closingSpeedAt, forwardSpeedAt, slamSpeed = 1.5, slamForward = 3, slamDecay = 0.6, bowSpray = {} } = {}) {
  const wake = normalizeBoat({ wake: { slamSpeed, slamForward, slamDecay, bowSpray } }, 'boat').wake;
  return createBoatBowSpray({
    bodyNode: 'hull',
    duration: 5,
    halfBeam: 0.6,
    halfLength: 1.9,
    bowAt: time => ({ bow: [0, 0, -3 * time], forward: [0, 0, -1], right: [1, 0, 0], seaLevel: 0, hullSpeed: forwardSpeedAt(time) }),
    closingSpeedAt,
    forwardSpeedAt,
    wake,
  });
}

test('bow spray intensity and droplet count scale with closing speed and forward speed, and stay zero below dead zones', () => {
  const peak = (closing, forward) => makeSyntheticSpray({
    closingSpeedAt: moment => (Math.abs(moment - 1) < 0.04 ? closing : 0),
    forwardSpeedAt: () => forward,
  }).evaluateDroplets(1.06);

  const strong = peak(2.0, 3.3);
  const moderate = peak(1.1, 3.3);
  const slowForward = peak(2.0, 1.2);
  assert.ok(strong.length > moderate.length, `strong ${strong.length} droplets > moderate ${moderate.length}`);
  assert.ok(strong.length > slowForward.length, `fast ${strong.length} droplets > slow ${slowForward.length}`);
  assert.ok(strong[0].alpha > moderate[0].alpha, 'stronger closing speed raises opacity');
  assert.ok(strong[0].size > moderate[0].size, 'stronger closing speed enlarges spray puffs');
  assert.equal(peak(0.4, 3.3).length, 0, 'closing speed below 0.5 m/s dead zone emits nothing');
  assert.equal(peak(2.0, 0.2).length, 0, 'forward speed below 0.3 m/s dead zone emits nothing');
});

test('bow spray burst fades cleanly to zero after slamDecay', () => {
  const decay = 0.5;
  const spray = makeSyntheticSpray({
    closingSpeedAt: moment => (moment >= 0.98 && moment <= 1.05 ? 2.5 : 0),
    forwardSpeedAt: () => 3.5,
    slamDecay: decay,
  });
  const early = spray.evaluateDroplets(1.1);
  const mid = spray.evaluateDroplets(1.1 + 0.55 * decay);
  const late = spray.evaluateDroplets(1.1 + 1.3 * decay);
  const wellPast = spray.evaluateDroplets(1.1 + 4 * decay);
  assert.ok(early.length > 0, 'burst is active right after the slam');
  const sumAlpha = droplets => droplets.reduce((total, droplet) => total + droplet.alpha, 0);
  assert.ok(sumAlpha(mid) < sumAlpha(early), `mid opacity ${sumAlpha(mid)} < early ${sumAlpha(early)}`);
  assert.equal(late.length, 0, 'all droplets fade out cleanly past bounded lifetime');
  assert.equal(wellPast.length, 0, 'zero droplets after 4 * slamDecay');
  assert.equal(spray.part(1.1 + 4 * decay, { eye: [5, 2, 0], up: [0, 1, 0] }), null, 'no render part emitted when decayed');
});

test('calm flat water and a hull at rest emit zero bow spray, while swell slams emit billboard sprites at the bow', () => {
  const calmScene = createAgentScene(boatOnSeaRecipe({ windSpeed: 1, choppiness: 0, thrust: 6, wake: { height: 0.15, slamSpeed: 1.5 } }));
  const calmAtRest = createAgentScene(boatOnSeaRecipe({ windSpeed: 1, choppiness: 0, thrust: 0, wake: { height: 0.15, slamSpeed: 0.5 } }));
  for (const time of [3.5, 4, 4.5]) {
    calmScene.sampleMotion(time);
    calmAtRest.sampleMotion(time);
    assert.equal(calmScene.parts.find(part => part.name === 'hull-bow-spray'), undefined, `calm water underway at ${time}s emits no spray`);
    assert.equal(calmAtRest.parts.find(part => part.name === 'hull-bow-spray'), undefined, `hull at rest on calm water at ${time}s emits no spray`);
  }

  const driftingScene = createAgentScene(boatOnSeaRecipe({ windSpeed: 14, choppiness: 1, thrust: 0, wake: { height: 0.15, slamSpeed: 0.5 } }));
  let driftingSprites = 0;
  for (let time = 1; time <= 4.5; time += 0.1) {
    driftingScene.sampleMotion(time);
    const driftingPart = driftingScene.parts.find(part => part.name === 'hull-bow-spray');
    if (driftingPart) driftingSprites += driftingPart.geometry.indices.length / 6;
  }

  const swellScene = createAgentScene(boatOnSeaRecipe({ windSpeed: 14, choppiness: 1, thrust: 6, wake: { height: 0.15, slamSpeed: 0.5 } }));
  let maxSprites = 0;
  let totalSprites = 0;
  for (let time = 1; time <= 4.5; time += 0.1) {
    swellScene.sampleMotion(time);
    const sprayPart = swellScene.parts.find(part => part.name === 'hull-bow-spray');
    if (!sprayPart) continue;
    const spriteCount = sprayPart.geometry.indices.length / 6;
    maxSprites = Math.max(maxSprites, spriteCount);
    totalSprites += spriteCount;
    assert.equal(sprayPart.material.alphaMode, 'blend');
    assert.equal(sprayPart.castShadow, false);
    assert.ok(sprayPart.geometry.vertexOpacity instanceof Float32Array);
    assert.ok(sprayPart.geometry.vertexOpacity.every(value => value > 0 && value <= 1));
    const hullMatrix = swellScene.parts.find(part => part.name === 'hull').matrix;
    const bowWorld = [hullMatrix[12] - hullMatrix[8] * 0.5, hullMatrix[13] - hullMatrix[9] * 0.5, hullMatrix[14] - hullMatrix[10] * 0.5];
    const firstPosition = [sprayPart.geometry.positions[0], sprayPart.geometry.positions[1], sprayPart.geometry.positions[2]];
    assert.ok(Math.hypot(firstPosition[0] - bowWorld[0], firstPosition[2] - bowWorld[2]) < 5, 'spray stays near the bow');
    const eye = swellScene.camera.eye;
    const toEye = [eye[0] - firstPosition[0], eye[1] - firstPosition[1], eye[2] - firstPosition[2]];
    const length = Math.hypot(...toEye);
    const normal = [sprayPart.geometry.normals[0], sprayPart.geometry.normals[1], sprayPart.geometry.normals[2]];
    const cosine = toEye.reduce((sum, value, axis) => sum + (value / length) * normal[axis], 0);
    assert.ok(cosine > 0.99, `billboard sprite faces camera (cosine ${cosine})`);
  }
  assert.ok(maxSprites > 0, 'swell run emits bow spray bursts');
  assert.ok(driftingSprites < totalSprites / 2, `drifting ${driftingSprites} sprites < underway ${totalSprites} / 2`);
});

test('direct seek to t = 2.0 matches stepped playback bit for bit, and seeds are deterministic', () => {
  const recipe = boatOnSeaRecipe({ windSpeed: 14, choppiness: 1, thrust: 6, wake: { height: 0.15, slamSpeed: 0.4, bowSpray: { seed: 7, count: 120 } } });
  const direct = createAgentScene(recipe);
  const stepped = createAgentScene(recipe);
  // Step forward, past, and back to t = 2.0 (or pick a slam time where spray is non-empty).
  let targetTime = 2.0;
  for (let probe = 1.0; probe <= 4.0; probe += 0.1) {
    direct.sampleMotion(probe);
    if (direct.parts.find(part => part.name === 'hull-bow-spray')) {
      targetTime = Number(probe.toFixed(2));
      break;
    }
  }
  const freshDirect = createAgentScene(recipe);
  freshDirect.sampleMotion(targetTime);
  for (const visit of [0.3, 4.2, 1.1, 3.8, targetTime]) stepped.sampleMotion(visit);

  const directPart = freshDirect.parts.find(part => part.name === 'hull-bow-spray');
  const steppedPart = stepped.parts.find(part => part.name === 'hull-bow-spray');
  assert.ok(directPart, `expected spray at t = ${targetTime}`);
  assert.deepEqual(Array.from(steppedPart.geometry.positions), Array.from(directPart.geometry.positions));
  assert.deepEqual(Array.from(steppedPart.geometry.normals), Array.from(directPart.geometry.normals));
  assert.deepEqual(Array.from(steppedPart.geometry.vertexOpacity), Array.from(directPart.geometry.vertexOpacity));
  assert.deepEqual(Array.from(steppedPart.geometry.indices), Array.from(directPart.geometry.indices));

  const otherSeed = createAgentScene(boatOnSeaRecipe({ windSpeed: 14, choppiness: 1, thrust: 6, wake: { height: 0.15, slamSpeed: 0.4, bowSpray: { seed: 99, count: 120 } } }));
  otherSeed.sampleMotion(targetTime);
  const otherPart = otherSeed.parts.find(part => part.name === 'hull-bow-spray');
  assert.notDeepEqual(Array.from(otherPart.geometry.positions), Array.from(directPart.geometry.positions), 'different seed gives distinct droplets');
});

test('recipes without slamSpeed or with bowSpray: false keep scenes unchanged, and bowSpray: true enables spray', () => {
  const plain = createAgentScene(boatOnSeaRecipe({ wake: { height: 0.15 } }));
  const sprayOff = createAgentScene(boatOnSeaRecipe({ wake: { height: 0.15, slamSpeed: 0.5, bowSpray: false } }));
  const sprayOn = createAgentScene(boatOnSeaRecipe({ wake: { height: 0.15, bowSpray: true } }));
  let sawOn = false;
  for (const time of [1.5, 2, 2.5, 3, 3.5, 4]) {
    plain.sampleMotion(time);
    sprayOff.sampleMotion(time);
    sprayOn.sampleMotion(time);
    assert.equal(plain.parts.find(part => part.name === 'hull-bow-spray'), undefined);
    assert.equal(sprayOff.parts.find(part => part.name === 'hull-bow-spray'), undefined);
    if (sprayOn.parts.find(part => part.name === 'hull-bow-spray')) sawOn = true;
  }
  assert.ok(sawOn, 'bowSpray: true defaults slamSpeed and emits spray');
});

test('bowSpray boundary validation rejects invalid values with clear field names and ranges', () => {
  const check = wake => () => createAgentScene(boatOnSeaRecipe({ wake }));
  assert.throws(check({ bowSpray: 123 }), /boat\.wake\.bowSpray must be true, false, or an object/);
  assert.throws(check({ bowSpray: [] }), /boat\.wake\.bowSpray must be true, false, or an object/);
  assert.throws(check({ bowSpray: { unknown: 1 } }), /boat\.wake\.bowSpray\.unknown is unsupported/);
  assert.throws(check({ bowSpray: { seed: -1 } }), /boat\.wake\.bowSpray\.seed must be an integer from 0 to 4294967295/);
  assert.throws(check({ bowSpray: { count: 0 } }), /boat\.wake\.bowSpray\.count must be an integer from 1 to 512/);
  assert.throws(check({ bowSpray: { count: 513 } }), /boat\.wake\.bowSpray\.count must be an integer from 1 to 512/);
  assert.throws(check({ bowSpray: { size: 0 } }), /boat\.wake\.bowSpray\.size must be a number from 0\.02 to 2/);
  assert.throws(check({ bowSpray: { lifetime: 10 } }), /boat\.wake\.bowSpray\.lifetime must be a number from 0\.05 to 5/);
  assert.throws(check({ bowSpray: { speed: -1 } }), /boat\.wake\.bowSpray\.speed must be a number from 0 to 30/);
  assert.throws(check({ bowSpray: { opacity: 2 } }), /boat\.wake\.bowSpray\.opacity must be a number from 0\.01 to 1/);
  assert.throws(check({ bowSpray: { color: [1, 1] } }), /boat\.wake\.bowSpray\.color must be \[r, g, b\]/);
  assert.throws(check({ bowSpray: { color: [1, 2, 0] } }), /boat\.wake\.bowSpray\.color\[1\] must be a number from 0 to 1/);
});
