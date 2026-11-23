// scene_export_glb names what it did not write (issue 2130): the motion tracks, camera and lights it left out,
// and scene_capabilities topic export says what the GLB carries. Node tracks, the camera and point and spot lights are written. Runs the real MCP server on the CPU backend.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parseGltf } from '../src/gltf.js';
import { GLB_EXPORT_NOTES, omittedFromGlb } from '../src/glb-export-omissions.js';

const CAMERA = { eye: [3, 2, 4], target: [0, 0.5, 0], fov: 45 };
let directory;
let client;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'crucible-export-omitted-'));
  await mkdir(join(directory, 'assets'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('bin/crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '96', '--assets', join(directory, 'assets'), '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
  client = new Client({ name: 'crucible-export-omitted-test', version: '1' });
  await client.connect(transport, { timeout: 240000 });
});

after(async () => {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
});

async function exportOf(recipe, extraArguments = {}) {
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe } }, { timeout: 120000 });
  assert.equal(created.isError, undefined, created.content?.[0]?.text);
  const exported = await client.callTool({ name: 'scene_export_glb', arguments: { sessionId: created.structuredContent.sessionId, ...extraArguments } }, { timeout: 120000 });
  assert.equal(exported.isError, undefined, exported.content?.[0]?.text);
  return exported.structuredContent;
}

const BASE = { format: 'crucible.scene', schemaVersion: 1, geometries: [{ id: 'box', type: 'box' }], materials: [{ id: 'm' }], camera: CAMERA,
  nodes: [{ id: 'cube', geometry: 'box', material: 'm' }] };

const MOTION_RECIPE = { ...BASE,
  environment: { pointLights: [{ position: [0, 2, 1], color: [1, 1, 1], intensity: 5 }, { position: [1, 2, 1], color: [1, 1, 1], intensity: 5 }],
    areaLights: [{ position: [0, 3, 0], direction: [0, -1, 0], width: 1, height: 1, color: [1, 1, 1], intensity: 20 }] },
  motion: { duration: 2, tracks: [
    { kind: 'node', id: 'cube', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 2, value: [1, 0, 0] }] },
    { kind: 'node', id: 'cube', property: 'opacity', keyframes: [{ time: 0, value: 1 }, { time: 1, value: 0.5 }] },
    { kind: 'material', id: 'm', property: 'emission', keyframes: [{ time: 0, value: 0 }, { time: 2, value: 1 }] },
    { kind: 'camera', property: 'fov', keyframes: [{ time: 0, value: 45 }, { time: 2, value: 60 }] }] } };

test('an export writes the node clip, the camera and the lights and lists what it still leaves out', { timeout: 300000 }, async () => {
  const result = await exportOf(MOTION_RECIPE);
  assert.equal(result.clips, 1);
  assert.deepEqual(result.omitted, ['motion tracks (3: camera 1, material 1, node 1)', 'area lights (1)']);
  const file = await readFile(result.path);
  const asset = await parseGltf(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  assert.equal(asset.animations.length, 1);
  assert.ok(Math.abs(asset.animations[0].duration - 2) < 1e-5);
  const position = asset.animations[0].tracks.find(track => track.name === 'cube.position');
  assert.deepEqual(Array.from(position.values.subarray(-3)), [1, 0, 0]);
  assert.equal(asset.lights.pointLights.length, 2);
});

test('motionTime exports one pose without a clip and names the node tracks it left out', { timeout: 300000 }, async () => {
  const result = await exportOf(MOTION_RECIPE, { motionTime: 1 });
  assert.equal(result.clips, 0);
  assert.equal(result.omitted[0], 'motion tracks (4: camera 1, material 1, node 2)');
});

test('omitted names nothing when the camera is written and nothing else was authored', { timeout: 300000 }, async () => {
  assert.deepEqual((await exportOf(BASE)).omitted, []);
});

test('scene_capabilities topic export says what the GLB carries and drops', { timeout: 120000 }, async () => {
  const answer = await client.callTool({ name: 'scene_capabilities', arguments: { topic: 'export' } });
  assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
  assert.equal(answer.structuredContent.topic, 'export');
  assert.deepEqual(answer.structuredContent.value.writes, GLB_EXPORT_NOTES.writes);
  assert.deepEqual(answer.structuredContent.value.drops, GLB_EXPORT_NOTES.drops);
});

test('omittedFromGlb skips the node tracks of bones a clip baked and leaves an empty list without a camera', () => {
  const recipe = { motion: { tracks: [{ kind: 'node', id: 'bone', property: 'rotation' }, { kind: 'node', id: 'prop', property: 'scale' }] } };
  assert.deepEqual(omittedFromGlb(recipe, { boneIds: ['bone'] }), ['motion tracks (1: node 1)']);
  assert.deepEqual(omittedFromGlb({}), []);
});
