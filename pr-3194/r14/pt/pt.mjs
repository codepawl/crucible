// node pt.mjs <view> <ground>: CPU path tracer ground truth for the puddle views. Writes pt/<view>-<ground>.f32 (linear RGB) and .json.
// ground: puddle-glaze (water IOR 1.33 over the bed Glaze paints), puddle-plain (same water over plain wet asphalt), road (wet rough road), none (default tone: the road as listed).
import { writeFileSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { readFileSync } from 'node:fs';
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const worktree = 'file:///C:/Users/nxan2/Documents/crucible/.claude/worktrees/w-2874/src';
const { createAgentScene, loadAllAgentSceneModules } = await import(`${worktree}/agent-scene.js`);
const { agentEnvironmentMap } = await import(`${worktree}/agent-look.js`);
const { renderPathTracedImage } = await import(`${worktree}/path-tracer.js`);
const { parseRadianceHdr } = await import(`${worktree}/hdri.js`);
const { registerCatalogEnvironment } = await import(`${worktree}/look-catalog.js`);
const { recipeFor, cloudsEnvironment, treeScene, views, baseScene, centre } = await import('./rig.mjs');

const [viewName, groundName] = process.argv.slice(2);
const samples = Number(process.env.PT_SAMPLES ?? 48);
// Mean linear albedo of the CC0 asphalt colour map (measured by asphalt-mean.py) and what Glaze does to it.
const asphaltAlbedo = Number(process.env.ASPHALT_ALBEDO ?? 0.2);
const glazeBed = asphaltAlbedo * 0.46 * 0.35;
const glazeRoad = asphaltAlbedo * 0.46;
const grounds = {
  'puddle-glaze': { id: 'asphalt', color: [glazeBed, glazeBed, glazeBed], roughness: 0.04, ior: 1.33 },
  'puddle-plain': { id: 'asphalt', color: [asphaltAlbedo * 0.46, asphaltAlbedo * 0.46, asphaltAlbedo * 0.46], roughness: 0.04, ior: 1.33 },
  'puddle-black': { id: 'asphalt', color: [0, 0, 0], roughness: 0.04, ior: 1.33 },
  'puddle-flat': { id: 'asphalt', color: [0.3, 0.3, 0.3], roughness: 0.04, ior: 1.33 },
  flat: { id: 'asphalt', color: [0.3, 0.3, 0.3], roughness: 1, ior: 1.5 },
  road: { id: 'asphalt', color: [glazeRoad, glazeRoad, glazeRoad], roughness: 0.55, ior: 1.5 },
};
const treeViews = new Set(['hero-tree', 'tree-under']);
const sceneBase = treeViews.has(viewName) ? treeScene : baseScene;
const environment = cloudsEnvironment(0);
delete environment.puddles;
delete environment.wetness;
const recipe = recipeFor(viewName, environment, sceneBase);
recipe.materials = recipe.materials.map(material => (material.id === 'asphalt' ? grounds[groundName] : material));
await loadAllAgentSceneModules();
registerCatalogEnvironment('sky-clouds', parseRadianceHdr(readFileSync('C:/Users/nxan2/Documents/crucible/artifacts/2874/assets/hdri/sky4k.hdr').buffer.slice(0)));
const scene = createAgentScene(recipe, {}, {});
const resolved = { ...scene.environment, map: agentEnvironmentMap(scene.environment) };
const started = performance.now();
const result = await renderPathTracedImage({ parts: scene.parts, environment: resolved, camera: scene.camera }, { width: 480, height: 270, samples, bounces: 4, denoiser: 'none', threads: 6, seed: 7 });
const base = `C:/Users/nxan2/Documents/crucible/artifacts/2874/r14/pt/${viewName}-${groundName}`;
writeFileSync(`${base}.f32`, Buffer.from(result.linear.buffer, result.linear.byteOffset, result.linear.byteLength));
writeFileSync(`${base}.depth.f32`, Buffer.from(result.features.depth.buffer, result.features.depth.byteOffset, result.features.depth.byteLength));
writeFileSync(`${base}.albedo.f32`, Buffer.from(result.features.albedo.buffer, result.features.albedo.byteOffset, result.features.albedo.byteLength));
writeFileSync(`${base}.json`, JSON.stringify({ view: views[viewName], ground: grounds[groundName], environment, samples, bounces: 4, size: [480, 270], seed: 7, backend: 'cpu path tracer', seconds: (performance.now() - started) / 1000, report: result.report }, null, 1));
console.log(viewName, groundName, 'seconds', ((performance.now() - started) / 1000).toFixed(1));
