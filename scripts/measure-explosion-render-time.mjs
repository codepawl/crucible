#!/usr/bin/env node
// Times the add-explosion recipe from scene build to the encoded MP4 (#1050 Done-when: 8 s of 1080p video in under 30 s on an RTX 3060, raster).
//
//   node scripts/measure-explosion-render-time.mjs --runs 3 --out artifacts/1050/timing
//
// Each run starts a fresh MCP server (a cold bake: the grid bake is cached per process), builds the scene with scene_create and scene_apply add-explosion,
// submits a video job and waits for it. The wall clock is split into the phases the job report names (bake, first draw, frames, encode) and the rest.
// Options: --runs <n>, --duration <seconds>, --width, --height, --fps, --size <metres>, --seed, --backend gpu|cpu, --out <folder>, --max-seconds <limit that aborts a run>.
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_OPTIONS = { runs: 3, duration: 8, width: 1920, height: 1080, fps: 24, size: 4, seed: 1, backend: 'gpu', out: 'artifacts/1050/timing', maxSeconds: 180, bakeCache: 'default' };
const NUMBER_OPTIONS = ['runs', 'duration', 'width', 'height', 'fps', 'size', 'seed', 'maxSeconds'];
const OPTION_NAMES = { 'max-seconds': 'maxSeconds', 'bake-cache': 'bakeCache' };
const USAGE = 'use [--runs 3] [--duration 8] [--width 1920] [--height 1080] [--fps 24] [--size 4] [--seed 1] [--backend gpu|cpu] [--out <folder>] [--max-seconds 180] [--bake-cache off|<absolute folder>].';

export const SCENE = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'disc', type: 'cylinder' }],
  materials: [{ id: 'floor', color: [0.12, 0.11, 0.1], roughness: 1 }],
  nodes: [{ id: 'floor', geometry: 'disc', material: 'floor', scale: [9, 0.1, 9], translation: [0, -0.05, 0] }],
  camera: { eye: [0, 3.2, 9], target: [0, 1.6, 0], fov: 40 },
};

export function parseArguments(argv) {
  const options = { ...DEFAULT_OPTIONS };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]?.replace(/^--/, '');
    const name = OPTION_NAMES[flag] ?? flag;
    if (!(name in DEFAULT_OPTIONS) || argv[index + 1] === undefined) throw new Error(`Unknown or incomplete option ${argv[index]}; ${USAGE}`);
    if (NUMBER_OPTIONS.includes(name)) {
      options[name] = Number(argv[index + 1]);
      if (!(options[name] > 0)) throw new Error(`--${flag} needs a positive number, got ${argv[index + 1]}.`);
    } else {
      options[name] = argv[index + 1];
    }
  }
  if (!['gpu', 'cpu'].includes(options.backend)) throw new Error(`--backend takes gpu or cpu, got ${options.backend}.`);
  if (options.bakeCache !== 'default' && options.bakeCache !== 'off' && !isAbsolute(options.bakeCache)) throw new Error(`--bake-cache takes off or an absolute folder, got ${options.bakeCache}.`);
  return options;
}

const roundSeconds = value => Math.round(value * 100) / 100;

// Phases come from the job's metrics: renderSeconds (drawing, first draw included), captureSeconds (reading the frames back), the encoder's backpressure and
// finish time and elapsedSeconds (the job's own clock). The bake and the first shader compile happen inside scene_apply, so they are in buildSeconds and the
// report cannot split them. A field the job does not carry stays out of the table instead of being guessed.
const PHASE_FIELDS = { drawSeconds: metrics => metrics.renderSeconds, captureSeconds: metrics => metrics.captureSeconds, encoderBackpressureSeconds: metrics => metrics.encoder?.backpressureSeconds, encoderFinishSeconds: metrics => metrics.encoder?.finishSeconds };

