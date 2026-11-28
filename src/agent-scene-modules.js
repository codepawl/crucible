// Code that most recipes never run loads on demand, so the agent scene entry stays small. A recipe that uses mesh
// editing, procedural modeling, motion, material patterns, terrain, light linking, cascaded shadows or the anisotropy and iridescence layers needs its module loaded before createAgentScene runs:
// call `await loadAgentSceneModules(recipe)` (or `loadAllAgentSceneModules()` in a host that does not mind the
// size). createAgentScene is still synchronous; when a needed module is missing it says which call to make.

const MODULE_LOADERS = {
  mesh: () => import('./agent-mesh-engine.js'),
  modeling: () => import('./modeling.js'),
  text: () => import('./text-geometry.js'),
  motion: () => import('./agent-motion.js'),
  motionBake: () => import('./agent-motion-bake.js'),
  motionTrackRemoval: () => import('./motion-track-removal.js'),
  springs: () => import('./spring-bones.js'),
  face: () => import('./face-animation.js'),
  settle: () => import('./agent-settle.js'),
  applyTransform: () => import('./agent-apply-transform.js'),
  drive: () => import('./agent-drive.js'),
  physics: () => import('./agent-physics.js'),
  fracture: () => import('./agent-fracture.js'),
  meshParts: () => import('./agent-mesh-parts.js'),
  explosion: () => import('./agent-explosion.js'),
  vehicleDamage: () => import('./vehicle-damage.js'),
  cloth: () => import('./agent-cloth.js'),
  particles: () => import('./agent-particles.js'),
  textPanel: () => import('./text-panel.js'),
  textBillboard: () => import('./text-billboard.js'),
  bake: () => import('./agent-bake.js'),
  bakeDeferred: () => import('./agent-bake-deferred.js'),
  reflections: () => import('./agent-reflections.js'),
  waterReflection: () => import('./water-reflection.js'),
  patterns: () => import('./material-patterns.js'),
  materialPresets: () => import('./material-presets.js'),
  assetGraph: () => import('./asset-material-graph.js'),
  relations: () => import('./agent-relations.js'),
  timeline: () => import('./film-timeline.js'),
  layerShaders: () => import('./material-layer-shaders.js'),
  emissionMask: () => import('./emission-mask.js'),
  liquidShader: () => import('./liquid-shader.js'),
  subsurfaceShader: () => import('./subsurface-shader.js'),
  fogShader: () => import('./fog-shader.js'),
  volumeEmissionMask: () => import('./volume-emission-mask.js'),
  retroShader: () => import('./retro-shader.js'),
  glitterShader: () => import('./glitter-shader.js'),
  heightParallaxShader: () => import('./height-parallax-shader.js'),
  detailNormalShader: () => import('./detail-normal-shader.js'),
  surfaceCover: () => import('./surface-cover.js'),
  worldMaterials: () => import('./world-material-shader.js'),
  terrain: () => import('./agent-terrain.js'),
  floorPlan: () => import('./agent-floor-plan.js'),
  navigation: () => import('./agent-navigation.js'),
  lightLinking: () => import('./light-linking.js'),
  lightParenting: () => import('./light-parenting.js'),
  cascades: () => import('./light-modules.js'),
  assets: () => import('./agent-scene-assets.js'),
  vegetation: () => import('./agent-vegetation.js'),
  clutter: () => import('./agent-clutter.js'),
  grass: () => import('./agent-grass.js'),
  crowd: () => import('./agent-crowd.js'),
  lineArt: () => import('./line-art.js'),
  rain: () => import('./rain.js'),
  wetnessPuddles: () => import('./wetness-puddles.js'),
  viewTransform: () => import('./view-transform-shader.js'),
  coplanar: () => import('./coplanar-overlap.js'),
  unsupportedPart: () => import('./unsupported-part.js'),
  physicalSky: () => import('./physical-sky.js'),
  skybox: () => import('./skybox.js'),
  reflectionEnvironment: () => import('./reflection-environment.js'),
  floorSky: () => import('./floor-sky-visibility.js'),
  userPass: () => import('./user-pass.js'),
  pixelGrid: () => import('./pixel-grid.js'),
  game: () => import('./game-setup.js'),
  objectMotionBlur: () => import('./object-motion-blur.js'),
  postSteps: () => import('./post-steps.js'),
  materialSnippet: () => import('./material-snippet.js'),
  volumeGrid: () => import('./local-volume-grid.js'),
  volumeRamp: () => import('./local-volume-ramp.js'),
  bloomPyramid: () => import('./bloom-pyramid.js'),
};

