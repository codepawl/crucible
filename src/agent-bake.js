import { invalidField } from './field-error.js';
import { planLightmaps, estimateBake, traceLightmaps, MAX_BAKE_TEXELS } from './light-bake.js';
import { runKernel } from './kernel-offload.js';
import { motionEnvironment } from './agent-motion.js';
import { normalizeProbeList, traceProbes } from './probe-trace.js';
import { placeProbes } from './reflection-probes.js';
import { normalizeIrradianceGrid, placeIrradianceGrid, traceIrradianceGrid, withMeanRadiance } from './irradiance-grid.js';
import { meanSkyRadiance } from './grid-medium.js';
import { knownKeys, finiteNumber } from './agent-recipe-checks.js';
import { BAKE_PRESETS, BAKE_RANGES, BAKE_MAXIMUM_SECONDS, BAKE_WORKER_MAXIMUM_SECONDS, BAKE_PRESET_PATH_WORK, BAKE_EXPLICIT_PATH_WORK_LIMIT } from './agent-scene-capabilities.js';

const PRESET_SAMPLES_FLOOR = 16;

// Recipe `bake`: bounced light written into lightmaps when the scene builds. This module loads on demand, so scenes
// without a bake never download the ray tracer.

const BAKE_FIELDS = ['preset', 'samples', 'bounces', 'texelsPerUnit', 'probes', 'irradianceGrid', 'gridFog', 'rebake'];
const BAKED_MATERIAL_FIELDS = ['emission', 'emissiveColor', 'emissiveMap', 'lightMap', 'lightMapScale', 'occlusionMap', 'occlusionStrength', 'doubleSided'];

/** Validates a recipe bake section and returns the plain, resolved form stored in the recipe (null clears it). */
export function normalizeAgentBake(input) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, BAKE_FIELDS, 'bake');
  if (input.preset !== undefined && !Object.hasOwn(BAKE_PRESETS, input.preset)) {
    throw invalidField('bake.preset', input.preset, `one of ${Object.keys(BAKE_PRESETS).join(', ')}`);
  }
  const resolved = { ...BAKE_PRESETS[input.preset ?? 'standard'] };
  for (const [field, [minimum, maximum]] of Object.entries(BAKE_RANGES)) {
    if (input[field] === undefined) {
      continue;
    }
    resolved[field] = finiteNumber(input[field], `bake.${field}`, minimum, maximum);
  }
  // Absent means 'room', one probe in the middle of an enclosed room (an open scene gets none). false opts out; a list places them.
  // Measured against Cycles, a probe lowered the FLIP score of every baked room, so a bake brings one along.
  if (input.probes === undefined) {
    resolved.probes = 'room';
  } else {
    resolved.probes = input.probes === false || input.probes === 'room' ? input.probes : normalizeProbeList(input.probes);
  }
  // Opt in: a grid of diffuse light for every part, traced instead of lightmaps (src/irradiance-grid.js). Not stored when off, so a recipe without it keeps its bytes.
  const irradianceGrid = normalizeIrradianceGrid(input.irradianceGrid);
  if (irradianceGrid) {
    resolved.irradianceGrid = irradianceGrid;
  }
  // Opt in on top of the grid: the grid's paths scatter in the scene's volume fog. Not stored when off, so the default bake keeps its bytes.
  if (input.gridFog !== undefined && typeof input.gridFog !== 'boolean') {
    throw invalidField('bake.gridFog', input.gridFog, 'true or false');
  }
  if (input.gridFog === true) {
    if (!irradianceGrid) {
      throw invalidField('bake.gridFog', input.gridFog, 'true only together with bake.irradianceGrid, such as irradianceGrid: true');
    }
    resolved.gridFog = true;
  }
  // Not stored when off, so the default bake keeps its bytes.
  if (input.rebake !== undefined && typeof input.rebake !== 'boolean') {
    throw invalidField('bake.rebake', input.rebake, 'true or false');
  }
  if (input.rebake === true) {
    resolved.rebake = true;
  }
  for (const field of ['samples', 'bounces']) {
    if (!Number.isInteger(resolved[field])) {
      throw invalidField(`bake.${field}`, resolved[field], `a whole number, such as ${Math.ceil(resolved[field])}`);
    }
  }
  return resolved;
}

