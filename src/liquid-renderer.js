import { backendFor } from './glaze-backend.js';
import { CLIP_PLANES_FEATURE, addClipPlanesToLiquidShader, bindClipPlanes, clipPlaneLocations } from './clip-planes.js';
import { resolveLiquidOptics } from './liquid-optics.js';
import { batchesNeedRefractionMips, mipLevelCount } from './transmission-blur.js';
import { depthMapping } from './glass-depth-march.js';
import { drawsBackFaces, glassShellsNested, planGlassRefractionLayers } from './glass-back-face.js';
import { geometryBoundingSphere } from './render-culling.js';
import { liquidProbeSupport, liquidWaterSupport, registeredFeatureCode, requireDeformationSupport } from './shader-registry.js';

// The renderer's liquid and foam pass, kept apart from renderer.js so a scene without liquid or foam does not carry it.
// liquid-shader.js registers drawLiquidPass; the renderer calls it with the frame state it needs.

// The renderer binds the metallic-roughness map to unit 3 in its main pass too (MAP_UNIFORMS order, offset 1).
const METALLIC_ROUGHNESS_UNIT = 3;
const METALLIC_ROUGHNESS_MAP_INDEX = 2;
// Glass reads the opaque pass's depth from this unit.
const SCENE_DEPTH_UNIT = 4;
// Closed glass reads the depth and outward normal of its own back faces from these units.
const BACK_DEPTH_UNIT = 5;
const BACK_NORMAL_UNIT = 12;
// The second layer (the farthest back face per pixel) is only bound while one shell is inside another; see glassShellsNested.
const BACK_FAR_DEPTH_UNIT = 14;
const BACK_FAR_NORMAL_UNIT = 11;

const LIQUID_UNIFORMS = [
  'viewProjection', 'lightProjection', 'eye', 'sceneColor', 'sceneDepth', 'glassBackDepth', 'glassBackNormal', 'glassBackFarDepth', 'glassBackFarNormal', 'glassBackFarEnabled', 'glassBackEnabled', 'glassBackPass', 'glassBackFirst', 'depthMapping', 'resolution', 'exposure', 'hdrEnabled', 'worldMode', 'daylight', 'lightDirection',
  'keyColor', 'ambientIntensity', 'fogColor', 'fogDensity', 'glassState', 'glassTint', 'glassCoverage', 'glassMediumContinues', 'materialEmissionFresnel', 'liquidOptics', 'foamShape', 'metallicRoughnessMap', 'hasMetallicRoughnessMap',
  'environmentSpecular', 'environmentEnabled', 'environmentIntensity', 'environmentRotation', 'environmentLevelMax',
  'time', 'probeEnabled', 'probeFloor', 'waterReflection', 'waterReflectionMatrix', 'waterClip', 'waterReflectionEnabled', 'wind', 'explosionProgress', 'explosionCenter', 'assemblyAmount',
  'skinEnabled', 'skinInfluences', 'jointPalette',
  'morphEnabled', 'morphVertexCount', 'morphTargetCount', 'morphWeights[0]', 'morphSlotTargets[0]', 'morphTargets',
];

const MORPH_STUB = 'vec3 morphedPosition(vec3 base) { return base; }\nvec3 morphedNormal(vec3 base) { return base; }';
const MORPH_SLOT_COUNT = 64;
const IDENTITY_MORPH_SLOTS = Float32Array.from({ length: MORPH_SLOT_COUNT }, (_, index) => index);
const MORPH_SLOT_TARGETS = new Float32Array(MORPH_SLOT_COUNT);
const MORPH_SLOT_WEIGHTS = new Float32Array(MORPH_SLOT_COUNT);

function bindLiquidMorph(renderer, batch, uniforms, backend = backendFor(renderer)) {
  if (!renderer.hasMorphs || !uniforms?.morphEnabled) return;
  backend.uniform1f(uniforms.morphEnabled, batch.morph ? 1 : 0);
  if (!batch.morph) return;
  backend.uniform1i(uniforms.morphVertexCount, batch.morphTexture.info.vertexCount);
  const targetCount = batch.morphWeights.length;
  const selected = targetCount > MORPH_SLOT_COUNT;
  const slotCount = selected ? requireDeformationSupport('selectMorphSlots', 'morph.js').selectMorphSlots(batch.morphWeights, MORPH_SLOT_TARGETS, MORPH_SLOT_WEIGHTS) : targetCount;
  backend.uniform1i(uniforms.morphTargetCount, slotCount);
  backend.uniform1fv(uniforms['morphWeights[0]'], selected ? MORPH_SLOT_WEIGHTS : batch.morphWeights);
  backend.uniform1fv(uniforms['morphSlotTargets[0]'], selected ? MORPH_SLOT_TARGETS : IDENTITY_MORPH_SLOTS);
  backend.bindTextureUnit(8, batch.morphTexture.texture);
}

