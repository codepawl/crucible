// usage: node shoot8.mjs <outdir> <rt|pt> [fileFilter]   Renders the r8 demo stills (realtime Glaze or the path tracer) through the MCP server.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const hue = color => { const largest = Math.max(...color); return color.map(channel => (channel / largest) ** 3); };
const red = [0.8, 0.1, 0.08];
const blue = [0.1, 0.3, 0.9];
const cyan = [0.2, 1, 0.9];
const names = ['smoothPlastic', 'wood', 'grass', 'neon', 'glass', 'brick'];
const bloomOn = { strength: Number(process.env.BLOOM_STRENGTH ?? 1), threshold: Number(process.env.BLOOM_THRESHOLD ?? 0.8), radius: Number(process.env.BLOOM_RADIUS ?? 3) };
const bloomOff = { strength: 0 };
const GREY = { id: 'backdrop', color: [0.35, 0.35, 0.35], roughness: 1, metallic: 0 };
const CHECKER = { id: 'backdrop', color: [1, 1, 1], roughness: 0.9, pattern: { type: 'graph', size: 1.2, graph: { color: { ramp: { value: { checker: { count: 4 } }, stops: [[0, [0.12, 0.12, 0.16]], [1, [0.92, 0.92, 0.92]]] } } } } };
const wallNode = { id: 'backdrop', geometry: 'cube', material: 'backdrop', translation: [0, 1.2, -1.6], scale: [40, 40, 0.2] };

function rowShot(file, tint, bloom) {
  const cubes = names.map((preset, index) => ({
    id: `${preset}`, material: { preset, ...(tint ? { color: tint } : {}) }, translation: [(index - 2.5) * 1.4, 1.2, 0], scale: [1.2, 1.2, 1.2], round: preset === 'glass',
  }));
  const lights = [{ position: [(3 - 2.5) * 1.4, 1.2, -0.9], color: hue(tint ?? cyan), intensity: 8 }];
  return { file, width: 1080, height: 1080, backdrop: { materials: [GREY], nodes: [wallNode] }, camera: { eye: [0, 1.2, 16], target: [0, 1.2, 0], fov: 32 }, effects: { bloom }, environment: { pointLights: lights, sunAngularRadius: 0.04 }, shadow: { target: [0, 1.2, 0], extent: 6 }, cubes };
}
function glassShot(file, backdrop) {
  const cubes = [red, blue, null].map((tint, index) => ({ id: `glass-${index}`, material: { preset: 'glass', ...(tint ? { color: tint } : {}) }, translation: [(index - 1) * 1.6, 1.2, 0], scale: [1.3, 1.3, 1.3], round: true }));
  return { file, width: 1080, height: 1080, backdrop, camera: { eye: [0, 1.2, 8.5], target: [0, 1.2, 0], fov: 32 }, effects: { bloom: { strength: 0.12 } }, shadow: { target: [0, 1.2, 0], extent: 4 }, cubes };
}
export const shots = [
  rowShot('row-red.png', red, bloomOn), rowShot('row-blue.png', blue, bloomOn), rowShot('row-default.png', null, bloomOn),
  rowShot('row-red-nobloom.png', red, bloomOff), rowShot('row-blue-nobloom.png', blue, bloomOff), rowShot('row-default-nobloom.png', null, bloomOff),
  { file: 'grass-face.png', width: 1080, height: 1080, backdrop: { materials: [GREY], nodes: [wallNode] }, camera: { eye: [0, 1.2, 4.5], target: [0, 1.2, 0], fov: 32 }, effects: { bloom: { strength: 0.12 } }, environment: { sunAngularRadius: 0.04 }, shadow: { target: [0, 1.2, 0], extent: 4 }, cubes: [{ id: 'grass', material: { preset: 'grass' }, translation: [0, 1.2, 0], scale: [1.2, 1.2, 1.2] }] },
  glassShot('glass-grey.png', { materials: [GREY], nodes: [wallNode] }),
  glassShot('glass-checker.png', { materials: [CHECKER], nodes: [wallNode] }),
];
export function recipeOf(shot) {
  const materials = [...shot.backdrop.materials];
  const nodes = [...shot.backdrop.nodes];
  for (const cube of shot.cubes) {
    materials.push({ id: cube.id, ...cube.material });
    nodes.push({ id: cube.id, geometry: cube.round ? 'round' : 'cube', material: cube.id, translation: cube.translation, scale: cube.scale });
  }
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }, { id: 'round', type: 'box', bevel: 0.2 }], materials, nodes,
    camera: shot.camera, effects: shot.effects, ...(shot.environment ? { environment: shot.environment } : {}), shadow: shot.shadow,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const out = resolve(process.argv[2]);
  const mode = process.argv[3];
  const filter = process.argv[4] ?? '';
  await mkdir(out, { recursive: true });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin/crucible-mcp.mjs'), '--backend', 'gpu', '--jobs', join(out, 'jobs')], cwd: out, stderr: 'pipe' });
  const client = new Client({ name: 'p3234-r8', version: '1' });
  await client.connect(transport);
  try {
    for (const shot of shots.filter(candidate => candidate.file.includes(filter))) {
      if (mode === 'pt' && shot.file.includes('nobloom')) continue;
      const created = await client.callTool({ name: 'scene_create', arguments: { recipe: recipeOf(shot) } }, { timeout: 300000 });
      if (created.isError) throw new Error(JSON.stringify(created.content).slice(0, 1500));
      const sessionId = created.structuredContent.sessionId;
      const settings = { kind: 'image', width: shot.width, height: shot.height };
      if (mode === 'pt') settings.renderer = { type: 'pathTracer', backend: process.env.PT_BACKEND ?? 'gpu', samples: Number(process.env.PT_SAMPLES ?? 192), bounces: 10, denoise: true, maxSeconds: 400 };
      else settings.quality = 'realtime';
      const submitted = await client.callTool({ name: 'scene_render_submit', arguments: { sessionId, expectedRevision: created.structuredContent.revision ?? 0, settings } }, { timeout: 300000 });
      if (submitted.isError) throw new Error(JSON.stringify(submitted.content).slice(0, 1500));
      const jobId = submitted.structuredContent.jobId;
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const status = await client.callTool({ name: 'scene_render_status', arguments: { jobId } }, { timeout: 60000 });
        const state = status.structuredContent?.state ?? status.structuredContent?.status;
        if (['succeeded', 'completed', 'done', 'failed', 'cancelled'].includes(state)) { if (state === 'failed') throw new Error(JSON.stringify(status.structuredContent).slice(0, 800)); break; }
        await new Promise(resolveWait => setTimeout(resolveWait, 1000));
      }
      const result = await client.callTool({ name: 'scene_render_result', arguments: { jobId } }, { timeout: 60000 });
      const parsed = JSON.parse(result.content[0].text);
      const target = mode === 'pt' ? shot.file.replace('.png', '-pt.png') : shot.file;
      await copyFile(parsed.artifacts[0].path, join(out, target));
      console.log('wrote', target, JSON.stringify(parsed.metrics?.pathTracer?.denoiser ?? ''));
      await client.callTool({ name: 'scene_dispose', arguments: { sessionId } });
    }
  } finally { await client.close(); }
}
