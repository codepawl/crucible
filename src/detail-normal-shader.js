// Tiled secondary tangent-space normal mapping (RNM) and micro-roughness modulation for standard PBR materials (#3566).
// Loaded lazily only when a material sets detailNormalMap so scenes without it compile identical GLSL and pay zero bundle bytes.

import { DETAIL_NORMAL_UNIT, DETAIL_NORMAL_FEATURE, layerTextureSupport, registerShaderFeatureCode } from './shader-registry.js';

export const DETAIL_UV_SCALE_MAX = 1024;
export const DETAIL_ROUGHNESS_MIN = 0.04;
export { DETAIL_NORMAL_UNIT, DETAIL_NORMAL_FEATURE };

const MAPPED_NORMAL_ANCHOR = 'vec3 mappedNormal(vec3 normal) {';
const NORMAL_COORDS_LINE = '  vec2 normalCoordinates = mapUV(hasNormalMap);';
const PRIMARY_FETCH_PATTERN = /  vec4 normalTexel = ([^\n]+);\n  vec3 sampled = normalTexel\.xyz \* 2\.0 - 1\.0;\n  normalMapVariance = mappedNormalVariance\(normalTexel\);\n  sampled\.xy \*= normalScale;/g;
const MAIN_NORMAL_ANCHOR = '  if (USES_NORMAL_MAP) normal = ensureValidReflection(geometricNormal, viewDirection, ';
const OCCLUSION_NORMAL_ANCHOR = '  if (USES_NORMAL_MAP) occlusion *= pow(0.5 + 0.5 * dot(normal, geometricNormal), 2.0);';
const MOSS_ANCHOR = '  float mossCover = 0.0;';

function detailNormalDeclarations(parallaxed) {
  const detailSampleCall = parallaxed
    ? 'textureGrad(detailNormalMap, mapUV(detailNormalState.x) * detailNormalScale.zw, mapGradientX(detailNormalState.x) * detailNormalScale.zw, mapGradientY(detailNormalState.x) * detailNormalScale.zw)'
    : 'texture(detailNormalMap, mapUV(detailNormalState.x) * detailNormalScale.zw)';
  return `uniform sampler2D detailNormalMap;
// xy: detailNormalScale, zw: detailUvScale
uniform vec4 detailNormalScale;
// x: hasDetailNormalMap (0 none, 1 uv0, 2 uv1), y: detailRoughnessStrength
uniform vec2 detailNormalState;
float detailRoughnessDelta = 0.0;
vec3 reorientNormal(vec3 baseNormal, vec3 detailNormal) {
  vec3 reorientedBase = baseNormal + vec3(0.0, 0.0, 1.0);
  reorientedBase.z = max(reorientedBase.z, 1e-4);
  vec3 reorientedDetail = detailNormal * vec3(-1.0, -1.0, 1.0);
  vec3 blended = reorientedBase * dot(reorientedBase, reorientedDetail) - reorientedDetail * reorientedBase.z;
  return dot(blended, blended) > 1e-12 ? normalize(blended) : baseNormal;
}
vec3 applyDetailTangentNormal(vec3 baseNormal, bool hasPrimary) {
  if (detailNormalState.x < 0.5) return baseNormal;
  vec4 detailTexel = ${detailSampleCall};
  vec3 detailSampled = detailTexel.xyz * 2.0 - 1.0;
  detailSampled.xy *= detailNormalScale.xy;
  vec3 detailNormal = dot(detailSampled, detailSampled) > 1e-12 ? normalize(detailSampled) : vec3(0.0, 0.0, 1.0);
  detailRoughnessDelta = clamp(length(detailNormal.xy), 0.0, 1.0);
  float primarySpread = normalMapSpread;
  float detailVariance = mappedNormalVariance(detailTexel);
  if (!hasPrimary) {
    normalMapVariance = detailVariance;
    return detailNormal;
  }
  normalMapVariance += detailVariance;
  normalMapSpread = max(primarySpread, normalMapSpread);
  vec3 primaryUnit = dot(baseNormal, baseNormal) > 1e-12 ? normalize(baseNormal) : vec3(0.0, 0.0, 1.0);
  return reorientNormal(primaryUnit, detailNormal);
}`;
}

function spliceOnce(source, anchor, replacement) {
  if (!source.includes(anchor)) throw new Error(`The shader source no longer contains "${anchor}", which the detailNormalMap feature splices around.`);
  return source.replace(anchor, () => replacement);
}

