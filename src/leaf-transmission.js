// Sun through leaves for the foliage tag (issue #2991). A leaf is thin, so sun on its back face reaches the eye through it,
// filtered to a warmer, yellower green, and most of all when looking toward the sun: a tree with the sun behind it glows from
// every leaf the light has crossed, and a tree lit from the side does not. Sun that was stopped by the crown's own shadow still
// reaches a leaf through the leaves above it, in the share `LEAF_THROUGH_CROWN`, and the leaf's vertex colour (darker and cooler
// deep in the crown, baked at build time) sets how much of it shows, so the glow fades toward the crown's centre. A leaf in
// shade also keeps a little sun that passed through the leaves above it, so the inside reads as dim green, not black.
// No extra pass: one term on the sun, added to shaders that draw foliage. The vegetation addon imports this module, so a
// scene without trees carries none of it.
import { shaderTransforms } from './shader-registry.js';

const FOLIAGE_ENABLED = '#define TAG_FOLIAGE (surface.w == 4.0)';
const SUN_LINE = /\n  vec3 radiance = illuminate\(normal, viewDirection, normalize\(lightDirection\), keyColor \* visibility \* shadowTint([^,]*), color, metallic, roughness\);/;
const DEFINITION_ANCHOR = '\nvec3 toneMap(vec3 color) {';
// The sun's shadow test of `shadowVisibility`: a leaf card is thin and its shading normal is the crown's, not its own, so at the
// usual bias the sunlit flank of a crown shadows itself in specks. A foliage shader takes a larger bias; a leaf is a few
// millimetres thick, so nothing floats off its shadow.
const SHADOW_BIAS_LINE = '  float bias = shadowBiasPerSlope * clamp(sqrt(1.0 - cosine * cosine) / cosine, 0.25, 4.0);';
// The sun's specular lobe in `illuminate`: it is white and not tinted by the leaf, so a card whose rounded normal bisects the
// view and the sun (the top of a crown seen toward the sun) added a pale, see-through wash that no leaf colour could bound. With
// the larger shadow bias above the self-shadow no longer hides it. Leaves are matte: a foliage shader keeps a small share.
const SPECULAR_LINE = '  specular *= directSpecularGain;';
/** The share of the sun's specular a foliage shader keeps (measured: 1 gave pale ghost clumps beside the sun, #2991). */
export const FOLIAGE_SUN_SPECULAR_SCALE = 0.08;
// Sky and ambient in the shade of the crown. The baked sky visibility goes close to zero deep in the crown and, with the dark core
// colour, left the shadow side near black and the trunk merging into it. A foliage shader never takes less than this share.
const OCCLUSION_LINE = '  occlusion *= splatCavity * vertexSkyVisibility;';
/** The least sky visibility a foliage shader uses (measured: the 10th percentile leaf at 8 m rose from 31 to the photos' 37, #2991). */
export const FOLIAGE_MIN_SKY_VISIBILITY = 0.4;
// Bright leaves in a photo are pale and grey-green (saturation 0.15 to 0.30), not lime (0.65 and over): sky and haze on the leaf
// and the camera's highlight roll-off take the colour out of the bright end. A foliage shader rolls highlights toward grey.
const HIGHLIGHT_ANCHOR = '  if (USES_SHEEN) radiance = sheenLayer(';
export const FOLIAGE_HIGHLIGHT_ROLL_OFF = Object.freeze({ start: 0.1, end: 0.6, amount: 0.9 });
/** How many times the usual shadow bias a foliage shader uses for the sun (measured: the sunlit half of an oak crown gains 15 percent). */
export const FOLIAGE_SHADOW_BIAS_SCALE = 8;

/** The numbers of the term; the shader and `leafTransmissionReference` both read them. */
export const LEAF_TRANSMISSION_PARAMETERS = Object.freeze({
  strength: 0.8,
  throughCrown: 0.25,
  shadeGlow: 0.015,
  behindWeight: 0.3,
  towardSunWeight: 0.7,
  towardSunSharpness: 3.0,
  towardSunFloor: 0.35,
  saturationBoost: 1.0,
  filter: Object.freeze([1.35, 1.0, 0.6]),
  rimWeight: 0.35,
  rimSharpness: 2.5,
  glowGreyShare: 0.35,
});

