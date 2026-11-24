import { compileProgram } from './gl-program.js';
import { CLIP_PLANES_FEATURE, addClipPlanesToLiquidShader, bindClipPlanes, clipPlaneLocations } from './clip-planes.js';
import { resolveLiquidOptics } from './liquid-optics.js';
import { batchesNeedRefractionMips, mipLevelCount } from './transmission-blur.js';
import { depthMapping } from './glass-depth-march.js';
import { liquidProbeSupport, liquidWaterSupport } from './shader-registry.js';

// The renderer's liquid and foam pass, kept apart from renderer.js so a scene without liquid or foam does not carry it.
// liquid-shader.js registers drawLiquidPass; the renderer calls it with the frame state it needs.

// The renderer binds the metallic-roughness map to unit 3 in its main pass too (MAP_UNIFORMS order, offset 1).
const METALLIC_ROUGHNESS_UNIT = 3;
const METALLIC_ROUGHNESS_MAP_INDEX = 2;
// Glass reads the opaque pass's depth from this unit.
const SCENE_DEPTH_UNIT = 4;

const LIQUID_UNIFORMS = [
  'viewProjection', 'lightProjection', 'eye', 'sceneColor', 'sceneDepth', 'depthMapping', 'resolution', 'exposure', 'hdrEnabled', 'worldMode', 'daylight', 'lightDirection',
  'keyColor', 'ambientIntensity', 'fogColor', 'fogDensity', 'glassState', 'glassTint', 'glassCoverage', 'glassMediumContinues', 'materialEmissionFresnel', 'liquidOptics', 'foamShape', 'metallicRoughnessMap', 'hasMetallicRoughnessMap',
  'environmentSpecular', 'environmentEnabled', 'environmentIntensity', 'environmentRotation', 'environmentLevelMax',
  'time', 'probeEnabled', 'probeFloor', 'waterReflection', 'waterReflectionMatrix', 'waterClip', 'waterReflectionEnabled', 'wind', 'explosionProgress', 'explosionCenter', 'assemblyAmount',
  'skinEnabled', 'skinInfluences', 'jointPalette',
  'morphEnabled', 'morphVertexCount', 'morphTargetCount', 'morphWeights[0]', 'morphSlotTargets[0]', 'morphTargets',
];

// The program compiles when the first liquid or foam batch draws, so a renderer without them never builds it.
function ensureLiquidProgram(renderer, environmentSpecularUnit, vertexSource, fragmentSource) {
  if (renderer.liquidProgram) return;
  const context = renderer.context;
  const clipped = renderer.shaderFeatures?.has(CLIP_PLANES_FEATURE) && !renderer.benchmark;
  renderer.liquidProgram = compileProgram(context, vertexSource, renderer.withViewTransform(clipped ? addClipPlanesToLiquidShader(fragmentSource) : fragmentSource, 'liquid'));
  renderer.liquidClipLocations = clipped ? clipPlaneLocations(context, renderer.liquidProgram) : null;
  renderer.liquidUniforms = Object.fromEntries(LIQUID_UNIFORMS.map(name => [name, context.getUniformLocation(renderer.liquidProgram, name)]));
  context.useProgram(renderer.liquidProgram);
  context.uniform1i(renderer.liquidUniforms.metallicRoughnessMap, METALLIC_ROUGHNESS_UNIT);
  context.uniform1i(renderer.liquidUniforms.sceneDepth, SCENE_DEPTH_UNIT);
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
    };
    target = { texture, framebuffer, width, height, reversed, release };
    renderer.refractionDepth = target;
  }
  context.bindFramebuffer(context.READ_FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.bindFramebuffer(context.DRAW_FRAMEBUFFER, target.framebuffer);
  context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.DEPTH_BUFFER_BIT, context.NEAREST);
  return target.texture;
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
  // Liquids refract the opaque scene, so resolve it into frameTexture before drawing them on top.
  context.bindFramebuffer(context.READ_FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.bindFramebuffer(context.DRAW_FRAMEBUFFER, renderer.resolveFramebuffer);
  context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.COLOR_BUFFER_BIT, context.NEAREST);
  const sceneTexture = batchesNeedRefractionMips(liquids, width, height) ? copySceneIntoMipChain(renderer, width, height) : renderer.frameTexture;
  const hasGlass = liquids.some(batch => batch.layerState[9] > 0);
  const sceneDepthTexture = hasGlass ? resolveSceneDepth(renderer, width, height) : null;
  context.bindFramebuffer(context.FRAMEBUFFER, renderer.multisampleFramebuffer);
  context.viewport(0, 0, width, height);
  context.enable(context.DEPTH_TEST);
  context.enable(context.CULL_FACE);
  context.useProgram(renderer.liquidProgram);
  const uniforms = renderer.liquidUniforms;
  context.uniformMatrix4fv(uniforms.viewProjection, false, renderer.rasterViewProjection ?? renderer.viewProjection);
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
  context.activeTexture(context.TEXTURE0);
  context.bindTexture(context.TEXTURE_2D, sceneTexture);
  context.uniform1i(uniforms.sceneColor, 0);
  if (sceneDepthTexture) {
    const reversed = Boolean(renderer.reversedDepth);
    const mapping = depthMapping(reversed);
    context.activeTexture(context.TEXTURE0 + SCENE_DEPTH_UNIT);
    context.bindTexture(context.TEXTURE_2D, sceneDepthTexture);
    context.activeTexture(context.TEXTURE0);
    context.uniform3f(uniforms.depthMapping, mapping.scale, mapping.bias, reversed ? 1 : 0);
  }
  for (const batch of liquids) {
    const layers = batch.layerState;
    context.uniform4f(uniforms.glassState, layers[9], layers[10], layers[11] * partScale(batch.parts[0].matrix), Math.min(layers[12], maximumDistance));
    context.uniform3f(uniforms.glassTint, layers[13], layers[14], layers[15]);
    // Blended glass covers the refracted picture by its alpha, over the opaque scene already in the frame.
    context.uniform1f(uniforms.glassMediumContinues, batch.parts[0].material.mediumContinues === true ? 1 : 0);
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
    context.bindVertexArray(batch.vertexArray);
    context.drawElementsInstanced(context.TRIANGLES, batch.indexCount, context.UNSIGNED_INT, 0, batch.instanceCount);
    if (covering) context.disable(context.BLEND);
  }
  liquidProbeSupport.finish?.(renderer, uniforms);
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
