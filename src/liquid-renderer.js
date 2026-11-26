import { compileProgram } from './gl-program.js';
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

function bindLiquidMorph(renderer, batch, uniforms) {
  if (!renderer.hasMorphs || !uniforms?.morphEnabled) return;
  const context = renderer.context;
  context.uniform1f(uniforms.morphEnabled, batch.morph ? 1 : 0);
  if (!batch.morph) return;
  context.uniform1i(uniforms.morphVertexCount, batch.morphTexture.info.vertexCount);
  const targetCount = batch.morphWeights.length;
  const selected = targetCount > MORPH_SLOT_COUNT;
  const slotCount = selected ? requireDeformationSupport('selectMorphSlots', 'morph.js').selectMorphSlots(batch.morphWeights, MORPH_SLOT_TARGETS, MORPH_SLOT_WEIGHTS) : targetCount;
  context.uniform1i(uniforms.morphTargetCount, slotCount);
  context.uniform1fv(uniforms['morphWeights[0]'], selected ? MORPH_SLOT_WEIGHTS : batch.morphWeights);
  context.uniform1fv(uniforms['morphSlotTargets[0]'], selected ? MORPH_SLOT_TARGETS : IDENTITY_MORPH_SLOTS);
  context.activeTexture(context.TEXTURE0 + 8);
  context.bindTexture(context.TEXTURE_2D, batch.morphTexture.texture);
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
function ensureLiquidProgram(renderer, environmentSpecularUnit, vertexSource, fragmentSource) {
  if (renderer.liquidProgram) return;
  const context = renderer.context;
  const clipped = renderer.shaderFeatures?.has(CLIP_PLANES_FEATURE) && !renderer.benchmark;
  renderer.liquidProgram = compileProgram(context, vertexSourceForLiquid(renderer, vertexSource), renderer.withViewTransform(clipped ? addClipPlanesToLiquidShader(fragmentSource) : fragmentSource, 'liquid'));
  renderer.liquidClipLocations = clipped ? clipPlaneLocations(context, renderer.liquidProgram) : null;
  renderer.liquidUniforms = Object.fromEntries(LIQUID_UNIFORMS.map(name => [name, context.getUniformLocation(renderer.liquidProgram, name)]));
  context.useProgram(renderer.liquidProgram);
  context.uniform1i(renderer.liquidUniforms.metallicRoughnessMap, METALLIC_ROUGHNESS_UNIT);
  context.uniform1i(renderer.liquidUniforms.sceneDepth, SCENE_DEPTH_UNIT);
  context.uniform1i(renderer.liquidUniforms.glassBackDepth, BACK_DEPTH_UNIT);
  context.uniform1i(renderer.liquidUniforms.glassBackNormal, BACK_NORMAL_UNIT);
  context.uniform1i(renderer.liquidUniforms.glassBackFarDepth, BACK_FAR_DEPTH_UNIT);
  context.uniform1i(renderer.liquidUniforms.glassBackFarNormal, BACK_FAR_NORMAL_UNIT);
  context.uniform1i(renderer.liquidUniforms.skinInfluences, 6);
  context.uniform1i(renderer.liquidUniforms.jointPalette, 7);
  context.uniform1i(renderer.liquidUniforms.morphTargets, 8);
  context.uniform1i(renderer.liquidUniforms.environmentSpecular, environmentSpecularUnit);
}

/**
 * Copies the resolved opaque scene into a texture with a full mip chain and returns it. Rough glass samples its blurrier levels.
 * The chain lives apart from frameTexture, which post and bloom read with a plain filter, and it is only built (once per frame, on
 * the frames that draw rough glass) here; a frame with no glass, or only smooth glass, never allocates or fills it.
 */
export function copySceneIntoMipChain(renderer, width, height) {
  const context = renderer.context;
  context.activeTexture(context.TEXTURE0);
  const hdr = Boolean(renderer.hdr);
  let chain = renderer.refractionChain;
  if (!chain || chain.width !== width || chain.height !== height || chain.hdr !== hdr) {
    chain?.release();
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texStorage2D(context.TEXTURE_2D, mipLevelCount(width, height), hdr ? context.RGBA16F : context.RGBA8, width, height);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR_MIPMAP_LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    const framebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
    const release = () => {
      context.deleteTexture(texture);
      context.deleteFramebuffer(framebuffer);
      renderer.refractionChain = null;
    };
    chain = { texture, framebuffer, width, height, hdr, release };
    renderer.refractionChain = chain;
  }
  // A blit, not copyTexSubImage2D: the opaque frame may be stored without alpha, and a copy needs the two formats to match.
  context.bindFramebuffer(context.READ_FRAMEBUFFER, renderer.resolveFramebuffer);
  context.bindFramebuffer(context.DRAW_FRAMEBUFFER, chain.framebuffer);
  context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.COLOR_BUFFER_BIT, context.NEAREST);
  context.activeTexture(context.TEXTURE0);
  context.bindTexture(context.TEXTURE_2D, chain.texture);
  context.generateMipmap(context.TEXTURE_2D);
  return chain.texture;
}

