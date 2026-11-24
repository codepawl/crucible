// The GLSL that reads the water mirror picture, shared by the lit program (water-reflection.js) and the liquid pass
// (liquid-shader.js), so water that transmits light and water that does not show the same reflection. This module
// imports nothing, so the liquid shader can carry it without carrying the reflection's scene code.

/** Above this roughness the mirror picture blurs with roughness: a surface this smooth is a sharp mirror. */
export const WATER_MAXIMUM_ROUGHNESS = 0.1;
/** A surface rougher than this is not water and gets no mirror. */
export const WATER_BLUR_LIMIT_ROUGHNESS = 0.5;
/** The mirror picture is sampled this many mip levels down at `WATER_BLUR_LIMIT_ROUGHNESS`. */
export const WATER_MAXIMUM_BLUR_LEVEL = 5;
/** From this roughness the mirror picture fades out to the environment's own reflection. */
export const WATER_FADE_START_ROUGHNESS = 0.35;

const RIPPLE_SLOPE = '0.012';
const RIPPLE_REACH = '0.004';
const BLUR_TAPS = 8;
const BLUR_ACROSS = '0.0015';
const BLUR_DOWN = '0.0045';

/** The uniforms the mirror lookup reads. The lit program declares them in its `declarations`, the liquid pass in its fragment shader. */
export const waterMirrorUniformsGlsl = `// 1 where the surface is standing water on wet ground: a still film that mirrors crisply (no ripple shake, four taps one pixel wide).
#define WATER_MIRROR_SHARPNESS
float waterMirrorSharpness = 0.0;
// 1 where the light under the surface is what the Fresnel reflection leaves (wet ground), 0 for a lake, which keeps its look.
float waterBedFresnelShare = 0.0;
// How much of the pixel along a puddle's edge is water (0 for a lake): the sky's glossy highlight is taken off the whole edge, not only where the mirror shows,
// or the half-wet rim of a puddle seen at a grazing angle draws a bright outline.
float waterEdgeCover = 0.0;
uniform sampler2D waterReflection;
uniform mat4 waterReflectionMatrix;
uniform vec2 waterClip;
uniform float waterReflectionEnabled;
`;

/**
 * `waterMirrorWeight(roughness)` is how much of the picture shows (1 up to 0.35, none from 0.5) and
 * `waterMirrorColor(position, roughness)` is the picture as linear light with the frame's exposure taken out. Still water is not a mirror:
 * small ripples shake the picture (more with distance) and a few taps smear it, more up and down, as ripples stretch a reflection.
 * It needs `eye`, `time`, `exposure` and `hdrEnabled` declared before it.
 */
export const waterMirrorFunctionsGlsl = `float waterMirrorWeight(float roughness) {
  return 1.0 - clamp((roughness - ${WATER_FADE_START_ROUGHNESS.toFixed(2)}) / ${(WATER_BLUR_LIMIT_ROUGHNESS - WATER_FADE_START_ROUGHNESS).toFixed(2)}, 0.0, 1.0);
}
vec3 waterMirrorColor(vec3 position, float roughness) {
  float eyeDistance = length(position - eye);
  vec2 slope = vec2(sin(position.x * 0.31 + position.z * 0.17 + time * 0.4) + 0.6 * sin(position.x * 0.83 - position.z * 0.5 - time * 0.7),
    sin(position.z * 0.27 - position.x * 0.11 + time * 0.5) + 0.6 * sin(position.z * 0.91 + position.x * 0.43 - time * 0.6)) * ${RIPPLE_SLOPE};
  vec3 shaken = position + vec3(slope.x, 0.0, slope.y) * (1.0 + eyeDistance * ${RIPPLE_REACH});
  if (waterMirrorSharpness > 0.5) shaken = position;
  vec4 mirrorClip = waterReflectionMatrix * vec4(shaken, 1.0);
  vec2 mirrorCentre = mirrorClip.xy / mirrorClip.w * 0.5 + 0.5;
  float mirrorLevel = ${WATER_MAXIMUM_BLUR_LEVEL.toFixed(1)} * clamp((roughness - ${WATER_MAXIMUM_ROUGHNESS.toFixed(2)}) / ${(WATER_BLUR_LIMIT_ROUGHNESS - WATER_MAXIMUM_ROUGHNESS).toFixed(2)}, 0.0, 1.0);
  vec3 mirrored = vec3(0.0);
  if (waterMirrorSharpness > 0.5) {
    // The target is as large as the frame and has no multisampling: four taps a third of a pixel off the centre filter its stairs.
    vec2 pixel = 1.0 / vec2(textureSize(waterReflection, 0));
    mirrored += textureLod(waterReflection, mirrorCentre + pixel * vec2(-0.35, -0.15), mirrorLevel).rgb;
    mirrored += textureLod(waterReflection, mirrorCentre + pixel * vec2(0.15, -0.35), mirrorLevel).rgb;
    mirrored += textureLod(waterReflection, mirrorCentre + pixel * vec2(0.35, 0.15), mirrorLevel).rgb;
    mirrored += textureLod(waterReflection, mirrorCentre + pixel * vec2(-0.15, 0.35), mirrorLevel).rgb;
    mirrored *= 0.25;
    return (hdrEnabled > 0.5 ? mirrored : pow(mirrored, vec3(2.2))) / max(exposure, 1e-4);
  }
  for (int tap = 0; tap < ${BLUR_TAPS}; tap++) {
    float angle = float(tap) * 2.39996;
    vec2 offset = vec2(cos(angle), sin(angle)) * sqrt((float(tap) + 0.5) / ${BLUR_TAPS}.0);
    mirrored += textureLod(waterReflection, mirrorCentre + offset * vec2(${BLUR_ACROSS}, ${BLUR_DOWN}), mirrorLevel).rgb;
  }
  mirrored /= ${BLUR_TAPS}.0;
  return (hdrEnabled > 0.5 ? mirrored : pow(mirrored, vec3(2.2))) / max(exposure, 1e-4);
}
`;
