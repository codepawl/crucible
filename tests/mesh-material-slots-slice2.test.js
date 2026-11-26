import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { meshEditSourceOf } from '../src/agent-mesh.js';
import { exportGlb } from '../src/export.js';
import { parseGltf } from '../src/gltf.js';
import { MAX_MATERIAL_SLOTS } from '../src/mesh-operations.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { buildTraceScene, isInstancedScene, resolveTexture } from '../src/path-tracer-scene.js';
import { uploadScene } from '../src/path-tracer-webgpu.js';
import * as gpuPack from '../src/path-tracer-gpu-pack.js';
import { exportNativeSceneTables } from '../scripts/native-bake-page.js';
import { createStudio, createStudioController } from '../src/studio.js';
import { createMeshEditor } from '../src/studio-mesh-edit.js';
import { createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';
import { FOLDED_APPLY_OPERATION_NOTES, FOLDED_APPLY_OPERATION_TYPES } from '../src/apply-operation-notes.js';

globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8 };

const CAMERA = { eye: [0, 1.5, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 };

function redBlueRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [
      { id: 'red', color: [1, 0, 0] },
      { id: 'blue', color: [0, 0, 1] },
      { id: 'gold', color: [1, 0.8, 0.1] },
    ],
    geometries: [
      { id: 'boxMesh', type: 'mesh', base: { type: 'box', bevel: 0 } },
    ],
    nodes: [
      { id: 'leftBox', geometry: 'boxMesh', material: 'red', translation: [-1.2, 0, 0] },
      { id: 'rightBox', geometry: 'boxMesh', material: 'blue', translation: [1.2, 0, 0] },
    ],
    camera: CAMERA,
    environment: { keyColor: [1, 1, 1], keyIntensity: 2, lightDirection: [0.2, 0.8, 0.6] },
  };
}