/** Rewrites the main fragment shader to sample tiled detailNormalMap, RNM-blend with normalMap (or perturb directly), and modulate micro-roughness. */
export function withDetailNormal(source) {
  const parallaxed = source.includes('vec2 mapGradientX(');
  const withDeclarations = spliceOnce(source, MAPPED_NORMAL_ANCHOR, `${detailNormalDeclarations(parallaxed)}\n${MAPPED_NORMAL_ANCHOR}`);
  const withCoords = withDeclarations.split(NORMAL_COORDS_LINE).join('  float activeNormalFlag = USES_NORMAL_MAP ? hasNormalMap : detailNormalState.x;\n  vec2 normalCoordinates = mapUV(activeNormalFlag);');
  const withFrame = parallaxed
    ? withCoords.replace('(hasNormalMap > 1.5 ? vec2(0.0) : parallaxShift)', '(activeNormalFlag > 1.5 ? vec2(0.0) : parallaxShift)')
    : withCoords;
  const withBlend = withFrame.replace(PRIMARY_FETCH_PATTERN, (_match, fetchExpr) => `  vec3 sampled = vec3(0.0, 0.0, 1.0);
  if (USES_NORMAL_MAP) {
    vec4 normalTexel = ${fetchExpr};
    sampled = normalTexel.xyz * 2.0 - 1.0;
    normalMapVariance = mappedNormalVariance(normalTexel);
    sampled.xy *= normalScale;
  }
  sampled = applyDetailTangentNormal(sampled, USES_NORMAL_MAP);`);
  if (withBlend === withFrame) throw new Error('The shader source no longer has the normal fetch block that detailNormalMap splices around.');
  const withNormalGate = spliceOnce(withBlend, MAIN_NORMAL_ANCHOR, '  bool usesAnyNormalMap = USES_NORMAL_MAP || (!BOX_MAPPED && detailNormalState.x > 0.5);\n  if (usesAnyNormalMap) normal = ensureValidReflection(geometricNormal, viewDirection, ');
  const withOcclusion = spliceOnce(withNormalGate, OCCLUSION_NORMAL_ANCHOR, '  if (usesAnyNormalMap) occlusion *= pow(0.5 + 0.5 * dot(normal, geometricNormal), 2.0);');
  return spliceOnce(withOcclusion, MOSS_ANCHOR, `  if (detailNormalState.x > 0.5 && detailNormalState.y > 0.0) {
    roughness = clamp(roughness + detailNormalState.y * detailRoughnessDelta, ${DETAIL_ROUGHNESS_MIN}, 1.0);
  }
${MOSS_ANCHOR}`);
}

/** Reference Reoriented Normal Mapping (RNM) blend of two unit tangent-space normals, matching the fragment shader. */
export function reorientNormalValues(baseNormal, detailNormal) {
  const reorientedBase = [baseNormal[0], baseNormal[1], Math.max(baseNormal[2] + 1, 1e-4)];
  const reorientedDetail = [-detailNormal[0], -detailNormal[1], detailNormal[2]];
  const dot = reorientedBase[0] * reorientedDetail[0] + reorientedBase[1] * reorientedDetail[1] + reorientedBase[2] * reorientedDetail[2];
  const blended = [
    reorientedBase[0] * dot - reorientedDetail[0] * reorientedBase[2],
    reorientedBase[1] * dot - reorientedDetail[1] * reorientedBase[2],
    reorientedBase[2] * dot - reorientedDetail[2] * reorientedBase[2],
  ];
  const length = Math.hypot(blended[0], blended[1], blended[2]);
  return length > 1e-12 ? [blended[0] / length, blended[1] / length, blended[2] / length] : [...baseNormal];
}

/** Reference micro-slope roughness delta computed from a unit tangent-space detail normal, matching the fragment shader. */
export function detailRoughnessDeltaFromNormal(detailNormal) {
  return Math.min(Math.max(Math.hypot(detailNormal[0], detailNormal[1]), 0), 1);
}

/** Reference micro-roughness modulation, matching the fragment shader (`strength === 0` leaves `roughness` unchanged). */
export function applyDetailRoughness(roughness, strength, detailNormal) {
  if (!(strength > 0)) return roughness;
  const delta = detailRoughnessDeltaFromNormal(detailNormal);
  return Math.min(Math.max(roughness + strength * delta, DETAIL_ROUGHNESS_MIN), 1);
}

export function validateDetailNormalScale(value) {
  if (value === undefined) return [1, 1];
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
      throw new RangeError(`detailNormalScale must be finite; got ${value}. Pass a finite number or [scaleX, scaleY] such as [1, 1].`);
    }
    return [value, value];
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError('detailNormalScale must be a finite number or a two-element array [scaleX, scaleY], such as [1, 1].');
  }
  for (let index = 0; index < 2; index++) {
    const component = value[index];
    if (typeof component !== 'number') {
      throw new TypeError(`detailNormalScale[${index}] must be a finite float, got ${typeof component}.`);
    }
    if (!Number.isFinite(component) || !Number.isFinite(Math.fround(component))) {
      throw new RangeError(`detailNormalScale[${index}] must be a finite float, got ${component}.`);
    }
  }
  return [value[0], value[1]];
}

