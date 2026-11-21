// Stage 1 preview of the Dutch galleon on Crucible water (#2758). Builds the recipe, writes a still and a short clip through the MCP render job.
// Usage: node build.mjs [--still-only] [--width 480] [--height 270] [--duration 6] [--fps 24] [--still-time 2.5] [--out <folder>]
// The folder holds assets/galleon.glb (CC0 Dutch ship, see the issue branch CREDITS.md) and assets/sky.hdr (Poly Haven kloofendal_48d_partly_cloudy_puresky, CC0).
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const width = Number(option('width', 480));
const height = Number(option('height', 270));
const duration = Number(option('duration', 6));
const framesPerSecond = Number(option('fps', 24));
const stillTime = Number(option('still-time', 2.5));
const outputFolder = resolve(option('out', 'artifacts/2758-galleon'));
const assetFolder = join(outputFolder, 'assets');
const jobsFolder = join(outputFolder, 'jobs');
const draft = Number(option('draft', 3.4));
const seaSize = 300;
const seaTag = option('tag', 'preview');

// The ship is 34 m long, bow toward +x, keel at y = 0 and its middle at x = 3.3 in the GLB.
const SHIP_HALF_LENGTH = 17.1;
const SHIP_HALF_WIDTH = 4.2;
const SHIP_MIDDLE_X = 3.3;

/** Half width of the hull at the waterline, `x` metres along the ship from its middle; the bow (+x) is narrower. */
function waterlineHalfWidth(x) {
  const fraction = x / SHIP_HALF_LENGTH;
  const rounded = SHIP_HALF_WIDTH * Math.sqrt(Math.max(0, 1 - fraction * fraction));
  return fraction > 0 ? rounded * (1 - 0.45 * fraction) : rounded;
}

/** Foam points [x, z, strength, width] around the hull, along the wake behind the stern and along the two bow-wave arms. */
function wakePoints() {
  const points = [];
  for (let x = -SHIP_HALF_LENGTH + 1; x <= SHIP_HALF_LENGTH - 0.5; x += 3.6) {
    const halfWidth = waterlineHalfWidth(x);
    points.push([x, halfWidth, 0.9, 2.2], [x, -halfWidth, 0.9, 2.2]);
  }
  points.push([SHIP_HALF_LENGTH + 1.2, 0, 1, 2.6]);
  for (let step = 1; step <= 11; step += 1) {
    const behind = step * 6;
    points.push([-SHIP_HALF_LENGTH - behind + 4, 0, Math.max(0.2, 0.95 - step * 0.07), 3 + step * 0.9]);
  }
  for (let step = 1; step <= 7; step += 1) {
    const behind = step * 7;
    const spread = SHIP_HALF_WIDTH + behind * 0.34;
    const strength = Math.max(0.25, 0.85 - step * 0.08);
    points.push([SHIP_HALF_LENGTH - behind, spread, strength, 2 + step * 0.4], [SHIP_HALF_LENGTH - behind, -spread, strength, 2 + step * 0.4]);
  }
  return points;
}

const SEA_EDITS = [
  { op: 'subdivide_edges', edges: { all: true }, cuts: 16 },
  { op: 'delete', select: { not: { normal: [0, 1, 0], maxAngle: 10 } } },
  { op: 'subdivide', levels: 4 },
  { op: 'set_position', position: { mul: [{ attr: 'position' }, [seaSize, 1, seaSize]] } },
];

// A round soft puff from the card's own uv, so a flat card reads as a cloud of spray and not a square.
const PUFF_SNIPPET = 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n'
  + '  float distanceFromMiddle = length(uv - vec2(0.5)) * 2.0;\n'
  + '  alpha *= smoothstep(1.0, 0.15, distanceFromMiddle);\n}';

