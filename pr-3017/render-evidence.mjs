// node render-evidence.mjs <checkout> <label> : renders the F-with-text image on a sphere and a plane, raster and path traced (both on the cpu backend).
// Writes artifacts/3017/<label>-<mode>.png and a .json (recipe, settings, backend, seed) beside each.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [checkout, label] = process.argv.slice(2);
const outputFolder = resolve('C:/Users/nxan2/Documents/crucible/artifacts/3017');
const assetFolder = join(outputFolder, 'assets');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(checkout, 'bin/crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '1024', '--assets', assetFolder, '--jobs', join(outputFolder, `jobs-${label}`)],
  cwd: checkout,
  stderr: 'pipe',
});
const client = new Client({ name: 'evidence-3017', version: '1' });
await client.connect(transport);
async function call(name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 580000 });
  if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
  return result.structuredContent;
}
const catalog = await call('scene_asset_catalog', {});
const imageEntry = (catalog.assets ?? catalog.entries ?? []).find(entry => entry.kind === 'image');
if (!imageEntry) throw new Error(`No image in catalog: ${JSON.stringify(catalog).slice(0, 400)}`);
const imageId = imageEntry.assetId;
const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'ball', type: 'sphere', segments: 96, rings: 64 }, { id: 'sheet', type: 'plane', segments: 1 }],
  materials: [{ id: 'picture', colorMap: imageId, roughness: 0.6, doubleSided: true }],
  nodes: [
    { id: 'sphere', geometry: 'ball', material: 'picture', translation: [-1.15, 0, 0], rotation: [0, 0.70710678, 0, 0.70710678], scale: [1, 1, 1] },
    { id: 'plane', geometry: 'sheet', material: 'picture', translation: [1.15, 0, 0], scale: [2, 2, 2] },
  ],
  camera: { eye: [0, 0, 6], target: [0, 0, 0], fov: 32 },
};
const modes = {
  raster: { kind: 'image', width: 960, height: 480 },
  traced: { kind: 'image', width: 960, height: 480, renderer: { type: 'pathTracer', backend: 'cpu', samples: 48, bounces: 4, denoise: false, seed: 1, maxSeconds: 300 } },
};
for (const [mode, settings] of Object.entries(modes)) {
  const created = await call('scene_create', { recipe });
  const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings });
  for (;;) {
    const record = await call('scene_render_status', { jobId: submitted.jobId });
    if (['completed', 'failed', 'cancelled'].includes(record.state)) {
      if (record.state !== 'completed') throw new Error(`${mode}: ${record.state} ${record.reason}`);
      break;
    }
    await new Promise(done => setTimeout(done, 500));
  }
  const result = await call('scene_render_result', { jobId: submitted.jobId });
  const artifact = (result.artifacts ?? []).find(item => /\.png$/.test(item.path ?? item.file ?? item.name ?? ''));
  const source = artifact?.path ?? artifact?.file;
  if (!source) throw new Error(`${mode}: no png in ${JSON.stringify(result).slice(0, 600)}`);
  const { copyFile } = await import('node:fs/promises');
  await copyFile(source, join(outputFolder, `${label}-${mode}.png`));
  await writeFile(join(outputFolder, `${label}-${mode}.json`), JSON.stringify({ checkout: label, backend: 'cpu', settings, recipe, camera: recipe.camera, seed: settings.renderer?.seed ?? null }, null, 1));
  console.log(mode, 'done');
}
await client.close();