function vertexSourceForLiquid(renderer, vertexSource) {
  if (!renderer.hasMorphs) return vertexSource;
  const morphVertex = registeredFeatureCode.get('morph')?.vertex;
  if (!morphVertex) throw new Error('Liquid morphing requires morph.js to be loaded.');
  if (!vertexSource.includes('#define USES_MORPH false') || !vertexSource.includes(MORPH_STUB)) {
    throw new Error('Liquid morph shader splice requires #define USES_MORPH false and the morph stub.');
  }
  return vertexSource.replace('#define USES_MORPH false', '#define USES_MORPH (morphEnabled > 0.5)').replace(MORPH_STUB, morphVertex);
}

// The program compiles when the first liquid or foam batch draws, so a renderer without them never builds it.
function ensureLiquidProgram(renderer, environmentSpecularUnit, vertexSource, fragmentSource, backend = backendFor(renderer)) {
  if (renderer.liquidProgram) return;
  const clipped = renderer.shaderFeatures?.has(CLIP_PLANES_FEATURE) && !renderer.benchmark;
  renderer.liquidProgram = backend.compileProgram(vertexSourceForLiquid(renderer, vertexSource), renderer.withViewTransform(clipped ? addClipPlanesToLiquidShader(fragmentSource) : fragmentSource, 'liquid'));
  renderer.liquidClipLocations = clipped ? clipPlaneLocations(renderer.context ?? backend.context, renderer.liquidProgram) : null;
  renderer.liquidUniforms = Object.fromEntries(LIQUID_UNIFORMS.map(name => [name, backend.uniformLocation(renderer.liquidProgram, name)]));
  backend.useProgram(renderer.liquidProgram);
  backend.uniform1i(renderer.liquidUniforms.metallicRoughnessMap, METALLIC_ROUGHNESS_UNIT);
  backend.uniform1i(renderer.liquidUniforms.sceneDepth, SCENE_DEPTH_UNIT);
  backend.uniform1i(renderer.liquidUniforms.glassBackDepth, BACK_DEPTH_UNIT);
  backend.uniform1i(renderer.liquidUniforms.glassBackNormal, BACK_NORMAL_UNIT);
  backend.uniform1i(renderer.liquidUniforms.glassBackFarDepth, BACK_FAR_DEPTH_UNIT);
  backend.uniform1i(renderer.liquidUniforms.glassBackFarNormal, BACK_FAR_NORMAL_UNIT);
  backend.uniform1i(renderer.liquidUniforms.skinInfluences, 6);
  backend.uniform1i(renderer.liquidUniforms.jointPalette, 7);
  backend.uniform1i(renderer.liquidUniforms.morphTargets, 8);
  backend.uniform1i(renderer.liquidUniforms.environmentSpecular, environmentSpecularUnit);
}

/**
 * Copies the resolved opaque scene into a texture with a full mip chain and returns it. Rough glass samples its blurrier levels.
 * The chain lives apart from frameTexture, which post and bloom read with a plain filter, and it is only built (once per frame, on
 * the frames that draw rough glass) here; a frame with no glass, or only smooth glass, never allocates or fills it.
 */
export function copySceneIntoMipChain(renderer, width, height) {
  const backend = backendFor(renderer);
  backend.activeTextureUnit(0);
  const hdr = Boolean(renderer.hdr);
  let chain = renderer.refractionChain;
  if (!chain || chain.width !== width || chain.height !== height || chain.hdr !== hdr) {
    chain?.release();
    const target = backend.createFramebufferTarget({
      width,
      height,
      colorFormat: hdr ? 'rgba16f' : 'rgba8',
      storage: true,
      levels: mipLevelCount(width, height),
      linear: true,
      clamp: true,
    });
    const texture = target.colorTexture;
    const framebuffer = target.framebuffer;
    const release = () => {
      backend.deleteTexture(texture);
      backend.deleteFramebuffer(framebuffer);
      renderer.refractionChain = null;
    };
    chain = { texture, framebuffer, width, height, hdr, release };
    renderer.refractionChain = chain;
  }
  // A blit, not copyTexSubImage2D: the opaque frame may be stored without alpha, and a copy needs the two formats to match.
  backend.blitTarget(renderer.resolveFramebuffer, chain.framebuffer, width, height, 'color');
  backend.bindTextureUnit(0, chain.texture);
  backend.generateMipmap(false);
  return chain.texture;
}

