import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';

const recipeText = readFileSync(new URL('../public/recipes/cumulus-towers.json', import.meta.url), 'utf8');
const TOWER_IDS = ['tower-left', 'tower-middle', 'tower-right'];

// The sea is plain mesh edits with their own tests; leaving it out keeps this test to the towers.
function withoutSea(recipe) {
  return { ...recipe, geometries: recipe.geometries.filter(geometry => geometry.id !== 'sea'), nodes: recipe.nodes.filter(node => node.id !== 'sea') };
}

function hashOf(mesh) {
  const hash = createHash('sha256');
  for (const array of [mesh.positions, mesh.normals, mesh.indices]) hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  return hash.digest('hex');
}

test('the cumulus towers recipe has three wide, flat-based clouds with soft lobes and a cool-to-warm toon ramp', () => {
  const recipe = JSON.parse(recipeText);
  const towers = recipe.geometries.filter(geometry => geometry.type === 'cloud');
  assert.deepEqual(towers.map(tower => tower.id), TOWER_IDS);
  for (const tower of towers) {
    assert.ok(tower.height <= 1.2 * tower.width, `${tower.id} stays a heap, not a tall tower`);
    assert.equal(tower.flatBase, 1, `${tower.id} keeps a flat base`);
    assert.ok(tower.unionSoftness >= 0.2, `${tower.id} blends its lobes softly`);
    const softnesses = tower.levels.map(level => level.softness);
    assert.ok(softnesses.every(softness => softness >= 0.2), `${tower.id} never blends a level crisply enough to cut pits`);
    assert.ok(softnesses[0] > softnesses[1], `${tower.id} blends its big lobes more softly than its middle ones`);
  }
  const cumulus = recipe.materials.find(material => material.id === 'cumulus');
  assert.equal(cumulus.toon, 6);
  assert.equal(cumulus.toonColors.length, 6);
  const [darkest] = cumulus.toonColors;
  const lightest = cumulus.toonColors.at(-1);
  assert.ok(darkest[2] > darkest[0], 'the shaded step is blue-grey');
  assert.ok(lightest[0] > lightest[2], 'the lit step is warm white');
  assert.ok(Math.min(...darkest) >= 0.25, 'the shaded step stays light, so no dark pits');
});

test('the three clouds have their own seeds and sit apart, so they read as separate clouds', () => {
  const recipe = JSON.parse(recipeText);
  const towers = recipe.nodes.filter(node => node.id.startsWith('tower'));
  const seeds = recipe.geometries.filter(geometry => geometry.type === 'cloud').map(geometry => geometry.seed);
  assert.equal(new Set(seeds).size, 3);
  const gaps = towers.map(node => node.translation[0]).sort((first, second) => first - second);
  assert.ok(gaps[1] - gaps[0] >= 50 && gaps[2] - gaps[1] >= 50, 'neighbouring clouds sit at least 50 m apart across the view');
});

test('the cumulus towers recipe builds the same towers byte for byte every time, each different from the others', () => {
  const first = createAgentScene(withoutSea(JSON.parse(recipeText)));
  const second = createAgentScene(withoutSea(JSON.parse(recipeText)));
  assert.equal(first.parts.length, 3);
  const firstHashes = first.parts.map(part => hashOf(part.geometry));
  assert.deepEqual(firstHashes, second.parts.map(part => hashOf(part.geometry)));
  assert.equal(new Set(firstHashes).size, firstHashes.length);
});

test('the cumulus towers recipe ships with the still that the clouds guide shows', () => {
  assert.ok(existsSync(new URL('../public/recipes/cumulus-towers.webp', import.meta.url)));
  assert.ok(readFileSync(new URL('../docs/modeling.md', import.meta.url), 'utf8').includes('https://crucible.codepawl.com/recipes/cumulus-towers.json'));
});

test('the cumulus towers recipe places a low camera below the cloud bases under a side sun', () => {
  const recipe = JSON.parse(recipeText);
  const towers = recipe.nodes.filter(node => node.id.startsWith('tower-'));
  for (const tower of towers) {
    assert.ok(recipe.camera.eye[1] < tower.translation[1], `${tower.id} sits above the camera eye so the lifted underside is visible`);
  }
  const { sunElevation, sunRotation } = recipe.environment.sky;
  assert.ok(sunElevation > 0 && sunElevation <= 30, 'low side sun keeps directional contrast and sky glow clear');
  const sideLit = (sunRotation >= 45 && sunRotation <= 120) || (sunRotation >= 240 && sunRotation <= 315);
  assert.ok(sideLit, `sunRotation ${sunRotation} puts the sun to the side so the silver lining reads as sun-side`);
});
