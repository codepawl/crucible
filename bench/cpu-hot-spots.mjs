// Times the JavaScript loops that run on the main thread and could move off it (#3419).
//
//   node bench/cpu-hot-spots.mjs [--runs 5] [--json out.json] [--tiny] [--only <id>[,<id>]] [--list]
//
// Each candidate runs on fixed seeds and fixed sizes: one warm-up, then the median of --runs timed runs. Setup (building
// the input) is outside the timer. The table is sorted by median milliseconds, slowest first. --tiny shrinks every size
// so the whole script finishes in about a second (the unit test uses it); --json writes the same rows as JSON.

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { box, sphere } from '../src/geometry.js';
import { loadAllAgentSceneModules } from '../src/agent-scene.js';
import { bakeLightmaps } from '../src/light-bake.js';
import { buildTriangleBvh } from '../src/triangle-bvh.js';
import { applyMeshEdits, selectFaces, meshFromGeometry } from '../src/mesh.js';
import { growSelection, selectLinked, shrinkSelection } from '../src/mesh-select-topology.js';
import { loadMeshBooleans } from '../src/mesh-boolean.js';
import { createTerrain } from '../src/terrain.js';
import { surfaceMap } from '../src/material-surface-map.js';
import { createTree, scatterVegetation } from '../src/vegetation.js';
import { groundCoverParts, normalizeGroundCover } from '../src/ground-cover.js';

const DEFAULT_RUNS = 5;
const MAX_RUNS = 50;

// Every size is bounded: a caller cannot ask for more than the cap, so a typo cannot start a run that never ends.
const SIZES = {
  full: {
    bakeSamples: 32, bakeTexelsPerUnit: 8, bakeMaxResolution: 128,
    bvhSegments: 360, bvhRings: 180,
    meshSegments: 640, meshRings: 320,
    terrainSize: 1024, terrainChunks: 8, terrainResolution: 48, snowMaskResolution: 512,
    treeCount: 24, scatterArea: 300, scatterDensity: 0.02, coverHalfWidth: 40, coverDensity: 150,
  },
  tiny: {
    bakeSamples: 2, bakeTexelsPerUnit: 1, bakeMaxResolution: 8,
    bvhSegments: 16, bvhRings: 8,
    meshSegments: 16, meshRings: 8,
    terrainSize: 64, terrainChunks: 2, terrainResolution: 8, snowMaskResolution: 32,
    treeCount: 1, scatterArea: 20, scatterDensity: 0.01, coverHalfWidth: 2, coverDensity: 20,
  },
};

const SIZE_CAPS = {
  bakeSamples: 256, bakeTexelsPerUnit: 32, bakeMaxResolution: 512,
  bvhSegments: 1000, bvhRings: 500,
  meshSegments: 800, meshRings: 400,
  terrainSize: 4096, terrainChunks: 16, terrainResolution: 128, snowMaskResolution: 2048,
  treeCount: 200, scatterArea: 1000, scatterDensity: 0.1, coverHalfWidth: 200, coverDensity: 500,
};

const IDENTITY_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function checkedSizes(sizes) {
  for (const [name, cap] of Object.entries(SIZE_CAPS)) {
    if (!(sizes[name] > 0 && sizes[name] <= cap)) throw new RangeError(`Size ${name} must be above 0 and at most ${cap}; got ${sizes[name]}.`);
  }
  return sizes;
}

function placedBox(name, translation, scale) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: box(0, 1), matrix, material: { tag: 'surface', color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.8, emission: 0 } };
}

function closedRoom() {
  return [
    placedBox('floor', [0, -0.05, 0], [6, 0.1, 6]),
    placedBox('ceiling', [0, 3.05, 0], [6, 0.1, 6]),
    placedBox('back', [0, 1.5, -3.05], [6, 3.2, 0.1]),
    placedBox('left', [-3.05, 1.5, 0], [0.1, 3.2, 6]),
    placedBox('right', [3.05, 1.5, 0], [0.1, 3.2, 6]),
    placedBox('front', [0, 1.5, 3.05], [6, 3.2, 0.1]),
    placedBox('divider', [0, 1.5, 0], [0.1, 3, 3]),
  ];
}

