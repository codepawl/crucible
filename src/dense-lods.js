import { requireFiniteInRange } from './modeling-limits.js';
import { generateGeometryLods, checkRatios, DEFAULT_LOD_RATIOS } from './mesh-lod.js';
import { MAXIMUM_SIMPLIFY_TRIANGLES } from './geometry-simplify.js';
import { DENSE_TRIANGLES_PER_PIXEL, partTakesLods } from './renderer.js';
import { splitHdriSun } from './hdri.js';
import { fitWorldShadowView } from './shadow-light.js';
import { sceneBoundsOfParts } from './near-plane-fit.js';
import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS } from './light-limits.js';
import { emittingAreaLights } from './area-light-portal.js';

// Parts for a scene with more than one triangle per pixel (a scan, a sculpt), given `lods` so that each draws with the
// fewest triangles whose error stays under `lodPixelError` pixels (#1163). On such a scene every pixel is shaded about
// once per triangle that touches it, so a level with a quarter of the triangles shades far fewer quads.

// Meshes of a few thousand triangles, many of them, are as dense as a few huge scans, so the floor sits low (#2144). Lone Monk draws as fast from 4000 as from 1500 and shimmers no more (#2157).
export const DEFAULT_MINIMUM_TRIANGLES = 4000;

/** A scene file picks a level at this many pixels of error (CrucibleRenderer's own default is 1); `renderer.lodPixelError` overrides it (#2157). */
export const SCENE_FILE_LOD_PIXEL_ERROR = 0.5;

/** The renderer options of a scene file with the scene-file defaults under them. */
export function withSceneFileRendererDefaults(rendererOptions = {}) {
  return { lodPixelError: SCENE_FILE_LOD_PIXEL_ERROR, ...rendererOptions };
}

/**
 * The environment of a scene file: the GLB's own KHR_lights_punctual lights (`asset.lights`) with the scene file's
 * `renderer.environment` on top, key by key, so a scene file can still override the file's key light or light lists.
 */
export function withSceneFileLights(fileLights = {}, sceneEnvironment = {}) {
  const merged = { ...fileLights, ...sceneEnvironment };
  return { ...studioLightsOffForOwnLights(merged, sceneEnvironment), ...merged };
}

/** True when a scene file's own `renderer.environment` lists a point, spot or emitting area light (a portal emits nothing). */
function hasOwnLocalLights(sceneEnvironment) {
  return Boolean(sceneEnvironment.pointLights?.length || sceneEnvironment.spotLights?.length || emittingAreaLights(sceneEnvironment.areaLights).length);
}

/**
 * A scene file that lists its own point, spot or area lights is lit by them, as a GLB with KHR_lights_punctual is: the
 * renderer's studio fill goes off, and so does the studio key unless the file names a sun (`lightDirection` or
 * `keyColor`). A `keyIntensity` or `fillIntensity` written in the file still wins (#2765).
 */
function studioLightsOffForOwnLights(merged, sceneEnvironment) {
  if (!hasOwnLocalLights(sceneEnvironment)) return {};
  const namesSun = merged.lightDirection !== undefined || merged.keyColor !== undefined;
  return { ...(namesSun ? {} : { keyIntensity: 0 }), fillIntensity: 0 };
}

/**
 * The lights of every part of a staged world as one partial environment: point and spot lights of all parts in part
 * order up to the renderer's limits, and the key light of the first part that has a directional light (#2666).
 * Parts without lights contribute nothing, and a world with no lights at all gives `{}`.
 */
export function mergePartLights(lightsPerPart) {
  const merged = {};
  const pointLights = lightsPerPart.flatMap(lights => lights.pointLights ?? []).slice(0, MAX_POINT_LIGHTS);
  const spotLights = lightsPerPart.flatMap(lights => lights.spotLights ?? []).slice(0, MAX_SPOT_LIGHTS);
  if (pointLights.length) merged.pointLights = pointLights;
  if (spotLights.length) merged.spotLights = spotLights;
  const keyed = lightsPerPart.find(lights => lights.lightDirection);
  if (keyed) {
    Object.assign(merged, { keyColor: keyed.keyColor, lightDirection: keyed.lightDirection, keyIntensity: keyed.keyIntensity });
  } else if (pointLights.length || spotLights.length) {
    merged.keyIntensity = 0;
  }
  if (Object.keys(merged).length) merged.fillIntensity = 0;
  return merged;
}

/** The environment a showcase page draws with: the GLB's own lights under the scene's `renderer.environment`, plus the sky `map` (#2666). */
export function showcaseEnvironment(fileLights, sceneEnvironment, map) {
  return { ...withSceneFileLights(fileLights, sceneEnvironment), map };
}

/**
 * The environment and map a scene file lights with. A file without a directional light of its own, whose scene file
 * names no key light, is lit by the HDRI's sun as a shadowed key with no fill, and the sun leaves the map, so it no
 * longer reaches shaded points through the unshadowed sky term (#2761). `hdriSun: false` in the scene file keeps the
 * HDRI whole and the renderer's default key. Returns `{ environment, map, sunSplit }`; a scene with lights of its own
 * comes back unchanged with `sunSplit` false.
 */