function recordingDevice() {
  const written = new Map();
  return {
    written,
    limits: { maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: ({ label }) => ({ label }),
    pushErrorScope() {},
    popErrorScope: async () => null,
    queue: {
      writeBuffer: (buffer, _offset, bytes) => {
        written.set(buffer.label, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
      },
    },
  };
}

function pixelColor(rgba, width, pixelX, pixelY) {
  const offset = (pixelY * width + pixelX) * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
}

test('joining red and blue objects preserves both materials across raster, CPU path tracer, WebGPU tables, native export, and glTF round-trip', async () => {
  const scene = createAgentScene(redBlueRecipe());
  scene.apply([{ type: 'join-meshes', node: 'leftBox', nodes: ['rightBox'] }], { expectedRevision: scene.revision });

  const rasterParts = scene.parts.filter(part => part.name === 'leftBox');
  assert.equal(rasterParts.length, 2);
  assert.deepEqual(rasterParts.map(part => Array.from(part.material.color)), [[1, 0, 0], [0, 0, 1]]);
  assert.deepEqual(rasterParts.map(part => part.geometry.indices.length / 3), [12, 12]);

  // CPU path tracer draws left side red and right side blue.
  const width = 32;
  const height = 24;
  const traced = await renderPathTracedImage(
    { parts: scene.parts, environment: { keyColor: [1, 1, 1], keyIntensity: 2, lightDirection: [0.1, 0.6, 1] }, camera: CAMERA },
    { width, height, samples: 4, threads: 1, denoiser: 'none' },
  );
  const leftSample = pixelColor(traced.rgba, width, 10, 12);
  const rightSample = pixelColor(traced.rgba, width, 21, 12);
  assert.ok(leftSample[0] > leftSample[2] + 60, `expected left box red in CPU trace, got ${leftSample}`);
  assert.ok(rightSample[2] > rightSample[0] + 60, `expected right box blue in CPU trace, got ${rightSample}`);

  // WebGPU scene upload & instanced trace preserve both slot materials.
  const device = recordingDevice();
  const flatTraceScene = buildTraceScene(scene.parts, scene.environment);
  const uploaded = uploadScene(device, flatTraceScene);
  await uploaded.allocationCheck;
  assert.equal(flatTraceScene.materials.length, 2);
  assert.deepEqual(Array.from(flatTraceScene.materials[0].color), [1, 0, 0]);
  assert.deepEqual(Array.from(flatTraceScene.materials[1].color), [0, 0, 1]);

  // Native scene export (with two instances of the joined slotted mesh) preserves un-offset indices and per-slot materials.
  const exportedRecipe = scene.exportRecipe();
  exportedRecipe.nodes.push({ id: 'copyBox', geometry: exportedRecipe.nodes[0].geometry, material: 'red', translation: [0, 3, 0] });
  const twoNodeScene = createAgentScene(exportedRecipe);
  const instancedTrace = buildTraceScene(twoNodeScene.parts, twoNodeScene.environment, { instancing: true });
  assert.equal(isInstancedScene(instancedTrace), true);
  assert.equal(instancedTrace.instances.length, 4);
  assert.ok(instancedTrace.instances.every(instance => instance.geometry.indices.byteOffset === 0));

  const capturedNativeInputs = [];
  const nativeExport = exportNativeSceneTables({
    parts: twoNodeScene.parts,
    environment: twoNodeScene.environment,
    camera: { eye: CAMERA.eye, target: CAMERA.target, up: CAMERA.up, fov: CAMERA.fov, near: 0.1, far: 100 },
    options: { width: 32, height: 24, samples: 4, bounces: 2 },
    kernel: 'cycles',
    instancing: true,
    modules: {
      buildTraceScene,
      resolveTexture,
      pack: gpuPack,
      buildNativeInput: () => { throw new Error('unexpected v1 fallback'); },
      buildFlattenedJobNativeInput: () => { throw new Error('unexpected flattened fallback'); },
      buildJobNativeInput: (traceScene) => {
        capturedNativeInputs.push(traceScene);
        return {
          triangleCount: 48,
          instanceCount: traceScene.instances.length,
          tables: { header: new Uint32Array([1]) },
        };
      },
    },
  });
  assert.equal(nativeExport.wholeMaterials, true);
  assert.equal(capturedNativeInputs.length, 1);
  assert.deepEqual(capturedNativeInputs[0].materials.map(material => Array.from(material.color)), [[1, 0, 0], [0, 0, 1], [1, 0, 0], [0, 0, 1]]);

  // glTF round-trip preserves both materials.
  const glb = exportGlb(scene.parts);
  const parsed = await parseGltf(glb);
  assert.equal(parsed.parts.length, 2);
  const parsedColors = parsed.parts.map(part => Array.from(part.material.color).map(channel => Math.round(channel)).join());
  assert.deepEqual(parsedColors.sort(), ['0,0,1', '1,0,0']);
});

test('local mesh volumes work on slotted meshes without failing open-edge checks', () => {
  const recipe = redBlueRecipe();
  const scene = createAgentScene(recipe);
  scene.apply([{ type: 'join-meshes', node: 'leftBox', nodes: ['rightBox'] }], { expectedRevision: scene.revision });
  const traced = buildTraceScene(scene.parts, {
    localVolumes: [{ shape: 'mesh', part: 'leftBox', fit: 'bounds', density: 0.2 }],
  });
  assert.equal(traced.localVolumes.length, 1);
});

test('joining meshes that already carry overlapping slot lists deduplicates and remaps slots cleanly', () => {
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [
      { id: 'red', color: [1, 0, 0] },
      { id: 'blue', color: [0, 0, 1] },
      { id: 'gold', color: [1, 0.8, 0.1] },
    ],
    geometries: [
      { id: 'first', type: 'mesh', base: { type: 'box', bevel: 0 }, slots: ['red', 'blue'], edits: [{ op: 'material_slot', select: { tag: 'top' }, slot: 1 }] },
      { id: 'second', type: 'mesh', base: { type: 'box', bevel: 0 }, slots: ['gold', 'red'], edits: [{ op: 'material_slot', select: { tag: 'top' }, slot: 1 }] },
    ],
    nodes: [
      { id: 'firstNode', geometry: 'first', material: 'red', translation: [-2, 0, 0] },
      { id: 'secondNode', geometry: 'second', material: 'gold', translation: [2, 0, 0] },
    ],
  };
  const scene = createAgentScene(recipe);
  scene.apply([{ type: 'join-meshes', node: 'firstNode', nodes: ['secondNode'] }], { expectedRevision: scene.revision });
  const exported = scene.exportRecipe();
  const mergedGeometry = exported.geometries.find(geometry => geometry.id === exported.nodes[0].geometry);
  assert.deepEqual(mergedGeometry.slots, ['red', 'blue', 'gold']);
  const parts = scene.parts.filter(part => part.name === 'firstNode');
  assert.deepEqual(parts.map(part => part.geometry.indices.length / 3), [12, 2, 10]);
});

test('scene_apply assign-face-material assigns by slot index or material ID and validates boundaries', () => {
  assert.ok(FOLDED_APPLY_OPERATION_TYPES.includes('assign-face-material'));
  assert.match(FOLDED_APPLY_OPERATION_NOTES['assign-face-material'], /slot\? \| material\?/);

  const recipe = redBlueRecipe();
  recipe.nodes.push({ id: 'sharedUser', geometry: 'boxMesh', material: 'red', translation: [0, 3, 0] });
  const scene = createAgentScene(recipe);

  // Assign face 0 of leftBox to "blue" (creates a copy of shared geometry and adds slots ['red', 'blue']).
  scene.apply([{ type: 'assign-face-material', node: 'leftBox', faces: [0], material: 'blue' }], { expectedRevision: scene.revision });
  const leftParts = scene.parts.filter(part => part.name === 'leftBox');
  assert.equal(leftParts.length, 2);
  assert.deepEqual(leftParts.map(part => part.geometry.indices.length / 3), [10, 2]);
  assert.equal(scene.parts.filter(part => part.name === 'sharedUser').length, 1, 'shared geometry on unselected node stays untouched');

  // Assign face 1 to "gold" (adds slot 2) and face 2 back to slot 0 by index.
  scene.apply([{ type: 'assign-face-material', node: 'leftBox', faces: [1], material: 'gold' }], { expectedRevision: scene.revision });
  scene.apply([{ type: 'assign-face-material', node: 'leftBox', faces: [1], slot: 0 }], { expectedRevision: scene.revision });
  assert.deepEqual(scene.parts.filter(part => part.name === 'leftBox').map(part => part.geometry.indices.length / 3), [10, 2]);

  // Validation errors name the bad field and what to pass.
  const bad = (operation, pattern) => assert.throws(() => scene.apply([operation], { expectedRevision: scene.revision }), pattern);
  bad({ type: 'assign-face-material', node: 'missing', faces: [0], material: 'blue' }, /existing node/);
  bad({ type: 'assign-face-material', node: 'leftBox', faces: [], material: 'blue' }, /nonempty array/);
  bad({ type: 'assign-face-material', node: 'leftBox', faces: [99], material: 'blue' }, /whole face numbers from 0 to 5/);
  bad({ type: 'assign-face-material', node: 'leftBox', faces: [0, 0], material: 'blue' }, /each face number once/);
  bad({ type: 'assign-face-material', node: 'leftBox', faces: [0] }, /either slot.*or material/);
  bad({ type: 'assign-face-material', node: 'leftBox', faces: [0], slot: 0, material: 'blue' }, /not both/);
  bad({ type: 'assign-face-material', node: 'leftBox', faces: [0], slot: 9 }, /whole number from 0 to 2/);
  bad({ type: 'assign-face-material', node: 'leftBox', faces: [0], material: 'emerald' }, /ID of a material in materials/);

  // Slot limit of 16 enforced cleanly.
  const manyMaterials = Array.from({ length: MAX_MATERIAL_SLOTS + 1 }, (_, index) => ({ id: `mat${index}`, color: [0.5, 0.5, 0.5] }));
  const fullScene = createAgentScene({
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: manyMaterials,
    geometries: [{ id: 'box', type: 'mesh', base: { type: 'box', bevel: 0 }, slots: manyMaterials.slice(0, MAX_MATERIAL_SLOTS).map(material => material.id) }],
    nodes: [{ id: 'box', geometry: 'box', material: 'mat0' }],
  });
  assert.throws(
    () => fullScene.apply([{ type: 'assign-face-material', node: 'box', faces: [0], material: `mat${MAX_MATERIAL_SLOTS}` }], { expectedRevision: fullScene.revision }),
    /at most 16 slots/,
  );
});

test('Studio Ctrl+J joins red and blue objects (including primitives) into one slotted mesh in 1 undo/redo step', async testContext => {
  const dom = installStudioDom();
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'red', color: [1, 0, 0] }, { id: 'blue', color: [0, 0, 1] }],
    geometries: [
      { id: 'boxMesh', type: 'mesh', base: { type: 'box', bevel: 0 } },
      { id: 'sphereShape', type: 'sphere' },
    ],
    nodes: [
      { id: 'redBox', geometry: 'boxMesh', material: 'red', translation: [-1.5, 0, 0] },
      { id: 'blueSphere', geometry: 'sphereShape', material: 'blue', translation: [1.5, 0, 0] },
    ],
    camera: CAMERA,
  };
  const studio = createStudio(dom.container, { recipe, renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  studio.renderNow();

  const { controller } = studio;
  controller.selectNodes(['blueSphere', 'redBox'], { active: 'redBox' });
  const before = controller.exportRecipe();
  const keyEvent = dispatch(dom.document, 'keydown', { key: 'j', ctrlKey: true });
  assert.equal(keyEvent.defaultPrevented, true);
  for (let attempt = 0; attempt < 200 && controller.exportRecipe().nodes.length !== 1; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }

  const joined = controller.exportRecipe();
  assert.deepEqual(joined.nodes.map(node => node.id), ['redBox']);
  const joinedGeometry = joined.geometries.find(geometry => geometry.id === joined.nodes[0].geometry);
  assert.deepEqual(joinedGeometry.slots, ['red', 'blue']);
  assert.equal(controller.scene.parts.filter(part => part.name === 'redBox').length, 2);

  // 1 undo restores both original nodes and their geometries cleanly.
  assert.equal(controller.undo(), true);
  assert.deepEqual(controller.exportRecipe().nodes.map(node => node.id), before.nodes.map(node => node.id));
  assert.equal(controller.scene.parts.length, 2);

  // 1 redo restores the joined slotted mesh cleanly.
  assert.equal(controller.redo(), true);
  assert.deepEqual(controller.exportRecipe().nodes.map(node => node.id), ['redBox']);
  assert.equal(controller.scene.parts.filter(part => part.name === 'redBox').length, 2);
});

