import { layerTextureSupport, liquidWaterSupport, registerShaderFeatureCode } from './shader-registry.js';
import { worldBounds } from './probe-trace.js';
import { requireFiniteInRange } from './modeling-limits.js';
import { WATER_MAXIMUM_ROUGHNESS, WATER_BLUR_LIMIT_ROUGHNESS, WATER_MAXIMUM_BLUR_LEVEL, WATER_FADE_START_ROUGHNESS, waterMirrorUniformsGlsl, waterMirrorFunctionsGlsl } from './water-mirror-glsl.js';

export { WATER_MAXIMUM_ROUGHNESS, WATER_BLUR_LIMIT_ROUGHNESS, WATER_MAXIMUM_BLUR_LEVEL, WATER_FADE_START_ROUGHNESS };

// Water reflection: a large, flat, smooth surface (a lake, a river, a polished floor) shows the scene around it. The scene is
// drawn a second time from the camera's mirror image into a target at reduced size, and the surface samples that picture.
// This module is optional. A scene without such a surface never loads it, and the renderer's only links to it are the material
// field `waterReflection`, which batches parts by it, and `frame.reflectionTarget`, which sends one draw into the target.

/** The mip level the mirror picture is sampled at for a roughness: 0 up to 0.1, rising linearly to `WATER_MAXIMUM_BLUR_LEVEL` at 0.5. */
export function waterMirrorLevel(roughness) {
  const share = (roughness - WATER_MAXIMUM_ROUGHNESS) / (WATER_BLUR_LIMIT_ROUGHNESS - WATER_MAXIMUM_ROUGHNESS);
  return WATER_MAXIMUM_BLUR_LEVEL * Math.min(Math.max(share, 0), 1);
}

/** How much of the mirror picture shows: 1 up to 0.35, falling linearly to 0 at 0.5 where only the environment is left. */
export function waterMirrorWeight(roughness) {
  const share = (roughness - WATER_FADE_START_ROUGHNESS) / (WATER_BLUR_LIMIT_ROUGHNESS - WATER_FADE_START_ROUGHNESS);
  return 1 - Math.min(Math.max(share, 0), 1);
}
/** The surface is flat when its bounds are at most this tall compared with their wider side. */
export const WATER_MAXIMUM_THICKNESS_RATIO = 0.02;
/** The surface is large when its footprint covers at least this share of the scene's footprint. */
export const WATER_MINIMUM_SCENE_SHARE = 0.002;
/** The reflection target is this share of the canvas in each direction. */
export const WATER_REFLECTION_SCALE = 0.75;
/** The wet-ground mirror is as large as the frame: a puddle is a still film, and the reduced target of a lake blurs its edges. */
export const WET_MIRROR_SCALE = 1;
// The mirror draw is blurred and rippled, so it can use coarser levels and drop parts that cover almost nothing.
/** The mirror draw accepts this many times the level error that the lit frame accepts (`lodPixelError`). */
export const WATER_MIRROR_LOD_SCALE = 3;
/** The mirror draw skips a part whose bounding sphere covers a smaller radius than this on screen, in pixels. */
export const WATER_MIRROR_MINIMUM_PIXEL_RADIUS = 5;
// How the picture is treated before it reaches the surface (see afterEmission). Fresnel starts at the reflectance of water.
const FRESNEL_BASE = '0.02';
const REFLECTION_GAIN = '1.0';

/** The share of light a still water surface reflects when seen at a cosine of the angle to the normal (the GLSL of afterEmission, in JS). */
export function waterFresnelReflectance(viewCosine) {
  return Number(FRESNEL_BASE) + (1 - Number(FRESNEL_BASE)) * (1 - Math.min(Math.max(viewCosine, 0), 1)) ** 5;
}

/** What is left for the bed under wet ground: the light the surface does not reflect. */
export function waterBedShare(viewCosine) {
  return 1 - waterFresnelReflectance(viewCosine);
}
// Geometry below this height above the water plane is left out of the reflection, so the lake bed never covers the sky.
const CLIP_MARGIN = 0.05;
const WATER_BATCH_FLAG = 'waterReflection';
const REFLECTION_TEXTURE_UNIT = 7;
const EXCLUDED_TAGS = new Set(['liquid', 'foam', 'unlit', 'fire', 'smoke', 'floor']);

function footprintOf({ minimum, maximum }) {
  return (maximum[0] - minimum[0]) * (maximum[2] - minimum[2]);
}