export function sceneFileLighting(map, fileLights = {}, sceneEnvironment = {}, { hdriSun = true } = {}) {
  const written = { ...fileLights, ...sceneEnvironment };
  const namesKey = ['lightDirection', 'keyColor', 'keyIntensity'].some(key => written[key] !== undefined);
  const split = hdriSun && map && !namesKey ? splitHdriSun(map) : null;
  if (!split) return { environment: withSceneFileLights(fileLights, sceneEnvironment), map, sunSplit: false };
  return { environment: { ...split.environment, fillIntensity: 0, ...written }, map: split.map, sunSplit: true };
}

// A closed room a sun lights gets the sky each surface sees and the light its sunlit patches bounce, as recipe scenes do
// (#2761). Both steps decide for themselves whether the parts make a closed room, so open scenes come back unchanged;
// `renderer.environment.floorSkyTrace: false` and `sunBounce: 0` turn them off. The module loads only for a scene with a sun.
// `floorSkyOptions` go to the trace (its texel and ray budgets); `skyReport` says what the trace did, or why it did not run, and
// `bounceReport` says the same of the sun bounce. A closed room past the triangle limit (a scanned classroom) is traced and bounced
// through the occupancy grid (`largeScenes: 'proxy'`, #2771); `floorSkyOptions.largeScenes: 'skip'` leaves such a scene as it is.
// `environment.skyOcclusion: true` also takes sky light away under cover (src/sky-occlusion-grid.js); `floorSkyOptions.skyOcclusion` holds its cell size and ray budgets.
export async function withFileSceneInteriorLight(parts, environment, floorSkyOptions = {}) {
  const lit = await withFileSceneSunLight(parts, environment, floorSkyOptions);
  if (environment?.skyOcclusion !== true) return lit;
  // Opt-in (#3289): the sky light under canopies and eaves, from a grid traced once here. It goes last so the sun bounce sees the plain parts.
  const { applySkyOcclusionGrid } = await import('./sky-occlusion-grid.js');
  const occluded = applySkyOcclusionGrid(lit.parts, floorSkyOptions.skyOcclusion);
  if (occluded.report.reason) console.warn(`Sky occlusion left out: ${SKY_OCCLUSION_REASONS[occluded.report.reason] ?? occluded.report.reason}.`);
  if (occluded.report.coarsened) console.warn(`Sky occlusion cells grew to ${occluded.report.cellSize.toFixed(2)} m so the grid stays within its node limit; canopy edges will look softer.`);
  return { ...lit, parts: occluded.parts, skyOcclusionReport: occluded.report };
}

const SKY_OCCLUSION_REASONS = Object.freeze({
  'baked light': 'a part already carries a light map or an irradiance grid, and that baked light wins',
  'no parts': 'the scene has no parts',
  'too large or too slow to trace': 'the scene has too many triangles or the trace ran past its time limit',
});

async function withFileSceneSunLight(parts, environment, floorSkyOptions) {
  const { applyDefaultFloorSky, environmentHasSun, withSunBounce } = await import('./floor-sky-visibility.js');
  if (!environmentHasSun(environment)) return { parts, environment, skyReport: null, bounceReport: { reason: 'no sun', detail: 'the scene has no sun (a key light with a colour and an intensity above zero)' } };
  const { skyOcclusion, ...traceOptions } = floorSkyOptions;
  const largeScenes = traceOptions.largeScenes ?? 'proxy';
  const traced = applyDefaultFloorSky(parts, environment, { ...traceOptions, largeScenes });
  // A scene past the trace's limits keeps the light it had; say so instead of dropping the reason (#2771).
  if (traced.report?.fallbackReason && traced.report.method !== 'proxy') console.warn(`Sky trace left out (${traced.report.reason}): ${traced.report.fallbackReason}`);
  const bounceReport = {};
  return { parts: traced.parts, environment: withSunBounce(traced.parts, environment, { largeScenes, report: bounceReport }), skyReport: traced.report, bounceReport };
}

/** Triangles over pixels for these parts on a canvas of `pixels` pixels (the canvas size times the pixel ratio squared). */
export function trianglesPerPixel(parts, pixels) {
  if (!(pixels > 0)) throw new RangeError('pixels must be the canvas width times its height times the pixel ratio squared, a positive number.');
  let triangles = 0;
  for (const part of parts) triangles += part.geometry.indices.length / 3;
  return triangles / pixels;
}

