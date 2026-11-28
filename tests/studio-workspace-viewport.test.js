import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { chooseViewportLook, workspaceDrawsPlainly } from '../src/studio-workspace-viewport.js';

const RECIPE = {
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box' }],
  materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
  nodes: [{ id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] }],
  camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  environment: { setup: 'overcast', lightDirection: [-2, 5, 3], fogDensity: 0.05, volumeFog: { density: 0.3 } },
  effects: { bloom: { strength: 1 }, vignette: 0.4 },
};

function frameInput(scene, workspaceId, drawingTheShot = false) {
  return { workspaceId, drawingTheShot, environment: scene.environment, effects: scene.effects, scene };
}

test('only Build draws plainly', () => {
  assert.equal(workspaceDrawsPlainly('build'), true);
  for (const workspaceId of ['look', 'animate', 'export']) {
    assert.equal(workspaceDrawsPlainly(workspaceId), false, workspaceId);
  }
});

test('Build drops shadows, fog, effects and post passes and leaves the scene untouched', () => {
  const scene = createAgentScene(RECIPE);
  const revisionBefore = scene.revision;
  const plain = chooseViewportLook(frameInput(scene, 'build'));
  assert.equal(plain.shadowsVisible, false);
  assert.equal(plain.environment.fogDensity, 0);
  assert.equal(plain.environment.volumeFog, undefined);
  assert.equal(plain.effects.bloom.strength, 0);
  assert.equal(plain.effects.vignette, 0);
  assert.deepEqual(plain.passScene.postPasses, []);
  assert.equal(scene.environment.fogDensity, 0.05);
  assert.equal(scene.effects.bloom.strength, 1);
  assert.equal(scene.revision, revisionBefore);
});

test('Look, Animate and Export keep the full look', () => {
  const scene = createAgentScene(RECIPE);
  for (const workspaceId of ['look', 'animate', 'export']) {
    const input = frameInput(scene, workspaceId);
    const full = chooseViewportLook(input);
    assert.equal(full.shadowsVisible, true, workspaceId);
    assert.equal(full.environment, input.environment, workspaceId);
    assert.equal(full.effects, input.effects, workspaceId);
    assert.equal(full.passScene, scene, workspaceId);
  }
});

test('a saved still keeps the full look even while Build is open', () => {
  const scene = createAgentScene(RECIPE);
  const input = frameInput(scene, 'build', true);
  const still = chooseViewportLook(input);
  assert.equal(still.shadowsVisible, true);
  assert.equal(still.environment, input.environment);
  assert.equal(still.effects, input.effects);
});
