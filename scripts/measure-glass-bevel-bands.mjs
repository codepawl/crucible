// Renders a glass shape in front of a checker wall through the MCP server and counts the luminance steps along lines across its edge, so
// the stair-step bands a bevelled thick glass box once showed (#3256) can be measured again.
//
//   node scripts/measure-glass-bevel-bands.mjs --out artifacts/3256/after [--shape box|ball|ellipsoid|cube] [--ior 1.3] [--thickness 0.2]
//        [--width 540] [--height 960] [--worktree <checkout whose bin/crucible-mcp.mjs renders>]
//   node scripts/measure-glass-bevel-bands.mjs --measure <still.png> [<still.png> ...]   (steps per line of stills you already have)
//
// Needs `npm run build && node scripts/build-mcp.mjs` in the checkout first. Run it under the GPU queue on a shared machine.
// The scene: a shape of scale 1.3 (the box has a bevel of 0.12), a camera 6 m away, a checker wall behind. Writes <out>.png and <out>.json
// (the full recipe, camera, size and the measured steps) and prints the steps per line across the top and the left edge.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHAPES = new Set(['box', 'ball', 'ellipsoid', 'cube']);
const STEP_LUMINANCE_THRESHOLD = 0.12;
const REFERENCE_HEIGHT = 960;
const REFERENCE_WIDTH = 540;

const SHAPE_NODES = {
  box: { geometry: 'rounded', scale: [1.3, 1.3, 1.3] },
  cube: { geometry: 'cube', scale: [1.3, 1.3, 1.3] },
  ball: { geometry: 'ball', scale: [1.3, 1.3, 1.3] },
  ellipsoid: { geometry: 'ball', scale: [1.6, 0.9, 0.9] },
};

/** The scene recipe: the glass shape of the chosen kind in front of a wall of 0.25 m checker tiles. */
export function buildBevelBandRecipe({ shape, indexOfRefraction, thickness }) {
  if (!SHAPES.has(shape)) throw new Error(`Unknown shape "${shape}". Pass one of ${[...SHAPES].join(', ')}.`);
  const nodes = [{ id: 'wall', geometry: 'box', material: 'light', translation: [0, 0, -2.5], scale: [8, 12, 0.1] }];
  const tile = 0.25;
  for (let row = -24; row < 24; row++) {
    for (let column = -16; column < 16; column++) {
      if ((row + column) % 2 === 0) continue;
      nodes.push({ id: `tile-${row + 24}-${column + 16}`, geometry: 'box', material: 'dark', translation: [(column + 0.5) * tile, (row + 0.5) * tile, -2.44], scale: [tile, tile, 0.02] });
    }
  }
  nodes.push({ id: 'glass', material: 'glass', translation: [0, 0, 0], ...SHAPE_NODES[shape] });
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [
      { id: 'box', type: 'box', bevel: 0 },
      { id: 'cube', type: 'box', bevel: 0 },
      { id: 'rounded', type: 'box', bevel: 0.12 },
      { id: 'ball', type: 'sphere' },
    ],
    materials: [
      { id: 'light', color: [0.88, 0.88, 0.86], roughness: 0.9 },
      { id: 'dark', color: [0.12, 0.2, 0.55], roughness: 0.9 },
      { id: 'glass', color: [1, 1, 1], roughness: 0.02, metallic: 0, transmission: 1, ior: indexOfRefraction, thickness, attenuationColor: [1, 1, 1], attenuationDistance: 100 },
    ],
    nodes,
    camera: { eye: [0.6, 0.5, 6], target: [0, 0, 0], fov: 30 },
  };
}

function countSteps(values) {
  let steps = 0;
  for (let index = 1; index < values.length; index++) {
    if (Math.abs(values[index] - values[index - 1]) > STEP_LUMINANCE_THRESHOLD) steps++;
  }
  return steps;
}

/**
 * Luminance steps per line (neighbour change above 0.12) along 40 vertical lines across the top edge of the box (rows 270 to 330 of a
 * 540x960 still, columns 120 to 420) and 40 horizontal lines across its left edge (columns 30 to 100, rows 340 to 620). Other sizes scale.
 */
