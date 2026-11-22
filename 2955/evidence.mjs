import { mkdir, writeFile, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Usage: node evidence.mjs <branchCli> <baseCli> <outputDirectory>
const [branchCli, baseCli, outputDirectory] = process.argv.slice(2).map(value => resolve(value));
const WIDTH = 480;
const HEIGHT = 360;
await mkdir(outputDirectory, { recursive: true });

const FOUR_ARGUMENT_HOOK = 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n  color = mix(color, vec3(1.0, 0.45, 0.1), 0.5 + 0.5 * sin(worldPosition.x * 6.0));\n}';
const TIME_HOOK = 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition, float time) {\n  float wave = 0.5 + 0.5 * sin(time * 4.0 + worldPosition.x * 6.0);\n  color = mix(color, vec3(1.0, 0.45, 0.1), wave);\n}';

function recipe(snippet) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box' }],
    materials: [
      { id: 'floor', color: [0.7, 0.7, 0.7], roughness: 0.9 },
      { id: 'lamp', color: [0.4, 0.5, 0.8], roughness: 0.6, ...(snippet ? { snippet: { fragment: snippet } } : {}) },
    ],
    nodes: [
      { id: 'ground', geometry: 'block', material: 'floor', scale: [20, 0.2, 20], translation: [0, -0.1, 0] },
      { id: 'caster', geometry: 'block', material: 'lamp', scale: [1.6, 1.6, 1.6], translation: [0, 0.8, 0] },
    ],
    camera: { eye: [5, 4, 6], target: [0, 0.6, 0], fov: 35, near: 0.5, far: 60 },
    environment: { world: true, lightDirection: [-1, 1.4, 0.6], keyColor: [3, 2.8, 2.5], ambientIntensity: 0.25, ground: false },
  };
}

async function openClient(cli) {
  const jobs = await mkdtemp(join(tmpdir(), 'evidence-2955-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--memory', '256', '--jobs', jobs], cwd: jobs, stderr: 'pipe' });
  const client = new Client({ name: 'evidence-2955', version: '1' });
  await client.connect(transport);
  return client;
}

async function renderFrames(cli, sceneRecipe, motionTimes) {
  const client = await openClient(cli);
  const call = async (name, argumentsValue) => {
    const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
    if (result.isError) throw new Error(result.content[0].text);
    return result;
  };
  const created = (await call('scene_create', { recipe: sceneRecipe })).structuredContent;
  const frames = [];
  for (const motionTime of motionTimes) {
    const look = await call('scene_review', { expectedRevision: created.revision, width: WIDTH, height: HEIGHT, shots: [{ rendererTime: motionTime, label: 't=' + motionTime.toFixed(2) }] });
    frames.push(Buffer.from(look.content.find(item => item.type === 'image').data, 'base64'));
  }
  await client.close();
  return frames;
}

async function rootMeanSquare(first, second) {
  const firstPixels = await sharp(first).raw().toBuffer();
  const secondPixels = await sharp(second).raw().toBuffer();
  let total = 0;
  for (let index = 0; index < firstPixels.length; index++) total += (firstPixels[index] - secondPixels[index]) ** 2;
  return Math.sqrt(total / firstPixels.length);
}

const report = {};
for (const [name, snippet] of [['plain', null], ['hook4', FOUR_ARGUMENT_HOOK]]) {
  const sceneRecipe = recipe(snippet);
  const [before] = await renderFrames(baseCli, sceneRecipe, [0]);
  const [after] = await renderFrames(branchCli, sceneRecipe, [0]);
  await writeFile(join(outputDirectory, `${name}-main.png`), before);
  await writeFile(join(outputDirectory, `${name}-branch.png`), after);
  await writeFile(join(outputDirectory, `${name}.json`), JSON.stringify({ recipe: sceneRecipe, camera: sceneRecipe.camera, sunDirection: sceneRecipe.environment.lightDirection, size: [WIDTH, HEIGHT], backend: 'default (GPU preview)', seed: 'none' }, null, 1));
  report[name] = await rootMeanSquare(before, after);
}

const timeRecipe = recipe(TIME_HOOK);
const times = Array.from({ length: 24 }, (_, index) => index / 12);
const frames = await renderFrames(branchCli, timeRecipe, times);
for (const [index, frame] of frames.entries()) await writeFile(join(outputDirectory, `time-${String(index).padStart(3, '0')}.png`), frame);
await writeFile(join(outputDirectory, 'time.json'), JSON.stringify({ recipe: timeRecipe, camera: timeRecipe.camera, sunDirection: timeRecipe.environment.lightDirection, size: [WIDTH, HEIGHT], fps: 12, motionTimes: [times[0], times.at(-1)], backend: 'default (GPU preview)', seed: 'none' }, null, 1));
report.timeFramesDiffer = await rootMeanSquare(frames[0], frames[5]);
console.log(JSON.stringify(report));
