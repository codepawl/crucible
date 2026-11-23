import { compileProgram } from './gl-program.js';
import { CLIP_PLANES_FEATURE, addClipPlanesToLiquidShader, bindClipPlanes, clipPlaneLocations } from './clip-planes.js';
import { resolveLiquidOptics } from './liquid-optics.js';
import { liquidProbeSupport, liquidWaterSupport } from './shader-registry.js';

// The renderer's liquid and foam pass, kept apart from renderer.js so a scene without liquid or foam does not carry it.
// liquid-shader.js registers drawLiquidPass; the renderer calls it with the frame state it needs.

// The renderer binds the metallic-roughness map to unit 3 in its main pass too (MAP_UNIFORMS order, offset 1).
const METALLIC_ROUGHNESS_UNIT = 3;
const METALLIC_ROUGHNESS_MAP_INDEX = 2;

const LIQUID_UNIFORMS = [
  'viewProjection', 'lightProjection', 'eye', 'sceneColor', 'resolution', 'exposure', 'hdrEnabled', 'worldMode', 'daylight', 'lightDirection',
  'keyColor', 'ambientIntensity', 'fogColor', 'fogDensity', 'glassState', 'glassTint', 'liquidOptics', 'foamShape', 'metallicRoughnessMap', 'hasMetallicRoughnessMap',
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
  context.uniform1i(renderer.liquidUniforms.skinInfluences, 6);
  context.uniform1i(renderer.liquidUniforms.jointPalette, 7);
  context.uniform1i(renderer.liquidUniforms.morphTargets, 8);
  context.uniform1i(renderer.liquidUniforms.environmentSpecular, environmentSpecularUnit);
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
  context.bindTexture(context.TEXTURE_2D, renderer.frameTexture);
  context.uniform1i(uniforms.sceneColor, 0);
  for (const batch of liquids) {
    const layers = batch.layerState;
    context.uniform4f(uniforms.glassState, layers[9], layers[10], layers[11], Math.min(layers[12], maximumDistance));
    context.uniform3f(uniforms.glassTint, layers[13], layers[14], layers[15]);
    const metallicRoughnessState = batch.mapState[METALLIC_ROUGHNESS_MAP_INDEX];
    context.activeTexture(context.TEXTURE0 + METALLIC_ROUGHNESS_UNIT);
    context.bindTexture(context.TEXTURE_2D, batch.textures[METALLIC_ROUGHNESS_MAP_INDEX]);
    context.uniform1f(uniforms.hasMetallicRoughnessMap, metallicRoughnessState ? 1 + (metallicRoughnessState.uvChannel ?? 0) : 0);
    if (renderer.liquidClipLocations) bindClipPlanes(renderer, batch, renderer.liquidClipLocations);
    liquidWaterSupport.bind?.(renderer, uniforms, batch);
    liquidProbeSupport.bind?.(renderer, uniforms, batch);
    context.bindVertexArray(batch.vertexArray);
    context.drawElementsInstanced(context.TRIANGLES, batch.indexCount, context.UNSIGNED_INT, 0, batch.instanceCount);
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
