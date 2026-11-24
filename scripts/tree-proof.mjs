#!/usr/bin/env node
// Renders every tree preset beside a real summer photo of the species and prints the numbers that explain the gap (#3041).
//
//   (add --from-crown-edge to measure each --distances value from the crown's near edge instead of the trunk)
//   node scripts/tree-proof.mjs --out artifacts/3041/proof [--reference artifacts/3041/reference] [--seed 4]
//        [--presets oak,ash] [--tree '{"leafSize":0.85}'] [--distances 20,70] [--width 640] [--height 480] [--backend gpu|cpu] [--measure-only]
//        [--sun behind|side|both]
//   node scripts/tree-proof.mjs --crowns [--reference artifacts/3057/refs] [--presets oak,ash,aspen,birch] [--level 0] [--seed 4]
//
// --crowns prints the crown metrics (hull fill, bays, sky hole, width over height, widest row; see tree-proof-lib.mjs) of the
// reference photos and of the model, per species, with the photo band and the metrics the model misses. No GPU needed.
// Photos sit outside the repository: `<reference>/<species>/credits.json` is `{ "photos": [{ file, kind: "leaf"|"bare", url, author,
// licence, crop: [left, top, width, height] as fractions, treeHeightFraction }] }`.
//
// For each preset it measures triangles, crown solidity and painted leaf length of every level on the CPU, renders a still
// just inside and just outside each level switch (a level camera, sun behind the camera, ground and shadow, framed so the
// tree fills the same share of the picture as the tree in the photo) and puts the stills beside the photo on a sheet.
// Photos are read from `<reference>/<preset>/`: `<preset>.jpg` and `credits.json` (URL, author, licence and
// `treeHeightFraction`, the share of the photo height the tree fills). Photos are never part of the repository.
// Every still gets a JSON of the same name with the recipe, camera, sun, size, backend and seed.
// On a shared machine run it through the GPU lock as a light job, so it does not compete with other renders.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { TREE_LEVEL_DISTANCES } from '../src/vegetation-species.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  DEFAULT_LEVEL_MARGIN, DEFAULT_SEED, PRESET_NAMES, bandFailures, fitFraming, formatCrownTable, formatProofTable, growTree, levelBounds, levelCameraEye,
  levelProbes, measureTreeLevels, modelCrownMetrics, photoBand, photoCrownMetrics,
} from './tree-proof-lib.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
// `lightDirection` points toward the sun. The camera looks toward -z, so this sun stands high on the camera's right: it lights
// the side of the tree the photo shows and throws the shadow to the left and behind the trunk, onto ground the camera sees.
const SUN_DIRECTIONS = Object.freeze({ behind: [0.6, 0.6, 0.45], side: [1, 0.55, -0.1] });
const CROWN_SPECIES = Object.freeze(['oak', 'ash', 'aspen', 'birch']);
const GROUND_SIZE = 300;
const GRASS_COLOR = [0.16, 0.24, 0.07];
const SHEET_CELL_WIDTH = 320;
const SHEET_CELL_HEIGHT = 240;
const SHEET_LABEL_HEIGHT = 22;
const FALLBACK_HEIGHT_FRACTION = 0.8;

