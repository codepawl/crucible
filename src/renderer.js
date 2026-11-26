import { LIGHT_DATA_BLOCK, uniformBlockOf, disposeUniformBlocks } from './light-uniform-block.js';
import { resolveBackground, clearColourFor } from './clear-colour.js';
import { materialTags, MAX_MORPH_TARGETS, registeredFeatureCode, requireFeatureCode, requireHeightParallaxSupport, deformationSupport, requireDeformationSupport, texturedReplaceSupport, textureUpdateSupport, bloomPyramidSupport } from './shader-registry.js';
import { mat4, mat3 } from 'gl-matrix';
import { BLEND_FACTORS } from './blend-output.js';
import { packNormalsWithTangents, validateGeometryTangents } from './tangent-encoding.js';
import { SPLAT_UNITS, requireSplatSupport, layerTextureSupport, LIGHT_SHADING_FEATURE, WETNESS_FEATURE, HEIGHT_MAP_FEATURE, FRAGMENT_SHADOW_POSITION_FEATURE, FADING_SHADOWS_FEATURE, VERTEX_OPACITY_FEATURE, SHADING_MODES, LIGHT_SHADING_MAXIMUM_SAMPLES, createVertexShader, TANGENT_FEATURE, vertexShader, liquidFragmentSource, createFragmentShader, liquidPassDrawer, createDepthFragmentShader, benchmarkVertexShader, benchmarkFragmentShader, viewTransformShader, createDepthVertexShader } from './shaders.js';
import { createGlazeBackend } from './glaze-backend.js';
import { postFragment, createPostFragment, GRID_MOTION_STEP, GRID_DETAIL_STEP, NOISE_OCTAVES_STEP, localVolumeKindSteps, POST_STEPS, POST_STEPS_WITH_OPTIONAL_CODE, skyFragment } from './post.js';
let bloomPyramidPromise = null;
const loadBloomPyramid = () => (bloomPyramidPromise ??= import('./bloom-pyramid.js'));
import { fullscreenVertex, compileProgram, ProgramNotReady, isLinkComplete, setPreparing, releaseStartedPrograms } from './gl-program.js';
import { ambientOcclusionFragment } from './ambient-occlusion.js';
import { planRenderSize, estimateTextureBytes, estimateFrameBytes, memoryBudgetError, automaticBudgetCeilingMiB } from './budget.js';
import { applyProjection } from './camera.js';
import { boundsGrownByParts, fittedNearPlane, sceneBoundsOfParts } from './near-plane-fit.js';
import { installReversedDepth, prepareCameraRelativeProgram } from './reversed-depth.js';
import { isBloomActive, isDitherActive, resolveEffects } from './effects.js';
import { frameDiagnostics, everyCasterOutsideShadowView } from './frame-diagnostics.js';
import { depthLayerOf, flushOrderOf, RANKS_PER_LAYER } from './depth-layer.js';
import { createLightingState, updateLightingState } from './lighting.js';
import { RenderTargetLedger } from './render-target-ledger.js';
import { SHADOW_ATLAS_WIDTH, SHADOW_TILE_SIZE, SHADOW_TILES_PER_ROW, tileViewport, writeShadowTile } from './local-shadows.js';
import { resolveVolumeFog, validateFogField } from './volumetric.js';
import { requireEnvironmentSupport, DEFAULT_SUN_ANGULAR_RADIUS } from './environment-shading.js';
import { DIELECTRIC_GRAZING_STATE_INDEX, materialLayerState, materialLayerValue } from './material-layers.js';
import { MaterialSnapshot } from './material-snapshot.js';
import { wearUniformValues } from './material-wear.js';
import { wetnessKeepOutBoxes, wetnessGroundHeight } from './wetness-keep-out.js';
import { fittedFogDensity } from './fog-fit.js';
import { canUseCompactColor, respecifyColorTargets } from './compact-color.js';
import { TranslucentOrder } from './translucent-order.js';
import { InstanceSelection, extractFrustumPlanes, geometryBoundingSphere, selectInstances } from './render-culling.js';
import { countDraws } from './draw-counter.js';
import { glassFaceTransmittance } from './glass-shadow.js';
import { fitStudioShadowView } from './studio-shadow-fit.js';
import { fitWorldShadowView, resolveShadowLight, shadowBiasPerSlope, sunShadowMapSize, writeShadowLightMatrix } from './shadow-light.js';
import { CLIP_PLANES_FEATURE, MAX_CLIP_PLANES, packClipPlanes, clipPlaneLocations, bindClipPlanes, clipPlanesChanged } from './clip-planes.js';
import { bakeNormalMapVariance } from './normal-map-variance.js';

// Liquid and foam see the resolved opaque scene, so they draw in their own pass after it.
const TRANSLUCENT_TAGS = new Set(['liquid', 'foam']);
// The 42nd float is the opacity of a blend or add part, so parts that differ only in opacity share a batch.
const INSTANCE_STRIDE = 42;
// Most runs of one back to front blended order that draw as they are; more than this and each batch draws whole (#3236).
const MAXIMUM_BLEND_RUNS = 48;
const OPACITY_OFFSET = 41;
// Shaders get this in place of an infinite attenuation distance, which is not a safe uniform value.
const MAX_FINITE_DISTANCE = 3e38;
const ALPHA_MODES = { opaque: 0, mask: 1, blend: 2, add: 3 };

/** Centre of the axis-aligned bounds of a geometry in its own space, where a blended instance is sorted from. */
function boundsCenterOf(geometry) {
  if (!geometry?.positions) return [0, 0, 0];
  const { minimum, maximum } = geometryBoundingSphere(geometry);
  return [(minimum[0] + maximum[0]) / 2, (minimum[1] + maximum[1]) / 2, (minimum[2] + maximum[2]) / 2];
}

const IDENTITY_VIEW = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Draws blended batches back to front as one set: every instance of every batch is ordered together by the view depth
 * of the centre of its bounds (translucent-order.js), then drawn in runs of consecutive instances of one batch, so
 * panes of different materials interleave correctly. A batch whose instances are all in one run draws as one call.
 */
function drawBlendedBatchesInOrder(renderer, batches) {
  if (batches.length === 0) return;
  const order = renderer.translucentOrder ??= new TranslucentOrder(INSTANCE_STRIDE);
  const batchRange = renderer.translucentRange ??= [0, 0];
  const view = renderer.view ?? IDENTITY_VIEW;
  const sortable = renderer.translucentSortable ??= [];
  sortable.length = 0;
  for (const batch of batches) {
  batch.sortCenter ??= boundsCenterOf(batch.parts[0].geometry);
    order.depthRange(batch, view, batchRange);
    batch.sortFarthest = batchRange[0];
    batch.sortNearest = batchRange[1];
    sortable.push(batch);
  }
  sortable.sort((first, second) => first.sortFarthest - second.sortFarthest);
  // Batches whose depth ranges overlap form a group that may interleave; a lone batch in its group draws on its own, as
  // it did before. Groups draw farthest first.
  const group = renderer.translucentGroup ??= [];
  let start = 0;
  while (start < sortable.length) {
    let end = start + 1;
    let nearest = sortable[start].sortNearest;
    while (end < sortable.length && sortable[end].sortFarthest <= nearest) {
      nearest = Math.max(nearest, sortable[end].sortNearest);
      end++;
    }
    group.length = 0;
    for (let index = start; index < end; index++) group.push(sortable[index]);
    drawBlendedGroup(renderer, group, order);
    start = end;
  }
  restoreInstanceOrder(renderer, sortable);
}

/**
 * Additive batches that lie wholly behind every transmissive shell (#3206). The shell reads a copy of the opaque scene,
 * so a beam drawn after it would be hidden by the shell's depth; drawing the beam first puts it in that copy, and the
 * shell attenuates it by its own transmittance only. A beam in front of, or between, shells keeps the order it had.
 * "Behind" compares the view depth of each instance's bounds centre, as the blended order does.
 */
export function additiveBatchesBehindShells(renderer, additiveBatches, shells) {
  if (additiveBatches.length === 0 || shells.length === 0) return [];
  const order = renderer.translucentOrder ??= new TranslucentOrder(INSTANCE_STRIDE);
  const range = renderer.translucentRange ??= [0, 0];
  const view = renderer.view ?? IDENTITY_VIEW;
  let farthestShellDepth = Infinity;
  for (const shell of shells) {
    shell.sortCenter ??= boundsCenterOf(shell.parts[0].geometry);
    farthestShellDepth = Math.min(farthestShellDepth, order.depthRange(shell, view, range)[0]);
  }
  return additiveBatches.filter(batch => {
    if (batch.throughGlass) return false;
    batch.sortCenter ??= boundsCenterOf(batch.parts[0].geometry);
    return order.depthRange(batch, view, range)[1] < farthestShellDepth;
  });
}

