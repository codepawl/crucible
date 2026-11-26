import { environmentLookupGlsl } from './environment-shading.js';
import { registerShaderFeatureCode } from './shader-registry.js';
import { drawLiquidPass } from './liquid-renderer.js';
import { probeLookupGlsl, probeUniformsGlsl } from './probe-glsl.js';
import { ballLensGlsl } from './glass-ball-lens.js';
import { glassDepthMarchGlsl } from './glass-depth-march.js';
import { glassBackFaceGlsl } from './glass-back-face.js';
import { transmissionBlurGlsl } from './transmission-blur.js';
import { waterMirrorFunctionsGlsl, waterMirrorUniformsGlsl } from './water-mirror-glsl.js';

// Importing this module registers the liquid and foam shader. A renderer with a transmissive, liquid or foam part
// needs it; any other renderer never carries it.
// Liquid and foam are drawn after the opaque scene, which is resolved into sceneColor first.
// Liquid: refraction through the scene, Beer-Lambert absorption over a convex-body thickness
// estimate, in-scattering, Fresnel environment reflection and a GGX key highlight.
// Foam: soft blended droplets whose alpha falls off toward their silhouettes.
export const liquidFragmentShader = `#version 300 es
precision highp float;
in vec3 worldPosition;
in vec3 worldNormal;
flat in vec3 baseColor;
flat in vec4 surface;
flat in vec4 instanceEmission;
in vec4 shadowPosition;
in vec2 textureUV;
in vec3 vertexTint;
uniform vec3 eye;
uniform float time;
uniform mat4 viewProjection;
uniform sampler2D sceneColor;
// The opaque pass's depth, in the buffer's convention; depthMapping is (scale, bias, 1 when the buffer is reversed). Glass marches against it.
uniform highp sampler2D sceneDepth;
uniform vec3 depthMapping;
uniform vec2 resolution;
uniform float exposure;
uniform float hdrEnabled;
uniform float worldMode;
uniform float daylight;
uniform vec3 lightDirection;
uniform vec3 keyColor;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;
// x: thickness in metres, y: index of refraction, z: refraction strength, w: scattering
uniform vec4 liquidOptics;
// A transmissive PBR material: x: transmission, y: index of refraction, z: thickness in metres, w: attenuation distance
uniform vec4 glassState;
uniform vec3 glassTint;
// The share of the part that covers the refracted picture: the alpha of a blended glass material, 1 for every other part. The shader raises it by the transmission share: light that passes through glass replaces the scene behind it, so a refracted picture drawn at low alpha would leave an unrefracted ghost of the same scene underneath.
uniform float glassCoverage;
// 1 for a glass cap with no back face (a cornea): the ray bends once on entry and the glass continues behind it.
uniform float glassMediumContinues;
// The IOR of a material graph's fresnel factor of emission (material-graph.js); 0 when the emission has none.
uniform float materialEmissionFresnel;
// The glTF metallic-roughness texture; a flag of 2 or more reads the second UV set, as in the opaque shader.
uniform sampler2D metallicRoughnessMap;
uniform float hasMetallicRoughnessMap;
in vec2 lightmapUV;
// x: foam opacity, y: foam edge softness
uniform vec2 foamShape;
out vec4 outputColor;
const float PI = 3.14159265359;

vec3 toneMap(vec3 color) {
  return clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), 0.0, 1.0);
}

${environmentLookupGlsl}
uniform float environmentEnabled;
// A part with a reflection probe reflects that room (reflection-probes.js binds it for a batch that has one).
${probeUniformsGlsl}${probeLookupGlsl}
// Water that transmits light shows the same mirror picture as water that does not (water-reflection.js binds it for a flagged batch).
${waterMirrorUniformsGlsl}${waterMirrorFunctionsGlsl}

vec3 environmentColor(vec3 direction, float roughness) {
  if (probeEnabled > 0.5) return environmentRadiance(probeSampleDirection(direction, worldPosition), roughness * environmentLevelMax);
  if (environmentEnabled > 0.5) return environmentRadiance(direction, roughness * environmentLevelMax);
  if (worldMode > 0.5) {
    vec3 zenith = vec3(0.20, 0.38, 0.52) * max(daylight, 0.08);
    return mix(fogColor * 0.75, zenith, smoothstep(-0.15, 0.7, direction.y));
  }
  vec3 color = mix(vec3(0.025, 0.035, 0.045), vec3(0.22, 0.25, 0.27), smoothstep(-0.3, 0.8, direction.y));
  float blur = roughness * 0.35;
  float key = smoothstep(0.80 - blur, 0.87, dot(direction, normalize(vec3(-3.0, 5.0, 4.0))));
  float rim = smoothstep(0.90 - blur, 0.97, dot(direction, normalize(vec3(4.0, 2.0, -3.0))));
  float strip = exp(-pow((direction.x + 0.6) / (0.035 + blur), 2.0)) * smoothstep(-0.1, 0.6, direction.y);
  return color + key * vec3(2.8, 2.2, 1.6) + rim * vec3(0.5, 1.6, 1.5) + strip * vec3(0.7);
}

float specularLobe(vec3 normal, vec3 viewDirection, vec3 light, float roughness) {
  float normalLight = max(dot(normal, light), 0.0);
  if (normalLight == 0.0) return 0.0;
  vec3 halfway = normalize(viewDirection + light);
  float normalView = max(dot(normal, viewDirection), 0.001);
  float normalHalf = max(dot(normal, halfway), 0.0);
  float alpha = roughness * roughness;
  float denominator = normalHalf * normalHalf * (alpha * alpha - 1.0) + 1.0;
  float distribution = alpha * alpha / max(PI * denominator * denominator, 0.00001);
  float masking = pow(roughness + 1.0, 2.0) / 8.0;
  float geometry = normalView / (normalView * (1.0 - masking) + masking) * normalLight / (normalLight * (1.0 - masking) + masking);
  return distribution * geometry / max(4.0 * normalView * normalLight, 0.001) * normalLight;
}

vec3 ambientLight(vec3 normal) {
  vec3 studioAmbient = vec3(0.16, 0.20, 0.22) * (0.45 + 0.55 * max(normal.y, 0.0));
  vec3 worldAmbient = vec3(0.19, 0.25, 0.30) * max(daylight, 0.08) * (0.45 + 0.55 * max(normal.y, 0.0));
  return mix(studioAmbient, worldAmbient, worldMode) * ambientIntensity;
}

${transmissionBlurGlsl}
${ballLensGlsl}
${glassDepthMarchGlsl}
${glassBackFaceGlsl}
vec3 displayed(vec3 radiance) {
  return hdrEnabled > 0.5 ? clamp(radiance * exposure, vec3(0), vec3(65504.0)) : pow(toneMap(radiance * exposure), vec3(1.0 / 2.2));
}

// The opaque shader's emission: the part's emission scaled by the material, times Schlick's Fresnel of the graph's IOR when it has one.
vec3 surfaceEmission(vec3 normal, vec3 viewDirection) {
  vec3 emission = instanceEmission.rgb * surface.z;
  if (materialEmissionFresnel > 0.0) {
    float normalIncidence = pow((materialEmissionFresnel - 1.0) / (materialEmissionFresnel + 1.0), 2.0);
    emission *= normalIncidence + (1.0 - normalIncidence) * pow(1.0 - clamp(dot(normal, viewDirection), 0.0, 1.0), 5.0);
  }
  return emission;
}

void main() {
  // While the mirror picture is drawn, nothing under the water plane is part of it.
  if (waterClip.y > 0.5 && worldPosition.y < waterClip.x + 0.05) discard;
  vec3 normal = normalize(worldNormal);
  if (glassBackPass > 0.5) {
    outputColor = vec4(normal * 0.5 + 0.5, glassBackIdentifier() / 255.0);
    return;
  }
  // Screen-space steps of the position and the normal give the radius of curvature the ball lens model needs.
  float positionStep = length(fwidth(worldPosition));
  float normalStep = length(fwidth(normal));
  if (!gl_FrontFacing) normal = -normal;
  vec3 viewDirection = normalize(eye - worldPosition);
  float facing = max(dot(normal, viewDirection), 0.0);
  vec3 light = normalize(lightDirection);
  vec3 color = baseColor * vertexTint;
  float fog = (1.0 - exp(-length(worldPosition - eye) * fogDensity)) * worldMode;

  if (surface.w == 12.0) {
    float alpha = foamShape.x * smoothstep(0.0, max(foamShape.y, 0.001), facing);
    if (alpha < 0.004) discard;
    float wrapped = max(dot(normal, light) * 0.5 + 0.5, 0.0);
    vec3 radiance = color * (ambientLight(normal) * 1.6 + keyColor * wrapped * 0.32);
    radiance = mix(radiance, fogColor, fog);
    outputColor = vec4(displayed(radiance), alpha);
    return;
  }

  float roughness = clamp(surface.y, 0.02, 1.0);
  vec2 screen = gl_FragCoord.xy / resolution;
  // A convex body is thickest where it faces the camera and thins to nothing at its silhouette.
  bool glass = glassState.x > 0.0;
  // A metal does not transmit: only the dielectric share of the surface lets light through (#2827).
  float metallic = glass ? surface.x : 0.0;
  if (glass && hasMetallicRoughnessMap > 0.5) metallic *= texture(metallicRoughnessMap, hasMetallicRoughnessMap > 1.5 ? lightmapUV : textureUV).b;
  float transmissionShare = glassState.x * (1.0 - metallic);
  float indexOfRefraction = glass ? glassState.y : liquidOptics.y;
  // Glass bends the ray where it enters and where it leaves (a ball lens), then the ray is marched against the opaque depth to the surface
  // it reaches. A liquid bends it once and reads the scene one thickness along. A march that misses reads the scene where the ray last was on the screen.
  float thickness = glass ? glassState.z : liquidOptics.x * mix(0.15, 1.0, facing);
  vec3 bent = refract(-viewDirection, normal, 1.0 / indexOfRefraction);
  vec3 samplePosition = worldPosition + bent * thickness;
  vec3 depthHit = vec3(0.0);
  if (glass && thickness > 0.0) {
    vec3 rayOrigin = worldPosition;
    vec3 rayDirection = bent;
    float reach = thickness;
    if (glassMediumContinues < 0.5) {
      float bodyDepth = glassBackEnabled > 0.5 ? glassBodyDepth(worldPosition, normal, thickness) : 0.0;
      ballLensRay(worldPosition, normal, viewDirection, indexOfRefraction, curvatureRadius(positionStep, normalStep, thickness), thickness, bodyDepth, rayOrigin, rayDirection);
      reach = thickness * SCENE_REACH_PER_THICKNESS;
      // A closed shape's own back face gives the real exit; where none is found the ball lens estimate above stays.
      vec3 backExit;
      vec3 backDirection;
      if (glassBackEnabled > 0.5 && glassBackFaceRay(worldPosition, normal, viewDirection, indexOfRefraction, thickness, backExit, backDirection)) {
        rayOrigin = backExit;
        rayDirection = backDirection;
      }
    }
    samplePosition = rayOrigin + rayDirection * reach;
    depthHit = marchSceneDepth(rayOrigin, rayDirection, thickness * MARCH_REACH_PER_THICKNESS);
  }
  vec4 projected = viewProjection * vec4(samplePosition, 1.0);
  vec2 refracted = projected.w > 0.0 ? projected.xy / projected.w * 0.5 + 0.5 : screen;
  if (depthHit.z > 0.25) refracted = depthHit.xy;
  refracted = clamp(mix(screen, refracted, glass ? 1.0 : liquidOptics.z), vec2(0.001), vec2(0.999));
  // Rough glass reads a blurrier level of the scene's mip chain; a scene without one (or a liquid) reads the sharp image.
  float blurLevel = glass ? transmissionBlurLevel(roughness, indexOfRefraction, resolution) : 0.0;
  vec3 behind = textureLod(sceneColor, refracted, blurLevel).rgb;
  // The material colour is what one metre of this liquid lets through.
  // For a PBR material the colour tints what passes through and the attenuation colour is what attenuationDistance metres let through.
  vec3 absorption = pow(clamp(glass ? glassTint : color, vec3(0.001), vec3(1.0)), vec3(glass ? thickness / glassState.w : thickness));
  vec3 transmittance = glass ? color * absorption : absorption;
  float surfaceReflectance = pow((indexOfRefraction - 1.0) / (indexOfRefraction + 1.0), 2.0);
  float reflectance = surfaceReflectance + (1.0 - surfaceReflectance) * pow(1.0 - facing, 5.0);
  // A metal reflects all of it, tinted by its colour.
  reflectance = mix(reflectance, 1.0, metallic);
  vec3 reflectionTint = mix(vec3(1.0), color, metallic);
  vec3 inScatter = color * (ambientLight(normal) + keyColor * max(dot(normal, light), 0.0) * 0.2) * (glass ? 0.0 : liquidOptics.w) * (1.0 - transmittance);
  // The share of a PBR material that does not transmit is lit like a diffuse surface, weighted by blended coverage.
  vec3 diffuseShare = glass ? color * (1.0 - transmissionShare) * (1.0 - metallic) * glassCoverage * (ambientLight(normal) + keyColor * max(dot(normal, light), 0.0) / PI) : vec3(0.0);
  vec3 reflection = environmentColor(reflect(-viewDirection, normal), roughness) * ambientIntensity;
  if (waterReflectionEnabled > 0.5) reflection = mix(reflection, waterMirrorColor(worldPosition, roughness), waterMirrorWeight(roughness));
  vec3 highlight = keyColor * specularLobe(normal, viewDirection, light, roughness);
  vec3 surfaceLight = (inScatter + diffuseShare) * (1.0 - reflectance) + reflection * reflectionTint * reflectance + highlight * reflectionTint;
  // Emission adds to the surface light, not to the refracted picture, so glass transmits and glows at once (#3279).
  surfaceLight += surfaceEmission(normal, viewDirection);
  surfaceLight = mix(surfaceLight, fogColor, fog);
  float transmitted = glass ? transmissionShare : 1.0;
  outputColor = vec4(behind * transmittance * transmitted * (1.0 - reflectance) * (1.0 - fog) + displayed(surfaceLight), glass ? glassOutputCoverage(glassCoverage, transmissionShare) : 1.0);
}`;

registerShaderFeatureCode('liquid', { fragment: liquidFragmentShader, draw: drawLiquidPass });