function parseArguments(argv) {
  const options = { out: null, crowns: false, fromCrownEdge: false, sun: 'behind', level: 0, reference: 'artifacts/3057/refs', seed: DEFAULT_SEED, presets: PRESET_NAMES, width: 640, height: 480, backend: 'gpu', measureOnly: false, tree: undefined, distances: undefined };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--measure-only') {
      options.measureOnly = true;
      continue;
    }
    if (name === '--from-crown-edge') {
      options.fromCrownEdge = true;
      continue;
    }
    if (name === '--crowns') {
      options.crowns = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`${name} needs a value, such as ${name} 4`);
    if (name === '--out') options.out = value;
    else if (name === '--reference') options.reference = value;
    else if (name === '--sun') options.sun = value;
    else if (name === '--level') options.level = Number(value);
    else if (name === '--seed') options.seed = Number(value);
    else if (name === '--presets') options.presets = value.split(',');
    else if (name === '--width') options.width = Number(value);
    else if (name === '--height') options.height = Number(value);
    else if (name === '--backend') options.backend = value;
    else if (name === '--distances') options.distances = value.split(',').map(Number);
    else if (name === '--tree') options.tree = JSON.parse(value);
    else throw new Error(`Unknown option ${name}; use --out, --reference, --seed, --presets, --tree, --distances, --width, --height, --backend, --sun, --level, --crowns, --from-crown-edge or --measure-only.`);
  }
  if (options.crowns && options.presets === PRESET_NAMES) options.presets = [...CROWN_SPECIES];
  if (!options.out && !options.crowns) throw new Error('Pass --out <folder>, such as --out artifacts/3041/proof.');
  if (!['behind', 'side', 'both'].includes(options.sun)) throw new Error('--sun must be behind, side or both.');
  if (!Number.isInteger(options.level) || options.level < 0) throw new Error('--level must be a whole number from 0, such as --level 0.');
  for (const preset of options.presets) {
    if (!PRESET_NAMES.includes(preset)) throw new Error(`Unknown preset ${preset}; use ${PRESET_NAMES.join(', ')}.`);
  }
  if (!Number.isFinite(options.seed)) throw new Error('--seed must be a number, such as 4.');
  if (options.distances && options.distances.some(distance => !(distance > 0))) throw new Error('--distances must be meters above 0, such as --distances 20,70.');
  if (!['gpu', 'cpu'].includes(options.backend)) throw new Error('--backend must be gpu or cpu.');
  return options;
}

async function readCredits(referenceFolder, preset) {
  const creditsPath = join(referenceFolder, preset, 'credits.json');
  if (!existsSync(creditsPath)) return null;
  const parsed = JSON.parse(await readFile(creditsPath, 'utf8'));
  // The sheet shows the first in-leaf photo; the older single-photo file is still read.
  const credits = parsed.photos ? (parsed.photos.find(photo => photo.kind === 'leaf') ?? parsed.photos[0]) : parsed;
  return { ...credits, photoPath: join(referenceFolder, preset, credits.file) };
}

function buildRecipe({ preset, seed, tree, bounds, shadowHeight, distance, heightFraction, aspect, sun }) {
  const { fov, centerX, centerY } = fitFraming({ bounds, aspect, photoFraction: heightFraction, distance });
  const eye = levelCameraEye({ centerX, centerY, distance });
  const target = [centerX, centerY, 0];
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box', bevel: 0 }],
    materials: [{ id: 'soil', color: GRASS_COLOR, metallic: 0, roughness: 0.95 }],
    nodes: [
      { id: 'ground', geometry: 'ground', material: 'soil', translation: [0, -0.05, 0], scale: [GROUND_SIZE, 0.1, GROUND_SIZE] },
      { id: 'tree', vegetation: { preset, seed, ...(tree === undefined ? {} : { tree }) } },
    ],
    camera: { eye, target, fov },
    environment: { world: true, lightDirection: SUN_DIRECTIONS[sun] },
    // The default shadow view is 3.5 m wide; this one covers the crown and its shadow on the ground.
    shadow: { target: [0, shadowHeight / 2, 0], extent: shadowHeight * 1.6, distance: shadowHeight * 3, far: shadowHeight * 8 },
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

async function renderStills({ options, plans, outputFolder }) {
  const jobsFolder = join(tmpdir(), `crucible-tree-proof-${process.pid}`);
  const serverArguments = [join(projectRoot, 'bin', 'crucible-mcp.mjs'), '--backend', options.backend, '--memory', '256', '--jobs', jobsFolder];
  const transport = new StdioClientTransport({ command: process.execPath, args: serverArguments, env: { ...process.env, COOK_DISABLE: '1' }, stderr: 'inherit' });
  const client = new Client({ name: 'tree-proof', version: '1.0.0' });
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
      await writeFile(plan.stillPath.replace(/\.png$/, '.json'), JSON.stringify(plan.description, null, 2));
      // The server keeps a bounded number of job records; free this one once its picture is copied.
      await call('scene_render_release', { jobId: submitted.structuredContent.jobId });
      await call('scene_dispose', { sessionId });
      console.log(`rendered ${plan.name}`);
    }
  } finally {
    await client.close();
  }
  return outputFolder;
}