/** The liquid and foam pass may have switched program, texture unit 0 and the viewport; blend and add draws restore them. */
function bindAlphaPassState(renderer) {
  const context = renderer.context;
  context.bindFramebuffer(context.FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.viewport(0, 0, renderer.canvas.width, renderer.canvas.height);
  context.enable(context.DEPTH_TEST);
  context.useProgram(renderer.program);
  context.activeTexture(context.TEXTURE0);
  context.bindTexture(context.TEXTURE_2D, renderer.shadowTexture);
  context.uniform1i(renderer.uniforms.shadowMap, 0);
}

/** Draws one group of blended batches in back to front order, interleaving instances only when the group has several batches. */
function drawBlendedGroup(renderer, group, order) {
  const view = renderer.view ?? IDENTITY_VIEW;
  const singleBatch = renderer.translucentSingle ??= [null];
  if (group.length === 1) {
    order.sort(group, view);
    drawBlendedRun(renderer, group[0], 0, group[0].instanceCount);
    return;
  }
  if (order.sort(group, view) > MAXIMUM_BLEND_RUNS) {
    // Past the run budget each batch draws whole in its own order, farthest mean depth first.
    for (const batch of group) {
      singleBatch[0] = batch;
      order.sort(singleBatch, view);
      batch.sortMeanDepth = order.meanDepth(batch.instanceCount);
    }
    group.sort((first, second) => first.sortMeanDepth - second.sortMeanDepth);
    for (const batch of group) {
      singleBatch[0] = batch;
      order.sort(singleBatch, view);
      drawBlendedRun(renderer, batch, 0, batch.instanceCount);
    }
    return;
  }
  for (let run = 0; run < order.runTotal; run++) {
    drawBlendedRun(renderer, group[order.runBatches[run]], order.runStarts[run], order.runCounts[run]);
  }
}

/** Draws `count` instances of a blended batch from the sorted copy in translucentOrder, starting at instance `start` of that copy. */
function drawBlendedRun(renderer, batch, start, count) {
  const context = renderer.context;
  const whole = batch.instanceCount;
  // A lone instance is already what its buffer holds.
  if (whole > 1) {
    context.bindBuffer(context.ARRAY_BUFFER, batch.instanceBuffer);
    context.bufferSubData(context.ARRAY_BUFFER, 0, renderer.translucentOrder.gathered, start * INSTANCE_STRIDE, count * INSTANCE_STRIDE);
  }
  batch.instanceCount = count;
  try {
    renderer.drawAlphaBatch(batch, true);
  } finally {
    batch.instanceCount = whole;
  }
}

function restoreInstanceOrder(renderer, sortable) {
  const context = renderer.context;
  const stride = INSTANCE_STRIDE;
  for (const batch of sortable) {
    if (batch.instanceCount < 2) continue;
    context.bindBuffer(context.ARRAY_BUFFER, batch.instanceBuffer);
    context.bufferSubData(context.ARRAY_BUFFER, 0, batch.instanceData, 0, batch.instanceCount * stride);
  }
}

/** Blend and add draw after the opaque loop, sorted, without writing depth. */
function isTranslucentMode(alphaMode) {
  return alphaMode === 'blend' || alphaMode === 'add';
}
const ZERO_VECTOR = Object.freeze([0, 0, 0]);
/**
 * Whether a material's shader reads the opaque scene behind it (its depth and colour, resolved once per frame before the first
 * blended batch draws). Only water does today: contact foam measures the gap to what lies behind the water. Add a reader here and
 * its batches stay in the blend pass, where the resolve happens, at any opacity.
 */
export function materialReadsOpaqueScene(material) {
  return material.tag === 'water' && material.contactFoam !== undefined;
}

/**
 * Whether a blend batch first draws as a cutout of its fully opaque texels. Most of a baked scene exported as BLEND is opaque, and a
 * cutout writes depth, so it hides whatever lies behind it in any draw order. The cutout draws before the opaque-scene resolve,
 * so a batch whose shader reads that scene stays in the blend pass, where it is drawn after the resolve.
 */
export function blendBatchDrawsCutoutFirst(batch) {
  if (materialReadsOpaqueScene(batch.parts[0].material)) return false;
  for (let index = 0; index < batch.instanceCount; index++) {
    if (batch.instanceData[index * INSTANCE_STRIDE + OPACITY_OFFSET] >= 0.999) return true;
  }
  return false;
}

const MATERIAL_MAPS = ['map', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];
const MAP_UNIFORMS = ['baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];
const MAP_FLAGS = ['hasBaseMap', 'hasNormalMap', 'hasMetallicRoughnessMap', 'hasOcclusionMap', 'hasEmissiveMap'];
const DEFAULT_NORMAL_SCALE = [1, 1];
// The most texture taps a mipmapped texture may take along a grazing axis (16 is the usual hardware ceiling, 8 costs less).
// Anisotropic filtering at 16x keeps a surface seen at about 4 degrees or more sharp; GPUs that allow less get their own limit.
export const DEFAULT_TEXTURE_ANISOTROPY = 16;
const PROCEDURAL_MATERIAL_TAGS = new Set(['water', 'foliage', 'grass', 'terrain', 'floor', 'fire', 'smoke', 'liquid', 'foam']);

// Tags whose vertices sway in the wind; the shadow pass must be redrawn when time moves.
const SWAYING_TAGS = new Set(['foliage', 'grass']);
// One depth rank (applyDepthRank): 0.1 mm, plus 2^-19 of the distance (2 mm at 1 km), plus a quarter of a subpixel of
// slope. On the 24-bit fallback a rank also moves two depth steps, since that buffer cannot hold the metric step far away.
const FLUSH_STEP = 1e-4;
const FLUSH_RELATIVE_STEP = 2 ** -19;
const FLUSH_CLIP_STEP = 2 ** -22;
const FLUSH_SLOPE_STEP = 4 / 256;
const clipPerMetreScratch = new Float32Array(4);
// Tags whose vertex shader moves vertices away from the instance matrix, so a bounding sphere would not hold.
const DEFORMING_TAGS = new Set(['foliage', 'grass', 'water', 'fire', 'smoke']);
// The farthest a vertex of a swaying tag moves in the world, per unit of wind strength (windOffset in shaders.js): foliage
// reaches 0.1 * 2.5 * 1.9 + 0.08 = 0.555 and grass 0.42 + 0.05 + 0.04 = 0.51. Their bounds grow by this much times the
// strength, so they can be culled and given levels like rigid parts.
const SWAY_REACH_PER_STRENGTH = 0.56;

const POST_UNIFORMS = [
  'transparent',
  'frameTexture',
  'bloomTexture',
  'bloomStrength',
  'bloomKeepHue',
  'hdrEnabled',
  'grade',
  'vignette',
  'grainAmount',
  'resolution',
  'monochrome',
  'fade',
  'cinematic',
  'time',
  'volumeExplosion',
  'explosionProgress',
  'inverseViewProjection',
  'eye',
  'sceneDepth',
  'volumeShadowMap',
  'volumeLightProjection',
  'volumeLightDirection',
  'volumeLightColor',
  'volumeDensity',
  'volumeMinimum',
  'volumeMaximum',
  'volumeColor',
  'volumeAmbient',
  'volumeDrift',
  'volumeSteps',
  'volumeAnisotropy',
  'volumeShadowAmbient',
  'volumeGridFog',
  'volumeNoiseAmount',
  'volumeNoiseScale',
  'volumeHeightFalloff',
  'volumeMaxDistance',
  'volumeField',
  'volumeProfile',
  'volumeFlowStrength',
  'volumeFlowPeriod',
  'volumeLightCount',
  'volumeLightPositions[0]',
  'volumeLightColors[0]',
  'volumeLightDirections[0]',
  'volumeLightCones[0]',
  'fogSkyVisibility',
  'orthographic',
  'occlusionTexture',
  'occlusionStrength',
  'occlusionTexel',
  'autoExposureScale',
];

function uniformLocations(context, program, names) {
  return Object.fromEntries(names.map(name => [name, context.getUniformLocation(program, name)]));
}

function postUniformLocations(context, program) {
  return uniformLocations(context, program, POST_UNIFORMS);
}

const LOCAL_LIGHT_BLOCK_FIELDS = [
  ['pointLightPositions', 'positions'], ['pointLightColors', 'colors'], ['pointLightRadii', 'radii'], ['pointLightShadowTiles', 'pointShadows'],
  ['spotLightPositions', 'spotPositions'], ['spotLightColors', 'spotColors'], ['spotLightDirections', 'spotDirections'], ['spotLightParameters', 'spotParameters'],
  ['areaLightPositions', 'areaPositions'], ['areaLightColors', 'areaColors'], ['areaLightNormals', 'areaNormals'], ['areaLightTangents', 'areaTangents'],
  ['fillLightColors', 'fillColors'],
];

function validateGeometryForMaterial(geometry, material, checkFiniteUvs = false) {
  const vertexCount = geometry.positions.length / 3;
  if (geometry.uvs && geometry.uvs.length !== vertexCount * 2) throw new Error('Geometry UV count must match the vertex count.');
  if (hasMaterialMap(material) && !geometry.uvs && !geometry.lightUvs && !material.boxMapScale) throw new Error('Textured geometry requires UV channel 0.');
  if (checkFiniteUvs) {
    for (const coordinate of geometry.uvs ?? []) {
      if (!Number.isFinite(coordinate)) throw new Error('Geometry UVs must be finite.');
    }
  }
  if (geometry.colors && geometry.colors.length !== geometry.positions.length) throw new Error('Geometry colors must contain RGB for every vertex.');
}

function batchAlphaState(batch) {
  return [batch.alphaMode, batch.alphaCutoff, batch.opacity, batch.doubleSided, batch.retro, batch.waterGlint, batch.depthTest !== false, batch.throughGlass === true];
}

function assertShadowFramebufferComplete(context, label) {
  if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error(`${label} framebuffer is incomplete.`);
}

function requireNewRenderer(reason, part) {
  throw new Error(`${reason} require a new renderer: ${part.name}`);
}

const MAP_SHADER_FEATURES = ['baseMap', 'normalMap', 'metallicRoughnessMap', 'occlusionMap', 'emissiveMap'];
// Part or material fields that name their shader feature and switch it on when set.
const PRESENT_SHADER_FEATURES = [
  CLIP_PLANES_FEATURE,
  'crowd',
  'emissionMask',
  'irradianceGrid',
  'lightMap',
  'morph',
  'retro',
  'skin',
  'surfaceCover',
  'waterGlint',
  'waterReflection',
];
// Material fields that name their shader feature and switch it on above zero.
const POSITIVE_SHADER_FEATURES = [
  'anisotropy',
  'boxMapScale',
  'emissionFresnel',
  'iridescence',
  'moss',
  'softEdge',
  'toon',
];
// Tags whose look the main fragment shader draws with code that other tags never reach.
const TAG_SHADER_FEATURES = new Set([
  'fire',
  'floor',
  'foliage',
  'grass',
  'smoke',
  'terrain',
  'unlit',
  'water',
]);

function shaderFeaturesOfLighting(lighting) {
  const features = [];
  if (lighting.spotCount > 0) features.push('spotLights');
  if (lighting.areaCount > 0) features.push('areaLights');
  if (lighting.shadowCasters.length > 0) features.push('localShadows');
  if (lighting.extraFeatures) features.push(...lighting.extraFeatures);
  if (lighting.fillIntensity > 0) features.push('fill');
  if (lighting.wetness > 0) features.push(WETNESS_FEATURE);
  return features;
}

/**
 * A few parts that need the same shader features as all of `parts`, plus one instanced pair when any geometry repeats.
 * A renderer built on these compiles the program the whole scene needs; replaceParts then adds the rest without a recompile.
 */
export function shaderFeatureRepresentatives(parts) {
  const covered = new Set();
  const representatives = [];
  const firstOfGeometry = new Map();
  let instancedPair = null;
  for (const part of parts) {
    const features = shaderFeaturesOfParts([part]);
    if ([...features].some(feature => !covered.has(feature))) {
      features.forEach(feature => covered.add(feature));
      representatives.push(part);
    }
    if (!instancedPair && firstOfGeometry.has(part.geometry)) instancedPair = [firstOfGeometry.get(part.geometry), part];
    else if (!firstOfGeometry.has(part.geometry)) firstOfGeometry.set(part.geometry, part);
  }
  if (instancedPair) for (const part of instancedPair) if (!representatives.includes(part)) representatives.push(part);
  return representatives.length > 0 ? representatives : parts.slice(0, 1);
}

export function shaderFeaturesOfParts(parts) {
  const features = new Set();
  for (const part of parts) {
    const { material } = part;
    for (const name of PRESENT_SHADER_FEATURES) {
      if (part[name] || material[name]) features.add(name);
    }
    MATERIAL_MAPS.forEach((field, index) => {
      if (material[field]) features.add(MAP_SHADER_FEATURES[index]);
    });
    if (castsTintedShadow(part)) features.add('tintedShadows');
    if (part.opacityScale && castsTintedShadow(part)) features.add(FADING_SHADOWS_FEATURE);
    if (material.environmentProbe) features.add('probe');
    if (material.normalMap?.uvTransform) features.add('normalMapTransform');
    if (usesHeightParallax(material)) features.add(HEIGHT_MAP_FEATURE);
    Object.keys(material.layerMaps ?? {}).forEach(name => features.add(name));
    if (material.layers) features.add('splat');
    for (const name of POSITIVE_SHADER_FEATURES) {
      if (material[name] > 0) features.add(name);
    }
    if (material.lightMask !== undefined) features.add('lightLinking');
    if ((material.alphaMode ?? 'opaque') !== 'opaque') features.add('alphaMode');
    if (material.subsurface?.weight > 0) features.add('subsurface');
    if (material.wear) features.add('surfaceWear');
    if (material.snippet) {
      features.add(material.snippet.feature);
      // A water hook reads the water values the world material code declares, so that code is compiled in.
      if (/\bvoid\s+waterHook\s*\(/.test(material.snippet.fragment)) features.add('water');
    }
    if (materialLayerValue(material, 'clearcoat') > 0) features.add('clearcoat');
    if (materialLayerValue(material, 'sheenColor').some(channel => channel !== 0)) features.add('sheen');
    if (TAG_SHADER_FEATURES.has(material.tag)) features.add(material.tag);
    // Without vertex colours the tint and sky visibility are the constants of the unbound attribute, so no varying carries them.
    if ([part.geometry, ...(part.lods ?? []).map(level => level.geometry)].some(geometry => geometry.colors || vertexAlpha(geometry))) features.add('vertexColors');
    // Particles that fade by opacity carry it in the fourth colour component; the shader reads it as the alpha of a blend draw.
    if (part.geometry.vertexOpacity) features.add(VERTEX_OPACITY_FEATURE);
    else if ([part.geometry, ...(part.lods ?? []).map(level => level.geometry)].some(geometry => hasVertexAlpha(geometry))) features.add('vertexAlpha');
    // Vertex tangents replace the screen-derivative frame of a normal map; a box-mapped material projects its map and has no UV frame.
    if (material.normalMap && !material.boxMapScale && [part.geometry, ...(part.lods ?? []).map(level => level.geometry)].some(geometry => geometry.tangents)) features.add(TANGENT_FEATURE);
  }
  return features;
}

function renderPass(material) {
  if (material.transmission > 0) return 'liquid';
  return TRANSLUCENT_TAGS.has(material.tag) ? material.tag : 'opaque';
}

// A shadow-only part joins the shadow passes and none of the colour, depth or ID passes, so the camera never sees it.
function partPass(part) {
  return part.shadowOnly === true ? 'shadowOnly' : renderPass(part.material);
}

function batchPass(batch) {
  return batch.pass ?? 'opaque';
}

const SKIN_UNIFORMS = ['skinEnabled', 'skinInfluences', 'jointPalette', 'crowdEnabled'];
const ALPHA_UNIFORMS = ['alphaMode', 'alphaCutoff', 'materialOpacity', 'alphaToCoverage', 'doubleSided'];
const DEPTH_ALPHA_UNIFORMS = ['alphaMasked', 'alphaCutoff', 'materialOpacity', 'hasBaseMap', 'baseMap', 'tintPass', 'tintTransmission', 'tintFaceTransmittance', 'tintMapSize', 'tintBias', 'opaqueShadow', 'shadowDither'];
const MORPH_UNIFORMS = ['morphEnabled', 'morphVertexCount', 'morphTargetCount', 'morphWeights[0]', 'morphSlotTargets[0]', 'morphTargets'];
const ENVIRONMENT_LOOKUP_UNIFORMS = ['environmentSpecular', 'environmentEnabled', 'environmentIntensity', 'environmentRotation', 'environmentLevelMax'];
const ENVIRONMENT_UNIFORMS = [...ENVIRONMENT_LOOKUP_UNIFORMS, 'environmentBrdf', 'environmentIrradiance[0]', 'environmentBounce', 'environmentDiffuseFrame'];
// Shares a unit with the skin influence texture, which no light-mapped (rigid) batch binds.
const LIGHT_MAP_UNIT = 6;
// The parallax state is the last entries of materialMapState, [heightMap, depth, fade, steps], and only a material that draws its heightMap has them. Its start is the length of the state of a material without them, read from the array itself, so a field added before it cannot leave the offset stale.
let cachedHeightStateOffset = null;
function heightStateOffset() {
  cachedHeightStateOffset ??= materialMapState({}).length;
  return cachedHeightStateOffset;
}
const ENVIRONMENT_SPECULAR_UNIT = 9;
const ENVIRONMENT_BRDF_UNIT = 10;
const LOCAL_SHADOW_UNIT = 15;
// Tinted shadows: one half float map holds the colour of the light that blended and transmissive casters let through (rgb)
// and the depth of the nearest one (alpha). Units 0 to 15 are all taken somewhere, and 13 is the one only a part with three
// layer textures also reads, so those parts are blind to the tint (batch.tintBlind). Splat layers keep off it (SPLAT_UNITS).
const TINT_UNIT = 13;
const TINT_MAP_SIZE = 1024;
// The shadow program's opaqueShadow sampler reads the sun map on this unit in the tint draw. Unit 0 would read the map while
// the opaque pass renders into it, a feedback loop that drops every opaque shadow caster.
const OPAQUE_SHADOW_UNIT = 2;
// The light arrays are not here: they live in the LightData uniform block (light-uniform-block.js).
const LIGHT_UNIFORMS = ['pointLightCount', 'spotLightCount', 'areaLightCount', 'localShadowAtlas', 'keyColor', 'fillIntensity', 'ambientIntensity', 'ambientColor', 'ambientGroundDelta', 'ambientMix', 'specularAntiAliasing'];
const SPLAT_UNIFORMS = ['splatEnabled', 'splatColor', 'splatNormal', 'splatPacked', 'splatMask', 'splatLayer[0]', 'splatTint[0]', 'splatSlope[0]', 'splatHeightRange[0]', 'splatMaskChannel[0]', 'splatMaskInvert[0]', 'splatBlend', 'splatOptions', 'splatMaskBounds', 'splatVariation'];

function validateMaterialMaps(material) {
  if (PROCEDURAL_MATERIAL_TAGS.has(material.tag)) {
    for (let index = 1; index < MATERIAL_MAPS.length; index++) {
      // Scanned leaf cards carry a normal map; the swaying tags apply it on top of their canopy normal.
      const leafNormalMap = MATERIAL_MAPS[index] === 'normalMap' && SWAYING_TAGS.has(material.tag);
      if (material[MATERIAL_MAPS[index]] && !leafNormalMap) throw new Error('Material maps require a standard PBR material tag. Procedural tags accept only a base map, and foliage and grass also a normal map.');
    }
  }
  if (material.tag === 'unlit' && (material.normalMap || material.metallicRoughnessMap || material.occlusionMap)) {
    throw new Error('Unlit materials support only base and emissive maps.');
  }
  const normalScale = material.normalScale ?? DEFAULT_NORMAL_SCALE;
  if (normalScale.length !== 2 || !Number.isFinite(normalScale[0]) || !Number.isFinite(normalScale[1]) || !Number.isFinite(Math.fround(normalScale[0])) || !Number.isFinite(Math.fround(normalScale[1]))) throw new Error('normalScale must contain two finite floats.');
  const occlusionStrength = material.occlusionStrength ?? 1;
  if (!Number.isFinite(occlusionStrength) || occlusionStrength < 0 || occlusionStrength > 1) throw new Error('occlusionStrength must be within zero and one.');
  validateMoss(material);
}

const DEFAULT_MOSS_COLOR = Object.freeze([0.05, 0.085, 0.02]);

function validateMoss(material) {
  if (material.moss === undefined) return;
  if (typeof material.moss !== 'number' || !(material.moss >= 0 && material.moss <= 1)) throw new Error('moss must be within zero and one.');
  if (material.moss > 0 && PROCEDURAL_MATERIAL_TAGS.has(material.tag)) throw new Error('Moss needs a standard PBR material tag.');
  const color = material.mossColor ?? DEFAULT_MOSS_COLOR;
  if (!Array.isArray(color) || color.length !== 3 || !color.every(Number.isFinite)) throw new Error('mossColor must be three linear RGB numbers.');
}

/** Moss amount and linear colour, as the shader's materialMoss uniform. */
function mossState(material) {
  return [material.moss ?? 0, ...(material.mossColor ?? DEFAULT_MOSS_COLOR)];
}

function materialMapState(material) {
  validateMaterialMaps(material);
  const normalScale = material.normalScale ?? DEFAULT_NORMAL_SCALE;
  const occlusionStrength = material.occlusionStrength ?? 1;
  if (material.layers || material.splat) requireSplatSupport().validate(material);
  if (material.layers && PROCEDURAL_MATERIAL_TAGS.has(material.tag)) throw new Error('Splat layers require a standard PBR material tag.');
  return [...MATERIAL_MAPS.map(field => material[field] ?? null), normalScale[0], normalScale[1], occlusionStrength, ...mossState(material), material.boxMapScale ?? 0, material.boxMapAxis ?? 1, ...lightMapState(material), material.layers ?? null, material.splat ?? null, material.layerMaps ?? null, material.environmentProbe ?? null, material.waterReflection ?? null, material.irradianceGrid ?? null, material.wear ?? null, material.surfaceCover ?? null, material.foamEdge ?? null, material.foamWidth ?? null, material.foamColor ?? null, material.foamVeins ?? null, material.contactFoam ?? null, material.waterRamp ?? null, material.ripples ?? null, ...heightMapState(material)];
}

// A baked light map reads the second UV set, so it is only drawn for parts that cannot be skinned or morphed.
function lightMapState(material) {
  if (!material.lightMap) return [null, 0];
  const scale = material.lightMapScale ?? 1;
  if (!Number.isFinite(scale) || scale < 0) throw new RangeError('lightMapScale must be a nonnegative number.');
  if ((material.lightMap.colorSpace ?? 'srgb') !== 'srgb') throw new Error('lightMap requires an srgb texture descriptor.');
  return [material.lightMap, scale];
}

/** Whether a material's parallax differs from the state a batch kept; a batch of a material without parallax keeps no entries. */
function heightParallaxChanged(material, mapState) {
  const kept = mapState.slice(heightStateOffset());
  const next = heightMapState(material);
  return next.length !== kept.length || next.some((value, index) => value !== kept[index]);
}

/** Whether a material draws its heightMap: a map and a heightScale above zero. A zero scale leaves the map unread and the shader unchanged. */
function usesHeightParallax(material) {
  return material.heightScale > 0 && Boolean(material.heightMap);
}

/** [heightMap, depth, fade distance, ray steps] of a material that draws its heightMap, from the lazy height-parallax-shader module; [] for every other material. */
function heightMapState(material) {
  return usesHeightParallax(material) ? requireHeightParallaxSupport().state(material, PROCEDURAL_MATERIAL_TAGS) : [];
}

function validateAlphaMaterial(material) {
  const alphaMode = material.alphaMode ?? 'opaque';
  if (!Object.hasOwn(ALPHA_MODES, alphaMode)) throw new Error("alphaMode must be 'opaque', 'mask', 'blend' or 'add'.");
  for (const field of ['alphaCutoff', 'opacity']) {
    const value = material[field] ?? 1;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${field} must be a number within zero and one.`);
  }
  for (const flag of ['doubleSided', 'depthTest', 'throughGlass']) if (material[flag] !== undefined && typeof material[flag] !== 'boolean') throw new TypeError(`${flag} must be a boolean`);
}

/** Opacity of one instance: blend and add parts carry it per instance, so it never splits a batch. A part's `opacityScale.value` (0 to 1) multiplies it. */
export function instanceOpacity(material, part) {
  const alphaMode = material.alphaMode ?? 'opaque';
  return isTranslucentMode(alphaMode) ? ((material.opacity ?? 1) + (material.opacityBias ?? 0)) * (part?.opacityScale?.value ?? 1) : 1;
}

/** Alpha settings that every instance of one draw call must share. Fields that a mode ignores, and the per-instance opacity, are normalized away. */
function materialAlphaState(material) {
  validateAlphaMaterial(material);
  const alphaMode = material.alphaMode ?? 'opaque';
  const alphaCutoff = alphaMode === 'mask' ? material.alphaCutoff ?? 0.5 : 0;
  // Glass that blends keeps its alpha as coverage over the refracted picture (the liquid pass reads it); other blend parts carry alpha in the shader.
  const opacity = alphaMode === 'mask' || (alphaMode === 'blend' && material.transmission > 0) ? (material.opacity ?? 1) + (material.opacityBias ?? 0) : 1;
  return [alphaMode, alphaCutoff, opacity, material.doubleSided === true, material.retro, material.waterGlint, material.depthTest !== false, material.throughGlass === true];
}

// A decal or depth layer draws with a scoped polygon offset so it wins against the surface it lies on (z-fighting).
// Larger layers win over smaller ones; geometry never moves.

// Additive light is not a shadow caster unless the part asks for it. A blended part lying on a surface (a decal) would shade
// the surface it covers, so it casts only when asked too. A shadow catcher only shows the shadow it receives, so it never
// casts one unless the part asks for it. Other blended parts cast a shadow weighted by their opacity.
/**
 * Whether a part is drawn into the sun's shadow map. A water sheet defaults to no: the water shader already dims the sun
 * along its leg through the water (Beer-Lambert), and a sheet that also shadowed itself drew dark blocks on the sea,
 * where its own facets met the shadow map. Set `castShadow: true` to make a sheet cast anyway.
 */
export function castsShadow(part) {
  const alphaMode = part.material.alphaMode ?? 'opaque';
  const decal = alphaMode === 'blend' && depthLayerOf(part) > 0;
  const waterSheet = part.material.tag === 'water';
  return part.castShadow ?? !(part.shadowCatcher === true || alphaMode === 'add' || decal || waterSheet);
}

/** A caster whose shadow is weighted by opacity or tinted by its colour: blended and transmissive parts. */
function castsTintedShadow(part) {
  return castsShadow(part) && part.material.tag !== 'floor' && ((part.material.alphaMode ?? 'opaque') === 'blend' || part.material.transmission > 0);
}

const receivesShadow = part => part.receiveShadow !== false;

// Uniform value of a batch: 0 draws normally, 1 is a holdout (zero colour, zero alpha), 2 is a shadow catcher (black, alpha = shadow).
const compositeModeOf = part => (part.holdout === true ? 1 : part.shadowCatcher === true ? 2 : 0);

const BOOLEAN_PART_FLAGS = ['castShadow', 'receiveShadow', 'holdout', 'shadowCatcher', 'shadowOnly', 'visible'];

function validatePartFlags(part) {
  for (const flag of BOOLEAN_PART_FLAGS) {
    if (part[flag] !== undefined && typeof part[flag] !== 'boolean') throw new TypeError(`${flag} must be a boolean`);
  }
  if (part.holdout === true && part.shadowCatcher === true) throw new Error(`A part is a holdout or a shadow catcher, not both: ${part.name}`);
}

/** A hidden part keeps its slot in the batch but draws and casts nothing: its instance matrices are packed as zeros. */
const isHidden = part => part.visible === false || part.visibility?.visible === false;

function hasMaterialMap(material) {
  return MATERIAL_MAPS.some(field => material[field]);
}

// Math.fround turns a double of 2^128 - 2^103 or more into Infinity, so that is the first value that is not a finite float.
const FLOAT_OVERFLOW = 2 ** 128 - 2 ** 103;

function finiteFloat(value) {
  return typeof value === 'number' && value > -FLOAT_OVERFLOW && value < FLOAT_OVERFLOW;
}

function finiteVector(value, size) {
  if (value?.length !== size) return false;
  if (value instanceof Float32Array) {
    // Every float is already in range, so it is finite exactly when 0 * value is 0 and not NaN. This runs without a branch per element.
    let zeroSum = 0;
    for (let index = 0; index < size; index++) zeroSum += value[index] * 0;
    return zeroSum === 0;
  }
  for (let index = 0; index < size; index++) if (!finiteFloat(value[index])) return false;
  return true;
}

/** A hidden part packs zeros instead of its matrix, so its matrix is not checked; its material still is. */
function validateTransform(part, normalMatrix = mat3.create(), hidden = false) {
  if (!hidden && !finiteVector(part.matrix, 16)) throw new Error(`Invalid transform: ${part.name}`);
  if (!hidden && (!mat3.normalFromMat4(normalMatrix, part.matrix) || !finiteVector(normalMatrix, 9))) throw new Error(`Singular transform: ${part.name}. Hide a part with part.visible = false.`);
  // An absent emissive colour or assembly offset packs as the base colour or zero, which need no second check.
  const material = part.material;
  const assembly = part.assembly;
  if (!finiteVector(material.color, 3) || (material.emissiveColor !== undefined && !finiteVector(material.emissiveColor, 3)) ||
      (assembly && (!finiteVector(assembly.offset ?? ZERO_VECTOR, 3) || !finiteVector(assembly.detailOffset ?? ZERO_VECTOR, 3)))) {
    throw new Error(`Invalid instance vector: ${part.name}`);
  }
  if (!finiteFloat(part.material.metallic) || !finiteFloat(part.material.roughness) || !finiteFloat(part.material.emission ?? 0)) throw new Error(`Invalid material: ${part.name}`);
  return normalMatrix;
}

// TypedArray.set costs more per call than three stores, and a loop shared by every vector length reads its source through a slow polymorphic path.
function copyVector3(target, offset, source) {
  target[offset] = source[0];
  target[offset + 1] = source[1];
  target[offset + 2] = source[2];
}

/**
 * True when the matrix reflects space (negative determinant of its upper 3x3, column major), which reverses the screen
 * winding of every triangle. The renderer owns this: it groups such parts apart and draws them with clockwise front faces.
 */
export function isMirroredMatrix(matrix) {
  const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9])
    + matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]);
  return determinant < 0;
}

function packInstance(data, index, part, normalMatrix) {
  const offset = index * INSTANCE_STRIDE;
  const material = part.material;
  // A fully faded part draws nothing: a blended surface keeps its specular glints at zero alpha, so it is hidden like a visible: false part.
  if (isHidden(part) || part.opacityScale?.value === 0) {
    data.fill(0, offset, offset + 25);
  } else {
    data.set(part.matrix, offset);
    data.set(normalMatrix, offset + 16);
  }
  copyVector3(data, offset + 25, material.color);
  data[offset + 28] = material.metallic;
  data[offset + 29] = material.roughness;
  data[offset + 30] = material.emission ?? 0;
  data[offset + 31] = materialTags[material.tag] ?? 0;
  copyVector3(data, offset + 32, part.assembly?.offset ?? ZERO_VECTOR);
  copyVector3(data, offset + 35, part.assembly?.detailOffset ?? ZERO_VECTOR);
  copyVector3(data, offset + 38, material.emissiveColor ?? material.color);
  data[offset + OPACITY_OFFSET] = instanceOpacity(material, part);
}

// The objectId mode of RENDER_PASS_MODES in render-passes.js.
const OBJECT_ID_PASS_MODE = 5;
const CRYPTOMATTE_PASS_MODE = 17;
/** Alpha at or above which a blended texel counts as part of its object in the ID passes. */
const ID_PASS_BLEND_CUTOFF = 0.5;

function isCullable(parts) {
  const first = parts[0];
  if (first.skin || first.morph) return false;
  if (DEFORMING_TAGS.has(first.material.tag) && !SWAYING_TAGS.has(first.material.tag)) return false;
  if (renderPass(first.material) !== 'opaque' || isTranslucentMode(materialAlphaState(first.material)[0])) return false;
  return parts.every(part => !part.assembly || part.crowd);
}

/** Whether a part may take `lods`: rigid or swaying and opaque, without assembly motion (the parts that culling can choose levels for). */
export function partTakesLods(part) {
  return isCullable([part]);
}

function validateLods(part, levels) {
  if (!Array.isArray(levels) || levels.length < 2 || levels[0].geometry !== part.geometry) {
    throw new TypeError(`lods must list level 0 (the own geometry of the part) and at least one coarser level: ${part.name}`);
  }
  levels.forEach((level, index) => {
    if (!level.geometry?.positions || !level.geometry.indices) throw new TypeError(`Every lods entry needs a geometry: ${part.name}`);
    if (!Number.isFinite(level.error) || level.error < 0 || (index > 0 && level.error < levels[index - 1].error)) {
      throw new RangeError(`lods errors must be finite and not decrease from level to level: ${part.name}`);
    }
  });
}

/** Every geometry a part can draw: its own, the levels of `lods` and the levels of `shadowLods`. */
function partGeometries(part) {
  const drawn = [part.geometry, ...(part.lods ?? []).map(level => level.geometry), ...(part.shadowLods ?? []).map(level => level.geometry)];
  // A part with hidden flush faces cut away draws its cut geometry, which lives and is released like any other.
  const clipped = flushOrderOf(part)?.geometry;
  if (clipped) drawn.push(clipped);
  return drawn;
}

/** The state of one list of levels: errors, geometries, the draw of each level once it is first needed, and a selection. */
function createLevelSet(levels, instanceCount) {
  return { levelErrors: levels.map(level => level.error), levelGeometries: levels.map(level => level.geometry), levelDraws: [], selection: new InstanceSelection(instanceCount, levels.length) };
}

/**
 * The studio floor sits at y 0.019. When that would hide more than a tenth of the scene's height (a pencil, a hand that
 * hangs below y 0), it sits 2% up from the scene's lowest point instead, so small objects are not buried (issue #468).
 * Scenes a metre or more tall resting on y 0, and large scenes that dip below it, keep the floor where it was.
 */
export function studioFloorHeight(parts) {
  let bottom = Infinity;
  let top = -Infinity;
  for (const { geometry, matrix } of parts) {
    if (!geometry?.positions?.length || !matrix) continue;
    // The world heights of the part's local box: each axis adds its row-one term at the box's lower or upper end.
    const { minimum, maximum } = geometryBoundingSphere(geometry);
    let low = matrix[13];
    let spread = 0;
    for (let axis = 0; axis < 3; axis++) {
      const scale = matrix[1 + axis * 4];
      low += Math.min(scale * minimum[axis], scale * maximum[axis]);
      spread += Math.abs(scale) * (maximum[axis] - minimum[axis]);
    }
    bottom = Math.min(bottom, low);
    top = Math.max(top, low + spread);
  }
  const height = top - bottom;
  return 0.019 - bottom > height * 0.1 ? bottom + height * 0.02 : 0.019;
}

/** The studio floor as a part: a 200 by 200 plane at `height` with the floor shader. */
export function groundPart(height = 0.019) {
  return {
    name: 'Studio floor',
    geometry: {
      positions: new Float32Array([-100, height, -100, -100, height, 100, 100, height, 100, 100, height, -100]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
    matrix: mat4.create(),
    material: { color: [0.04, 0.05, 0.06], metallic: 0, roughness: 1, emission: 0, tag: 'floor' },
  };
}

// The skin and morph code loads with skinning.js and morph.js (any module that makes a pose imports them), so a part without
// a skin or morph targets never reaches it.
const skinSupport = () => requireDeformationSupport('validateSkinGeometry', 'skinning.js');
// A draw applies at most MAX_MORPH_TARGETS targets. With more stored, the draw uploads the largest weights and their indices.
const MORPH_SLOT_COUNT = MAX_MORPH_TARGETS;
const IDENTITY_MORPH_SLOTS = Float32Array.from({ length: MORPH_SLOT_COUNT }, (_, index) => index);
const MORPH_SLOT_TARGETS = new Float32Array(MORPH_SLOT_COUNT);
const MORPH_SLOT_WEIGHTS = new Float32Array(MORPH_SLOT_COUNT);
const morphSupport = () => requireDeformationSupport('validateMorphGeometry', 'morph.js');
const hasSkinData = part => Boolean(part.skin || part.geometry.skinIndices || part.geometry.skinWeights);
const hasMorphData = part => Boolean(part.morph || part.geometry.morphTargets !== undefined);

const validateDeformedTag = (kind, part, allowLiquid) => {
  const tag = part.material.tag;
  if ((!allowLiquid || tag !== 'liquid') && PROCEDURAL_MATERIAL_TAGS.has(tag)) throw new Error(`${kind} parts require a standard material tag.`);
};

function validatePartForGrouping(part, morphInfos) {
  const hidden = isHidden(part);
  validateTransform(part, undefined, hidden);
  validatePartFlags(part);
  if (part.clipPlanes !== undefined) packClipPlanes(part.clipPlanes, new Float32Array(MAX_CLIP_PLANES * 4), `Part "${part.name}" clipPlanes`);
  if (hasSkinData(part)) {
    const { validateSkinGeometry, validateSkinPose } = skinSupport();
    validateSkinGeometry(part.geometry, part.skin);
    if (part.skin && !hidden) validateSkinPose(part.skin, part.geometry, part.matrix);
  }
  if (part.skin) validateDeformedTag('Skinned', part, false);
  if (hasMorphData(part)) {
    const { validateMorphGeometry, validateMorphPose, validateMorphTransform } = morphSupport();
    if (!morphInfos.has(part.geometry)) morphInfos.set(part.geometry, validateMorphGeometry(part.geometry, part.morph));
    else validateMorphPose(part.morph, morphInfos.get(part.geometry));
    if (part.morph && !hidden) validateMorphTransform(part.morph, morphInfos.get(part.geometry), part.matrix, part.skin);
  }
  if (part.morph) validateDeformedTag('Morphed', part, true);
}

/**
 * Groups parts into batches one part at a time, in the order they arrive: a batch starts at the first part with its key and
 * collects every later part with the same key. Adding parts later gives the batches a single call over all of them would give.
 */
function createPartGrouper(batching) {
  // One flat map from a compact string key to a batch: a nested map per key value cost about 12 KB for every batch.
  const batchesByKey = new Map();
  const batches = [];
  const morphInfos = new Map();
  const materialKeyValues = new Map();
  const materialKeyTails = new Map();
  // A key value (a geometry, a material map, a flag) is replaced by a small number, so the key stays a short string.
  const valueNumbers = new Map();
  function numberOf(value) {
    let number = valueNumbers.get(value);
    if (number === undefined) {
      number = valueNumbers.size;
      valueNumbers.set(value, number);
    }
    return number;
  }
  function addPart(part) {
    validatePartForGrouping(part, morphInfos);
    // Thousands of parts share a few materials, so the material half of the key is built once per material.
    let materialValues = materialKeyValues.get(part.material);
    if (!materialValues) {
      materialValues = [...materialMapState(part.material), ...materialLayerState(part.material)];
      materialKeyValues.set(part.material, materialValues);
    }
    let materialTail = materialKeyTails.get(part.material);
    if (!materialTail) {
      materialTail = [renderPass(part.material), part.material.windScale ?? null, ...materialAlphaState(part.material), part.material.aovMap ?? null, part.material.transmissionMap ?? null, ...(part.material.aov ?? ZERO_VECTOR)];
      materialKeyTails.set(part.material, materialTail);
    }
    const values = [batching ? part.geometry : part, ...materialValues, part.skin ?? null, part.material.snippet, part.crowd ?? null, part.morph ?? null, castsShadow(part), receivesShadow(part), compositeModeOf(part), part.shadowOnly === true, depthLayerOf(part), flushOrderOf(part), part.lods ?? null, part.shadowLods ?? null, isMirroredMatrix(part.matrix), part.clipPlanes ?? null, ...materialTail];
    const key = values.map(numberOf).join(',');
    let batch = batchesByKey.get(key);
    if (!batch) {
      batch = [];
      batchesByKey.set(key, batch);
      batches.push(batch);
    }
    batch.push(part);
  }
  return {
    batches,
    addParts(parts) {
      for (const part of parts) addPart(part);
    },
  };
}

export function groupParts(parts, batching = true) {
  const grouper = createPartGrouper(batching);
  grouper.addParts(parts);
  return grouper.batches;
}

/**
 * Groups a world that grows, as replaceParts({ retainedUnchanged: true }) receives it in slices.
 * When `parts` starts with the parts of `previous`, the appended parts join the batches built so far: a new part lands in the
 * batch that already has its key, or starts a batch after the others, which is where groupParts over the whole list puts it. Only
 * the appended parts are grouped and validated. Anything else, including a state left behind by a failed call, groups the whole list.
 * Returns the batches and the state to pass on the next call. The batches of a state that continues grow in place, so use them
 * before grouping again.
 */
export function groupPartsIncrementally(previous, parts, batching = true) {
  const startsWithPrevious = Boolean(previous?.intact) && batching && previous.parts.length <= parts.length &&
    previous.parts.every((part, index) => part === parts[index]);
  if (startsWithPrevious) {
    // The grouper changes as it takes parts, so a call that throws leaves this state unusable.
    previous.intact = false;
    const appended = parts.slice(previous.parts.length);
    previous.grouper.addParts(appended);
    for (const part of appended) previous.geometries.add(part.geometry);
    const { grouper, geometries } = previous;
    return { batches: grouper.batches, state: { parts: parts.slice(), geometries, batches: grouper.batches, grouper, intact: true } };
  }
  const grouper = createPartGrouper(batching);
  grouper.addParts(parts);
  return { batches: grouper.batches, state: { parts: parts.slice(), geometries: new Set(parts.map(part => part.geometry)), batches: grouper.batches, grouper, intact: true } };
}

/**
 * Groups the world and its floor for replaceParts. Without `retainedUnchanged` this is groupParts over the parts and the floor, with no state kept.
 * With it, only the appended slice is grouped; the floor is one more batch unless it shares a geometry with a world part,
 * where groupParts would have merged them, so that case groups everything.
 */
export function groupWorld(previous, parts, groundPart, batching, retainedUnchanged) {
  if (!retainedUnchanged) return { batches: groupParts(groundPart ? [...parts, groundPart] : parts, batching), state: null };
  const grouped = groupPartsIncrementally(previous, parts, batching);
  if (!groundPart) return grouped;
  const floorMerges = grouped.state.geometries.has(groundPart.geometry);
  const batches = floorMerges ? groupParts([...parts, groundPart], batching) : [...grouped.batches, ...groupParts([groundPart], batching)];
  return { batches, state: grouped.state };
}

// Sampler state and mipmaps of the texture bound to TEXTURE_2D, once its level 0 is uploaded. Needs only the renderer's context and applyAnisotropy.
// `bakesNormalVariance` marks a normal map: its mip chain is built from the texels with the spread of each level in alpha (src/normal-map-variance.js).
export function configureTexture(renderer, info, { bakesNormalVariance = false } = {}) {
  const context = renderer.context;
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, info.wrapS);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, info.wrapT);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, info.minFilter);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, info.magFilter);
  if (info.mipmaps) {
    if (info.mipLevels) {
      uploadProvidedMipLevels(context, info);
    } else {
      const baked = bakesNormalVariance && bakeNormalMapVariance(context, context.getParameter(context.TEXTURE_BINDING_2D), info.width, info.height);
      if (!baked) context.generateMipmap(context.TEXTURE_2D);
    }
    if (filtersSmoothly(info)) renderer.applyAnisotropy(context.TEXTURE_2D);
  }
}

// A descriptor with its own mip chain (alpha-tested leaf cards, whose coverage a box filter loses) uploads levels 1 and down as given.
function uploadProvidedMipLevels(context, { mipLevels, linear }) {
  mipLevels.forEach((level, index) => {
    context.texImage2D(context.TEXTURE_2D, index + 1, linear ? context.RGBA8 : context.SRGB8_ALPHA8, level.width, level.height, 0, context.RGBA, context.UNSIGNED_BYTE, level.data);
  });
}

function validateMipLevels(mipLevels, width, height) {
  const valid = mipLevels?.length === Math.floor(Math.log2(Math.max(width, height))) && mipLevels.every((level, index) => (
    level.width === Math.max(1, width >> (index + 1)) && level.height === Math.max(1, height >> (index + 1)) && level.data?.length === level.width * level.height * 4));
  if (!valid) throw new Error(`mipLevels must be every level below the ${width}x${height} image, each width x height x 4 bytes.`);
}

// Anisotropic filtering replaces both filters with its own smooth one, so it would turn a NEAREST sampler (pixel art, block
// textures) into a blur. Only a texture that already filters linearly in both directions gets it.
function filtersSmoothly({ minFilter, magFilter }) {
  const LINEAR = 9729;
  const LINEAR_MIPMAP_NEAREST = 9985;
  const LINEAR_MIPMAP_LINEAR = 9987;
  return magFilter === LINEAR && (minFilter === LINEAR_MIPMAP_NEAREST || minFilter === LINEAR_MIPMAP_LINEAR);
}

export function textureDescriptorInfo(map, maximumSize = Infinity) {
  const width = map.image?.naturalWidth ?? map.image?.width;
  const height = map.image?.naturalHeight ?? map.image?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > maximumSize || height > maximumSize) throw new Error('Texture image dimensions are invalid or exceed MAX_TEXTURE_SIZE.');
  if (![0, 1].includes(map.uvChannel ?? 0)) throw new Error('Only texture UV channels 0 and 1 are supported.');
  if (map.transform || map.offset || map.repeat || map.rotation !== undefined || map.extensions && Object.keys(map.extensions).length) throw new Error('Texture transforms and extensions are unsupported. Bake them into UV channel 0.');
  if (map.colorSpace && !['srgb', 'linear'].includes(map.colorSpace)) throw new Error('Texture color space must be srgb or linear.');
  const wrapS = map.wrapS ?? 10497;
  const wrapT = map.wrapT ?? 10497;
  const minFilter = map.minFilter ?? 9987;
  const magFilter = map.magFilter ?? 9729;
  if (![10497, 33071, 33648].includes(wrapS) || ![10497, 33071, 33648].includes(wrapT)) throw new Error('Unsupported texture wrap mode.');
  if (![9728, 9729, 9984, 9985, 9986, 9987].includes(minFilter) || ![9728, 9729].includes(magFilter)) throw new Error('Unsupported texture filtering mode.');
  const compressed = map.image.compressed;
  // Precompressed mips come with the image and are never generated. The image supplies its own filter and byte count.
  if (compressed) return { width, height, wrapS, wrapT, minFilter: compressed.minFilter(minFilter), magFilter, mipmaps: false, bytes: compressed.bytes };
  const mipmaps = minFilter >= 9984;
  const info = { width, height, wrapS, wrapT, minFilter, magFilter, mipmaps, bytes: estimateTextureBytes(width, height, { mipmaps }) };
  if (mipmaps && map.mipLevels) {
    validateMipLevels(map.mipLevels, width, height);
    Object.assign(info, { mipLevels: map.mipLevels, linear: map.colorSpace === 'linear' });
  }
  return info;
}

// Light-mapped geometry uploads its two UV sets as one four-wide attribute (zeros where channel 0 is absent).
function uvBufferBytes(geometry) {
  if (!geometry.lightUvs) return geometry.uvs?.byteLength ?? 0;
  return geometry.lightUvs.byteLength * 2;
}

function interleaveUvSets(geometry) {
  const vertexCount = geometry.lightUvs.length / 2;
  const combined = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    combined[vertex * 4] = geometry.uvs?.[vertex * 2] ?? 0;
    combined[vertex * 4 + 1] = geometry.uvs?.[vertex * 2 + 1] ?? 0;
    combined[vertex * 4 + 2] = geometry.lightUvs[vertex * 2];
    combined[vertex * 4 + 3] = geometry.lightUvs[vertex * 2 + 1];
  }
  return combined;
}

// Sky visibility, or the packed surface wear masks of a material with `wear`, rides in the fourth component of the vertex
// colour attribute, so the attribute layout stays the same (every vertex attribute slot is taken). The glTF COLOR_0 alpha
// shares that component with sky visibility as two 10 bit levels. A part with wear masks keeps them and drops the alpha.
function vertexAlpha(geometry) {
  return geometry.surfaceMasks ?? geometry.vertexOpacity ?? geometry.colorAlpha ?? geometry.skyVisibility;
}

function hasVertexAlpha(geometry) {
  return Boolean(geometry.colorAlpha) && !geometry.surfaceMasks;
}

const VERTEX_ALPHA_LEVELS = 1023;

/** colour alpha * 1024 + sky visibility, both rounded to 0..1023; exact in a float, and the vertexAlpha shader unpacks it. */
export function packVertexAlpha(colorAlpha, skyVisibility) {
  return vertexAlphaLevel(colorAlpha) * 1024 + vertexAlphaLevel(skyVisibility ?? 1);
}

// Clamped so a value just past 1 can never carry into the next alpha level.
function vertexAlphaLevel(value) {
  return Math.round(Math.min(Math.max(value, 0), 1) * VERTEX_ALPHA_LEVELS);
}

function vertexFourthComponent(geometry, vertex) {
  if (hasVertexAlpha(geometry)) return packVertexAlpha(geometry.colorAlpha[vertex], geometry.skyVisibility?.[vertex]);
  return vertexAlpha(geometry)[vertex];
}

export function interleaveColorsWithSkyVisibility(geometry) {
  const vertexCount = vertexAlpha(geometry).length;
  const combined = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    for (let channel = 0; channel < 3; channel++) {
      combined[vertex * 4 + channel] = geometry.colors ? geometry.colors[vertex * 3 + channel] : 1;
    }
    combined[vertex * 4 + 3] = vertexFourthComponent(geometry, vertex);
  }
  return combined;
}

function geometryBufferBytes(geometry) {
  const tangentBytes = geometry.tangents ? geometry.positions.length / 3 * 4 : 0;
  const plainBytes = ['positions', 'normals', 'colors', 'indices'].reduce((total, field) => total + (geometry[field]?.byteLength ?? 0), uvBufferBytes(geometry) + tangentBytes);
  if (!vertexAlpha(geometry)) return plainBytes;
  return plainBytes - (geometry.colors?.byteLength ?? 0) + vertexAlpha(geometry).length * 16;
}

function validateReplacementGeometry(geometry) {
  const vertexCount = geometry.positions?.length / 3;
  if (!(geometry.positions instanceof Float32Array) || !Number.isInteger(vertexCount) || vertexCount < 1 ||
      !(geometry.normals instanceof Float32Array) || geometry.normals.length !== vertexCount * 3 ||
      !(geometry.indices instanceof Uint32Array) || geometry.indices.length < 3 || geometry.indices.length % 3 !== 0) {
    throw new TypeError('Replacement geometry needs matching Float32 positions/normals and Uint32 triangles.');
  }
  // Plain loops: replaceParts runs this every frame for streamed meshes, where callback-based
  // `every` cost about ten times more than the upload itself.
  for (const [field, count] of [['positions', 3], ['normals', 3], ['uvs', 2], ['colors', 3]]) {
    const values = geometry[field];
    if (!values && ['uvs', 'colors'].includes(field)) continue;
    if (!(values instanceof Float32Array) || values.length !== vertexCount * count || !allFinite(values)) {
      throw new TypeError(`Replacement ${field} must contain finite matching Float32 data.`);
    }
  }
  const indices = geometry.indices;
  for (let index = 0; index < indices.length; index++) {
    if (indices[index] >= vertexCount) throw new RangeError('Replacement triangle indices must address existing vertices.');
  }
}

function allFinite(values) {
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    // NaN fails both comparisons; infinities fail one.
    if (!(value > -Infinity && value < Infinity)) return false;
  }
  return true;
}

// Triangles per pixel above which `denseSamples` replaces `samples`: past one triangle per pixel every pixel is shaded about once per sample anyway, so the extra samples cost fragment work and buy little edge quality (#1163).
export const DENSE_TRIANGLES_PER_PIXEL = 1;

export function samplesForDensity(parts, canvas, pixelRatio, samples, denseSamples) {
  if (!Number.isInteger(denseSamples) || denseSamples < 1) throw new Error('denseSamples must be a positive integer or null.');
  let triangles = 0;
  for (const part of parts) triangles += part.geometry.indices.length / 3;
  const pixels = Math.max(1, canvas.clientWidth) * Math.max(1, canvas.clientHeight) * pixelRatio * pixelRatio;
  return triangles / pixels > DENSE_TRIANGLES_PER_PIXEL ? Math.min(samples, denseSamples) : samples;
}

function bindTextureUnit(context, unit, texture) {
  context.activeTexture(context.TEXTURE0 + unit);
  context.bindTexture(context.TEXTURE_2D, texture);
}

function sameVector3(first, second) {
  return Boolean(first && second) && first[0] === second[0] && first[1] === second[1] && first[2] === second[2];
}

export class CrucibleRenderer {
  constructor(canvas, parts, { batching = true, pixelRatio = 1.5, benchmark = false, world = false, ground = true, transparent = false, samples, denseSamples = null, hdr = false, compactColor = true, depth = false, memoryBudgetMiB, environment = {}, shadowBounds = {}, shadowCascades = null, clipPlanes = null, culling = true, lodPixelError = 1, createGpuTimer = null, skyOpenness = null, fogSkyVisibility = null, shading = 'full', viewTransform = 'aces', look = null, resolveCoplanar = false, reversedDepth = 'auto', exactFrames = false, deferProgramLink = false, deferEnvironmentPrefilter = false, background = null, maximumMemoryBudgetMiB, maxAnisotropy = DEFAULT_TEXTURE_ANISOTROPY } = {}) {
    this.background = background ? resolveBackground(background) : null;
    this.canvas = canvas;
    this.sceneParts = parts;
    // `skyOpenness` from closed-room.js is passed in, which keeps the ray code out of scenes without volume fog.
    this.skyOpenness = skyOpenness;
    // `fogSkyVisibility` from fog-sky-visibility.js is passed in for the same reason; without it the post shader has no grid.
    this.fogSkyVisibility = fogSkyVisibility;
    this.fogFieldOverride = null;
    this.fogFieldTexture = null;
    // fog-shader.js creates the light buffers on the first frame that draws a volume fog.
    this.fogLightBuffers = null;
    // `createGpuTimer` from adaptive-quality.js is passed in, which keeps the timer code out of scenes that do not time frames.
    this.createGpuTimer = createGpuTimer;
    this.gpuTimer = undefined;
    /** Milliseconds the GPU took for a recent frame, when `createGpuTimer` is given. */
    this.gpuMilliseconds = null;
    /** Cost of the last `render()`: draw calls, triangles drawn, planned bytes and the GPU time of a recent frame (docs/learn/renderer-reference.md). */
    this.stats = { drawCalls: 0, trianglesDrawn: 0, geometryBytes: 0, textureBytes: 0, gpuTimeMs: null };
    this.culling = culling;
    // A NaN or negative error would pick the coarsest level everywhere without a word (#2403).
    if (typeof lodPixelError !== 'number' || !(lodPixelError >= 0)) throw new TypeError(`lodPixelError must be a number of 0 or more pixels, got ${lodPixelError}.`);
    this.lodPixelError = lodPixelError;
    if (!(maxAnisotropy >= 1 && maxAnisotropy <= 16 && Number.isInteger(maxAnisotropy))) throw new RangeError(`maxAnisotropy must be a whole number from 1 to 16, got ${maxAnisotropy}.`);
    this.maxAnisotropy = maxAnisotropy;
    this.frustumPlanes = new Float32Array(24);
    this.samplesExplicit = samples !== undefined;
    const requestedSamples = this.samplesExplicit ? samples : 4;
    if (!Number.isInteger(requestedSamples) || requestedSamples < 1) throw new Error('MSAA sample count must be a positive integer.');
    if (!SHADING_MODES.includes(shading)) throw new Error(`shading must be one of ${SHADING_MODES.join(', ')}.`);
    this.shading = shading;
    if (new Set(parts).size !== parts.length) throw new Error('Scene parts must have distinct object identities for animation.');
    this.lighting = createLightingState();
    updateLightingState(this.lighting, environment, { world });
    const volume = resolveVolumeFog(environment.volumeFog);
    if (volume.density > 0 && (!depth || benchmark || transparent || !hdr)) throw new Error('Volume fog requires depth:true, hdr:true, an opaque canvas and normal rendering');
    this.backend = createGlazeBackend(canvas, { transparent });
    this.context = this.backend.context;
    this.transparent = Boolean(transparent);
    this.pixelRatio = pixelRatio;
    this.benchmark = benchmark;
    this.depth = Boolean(depth && !benchmark);
    this.world = world;
    this.environment = environment;
    this.fittedFogDensity = world ? fittedFogDensity(parts) : undefined;
    this.shadowBounds = shadowBounds;
    /** Set by installCoplanarDiagnostics (coplanar-overlap.js): called with the batches, returns coplanar-overlap warnings. */
    this.coplanarDiagnostics = null;
    /** `false` keeps the standard depth buffer; the default draws every colour pass with reversed-Z and a 32-bit float depth buffer where EXT_clip_control exists. */
    this.reversedDepthMode = reversedDepth;
    // A frame that must match every later draw of it (a render job, a still) waits for a post program the driver is still building instead of drawing with the all-steps fallback, whose maths differs by a half-float step (#1767).
    this.exactFrames = exactFrames;
    const reversedDepthWanted = reversedDepth !== false && !benchmark && Boolean(this.context.getExtension?.('EXT_clip_control'));
    this.diagnosticsCache = [];
    this.diagnosticsPending = false;
    this.diagnosticsState = [null, null, null];
    this.activeLightDirection = [...(environment.lightDirection ?? [-3, 6, 4])];
    this.shadowCascades = shadowCascades;
    this.clipPlaneValues = new Float32Array(MAX_CLIP_PLANES * 4);
    this.clipPlaneCount = clipPlanes === null ? 0 : packClipPlanes(clipPlanes, this.clipPlaneValues, 'clipPlanes');
    this.renderTargets = new RenderTargetLedger();
    // The constructor options are the default; a frame's environment (a recipe's viewTransform and look) overrides them.
    this.defaultViewTransform = viewTransform;
    this.defaultLook = look;
    this.viewTransform = 'aces';
    this.look = null;
    this.lookSource = null;
    this.selectViewTransform(viewTransform, look);
    this.hdr = Boolean(hdr && !benchmark && this.context.getExtension('EXT_color_buffer_float'));
    this.compactColor = compactColor !== false;
    if (volume.density > 0 && !this.hdr) throw new Error('Volume fog requires EXT_color_buffer_float for HDR rendering');
    this.baseSamples = requestedSamples;
    this.denseSamples = denseSamples;
    this.densityParts = parts;
    this.multisampleSamples = this.chooseMultisampleSamples(this.densityParts);
    this.capabilities = { hdr: this.hdr, hdrRequested: Boolean(hdr), hdrFallbackReason: hdr && !this.hdr ? benchmark ? 'HDR is disabled in benchmark mode' : 'EXT_color_buffer_float is unavailable' : null, samples: this.multisampleSamples };
    this.geometryBytes = 0;
    this.geometryBuffers = new Map();
    this.batching = batching;
    this.groundPart = ground === true ? groundPart(studioFloorHeight(parts)) : ground || null;
    this.buffers = [];
    this.batches = [];
    this.partLocations = new Map();
    this.updateBatches = new Set();
    // Addons plug in here: full-frame effects (camera-effects.js) run between the resolve and the post pass, and
    // render-passes.js sets passSupport. None by default.
    this.postStages = [];
    this.passSupport = null;
    this.updateSkins = new Set();
    this.updateMorphs = new Set();
    this.skinTextures = new Map();
    this.influenceTextures = new Map();
    this.morphTextures = new Map();
    this.textures = new Map();
    this.splatResources = new Map();
    this.textureBytes = 4;
    this.shadowsDirty = true;
    this.windState = { time: 0, strength: 0.3 };
    // The shadow map the constructor draws uses no assembly, so a first frame with none does not draw it again.
    this.assemblyAmount = 0;
    // `resolveCoplanar` is resolveFlushParts from the coplanar-overlap addon, passed in so the search stays out of the core bundle.
    // It ranks near-coplanar triangles (flushOrderOf in depth-layer.js) before the parts are grouped into batches.
    if (resolveCoplanar && typeof resolveCoplanar !== 'function') throw new TypeError('resolveCoplanar is resolveFlushParts from crucible/addons/coplanar-overlap.');
    if (resolveCoplanar && !benchmark) resolveCoplanar(parts);
    this.fitParts = this.groundPart ? [...parts, this.groundPart] : parts;
    const groups = groupParts(this.fitParts, batching);
    const textureLimit = this.context.getParameter(this.context.MAX_TEXTURE_SIZE);
    this.hasSkins = groups.some(group => group[0].skin || group[0].crowd);
    this.hasMorphs = groups.some(group => group[0].morph);
    if (this.hasSkins && (this.context.getParameter(this.context.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 2 || this.context.getParameter(this.context.MAX_COMBINED_TEXTURE_IMAGE_UNITS) < 8)) throw new Error('GPU skinning requires two vertex texture units and eight combined texture units.');
    if (this.hasMorphs && (this.context.getParameter(this.context.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < (this.hasSkins ? 3 : 1) || this.context.getParameter(this.context.MAX_COMBINED_TEXTURE_IMAGE_UNITS) < 9)) throw new Error('GPU morphing requires one additional vertex texture unit and nine combined texture units.');
    const morphGeometries = new Set();
    for (const group of groups) {
      const part = group[0];
      if (!part.morph || morphGeometries.has(part.geometry)) continue;
      const texelCount = part.geometry.positions.length / 3 * part.geometry.morphTargets.length * 2;
      this.textureBytes += morphSupport().skinTextureLayout(texelCount, textureLimit, 2).bytes;
      morphGeometries.add(part.geometry);
    }
    const poses = new Set();
    const skinGeometries = new Set();
    for (const group of groups) {
      const part = group[0];
      if (part.crowd && !poses.has(part.crowd)) {
        this.textureBytes += skinSupport().skinTextureLayout(part.crowd.data.length / 4, textureLimit, 4).bytes;
        poses.add(part.crowd);
      }
      if (!part.skin) continue;
      if (!poses.has(part.skin)) this.textureBytes += skinSupport().skinTextureLayout(part.skin.jointMatrices.length / 4, textureLimit, 4).bytes;
      if (!skinGeometries.has(part.geometry)) this.textureBytes += skinSupport().skinTextureLayout(part.geometry.positions.length / 3 * 2, textureLimit, 2).bytes;
      poses.add(part.skin);
      skinGeometries.add(part.geometry);
    }
    const maps = new Set();
    for (const group of groups) {
      const material = group[0].material;
      for (const [field, map] of [...MATERIAL_MAPS, 'lightMap', ...(usesHeightParallax(material) ? ['heightMap'] : [])].map(name => [name, material[name]]).concat(Object.entries(material.layerMaps ?? {}))) {
        if (!map) continue;
        const info = textureDescriptorInfo(map, textureLimit);
        if (['normalMap', 'metallicRoughnessMap', 'occlusionMap', 'heightMap'].includes(field) && map.colorSpace !== 'linear') throw new Error(`${field} requires a linear texture descriptor.`);
        if (field === 'emissiveMap' && (map.colorSpace ?? 'srgb') !== 'srgb') throw new Error('emissiveMap requires an srgb texture descriptor.');
        if (!maps.has(map)) this.textureBytes += info.bytes;
        maps.add(map);
      }
    }
    this.splatBytes = 0;
    const splatLayerSets = new Set();
    for (const group of groups) {
      const material = group[0].material;
      if (!material.layers || splatLayerSets.has(material.layers)) continue;
      splatLayerSets.add(material.layers);
      this.splatBytes += requireSplatSupport().textureBytes(requireSplatSupport().resolveSize(material, textureLimit), material.layers.length) + (material.splat?.maskMap ? textureDescriptorInfo(material.splat.maskMap, textureLimit).bytes : 0);
    }
    this.textureBytes += this.splatBytes;
    this.capabilities.maximumTextureSize = textureLimit;
    this.environmentResources = null;
    this.environmentBackgroundProgram = null;
    this.environmentBytes = !benchmark && environment.map ? requireEnvironmentSupport().estimateBytes(environment.map, textureLimit) : 0;
    this.textureBytes += this.environmentBytes;
    for (const group of groups) validateGeometryForMaterial(group[0].geometry, group[0].material, true);
    const expectedGeometryBytes = groups.reduce((total, group) => total + geometryBufferBytes(group[0].geometry) + group.length * INSTANCE_STRIDE * 4, 0);
    this.memoryBudgetMiB = planRenderSize({ width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight), pixelRatio, samples: this.samples, memoryBudgetMiB, geometryBytes: expectedGeometryBytes, textureBytes: this.textureBytes, hdr: this.hdr, bloom: !benchmark, depth: this.depth, maximumSize: textureLimit, maximumMemoryBudgetMiB }).memoryBudgetMiB;
    this.maximumMemoryBudgetMiB = maximumMemoryBudgetMiB;
    // A budget the caller did not set was sized for the first scene; it follows later scene changes up to its ceiling instead of freezing the page (#2828).
    this.memoryBudgetFollowsScene = memoryBudgetMiB === undefined;
    this.view = mat4.create();
    this.translucentOrder = null;
    this.projection = mat4.create();
    this.viewProjection = mat4.create();
    this.lightProjection = mat4.create();
    this.shadowBiasPerSlope = 0;
    this.inverseViewProjection = mat4.create();
    this.shaderFeatures = shaderFeaturesOfParts(groups.flat());
    if (groups.some(group => group.length > 1)) this.shaderFeatures.add('instanced');
    this.shaderFeatures.add(environment.map ? 'environmentMap' : 'studioLighting');
    shaderFeaturesOfLighting(this.lighting).forEach(feature => this.shaderFeatures.add(feature));
    if (shading === 'light') this.shaderFeatures.add(LIGHT_SHADING_FEATURE);
    if (clipPlanes !== null) this.shaderFeatures.add(CLIP_PLANES_FEATURE);
    this.shaderFeatures.add(FRAGMENT_SHADOW_POSITION_FEATURE);
    if (shadowCascades) this.shaderFeatures.add(shadowCascades.shaderFeature);
    if (shadowBounds?.hard) this.addHardShadowFeature(shadowCascades);
    // The tint map is a half float render target. It is drawn from the sun and read beside the cascades too (#3259).
    if (this.shaderFeatures.has('tintedShadows') && !this.context.getExtension('EXT_color_buffer_float')) this.shaderFeatures.delete('tintedShadows');
    this.tintedShadowsActive = this.shaderFeatures.has('tintedShadows');
    // The camera-relative vertex line is part of the first compile, so reversed depth does not compile the main program twice.
    if (reversedDepthWanted) prepareCameraRelativeProgram(this);
    // The shadow program keeps the features it was built with: tint and the rest are set up once, at construction.
    this.depthShaderFeatures = new Set(this.shaderFeatures);
    const pending = {
      main: this.startMainProgram(),
      depth: this.backend.startProgram(createDepthVertexShader(this.depthShaderFeatures), createDepthFragmentShader(this.depthShaderFeatures)),
    };
    if (!benchmark) {
      pending.post = this.backend.startProgram(fullscreenVertex, this.withViewTransform(postFragment, 'post'));
      pending.sky = this.backend.startProgram(fullscreenVertex, skyFragment);
      if (environment.map) this.startEnvironmentPrograms();
    }
    // The driver links the programs on its own threads while the textures and buffers upload; only then is the link result read.
    groups.forEach((group) => this.batches.push(this.uploadBatch(group)));
    this.pendingConstruction = { pending, parts, environment };
    this.deferEnvironmentPrefilter = deferEnvironmentPrefilter;
    if (!deferProgramLink) this.finishConstruction();
  }

  // The second half of construction, which reads the link results. Reading a result waits for the driver, so a page that
  // builds a heavy renderer passes deferProgramLink and awaits programsReady() instead of freezing for the whole compile.
  finishConstruction({ deferFrameTargets = false } = {}) {
    if (this.disposed || !this.pendingConstruction) return;
    const { pending, parts, environment } = this.pendingConstruction;
    this.pendingConstruction = null;
    const benchmark = this.benchmark;
    this.finishMainProgram(pending.main);
    this.depthProgram = this.backend.finishProgram(pending.depth);
    this.readDepthProgramLocations();
    if (!benchmark) {
      this.postProgram = this.backend.finishProgram(pending.post);
      this.skyProgram = this.backend.finishProgram(pending.sky);
      this.postUniforms = postUniformLocations(this.context, this.postProgram);
      this.postVariants = new Map();
      this.skyUniforms = uniformLocations(this.context, this.skyProgram, ['skyTop', 'skyBottom', 'sunDirection', 'inverseViewProjection', 'eye', 'time', 'daylight', 'hdrEnabled']);
    }
    this.partCount = parts.length;
    this.triangles = parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
    this.whiteTexture = this.createTexture(null);
    // Disabled skin samplers still need distinct units from the depth sampler.
    for (const [program, uniforms] of [[this.program, this.uniforms], [this.depthProgram, this.depthSkinUniforms]]) {
      this.context.useProgram(program);
      this.context.uniform1i(uniforms.skinInfluences, 6);
      this.context.uniform1i(uniforms.jointPalette, 7);
    }
    for (const [program, uniforms] of [[this.program, this.uniforms], [this.depthProgram, this.depthMorphUniforms]]) {
      this.context.useProgram(program);
      this.context.uniform1i(uniforms.morphTargets, 8);
    }
    for (const unit of [6, 7, 8]) bindTextureUnit(this.context, unit, this.whiteTexture);
    if (this.shaderFeatures.has('splat')) requireSplatSupport().initializePlaceholders(this);
    this.initializeEnvironment(environment.map);
    this.createShadowMap();
    if (this.reversedDepthMode !== false && !benchmark) installReversedDepth(this, this.reversedDepthMode);
    if (!deferFrameTargets) this.allocateInitialTargets();
  }

  // The uniform locations of the shadow (depth) program. Read once at construction and again when the program is rebuilt.
  readDepthProgramLocations() {
    const context = this.context;
    const program = this.depthProgram;
    this.depthSkinUniforms = uniformLocations(context, program, SKIN_UNIFORMS);
    this.depthMorphUniforms = uniformLocations(context, program, MORPH_UNIFORMS);
    this.depthAlphaUniforms = uniformLocations(context, program, DEPTH_ALPHA_UNIFORMS);
    this.depthUniform = context.getUniformLocation(program, 'lightProjection');
    this.depthClipLocations = clipPlaneLocations(context, program);
    this.depthAssemblyUniform = context.getUniformLocation(program, 'assemblyAmount');
    this.depthWindUniforms = uniformLocations(context, program, ['time', 'wind']);
  }

  // Compiles the shadow program again with the clip plane test added, for a clip plane that arrived after construction.
  rebuildDepthProgram() {
    const context = this.context;
    const previousProgram = this.depthProgram;
    this.depthShaderFeatures.add(CLIP_PLANES_FEATURE);
    const pending = this.backend.startProgram(createDepthVertexShader(this.depthShaderFeatures), createDepthFragmentShader(this.depthShaderFeatures));
    this.depthProgram = this.backend.finishProgram(pending);
    this.readDepthProgramLocations();
    context.useProgram(this.depthProgram);
    context.uniform1i(this.depthSkinUniforms.skinInfluences, 6);
    context.uniform1i(this.depthSkinUniforms.jointPalette, 7);
    context.uniform1i(this.depthMorphUniforms.morphTargets, 8);
    context.deleteProgram(previousProgram);
  }

  // The size plan and the frame targets: the largest driver calls of construction, so a page that awaits programsReady() takes them in a task of their own.
  allocateInitialTargets() {
    if (this.disposed) return;
    this.resize();
    if (!this.benchmark && !this.multisampleFramebuffer) this.allocateFrameTargets(this.canvas.width, this.canvas.height);
  }

  /** Resolves once every program started by the constructor has linked, polling without blocking the main thread, then finishes construction. Needs deferProgramLink. After dispose() it resolves at once without finishing construction. */
  async programsReady() {
    if (this.disposed) return;
    if (!this.pendingConstruction) {
      await this.initialTargetsPending;
      return;
    }
    const context = this.context;
    const parallelCompile = context.getExtension('KHR_parallel_shader_compile');
    const { pending } = this.pendingConstruction;
    const programs = [...Object.values(pending), ...(this.pendingEnvironmentPrograms?.values() ?? [])].map(started => started.program);
    // A renderer disposed during the wait has deleted these programs, which would never report complete.
    while (!this.disposed && parallelCompile && programs.some(program => !context.getProgramParameter(program, parallelCompile.COMPLETION_STATUS_KHR))) {
      await new Promise(resolve => setTimeout(resolve, 8));
    }
    if (this.pendingConstruction) {
      this.finishConstruction({ deferFrameTargets: true });
      this.initialTargetsPending = new Promise(resolve => setTimeout(resolve, 0)).then(() => this.allocateInitialTargets());
    }
    await this.initialTargetsPending;
  }

  /**
   * Draws `frame` once the way a real frame is drawn, but without freezing the page for programs the driver has not finished
   * building (the post pass of a fog or sky frame, liquids, ambient occlusion, a reversed-depth copy). Each draw that meets one
   * stops there; the driver's thread keeps building while this waits in short timers, then the draw runs again. The last
   * draw is complete and leaves every program, target and texture that frame uses ready, so the next frame costs no more than
   * any other. Call it while the canvas is hidden or another world is on screen. Past `timeoutMilliseconds` it draws the
   * frame at once and resolves true when it never had to, false otherwise. On a disposed renderer it resolves false without drawing.
   */
  async prepareFrame(frame, { timeoutMilliseconds = 6000 } = {}) {
    await this.programsReady();
    if (this.disposed) return false;
    // The bloom targets take the driver tens of milliseconds under load: a frame that blooms allocates them in a task of its own, not inside the draw.
    if (!this.benchmark && !this.bloomTargets.length && isBloomActive(resolveEffects(frame.effects))) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (this.disposed) return false;
      if (!bloomPyramidSupport.ensureTargets) await loadBloomPyramid();
      if (this.disposed) return false;
      this.ensureBloomTargets();
    }
    const context = this.context;
    const deadline = performance.now() + timeoutMilliseconds;
    setPreparing(context, true);
    try {
      for (;;) {
        // dispose() may have run during any wait below: its programs are deleted and a draw would leak and raise GL errors.
        if (this.disposed) return false;
        try {
          this.render(frame);
          return true;
        } catch (error) {
          if (!(error instanceof ProgramNotReady)) throw error;
          while (!this.disposed && !isLinkComplete(context, error.program) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 8));
          if (this.disposed) return false;
          if (performance.now() >= deadline) break;
        }
      }
    } finally {
      setPreparing(context, false);
    }
    this.render(frame);
    return false;
  }

  selectViewTransform(viewTransform, lookSource) {
    if ((viewTransform !== 'aces' || lookSource) && !viewTransformShader.apply) throw new Error("viewTransform and look need their shader code: add import '@codepawlhq/crucible/addons/view-transform-shader' (a recipe: await loadAgentSceneModules(recipe)).");
    this.viewTransform = viewTransform;
    this.lookSource = lookSource;
    this.look = lookSource ? viewTransformShader.resolveLook(lookSource) : null;
  }

  // A recipe's environment.viewTransform and environment.look reach the renderer in each frame; a change recompiles the
  // programs that carry the display curve (main, liquid, environment background, post) before the frame is drawn.
  syncViewTransform(environment) {
    const viewTransform = environment.viewTransform ?? this.defaultViewTransform;
    const lookSource = environment.look ?? this.defaultLook;
    if (viewTransform === this.viewTransform && lookSource === this.lookSource) return;
    viewTransformShader.dispose?.(this);
    this.selectViewTransform(viewTransform, lookSource);
    if (this.benchmark) return;
    const context = this.context;
    this.rebuildMainProgram();
    for (const variant of this.postVariants.values()) context.deleteProgram(variant.pending ? this.backend.finishProgram(variant.pending) : variant.program);
    this.postVariants.clear();
    context.deleteProgram(this.postProgram);
    this.postProgram = this.backend.finishProgram(this.backend.startProgram(fullscreenVertex, this.withViewTransform(postFragment, 'post')));
    this.postUniforms = postUniformLocations(context, this.postProgram);
    // The liquid pass builds its program on its next draw, with the new curve (liquid-renderer.js).
    if (this.liquidProgram) context.deleteProgram(this.liquidProgram);
    this.liquidProgram = null;
    if (this.environmentBackgroundProgram) context.deleteProgram(this.environmentBackgroundProgram);
    this.environmentBackgroundProgram = null;
  }

  // The display curve and look of this renderer, spliced into one of its programs (view-transform-shader.js); the default curve changes nothing.
  withViewTransform(source, kind) {
    if (this.viewTransform === 'aces' && !this.look) return source;
    return viewTransformShader.apply(source, kind, this.viewTransform, Boolean(this.look));
  }

  // Compiles the main program with only the shader features that this renderer's parts use, and finds its uniforms.
  startMainProgram() {
    const benchmark = this.benchmark;
    const fragmentSource = benchmark ? benchmarkFragmentShader : this.withViewTransform(createFragmentShader(this.shaderFeatures), 'main');
    return this.backend.startProgram(benchmark ? benchmarkVertexShader : createVertexShader(this.shaderFeatures), fragmentSource);
  }

  // While a context is being prepared, a main program that is still linking stays started (ProgramNotReady). The draw that comes
  // back finishes that same program instead of compiling its 40 KB of source again; a build for other source drops it (#2944).
  buildMainProgram() {
    const key = `${[...this.shaderFeatures ?? []].sort()}|${this.viewTransform}|${Boolean(this.cameraRelativeMainProgram)}`;
    if (this.pendingMainProgram && (this.pendingMainProgram.key !== key || this.pendingMainProgram.look !== this.lookSource)) this.releasePendingMainProgram();
    this.pendingMainProgram ??= { key, look: this.lookSource, started: this.startMainProgram() };
    const { started } = this.pendingMainProgram;
    try {
      this.finishMainProgram(started);
    } catch (error) {
      // A failed program is already deleted; only one that is still building is kept for the next draw.
      if (!(error instanceof ProgramNotReady)) this.pendingMainProgram = null;
      throw error;
    }
    this.pendingMainProgram = null;
  }

  // Reads the link status first: deleting a program mid-link leaves a GL error that the next draw on this context sees (#74).
  releasePendingMainProgram() {
    if (!this.pendingMainProgram) return;
    const context = this.context;
    const { program, shaders } = this.pendingMainProgram.started;
    context.getProgramParameter(program, context.LINK_STATUS);
    shaders.forEach((shader) => context.deleteShader(shader));
    context.deleteProgram(program);
    this.pendingMainProgram = null;
  }

  finishMainProgram(pendingProgram) {
    this.program = this.backend.finishProgram(pendingProgram);
    this.uniforms = uniformLocations(this.context, this.program, ['materialDielectric', 'materialEmissionFresnel', 'materialSoftEdge', 'materialCoat', 'materialSheen', 'materialAnisotropy', 'materialIridescence', 'lightLinkMask', 'boxMapScale', 'boxMapAxis', 'lightMap', 'lightMapScale', 'hasLightMap', 'heightMap', 'heightState', 'viewProjection', 'flushBias', 'clipPerMetre', 'lightProjection', 'eye', 'armorColor', 'armorSurface', 'exposure', 'inspection', 'shadowMap', 'shadowBiasPerSlope', ...MAP_UNIFORMS, ...MAP_FLAGS, ...SKIN_UNIFORMS, ...MORPH_UNIFORMS, 'normalScale', 'occlusionStrength', 'materialMoss', 'wetnessState', 'wetnessKeepOut[0]', 'wearEnabled', 'wearMetal', 'wearDirt', 'wearShape', 'wearDirtShape', ...SPLAT_UNIFORMS, 'hdrEnabled', 'time', 'wind', 'worldMode', 'daylight', 'fogColor', 'lightDirection', 'fogDensity', 'waterRipple', 'rippleTime', 'explosionProgress', 'explosionCenter', 'assemblyAmount', 'renderPassMode', 'renderPassDepthRange', 'renderPassObjectBase', 'baseColor', 'surface', 'instanceEmission', 'instanceOpacity', 'boxNormalMatrix', 'shadowBlind', 'compositeMode', 'tintShadowMap', 'tintBlind', ...ALPHA_UNIFORMS, ...LIGHT_UNIFORMS, ...ENVIRONMENT_UNIFORMS]);
    Object.assign(this.uniforms, clipPlaneLocations(this.context, this.program));
    this.keepSamplerTypesApart();
  }

  // A sampler nobody has set reads texture unit 0, which holds the shadow map as a comparison sampler. One unit may not serve
  // two sampler types, so every 2D sampler starts on unit 1 until a draw sets it.
  keepSamplerTypesApart() {
    const context = this.context;
    context.useProgram(this.program);
    const count = context.getProgramParameter(this.program, context.ACTIVE_UNIFORMS);
    for (let index = 0; index < count; index++) {
      const uniform = context.getActiveUniform(this.program, index);
      if (uniform.type === context.SAMPLER_2D) context.uniform1iv(context.getUniformLocation(this.program, uniform.name), new Int32Array(uniform.size).fill(1));
    }
  }

  /** Warnings about the last frame drawn, in the shape of `agent-diagnostics.js`; built lazily when read. */
  get diagnostics() {
    if (this.diagnosticsPending) {
      const [frame, effects, coplanarProblems] = this.diagnosticsState;
      this.diagnosticsCache = frameDiagnostics({ world: this.world, depth: this.depth, effects, requestedEffects: frame.effects, requestedExposure: frame.exposure, lightDirection: this.activeLightDirection, shadowBounds: this.shadowBounds, shadowViewMissesCasters: this.studioShadowViewMissingCasters(), coplanarProblems, skinProblems: deformationSupport.reflectedSkinDiagnostics?.(this.partLocations) });
      this.diagnosticsPending = false;
    }
    return this.diagnosticsCache;
  }

  set diagnostics(value) {
    this.diagnosticsPending = null;
    this.diagnosticsCache = value;
  }

  /** The MSAA sample count for these parts at the canvas's current size: `samples`, or `denseSamples` when the scene is dense (#1163). */
  chooseMultisampleSamples(parts) {
    if (this.benchmark) return 0;
    if (!this.samplesExplicit && this.backend.isSoftwareRenderer?.()) return 0;
    const requestedSamples = this.denseSamples == null ? this.baseSamples : samplesForDensity(parts, this.canvas, this.pixelRatio, this.baseSamples, this.denseSamples);
    const shaded = this.shading === 'light' ? Math.min(requestedSamples, LIGHT_SHADING_MAXIMUM_SAMPLES) : requestedSamples;
    return this.backend.supportedSampleCount(this.hdr ? this.context.RGBA16F : this.context.RGBA8, shaded);
  }

  get samples() {
    return Math.max(1, this.multisampleSamples);
  }

  uploadBuffer(target, data, usage = this.context.STATIC_DRAW) {
    const buffer = this.backend.createBuffer();
    this.buffers.push(buffer);
    this.backend.uploadBuffer(target, buffer, data, usage);
    this.geometryBytes += data.byteLength;
    return buffer;
  }

  // Without anisotropic filtering a mipmapped texture seen at a grazing angle (a floor, a road, an apron) falls to a
  // blurred level long before its detail is gone. Applies to the texture bound to `target`.
  applyAnisotropy(target) {
    const context = this.context;
    const extension = context.getExtension('EXT_texture_filter_anisotropic');
    if (!extension) return;
    // The limit is fixed for the context, and asking for it is a round trip to the GPU process, so it is asked once.
    this.supportedAnisotropy ??= Math.min(this.maxAnisotropy, context.getParameter(extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
    context.texParameterf(target, extension.TEXTURE_MAX_ANISOTROPY_EXT, this.supportedAnisotropy);
  }

  /**
   * Uploads the large textures of `source` (parts, or texture descriptors) in bands of at most `maximumBytes`, yielding to
   * the page after each band, so a later replaceParts or createTexture finds them ready instead of handing the driver every
   * image in one call. Pixels equal a single upload. Compressed and small textures are left to createTexture.
   * `checkpoint` is an async function that yields (createSlicer from cooperative.js).
   */
  async preloadTextures(source, options = {}) {
    const descriptors = source.flatMap(item => (item?.material ? materialMapState(item.material).slice(0, 5) : [item]));
    // The slicing code loads on demand, so a renderer that never preloads does not carry it.
    const { preloadRendererTextures } = await import('./texture-upload.js');
    const normalMaps = new Set(source.flatMap(item => (item?.material ? [materialMapState(item.material)[1]] : [])).filter(Boolean));
    await preloadRendererTextures(this, descriptors, { ...options, normalMaps });
  }

  createTexture(map, isNormalMap = false) {
    if (this.textures.has(map)) return this.textures.get(map);
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    const previousFlip = context.getParameter(context.UNPACK_FLIP_Y_WEBGL);
    const previousColorSpace = context.getParameter(context.UNPACK_COLORSPACE_CONVERSION_WEBGL);
    try {
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, map?.flipY ?? false);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
      if (map) {
        const info = textureDescriptorInfo(map, context.getParameter(context.MAX_TEXTURE_SIZE));
        if (map.image.compressed) map.image.compressed.upload(context);
        else context.texImage2D(context.TEXTURE_2D, 0, map.colorSpace === 'linear' ? context.RGBA8 : context.SRGB8_ALPHA8, context.RGBA, context.UNSIGNED_BYTE, map.image);
        configureTexture(this, info, { bakesNormalVariance: isNormalMap && !map.image.compressed && map.colorSpace === 'linear' });
      } else {
        context.texImage2D(context.TEXTURE_2D, 0, context.RGBA8, 1, 1, 0, context.RGBA, context.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      }
    } catch (error) {
      context.deleteTexture(texture);
      throw error;
    } finally {
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, previousFlip);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, previousColorSpace);
    }
    this.textures.set(map, texture);
    return texture;
  }

  // Re-uploads a descriptor's pixels: the whole image (update.image, or the descriptor image again) or update.region {x, y, width, height, data}.
  // The code is in the texture-update addon, so a scene that never updates a texture does not carry it.
  updateTexture(descriptor, update = {}) {
    if (!textureUpdateSupport.update) throw new Error("updateTexture needs its code: add import '@codepawlhq/crucible/addons/texture-update'.");
    textureUpdateSupport.update(this, descriptor, update);
  }

  // Parts can arrive after construction (replaceParts) or change their tag (updateParts). When one needs a shader feature
  // that the program left out, the program is compiled again with that feature added.
  requireShaderFeatures(parts) {
    this.requireFeatureNames([...shaderFeaturesOfParts(parts), ...(parts.length > 1 ? ['instanced'] : [])]);
  }

  requireFeatureNames(features) {
    if (this.benchmark || !this.shaderFeatures) return;
    const missing = features.filter(feature => !this.shaderFeatures.has(feature));
    if (missing.length === 0) return;
    missing.forEach(feature => this.shaderFeatures.add(feature));
    try {
      // The shadow program carries the clip test too, so it is compiled again with the main one.
      if (missing.includes(CLIP_PLANES_FEATURE)) {
        this.rebuildDepthProgram();
        // The liquid pass builds its program again on its next draw, with the plane test.
        if (this.liquidProgram) this.context.deleteProgram(this.liquidProgram);
        this.liquidProgram = null;
      }
      this.rebuildMainProgram();
    } catch (error) {
      // A program that is still linking (ProgramNotReady) leaves the old main program in place. Forget the features, so the draw that comes back asks for them again
      // and finds the program built; keeping them would draw the old program with no render pass code, and the emission mask would read the lit image (#1360).
      missing.forEach(feature => this.shaderFeatures.delete(feature));
      throw error;
    }
  }

  rebuildMainProgram() {
    const context = this.context;
    const previousProgram = this.program;
    this.buildMainProgram();
    context.deleteProgram(previousProgram);
    context.useProgram(this.program);
    for (const [name, unit] of [['skinInfluences', 6], ['jointPalette', 7], ['morphTargets', 8], ...Object.entries(SPLAT_UNITS), ['environmentSpecular', ENVIRONMENT_SPECULAR_UNIT], ['environmentBrdf', ENVIRONMENT_BRDF_UNIT]]) {
      context.uniform1i(this.uniforms[name], unit);
    }
    context.uniform1f(this.uniforms.splatEnabled, 0);
    if (this.shaderFeatures.has('splat') && !this.splatPlaceholder) requireSplatSupport().initializePlaceholders(this);
  }

  uploadBatch(parts) {
    this.requireShaderFeatures(parts);
    const context = this.context;
    const vertexArray = context.createVertexArray();
    try {
      return this.uploadBatchData(parts, vertexArray);
    } catch (error) {
      context.bindVertexArray(null);
      context.deleteVertexArray(vertexArray);
      throw error;
    }
  }

  // The wet shader's uniforms: the wetness state and the ground footprints of the thin parts that keep puddles away.
  bindWetness() {
    if (this.wetnessKeepOutParts !== this.fitParts) {
      this.wetnessKeepOutParts = this.fitParts;
      this.wetnessKeepOut = wetnessKeepOutBoxes(this.fitParts ?? []);
      this.wetnessGroundHeight = wetnessGroundHeight(this.fitParts ?? []);
    }
    const [wetness, fillLevel] = this.lighting.wetnessState;
    this.context.uniform4f(this.uniforms.wetnessState, wetness, fillLevel, this.wetnessKeepOut.count, this.wetnessGroundHeight);
    this.context.uniform4fv(this.uniforms['wetnessKeepOut[0]'], this.wetnessKeepOut.boxes);
  }

  // The parallax uniforms and height texture of a batch, in programs that compiled the parallax code (so the module is loaded). A batch
  // without a height map in such a program sends w = 0, which skips the march.
  bindHeightParallax(batch) {
    if (!this.shaderFeatures?.has(HEIGHT_MAP_FEATURE)) return;
    requireHeightParallaxSupport().bind(this.context, this.uniforms, batch.mapState.slice(heightStateOffset()), batch.heightTexture);
  }

  /** Sets the surface wear uniforms of a batch; a material without wear turns the term off. */
  bindSurfaceWear(wear) {
    const { context, uniforms } = this;
    context.uniform1f(uniforms.wearEnabled, wear ? 1 : 0);
    if (!wear) return;
    const values = wearUniformValues(wear);
    context.uniform4fv(uniforms.wearMetal, values.metal);
    context.uniform4fv(uniforms.wearDirt, values.dirt);
    context.uniform4fv(uniforms.wearShape, values.shape);
    context.uniform2fv(uniforms.wearDirtShape, values.dirtShape);
  }

  /** Binds the geometry's vertex buffers and attributes into the bound vertex array. */
  bindGeometryAttributes(geometry, material) {
    const context = this.context;
    if (geometry.tangents !== undefined) validateGeometryTangents(geometry.tangents, geometry.positions.length / 3);
    let geometryBuffers = this.geometryBuffers.get(geometry);
    if (!geometryBuffers) {
      geometryBuffers = new Map();
      for (const field of ['positions', 'normals', 'uvs', 'colors', 'indices', 'crowdPacked']) {
        if (geometry[field]) {
          const target = field === 'indices' ? context.ELEMENT_ARRAY_BUFFER : context.ARRAY_BUFFER;
          const values = field === 'uvs' && geometry.lightUvs ? interleaveUvSets(geometry) : field === 'normals' && geometry.tangents ? packNormalsWithTangents(geometry.normals, geometry.tangents) : geometry[field];
          geometryBuffers.set(field, this.uploadBuffer(target, field === 'colors' && vertexAlpha(geometry) ? interleaveColorsWithSkyVisibility(geometry) : values));
        }
      }
      if (vertexAlpha(geometry) && !geometry.colors) geometryBuffers.set('colors', this.uploadBuffer(context.ARRAY_BUFFER, interleaveColorsWithSkyVisibility(geometry)));
      if (geometry.lightUvs && !geometry.uvs) geometryBuffers.set('uvs', this.uploadBuffer(context.ARRAY_BUFFER, interleaveUvSets(geometry)));
      this.geometryBuffers.set(geometry, geometryBuffers);
    }
    const bindAttribute = (location, field, size) => {
      context.bindBuffer(context.ARRAY_BUFFER, geometryBuffers.get(field));
      context.enableVertexAttribArray(location);
      context.vertexAttribPointer(location, size, context.FLOAT, false, 0, 0);
    };
    // A geometry with tangents keeps each tangent code in the fourth float of its normal (src/tangent-encoding.js).
    for (const [location, field, size] of [[0, 'positions', 3], [1, 'normals', geometry.tangents ? 4 : 3]]) bindAttribute(location, field, size);
    validateGeometryForMaterial(geometry, material);
    if (geometry.lightUvs && geometry.lightUvs.length !== geometry.positions.length / 3 * 2) throw new Error('Geometry lightUvs count must match the vertex count.');
    if (geometry.uvs || geometry.lightUvs) {
      bindAttribute(13, 'uvs', geometry.lightUvs ? 4 : 2);
    } else {
      context.disableVertexAttribArray(13);
      // (-1, -1) marks "no UVs": grass wind then bends by local height instead of by blade position.
      context.vertexAttrib2f(13, -1, -1);
    }
    if (vertexAlpha(geometry) && vertexAlpha(geometry).length !== geometry.positions.length / 3) throw new Error('Geometry skyVisibility must hold one value for every vertex.');
    if (geometry.colors || vertexAlpha(geometry)) {
      bindAttribute(14, 'colors', vertexAlpha(geometry) ? 4 : 3);
    } else {
      context.disableVertexAttribArray(14);
      context.vertexAttrib3f(14, 1, 1, 1);
    }
    // A crowd geometry packs four joint ids and weights into the colour attribute; its UVs stay free for maps.
    if (geometry.crowdPacked) bindAttribute(14, 'crowdPacked', 4);
    context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, geometryBuffers.get('indices'));
  }

  /** Points the instance attributes of the bound vertex array at the bound array buffer. */
  pointInstanceAttributes() {
    const stride = INSTANCE_STRIDE;
    for (let column = 0; column < 4; column++) this.attribute(2 + column, 4, stride * 4, column * 16);
    // The normal matrix (9 floats) and colour (3) are read as three vec4s (floats 16 to 27) so slot 9 stays empty (#2042).
    for (let slot = 0; slot < 3; slot++) this.attribute(6 + slot, 4, stride * 4, 64 + slot * 16);
    this.attribute(10, 4, stride * 4, 112);
    this.attribute(11, 3, stride * 4, 128);
    this.attribute(12, 3, stride * 4, 140);
    this.attribute(15, 4, stride * 4, 152);
  }

  createCullingState(parts) {
    const first = parts[0];
    const cullable = isCullable(parts);
    if (first.lods) {
      validateLods(first, first.lods);
      if (!cullable) throw new RangeError(`lods need rigid or swaying, opaque parts without assembly motion: ${first.name}`);
    }
    if (first.shadowLods) {
      validateLods(first, first.shadowLods);
      if (!cullable) throw new RangeError(`shadowLods need rigid or swaying, opaque parts without assembly motion: ${first.name}`);
    }
    const levels = first.lods ?? [{ geometry: first.geometry, error: 0 }];
    const sphere = first.crowd?.bounds ?? geometryBoundingSphere(first.geometry);
    const bounds = { center: sphere.center, radius: sphere.radius + Math.max(...levels.map(level => level.error)) };
    const shadowLevels = first.shadowLods ? createLevelSet(first.shadowLods, parts.length) : null;
    const swayReach = SWAYING_TAGS.has(first.material.tag) ? SWAY_REACH_PER_STRENGTH : 0;
    return { cullable, bounds, swayReach, ...createLevelSet(levels, parts.length), shadowLevels };
  }

  /** The vertex array and instance buffer that draw one level of a batch (or of its `shadowLevels`) from the instances selected for it. */
  levelDraw(batch, level, levelSet = batch) {
    if (levelSet.levelDraws[level]) return levelSet.levelDraws[level];
    const context = this.context;
    const ranked = levelSet === batch && level === 0;
    const geometry = (ranked && batch.flushOrder?.geometry) || levelSet.levelGeometries[level];
    const vertexArray = context.createVertexArray();
    context.bindVertexArray(vertexArray);
    this.bindGeometryAttributes(geometry, batch.parts[0].material);
    if (batch.flushIndexBuffer && ranked) context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, batch.flushIndexBuffer);
    const instanceBuffer = context.createBuffer();
    this.buffers.push(instanceBuffer);
    context.bindBuffer(context.ARRAY_BUFFER, instanceBuffer);
    context.bufferData(context.ARRAY_BUFFER, batch.instanceData.byteLength, context.DYNAMIC_DRAW);
    this.pointInstanceAttributes();
    context.bindVertexArray(null);
    levelSet.levelDraws[level] = { vertexArray, instanceBuffer, indexCount: geometry.indices.length };
    return levelSet.levelDraws[level];
  }

  releaseLevelDraws(batch, releasedBuffers) {
    for (const levelSet of [batch, batch.shadowLevels]) {
      if (!levelSet) continue;
      for (const draw of levelSet.levelDraws) {
        if (!draw) continue;
        this.context.deleteVertexArray(draw.vertexArray);
        releasedBuffers?.add(draw.instanceBuffer);
      }
      levelSet.levelDraws = [];
    }
  }

  /**
   * Gives a part that was built without `lods` its levels now, for levels made after the first frame (#2985). The part must
   * be alone in its batch (a scan is) and may take lods; `lods` follows the rules of the `lods` field: level 0 is the part's own
   * geometry and the errors do not decrease. Culling picks among the levels from the next frame on.
   */
  setPartLods(part, lods) {
    const location = this.partLocations.get(part);
    if (!location) throw new RangeError(`setPartLods needs a part this renderer draws: ${part?.name ?? '?'}.`);
    const batch = location.batch;
    if (batch.parts.length !== 1) throw new RangeError(`setPartLods needs a part that is alone in its batch; ${part.name} is drawn with ${batch.parts.length - 1} others that share its geometry. Pass lods in the part when the renderer is built.`);
    if (!batch.cullable) throw new RangeError(`lods need rigid or swaying, opaque parts without assembly motion: ${part.name}`);
    validateLods(part, lods);
    this.reserveLevelBytes(lods, batch);
    this.releaseLevelDraws(batch);
    const levelSet = createLevelSet(lods, batch.instanceCount);
    Object.assign(batch, levelSet);
    const sphere = geometryBoundingSphere(part.geometry);
    batch.bounds = { center: sphere.center, radius: sphere.radius + Math.max(...lods.map(level => level.error)) };
    levelSet.levelGeometries.forEach((geometryOfLevel, level) => this.levelDraw(batch, level));
  }

  /**
   * Checks that the buffers of levels made after the first frame fit `memoryBudgetMiB` before any is uploaded: the geometry of each
   * level above 0 that is not on the GPU yet and one instance buffer per level. A budget the caller did not set grows to hold them,
   * as it does for replaceParts; one the caller set throws the budget error, and the part keeps the levels it has (#2985).
   */
  reserveLevelBytes(lods, batch) {
    const levelBytes = lods.slice(1).reduce((total, level) => total + (this.geometryBuffers.has(level.geometry) ? 0 : geometryBufferBytes(level.geometry)) + batch.instanceData.byteLength, 0);
    const frameBytes = estimateFrameBytes(this.canvas.width, this.canvas.height, this.samples, 2048, { hdr: this.hdr, bloom: !this.benchmark, depth: this.depth });
    const peakBytes = frameBytes + this.textureBytes + this.geometryBytes + levelBytes;
    if (peakBytes > this.memoryBudgetMiB * 1024 * 1024 && !this.growAutomaticBudgetTo(peakBytes)) {
      throw memoryBudgetError(this.geometryBytes + levelBytes, this.textureBytes, frameBytes, this.memoryBudgetMiB, { maximumMemoryBudgetMiB: this.maximumMemoryBudgetMiB });
    }
  }

  /** The instances of a batch that the camera can see, split by level; null when the whole batch draws as it is. */
  selectBatchInstances(batch) {
    if (!this.culling || !batch.cullable) return null;
    return selectInstances(batch.selection, {
      instanceData: batch.instanceData, instanceCount: batch.instanceCount, stride: INSTANCE_STRIDE, bounds: batch.bounds, margin: batch.swayReach * Math.abs(this.windState.strength),
      levelErrors: batch.levelErrors, planes: this.frustumPlanes, viewProjection: this.viewProjection,
      pixelsPerUnit: this.canvas.height / 2 * this.projection[5], pixelError: this.lodPixelError * (this.mirrorCulling?.lodScale ?? 1),
      belowHeight: this.mirrorCulling?.belowHeight, minimumPixelRadius: this.mirrorCulling?.minimumPixelRadius,
    });
  }

  drawSelectedLevels(batch, selection, levelSet = batch, flushRanges = null) {
    const context = this.context;
    const stride = INSTANCE_STRIDE;
    for (let level = 0; level < selection.counts.length; level++) {
      const count = selection.counts[level];
      if (count === 0) continue;
      const draw = this.levelDraw(batch, level, levelSet);
      if (!(this.selectionScratch?.length >= count * stride)) this.selectionScratch = new Float32Array(count * stride);
      for (let slot = 0; slot < count; slot++) {
        const instance = selection.indices[level][slot];
        this.selectionScratch.set(batch.instanceData.subarray(instance * stride, (instance + 1) * stride), slot * stride);
      }
      context.bindBuffer(context.ARRAY_BUFFER, draw.instanceBuffer);
      context.bufferSubData(context.ARRAY_BUFFER, 0, this.selectionScratch, 0, count * stride);
      context.bindVertexArray(draw.vertexArray);
      // Only level 0 holds the ranked index order; the simpler levels draw far away, as one range.
      if (flushRanges && level === 0) this.drawFlushRanges(batch, flushRanges, count);
      else this.backend.drawIndexedInstanced(draw.indexCount, count);
    }
  }

  /** Draws a batch rank by rank from its ranked index order (flush-resolve.js), each rank a little closer in depth. */
  drawFlushRanges(batch, ranges, instanceCount) {
    const base = (batch.depthLayer ?? 0) * RANKS_PER_LAYER;
    for (const range of ranges) {
      this.applyDepthRank(base + range.rank);
      this.backend.drawIndexedInstanced(range.count, instanceCount, range.start);
    }
    this.applyDepthRank(base);
  }

  uploadBatchData(parts, vertexArray) {
    const context = this.context;
    const geometry = parts[0].geometry;
    context.bindVertexArray(vertexArray);
    const flushOrder = flushOrderOf(parts[0]);
    // A cut geometry carries the ranked order as its own indices. Without cuts the ranked order replaces the geometry's
    // index buffer in this vertex array only; the vertex buffers stay shared.
    this.bindGeometryAttributes(flushOrder?.geometry ?? geometry, parts[0].material);
    const flushIndexBuffer = flushOrder && !flushOrder.geometry ? this.uploadBuffer(context.ELEMENT_ARRAY_BUFFER, flushOrder.indices) : null;
    const stride = INSTANCE_STRIDE;
    const instanceData = new Float32Array(parts.length * stride);
    const normalMatrix = mat3.create();
    parts.forEach((part, index) => {
      mat3.normalFromMat4(normalMatrix, part.matrix);
      packInstance(instanceData, index, part, normalMatrix);
    });
    const instanceBuffer = this.uploadBuffer(context.ARRAY_BUFFER, instanceData, context.DYNAMIC_DRAW);
    this.pointInstanceAttributes();
    context.bindVertexArray(null);
    const map = parts[0].material.map ?? null;
    const mapState = materialMapState(parts[0].material);
    const textures = mapState.slice(0, 5).map((descriptor, index) => this.createTexture(descriptor, index === 1));
    const splat = parts[0].material.layers ? requireSplatSupport().createResources(this, parts[0].material, requireSplatSupport()) : null;
    const heightTexture = mapState[heightStateOffset()] ? this.createTexture(mapState[heightStateOffset()]) : null;
    const lightMapTexture = mapState[14] ? this.createTexture(mapState[14]) : null;
    if (lightMapTexture && (parts[0].skin || parts[0].morph || !geometry.lightUvs)) throw new Error('A light map needs lightUvs on rigid geometry, with no skin or morph.');
    const skin = parts[0].skin ?? null;
    const skinTexture = skin ? this.createSkinTexture(this.skinTextures, skin, skin.jointMatrices, 4) : null;
    const influenceTexture = skin ? this.createSkinTexture(this.influenceTextures, geometry, null, 2) : null;
    const crowd = parts[0].crowd ?? null;
    const crowdTexture = crowd ? this.createSkinTexture(this.skinTextures, crowd, crowd.data, 4) : null;
    const morph = parts[0].morph ?? null;
    const morphTexture = morph ? this.createMorphTexture(geometry, morph) : null;
    const morphWeights = morph ? new Float32Array(morph.weights) : null;
    const [alphaMode, alphaCutoff, opacity, doubleSided, retro, waterGlint, depthTest, throughGlass] = materialAlphaState(parts[0].material);
    const layerState = materialLayerState(parts[0].material);
    const culling = this.createCullingState(parts);
    const batch = { ...culling, alphaMode, alphaCutoff, opacity, doubleSided, retro, waterGlint, depthTest, throughGlass, mirrored: isMirroredMatrix(parts[0].matrix), layerState, wear: parts[0].material.wear ?? null, parts: [...parts], vertexArray, instanceBuffer, instanceData, textures, mapState, splat, lightMapTexture, heightTexture, texture: textures[0], map, skin, skinTexture, influenceTexture, crowd, crowdTexture, morph, morphTexture, morphWeights, indexCount: flushOrder?.indices.length ?? geometry.indices.length, instanceCount: parts.length, floor: parts[0].material.tag === 'floor', castShadow: castsShadow(parts[0]), tintedShadow: castsTintedShadow(parts[0]), tintBlind: Object.keys(parts[0].material.layerMaps ?? {}).length >= 3, receivesShadow: receivesShadow(parts[0]), compositeMode: compositeModeOf(parts[0]), depthLayer: depthLayerOf(parts[0]), flushOrder, flushIndexBuffer, pass: partPass(parts[0]), clipPlanes: parts[0].clipPlanes ?? null };
    if (parts[0].lods) culling.levelGeometries.forEach((geometryOfLevel, level) => this.levelDraw(batch, level));
    culling.shadowLevels?.levelGeometries.forEach((geometryOfLevel, level) => this.levelDraw(batch, level, batch.shadowLevels));
    parts.forEach((part, index) => this.partLocations.set(part, { batch, index, geometry: part.geometry, map, mapState, layerState, skin, jointMatrices: skin?.jointMatrices, skinIndices: geometry.skinIndices, skinWeights: geometry.skinWeights, morph, morphWeights: morph?.weights, morphTargets: geometry.morphTargets, normalMatrix: mat3.create(), committedMatrix: batch.instanceData.subarray(index * INSTANCE_STRIDE, index * INSTANCE_STRIDE + 16) }));
    return batch;
  }

  /**
   * Raises a budget the caller did not set so it holds `neededBytes`, when that fits under the automatic ceiling and the runtime's
   * own ceiling. Returns whether the budget now holds it; a budget the caller set is never changed.
   */
  growAutomaticBudgetTo(neededBytes) {
    if (!this.memoryBudgetFollowsScene) return false;
    const neededMiB = Math.ceil(neededBytes / (1024 * 1024));
    const ceilingMiB = Math.min(automaticBudgetCeilingMiB(), this.maximumMemoryBudgetMiB ?? Infinity);
    if (neededMiB > ceilingMiB) return false;
    this.memoryBudgetMiB = neededMiB;
    return true;
  }

  /** Reconcile immutable rigid, untextured geometry without rebuilding programs or render targets. `retainedUnchanged` skips the re-sync of parts in kept batches, for a world that grows in slices. */
  replaceParts(parts, { regroupOnly = false, retainedUnchanged = false } = {}) {
    if (!Array.isArray(parts) || new Set(parts).size !== parts.length) {
      throw new TypeError('Scene parts must be an array with distinct object identities.');
    }
    const renderParts = this.groundPart ? [...parts, this.groundPart] : parts;
    // Local volumes bind to parts by name, so they must see the new list after a topology change.
    this.sceneParts = parts;
    this.fitParts = renderParts;
    this.fitBounds = undefined;
    this.receiverBox = undefined;
    this.densityParts = parts;
    // A scene that gained or lost triangles can cross the density threshold with no size change; resize() judges it again and rebuilds the targets.
    const resampled = this.denseSamples != null && this.chooseMultisampleSamples(this.densityParts) !== this.multisampleSamples;
    const grouped = groupWorld(retainedUnchanged ? this.incrementalGrouping : null, parts, this.groundPart, this.batching, retainedUnchanged);
    this.incrementalGrouping = grouped.state;
    const groups = grouped.batches;
    const geometries = new Set(renderParts.flatMap(partGeometries));
    // Uploaded geometry was validated when it arrived; rechecking a large static scene every frame dominated streamed playback.
    for (const geometry of geometries) {
      if (!this.geometryBuffers.has(geometry)) validateReplacementGeometry(geometry);
    }
    const retained = new Set();
    // Groups share a few materials, and the layer state is 28 validated values, so each material answers once per call.
    const layerStates = new Map();
    const layerStateOf = material => {
      if (!layerStates.has(material)) layerStates.set(material, materialLayerState(material));
      return layerStates.get(material);
    };
    const replacements = groups.map(group => {
      const first = group[0];
      const location = this.partLocations.get(first);
      const batch = location?.batch;
      const mapState = materialMapState(first.material);
      const sameParts = batch?.parts.length === group.length && batch.parts.every((part, index) => part === group[index]);
      const alphaState = materialAlphaState(first.material);
      // A batch keeps its winding: a group that flipped sign with the same members is a new batch, or the update would regroup forever (#3059).
      const sameState = location?.geometry === first.geometry && batch?.castShadow === castsShadow(first) && batch.mirrored === isMirroredMatrix(first.matrix) && batch.receivesShadow === receivesShadow(first) && batch.compositeMode === compositeModeOf(first) && (batch.depthLayer ?? 0) === depthLayerOf(first) && (batch.flushOrder ?? null) === flushOrderOf(first) &&
        batch.floor === (first.material.tag === 'floor') && batchPass(batch) === partPass(first) &&
        batchAlphaState(batch).every((value, index) => value === alphaState[index]) &&
        batch.mapState.every((value, index) => value === mapState[index]) &&
        batch.layerState.every((value, index) => value === layerStateOf(first.material)[index]);
      if (sameParts && sameState) {
        retained.add(batch);
        return { group, batch };
      }
      return { group, batch: null };
    });
    const incomingParts = new Set(renderParts);
    const canSwap = part => {
      const location = this.partLocations.get(part);
      return Boolean(location && location.geometry === part.geometry && location.skin === (part.skin ?? null) && location.morph === (part.morph ?? null) && MATERIAL_MAPS.every(field => !part.material[field] || this.textures?.has(part.material[field])));
    };
    const texturesReplaceable = regroupOnly || Boolean(texturedReplaceSupport.begin);
    for (const item of replacements) {
      if (!item.batch && item.group.some(part => !canSwap(part) && (part.skin || part.morph || part.geometry.morphTargets || part.geometry.skinIndices || (!texturesReplaceable && hasMaterialMap(part.material))))) {
        throw new Error('replaceParts can add or change only rigid, untextured parts. Keep textured, skinned and morphed parts unchanged, or import replace-textured-parts to add textured ones.');
      }
    }
    for (const [part, location] of this.partLocations) {
      if (retained.has(location.batch) || (incomingParts.has(part) && canSwap(part))) continue;
      if (location.skin || location.morph || location.morphTargets || location.skinIndices || (location.mapState.slice(0, 5).some(Boolean) && !texturesReplaceable)) {
        throw new Error(`replaceParts can remove or regroup only existing rigid, untextured parts; ${part.name} is textured, skinned or morphed and needs a new renderer.`);
      }
    }
    const newGeometryBytes = [...geometries].filter(geometry => !this.geometryBuffers.has(geometry)).reduce((total, geometry) => total + geometryBufferBytes(geometry), 0);
    const newInstanceBytes = replacements.filter(item => !item.batch).reduce((total, item) => total + item.group.length * INSTANCE_STRIDE * 4, 0);
    const frameBytes = estimateFrameBytes(this.canvas.width, this.canvas.height, this.samples, 2048, { hdr: this.hdr, bloom: !this.benchmark, depth: this.depth });
    const peakBytes = frameBytes + this.textureBytes + this.geometryBytes + newGeometryBytes + newInstanceBytes;
    if (peakBytes > this.memoryBudgetMiB * 1024 * 1024 && !this.growAutomaticBudgetTo(peakBytes)) {
      throw memoryBudgetError(this.geometryBytes + newGeometryBytes + newInstanceBytes, this.textureBytes, frameBytes, this.memoryBudgetMiB, { maximumMemoryBudgetMiB: this.maximumMemoryBudgetMiB });
    }
    const previousLocations = this.partLocations;
    const previousBuffers = [...this.buffers];
    const previousGeometryBytes = this.geometryBytes;
    const previousGeometryBuffers = new Map(this.geometryBuffers);
    const settleTextures = texturedReplaceSupport.begin?.(this);
    const stagedLocations = new Map();
    const stagedBatches = [];
    this.partLocations = stagedLocations;
    try {
      for (const item of replacements) {
        if (item.batch) {
          stagedBatches.push(item.batch);
          for (const part of item.group) {
            stagedLocations.set(part, previousLocations.get(part));
          }
        } else {
          stagedBatches.push(this.uploadBatch(item.group));
        }
      }
      const error = this.context.getError();
      if (error !== 0) {
        throw new Error(`WebGL replacement allocation failed with error ${error}.`);
      }
    } catch (error) {
      for (const batch of stagedBatches) {
        if (!retained.has(batch)) {
          this.context.deleteVertexArray(batch.vertexArray);
          this.releaseLevelDraws(batch);
        }
      }
      for (const buffer of this.buffers.slice(previousBuffers.length)) {
        this.context.deleteBuffer(buffer);
      }
      this.context.bindVertexArray(null);
      this.buffers = previousBuffers;
      this.geometryBytes = previousGeometryBytes;
      this.geometryBuffers = previousGeometryBuffers;
      settleTextures?.();
      this.partLocations = previousLocations;
      throw error;
    }
    const releasedBuffers = new Set();
    for (const batch of this.batches) {
      if (!retained.has(batch)) {
        this.context.deleteVertexArray(batch.vertexArray);
        releasedBuffers.add(batch.instanceBuffer);
        if (batch.flushIndexBuffer) releasedBuffers.add(batch.flushIndexBuffer);
        this.releaseLevelDraws(batch, releasedBuffers);
      }
    }
    for (const [geometry, buffers] of this.geometryBuffers) {
      if (!geometries.has(geometry)) {
        for (const buffer of buffers.values()) releasedBuffers.add(buffer);
        this.geometryBuffers.delete(geometry);
      }
    }
    for (const buffer of releasedBuffers) this.context.deleteBuffer(buffer);
    this.buffers = this.buffers.filter(buffer => !releasedBuffers.has(buffer));
    settleTextures?.(this.batches, stagedBatches);
    this.geometryBytes = [...geometries].reduce((total, geometry) => total + geometryBufferBytes(geometry), 0) + renderParts.length * INSTANCE_STRIDE * 4;
    this.batches = stagedBatches;
    this.partCount = parts.length;
    this.triangles = parts.reduce((total, part) => total + part.geometry.indices.length / 3, 0);
    this.updateBatches.clear();
    this.shadowsDirty = true;
    // With retainedUnchanged the caller promises that parts of kept batches did not move, so only the new batches are re-synced.
    this.updateParts(retainedUnchanged ? renderParts.filter(part => !retained.has(this.partLocations.get(part)?.batch)) : renderParts);
    if (resampled) this.resize();
    return parts.length;
  }

  createSkinTexture(cache, identity, matrices, groupSize) {
    if (cache.has(identity)) return cache.get(identity);
    const context = this.context;
    const texelCount = matrices ? matrices.length / 4 : identity.positions.length / 3 * 2;
    const layout = skinSupport().skinTextureLayout(texelCount, context.getParameter(context.MAX_TEXTURE_SIZE), groupSize);
    const data = matrices ? new Float32Array(layout.width * layout.height * 4) : skinSupport().packSkinInfluences(identity, layout);
    if (matrices) data.set(matrices);
    const record = this.createPackedTexture(layout, data);
    record.pose = matrices ? identity : null;
    cache.set(identity, record);
    return record;
  }

  createMorphTexture(geometry, pose) {
    if (this.morphTextures.has(geometry)) return this.morphTextures.get(geometry);
    const info = morphSupport().validateMorphGeometry(geometry, pose);
    const layout = morphSupport().skinTextureLayout(info.vertexCount * info.targetCount * 2, this.context.getParameter(this.context.MAX_TEXTURE_SIZE), 2);
    const record = this.createPackedTexture(layout, morphSupport().packMorphTargets(geometry, layout));
    record.info = info;
    this.morphTextures.set(geometry, record);
    return record;
  }

  createPackedTexture(layout, data) {
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    try {
      context.texImage2D(context.TEXTURE_2D, 0, context.RGBA32F, layout.width, layout.height, 0, context.RGBA, context.FLOAT, data);
      this.backend?.setClampedFiltering(context.NEAREST);
    } catch (error) {
      context.deleteTexture(texture);
      throw error;
    }
    return { ...layout, texture, data };
  }

  /**
   * Upload changed parts. `checks: false` skips the per-frame pose checks (finite, non-singular, unmirrored skin and
   * morph transforms) for poses already checked where they were made, such as `applyAnimation(time, clip, { checks: false })`.
   * Identity, material and transform rules still apply.
   */
  updateParts(parts, { shadows = true, checks = true } = {}) {
    if (typeof checks !== "boolean") throw new TypeError("updateParts checks must be a boolean.");
    this.updatePartIdentities ??= new Set();
    this.updatePartIdentities.clear();
    this.updateSkins.clear();
    this.updateMorphs ??= new Set();
    this.updateMorphs.clear();
    this.updateBatches.clear();
    const locations = this.updateLocations ??= [];
    locations.length = parts.length;
    let mirrorChanged = false;
    // Preflight every part before touching packed data or submitting GPU writes.
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const location = this.partLocations.get(part);
      if (!location) throw new Error(`Unknown part identity: ${part.name}`);
      locations[partIndex] = location;
      if (part.skin || part.morph) this.updatePartIdentities.add(part);
      validatePartFlags(part);
      if (castsShadow(part) !== location.batch.castShadow) requireNewRenderer('Shadow casting changes', part);
      if (receivesShadow(part) !== location.batch.receivesShadow || (part.shadowOnly === true) !== (batchPass(location.batch) === 'shadowOnly') || compositeModeOf(part) !== location.batch.compositeMode) throw new Error(`receiveShadow, holdout, shadowCatcher and shadowOnly changes require replaceParts: ${part.name}`);
      if (depthLayerOf(part) !== (location.batch.depthLayer ?? 0)) throw new Error(`depthLayer changes require replaceParts: ${part.name}`);
      if ((part.clipPlanes ?? null) !== (location.batch.clipPlanes ?? null)) throw new Error(`Giving a part another clipPlanes array requires replaceParts: ${part.name}. Fix: edit the planes of the same array in place.`);
      // A material whose fields still equal the ones that passed the full checks below needs none of them again.
      const materialUnchanged = location.materialSnapshot?.matches(part.material) === true;
      if (!materialUnchanged) {
        const alphaState = materialAlphaState(part.material);
        const batchAlpha = batchAlphaState(location.batch);
        if (alphaState.some((value, index) => value !== batchAlpha[index])) throw new Error(`Alpha mode, cutoff, double-sided, depthTest, retro and mask opacity changes require a new renderer: set them when the part is made (blend and add opacity may change): ${part.name}`);
      }
      if (part.geometry !== location.geometry) requireNewRenderer('Geometry changes', part);
      // A hidden part packs zeros, so its matrix (often a zero scale) says nothing about winding, and neither is checked.
      const hidden = isHidden(part);
      if (!hidden && isMirroredMatrix(part.matrix) !== Boolean(location.batch.mirrored)) mirrorChanged = true;
      if (!materialUnchanged && partPass(part) !== batchPass(location.batch)) throw new Error(`Moving a part into or out of the liquid or foam pass requires replaceParts: ${part.name}`);
      if ((part.skin ?? null) !== location.skin || part.skin?.jointMatrices !== location.jointMatrices || part.geometry.skinIndices !== location.skinIndices || part.geometry.skinWeights !== location.skinWeights) requireNewRenderer('Skin identity changes', part);
      if (part.skin) {
        validateDeformedTag('Skinned', part, false);
        if (checks && !hidden) skinSupport().validateSkinPose(part.skin, part.geometry, part.matrix);
        this.updateSkins.add(location.batch.skinTexture);
      }
      if ((part.morph ?? null) !== (location.morph ?? null) || part.morph?.weights !== location.morphWeights || part.geometry.morphTargets !== location.morphTargets) requireNewRenderer('Morph identity changes', part);
      if (part.morph) {
        validateDeformedTag('Morphed', part, true);
        if (checks && !hidden) morphSupport().validateMorphTransform(part.morph, location.batch.morphTexture.info, part.matrix, part.skin);
        this.updateMorphs.add(part.morph);
      }
      if (materialUnchanged) {
        validateTransform(part, location.normalMatrix, hidden);
        continue;
      }
      if ((part.material.map ?? null) !== location.map) requireNewRenderer('Texture map changes', part);
      validateMaterialMaps(part.material);
      const normalScale = part.material.normalScale ?? DEFAULT_NORMAL_SCALE;
      const mapState = location.mapState;
      for (let index = 0; index < MATERIAL_MAPS.length; index++) {
        if ((part.material[MATERIAL_MAPS[index]] ?? null) !== mapState[index]) requireNewRenderer('Material map or scale changes', part);
      }
      const [lightMapDescriptor, lightMapScale] = lightMapState(part.material);
      if (heightParallaxChanged(part.material, mapState)) requireNewRenderer('Height map and parallax changes', part);
      if (lightMapDescriptor !== (mapState[14] ?? null) || lightMapScale !== (mapState[15] ?? 0) || (part.material.layerMaps ?? null) !== (mapState[18] ?? null)) requireNewRenderer('Light map and layer texture changes', part);
      if (normalScale[0] !== mapState[5] || normalScale[1] !== mapState[6] || (part.material.occlusionStrength ?? 1) !== mapState[7] || mossState(part.material).some((value, index) => value !== mapState[8 + index]) || materialLayerState(part.material).some((value, index) => value !== location.layerState[index])) requireNewRenderer('Material map or scale changes', part);
      validateTransform(part, location.normalMatrix, hidden);
      location.materialSnapshot = MaterialSnapshot.of(part.material);
    }
    // A part moved toward the camera may leave the box the near plane is fitted to, and the plane would cut it (#2403). Growing the
    // box by the moved parts costs only them; it never shrinks, so the plane stays safe if not as tight.
    if (this.fitBounds) this.fitBounds = boundsGrownByParts(this.fitBounds, parts);
    if (this.receiverBox) this.receiverBox = boundsGrownByParts(this.receiverBox, parts, { includeMoving: true });
    // A part that crossed a mirror (a flip animation, a toggled billboard) belongs to the other winding batch: regroup every part once.
    // replaceParts packs all parts again, so the rest of this update is done.
    if (mirrorChanged) {
      this.replaceParts([...this.partLocations.keys()].filter(part => part !== this.groundPart), { regroupOnly: true });
      return parts.length;
    }
    // A palette upload also changes consumers absent from the submitted part list.
    if (checks && this.updateSkins.size) {
      for (const [part, location] of this.partLocations) {
        if (!location.skin || !this.updateSkins.has(location.batch.skinTexture) || this.updatePartIdentities.has(part) || isHidden(part)) continue;
        const committedMatrix = location.committedMatrix ?? location.batch.instanceData.subarray(location.index * INSTANCE_STRIDE, location.index * INSTANCE_STRIDE + 16);
        skinSupport().validateSkinPose(location.skin, location.geometry, committedMatrix);
      }
    }
    // Shared weights also affect batches absent from the submitted part list.
    // Nothing is shared when the update carries no morph and no skin.
    if (checks && (this.updateMorphs.size || this.updateSkins.size)) {
      for (const [part, location] of this.partLocations) {
        if (!location.morph || this.updatePartIdentities.has(part) || isHidden(part)) continue;
        if (!this.updateMorphs.has(location.morph) && !this.updateSkins.has(location.batch.skinTexture)) continue;
        const committedMatrix = location.committedMatrix ?? location.batch.instanceData.subarray(location.index * INSTANCE_STRIDE, location.index * INSTANCE_STRIDE + 16);
        morphSupport().validateMorphTransform(location.morph, location.batch.morphTexture.info, committedMatrix, location.skin);
      }
    }
    this.updateBatches.clear();
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const location = locations[partIndex];
      // A tag can change between frames without a new batch, so its shader code may not be compiled yet.
      if (TAG_SHADER_FEATURES.has(part.material.tag) && !this.shaderFeatures?.has(part.material.tag)) this.requireShaderFeatures([part]);
      packInstance(location.batch.instanceData, location.index, part, location.normalMatrix);
      this.updateBatches.add(location.batch);
    }
    // updateParts repacks the instances in place and keeps this.batches, so the shadow-miss check keys on this count too.
    this.partsMoveCount = (this.partsMoveCount ?? 0) + 1;
    for (const batch of this.updateBatches) {
      this.context.bindBuffer(this.context.ARRAY_BUFFER, batch.instanceBuffer);
      this.context.bufferSubData(this.context.ARRAY_BUFFER, 0, batch.instanceData);
    }
    for (const record of this.updateSkins) {
      // Each texture record belongs to one pose and keeps its padded upload buffer.
      const pose = record.pose;
      record.data.set(pose.jointMatrices);
      this.context.bindTexture(this.context.TEXTURE_2D, record.texture);
      this.context.texSubImage2D(this.context.TEXTURE_2D, 0, 0, 0, record.width, record.height, this.context.RGBA, this.context.FLOAT, record.data);
    }
    for (const batch of this.batches ?? []) {
      if (batch.morph && this.updateMorphs.has(batch.morph)) batch.morphWeights.set(batch.morph.weights);
    }
    if (shadows && parts.length > 0) this.shadowsDirty = true;
    return parts.length;
  }

  attribute(location, size, stride, offset) {
    this.context.enableVertexAttribArray(location);
    this.context.vertexAttribPointer(location, size, this.context.FLOAT, false, stride, offset);
    this.context.vertexAttribDivisor(location, 1);
  }

  // A one texel map stays cleared to the far depth, so every point reads as lit. That is exact when nothing casts, and when
  // cascades replace the main shader's lookup and nothing else (volume fog, subsurface thickness) still reads this map.
  addHardShadowFeature(cascades) {
    if (cascades || !registeredFeatureCode.has('hardShadows')) throw new Error('shadow.hard needs no shadowCascades and its code: await loadAgentSceneModules(recipe).');
    this.shaderFeatures.add('hardShadows');
  }

  shadowMapSizeWanted() {
    const casts = this.batches.some(batch => !batch.floor && batch.castShadow && !this.tintsShadow(batch));
    if (!casts || this.shadowCascades?.replacesSingleMap(this)) return 1;
    const light = resolveShadowLight(this.world, this.activeLightDirection, this.shadowBounds, this.fittedShadowView());
    return sunShadowMapSize(light.extent);
  }

  createShadowMap() {
    const context = this.context;
    const mapSize = this.shadowMapSizeWanted();
    this.shadowTexture ??= context.createTexture();
    bindTextureUnit(context, 0, this.shadowTexture);
    if (mapSize !== this.shadowMapSize) {
      this.shadowMapSize = mapSize;
      context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT24, mapSize, mapSize, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
      this.renderTargets.record('shadowMap', { width: mapSize, height: mapSize, format: 'DEPTH_COMPONENT24' });
    }
    // Compare on fetch (the default function is LEQUAL) with linear filtering gives a 2 x 2 percentage-closer result from one fetch.
    this.backend?.setClampedFiltering(context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_COMPARE_MODE, context.COMPARE_REF_TO_TEXTURE);
    if (!this.shadowFramebuffer) this.shadowFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.shadowFramebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, this.shadowTexture, 0);
    context.drawBuffers([context.NONE]);
    context.readBuffer(context.NONE);
    // The status is a round trip to the GPU process. The attachment only changes with the map size, so it is checked once per size,
    // not on each of the several refreshes a second an animated world makes.
    if (this.shadowFramebufferCheckedSize !== mapSize) {
      assertShadowFramebufferComplete(context, 'Shadow');
      this.shadowFramebufferCheckedSize = mapSize;
    }
    const resolvedLight = resolveShadowLight(this.world, this.activeLightDirection, this.shadowBounds, this.fittedShadowView());
    const light = resolvedLight.hard ? registeredFeatureCode.get('hardShadows').snapView(resolvedLight, mapSize) : resolvedLight;
    writeShadowLightMatrix(this.lightProjection, light);
    context.viewport(0, 0, mapSize, mapSize);
    context.enable(context.DEPTH_TEST);
    context.enable(context.CULL_FACE);
    context.clear(context.DEPTH_BUFFER_BIT);
    this.shadowBiasPerSlope = shadowBiasPerSlope(light, mapSize);
    this.drawShadowCasters(this.lightProjection, mapSize, true);
    // The soft cascade filter widens the tint penumbra with the gap to the caster, in metres, so it needs the view's size and the bias of a tint texel.
    this.tintView = { depthRange: light.far - light.near, uvPerMetre: 1 / (2 * light.extent), biasPerSlope: shadowBiasPerSlope(light, TINT_MAP_SIZE) };
    this.drawTintedShadows();
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    this.shadowsDirty = false;
  }

  /** True when the batch casts into the tint map instead of the depth map of the sun. */
  tintsShadow(batch) {
    return Boolean(this.tintedShadowsActive && batch.tintedShadow);
  }

  // The shadow program's opaqueShadow sampler is a comparison sampler, so while a depth map renders it needs a comparison-capable
  // depth texture on its unit that is not the render target: a 2D map left there, or the sun map itself, fails the draw.
  bindPlaceholderOpaqueShadow() {
    const context = this.context;
    context.activeTexture(context.TEXTURE0 + OPAQUE_SHADOW_UNIT);
    if (!this.placeholderShadowTexture) {
      this.placeholderShadowTexture = context.createTexture();
      context.bindTexture(context.TEXTURE_2D, this.placeholderShadowTexture);
      context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT24, 1, 1, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_COMPARE_MODE, context.COMPARE_REF_TO_TEXTURE);
    }
    context.bindTexture(context.TEXTURE_2D, this.placeholderShadowTexture);
    context.activeTexture(context.TEXTURE0);
  }

  allocateTintTarget() {
    const context = this.context;
    this.tintTexture = context.createTexture();
    bindTextureUnit(context, TINT_UNIT, this.tintTexture);
    context.texImage2D(context.TEXTURE_2D, 0, context.RGBA16F, TINT_MAP_SIZE, TINT_MAP_SIZE, 0, context.RGBA, context.HALF_FLOAT, null);
    this.backend?.setClampedFiltering(context.LINEAR);
    this.renderTargets.record('tintShadow', { width: TINT_MAP_SIZE, height: TINT_MAP_SIZE, format: 'RGBA16F' });
    this.tintFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.tintFramebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, this.tintTexture, 0);
    context.drawBuffers([context.COLOR_ATTACHMENT0]);
    assertShadowFramebufferComplete(context, 'Tinted shadow');
  }

  /**
   * Draws the light that blended and transmissive casters let through, as seen from the sun, in one draw of those casters:
   * the colour map starts white and each caster multiplies its transmittance into rgb while alpha keeps the nearest depth
   * (blend equation MIN). Does nothing, and allocates nothing, when no caster of that kind exists.
   */
  drawTintedShadows() {
    const tinting = this.batches.filter(batch => !batch.floor && batch.castShadow && this.tintsShadow(batch));
    if (tinting.length === 0) return;
    const context = this.context;
    if (!this.tintFramebuffer) this.allocateTintTarget();
    context.bindFramebuffer(context.FRAMEBUFFER, this.tintFramebuffer);
    context.viewport(0, 0, TINT_MAP_SIZE, TINT_MAP_SIZE);
    bindTextureUnit(context, OPAQUE_SHADOW_UNIT, this.shadowTexture);
    context.activeTexture(context.TEXTURE0);
    context.useProgram(this.depthProgram);
    const uniforms = this.depthAlphaUniforms;
    context.uniform1f(uniforms.tintMapSize, TINT_MAP_SIZE);
    context.uniform1f(uniforms.tintBias, this.shadowBiasPerSlope * 2);
    context.uniform1f(uniforms.tintPass, 1);
    context.disable(context.DEPTH_TEST);
    context.enable(context.BLEND);
    context.blendEquationSeparate(context.FUNC_ADD, context.MIN);
    context.blendFuncSeparate(context.DST_COLOR, context.ZERO, context.ONE, context.ONE);
    context.clearColor(1, 1, 1, 1);
    context.clear(context.COLOR_BUFFER_BIT);
    context.enable(context.POLYGON_OFFSET_FILL);
    context.polygonOffset(1, 1);
    for (const batch of tinting) {
      this.applyAlphaState(batch, false);
      context.uniform1f(uniforms.tintTransmission, batch.layerState[9]);
      context.uniform3fv(uniforms.tintFaceTransmittance, glassFaceTransmittance(batch.parts[0].material));
      this.drawBatch(batch, false, this.selectShadowInstances(batch, batch, this.lightProjection, TINT_MAP_SIZE), batch);
    }
    context.disable(context.POLYGON_OFFSET_FILL);
    context.enable(context.CULL_FACE);
    context.disable(context.BLEND);
    context.blendEquation(context.FUNC_ADD);
    context.enable(context.DEPTH_TEST);
    context.uniform1f(uniforms.tintPass, 0);
  }

  bindTintedShadows() {
    if (!this.tintedShadowsActive || !this.tintTexture) return;
    const context = this.context;
    bindTextureUnit(context, TINT_UNIT, this.tintTexture);
    context.uniform1i(this.uniforms.tintShadowMap, TINT_UNIT);
    context.activeTexture(context.TEXTURE0);
  }

  /**
   * The instances of a batch that can land in a shadow map, split by level. An instance outside the light's frustum
   * writes nothing. With an orthographic light and a known map size, the level follows the world size of one texel,
   * so a tree far smaller than a texel uses its coarsest level. Only shadowLods choose shadow levels: a batch with just
   * lods casts from level 0, so a part draws the same shadow, and the same pixels, with and without its camera levels (#3189).
   * Null when the whole batch draws as it is.
   */
  selectShadowInstances(batch, levelSet, lightMatrix, resolution) {
    if (!this.culling || !batch.cullable) return null;
    const planes = extractFrustumPlanes(lightMatrix, this.shadowFrustumPlanes ??= new Float32Array(24));
    const isOrthographic = lightMatrix[3] === 0 && lightMatrix[7] === 0 && lightMatrix[11] === 0 && lightMatrix[15] === 1;
    const selectsLevels = Boolean(resolution) && isOrthographic && levelSet !== batch && levelSet.levelErrors.length > 1;
    // Texels per world unit along the map's x axis; an orthographic matrix has depth 1 everywhere.
    const texelsPerUnit = selectsLevels ? Math.hypot(lightMatrix[0], lightMatrix[4], lightMatrix[8]) * resolution / 2 : 0;
    return selectInstances(levelSet.selection, {
      instanceData: batch.instanceData, instanceCount: batch.instanceCount, stride: INSTANCE_STRIDE, bounds: batch.bounds, margin: batch.swayReach * Math.abs(this.windState.strength),
      levelErrors: selectsLevels ? levelSet.levelErrors : [0], planes, viewProjection: lightMatrix,
      pixelsPerUnit: texelsPerUnit, pixelError: this.lodPixelError,
    });
  }

  // `sunMap` is true for the sun's maps (the single map and each cascade), where blended and transmissive casters draw into the tint map instead. Elsewhere
  // (cascades, point and spot tiles) they draw as opaque casters, except a blended part that did not ask to cast.
  // A world scene that sets neither shadowBounds.target nor extent gets a sun view fitted to its casters (issue #1695).
  // Skinned, morphed or crowd casters can leave any box, so they keep the fixed view.
  shadowCasterParts() {
    return this.batches.filter(batch => !batch.floor && batch.castShadow).flatMap(batch => batch.parts);
  }

  fittedWorldShadowView() {
    if (!this.world || this.shadowBounds?.target !== undefined || this.shadowBounds?.extent !== undefined) return null;
    const casters = this.shadowCasterParts();
    if (casters.length === 0) return null;
    return fitWorldShadowView(sceneBoundsOfParts(casters));
  }

  // The sun view the scene needs: the world fit, or for a scene that is not a world and wrote no bounds, the studio fit (issue #3392).
  fittedShadowView() {
    return this.fittedWorldShadowView() ?? this.fittedStudioShadowView();
  }

  // A scene bigger than the default 7 m studio view gets a view fitted to its parts, so its far walls are shadowed. Cached like the miss check below.
  fittedStudioShadowView() {
    if (this.world || this.shadowBounds?.target !== undefined || this.shadowBounds?.extent !== undefined) return null;
    const cacheKey = `${this.activeLightDirection}|${this.partsMoveCount ?? 0}`;
    if (this.studioShadowFitCache?.batches !== this.batches || this.studioShadowFitCache.cacheKey !== cacheKey) {
      const receivers = this.batches.filter(batch => !batch.floor).flatMap(batch => batch.parts);
      this.studioShadowFitCache = { batches: this.batches, cacheKey, view: fitStudioShadowView(this.shadowCasterParts(), receivers, this.activeLightDirection) };
    }
    return this.studioShadowFitCache.view;
  }

  // The studio shadow view (3.5 m round the origin) stays when a scene sets no shadowBounds target or extent. Returns that view when every
  // caster lies outside it, else null; cached per batch list, light direction and updateParts call because the check walks every part.
  studioShadowViewMissingCasters() {
    if (this.world || this.shadowBounds?.target !== undefined || this.shadowBounds?.extent !== undefined) return null;
    const cacheKey = `${this.activeLightDirection}|${this.partsMoveCount ?? 0}`;
    if (this.studioShadowMissCache?.batches !== this.batches || this.studioShadowMissCache.cacheKey !== cacheKey) {
      const view = resolveShadowLight(false, this.activeLightDirection);
      // A skinned, morphed or crowd part has no fixed box, so one of them means the answer is unknown and nothing warns.
      const boxes = this.shadowCasterParts().map(part => sceneBoundsOfParts([part]));
      const missed = !boxes.includes(null) && everyCasterOutsideShadowView(boxes, writeShadowLightMatrix(mat4.create(), view));
      this.studioShadowMissCache = { batches: this.batches, cacheKey, view: missed ? view : null };
    }
    return this.studioShadowMissCache.view;
  }

  drawShadowCasters(lightMatrix = this.lightProjection, resolution = null, sunMap = false) {
    const context = this.context;
    context.useProgram(this.depthProgram);
    context.uniformMatrix4fv(this.depthUniform, false, lightMatrix);
    context.uniform1f(this.depthAssemblyUniform, this.assemblyAmount ?? 0);
    context.uniform1f(this.depthWindUniforms.time, this.windState.time);
    context.uniform1f(this.depthWindUniforms.wind, this.windState.strength);
    // The base map sampler must not alias the shadow texture on unit 0 while that texture is the render target.
    context.uniform1i(this.depthAlphaUniforms.baseMap, 1);
    if (this.tintedShadowsActive) {
      context.uniform1f(this.depthAlphaUniforms.tintPass, 0);
      context.uniform1i(this.depthAlphaUniforms.opaqueShadow, OPAQUE_SHADOW_UNIT);
      this.bindPlaceholderOpaqueShadow();
    }
    context.enable(context.POLYGON_OFFSET_FILL);
    context.polygonOffset(1, 1);
    // A one texel sun map (the cascades draw the opaque casters) stays cleared: one texel would cut the tint pass against whatever sits at its centre.
    for (const batch of resolution === 1 ? [] : this.batches) {
      if (batch.floor || !batch.castShadow) continue;
      const fades = batch.tintedShadow && Boolean(batch.parts?.some(part => part.opacityScale));
      if (batch.tintedShadow && (sunMap && this.tintedShadowsActive || batch.alphaMode === 'blend' && batch.parts[0].castShadow !== true && !fades)) continue;
      if (this.depthShaderFeatures?.has(FADING_SHADOWS_FEATURE)) context.uniform1f(this.depthAlphaUniforms.shadowDither, fades ? 1 : 0);
      const levelSet = batch.shadowLevels ?? batch;
      const selection = this.selectShadowInstances(batch, levelSet, lightMatrix, resolution);
      if (selection?.visibleCount === 0) continue;
      this.applyAlphaState(batch, false);
      this.drawBatch(batch, false, selection, levelSet);
    }
    if (this.depthShaderFeatures?.has(FADING_SHADOWS_FEATURE)) context.uniform1f(this.depthAlphaUniforms.shadowDither, 0);
    context.disable(context.POLYGON_OFFSET_FILL);
    context.enable(context.CULL_FACE);
  }

  // The atlas has one row of tiles per four shadow tiles in use. The shader fetches by texel, so the height is free.
  allocateLocalShadowAtlas(tileCount) {
    const context = this.context;
    if (this.localShadowTexture) context.deleteTexture(this.localShadowTexture);
    if (this.localShadowFramebuffer) context.deleteFramebuffer(this.localShadowFramebuffer);
    this.localShadowAtlasHeight = Math.ceil(tileCount / SHADOW_TILES_PER_ROW) * SHADOW_TILE_SIZE;
    this.localShadowTexture = context.createTexture();
    bindTextureUnit(context, LOCAL_SHADOW_UNIT, this.localShadowTexture);
    context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT24, SHADOW_ATLAS_WIDTH, this.localShadowAtlasHeight, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
    this.renderTargets.record('localShadowAtlas', { width: SHADOW_ATLAS_WIDTH, height: this.localShadowAtlasHeight, format: 'DEPTH_COMPONENT24' });
    this.backend?.setClampedFiltering(context.NEAREST);
    this.localShadowFramebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, this.localShadowFramebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, this.localShadowTexture, 0);
    context.drawBuffers([context.NONE]);
    context.readBuffer(context.NONE);
    assertShadowFramebufferComplete(context, 'Local shadow');
    context.activeTexture(context.TEXTURE0);
  }

  // Builds the view of each atlas tile, and draws the atlas again only when a light moved or the casters changed.
  updateLocalShadows(casterChanged) {
    const casters = this.lighting.shadowCasters;
    if (casters.length === 0 || this.benchmark) return;
    const matrices = this.localShadowMatrices ??= new Float32Array(24 * 16);
    const texelAngles = this.localShadowTexelAngles ??= new Float32Array(24);
    const previous = this.localShadowPreviousMatrices ??= new Float32Array(24 * 16);
    const tileMatrix = new Float32Array(16);
    casters.forEach((caster, tile) => {
      texelAngles[tile] = writeShadowTile(caster, tileMatrix);
      matrices.set(tileMatrix, tile * 16);
    });
    const moved = casters.length !== this.localShadowTileCount || matrices.some((value, index) => value !== previous[index]);
    if (!moved && !casterChanged && this.localShadowTexture) return;
    previous.set(matrices);
    this.localShadowTileCount = casters.length;
    const context = this.context;
    if (!this.localShadowTexture || Math.ceil(casters.length / SHADOW_TILES_PER_ROW) * SHADOW_TILE_SIZE > this.localShadowAtlasHeight) this.allocateLocalShadowAtlas(casters.length);
    context.bindFramebuffer(context.FRAMEBUFFER, this.localShadowFramebuffer);
    context.viewport(0, 0, SHADOW_ATLAS_WIDTH, this.localShadowAtlasHeight);
    context.enable(context.DEPTH_TEST);
    context.clear(context.DEPTH_BUFFER_BIT);
    for (let tile = 0; tile < casters.length; tile++) {
      context.viewport(...tileViewport(tile));
      this.drawShadowCasters(matrices.subarray(tile * 16, tile * 16 + 16));
    }
    context.bindFramebuffer(context.FRAMEBUFFER, null);
  }

  /** Stores the wind time and strength the shadow pass must use; true when swaying batches need a new shadow map. */
  updateWindState(frame) {
    const next = { time: frame.time ?? 0, strength: frame.wind ?? 0.3 };
    const previous = this.windState;
    this.windState = next;
    if (previous.time === next.time && previous.strength === next.strength) return false;
    return this.batches.some(batch => batch.castShadow && SWAYING_TAGS.has(batch.parts[0].material.tag));
  }

  // Sets the clear colour behind the scene as [red, green, blue] or [red, green, blue, alpha] from 0 to 1; null restores the default.
  setBackground(background) {
    this.background = background ? resolveBackground(background) : null;
  }

  resize() {
    // A lost context answers every parameter query with null, so there is no size limit to plan against. This class has no restore path: the caller disposes the renderer and builds a new one when the context comes back.
    if (this.context.isContextLost()) return;
    // A canvas that grew or shrank changes the triangles per pixel, so denseSamples is judged again; a new count needs new render targets.
    const previousSamples = this.multisampleSamples;
    if (this.denseSamples != null) {
      this.multisampleSamples = this.chooseMultisampleSamples(this.densityParts);
      this.capabilities.samples = this.multisampleSamples;
    }
    const plan = planRenderSize({ width: Math.max(1, this.canvas.clientWidth), height: Math.max(1, this.canvas.clientHeight), pixelRatio: this.pixelRatio, samples: this.samples, memoryBudgetMiB: this.memoryBudgetMiB, geometryBytes: this.geometryBytes, textureBytes: this.textureBytes, hdr: this.hdr, bloom: !this.benchmark, depth: this.depth, maximumSize: Math.min(this.context.getParameter(this.context.MAX_RENDERBUFFER_SIZE), this.context.getParameter(this.context.MAX_TEXTURE_SIZE)), maximumMemoryBudgetMiB: this.maximumMemoryBudgetMiB });
    const { width, height } = plan;
    this.memoryPlan = plan;
    const sizeChanged = this.canvas.width !== width || this.canvas.height !== height;
    if (sizeChanged || this.multisampleSamples !== previousSamples) {
      this.canvas.width = width;
      this.canvas.height = height;
      if (!this.benchmark) this.allocateFrameTargets(width, height);
    }
    mat4.perspective(this.projection, this.world ? Math.PI / 4 : Math.PI / 5.5, width / height, 0.1, this.world ? 600 : 100);
  }

  /**
   * Without reversed depth the 24-bit buffer needs a tight near plane: a camera that left near unset gets one just in front of the
   * nearest scene bounds (near-plane-fit.js). A frame with its own near, an orthographic lens or a scene that can move out of its
   * bounds keeps the frame as it is.
   */
  withFittedNear(frame) {
    if (this.reversedDepth || frame.near !== undefined || frame.projection === 'orthographic') return frame;
    if (this.fitBounds === undefined) this.fitBounds = sceneBoundsOfParts(this.fitParts);
    if (!this.fitBounds) return frame;
    const far = frame.far ?? (this.world ? 600 : 100);
    const near = fittedNearPlane(this.fitBounds, this.view, far);
    return near === 0.1 ? frame : { ...frame, near };
  }

  /** The box around every part where it rests, skinned parts included: where the sun's receivers end, which the cascaded shadows read. */
  receiverBounds() {
    if (this.receiverBox === undefined) this.receiverBox = sceneBoundsOfParts(this.fitParts, { includeMoving: true });
    return this.receiverBox;
  }

  /** Every GPU render target this renderer holds: name, size, format, samples and bytes, largest first, with the total. */
  memoryReport() {
    return this.renderTargets.report();
  }

  releaseFrameTargets() {
    const context = this.context;
    const backend = this.backend;
    // The fog step may have left one of the textures deleted below on a mipmapped filter; binding it later is INVALID_OPERATION (1282, #2205).
    this.mipmappedTexture = null;
    for (const framebuffer of [this.multisampleFramebuffer, this.resolveFramebuffer]) if (framebuffer) backend.deleteFramebuffer(framebuffer);
    for (const renderbuffer of [this.multisampleColor, this.multisampleDepth]) if (renderbuffer) backend.deleteRenderbuffer(renderbuffer);
    for (const texture of [this.frameTexture, this.depthTexture]) if (texture) backend.deleteTexture(texture);
    this.refractionChain?.release();
    this.refractionDepth?.release();
    bloomPyramidSupport.releaseTargets?.(this);
    this.bloomTargets = [];
    this.renderTargets.release('multisampleColor', 'multisampleDepth', 'frameColor', 'sceneDepth');
    this.releaseOcclusionTarget();
    this.passSupport?.releaseTargets(context);
    for (const stage of this.postStages ?? []) stage.releaseTargets(context);
    if (this.localVolumeComposite) requireFeatureCode('volumeFog').support.releaseLocalVolumeComposite(this, false);
    this.multisampleFramebuffer = this.resolveFramebuffer = this.multisampleColor = this.multisampleDepth = this.frameTexture = this.depthTexture = null;
  }

  releaseOcclusionTarget() {
    if (!this.occlusionTarget) return;
    this.context.deleteTexture(this.occlusionTarget.texture);
    this.context.deleteFramebuffer(this.occlusionTarget.framebuffer);
    this.renderTargets.release('ambientOcclusion');
    this.occlusionTarget = null;
  }

  /** Whether a batch is drawn by the opaque loop, and so by render passes. */
  drawsInOpaqueLoop(batch) {
    return batchPass(batch) === 'opaque' && !isTranslucentMode(batch.alphaMode);
  }

  /**
   * Whether a batch's parts take object IDs, in draw order. A blended batch (tree leaves exported as BLEND) takes them too:
   * the object ID and Cryptomatte passes draw it as a cutout, so a matte covers its texels instead of leaving them black.
   */
  takesObjectIds(batch) {
    return this.drawsInOpaqueLoop(batch) || (batchPass(batch) === 'opaque' && batch.alphaMode === 'blend');
  }

  /** The batch an ID pass draws: a blended batch becomes a cutout at half alpha, so see-through texels write nothing and hide nothing. */
  idPassBatch(batch) {
    return batch.alphaMode === 'blend' ? { ...batch, alphaMode: 'mask', alphaCutoff: ID_PASS_BLEND_CUTOFF } : batch;
  }

  // Compiled and allocated on first use, so scenes without occlusion pay nothing.
  ensureOcclusionTarget() {
    const context = this.context;
    if (!this.occlusionProgram) {
      this.occlusionProgram = compileProgram(context, fullscreenVertex, ambientOcclusionFragment);
      this.occlusionUniforms = uniformLocations(context, this.occlusionProgram, ['sceneDepth', 'inverseViewProjection', 'radius', 'projectionScale', 'aspect', 'orthographic']);
    }
    if (this.occlusionTarget) return;
    const width = Math.max(1, Math.ceil(this.canvas.width / 2));
    const height = Math.max(1, Math.ceil(this.canvas.height / 2));
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texImage2D(context.TEXTURE_2D, 0, context.R8, width, height, 0, context.RED, context.UNSIGNED_BYTE, null);
    this.renderTargets.record('ambientOcclusion', { width, height, format: 'R8' });
    this.backend?.setClampedFiltering(context.LINEAR);
    const framebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
    this.occlusionTarget = { texture, framebuffer, width, height };
  }

  drawAmbientOcclusion(frame, effects) {
    const context = this.context;
    this.ensureOcclusionTarget();
    const uniforms = this.occlusionUniforms;
    context.bindFramebuffer(context.FRAMEBUFFER, this.occlusionTarget.framebuffer);
    context.viewport(0, 0, this.occlusionTarget.width, this.occlusionTarget.height);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.occlusionProgram);
    context.activeTexture(context.TEXTURE1);
    context.bindTexture(context.TEXTURE_2D, this.depthTexture);
    context.uniform1i(uniforms.sceneDepth, 1);
    context.uniformMatrix4fv(uniforms.inverseViewProjection, false, mat4.invert([], this.projection));
    context.uniform1f(uniforms.radius, effects.ambientOcclusionRadius);
    context.uniform1f(uniforms.projectionScale, 0.5 * this.projection[5]);
    context.uniform1f(uniforms.aspect, this.canvas.width / this.canvas.height);
    context.uniform1f(uniforms.orthographic, frame.projection === 'orthographic' ? 1 : 0);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  allocateFrameTargets(width, height) {
    this.releaseFrameTargets();
    // 24 bits at least (issue #751): 16 bits is one step per 1.5 cm at 10 m. Reversed depth respecifies this store as 32-bit float.
    const depthFormat = 'DEPTH_COMPONENT24';
    const multisample = this.backend.createMultisampleTarget({ width, height, samples: this.multisampleSamples, hdr: this.hdr });
    this.multisampleFramebuffer = multisample.framebuffer;
    this.multisampleColor = multisample.colorBuffer;
    this.multisampleDepth = multisample.depthBuffer;
    this.renderTargets.record('multisampleColor', { width, height, format: this.hdr ? 'RGBA16F' : 'RGBA8', samples: this.multisampleSamples });
    this.renderTargets.record('multisampleDepth', { width, height, format: depthFormat, samples: this.multisampleSamples });
    this.renderTargets.record('frameColor', { width, height, format: this.hdr ? 'RGBA16F' : 'RGBA8' });
    const resolve = this.backend.createResolveTarget({ width, height, hdr: this.hdr, depth: this.depth });
    this.resolveFramebuffer = resolve.framebuffer;
    this.frameTexture = resolve.colorTexture;
    this.depthTexture = resolve.depthTexture;
    if (this.depth) this.renderTargets.record('sceneDepth', { width, height, format: depthFormat });
    this.bloomWidth = Math.max(1, Math.ceil(width / 2));
    this.bloomHeight = Math.max(1, Math.ceil(height / 2));
    this.backend.bindCanvasTarget();
    this.chooseColorFormat(width, height);
  }

  // An opaque canvas never reads the frame's alpha, so the frame and multisample colour take 4 bytes a pixel instead of 8 (#2179).
  // A device that refuses the compact framebuffers gets the RGBA16F targets back.
  chooseColorFormat(width, height) {
    this.colorFormat = this.hdr ? 'RGBA16F' : 'RGBA8';
    if (!canUseCompactColor(this)) return;
    try {
      respecifyColorTargets(this, width, height);
    } catch {
      this.compactColor = false;
      this.allocateFrameTargets(width, height);
    }
  }

  // The prefilter and BRDF programs build while the other programs do, instead of after them.
  startEnvironmentPrograms() {
    this.pendingEnvironmentPrograms = new Map();
    for (const fragmentSource of [requireEnvironmentSupport().prefilterFragment, requireEnvironmentSupport().brdfFragment]) {
      this.pendingEnvironmentPrograms.set(fragmentSource, this.backend.startProgram(fullscreenVertex, fragmentSource));
    }
  }

  compileEnvironmentProgram(context, vertexSource, fragmentSource) {
    const pendingProgram = this.pendingEnvironmentPrograms?.get(fragmentSource);
    if (!pendingProgram) return compileProgram(context, vertexSource, fragmentSource);
    this.pendingEnvironmentPrograms.delete(fragmentSource);
    return this.backend.finishProgram(pendingProgram);
  }

  initializeEnvironment(map) {
    const context = this.context;
    context.useProgram(this.program);
    context.uniform1i(this.uniforms.environmentSpecular, ENVIRONMENT_SPECULAR_UNIT);
    context.uniform1i(this.uniforms.environmentBrdf, ENVIRONMENT_BRDF_UNIT);
    if (this.liquidProgram) {
      context.useProgram(this.liquidProgram);
      context.uniform1i(this.liquidUniforms.environmentSpecular, ENVIRONMENT_SPECULAR_UNIT);
    }
    this.bindEnvironmentTextures(this.whiteTexture, this.whiteTexture);
    if (!this.benchmark && map && !this.deferEnvironmentPrefilter) this.prepareEnvironment(map);
  }

  bindEnvironmentTextures(specularTexture, brdfTexture) {
    const context = this.context;
    bindTextureUnit(context, ENVIRONMENT_SPECULAR_UNIT, specularTexture);
    bindTextureUnit(context, ENVIRONMENT_BRDF_UNIT, brdfTexture);
    context.activeTexture(context.TEXTURE0);
  }

  // Prefilters a map the first time it is seen; maps spread from one created map share its data and reuse the GPU textures (an `irradianceSource` map, which only the diffuse light reads, counts as part of the map). Returns true when new textures were built.
  prepareEnvironment(map) {
    requireEnvironmentSupport().assertMap(map);
    if (this.environmentResources?.data === map.data && this.environmentResources.irradianceSource === map.irradianceSource) return false;
    requireEnvironmentSupport().estimateBytes(map, this.capabilities.maximumTextureSize);
    const resources = requireEnvironmentSupport().createResources(this.context, map, { compileProgram: (context, vertexSource, fragmentSource) => this.compileEnvironmentProgram(context, vertexSource, fragmentSource), fullscreenVertex });
    this.environmentResources?.dispose();
    this.environmentResources = resources;
    this.textureBytes += resources.bytes - this.environmentBytes;
    this.environmentBytes = resources.bytes;
    return true;
  }

  /**
   * Prefilters the map in steps, awaiting `checkpoint()` between them, for a renderer built with `deferEnvironmentPrefilter: true`.
   * Call it before the first render: the steps leave GL state mid-pass, so no frame may draw on this context until it resolves.
   */
  async prepareEnvironmentInSlices(map, checkpoint) {
    requireEnvironmentSupport().assertMap(map);
    if (this.environmentResources?.data === map.data && this.environmentResources.irradianceSource === map.irradianceSource) return false;
    requireEnvironmentSupport().estimateBytes(map, this.capabilities.maximumTextureSize);
    const resources = await requireEnvironmentSupport().createResourcesInSlices(this.context, map, { compileProgram: (context, vertexSource, fragmentSource) => this.compileEnvironmentProgram(context, vertexSource, fragmentSource), fullscreenVertex }, checkpoint);
    this.environmentResources?.dispose();
    this.environmentResources = resources;
    this.textureBytes += resources.bytes - this.environmentBytes;
    this.environmentBytes = resources.bytes;
    return true;
  }

  // Binds the prefiltered textures for this frame and returns the active map, or null for the built-in studio lighting.
  activateEnvironment(map) {
    this.activeMap = this.benchmark ? null : map;
    if (this.benchmark || !map) {
      this.bindEnvironmentTextures(this.whiteTexture, this.whiteTexture);
      return null;
    }
    if (this.prepareEnvironment(map)) this.resize();
    this.bindEnvironmentTextures(this.environmentResources.specularTexture, this.environmentResources.brdfTexture);
    return map;
  }

  applyEnvironmentUniforms(map, uniforms = this.uniforms) {
    const context = this.context;
    context.uniform1f(uniforms.environmentEnabled, map ? 1 : 0);
    if (!map) return;
    this.applyDiffuseUniforms(map, uniforms, true);
    context.uniform1f(uniforms.environmentIntensity, map.intensity);
    context.uniform2f(uniforms.environmentRotation, Math.cos(map.rotation), Math.sin(map.rotation));
    context.uniform1f(uniforms.environmentLevelMax, this.environmentResources.levelCount - 1);
  }

  // The diffuse light of the global map: the fitted coefficients (kept for the light shading preset), the map's rotation and intensity, and the
  // constant bounce a room adds on top of the exact irradiance grid. A reflection probe passes withBounce false, as it never bounced.
  applyDiffuseUniforms(map, uniforms, withBounce) {
    const context = this.context;
    const coefficients = this.environmentResources.irradiance;
    const bounced = withBounce ? map.irradianceWithBounce?.(coefficients) : null;
    // environment.environmentDiffuseScale scales the diffuse light; the specular light and a probe are left alone. environment.ambientColor is
    // not added here: it is a shadow fill the main shader weights by the key light's shadow (keyReach in src/shaders.js).
    const environmentDiffuseScale = withBounce ? this.lighting.environmentDiffuseScale : 1;
    const irradiance = bounced ?? coefficients;
    if (uniforms['environmentIrradiance[0]']) context.uniform3fv(uniforms['environmentIrradiance[0]'], irradiance);
    if (uniforms.environmentBounce) context.uniform3f(uniforms.environmentBounce, irradiance[0] - coefficients[0], irradiance[1] - coefficients[1], irradiance[2] - coefficients[2]);
    if (uniforms.environmentDiffuseFrame) context.uniform3f(uniforms.environmentDiffuseFrame, Math.cos(map.rotation), Math.sin(map.rotation), map.intensity * environmentDiffuseScale);
  }

  drawEnvironmentBackground(map, frame, exposure) {
    if (!map?.showBackground || this.transparent) return false;
    const context = this.context;
    if (!this.environmentBackgroundProgram) {
      this.environmentBackgroundProgram = compileProgram(context, fullscreenVertex, this.withViewTransform(requireEnvironmentSupport().backgroundFragment, 'background'));
      this.environmentBackgroundUniforms = uniformLocations(context, this.environmentBackgroundProgram, ['inverseViewProjection', 'eye', 'backgroundLevel', 'exposure', 'hdrEnabled', 'environmentSpecular', 'environmentRotation', 'environmentIntensity', 'environmentLevelMax', 'sunMapDirection', 'sunDiscRadiance', 'sunDiscRadius']);
    }
    const uniforms = this.environmentBackgroundUniforms;
    const levelMax = this.environmentResources.levelCount - 1;
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.environmentBackgroundProgram);
    context.uniformMatrix4fv(uniforms.inverseViewProjection, false, this.inverseViewProjection);
    context.uniform3fv(uniforms.eye, frame.eye);
    context.uniform1f(uniforms.backgroundLevel, map.backgroundBlur * levelMax);
    context.uniform1f(uniforms.exposure, exposure);
    context.uniform1f(uniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.uniform1i(uniforms.environmentSpecular, ENVIRONMENT_SPECULAR_UNIT);
    context.uniform2f(uniforms.environmentRotation, Math.cos(map.rotation), Math.sin(map.rotation));
    context.uniform1f(uniforms.environmentIntensity, map.intensity);
    context.uniform1f(uniforms.environmentLevelMax, levelMax);
    const sunDisc = map.sunDisc;
    context.uniform3fv(uniforms.sunMapDirection, sunDisc?.direction ?? [0, -1, 0]);
    context.uniform3fv(uniforms.sunDiscRadiance, sunDisc?.radiance ?? [0, 0, 0]);
    context.uniform1f(uniforms.sunDiscRadius, frame.environment?.sunAngularRadius ?? this.environment?.sunAngularRadius ?? DEFAULT_SUN_ANGULAR_RADIUS);
    context.drawArrays(context.TRIANGLES, 0, 3);
    return true;
  }

  drawSky(frame) {
    const context = this.context;
    const environment = { skyTop: [0.20, 0.38, 0.52], skyBottom: [0.62, 0.70, 0.67], lightDirection: [-3, 6, 4], daylight: 1, ...this.environment, ...frame.environment };
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(this.skyProgram);
    context.uniform3fv(this.skyUniforms.skyTop, environment.skyTop);
    context.uniform3fv(this.skyUniforms.skyBottom, environment.skyBottom);
    context.uniform3fv(this.skyUniforms.sunDirection, environment.lightDirection);
    context.uniformMatrix4fv(this.skyUniforms.inverseViewProjection, false, this.inverseViewProjection);
    context.uniform3fv(this.skyUniforms.eye, frame.eye);
    context.uniform1f(this.skyUniforms.time, frame.time ?? 0);
    context.uniform1f(this.skyUniforms.daylight, environment.daylight);
    context.uniform1f(this.skyUniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  // True when the frame draws local volumes. An empty list costs nothing; anything else is checked here, before a program is bound.
  prepareLocalVolumes(input, frame, volumeTime, volumeShutter = 0) {
    if (input === undefined || (Array.isArray(input) && input.length === 0)) return false;
    return requireFeatureCode('volumeFog').support.prepareLocalVolumes(this, input, frame, volumeTime, volumeShutter) > 0;
  }

  // The post steps this frame uses. A step that is off costs nothing in a program that has it compiled out.
  postStepsOf(frame, effects, volume, occluded, fogSky, localVolumes) {
    const steps = [];
    if (this.transparent) steps.push('transparent');
    if (occluded) steps.push('occlusion');
    if (isBloomActive(effects)) steps.push('bloom');
    if (volume.density > 0) steps.push('volume');
    if (volume.density > 0 && volume.field) steps.push('field');
    if (volume.density > 0 && requireFeatureCode('volumeFog').support.usesDetail(volume)) steps.push('detail');
    if (volume.density > 0 && this.fogLightBuffers?.count > 0) steps.push('lights');
    if (localVolumes) steps.push('local');
    if (localVolumes && this.localVolumeBuffers.gridShutter > 0) steps.push(GRID_MOTION_STEP);
    if (localVolumes) steps.push(...localVolumeKindSteps(this.localVolumeBuffers.kind));
    if (localVolumes && this.localVolumeBuffers.noiseOctaves) steps.push(NOISE_OCTAVES_STEP);
    if (localVolumes && this.localVolumeBuffers.gridDetail) steps.push(GRID_DETAIL_STEP);
    if (fogSky) steps.push('sky');
    if (frame.volumeExplosion) steps.push('explosion');
    if (this.autoExposureScale != null) steps.push('autoExposure');
    const gradesColor = effects.saturation !== 1 || effects.contrast !== 1 || effects.temperature !== 0;
    const finishes = gradesColor || (frame.monochrome ?? 0) !== 0 || Boolean(frame.cinematic) || effects.vignette !== 0 || effects.grain !== 0;
    if (finishes) steps.push('finish');
    if (isDitherActive(effects) || (isBloomActive(effects) && effects.bloom.radius > 1.5)) steps.push('dither');
    if (frame.linearOutput) requireFeatureCode('linearOutput');
    if (isBloomActive(effects) && effects.bloom.keepHue) requireFeatureCode('keepHue');
    for (const feature of registeredFeatureCode.values()) {
      const step = feature.postStep?.(this, frame, effects);
      if (step) steps.push(step);
    }
    return steps;
  }

  // Compiles a program for the steps of this frame the first time they occur. The program with every step stays in use
  // until the driver has finished building the new one, so a step that appears later does not stall a frame.
  selectPostProgram(steps) {
    if (steps.join() === POST_STEPS.join()) return { program: this.postProgram, uniforms: this.postUniforms };
    const key = steps.join(',');
    let variant = this.postVariants.get(key);
    if (!variant) {
      variant = { pending: this.backend.startProgram(fullscreenVertex, this.withViewTransform(createPostFragment(steps), 'post')) };
      this.postVariants.set(key, variant);
    }
    if (variant.pending) {
      const parallelCompile = this.context.getExtension('KHR_parallel_shader_compile');
      const building = !this.exactFrames && parallelCompile && !POST_STEPS_WITH_OPTIONAL_CODE.some(step => steps.includes(step)) && !this.context.getProgramParameter(variant.pending.program, parallelCompile.COMPLETION_STATUS_KHR);
      if (building) return { program: this.postProgram, uniforms: this.postUniforms };
      variant.program = this.backend.finishProgram(variant.pending);
      variant.uniforms = postUniformLocations(this.context, variant.program);
      variant.pending = null;
    }
    return variant;
  }

  // effects.autoExposure (src/auto-exposure.js) meters the frame and sets the factor the post pass scales it by; null when it is off.
  meterAutoExposure(frame, sourceTexture) {
    if (frame.effects?.autoExposure === undefined) {
      this.autoExposure = null;
      this.autoExposureScale = null;
      return;
    }
    this.autoExposureScale = requireFeatureCode('autoExposure').measure(this, frame, sourceTexture);
  }

  // The fog step leaves the last frame's texture on a mipmapped filter. The stages and bloom read before this frame's
  // mip chain exists, so on that filter they would sample the previous frame's blurred levels: a ghost after a seek.
  restoreSingleLevelFiltering() {
    if (!this.mipmappedTexture) return;
    const context = this.context;
    context.bindTexture(context.TEXTURE_2D, this.mipmappedTexture);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    this.mipmappedTexture = null;
  }

  resolveFrame(frame, effects, environment, volume) {
    const context = this.context;
    this.backend.resolveMultisample({ source: this.multisampleFramebuffer, destination: this.resolveFramebuffer, width: this.canvas.width, height: this.canvas.height, depth: this.depth });
    this.restoreSingleLevelFiltering();
    let sourceTexture = this.frameTexture;
    for (const stage of this.postStages) sourceTexture = stage.apply(this, frame, effects, sourceTexture) ?? sourceTexture;
    // A grid with velocity blurs over the shutter of the scene's motion blur, or over environment.volumeShutter when the caller sets one (#1759).
    const localVolumes = this.prepareLocalVolumes(environment.localVolumes, frame, environment.volumeTime ?? frame.time ?? 0, environment.volumeShutter ?? effects.motionBlur.shutter);
    // A glowing volume is drawn before bloom extraction so it blooms; the final pass then skips its local step.
    const compositedLocalVolumes = localVolumes && isBloomActive(effects) && this.localVolumeBuffers.emissive;
    if (compositedLocalVolumes) sourceTexture = requireFeatureCode('volumeFog').support.compositeLocalVolumes(this, frame, environment, sourceTexture);
    const bloomActive = isBloomActive(effects) && this.drawBloom(effects.bloom, sourceTexture);
    const occluded = effects.ambientOcclusion > 0 && Boolean(this.depthTexture);
    if (occluded) this.drawAmbientOcclusion(frame, effects);
    this.meterAutoExposure(frame, sourceTexture);
    // A frame that names an outputFramebuffer (src/float-output.js) draws its final pass there, not on the canvas.
    context.bindFramebuffer(context.FRAMEBUFFER, frame.outputFramebuffer ?? null);
    context.viewport(0, 0, this.canvas.width, this.canvas.height);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    const fogSky = this.fogSkyVisibility?.(this.sceneParts, volume, context, environment);
    const fogSupport = volume.density > 0 ? requireFeatureCode('volumeFog').support : null;
    if (fogSupport) fogSupport.packLights(this);
    else if (this.fogLightBuffers) this.fogLightBuffers.count = 0;
    const post = this.selectPostProgram(this.postStepsOf(frame, effects, volume, occluded, fogSky, localVolumes && !compositedLocalVolumes));
    context.useProgram(post.program);
    if (this.look) viewTransformShader.bindLook(this, post.program);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, sourceTexture);
    // The fog's glow reads blurred copies of the frame from its mip chain, so a tap is smooth instead of one speckled pixel.
    if (volume.density > 0 || (localVolumes && !compositedLocalVolumes && this.localVolumeBuffers.blurred)) {
      context.generateMipmap(context.TEXTURE_2D);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR_MIPMAP_LINEAR);
      this.mipmappedTexture = sourceTexture;
    } else if (this.mipmappedTexture === sourceTexture) {
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      this.mipmappedTexture = null;
    }
    context.uniform1i(post.uniforms.frameTexture, 0);
    context.activeTexture(context.TEXTURE1);
    context.bindTexture(context.TEXTURE_2D, this.depthTexture ?? this.whiteTexture);
    context.uniform1i(post.uniforms.sceneDepth, 1);
    fogSupport?.bindUniforms(this, post, volume, environment, frame);
    if (localVolumes && !compositedLocalVolumes) requireFeatureCode('volumeFog').support.bindLocalVolumes(this, post, frame, environment);
    context.activeTexture(context.TEXTURE2);
    context.bindTexture(context.TEXTURE_2D, bloomActive && this.bloomTargets.length > 0 ? this.bloomTargets[0].texture : this.whiteTexture);
    context.uniform1i(post.uniforms.bloomTexture, 2);
    context.uniform1f(post.uniforms.bloomStrength, bloomActive ? effects.bloom.strength : 0);
    context.uniform1f(post.uniforms.bloomKeepHue, bloomActive && effects.bloom.keepHue ? 1 : 0);
    context.activeTexture(context.TEXTURE4);
    context.bindTexture(context.TEXTURE_2D, occluded ? this.occlusionTarget.texture : this.whiteTexture);
    context.uniform1i(post.uniforms.occlusionTexture, 4);
    context.uniform1f(post.uniforms.occlusionStrength, occluded ? effects.ambientOcclusion : 0);
    if (this.autoExposureScale != null) context.uniform1f(post.uniforms.autoExposureScale, this.autoExposureScale);
    context.uniform2f(post.uniforms.occlusionTexel, 1 / Math.ceil(this.canvas.width / 2), 1 / Math.ceil(this.canvas.height / 2));
    context.uniform1f(post.uniforms.transparent, this.transparent ? 1 : 0);
    context.uniform1f(post.uniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.uniform3f(post.uniforms.grade, effects.saturation, effects.contrast, effects.temperature);
    context.uniform1f(post.uniforms.vignette, effects.vignette);
    context.uniform1f(post.uniforms.grainAmount, effects.grain);
    context.uniform2f(post.uniforms.resolution, this.canvas.width, this.canvas.height);
    context.uniform1f(post.uniforms.monochrome, frame.monochrome ?? 0);
    context.uniform1f(post.uniforms.fade, frame.fade ?? 0);
    context.uniform1f(post.uniforms.cinematic, frame.cinematic ? 1 : 0);
    context.uniform1f(post.uniforms.time, frame.time ?? 0);
    context.uniform1f(post.uniforms.volumeExplosion, frame.volumeExplosion ? 1 : 0);
    context.uniform1f(post.uniforms.explosionProgress, frame.explosionProgress ?? 1);
    context.uniformMatrix4fv(post.uniforms.inverseViewProjection, false, this.inverseViewProjection);
    context.uniform3fv(post.uniforms.eye, frame.eye);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  drawTranslucent(frame, environment, assemblyAmount, environmentMap) {
    this.activateEnvironment(environmentMap);
    const liquids = this.batches.filter(batch => batchPass(batch) === 'liquid');
    const foams = this.batches.filter(batch => batchPass(batch) === 'foam');
    this.additiveBehindShells = null;
    if (liquids.length === 0 && foams.length === 0) { this.glassBackCache = null; this.refractionDepth?.release(); this.refractionChain?.release(); return; }
    this.drawAdditiveBehindShells(liquids);
    liquidPassDrawer()(this, { frame, environment, assemblyAmount, environmentMap, liquids, foams, environmentSpecularUnit: ENVIRONMENT_SPECULAR_UNIT, maximumDistance: MAX_FINITE_DISTANCE, vertexSource: vertexShader, fragmentSource: liquidFragmentSource() });
  }

  // Allocated on the first frame that asks for bloom, so scenes without it pay nothing.
  ensureBloomTargets() {
    bloomPyramidSupport.ensureTargets?.(this, compileProgram, fullscreenVertex);
  }

  drawBloom(bloom, sourceTexture = this.frameTexture) {
    if (!bloomPyramidSupport.draw) { loadBloomPyramid(); return false; }
    bloomPyramidSupport.draw(this, bloom, sourceTexture);
    return true;
  }

  /** Culling, cutout and opacity state for one batch, in the color pass (textured) or the shadow depth pass. */
  applyAlphaState(batch, textured) {
    const context = this.context;
    if (this.shaderFeatures?.has(CLIP_PLANES_FEATURE) && !this.benchmark) bindClipPlanes(this, batch, textured ? this.uniforms : this.depthClipLocations);
    // The shadow depth pass (not textured) draws both faces. A single-sided terrain edge, leaf card or open shell seen from
    // behind would otherwise write no depth, and the sun would pass through it.
    if (batch.doubleSided || !textured) {
      context.disable(context.CULL_FACE);
    } else {
      context.enable(context.CULL_FACE);
    }
    const masked = batch.alphaMode === 'mask';
    if (!textured) {
      const uniforms = this.depthAlphaUniforms;
      context.uniform1f(uniforms.alphaMasked, masked ? 1 : 0);
      context.uniform1f(uniforms.alphaCutoff, batch.alphaCutoff);
      context.uniform1f(uniforms.materialOpacity, batch.opacity);
      context.uniform1f(uniforms.hasBaseMap, batch.mapState[0] ? 1 + (batch.mapState[0].uvChannel ?? 0) : 0);
      layerTextureSupport.bindDepth?.(this, batch);
      if (masked || batch.tintedShadow) {
        context.activeTexture(context.TEXTURE0 + 1);
        context.bindTexture(context.TEXTURE_2D, batch.textures[0]);
      }
      return;
    }
    this.applyDepthRank((batch.depthLayer ?? 0) * RANKS_PER_LAYER);
    const useCoverage = masked && this.samples > 1 && !this.benchmark && !this.renderingPass;
    if (useCoverage) {
      context.enable(context.SAMPLE_ALPHA_TO_COVERAGE);
    } else {
      context.disable(context.SAMPLE_ALPHA_TO_COVERAGE);
    }
    const uniforms = this.uniforms;
    context.uniform1f(uniforms.alphaMode, ALPHA_MODES[batch.alphaMode]);
    context.uniform1f(uniforms.alphaCutoff, batch.alphaCutoff);
    context.uniform1f(uniforms.materialOpacity, batch.opacity);
    context.uniform1f(uniforms.alphaToCoverage, useCoverage ? 1 : 0);
    context.uniform1f(uniforms.doubleSided, batch.doubleSided ? 1 : 0);
  }

  /**
   * Pulls what draws next `rank` steps toward the eye, in depth only, for the colour pass; rank 0 is the plain depth test.
   * A step is a view-space distance (FLUSH_STEP metres plus FLUSH_RELATIVE_STEP of the depth), so it separates two faces the
   * same way on every depth format, plus a slope-only polygon offset for the depth the rasteriser's snapping adds on a
   * grazing face. `towardEye` is the sign of nearer depth values: -1 for standard depth, 1 for reversed depth.
   */
  applyDepthRank(rank, towardEye = -1) {
    const context = this.context;
    context.uniform3f(this.uniforms.flushBias, rank * FLUSH_STEP, rank * FLUSH_RELATIVE_STEP, towardEye < 0 && rank ? -rank * FLUSH_CLIP_STEP : 0);
    if (rank) {
      context.enable(context.POLYGON_OFFSET_FILL);
      context.polygonOffset(towardEye * rank * FLUSH_SLOPE_STEP, 0);
    } else {
      context.disable(context.POLYGON_OFFSET_FILL);
    }
  }

  /** Tells the main program how clip space moves per metre along the view direction, for the depth ranks. */
  setFlushProjection(viewProjection) {
    const view = this.view;
    const forward = [-view[2], -view[6], -view[10]];
    for (let row = 0; row < 4; row++) {
      clipPerMetreScratch[row] = viewProjection[row] * forward[0] + viewProjection[4 + row] * forward[1] + viewProjection[8 + row] * forward[2];
    }
    this.context.uniform4fv(this.uniforms.clipPerMetre, clipPerMetreScratch);
  }

  /** Draws additive batches that lie behind every shell into the opaque scene the shell reads; drawBlendBatches skips them. */
  drawAdditiveBehindShells(liquids) {
    const shells = liquids.filter(batch => batch.layerState[9] > 0);
    const additive = this.batches.filter(batch => batch.alphaMode === 'add' && batchPass(batch) === 'opaque' && batch.depthTest !== false);
    const behind = additiveBatchesBehindShells(this, additive, shells);
    if (behind.length === 0) return;
    this.additiveBehindShells = new Set(behind);
    const context = this.context;
    bindAlphaPassState(this);
    context.enable(context.BLEND);
    context.blendFuncSeparate(context.SRC_ALPHA, context.ONE, context.ZERO, context.ONE);
    context.depthMask(false);
    for (const batch of behind) this.drawAlphaBatch(batch, true);
    context.depthMask(true);
    this.applyDepthRank(0);
    context.disable(context.BLEND);
    context.enable(context.CULL_FACE);
    context.bindVertexArray(null);
  }

  /** Draws blended batches back to front as one set; see drawBlendedBatchesInOrder. */
  drawBlendedInOrder(batches) {
    drawBlendedBatchesInOrder(this, batches);
  }

  /** Alpha-blended batches draw after opaque and masked geometry, farthest first, without writing depth. Additive batches draw last. */
  drawBlendBatches(frame) {
    const context = this.context;
    const blendBatches = this.batches.filter(batch => batch.alphaMode === 'blend' && batchPass(batch) === 'opaque');
    // Light adds in any order, so additive batches need no sort.
    const addBatches = this.batches.filter(batch => batch.alphaMode === 'add' && batchPass(batch) === 'opaque' && !this.additiveBehindShells?.has(batch));
    if (blendBatches.length === 0 && addBatches.length === 0) return;
    // The liquid and foam pass may have switched program, texture unit 0 and the viewport.
    bindAlphaPassState(this);
    const depthOrdered = blendBatches.filter(batch => batch.depthTest !== false);
    const overlayOrdered = blendBatches.filter(batch => batch.depthTest === false);
    const depthAddBatches = addBatches.filter(batch => batch.depthTest !== false);
    const overlayAddBatches = addBatches.filter(batch => batch.depthTest === false);
    // Fully opaque texels (most of a baked scene exported as BLEND) draw first as a cutout that writes depth, so they hide
    // whatever lies behind them in any draw order. The blend pass below then shades only the translucent texels (depth LESS).
    for (const batch of depthOrdered) {
      if (blendBatchDrawsCutoutFirst(batch)) this.drawAlphaBatch({ ...batch, alphaMode: 'mask', alphaCutoff: 0.999 }, true);
    }
    context.enable(context.BLEND);
    // The program writes a blended part premultiplied, so its specular is not faded by alpha (blend-output.js).
    context.blendFuncSeparate(context[BLEND_FACTORS.sourceColor], context[BLEND_FACTORS.destinationColor], context[BLEND_FACTORS.sourceAlpha], context[BLEND_FACTORS.destinationAlpha]);
    context.depthMask(false);
    drawBlendedBatchesInOrder(this, depthOrdered);
    if (depthAddBatches.length > 0) {
      // Source colour times opacity is added to the frame; the destination alpha is kept.
      context.blendFuncSeparate(context.SRC_ALPHA, context.ONE, context.ZERO, context.ONE);
      for (const batch of depthAddBatches) this.drawAlphaBatch(batch, true);
    }
    if (overlayOrdered.length > 0 || overlayAddBatches.length > 0) {
      context.disable(context.DEPTH_TEST);
      if (overlayOrdered.length > 0) {
        context.blendFuncSeparate(context[BLEND_FACTORS.sourceColor], context[BLEND_FACTORS.destinationColor], context[BLEND_FACTORS.sourceAlpha], context[BLEND_FACTORS.destinationAlpha]);
        drawBlendedBatchesInOrder(this, overlayOrdered);
      }
      if (overlayAddBatches.length > 0) {
        context.blendFuncSeparate(context.SRC_ALPHA, context.ONE, context.ZERO, context.ONE);
        for (const batch of overlayAddBatches) this.drawAlphaBatch(batch, true);
      }
      context.enable(context.DEPTH_TEST);
    }
    context.depthMask(true);
    this.applyDepthRank(0);
    context.disable(context.BLEND);
    context.disable(context.SAMPLE_ALPHA_TO_COVERAGE);
    context.enable(context.CULL_FACE);
    context.bindVertexArray(null);
  }

  drawAlphaBatch(batch, textured, culled = false) {
    const selection = culled ? this.selectBatchInstances(batch) : null;
    if (selection?.visibleCount === 0) return;
    this.applyAlphaState(batch, textured);
    this.drawBatch(batch, textured, selection);
  }

  // When every batch holds one instance, its flat values (colour, surface, emission, box normal matrix) are uniforms, not varyings.
  setSingleInstanceUniforms(data) {
    const context = this.context;
    context.uniform3f(this.uniforms.baseColor, data[25], data[26], data[27]);
    context.uniform4f(this.uniforms.surface, data[28], data[29], data[30], data[31]);
    context.uniform4f(this.uniforms.instanceEmission, data[38], data[39], data[40], 0);
    context.uniform1f(this.uniforms.instanceOpacity, data[OPACITY_OFFSET]);
    if (this.shaderFeatures.has('boxMapScale')) context.uniformMatrix3fv(this.uniforms.boxNormalMatrix, false, data.subarray(16, 25));
  }

  // A batch whose material has `windScale` feels a share of the frame wind (ground-cover grass); the batch after it gets the frame wind back.
  // Batches without a scale never write the uniform, so a scene without one draws exactly as before.
  bindBatchWind(batch) {
    const scale = batch.parts?.[0]?.material.windScale;
    if (scale === undefined && !this.windScaledBatch) return;
    this.windScaledBatch = scale !== undefined;
    this.context.uniform1f(this.uniforms.wind, this.frameWind * (scale ?? 1));
  }

  drawBatch(batch, textured = false, selection = null, levelSet = batch) {
    if (this.hasMorphs) {
      const uniforms = textured ? this.uniforms : this.depthMorphUniforms;
      this.context.uniform1f(uniforms.morphEnabled, batch.morph ? 1 : 0);
      if (batch.morph) {
        this.context.uniform1i(uniforms.morphVertexCount, batch.morphTexture.info.vertexCount);
        const targetCount = batch.morphWeights.length;
        const selected = targetCount > MORPH_SLOT_COUNT;
        const slotCount = selected ? morphSupport().selectMorphSlots(batch.morphWeights, MORPH_SLOT_TARGETS, MORPH_SLOT_WEIGHTS) : targetCount;
        this.context.uniform1i(uniforms.morphTargetCount, slotCount);
        this.context.uniform1fv(uniforms['morphWeights[0]'], selected ? MORPH_SLOT_WEIGHTS : batch.morphWeights);
        this.context.uniform1fv(uniforms['morphSlotTargets[0]'], selected ? MORPH_SLOT_TARGETS : IDENTITY_MORPH_SLOTS);
        bindTextureUnit(this.context, 8, batch.morphTexture.texture);
      }
    }
    if (this.hasSkins) {
      const uniforms = textured ? this.uniforms : this.depthSkinUniforms;
      this.context.uniform1f(uniforms.crowdEnabled, batch.crowd ? 1 : 0);
      this.context.uniform1f(uniforms.skinEnabled, batch.skin ? 1 : 0);
      if (batch.crowd) {
        bindTextureUnit(this.context, 7, batch.crowdTexture.texture);
        this.context.uniform1i(uniforms.jointPalette, 7);
      } else if (batch.skin) {
        bindTextureUnit(this.context, 6, batch.influenceTexture.texture);
        this.context.uniform1i(uniforms.skinInfluences, 6);
        bindTextureUnit(this.context, 7, batch.skinTexture.texture);
        this.context.uniform1i(uniforms.jointPalette, 7);
      }
    }
    if (textured && !this.benchmark) {
      this.context.uniform1f(this.uniforms.shadowBlind, batch.receivesShadow === false ? 1 : 0);
      this.context.uniform1f(this.uniforms.tintBlind, batch.tintBlind ? 1 : 0);
      this.context.uniform1f(this.uniforms.compositeMode, batch.compositeMode ?? 0);
      for (let index = 0; index < MATERIAL_MAPS.length; index++) {
        bindTextureUnit(this.context, index + 1, batch.textures[index]);
        this.context.uniform1i(this.uniforms[MAP_UNIFORMS[index]], index + 1);
        this.context.uniform1f(this.uniforms[MAP_FLAGS[index]], batch.mapState[index] ? 1 + (batch.mapState[index].uvChannel ?? 0) : 0);
      }
      this.context.uniform2f(this.uniforms.normalScale, batch.mapState[5], batch.mapState[6]);
      this.context.uniform1f(this.uniforms.occlusionStrength, batch.mapState[7]);
      this.context.uniform4f(this.uniforms.materialMoss, batch.mapState[8], batch.mapState[9], batch.mapState[10], batch.mapState[11]);
      this.bindSurfaceWear(batch.wear);
      const layers = batch.layerState;
      this.context.uniform4f(this.uniforms.materialDielectric, layers[0], layers[1], layers[2], layers[DIELECTRIC_GRAZING_STATE_INDEX]);
      this.context.uniform2f(this.uniforms.materialCoat, layers[3], layers[4]);
      this.context.uniform4f(this.uniforms.materialSheen, layers[5], layers[6], layers[7], layers[8]);
      this.context.uniform2f(this.uniforms.materialAnisotropy, layers[16], layers[17]);
      this.context.uniform3f(this.uniforms.materialIridescence, layers[18], layers[19], layers[20]);
      this.context.uniform1i(this.uniforms.lightLinkMask, layers[21]);
      this.context.uniform1f(this.uniforms.materialToon, layers[22]);
      this.context.uniform1f(this.uniforms.materialEmissionFresnel, layers[24]);
      this.context.uniform1f(this.uniforms.materialSoftEdge, layers[28]);
      this.context.uniform1f(this.uniforms.boxMapScale, batch.mapState[12]);
      this.context.uniform1i(this.uniforms.boxMapAxis, batch.mapState[13]);
      if (this.shaderFeatures?.has('splat')) requireSplatSupport().bind(this, batch.splat);
      layerTextureSupport.bind?.(this, batch.mapState, layers, batch);
      this.bindHeightParallax(batch);
      this.bindBatchWind(batch);
      this.context.uniform1f(this.uniforms.hasLightMap, batch.lightMapTexture ? 1 : 0);
      if (batch.lightMapTexture) {
        bindTextureUnit(this.context, LIGHT_MAP_UNIT, batch.lightMapTexture);
        this.context.uniform1i(this.uniforms.lightMap, LIGHT_MAP_UNIT);
        this.context.uniform1f(this.uniforms.lightMapScale, batch.mapState[15]);
      }
    }
    if (textured && !this.benchmark && this.shaderFeatures?.has('instanced') === false)this.setSingleInstanceUniforms(batch.instanceData);
    // A reflecting matrix reverses screen winding: clockwise triangles are the front faces of a mirrored batch.
    if (batch.mirrored) this.backend.setFrontFaceClockwise(true);
    // The shadow pass (not textured) draws the whole index buffer; its order does not matter there.
    const flushRanges = textured && !this.benchmark ? batch.flushOrder?.ranges ?? null : null;
    if (selection && !selection.isEverything) {
      this.drawSelectedLevels(batch, selection, levelSet, levelSet === batch ? flushRanges : null);
    } else {
      this.context.bindVertexArray(batch.vertexArray);
      if (flushRanges) this.drawFlushRanges(batch, flushRanges, batch.instanceCount);
      else this.backend.drawIndexedInstanced(batch.indexCount, batch.instanceCount);
    }
    if (batch.mirrored) this.backend.setFrontFaceClockwise(false);
  }

  // A render pass draws raw material data instead of the lit image; the addon validates frame.pass and returns the shader mode.
  preparePass(frame) {
    if (frame.pass === undefined) return 0;
    if (!this.passSupport) throw new Error('Render passes need installRenderPasses(renderer) from crucible/addons/render-passes.');
    return this.passSupport.prepare(frame);
  }

  /**
   * Sets the world-space planes that cut every part without clipPlanes of its own, until the next call. Each plane is
   * { normal: [x, y, z], constant }, and a point p stays when dot(normal, p) + constant is 0 or more. Pass at most 4, or [] to cut nothing.
   * Call it between renders to animate a cut. The renderer needs `clipPlanes` in its options, or a part with clipPlanes, so its shaders have the code.
   */
  setClipPlanes(planes) {
    if (!this.shaderFeatures?.has(CLIP_PLANES_FEATURE)) throw new Error('This renderer has no clip plane code. Fix: pass clipPlanes: [] in the renderer options (or give a part clipPlanes) so the shaders include it.');
    const packed = new Float32Array(MAX_CLIP_PLANES * 4);
    const count = packClipPlanes(planes, packed, 'clipPlanes');
    this.clipPlaneValues.set(packed);
    this.clipPlaneCount = count;
  }

  /**
   * Sets the fog's density and velocity field (see docs/volumetric.md) until it is replaced or cleared with null. It wins over
   * a field in the constructor's or the frame's volumeFog. The same size is written into the existing texture on the next frame.
   */
  setFogField(field) {
    this.fogFieldOverride = field === null ? null : validateFogField(field);
  }

  render(frame) {
    // The water mirror is part of a frame, not a frame: it neither counts draws nor replaces the stats.
    const draws = frame.reflectionTarget ? null : countDraws(this.context);
    try {
      this.renderFrame(frame);
    } finally {
      draws?.release();
    }
    if (draws) this.publishStats(draws.counters);
  }

  publishStats({ drawCalls, triangles }) {
    this.stats = { drawCalls, trianglesDrawn: triangles, geometryBytes: this.geometryBytes, textureBytes: this.textureBytes, gpuTimeMs: this.gpuMilliseconds };
  }

  canDrawDirectly(frame, effects, environment, volume) {
    return !this.benchmark && !this.hdr && !this.depth && this.multisampleSamples <= 1
      && !this.reversedDepth && this.postStages.length === 0 && !this.look && !this.fogFieldOverride
      && !frame.outputFramebuffer && !(frame.fade > 0) && frame.effects?.autoExposure === undefined
      && !(environment.localVolumes?.length > 0)
      && this.postStepsOf(frame, effects, volume, false, false, false).length === 0
      && !this.batches.some(batch => batchPass(batch) !== 'opaque' || Boolean(batch.mapState?.[20]));
  }

  renderFrame(frame) {
    this.localEmissionMaskReady = false;
    if (frame.pass === undefined && !frame.reflectionTarget && (frame.environment?.localVolumes ?? this.environment?.localVolumes)?.length > 0) {
      this.localEmissionMaskReady = requireFeatureCode('volumeFog').support.drawEmissionMask(this, frame);
    }
    const { eye, target = [0, 1.2, 0], armorColor = [0.53, 0.39, 0.24], armorSurface = [0.88, 0.32], exposure = 1, inspection = false } = frame;
    const effects = resolveEffects(frame.effects);
    const environment = { lightDirection: [-3, 6, 4], fogColor: [0.35, 0.43, 0.43], fogDensity: 0.006, daylight: 1, explosionCenter: [0, 0, 0], ...this.environment, ...frame.environment };
    environment.fogDensity ??= this.fittedFogDensity ?? 0.006;
    if (environment.localVolumes?.some?.(localVolume => localVolume?.lightsScene === true)) {
      // Fire lights the set: the emitting volumes add point lights before the lighting state is written (#1046).
      environment.pointLights = requireFeatureCode('volumeFog').support.withVolumeFireLights(this, environment, environment.volumeTime ?? frame.time ?? 0).pointLights;
    }
    const volume = resolveVolumeFog(environment.volumeFog);
    if (this.fogFieldOverride) volume.field = this.fogFieldOverride;
    if (volume.density > 0) {
      requireFeatureCode('volumeFog');
      if (!this.depth || !this.hdr || this.transparent || this.benchmark) throw new Error('Volume fog requires depth:true, active HDR and an opaque canvas');
      if (!Number.isFinite(frame.time ?? 0) || Math.abs(frame.time ?? 0) > 1e6) throw new RangeError('Volume time must be finite and within ±1000000 seconds');
      const direction = environment.lightDirection;
      const lightLength = direction?.length === 3 ? Math.hypot(...direction) : NaN;
      if (!Number.isFinite(lightLength) || lightLength < 1e-6 || !Array.from(direction).every(component => typeof component === 'number' && Math.abs(component) <= 1e6)) throw new RangeError('Volume light direction must have a finite nonzero length and bounded components');
    }
    updateLightingState(this.lighting, environment, { world: this.world });
    this.syncViewTransform(environment);
    // The shadow view follows the sun, so a moved sun redraws the map.
    const nextLightDirection = environment.lightDirection;
    const lightChanged = !sameVector3(this.activeLightDirection, nextLightDirection);
    if (lightChanged && nextLightDirection) for (let axis = 0; axis < 3; axis++) this.activeLightDirection[axis] = nextLightDirection[axis];
    this.diagnosticsState[0] = frame;
    this.diagnosticsState[1] = effects;
    this.diagnosticsState[2] = this.coplanarDiagnostics ? this.coplanarDiagnostics(this.batches) : null;
    this.diagnosticsPending = true;
    const start = performance.now();
    const context = this.context;
    this.beginGpuTiming();
    const assemblyAmount = Math.max(0, Math.min(1, frame.assemblyAmount ?? 0));
    // Swaying foliage moves every frame, so its shadow map is redrawn whenever time or wind changes.
    const windChanged = this.updateWindState(frame);
    const casterChanged = this.assemblyAmount !== assemblyAmount || this.shadowsDirty || windChanged || lightChanged || (this.shaderFeatures.has(CLIP_PLANES_FEATURE) && clipPlanesChanged(this));
    this.requireFeatureNames(shaderFeaturesOfLighting(this.lighting));
    const passMode = this.preparePass(frame);
    this.renderingPass = passMode > 0;
    this.volumeShadowWanted = volume.density > 0 || (Array.isArray(environment.localVolumes) && environment.localVolumes.some(localVolume => localVolume?.scatter > 0));
    if (casterChanged || this.shadowMapSizeWanted() !== this.shadowMapSize) {
      this.assemblyAmount = assemblyAmount;
      this.createShadowMap();
    }
    this.updateLocalShadows(casterChanged);
    const environmentMap = this.activateEnvironment(environment.map);
    this.requireFeatureNames([environmentMap ? 'environmentMap' : 'studioLighting']);
    mat4.lookAt(this.view, eye, target, frame.up ?? [0, 1, 0]);
    applyProjection(this.projection, this.withFittedNear(frame), this.canvas.width / this.canvas.height, { world: this.world });
    mat4.multiply(this.viewProjection, this.projection, this.view);
    mat4.invert(this.inverseViewProjection, this.viewProjection);
    extractFrustumPlanes(this.viewProjection, this.frustumPlanes);
    this.viewForward = [-this.view[2], -this.view[6], -this.view[10]];
    // The water mirror is a cheap draw: it reuses the cascades of the last lit frame and leaves their redraw to the lit frame that follows.
    if (frame.reflectionTarget && this.shadowCascades?.texture) {
      this.cascadeCastersChanged ||= casterChanged;
    } else {
      this.shadowCascades?.update(this, casterChanged || Boolean(this.cascadeCastersChanged));
      this.cascadeCastersChanged = false;
    }
    // The water reflection addon draws the scene a second time into its own smaller target (frame.reflectionTarget).
    const mirrorTarget = frame.reflectionTarget;
    const directCanvas = !mirrorTarget && !passMode && this.canDrawDirectly(frame, effects, environment, volume);
    context.bindFramebuffer(context.FRAMEBUFFER, mirrorTarget ? mirrorTarget.framebuffer : passMode ? this.passSupport.framebuffer : this.benchmark || directCanvas ? null : this.multisampleFramebuffer);
    context.viewport(0, 0, mirrorTarget?.width ?? this.canvas.width, mirrorTarget?.height ?? this.canvas.height);
    if (passMode) {
      context.clearColor(...this.passSupport.background(frame.pass));
    } else {
      context.clearColor(...clearColourFor(this.background, this.transparent));
    }
    // The environment background covers every pixel, so the colour clear before it would be overwritten.
    const backgroundCoversFrame = !passMode && Boolean(environmentMap?.showBackground) && !this.transparent;
    context.clear(backgroundCoversFrame ? context.DEPTH_BUFFER_BIT : context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT);
    const environmentBackgroundDrawn = !passMode && this.drawEnvironmentBackground(environmentMap, frame, exposure);
    if (this.world && !this.benchmark && !passMode && !environmentBackgroundDrawn) this.drawSky(frame);
    context.enable(context.DEPTH_TEST);
    context.enable(context.CULL_FACE);
    const uniforms = this.uniforms;
    const lighting = this.lighting;
    context.useProgram(this.program);
    context.uniformMatrix4fv(uniforms.viewProjection, false, this.viewProjection);
    this.setFlushProjection(this.viewProjection);
    context.uniformMatrix4fv(uniforms.lightProjection, false, this.lightProjection);
    context.uniform1f(uniforms.shadowBiasPerSlope, this.shadowBiasPerSlope);
    context.uniform3fv(uniforms.eye, eye);
    this.shadowCascades?.bindUniforms(this);
    context.uniform3fv(uniforms.armorColor, armorColor);
    context.uniform2fv(uniforms.armorSurface, armorSurface);
    context.uniform1f(uniforms.exposure, exposure);
    context.uniform1f(uniforms.inspection, inspection ? 1 : 0);
    context.uniform1f(uniforms.hdrEnabled, this.hdr ? 1 : 0);
    context.uniform1i(uniforms.pointLightCount, frame.reflectionTarget ? 0 : lighting.pointCount);
    this.applyLocalLightUniforms(Boolean(frame.reflectionTarget));
    lighting.bind?.(this);
    context.uniform3fv(uniforms.keyColor, lighting.keyColor);
    context.uniform1f(uniforms.fillIntensity, lighting.fillIntensity);
    context.uniform1f(uniforms.ambientIntensity, lighting.ambientIntensity);
    context.uniform3fv(uniforms.ambientColor, lighting.ambientColor);
    context.uniform3fv(uniforms.ambientGroundDelta, lighting.ambientGroundDelta);
    context.uniform1f(uniforms.ambientMix, lighting.ambientMix);
    context.uniform1f(uniforms.specularAntiAliasing, lighting.specularAntiAliasing);
    if (lighting.wetness > 0) this.bindWetness();
    context.uniform1f(uniforms.time, frame.time ?? 0);
    this.frameWind = frame.wind ?? 0.3;
    this.windScaledBatch = false;
    context.uniform1f(uniforms.wind, this.frameWind);
    context.uniform1f(uniforms.worldMode, this.world ? 1 : 0);
    context.uniform1f(uniforms.daylight, environment.daylight);
    context.uniform3fv(uniforms.lightDirection, environment.lightDirection);
    context.uniform3fv(uniforms.fogColor, environment.fogColor);
    context.uniform1f(uniforms.fogDensity, environment.fogDensity);
    context.uniform3fv(uniforms.waterRipple, frame.waterRipple ?? [10000, 0, 10000]);
    context.uniform1f(uniforms.rippleTime, frame.rippleTime ?? -1000);
    context.uniform1f(uniforms.explosionProgress, frame.explosionProgress ?? 1);
    context.uniform3fv(uniforms.explosionCenter, environment.explosionCenter);
    context.uniform1f(uniforms.assemblyAmount, assemblyAmount);
    bindTextureUnit(context, 0, this.shadowTexture);
    context.uniform1i(uniforms.shadowMap, 0);
    this.bindTintedShadows();
    this.applyEnvironmentUniforms(environmentMap);
    context.uniform1f(this.uniforms.renderPassMode, passMode);
    context.uniform1f(this.uniforms.renderPassDepthRange, frame.passDepthRange ?? 100);
    if (passMode > 5) this.passSupport.bindFrame(frame, environment, volume);
    let objectBase = 0;
    const idPass = passMode === OBJECT_ID_PASS_MODE || passMode === CRYPTOMATTE_PASS_MODE;
    for (const batch of this.batches) {
      if (this.benchmark) {
        this.drawBatch(batch, true);
        continue;
      }
      const drawn = idPass ? this.takesObjectIds(batch) : (passMode > 5 ? this.passSupport.drawsInPass(batch, passMode) : this.drawsInOpaqueLoop(batch));
      const firstObject = objectBase;
      // A batch that takes object IDs keeps its numbers even when this pass does not draw it, so IDs agree across passes.
      if (drawn || this.takesObjectIds(batch)) objectBase += batch.instanceCount;
      if (!drawn || (mirrorTarget && batch.mapState[20])) continue;
      context.uniform1f(this.uniforms.renderPassObjectBase, firstObject);
      const drawnBatch = idPass ? this.idPassBatch(batch) : batch;
      // Object IDs are the instance ordinal, which culling and level selection renumber, so that pass draws every instance.
      if (passMode > 5) this.passSupport.drawBatch(drawnBatch, passMode, frame, firstObject);
      else this.drawAlphaBatch(drawnBatch, true, passMode !== OBJECT_ID_PASS_MODE);
    }
    this.applyDepthRank(0);
    context.disable(context.SAMPLE_ALPHA_TO_COVERAGE);
    context.enable(context.CULL_FACE);
    context.bindVertexArray(null);
    if (mirrorTarget) {
      this.renderingPass = false;
      this.endGpuTiming();
      return;
    }
    if (passMode) {
      if (!frame.emissionMaskPass) this.passSupport.copyToCanvas();
    } else if (!this.benchmark) {
      this.drawTranslucent(frame, environment, assemblyAmount, environmentMap);
      this.drawBlendBatches(frame);
      if (!directCanvas) this.resolveFrame(frame, effects, environment, volume);
    }
    this.renderingPass = false;
    this.endGpuTiming();
    this.cpuMilliseconds = performance.now() - start;
  }

  beginGpuTiming() {
    if (this.gpuTimer === undefined) this.gpuTimer = this.createGpuTimer?.(this.context) ?? null;
    this.gpuTimer?.begin();
  }

  endGpuTiming() {
    if (!this.gpuTimer) return;
    this.gpuTimer.end();
    this.gpuMilliseconds = this.gpuTimer.collect();
  }

  // The water mirror draws without local lights: it is blurred and rippled, and the sun, sky and fog colour carry the picture.
  applyLocalLightUniforms(withoutLights = false) {
    const context = this.context;
    const lighting = this.lighting;
    const uniforms = this.uniforms;
    context.uniform1i(uniforms.spotLightCount, withoutLights ? 0 : lighting.spotCount);
    context.uniform1i(uniforms.areaLightCount, withoutLights ? 0 : lighting.areaCount);
    const block = uniformBlockOf(this, LIGHT_DATA_BLOCK);
    for (const [field, source] of LOCAL_LIGHT_BLOCK_FIELDS) block.write(field, lighting[source]);
    const drawsLocalShadows = lighting.shadowCasters.length > 0 && this.localShadowTexture;
    if (drawsLocalShadows) {
      block.write('localShadowMatrices', this.localShadowMatrices);
      block.write('localShadowTexelAngles', this.localShadowTexelAngles);
    }
    block.upload(this.program);
    if (!drawsLocalShadows) return;
    context.activeTexture(context.TEXTURE0 + LOCAL_SHADOW_UNIT);
    context.bindTexture(context.TEXTURE_2D, this.localShadowTexture);
    context.uniform1i(uniforms.localShadowAtlas, LOCAL_SHADOW_UNIT);
    context.activeTexture(context.TEXTURE0);
  }

  // Programs and shaders that deferProgramLink started and finishConstruction has not yet taken over.
  releasePendingConstruction() {
    const context = this.context;
    const started = [...Object.values(this.pendingConstruction?.pending ?? {}), ...(this.pendingEnvironmentPrograms?.values() ?? [])];
    for (const { program, shaders } of started) {
      // Reading the link status waits for a link still in flight; deleting a program mid-link leaves a GL error that the next renderer on this context sees (#74).
      context.getProgramParameter(program, context.LINK_STATUS);
      shaders.forEach((shader) => context.deleteShader(shader));
      context.deleteProgram(program);
    }
    this.pendingConstruction = null;
    this.pendingEnvironmentPrograms = null;
    this.releasePendingMainProgram();
  }

  dispose() {
    const context = this.context;
    this.disposed = true;
    disposeUniformBlocks(this);
    this.releasePendingConstruction();
    releaseStartedPrograms(context);
    this.fogFieldTexture?.dispose();
    this.releaseFrameTargets();
    this.shadowCascades?.dispose(context, this.renderTargets);
    viewTransformShader.dispose?.(this);
    for (const texture of [this.localShadowTexture, this.placeholderShadowTexture, this.tintTexture, this.shadowTexture, ...this.textures.values()]) if (texture) context.deleteTexture(texture);
    for (const framebuffer of [this.localShadowFramebuffer, this.tintFramebuffer, this.shadowFramebuffer]) if (framebuffer) context.deleteFramebuffer(framebuffer);
    this.batches.forEach((batch) => {
      context.deleteVertexArray(batch.vertexArray);
      this.releaseLevelDraws(batch);
    });
    this.buffers.forEach((buffer) => context.deleteBuffer(buffer));
    this.geometryBuffers?.clear();
    // A program still linking must finish first: deleting it mid-link leaves a GL error that the next renderer on this context sees.
    for (const variant of this.postVariants?.values() ?? []) context.deleteProgram(variant.pending ? this.backend.finishProgram(variant.pending) : variant.program);
    for (const program of [this.program, this.liquidProgram, this.depthProgram, this.postProgram, this.skyProgram, this.bloomProgram, this.occlusionProgram, this.environmentBackgroundProgram]) if (program) context.deleteProgram(program);
    this.passSupport?.dispose(context);
    for (const stage of this.postStages ?? []) stage.dispose(context);
    if (this.localVolumeComposite) requireFeatureCode('volumeFog').support.releaseLocalVolumeComposite(this, true);
    this.environmentResources?.dispose();
    if (this.splatPlaceholder) requireSplatSupport().dispose(this);
    this.textures.clear();
    for (const cache of [this.skinTextures, this.influenceTextures, this.morphTextures]) {
      for (const record of cache?.values() ?? []) context.deleteTexture(record.texture);
      cache?.clear();
    }
    for (const collection of [this.geometryBuffers, this.partLocations, this.updatePartIdentities, this.updateSkins, this.updateMorphs, this.updateBatches]) collection?.clear();
  }
}

// Glaze is the public name of the real-time renderer; CrucibleRenderer stays for existing code.
export { CrucibleRenderer as Glaze };
/** Deprecated: the old name of CrucibleRenderer, removed in the release after 0.20.0. */

export { renderPass, materialAlphaState };
