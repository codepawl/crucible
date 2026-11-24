// A file scene that is a closed room lit by a sun gets the recipe path's interior light: the sky trace on its surfaces and
// the lights its sunlit patches bounce (#2761). Open scenes, sunless ones and scene files that turn either step off do not.
import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { withFileSceneInteriorLight } from '../src/dense-lods.js';

// A closed room. With `opening` its roof has a gap the sun reaches a patch of the floor through; without, the roof is whole.
function roomParts({ opening = true } = {}) {
  const block = (id, translation, scale) => ({ id, geometry: 'box', material: 'stone', translation, scale });
  const { parts } = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box' }],
    materials: [{ id: 'stone', color: [0.6, 0.5, 0.4], roughness: 0.8 }],
    nodes: [
      block('floor', [0, -0.05, 0], [10, 0.1, 10]),
      block('wall-left', [-5, 2, 0], [0.2, 4, 10]),
      block('wall-right', [5, 2, 0], [0.2, 4, 10]),
      block('wall-front', [0, 2, 5], [10, 4, 0.2]),
      block('wall-back', [0, 2, -5], [10, 4, 0.2]),
      ...(opening
        ? [block('roof-left', [-2.9, 4.1, 0], [4.6, 0.2, 10.4]), block('roof-right', [2.9, 4.1, 0], [4.6, 0.2, 10.4])]
        : [block('roof', [0, 4.1, 0], [10.4, 0.2, 10.4])]),
    ],
    camera: { eye: [0, 1.5, 4], target: [0, 1.5, 0], fov: 60, near: 0.05, far: 40 },
    environment: { keyColor: [3, 3, 3], lightDirection: [0, 1, 0.2], floorSkyTrace: false, sunBounce: 0 },
  });
  return parts;
}

const SUN = { keyColor: [3, 3, 3], lightDirection: [0, 1, 0.2] };
// The scene path runs the trace with its default budgets, which take seconds here; the test keeps the trace small.
const SMALL_TRACE = { maximumTexels: 400 };

test('a closed room with a sun gets the sky trace on its surfaces', async () => {
  const parts = roomParts({ opening: false });
  const lit = await withFileSceneInteriorLight(parts, SUN, SMALL_TRACE);
  assert.equal(lit.parts.length, parts.length, 'one part for one part, so the clip player still matches them');
  assert.equal(lit.skyReport.reason, null);
  assert.ok(lit.parts.some(part => part.geometry.skyVisibility), 'the room surfaces carry the sky they see');
});

test('a room the sun reaches through an opening gets the lights its sunlit patch bounces', async () => {
  const lit = await withFileSceneInteriorLight(roomParts(), SUN);
  assert.ok(lit.environment.pointLights.length > 0 && lit.environment.pointLights.length <= 6);
  assert.deepEqual(lit.environment.lightDirection, SUN.lightDirection, 'the key light is kept');
});

test('open ground, a scene with no sun and a scene file that turns the steps off come back unchanged', async () => {
  const floorOnly = roomParts().filter(part => part.name === 'floor');
  const open = await withFileSceneInteriorLight(floorOnly, SUN);
  assert.equal(open.parts, floorOnly);
  assert.equal(open.environment, SUN);

  const parts = roomParts();
  const dark = { ...SUN, keyIntensity: 0 };
  const unlit = await withFileSceneInteriorLight(parts, dark);
  assert.deepEqual({ parts: unlit.parts, environment: unlit.environment, skyReport: unlit.skyReport }, { parts, environment: dark, skyReport: null });
  assert.equal(unlit.bounceReport.reason, 'no sun');

  const off = { ...SUN, floorSkyTrace: false, sunBounce: 0 };
  const unchanged = await withFileSceneInteriorLight(parts, off);
  assert.equal(unchanged.parts, parts);
  assert.equal(unchanged.environment, off);

  const closed = roomParts({ opening: false });
  const traceOnly = await withFileSceneInteriorLight(closed, { ...SUN, sunBounce: 0 }, SMALL_TRACE);
  assert.equal(traceOnly.environment.pointLights, undefined);
  assert.notEqual(traceOnly.parts, closed, 'sunBounce: 0 leaves the sky trace on');
  const bounceOnly = await withFileSceneInteriorLight(parts, { ...SUN, floorSkyTrace: false });
  assert.equal(bounceOnly.parts, parts, 'floorSkyTrace: false leaves the bounce lights on');
  assert.ok(bounceOnly.environment.pointLights.length > 0);
});