/** A surface that transmits light is water, not a glass roof or skylight, when its index of refraction is below this (water is 1.33, glass 1.5). */
export const WATER_MAXIMUM_TRANSMISSIVE_IOR = 1.45;

/** Water that transmits light (glTF KHR_materials_transmission with an ior near 1.33) draws in the liquid pass, which samples the same mirror picture. */
function isWaterLikeTransmission(material) {
  return !(material.transmission > 0) || (material.ior ?? 1.5) < WATER_MAXIMUM_TRANSMISSIVE_IOR;
}

function isSmoothSurface(material) {
  return !EXCLUDED_TAGS.has(material.tag) && isWaterLikeTransmission(material) && (material.roughness ?? 1) < WATER_BLUR_LIMIT_ROUGHNESS;
}

// Wet ground mirrors in its puddles whatever its dry roughness: any flat part that is not metal, liquid, foam, unlit, fire, smoke or floor.
function isWetGround(material) {
  return !EXCLUDED_TAGS.has(material.tag) && material.tag !== 'water' && (material.metallic ?? 0) < 0.5;
}

function isFlatSurface({ minimum, maximum }) {
  const wider = Math.max(maximum[0] - minimum[0], maximum[2] - minimum[2]);
  return wider > 0 && maximum[1] - minimum[1] <= wider * WATER_MAXIMUM_THICKNESS_RATIO;
}

/**
 * The reflecting surface of a scene, or null. A part qualifies when its material is smooth (roughness below 0.5, blurred above 0.1, and not
 * liquid, foam, unlit, fire, smoke or floor), its bounds are flat, and its footprint is at least 0.2% of the scene's. The largest
 * qualifying part sets the plane (its top); parts within a few centimetres of that height join it.
 * Returns `{ height, partIndices, footprint, sceneShare }`.
 */
export function findWaterSurface(parts, { wet = false } = {}) {
  const bounds = parts.map(part => worldBounds(part));
  const sceneMinimum = [Infinity, Infinity, Infinity];
  const sceneMaximum = [-Infinity, -Infinity, -Infinity];
  for (const { minimum, maximum } of bounds) {
    for (let axis = 0; axis < 3; axis++) {
      sceneMinimum[axis] = Math.min(sceneMinimum[axis], minimum[axis]);
      sceneMaximum[axis] = Math.max(sceneMaximum[axis], maximum[axis]);
    }
  }
  const sceneFootprint = footprintOf({ minimum: sceneMinimum, maximum: sceneMaximum });
  const candidates = [];
  parts.forEach((part, index) => {
    const share = sceneFootprint > 0 ? footprintOf(bounds[index]) / sceneFootprint : 0;
    const qualifies = wet ? isWetGround(part.material) : isSmoothSurface(part.material);
    if (qualifies && isFlatSurface(bounds[index]) && share >= WATER_MINIMUM_SCENE_SHARE) {
      candidates.push({ index, share, height: bounds[index].maximum[1], footprint: footprintOf(bounds[index]) });
    }
  });
  if (candidates.length === 0) {
    return null;
  }
  const largest = candidates.reduce((best, candidate) => (candidate.footprint > best.footprint ? candidate : best));
  const sameLevel = candidates.filter(candidate => Math.abs(candidate.height - largest.height) <= CLIP_MARGIN);
  return { height: largest.height, partIndices: sameLevel.map(candidate => candidate.index), footprint: largest.footprint, sceneShare: largest.share };
}

// A part keeps reading every other field from the live material, so motion on colour still works.
function withWaterReflectionFlag(liveMaterial) {
  const wrapper = {};
  for (const field of Object.keys(liveMaterial)) {
    Object.defineProperty(wrapper, field, { enumerable: true, get: () => liveMaterial[field] });
  }
  Object.defineProperty(wrapper, WATER_BATCH_FLAG, { enumerable: true, value: true });
  return Object.freeze(wrapper);
}

/**
 * Marks the qualifying parts of a scene for the reflection. Returns `{ parts, surface, report }`; `surface` is null (and the
 * parts are returned as they came) when nothing qualifies. Call `attachWaterReflection(renderer, surface)` after the renderer
 * is built from `parts`.
 */
