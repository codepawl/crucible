// How an alpha-blended part leaves the lit program. glTF says the specular of a blended dielectric is not attenuated by
// alpha: opacity fades the diffuse body and the transmitted light, and a reflection stays as strong as at full opacity.
// The program therefore writes the colour premultiplied, with the specular added at full strength, and the blend adds
// the destination scaled by one minus alpha. This module imports nothing, so the renderer and the shader can both carry it.

/** The WebGL blend factors of a blended part: source colour already holds alpha (ONE), destination fades by 1 - alpha. */
export const BLEND_FACTORS = Object.freeze({ sourceColor: 'ONE', destinationColor: 'ONE_MINUS_SRC_ALPHA', sourceAlpha: 'ONE', destinationAlpha: 'ONE_MINUS_SRC_ALPHA' });

/**
 * `blendedOutput(displayed, displayedDiffuse, alpha)` is the fragment colour: `displayed` is the whole shaded colour and
 * `displayedDiffuse` the same colour with the specular light removed. Blend mode (alphaMode 2) premultiplies only the
 * diffuse share; opaque, mask and add modes keep the plain colour, which add mode blends with SRC_ALPHA as before.
 */
export const blendOutputGlsl = `vec4 blendedOutput(vec3 displayed, vec3 displayedDiffuse, float alpha) {
  if (alphaMode > 1.5 && alphaMode < 2.5) return vec4(displayedDiffuse * alpha + (displayed - displayedDiffuse), alpha);
  return vec4(displayed, alpha);
}
`;

/** The fragment colour of a blend part, as [red, green, blue, alpha]. `coverage` is the texture alpha that scales the specular (see withBlendCoverage); 1 keeps it at full strength. */
export function blendedFragment(displayed, displayedDiffuse, alpha, coverage = 1) {
  return [0, 1, 2].map(channel => displayedDiffuse[channel] * alpha + (displayed[channel] - displayedDiffuse[channel]) * coverage).concat(alpha);
}

/** What the frame holds after a blend part draws over it with `BLEND_FACTORS`: the source plus the destination scaled by 1 - alpha. */
export function compositeBlended(destination, fragment) {
  return [0, 1, 2].map(channel => fragment[channel] + destination[channel] * (1 - fragment[3]));
}

const BLEND_OUTPUT_OLD = 'vec4 blendedOutput(vec3 displayed, vec3 displayedDiffuse, float alpha) {\n  if (alphaMode > 1.5 && alphaMode < 2.5) return vec4(displayedDiffuse * alpha + (displayed - displayedDiffuse), alpha);';
const BLEND_OUTPUT_NEW = 'vec4 blendedOutput(vec3 displayed, vec3 displayedDiffuse, float alpha, float coverage) {\n  if (alphaMode > 1.5 && alphaMode < 2.5) return vec4(displayedDiffuse * alpha + (displayed - displayedDiffuse) * coverage, alpha);';
const BLEND_CALLS = [
  ['blendedOutput(unlitColor, unlitColor, alpha)', 'blendedOutput(unlitColor, unlitColor, alpha, 1.0)'],
  ['blendedOutput(displayedColor, displayedDiffuse, alpha)', 'blendedOutput(displayedColor, displayedDiffuse, alpha, clamp(textureAlpha, 0.0, 1.0))'],
];

/**
 * The lit fragment source of a shader that draws a blend part (#3110). The specular of a blended dielectric stays at full
 * strength, as for glass, but a texel the colour map leaves transparent has nothing to reflect: the specular share is
 * scaled by the texture alpha (`coverage`), so a card cut out of a leaf picture shows no reflective rectangle. Only shaders
 * with the alphaMode feature take this; every other shader keeps its source byte for byte.
 */
export function withBlendCoverage(source) {
  let patched = source;
  for (const [before, after] of [[BLEND_OUTPUT_OLD, BLEND_OUTPUT_NEW], ...BLEND_CALLS]) {
    if (!patched.includes(before)) throw new Error(`withBlendCoverage: the fragment source no longer contains "${before.slice(0, 48)}...". Update blend-output.js to match shaders.js.`);
    patched = patched.replace(before, after);
  }
  return patched;
}
