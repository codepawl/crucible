import assert from 'node:assert/strict';
import test from 'node:test';
import { SUN_RAY_GAP_FROM_MARK, sunRayStartOutsideMark } from '../src/studio-scene-marks.js';

const MARK_RADIUS = 13;
const CLEARANCE = MARK_RADIUS + SUN_RAY_GAP_FROM_MARK;

test('the sun ray starts just outside the mark disc, on the way to its end', () => {
  const start = sunRayStartOutsideMark({ x: 100, y: 100 }, { x: 160, y: 180 });
  assert.ok(Math.abs(Math.hypot(start.x - 100, start.y - 100) - CLEARANCE) < 1e-9, 'it starts at the disc radius plus the gap');
  assert.ok(Math.abs((start.y - 100) / (start.x - 100) - 80 / 60) < 1e-9, 'it stays on the line to the end');
});

test('a sun ray too short to clear the disc is not drawn', () => {
  assert.equal(sunRayStartOutsideMark({ x: 100, y: 100 }, { x: 100 + CLEARANCE, y: 100 }), null);
  assert.equal(sunRayStartOutsideMark({ x: 100, y: 100 }, { x: 100, y: 100 }), null);
});