function labelBuffer(text, width) {
  const safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(`<svg width="${width}" height="${SHEET_LABEL_HEIGHT}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="16" font-family="Arial" font-size="13" fill="#fff">${safeText}</text></svg>`);
}

async function composeRow({ preset, credits, plans, rowTop }) {
  const cells = [];
  if (credits && existsSync(credits.photoPath)) {
    cells.push({ label: `${preset}: photo ${credits.licence}, ${credits.author?.slice(0, 22) ?? ''}`, path: credits.photoPath });
  } else {
    cells.push({ label: `${preset}: photo missing`, path: null });
  }
  for (const plan of plans) cells.push({ label: `${preset} level ${plan.level}, ${plan.distance.toFixed(1)} m, ${plan.sun} sun`, path: plan.stillPath });
  const composites = [];
  for (let column = 0; column < cells.length; column++) {
    const left = column * SHEET_CELL_WIDTH;
    composites.push({ input: labelBuffer(cells[column].label, SHEET_CELL_WIDTH), left, top: rowTop });
    if (!cells[column].path) continue;
    const picture = await sharp(cells[column].path).resize(SHEET_CELL_WIDTH, SHEET_CELL_HEIGHT, { fit: 'contain', background: '#000' }).toBuffer();
    composites.push({ input: picture, left, top: rowTop + SHEET_LABEL_HEIGHT });
  }
  return { composites, width: cells.length * SHEET_CELL_WIDTH };
}

async function writeSheets({ presetResults, outputFolder }) {
  const rowHeight = SHEET_CELL_HEIGHT + SHEET_LABEL_HEIGHT;
  const rows = [];
  for (const result of presetResults) rows.push(await composeRow({ preset: result.preset, credits: result.credits, plans: result.plans, rowTop: 0 }));
  const width = Math.max(...rows.map(row => row.width));
  for (let index = 0; index < rows.length; index++) {
    await sharp({ create: { width, height: rowHeight, channels: 3, background: '#000' } }).composite(rows[index].composites).jpeg({ quality: 86 }).toFile(join(outputFolder, `sheet-${presetResults[index].preset}.jpg`));
  }
  const stacked = [];
  for (let index = 0; index < presetResults.length; index++) {
    const row = await composeRow({ preset: presetResults[index].preset, credits: presetResults[index].credits, plans: presetResults[index].plans, rowTop: index * rowHeight });
    stacked.push(...row.composites);
  }
  const sheetPath = join(outputFolder, 'sheet.jpg');
  await sharp({ create: { width, height: rowHeight * presetResults.length, channels: 3, background: '#000' } }).composite(stacked).jpeg({ quality: 86 }).toFile(sheetPath);
  return sheetPath;
}

