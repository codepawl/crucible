import { postStepSupport } from './shader-registry.js';
import { resolveAutoExposure } from './auto-exposure.js';
import './bloom-keep-hue.js';
import { createStage, createTarget, sharedFragmentHeader } from './camera-effects.js';
import { compileProgram, fullscreenVertex } from './gl-program.js';
import { numberInRange, groupOf, onlyKeys, triple } from './post-fields.js';
import { resolveDistortion, resolveFlash, createDistortionStage, createFlashStage } from './post-air.js';
import { resolveMask, usesObjectMask, maskShader, bindMask, unbindMask, MASK_UNIFORM_NAMES } from './post-mask.js';

export { usesObjectMask };
export { placeAirSteps, checkAirStepNodes } from './post-air.js';

// Named post steps for a graded film: color balance (lift, gamma, gain), glare (streaks and fog glow), lens distortion with
// dispersion, stylize filters (sharpen, kuwahara, posterize, pixelate) and composite (a chroma or luma key over a background).
// Color balance, stylize and composite take a `mask` (post-mask.js) that limits them to named parts or a range of distance. They are optional full-frame stages. The core renderer carries none of their code: a recipe that names one
// loads this module (agent-scene-modules.js), and each stage compiles only on the first frame that turns it on. Defocus from
// depth is the `depthOfField` group of camera-effects.js, which is the same step under its older name.
//
// All of them are deterministic: fixed sample patterns and no history, so a seek repeats the same pixels.

const MAXIMUM_STREAK_ARMS = 8;
const STREAK_STEPS = 24;
const FOG_SAMPLES = 32;
const MAXIMUM_KUWAHARA_RADIUS = 8;
// Longest lateral color offset at the image corner at full dispersion, as a fraction of the distance from the center.
const MAXIMUM_DISPERSION = 0.03;

// Local tone mapping works on the blur of the frame at a radius that is a fraction of its height; the taps read a mip level, so the cost does not grow with the radius.
const LOCAL_TONE_TAPS = 24;
const LOCAL_TONE_PIVOT = 0.18;
// The most the base of a shadow is lifted, in natural-log units (2 stops), so deep blacks stay black.
const LOCAL_TONE_MAXIMUM_LIFT = 1.386;
// How round the knee between the untouched midtones and the compressed tail is, in squared natural-log units; the shader and localToneMappedLog read the same number.
const LOCAL_TONE_KNEE_SOFTNESS = 0.04;

const NEUTRAL = Object.freeze({ lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1] });

function resolveColorBalance(input) {
  const group = groupOf(input, 'colorBalance');
  onlyKeys(group, ['lift', 'gamma', 'gain', 'mask'], 'colorBalance');
  return {
    lift: triple(group.lift, NEUTRAL.lift, -1, 1, 'colorBalance.lift'),
    gamma: triple(group.gamma, NEUTRAL.gamma, 0.1, 4, 'colorBalance.gamma'),
    gain: triple(group.gain, NEUTRAL.gain, 0, 4, 'colorBalance.gain'),
    ...(group.mask === undefined ? {} : { mask: resolveMask(group.mask, 'colorBalance.mask') }),
  };
}

// effects.colorCorrection: a four-control grade with no LUT file, in the order of Roblox's ColorCorrectionEffect. It is the identity at its defaults, and a frame
// that leaves every control there skips the stage, so the picture is the one it was without the step.
const COLOR_CORRECTION_FIELDS = ['brightness', 'contrast', 'saturation', 'tint'];
const COLOR_CORRECTION_RANGES = Object.freeze({
  brightness: [-1, 1, 'stops of two: 0 leaves the frame, 0.5 doubles it, -0.5 halves it, such as 0.25'],
  contrast: [-1, 1, '0 leaves the frame, 1 doubles the steepness around middle grey, -1 flattens it to grey, such as 0.2'],
  saturation: [-1, 1, '0 leaves the colour, -1 is greyscale, 1 doubles the saturation, such as -0.3'],
});
const NEUTRAL_COLOR_CORRECTION = Object.freeze({ brightness: 0, contrast: 0, saturation: 0, tint: [1, 1, 1] });
const COLOR_CORRECTION_MIDDLE_GREY = 0.18;

function colorCorrectionError(name, value, accepted) {
  return new RangeError(`effects.colorCorrection.${name} is ${JSON.stringify(value)}: pass ${accepted}.`);
}

function resolveColorCorrection(input) {
  const group = groupOf(input, 'colorCorrection');
  const unknown = Object.keys(group).find(key => !COLOR_CORRECTION_FIELDS.includes(key));
  if (unknown !== undefined) {
    throw colorCorrectionError(unknown, group[unknown], `one of the fields ${COLOR_CORRECTION_FIELDS.join(', ')}`);
  }
  const resolved = {};
  for (const [name, [minimum, maximum, example]] of Object.entries(COLOR_CORRECTION_RANGES)) {
    const value = group[name] ?? NEUTRAL_COLOR_CORRECTION[name];
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw colorCorrectionError(name, value, `a number from ${minimum} to ${maximum}, ${example}`);
    }
    resolved[name] = value;
  }
  const tint = group.tint ?? NEUTRAL_COLOR_CORRECTION.tint;
  if (!Array.isArray(tint) || tint.length !== 3 || tint.some(component => !Number.isFinite(component) || component < 0 || component > 4)) {
    throw colorCorrectionError('tint', tint, 'three numbers from 0 to 4 that multiply red, green and blue, such as [1, 0.9, 0.8] for a warm tint; [1, 1, 1] leaves the colour');
  }
  resolved.tint = [...tint];
  return resolved;
}

// effects.sunRays: a screen-space radial shaft pass (#3235). Each pixel marches toward the sun's screen position and counts how many
// samples see open sky in the depth buffer, so a tree, a mast or a wall in front of the sun breaks the glow into beams. It adds the key
// light's colour scaled by that share, strongest near the sun. Fixed sample count and a fixed per-pixel offset: no history, so a seek repeats.
const SUN_RAY_SAMPLES = 24;
const SUN_RAY_FIELDS = ['intensity', 'spread'];
const SUN_RAY_RANGES = Object.freeze({
  intensity: [0, 4, 'how much light the rays add, 0 for none, such as 0.25', 0.25],
  spread: [0, 1, 'how far the rays reach from the sun, 0 short and tight to 1 across the frame, such as 0.6', 1],
});

function resolveSunRays(input) {
  const group = groupOf(input, 'sunRays');
  const unknown = Object.keys(group).find(key => !SUN_RAY_FIELDS.includes(key));
  if (unknown !== undefined) {
    throw new RangeError(`effects.sunRays.${unknown} is ${JSON.stringify(group[unknown])}: pass one of the fields ${SUN_RAY_FIELDS.join(', ')}.`);
  }
  const resolved = {};
  for (const [name, [minimum, maximum, example, fallback]] of Object.entries(SUN_RAY_RANGES)) {
    const value = group[name] ?? fallback;
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new RangeError(`effects.sunRays.${name} is ${JSON.stringify(value)}: pass a number from ${minimum} to ${maximum}, ${example}.`);
    }
    resolved[name] = value;
  }
  return resolved;
}