const { strength, throughCrown, shadeGlow, behindWeight, towardSunWeight, towardSunSharpness, towardSunFloor, saturationBoost, filter, rimWeight, rimSharpness, glowGreyShare } = LEAF_TRANSMISSION_PARAMETERS;
const glslFloat = value => (Number.isInteger(value) ? `${value}.0` : String(value));

const LEAF_TRANSMISSION_CODE = `
const float LEAF_TRANSMISSION = ${glslFloat(strength)};
const float LEAF_THROUGH_CROWN = ${glslFloat(throughCrown)};
const float LEAF_SHADE_GLOW = ${glslFloat(shadeGlow)};
vec3 leafTransmission(vec3 normal, vec3 viewDirection, vec3 lightDirection, vec3 sunColor, float visibility, vec3 color) {
  float behind = max(-dot(normal, lightDirection), 0.0);
  float towardSun = pow(max(dot(-viewDirection, lightDirection), 0.0), ${glslFloat(towardSunSharpness)});
  vec3 filtered = max(mix(vec3(dot(color, vec3(0.3, 0.59, 0.11))), color, ${glslFloat(saturationBoost)}), vec3(0.0)) * vec3(${filter.map(glslFloat).join(', ')});
  float reach = mix(LEAF_THROUGH_CROWN, 1.0, visibility);
  float rim = pow(1.0 - abs(dot(normal, viewDirection)), ${glslFloat(rimSharpness)});
  float glow = ${glslFloat(behindWeight)} * behind + ${glslFloat(towardSunWeight)} * towardSun * (${glslFloat(towardSunFloor)} + ${glslFloat(1 - towardSunFloor)} * behind + ${glslFloat(rimWeight)} * rim);
  vec3 glowColor = filtered * sunColor * (reach * LEAF_TRANSMISSION * glow + (1.0 - visibility) * LEAF_SHADE_GLOW);
  return mix(glowColor, vec3(dot(glowColor, vec3(0.2126, 0.7152, 0.0722))), ${glslFloat(glowGreyShare)});
}
`;

/**
 * The same arithmetic as the shader on plain numbers (unit vectors, `visibility` in [0, 1]), for tests and for reading what the
 * term does: how much of the sun colour, filtered by the leaf, reaches the eye.
 */
export function leafTransmissionReference({ normal, viewDirection, lightDirection, visibility, color }) {
  const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  const behind = Math.max(-dot(normal, lightDirection), 0);
  const towardSun = Math.max(-dot(viewDirection, lightDirection), 0) ** towardSunSharpness;
  const gray = color[0] * 0.3 + color[1] * 0.59 + color[2] * 0.11;
  const reach = throughCrown + (1 - throughCrown) * visibility;
  const rim = (1 - Math.abs(dot(normal, viewDirection))) ** rimSharpness;
  const glow = behindWeight * behind + towardSunWeight * towardSun * (towardSunFloor + (1 - towardSunFloor) * behind + rimWeight * rim);
  const glowColor = color.map((channel, index) => Math.max(gray + (channel - gray) * saturationBoost, 0) * filter[index] * (reach * strength * glow + (1 - visibility) * shadeGlow));
  const glowGray = glowColor[0] * 0.2126 + glowColor[1] * 0.7152 + glowColor[2] * 0.0722;
  return glowColor.map(channel => channel + (glowGray - channel) * glowGreyShare);
}

/** The sky visibility a foliage shader uses: the baked value in sun, lifted to the floor only as the sun is blocked (`sunVisibility` 0 in shadow, 1 in sun). */
export function foliageSkyVisibilityReference(bakedVisibility, sunVisibility) {
  const floored = Math.max(bakedVisibility, FOLIAGE_MIN_SKY_VISIBILITY);
  return bakedVisibility + (floored - bakedVisibility) * (1 - sunVisibility);
}

