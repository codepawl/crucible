// Parallax occlusion mapping for the main fragment shader (#2839). The code joins the program only when a material has a heightMap and a
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

/** The ray steps a pixel may take at most; the loop bound the GLSL needs at compile time. */
export const MAXIMUM_PARALLAX_STEPS = HEIGHT_PARALLAX_LIMITS.steps[1];
/** The smallest view cosine the march uses: at a grazing angle the ray would run across the whole texture. */
export const MINIMUM_PARALLAX_VIEW_COSINE = 0.08;
/** Fewest steps at a head-on view, as a share of the requested steps. */
export const HEAD_ON_STEP_SHARE = 0.5;
export const HEIGHT_MAP_UNIT = 16;

const MAPPED_UV = `vec2 parallaxShift = vec2(0.0);
vec2 mapUV(float flag) {
  return flag > 1.5 ? lightmapUV : textureUV + parallaxShift;
}`;

const FRAME_UV = `vec2 frameCoordinates = normalCoordinates - (hasNormalMap > 1.5 ? vec2(0.0) : parallaxShift);
  vec2 uvX = dFdx(frameCoordinates);
  vec2 uvY = dFdy(frameCoordinates);`;

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
  vec2 uvX = dFdx(textureUV);
  vec2 uvY = dFdy(textureUV);
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
  float above = max(previousSurfaceDepth - previousRayDepth, 0.0);
  float below = max(rayDepth - surfaceDepth, 0.0);
  float crossing = previousRayDepth + stepDepth * above / max(above + below, 1e-6);
  return -fullShift * min(crossing, rayDepth);
}
`,
  mainStart: `  if (heightState.w > 0.5) parallaxShift = parallaxUvShift(normalize(worldNormal));
`,
});

function spliceOnce(source, anchor, replacement) {
  if (!source.includes(anchor)) throw new Error(`The shader source no longer contains "${anchor}", which the heightMap feature splices around.`);
  return source.replace(anchor, () => replacement);
}

/** The main fragment shader with every UV-set-0 map read through the parallax shift; the normal frame keeps the unshifted UV. */
export function withHeightParallax(source) {
  const mapped = spliceOnce(source, `vec2 mapUV(float flag) {
  return flag > 1.5 ? lightmapUV : textureUV;
}`, MAPPED_UV);
  return spliceOnce(mapped, `vec2 uvX = dFdx(normalCoordinates);
  vec2 uvY = dFdy(normalCoordinates);`, FRAME_UV);
}