/** The parts that would take levels: dense scene, at least `minimumTriangles`, not past the simplifier's limit, may take lods. Empty for a sparse scene. */
function partsThatTakeDenseLods(parts, { pixels, minimumTrianglesPerPixel = DENSE_TRIANGLES_PER_PIXEL, minimumTriangles = DEFAULT_MINIMUM_TRIANGLES, ratios = DEFAULT_LOD_RATIOS } = {}) {
  if (!Array.isArray(parts)) throw new TypeError('parts must be the array of parts that goes to CrucibleRenderer.');
  // Checked here so bad ratios fail on a sparse scene too, not only on the frame a scene turns dense.
  checkRatios(ratios);
  requireFiniteInRange('addLodsToDenseParts', 'minimumTrianglesPerPixel', minimumTrianglesPerPixel, 0, 1e9);
  requireFiniteInRange('addLodsToDenseParts', 'minimumTriangles', minimumTriangles, 0, 1e9);
  if (trianglesPerPixel(parts, pixels) <= minimumTrianglesPerPixel) return [];
  return parts.filter(part => {
    const triangles = part.geometry.indices.length / 3;
    return !part.lods && triangles >= minimumTriangles && triangles <= MAXIMUM_SIMPLIFY_TRIANGLES && partTakesLods(part);
  });
}

/**
 * Returns `parts` with `lods` on every part that has at least `minimumTriangles` triangles and may take levels, when
 * the scene is denser than `minimumTrianglesPerPixel`; otherwise returns `parts` itself. Parts that share a geometry
 * share its levels and so one batch; a part that already has `lods` keeps them. The levels keep uvs and colours.
 * The levels are made before this returns, so a frame drawn from the result is the same every time. A viewer that
 * should not wait for them uses `planDenseLods` and src/deferred-lods.js.
 */
export function addLodsToDenseParts(parts, options = {}) {
  const taking = new Set(partsThatTakeDenseLods(parts, options));
  if (!taking.size) return parts;
  const ratios = options.ratios ?? DEFAULT_LOD_RATIOS;
  const levelsByGeometry = new Map();
  return parts.map(part => {
    if (!taking.has(part)) return part;
    if (!levelsByGeometry.has(part.geometry)) levelsByGeometry.set(part.geometry, generateGeometryLods(part.geometry, { ratios }));
    return { ...part, lods: levelsByGeometry.get(part.geometry) };
  });
}

/**
 * What addLodsToDenseParts would do, without doing it: `{ parts, geometries, ratios }` where `parts` are the parts that
 * would take levels and `geometries` are their distinct geometries (parts that share one share its levels). Both are empty
 * for a sparse scene. Use it to draw the first frame from level 0 and make the levels afterwards (src/deferred-lods.js).
 */
export function planDenseLods(parts, options = {}) {
  const taking = partsThatTakeDenseLods(parts, options);
  return { parts: taking, geometries: [...new Set(taking.map(part => part.geometry))], ratios: options.ratios ?? DEFAULT_LOD_RATIOS };
}

/**
 * The parts a scene file's renderer options ask for: `denseLods` (on by default) runs addLodsToDenseParts at the canvas's
 * size and pixel ratio (the default ratio of CrucibleRenderer is 1.5); `false` returns `parts` itself, so a scene file
 * can keep every triangle of a dense scan.
 */
export function partsForRendererOptions(parts, canvas, rendererOptions = {}) {
  const pixels = denseLodPixels('partsForRendererOptions', canvas, rendererOptions);
  return pixels === null ? parts : addLodsToDenseParts(parts, { pixels });
}

/** planDenseLods for a scene file's renderer options, the way partsForRendererOptions reads them; an empty plan when `denseLods` is false. */
export function planLodsForRendererOptions(parts, canvas, rendererOptions = {}) {
  const pixels = denseLodPixels('planLodsForRendererOptions', canvas, rendererOptions);
  return pixels === null ? { parts: [], geometries: [], ratios: DEFAULT_LOD_RATIOS } : planDenseLods(parts, { pixels });
}

/** The canvas pixels the renderer options imply, or null when `denseLods` is false. */
function denseLodPixels(label, canvas, { denseLods = true, pixelRatio = 1.5 }) {
  if (typeof denseLods !== 'boolean') throw new TypeError('renderer.denseLods must be true or false.');
  if (!denseLods) return null;
  requireFiniteInRange(label, 'pixelRatio', pixelRatio, 0.1, 16);
  return Math.max(1, canvas.clientWidth) * Math.max(1, canvas.clientHeight) * pixelRatio * pixelRatio;
}

/**
 * The sun's shadow view for a file scene lit by its HDRI sun, as `shadowBounds`: fitted to the parts the way a world
 * scene's view is (#1695), with the eye on the sun's side, instead of the 7 m studio box at the origin (#2761).
 * Returns `{}` (the studio view) when the parts have no fixed bounds or are too large to fit.
 */
export function sunShadowBounds(parts, lightDirection) {
  const view = fitWorldShadowView(sceneBoundsOfParts(parts));
  if (!view) return {};
  const length = Math.hypot(lightDirection[0], lightDirection[1], lightDirection[2]);
  const eye = view.target.map((value, axis) => value + (lightDirection[axis] / length) * view.distance);
  return { eye, target: view.target, extent: view.extent, near: view.near, far: view.far };
}
