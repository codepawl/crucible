import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePack } from '../src/scene-pack-format.js';
import { compileRecipeToPack } from '../src/scene-pack.js';
import { createStudio } from '../src/studio.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';
import { baseRecipe, createHost, installImageDecoder, installImmediateScheduler, tinyPng, triangleGlb } from './support/studio-import-fixtures.mjs';

const ROCK_COLOR = [0.8, 0.25, 0.1, 1];

// One fake browser per test: the studios of a test share it, and they are disposed before it goes away.
function installTestDom(testContext) {
  const dom = installStudioDom();
  const studios = [];
  testContext.after(() => {
    studios.forEach(studio => studio.dispose());
    dom.uninstall();
  });
  return { dom, studios };
}

function mountStudio(testDom, options) {
  const { dom, studios } = testDom;
  const container = dom.document.createElement('div');
  dom.document.body.append(container);
  const studio = createStudio(container, { renderer: createFakeRenderer(), ...options });
  studios.push(studio);
  return { studio, dom, testDom, root: container.firstElementChild };
}

async function dropFile(mounted, name, bytes) {
  const statusElement = mounted.root.querySelector('.crucible-studio-status');
  mounted.dom.runTimers();
  dispatch(mounted.root.querySelector('.crucible-studio-viewport'), 'drop', { dataTransfer: { files: [{ name, size: bytes.length, arrayBuffer: async () => bytes.buffer }] } });
  await mounted.dom.settleUntil(() => statusElement.textContent !== '');
  return statusElement.textContent;
}

function sceneListLabels(root) {
  return root.querySelectorAll('.crucible-studio-tree-row').map(row => row.textContent);
}

function packedPartNamed(packBytes, namePrefix) {
  return decodePack(packBytes).parts.find(part => part.name.startsWith(namePrefix));
}

function bytesOf(typedArray) {
  return Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
}

function triangleCount(geometry) {
  return (geometry.indices ? geometry.indices.length : geometry.positions.length / 3) / 3;
}

function assertSamePart(packedPart, livePart, message) {
  assert.equal(packedPart.geometry.positions.length, livePart.geometry.positions.length, `${message}: vertex count`);
  assert.equal(triangleCount(packedPart.geometry), triangleCount(livePart.geometry), `${message}: triangle count`);
  assert.deepEqual(bytesOf(packedPart.geometry.positions), bytesOf(livePart.geometry.positions), `${message}: positions byte for byte`);
}

test('a dropped GLB shows in the viewport and the Scene list, and the web pack carries its geometry and colour', async testContext => {
  installImmediateScheduler(testContext);
  const mounted = mountStudio(installTestDom(testContext), { recipe: baseRecipe(), catalog: createHost().hooks });
  assert.equal(await dropFile(mounted, 'rock.glb', triangleGlb({}, { baseColor: ROCK_COLOR })), 'Placed rock.glb');

  const livePart = mounted.studio.scene.parts.find(part => part.name.startsWith('rock'));
  assert.ok(livePart, 'the triangle draws in the viewport');
  assert.ok(sceneListLabels(mounted.root).includes('rock'), `the Scene list names the node: ${sceneListLabels(mounted.root).join(', ')}`);

  const payload = await mounted.studio.buildWebPackPayload();
  assert.deepEqual(payload.stripped, []);
  const packedPart = packedPartNamed(payload.packBytes, 'rock');
  assert.ok(packedPart, 'the pack holds the imported node');
  assertSamePart(packedPart, livePart, 'pack against viewport');
  assert.equal(packedPart.geometry.positions.length / 3, 3);
  assert.deepEqual([...packedPart.geometry.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual([...packedPart.material.color], [...livePart.material.color], 'the pack keeps the colour the viewport draws');
  assert.ok(Math.abs(packedPart.material.color[0] - ROCK_COLOR[0]) < 0.01, 'the pack keeps the imported base colour');
});

test('a saved scene with an imported GLB reopens, lists the node and packs to the same bytes', async testContext => {
  installImmediateScheduler(testContext);
  const host = createHost();
  const first = mountStudio(installTestDom(testContext), { recipe: baseRecipe(), catalog: host.hooks });
  await dropFile(first, 'rock.glb', triangleGlb({}, { baseColor: ROCK_COLOR }));
  const saved = JSON.parse(JSON.stringify(first.studio.exportRecipe()));
  const firstPack = (await first.studio.buildWebPackPayload()).packBytes;

  const reopened = mountStudio(first.testDom, { recipe: saved, catalog: host.hooks });
  await reopened.studio.ready;
  const reopenedPart = reopened.studio.scene.parts.find(part => part.name.startsWith('rock'));
  assert.ok(reopenedPart, 'the reopened scene draws the file again');
  assert.ok(sceneListLabels(reopened.root).includes('rock'), 'the reopened Scene list names the node');
  const reopenedPayload = await reopened.studio.buildWebPackPayload();
  assert.deepEqual(reopenedPayload.stripped, []);
  assert.deepEqual(Buffer.from(reopenedPayload.packBytes), Buffer.from(firstPack), 'the same scene packs to the same bytes after save and reopen');
  assertSamePart(packedPartNamed(reopenedPayload.packBytes, 'rock'), reopenedPart, 'reopened pack against viewport');
});

test('an imported image on a material goes into the web pack as plain pixels and the pack does not report it as left out', async testContext => {
  installImmediateScheduler(testContext);
  installImageDecoder(testContext);
  const mounted = mountStudio(installTestDom(testContext), { recipe: baseRecipe(), catalog: createHost().hooks });
  mounted.studio.controller.selectNode('floor');
  assert.equal(await dropFile(mounted, 'brick.png', tinyPng()), 'Colour map of grass set from brick.png');
  const payload = await mounted.studio.buildWebPackPayload();
  assert.deepEqual(payload.stripped, []);
  const floor = packedPartNamed(payload.packBytes, 'floor');
  assert.deepEqual([floor.material.map.image.width, floor.material.map.image.height], [2, 2]);
  assert.equal(floor.material.map.image.data.length, 2 * 2 * 4, 'the pack holds the decoded pixels, not a reference to the catalog');
});

test('the command line pack refuses a material that holds a catalog image and says to export the web pack from Studio', async () => {
  const recipe = baseRecipe();
  recipe.materials[0].colorMap = 'f'.repeat(64);
  await assert.rejects(
    compileRecipeToPack(recipe),
    error => error.message === 'recipe.materials["grass"].colorMap: crucible pack cannot read the asset catalog that holds this image. Export the web pack from Studio, which has the catalog, or remove the colorMap.',
  );
});