export async function measureEdgeSteps(file) {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  const luminanceAt = (x, y) => data[y * info.width + x] / 255;
  const scaleX = info.width / REFERENCE_WIDTH;
  const scaleY = info.height / REFERENCE_HEIGHT;
  let topSteps = 0;
  let leftSteps = 0;
  for (let line = 0; line < 40; line++) {
    const column = Math.round((120 + line * 7.5) * scaleX);
    const values = [];
    for (let row = Math.round(270 * scaleY); row < Math.round(330 * scaleY); row++) values.push(luminanceAt(column, row));
    topSteps += countSteps(values);
    const row = Math.round((340 + line * 7) * scaleY);
    const rowValues = [];
    for (let column2 = Math.round(30 * scaleX); column2 < Math.round(100 * scaleX); column2++) rowValues.push(luminanceAt(column2, row));
    leftSteps += countSteps(rowValues);
  }
  return { topStepsPerLine: topSteps / 40, leftStepsPerLine: leftSteps / 40 };
}

function parseArguments(argv) {
  const options = { shape: 'box', ior: '1.3', thickness: '0.2', width: String(REFERENCE_WIDTH), height: String(REFERENCE_HEIGHT), worktree: REPOSITORY_ROOT };
  const measure = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--measure') {
      measure.push(...argv.slice(index + 1));
      break;
    }
    const name = argument.replace(/^--/, '');
    if (!argument.startsWith('--') || !(name in options) && name !== 'out' || argv[index + 1] === undefined) {
      throw new Error(`Unknown or incomplete option "${argument}". Pass --out <basename> with optional --shape, --ior, --thickness, --width, --height, --worktree, or --measure <still.png> ...`);
    }
    options[name] = argv[++index];
  }
  if (!measure.length && !options.out) throw new Error('Pass --out <basename> to render, or --measure <still.png> to measure stills you already have.');
  return { options, measure };
}

async function renderStill({ options, recipe, settings }) {
  const root = resolve(options.worktree);
  const { Client } = await import(pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/client/dist/index.mjs')).href);
  const { StdioClientTransport } = await import(pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/client/dist/stdio.mjs')).href);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/crucible-mcp.mjs'), '--jobs', join(tmpdir(), `crucible-bevel-bands-${process.pid}`)], stderr: 'inherit' });
  const client = new Client({ name: 'measure-glass-bevel-bands', version: '1.0.0' });
  await client.connect(transport);
  try {
    const call = (name, args) => client.callTool({ name, arguments: args }, { timeout: 900000 });
    const created = await call('scene_create', { recipe });
    if (created.isError) throw new Error(created.content?.[0]?.text);
    const submitted = await call('scene_render_submit', { sessionId: created.structuredContent.sessionId, expectedRevision: 0, settings });
    if (submitted.isError) throw new Error(submitted.content?.[0]?.text);
    const { jobId } = submitted.structuredContent;
    for (;;) {
      const record = (await call('scene_render_status', { jobId })).structuredContent;
      if (record.state === 'completed') break;
      if (['cancelled', 'failed'].includes(record.state)) throw new Error(`Render job ${record.state}: ${record.reason}`);
      await delay(300);
    }
    return (await call('scene_render_result', { jobId })).structuredContent.artifacts[0].path;
  } finally {
    await client.close();
  }
}

async function main() {
  const { options, measure } = parseArguments(process.argv.slice(2));
  for (const file of measure) {
    const steps = await measureEdgeSteps(file);
    console.log(file, 'top', steps.topStepsPerLine.toFixed(2), 'left', steps.leftStepsPerLine.toFixed(2));
  }
  if (!options.out) return;
  const recipe = buildBevelBandRecipe({ shape: options.shape, indexOfRefraction: Number(options.ior), thickness: Number(options.thickness) });
  const settings = { kind: 'image', width: Number(options.width), height: Number(options.height) };
  const rendered = await renderStill({ options, recipe, settings });
  const outputBase = resolve(options.out);
  await mkdir(dirname(outputBase), { recursive: true });
  await copyFile(rendered, `${outputBase}.png`);
  const steps = await measureEdgeSteps(`${outputBase}.png`);
  await writeFile(`${outputBase}.json`, JSON.stringify({ shape: options.shape, recipe, settings, steps, backend: 'raster (GPU)' }, null, 1));
  console.log(`${outputBase}.png`, options.shape, 'top', steps.topStepsPerLine.toFixed(2), 'left', steps.leftStepsPerLine.toFixed(2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