export function applyWaterReflection(parts) {
  const surface = findWaterSurface(parts);
  if (!surface) {
    return { parts, surface: null, report: { placed: false, reason: 'no large flat smooth surface' } };
  }
  // Terrain parts build their coarse mirror levels now that the scene has water, before the renderer reads the parts.
  for (const part of parts) {
    part.prepareMirrorLevels?.();
  }
  const flagged = new Set(surface.partIndices);
  const marked = parts.map((part, index) => (flagged.has(index) ? Object.freeze({ ...part, material: withWaterReflectionFlag(part.material) }) : part));
  const report = { placed: true, height: surface.height, parts: surface.partIndices.length, footprint: surface.footprint, sceneShare: surface.sceneShare };
  return { parts: Object.freeze(marked), surface, report };
}

/**
 * The parts of a wet scene (environment.wetness above 0 with puddles) that mirror in their puddles: the flat ground at the level of the
 * largest flat part (wet mode of `findWaterSurface`), flagged like water so the renderer builds the mirror. The wetness shader sets the
 * roughness that decides how much of the picture each pixel shows. Returns the parts as they came when no flat part qualifies.
 */
export function flagWetMirrorParts(parts) {
  const surface = findWaterSurface(parts, { wet: true });
  if (!surface) {
    return parts;
  }
  const flagged = new Set(surface.partIndices);
  return parts.map((part, index) => (flagged.has(index) ? Object.freeze({ ...part, material: withWaterReflectionFlag(part.material) }) : part));
}

/** The reflecting surface of parts `flagWetMirrorParts` marked, or null: the input of `attachWaterReflection`. */
export function wetMirrorSurface(parts) {
  const flagged = parts.filter(part => part.material?.[WATER_BATCH_FLAG] === true);
  return flagged.length === 0 ? null : findWaterSurface(flagged, { wet: true });
}

/** The options for the mirror of wet ground: a full-size target, the frame's own level choice and no part dropped for being small. */
export const WET_MIRROR_OPTIONS = Object.freeze({ scale: WET_MIRROR_SCALE, levelOfDetailScale: 1, minimumPixelRadius: 0 });

/** Attaches the mirror for the wet ground of a scene (`wetMirrorSurface` of its parts) with `WET_MIRROR_OPTIONS`; returns the detach function. */
export function attachWetMirror(renderer, parts) {
  return attachWaterReflection(renderer, wetMirrorSurface(parts), WET_MIRROR_OPTIONS);
}

registerShaderFeatureCode('waterReflection', Object.freeze({
  declarations: `${waterMirrorUniformsGlsl}${waterMirrorFunctionsGlsl}`,
  // While the mirror image is drawn, nothing under the water plane is part of it.
  mainSetup: '  if (waterClip.y > 0.5 && worldPosition.y < waterClip.x + ' + CLIP_MARGIN.toFixed(2) + ') discard;\n',
  // Above roughness 0.1 the picture is sampled from a coarser mip level (rougher water, blurrier reflection) and fades to the
  // environment's reflection between 0.35 and 0.5: `waterMirrorLevel` and `waterMirrorWeight` written in GLSL.
  // The picture holds the light as the frame leaves the shader: scaled by exposure, and encoded when the frame is not HDR.
  // Still water is not a mirror: small ripples shake the picture (more with distance), a few taps smear it (more up and down,
  // as ripples stretch a reflection), and Fresnel makes it strong at grazing angles and faint when looking down into the water.
  afterEmission: `  if (waterReflectionEnabled > 0.5) {
    float mirrorWeight = waterMirrorWeight(roughness);
    vec3 mirrored = waterMirrorColor(worldPosition, roughness);
    float fresnelWeight = (${FRESNEL_BASE} + (1.0 - ${FRESNEL_BASE}) * pow(1.0 - max(viewDirection.y, 0.0), 5.0)) * mirrorWeight;
    vec3 skyLight = ENVIRONMENT_ENABLED ? environmentLighting(normal, specularNormal, baseReflectance, viewDirection, reflect(-viewDirection, specularNormal), vec3(0.0), metallic, roughness, occlusion, ambientIntensity, skyReflection) : vec3(0.0);
    radiance = ENVIRONMENT_ENABLED ? max(radiance - skyLight * max(mirrorWeight, waterEdgeCover), vec3(0.0)) * (1.0 - fresnelWeight * waterBedFresnelShare) + mirrored * ${REFLECTION_GAIN} * fresnelWeight : mix(radiance, mirrored * ${REFLECTION_GAIN}, fresnelWeight);
  }
`,
}));

const rendererStates = new WeakMap();