/**
 * Resolves the opaque pass's depth into a single-sample texture that glass marches against, and returns it. The target is built on the
 * first frame that draws glass (4 bytes a pixel, 32-bit float with reversed depth) and freed with the frame targets; a frame with no
 * glass never allocates or fills it. The depth stays in the buffer's own convention, which depthMapping describes to the shader.
 */
export function resolveSceneDepth(renderer, width, height) {
  const backend = backendFor(renderer);
  backend.activeTextureUnit(0);
  const reversed = Boolean(renderer.reversedDepth);
  let target = renderer.refractionDepth;
  if (!target || target.width !== width || target.height !== height || target.reversed !== reversed) {
    target?.release();
    const created = backend.createFramebufferTarget({
      width,
      height,
      color: false,
      depth: true,
      floatDepth: reversed,
      depthAsTexture: true,
      clamp: true,
    });
    const texture = created.depthTexture;
    const framebuffer = created.framebuffer;
    renderer.renderTargets?.record('refractionDepth', { width, height, format: reversed ? 'DEPTH_COMPONENT32F' : 'DEPTH_COMPONENT24' });
    const release = () => {
      backend.deleteTexture(texture);
      backend.deleteFramebuffer(framebuffer);
      renderer.renderTargets?.release('refractionDepth');
      renderer.refractionDepth = null;
      // The back-face target is only built on top of this one, so it goes with it.
      renderer.glassBackFaces?.release();
      renderer.glassBackFarFaces?.release();
    };
    target = { texture, framebuffer, width, height, reversed, release };
    renderer.refractionDepth = target;
  }
  backend.blitTarget(renderer.multisampleFramebuffer, target.framebuffer, width, height, 'depth');
  return target.texture;
}

/**
 * The target the back faces of closed glass are drawn into: the outward normal (RGBA8 encoded as n * 0.5 + 0.5, alpha 0 where nothing was drawn; RGBA16F is not renderable without HDR) and the depth in the
 * buffer's convention. Built on the first frame that draws closed glass (8 bytes a pixel) and freed with the frame targets; a frame with no
 * closed glass never allocates it.
 */
function ensureGlassBackTarget(renderer, width, height, far = false, backend = backendFor(renderer)) {
  const reversed = Boolean(renderer.reversedDepth);
  const property = far ? 'glassBackFarFaces' : 'glassBackFaces';
  const ledgerName = far ? 'glassBackFarFaces' : 'glassBackFaces';
  let target = renderer[property];
  if (target && target.width === width && target.height === height && target.reversed === reversed) return target;
  target?.release();
  // Built on a spare unit, so the scene texture bound to unit 0 stays bound.
  backend.activeTextureUnit(far ? BACK_FAR_DEPTH_UNIT : BACK_DEPTH_UNIT);
  const created = backend.createFramebufferTarget({
    width,
    height,
    colorFormat: 'rgba8',
    depth: true,
    floatDepth: reversed,
    depthAsTexture: true,
    storage: true,
    linear: false,
    clamp: true,
  });
  const normalTexture = created.colorTexture;
  const depthTexture = created.depthTexture;
  const framebuffer = created.framebuffer;
  renderer.renderTargets?.record(ledgerName, { width, height, format: 'RGBA8' });
  renderer.renderTargets?.record(`${ledgerName}Depth`, { width, height, format: reversed ? 'DEPTH_COMPONENT32F' : 'DEPTH_COMPONENT24' });
  const release = () => {
    backend.deleteTexture(normalTexture);
    backend.deleteTexture(depthTexture);
    backend.deleteFramebuffer(framebuffer);
    renderer.renderTargets?.release(ledgerName);
    renderer.renderTargets?.release(`${ledgerName}Depth`);
    renderer[property] = null;
  };
  target = { normalTexture, depthTexture, framebuffer, width, height, reversed, release };
  renderer[property] = target;
  backend.activeTextureUnit(0);
  return target;
}

