// scene_render_submit refuses a job that can never run, at submit and through the real MCP server on the CPU backend (SwiftShader):
// a gpu path tracer backend on that runtime, and an ID matte naming a part or material the scene does not have. No job record is made.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const FRAME = { kind: 'image', width: 64, height: 64 };
const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'box', type: 'box' }],
  materials: [{ id: 'w', color: [0.7, 0.7, 0.7] }],
  nodes: [{ id: 'box', geometry: 'box', material: 'w' }],
  camera: { eye: [3, 2, 3], target: [0, 0, 0], fov: 40 },
};

let directory;
let client;
let sessionId;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'crucible-submit-refusals-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve('bin/crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '96', '--jobs', join(directory, 'jobs')], cwd: directory, stderr: 'pipe' });
  client = new Client({ name: 'crucible-submit-refusals-test', version: '1' });
  await client.connect(transport, { timeout: 240000 });
  sessionId = (await client.callTool({ name: 'scene_create', arguments: { recipe } }, { timeout: 120000 })).structuredContent.sessionId;
});

after(async () => {
  await client?.close();
  await rm(directory, { recursive: true, force: true });
});

function submit(settings) {
  return client.callTool({ name: 'scene_render_submit', arguments: { sessionId, expectedRevision: 0, settings: { ...FRAME, ...settings } } }, { timeout: 120000 });
}

async function jobFolders() {
  // The job store folder exists only once a job is stored.
  const names = await readdir(join(directory, 'jobs')).catch(() => []);
  return names.filter(name => /^[0-9a-f-]{36}$/.test(name));
}

async function refused(settings, expectedMessage) {
  const before = await jobFolders();
  const result = await submit(settings);
  assert.equal(result.isError, true, 'the submit is refused');
  assert.match(result.content[0].text, expectedMessage);
  assert.deepEqual(await jobFolders(), before, 'no job record is created');
}

test('a gpu path tracer backend is refused at submit on a cpu runtime', { timeout: 180000 }, async () => {
  await refused({ renderer: { type: 'pathTracer', backend: 'gpu', samples: 1 } },
    /renderer\.backend "gpu" needs a runtime on the GPU backend, and this one runs on SwiftShader\./);
});

test('a matte naming a part the scene lacks is refused at submit with the part names', { timeout: 180000 }, async () => {
  await refused({ mattes: [{ object: 'nope' }] }, /mattes\[0\]: no part named "nope" in this scene\. Pass one of: box/);
});

test('a matte naming a material the scene lacks is refused at submit with the material names', { timeout: 180000 }, async () => {
  await refused({ mattes: [{ object: 'box' }, { material: 'nope' }] }, /mattes\[1\]: no material named "nope" in this scene\. Pass one of: .*w/);
});

test('mattes naming real parts and materials still queue and render', { timeout: 180000 }, async () => {
  const result = await submit({ mattes: [{ object: 'box' }, { material: 'w' }] });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  const { jobId } = result.structuredContent;
  let record;
  for (let poll = 0; poll < 300; poll++) {
    record = (await client.callTool({ name: 'scene_render_status', arguments: { jobId } })).structuredContent;
    if (['completed', 'failed', 'cancelled'].includes(record.state)) break;
    await delay(200);
  }
  assert.equal(record.state, 'completed', record.reason);
});
