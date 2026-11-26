import { registerShaderFeatureCode } from './shader-registry.js';

// bloom.keepHue (#3326), a step of the post pass. Plain bloom adds the glow and tone maps each channel on its own, so the strongest channel of a bright coloured part
// clips first and the colour washes toward white. Here the weakest channel of a pixel goes through the display curve as before and the colour on top of it keeps its
// channel ratio; a pixel whose strongest channel was between 0.8 and 2 before bloom blends toward keeping the whole ratio (the emissive part itself), so a lit grey base does not
// turn a neon face pastel. Only a renderer that draws a frame with keepHue needs this module; post.js leaves every other post program as it was.
const BLOOM_LINE = '  if (POST_BLOOM) color += texture(bloomTexture, textureCoordinate).rgb * bloomStrength;\n';
const TONE_LINES = '    color = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);\n    color = pow(color, vec3(1.0 / 2.2));\n';
const DECLARATIONS = `uniform float bloomKeepHue;
vec3 toneCurve(vec3 color) { return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0); }
vec3 toneKeepingHue(vec3 radiance) {
  float peak = max(radiance.r, max(radiance.g, radiance.b));
  return peak > 0.0 ? radiance * (toneCurve(vec3(peak)).x / peak) : vec3(0.0);
}
vec3 toneKeepingChroma(vec3 radiance) {
  float low = min(radiance.r, min(radiance.g, radiance.b));
  float high = max(radiance.r, max(radiance.g, radiance.b));
  vec3 position = high - low > 0.00001 ? (radiance - low) / (high - low) : vec3(0.0);
  return mix(toneCurve(vec3(low)), toneCurve(vec3(high)), position);
}
`;
// The auto exposure step scales the frame after bloom is added, so the peak that picks the emissive part is scaled the same way.
const bloomLines = hasAutoExposure => `  float sourcePeak = max(color.r, max(color.g, color.b))${hasAutoExposure ? ' * autoExposureScale' : ''};
  vec3 bloomLight = POST_BLOOM ? texture(bloomTexture, textureCoordinate).rgb * bloomStrength : vec3(0.0);
  color += bloomLight;
`;
const TONE_KEEPING_LINES = `    vec3 plainColor = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
    float bloomPeak = max(bloomLight.r, max(bloomLight.g, bloomLight.b));
    vec3 kept = mix(toneKeepingChroma(color), toneKeepingHue(color), smoothstep(0.8, 2.0, sourcePeak));
    color = pow(mix(plainColor, kept, bloomPeak / (bloomPeak + 0.02)), vec3(1.0 / 2.2));
`;

registerShaderFeatureCode('keepHue', {
  /** Swaps the bloom add and the display curve of the post main for their keepHue form; run it after the auto exposure and linear output steps. */
  post(mainBody) {
    if (!mainBody.includes(BLOOM_LINE) || !mainBody.includes(TONE_LINES)) {
      throw new Error('The post shader no longer holds the bloom and display curve lines that bloom.keepHue replaces.');
    }
    const swapped = mainBody.replace(BLOOM_LINE, bloomLines(mainBody.includes('uniform float autoExposureScale;'))).replace(TONE_LINES, TONE_KEEPING_LINES);
    return DECLARATIONS + swapped;
  },
  postStep: (renderer, frame, effects) => (effects?.bloom?.strength > 0 && effects.bloom.keepHue ? 'keepHue' : null),
});
