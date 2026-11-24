// Usage: node evidence.mjs <checkout> <out folder> <shot,...>   shots: close-baked, close-pixel, heavy-baked, heavy-pixel
// Renders the snow recipes of artifacts/snow through the MCP server of <checkout>. The pixel variants drop the baked
// layer mask from each graph and put the same slope mask on material.surfaceCover. Writes <shot>.png and <shot>.json.
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [checkout, folder, shotList] = process.argv.slice(2);
const SNOW_SOURCE = 'C:/Users/nxan2/Documents/crucible/artifacts/snow';
const meanOf = value => (Array.isArray(value) ? value : [0.85, 0.9, 0.99]);

function noiseScaleFor(materialId) {
  return materialId === 'mountain' ? 0.7 : 3;
}

function toPixelMaterial(material) {
  const layer = material.pattern?.graph?.color?.layer;
  if (!layer) return material;
  const seed = layer.mask.smoothstep[2].add?.[1]?.mul?.[0]?.sub?.[0]?.noise?.seed ?? 0;
  const graph = { ...material.pattern.graph, color: layer.base };
  const top = Array.isArray(layer.top) ? layer.top : [0.85, 0.9, 0.99];
  return {
    ...material,
    pattern: { ...material.pattern, graph },
    surfaceCover: { output: 'slope', edge: 0.33, softness: 0.13, noise: { scale: noiseScaleFor(material.id), amount: 0.4, seed: seed % 1000 }, color: top, roughness: 0.85 },
  };
}

async function loadShot(name) {
  const source = JSON.parse(await readFile('C:/Users/nxan2/Documents/crucible/artifacts/3147e/r3/' + name + '.json', 'utf8'));
  return { recipe: source.recipe, width: source.width, height: source.height };
}
async function unusedLoadShot(name) {
  const [scene, variant] = name.split('-');
  const source = JSON.parse(await readFile(join(SNOW_SOURCE, `${scene}-r2.recipe.json`), 'utf8'));
  const recipe = source.recipe;
  if (variant === 'pixel') recipe.materials = recipe.materials.map(toPixelMaterial);
  return { recipe, width: source.width, height: source.height };
}

const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(checkout, 'bin/crucible-mcp.mjs'), '--jobs', join(tmpdir(), `evidence3147-${process.pid}`)], stderr: 'inherit' });
const client = new Client({ name: 'evidence', version: '1.0.0' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args }, { timeout: 600000 });
try {
  for (const name of shotList.split(',')) {
    const { recipe, width, height } = await loadShot(name);
    const started = Date.now();
    let created;
    for (let attempt = 1; attempt <= 14; attempt++) {
      created = await call('scene_create', { recipe });
      if (!created.isError) break;
      console.log(name, 'scene_create attempt', attempt, String(created.content?.[0]?.text).slice(0, 160));
    }
    if (created.isError) { console.log('FAILED', name); continue; }
    const createdAt = Date.now();
    const { sessionId } = created.structuredContent;
    const submitted = (await call('scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'image', width, height } })).structuredContent;
    let record;
    for (;;) {
      record = (await call('scene_render_status', { jobId: submitted.jobId })).structuredContent;
      if (record.state === 'completed') break;
      if (['cancelled', 'failed'].includes(record.state)) throw new Error(JSON.stringify(record).slice(0, 1500));
      await delay(250);
    }
    const result = (await call('scene_render_result', { jobId: submitted.jobId })).structuredContent;
    await copyFile(result.artifacts[0].path, join(folder, `${name}.png`));
    await writeFile(join(folder, `${name}.json`), JSON.stringify({ recipe, width, height, backend: 'raster', createMs: createdAt - started, renderMs: Date.now() - createdAt, record }, null, 1));
    console.log('wrote', name, 'create', createdAt - started, 'render', Date.now() - createdAt);
  }
} finally {
  await client.close();
}