function wholeNumberInRange(value, minimum, maximum, name) {
  const result = numberInRange(value, undefined, minimum, maximum, name);
  if (!Number.isInteger(result)) throw new RangeError(`${name} must be a whole number.`);
  return result;
}

// Each filter is off until named; a filter named with a number turns on.
function resolveStylize(input) {
  const group = groupOf(input, 'stylize');
  onlyKeys(group, ['sharpen', 'kuwahara', 'posterize', 'pixelate', 'mask'], 'stylize');
  const resolved = {};
  if (group.sharpen !== undefined) resolved.sharpen = numberInRange(group.sharpen, undefined, 0, 2, 'stylize.sharpen');
  if (group.kuwahara !== undefined) resolved.kuwahara = wholeNumberInRange(group.kuwahara, 0, MAXIMUM_KUWAHARA_RADIUS, 'stylize.kuwahara');
  if (group.posterize !== undefined) resolved.posterize = wholeNumberInRange(group.posterize, 0, 256, 'stylize.posterize');
  if (group.pixelate !== undefined) resolved.pixelate = wholeNumberInRange(group.pixelate, 0, 64, 'stylize.pixelate');
  if (group.mask !== undefined) resolved.mask = resolveMask(group.mask, 'stylize.mask');
  return resolved;
}

const MAXIMUM_LIGHT = 64;
const CHROMA_DISTANCE_SCALE = 0.7;