test('Studio edit mode works on slotted meshes and assigns face materials via panel and swatch in 1 undo step', async testContext => {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { recipe: redBlueRecipe(), renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  studio.renderNow();
  const { controller } = studio;

  // Join red and blue first, then enter edit mode on the slotted mesh.
  const byAriaLabel = (tag, label) => dom.container.querySelectorAll(tag).find(element => element.getAttribute('aria-label') === label);
  controller.applyImportOperations([{ type: 'join-meshes', node: 'leftBox', nodes: ['rightBox'] }], { selectNodeId: 'leftBox', detail: { kind: 'topology', nodeId: 'leftBox' } });
  dispatch(dom.document, 'keydown', { key: 'Tab' });
  const faceSelect = byAriaLabel('select', 'Face material');
  const panel = faceSelect.parentNode;
  for (let attempt = 0; attempt < 200 && panel.hidden; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(panel.hidden, false, 'face material panel appears in edit mode');
  const slotButtons = panel.querySelectorAll('button');
  assert.equal(slotButtons.length, 2);

  // Pick face 0 via studio canvas click, then assign gold via Face material <select> and blue via Scene palette swatch.
  const part = controller.scene.parts.find(candidate => candidate.name === 'leftBox');
  assert.ok(meshEditSourceOf(part.geometry), 'slotted part resolves its edit source');
  const mesh = meshEditSourceOf(part.geometry).mesh;
  const faceZeroCorners = [];
  for (let index = mesh.faceOffsets[0]; index < mesh.faceOffsets[1]; index += 1) faceZeroCorners.push(mesh.cornerVertices[index]);
  const centre = [0, 1, 2].map(axis => faceZeroCorners.reduce((sum, vertex) => sum + mesh.positions[vertex * 3 + axis], 0) / faceZeroCorners.length);
  const worldCentre = [0, 1, 2].map(axis => part.matrix[axis] * centre[0] + part.matrix[4 + axis] * centre[1] + part.matrix[8 + axis] * centre[2] + part.matrix[12 + axis]);
  const facePixel = controller.projectWorldPoint(worldCentre);
  const canvas = dom.container.querySelector('canvas');
  dispatch(canvas, 'pointerdown', { button: 0, clientX: facePixel.x, clientY: facePixel.y });
  dispatch(canvas, 'pointerup', { button: 0, clientX: facePixel.x, clientY: facePixel.y });
  assert.equal(faceSelect.disabled, false, 'Face material select enables once a face is picked');

  faceSelect.value = 'gold';
  dispatch(faceSelect, 'change');
  assert.equal(controller.scene.parts.filter(candidate => candidate.name === 'leftBox').length, 3);
  assert.equal(panel.querySelectorAll('button').length, 3, 'a slot chip is added for gold');

  // 1 undo restores 2 slots; 1 redo restores 3 slots.
  assert.equal(controller.undo(), true);
  assert.equal(controller.scene.parts.filter(candidate => candidate.name === 'leftBox').length, 2);
  assert.equal(controller.redo(), true);
  assert.equal(controller.scene.parts.filter(candidate => candidate.name === 'leftBox').length, 3);

  // Clicking a Scene palette swatch in edit mode assigns that material to the picked face (1 undo step).
  const blueSwatch = byAriaLabel('button', 'Material blue');
  dispatch(blueSwatch, 'click');
  assert.equal(controller.scene.parts.filter(candidate => candidate.name === 'leftBox').length, 2);
  assert.equal(controller.undo(), true);
  assert.equal(controller.scene.parts.filter(candidate => candidate.name === 'leftBox').length, 3);

  // Exit Studio edit mode and also check createMeshEditor see-through + error refusal when no face is picked.
  dispatch(dom.document, 'keydown', { key: 'Tab' });
  const editor = createMeshEditor({ controller, announce: () => {}, getRenderer: () => ({}), updatePart: () => {} });
  editor.enter();
  assert.equal(editor.assignMaterial('gold').ok, false, 'refuses cleanly when no face is picked');
  editor.setSeeThrough(true);
  const drawn = editor.partsToDraw(controller.scene.parts).filter(candidate => candidate.name === 'leftBox');
  assert.equal(drawn.length, 3);
  assert.ok(drawn.every(candidate => candidate.material.alphaMode === 'blend'));
  editor.leave();
});

test('slotless recipes remain byte-identical when joined with matching materials', () => {
  const makeSameMaterialRecipe = () => ({
    format: 'crucible.scene',
    schemaVersion: 1,
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5] }],
    geometries: [
      { id: 'first', type: 'mesh', base: { type: 'box', bevel: 0 } },
      { id: 'second', type: 'mesh', base: { type: 'box', bevel: 0 } },
    ],
    nodes: [
      { id: 'a', geometry: 'first', material: 'stone', translation: [0, 0, 0] },
      { id: 'b', geometry: 'second', material: 'stone', translation: [2, 0, 0] },
    ],
  });
  const firstScene = createAgentScene(makeSameMaterialRecipe());
  firstScene.apply([{ type: 'join-meshes', node: 'a', nodes: ['b'] }], { expectedRevision: firstScene.revision });
  const secondScene = createAgentScene(makeSameMaterialRecipe());
  secondScene.apply([{ type: 'join-meshes', node: 'a', nodes: ['b'] }], { expectedRevision: secondScene.revision });

  assert.equal(firstScene.parts.length, 1);
  assert.equal(firstScene.parts[0].materialSlot, undefined);
  assert.equal(firstScene.parts[0].geometry.materialGroups, undefined);
  assert.equal(firstScene.parts[0].geometry.materialSlots, undefined);
  assert.deepEqual(Array.from(firstScene.parts[0].geometry.positions), Array.from(secondScene.parts[0].geometry.positions));
  assert.deepEqual(Array.from(firstScene.parts[0].geometry.indices), Array.from(secondScene.parts[0].geometry.indices));
});
