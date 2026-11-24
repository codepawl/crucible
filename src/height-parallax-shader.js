// Parallax relief for the main fragment shader (#2839). The code joins the program only when a material has a heightMap and a
// heightScale above zero, so every other scene compiles the same program as before. A material without one in a scene that has some
// reads heightState.w = 0 and skips the whole march.
//
// The height map holds the surface seen from above: texel 1 is the top, texel 0 lies heightScale metres below it, so the relief only
// ever sinks and the silhouette of the mesh stays flat. For each pixel a ray from the eye runs down through that depth, in steps, until
// it passes under the surface; the two samples around the crossing are joined by a straight line. The UV where it lands, as a shift
// from the pixel's own UV, moves every map of the material that reads UV set 0 (colour, normal, roughness, occlusion, emission), while
// the tangent frame of the normal map keeps reading the unshifted UV. The depth fades to zero between half of heightFade and
// heightFade metres from the eye, which leaves plain normal mapping there.

import { HEIGHT_PARALLAX_LIMITS } from './texture-set-fields.js';
import { HEIGHT_MAP_UNIT } from './shader-registry.js';

/** The ray steps a pixel may take at most; the loop bound the GLSL needs at compile time. */
export const MAXIMUM_PARALLAX_STEPS = HEIGHT_PARALLAX_LIMITS.steps[1];
/** The smallest view cosine the march uses: at a grazing angle the ray would run across the whole texture. */
export const MINIMUM_PARALLAX_VIEW_COSINE = 0.08;
/** Fewest steps at a head-on view, as a share of the requested steps. */
export const HEAD_ON_STEP_SHARE = 0.5;
/** Halvings of the last ray interval once the march has crossed the surface; the straight line joins the two samples that remain. */
export const PARALLAX_REFINE_STEPS = 4;
export { HEIGHT_MAP_UNIT };

// Every map reads through mapTexture: the shifted UV, with the mip gradients of the unshifted one. The shift jumps where the ray lands on
// another layer, and the implicit gradient of a jumping UV picks a blurry mip there, which smeared the rock faces and streaked the moss.
const MAPPED_UV = `vec2 parallaxShift = vec2(0.0);
vec2 textureGradientX = vec2(0.0);
vec2 textureGradientY = vec2(0.0);
vec2 lightmapGradientX = vec2(0.0);
vec2 lightmapGradientY = vec2(0.0);
vec2 mapUV(float flag) {
  return flag > 1.5 ? lightmapUV : textureUV + parallaxShift;
}
vec2 mapGradientX(float flag) {
  return flag > 1.5 ? lightmapGradientX : textureGradientX;
}
vec2 mapGradientY(float flag) {
  return flag > 1.5 ? lightmapGradientY : textureGradientY;
}
vec4 mapTexture(sampler2D source, float flag) {
  return textureGrad(source, mapUV(flag), mapGradientX(flag), mapGradientY(flag));
}`;