function batchDrawsBackFaces(batch) {
  const layers = batch.layerState;
  return drawsBackFaces({ transmission: layers[9], thickness: layers[11] * partScale(batch.parts[0].matrix), mediumContinues: batch.parts[0].material.mediumContinues });
}

/** Numbers the closed glass instances of the frame batch by batch: each batch gets the number of its first instance (see backIdentifier). */
function firstInstanceOfEachBatch(closedBatches) {
  const firstInstances = new Map();
  let next = 0;
  for (const batch of closedBatches) {
    firstInstances.set(batch, next);
    next += batch.instanceCount;
  }
  return firstInstances;
}

function invertMatrix4(matrix) {
  const a00 = matrix[0], a01 = matrix[1], a02 = matrix[2], a03 = matrix[3];
  const a10 = matrix[4], a11 = matrix[5], a12 = matrix[6], a13 = matrix[7];
  const a20 = matrix[8], a21 = matrix[9], a22 = matrix[10], a23 = matrix[11];
  const a30 = matrix[12], a31 = matrix[13], a32 = matrix[14], a33 = matrix[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const inv = 1 / det;
  return new Float32Array([
    (a11 * b11 - a12 * b10 + a13 * b09) * inv, (a02 * b10 - a01 * b11 - a03 * b09) * inv, (a31 * b05 - a32 * b04 + a33 * b03) * inv, (a22 * b04 - a21 * b05 - a23 * b03) * inv,
    (a12 * b08 - a10 * b11 - a13 * b07) * inv, (a00 * b11 - a02 * b08 + a03 * b07) * inv, (a32 * b02 - a30 * b05 - a33 * b01) * inv, (a20 * b05 - a22 * b02 + a23 * b01) * inv,
    (a10 * b10 - a11 * b08 + a13 * b06) * inv, (a01 * b08 - a00 * b10 - a03 * b06) * inv, (a30 * b04 - a31 * b02 + a33 * b00) * inv, (a21 * b02 - a20 * b04 - a23 * b00) * inv,
    (a11 * b07 - a10 * b09 - a12 * b06) * inv, (a00 * b09 - a01 * b07 + a02 * b06) * inv, (a31 * b01 - a30 * b03 - a32 * b00) * inv, (a20 * b03 - a21 * b01 + a22 * b00) * inv,
  ]);
}

/** The world bounds of every closed glass instance of the frame: the local box of its geometry carried through the part's matrix, plus oriented bounds. */
export function closedGlassShells(closedBatches) {
  const shells = [];
  for (const batch of closedBatches) {
    batch.parts.forEach((part, instanceIndex) => {
      const { minimum, maximum } = geometryBoundingSphere(part.geometry);
      const matrix = part.matrix;
      const low = [Infinity, Infinity, Infinity];
      const high = [-Infinity, -Infinity, -Infinity];
      for (let corner = 0; corner < 8; corner++) {
        const local = [corner & 1 ? maximum[0] : minimum[0], corner & 2 ? maximum[1] : minimum[1], corner & 4 ? maximum[2] : minimum[2]];
        for (let axis = 0; axis < 3; axis++) {
          const world = matrix[axis] * local[0] + matrix[4 + axis] * local[1] + matrix[8 + axis] * local[2] + matrix[12 + axis];
          low[axis] = Math.min(low[axis], world);
          high[axis] = Math.max(high[axis], world);
        }
      }
      shells.push({ minimum: low, maximum: high, localMinimum: minimum, localMaximum: maximum, matrix, inverseMatrix: invertMatrix4(matrix), batch, instanceIndex });
    });
  }
  return shells;
}

function sameBatchList(first, second) {
  return first.length === second.length && first.every((batch, index) => batch === second[index]);
}

function resolveClosedGlassMetadata(renderer, liquids) {
  const moveCount = renderer.partsMoveCount ?? 0;
  const cache = renderer.glassBackCache;
  if (cache && cache.batches === renderer.batches && cache.moveCount === moveCount && sameBatchList(cache.liquids, liquids)) {
    return cache;
  }
  const closedBatches = liquids.filter(batchDrawsBackFaces);
  const firstInstances = closedBatches.length > 0 ? firstInstanceOfEachBatch(closedBatches) : null;
  const shells = closedBatches.length > 0 ? closedGlassShells(closedBatches) : [];
  const farLayer = shells.length > 0 ? glassShellsNested(shells) : false;
  renderer.glassBackShellWalkCount = (renderer.glassBackShellWalkCount ?? 0) + 1;
  const entry = { batches: renderer.batches, moveCount, liquids: [...liquids], closedBatches, firstInstances, farLayer, shells };
  renderer.glassBackCache = entry;
  return entry;
}

function unbindBackFaceTextures(backend) {
  for (const unit of [BACK_DEPTH_UNIT, BACK_NORMAL_UNIT, BACK_FAR_DEPTH_UNIT, BACK_FAR_NORMAL_UNIT]) {
    backend.bindTextureUnit(unit, null);
  }
  backend.activeTextureUnit(0);
}

function drawBatchInstance(backend, batch, instanceIndex) {
  backend.bindVertexArray(batch.vertexArray);
  if (batch.instanceCount <= 1 || instanceIndex == null || !batch.instanceBuffer || !batch.instanceData) {
    backend.drawIndexedInstanced(batch.indexCount, batch.instanceCount);
    return;
  }
  const stride = batch.instanceData.length / batch.instanceCount;
  const start = instanceIndex * stride;
  if (instanceIndex > 0) backend.updateBuffer(batch.instanceBuffer, batch.instanceData.subarray(start, start + stride));
  else backend.bindArrayBuffer(batch.instanceBuffer);
  try {
    backend.drawIndexedInstanced(batch.indexCount, 1);
  } finally {
    if (instanceIndex > 0) backend.updateBuffer(batch.instanceBuffer, batch.instanceData.subarray(0, stride));
    backend.bindArrayBuffer(null);
  }
}

/** Draws one layer of back faces into its target: the nearest per pixel, or with `far` the farthest. */
function drawBackLayer(renderer, target, items, firstInstances, width, height, far, backend) {
  const uniforms = renderer.liquidUniforms;
  const reversed = Boolean(renderer.reversedDepth);
  const nearestFunction = reversed ? 'greater' : 'less';
  const farthestFunction = reversed ? 'less' : 'greater';
  const farthestClear = reversed ? 1 : 0;
  backend.bindFramebuffer(target.framebuffer);
  backend.setViewport(width, height);
  backend.clearColorAndDepth([0, 0, 0, 0], far ? farthestClear : reversed ? 0 : 1);
  if (far) backend.setRenderState({ depthFunc: farthestFunction });
  backend.setRenderState({ cullMode: 'front' });
  backend.uniform1f(uniforms.glassBackPass, 1);
  for (const item of items) {
    const batch = item.batch ?? item;
    const instanceIndex = item.batch ? item.instanceIndex : null;
    bindLiquidMorph(renderer, batch, uniforms, backend);
    backend.uniform1f(uniforms.glassBackFirst, firstInstances.get(batch));
    if (renderer.liquidClipLocations) bindClipPlanes(renderer, batch, renderer.liquidClipLocations);
    if (batch.mirrored) backend.setFrontFaceClockwise(true);
    drawBatchInstance(backend, batch, instanceIndex);
    if (batch.mirrored) backend.setFrontFaceClockwise(false);
  }
  if (uniforms.morphEnabled) backend.uniform1f(uniforms.morphEnabled, 0);
  backend.uniform1f(uniforms.glassBackPass, 0);
  backend.setRenderState({ cullMode: 'back' });
  if (far) backend.setRenderState({ depthFunc: nearestFunction });
}

function bindBackFaceTarget(backend, renderer, target, farTarget = null) {
  // With no second layer the far units hold the first one, which the shader never reads there; they only keep the samplers valid.
  const farSource = farTarget ?? target;
  const bindings = [[BACK_DEPTH_UNIT, target.depthTexture], [BACK_NORMAL_UNIT, target.normalTexture], [BACK_FAR_DEPTH_UNIT, farSource.depthTexture], [BACK_FAR_NORMAL_UNIT, farSource.normalTexture]];
  for (const [unit, texture] of bindings) {
    backend.bindTextureUnit(unit, texture);
  }
  backend.activeTextureUnit(0);
  backend.bindFramebuffer(renderer.multisampleFramebuffer);
}

/**
 * Draws the back faces (front-face culling) of every closed glass batch into the back-face target and binds it for the glass pass.
 * When one closed shell is inside another (glassShellsNested) a second pass keeps the farthest back face per pixel in a second target, so
 * the outer shell's exit is found behind the inner one's. Returns `{ firstInstances, farLayer }` (the first-instance number of each drawn
 * batch as a Map), or null, and draws nothing, when no batch is closed glass. The liquid program is in use with its frame uniforms set.
 */
export function drawGlassBackFaces(renderer, liquids, width, height, cachedMetadata = null) {
  const { closedBatches, firstInstances, farLayer } = cachedMetadata ?? resolveClosedGlassMetadata(renderer, liquids);
  const backend = backendFor(renderer);
  if (closedBatches.length === 0) {
    if (renderer.glassBackFarFaces) {
      unbindBackFaceTextures(backend);
      renderer.glassBackFarFaces.release();
    }
    return null;
  }
  const target = ensureGlassBackTarget(renderer, width, height, false, backend);
  // The previous frame left these bound to the attachments; drawing into them while the program samples them is a feedback loop.
  unbindBackFaceTextures(backend);
  if (!farLayer) renderer.glassBackFarFaces?.release();
  const farTarget = farLayer ? ensureGlassBackTarget(renderer, width, height, true, backend) : null;
  drawBackLayer(renderer, target, closedBatches, firstInstances, width, height, false, backend);
  if (farTarget) drawBackLayer(renderer, farTarget, closedBatches, firstInstances, width, height, true, backend);
  bindBackFaceTarget(backend, renderer, target, farTarget);
  return { firstInstances, farLayer };
}

function drawLayerBackFaces(renderer, layerShells, firstInstances, width, height, backend) {
  const target = ensureGlassBackTarget(renderer, width, height, false, backend);
  unbindBackFaceTextures(backend);
  renderer.glassBackFarFaces?.release();
  drawBackLayer(renderer, target, layerShells, firstInstances, width, height, false, backend);
  bindBackFaceTarget(backend, renderer, target);
}

function resolveRefractionTargets(renderer, width, height, needsRefractionMips, hasGlass, backend) {
  // Liquids refract the opaque scene (or already-drawn glass layers), so resolve it into frameTexture before drawing on top.
  backend.blitTarget(renderer.multisampleFramebuffer, renderer.resolveFramebuffer, width, height, 'color');
  const sceneTexture = needsRefractionMips ? copySceneIntoMipChain(renderer, width, height) : renderer.frameTexture;
  const sceneDepthTexture = hasGlass ? resolveSceneDepth(renderer, width, height) : null;
  backend.bindFramebuffer(renderer.multisampleFramebuffer);
  backend.setViewport(width, height);
  return { sceneTexture, sceneDepthTexture };
}

function bindRefractionTargets(backend, uniforms, sceneTexture, sceneDepthTexture, reversed) {
  backend.bindTextureUnit(0, sceneTexture);
  backend.uniform1i(uniforms.sceneColor, 0);
  if (!sceneDepthTexture) return;
  const mapping = depthMapping(reversed);
  backend.bindTextureUnit(SCENE_DEPTH_UNIT, sceneDepthTexture);
  backend.activeTextureUnit(0);
  backend.uniform3f(uniforms.depthMapping, mapping.scale, mapping.bias, reversed ? 1 : 0);
}

function drawGlassBatchFront(renderer, uniforms, batch, backFirstInstances, maximumDistance, instanceIndex = null, skipDepthWrite = false, backend = backendFor(renderer)) {
  const part = batch.parts[instanceIndex ?? 0];
  bindLiquidMorph(renderer, batch, uniforms, backend);
  const layers = batch.layerState;
  backend.uniform4f(uniforms.glassState, layers[9], layers[10], layers[11] * partScale(part.matrix), Math.min(layers[12], maximumDistance));
  backend.uniform3f(uniforms.glassTint, layers[13], layers[14], layers[15]);
  // Blended glass covers the refracted picture by its alpha, over the opaque scene already in the frame.
  backend.uniform1f(uniforms.glassBackFirst, backFirstInstances?.get(batch) ?? 0);
  backend.uniform1f(uniforms.glassMediumContinues, part.material.mediumContinues === true ? 1 : 0);
  backend.uniform1f(uniforms.materialEmissionFresnel, layers[24]);
  const covering = batch.opacity < 1;
  backend.uniform1f(uniforms.glassCoverage, covering ? batch.opacity : 1);
  if (covering) backend.setRenderState({ blend: true, blendMode: 'premultiplied' });
  if (skipDepthWrite) backend.setRenderState({ depthWrite: false });
  if (batch.doubleSided) backend.setRenderState({ cullFace: false });
  if (batch.mirrored) backend.setFrontFaceClockwise(true);
  const metallicRoughnessState = batch.mapState[METALLIC_ROUGHNESS_MAP_INDEX];
  backend.bindTextureUnit(METALLIC_ROUGHNESS_UNIT, batch.textures[METALLIC_ROUGHNESS_MAP_INDEX]);
  backend.uniform1f(uniforms.hasMetallicRoughnessMap, metallicRoughnessState ? 1 + (metallicRoughnessState.uvChannel ?? 0) : 0);
  if (renderer.liquidClipLocations) bindClipPlanes(renderer, batch, renderer.liquidClipLocations);
  liquidWaterSupport.bind?.(renderer, uniforms, batch);
  liquidProbeSupport.bind?.(renderer, uniforms, batch);
  drawBatchInstance(backend, batch, instanceIndex);
  if (batch.mirrored) backend.setFrontFaceClockwise(false);
  if (batch.doubleSided) backend.setRenderState({ cullFace: true });
  if (skipDepthWrite) backend.setRenderState({ depthWrite: true });
  if (covering) backend.setRenderState({ blend: false });
}

// KHR_materials_volume gives the thickness in the mesh's own units, so a placed or scaled asset thickens with its transform.
// The first part stands for the batch: parts that share a glass material and differ in scale are rare.
function partScale(matrix) {
  const columnLength = column => Math.hypot(matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]);
  return (columnLength(0) + columnLength(1) + columnLength(2)) / 3;
}