function backgroundColor(value, name) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${name} must be three numbers.`);
  return triple(value, [0, 0, 0], 0, MAXIMUM_LIGHT, name);
}

function resolveBackground(input) {
  const group = groupOf(input, 'composite.background');
  onlyKeys(group, ['color', 'top', 'bottom'], 'composite.background');
  if (group.color !== undefined) {
    if (group.top !== undefined || group.bottom !== undefined) throw new TypeError('composite.background takes color, or top and bottom, not both. Fix: pass one of them.');
    return { color: backgroundColor(group.color, 'composite.background.color') };
  }
  if (group.top === undefined || group.bottom === undefined) {
    throw new TypeError('composite.background needs color, or both top and bottom. Fix: { "color": [0.1, 0.3, 0.8] } or { "top": [..], "bottom": [..] }.');
  }
  return { top: backgroundColor(group.top, 'composite.background.top'), bottom: backgroundColor(group.bottom, 'composite.background.bottom') };
}

function resolveKey(input) {
  const group = groupOf(input, 'composite.key');
  onlyKeys(group, ['chroma', 'luma'], 'composite.key');
  if ((group.chroma === undefined) === (group.luma === undefined)) {
    throw new TypeError('composite.key needs exactly one of chroma ({ color, tolerance, softness }) or luma ({ low, high, invert }).');
  }
  if (group.chroma !== undefined) {
    const chroma = groupOf(group.chroma, 'composite.key.chroma');
    onlyKeys(chroma, ['color', 'tolerance', 'softness'], 'composite.key.chroma');
    return {
      chroma: {
        color: backgroundColor(chroma.color, 'composite.key.chroma.color'),
        tolerance: numberInRange(chroma.tolerance, 0.3, 0, 1, 'composite.key.chroma.tolerance'),
        softness: numberInRange(chroma.softness, 0.1, 0, 1, 'composite.key.chroma.softness'),
      },
    };
  }
  const luma = groupOf(group.luma, 'composite.key.luma');
  onlyKeys(luma, ['low', 'high', 'invert'], 'composite.key.luma');
  const low = numberInRange(luma.low, 0, 0, 10, 'composite.key.luma.low');
  const high = numberInRange(luma.high, 1, 0, 10, 'composite.key.luma.high');
  if (high <= low) throw new RangeError('composite.key.luma.high must be greater than low. Fix: luma is linear scene light, 0.18 is middle grey.');
  if (luma.invert !== undefined && typeof luma.invert !== 'boolean') throw new TypeError('composite.key.luma.invert must be true or false.');
  return { luma: { low, high, invert: luma.invert === true } };
}

// A key turns pixels transparent; the background is what shows through, so a key without one has nothing to show.
function resolveComposite(input) {
  const group = groupOf(input, 'composite');
  onlyKeys(group, ['background', 'key', 'mask'], 'composite');
  const resolved = {};
  if (group.background !== undefined) resolved.background = resolveBackground(group.background);
  if (group.key !== undefined) resolved.key = resolveKey(group.key);
  if (group.mask !== undefined) resolved.mask = resolveMask(group.mask, 'composite.mask');
  if (resolved.key && !resolved.background) throw new TypeError('composite.key needs composite.background to show through the keyed pixels. Fix: add background { color } or { top, bottom }.');
  if (resolved.mask && !resolved.key) throw new TypeError('composite.mask limits the key, so it needs composite.key. Fix: add a key, or remove the mask.');
  return resolved;
}

function resolveGlare(input) {
  const group = groupOf(input, 'glare');
  onlyKeys(group, ['streaks', 'count', 'angle', 'fogGlow', 'threshold', 'size'], 'glare');
  const count = numberInRange(group.count, 4, 1, MAXIMUM_STREAK_ARMS, 'glare.count');
  if (!Number.isInteger(count)) throw new RangeError('glare.count must be a whole number.');
  return {
    streaks: numberInRange(group.streaks, 0, 0, 1, 'glare.streaks'),
    count,
    angle: numberInRange(group.angle, 0, -360, 360, 'glare.angle'),
    fogGlow: numberInRange(group.fogGlow, 0, 0, 1, 'glare.fogGlow'),
    threshold: numberInRange(group.threshold, 1, 0, 10, 'glare.threshold'),
    size: numberInRange(group.size, 0.15, 0.01, 1, 'glare.size'),
  };
}

function resolveLensDistortion(input) {
  const group = groupOf(input, 'lensDistortion');
  onlyKeys(group, ['distortion', 'dispersion'], 'lensDistortion');
  return {
    distortion: numberInRange(group.distortion, 0, -1, 1, 'lensDistortion.distortion'),
    dispersion: numberInRange(group.dispersion, 0, 0, 1, 'lensDistortion.dispersion'),
  };
}

function resolveLocalToneMapping(input) {
  const group = groupOf(input, 'localToneMapping');
  onlyKeys(group, ['strength', 'highlightContrast', 'shadowContrast', 'detail', 'blurRadius', 'midtoneRange'], 'localToneMapping');
  return {
    strength: numberInRange(group.strength, 0.4, 0, 1, 'localToneMapping.strength'),
    highlightContrast: numberInRange(group.highlightContrast, 0.6, 0, 1, 'localToneMapping.highlightContrast'),
    shadowContrast: numberInRange(group.shadowContrast, 0.6, 0, 1, 'localToneMapping.shadowContrast'),
    detail: numberInRange(group.detail, 1, 0, 2, 'localToneMapping.detail'),
    blurRadius: numberInRange(group.blurRadius, 0.08, 0.01, 0.25, 'localToneMapping.blurRadius'),
    midtoneRange: numberInRange(group.midtoneRange, 1.5, 0, 4, 'localToneMapping.midtoneRange'),
  };
}

/** The named steps an effects input sets, resolved with their defaults. A step the input leaves out stays out of the result. */
export function resolvePostSteps(effects) {
  const resolved = {};
  if (effects.distortion !== undefined) resolved.distortion = resolveDistortion(effects.distortion);
  if (effects.flash !== undefined) resolved.flash = resolveFlash(effects.flash);
  if (effects.colorBalance !== undefined) resolved.colorBalance = resolveColorBalance(effects.colorBalance);
  if (effects.colorCorrection !== undefined) resolved.colorCorrection = resolveColorCorrection(effects.colorCorrection);
  if (effects.sunRays !== undefined) resolved.sunRays = resolveSunRays(effects.sunRays);
  if (effects.glare !== undefined) resolved.glare = resolveGlare(effects.glare);
  if (effects.lensDistortion !== undefined) resolved.lensDistortion = resolveLensDistortion(effects.lensDistortion);
  if (effects.stylize !== undefined) resolved.stylize = resolveStylize(effects.stylize);
  if (effects.composite !== undefined) resolved.composite = resolveComposite(effects.composite);
  if (effects.localToneMapping !== undefined) resolved.localToneMapping = resolveLocalToneMapping(effects.localToneMapping);
  if (effects.autoExposure !== undefined) resolved.autoExposure = resolveAutoExposure(effects.autoExposure);
  refuseMaskWithLensDistortion(resolved);
  return resolved;
}

// A mask reads the object ID pass and the depth, which are in undistorted screen space; lens distortion warps the colour image
// before the masked stages run, so the mask would sit in the wrong place, more so toward the corners and with dispersion.
function refuseMaskWithLensDistortion(resolved) {
  const lens = resolved.lensDistortion;
  const lensIsOn = Boolean(lens) && (lens.distortion !== 0 || lens.dispersion > 0);
  const airIsOn = resolved.distortion?.length > 0;
  const maskedStep = ['colorBalance', 'stylize', 'composite'].find(name => resolved[name]?.mask);
  if (airIsOn && maskedStep) {
    throw new TypeError(`${maskedStep}.mask cannot be combined with distortion: the mask is in undistorted screen space and would not line up with the bent picture. Fix: remove the mask, or remove the distortion step.`);
  }
  if (lensIsOn && maskedStep) {
    throw new TypeError(`${maskedStep}.mask cannot be combined with lensDistortion: the mask is in undistorted screen space and would not line up with the warped image. Fix: remove the mask, or set lensDistortion.distortion and dispersion to 0.`);
  }
}

// Registers what the look needs: the field names it accepts and how to resolve them (src/shader-registry.js).
postStepSupport.fields = ['distortion', 'flash', 'colorBalance', 'colorCorrection', 'sunRays', 'glare', 'lensDistortion', 'stylize', 'composite', 'localToneMapping', 'autoExposure'];
postStepSupport.resolve = resolvePostSteps;

export const colorBalanceFragment = `${sharedFragmentHeader}
${maskShader}
uniform vec3 lift;
uniform vec3 inverseGamma;
uniform vec3 gain;
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  // Lift raises the shadows and fades out toward white, gain scales the highlights, gamma bends the midtones.
  vec3 graded = source.rgb * gain + lift * (1.0 - clamp(source.rgb, 0.0, 1.0));
  graded = pow(max(graded, vec3(0.0)), inverseGamma);
  float mask = maskAt(textureCoordinate);
  outputColor = vec4(mask < 1.0 ? mix(source.rgb, graded, mask) : graded, source.a);
}`;

export const colorCorrectionFragment = `${sharedFragmentHeader}
uniform vec3 tint;
uniform vec3 gradeControls;
// Oklab (Ottosson 2020), so saturation moves the chroma of a colour and leaves its lightness and hue alone.
vec3 linearToOklab(vec3 color) {
  vec3 cone = pow(max(mat3(0.4122214708, 0.2119034982, 0.0883024619, 0.5363325363, 0.6806995451, 0.2817188376, 0.0514459929, 0.1073969566, 0.6299787005) * color, vec3(1e-9)), vec3(1.0 / 3.0));
  return mat3(0.2104542553, 1.9779984951, 0.0259040371, 0.7936177850, -2.4285922050, 0.7827717662, -0.0040720468, 0.4505937099, -0.8086757660) * cone;
}
vec3 oklabToLinear(vec3 lab) {
  vec3 cone = mat3(1.0, 1.0, 1.0, 0.3963377774, -0.1055613458, -0.0894841775, 0.2158037573, -0.0638541728, -1.2914855480) * lab;
  return mat3(4.0767416621, -1.2684380046, -0.0041960863, -3.3077115913, 2.6097574011, -0.7034186147, 0.2309699292, -0.3413193965, 1.7076147010) * (cone * cone * cone);
}
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  // Tint, then brightness in stops of two, then contrast about middle grey, then saturation as a chroma scale in Oklab.
  vec3 graded = max(source.rgb, vec3(0.0)) * tint * exp2(gradeControls.x * 2.0);
  graded = ${COLOR_CORRECTION_MIDDLE_GREY.toFixed(2)} * pow(graded / ${COLOR_CORRECTION_MIDDLE_GREY.toFixed(2)}, vec3(1.0 + gradeControls.y));
  if (gradeControls.z != 0.0) {
    vec3 lab = linearToOklab(graded);
    float chroma = length(lab.yz);
    // Vibrance: colours that are already vivid gain less, so a green does not run to the edge of the gamut.
    float gain = gradeControls.z > 0.0 ? 1.0 + gradeControls.z * (1.0 - smoothstep(0.04, 0.22, chroma)) : 1.0 + gradeControls.z;
    vec3 scaled = oklabToLinear(vec3(lab.x, lab.yz * gain));
    // A channel pushed toward zero would clip and shift the hue: pull the colour back toward the grey of the same lightness until its lowest
    // channel keeps a fifth of the grey's, so a saturated green stays a green and does not run to the edge of the gamut.
    vec3 grey = oklabToLinear(vec3(lab.x, 0.0, 0.0));
    float greyLowest = min(grey.r, min(grey.g, grey.b));
    float lowest = min(scaled.r, min(scaled.g, scaled.b));
    float keepLowest = 0.2 * greyLowest;
    graded = lowest < keepLowest ? mix(scaled, grey, (keepLowest - lowest) / max(greyLowest - lowest, 1e-6)) : scaled;
  }
  outputColor = vec4(graded, source.a);
}`;

// The gather runs at half resolution (a quarter of the pixels, so a quarter of the depth reads) and a upsample puts it back, weighting sky and geometry apart.
export const SUN_RAY_RESOLUTION_DIVISOR = 2;

// Radial blur of the light the sun sends past the geometry (GPU Gems 3, ch. 13). A tap counts only where the depth buffer shows open sky,
// weighted by how near the sun's disc it is, so a ray from a pixel is bright when its line to the sun is clear and dark behind a trunk or a crown.
// `sunPosition` is the centre of every ray, the sun's projected direction. The result is a share from 0 to 1 in the red channel.
export const sunRaysGatherFragment = `${sharedFragmentHeader}
uniform vec2 sunPosition;
uniform float spread;
void main() {
  float aspect = resolution.x / resolution.y;
  vec2 toSun = sunPosition - textureCoordinate;
  vec2 step = toSun * mix(0.35, 1.0, spread) / ${SUN_RAY_SAMPLES}.0;
  float discScale = 1.0 / (0.06 + 0.1 * spread);
  discScale *= discScale;
  vec2 position = textureCoordinate + step * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec2 aspectScale = vec2(aspect, 1.0);
  vec2 depthSize = vec2(textureSize(sceneDepth, 0));
  ivec2 lastTexel = ivec2(depthSize) - 1;
  float gathered = 0.0;
  float weight = 1.0;
  float totalWeight = 0.0;
  for (int index = 0; index < ${SUN_RAY_SAMPLES}; index++) {
    position += step;
    float depth = texelFetch(sceneDepth, clamp(ivec2(position * depthSize), ivec2(0), lastTexel), 0).r;
    vec2 fromSun = (position - sunPosition) * aspectScale;
    float glow = 0.04 + 1.0 / (1.0 + dot(fromSun, fromSun) * discScale * 4.0);
    gathered += depth >= 0.99999 ? glow * weight : 0.0;
    totalWeight += weight;
    weight *= 0.98;
  }
  vec2 fromSunPixel = (textureCoordinate - sunPosition) * aspectScale;
  float falloff = exp(-length(fromSunPixel) / (0.35 + 0.6 * spread));
  // A sixth of the glow is the haze around the sun, which a crown in front of it does not remove; the rest is the shafts. Without the haze a
  // crown leaves a ring of unlit sky around it, which reads as a dark halo.
  outputColor = vec4(0.4 * (0.15 + 0.85 * gathered / totalWeight) * falloff, 0.0, 0.0, 1.0);
}`;

// Adds the gathered rays to the frame. The four half-resolution texels around a pixel are weighted by bilinear share and by how well their
// depth matches the pixel's (sky against geometry counts least), so a ray never bleeds across the edge of a crown or a trunk.
export const sunRaysFragment = `${sharedFragmentHeader}
uniform sampler2D rayTexture;
uniform vec3 rayColor;
uniform float intensity;
bool isSky(float depth) {
  return depth >= 0.99999;
}
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  vec2 depthSize = vec2(textureSize(sceneDepth, 0));
  ivec2 lastDepthTexel = ivec2(depthSize) - 1;
  vec2 coarseSize = vec2(textureSize(rayTexture, 0));
  ivec2 lastCoarseTexel = ivec2(coarseSize) - 1;
  vec2 coarsePosition = textureCoordinate * coarseSize - 0.5;
  ivec2 base = ivec2(floor(coarsePosition));
  vec2 share = fract(coarsePosition);
  float centreDepth = texelFetch(sceneDepth, clamp(ivec2(gl_FragCoord.xy), ivec2(0), lastDepthTexel), 0).r;
  float rays = 0.0;
  float total = 0.0;
  for (int corner = 0; corner < 4; corner++) {
    ivec2 offset = ivec2(corner & 1, corner >> 1);
    ivec2 texel = clamp(base + offset, ivec2(0), lastCoarseTexel);
    float cornerDepth = texelFetch(sceneDepth, clamp(ivec2((vec2(texel) + 0.5) / coarseSize * depthSize), ivec2(0), lastDepthTexel), 0).r;
    float bilinear = (offset.x == 1 ? share.x : 1.0 - share.x) * (offset.y == 1 ? share.y : 1.0 - share.y);
    // Only sky against geometry counts: weighting by depth distance as well favoured the neighbours along a sloped floor and left vertical streaks.
    float similarity = isSky(cornerDepth) == isSky(centreDepth) ? 1.0 : 0.02;
    float cornerWeight = bilinear * similarity + 1e-5;
    rays += texelFetch(rayTexture, texel, 0).r * cornerWeight;
    total += cornerWeight;
  }
  outputColor = vec4(source.rgb + rayColor * intensity * rays / total, source.a);
}`;

export const stylizeFragment = `${sharedFragmentHeader}
${maskShader}
uniform float sharpenAmount;
uniform int kuwaharaRadius;
uniform float posterizeLevels;
uniform float pixelateSize;
uniform vec2 pixelateOrigin;
vec2 snapped(vec2 coordinate) {
  if (pixelateSize < 1.0) return coordinate;
  return ((floor((coordinate * resolution + pixelateOrigin) / pixelateSize) + 0.5) * pixelateSize - pixelateOrigin) / resolution;
}
vec4 sourceAt(vec2 coordinate) {
  return texture(sourceTexture, snapped(coordinate));
}
// Kuwahara: the mean of whichever of the four quadrants around the pixel varies least, so flat areas stay flat and edges stay sharp.
vec3 kuwahara(vec2 coordinate) {
  vec3 bestMean = vec3(0.0);
  float bestVariance = 1e30;
  for (int quadrant = 0; quadrant < 4; quadrant++) {
    vec2 direction = vec2(quadrant == 1 || quadrant == 3 ? -1.0 : 1.0, quadrant >= 2 ? -1.0 : 1.0);
    vec3 sum = vec3(0.0);
    float lumaSum = 0.0;
    float lumaSquareSum = 0.0;
    float count = 0.0;
    for (int row = 0; row <= ${MAXIMUM_KUWAHARA_RADIUS}; row++) {
      if (row > kuwaharaRadius) break;
      for (int column = 0; column <= ${MAXIMUM_KUWAHARA_RADIUS}; column++) {
        if (column > kuwaharaRadius) break;
        vec3 color = sourceAt(coordinate + direction * vec2(float(column), float(row)) / resolution).rgb;
        float luma = dot(color, vec3(0.299, 0.587, 0.114));
        sum += color;
        lumaSum += luma;
        lumaSquareSum += luma * luma;
        count += 1.0;
      }
    }
    float variance = lumaSquareSum / count - (lumaSum / count) * (lumaSum / count);
    if (variance < bestVariance) {
      bestVariance = variance;
      bestMean = sum / count;
    }
  }
  return bestMean;
}
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  vec4 center = sourceAt(textureCoordinate);
  vec3 color = kuwaharaRadius > 0 ? kuwahara(textureCoordinate) : center.rgb;
  if (sharpenAmount > 0.0) {
    vec2 texel = 1.0 / resolution;
    vec3 around = sourceAt(textureCoordinate + vec2(texel.x, 0.0)).rgb + sourceAt(textureCoordinate - vec2(texel.x, 0.0)).rgb
      + sourceAt(textureCoordinate + vec2(0.0, texel.y)).rgb + sourceAt(textureCoordinate - vec2(0.0, texel.y)).rgb;
    color = max(color + sharpenAmount * (center.rgb * 4.0 - around), vec3(0.0));
  }
  if (posterizeLevels > 0.0) color = floor(color * posterizeLevels + 0.5) / posterizeLevels;
  float mask = maskAt(textureCoordinate);
  outputColor = vec4(mask < 1.0 ? mix(source.rgb, color, mask) : color, source.a);
}`;

export const compositeFragment = `${sharedFragmentHeader}
${maskShader}
uniform float keyMode;
uniform vec3 keyColor;
uniform vec3 keyRange;
uniform float keyInvert;
uniform vec3 backgroundTop;
uniform vec3 backgroundBottom;
vec2 chromaOf(vec3 color) {
  vec3 normalized = color / max(max(color.r, max(color.g, color.b)), 0.0001);
  return vec2(dot(normalized, vec3(-0.169, -0.331, 0.5)), dot(normalized, vec3(0.5, -0.419, -0.081)));
}
// 1 keeps the pixel, 0 shows the background. Chroma: distance between the pixel's and the key's chroma, so brightness does not matter.
float keepAmount(vec3 color) {
  if (keyMode > 1.5) {
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float keep = smoothstep(keyRange.x, keyRange.y, luma);
    return mix(keep, 1.0 - keep, keyInvert);
  }
  float distanceToKey = distance(chromaOf(color), chromaOf(keyColor));
  return smoothstep(keyRange.x, keyRange.x + keyRange.y, distanceToKey);
}
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  float keep = 1.0;
  if (keyMode > 0.5) keep = mix(1.0, keepAmount(source.rgb), maskAt(textureCoordinate));
  vec3 background = mix(backgroundBottom, backgroundTop, textureCoordinate.y);
  outputColor = vec4(mix(background, source.rgb, keep * source.a), 1.0);
}`;

export const glareFragment = `${sharedFragmentHeader}
uniform float streakAmount;
uniform int streakCount;
uniform float streakAngle;
uniform float fogAmount;
uniform float threshold;
uniform float sizePixels;
uniform float fogLod;
vec3 brightPart(vec2 coordinate, float lod) {
  vec3 color = textureLod(sourceTexture, coordinate, lod).rgb;
  float peak = max(color.r, max(color.g, color.b));
  return color * max(peak - threshold, 0.0) / max(peak, 0.00001);
}
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  vec3 glow = vec3(0.0);
  float jitter = pixelRotation() / 6.2831853;
  if (streakAmount > 0.0) {
    vec3 streaks = vec3(0.0);
    // Each arm is one thin line of taps from the pixel outward, evenly spaced around the circle; a pair of arms is one streak.
    // Weights fall off cubically, so a streak is bright at its core and thins to nothing at its tip.
    for (int arm = 0; arm < ${MAXIMUM_STREAK_ARMS}; arm++) {
      if (arm >= streakCount) break;
      float angle = streakAngle + float(arm) * 6.2831853 / float(streakCount);
      vec2 step = vec2(cos(angle), sin(angle)) * sizePixels / ${STREAK_STEPS}.0 / resolution;
      for (int index = 1; index <= ${STREAK_STEPS}; index++) {
        float along = float(index) - jitter;
        float weight = 1.0 - along / (${STREAK_STEPS}.0 + 1.0);
        streaks += brightPart(textureCoordinate + step * along, 0.0) * weight * weight * weight;
      }
    }
    glow += streaks * streakAmount * 4.0 / ${STREAK_STEPS}.0;
  }
  if (fogAmount > 0.0) {
    // Taps read a blurred level of the frame, so the fixed spiral of taps merges into one smooth halo with no per-pixel noise.
    vec3 fog = vec3(0.0);
    float weightSum = 0.0;
    for (int index = 0; index < ${FOG_SAMPLES}; index++) {
      float ring = sqrt((float(index) + 0.5) / ${FOG_SAMPLES}.0);
      float angle = float(index) * 2.3999632;
      float weight = 1.0 - ring * ring;
      fog += brightPart(textureCoordinate + vec2(cos(angle), sin(angle)) * ring * sizePixels / resolution, fogLod) * weight;
      weightSum += weight;
    }
    glow += fog / weightSum * fogAmount;
  }
  outputColor = vec4(source.rgb + glow, source.a);
}`;

export const lensDistortionFragment = `${sharedFragmentHeader}
uniform float distortion;
uniform float dispersion;
void main() {
  float aspect = resolution.x / resolution.y;
  vec2 centered = (textureCoordinate - 0.5) * 2.0;
  centered.x *= aspect;
  // Positive distortion is barrel: the edges sample from further out, so they bunch toward the center. Each channel
  // takes a slightly different scale, so a line off center splits into color fringes that grow with the distance.
  float bend = 1.0 + distortion * 0.25 * dot(centered, centered);
  vec3 spread = 1.0 + dispersion * ${MAXIMUM_DISPERSION} * vec3(1.0, 0.0, -1.0);
  // Barrel samples from beyond the frame at the corners, so the picture is scaled to fill: the corner maps onto the corner for every channel.
  float cornerBend = max(1.0 + distortion * 0.25 * (aspect * aspect + 1.0), 1.0);
  vec3 scales = bend * spread / (cornerBend * (1.0 + dispersion * ${MAXIMUM_DISPERSION}));
  vec2 red = centered * scales.r;
  vec2 green = centered * scales.g;
  vec2 blue = centered * scales.b;
  vec4 center = texture(sourceTexture, green / vec2(aspect, 1.0) * 0.5 + 0.5);
  outputColor = vec4(texture(sourceTexture, red / vec2(aspect, 1.0) * 0.5 + 0.5).r, center.g,
    texture(sourceTexture, blue / vec2(aspect, 1.0) * 0.5 + 0.5).b, center.a);
}`;

// Local exposure (as in UE5, where a contrast scale of 1 leaves a range alone and less than 1 compresses it): the frame splits into a base, a bilateral blur of log luminance whose taps stop at edges so a bright sky does not
// bleed into the grass beside it, and the detail left over. The base is pulled toward middle grey, highlights and shadows each by their own
// amount, and the detail is added back, so a low sun's sky and the shaded ground both fit in one frame without flattening texture.
export const localToneMappingFragment = `${sharedFragmentHeader}
uniform float strength;
uniform float highlightContrast;
uniform float shadowContrast;
uniform float detailGain;
uniform float radiusPixels;
uniform float baseLod;
uniform float kneeLog;
float logLuminance(vec3 color) {
  return log(max(dot(color, vec3(0.2126, 0.7152, 0.0722)), 0.0001));
}
void main() {
  vec4 source = texture(sourceTexture, textureCoordinate);
  float centerLog = logLuminance(source.rgb);
  // The pixel's own brightness is a tap of weight 1, so the base is continuous across an edge and never empty.
  float sum = centerLog;
  float weightSum = 1.0;
  for (int index = 0; index < ${LOCAL_TONE_TAPS}; index++) {
    float ring = sqrt((float(index) + 0.5) / ${LOCAL_TONE_TAPS}.0);
    float angle = float(index) * 2.3999632;
    vec2 offset = vec2(cos(angle), sin(angle)) * ring * radiusPixels / resolution;
    float tapLog = logLuminance(textureLod(sourceTexture, textureCoordinate + offset, baseLod).rgb);
    float difference = tapLog - centerLog;
    // Spatial falloff times an edge stop: taps more than about a stop and a half away in brightness barely count.
    float weight = (1.0 - ring * ring * 0.8) * exp(-difference * difference / 0.5);
    sum += tapLog * weight;
    weightSum += weight;
  }
  float pivot = log(${LOCAL_TONE_PIVOT});
  float baseLog = sum / weightSum;
  float detailLog = centerLog - baseLog;
  // Only what lies past the knee on either side of middle grey is compressed, so the midtones keep their contrast and the picture does not go flat. A smooth
  // knee has no kink for the eye to find, and the lift of a shadow is capped so the darkest parts stay dark.
  float offset = baseLog - pivot;
  float highTail = offset - kneeLog;
  float lowTail = -offset - kneeLog;
  float highExcess = 0.5 * (highTail + sqrt(highTail * highTail + ${LOCAL_TONE_KNEE_SOFTNESS}));
  float lowExcess = 0.5 * (lowTail + sqrt(lowTail * lowTail + ${LOCAL_TONE_KNEE_SOFTNESS}));
  float highDrop = highExcess * (1.0 - mix(1.0, highlightContrast, strength));
  float lowWanted = lowExcess * (1.0 - mix(1.0, shadowContrast, strength));
  float lowLift = ${LOCAL_TONE_MAXIMUM_LIFT} * tanh(lowWanted / ${LOCAL_TONE_MAXIMUM_LIFT});
  float mappedLog = pivot + offset - highDrop + lowLift + detailLog * detailGain;
  // The gain is one number for all three channels, so hue and saturation of the pixel stay as rendered.
  outputColor = vec4(source.rgb * exp(mappedLog - centerLog), source.a);
}`;

function kneeTail(distancePastKnee) {
  return 0.5 * (distancePastKnee + Math.sqrt(distancePastKnee * distancePastKnee + LOCAL_TONE_KNEE_SOFTNESS));
}

/**
 * The curve of the local tone mapping shader on one pixel, for tests and tools: natural-log luminances in, the mapped natural-log luminance out. `settings` is a resolved localToneMapping group.
 * Only the base past the knee (`midtoneRange` stops either side of middle grey) is compressed, a shadow's lift is capped, and the detail is added back.
 */
export function localToneMappedLog(baseLog, detailLog, settings) {
  const pivot = Math.log(LOCAL_TONE_PIVOT);
  const offset = baseLog - pivot;
  const kneeLog = settings.midtoneRange * Math.LN2;
  const highDrop = kneeTail(offset - kneeLog) * (1 - (1 + (settings.highlightContrast - 1) * settings.strength));
  const lowWanted = kneeTail(-offset - kneeLog) * (1 - (1 + (settings.shadowContrast - 1) * settings.strength));
  const lowLift = LOCAL_TONE_MAXIMUM_LIFT * Math.tanh(lowWanted / LOCAL_TONE_MAXIMUM_LIFT);
  return pivot + offset - highDrop + lowLift + detailLog * settings.detail;
}

// The renderer resolves only the core effects, so a stage reads its group from the frame's own effects.
function stepsOf(frame) {
  return resolvePostSteps(frame.effects ?? {});
}

function isColorBalanceActive(colorBalance) {
  return Boolean(colorBalance) && ['lift', 'gamma', 'gain'].some(name => colorBalance[name].some((component, index) => component !== NEUTRAL[name][index]));
}

// The object ID texture is the colour attachment of the pass framebuffer, which the next frame draws into. Leaving it bound on
// unit 2 would risk a feedback loop, so the unit is cleared after the masked draw.
function withMaskUnbound(stage) {
  return {
    ...stage,
    apply(renderer, frame, effects, sourceTexture) {
      const result = stage.apply(renderer, frame, effects, sourceTexture);
      if (result) unbindMask(renderer.context);
      return result;
    },
  };
}

function createColorBalanceStage() {
  return withMaskUnbound(createStage({
    name: 'Color balance',
    fragment: colorBalanceFragment,
    uniformNames: ['lift', 'inverseGamma', 'gain', ...MASK_UNIFORM_NAMES],
    isActive: (effects, frame) => isColorBalanceActive(stepsOf(frame).colorBalance),
    setUniforms(context, uniforms, renderer, frame) {
      const { colorBalance } = stepsOf(frame);
      context.uniform3fv(uniforms.lift, colorBalance.lift);
      context.uniform3fv(uniforms.inverseGamma, colorBalance.gamma.map(gamma => 1 / gamma));
      context.uniform3fv(uniforms.gain, colorBalance.gain);
      bindMask(context, uniforms, renderer, frame, colorBalance.mask);
    },
  }));
}

function isColorCorrectionActive(colorCorrection) {
  return Boolean(colorCorrection) && (['brightness', 'contrast', 'saturation'].some(name => colorCorrection[name] !== 0) || colorCorrection.tint.some(component => component !== 1));
}

function createColorCorrectionStage() {
  return createStage({
    name: 'Color correction',
    fragment: colorCorrectionFragment,
    uniformNames: ['tint', 'gradeControls'],
    isActive: (effects, frame) => isColorCorrectionActive(stepsOf(frame).colorCorrection),
    setUniforms(context, uniforms, renderer, frame) {
      const { colorCorrection } = stepsOf(frame);
      context.uniform3fv(uniforms.tint, colorCorrection.tint);
      context.uniform3f(uniforms.gradeControls, colorCorrection.brightness, colorCorrection.contrast, colorCorrection.saturation);
    },
  });
}

function isSunRaysActive(sunRays) {
  return Boolean(sunRays) && sunRays.intensity > 0;
}

/**
 * The sun's place on screen in texture coordinates, or null when it is behind the camera. The sun is far enough to treat as a direction:
 * the projection of `renderer.activeLightDirection`, the vector that aims the key light and the cast shadows, so every ray starts at the sun.
 */
export function sunScreenPosition(renderer, frame) {
  const direction = renderer.activeLightDirection;
  const length = Math.hypot(...direction) || 1;
  const point = [0, 1, 2].map(axis => frame.eye[axis] + direction[axis] / length * 1e4);
  const matrix = renderer.viewProjection;
  const clip = [0, 1, 3].map(row => matrix[row] * point[0] + matrix[row + 4] * point[1] + matrix[row + 8] * point[2] + matrix[row + 12]);
  if (clip[2] <= 0) return null;
  return [clip[0] / clip[2] * 0.5 + 0.5, clip[1] / clip[2] * 0.5 + 0.5];
}

// Two passes: a half-resolution gather toward the sun, then a depth-aware upsample that adds it to the frame. A sun behind the camera draws nothing.
function createSunRaysStage() {
  let gatherProgram = null;
  let gatherUniforms = null;
  let gatherTarget = null;
  let rayTexture = null;
  let rayColor = [1, 1, 1];
  let intensity = 0;
  const composite = createStage({
    name: 'Sun rays',
    fragment: sunRaysFragment,
    uniformNames: ['rayTexture', 'rayColor', 'intensity'],
    isActive: () => true,
    setUniforms(context, uniforms) {
      context.activeTexture(context.TEXTURE2);
      context.bindTexture(context.TEXTURE_2D, rayTexture);
      context.uniform1i(uniforms.rayTexture, 2);
      context.uniform3fv(uniforms.rayColor, rayColor);
      context.uniform1f(uniforms.intensity, intensity);
      context.activeTexture(context.TEXTURE0);
    },
  });

  function releaseTargets(context) {
    if (gatherTarget) {
      context.deleteTexture(gatherTarget.texture);
      context.deleteFramebuffer(gatherTarget.framebuffer);
      gatherTarget = null;
    }
    composite.releaseTargets(context);
  }

  function gather(renderer, sunPosition, spread) {
    const context = renderer.context;
    if (!gatherProgram) {
      gatherProgram = compileProgram(context, fullscreenVertex, sunRaysGatherFragment);
      gatherUniforms = Object.fromEntries(['sceneDepth', 'resolution', 'sunPosition', 'spread'].map(name => [name, context.getUniformLocation(gatherProgram, name)]));
    }
    gatherTarget ??= createTarget(renderer, SUN_RAY_RESOLUTION_DIVISOR);
    context.bindFramebuffer(context.FRAMEBUFFER, gatherTarget.framebuffer);
    context.viewport(0, 0, Math.ceil(renderer.canvas.width / SUN_RAY_RESOLUTION_DIVISOR), Math.ceil(renderer.canvas.height / SUN_RAY_RESOLUTION_DIVISOR));
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    context.useProgram(gatherProgram);
    context.activeTexture(context.TEXTURE1);
    context.bindTexture(context.TEXTURE_2D, renderer.depthTexture);
    context.uniform1i(gatherUniforms.sceneDepth, 1);
    context.uniform2f(gatherUniforms.resolution, renderer.canvas.width, renderer.canvas.height);
    context.uniform2f(gatherUniforms.sunPosition, sunPosition[0], sunPosition[1]);
    context.uniform1f(gatherUniforms.spread, spread);
    context.drawArrays(context.TRIANGLES, 0, 3);
    context.activeTexture(context.TEXTURE0);
    return gatherTarget.texture;
  }

  function apply(renderer, frame, effects, sourceTexture) {
    const { sunRays } = stepsOf(frame);
    if (!isSunRaysActive(sunRays)) return null;
    if (!renderer.depthTexture) throw new Error('Sun rays requires depth:true on the renderer.');
    const position = sunScreenPosition(renderer, frame);
    if (!position) return null;
    const key = renderer.lighting.keyColor;
    const brightest = Math.max(key[0], key[1], key[2], 1e-3);
    rayColor = [key[0] / brightest, key[1] / brightest, key[2] / brightest];
    intensity = sunRays.intensity;
    rayTexture = gather(renderer, position, sunRays.spread);
    return composite.apply(renderer, frame, effects, sourceTexture);
  }

  function dispose(context) {
    releaseTargets(context);
    if (gatherProgram) context.deleteProgram(gatherProgram);
    gatherProgram = null;
    composite.dispose(context);
  }

  return { name: 'Sun rays', apply, releaseTargets, dispose };
}

function isStylizeActive(stylize) {
  return Boolean(stylize) && (stylize.sharpen > 0 || stylize.kuwahara > 0 || stylize.posterize > 0 || stylize.pixelate > 0);
}

function createStylizeStage() {
  return withMaskUnbound(createStage({
    name: 'Stylize',
    fragment: stylizeFragment,
    uniformNames: ['sharpenAmount', 'kuwaharaRadius', 'posterizeLevels', 'pixelateSize', 'pixelateOrigin', ...MASK_UNIFORM_NAMES],
    isActive: (effects, frame) => isStylizeActive(stepsOf(frame).stylize),
    setUniforms(context, uniforms, renderer, frame) {
      const { stylize } = stepsOf(frame);
      context.uniform1f(uniforms.sharpenAmount, stylize.sharpen ?? 0);
      context.uniform1i(uniforms.kuwaharaRadius, stylize.kuwahara ?? 0);
      context.uniform1f(uniforms.posterizeLevels, stylize.posterize ?? 0);
      context.uniform1f(uniforms.pixelateSize, stylize.pixelate ?? 0);
      // On a pixel grid the blocks start on a lattice that moves with the snapped camera, so they stay on the same geometry.
      context.uniform2fv(uniforms.pixelateOrigin, stylize.pixelate > 0 ? renderer.pixelGrid?.latticeOrigin(stylize.pixelate) ?? [0, 0] : [0, 0]);
      bindMask(context, uniforms, renderer, frame, stylize.mask);
    },
  }));
}

function createCompositeStage() {
  return withMaskUnbound(createStage({
    name: 'Composite',
    fragment: compositeFragment,
    uniformNames: ['keyMode', 'keyColor', 'keyRange', 'keyInvert', 'backgroundTop', 'backgroundBottom', ...MASK_UNIFORM_NAMES],
    isActive: (effects, frame) => Boolean(stepsOf(frame).composite?.background),
    setUniforms(context, uniforms, renderer, frame) {
      const { composite } = stepsOf(frame);
      const { background, key } = composite;
      context.uniform3fv(uniforms.backgroundTop, background.color ?? background.top);
      context.uniform3fv(uniforms.backgroundBottom, background.color ?? background.bottom);
      const chroma = key?.chroma;
      const luma = key?.luma;
      context.uniform1f(uniforms.keyMode, chroma ? 1 : luma ? 2 : 0);
      context.uniform3fv(uniforms.keyColor, chroma?.color ?? [0, 0, 0]);
      const range = chroma
        ? [chroma.tolerance * CHROMA_DISTANCE_SCALE, Math.max(chroma.softness * CHROMA_DISTANCE_SCALE, 0.0001), 0]
        : [luma?.low ?? 0, luma?.high ?? 1, 0];
      context.uniform3fv(uniforms.keyRange, range);
      context.uniform1f(uniforms.keyInvert, luma?.invert ? 1 : 0);
      bindMask(context, uniforms, renderer, frame, composite.mask);
    },
  }));
}

function createGlareStage() {
  const stage = createStage({
    name: 'Glare',
    fragment: glareFragment,
    uniformNames: ['streakAmount', 'streakCount', 'streakAngle', 'fogAmount', 'threshold', 'sizePixels', 'fogLod'],
    isActive: (effects, frame) => {
      const { glare } = stepsOf(frame);
      return Boolean(glare) && (glare.streaks > 0 || glare.fogGlow > 0);
    },
    setUniforms(context, uniforms, renderer, frame) {
      const { glare } = stepsOf(frame);
      context.uniform1f(uniforms.streakAmount, glare.streaks);
      context.uniform1i(uniforms.streakCount, glare.count);
      context.uniform1f(uniforms.streakAngle, glare.angle * Math.PI / 180);
      context.uniform1f(uniforms.fogAmount, glare.fogGlow);
      context.uniform1f(uniforms.threshold, glare.threshold);
      const sizePixels = glare.size * renderer.canvas.height;
      context.uniform1f(uniforms.sizePixels, sizePixels);
      // The halo blurs at about two thirds of its radius: coarse enough to hide the tap spacing, fine enough to keep its shape.
      context.uniform1f(uniforms.fogLod, Math.max(0, Math.log2(sizePixels / 1.5)));
    },
  });
  // The halo reads blurred levels of the frame, so the frame gets a mip chain for this draw and goes back to one level after it.
  return {
    ...stage,
    apply(renderer, frame, effects, sourceTexture) {
      const context = renderer.context;
      const fogOn = stepsOf(frame).glare?.fogGlow > 0;
      if (fogOn) {
        context.activeTexture(context.TEXTURE0);
        context.bindTexture(context.TEXTURE_2D, sourceTexture);
        context.generateMipmap(context.TEXTURE_2D);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR_MIPMAP_LINEAR);
      }
      const result = stage.apply(renderer, frame, effects, sourceTexture);
      if (fogOn) {
        context.activeTexture(context.TEXTURE0);
        context.bindTexture(context.TEXTURE_2D, sourceTexture);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      }
      return result;
    },
  };
}

function createLensDistortionStage() {
  return createStage({
    name: 'Lens distortion',
    fragment: lensDistortionFragment,
    uniformNames: ['distortion', 'dispersion'],
    isActive: (effects, frame) => {
      const { lensDistortion } = stepsOf(frame);
      return Boolean(lensDistortion) && (lensDistortion.distortion !== 0 || lensDistortion.dispersion > 0);
    },
    setUniforms(context, uniforms, renderer, frame) {
      const { lensDistortion } = stepsOf(frame);
      context.uniform1f(uniforms.distortion, lensDistortion.distortion);
      context.uniform1f(uniforms.dispersion, lensDistortion.dispersion);
    },
  });
}

// Strength 0, or contrasts and detail all at 1 (which leave the frame as it is), draws nothing.
function isLocalToneMappingActive(localToneMapping) {
  if (!localToneMapping || localToneMapping.strength === 0) return false;
  return localToneMapping.highlightContrast !== 1 || localToneMapping.shadowContrast !== 1 || localToneMapping.detail !== 1;
}

function createLocalToneMappingStage() {
  const stage = createStage({
    name: 'Local tone mapping',
    fragment: localToneMappingFragment,
    uniformNames: ['strength', 'highlightContrast', 'shadowContrast', 'detailGain', 'radiusPixels', 'baseLod', 'kneeLog'],
    isActive: (effects, frame) => isLocalToneMappingActive(stepsOf(frame).localToneMapping),
    setUniforms(context, uniforms, renderer, frame) {
      const { localToneMapping } = stepsOf(frame);
      context.uniform1f(uniforms.strength, localToneMapping.strength);
      context.uniform1f(uniforms.highlightContrast, localToneMapping.highlightContrast);
      context.uniform1f(uniforms.shadowContrast, localToneMapping.shadowContrast);
      context.uniform1f(uniforms.detailGain, localToneMapping.detail);
      const radiusPixels = localToneMapping.blurRadius * renderer.canvas.height;
      context.uniform1f(uniforms.radiusPixels, radiusPixels);
      context.uniform1f(uniforms.kneeLog, localToneMapping.midtoneRange * Math.LN2);
      context.uniform1f(uniforms.baseLod, Math.max(0, Math.log2(radiusPixels / 3)));
    },
  });
  // The base reads blurred levels of the frame, so the frame gets a mip chain for this draw and goes back to one level after it.
  return {
    ...stage,
    apply(renderer, frame, effects, sourceTexture) {
      // Without a float frame (a benchmark renderer, or no float buffers) the picture is already clamped, so the step stays off.
      if (!renderer.hdr) return null;
      const context = renderer.context;
      const active = isLocalToneMappingActive(stepsOf(frame).localToneMapping);
      if (active) {
        context.activeTexture(context.TEXTURE0);
        context.bindTexture(context.TEXTURE_2D, sourceTexture);
        context.generateMipmap(context.TEXTURE_2D);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR_MIPMAP_LINEAR);
      }
      const result = stage.apply(renderer, frame, effects, sourceTexture);
      if (active) {
        context.activeTexture(context.TEXTURE0);
        context.bindTexture(context.TEXTURE_2D, sourceTexture);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
      }
      return result;
    },
  };
}

/**
 * Adds the air distortion and flash steps (post-air.js), glare, lens distortion, color balance, the stylize filters and the composite key to a renderer, after any depth of field and motion blur it has, in that
 * order. Like them it needs `depth: true`. Each stage runs only for a frame whose effects set it. A step with a `mask` by
 * objects reads the object ID pass: install the render passes and draw that pass before the lit frame (`usesObjectMask` says when).
 */
export function installPostSteps(renderer) {
  if (!renderer.postStages.some(stage => stage.name === 'Glare')) {
    renderer.postStages.push(createDistortionStage(stepsOf), createFlashStage(stepsOf), createGlareStage(), createLocalToneMappingStage(), createLensDistortionStage(), createColorBalanceStage(), createColorCorrectionStage(), createSunRaysStage(), createStylizeStage(), createCompositeStage());
  }
  return renderer;
}
