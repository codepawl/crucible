import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

function recipeWith(system) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'speck', type: 'box', bevel: 0 }],
    materials: [{ id: 'glow', color: [1, 0.5, 0.1], emission: 4 }],
    nodes: [{ id: 'sparks', geometry: 'speck', material: 'glow' }],
    particles: { systems: [{ node: 'sparks', seed: 7, count: 20, rate: 10, lifetime: 0.5, speed: [1, 2], size: 1, ...system }] },
  };
}

const FLOATS_PER_PARTICLE = 24 * 3;

function positionsAt(system, time) {
  const scene = createAgentScene(recipeWith(system));
  scene.sampleMotion(time);
  return Array.from(scene.parts.find(part => part.name === 'sparks').geometry.positions);
}

// A particle that is not alive is collapsed to a point, so its vertices span nothing.
function aliveParticles(positions) {
  const alive = [];
  for (let index = 0; index < positions.length / FLOATS_PER_PARTICLE; index++) {
    const first = index * FLOATS_PER_PARTICLE;
    const axisSpans = [0, 1, 2].map(axis => {
      const values = positions.filter((_, offset) => offset >= first && offset < first + FLOATS_PER_PARTICLE && offset % 3 === axis);
      return Math.max(...values) - Math.min(...values);
    });
    if (Math.max(...axisSpans) > 0) alive.push(index);
  }
  return alive;
}

test('start shifts every birth: the same particle at time t + start matches the one without start at t', () => {
  const unshifted = positionsAt({}, 0.25);
  const shifted = positionsAt({ start: 2 }, 2.25);
  assert.deepEqual(shifted, unshifted);
});

test('no particle is alive before start', () => {
  assert.deepEqual(aliveParticles(positionsAt({ start: 1 }, 0.5)), []);
  assert.deepEqual(aliveParticles(positionsAt({ start: 1 }, 0.99)), []);
  assert.deepEqual(aliveParticles(positionsAt({ start: 1 }, 1.01)), [0]);
});

test('nothing is born at or after stop, and the report counts only the window', () => {
  const system = { start: 1, stop: 1.5 };
  // Births are 1.0, 1.1, 1.2, 1.3 and 1.4: particles 5 and later would be born at 1.5 or after.
  assert.deepEqual(aliveParticles(positionsAt(system, 1.45)), [0, 1, 2, 3, 4]);
  for (const time of [1.6, 2, 5]) {
    assert.ok(aliveParticles(positionsAt(system, time)).every(index => index < 5), `at ${time} s only window particles can be alive`);
  }
  assert.deepEqual(aliveParticles(positionsAt(system, 2.05)), []);
  const report = createAgentScene(recipeWith(system)).inspect().particles.systems[0];
  assert.equal(report.maxAlive, 5);
  assert.equal(report.endsAt, 1.9);
});

test('without start and stop the particles are byte for byte what they were', () => {
  for (const time of [0, 0.3, 1.2, 2.4]) {
    assert.deepEqual(positionsAt({ start: 0 }, time), positionsAt({}, time));
    assert.deepEqual(positionsAt({ delay: 0 }, time), positionsAt({}, time));
  }
  const report = createAgentScene(recipeWith({})).inspect().particles.systems[0];
  assert.equal(report.maxAlive, 5);
  assert.equal(report.endsAt, 2.4);
});

test('start and delay are the same field and may not both be given', () => {
  assert.deepEqual(positionsAt({ delay: 1 }, 1.25), positionsAt({ start: 1 }, 1.25));
  assert.throws(() => createAgentScene(recipeWith({ start: 1, delay: 1 })), /either start or delay/);
});

test('invalid windows are refused with what to pass', () => {
  const bad = (system, pattern) => assert.throws(() => createAgentScene(recipeWith(system)), pattern);
  bad({ start: -1 }, /\.start: got -1; expected a number from 0 to 3600/);
  bad({ stop: '2' }, /\.stop: /);
  bad({ stop: 0 }, /\.stop: got 0; expected an absolute scene time in seconds, above start \(0\)/);
  bad({ start: 2, stop: 2 }, /\.stop: got 2; expected an absolute scene time in seconds, above start \(2\), such as 4/);
  bad({ start: 3, stop: 1 }, /\.stop: got 1; expected an absolute scene time in seconds, above start \(3\)/);
  bad({ delay: 2, stop: 1 }, /\.stop: got 1; expected an absolute scene time in seconds, above start \(2\)/);
});
