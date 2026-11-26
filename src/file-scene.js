import { CrucibleRenderer } from './renderer.js';
import { createSharedTextures, loadGltf } from './gltf.js';
import { loadHdri } from './hdri.js';
import { withReflectionEnvironment } from './reflection-environment.js';
import { loadViewTransformForRendererOptions } from './view-transform-loading.js';
import { createCascadedShadows } from './cascaded-shadows.js';
import { applyWaterReflection, attachWaterReflection } from './water-reflection.js';
import { createCameraSampler } from './camera-track.js';
import { inWholeWorldOrder, readPartRanks } from './showcase-download.js';
import { withinDrawnLightLimits } from './drawn-light-lists.js';
import { createFileSceneRenderAt } from './file-scene-clip.js';
import { startDeferredLods } from './deferred-lods.js';
import { MEMORY_BUDGET_ERROR_CODE } from './budget.js';
import { withDepthForRequestedEffects } from './file-scene-depth.js';
import {
  applyFileSceneMaterialOverridesWithReplacements,
  collectFileSceneWarnings,
  DEFAULT_MEMORY_BUDGET_MIB,
  needsWorldMaterialsForOverrides,
  reportFileSceneWarnings,
  resolveFileSceneGltfOptions,
} from './file-scene-overrides.js';
import { partsForRendererOptions, planLodsForRendererOptions, sceneFileLighting, sunShadowBounds, withFileSceneInteriorLight, withSceneFileLights, withSceneFileRendererDefaults } from './dense-lods.js';

// Headless twin of the showcase page for scripts/render-media.mjs (--scene file). The export script serves the scene.json
// at /__file/config.json with every asset path already pointing at a file it can read, and an optional camera track at
// /__file/camera.json. The renderer options, sky, exposure and frame effects are read exactly as src/showcase.js reads them.

export { collectFileSceneWarnings, reportFileSceneWarnings, resolveFileSceneGltfOptions };

/**
 * Applies `description.materials` (keyed by glTF `material.name`) onto `parts`. Returns `{ parts, replaced }` where `replaced`
 * maps each overridden input part to its updated copy, and preserves shared source material object identity per batch.
 */
export async function applyFileSceneMaterials(parts, materials) {
  if (materials === undefined) {
    return { parts, replaced: new Map() };
  }
  const requiresWater = needsWorldMaterialsForOverrides(materials, parts);
  const worldMaterialShader = requiresWater ? await import('./world-material-shader.js') : null;
  return applyFileSceneMaterialOverridesWithReplacements(parts, materials, worldMaterialShader);
}

// Loads the "glbRest" files with the first file's shared textures and joins every file's parts in the order the showcase page
// uses, so a headless frame matches the page. A scene with no "glbRest" keeps the first file's parts as they are.
async function loadStagedParts(description, asset, model, sharedTextures, gltfOptions = {}) {
  const restPaths = description.glbRest ?? [];
  if (!restPaths.length) {
    return { parts: asset.parts, warnings: [] };
  }
  const files = [{ parts: asset.parts, ranks: await readPartRanks(model) }];
  const restWarnings = [];
  for (const restPath of restPaths) {
    const restModel = await fetch(restPath).then(response => response.blob());
    const baseUrl = new URL('.', new URL(restPath, location.href)).href;
    const rest = await loadGltf(restModel, { baseUrl, sharedTextures, ...gltfOptions });
    files.push({ parts: rest.parts, ranks: await readPartRanks(restModel) });
    restWarnings.push(...(rest.warnings ?? []));
  }
  await import('./replace-textured-parts.js');
  return { parts: inWholeWorldOrder(files), warnings: restWarnings };
}

// The native path tracer takes more lights of one kind than a drawn frame does. With `?traceLights=1` (set by
// scripts/render-file-native.mjs, whose picture is traced from `window.__scene.environment`, not drawn) the renderer of this
// page gets the first lights of each kind that fit, so it starts. Without the parameter the lists are untouched and a list
// that is too long fails as before.
function environmentForRenderer(environment) {
  if (!new URLSearchParams(location.search).has('traceLights')) return environment;
  return withinDrawnLightLimits(environment);
}

