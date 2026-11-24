#!/usr/bin/env node
// Renders tree crowns with the sun behind the tree and beside it, at 8 m and 30 m, so the lighting of the leaves can be judged
// against a photo (issue #2991).
//
//   node scripts/foliage-shading-proof.mjs --out artifacts/2991/after [--reference artifacts/3057/refs] [--width 640] [--height 480]
//        [--subjects oak,birch,forest] [--backend gpu|cpu]
//        [--distances 8,30] [--suns behind,side] [--eye-height m] [--fog-density d] [--ground-color 0.3,0.3,0.3]
//
// Subjects: `oak` and `birch` (one preset tree, seed 4) and `forest` (200 oak trees). For each it renders four stills
// (8 m and 30 m from the trunk, sun behind the tree and sun to the side) and puts them beside a photo from
// `<reference>/<photo folder>/` on a sheet. Every still gets a JSON of the same name with the recipe, camera, sun, size and
// backend. Run it through the GPU lock as a light job.
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { growTree, levelBounds } from './tree-proof-lib.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const SEED = 4;
const FOREST_AREA = 50;
const FOREST_DENSITY = 0.02;
const GROUND_SIZE = 400;
const DEFAULT_GROUND_COLOR = [0.16, 0.24, 0.07];
// `lightDirection` points toward the sun. The camera sits on +z and looks toward -z.
const SUNS = Object.freeze({ behind: [0.12, 0.34, -0.93], side: [0.93, 0.34, 0.12] });
const DEFAULT_DISTANCES = Object.freeze([8, 30]);
const SUBJECTS = Object.freeze({
  oak: { vegetation: { preset: 'oak', seed: SEED }, photoFolder: 'oak', height: null },
  birch: { vegetation: { preset: 'birch', seed: SEED }, photoFolder: 'birch', height: null },
  forest: { vegetation: { preset: 'oak', seed: SEED, scatter: { ground: 'ground', density: FOREST_DENSITY, area: { min: [-FOREST_AREA, -FOREST_AREA], max: [FOREST_AREA, FOREST_AREA] } } }, photoFolder: 'forest', height: 16 },
});
const CELL_WIDTH = 320;
const CELL_HEIGHT = 240;
const LABEL_HEIGHT = 22;

function parseArguments(argv) {
  const options = { fogDensity: null, eyeHeight: null, out: null, reference: 'artifacts/3057/refs', width: 640, height: 480, subjects: Object.keys(SUBJECTS), backend: 'gpu', distances: [...DEFAULT_DISTANCES], suns: Object.keys(SUNS), groundColor: DEFAULT_GROUND_COLOR };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${name} needs a value, such as ${name} 640`);
    if (name === '--eye-height') options.eyeHeight = Number(value);
    else if (name === '--fog-density') options.fogDensity = Number(value);
    else if (name === '--out') options.out = value;
    else if (name === '--reference') options.reference = value;
    else if (name === '--width') options.width = Number(value);
    else if (name === '--height') options.height = Number(value);
    else if (name === '--subjects') options.subjects = value.split(',');
    else if (name === '--backend') options.backend = value;
    else if (name === '--distances') options.distances = value.split(',').map(Number);
    else if (name === '--suns') options.suns = value.split(',');
    else if (name === '--ground-color') options.groundColor = value.split(',').map(Number);
    else throw new Error(`Unknown option ${name}; use --out, --reference, --width, --height, --subjects, --backend, --distances, --suns or --ground-color.`);
  }
  if (!options.out) throw new Error('Pass --out <folder>, such as --out artifacts/2991/after.');
  for (const subject of options.subjects) {
    if (!SUBJECTS[subject]) throw new Error(`Unknown subject ${subject}; use ${Object.keys(SUBJECTS).join(', ')}.`);
  }
  for (const sunName of options.suns) {
    if (!SUNS[sunName]) throw new Error(`Unknown sun ${sunName}; use ${Object.keys(SUNS).join(', ')}.`);
  }
  if (options.groundColor.length !== 3 || options.groundColor.some(Number.isNaN)) throw new Error('--ground-color needs three numbers, such as --ground-color 0.3,0.3,0.3.');
  if (!['gpu', 'cpu'].includes(options.backend)) throw new Error('--backend must be gpu or cpu.');
  return options;
}

function treeHeightOf(subjectName) {
  const subject = SUBJECTS[subjectName];
  if (subject.height) return subject.height;
  const tree = growTree({ preset: subject.vegetation.preset, seed: SEED });
  const bounds = levelBounds(tree, 0);
  return bounds.maximum[1] - bounds.minimum[1];
}

function buildRecipe({ subjectName, distance, sunName, height, groundColor, eyeHeightOverride, fogDensity }) {
  const isForest = subjectName === 'forest';
  const eyeZ = isForest ? FOREST_AREA + distance : distance;
  const eyeHeight = eyeHeightOverride ?? (isForest ? 2 : height * 0.35);
  const targetHeight = height * 0.6;
  const targetZ = 0;
  const viewHeight = height * 1.3;
  const fov = Math.min(70, Math.max(24, 2 * Math.atan(viewHeight / 2 / (eyeZ - targetZ)) * 180 / Math.PI));
  const shadowSpan = isForest ? FOREST_AREA * 2.4 : height * 1.6;
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [isForest ? { id: 'ground', type: 'terrain', size: 200, resolution: 64, seed: 3, amplitude: 1 } : { id: 'ground', type: 'box', bevel: 0 }],
    materials: [{ id: 'soil', color: groundColor, metallic: 0, roughness: 0.95 }],
    nodes: [
      isForest ? { id: 'ground', geometry: 'ground', material: 'soil' } : { id: 'ground', geometry: 'ground', material: 'soil', translation: [0, -0.05, 0], scale: [GROUND_SIZE, 0.1, GROUND_SIZE] },
      { id: 'trees', vegetation: SUBJECTS[subjectName].vegetation },
    ],
    camera: { eye: [0, eyeHeight, eyeZ], target: [0, targetHeight, targetZ], fov },
    environment: { world: true, lightDirection: SUNS[sunName], ...(fogDensity === null ? {} : { fogDensity }) },
    shadow: { target: [0, height / 2, 0], extent: shadowSpan, distance: shadowSpan * 2, far: shadowSpan * 6 },
  };
}

async function waitForJob(call, jobId) {
  for (;;) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (record.state === 'completed') return;
    if (['cancelled', 'failed'].includes(record.state)) throw new Error(`Render job ${record.state}: ${record.reason}`);
    await delay(250);
  }
}

async function renderStills({ options, plans }) {
  const jobsFolder = join(tmpdir(), `crucible-foliage-proof-${process.pid}`);
  const serverArguments = [join(projectRoot, 'bin', 'crucible-mcp.mjs'), '--backend', options.backend, '--memory', '512', '--jobs', jobsFolder];
  const transport = new StdioClientTransport({ command: process.execPath, args: serverArguments, env: { ...process.env, COOK_DISABLE: '1' }, stderr: 'inherit' });
  const client = new Client({ name: 'foliage-shading-proof', version: '1.0.0' });
  await client.connect(transport);
  const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 600000 });
  try {
    for (const plan of plans) {
      const created = await call('scene_create', { recipe: plan.recipe });
      if (created.isError) throw new Error(`${plan.name}: ${created.content?.[0]?.text}`);
      const { sessionId } = created.structuredContent;
      const submitted = await call('scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'image', width: options.width, height: options.height } });
      if (submitted.isError) throw new Error(`${plan.name}: ${submitted.content?.[0]?.text}`);
      await waitForJob(call, submitted.structuredContent.jobId);
      const result = (await call('scene_render_result', { jobId: submitted.structuredContent.jobId })).structuredContent;
      await copyFile(result.artifacts[0].path, plan.stillPath);
      await writeFile(plan.stillPath.replace(/\.png$/, '.json'), JSON.stringify({ ...plan.description, backend: options.backend, size: [options.width, options.height], recipe: plan.recipe }, null, 2));
      await call('scene_render_release', { jobId: submitted.structuredContent.jobId });
      await call('scene_dispose', { sessionId });
      console.log(`rendered ${plan.name}`);
    }
  } finally {
    await client.close();
  }
}

function labelBuffer(text) {
  const safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(`<svg width="${CELL_WIDTH}" height="${LABEL_HEIGHT}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="16" font-family="Arial" font-size="13" fill="#fff">${safeText}</text></svg>`);
}