const ROOM_LAMP = { pointLights: [{ position: [-1.5, 2.5, 0], color: [1, 1, 1], intensity: 8, radius: 0.05 }], keyColor: [0, 0, 0] };

function heavyMesh(sizes) {
  return meshFromGeometry(sphere(sizes.meshSegments, sizes.meshRings));
}

function meshLabel(sizes) {
  return `${(sizes.meshSegments * sizes.meshRings).toLocaleString('en-US')}-face sphere`;
}

// Faces whose normal is within 37 degrees of straight up: the cap holds (1 - cos 37) / 2, about 10 percent, of a sphere.
const TENTH_OF_FACES_RULE = { normal: [0, 1, 0], maxAngle: 37 };

function terrainOptions(sizes) {
  return {
    size: sizes.terrainSize, chunks: sizes.terrainChunks, resolution: sizes.terrainResolution, levels: 3,
    height: { amplitude: 20, mountainAmplitude: 60, featureSize: 200 }, seed: 7,
  };
}

function planeSurface(halfWidth) {
  const positions = new Float32Array([-halfWidth, 0, -halfWidth, -halfWidth, 0, halfWidth, halfWidth, 0, halfWidth, halfWidth, 0, -halfWidth]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return { name: 'Lawn', geometry: { positions, indices }, matrix: IDENTITY_MATRIX, material: { name: 'Lawn', tag: 'surface', color: [0.2, 0.3, 0.1] } };
}

// frequency says how often an agent or a Studio user reaches the spot, and why we judged it so (see the issue table).
// prepare(sizes) builds fresh input outside the timer and returns the function to time.
export const CANDIDATES = [
  {
    id: 'light-bake-cpu', group: 'light bake', frequency: 'every bake_light call without a GPU, and every CI and headless run',
    describe: sizes => `closed room of 7 boxes, ${sizes.bakeSamples} samples, 2 bounces, up to ${sizes.bakeMaxResolution} px per part`,
    prepare: sizes => {
      const parts = closedRoom();
      const options = { samples: sizes.bakeSamples, bounces: 2, texelsPerUnit: sizes.bakeTexelsPerUnit, maxResolution: sizes.bakeMaxResolution };
      return () => bakeLightmaps(parts, ROOM_LAMP, options);
    },
  },
  {
    id: 'bvh-build', group: 'path tracer', frequency: 'every path-traced still and every ray query on a changed mesh',
    describe: sizes => `triangle BVH over a ${sizes.bvhSegments} by ${sizes.bvhRings} sphere`,
    prepare: sizes => {
      const geometry = sphere(sizes.bvhSegments, sizes.bvhRings);
      return () => buildTriangleBvh(geometry.positions, geometry.indices);
    },
  },
  {
    id: 'mesh-extrude', group: 'mesh edit', frequency: 'every Studio extrude and every extrude_face_region edit',
    describe: sizes => `extrude the faces in a cap holding about 10% of a ${meshLabel(sizes)}`,
    prepare: sizes => {
      const mesh = heavyMesh(sizes);
      const edits = [{ op: 'extrude_face_region', select: TENTH_OF_FACES_RULE, offset: 0.2 }];
      return () => applyMeshEdits(mesh, edits);
    },
  },
  {
    id: 'mesh-dissolve', group: 'mesh edit', frequency: 'a Studio dissolve, less often than extrude',
    describe: sizes => `dissolve the faces in a box on a ${meshLabel(sizes)}`,
    prepare: sizes => {
      const mesh = heavyMesh(sizes);
      const edits = [{ op: 'dissolve_faces', select: { inside: { min: [-1, 0.2, -1], max: [1, 1, 1] } } }];
      return () => applyMeshEdits(mesh, edits);
    },
  },
  {
    id: 'mesh-boolean', group: 'mesh edit', frequency: 'every boolean edit; runs inside a WebAssembly library plus a JavaScript round trip',
    describe: sizes => `subtract a box from a ${meshLabel(sizes)}`,
    prepare: sizes => {
      const mesh = heavyMesh(sizes);
      const edits = [{ op: 'boolean', operation: 'difference', cutter: { type: 'box' }, translation: [0.3, 0.3, 0.3], scale: [0.8, 0.8, 0.8] }];
      return () => applyMeshEdits(mesh, edits, { resolveCutter: () => meshFromGeometry(box(0, 1)) });
    },
  },
  {
    id: 'mesh-select-grow', group: 'mesh edit', frequency: 'every selection by rule and every Studio select-linked or grow',
    describe: sizes => `grow a normal-based selection five steps on a ${meshLabel(sizes)}`,
    prepare: sizes => {
      const mesh = heavyMesh(sizes);
      const rule = { grow: { normal: [0, 1, 0], maxAngle: 20 }, steps: 5 };
      return () => selectFaces(mesh, rule);
    },
  },
  {
    id: 'mesh-select-by-normal', group: 'mesh edit', frequency: 'every selection by normal rule and every Studio select-similar-normal',
    describe: sizes => `select the faces within 37 degrees of up on a ${meshLabel(sizes)}`,
    prepare: sizes => {
      const mesh = heavyMesh(sizes);
      return () => selectFaces(mesh, TENTH_OF_FACES_RULE);
    },
  },
  {
    id: 'mesh-select-linked', group: 'mesh edit', frequency: 'every Studio select-linked (the L key) and every agent selection of a whole part',
    describe: sizes => `select every face linked to one face on a ${meshLabel(sizes)}`,
    prepare: sizes => {
      const mesh = heavyMesh(sizes);
      return () => selectLinked(mesh, 'face', [0]);
    },
  },
  {
    id: 'mesh-select-grow-shrink', group: 'mesh edit', frequency: 'every Studio grow or shrink of a selection; one of each is timed',
    describe: sizes => `grow then shrink a face selection of about 10% of a ${meshLabel(sizes)}`,
    prepare: sizes => {
      const mesh = heavyMesh(sizes);
      const selected = [];
      selectFaces(mesh, TENTH_OF_FACES_RULE).forEach((isSelected, face) => { if (isSelected) selected.push(face); });
      return () => {
        const grown = growSelection(mesh, 'face', selected);
        shrinkSelection(mesh, 'face', grown);
      };
    },
  },
  {
    id: 'terrain-build', group: 'terrain', frequency: 'every createTerrain call and every terrain recipe rebuild',
    describe: sizes => `${sizes.terrainChunks * sizes.terrainChunks} chunks of ${sizes.terrainResolution} cells, ${sizes.terrainSize} units wide`,
    prepare: sizes => {
      const options = terrainOptions(sizes);
      return () => createTerrain(options);
    },
  },
  {
    id: 'snow-mask-bake', group: 'terrain', frequency: 'every material with a slope, normalY or height mask, on each geometry change',
    describe: sizes => `slope mask at ${sizes.snowMaskResolution} px on each chunk of a ${sizes.terrainChunks * sizes.terrainChunks}-chunk terrain`,
    prepare: sizes => {
      const terrain = createTerrain(terrainOptions(sizes));
      const geometries = terrain.parts.map(part => part.geometry).filter(geometry => geometry.uvs);
      if (geometries.length === 0) throw new Error('The terrain gave no geometry with UVs to bake a mask for.');
      // Masks are cached per geometry, so a fresh settings object per run is not enough: give each run new geometry objects.
      const fresh = geometries.map(geometry => ({ ...geometry }));
      return () => {
        for (const geometry of fresh) surfaceMap(geometry, { output: 'slope', space: 'object' }, sizes.snowMaskResolution, 'terrain');
      };
    },
  },
  {
    id: 'tree-build', group: 'scene builders', frequency: 'every tree in a recipe, once per seed and species',
    describe: sizes => `${sizes.treeCount} broadleaf trees, seeds 1 to ${sizes.treeCount}, card leaves`,
    prepare: sizes => () => {
      for (let seed = 1; seed <= sizes.treeCount; seed++) createTree('broadleaf', seed);
    },
  },
  {
    id: 'vegetation-scatter', group: 'scene builders', frequency: 'every forest or meadow scatter in a recipe',
    describe: sizes => `scatter over ${sizes.scatterArea} by ${sizes.scatterArea} units at ${sizes.scatterDensity} per square unit`,
    prepare: sizes => {
      const half = sizes.scatterArea / 2;
      const area = { minX: -half, maxX: half, minZ: -half, maxZ: half };
      return () => scatterVegetation({ area, density: sizes.scatterDensity, seed: 3 });
    },
  },
  {
    id: 'ground-cover', group: 'scene builders', frequency: 'every recipe with groundCover; grown once per shot',
    describe: sizes => `grass at ${sizes.coverDensity} blades per square unit over a ${sizes.coverHalfWidth * 2} unit square`,
    prepare: sizes => {
      const parts = [planeSurface(sizes.coverHalfWidth)];
      const entries = normalizeGroundCover([{ surfaces: 'Lawn', length: 0.12, density: sizes.coverDensity }]);
      return () => groundCoverParts(parts, entries, [0, 3, 8]);
    },
  },
];

export function medianOf(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function timeOnce(candidate, sizes) {
  const work = candidate.prepare(sizes);
  const start = performance.now();
  work();
  return performance.now() - start;
}

export function measureCandidate(candidate, sizes, runs) {
  timeOnce(candidate, sizes);
  const samples = [];
  for (let run = 0; run < runs; run++) samples.push(timeOnce(candidate, sizes));
  return {
    id: candidate.id,
    group: candidate.group,
    describe: candidate.describe(sizes),
    frequency: candidate.frequency,
    runs,
    medianMs: medianOf(samples),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
  };
}

export function parseArguments(argv) {
  const options = { runs: DEFAULT_RUNS, json: null, tiny: false, only: null, list: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--runs') options.runs = Number(argv[++index]);
    else if (argument === '--json') options.json = argv[++index];
    else if (argument === '--tiny') options.tiny = true;
    else if (argument === '--only') options.only = String(argv[++index]).split(',');
    else if (argument === '--list') options.list = true;
    else throw new Error(`Unknown option ${argument}. Use --runs <n>, --json <file>, --tiny, --only <id,id> or --list.`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > MAX_RUNS) throw new RangeError(`--runs needs a whole number from 1 to ${MAX_RUNS}.`);
  return options;
}

export async function runBench(options) {
  await loadAllAgentSceneModules();
  await loadMeshBooleans();
  const sizes = checkedSizes(options.tiny ? SIZES.tiny : SIZES.full);
  const known = CANDIDATES.map(candidate => candidate.id);
  for (const id of options.only ?? []) {
    if (!known.includes(id)) throw new Error(`Unknown candidate ${id}. Use one of ${known.join(', ')}.`);
  }
  const chosen = CANDIDATES.filter(candidate => !options.only || options.only.includes(candidate.id));
  const rows = chosen.map(candidate => measureCandidate(candidate, sizes, options.runs));
  rows.sort((first, second) => second.medianMs - first.medianMs);
  return { node: process.version, sizes: options.tiny ? 'tiny' : 'full', runs: options.runs, rows };
}

export function formatTable(report) {
  const lines = [`| rank | candidate | median ms | min | max | what ran |`, '| ---: | --- | ---: | ---: | ---: | --- |'];
  report.rows.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.id} | ${row.medianMs.toFixed(1)} | ${row.minMs.toFixed(1)} | ${row.maxMs.toFixed(1)} | ${row.describe} |`);
  });
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseArguments(process.argv.slice(2));
  if (options.list) {
    for (const candidate of CANDIDATES) console.log(`${candidate.id}\t${candidate.group}`);
  } else {
    const report = await runBench(options);
    console.log(formatTable(report));
    if (options.json) writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
  }
}