// The crown metrics of the photos and of the model, per species: the photo band and what the model misses.
async function printCrowns(options) {
  const referenceFolder = resolve(options.reference);
  const lines = [];
  for (const species of options.presets) {
    const photoRows = await photoCrownMetrics(referenceFolder, species);
    const modelMetrics = modelCrownMetrics(growTree({ preset: species, seed: options.seed, tree: options.tree }), options.level);
    const rows = [...photoRows.map(row => ({ ...row, source: `photo ${row.source}` })), { species, source: `model seed ${options.seed} level ${options.level}`, kind: 'leaf', ...modelMetrics }];
    lines.push(formatCrownTable(rows));
    const leafCount = photoRows.filter(row => row.kind === 'leaf').length;
    if (leafCount === 0) {
      lines.push(`${species}: no in-leaf photo under ${referenceFolder}`, '');
      continue;
    }
    const band = photoBand(photoRows);
    const failures = bandFailures(modelMetrics, band);
    lines.push(`${species} band (${leafCount} leaf, ${photoRows.length - leafCount} bare photos): ${Object.entries(band).map(([name, [low, high]]) => `${name} ${low.toFixed(2)}-${high.toFixed(2)}`).join(', ')}`);
    lines.push(`${species} model ${failures.length === 0 ? 'inside the band' : `outside the band on ${failures.join(', ')}`}`, '');
  }
  console.log(lines.join('\n'));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.crowns) {
    await printCrowns(options);
    return;
  }
  const outputFolder = resolve(options.out);
  const referenceFolder = resolve(options.reference);
  await mkdir(outputFolder, { recursive: true });
  const probes = options.distances ? options.distances.map(distance => ({ level: TREE_LEVEL_DISTANCES.filter(threshold => threshold <= distance).length, distance, side: 'at' })) : levelProbes(undefined, DEFAULT_LEVEL_MARGIN);
  const rows = [];
  const presetResults = [];
  for (const preset of options.presets) {
    rows.push(...measureTreeLevels({ preset, seed: options.seed, tree: options.tree }));
    const credits = await readCredits(referenceFolder, preset);
    const tree = growTree({ preset, seed: options.seed, tree: options.tree });
    const shadowHeight = tree.bounds.maximum[1] - tree.bounds.minimum[1];
    const heightFraction = credits?.treeHeightFraction ?? FALLBACK_HEIGHT_FRACTION;
    await mkdir(join(outputFolder, preset), { recursive: true });
    const suns = options.sun === 'both' ? ['behind', 'side'] : [options.sun];
    // A broad crown reaches past 10 m from its trunk: with --from-crown-edge a probe distance is measured from the crown's near edge, so the camera stays outside it.
    const crownBounds = levelBounds(tree, 0);
    const edgeReach = options.fromCrownEdge ? Math.max(crownBounds.maximum[2], -crownBounds.minimum[2]) : 0;
    const plans = probes.flatMap(probe => suns.map((sun) => {
      const recipe = buildRecipe({ preset, seed: options.seed, tree: options.tree, bounds: levelBounds(tree, probe.level), shadowHeight, distance: probe.distance + edgeReach, heightFraction, aspect: options.width / options.height, sun });
      const name = `${preset}-level${probe.level}-${probe.distance.toFixed(1)}m${sun === 'behind' ? '' : `-${sun}`}`;
      return {
        name, level: probe.level, distance: probe.distance, sun, recipe,
        stillPath: join(outputFolder, preset, `${name}.png`),
        description: {
          preset, seed: options.seed, tree: options.tree ?? null, level: probe.level, distance: probe.distance, side: probe.side, backend: options.backend,
          size: [options.width, options.height], camera: recipe.camera, sun: SUN_DIRECTIONS[sun], treeHeightFraction: heightFraction,
          photo: credits ? { url: credits.url, author: credits.author, licence: credits.licence } : null, recipe,
        },
      };
    }));
    presetResults.push({ preset, credits, plans });
  }
  const table = formatProofTable(rows);
  console.log(table);
  await writeFile(join(outputFolder, 'table.txt'), `${table}\n`);
  await writeFile(join(outputFolder, 'table.json'), JSON.stringify(rows, null, 2));
  if (options.measureOnly) return;
  await renderStills({ options, plans: presetResults.flatMap(result => result.plans), outputFolder });
  console.log(`sheet: ${await writeSheets({ presetResults, outputFolder })}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