async function firstPhotoOf(referenceFolder, photoFolder) {
  const folder = join(referenceFolder, photoFolder);
  if (!existsSync(folder)) return null;
  const names = (await readdir(folder)).filter(name => /-leaf-.*\.jpg$/.test(name)).sort();
  return names.length ? join(folder, names[0]) : null;
}

async function writeSheet({ subjectName, plans, photoPath, outputFolder }) {
  const cells = [{ label: photoPath ? `${subjectName}: photo` : `${subjectName}: photo missing`, path: photoPath }];
  for (const plan of plans) cells.push({ label: `${plan.distance} m, sun ${plan.sunName}`, path: plan.stillPath });
  const composites = [];
  for (let column = 0; column < cells.length; column++) {
    composites.push({ input: labelBuffer(cells[column].label), left: column * CELL_WIDTH, top: 0 });
    if (!cells[column].path) continue;
    const picture = await sharp(cells[column].path).resize(CELL_WIDTH, CELL_HEIGHT, { fit: 'cover' }).toBuffer();
    composites.push({ input: picture, left: column * CELL_WIDTH, top: LABEL_HEIGHT });
  }
  const sheetPath = join(outputFolder, `sheet-${subjectName}.jpg`);
  await sharp({ create: { width: cells.length * CELL_WIDTH, height: CELL_HEIGHT + LABEL_HEIGHT, channels: 3, background: '#000' } }).composite(composites).jpeg({ quality: 88 }).toFile(sheetPath);
  return sheetPath;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const outputFolder = resolve(options.out);
  const referenceFolder = resolve(options.reference);
  await mkdir(outputFolder, { recursive: true });
  const bySubject = options.subjects.map((subjectName) => {
    const height = treeHeightOf(subjectName);
    const plans = [];
    for (const distance of options.distances) {
      for (const sunName of options.suns) {
        const name = `${subjectName}-${distance}m-${sunName}`;
        plans.push({
          name, distance, sunName, stillPath: join(outputFolder, `${name}.png`),
          recipe: buildRecipe({ subjectName, distance, sunName, height, groundColor: options.groundColor, eyeHeightOverride: options.eyeHeight, fogDensity: options.fogDensity }),
          description: { subject: subjectName, seed: SEED, distance, sun: SUNS[sunName], sunName, treeHeight: height },
        });
      }
    }
    return { subjectName, plans };
  });
  await renderStills({ options, plans: bySubject.flatMap(entry => entry.plans) });
  for (const { subjectName, plans } of bySubject) {
    const photoPath = await firstPhotoOf(referenceFolder, SUBJECTS[subjectName].photoFolder);
    console.log(`sheet: ${await writeSheet({ subjectName, plans, photoPath, outputFolder })}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