/**
 * The text a bake is cached by: the bake settings (not `rebake`), the lights, materials and the world matrix of every
 * part. The scene stores it when it bakes; a frame whose key differs is lit by a bake that no longer matches.
 */
export function lightBakeKey(recipe, generatedGeometryGenerators, environment, worldMatrices) {
  const { pointLights, spotLights, areaLights, keyColor, keyIntensity, lightDirection, keyAffects } = environment;
  return JSON.stringify([{ ...recipe.bake, rebake: undefined }, [...generatedGeometryGenerators], pointLights, spotLights, areaLights, keyColor, keyIntensity, lightDirection, keyAffects, recipe.materials,
    [...worldMatrices].map(([name, matrix]) => [name, Array.from(matrix)])]);
}

/** The nodes whose geometry is built every frame, which no lightmap fits, with what builds each. */
export function bakeGenerators(recipe) {
  const generators = new Map();
  for (const system of recipe.particles?.systems ?? []) {
    generators.set(system.node, 'a hair or particle system');
  }
  for (const sheet of recipe.cloth?.sheets ?? []) {
    generators.set(sheet.node, 'a cloth simulation');
  }
  return generators;
}

// The bake inputs at a sampled pose: the lights, sun and part matrices as motion has set them, and the key they give.
function sampledBakeInputs(recipe, sourceRestParts, generators, pose) {
  const environment = pose.movedLook ? motionEnvironment(structuredClone(recipe.environment), pose.movedLook) : recipe.environment;
  const worldMatrices = new Map(sourceRestParts.map(part => [part.name, new Float32Array(pose.graph.getNode(part.name).worldMatrix)]));
  return { environment, worldMatrices, key: lightBakeKey(recipe, generators, environment, worldMatrices) };
}

/** The scene_inspect diagnostics for a bake whose inputs, at the sampled pose, differ from the ones it was traced at. */
export function staleBakeProblems(state, bakedKey) {
  if (state.recipe.bake.rebake) {
    return [];
  }
  const pose = { graph: state.poseGraph ?? state.graph, movedLook: state.movedLook };
  return sampledBakeInputs(state.recipe, state.sourceRestParts, bakeGenerators(state.recipe), pose).key === bakedKey ? [] : [staleBakeDiagnostic()];
}

const REBAKE_CACHE_SIZE = 4;

/**
 * bake.rebake: the bake for the pose a frame is sampled at. Returns null while the bake in use already matches that pose;
 * otherwise the bake traced at the sampled lights, sun and part matrices, from the cache (the last 4 poses, least recently
 * used leaves first) or freshly traced. `lightBake.currentKey` is the pose the scene is drawn with.
 */
export function bakeAtSampledPose(lightBake, recipe, pose) {
  const generators = bakeGenerators(recipe);
  const { key, environment, worldMatrices } = sampledBakeInputs(recipe, lightBake.sourceRestParts, generators, pose);
  if (key === lightBake.currentKey) {
    return null;
  }
  const cache = lightBake.cache ??= new Map([[lightBake.key, lightBake]]);
  let entry = cache.get(key);
  const reused = Boolean(entry);
  cache.delete(key);
  entry ??= bakeAgentParts(lightBake.sourceRestParts, worldMatrices, environment, recipe.bake, generators);
  cache.set(key, entry);
  if (cache.size > REBAKE_CACHE_SIZE) {
    cache.delete(cache.keys().next().value);
  }
  lightBake.currentKey = key;
  return { parts: entry.parts, report: { ...entry.report, reused } };
}

/**
 * `bakeAgentParts`, except that a size limit (a RangeError: part cap, path work, triangles, grid nodes) returns
 * `{ refusal: message }` when `mayRefuse` is true, so an edit of an existing scene can stay applied without its bake.
 */