/**
 * Resolves the opaque pass's depth into a single-sample texture that glass marches against, and returns it. The target is built on the
 * first frame that draws glass (4 bytes a pixel, 32-bit float with reversed depth) and freed with the frame targets; a frame with no
 * glass never allocates or fills it. The depth stays in the buffer's own convention, which depthMapping describes to the shader.
 */
export function resolveSceneDepth(renderer, width, height) {
  const context = renderer.context;
  context.activeTexture(context.TEXTURE0);
  const reversed = Boolean(renderer.reversedDepth);
  let target = renderer.refractionDepth;
  if (!target || target.width !== width || target.height !== height || target.reversed !== reversed) {
    target?.release();
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    const internalFormat = reversed ? context.DEPTH_COMPONENT32F : context.DEPTH_COMPONENT24;
    context.texImage2D(context.TEXTURE_2D, 0, internalFormat, width, height, 0, context.DEPTH_COMPONENT, reversed ? context.FLOAT : context.UNSIGNED_INT, null);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    const framebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, texture, 0);
    renderer.renderTargets?.record('refractionDepth', { width, height, format: reversed ? 'DEPTH_COMPONENT32F' : 'DEPTH_COMPONENT24' });
    const release = () => {
      context.deleteTexture(texture);
      context.deleteFramebuffer(framebuffer);
      renderer.renderTargets?.release('refractionDepth');
      renderer.refractionDepth = null;
      // The back-face target is only built on top of this one, so it goes with it.
      renderer.glassBackFaces?.release();
      renderer.glassBackFarFaces?.release();
    };
    target = { texture, framebuffer, width, height, reversed, release };
    renderer.refractionDepth = target;
  }
  context.bindFramebuffer(context.READ_FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.bindFramebuffer(context.DRAW_FRAMEBUFFER, target.framebuffer);
  context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.DEPTH_BUFFER_BIT, context.NEAREST);
  return target.texture;
}

/**
 * The target the back faces of closed glass are drawn into: the outward normal (RGBA8 encoded as n * 0.5 + 0.5, alpha 0 where nothing was drawn; RGBA16F is not renderable without HDR) and the depth in the
 * buffer's convention. Built on the first frame that draws closed glass (8 bytes a pixel) and freed with the frame targets; a frame with no
 * closed glass never allocates it.
 */
function ensureGlassBackTarget(renderer, width, height, far = false) {
  const context = renderer.context;
  const reversed = Boolean(renderer.reversedDepth);
  const property = far ? 'glassBackFarFaces' : 'glassBackFaces';
  const ledgerName = far ? 'glassBackFarFaces' : 'glassBackFaces';
  let target = renderer[property];
  if (target && target.width === width && target.height === height && target.reversed === reversed) return target;
  target?.release();
  // Built on a spare unit, so the scene texture bound to unit 0 stays bound.
  context.activeTexture(context.TEXTURE0 + (far ? BACK_FAR_DEPTH_UNIT : BACK_DEPTH_UNIT));
  const makeTexture = () => {
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    return texture;
  };
  const normalTexture = makeTexture();
  context.texStorage2D(context.TEXTURE_2D, 1, context.RGBA8, width, height);
  const depthTexture = makeTexture();
  context.texStorage2D(context.TEXTURE_2D, 1, reversed ? context.DEPTH_COMPONENT32F : context.DEPTH_COMPONENT24, width, height);
  const framebuffer = context.createFramebuffer();
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, normalTexture, 0);
  context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, depthTexture, 0);
  renderer.renderTargets?.record(ledgerName, { width, height, format: 'RGBA8' });
  renderer.renderTargets?.record(`${ledgerName}Depth`, { width, height, format: reversed ? 'DEPTH_COMPONENT32F' : 'DEPTH_COMPONENT24' });
  const release = () => {
    context.deleteTexture(normalTexture);
    context.deleteTexture(depthTexture);
    context.deleteFramebuffer(framebuffer);
    renderer.renderTargets?.release(ledgerName);
    renderer.renderTargets?.release(`${ledgerName}Depth`);
    renderer[property] = null;
  };
  target = { normalTexture, depthTexture, framebuffer, width, height, reversed, release };
  renderer[property] = target;
  context.activeTexture(context.TEXTURE0);
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

