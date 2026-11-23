// Times scene_create through the MCP server for a recipe that places one catalog GLB (#2896).
//   node scripts/measure-big-texture-create.mjs <assets-directory> <asset-file-name> [--backend gpu|cpu] [--deadline 30] [--without-asset]
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PREVIEW_DEADLINE_VARIABLE } from './preview-deadline.mjs';

const [assetsDirectory, assetName, ...flags] = process.argv.slice(2);
if (!assetsDirectory || !assetName) throw new Error('Usage: node scripts/measure-big-texture-create.mjs <assets-directory> <asset-file-name> [--backend gpu|cpu] [--deadline 30]');
const flagValue = (name, fallback) => flags.includes(name) ? flags[flags.indexOf(name) + 1] : fallback;
const backend = flagValue('--backend', 'gpu');
const deadlineSeconds = flagValue('--deadline', '30');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', backend, '--memory', '192', '--assets', resolve(assetsDirectory)],
  stderr: 'pipe', cwd: process.cwd(),
  env: { ...process.env, [PREVIEW_DEADLINE_VARIABLE]: deadlineSeconds },
});
let diagnostics = '';
transport.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
const client = new Client({ name: 'crucible-create-timing', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 180000 } } });
try {
  await client.connect(transport, { timeout: 180000 });
  const catalog = await client.callTool({ name: 'scene_asset_catalog', arguments: {} }, { timeout: 180000 });
  const asset = catalog.structuredContent.assets.find(entry => entry.name === assetName);
  if (!asset) throw new Error(`The catalog lists no ${assetName}: ${JSON.stringify(catalog.structuredContent).slice(0, 300)}`);
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'floor', type: 'terrain', size: 12, resolution: 16, amplitude: 0.1 }],
    materials: [{ id: 'sand', color: [0.6, 0.55, 0.4], roughness: 0.9 }],
    nodes: [{ id: 'ground', geometry: 'floor', material: 'sand' }, ...(flags.includes('--without-asset') ? [] : [{ id: 'hero', asset: { id: asset.assetId } }])],
    camera: { eye: [0, 1.5, 5], target: [0, 0, 0], fov: 45 },
  };
  const started = performance.now();
  const created = await client.callTool({ name: 'scene_create', arguments: { recipe } }, { timeout: 240000 });
  const seconds = (performance.now() - started) / 1000;
  const text = created.content?.find(item => item.type === 'text')?.text ?? '';
  console.log(JSON.stringify({ backend, deadlineSeconds, createSeconds: Number(seconds.toFixed(2)), isError: created.isError === true, message: created.isError ? text : undefined }));
} finally {
  await client.close().catch(() => {});
  if (process.env.SHOW_DIAGNOSTICS) console.error(diagnostics);
}
