import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { decodePack } from '../src/scene-pack-format.js';
import { PACK_MAX_SKY_WIDTH } from '../src/scene-pack-sky.js';
import { textureMapIds } from '../src/agent-texture-set.js';
import { AGENT_ASSET_LIMITS } from '../src/agent-asset-limits.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { createStudioCatalog, NO_STORE_MESSAGE } from '../src/studio-catalog.js';
import { importFile } from '../src/studio-import.js';
import { hdriChoiceLabel } from '../src/studio-properties.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';
import { baseRecipe, createHost, installImageDecoder, installImmediateScheduler, SOFTBOX_URL, tinyPng, triangleGlb } from './support/studio-import-fixtures.mjs';

// The renderer pauses a picture on any part whose map has no UV channel; this is its rule from renderer.js, applied to the real built parts.
function partsTheRendererWouldPause(controller) {
  return controller.scene.parts
    .filter(part => part.material.map && !part.geometry.uvs && !part.geometry.lightUvs && !part.material.boxMapScale)
    .map(part => part.name);
}

function createGeometrySession(host, nodeGeometries) {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'plain-box', type: 'box' },
      { id: 'bevelled-box', type: 'box', bevel: 0.04 },
      { id: 'drum', type: 'cylinder' },
      { id: 'spike', type: 'cone' },
      { id: 'faceted-ball', type: 'icoSphere' },
      { id: 'ball', type: 'sphere' },
      { id: 'sheet', type: 'plane' },
    ],
    materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.2, 0.2], roughness: 0.5, metallic: 0 }],
    nodes: Object.entries(nodeGeometries).map(([id, geometry]) => ({ id, geometry, material: 'paint' })),
  };
  const catalog = createStudioCatalog(host.hooks);
  const controller = createStudioController({ scene: createAgentScene(recipe, {}, { assets: catalog.pool, sequenceFrames: catalog.pool }), assets: catalog.pool });
  return {
    catalog,
    controller,
    importBytes: (name, bytes) => importFile({ name, bytes }, { catalog, controller, prepareRecipe: nextRecipe => catalog.prepare(nextRecipe) }),
    snapshot: () => JSON.stringify({ recipe: controller.exportRecipe(), canUndo: controller.canUndo, pool: catalog.pool.size }),
  };
}

function createImportSession(host) {
  const catalog = createStudioCatalog(host.hooks);
  const controller = createStudioController({ scene: createAgentScene(baseRecipe(), {}, { assets: catalog.pool, sequenceFrames: catalog.pool }), assets: catalog.pool });
  const prepareRecipe = recipe => catalog.prepare(recipe);
  return {
    catalog,
    controller,
    importBytes: (name, bytes) => importFile({ name, bytes }, { catalog, controller, prepareRecipe }),
    snapshot: () => JSON.stringify({ recipe: controller.exportRecipe(), canUndo: controller.canUndo, pool: catalog.pool.size }),
  };
}

async function assertRefused(session, name, bytes, pattern) {
  const before = session.snapshot();
  await assert.rejects(session.importBytes(name, bytes), pattern);
  assert.equal(session.snapshot(), before, `${name}: the refusal changed nothing`);
}

test('a GLB from disk becomes a selected node at the origin, one undo step, and survives save and reopen', async testContext => {
  installImmediateScheduler(testContext);
  const host = createHost();
  const session = createImportSession(host);
  const message = await session.importBytes('Red Rock (1).glb', triangleGlb());
  assert.equal(message, 'Placed Red Rock (1).glb');
  const recipe = session.controller.exportRecipe();
  const placed = recipe.nodes.find(node => node.asset);
  assert.match(placed.asset.id, /^[a-f0-9]{64}$/);
  assert.equal(placed.id, 'red-rock-1');
  assert.deepEqual(placed.translation, [0, 0, 0]);
  assert.equal(session.controller.selectedNodeId, 'red-rock-1');
  assert.ok(session.controller.scene.parts.some(part => part.name.startsWith('red-rock-1')), 'the triangle draws');
  assert.deepEqual(host.storeCalls, [{ kind: 'asset', id: placed.asset.id, name: 'Red Rock (1).glb', extension: 'glb' }]);

  await session.importBytes('red rock 1.glb', triangleGlb());
  assert.equal(session.controller.exportRecipe().nodes.filter(node => node.asset).length, 2, 'the same file twice gives two nodes');
  assert.equal(session.controller.exportRecipe().nodes.at(-1).id, 'red-rock-1-2');
  session.controller.undo();
  assert.equal(session.controller.exportRecipe().nodes.filter(node => node.asset).length, 1, 'one undo removes the second import');
  session.controller.undo();
  assert.equal(session.controller.exportRecipe().nodes.some(node => node.asset), false);
  assert.equal(session.controller.canUndo, false);
  session.controller.redo();
  assert.equal(session.controller.exportRecipe().nodes.filter(node => node.asset).length, 1, 'redo restores it');

  const reopened = createStudioCatalog(host.hooks);
  const saved = session.controller.exportRecipe();
  assert.equal(reopened.needsLoading(saved), true);
  await reopened.prepare(saved);
  assert.equal(reopened.needsLoading(saved), false);
  const reopenedScene = createAgentScene(saved, {}, { assets: reopened.pool });
  assert.ok(reopenedScene.parts.some(part => part.name.startsWith('red-rock-1')), 'the saved scene loads the file again from the host');
});