export function bakeUnlessRefused(mayRefuse, ...bakeArguments) {
  try {
    return { baked: bakeAgentParts(...bakeArguments) };
  } catch (error) {
    if (!mayRefuse || !(error instanceof RangeError)) {
      throw error;
    }
    return { refusal: error.message };
  }
}

/** The scene_inspect and scene_apply diagnostic for an edit whose rebake could not run: the edit stands and the scene is drawn unbaked. */
export function bakeSkippedDiagnostic(reason) {
  return {
    kind: 'bake-skipped', severity: 'warning', target: 'bake',
    message: `The edit is applied but the light bake did not run, so the old bake was dropped and the scene is drawn without baked light. ${reason}`,
    fix: 'Fit the bake to the scene: fewer parts, a lower bake.samples or bake.texelsPerUnit (scene_apply set-bake), or remove bake.irradianceGrid and bake.probes when the part limit is theirs (they trace on the CPU, 1,024 parts). The bake runs again on the next edit.',
  };
}

function staleBakeDiagnostic() {
  return {
    kind: 'bake-stale', severity: 'warning', target: 'bake',
    message: 'A light, the sun or a part has moved from the pose the bake was traced at, so the baked light no longer matches the frame.',
    fix: 'Bounced light does not follow motion. Bake a pose that stays put, or set bake.rebake true (scene_apply set-bake) to bake each sampled pose. Material animation is not checked.',
  };
}

function isPreset(settings) {
  return Object.values(BAKE_PRESETS).some(preset => Object.keys(preset).every(field => preset[field] === settings[field]));
}

// Path steps in total: texels x samples x bounces. Measured, a path costs about the same in a closed room and in an
// open one whatever the number of lights, so this tracks the time of a bake better than a count of rays does.
// More texels than the bake takes at all counts as infinite work, so the shrinking lowers texelsPerUnit until they fit too.
function pathWorkOf(plan, settings) {
  const { texels } = estimateBake(plan, settings);
  return texels > MAX_BAKE_TEXELS ? Infinity : texels * settings.samples * settings.bounces;
}

function scaleSettingsDown(settings, floor) {
  return {
    ...settings,
    samples: Math.max(floor.samples, Math.floor(settings.samples * 0.8)),
    texelsPerUnit: Math.max(floor.texelsPerUnit, Math.round(settings.texelsPerUnit * 0.9 * 100) / 100),
  };
}

// The lowest samples and texel density the shrinking goes to: the preset floor, or what was asked when that is already lower.
function shrinkFloor(settings) {
  return { samples: Math.min(settings.samples, PRESET_SAMPLES_FLOOR), texelsPerUnit: Math.min(settings.texelsPerUnit, BAKE_RANGES.texelsPerUnit[0]) };
}

/**
 * Keeps a bake inside its work limits before any ray is traced. The estimate counts texels, samples and bounces and reads
 * no clock, so the same recipe always resolves to the same settings. Explicit settings that fit BAKE_EXPLICIT_PATH_WORK_LIMIT
 * are never changed: they run until the real maxSeconds limit. A preset is scaled down (samples by a fifth, texel density by
 * a tenth, repeatedly) until it fits BAKE_PRESET_PATH_WORK. Explicit settings over the hard limit are scaled down the same
 * way until they fit it, and the result says what was asked and what ran, so a large scene gets some baked light instead of
 * none. Only a scene that does not fit at the floor is refused.
 */