function unbindBackFaceTextures(context) {
  for (const unit of [BACK_DEPTH_UNIT, BACK_NORMAL_UNIT, BACK_FAR_DEPTH_UNIT, BACK_FAR_NORMAL_UNIT]) {
    context.activeTexture(context.TEXTURE0 + unit);
    context.bindTexture(context.TEXTURE_2D, null);
  }
  context.activeTexture(context.TEXTURE0);
}

function drawBatchInstance(context, batch, instanceIndex) {
  context.bindVertexArray(batch.vertexArray);
  if (batch.instanceCount <= 1 || instanceIndex == null || !batch.instanceBuffer || !batch.instanceData) {
    context.drawElementsInstanced(context.TRIANGLES, batch.indexCount, context.UNSIGNED_INT, 0, batch.instanceCount);
    return;
  }
  const stride = batch.instanceData.length / batch.instanceCount;
  const start = instanceIndex * stride;
  context.bindBuffer(context.ARRAY_BUFFER, batch.instanceBuffer);
  if (instanceIndex > 0) context.bufferSubData(context.ARRAY_BUFFER, 0, batch.instanceData.subarray(start, start + stride));
  try {
    context.drawElementsInstanced(context.TRIANGLES, batch.indexCount, context.UNSIGNED_INT, 0, 1);
  } finally {
    if (instanceIndex > 0) context.bufferSubData(context.ARRAY_BUFFER, 0, batch.instanceData.subarray(0, stride));
    context.bindBuffer(context.ARRAY_BUFFER, null);
  }
}

/** Draws one layer of back faces into its target: the nearest per pixel, or with `far` the farthest. */
function drawBackLayer(renderer, target, items, firstInstances, width, height, far) {
  const context = renderer.context;
  const uniforms = renderer.liquidUniforms;
  const reversed = Boolean(renderer.reversedDepth);
  const nearestFunction = reversed ? context.GREATER : context.LESS;
  const farthestFunction = reversed ? context.LESS : context.GREATER;
  const farthestClear = reversed ? 1 : 0;
  context.bindFramebuffer(context.FRAMEBUFFER, target.framebuffer);
  context.viewport(0, 0, width, height);
  context.clearColor(0, 0, 0, 0);
  context.clearDepth(far ? farthestClear : reversed ? 0 : 1);
  context.clear(context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT);
  context.clearDepth(1);
  if (far) context.depthFunc(farthestFunction);
  context.cullFace(context.FRONT);
  context.uniform1f(uniforms.glassBackPass, 1);
  for (const item of items) {
    const batch = item.batch ?? item;
    const instanceIndex = item.batch ? item.instanceIndex : null;
    bindLiquidMorph(renderer, batch, uniforms);
    context.uniform1f(uniforms.glassBackFirst, firstInstances.get(batch));
    if (renderer.liquidClipLocations) bindClipPlanes(renderer, batch, renderer.liquidClipLocations);
    drawBatchInstance(context, batch, instanceIndex);
  }
  if (uniforms.morphEnabled) context.uniform1f(uniforms.morphEnabled, 0);
  context.uniform1f(uniforms.glassBackPass, 0);
  context.cullFace(context.BACK);
  if (far) context.depthFunc(nearestFunction);
}

