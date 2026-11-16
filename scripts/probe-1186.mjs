// Probe for #1186: peak Node RSS of a native + OIDN video job of the demo room, per frame size, with the default guard.
//   node probe-1186.mjs <checkout> <width>x<height> [...] (env PROBE_FRAMES, PROBE_SAMPLES)
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const checkout = resolve(process.argv[2]);
const sizes = process.argv.slice(3).map(text => text.split('x').map(Number));
const frames = Number(process.env.PROBE_FRAMES ?? '24');
const samples = Number(process.env.PROBE_SAMPLES ?? '16');
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

const directory = await mkdtemp(join(tmpdir(), 'crucible-1186-probe-'));
const transport = new StdioClientTransport({ command: process.execPath,
  args: [join(checkout, 'bin/crucible-mcp.mjs'), '--backend', process.env.PROBE_RUNTIME_BACKEND ?? 'gpu', '--jobs', join(directory, 'jobs')],
  cwd: directory, stderr: 'inherit', env: { ...process.env } });
const client = new Client({ name: 'probe-1186', version: '1' });
await client.connect(transport);

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 1800000 });
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent;
}

const baseRecipe = JSON.parse(await readFile(join(checkout, 'tests/fixtures/demo-room.recipe.json'), 'utf8'));
const recipe = baseRecipe;
const renderer = { type: 'pathTracer', backend: 'native', samples, bounces: 4, denoise: true, maxSeconds: Number(process.env.PROBE_MAX_SECONDS ?? '120') };
const mebibytes = bytes => (bytes / 1048576).toFixed(0);

try {
  for (const [width, height] of sizes) {
    const { sessionId } = await call('scene_create', { recipe });
    const started = Date.now();
    const submitted = await call('scene_render_submit', { sessionId, expectedRevision: 0,
      settings: { kind: 'video', width, height, fps: 12, duration: frames / 12, renderer } });
    let record;
    while (true) {
      record = await call('scene_render_status', { jobId: submitted.jobId });
      if (['completed', 'failed', 'cancelled'].includes(record.state)) break;
      await delay(1000);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (record.state !== 'completed') {
      console.log(`RESULT ${width}x${height}: ${record.state} after ${seconds}s: ${JSON.stringify(record.error ?? record).slice(0, 500)}`);
      continue;
    }
    const { metrics } = await call('scene_render_result', { jobId: submitted.jobId, response_format: 'detailed' });
    const tracer = metrics.pathTracer ?? {};
    console.log(`RESULT ${width}x${height}: completed in ${seconds}s, peak Node RSS ${mebibytes(metrics.peakNodeBytes)} MiB, backend ${tracer.backend}, denoiser ${tracer.denoiser}, oidnMode ${tracer.oidnMode}, routes ${JSON.stringify((metrics.nativeSessionRoutes ?? []).slice(0, 3))}`);
  }
} finally {
  await client.close();
}