export function fitSettingsToBudget(plan, settings) {
  const explicit = !isPreset(settings);
  const budget = explicit ? BAKE_EXPLICIT_PATH_WORK_LIMIT : BAKE_PRESET_PATH_WORK;
  if (pathWorkOf(plan, settings) <= budget) {
    return { used: settings, reduced: false, reduction: null };
  }
  const floor = shrinkFloor(settings);
  // Samples and texel density shrink first. When the floor of both still does not fit (a large hall), a bounce is given up and
  // the density and samples start again from the asked settings, so the result is the largest bake that fits.
  for (let bounces = settings.bounces; bounces >= BAKE_RANGES.bounces[0]; bounces--) {
    let used = { ...settings, bounces };
    while (pathWorkOf(plan, used) > budget && !atFloor(used, floor)) {
      used = scaleSettingsDown(used, floor);
    }
    if (pathWorkOf(plan, used) <= budget) {
      return { used, reduced: true, reduction: reductionMessage(settings, used, explicit) };
    }
  }
  throw new RangeError(overLimitMessage(plan, settings, budget, floor));
}

function atFloor(settings, floor) {
  return settings.samples <= floor.samples && settings.texelsPerUnit <= floor.texelsPerUnit;
}

// What the agent reads in bake.reduction: what was asked, what ran, and the one thing to do for more.
function reductionMessage(asked, used, explicit) {
  const asking = `samples ${asked.samples}, bounces ${asked.bounces}, texelsPerUnit ${asked.texelsPerUnit}`;
  const running = `samples ${used.samples}, bounces ${used.bounces}, texelsPerUnit ${used.texelsPerUnit} (bake.used)`;
  if (explicit) {
    return `The explicit settings asked for ${asking}; this scene is over the hard limit of ${BAKE_EXPLICIT_PATH_WORK_LIMIT} path steps for that, so it baked ${running} instead of failing. For the settings you asked for, remove parts or lights.`;
  }
  return `The preset asked for ${asking}; this scene is too large for that within the preset budget of ${BAKE_PRESET_PATH_WORK} path steps, so it baked ${running}. For a denser bake pass explicit samples, bounces and texelsPerUnit, up to ${BAKE_EXPLICIT_PATH_WORK_LIMIT} path steps and ${BAKE_MAXIMUM_SECONDS} s.`;
}

function overLimitMessage(plan, settings, budget, floor) {
  const atFloorSettings = { ...settings, samples: floor.samples, texelsPerUnit: floor.texelsPerUnit, bounces: BAKE_RANGES.bounces[0] };
  const limitName = isPreset(settings) ? 'the preset budget' : 'the limit for explicit settings';
  const { texels } = estimateBake(plan, atFloorSettings);
  const size = texels > MAX_BAKE_TEXELS ? `${texels} texels, over the ${MAX_BAKE_TEXELS} the bake takes` : `${pathWorkOf(plan, atFloorSettings)} path steps (texels x samples x bounces), over ${limitName} of ${budget}`;
  return `Even samples ${atFloorSettings.samples}, bounces 1 and texelsPerUnit ${atFloorSettings.texelsPerUnit} is ${size}. Remove parts or lights.`;
}

function timeLimitMessage(error, settings) {
  const lowerSamples = Math.max(BAKE_RANGES.samples[0], Math.floor(settings.samples / 2));
  return `${error.message} The scene is unchanged. Try samples ${lowerSamples}, or texelsPerUnit ${Math.max(BAKE_RANGES.texelsPerUnit[0], Math.round(settings.texelsPerUnit / 2 * 100) / 100)}.`;
}

// The baked part keeps reading every other material field from the live material (doubleSided is baked: a two-sided part bakes its back faces as triangles), so motion tracks still drive it.
function liveBakedMaterial(liveMaterial, bakedMaterial) {
  const output = {};
  for (const field of Object.keys(bakedMaterial)) {
    const source = BAKED_MATERIAL_FIELDS.includes(field) ? bakedMaterial : liveMaterial;
    Object.defineProperty(output, field, { enumerable: true, get: () => source[field] });
  }
  return Object.freeze(output);
}

// Inside a worker the bake blocks nothing, so it may run longer; on the page's own thread it must stay short.
function runsOnWorker() {
  return typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;
}

/** The seconds a bake may run here: 90 on a worker, 20 on the page's own thread. */
export function bakeSecondsLimit() {
  return runsOnWorker() ? BAKE_WORKER_MAXIMUM_SECONDS : BAKE_MAXIMUM_SECONDS;
}

