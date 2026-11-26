import { bloomPyramidSupport } from './shader-registry.js';

export const MAX_BLOOM_LEVELS = 6;
export const BLOOM_SCATTER = 0.62;
const BLOOM_UNIFORM_NAMES = ['sourceTexture', 'texelSize', 'threshold', 'passMode', 'mixWeight'];

export const bloomPyramidFragment = `#version 300 es
precision highp float;
in vec2 textureCoordinate;
uniform sampler2D sourceTexture;
uniform vec2 texelSize;
uniform float threshold;
uniform float passMode;
uniform float mixWeight;
out vec4 outputColor;

vec3 sampleTap(vec2 offset) {
  vec3 color = texture(sourceTexture, textureCoordinate + offset * texelSize).rgb;
  if (passMode < 0.5) {
    float peak = max(color.r, max(color.g, color.b));
    color *= max(peak - threshold, 0.0) / max(peak, 0.00001);
  }
  return color;
}

float karisWeight(vec3 color) {
  return 1.0 / (1.0 + max(color.r, max(color.g, color.b)));
}

void main() {
  if (passMode > 1.5) {
    vec3 tent = sampleTap(vec2(-1.0, 1.0)) + sampleTap(vec2(1.0, 1.0))
      + sampleTap(vec2(-1.0, -1.0)) + sampleTap(vec2(1.0, -1.0))
      + (sampleTap(vec2(0.0, 1.0)) + sampleTap(vec2(-1.0, 0.0)) + sampleTap(vec2(1.0, 0.0)) + sampleTap(vec2(0.0, -1.0))) * 2.0
      + sampleTap(vec2(0.0, 0.0)) * 4.0;
    outputColor = vec4(tent * 0.0625, mixWeight);
    return;
  }
  vec3 northWest = sampleTap(vec2(-2.0, 2.0));
  vec3 north = sampleTap(vec2(0.0, 2.0));
  vec3 northEast = sampleTap(vec2(2.0, 2.0));
  vec3 innerNorthWest = sampleTap(vec2(-1.0, 1.0));
  vec3 innerNorthEast = sampleTap(vec2(1.0, 1.0));
  vec3 west = sampleTap(vec2(-2.0, 0.0));
  vec3 center = sampleTap(vec2(0.0, 0.0));
  vec3 east = sampleTap(vec2(2.0, 0.0));
  vec3 innerSouthWest = sampleTap(vec2(-1.0, -1.0));
  vec3 innerSouthEast = sampleTap(vec2(1.0, -1.0));
  vec3 southWest = sampleTap(vec2(-2.0, -2.0));
  vec3 south = sampleTap(vec2(0.0, -2.0));
  vec3 southEast = sampleTap(vec2(2.0, -2.0));
  vec3 centerBox = (innerNorthWest + innerNorthEast + innerSouthWest + innerSouthEast) * 0.25;
  vec3 topLeftBox = (northWest + north + west + center) * 0.25;
  vec3 topRightBox = (north + northEast + center + east) * 0.25;
  vec3 bottomLeftBox = (west + center + southWest + south) * 0.25;
  vec3 bottomRightBox = (center + east + south + southEast) * 0.25;
  if (passMode < 0.5) {
    float weightCenter = 0.5 * karisWeight(centerBox);
    float weightTopLeft = 0.125 * karisWeight(topLeftBox);
    float weightTopRight = 0.125 * karisWeight(topRightBox);
    float weightBottomLeft = 0.125 * karisWeight(bottomLeftBox);
    float weightBottomRight = 0.125 * karisWeight(bottomRightBox);
    float weightSum = weightCenter + weightTopLeft + weightTopRight + weightBottomLeft + weightBottomRight;
    vec3 weighted = centerBox * weightCenter + topLeftBox * weightTopLeft + topRightBox * weightTopRight
      + bottomLeftBox * weightBottomLeft + bottomRightBox * weightBottomRight;
    outputColor = vec4(weighted / max(weightSum, 0.00001), 1.0);
    return;
  }
  vec3 averaged = centerBox * 0.5 + (topLeftBox + topRightBox + bottomLeftBox + bottomRightBox) * 0.125;
  outputColor = vec4(averaged, 1.0);
}`;

/** Dimensions of each mip level in the bloom pyramid, starting from the half-resolution target. */
export function bloomMipDimensions(baseWidth, baseHeight, maximumLevels = MAX_BLOOM_LEVELS) {
  const levels = [];
  let width = Math.max(1, Math.floor(baseWidth));
  let height = Math.max(1, Math.floor(baseHeight));
  while (levels.length < maximumLevels) {
    levels.push({ width, height });
    const nextWidth = Math.floor(width / 2);
    const nextHeight = Math.floor(height / 2);
    if (nextWidth < 2 || nextHeight < 2) break;
    width = nextWidth;
    height = nextHeight;
  }
  return levels;
}