export const HEIGHT_PARALLAX_CODE = Object.freeze({
  declarations: `uniform sampler2D heightMap;
// x: depth in metres at texel 0, y: distance in metres where the relief has faded out, z: ray steps, w: 1 when the material has a height map.
uniform vec4 heightState;
// The UV shift that lands the eye ray on the relief, and zero where the relief fades out. Reads the unshifted UV, so it also gives the
// mip gradients of the height samples.
vec2 parallaxUvShift(vec3 surfaceNormal) {
  vec3 toEye = eye - worldPosition;
  float eyeDistance = length(toEye);
  float fade = 1.0 - smoothstep(0.5 * heightState.y, heightState.y, eyeDistance);
  vec3 positionX = dFdx(worldPosition);
  vec3 positionY = dFdy(worldPosition);
  vec2 uvX = textureGradientX;
  vec2 uvY = textureGradientY;
  float determinant = uvX.x * uvY.y - uvX.y * uvY.x;
  if (fade <= 0.0 || abs(determinant) < 1e-14) return vec2(0.0);
  vec3 tangent = (positionX * uvY.y - positionY * uvX.y) / determinant;
  vec3 bitangent = (positionY * uvX.x - positionX * uvY.x) / determinant;
  vec3 view = toEye / eyeDistance;
  vec3 facing = dot(surfaceNormal, view) < 0.0 ? -surfaceNormal : surfaceNormal;
  float viewCosine = max(dot(view, facing), ${MINIMUM_PARALLAX_VIEW_COSINE});
  // The world offset of the ray's exit at full depth, then the same offset in UV units: solve offset = tangent * a + bitangent * b.
  vec3 offset = (view - facing * dot(view, facing)) / viewCosine * (heightState.x * fade);
  float tangentTangent = dot(tangent, tangent);
  float tangentBitangent = dot(tangent, bitangent);
  float bitangentBitangent = dot(bitangent, bitangent);
  float gram = tangentTangent * bitangentBitangent - tangentBitangent * tangentBitangent;
  if (gram <= 0.0) return vec2(0.0);
  vec2 projected = vec2(dot(offset, tangent), dot(offset, bitangent));
  vec2 fullShift = vec2(bitangentBitangent * projected.x - tangentBitangent * projected.y, tangentTangent * projected.y - tangentBitangent * projected.x) / gram;
  float steps = mix(heightState.z, max(heightState.z * ${HEAD_ON_STEP_SHARE.toFixed(1)}, ${HEIGHT_PARALLAX_LIMITS.steps[0].toFixed(1)}), viewCosine);
  float stepDepth = 1.0 / steps;
  float rayDepth = 0.0;
  float previousRayDepth = 0.0;
  float surfaceDepth = 1.0 - textureGrad(heightMap, textureUV, uvX, uvY).r;
  float previousSurfaceDepth = surfaceDepth;
  for (int stepIndex = 0; stepIndex < ${MAXIMUM_PARALLAX_STEPS}; stepIndex++) {
    if (float(stepIndex) >= steps || rayDepth >= surfaceDepth) break;
    previousRayDepth = rayDepth;
    previousSurfaceDepth = surfaceDepth;
    rayDepth += stepDepth;
    surfaceDepth = 1.0 - textureGrad(heightMap, textureUV - fullShift * rayDepth, uvX, uvY).r;
  }
  // Halve the interval the ray crossed the surface in, then join the two samples left by a straight line.
  for (int refineIndex = 0; refineIndex < ${PARALLAX_REFINE_STEPS}; refineIndex++) {
    if (rayDepth <= previousRayDepth || rayDepth < surfaceDepth) break;
    float middleDepth = 0.5 * (previousRayDepth + rayDepth);
    float middleSurface = 1.0 - textureGrad(heightMap, textureUV - fullShift * middleDepth, uvX, uvY).r;
    if (middleDepth >= middleSurface) {
      rayDepth = middleDepth;
      surfaceDepth = middleSurface;
    } else {
      previousRayDepth = middleDepth;
      previousSurfaceDepth = middleSurface;
    }
  }
  float above = max(previousSurfaceDepth - previousRayDepth, 0.0);
  float below = max(rayDepth - surfaceDepth, 0.0);
  float crossing = previousRayDepth + (rayDepth - previousRayDepth) * above / max(above + below, 1e-6);
  return -fullShift * min(crossing, rayDepth);
}
`,
  mainStart: `  textureGradientX = dFdx(textureUV);
  textureGradientY = dFdy(textureUV);
  lightmapGradientX = dFdx(lightmapUV);
  lightmapGradientY = dFdy(lightmapUV);
  if (heightState.w > 0.5) parallaxShift = parallaxUvShift(normalize(worldNormal));
`,
});

function spliceOnce(source, anchor, replacement) {
  if (!source.includes(anchor)) throw new Error(`The shader source no longer contains "${anchor}", which the heightMap feature splices around.`);
  return source.replace(anchor, () => replacement);
}

// The main shader picks box mapping or UV mapping with `BOX_MAPPED ? boxCall : uvCall`. Where the global parallaxShift feeds the UV branch,
// the GPU programs measured (headless Chrome on Windows) returned the unshifted sample from that ternary, although the same call made as
// a statement was shifted (#2839). A statement with an early return gives the same picture in the other programs and the shifted one here.
const MAPPED_SAMPLE_HELPERS = `vec4 mappedSample(sampler2D source, float flag) {
  if (BOX_MAPPED) return sampleBox(source);
  return mapTexture(source, flag);
}
vec3 mappedOrBoxNormal(vec3 normal) {
  if (BOX_MAPPED) return boxMappedNormal(normal);
  return mappedNormal(normal);
}
void main() {`;
const UV_TEXTURE_READ = /texture\((\w+), mapUV\((\w+)\)\)/g;
const SAMPLE_TERNARY = /BOX_MAPPED \? sampleBox\((\w+)\) : mapTexture\(\1, (\w+)\)/g;
const NORMAL_TERNARY = 'BOX_MAPPED ? boxMappedNormal(normal) : mappedNormal(normal)';
// A normal frame (the main normal map and the clearcoat normal map) reads the UV derivatives without the shift, so the tangent frame
// stays the mesh's; the texel itself is fetched at the shifted UV with the unshifted mip gradients.
const NORMAL_FRAME = /vec2 normalCoordinates = mapUV\((\w+)\);\n  vec2 uvX = dFdx\(normalCoordinates\);\n  vec2 uvY = dFdy\(normalCoordinates\);/g;
const NORMAL_TEXEL = 'texture(normalMap, normalCoordinates)';

