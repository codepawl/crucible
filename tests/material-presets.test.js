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
  assert.equal(materialOf(scene, 'grass').pattern.type, 'graph');
  assert.equal(materialOf(scene, 'smoothPlastic').pattern, undefined);
  const glass = materialOf(scene, 'glass');
  assert.ok(glass.opacity <= 0.85);
  assert.ok(!glass.transmission, 'transmission above 0 makes Glaze drop emission (#3279), which the rim needs');
  assert.ok(glass.emission >= 6 && glass.emission <= 8, 'the Fresnel rim is bright (contrast 25 or more on every side) but keeps every channel under 255');
  assert.ok(glass.pattern.graph.emission, 'glass carries a Fresnel edge light');
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

test('wood keeps a contrasty ring ramp', async () => {
  const scene = await build(recipeWith([{ id: 'wood', preset: 'wood' }]));
  const [dark, light] = materialOf(scene, 'wood').pattern.colors;
  assert.ok(light[0] / dark[0] >= 3, 'ring ramp keeps at least 3 to 1 contrast');
});

test('grass is a graph of sparse upright blades with a dark-to-bright ramp and a height output', async () => {
  const scene = await build(recipeWith([{ id: 'grass', preset: 'grass' }]));
  const pattern = materialOf(scene, 'grass').pattern;
  assert.equal(pattern.type, 'graph');
  assert.ok(pattern.graph.height, 'blades have height variation');
  const [darkStop, lightStop] = pattern.graph.color.ramp.stops;
  assert.ok(lightStop[1][0] / darkStop[1][0] >= 3, 'two tones with at least 3 to 1 contrast');
});

test('brick defaults to a deep red', async () => {
  const scene = await build(recipeWith([{ id: 'brick', preset: 'brick' }]));
  const [red, green, blue] = materialOf(scene, 'brick').color;
  assert.ok(red >= 0.5 && green <= 0.2 && blue <= 0.15, 'deep brick red, not peach');
});

test('neon is a plain glowing dielectric tinted by color with no pattern', async () => {
  const scene = await build(recipeWith([{ id: 'default-neon', preset: 'neon' }, { id: 'red-neon', preset: 'neon', color: [1, 0, 0] }]));
  const fallback = materialOf(scene, 'default-neon');
  assert.equal(fallback.tag, 'surface');
  assert.equal(fallback.metallic, 0);
  assert.equal(fallback.roughness, 0.5);
  assert.equal(fallback.emission, 8);
  assert.equal(fallback.pattern, undefined);
  assert.equal(fallback.emissiveColor, undefined);
  assert.deepEqual([...fallback.color], [0.2, 1, 0.9]);
  const red = materialOf(scene, 'red-neon');
  assert.deepEqual([...red.color], [1, 0, 0]);
  assert.equal(red.emission, 8);
  assert.equal(red.pattern, undefined);
});