export function shapeReport({ options, runIndex, buildSeconds, submitSeconds, jobSeconds, totalSeconds, metrics }) {
  const phases = {};
  for (const [name, read] of Object.entries(PHASE_FIELDS)) {
    const value = read(metrics ?? {});
    if (Number.isFinite(value)) phases[name] = roundSeconds(value);
  }
  return {
    run: runIndex + 1,
    frames: Math.round(options.duration * options.fps),
    size: `${options.width}x${options.height}`,
    buildSeconds: roundSeconds(buildSeconds),
    submitSeconds: roundSeconds(submitSeconds),
    jobSeconds: roundSeconds(jobSeconds),
    jobReportSeconds: Number.isFinite(metrics?.elapsedSeconds) ? roundSeconds(metrics.elapsedSeconds) : undefined,
    totalSeconds: roundSeconds(totalSeconds),
    phases,
    meetsThirtySeconds: totalSeconds <= 30,
  };
}

// The server reads CRUCIBLE_BAKE_CACHE (#1876): "off" times a cold bake every run; a folder is empty on its first run and warm after it.
export function serverEnvironment(options, baseEnvironment) {
  return options.bakeCache === 'default' ? baseEnvironment : { ...baseEnvironment, CRUCIBLE_BAKE_CACHE: options.bakeCache };
}

async function openClient(options, runIndex) {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/client/stdio');
  const directory = join(tmpdir(), `crucible-explosion-time-${process.pid}-${runIndex}`);
  await mkdir(directory, { recursive: true });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('bin/crucible-mcp.mjs'), '--backend', options.backend, '--memory', '512', '--jobs', join(directory, 'jobs')], cwd: directory, env: serverEnvironment(options, getDefaultEnvironment()), stderr: 'pipe' });
  const client = new Client({ name: 'measure-explosion-render-time', version: '1' });
  await client.connect(transport, { timeout: 240000 });
  return client;
}

async function callTool(client, name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 240000 });
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text ?? `${name} failed`);
  return result.structuredContent;
}

async function waitForJob(client, jobId, startedAt, options, runIndex) {
  while (true) {
    const record = await callTool(client, 'scene_render_status', { jobId });
    if (['completed', 'cancelled', 'failed'].includes(record.state)) return record;
    if ((performance.now() - startedAt) / 1000 > options.maxSeconds) {
      throw new Error(`Run ${runIndex + 1} passed ${options.maxSeconds} s; hand this command to the lead to run as a heavy job instead.`);
    }
    await delay(200);
  }
}

async function runOnce(options, runIndex) {
  const client = await openClient(options, runIndex);
  try {
    const started = performance.now();
    const created = await callTool(client, 'scene_create', { recipe: SCENE });
    const operation = { type: 'add-explosion', id: 'blast', center: [0, 0, 0], size: options.size, seed: options.seed };
    const applied = await callTool(client, 'scene_apply', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, operations: [operation] });
    const built = performance.now();
    const settings = { kind: 'video', width: options.width, height: options.height, fps: options.fps, duration: options.duration };
    const submitted = await callTool(client, 'scene_render_submit', { sessionId: created.sessionId, expectedRevision: applied.revision ?? created.revision ?? 0, settings });
    const submittedAt = performance.now();
    const record = await waitForJob(client, submitted.jobId, started, options, runIndex);
    const finished = performance.now();
    if (record.state !== 'completed') throw new Error(`Job ${record.state}: ${JSON.stringify(record.reason ?? record)}`);
    const result = await callTool(client, 'scene_render_result', { jobId: submitted.jobId, response_format: 'detailed' });
    const shaped = shapeReport({ options, runIndex, buildSeconds: (built - started) / 1000, submitSeconds: (submittedAt - built) / 1000, jobSeconds: (finished - submittedAt) / 1000, totalSeconds: (finished - started) / 1000, metrics: result?.metrics });
    return { shaped, result };
  } finally {
    await client.close();
  }
}

async function main() {
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  const options = parseArguments(process.argv.slice(2));
  await mkdir(options.out, { recursive: true });
  const runs = [];
  for (let runIndex = 0; runIndex < options.runs; runIndex++) {
    const { shaped, result } = await runOnce(options, runIndex);
    if (runIndex === 0) await writeFile(join(options.out, 'job-result.json'), JSON.stringify(result, null, 2));
    runs.push(shaped);
    console.error(JSON.stringify(shaped));
  }
  await writeFile(join(options.out, 'timing.json'), JSON.stringify({ options, runs }, null, 2));
  console.log(JSON.stringify({ options, runs }, null, 2));
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
