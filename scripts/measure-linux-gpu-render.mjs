// Measures portrait renders on a Linux GPU box through the MCP render job: a realtime stills sequence and a path traced still.
// Usage: node scripts/measure-linux-gpu-render.mjs [--out artifacts/linux-gpu] [--width 1080] [--height 1920] [--frames 30] [--samples 16] [--skip-raster] [--skip-trace]
// The server starts Chrome with the Vulkan flags a Linux GPU container needs (docs/agent-render-jobs.md, "Linux GPU box").
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const outputFolder = resolve(option('out', 'artifacts/linux-gpu'));
const width = Number(option('width', 1080));
const height = Number(option('height', 1920));
const frameCount = Number(option('frames', 30));
const samples = Number(option('samples', 16));
await mkdir(join(outputFolder, 'jobs'), { recursive: true });

function vulkanChromeWrapper() {
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const found = names.map(name => spawnSync('which', [name], { encoding: 'utf8' }).stdout.trim()).find(Boolean);
  if (!found) throw new Error('No Chrome or Chromium on the PATH.');
  const wrapper = join(outputFolder, 'chrome-vulkan.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${found} --use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --no-sandbox "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

// On Linux the server starts Chrome through the Vulkan wrapper; elsewhere it uses the Chrome it finds (or CHROME_PATH).
const serverArguments = [resolve('bin/crucible-mcp.mjs'), '--backend', 'gpu', '--memory', '1024', '--jobs', join(outputFolder, 'jobs')];
const browserPath = process.platform === 'linux' ? vulkanChromeWrapper() : process.env.CHROME_PATH;
if (browserPath) serverArguments.push('--browser', browserPath);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: serverArguments,
  stderr: 'inherit',
});
const client = new Client({ name: 'crucible-linux-gpu-measure', version: '1' });

async function call(name, argumentsValue = {}, timeout = 300000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  if (result.isError) throw new Error(`${name}: ${result.content?.find(item => item.type === 'text')?.text}`);
  return result;
}

async function runJob(sessionId, revision, settings, label) {
  const started = performance.now();
  const job = (await call('scene_render_submit', { sessionId, expectedRevision: revision, settings })).structuredContent;
  for (;;) {
    const state = (await call('scene_render_status', { jobId: job.jobId })).structuredContent;
    if (['completed', 'failed', 'cancelled'].includes(state.state)) {
      const seconds = (performance.now() - started) / 1000;
      if (state.state !== 'completed') return { label, state: state.state, seconds, detail: JSON.stringify(state).slice(0, 600) };
      const result = (await call('scene_render_result', { jobId: job.jobId })).structuredContent;
      const sizes = [];
      for (const artifact of result.artifacts) sizes.push((await stat(artifact.path)).size);
      const firstHash = createHash('sha256').update(await readFile(result.artifacts[0].path)).digest('hex');
      return { label, state: 'completed', seconds, frames: sizes.length, firstSha256: firstHash, bytesFirst: sizes[0], bytesMin: Math.min(...sizes), bytesMax: Math.max(...sizes), pathTracer: result.metrics?.pathTracer, artifacts: result.artifacts.map(artifact => artifact.path) };
    }
    if ((performance.now() - started) / 1000 > 900) return { label, state: 'timeout-in-probe', seconds: 900 };
    await delay(500);
  }
}

const report = { width, height, steps: [] };
try {
  await client.connect(transport);
  const recipe = JSON.parse(await readFile('tests/fixtures/demo-room.recipe.json', 'utf8'));
  const created = (await call('scene_create', { recipe }, 600000)).structuredContent;
  const look = await call('scene_look', { sessionId: created.sessionId, width: 540, height: 960 });
  report.look = look.content.filter(item => item.type === 'text').map(item => item.text).join(' ').slice(0, 500);
  const revision = created.revision ?? 0;
  const steps = [];
  if (!process.argv.includes('--skip-raster')) {
    steps.push(['raster-stills', { kind: 'stills', width, height, stillCount: frameCount, motion: { start: 0 } }]);
  }
  if (!process.argv.includes('--skip-trace')) {
    for (const [traceWidth, traceHeight] of (width === 540 && height === 960 ? [[540, 960]] : [[540, 960], [width, height]])) {
      steps.push([`pathtrace-${traceWidth}x${traceHeight}`, { kind: 'image', width: traceWidth, height: traceHeight, renderer: { type: 'pathTracer', backend: 'gpu', samples, maxSeconds: 600, denoise: false } }]);
    }
  }
  for (const [label, settings] of steps) {
    try {
      report.steps.push(await runJob(created.sessionId, revision, settings, label));
    } catch (error) {
      report.steps.push({ label, state: 'error', detail: String(error.message).slice(0, 800) });
    }
    console.log(JSON.stringify(report.steps.at(-1)));
  }
} finally {
  await writeFile(join(outputFolder, 'report.json'), JSON.stringify(report, null, 2));
  await client.close();
}
