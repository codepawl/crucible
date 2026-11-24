// How rough glass blurs what it refracts. The liquid pass samples a mip chain of the opaque scene at a level that grows with the
// microfacet width of the surface, alpha = roughness squared, as the path tracer's GGX lobe does: a rougher surface scatters the transmitted
// light over a wider cone, and a higher index of refraction widens that cone. (A linear roughness, as three.js uses for
// KHR_materials_transmission, blurred a glTF cornea of roughness 0.08 by a whole mip, where the tracer shows it sharp.) The GLSL below is built from the same constants as the JavaScript
// reference, so a test of the reference covers the shader.

/** The index of refraction at which roughness blurs fully: 1.5 glass, so 1 gives no blur and 1.5 or more gives the full blur. */
export const BLUR_IOR_START = 1;
export const BLUR_IOR_FULL = 1.5;

/** The liquid shader clamps roughness to 0.02 to 1 before it reads it. */
const MINIMUM_ROUGHNESS = 0.02;

/** A mip level below this is the sharp image to within a quarter of a texel, so no mip chain is built for it. */
export const MINIMUM_BLUR_LEVEL = 0.25;

/** The share of the roughness that reaches the blur at this index of refraction, 0 to 1. */
export function iorBlurShare(indexOfRefraction) {
  const share = (indexOfRefraction - BLUR_IOR_START) / (BLUR_IOR_FULL - BLUR_IOR_START);
  return Math.min(Math.max(share, 0), 1);
}

/** The mip level of the opaque scene that a transmissive fragment samples: log2 of the larger side at full blur. */
export function transmissionBlurLevel(roughness, indexOfRefraction, width, height) {
  const shaderRoughness = Math.min(Math.max(roughness, MINIMUM_ROUGHNESS), 1);
  return Math.log2(Math.max(width, height, 1)) * shaderRoughness * shaderRoughness * iorBlurShare(indexOfRefraction);
}

/** The number of levels in a full mip chain of a width by height image. */
export function mipLevelCount(width, height) {
  return Math.floor(Math.log2(Math.max(width, height, 1))) + 1;
}

/** Whether any glass part of a batch list is rough enough to need the scene's mip chain at this size. */
export function batchesNeedRefractionMips(batches, width, height) {
  return batches.some(batch => batch.layerState[9] > 0 && batch.parts.some(part => {
    const indexOfRefraction = batch.layerState[10];
    return transmissionBlurLevel(part.material.roughness, indexOfRefraction, width, height) >= MINIMUM_BLUR_LEVEL;
  }));
}

export const transmissionBlurGlsl = `
float transmissionBlurLevel(float roughness, float indexOfRefraction, vec2 size) {
  float share = clamp((indexOfRefraction - ${BLUR_IOR_START.toFixed(1)}) / ${(BLUR_IOR_FULL - BLUR_IOR_START).toFixed(1)}, 0.0, 1.0);
  return log2(max(max(size.x, size.y), 1.0)) * roughness * roughness * share;
}
`;