/** The roll-off of `FOLIAGE_HIGHLIGHT_ROLL_OFF` on plain linear RGB: bright radiance moves toward its own luminance. */
export function foliageHighlightRollOffReference(radiance) {
  const { start, end, amount } = FOLIAGE_HIGHLIGHT_ROLL_OFF;
  const luminance = radiance[0] * 0.2126 + radiance[1] * 0.7152 + radiance[2] * 0.0722;
  const position = Math.min(Math.max((luminance - start) / (end - start), 0), 1);
  const share = amount * position * position * (3 - 2 * position);
  return radiance.map(channel => channel + (luminance - channel) * share);
}

/**
 * The sun's specular term of `illuminate` (GGX, Smith, Schlick Fresnel at 4 percent) on plain numbers for a foliage shader:
 * the largest value over every normal, in units of the sun's radiance, for `roughness`. Tests bound it against the diffuse
 * light of the same leaf, which is what the white wash of a ghost clump came from.
 */
export function foliageSunSpecularPeak({ viewDirection, lightDirection, roughness, scale = FOLIAGE_SUN_SPECULAR_SCALE }) {
  const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  const halfway = [0, 1, 2].map(axis => viewDirection[axis] + lightDirection[axis]);
  const halfLength = Math.hypot(...halfway);
  const unitHalf = halfway.map(value => value / halfLength);
  const alpha = roughness * roughness;
  const distribution = alpha * alpha / (Math.PI * ((alpha * alpha - 1) + 1) ** 2);
  const fresnel = 0.04 + 0.96 * (1 - dot(unitHalf, viewDirection)) ** 5;
  const normalLight = dot(unitHalf, lightDirection);
  const masking = (roughness + 1) ** 2 / 8;
  const geometry = (normalLight / (normalLight * (1 - masking) + masking)) ** 2;
  return distribution * geometry * fresnel / Math.max(4 * normalLight * normalLight, 0.001) * normalLight * scale;
}

/** Adds leaf transmission to a fragment shader that draws foliage; every other source passes through unchanged. */
export function addLeafTransmission(source) {
  if (!source.includes(FOLIAGE_ENABLED) || !source.includes(DEFINITION_ANCHOR) || !SUN_LINE.test(source)) return source;
  const withBias = source.replace(SHADOW_BIAS_LINE, () => `${SHADOW_BIAS_LINE.slice(0, -1)} * ${glslFloat(FOLIAGE_SHADOW_BIAS_SCALE)};`);
  const withSpecular = withBias.replace(SPECULAR_LINE, () => `${SPECULAR_LINE} if (TAG_FOLIAGE) specular *= ${glslFloat(FOLIAGE_SUN_SPECULAR_SCALE)};`);
  const withOcclusion = withSpecular.replace(OCCLUSION_LINE, () => `  occlusion *= splatCavity * (TAG_FOLIAGE ? mix(vertexSkyVisibility, max(vertexSkyVisibility, ${glslFloat(FOLIAGE_MIN_SKY_VISIBILITY)}), 1.0 - visibility) : vertexSkyVisibility);`);
  const { start, end, amount } = FOLIAGE_HIGHLIGHT_ROLL_OFF;
  // The glow is added after the roll-off: the roll-off moves bright radiance toward grey, and a glow that went through it came out milky.
  const sunLink = SUN_LINE.exec(source)[1];
  const withRollOff = withOcclusion.replace(HIGHLIGHT_ANCHOR, () => `  if (TAG_FOLIAGE) radiance = mix(radiance, vec3(dot(radiance, vec3(0.2126, 0.7152, 0.0722))), ${glslFloat(amount)} * smoothstep(${glslFloat(start)}, ${glslFloat(end)}, dot(radiance, vec3(0.2126, 0.7152, 0.0722))));
  if (TAG_FOLIAGE) radiance += leafTransmission(normal, viewDirection, normalize(lightDirection), keyColor * shadowTint${sunLink}, visibility, color);
${HIGHLIGHT_ANCHOR}`);
  const withDefinition = withRollOff.replace(DEFINITION_ANCHOR, () => LEAF_TRANSMISSION_CODE + DEFINITION_ANCHOR);
  return withDefinition;
}

shaderTransforms.push(addLeafTransmission);