// A person viewing the page gets the first frame at once and the levels of detail afterwards (#2985). A page driven by a
// script (navigator.webdriver, as every render and smoke script is) makes the levels before the first frame, so what it
// draws never depends on timing; `?lods=sync` or `?lods=deferred` chooses either way. `window.__scene.lodsReady` settles
// when the levels are in (at once for 'sync'), and a script that draws for output awaits it.
function lodTiming() {
  const asked = new URLSearchParams(location.search).get('lods');
  if (asked === 'sync' || asked === 'deferred') return asked;
  if (asked !== null) throw new Error(`lods must be sync or deferred, got ${asked}.`);
  return navigator.webdriver ? 'sync' : 'deferred';
}

/** Gives each planned part its levels, with the sky light the renderer's copy of level 0 carries; one step, after every level is made. */
function swapInLevels({ renderer, plan, sourceParts, rendererParts, levelsByGeometry, sky }) {
  const planned = new Set(plan.parts);
  const withLevels = sourceParts.map(part => (planned.has(part) ? { ...part, lods: levelsByGeometry.get(part.geometry) } : part));
  const levelled = sky ? sky.applyDefaultFloorSky(withLevels, sky.environment, { largeScenes: 'proxy' }).parts : withLevels;
  levelled.forEach((part, index) => {
    if (!planned.has(sourceParts[index])) return;
    const rendererPart = rendererParts[index];
    try {
      renderer.setPartLods(rendererPart, [{ ...part.lods[0], geometry: rendererPart.geometry }, ...part.lods.slice(1)]);
    } catch (error) {
      if (error.code !== MEMORY_BUDGET_ERROR_CODE) throw error;
      // The levels would pass memoryBudgetMiB: the part keeps drawing level 0 only, as it would with a budget that cannot hold them.
      console.warn(`Levels of detail for ${part.name} skipped: ${error.message}`);
    }
  });
}