/** The main fragment shader with every UV-set-0 map read through the parallax shift; the normal frame keeps the unshifted UV. */
export function withHeightParallax(source) {
  const mapped = spliceOnce(source, `vec2 mapUV(float flag) {
  return flag > 1.5 ? lightmapUV : textureUV;
}`, MAPPED_UV);
  const framed = mapped.replace(NORMAL_FRAME, (_match, flag) => `vec2 normalCoordinates = mapUV(${flag});
  vec2 frameCoordinates = normalCoordinates - (${flag} > 1.5 ? vec2(0.0) : parallaxShift);
  vec2 uvX = dFdx(frameCoordinates);
  vec2 uvY = dFdy(frameCoordinates);`);
  if (framed === mapped) throw new Error('The shader source no longer has a normal frame that the heightMap feature splices around.');
  const withHelpers = spliceOnce(framed, 'void main() {', MAPPED_SAMPLE_HELPERS);
  const withGradients = withHelpers.replace(UV_TEXTURE_READ, (_match, sampler, flag) => `mapTexture(${sampler}, ${flag})`);
  const withSamples = withGradients.replace(SAMPLE_TERNARY, (_match, sampler, flag) => `mappedSample(${sampler}, ${flag})`);
  const withNormalTexel = withSamples.split(NORMAL_TEXEL).join('textureGrad(normalMap, normalCoordinates, mapGradientX(hasNormalMap), mapGradientY(hasNormalMap))');
  return spliceOnce(withNormalTexel, NORMAL_TERNARY, 'mappedOrBoxNormal(normal)');
}

/**
 * The march of parallaxUvShift on the CPU, as the check of its numbers (the shader runs only on a GPU). `heightAt(offsetU, offsetV)` is the
 * height texel (1 top, 0 at depth) at the pixel's UV plus that offset, `fullShift` the UV shift the eye ray makes over the full depth and
 * `steps` the ray steps. Returns the UV shift to add to the pixel's UV, as the shader does.
 */
export function referenceParallaxShift(heightAt, fullShift, steps, refineSteps = PARALLAX_REFINE_STEPS) {
  const stepDepth = 1 / steps;
  let rayDepth = 0;
  let previousRayDepth = 0;
  let surfaceDepth = 1 - heightAt(0, 0);
  let previousSurfaceDepth = surfaceDepth;
  for (let stepIndex = 0; stepIndex < steps && rayDepth < surfaceDepth; stepIndex++) {
    previousRayDepth = rayDepth;
    previousSurfaceDepth = surfaceDepth;
    rayDepth += stepDepth;
    surfaceDepth = 1 - heightAt(-fullShift[0] * rayDepth, -fullShift[1] * rayDepth);
  }
  for (let refineIndex = 0; refineIndex < refineSteps; refineIndex++) {
    if (rayDepth <= previousRayDepth || rayDepth < surfaceDepth) break;
    const middleDepth = 0.5 * (previousRayDepth + rayDepth);
    const middleSurface = 1 - heightAt(-fullShift[0] * middleDepth, -fullShift[1] * middleDepth);
    if (middleDepth >= middleSurface) {
      rayDepth = middleDepth;
      surfaceDepth = middleSurface;
    } else {
      previousRayDepth = middleDepth;
      previousSurfaceDepth = middleSurface;
    }
  }
  const above = Math.max(previousSurfaceDepth - previousRayDepth, 0);
  const below = Math.max(rayDepth - surfaceDepth, 0);
  const crossing = previousRayDepth + (rayDepth - previousRayDepth) * above / Math.max(above + below, 1e-6);
  const depth = Math.min(crossing, rayDepth);
  return [-fullShift[0] * depth, -fullShift[1] * depth];
}