/** Downsample count and per-level upsample weights so radius 0.1 to 16 scales continuously without stepping. */
export function bloomPyramidPlan(levelCount, radius) {
  if (levelCount <= 1) return { activeLevels: 1, upsampleWeights: [] };
  const depth = Math.min(levelCount - 1, Math.max(0.05, Math.log2(1 + radius * 1.9375)));
  const activeLevels = Math.min(levelCount, Math.ceil(depth) + 1);
  const upsampleWeights = [];
  for (let level = activeLevels - 2; level >= 0; level--) {
    const span = Math.min(1, Math.max(0, depth - level));
    upsampleWeights.push({ level, mixWeight: BLOOM_SCATTER * span });
  }
  return { activeLevels, upsampleWeights };
}

export function bloomUniformLocations(context, program) {
  return Object.fromEntries(BLOOM_UNIFORM_NAMES.map(name => [name, context.getUniformLocation(program, name)]));
}

export function ensureBloomPyramidTargets(renderer, compileProgram, fullscreenVertex) {
  const context = renderer.context;
  if (!renderer.bloomProgram && compileProgram) {
    renderer.bloomProgram = compileProgram(context, fullscreenVertex, bloomPyramidFragment);
    renderer.bloomUniforms = bloomUniformLocations(context, renderer.bloomProgram);
  }
  if (renderer.bloomTargets.length > 0) return;
  const formatName = renderer.hdr ? 'RGBA16F' : 'RGBA8';
  const internalFormat = renderer.hdr ? context.RGBA16F : context.RGBA8;
  const pixelType = renderer.hdr ? context.HALF_FLOAT : context.UNSIGNED_BYTE;
  const dimensions = bloomMipDimensions(renderer.bloomWidth, renderer.bloomHeight);
  for (let level = 0; level < dimensions.length; level++) {
    const { width, height } = dimensions[level];
    const texture = context.createTexture();
    const framebuffer = context.createFramebuffer();
    renderer.bloomTargets.push({ texture, framebuffer, width, height });
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texImage2D(context.TEXTURE_2D, 0, internalFormat, width, height, 0, context.RGBA, pixelType, null);
    renderer.backend?.setClampedFiltering(context.LINEAR);
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
      throw new Error('Bloom framebuffer allocation failed. Choose a lower quality preset.');
    }
    renderer.renderTargets.record(`bloom${level}`, { width, height, format: formatName });
  }
  context.bindFramebuffer(context.FRAMEBUFFER, null);
}

export function releaseBloomPyramidTargets(renderer) {
  const context = renderer.context;
  const targets = renderer.bloomTargets ?? [];
  for (let level = 0; level < targets.length; level++) {
    context.deleteTexture(targets[level].texture);
    context.deleteFramebuffer(targets[level].framebuffer);
    renderer.renderTargets.release(`bloom${level}`);
  }
  renderer.bloomTargets = [];
}

export function drawBloomPyramid(renderer, bloom, sourceTexture = renderer.frameTexture) {
  const context = renderer.context;
  renderer.ensureBloomTargets();
  const targets = renderer.bloomTargets;
  const uniforms = renderer.bloomUniforms;
  const sourceWidth = renderer.canvas?.width || renderer.bloomWidth * 2;
  const sourceHeight = renderer.canvas?.height || renderer.bloomHeight * 2;
  const { activeLevels, upsampleWeights } = bloomPyramidPlan(targets.length, bloom.radius);
  context.disable(context.DEPTH_TEST);
  context.disable(context.CULL_FACE);
  context.bindVertexArray(null);
  context.useProgram(renderer.bloomProgram);
  context.activeTexture(context.TEXTURE0);
  context.uniform1i(uniforms.sourceTexture, 0);
  context.uniform1f(uniforms.threshold, bloom.threshold);
  context.uniform1f(uniforms.mixWeight, 1);
  for (let level = 0; level < activeLevels; level++) {
    const target = targets[level];
    const inputWidth = level === 0 ? sourceWidth : targets[level - 1].width;
    const inputHeight = level === 0 ? sourceHeight : targets[level - 1].height;
    context.bindFramebuffer(context.FRAMEBUFFER, target.framebuffer);
    context.viewport(0, 0, target.width, target.height);
    context.bindTexture(context.TEXTURE_2D, level === 0 ? sourceTexture : targets[level - 1].texture);
    context.uniform1f(uniforms.passMode, level === 0 ? 0 : 1);
    context.uniform2f(uniforms.texelSize, 1 / inputWidth, 1 / inputHeight);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }
  if (upsampleWeights.length === 0) return;
  context.enable(context.BLEND);
  context.blendFuncSeparate(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA, context.ZERO, context.ONE);
  context.uniform1f(uniforms.passMode, 2);
  for (const { level, mixWeight } of upsampleWeights) {
    const target = targets[level];
    const source = targets[level + 1];
    context.bindFramebuffer(context.FRAMEBUFFER, target.framebuffer);
    context.viewport(0, 0, target.width, target.height);
    context.bindTexture(context.TEXTURE_2D, source.texture);
    context.uniform2f(uniforms.texelSize, 1 / source.width, 1 / source.height);
    context.uniform1f(uniforms.mixWeight, mixWeight);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }
  context.disable(context.BLEND);
}

Object.assign(bloomPyramidSupport, {
  ensureTargets: ensureBloomPyramidTargets,
  releaseTargets: releaseBloomPyramidTargets,
  draw: drawBloomPyramid,
});