function createReflectionTarget(renderer, width, height) {
  const context = renderer.context;
  const texture = context.createTexture();
  context.bindTexture(context.TEXTURE_2D, texture);
  context.texImage2D(context.TEXTURE_2D, 0, renderer.hdr ? context.RGBA16F : context.RGBA8, width, height, 0, context.RGBA, renderer.hdr ? context.HALF_FLOAT : context.UNSIGNED_BYTE, null);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR_MIPMAP_LINEAR);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
  context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
  const depth = context.createRenderbuffer();
  context.bindRenderbuffer(context.RENDERBUFFER, depth);
  context.renderbufferStorage(context.RENDERBUFFER, context.DEPTH_COMPONENT24, width, height);
  const framebuffer = context.createFramebuffer();
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
  context.framebufferRenderbuffer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.RENDERBUFFER, depth);
  const complete = context.checkFramebufferStatus(context.FRAMEBUFFER) === context.FRAMEBUFFER_COMPLETE;
  context.bindFramebuffer(context.FRAMEBUFFER, null);
  return { framebuffer, texture, depth, width, height, complete };
}

function releaseReflectionTarget(renderer, target) {
  if (!target) {
    return;
  }
  const context = renderer.context;
  context.deleteFramebuffer(target.framebuffer);
  context.deleteTexture(target.texture);
  context.deleteRenderbuffer(target.depth);
}

// The camera as the water sees it: below the plane, looking at the mirrored target, with up turned over.
function mirroredFrame(frame, height, target) {
  const [eyeX, eyeY, eyeZ] = frame.eye;
  const [targetX, targetY, targetZ] = frame.target ?? [0, 1.2, 0];
  const [upX, upY, upZ] = frame.up ?? [0, 1, 0];
  return { ...frame, eye: [eyeX, 2 * height - eyeY, eyeZ], target: [targetX, 2 * height - targetY, targetZ], up: [upX, -upY, upZ], reflectionTarget: target };
}

const SNAPSHOT_DEPTH = 4;
// A typed array longer than this is a texture or map payload (a sky's pixels run to millions of values). Copying and comparing it
// every frame cost about 170 ms a frame in the container port, so a frame snapshot keeps it by reference and a frame matches it by identity.
const LARGE_ARRAY_LENGTH = 65536;

function isTypedArray(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function sameTypedArray(first, second) {
  if (first.constructor !== second.constructor || first.length !== second.length || first.length > LARGE_ARRAY_LENGTH) {
    return false;
  }
  for (let index = 0; index < first.length; index++) {
    if (first[index] !== second[index]) {
      return false;
    }
  }
  return true;
}

// A copy of the frame's values (arrays, typed arrays and plain objects are copied, anything else is kept by reference), so a later
// frame can be compared with what this one held even when the caller changes the same arrays in place.
function snapshotOf(value, depth = 0) {
  if (depth >= SNAPSHOT_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return isTypedArray(value) && value.length > LARGE_ARRAY_LENGTH ? value : value.slice();
  }
  if (Array.isArray(value)) {
    return value.map(item => snapshotOf(item, depth + 1));
  }
  if (Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotOf(item, depth + 1)]));
  }
  return value;
}

function sameValue(first, second, depth = 0) {
  if (first === second) {
    return true;
  }
  if (depth >= SNAPSHOT_DEPTH || first === null || second === null || typeof first !== 'object' || typeof second !== 'object') {
    return false;
  }
  if (isTypedArray(first) && isTypedArray(second)) {
    return sameTypedArray(first, second);
  }
  const firstKeys = Object.keys(first);
  if (Object.getPrototypeOf(first) !== Object.getPrototypeOf(second) || firstKeys.length !== Object.keys(second).length) {
    return false;
  }
  return firstKeys.every(key => sameValue(first[key], second[key], depth + 1));
}

/**
 * Whether the picture from the last mirror draw still serves this frame: the frame holds the same values as the one it was drawn for
 * and no part was updated since, or `updateEvery` asks for the last picture to stay for that many lit frames.
 */
export function canReuseMirrorImage(state, frame) {
  if (!state.ready || !state.drawnFrame) {
    return false;
  }
  if (state.partsRevision === state.drawnRevision && sameValue(state.drawnFrame, frame)) {
    return true;
  }
  return state.framesSinceDraw < state.updateEvery - 1;
}

