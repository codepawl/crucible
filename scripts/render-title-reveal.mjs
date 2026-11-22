// A title that drops in, grows and fades in letter by letter (splitText plus staggerNodeTracks), rendered through the MCP render job.
// Usage: node scripts/render-title-reveal.mjs [--text CRUCIBLE] [--effect rise|fade] [--metallic 0.9] [--order forward|reverse|center|random] [--backend gpu|cpu] [--width 640] [--height 360] [--out artifacts/2891]
// CHROME_PATH names another Chrome or Chromium executable.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { splitText, staggerNodeTracks } from '../src/kinetic-text.js';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const backend = option('backend', 'gpu');
const width = Number(option('width', 640));
const height = Number(option('height', 360));
const order = option('order', 'forward');
const effect = option('effect', 'rise');
const titleText = option('text', 'CRUCIBLE');
const outputFolder = resolve(option('out', 'artifacts/2891'));
const jobsFolder = join(outputFolder, 'jobs');
const FPS = 24;
const HOLD_SECONDS = 0.8;

function buildRecipe() {
  const title = splitText(titleText, { id: 'title', split: 'letters', size: 1.2, depth: 0.35, align: 'center', material: 'gold' });
  const drop = staggerNodeTracks(title.nodes, {
    property: 'translation', offset: 0.09, order,
    keyframes: [{ time: 0, value: [0, 1.6, 0], easing: 'easeOutCubic' }, { time: 0.7, value: [0, 0, 0] }],
  });
  const grow = staggerNodeTracks(title.nodes, {
    property: 'scale', offset: 0.09, order,
    keyframes: [{ time: 0, value: [0.2, 0.2, 0.2], easing: 'easeOutCubic' }, { time: 0.7, value: [1, 1, 1] }],
  });
  const fade = staggerNodeTracks(title.nodes, {
    property: 'opacity', offset: 0.18, order,
    keyframes: [{ time: 0, value: 0, easing: 'easeOutCubic' }, { time: 0.6, value: 1 }],
  });
  const fadeOnly = effect === 'fade';
  const shown = fadeOnly ? fade : drop;
  const tracks = fadeOnly ? fade.tracks : [...drop.tracks, ...grow.tracks];
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: title.geometries,
    materials: [
      { id: 'gold', color: [0.9, 0.65, 0.2], metallic: Number(option('metallic', 0.9)), roughness: 0.3 },
    ],
    nodes: title.nodes,
    camera: { eye: [0, 0.4, 9], target: [0, 0.3, 0], up: [0, 1, 0], fov: 35, near: 0.1, far: 100 },
    motion: { duration: shown.duration + HOLD_SECONDS, tracks },
  };
}

await mkdir(jobsFolder, { recursive: true });
const serverArguments = [resolve('bin/crucible-mcp.mjs'), '--backend', backend, '--memory', '384', '--jobs', jobsFolder];
if (process.env.CHROME_PATH) serverArguments.push('--browser', process.env.CHROME_PATH);
const transport = new StdioClientTransport({ command: process.execPath, args: serverArguments, stderr: 'inherit' });
const client = new Client({ name: 'crucible-title-reveal', version: '1' });

async function call(name, argumentsValue = {}, timeout = 120000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  if (result.isError) throw new Error(`${name}: ${result.content?.find(item => item.type === 'text')?.text}`);
  return result;
}

try {
  await client.connect(transport);
  const recipe = buildRecipe();
  const created = (await call('scene_create', { recipe }, 300000)).structuredContent;
  const job = (await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: { kind: 'video', width, height, fps: FPS, duration: recipe.motion.duration, motion: { start: 0 } } })).structuredContent;
  for (;;) {
    const state = (await call('scene_render_status', { jobId: job.jobId })).structuredContent;
    if (['completed', 'failed', 'cancelled'].includes(state.state)) {
      if (state.state !== 'completed') throw new Error(`Render ${state.state}: ${JSON.stringify(state).slice(0, 400)}`);
      break;
    }
    await delay(500);
  }
  const result = (await call('scene_render_result', { jobId: job.jobId })).structuredContent;
  const outputPath = join(outputFolder, `title-${effect === 'fade' ? 'fade' : 'reveal'}-${order}.mp4`);
  await writeFile(outputPath, await readFile(result.artifacts[0].path));
  await writeFile(outputPath.replace(/.mp4$/, '.json'), JSON.stringify({ effect, order, backend, width, height, fps: FPS, seed: 0, camera: recipe.camera, light: 'default sun and sky of the recipe', recipe }, null, 2));
  console.log(`wrote ${outputPath} (${recipe.motion.duration} s)`);
} finally {
  await client.close();
}
