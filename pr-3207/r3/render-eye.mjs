// Renders the glass-sphere test scene of #3148 through the MCP render job tools of a worktree build.
// Usage: node render.mjs <worktree> <out basename> <raster|cpu-trace> [thickness] [roughness]
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [worktree, outBase, mode, thicknessArg, roughnessArg, extraJson] = process.argv.slice(2);
const root = resolve(worktree);
const { Client } = await import(pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/client/dist/index.mjs')).href).catch(() => import('@modelcontextprotocol/client'));
const { StdioClientTransport } = await import(pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/client/dist/stdio.mjs')).href).catch(() => import('@modelcontextprotocol/client/stdio'));

const thickness = thicknessArg === undefined ? 0.4 : Number(thicknessArg);
const roughness = roughnessArg === undefined ? 0.05 : Number(roughnessArg);
const stripeColors = [[0.9, 0.1, 0.1], [0.95, 0.75, 0.1], [0.1, 0.65, 0.2], [0.1, 0.4, 0.9], [0.6, 0.15, 0.8], [0.95, 0.95, 0.95]];
const materials = [
  { id: 'floor', color: [0.55, 0.55, 0.58], roughness: 0.9 },
  { id: 'glass', color: [1, 1, 1], roughness, metallic: 0, transmission: 1, ior: 1.5, thickness, attenuationColor: [0.8, 0.95, 1], attenuationDistance: 2, ...JSON.parse(extraJson ?? '{}') },
  ...stripeColors.map((color, index) => ({ id: `stripe${index}`, color, roughness: 0.6 })),
];
const nodes = [
  { id: 'floor', geometry: 'box', material: 'floor', translation: [0, -0.05, 0], scale: [8, 0.1, 6] },
  ...stripeColors.map((_, index) => ({ id: `stripe${index}`, geometry: 'box', material: `stripe${index}`, translation: [-1.25 + index * 0.5, 0.8, -1.2], scale: [0.5, 1.6, 0.1] })),
  { id: 'glass', geometry: 'ball', material: 'glass', translation: [0, 0.6, 0.2], scale: [1, 1, 1] },
];
const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'box', type: 'box', bevel: 0 }, { id: 'ball', type: 'sphere', segments: 64 }],
  materials, nodes,
  camera: { eye: [0, 1.0, 5.2], target: [0, 0.7, 0], fov: 32 },
  environment: { world: true, hdri: 'studio-softbox', environmentIntensity: 0.25 },
};
const settings = { kind: 'image', width: 960, height: 540 };
if (mode === 'cpu-trace') settings.renderer = { type: 'pathTracer', backend: 'cpu', samples: 64, bounces: 8, denoise: false, seed: 1 };

const serverEntry = join(root, 'bin/crucible-mcp.mjs');
const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry, '--assets', 'C:/Users/nxan2/Documents/crucible/artifacts/3148/eye', '--jobs', join(tmpdir(), `crucible-3148-${process.pid}`)], stderr: 'inherit' });
const client = new Client({ name: 'render-3148', version: '1.0.0' });
await client.connect(transport);
try {
  const call = (name, args) => client.callTool({ name, arguments: args }, { timeout: 900000 });
  const catalog = (await call('scene_asset_catalog', {})).structuredContent;
  const catalogEntry = catalog.assets.find(entry => /glb/i.test(JSON.stringify(entry))); if (process.env.EYE_INSPECT) console.log(JSON.stringify(catalogEntry).slice(0, 600)); const assetId = catalogEntry.id ?? catalogEntry.assetId;
  const scale = Number(process.env.EYE_SCALE ?? 1);
  recipe.nodes = [{ id: 'eye', asset: { id: assetId }, translation: [0, 0, 0], scale: [scale, scale, scale] }];
  recipe.materials = [];
  recipe.geometries = [];
  recipe.camera = JSON.parse(process.env.EYE_CAMERA ?? '{"eye":[0,0,3],"target":[0,0,0],"fov":30}');
  recipe.environment = { world: false, hdri: 'studio-softbox', environmentIntensity: 0.5 };
  const created = await call('scene_create', { recipe });
  if (created.isError) throw new Error(created.content?.[0]?.text);
  const { sessionId } = created.structuredContent;
  if (process.env.EYE_INSPECT) { const inspected = await call('scene_inspect', { sessionId }); console.log(JSON.stringify(inspected.structuredContent.assets ?? inspected.structuredContent).slice(0, 1500)); }
  const submitted = await call('scene_render_submit', { sessionId, expectedRevision: 0, settings });
  if (submitted.isError) throw new Error(submitted.content?.[0]?.text);
  const { jobId } = submitted.structuredContent;
  for (;;) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (record.state === 'completed') break;
    if (['cancelled', 'failed'].includes(record.state)) throw new Error(`Render job ${record.state}: ${record.reason}`);
    await delay(300);
  }
  const result = (await call('scene_render_result', { jobId })).structuredContent;
  const outDirectory = dirname(resolve(outBase));
  await mkdir(outDirectory, { recursive: true });
  await copyFile(result.artifacts[0].path, `${resolve(outBase)}.png`);
  await writeFile(`${resolve(outBase)}.json`, JSON.stringify({ recipe, settings, mode }, null, 1));
  console.log('wrote', `${resolve(outBase)}.png`, JSON.stringify(result.metrics?.diagnostics ?? '').slice(0, 300));
} finally {
  await client.close();
}