function deferLevels({ plan, sourceParts, rendererParts, renderer, sky }) {
  const deferred = startDeferredLods({ geometries: plan.geometries, ratios: plan.ratios });
  const dispose = renderer.dispose.bind(renderer);
  renderer.dispose = () => {
    deferred.cancel();
    dispose();
  };
  const lodsReady = deferred.ready.then(levelsByGeometry => {
    if (!levelsByGeometry || renderer.disposed) return;
    try {
      swapInLevels({ renderer, plan, sourceParts, rendererParts, levelsByGeometry, sky });
    } catch (error) {
      console.warn(`Levels of detail were made but not swapped in: ${error.message}`);
      throw error;
    }
  });
  lodsReady.catch(error => { window.__fileSceneLodError = error.message; });
  return lodsReady;
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} is not available (${response.status})`);
  return response.json();
}

// "environment.groundCover" grows grass on named surfaces (#3290). A scene without it loads nothing and keeps its parts as they are.
// The field is built once for the first frame's eye, so every frame and every rerender draws the same blades.
async function addGroundCover(asset, description, camera) {
  if (description.environment?.groundCover === undefined) return;
  const { addGroundCoverToAsset } = await import('./ground-cover-offload.js');
  await addGroundCoverToAsset(asset, description.environment.groundCover, camera ? camera.sample(0).eye : description.eye);
}

async function start() {
  const description = await readJson('/__file/config.json');
  const cameraResponse = await fetch('/__file/camera.json');
  const camera = cameraResponse.ok ? createCameraSampler(await cameraResponse.json()) : null;
  const [model, map, reflectionMap] = await Promise.all([
    fetch(description.glb).then(response => response.blob()),
    loadHdri(description.hdri, description.hdriOptions ?? {}),
    description.reflectionHdri ? loadHdri(description.reflectionHdri) : null,
  ]);
  const sharedTextures = createSharedTextures();
  const gltfOptions = resolveFileSceneGltfOptions(description);
  const asset = await loadGltf(model, { baseUrl: new URL('.', new URL(description.glb, location.href)).href, sharedTextures, ...gltfOptions });
  const assetOwnParts = asset.parts;
  const staged = await loadStagedParts(description, asset, model, sharedTextures, gltfOptions);
  const warnings = collectFileSceneWarnings(asset.warnings, staged.warnings);
  reportFileSceneWarnings(warnings);
  const overridden = await applyFileSceneMaterials(staged.parts, description.materials);
  asset.parts = overridden.parts;
  const posedParts = assetOwnParts.map(part => overridden.replaced.get(part) ?? part);
  await addGroundCover(asset, description, camera);
  // An effect the file asks for that reads depth (ambient occlusion, depth of field, motion blur, sun rays) turns the depth buffer on (#3388).
  const rendererOptions = withDepthForRequestedEffects(withSceneFileRendererDefaults(description.renderer), description.frame?.effects);
  await loadViewTransformForRendererOptions(rendererOptions);
  const shadowCascades = rendererOptions.shadowCascades ? createCascadedShadows(rendererOptions.shadowCascades) : undefined;
  const reflection = description.waterReflection ? applyWaterReflection(asset.parts) : { parts: asset.parts, surface: null };
  // The GLB's punctual lights light the scene, for the drawn frame and the native trace alike (#2664).
  const sceneEnvironment = withSceneFileLights(asset.lights, rendererOptions.environment);
  // The drawn frame takes the HDRI's sun as its shadowed key light, with the sun's shadow view fitted to the scene (#2761).
  // A scene with lights of its own is drawn as before, and the native trace keeps the whole map.
  const drawn = sceneFileLighting(map, asset.lights, rendererOptions.environment, { hdriSun: description.hdriSun !== false });
  const viewport = document.querySelector('#file-viewport');
  const deferLods = lodTiming() === 'deferred';
  const plan = deferLods ? planLodsForRendererOptions(reflection.parts, viewport, rendererOptions) : null;
  const preparedParts = deferLods ? reflection.parts : partsForRendererOptions(reflection.parts, viewport, rendererOptions);
  const interiorStarted = performance.now();
  const interior = await withFileSceneInteriorLight(preparedParts, { ...drawn.environment, map: drawn.map });
  const interiorLight = { sky: interior.skyReport, bounce: interior.bounceReport, seconds: (performance.now() - interiorStarted) / 1000 };
  const rendererParts = interior.parts;
  const rendererMap = interior.environment.map ?? drawn.map;
  const renderer = new CrucibleRenderer(viewport, rendererParts, {
    ground: false, hdr: true, samples: 4, memoryBudgetMiB: DEFAULT_MEMORY_BUDGET_MIB,
    shadowBounds: drawn.sunSplit ? sunShadowBounds(reflection.parts, drawn.environment.lightDirection) : {},
    ...rendererOptions,
    shadowCascades,
    // "reflectionHdri" gives glass and water a sky of their own; the diffuse light and the native trace keep the lighting map (#3396).
    environment: { ...environmentForRenderer(interior.environment), map: reflectionMap ? withReflectionEnvironment(rendererMap, reflectionMap) : rendererMap },
  });
  attachWaterReflection(renderer, reflection.surface, { updateEvery: 1 });
  const frame = { exposure: description.exposure ?? 1, ...(description.frame ?? {}) };
  // A GLB with an animation clip plays its first clip on a loop, as the showcase page does; one without a clip is drawn as before.
  // A scene file that asks for motion blur ("frame.effects.motionBlur") loads the blur stages; one that does not loads nothing.
  const blurModule = description.frame?.effects?.motionBlur ? await import('./file-scene-motion-blur.js') : null;
  const requestedBlur = blurModule?.requestedMotionBlur(frame);
  if (requestedBlur?.shutter > 0) blurModule.installFileSceneMotionBlur(renderer, requestedBlur);
  const renderAt = createFileSceneRenderAt({ asset, posedParts, sceneParts: asset.parts, rendererParts, renderer, camera, description, frame, motionBlur: requestedBlur?.shutter > 0 ? blurModule : null });
  // `parts` and `environment` let scripts/render-file-native.mjs pack the same scene for the native path tracer.
  const sky = interior.skyReport ? { ...(await import('./floor-sky-visibility.js')), environment: drawn.environment } : null;
  const lodsReady = plan?.geometries.length ? deferLevels({ plan, sourceParts: reflection.parts, rendererParts, renderer, sky }) : Promise.resolve();
  window.__scene = { renderer, lodsReady, duration: camera?.duration, renderAt, poseClipAt: seconds => renderAt.clipPlayer?.applyAt(seconds), pause() {}, parts: reflection.parts, interiorLight, environment: { ...sceneEnvironment, map }, warnings };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  start().catch(error => {
    window.__fileSceneError = error.message;
    throw error;
  });
}
