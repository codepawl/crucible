// Usage: node render.mjs <checkout root> <variant> <out folder>
// variants: default | hard | toon-soft | toon-crisp | toon-dither. Writes <variant>.png and <variant>.json (recipe, camera, size, backend).
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [root, variant, outputFolder] = process.argv.slice(2);
const toonLayers = {
  'toon-soft': { toon: 4 },
  'toon-crisp': { toon: 4, toonEdge: 1 },
  'toon-dither': { toon: 4, toonEdge: 2 },
};
const camera = { eye: [6.5, 4.5, 8], target: [0, 0.6, 0], fov: 40 };
const layers = toonLayers[variant] ?? {};
const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'box', type: 'box' }, { id: 'ball', type: 'sphere' }],
  materials: [
    { id: 'floor', color: [0.55, 0.6, 0.5], roughness: 0.9, ...layers },
    { id: 'red', color: [0.8, 0.2, 0.15], roughness: 0.6, ...layers },
    { id: 'blue', color: [0.2, 0.35, 0.8], roughness: 0.5, ...layers },
  ],
  nodes: [
    { id: 'ground', geometry: 'box', material: 'floor', translation: [0, -0.1, 0], scale: [9, 0.2, 9] },
    { id: 'cube', geometry: 'box', material: 'red', translation: [-0.9, 0.6, 0], scale: [1.2, 1.2, 1.2] },
    { id: 'ball', geometry: 'ball', material: 'blue', translation: [1, 0.7, 0.4], scale: [1.4, 1.4, 1.4] },
  ],
  camera,
  environment: { lightDirection: [-3, 5, 2.5], keyIntensity: 3.5 },
  shadow: { target: [0, 0.5, 0], extent: 30, distance: 60, far: 150, ...(variant === 'hard' ? { hard: true } : {}) },
};
const size = [480, 360];
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'bin/crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '512', '--jobs', resolve(outputFolder, 'jobs-' + variant)], stderr: 'pipe' });
const client = new Client({ name: 'evidence-2955', version: '1' });
await client.connect(transport);
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, { timeout: 300000 });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent;
}
const created = await call('scene_create', { recipe });
const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: 0, settings: { kind: 'image', width: size[0], height: size[1] } });
for (;;) {
  const record = await call('scene_render_status', { jobId: submitted.jobId });
  if (['completed', 'failed', 'cancelled'].includes(record.state)) {
    if (record.state !== 'completed') throw new Error(record.reason);
    break;
  }
  await new Promise(done => setTimeout(done, 300));
}
const result = await call('scene_render_result', { jobId: submitted.jobId });
const png = result.artifacts.find(artifact => artifact.filename.endsWith('.png'));
mkdirSync(outputFolder, { recursive: true });
copyFileSync(png.path, join(outputFolder, `${variant}.png`));
writeFileSync(join(outputFolder, `${variant}.json`), JSON.stringify({ variant, size, backend: 'cpu (SwiftShader), MCP image job', camera, lightDirection: recipe.environment.lightDirection, seed: 'none', recipe }, null, 2));
await client.close();
console.log('wrote', variant);