function buildRecipe(shipAssetId, skyAssetId) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [
      { id: 'sea', type: 'mesh', base: { type: 'box', bevel: 0 }, edits: SEA_EDITS,
        stack: [{ op: 'ocean', windSpeed: 9, choppiness: 1.6, size: 60, seed: 11, resolution: 5, spray: true, wake: { points: wakePoints(), height: 0.25 } }] },
      { id: 'card', type: 'plane', segments: 1 },
    ],
    materials: [
      { id: 'water', color: [0.004, 0.03, 0.07], tag: 'water', waterPreset: 'sea', roughness: 0.08, turbidity: 0.25 },
      { id: 'spray', tag: 'unlit', color: [0.92, 0.96, 1], alphaMode: 'add', opacity: 0.9, doubleSided: true, snippet: { fragment: PUFF_SNIPPET } },
      { id: 'mist', tag: 'unlit', color: [0.85, 0.9, 0.95], alphaMode: 'blend', opacity: 0.16, doubleSided: true, snippet: { fragment: PUFF_SNIPPET } },
    ],
    nodes: [
      { id: 'sea', geometry: 'sea', material: 'water' },
      { id: 'ship', asset: { id: shipAssetId }, translation: [-SHIP_MIDDLE_X, -draft, 0] },
      { id: 'bow-spray', geometry: 'card', material: 'spray' },
      { id: 'low-mist', geometry: 'card', material: 'mist' },
    ],
    camera: { eye: [32, 4.2, -30], target: [3, 9, 0], fov: 42 },
    environment: {
      world: true, hdri: skyAssetId, environmentIntensity: 1, environmentRotation: 0,
      keyIntensity: 1, lightDirection: [0.5, 0.7, -0.4], keyColor: [2.4, 2.1, 1.8], fogColor: [0.5, 0.62, 0.76], fogDensity: 0.0009,
    },
    particles: {
      systems: [
        { node: 'bow-spray', seed: 7, count: 2000, rate: 260, lifetime: [0.7, 1.4], speed: [2, 6], spread: 55, size: [0.8, 2.4], drag: 0.6, orient: 'random', scale: 'grow',
          emitter: { shape: 'box', position: [SHIP_HALF_LENGTH - 3, 0.4, 0], halfExtents: [3.2, 0.3, 2.4] }, direction: [0.3, 1, 0] },
        { node: 'low-mist', seed: 3, count: 400, rate: 55, lifetime: [4, 7], speed: [0.2, 0.9], spread: 90, size: [4, 9], drag: 1, orient: 'random',
          emitter: { shape: 'box', position: [0, 1.2, 0], halfExtents: [60, 0.8, 40] }, direction: [1, 0.1, 0] },
      ],
    },
    motion: {
      duration,
      tracks: [
        { kind: 'geometry', id: 'sea', property: 'oceanTime', interpolation: 'LINEAR', keyframes: [{ time: 0, value: 0 }, { time: duration, value: duration }] },
        { kind: 'camera', property: 'eye', interpolation: 'LINEAR', keyframes: [{ time: 0, value: [32, 4.2, -30] }, { time: duration, value: [26, 3.6, -36] }] },
      ],
    },
  };
}

await mkdir(jobsFolder, { recursive: true });
const serverArguments = [resolve('bin/crucible-mcp.mjs'), '--backend', 'gpu', '--memory', '768', '--assets', assetFolder, '--jobs', jobsFolder];
if (process.env.CHROME_PATH) serverArguments.push('--browser', process.env.CHROME_PATH);
const transport = new StdioClientTransport({ command: process.execPath, args: serverArguments, stderr: 'inherit', env: { ...process.env, COOK_DISABLE: '1' } });
const client = new Client({ name: 'crucible-galleon-preview', version: '1' });

async function call(name, argumentsValue = {}, timeout = 120000) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout });
  if (result.isError) throw new Error(`${name}: ${result.content?.find(item => item.type === 'text')?.text}`);
  return result;
}

try {
  await client.connect(transport);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  const ship = catalog.assets.find(asset => JSON.stringify(asset).includes('galleon'));
  const sky = catalog.assets.find(asset => JSON.stringify(asset).includes('sky.hdr'));
  if (!ship || !sky) throw new Error(`The catalog lacks the galleon or the sky: ${JSON.stringify(catalog).slice(0, 500)}`);
  const created = (await call('scene_create', { recipe: buildRecipe(ship.assetId, sky.assetId) }, 300000)).structuredContent;
  const inspected = (await call('scene_inspect', { sessionId: created.sessionId })).structuredContent;
  console.log(JSON.stringify({ particles: inspected.particles, warnings: inspected.warnings }).slice(0, 1500));
  const still = (await call('scene_look', { sessionId: created.sessionId, width: 960, height: 540, motionTime: stillTime }, 300000)).content.find(item => item.type === 'image');
  await writeFile(join(outputFolder, `galleon-${seaTag}.png`), Buffer.from(still.data, 'base64'));
  console.log(`wrote galleon-${seaTag}.png`);
  if (process.argv.includes('--still-only')) {
    await client.close();
    process.exit(0);
  }
  const job = (await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision ?? 0, settings: { kind: 'video', width, height, fps: framesPerSecond, duration, motion: { start: 0 } } })).structuredContent;
  for (;;) {
    const state = (await call('scene_render_status', { jobId: job.jobId })).structuredContent;
    if (['completed', 'failed', 'cancelled'].includes(state.state)) {
      if (state.state !== 'completed') throw new Error(`Render ${state.state}: ${JSON.stringify(state).slice(0, 600)}`);
      break;
    }
    await delay(1000);
  }
  const result = (await call('scene_render_result', { jobId: job.jobId })).structuredContent;
  console.log(JSON.stringify(result).slice(0, 800));
  await client.close();
  process.exit(0);
} catch (error) {
  console.error(String(error.stack ?? error));
  process.exit(1);
}