function bindBackFaceTarget(context, renderer, target, farTarget = null) {
  // With no second layer the far units hold the first one, which the shader never reads there; they only keep the samplers valid.
  const farSource = farTarget ?? target;
  const bindings = [[BACK_DEPTH_UNIT, target.depthTexture], [BACK_NORMAL_UNIT, target.normalTexture], [BACK_FAR_DEPTH_UNIT, farSource.depthTexture], [BACK_FAR_NORMAL_UNIT, farSource.normalTexture]];
  for (const [unit, texture] of bindings) {
    context.activeTexture(context.TEXTURE0 + unit);
    context.bindTexture(context.TEXTURE_2D, texture);
  }
  context.activeTexture(context.TEXTURE0);
  context.bindFramebuffer(context.FRAMEBUFFER, renderer.multisampleFramebuffer);
}

/**
 * Draws the back faces (front-face culling) of every closed glass batch into the back-face target and binds it for the glass pass.
 * When one closed shell is inside another (glassShellsNested) a second pass keeps the farthest back face per pixel in a second target, so
 * the outer shell's exit is found behind the inner one's. Returns `{ firstInstances, farLayer }` (the first-instance number of each drawn
 * batch as a Map), or null, and draws nothing, when no batch is closed glass. The liquid program is in use with its frame uniforms set.
 */
export function drawGlassBackFaces(renderer, liquids, width, height, cachedMetadata = null) {
  const { closedBatches, firstInstances, farLayer } = cachedMetadata ?? resolveClosedGlassMetadata(renderer, liquids);
  const context = renderer.context;
  if (closedBatches.length === 0) {
    if (renderer.glassBackFarFaces) {
      unbindBackFaceTextures(context);
      renderer.glassBackFarFaces.release();
    }
    return null;
  }
  const target = ensureGlassBackTarget(renderer, width, height);
  // The previous frame left these bound to the attachments; drawing into them while the program samples them is a feedback loop.
  unbindBackFaceTextures(context);
  if (!farLayer) renderer.glassBackFarFaces?.release();
  const farTarget = farLayer ? ensureGlassBackTarget(renderer, width, height, true) : null;
  drawBackLayer(renderer, target, closedBatches, firstInstances, width, height, false);
  if (farTarget) drawBackLayer(renderer, farTarget, closedBatches, firstInstances, width, height, true);
  bindBackFaceTarget(context, renderer, target, farTarget);
  return { firstInstances, farLayer };
}

function drawLayerBackFaces(renderer, layerShells, firstInstances, width, height) {
  const context = renderer.context;
  const target = ensureGlassBackTarget(renderer, width, height);
  unbindBackFaceTextures(context);
  renderer.glassBackFarFaces?.release();
  drawBackLayer(renderer, target, layerShells, firstInstances, width, height, false);
  bindBackFaceTarget(context, renderer, target);
}

