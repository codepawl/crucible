import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { MATERIAL_PRESET_NAMES } from '../src/material-presets.js';

async function build(recipe) {
  await loadAgentSceneModules(recipe);
  return createAgentScene(recipe);
}

const recipeWith = materials => ({
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box' }],
  materials,
  nodes: materials.map((material, index) => ({ id: `part-${index}`, geometry: 'cube', material: material.id, translation: [index * 2, 0, 0] })),
});

function materialOf(scene, id) {
  return scene.exportRecipe().materials.find(material => material.id === id);
}

test('every preset name is listed in scene_capabilities', async () => {
  assert.deepEqual([...AGENT_SCENE_CAPABILITIES.materialPresets.names], [...MATERIAL_PRESET_NAMES]);
  assert.deepEqual([...MATERIAL_PRESET_NAMES], ['smoothPlastic', 'wood', 'grass', 'neon', 'glass', 'brick']);
});

test('each preset builds, and the part colour is kept as the tint', async () => {
  const tint = [0.9, 0.2, 0.1];
  const materials = MATERIAL_PRESET_NAMES.map(name => ({ id: name, preset: name, color: tint }));
  const scene = await build(recipeWith(materials));
  for (const name of MATERIAL_PRESET_NAMES) {
    assert.deepEqual([...materialOf(scene, name).color], tint, name);
  }
});

test('presets fill the fields their name promises', async () => {
  const scene = await build(recipeWith(MATERIAL_PRESET_NAMES.map(name => ({ id: name, preset: name }))));
  assert.equal(materialOf(scene, 'wood').pattern.type, 'wood');
  assert.equal(materialOf(scene, 'brick').pattern.type, 'bricks');
  assert.equal(materialOf(scene, 'grass').pattern.type, 'metal');
  assert.equal(materialOf(scene, 'smoothPlastic').pattern, undefined);
  assert.ok(materialOf(scene, 'neon').emission > 1);
  const glass = materialOf(scene, 'glass');
  assert.ok(glass.opacity <= 0.5);
  assert.equal(glass.clearcoat, 1);
  assert.ok(glass.roughness <= 0.1);
  assert.equal(glass.alphaMode, 'blend');
});

test('pattern size is in metres, so a small and a large part keep the same grain size', async () => {
  const recipe = recipeWith([{ id: 'wood', preset: 'wood' }]);
  recipe.nodes[0].scale = [4, 4, 4];
  recipe.nodes.push({ id: 'big', geometry: 'cube', material: 'wood', scale: [40, 40, 40] });
  const scene = await build(recipe);
  assert.equal(materialOf(scene, 'wood').pattern.size, 0.8);
});

test('a field set on the material wins over the preset', async () => {
  const scene = await build(recipeWith([{ id: 'wood', preset: 'wood', roughness: 0.2, pattern: { type: 'planks' } }]));
  const wood = materialOf(scene, 'wood');
  assert.equal(wood.roughness, 0.2);
  assert.equal(wood.pattern.type, 'planks');
});

test('presets are deterministic', async () => {
  const buildJson = async () => JSON.stringify((await build(recipeWith(MATERIAL_PRESET_NAMES.map(name => ({ id: name, preset: name, color: [0.4, 0.5, 0.6] }))))).exportRecipe());
  assert.equal(await buildJson(), await buildJson());
});

test('an unknown preset names the valid ones', async () => {
  await assert.rejects(
    build(recipeWith([{ id: 'x', preset: 'plastic' }])),
    error => error.message.includes('smoothPlastic') && error.message.includes('preset'),
  );
});

test('neon glows in a saturated version of the part colour, not white', async () => {
  const scene = await build(recipeWith([{ id: 'neon', preset: 'neon', color: [0.8, 0.1, 0.08] }]));
  const [red, green, blue] = materialOf(scene, 'neon').emissiveColor;
  assert.equal(red, 1);
  assert.ok(green < 0.05 && blue < 0.05, `emissive colour ${[red, green, blue]} must keep the hue of the part`);
});

test('an explicit emissiveColor wins over the neon default', async () => {
  const scene = await build(recipeWith([{ id: 'neon', preset: 'neon', emissiveColor: [0, 1, 0] }]));
  assert.deepEqual([...materialOf(scene, 'neon').emissiveColor], [0, 1, 0]);
});

test('grass and wood patterns carry contrast and direction', async () => {
  const scene = await build(recipeWith([{ id: 'grass', preset: 'grass' }, { id: 'wood', preset: 'wood' }]));
  for (const id of ['grass', 'wood']) {
    const [dark, light] = materialOf(scene, id).pattern.colors;
    assert.ok(light[0] / dark[0] >= 3, `${id} ramp keeps at least 3 to 1 contrast`);
  }
  assert.equal(materialOf(scene, 'grass').pattern.type, 'metal');
});