function drawMirrorImage(renderer, state, frame, renderFrame) {
  const width = Math.max(1, Math.ceil(renderer.canvas.width * state.scale));
  const height = Math.max(1, Math.ceil(renderer.canvas.height * state.scale));
  if (!state.target || state.target.width !== width || state.target.height !== height) {
    releaseReflectionTarget(renderer, state.target);
    state.target = createReflectionTarget(renderer, width, height);
    state.ready = false;
  }
  const lookingDown = frame.eye[1] > state.height;
  if (!lookingDown || !state.target.complete) {
    state.ready = false;
    return;
  }
  if (canReuseMirrorImage(state, frame)) {
    state.framesSinceDraw++;
    return;
  }
  state.ready = false;
  // The last frame left the picture bound for sampling, and a target cannot be drawn into while it is bound.
  renderer.context.activeTexture(renderer.context.TEXTURE0 + REFLECTION_TEXTURE_UNIT);
  renderer.context.bindTexture(renderer.context.TEXTURE_2D, null);
  renderer.context.activeTexture(renderer.context.TEXTURE0);
  state.drawing = true;
  // Parts wholly under the plane are discarded by the shader anyway, so the renderer leaves them out of the draw.
  renderer.mirrorCulling = { belowHeight: state.height + CLIP_MARGIN, lodScale: state.levelOfDetailScale, minimumPixelRadius: state.minimumPixelRadius };
  try {
    renderFrame(mirroredFrame(frame, state.height, state.target));
  } finally {
    renderer.mirrorCulling = null;
    state.drawing = false;
  }
  // Rougher water samples the coarser levels, so they are built from the finished picture.
  renderer.context.bindTexture(renderer.context.TEXTURE_2D, state.target.texture);
  renderer.context.generateMipmap(renderer.context.TEXTURE_2D);
  state.matrix.set(renderer.viewProjection);
  state.drawnFrame = snapshotOf(frame);
  state.drawnRevision = state.partsRevision;
  state.framesSinceDraw = 0;
  state.ready = true;
}

function locationsOf(renderer, state) {
  if (state.program !== renderer.program) {
    const context = renderer.context;
    const locate = name => context.getUniformLocation(renderer.program, name);
    state.program = renderer.program;
    state.locations = { sampler: locate('waterReflection'), matrix: locate('waterReflectionMatrix'), clip: locate('waterClip'), enabled: locate('waterReflectionEnabled') };
  }
  return state.locations;
}

function bindWater(renderer, mapState) {
  const state = rendererStates.get(renderer);
  if (!state || !renderer.shaderFeatures?.has('waterReflection')) {
    return;
  }
  const context = renderer.context;
  const locations = locationsOf(renderer, state);
  const sampled = Boolean(mapState[20]) && state.ready && !state.drawing;
  context.uniform2f(locations.clip, state.height, state.drawing ? 1 : 0);
  context.uniform1f(locations.enabled, sampled ? 1 : 0);
  if (sampled) {
    context.activeTexture(context.TEXTURE0 + REFLECTION_TEXTURE_UNIT);
    context.bindTexture(context.TEXTURE_2D, state.target.texture);
    context.uniform1i(locations.sampler, REFLECTION_TEXTURE_UNIT);
    context.uniformMatrix4fv(locations.matrix, false, state.matrix);
  }
}

// The liquid pass draws transmissive water with its own program; each batch tells it whether the mirror picture is ready for that batch.
const LIQUID_MIRROR_TEXTURE_UNIT = REFLECTION_TEXTURE_UNIT;
liquidWaterSupport.bind = (renderer, uniforms, batch) => {
  const state = rendererStates.get(renderer);
  if (!state || !uniforms.waterReflectionEnabled) {
    return;
  }
  const context = renderer.context;
  const sampled = Boolean(batch.parts[0]?.material.waterReflection) && state.ready && !state.drawing;
  context.uniform2f(uniforms.waterClip, state.height, state.drawing ? 1 : 0);
  context.uniform1f(uniforms.waterReflectionEnabled, sampled ? 1 : 0);
  if (sampled) {
    context.activeTexture(context.TEXTURE0 + LIQUID_MIRROR_TEXTURE_UNIT);
    context.bindTexture(context.TEXTURE_2D, state.target.texture);
    context.uniform1i(uniforms.waterReflection, LIQUID_MIRROR_TEXTURE_UNIT);
    context.uniformMatrix4fv(uniforms.waterReflectionMatrix, false, state.matrix);
    context.activeTexture(context.TEXTURE0);
  }
};

const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  bindWater(renderer, mapState);
};