const loadedModules = {};
const pendingLoads = {};
// Set by loadAllAgentSceneModules: the host runs any recipe and wants every default stage on (the MCP preview).
let hostLoadedEveryModule = false;
let manifoldLoader = null;
let physicsLoader = null;

// The two modules that switch a default stage on for every scene once loaded. Kept apart so createAgentScene can ask for just
// these without carrying the whole marker table.
const DEFAULT_STAGE_MARKERS = {
  // Flush faces are ranked whenever this is loaded (issue #751): the MCP preview registers it, loadAllAgentSceneModules loads it,
  // and so does a recipe that names resolveCoplanar or places an asset, since glTF models nest facades a few millimetres apart.
  // A recipe of plain primitives in a host without it stays free of the 85 KB of flush code, so it needs no on-demand module.
  coplanar: ['"resolveCoplanar"', '"asset":{'],
  // A closed room a sun lights gets the floor sky trace by default. The recipe text can not say whether a room is closed, so a recipe that names its sun loads it and the module skips an open scene.
  floorSky: ['"keyColor"', '"keyIntensity"'],
};

// Each test errs on the side of loading: a false positive costs a chunk, a false negative a clear error.
const MODULE_MARKERS = {
  mesh: ['"type":"mesh"', '"instances"', '"separate-faces"', '"join-meshes"', '"apply-transform"', '"set-origin"'],
  meshParts: ['"separate-faces"', '"join-meshes"', '"assign-face-material"'],
  applyTransform: ['"apply-transform"', '"set-origin"'],
  modeling: ['"type":"lathe"', '"type":"extrude"', '"type":"tube"', '"type":"curve"', '"type":"sdf"', '"type":"cloud"'],
  text: ['"type":"text"'],
  motion: ['"motion":{', '"bake-motion"', '"add-explosion"'],
  motionBake: ['"bake-motion"'],
  motionTrackRemoval: ['"removeTracks"'],
  springs: ['"springs":{'],
  face: ['"face":{'],
  settle: ['"type":"settle"'],
  drive: ['"drive":{'],
  physics: ['"physics":{', '"fracture-node"', '"add-explosion"'],
  fracture: ['"type":"fragment"', '"fracture-node"', '"add-explosion"'],
  explosion: ['"add-explosion"'],
  vehicleDamage: ['"type":"dented"'],
  cloth: ['"cloth":{'],
  particles: ['"particles":{', '"add-explosion"'],
  textPanel: ['"text":{'],
  textBillboard: ['"billboard":{'],
  bake: ['"bake":{'],
  bakeDeferred: ['"bake":{'],
  // A metallic value of 0.5 or more may make a part reflective; the module skips a scene that has no smooth one.
  reflections: [/"metallic":(0\.[5-9]|1(?![0-9]))/],
  // Wet ground mirrors the scene in its puddles through the water mirror (src/water-reflection.js).
  waterReflection: ['"puddles":'],
  patterns: ['"pattern"', '"layers"', '"preset":"wood"', '"preset":"grass"', '"preset":"brick"', '"preset":"glass"'],
  // Any preset name loads it, so a wrong name gets the error that lists the right ones.
  materialPresets: ['"preset":'],
  // Only a graph on a placed asset needs it: the placement's "pattern" comes after its "asset":{ in the JSON.
  assetGraph: [/"asset":{[^]*"pattern"/],
  relations: ['"relations":', '"ports":'],
  timeline: ['"timeline":{'],
  layerShaders: ['"anisotropy"', '"iridescence"', '"fresnel"', '"preset":"glass"', '"emissionMask"', '"softEdge"'],
  emissionMask: ['"emissionMask"'],
  liquidShader: ['"transmission"', '"preset":"glass"', '"liquid"', '"foam"'],
  subsurfaceShader: ['"subsurface"'],
  retroShader: ['"retro"'],
  glitterShader: ['"waterGlint"'],
  // Relief needs a heightScale above 0; a heightMap alone is ignored, so the scale is the marker (a texture set sets its height the same way).
  heightParallaxShader: ['"heightScale"'],
  detailNormalShader: ['"detailNormalMap"'],
  surfaceCover: ['"surfaceCover"'],
  // Any mention loads it, because an edit can set the density through a path or the environment of an operation.
  fogShader: ['volumeFog', 'localVolumes', '"add-explosion"'],
  // A volume that casts a shadow draws the emission of the parts it covers apart from the dimmed light (#1360); loaded up front, the first frame already has it.
  volumeEmissionMask: ['"castShadow":true'],
  worldMaterials: ['"tag":"water"', '"waterPreset"', '"absorption"', '"turbidity"', '"caustics"', '"waterRamp"', '"vegetation":{', '"tag":"foliage"', '"tag":"grass"', '"tag":"terrain"', '"tag":"fire"', '"tag":"smoke"', '"moss"'],
  terrain: ['"type":"terrain"'],
  floorPlan: ['"type":"floorPlan"'],
  // No recipe text asks for it, only the path option of scene_inspect does, so a host loads it with loadAllAgentSceneModules.
  navigation: [],
  lightLinking: ['"affects"', '"keyAffects"'],
  // A light with a parent or a face, in a recipe or in a later set-environment (#3239).
  lightParenting: [/"(?:pointLights|spotLights|areaLights)":\[(?:[^\[\]]|\[[^\]]*\])*?"(?:parent|face)"/],
  // The cascade module also loads light-shapes (soft area shadows, IES profiles), so these markers bring both.
  cascades: [/"(?:shadowCascades|sunAngularRadius|ies|hard)"|"areaLights":\[\{/],
  assets: ['"asset":{', '"sequence":{', '"faceImages":', /"(?:colorMap|normalMap|roughnessMap|metallicMap|occlusionMap|heightMap|detailNormalMap|textureSet)":"|"(?:detailNormalScale|detailUvScale|detailRoughnessStrength)":/],
  vegetation: ['"vegetation":{', '"wind":{'],
  clutter: ['"clutter":['],
  grass: ['"grass":{'],
  crowd: ['"crowd":{'],
  lineArt: ['"lines":{', '"toon'],
  rain: ['"rain":{'],
  wetnessPuddles: [/"from":"(?:cavity|mask)"/],
  viewTransform: ['"viewTransform":"agx"', '"viewTransform":"neutral"', '"viewTransform":"standard"', '"look":"'],
  // Flush faces are ranked whenever this is loaded (issue #751): the MCP preview registers it, loadAllAgentSceneModules loads it,
  // and so does a recipe that names resolveCoplanar or places an asset, since glTF models nest facades a few millimetres apart.
  // A recipe of plain primitives in a host without it stays free of the 85 KB of flush code, so it needs no on-demand module.
  coplanar: DEFAULT_STAGE_MARKERS.coplanar,
  // The support check needs no recipe text: the MCP preview and loadAllAgentSceneModules load it, and a plain host stays free of it.
  unsupportedPart: [],
  // A closed room a sun lights gets the floor sky trace by default. The recipe text can not say whether a room is closed, so a recipe that names its sun loads it and the module skips an open scene.
  floorSky: DEFAULT_STAGE_MARKERS.floorSky,
  physicalSky: ['"type":"physical"', '"type":"gradient"'],
  skybox: ['"skybox":{'],
  reflectionEnvironment: ['"reflectionHdri":'],
  userPass: ['"postPasses"', '"postPassesAntialias"'],
  pixelGrid: ['"pixelGrid":{'],
  game: ['"game":{', '"set-game"'],
  materialSnippet: ['"snippet":{'],
  volumeGrid: ['"shape":"grid"'],
  volumeRamp: ['"emissionRamp"'],
  // Only a motionBlur object that sets a non-zero `objects` loads it; the common `"shutter":0` look does not.
  objectMotionBlur: [/"motionBlur":\{[^}]*"objects":(?!0[,}])/],
  postSteps: [/"(?:colorBalance|colorCorrection|sunRays|glare|lensDistortion|stylize|composite|localToneMapping|autoExposure)"|"keepHue":|"(?:distortion|flash)":[\[{]|"add-explosion"/],
  bloomPyramid: [/"bloom":\{/, /"bloomStrength":/],
};

/** Whether a recipe, operation list or edit list contains a boolean edit, which needs loadMeshBooleans() first. */
export function needsMeshBooleans(value) {
  return JSON.stringify(value ?? null).includes('"op":"boolean"');
}

/** True when a recipe or an operation list carries a physics section or a settle operation, so the host loads the solver first. */
export function needsPhysics(value) {
  const text = JSON.stringify(value ?? null);
  return text.includes('"physics":{') || text.includes('"fracture-node"') || text.includes('"type":"settle"') || (text.includes('"add-explosion"') && text.includes('"debris"'));
}

/** True when a recipe has a body with a float field, so the host passes { buoyancy: true } to loadPhysicsEngine. */
export function needsBuoyancy(value) {
  return JSON.stringify(value ?? null).includes('"float":{');
}

function namedModules(value, markers, fallback) {
  let text;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return fallback;
  }
  const compact = text.replace(/"\s*:\s*/g, '":');
  return Object.keys(markers).filter(name => markers[name].some(marker => (marker instanceof RegExp ? marker.test(compact) : compact.includes(marker))));
}

/** Names of the on-demand modules a recipe, or a list of edit operations, needs. */
export function agentSceneModulesNeeded(value) {
  return namedModules(value, MODULE_MARKERS, Object.keys(MODULE_LOADERS));
}

/** Which default-stage modules (flush ranking, floor sky) a recipe or a list of edit operations names. */
export function defaultStageModulesNamed(value) {
  return namedModules(value, DEFAULT_STAGE_MARKERS, Object.keys(DEFAULT_STAGE_MARKERS));
}

function loadModule(name) {
  if (loadedModules[name]) return Promise.resolve(loadedModules[name]);
  pendingLoads[name] ??= MODULE_LOADERS[name]().then(module => {
    loadedModules[name] = module;
    if (name === 'mesh' && manifoldLoader) module.setManifoldModuleLoader(manifoldLoader);
    if (name === 'physics' && physicsLoader) module.setPhysicsModuleLoader(physicsLoader);
    return module;
  });
  return pendingLoads[name];
}

/** Load the modules a recipe (or a list of edit operations) needs. Safe to call repeatedly. */
export async function loadAgentSceneModules(value) {
  await Promise.all(agentSceneModulesNeeded(value).map(loadModule));
}

/** Load every on-demand module, for hosts that run any recipe an agent writes. `onModuleLoaded(loaded, total)` runs as each one arrives. */
export async function loadAllAgentSceneModules({ onModuleLoaded } = {}) {
  hostLoadedEveryModule = true;
  const names = Object.keys(MODULE_LOADERS);
  let loaded = 0;
  await Promise.all(names.map(async name => {
    await loadModule(name);
    loaded += 1;
    onModuleLoaded?.(loaded, names.length);
  }));
}

/** Entries that import a module statically register it here, so createAgentScene finds it without a load call. */
export function registerAgentSceneModule(name, module) {
  loadedModules[name] ??= module;
}

/** The loaded module, or an error that names the call that loads it. */
export function agentSceneModule(name) {
  const module = loadedModules[name];
  if (!module) {
    throw new Error(`This recipe needs the ${name} code, which loads on demand: await loadAgentSceneModules(recipe) before createAgentScene or apply.`);
  }
  return module;
}

export function allAgentSceneModulesLoaded() {
  return Object.keys(MODULE_LOADERS).every(name => loadedModules[name]);
}

export function agentSceneModuleLoaded(name) {
  return Boolean(loadedModules[name]);
}

/**
 * Whether a default stage that needs this module runs for one scene. A module another scene loaded earlier in the same
 * process does not count: the stage runs when the host loaded every module, or when this scene's own recipe or edits
 * asked for it (`requestedNames`, from agentSceneModulesNeeded). So a scene builds the same bytes whatever was built before it.
 */
export function agentSceneModuleActive(name, requestedNames) {
  return Boolean(loadedModules[name]) && (hostLoadedEveryModule || requestedNames.has(name));
}

/** Add a font table that recipes can name in a text geometry. Loads the text code first. */
export async function registerAgentSceneFont(name, fontData) {
  const module = await loadModule('text');
  module.registerFont(name, fontData);
}

/** Replace how the Manifold module is imported. Applied when the mesh code loads, if it has not yet. */
export function setManifoldModuleLoader(loader) {
  if (typeof loader !== 'function') throw new TypeError('The Manifold loader must be a function returning a module promise.');
  manifoldLoader = loader;
  loadedModules.mesh?.setManifoldModuleLoader(loader);
}

export async function loadMeshBooleans(options) {
  const mesh = await loadModule('mesh');
  return mesh.loadMeshBooleans(options);
}

export function meshBooleansLoaded() {
  return loadedModules.mesh?.meshBooleansLoaded() ?? false;
}

/** Replace how the Rapier module is imported. Applied when the physics code loads, if it has not yet. */
export function setPhysicsModuleLoader(loader) {
  if (typeof loader !== 'function') throw new TypeError('The physics loader must be a function returning a module promise.');
  physicsLoader = loader;
  loadedModules.physics?.setPhysicsModuleLoader(loader);
}

export async function loadPhysicsEngine(options) {
  const physics = await loadModule('physics');
  return physics.loadPhysicsEngine(options);
}

export function physicsEngineLoaded() {
  return loadedModules.physics?.physicsEngineLoaded() ?? false;
}
