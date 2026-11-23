import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

function emptySession() {
  return createAgentScene({ format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [] });
}

function applyAll(session, operations) {
  session.apply(operations, { expectedRevision: session.revision });
  return session.exportRecipe();
}

test('set-camera null clears optional lens fields and the fields that depend on them', () => {
  const session = emptySession();
  applyAll(session, [{ type: 'set-camera', focalLength: 35, sensorWidth: 24, shift: [0.1, 0], fStop: 2.8, focusDistance: 4 }]);
  const recipe = applyAll(session, [{ type: 'set-camera', focalLength: null, shift: null, fStop: null }]);
  for (const field of ['focalLength', 'sensorWidth', 'shift', 'fStop', 'focusDistance']) {
    assert.equal(Object.hasOwn(recipe.camera, field), false, `${field} is not set`);
  }
  assert.equal(recipe.camera.fov, 45);
});

test('set-camera projection null returns to perspective and drops orthoScale', () => {
  const session = emptySession();
  applyAll(session, [{ type: 'set-camera', projection: 'orthographic', orthoScale: 6 }]);
  const recipe = applyAll(session, [{ type: 'set-camera', projection: null }]);
  assert.equal(Object.hasOwn(recipe.camera, 'projection'), false);
  assert.equal(Object.hasOwn(recipe.camera, 'orthoScale'), false);
});

test('clearing a camera field that is not set changes nothing', () => {
  const session = emptySession();
  const before = session.exportRecipe().camera;
  const recipe = applyAll(session, [{ type: 'set-camera', shift: null, fStop: null }]);
  assert.deepEqual(recipe.camera, before);
});

test('set-camera refuses null on a required field and says what to pass', () => {
  const session = emptySession();
  assert.throws(() => session.apply([{ type: 'set-camera', near: null }], { expectedRevision: session.revision }), /camera\.near.*required and cannot be cleared.*0\.1/);
  assert.throws(() => session.apply([{ type: 'set-camera', fov: null }], { expectedRevision: session.revision }), /camera\.fov.*cannot be cleared/);
});

test('set-environment null clears optional fields and ignores ones that are not set', () => {
  const session = emptySession();
  applyAll(session, [{ type: 'set-environment', environment: { sunBounce: 1, specularAntiAliasing: 1, shadowCascades: 3, objectReflections: true, floorSkyTrace: true, ground: true, resolveCoplanar: 'offset' } }]);
  const optional = ['sunBounce', 'specularAntiAliasing', 'shadowCascades', 'objectReflections', 'floorSkyTrace', 'ground', 'resolveCoplanar'];
  assert.ok(optional.every(field => Object.hasOwn(session.exportRecipe().environment, field)), 'the fields were set first');
  const recipe = applyAll(session, [{ type: 'set-environment', environment: Object.fromEntries(optional.map(field => [field, null])) }]);
  for (const field of optional) assert.equal(Object.hasOwn(recipe.environment, field), false, `${field} is not set`);
  applyAll(session, [{ type: 'set-environment', environment: { sunBounce: null } }]);
});

test('set-environment refuses null on a required field and keeps fogDensity null as a value', () => {
  const session = emptySession();
  assert.throws(() => session.apply([{ type: 'set-environment', environment: { keyIntensity: null } }], { expectedRevision: session.revision }), /environment\.keyIntensity.*required and cannot be cleared.*1/);
  const recipe = applyAll(session, [{ type: 'set-environment', environment: { fogDensity: null } }]);
  assert.equal(recipe.environment.fogDensity, null);
});

test('set-effects merges depthOfField and motionBlur fields the way bloom does', () => {
  const session = emptySession();
  applyAll(session, [{ type: 'set-effects', effects: { depthOfField: { blur: 0.5, focusDistance: 3 }, motionBlur: { shutter: 0.1, objects: 1 } } }]);
  const recipe = applyAll(session, [{ type: 'set-effects', effects: { depthOfField: { blur: 0.8 }, motionBlur: { shutter: 0.3 } } }]);
  assert.deepEqual(recipe.effects.depthOfField, { blur: 0.8, focusDistance: 3 });
  assert.deepEqual(recipe.effects.motionBlur, { shutter: 0.3, objects: 1 });
});

test('set-effects null removes a whole group back to its defaults and an optional group field', () => {
  const session = emptySession();
  applyAll(session, [{ type: 'set-effects', effects: { depthOfField: { blur: 0.5, focusDistance: 3 }, motionBlur: { shutter: 0.1, objects: 1 } } }]);
  const recipe = applyAll(session, [{ type: 'set-effects', effects: { depthOfField: null, motionBlur: { objects: null } } }]);
  assert.deepEqual(recipe.effects.depthOfField, { blur: 0, focusDistance: 5 });
  assert.deepEqual(recipe.effects.motionBlur, { shutter: 0.1 });
});

test('set-effects refuses null on a required field and on a required group field', () => {
  const session = emptySession();
  assert.throws(() => session.apply([{ type: 'set-effects', effects: { exposure: null } }], { expectedRevision: session.revision }), /effects\.exposure.*required and cannot be cleared/);
  assert.throws(() => session.apply([{ type: 'set-effects', effects: { depthOfField: { blur: null } } }], { expectedRevision: session.revision }), /depthOfField\.blur.*cannot be cleared/);
});