function traceWithAdvice(plan, used) {
  try {
    return traceLightmaps(plan, used);
  } catch (error) {
    if (/passed maxSeconds/.test(error.message)) {
      throw new Error(timeLimitMessage(error, used));
    }
    throw error;
  }
}

/**
 * The light bake as a worker kernel: unwrap, budget fit and trace all run in the same place, because unwrapping and
 * tracing are both the heavy parts. Only the parts the bake changed travel back, as [index, part] pairs, because a part
 * that was left alone is the caller's own object and has nothing to send. An explicit setting over the budget throws
 * the same RangeError here as it would inline, and the worker sends it back with its message.
 */
export function bakeChangedParts(snapshots, lighting, settings) {
  const plan = planLightmaps(snapshots, lighting, { ...settings, maxSeconds: bakeSecondsLimit() });
  const { used, reduced, reduction } = fitSettingsToBudget(plan, settings);
  const { parts, report } = traceWithAdvice(plan, used);
  return { changed: changedPartsOf(parts, snapshots), report, used, reduced, reduction };
}

/** The [index, part] pairs of the parts a bake replaced; a part left alone is the caller's own object. */
export function changedPartsOf(bakedParts, snapshots) {
  const changed = [];
  bakedParts.forEach((part, index) => {
    if (part !== snapshots[index]) {
      changed.push([index, part]);
    }
  });
  return changed;
}

/**
 * Bakes the parts at the world matrices given by name (a retained part's own matrix is only refreshed after a commit).
 * Returns the new parts, which share the originals' matrices so poses still move them, and a report: texels,
 * rayWork, seconds, skipped parts with reasons.
 */
export function bakeAgentParts(parts, worldMatrices, environment, settings, generatedGeometryGenerators = new Map()) {
  return traceAgentBake(parts, worldMatrices, environment, settings, generatedGeometryGenerators);
}

/**
 * Local volumes are drawn in the post pass and have no place in a lightmap, so the bake leaves them out. The report names
 * them from the recipe as it is now, outside the bake cache: adding or clearing a volume does not re-trace the bake.
 */
export function withLocalVolumeReport(report, localVolumes) {
  const skippedVolumes = skippedLocalVolumes(localVolumes);
  const { skippedLocalVolumes: staleVolumes, warnings: staleWarnings, ...cleanReport } = report;
  if (skippedVolumes.length === 0) {
    return cleanReport;
  }
  return { ...cleanReport, skippedLocalVolumes: skippedVolumes, warnings: [localVolumesNotBakedWarning(skippedVolumes)] };
}

function skippedLocalVolumes(localVolumes) {
  return (localVolumes ?? []).map((volume, index) => ({ index, shape: volume.shape, emissive: volume.emissionStrength > 0 && volume.emission.some(channel => channel > 0) }));
}

function localVolumesNotBakedWarning(skippedVolumes) {
  const names = skippedVolumes.map(volume => `environment.localVolumes[${volume.index}] (${volume.shape}${volume.emissive ? ', emissive' : ''})`).join(', ');
  return `The bake leaves out ${names}: local volumes are drawn in the post pass, so an emissive volume does not light baked surfaces and no volume dims the baked light. Light the surfaces with a point light or an emissive part.`;
}