function batchViewDepth(batch, view) {
  const matrix = batch.parts[0].matrix;
  return view[2] * matrix[12] + view[6] * matrix[13] + view[10] * matrix[14] + view[14];
}

export function drawLiquidPass(renderer, { frame, environment, assemblyAmount, environmentMap, liquids, foams, environmentSpecularUnit, maximumDistance, vertexSource, fragmentSource }) {
  const backend = backendFor(renderer);
  const optics = resolveLiquidOptics({ ...environment.liquid, ...frame.liquid });
  ensureLiquidProgram(renderer, environmentSpecularUnit, vertexSource, fragmentSource, backend);
  const width = renderer.canvas.width;
  const height = renderer.canvas.height;
  const needsRefractionMips = batchesNeedRefractionMips(liquids, width, height);
  const hasGlass = liquids.some(batch => batch.layerState[9] > 0);
  const { sceneTexture, sceneDepthTexture } = resolveRefractionTargets(renderer, width, height, needsRefractionMips, hasGlass, backend);
  backend.setRenderState({ depthTest: true, cullFace: true });
  backend.useProgram(renderer.liquidProgram);
  const uniforms = renderer.liquidUniforms;
  const viewProjection = renderer.rasterViewProjection ?? renderer.viewProjection;
  backend.uniformMatrix4fv(uniforms.viewProjection, viewProjection);
  backend.uniformMatrix4fv(uniforms.lightProjection, renderer.lightProjection);
  backend.uniform3fv(uniforms.eye, frame.eye);
  backend.uniform2f(uniforms.resolution, width, height);
  backend.uniform1f(uniforms.exposure, frame.exposure ?? 1);
  backend.uniform1f(uniforms.hdrEnabled, renderer.hdr ? 1 : 0);
  backend.uniform1f(uniforms.worldMode, renderer.world ? 1 : 0);
  backend.uniform1f(uniforms.daylight, environment.daylight);
  backend.uniform3fv(uniforms.lightDirection, environment.lightDirection);
  backend.uniform3fv(uniforms.keyColor, renderer.lighting.keyColor);
  backend.uniform1f(uniforms.ambientIntensity, renderer.lighting.ambientIntensity);
  backend.uniform3fv(uniforms.fogColor, environment.fogColor);
  backend.uniform1f(uniforms.fogDensity, environment.fogDensity);
  backend.uniform4f(uniforms.liquidOptics, optics.thickness, optics.ior, optics.refraction, optics.scattering);
  backend.uniform2f(uniforms.foamShape, optics.foamOpacity, optics.foamSoftness);
  renderer.applyEnvironmentUniforms(environmentMap, uniforms);
  backend.uniform1f(uniforms.time, frame.time ?? 0);
  backend.uniform1f(uniforms.wind, frame.wind ?? 0.3);
  backend.uniform1f(uniforms.explosionProgress, frame.explosionProgress ?? 1);
  backend.uniform3fv(uniforms.explosionCenter, environment.explosionCenter);
  backend.uniform1f(uniforms.assemblyAmount, assemblyAmount);
  if (uniforms.skinEnabled) backend.uniform1f(uniforms.skinEnabled, 0);
  if (uniforms.morphEnabled) backend.uniform1f(uniforms.morphEnabled, 0);
  const reversed = Boolean(renderer.reversedDepth);
  bindRefractionTargets(backend, uniforms, sceneTexture, sceneDepthTexture, reversed);
  backend.uniform1f(uniforms.glassBackPass, 0);
  const hasThroughGlass = renderer.batches?.some(batch => batch.alphaMode === 'add' && batch.throughGlass);
  const hasAdditiveAfter = hasThroughGlass || renderer.batches?.some(batch => batch.alphaMode === 'add' && batch.depthTest !== false && !renderer.additiveBehindShells?.has(batch));
  const skipDepthWriteFor = batch => hasThroughGlass || (hasAdditiveAfter && batch.alphaMode === 'blend');
  const metadata = sceneDepthTexture ? resolveClosedGlassMetadata(renderer, liquids) : null;
  const refractionLayers = metadata && metadata.closedBatches.length > 0 ? planGlassRefractionLayers(metadata.shells, viewProjection, frame.eye) : null;
  if (refractionLayers) {
    const closedSet = new Set(metadata.closedBatches);
    const otherLiquids = liquids.filter(batch => !closedSet.has(batch));
    backend.uniform1f(uniforms.glassBackEnabled, 1);
    backend.uniform1f(uniforms.glassBackFarEnabled, 0);
    for (let layerIndex = 0; layerIndex < refractionLayers.length; layerIndex++) {
      if (layerIndex > 0) {
        const resolved = resolveRefractionTargets(renderer, width, height, needsRefractionMips, true, backend);
        bindRefractionTargets(backend, uniforms, resolved.sceneTexture, resolved.sceneDepthTexture, reversed);
      }
      drawLayerBackFaces(renderer, refractionLayers[layerIndex], metadata.firstInstances, width, height, backend);
      for (const shell of refractionLayers[layerIndex]) {
        drawGlassBatchFront(renderer, uniforms, shell.batch, metadata.firstInstances, maximumDistance, shell.instanceIndex, skipDepthWriteFor(shell.batch), backend);
      }
    }
    if (otherLiquids.length > 0) {
      const resolved = resolveRefractionTargets(renderer, width, height, needsRefractionMips, true, backend);
      bindRefractionTargets(backend, uniforms, resolved.sceneTexture, resolved.sceneDepthTexture, reversed);
      backend.uniform1f(uniforms.glassBackEnabled, 0);
      for (const batch of otherLiquids) {
        drawGlassBatchFront(renderer, uniforms, batch, metadata.firstInstances, maximumDistance, null, skipDepthWriteFor(batch), backend);
      }
    }
  } else {
    const backFaces = sceneDepthTexture ? drawGlassBackFaces(renderer, liquids, width, height, metadata) : null;
    const backFirstInstances = backFaces?.firstInstances ?? null;
    backend.uniform1f(uniforms.glassBackEnabled, backFaces ? 1 : 0);
    backend.uniform1f(uniforms.glassBackFarEnabled, backFaces?.farLayer ? 1 : 0);
    const orderedLiquids = liquids.length > 1 && renderer.view
      ? [...liquids].sort((first, second) => batchViewDepth(first, renderer.view) - batchViewDepth(second, renderer.view))
      : liquids;
    for (const batch of orderedLiquids) {
      drawGlassBatchFront(renderer, uniforms, batch, backFirstInstances, maximumDistance, null, skipDepthWriteFor(batch), backend);
    }
  }
  liquidProbeSupport.finish?.(renderer, uniforms);
  if (uniforms.morphEnabled) backend.uniform1f(uniforms.morphEnabled, 0);
  if (foams.length > 0) {
    backend.setRenderState({ blend: true, blendMode: 'alpha', depthWrite: false });
    for (const batch of foams) {
      if (renderer.liquidClipLocations) bindClipPlanes(renderer, batch, renderer.liquidClipLocations);
      backend.bindVertexArray(batch.vertexArray);
      backend.drawIndexedInstanced(batch.indexCount, batch.instanceCount);
    }
    backend.setRenderState({ depthWrite: true, blend: false });
  }
  backend.bindVertexArray(null);
}