/**
 * Draws the mirror image before each frame of a renderer built from the parts `applyWaterReflection` marked. Wraps
 * `renderer.render` and `renderer.dispose`; the returned function undoes both. Does nothing when `surface` is null.
 * `scale` is the target's size against the canvas in each direction (default 0.75). The picture is kept while the frame holds the same
 * values as the one it was drawn for and no part was updated (`renderer.updateParts`); `updateEvery: 2` also keeps it for one lit frame
 * after each draw (the reflection then trails the camera by a frame), which suits a film.
 */
/**
 * Hides the geometries flagged `mirrorOnly` (the coarse terrain meshes of `createTerrain({ mirrorLevels })`) from every draw but
 * the mirror: the batch keeps its true level errors in `mirrorErrors` and shows an infinite error for those levels, which no
 * frame or shadow selection can pass. Done once for each batch, also across attaching and detaching.
 */
const hiddenBatches = new WeakSet();
function hideMirrorOnlyLevels(batch) {
  if (hiddenBatches.has(batch)) {
    return;
  }
  hiddenBatches.add(batch);
  if (batch.levelGeometries?.some(geometry => geometry.mirrorOnly)) {
    batch.mirrorErrors = batch.levelErrors;
    batch.levelErrors = batch.levelErrors.map((error, level) => (batch.levelGeometries[level].mirrorOnly ? Infinity : error));
  }
}

export function attachWaterReflection(renderer, surface, { scale = WATER_REFLECTION_SCALE, updateEvery = 1, levelOfDetailScale = WATER_MIRROR_LOD_SCALE, minimumPixelRadius = WATER_MIRROR_MINIMUM_PIXEL_RADIUS } = {}) {
  requireFiniteInRange('attachWaterReflection', 'scale', scale, 0.05, 1);
  requireFiniteInRange('attachWaterReflection', 'levelOfDetailScale', levelOfDetailScale, 1, 16);
  requireFiniteInRange('attachWaterReflection', 'minimumPixelRadius', minimumPixelRadius, 0, 100);
  requireFiniteInRange('attachWaterReflection', 'updateEvery', updateEvery, 0, 1000);
  if (!surface) {
    return () => {};
  }
  const state = { height: surface.height, scale, levelOfDetailScale, minimumPixelRadius, updateEvery: Math.max(1, Math.floor(updateEvery)), partsRevision: 0, drawnRevision: -1, drawnFrame: null, framesSinceDraw: 0, target: null, ready: false, drawing: false, matrix: new Float32Array(16), program: null, locations: null };
  rendererStates.set(renderer, state);
  renderer.batches?.forEach(hideMirrorOnlyLevels);
  const render = renderer.render;
  const dispose = renderer.dispose;
  const updateParts = renderer.updateParts;
  const renderFrame = frame => render.call(renderer, frame);
  const selectBatchInstances = renderer.selectBatchInstances;
  // The mirror draw selects among all the levels of a batch; every other draw never sees the mirror-only ones.
  renderer.selectBatchInstances = batch => {
    hideMirrorOnlyLevels(batch);
    if (!state.drawing || !batch.mirrorErrors) {
      return selectBatchInstances.call(renderer, batch);
    }
    const hidden = batch.levelErrors;
    batch.levelErrors = batch.mirrorErrors;
    try {
      return selectBatchInstances.call(renderer, batch);
    } finally {
      batch.levelErrors = hidden;
    }
  };
  renderer.render = frame => {
    // The shadow passes of a lit frame run before its first draw, so every batch is checked first.
    renderer.batches?.forEach(hideMirrorOnlyLevels);
    // A render pass (albedo, depth, object ID...) never shows the reflection, so it skips the mirror draw.
    if (!frame.reflectionTarget && frame.pass === undefined) {
      drawMirrorImage(renderer, state, frame, renderFrame);
    }
    return render.call(renderer, frame);
  };
  if (updateParts) {
    renderer.updateParts = (...updateArguments) => {
      state.partsRevision++;
      return updateParts.apply(renderer, updateArguments);
    };
  }
  renderer.dispose = () => {
    releaseReflectionTarget(renderer, state.target);
    rendererStates.delete(renderer);
    return dispose.call(renderer);
  };
  return () => {
    renderer.render = render;
    renderer.selectBatchInstances = selectBatchInstances;
    renderer.dispose = dispose;
    if (updateParts) {
      renderer.updateParts = updateParts;
    }
    releaseReflectionTarget(renderer, state.target);
    rendererStates.delete(renderer);
  };
}
