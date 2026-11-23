import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { assetCopyKey } from '../src/agent-scene-assets.js';
import { planSceneEviction, SCENE_STORE_LIMITS } from '../src/agent-errors.js';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { gridGlb } from './fixtures/grid-glb.js';

await loadAllAgentSceneModules();

const MEBIBYTE = 1024 * 1024;
const ASSET_ID = 'ab'.repeat(32);
const GRID_SIDE = 60;
const SHAPE_KEY_MESH = {
  id: 'face', type: 'mesh', base: { type: 'box', bevel: 0, subdivisions: 2 },
  shapeKeys: [{ name: 'lift', offsets: [{ select: { tag: 'top' }, offset: [0, 0.5, 0] }] }],
};

function recipeWith({ geometries = [], nodes }) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }, ...geometries],
    materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
    nodes: [{ id: 'floor', geometry: 'ground', material: 'grass' }, ...nodes],
  };
}

function placements(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `tree-${index}`, translation: [index * 2, 0, 0], asset: { id: ASSET_ID } }));
}

async function inspectWithGrid(nodes, extra = {}) {
  const glb = gridGlb(GRID_SIDE);
  const glbBuffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const assets = new Map([[assetCopyKey(ASSET_ID, 0), await parseGltf(glbBuffer)]]);
  return createAgentScene(recipeWith({ nodes, ...extra }), {}, { assets }).inspect();
}

test('a scene with placed assets reports finite positive resident and geometry bytes (#2287)', async () => {
  const withoutAssets = createAgentScene(recipeWith({ nodes: [] })).inspect();
  const withAssets = await inspectWithGrid(placements(1));
  const gridBytes = GRID_SIDE * GRID_SIDE * 6 * 4 + (GRID_SIDE - 1) ** 2 * 6 * 4;
  assert.ok(Number.isFinite(withAssets.residentGeometryBytes) && withAssets.residentGeometryBytes > 0);
  assert.ok(Number.isFinite(withAssets.geometryBytes) && withAssets.geometryBytes > 0);
  assert.equal(withAssets.residentGeometryBytes - withoutAssets.residentGeometryBytes, gridBytes, 'positions, normals and indices of the asset');
  assert.equal(withAssets.geometryBytes, withAssets.residentGeometryBytes);
});

test('one asset placed many times counts its shared buffers once (#2287)', async () => {
  const once = await inspectWithGrid(placements(1));
  const many = await inspectWithGrid(placements(12));
  assert.equal(many.residentGeometryBytes, once.residentGeometryBytes);
});

test('a mesh with shape keys counts its morph target buffers instead of going NaN (#2287)', async () => {
  const { shapeKeys, ...plainMesh } = SHAPE_KEY_MESH;
  const plain = createAgentScene(recipeWith({ geometries: [plainMesh], nodes: [{ id: 'head', geometry: 'face', material: 'grass' }] })).inspect();
  const keyed = createAgentScene(recipeWith({ geometries: [SHAPE_KEY_MESH], nodes: [{ id: 'head', geometry: 'face', material: 'grass' }] })).inspect();
  assert.ok(Number.isFinite(keyed.residentGeometryBytes));
  assert.ok(keyed.residentGeometryBytes > plain.residentGeometryBytes, 'the shape key target adds bytes');
  assert.equal(keyed.geometryBytes, keyed.residentGeometryBytes);
});

test('assets and shape keys together stay finite and keep the generated geometry budget to generated geometry (#2287)', async () => {
  const report = await inspectWithGrid([...placements(3), { id: 'head', geometry: 'face', material: 'grass' }], { geometries: [SHAPE_KEY_MESH] });
  assert.ok(Number.isFinite(report.residentGeometryBytes) && report.residentGeometryBytes > 0);
  assert.ok(Number.isFinite(report.geometryBytes) && report.geometryBytes > 0);
});

test('the store refuses a non-finite byte figure and names the scene instead of treating it as fitting (#2287)', () => {
  const openScenes = [{ sessionId: 'scene-a', bytes: MEBIBYTE }, { sessionId: 'scene-b', bytes: Number.NaN }];
  assert.throws(() => planSceneEviction(openScenes, MEBIBYTE), /resident geometry bytes of scene scene-b is NaN/);
  assert.throws(() => planSceneEviction([], Number.NaN), /resident geometry bytes of the new scene is NaN/);
  assert.throws(() => planSceneEviction([], undefined), /not a finite count/);
});

async function runtimeWithGrids(context, sides) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-resident-bytes-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, side] of Object.entries(sides)) await writeFile(join(directory, name), gridGlb(side, name));
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 192, assets: directory });
  context.after(() => runtime.close());
  return runtime;
}

function sceneRecipePlacing(names) {
  return recipeWith({ nodes: names.map((name, index) => ({ id: `placed-${index}`, asset: { name } })) });
}

test('scenes with placed assets stay open up to the scene cap and the fifth closes the oldest (#2287)', { timeout: 240000 }, async context => {
  const runtime = await runtimeWithGrids(context, { 'small.glb': 40 });
  const created = [];
  for (let index = 0; index < SCENE_STORE_LIMITS.maxOpenScenes; index++) {
    const scene = await runtime.create({ recipe: sceneRecipePlacing(['small.glb']) });
    assert.ok(scene.inspection.residentGeometryBytes > 0 && Number.isFinite(scene.inspection.residentGeometryBytes));
    assert.equal(scene.evictedSessions, undefined, `scene ${index + 1} fits`);
    created.push(scene.sessionId);
  }
  const fifth = await runtime.create({ recipe: sceneRecipePlacing(['small.glb']) });
  assert.deepEqual(fifth.evictedSessions, [created[0]]);
  assert.match(fifth.evictionReason, /at most 4 open scenes/);
  assert.doesNotMatch(fifth.evictionReason, /NaN/);
});

test('placed assets count toward the byte cap, which closes the oldest scene and names real MiB (#2287)', { timeout: 240000 }, async context => {
  const runtime = await runtimeWithGrids(context, { 'big-a.glb': 600, 'big-b.glb': 600 });
  const first = await runtime.create({ recipe: sceneRecipePlacing(['big-a.glb', 'big-b.glb']) });
  const second = await runtime.create({ recipe: sceneRecipePlacing(['big-a.glb', 'big-b.glb']) });
  const sceneBytes = first.inspection.residentGeometryBytes;
  assert.ok(2 * sceneBytes <= SCENE_STORE_LIMITS.maxOpenSceneBytes, 'two such scenes fit under the cap');
  assert.ok(3 * sceneBytes > SCENE_STORE_LIMITS.maxOpenSceneBytes, 'three such scenes are over the cap');
  assert.equal(second.evictedSessions, undefined);
  const third = await runtime.create({ recipe: sceneRecipePlacing(['big-a.glb', 'big-b.glb']) });
  assert.deepEqual(third.evictedSessions, [first.sessionId]);
  assert.match(third.evictionReason, /\d+\.\d MiB of resident geometry, over the 96\.0 MiB cap/);
  assert.doesNotMatch(third.evictionReason, /NaN|at most 4 open scenes/);
});
