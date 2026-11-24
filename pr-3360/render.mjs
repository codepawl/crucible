// Usage: node render2.mjs <worktree> <out basename> <raster|cpu-trace> [samples]. Renders the #3225 scene (scene2.mjs) through MCP.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { buildRecipe, size } from './scenes.mjs';

const [worktree, outBase, mode, sceneName, samplesArg] = process.argv.slice(2);
const root = resolve(worktree);
const { Client } = await import(pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/client/dist/index.mjs')).href);
const { StdioClientTransport } = await import(pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/client/dist/stdio.mjs')).href);
const recipe = buildRecipe(sceneName);
if (process.env.NOGLASS) recipe.nodes = recipe.nodes.filter(node => !node.id.startsWith("glass") && node.material?.startsWith("glass") !== true);
const settings = { kind: 'image', ...size };
if (mode === 'cpu-trace') settings.renderer = { type: 'pathTracer', backend: 'cpu', samples: Number(samplesArg ?? 128), bounces: 8, denoise: false, seed: 1 };
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/crucible-mcp.mjs'), '--jobs', join(tmpdir(), `crucible-3340-${process.pid}`)], stderr: 'inherit' });
const client = new Client({ name: 'render-3340', version: '1.0.0' });
await client.connect(transport);
try {
  const call = (name, args) => client.callTool({ name, arguments: args }, { timeout: 900000 });
  const created = await call('scene_create', { recipe });
  if (created.isError) throw new Error(created.content?.[0]?.text);
  const { sessionId } = created.structuredContent;
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
  await mkdir(dirname(resolve(outBase)), { recursive: true });
  await copyFile(result.artifacts[0].path, `${resolve(outBase)}.png`);
  await writeFile(`${resolve(outBase)}.json`, JSON.stringify({ recipe, settings, mode, seed: 1, renderSeconds: result.metrics?.renderSeconds }, null, 1));
  console.log('wrote', `${resolve(outBase)}.png`, result.metrics?.renderSeconds);
} finally {
  await client.close();
}