function traceAgentBake(parts, worldMatrices, environment, settings, generatedGeometryGenerators) {
  const sunScale = environment.keyIntensity ?? 1;
  const lighting = {
    pointLights: environment.pointLights,
    spotLights: environment.spotLights,
    areaLights: environment.areaLights,
    keyColor: Array.from(environment.keyColor, channel => channel * sunScale),
    skyTop: environment.skyTop,
    skyBottom: environment.skyBottom,
    lightDirection: environment.lightDirection,
    keyAffects: environment.keyAffects,
  };
  if (settings.gridFog) {
    lighting.volumeFog = environment.volumeFog;
    lighting.skyMean = meanSkyRadiance(environment.map);
  }
  // A hair, particle or cloth node is drawn from geometry built every frame, which has no lightmap UVs.
  const snapshots = parts.map(part => ({
    ...part,
    matrix: worldMatrices.get(part.name),
    material: { ...part.material },
    generatesGeometry: generatedGeometryGenerators.get(part.name) ?? false,
  }));
  if (settings.irradianceGrid) {
    return bakeIrradianceGridParts(parts, snapshots, lighting, settings);
  }
  const { changed, report, used, reduced, reduction } = runKernel('lightBake', [snapshots, lighting, settings], bakeChangedParts);
  // Probes see the unbaked parts, as the bake does, and are traced as a kernel of their own so a worker can take them too.
  const probeTrace = !settings.probes ? null
    : runKernel('probeTrace', [snapshots, lighting, settings.probes, { environment: lighting, maxSeconds: bakeSecondsLimit() }], traceProbes);
  const bakedSnapshots = snapshots.slice();
  for (const [index, part] of changed) {
    bakedSnapshots[index] = part;
  }
  const bakedParts = parts.map((part, index) => {
    if (bakedSnapshots[index] === snapshots[index]) {
      return part;
    }
    const { geometry, material } = bakedSnapshots[index];
    return Object.freeze({ ...part, geometry, material: liveBakedMaterial(part.material, material) });
  });
  // Probes are placed here, on the page, because they build maps and materials; their trace ran above.
  const placed = probeTrace ? placeProbes(bakedParts, probeTrace) : null;
  return { parts: Object.freeze(placed ? placed.parts : bakedParts), report: { ...settings, ...(placed ? { probes: placed.report } : {}), used, reduced, reduction, texels: report.texels, rayWork: report.rayWork, seconds: report.seconds,
    backend: report.backend, ...(report.gpu ? { gpu: report.gpu, gpuCompileSeconds: report.gpuCompileSeconds } : {}), bakedParts: report.parts.length, skipped: report.skipped } };
}

// The grid is a few thousand nodes of six gathers each, so its samples are a quarter of the lightmap preset's: about 32 at standard.
const GRID_SAMPLES_SHARE = 4;
const GRID_MINIMUM_SAMPLES = 8;

/**
 * The irradiance grid trace as a worker kernel. The time limit is read here and not passed in, so a worker traces under its
 * own 90 s and the page's 20 s never reaches it (and never changes the kernel's cache key).
 */
export function traceGridKernel(snapshots, lighting, options) {
  return traceIrradianceGrid(snapshots, lighting, { ...options, maxSeconds: bakeSecondsLimit() });
}

// bake.irradianceGrid: no lightmaps. Every part reads one baked grid of bounced light (the sun's lit patches included), and the
// probes still run. Inside a worker session the trace runs on the worker (90 s); otherwise on the page's thread (20 s).
function bakeIrradianceGridParts(parts, snapshots, lighting, settings) {
  const gridOptions = {
    resolution: settings.irradianceGrid,
    samples: Math.max(GRID_MINIMUM_SAMPLES, Math.round(settings.samples / GRID_SAMPLES_SHARE)),
    bounces: settings.bounces,
  };
  const grid = withMeanRadiance(runKernel('gridTrace', [snapshots, lighting, gridOptions], traceGridKernel));
  const probeTrace = !settings.probes ? null
    : runKernel('probeTrace', [snapshots, lighting, settings.probes, { environment: lighting, maxSeconds: bakeSecondsLimit() }], traceProbes);
  const gridParts = placeIrradianceGrid(parts, grid);
  const placed = probeTrace ? placeProbes(gridParts, probeTrace) : null;
  const { data, ...gridReport } = grid;
  return { parts: Object.freeze(placed ? placed.parts : gridParts), report: { ...settings, ...(placed ? { probes: placed.report } : {}), used: settings, reduced: false, reduction: null, texels: 0, rayWork: 0,
    seconds: grid.seconds, bakedParts: 0, skipped: [], irradianceGrid: gridReport } };
}
