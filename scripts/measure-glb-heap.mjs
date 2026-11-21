// Measures the browser heap a render job holds for one dense GLB: builds a deterministic sphere of about
// 200k triangles, places it through MCP, renders one still and prints the job's peak heap per triangle.
// Usage: node scripts/measure-glb-heap.mjs [segments] [outputPng]   (backend: CRUCIBLE_BACKEND, default cpu)
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mat4 } from 'gl-matrix';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { exportGlb } from '../src/export.js';
import { sphere } from '../src/geometry.js';
import { createScratchDirectory } from './scratch-directory.mjs';

const segments = Number(process.argv[2] ?? 316);
const outputPng = process.argv[3];
const backend = process.env.CRUCIBLE_BACKEND ?? 'cpu';
const geometry = sphere(segments, segments);
const triangles = geometry.indices.length / 3;
const directory = await createScratchDirectory('crucible-glb-heap-');
const assets = join(directory, 'assets');
await mkdir(assets);
const material = { color: [0.6, 0.5, 0.4], roughness: 0.7, metallic: 0 };
await writeFile(join(assets, 'dense.glb'), Buffer.from(exportGlb([{ name: 'Dense', geometry, matrix: mat4.create(), material }])));

const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('bin/crucible-mcp.mjs'), '--backend', backend, '--memory', '384', '--assets', assets, '--jobs', join(directory, 'jobs')],
  cwd: directory, stderr: 'pipe', env: { ...process.env } });
const client = new Client({ name: 'glb-heap-measure', version: '1' });
await client.connect(transport);
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, { timeout: 300000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}
try {
  const assetId = (await call('scene_asset_catalog')).structuredContent.assets[0].assetId;
  const created = (await call('scene_create', { recipe: { format: 'crucible.scene', schemaVersion: 1,
    geometries: [], materials: [], ...(process.env.RESOLVE_COPLANAR === 'false' ? { environment: { resolveCoplanar: false } } : {}), nodes: [{ id: 'dense', asset: { id: assetId } }],
    camera: { eye: [0, 0.5, 3.2], target: [0, 0, 0], fov: 40 } } })).structuredContent;
  const submitted = (await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision,
    settings: { kind: 'image', width: 320, height: 240 } })).structuredContent;
  let record;
  for (let attempt = 0; attempt < 600; attempt++) {
    record = (await call('scene_render_status', { jobId: submitted.jobId })).structuredContent;
    if (['completed', 'failed', 'cancelled'].includes(record.state)) break;
    await delay(500);
  }
  const result = (await call('scene_render_result', { jobId: submitted.jobId, response_format: 'detailed' })).structuredContent;
  const heapMiB = result.metrics.peakBrowserHeap / 1048576;
  console.log(JSON.stringify({ triangles, state: record.state, peakBrowserHeapMiB: Number(heapMiB.toFixed(1)), heapBytesPerTriangle: Math.round(result.metrics.peakBrowserHeap / triangles), peakNodeMiB: Math.round(result.metrics.peakNodeBytes / 1048576), error: record.error }));
  if (outputPng && result.artifacts?.[0]?.path) await copyFile(result.artifacts[0].path, outputPng);
} finally {
  await client.close();
}