test('an HDR from disk becomes the sky, shows by its file name and loads again on reopen', async testContext => {
  const host = createHost();
  const session = createImportSession(host);
  const softbox = new Uint8Array(await readFile(SOFTBOX_URL));
  assert.equal(await session.importBytes('Studio Softbox Copy.hdr', softbox), 'Sky set to Studio Softbox Copy.hdr');
  const skyId = session.controller.exportRecipe().environment.hdri;
  assert.match(skyId, /^[a-f0-9]{64}$/);
  assert.equal(hdriChoiceLabel(skyId, session.catalog.names), 'Studio Softbox Copy.hdr');
  assert.equal(hdriChoiceLabel(skyId, {}), `Custom ${skyId.slice(0, 8)}`, 'without a name the short id shows');
  session.controller.undo();
  assert.equal(session.controller.exportRecipe().environment?.hdri, undefined);
  assert.equal(session.controller.canUndo, false);

  const reopened = createStudioCatalog(host.hooks);
  await reopened.prepare({ ...baseRecipe(), environment: { hdri: skyId } });
  assert.equal(reopened.names[skyId], 'Studio Softbox Copy.hdr', 'the name hook gives the name back when the scene reopens');
  const nameless = createStudioCatalog({ ...host.hooks, name: async () => { throw new Error('offline'); } });
  await nameless.prepare({ ...baseRecipe(), environment: { hdri: skyId } });
  assert.equal(nameless.names[skyId], undefined, 'a name that cannot be read leaves the short id and does not fail the load');
});

test('an image from disk becomes the colour map of the selected object, and its texture resolves from the pool', async testContext => {
  installImageDecoder(testContext);
  const host = createHost();
  const session = createImportSession(host);
  session.controller.selectNode('floor');
  assert.equal(await session.importBytes('brick.png', tinyPng()), 'Colour map of grass set from brick.png');
  const grass = session.controller.exportRecipe().materials.find(material => material.id === 'grass');
  const [imageId] = textureMapIds(grass);
  assert.equal(grass.colorMap, imageId);
  assert.deepEqual(grass.color, [1, 1, 1], 'the old tint would stain the picture, so the colour goes to white');
  assert.deepEqual(host.storeCalls, [{ kind: 'image', id: imageId, name: 'brick.png', extension: 'png' }]);
  assert.deepEqual([session.catalog.pool.get(imageId).width, session.catalog.pool.get(imageId).height], [2, 2]);
  const floorPart = session.controller.scene.parts.find(part => part.name.startsWith('floor'));
  assert.ok(floorPart.material.map?.image, 'the material draws the decoded image');
  session.controller.undo();
  assert.equal(session.controller.exportRecipe().materials[0].colorMap, undefined);
  assert.equal(session.controller.canUndo, false);

  const reopened = createStudioCatalog(host.hooks);
  const saved = { ...baseRecipe(), materials: [{ ...baseRecipe().materials[0], colorMap: imageId, color: [1, 1, 1] }, baseRecipe().materials[1]] };
  assert.equal(reopened.needsLoading(saved), true);
  await reopened.prepare(saved);
  assert.equal(reopened.pool.get(imageId).width, 2, 'the image hook gives the file back on reopen');
  await assert.rejects(createStudioCatalog({}).prepare(saved), /catalog image .*catalog: \{ image: async reference => bytes \}/);
});