function resolveRefractionTargets(renderer, width, height, needsRefractionMips, hasGlass) {
  const context = renderer.context;
  // Liquids refract the opaque scene (or already-drawn glass layers), so resolve it into frameTexture before drawing on top.
  context.bindFramebuffer(context.READ_FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.bindFramebuffer(context.DRAW_FRAMEBUFFER, renderer.resolveFramebuffer);
  context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.COLOR_BUFFER_BIT, context.NEAREST);
  const sceneTexture = needsRefractionMips ? copySceneIntoMipChain(renderer, width, height) : renderer.frameTexture;
  const sceneDepthTexture = hasGlass ? resolveSceneDepth(renderer, width, height) : null;
  context.bindFramebuffer(context.FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.viewport(0, 0, width, height);
  return { sceneTexture, sceneDepthTexture };
}

function bindRefractionTargets(context, uniforms, sceneTexture, sceneDepthTexture, reversed) {
  context.activeTexture(context.TEXTURE0);
  context.bindTexture(context.TEXTURE_2D, sceneTexture);
  context.uniform1i(uniforms.sceneColor, 0);
  if (!sceneDepthTexture) return;
  const mapping = depthMapping(reversed);
  context.activeTexture(context.TEXTURE0 + SCENE_DEPTH_UNIT);
  context.bindTexture(context.TEXTURE_2D, sceneDepthTexture);
  context.activeTexture(context.TEXTURE0);
  context.uniform3f(uniforms.depthMapping, mapping.scale, mapping.bias, reversed ? 1 : 0);
}

function drawGlassBatchFront(renderer, uniforms, batch, backFirstInstances, maximumDistance, instanceIndex = null) {
  const context = renderer.context;
  const part = batch.parts[instanceIndex ?? 0];
  bindLiquidMorph(renderer, batch, uniforms);
  const layers = batch.layerState;
  context.uniform4f(uniforms.glassState, layers[9], layers[10], layers[11] * partScale(part.matrix), Math.min(layers[12], maximumDistance));
  context.uniform3f(uniforms.glassTint, layers[13], layers[14], layers[15]);
  // Blended glass covers the refracted picture by its alpha, over the opaque scene already in the frame.
  context.uniform1f(uniforms.glassBackFirst, backFirstInstances?.get(batch) ?? 0);
  context.uniform1f(uniforms.glassMediumContinues, part.material.mediumContinues === true ? 1 : 0);
  context.uniform1f(uniforms.materialEmissionFresnel, layers[24]);
  const covering = batch.opacity < 1;
  context.uniform1f(uniforms.glassCoverage, covering ? batch.opacity : 1);
  if (covering) {
    context.enable(context.BLEND);
    context.blendFuncSeparate(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE_MINUS_SRC_ALPHA);
  }
  const metallicRoughnessState = batch.mapState[METALLIC_ROUGHNESS_MAP_INDEX];
  context.activeTexture(context.TEXTURE0 + METALLIC_ROUGHNESS_UNIT);
  context.bindTexture(context.TEXTURE_2D, batch.textures[METALLIC_ROUGHNESS_MAP_INDEX]);
  context.uniform1f(uniforms.hasMetallicRoughnessMap, metallicRoughnessState ? 1 + (metallicRoughnessState.uvChannel ?? 0) : 0);
  if (renderer.liquidClipLocations) bindClipPlanes(renderer, batch, renderer.liquidClipLocations);
  liquidWaterSupport.bind?.(renderer, uniforms, batch);
  liquidProbeSupport.bind?.(renderer, uniforms, batch);
  drawBatchInstance(context, batch, instanceIndex);
  if (covering) context.disable(context.BLEND);
}

// KHR_materials_volume gives the thickness in the mesh's own units, so a placed or scaled asset thickens with its transform.
// The first part stands for the batch: parts that share a glass material and differ in scale are rare.
function partScale(matrix) {
  const columnLength = column => Math.hypot(matrix[column * 4], matrix[column * 4 + 1], matrix[column * 4 + 2]);
  return (columnLength(0) + columnLength(1) + columnLength(2)) / 3;
}

export function drawLiquidPass(renderer, { frame, environment, assemblyAmount, environmentMap, liquids, foams, environmentSpecularUnit, maximumDistance, vertexSource, fragmentSource }) {
  const optics = resolveLiquidOptics({ ...environment.liquid, ...frame.liquid });
  ensureLiquidProgram(renderer, environmentSpecularUnit, vertexSource, fragmentSource);
  const context = renderer.context;
  const width = renderer.canvas.width;
  const height = renderer.canvas.height;
  const needsRefractionMips = batchesNeedRefractionMips(liquids, width, height);
  const hasGlass = liquids.some(batch => batch.layerState[9] > 0);
  const { sceneTexture, sceneDepthTexture } = resolveRefractionTargets(renderer, width, height, needsRefractionMips, hasGlass);
  context.enable(context.DEPTH_TEST);
  context.enable(context.CULL_FACE);
  context.useProgram(renderer.liquidProgram);
  const uniforms = renderer.liquidUniforms;
  const viewProjection = renderer.rasterViewProjection ?? renderer.viewProjection;
  context.uniformMatrix4fv(uniforms.viewProjection, false, viewProjection);
  context.uniformMatrix4fv(uniforms.lightProjection, false, renderer.lightProjection);
  context.uniform3fv(uniforms.eye, frame.eye);
  context.uniform2f(uniforms.resolution, width, height);
  context.uniform1f(uniforms.exposure, frame.exposure ?? 1);
  context.uniform1f(uniforms.hdrEnabled, renderer.hdr ? 1 : 0);
  context.uniform1f(uniforms.worldMode, renderer.world ? 1 : 0);
  context.uniform1f(uniforms.daylight, environment.daylight);
  context.uniform3fv(uniforms.lightDirection, environment.lightDirection);
  context.uniform3fv(uniforms.keyColor, renderer.lighting.keyColor);
  context.uniform1f(uniforms.ambientIntensity, renderer.lighting.ambientIntensity);
  context.uniform3fv(uniforms.fogColor, environment.fogColor);
  context.uniform1f(uniforms.fogDensity, environment.fogDensity);
  context.uniform4f(uniforms.liquidOptics, optics.thickness, optics.ior, optics.refraction, optics.scattering);
  context.uniform2f(uniforms.foamShape, optics.foamOpacity, optics.foamSoftness);
  renderer.applyEnvironmentUniforms(environmentMap, uniforms);
  context.uniform1f(uniforms.time, frame.time ?? 0);
  context.uniform1f(uniforms.wind, frame.wind ?? 0.3);
  context.uniform1f(uniforms.explosionProgress, frame.explosionProgress ?? 1);
  context.uniform3fv(uniforms.explosionCenter, environment.explosionCenter);
  context.uniform1f(uniforms.assemblyAmount, assemblyAmount);
  if (uniforms.skinEnabled) context.uniform1f(uniforms.skinEnabled, 0);
  if (uniforms.morphEnabled) context.uniform1f(uniforms.morphEnabled, 0);
  const reversed = Boolean(renderer.reversedDepth);
  bindRefractionTargets(context, uniforms, sceneTexture, sceneDepthTexture, reversed);
  context.uniform1f(uniforms.glassBackPass, 0);
  const metadata = sceneDepthTexture ? resolveClosedGlassMetadata(renderer, liquids) : null;
  const refractionLayers = metadata && metadata.closedBatches.length > 0 ? planGlassRefractionLayers(metadata.shells, viewProjection, frame.eye) : null;
  if (refractionLayers) {
    const closedSet = new Set(metadata.closedBatches);
    const otherLiquids = liquids.filter(batch => !closedSet.has(batch));
    context.uniform1f(uniforms.glassBackEnabled, 1);
    context.uniform1f(uniforms.glassBackFarEnabled, 0);
    for (let layerIndex = 0; layerIndex < refractionLayers.length; layerIndex++) {
      if (layerIndex > 0) {
        const resolved = resolveRefractionTargets(renderer, width, height, needsRefractionMips, true);
        bindRefractionTargets(context, uniforms, resolved.sceneTexture, resolved.sceneDepthTexture, reversed);
      }
      drawLayerBackFaces(renderer, refractionLayers[layerIndex], metadata.firstInstances, width, height);
      for (const shell of refractionLayers[layerIndex]) {
        drawGlassBatchFront(renderer, uniforms, shell.batch, metadata.firstInstances, maximumDistance, shell.instanceIndex);
      }
    }
    if (otherLiquids.length > 0) {
      const resolved = resolveRefractionTargets(renderer, width, height, needsRefractionMips, true);
      bindRefractionTargets(context, uniforms, resolved.sceneTexture, resolved.sceneDepthTexture, reversed);
      context.uniform1f(uniforms.glassBackEnabled, 0);
      for (const batch of otherLiquids) {
        drawGlassBatchFront(renderer, uniforms, batch, metadata.firstInstances, maximumDistance);
      }
    }
  } else {
    const backFaces = sceneDepthTexture ? drawGlassBackFaces(renderer, liquids, width, height, metadata) : null;
    const backFirstInstances = backFaces?.firstInstances ?? null;
    context.uniform1f(uniforms.glassBackEnabled, backFaces ? 1 : 0);
    context.uniform1f(uniforms.glassBackFarEnabled, backFaces?.farLayer ? 1 : 0);
    for (const batch of liquids) {
      drawGlassBatchFront(renderer, uniforms, batch, backFirstInstances, maximumDistance);
    }
  }
  liquidProbeSupport.finish?.(renderer, uniforms);
  if (uniforms.morphEnabled) context.uniform1f(uniforms.morphEnabled, 0);
  if (foams.length > 0) {
    context.enable(context.BLEND);
    context.blendFuncSeparate(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE_MINUS_SRC_ALPHA);
    context.depthMask(false);
    for (const batch of foams) {
      if (renderer.liquidClipLocations) bindClipPlanes(renderer, batch, renderer.liquidClipLocations);
      context.bindVertexArray(batch.vertexArray);
      context.drawElementsInstanced(context.TRIANGLES, batch.indexCount, context.UNSIGNED_INT, 0, batch.instanceCount);
    }
    context.depthMask(true);
    context.disable(context.BLEND);
  }
  context.bindVertexArray(null);
}