export function validateDetailUvScale(value) {
  if (value === undefined) return [1, 1];
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > DETAIL_UV_SCALE_MAX) {
      throw new RangeError(`detailUvScale must be within (0, ${DETAIL_UV_SCALE_MAX}]; got ${value}. Use a positive tiling multiplier such as 8.`);
    }
    return [value, value];
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`detailUvScale must be a positive number or a two-element array [u, v] within (0, ${DETAIL_UV_SCALE_MAX}], such as 8.`);
  }
  for (let index = 0; index < 2; index++) {
    const component = value[index];
    if (typeof component !== 'number') {
      throw new TypeError(`detailUvScale[${index}] must be a positive number within (0, ${DETAIL_UV_SCALE_MAX}].`);
    }
    if (!Number.isFinite(component) || component <= 0 || component > DETAIL_UV_SCALE_MAX) {
      throw new RangeError(`detailUvScale[${index}] must be within (0, ${DETAIL_UV_SCALE_MAX}]; got ${component}.`);
    }
  }
  return [value[0], value[1]];
}

export function validateDetailRoughnessStrength(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'number') {
    throw new TypeError(`detailRoughnessStrength must be a number from 0 to 1, such as 0.45.`);
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`detailRoughnessStrength must be between 0 and 1; got ${value}. Use a value such as 0.45.`);
  }
  return value;
}

/**
 * Validates detailNormalMap and its options, returning `[detailNormalMap, scaleX, scaleY, uvScaleX, uvScaleY, roughnessStrength]`.
 */
export function detailNormalState(material, proceduralTags) {
  const [scaleX, scaleY] = validateDetailNormalScale(material.detailNormalScale);
  const [uvScaleX, uvScaleY] = validateDetailUvScale(material.detailUvScale);
  const roughnessStrength = validateDetailRoughnessStrength(material.detailRoughnessStrength);
  const descriptor = material.detailNormalMap;
  if (!descriptor) {
    throw new Error('detailNormalScale, detailUvScale and detailRoughnessStrength require detailNormalMap on the material.');
  }
  if (typeof descriptor !== 'object' || !descriptor.image) {
    throw new TypeError('detailNormalMap must be a texture descriptor with an image and colorSpace: "linear".');
  }
  if (material.boxMapScale > 0 || proceduralTags.has(material.tag) || material.tag === 'unlit') {
    throw new Error('detailNormalMap needs a standard PBR material with UVs: remove detailNormalMap, or remove boxMapScale and use the surface tag.');
  }
  if (descriptor.colorSpace !== 'linear') {
    throw new Error('detailNormalMap requires a linear texture descriptor (colorSpace: "linear").');
  }
  return [descriptor, scaleX, scaleY, uvScaleX, uvScaleY, roughnessStrength];
}

const EMPTY_PROCEDURAL_TAGS = new Set();

function uniformOf(renderer, name) {
  renderer.uniforms[name] ??= renderer.context.getUniformLocation(renderer.program, name);
  return renderer.uniforms[name];
}

/** Binds detailNormalMap uniforms and texture unit for the current batch. */
export function bindDetailNormal(renderer, batch) {
  if (!renderer.shaderFeatures?.has(DETAIL_NORMAL_FEATURE)) return;
  const context = renderer.context;
  const material = batch?.parts?.[0]?.material;
  const state = material?.detailNormalMap ? detailNormalState(material, EMPTY_PROCEDURAL_TAGS) : [];
  const [descriptor = null, scaleX = 1, scaleY = 1, uvScaleX = 1, uvScaleY = 1, roughnessStrength = 0] = state;
  const texture = descriptor ? renderer.createTexture(descriptor, true) : renderer.whiteTexture;
  context.uniform4f(uniformOf(renderer, 'detailNormalScale'), scaleX, scaleY, uvScaleX, uvScaleY);
  context.uniform2f(uniformOf(renderer, 'detailNormalState'), descriptor ? 1 + (descriptor.uvChannel ?? 0) : 0, roughnessStrength);
  context.uniform1i(uniformOf(renderer, 'detailNormalMap'), DETAIL_NORMAL_UNIT);
  context.activeTexture(context.TEXTURE0 + DETAIL_NORMAL_UNIT);
  context.bindTexture(context.TEXTURE_2D, texture);
  context.activeTexture(context.TEXTURE0);
}

registerShaderFeatureCode(DETAIL_NORMAL_FEATURE, Object.freeze({ rewrite: withDetailNormal, state: detailNormalState, bind: bindDetailNormal }));
const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  bindDetailNormal(renderer, batch);
};
