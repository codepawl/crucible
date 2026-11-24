import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentLook } from '../src/agent-look.js';
import { sunAnglesFromClock } from '../src/sun-clock.js';
import { physicalSunDirection } from '../src/physical-sky.js';

function skyFor(sky) {
  return normalizeAgentLook({ environment: { sky: { type: 'physical', ...sky } } }).environment.sky;
}

const EQUINOX = { dayOfYear: 80, northOffset: 0 };

test('noon at the equator on the equinox puts the sun overhead', () => {
  const angles = sunAnglesFromClock({ hours: 12, latitude: 0, ...EQUINOX });
  assert.ok(Math.abs(angles.sunElevation - 90) < 0.5);
});

test('at 41.7 degrees north on the equinox, noon is 48.3 degrees up due south and 18:00 is on the western horizon', () => {
  const noon = sunAnglesFromClock({ hours: 12, latitude: 41.7, ...EQUINOX });
  assert.ok(Math.abs(noon.sunElevation - 48.3) < 0.5, `${noon.sunElevation}`);
  assert.ok(Math.abs(noon.sunRotation - 180) < 0.01, `${noon.sunRotation}`);
  const evening = sunAnglesFromClock({ hours: 18, latitude: 41.7, ...EQUINOX });
  assert.ok(Math.abs(evening.sunElevation) < 0.5);
  assert.ok(Math.abs(evening.sunRotation - 270) < 0.5, `${evening.sunRotation}`);
  const morning = sunAnglesFromClock({ hours: 6, latitude: 41.7, ...EQUINOX });
  assert.ok(Math.abs(morning.sunRotation - 90) < 0.5, `${morning.sunRotation}`);
});

test('the solstices move noon elevation by the axial tilt', () => {
  const summer = sunAnglesFromClock({ hours: 12, latitude: 40, dayOfYear: 172, northOffset: 0 });
  const winter = sunAnglesFromClock({ hours: 12, latitude: 40, dayOfYear: 355, northOffset: 0 });
  assert.ok(Math.abs(summer.sunElevation - (90 - 40 + 23.44)) < 0.3, `${summer.sunElevation}`);
  assert.ok(Math.abs(winter.sunElevation - (90 - 40 - 23.44)) < 0.3, `${winter.sunElevation}`);
});

test('midnight puts the sun below the horizon, and the offset turns the bearing', () => {
  assert.ok(sunAnglesFromClock({ hours: 0, latitude: 41.7, ...EQUINOX }).sunElevation < -40);
  const turned = sunAnglesFromClock({ hours: 12, latitude: 41.7, dayOfYear: 80, northOffset: 90 });
  assert.ok(Math.abs(turned.sunRotation - 270) < 0.01);
});

test('the sky takes the sun from the clock and the sun direction follows the Crucible axes', () => {
  const sky = skyFor({ clockTime: { hours: 15, latitude: 41.7 } });
  assert.equal(sky.clockTime, undefined);
  assert.ok(sky.sunElevation > 0 && sky.sunRotation > 180 && sky.sunRotation < 270);
  const direction = physicalSunDirection(sky);
  assert.ok(direction[0] < 0, 'afternoon sun is west, -X');
  assert.ok(direction[2] > 0, 'northern hemisphere sun stands south, +Z');
  assert.ok(direction[1] > 0);
  assert.deepEqual(skyFor({ sunElevation: sky.sunElevation, sunRotation: sky.sunRotation }), sky);
});

test('clockTime errors name the field and the fix', () => {
  assert.throws(() => skyFor({ clockTime: { hours: 25 } }), /environment\.sky\.clockTime\.hours.*0 to 24/);
  assert.throws(() => skyFor({ clockTime: {} }), /hours is required/);
  assert.throws(() => skyFor({ clockTime: { hours: 12, zone: 1 } }), /clockTime\.zone.*one of the fields/);
  assert.throws(() => skyFor({ clockTime: { hours: 12 }, sunElevation: 10 }), /sunElevation.*remove clockTime/);
  assert.throws(() => skyFor({ clockTime: { hours: 12 }, preset: 'sunset' }), /preset.*remove clockTime/);
});