test('each refusal says what to do and leaves the recipe, undo stack, pool and host untouched', async testContext => {
  installImmediateScheduler(testContext);
  installImageDecoder(testContext);
  const host = createHost();
  const session = createImportSession(host);

  const tooLargeBytes = AGENT_ASSET_LIMITS.maxBytes + 1;
  await assert.rejects(importFile({ name: 'huge.glb', size: tooLargeBytes, arrayBuffer: async () => assert.fail('a file over the limit is not read') }, { ...session, prepareRecipe: async () => {} }), /huge\.glb is 64\.0 MiB; Studio imports files up to 64 MiB of this type\. Simplify it first/);
  await assert.rejects(importFile({ name: 'big.hdr', size: 9 * 1024 * 1024, arrayBuffer: async () => assert.fail('a file over the limit is not read') }, { ...session, prepareRecipe: async () => {} }), /big\.hdr is 9\.0 MiB.*up to 8 MiB.*Use a 2k or smaller HDRI/);

  await assertRefused(session, 'draco.glb', triangleGlb({ extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'] }), /draco\.glb uses Draco mesh compression.*Export it again without that compression.*MCP asset catalog, which converts it/);
  await assertRefused(session, 'ktx.glb', triangleGlb({ extensionsUsed: ['KHR_texture_basisu'], extensionsRequired: ['KHR_texture_basisu'] }), /ktx\.glb uses KTX2 texture compression.*Export it again without that compression/);
  await assertRefused(session, 'split.glb', triangleGlb({ buffers: [{ byteLength: 36, uri: 'split.bin' }] }, { embedBuffer: false }), /split\.glb points at files outside itself\. Export one self-contained \.glb/);
  await assertRefused(session, 'scene.gltf', new TextEncoder().encode('{"asset":{"version":"2.0"}}'), /scene\.gltf looks like a glTF JSON file.*Export one self-contained \.glb/);
  await assertRefused(session, 'notes.txt', new TextEncoder().encode('hello'), /notes\.txt is not a file Studio can import\. Import a \.glb model, a Radiance \.hdr sky, or a \.png, \.jpg or \.webp image/);
  assert.equal(await session.importBytes('renamed.png', triangleGlb()), 'Placed renamed.png', 'the kind comes from the bytes, so a GLB named .png is still a GLB');
  session.controller.undo();
  const storedBefore = host.storeCalls.length;

  session.controller.selectNode(null);
  await assertRefused(session, 'brick.png', tinyPng(), /Select the object that should wear brick\.png first/);
  session.controller.selectNode('wall');
  await assertRefused(session, 'brick.png', tinyPng(), /material of wall is made from a procedural pattern.*Select an object with a plain material/);
  session.controller.selectNode('floor');
  await assertRefused(session, 'wide.png', tinyPng(4096, 16), /wide\.png is 4096x16; frames are at most 2048 pixels on a side\. Resize it/);
  await assertRefused(session, 'no-header.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), /not a file Studio can import/);
  assert.equal(host.storeCalls.length, storedBefore, 'no refused file reached the host');
});

test('a rejection of the host store reaches the person as written and changes nothing', async testContext => {
  installImmediateScheduler(testContext);
  const host = createHost({ rejectStoreWith: 'Save the scene first, then import again.' });
  const session = createImportSession(host);
  const before = session.snapshot();
  await assert.rejects(session.importBytes('rock.glb', triangleGlb()), error => error.message === 'Save the scene first, then import again.');
  assert.equal(session.snapshot(), before);
  assert.deepEqual(session.catalog.names, {});
});

test('a picture goes on a geometry that carries UVs and the built scene has nothing the renderer would pause', async testContext => {
  installImageDecoder(testContext);
  const host = createHost();
  const session = createGeometrySession(host, { ball: 'ball', sheet: 'sheet' });
  session.controller.selectNode('sheet');
  await session.importBytes('brick.png', tinyPng());
  assert.equal(session.controller.scene.parts.every(part => part.material.map), true, 'both objects wear the picture');
  assert.deepEqual(partsTheRendererWouldPause(session.controller), []);
});

test('a picture goes on a box, a bevelled box, a cylinder and a cone, which get their UVs with the map', async testContext => {
  installImageDecoder(testContext);
  for (const [geometry, nodeId] of [['plain-box', 'crate'], ['bevelled-box', 'trim'], ['drum', 'barrel'], ['spike', 'cap']]) {
    const session = createGeometrySession(createHost(), { [nodeId]: geometry });
    session.controller.selectNode(nodeId);
    await session.importBytes('brick.png', tinyPng());
    const [part] = session.controller.scene.parts;
    assert.ok(part.material.map, `${geometry}: the picture is on`);
    assert.equal(part.geometry.uvs.length, part.geometry.positions.length / 3 * 2, `${geometry}: the built part carries UVs`);
    assert.deepEqual(partsTheRendererWouldPause(session.controller), [], geometry);
  }
});

test('a picture is refused on an icosphere and a material shared with one, naming the object and changing nothing', async testContext => {
  installImageDecoder(testContext);
  const host = createHost();
  const single = createGeometrySession(host, { gem: 'faceted-ball' });
  single.controller.selectNode('gem');
  await assertRefused(single, 'brick.png', tinyPng(), /brick.png cannot go on this material: gem has no UV coordinates.*Only sphere, box, cylinder, cone, torus, plane, grid and unwrapped mesh objects take an image.*give that object its own material first./);
  assert.deepEqual(host.storeCalls, [], 'nothing reached the host');
  assert.deepEqual(partsTheRendererWouldPause(single.controller), []);

  const sharedHost = createHost();
  const session = createGeometrySession(sharedHost, { ball: 'ball', gem: 'faceted-ball', crate: 'plain-box' });
  session.controller.selectNode('ball');
  await assertRefused(session, 'brick.png', tinyPng(), /brick.png cannot go on this material: gem has no UV coordinates/);
  assert.deepEqual(sharedHost.storeCalls, []);
  assert.equal(session.catalog.pool.size, 0);
});

test('a box built with a colour map has UVs and an icosphere does not, which is the gap the guard still closes', async testContext => {
  installImageDecoder(testContext);
  const session = createGeometrySession(createHost(), { crate: 'plain-box', gem: 'faceted-ball' });
  const withMap = { ...session.controller.exportRecipe().materials[0], colorMap: 'f'.repeat(64) };
  session.catalog.pool.set(withMap.colorMap, { width: 2, height: 2, data: new Uint8Array(16).fill(255) });
  const recipe = { ...session.controller.exportRecipe(), materials: [withMap] };
  const built = createAgentScene(recipe, {}, { assets: session.catalog.pool, sequenceFrames: session.catalog.pool });
  assert.deepEqual(built.parts.filter(part => part.material.map && !part.geometry.uvs).map(part => part.name), ['gem']);
});

test('the status line keeps an import message up in proportion to its length, between 3.4 and 12 seconds', async testContext => {
  installImmediateScheduler(testContext);
  const dom = installStudioDom();
  const container = dom.document.createElement('div');
  dom.document.body.append(container);
  const studio = createStudio(container, { recipe: baseRecipe(), renderer: createFakeRenderer(), catalog: createHost().hooks });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = container.firstElementChild;
  const statusText = () => root.querySelector('.crucible-studio-status').textContent;
  const viewport = root.querySelector('.crucible-studio-viewport');
  const dropAndRead = async (name, bytes) => {
    dom.runTimers();
    dispatch(viewport, 'drop', { dataTransfer: { files: [{ name, size: bytes.length, arrayBuffer: async () => bytes.buffer }] } });
    await dom.settleUntil(() => statusText() !== '');
    return { text: statusText(), delays: [dom.pendingTimerDelays.at(-1)] };
  };
  const short = await dropAndRead('rock.glb', triangleGlb());
  assert.equal(short.text, 'Placed rock.glb');
  assert.deepEqual(short.delays, [3400], 'a short message keeps the usual time');
  const long = await dropAndRead('notes.txt', new TextEncoder().encode('hello'));
  assert.ok(long.text.length > 100, 'the refusal is a long sentence');
  assert.deepEqual(long.delays, [Math.min(12000, long.text.length * 60)]);
  assert.ok(long.delays[0] > 3400 && long.delays[0] <= 12000);
});

test('an imported HDR sky travels into the web pack as its sky image, and the pack does not report it as left out', async testContext => {
  installImmediateScheduler(testContext);
  const dom = installStudioDom();
  const container = dom.document.createElement('div');
  dom.document.body.append(container);
  const studio = createStudio(container, { recipe: baseRecipe(), renderer: createFakeRenderer(), catalog: createHost().hooks });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = container.firstElementChild;
  const withoutSky = decodePack((await studio.buildWebPackPayload()).packBytes);
  const softbox = new Uint8Array(await readFile(SOFTBOX_URL));
  dispatch(root.querySelector('.crucible-studio-viewport'), 'drop', { dataTransfer: { files: [{ name: 'softbox.hdr', size: softbox.length, arrayBuffer: async () => softbox.buffer }] } });
  await dom.settleUntil(() => root.querySelector('.crucible-studio-status').textContent !== '');
  assert.equal(root.querySelector('.crucible-studio-status').textContent, 'Sky set to softbox.hdr');
  const payload = await studio.buildWebPackPayload();
  const withSky = decodePack(payload.packBytes);
  assert.equal(withoutSky.environmentMap, undefined, 'the scene without the sky carries no sky image');
  assert.equal(withoutSky.environment.hdri, undefined);
  assert.equal(typeof withSky.environment.hdri, 'string', 'the packed environment names the imported sky');
  assert.equal(withSky.environmentMap.kind, 'environment-map', 'the pack carries the decoded sky image (#3004)');
  assert.ok(withSky.environmentMap.width > 0 && withSky.environmentMap.width <= PACK_MAX_SKY_WIDTH, 'the sky fits the width one pack carries');
  assert.equal(withSky.environmentMap.data.length, withSky.environmentMap.width * withSky.environmentMap.height * withSky.environmentMap.channels);
  assert.deepEqual(payload.stripped, [], 'the sky is not in the list of what the pack left out');
});

test('without a store hook an import is refused with one sentence and the pool is untouched', async () => {
  const session = createImportSession(createHost({ withStore: false }));
  assert.equal(session.catalog.canStore, false);
  await assertRefused(session, 'rock.glb', triangleGlb(), error => error.message === NO_STORE_MESSAGE);
});

test('the Import row shows only with a store, and a dropped GLB or scene.json takes its own path', async testContext => {
  installImmediateScheduler(testContext);
  const dom = installStudioDom();
  const studios = [];
  const mountStudio = options => {
    const container = dom.document.createElement('div');
    dom.document.body.append(container);
    const created = createStudio(container, { recipe: baseRecipe(), renderer: createFakeRenderer(), ...options });
    studios.push(created);
    return { studio: created, root: container.firstElementChild };
  };
  testContext.after(() => {
    studios.forEach(created => created.dispose());
    dom.uninstall();
  });
  const host = createHost();
  const { studio, root } = mountStudio({ catalog: host.hooks });
  const rowTexts = () => root.querySelectorAll('button').map(button => button.textContent);
  const statusText = () => root.querySelector('.crucible-studio-status').textContent;
  assert.ok(rowTexts().includes('Import…'));
  assert.match(root.querySelector('.crucible-studio-drop-overlay').textContent, /GLB, HDR or image/);

  const viewport = root.querySelector('.crucible-studio-viewport');
  const glb = triangleGlb();
  dispatch(viewport, 'drop', { dataTransfer: { files: [{ name: 'rock.glb', size: glb.length, arrayBuffer: async () => glb.buffer, text: async () => assert.fail('a binary file is never read as text') }] } });
  await dom.settleUntil(() => statusText() !== '');
  assert.equal(statusText(), 'Placed rock.glb');
  assert.equal(studio.exportRecipe().nodes.filter(node => node.asset).length, 1);
  assert.equal(studio.controller.selectedNodeId, 'rock');

  const payload = await studio.buildWebPackPayload();
  const withoutImport = await mountStudio({}).studio.buildWebPackPayload();
  assert.ok(payload.packBytes.byteLength > withoutImport.packBytes.byteLength, 'the pack carries the decoded triangle of the imported model');
  assert.deepEqual(payload.stripped, [], 'the import adds nothing the pack leaves out');

  dom.runTimers();
  dispatch(viewport, 'drop', { dataTransfer: { files: [{ name: 'again.scene.json', text: async () => JSON.stringify(baseRecipe()) }] } });
  await dom.settleUntil(() => statusText() !== '');
  assert.equal(statusText(), 'Loaded again.scene.json');

  const { root: plainRoot } = mountStudio({ catalog: { ...host.hooks, store: undefined } });
  assert.equal(plainRoot.querySelectorAll('button').some(button => button.textContent === 'Import…'), false);
  assert.match(plainRoot.querySelector('.crucible-studio-drop-overlay').textContent, /^Drop a scene\.json to open it$/);
  dispatch(plainRoot.querySelector('.crucible-studio-viewport'), 'drop', { dataTransfer: { files: [{ name: 'rock.glb', size: glb.length, arrayBuffer: async () => glb.buffer }] } });
  await dom.settleUntil(() => plainRoot.querySelector('.crucible-studio-status').textContent !== '');
  assert.equal(plainRoot.querySelector('.crucible-studio-status').textContent, NO_STORE_MESSAGE);
});
