import { registerShaderFeatureCode } from './shader-registry.js';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes, LOCAL_VOLUME_MAXIMUM_STEPS, LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS, LOCAL_VOLUME_DETAIL_SHADOW_TAPS, LOCAL_VOLUME_STEPS_PER_NOISE_CELL, LOCAL_VOLUME_BLUR_PIXELS, LOCAL_VOLUME_BLUR_RATE, LOCAL_VOLUME_EDGE_WARP, LOCAL_VOLUME_KEY_GAIN, LOCAL_VOLUME_LIGHT_DEPTH_SATURATION, LOCAL_VOLUME_SHADOW_STRENGTH, LOCAL_VOLUME_SKY_GAIN, LOCAL_VOLUME_SUN_FLATTEN, LOCAL_VOLUME_GRID_MAXIMUM_STEPS, LOCAL_VOLUME_SURFACE_SHADOW_TAPS, LOCAL_VOLUME_GRID_SHADOW_TAPS, LOCAL_VOLUME_MAXIMUM_SCATTER_OCTAVES, LOCAL_VOLUME_MAXIMUM_NOISE_OCTAVES, LOCAL_VOLUME_MULTI_SCATTER, LOCAL_VOLUME_MULTI_EXTINCTION, LOCAL_VOLUME_MULTI_ANISOTROPY, MAX_LOCAL_VOLUMES } from './local-volumes.js';
import { createLocalVolumeCompositeFragment } from './post.js';
import { fullscreenVertex } from './gl-program.js';
import { backendFor } from './glaze-backend.js';
import { LOCAL_VOLUME_RAMP_STOPS } from './local-volume-ramp.js';
import { bindLocalVolumeParts } from './local-volume-parts.js';
import { fireLightsOf } from './local-volume-fire-light.js';
import { MAX_POINT_LIGHTS } from './light-limits.js';
import { GRID_BORDER_VOXELS, GRID_MOTION_TIME_STEP, HALF_FLOAT_MAXIMUM, bakedGridEmission, floatToHalf, gridUnitVelocity } from './volume-grid.js';
import { STEP_INTEGRAL_GLSL } from './volume-step-integral.js';
import { drawMeshVolumes } from './mesh-volume-pass.js';
import { FogFieldTexture, createFogLightBuffers, packFogLights, volumeShadowAmbient, DEFAULT_FLOW_STRENGTH, DEFAULT_FLOW_PERIOD, resolveFogDetail, fogUsesDetail } from './fog-field.js';

// The volume fog step of the post pass: its uniforms and the march that scatters light through the fog box. Only a renderer that
// draws a frame with environment.volumeFog needs this module; post.js gives every other post program a stub. It reads hash and
// cloudNoise from the post shader. Recipes and the film load it by themselves.

function bindUniforms(renderer, post, volume, environment, frame) {
  const backend = backendFor(renderer);
  backend.bindTextureUnit(3, renderer.shadowTexture);
  backend.uniform1i(post.uniforms.volumeShadowMap, 3);
  backend.uniformMatrix4fv(post.uniforms.volumeLightProjection, renderer.lightProjection);
  backend.uniform3fv(post.uniforms.volumeLightDirection, environment.lightDirection);
  backend.uniform3fv(post.uniforms.volumeLightColor, renderer.lighting.keyColor);
  backend.uniform1f(post.uniforms.volumeDensity, volume.density);
  backend.uniform3fv(post.uniforms.volumeMinimum, volume.minimum);
  backend.uniform3fv(post.uniforms.volumeMaximum, volume.maximum);
  backend.uniform3fv(post.uniforms.volumeColor, volume.color);
  backend.uniform3fv(post.uniforms.volumeAmbient, volume.ambient);
  backend.uniform3fv(post.uniforms.volumeDrift, volume.drift);
  backend.uniform1i(post.uniforms.volumeSteps, volume.steps);
  backend.uniform1f(post.uniforms.volumeAnisotropy, volume.anisotropy);
  backend.uniform1f(post.uniforms.volumeShadowAmbient, volumeShadowAmbient(volume, renderer.sceneParts, renderer.skyOpenness));
  backend.uniform1f(post.uniforms.volumeNoiseAmount, volume.noiseAmount);
  backend.uniform1f(post.uniforms.volumeNoiseScale, volume.noiseScale);
  backend.uniform1f(post.uniforms.volumeMaxDistance, volume.maxDistance);
  backend.uniform1f(post.uniforms.volumeHeightFalloff, volume.heightFalloff);
  bindFieldAndLights(renderer, post, volume, backend);
  bindDetail(backend, post, volume);
  backend.uniform1f(post.uniforms.orthographic, frame.projection === 'orthographic' ? 1 : 0);
  backend.uniform1i(post.uniforms.fogSkyVisibility, 5);
  backend.uniform1f(post.uniforms.volumeGridFog, fogIsLitByGrid(renderer.sceneParts) ? 1 : 0);
}

/** True when a baked irradiance grid lights the fog. A sky-only grid (src/sky-occlusion-grid.js) holds no light, so it leaves the fog as it was (#3289). */
export function fogIsLitByGrid(parts) {
  return parts.some(part => part.material?.irradianceGrid && !part.material.irradianceGrid.skyOnly);
}

// Detail, layer top and key light controls. The detail ones only act in a program with the detail step compiled in (fogUsesDetail).
function bindDetail(backend, post, volume) {
  const detail = resolveFogDetail(volume);
  // The renderer's post uniform list knows only the older fields; these locations are looked up here, once per program.
  const locate = name => (post.uniforms[name] ??= backend.uniformLocation(post.program, name));
  backend.uniform1i(locate('volumeDetailOctaves'), detail.detailOctaves);
  backend.uniform1f(locate('volumeDetailAmount'), detail.detailAmount);
  backend.uniform1f(locate('volumeWarp'), detail.warp);
  backend.uniform1f(locate('volumeContrast'), detail.contrast);
  backend.uniform1f(locate('volumeProfileStart'), detail.profileSoftness);
  backend.uniform1f(locate('volumeKeyScattering'), detail.keyScattering);
  backend.uniform1i(locate('volumeScatterOctaves'), detail.scatterOctaves);
  backend.uniform1f(locate('volumeMultiScatter'), detail.multiScatter);
  backend.uniform1f(locate('volumeMultiExtinction'), detail.multiExtinction);
  backend.uniform1f(locate('volumeMultiAnisotropy'), detail.multiAnisotropy);
  backend.uniform1f(locate('volumeKeyTransmittance'), detail.keyTransmittance);
  backend.uniform1f(locate('volumeSurfaceTransmittance'), detail.surfaceTransmittance);
  backend.uniform1f(locate('volumeBeamRadius'), detail.beamRadius);
}

// The fog's field texture and light buffers; a program without those steps has no such uniforms, and a null location is ignored.
function bindFieldAndLights(renderer, post, volume, backend = backendFor(renderer)) {
  if (volume.field) {
    renderer.fogFieldTexture ??= new FogFieldTexture(backend);
    backend.activeTextureUnit(6);
    renderer.fogFieldTexture.upload(volume.field);
    backend.uniform1i(post.uniforms.volumeField, 6);
    backend.uniform1f(post.uniforms.volumeProfile, volume.profile === 'smoothstep' ? 1 : 0);
    backend.uniform1f(post.uniforms.volumeFlowStrength, volume.flowStrength ?? DEFAULT_FLOW_STRENGTH);
    backend.uniform1f(post.uniforms.volumeFlowPeriod, volume.flowPeriod ?? DEFAULT_FLOW_PERIOD);
  }
  const lights = renderer.fogLightBuffers;
  backend.uniform1i(post.uniforms.volumeLightCount, lights.count);
  if (lights.count === 0) return;
  backend.uniform4fv(post.uniforms['volumeLightPositions[0]'], lights.positions);
  backend.uniform4fv(post.uniforms['volumeLightColors[0]'], lights.colors);
  backend.uniform4fv(post.uniforms['volumeLightDirections[0]'], lights.directions);
  backend.uniform4fv(post.uniforms['volumeLightCones[0]'], lights.cones);
}

// The local volumes of the frame (environment.localVolumes), checked and packed once before the post program is chosen, so a bad
// field or a renderer without depth or HDR throws before any program is bound. Returns the count packed, or 0 for an empty list.
function prepareLocalVolumes(renderer, input, frame, volumeTime = 0, volumeShutter = 0) {
  const resolved = resolveLocalVolumes(input, 'environment.localVolumes');
  if (resolved.length === 0) return 0;
  if (!renderer.depth || !renderer.hdr || renderer.transparent || renderer.benchmark) throw new Error('Local volumes require depth:true, active HDR and an opaque canvas');
  const buffers = (renderer.localVolumeBuffers ??= createLocalVolumeBuffers());
  packLocalVolumes(bindLocalVolumeParts(resolved, renderer.sceneParts, { time: volumeTime, shutter: volumeShutter }), buffers);
  drawMeshVolumes(renderer, frame);
  return buffers.count;
}

/**
 * The frame's environment with the point lights of the local volumes that set `lightsScene` added after the scene's own, as many as fit (#1046).
 * A frame with no such volume returns the environment it was given.
 */
function withVolumeFireLights(renderer, environment, volumeTime = 0) {
  if (!Array.isArray(environment.localVolumes) || !environment.localVolumes.some(volume => volume?.lightsScene === true)) return environment;
  const resolved = resolveLocalVolumes(environment.localVolumes, 'environment.localVolumes');
  const ownLights = environment.pointLights ?? [];
  const fireLights = fireLightsOf(bindLocalVolumeParts(resolved, renderer.sceneParts, { time: volumeTime }), MAX_POINT_LIGHTS - ownLights.length);
  return fireLights.length === 0 ? environment : { ...environment, pointLights: [...ownLights, ...fireLights] };
}

// Draws the local volumes over the frame into a texture of their own, before bloom extraction, so the glow of an emitting volume blooms (#1046). The final pass then
// skips its local step and reads this texture. The pass runs only for a frame with bloom and a glowing volume, so every other frame draws as before.
function compositeLocalVolumes(renderer, frame, environment, sourceTexture) {
  const backend = backendFor(renderer);
  const composite = (renderer.localVolumeComposite ??= { program: null, uniforms: {}, target: null, motion: false, kind: 'both' });
  const motion = renderer.localVolumeBuffers.gridShutter > 0;
  const kind = renderer.localVolumeBuffers.kind;
  const noiseOctaves = renderer.localVolumeBuffers.noiseOctaves;
  const gridDetail = renderer.localVolumeBuffers.gridDetail;
  if (composite.program && (composite.motion !== motion || composite.kind !== kind || composite.noiseOctaves !== noiseOctaves || composite.gridDetail !== gridDetail)) {
    backend.deleteProgram(composite.program);
    composite.program = null;
    composite.uniforms = {};
  }
  if (!composite.program) {
    composite.motion = motion;
    composite.kind = kind;
    composite.noiseOctaves = noiseOctaves;
    composite.gridDetail = gridDetail;
    composite.program = backend.compileProgram(fullscreenVertex, createLocalVolumeCompositeFragment(motion, kind, noiseOctaves, gridDetail));
    for (const name of ['frameTexture', 'sceneDepth', 'resolution', 'inverseViewProjection', 'eye']) composite.uniforms[name] = backend.uniformLocation(composite.program, name);
  }
  if (!composite.target) composite.target = createCompositeTarget(backend, renderer.canvas);
  backend.beginFullscreenPass(composite.target.framebuffer, renderer.canvas.width, renderer.canvas.height, composite.program);
  if (renderer.localVolumeBuffers.blurred) {
    backend.setTextureMipmaps(sourceTexture, true, 0);
  } else {
    backend.bindTextureUnit(0, sourceTexture);
  }
  backend.uniform1i(composite.uniforms.frameTexture, 0);
  backend.bindTextureUnit(1, renderer.depthTexture ?? renderer.whiteTexture);
  backend.uniform1i(composite.uniforms.sceneDepth, 1);
  backend.uniform2f(composite.uniforms.resolution, renderer.canvas.width, renderer.canvas.height);
  backend.uniformMatrix4fv(composite.uniforms.inverseViewProjection, renderer.inverseViewProjection);
  backend.uniform3fv(composite.uniforms.eye, frame.eye);
  bindLocalVolumes(renderer, composite, frame, environment);
  backend.drawFullscreenTriangles();
  if (renderer.localVolumeBuffers.blurred) {
    // Only this pass reads the mip chain; the frame goes back to one level so a later pass never reads a stale one.
    backend.setTextureMipmaps(sourceTexture, false, 0);
  }
  return composite.target.texture;
}

function createCompositeTarget(backend, { width, height }) {
  const target = backend.createFramebufferTarget({ width, height, hdr: true, linear: true, clamp: true });
  if (!target.complete) {
    backend.deleteFramebuffer(target.framebuffer);
    backend.deleteTexture(target.colorTexture);
    throw new Error('The local volume composite target could not be allocated. Choose a lower quality preset.');
  }
  return { texture: target.colorTexture, framebuffer: target.framebuffer };
}

// Frees the composite target (at a resize or a release) or the target and the program (at dispose).
function releaseLocalVolumeComposite(renderer, disposeProgram) {
  const composite = renderer.localVolumeComposite;
  if (!composite) return;
  const backend = backendFor(renderer);
  if (composite.target) {
    backend.deleteTexture(composite.target.texture);
    backend.deleteFramebuffer(composite.target.framebuffer);
    composite.target = null;
  }
  if (disposeProgram && composite.program) {
    backend.deleteProgram(composite.program);
    renderer.localVolumeComposite = null;
  }
}

// Uploads the packed volumes. Their uniforms exist only in a program with the local step compiled in.
function bindLocalVolumes(renderer, post, frame, environment) {
  const backend = backendFor(renderer);
  const buffers = renderer.localVolumeBuffers;
  const locate = name => (post.uniforms[name] ??= backend.uniformLocation(post.program, name));
  bindKeyLight(renderer, locate, environment, backend);
  backend.uniform1i(locate('localVolumeCount'), buffers.count);
  backend.uniform1f(locate('localOrthographic'), frame.projection === 'orthographic' ? 1 : 0);
  backend.uniform4fv(locate('localVolumeCenters[0]'), buffers.centers);
  backend.uniform4fv(locate('localVolumeExtents[0]'), buffers.extents);
  backend.uniform4fv(locate('localVolumeAbsorption[0]'), buffers.absorption);
  backend.uniform4fv(locate('localVolumeEmission[0]'), buffers.emission);
  backend.uniform4fv(locate('localVolumeSteps[0]'), buffers.steps);
  backend.uniform4fv(locate('localVolumeAxes[0]'), buffers.axes);
  const gridTexture = localGridTexture(renderer, buffers.gridVolume?.gridData ?? null);
  const gridEmission = localGridEmissionTexture(renderer, buffers.gridVolume);
  const gridVelocity = buffers.gridShutter > 0 ? localGridVelocityTexture(renderer, buffers.gridVolume) : null;
  // The sampler always gets a texture of its own type, so the program is valid in a frame with no mesh volume.
  backend.bindTextureUnit(7, buffers.meshParts.length > 0 ? renderer.meshVolumePass.target.texture : renderer.whiteTexture);
  backend.uniform1i(locate('localMeshVolumes'), 7);
  backend.uniform4fv(locate('localVolumeGrid[0]'), buffers.grid);
  backend.uniform4fv(locate('localVolumeRampSetup[0]'), buffers.rampSetup);
  backend.uniform4fv(locate('localVolumeRamp[0]'), buffers.rampColors);
  backend.bindTextureUnit(8, gridTexture, '3d');
  backend.uniform1i(locate('localGridTexture'), 8);
  backend.bindTextureUnit(9, gridEmission, '3d');
  backend.uniform1i(locate('localGridEmissionTexture'), 9);
  // The velocity texture and the shutter exist only in the 'gridMotion' program variant, so a frame with the shutter off binds nothing more than it did before (#1759).
  if (gridVelocity) {
    backend.uniform1f(locate('localGridShutter'), buffers.gridShutter);
    backend.bindTextureUnit(10, gridVelocity, '3d');
    backend.uniform1i(locate('localGridVelocityTexture'), 10);
  }
  // The emission of the glowing surfaces, when the frame drew it (drawEmissionMask): the surface shadow leaves it alone.
  const maskReady = renderer.localEmissionMaskReady === true;
  backend.bindTextureUnit(11, maskReady ? renderer.passSupport.texture : renderer.whiteTexture);
  backend.uniform1i(locate('localEmissionMask'), 11);
  backend.uniform1f(locate('localEmissionMaskReady'), maskReady ? 1 : 0);
}

let emissionMaskDrawer = null;
let emissionMaskLoad = null;

/** volume-emission-mask.js calls this on import with the function that draws the mask. */
export function registerEmissionMaskDrawer(drawer) {
  emissionMaskDrawer = drawer;
}

/** Loads the mask code (the render pass code rides with it) and resolves once it is registered; a host that renders a shadowing volume awaits it before its first frame. */
export function loadEmissionMask() {
  emissionMaskLoad ??= import('./volume-emission-mask.js');
  return emissionMaskLoad;
}

/**
 * Draws the emission of the opaque surfaces as a float pass into the render pass target, before the frame itself, when a volume with `castShadow` sits over glowing parts,
 * so the post pass can leave their emission out of the light it dims (#1360). Returns whether it drew the mask; a frame with nothing to mask costs nothing.
 * The drawing code is a lazy chunk: until it has loaded (loadEmissionMask, or the `volumeEmissionMask` agent scene module) a frame dims the glow as before.
 */
function drawEmissionMask(renderer, frame) {
  const environment = { ...renderer.environment, ...frame.environment };
  const volumes = environment.localVolumes;
  if (!Array.isArray(volumes) || !renderer.depth || !renderer.hdr || !((environment.keyIntensity ?? 1) > 0)) return false;
  const shadowing = volumes.some(volume => volume?.shape !== 'mesh' && volume?.castShadow === true && (volume?.density ?? 1) > 0);
  if (!shadowing || !renderer.sceneParts.some(part => (part.material?.emission ?? 0) > 0)) return false;
  if (!emissionMaskDrawer) {
    loadEmissionMask().catch(() => {});
    return false;
  }
  emissionMaskDrawer(renderer, frame);
  return true;
}

// The two 3D textures of a grid volume, RGBA16F, linear and clamped, uploaded once per grid (and per temperature scale for the emission): `localGridTexture` holds
// r density, g temperature, b flame (the density when the grid has no flame channel) and `localGridEmissionTexture` the blackbody radiance of each voxel's
// temperature, baked on the CPU (bakedGridEmission) so the march reads it with one linear tap and the interpolation happens after the blackbody, as Cycles does
// (#1752). Both carry GRID_BORDER_VOXELS empty voxels on every face. A frame with no grid volume gets 1 x 1 x 1 textures, so the samplers are always valid.
function localGridTexture(renderer, grid) {
  const { density, temperature, flame } = grid?.channels ?? {};
  return uploadGridTexture(renderer, 'localGridTextureCache', grid, null, (texels, voxel, texel) => {
    texels[texel] = density[voxel];
    texels[texel + 1] = temperature ? temperature[voxel] : 0;
    texels[texel + 2] = (flame ?? density)[voxel];
  });
}

function localGridEmissionTexture(renderer, volume) {
  const grid = volume?.gridData ?? null;
  // A grid without a temperature channel bakes to zeros: its texture is the zero fill, with no pass over the voxels.
  const baked = grid?.channels.temperature ? bakedGridEmission(grid, volume.temperatureScale, volume.flameTemperature) : null;
  const cacheKey = `${volume?.temperatureScale ?? 0}|${volume?.flameTemperature?.ignition}|${volume?.flameTemperature?.maximum}`;
  return uploadGridTexture(renderer, 'localGridEmissionCache', grid, cacheKey, baked && ((texels, voxel, texel) => {
    texels[texel] = floatToHalf(Math.min(baked.red[voxel], HALF_FLOAT_MAXIMUM));
    texels[texel + 1] = floatToHalf(Math.min(baked.green[voxel], HALF_FLOAT_MAXIMUM));
    texels[texel + 2] = floatToHalf(Math.min(baked.blue[voxel], HALF_FLOAT_MAXIMUM));
  }));
}

// The gas velocity of a grid with velocity channels as box fractions per second, x y z (volume-grid.js gridUnitVelocity), for the motion blur of the march (#1759).
function localGridVelocityTexture(renderer, volume) {
  const grid = volume?.gridData ?? null;
  const velocity = grid ? gridUnitVelocity(grid, volume.size) : null;
  return uploadGridTexture(renderer, 'localGridVelocityCache', velocity ? grid : null, velocity ? volume.size.join(',') : null, (texels, voxel, texel) => {
    texels[texel] = floatToHalf(velocity.x[voxel]);
    texels[texel + 1] = floatToHalf(velocity.y[voxel]);
    texels[texel + 2] = floatToHalf(velocity.z[voxel]);
  });
}

function uploadGridTexture(renderer, cacheName, grid, scale, writeVoxel) {
  const backend = backendFor(renderer);
  const cached = renderer[cacheName];
  if (cached && cached.grid === grid && cached.scale === scale) return cached.texture;
  const resolution = grid ? grid.resolution : [1, 1, 1];
  // The next frame of a sequence has the resolution of the one before: overwrite its texture instead of making a new one.
  const reuse = cached && cached.resolution.join('x') === resolution.join('x');
  const filled = Boolean(grid && writeVoxel);
  if (reuse && !filled && !cached.filled) {
    // Zeros over zeros (the emission of a grid with no temperature): nothing to upload.
    renderer[cacheName] = { ...cached, grid, scale };
    return cached.texture;
  }
  if (cached && !reuse) backend.deleteTexture(cached.texture);
  const padded = resolution.map(count => count + 2 * GRID_BORDER_VOXELS);
  // The padded buffer is kept with the texture: its border is never written, and a frame with the same resolution overwrites every interior voxel, so a
  // sequence allocates it once instead of once per frame (#1045).
  const texelCount = padded[0] * padded[1] * padded[2] * 4;
  const texels = reuse && cached.texels ? cached.texels : new Uint16Array(texelCount);
  if (!filled) texels.fill(0);
  if (filled) {
    for (let z = 0; z < resolution[2]; z++) {
      for (let y = 0; y < resolution[1]; y++) {
        for (let x = 0; x < resolution[0]; x++) {
          const voxel = x + resolution[0] * (y + resolution[1] * z);
          const texel = ((x + GRID_BORDER_VOXELS) + padded[0] * ((y + GRID_BORDER_VOXELS) + padded[1] * (z + GRID_BORDER_VOXELS))) * 4;
          writeVoxel(texels, voxel, texel);
        }
      }
    }
  }
  const dimensions = { width: padded[0], height: padded[1], depth: padded[2], data: texels };
  let texture;
  if (reuse) {
    texture = cached.texture;
    backend.uploadTexture3D(texture, dimensions);
  } else {
    texture = backend.createTexture3D(dimensions);
  }
  renderer[cacheName] = { grid, scale, texture, resolution, filled, texels };
  return texture;
}

// The renderer's own sky gradient when a scene names none; drawSky in renderer.js holds the same two colours.
const DEFAULT_SKY_TOP = [0.20, 0.38, 0.52];
const DEFAULT_SKY_BOTTOM = [0.62, 0.70, 0.67];

// The sky term of a scattering local volume: the mean of the sky gradient times the ambient intensity.
function localSkyAmbient(renderer, environment) {
  const top = environment.skyTop ?? DEFAULT_SKY_TOP;
  const bottom = environment.skyBottom ?? DEFAULT_SKY_BOTTOM;
  return [0, 1, 2].map(channel => 0.5 * (top[channel] + bottom[channel]) * renderer.lighting.ambientIntensity);
}

// The key light's shadow map, direction and colour, and the sky term, for volumes that scatter. The sampler always has the shadow map
// on its unit, so the program is valid in a frame where no volume scatters.
function bindKeyLight(renderer, locate, environment, backend = backendFor(renderer)) {
  if (renderer.shadowTexture) backend.bindTextureUnit(3, renderer.shadowTexture);
  backend.uniform1i(locate('volumeShadowMap'), 3);
  backend.uniformMatrix4fv(locate('volumeLightProjection'), renderer.lightProjection);
  backend.uniform3fv(locate('volumeLightDirection'), environment.lightDirection);
  backend.uniform3fv(locate('volumeLightColor'), renderer.lighting.keyColor);
  backend.uniform3fv(locate('localSkyAmbient'), localSkyAmbient(renderer, environment));
}

// The in-scatter light of a volume (the sky light through its own depth, the key light through the shadow map) is inlined at every march step, and
// the driver builds each inlined copy. One copy per kind of volume keeps the grid copies free of the box and sphere profile and the other way round:
// a grid scene built in 23 to 32 s on ANGLE d3d11 when both shared one copy (#1768).
// A grid never has the detail shadow, so its light-depth loop stops at the 3 taps it takes.
const GRID_LIGHT_DEPTH_TAPS = 3;
function scatterFunctions(kind) {
  return `// The optical depth of a volume between a point inside it and its far side along a direction, from midpoint taps of its profile.
vec3 localVolumeDepth${kind}(int index, vec3 position, vec3 direction, int taps, bool withNoise) {
  float exitDistance = max(localVolumeInterval(index, position, direction).y, 0.0);
  float profileSum = 0.0;
  for (int tap = 0; tap < ${kind === 'Grid' ? GRID_LIGHT_DEPTH_TAPS : LOCAL_VOLUME_DETAIL_SHADOW_TAPS}; tap++) {
    if (tap >= taps) break;
    profileSum += min(${kind === 'Grid' ? 'localVolumeGridProfile(index, position + direction * (exitDistance * (float(tap) + 0.5) / float(taps)))' : 'localVolumeShapeProfile(index, position + direction * (exitDistance * (float(tap) + 0.5) / float(taps)), withNoise)'} * ${LOCAL_VOLUME_LIGHT_DEPTH_SATURATION.toFixed(3)}, 1.0);
  }
  return localVolumeAbsorption[index].rgb * (profileSum * exitDistance / float(taps));
}
// The depth of one midpoint tap, the case the sky light needs: the loop above would be built eight times over for it.
vec3 localVolumeDepthOnce${kind}(int index, vec3 position, vec3 direction) {
  float exitDistance = max(localVolumeInterval(index, position, direction).y, 0.0);
  float profile = ${kind === 'Grid' ? 'localVolumeGridProfile(index, position + direction * (exitDistance * 0.5))' : 'localVolumeShapeProfile(index, position + direction * (exitDistance * 0.5), false)'};
  return localVolumeAbsorption[index].rgb * (min(profile * ${LOCAL_VOLUME_LIGHT_DEPTH_SATURATION.toFixed(3)}, 1.0) * exitDistance);
}
// The sky light a point receives through the volume's own depth: the mean over the up and four side directions of what one tap leaves.
// Without it the sky term is flat, so a thick smoke glows as evenly deep inside as at its edge and hides the key light's side.
vec3 localVolumeSkyLight${kind}(int index, vec3 position) {
  vec3 open = vec3(0.0);
  for (int side = 0; side < 5; side++) {
    vec3 direction = side == 0 ? vec3(0.0, 1.0, 0.0) : (side == 1 ? vec3(1.0, 0.0, 0.0) : (side == 2 ? vec3(-1.0, 0.0, 0.0) : (side == 3 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 0.0, -1.0))));
    open += exp(-localVolumeDepthOnce${kind}(index, position, direction));
  }
  return localSkyAmbient * (open * ${(0.2 * LOCAL_VOLUME_SKY_GAIN).toFixed(3)});
}
// The light a scattering volume receives at a point: the sky term and the key light through the shadow map, each through the volume's own depth.
vec3 localVolumeInScatter${kind}(int index, vec3 position, vec3 direction) {
  vec3 towardSun = normalize(volumeLightDirection);
  float visibility = keyVisibility(position);
  vec3 sunLight = vec3(0.0);
  if (visibility > 0.001) {
    vec3 lightDirection = normalize(vec3(towardSun.x, towardSun.y * ${LOCAL_VOLUME_SUN_FLATTEN.toFixed(3)}, towardSun.z));
    bool detailShadow = localVolumeGrid[index].y > 0.5 && localVolumeGrid[index].x < 0.5;
    vec3 lightDepth = localVolumeDepth${kind}(index, position, lightDirection, detailShadow ? ${LOCAL_VOLUME_DETAIL_SHADOW_TAPS} : 3, detailShadow) * ${LOCAL_VOLUME_SHADOW_STRENGTH.toFixed(3)};
    // The octave sum of multiple scattering (scatterOctaves, in the free fourth component of the first axis row, as the octaves beyond the first so a volume without it keeps its bytes); one octave is the single scatter.
    float cosine = dot(direction, towardSun);
    int octaves = 1 + int(localVolumeAxes[index * 3].w + 0.5);
    vec3 phaseSum = vec3(0.0);
    float weight = 1.0;
    float extinction = 1.0;
    float anisotropy = localVolumeGrid[index].w;
    for (int octave = 0; octave < ${LOCAL_VOLUME_MAXIMUM_SCATTER_OCTAVES}; octave++) {
      if (octave >= octaves) break;
      phaseSum += weight * henyeyGreenstein(cosine, anisotropy) * exp(-lightDepth * extinction);
      weight *= ${LOCAL_VOLUME_MULTI_SCATTER.toFixed(3)};
      extinction *= ${LOCAL_VOLUME_MULTI_EXTINCTION.toFixed(3)};
      anisotropy *= ${LOCAL_VOLUME_MULTI_ANISOTROPY.toFixed(3)};
    }
    sunLight = volumeLightColor * (visibility * ${LOCAL_VOLUME_KEY_GAIN.toFixed(3)}) * phaseSum;
  }
  return localVolumeSkyLight${kind}(index, position) + sunLight;
}`;
}

const LOCAL_VOLUME_DECLARATIONS = `
uniform int localVolumeCount;
uniform float localOrthographic;
uniform vec4 localVolumeCenters[8];
uniform vec4 localVolumeExtents[8];
uniform vec4 localVolumeAbsorption[8];
uniform vec4 localVolumeEmission[8];
uniform vec4 localVolumeSteps[8];
uniform vec4 localVolumeAxes[24];
uniform vec3 localSkyAmbient;
uniform highp sampler2D localMeshVolumes;
uniform vec4 localVolumeGrid[8];
uniform vec4 localVolumeRampSetup[8];
uniform vec4 localVolumeRamp[${MAX_LOCAL_VOLUMES * LOCAL_VOLUME_RAMP_STOPS}];
uniform highp sampler3D localGridTexture;
uniform highp sampler2D localEmissionMask;
uniform float localEmissionMaskReady;
uniform highp sampler3D localGridEmissionTexture;
`;

// The motion blur of a grid (#1759) compiles in only for a frame whose grid carries velocity and whose shutter is open (post step 'gridMotion'), so every other program
// has exactly the source it had without the feature.
const LOCAL_MOTION_DECLARATIONS = `uniform highp sampler3D localGridVelocityTexture;
uniform float localGridShutter;
`;

// Motion blur of a grid (#1759). The frame's grid is the gas as the shutter opens and the gas moves on by its velocity, so the point seen timeFraction * localGridShutter
// seconds into the shutter reads the grid back along the velocity, as Cycles does with a velocity grid (local-volumes.js localVolumeGridMotionPoint repeats it). The
// velocity texture holds box fractions per second.
const LOCAL_MOTION_POSITION_FUNCTION = `// Motion blur of a grid (#1759): the point a march step reads for its time in the shutter.
vec3 localGridMotionPosition(int index, vec3 position, float timeFraction) {
  vec3 size = localVolumeExtents[index].xyz * 2.0;
  vec3 unit = (position - localVolumeCenters[index].xyz) / size + 0.5;
  vec3 paddedSize = vec3(textureSize(localGridVelocityTexture, 0));
  vec3 velocity = textureLod(localGridVelocityTexture, (unit * (paddedSize - ${2 * GRID_BORDER_VOXELS}.0) + ${GRID_BORDER_VOXELS}.0) / paddedSize, 0.0).rgb;
  return position - velocity * size * (localGridShutter * timeFraction);
}
`;
// One shutter time per step, spread over the ray by the golden ratio (volume-grid.js gridMotionTimeFraction), so the blur adds one velocity tap per step.
const LOCAL_MOTION_SAMPLE_POSITION = `vec3 samplePosition = localGridMotionPosition(nearest, position, fract(gridJitter + float(step) * ${GRID_MOTION_TIME_STEP}));
        vec3 cell = localGridSample(nearest, samplePosition);`;

// The shadow of a blurred grid (#1763): each tap of the surface shadow reads the grid at its own time in the shutter, spread by the golden ratio like the march, so the
// shadow smears the way the gas does. A pixel's jitter starts the spread and the taps of that pixel cover the shutter between them.
const LOCAL_MOTION_SHADOW_PROFILE = `vec3 tapPosition = position + towardSun * (entry + (span.y - entry) * (float(tap) + 0.5) / taps);
      if (isGrid) tapPosition = localGridMotionPosition(index, tapPosition, fract(localVolumeJitter() + float(tap) * ${GRID_MOTION_TIME_STEP}));
      float profile = localVolumeProfile(index, tapPosition, true);`;

// Each volume is marched on its own between its entry and exit (cut at the first surface) and composited nearest first: the colour
// behind it is dimmed by exp(-absorption * profile * step) and its emission is added, both per colour channel.
// With `motion` the grid march reads the point its shutter time selects; without it the source is exactly what it was before the blur existed.
// The fractal noise of a grid volume sits in a narrow band around 0.5; stretching it by this much before a smoothstep gives the clumps crisp edges (#2289).
const GRID_DETAIL_CONTRAST = 1.1;
const localVolumeFunctions =(motion, kind = 'both', noiseOctaves = false, gridDetail = false) => {
  const withGrid = kind !== 'shape';
  const withShape = kind !== 'grid';
  // A frame whose grid volume asks for fine detail (#2289) compiles the noise into the grid march; every other grid program keeps the source it had.
  const withGridDetail = gridDetail && withGrid;
  const profileSelection = withGrid && withShape
    ? 'return localVolumeGrid[index].x > 0.5 ? localVolumeGridProfile(index, position) : localVolumeShapeProfile(index, position, withNoise);'
    : (withGrid ? 'return localVolumeGridProfile(index, position);' : 'return localVolumeShapeProfile(index, position, withNoise);');
  return `
// Interleaved gradient noise (Jimenez 2014): the start offsets of neighbouring pixels stay far apart, so the march error is a fine, even dither
// and not the clumps a white-noise hash leaves, which read as grain at 8 to 16 steps.
float localVolumeJitter() {
  return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
}
${withShape || withGridDetail ? `// Value noise on a hash of plain multiplies, adds and fract, which rounds the same way on SwiftShader, where it was measured, and is unchecked on hardware GPUs (a sine hash does not: its error
// grows with the argument). local-volume-noise.js repeats it for the CPU path tracer, so keep the two in step.
float localVolumeCellHash(vec3 cell) {
  vec3 scrambled = fract(cell * 0.1031);
  scrambled += dot(scrambled, scrambled.zyx + 31.32);
  return fract((scrambled.x + scrambled.y) * scrambled.z);
}
float localVolumeNoise(vec3 position) {
  vec3 cell = floor(position);
  vec3 fraction = fract(position);
  fraction = fraction * fraction * (3.0 - 2.0 * fraction);
  float lower = mix(mix(localVolumeCellHash(cell), localVolumeCellHash(cell + vec3(1,0,0)), fraction.x), mix(localVolumeCellHash(cell + vec3(0,1,0)), localVolumeCellHash(cell + vec3(1,1,0)), fraction.x), fraction.y);
  float upper = mix(mix(localVolumeCellHash(cell + vec3(0,0,1)), localVolumeCellHash(cell + vec3(1,0,1)), fraction.x), mix(localVolumeCellHash(cell + vec3(0,1,1)), localVolumeCellHash(cell + vec3(1,1,1)), fraction.x), fraction.y);
  return mix(lower, upper, fraction.z);
}
${noiseOctaves ? `// Fractal value noise for a volume with noiseOctaves above 1 (local-volume-noise.js localVolumeFractalNoise repeats it): lacunarity 2, gain 0.5, divided by the weights.
float localVolumeFractalNoise(vec3 position, int octaves) {
  float sum = 0.0;
  float weight = 1.0;
  float weightSum = 0.0;
  float frequency = 1.0;
  for (int octave = 0; octave < ${LOCAL_VOLUME_MAXIMUM_NOISE_OCTAVES}; octave++) {
    if (octave >= octaves) break;
    sum += weight * localVolumeNoise(position * frequency);
    weightSum += weight;
    weight *= 0.5;
    frequency *= 2.0;
  }
  return sum / weightSum;
}
` : ''}` : ''}vec3 localVolumeLocal(int index, vec3 vector) {
  return vec3(dot(localVolumeAxes[index * 3].xyz, vector), dot(localVolumeAxes[index * 3 + 1].xyz, vector), dot(localVolumeAxes[index * 3 + 2].xyz, vector));
}
vec2 localVolumeInterval(int index, vec3 origin, vec3 direction) {
  vec3 center = localVolumeCenters[index].xyz;
  vec3 halfSize = localVolumeExtents[index].xyz;
  if (localVolumeCenters[index].w > 0.5) {
    vec3 offset = origin - center;
    float along = dot(offset, direction);
    float discriminant = along * along - (dot(offset, offset) - halfSize.x * halfSize.x);
    if (discriminant <= 0.0) return vec2(0.0);
    float root = sqrt(discriminant);
    return vec2(-along - root, -along + root);
  }
  vec3 localOrigin = localVolumeLocal(index, origin - center);
  vec3 localDirection = localVolumeLocal(index, direction);
  float entry = -1e30;
  float exitDistance = 1e30;
  for (int axis = 0; axis < 3; axis++) {
    float relative = -localOrigin[axis];
    if (localDirection[axis] == 0.0) {
      if (abs(relative) > halfSize[axis]) return vec2(0.0);
    } else {
      float first = (relative - halfSize[axis]) / localDirection[axis];
      float second = (relative + halfSize[axis]) / localDirection[axis];
      entry = max(entry, min(first, second));
      exitDistance = min(exitDistance, max(first, second));
    }
  }
  return vec2(entry, exitDistance);
}
${withShape ? `// Where a fade position (0 at the core, 1 at the outer face) lands once the noise has pushed the edge in and out, most at the middle of the fade (local-volumes.js repeats it).
float localVolumeWarpedFade(float position, float noiseAmount, float noise) {
  float clamped = clamp(position, 0.0, 1.0);
  return clamped + (0.5 - noise) * noiseAmount * ${LOCAL_VOLUME_EDGE_WARP.toFixed(3)} * 4.0 * clamped * (1.0 - clamped);
}
` : ''}${withGrid ? `// A grid volume (#1045) reads its box as a 3D texture: x density, y temperature, z flame. localVolumeGrid holds, per volume, x 1 for a grid, y the temperature
// scale, z the blackbody intensity times the emission strength and w the anisotropy. volume-grid.js (blackbodyRadiance) repeats the blackbody.
${withGridDetail ? `// The fine detail a grid volume with noiseAmount adds to its density and flame (#2289): the grid's cells are the coarsest structure of the smoke, and the noise (the
// one of the box and sphere volumes, in world metres) breaks them into the small clumps a close camera expects. It averages 1, so the far look keeps its optical depth.
// A march step reads the density and the blackbody at one point, so the second read takes the detail the first one computed (#2301: the
// fractal noise ran twice per step and doubled the CPU preview look). The result is the same number either way.
vec3 localGridDetailPosition = vec3(1e30);
int localGridDetailIndex = -1;
float localGridDetailValue = 1.0;
float localGridDetail(int index, vec3 position) {
  float noiseAmount = localVolumeAbsorption[index].w;
  if (noiseAmount <= 0.0) return 1.0;
  if (index == localGridDetailIndex && position == localGridDetailPosition) return localGridDetailValue;
  float noise = ${noiseOctaves ? 'localVolumeFractalNoise(position * localVolumeEmission[index].w, 1 + int(localVolumeAxes[index * 3 + 1].w + 0.5))' : 'localVolumeNoise(position * localVolumeEmission[index].w)'};
  float stretched = clamp((noise - 0.5) * ${GRID_DETAIL_CONTRAST.toFixed(1)} + 0.5, 0.0, 1.0);
  localGridDetailIndex = index;
  localGridDetailPosition = position;
  localGridDetailValue = 1.0 + (2.0 * (stretched * stretched * (3.0 - 2.0 * stretched)) - 1.0) * noiseAmount;
  return localGridDetailValue;
}
` : ''}// A grid cell at a world point: x density, y temperature, z flame, all linear taps of the padded texture (a texel centre is at i + 0.5).
vec3 localGridSample(int index, vec3 position) {
  vec3 unit = (position - localVolumeCenters[index].xyz) / (localVolumeExtents[index].xyz * 2.0) + 0.5;
  vec3 paddedSize = vec3(textureSize(localGridTexture, 0));
  ${withGridDetail ? `vec3 cell = textureLod(localGridTexture, (unit * (paddedSize - ${2 * GRID_BORDER_VOXELS}.0) + ${GRID_BORDER_VOXELS}.0) / paddedSize, 0.0).rgb;
  if (cell.x == 0.0 && cell.z == 0.0) return cell;
  float detail = localGridDetail(index, position);
  return vec3(cell.x * detail, cell.y, cell.z * detail);` : `return textureLod(localGridTexture, (unit * (paddedSize - ${2 * GRID_BORDER_VOXELS}.0) + ${GRID_BORDER_VOXELS}.0) / paddedSize, 0.0).rgb;`}
}
` : ''}${withGrid ? `// The baked blackbody radiance at a world point (volume-grid.js bakedGridEmission), before the blackbody intensity and the emission strength.
vec3 localGridBlackbody(int index, vec3 position) {
  vec3 unit = (position - localVolumeCenters[index].xyz) / (localVolumeExtents[index].xyz * 2.0) + 0.5;
  vec3 paddedSize = vec3(textureSize(localGridEmissionTexture, 0));
  ${withGridDetail ? `vec3 radiance = textureLod(localGridEmissionTexture, (unit * (paddedSize - ${2 * GRID_BORDER_VOXELS}.0) + ${GRID_BORDER_VOXELS}.0) / paddedSize, 0.0).rgb;
  return radiance == vec3(0.0) ? radiance : radiance * localGridDetail(index, position);` : `return textureLod(localGridEmissionTexture, (unit * (paddedSize - ${2 * GRID_BORDER_VOXELS}.0) + ${GRID_BORDER_VOXELS}.0) / paddedSize, 0.0).rgb;`}
}
` : ''}${motion ? LOCAL_MOTION_POSITION_FUNCTION : ''}${STEP_INTEGRAL_GLSL}// The emission ramp of a volume (#1046): the light per unit length at a source value, 0 where the volume has no ramp. localVolumeRampSetup holds x the source
// code (0 none, 1 density, 2 temperature, 3 flame), y the stop count and z, w the source range; the stops are baked in local-volume-ramp.js with the exposure and
// the emission strength applied. The light fades to nothing with the source, so a cold cell gives none.
vec3 localVolumeRampLight(int index, float value) {
  vec4 setup = localVolumeRampSetup[index];
  if (setup.y < 0.5) return vec3(0.0);
  float position = clamp((value - setup.z) / (setup.w - setup.z), 0.0, 1.0);
  float scaled = position * (setup.y - 1.0);
  int lower = int(floor(scaled));
  int upper = min(lower + 1, int(setup.y) - 1);
  return mix(localVolumeRamp[index * ${LOCAL_VOLUME_RAMP_STOPS} + lower].rgb, localVolumeRamp[index * ${LOCAL_VOLUME_RAMP_STOPS} + upper].rgb, scaled - float(lower)) * position;
}
${withGrid ? `float localVolumeGridProfile(int index, vec3 position) {
  vec3 gridOffset = abs(position - localVolumeCenters[index].xyz);
  vec3 gridHalf = localVolumeExtents[index].xyz;
  return (gridOffset.x > gridHalf.x || gridOffset.y > gridHalf.y || gridOffset.z > gridHalf.z) ? 0.0 : localGridSample(index, position).x;
}
` : ''}${withShape ? `float localVolumeShapeProfile(int index, vec3 position, bool withNoise) {
  vec3 offset = position - localVolumeCenters[index].xyz;
  if (localVolumeCenters[index].w < 0.5) offset = localVolumeLocal(index, offset);
  vec3 halfSize = localVolumeExtents[index].xyz;
  float falloff = localVolumeExtents[index].w;
  float noiseAmount = withNoise ? localVolumeAbsorption[index].w : 0.0;
  float noise = noiseAmount > 0.0 ? ${noiseOctaves ? 'localVolumeFractalNoise(position * localVolumeEmission[index].w, 1 + int(localVolumeAxes[index * 3 + 1].w + 0.5))' : 'localVolumeNoise(position * localVolumeEmission[index].w)'} : 0.5;
  float profile;
  if (localVolumeCenters[index].w > 0.5) {
    float distanceRatio = length(offset) / halfSize.x;
    float fade = localVolumeWarpedFade((distanceRatio - (1.0 - falloff)) / max(falloff, 1e-6), noiseAmount, noise);
    profile = falloff > 0.0 ? 1.0 - smoothstep(0.0, 1.0, fade) : 1.0 - step(1.0, distanceRatio);
    if (distanceRatio >= 1.0) profile = 0.0;
  } else {
    vec3 ratios = abs(offset) / halfSize;
    // The distance past the core box is round at the corners; the plain largest ratio fades along boxes with mitred creases (local-volumes.js repeats it).
    float fadeDistance = length(max(ratios - (1.0 - falloff), 0.0));
    float fade = localVolumeWarpedFade(fadeDistance / max(falloff, 1e-6), noiseAmount, noise);
    profile = falloff > 0.0 ? 1.0 - smoothstep(0.0, 1.0, fade) : 1.0 - step(1.0, max(max(ratios.x, ratios.y), ratios.z));
    if (max(max(ratios.x, ratios.y), ratios.z) >= 1.0) profile = 0.0;
  }
  if (noiseAmount > 0.0) profile *= mix(1.0, noise * 2.0, noiseAmount);
  return profile;
}
` : ''}float localVolumeProfile(int index, vec3 position, bool withNoise) {
  ${profileSelection}
}
${withGrid ? scatterFunctions('Grid') : ''}${withShape ? scatterFunctions('Shape') : ''}
// The share of the key light a surface keeps under the volumes that cast shadows (#1047): exp of the optical depth the volumes put between it and the sun.
vec3 localVolumeSurfaceShadow(vec3 position, vec3 towardSun) {
  vec3 depthSum = vec3(0.0);
  vec3 gridDepth = vec3(0.0);
  for (int index = 0; index < 8; index++) {
    if (index >= localVolumeCount) break;
    // A grid volume that casts packs 2 in the first component (a plain grid packs 1); the other shapes pack the flag in the third.
    bool isGrid = localVolumeGrid[index].x > 0.5;
    bool casts = isGrid ? localVolumeGrid[index].x > 1.5 : localVolumeGrid[index].z > 0.5;
    if (!casts || localVolumeCenters[index].w > 1.5) continue;
    vec2 span = localVolumeInterval(index, position, towardSun);
    float entry = max(span.x, 0.0);
    if (span.y <= entry) continue;
    float profileSum = 0.0;
    for (int tap = 0; tap < ${LOCAL_VOLUME_GRID_SHADOW_TAPS}; tap++) {
      // A grid reads its simulated density as it is: the saturation and strength below tune the faded skin of a box or sphere, not a measured density.
      if (!isGrid && tap >= ${LOCAL_VOLUME_SURFACE_SHADOW_TAPS}) break;
      float taps = isGrid ? ${LOCAL_VOLUME_GRID_SHADOW_TAPS}.0 : ${LOCAL_VOLUME_SURFACE_SHADOW_TAPS}.0;
      ${motion ? LOCAL_MOTION_SHADOW_PROFILE : 'float profile = localVolumeProfile(index, position + towardSun * (entry + (span.y - entry) * (float(tap) + 0.5) / taps), true);'}
      profileSum += isGrid ? profile : min(profile * ${LOCAL_VOLUME_LIGHT_DEPTH_SATURATION.toFixed(3)}, 1.0);
    }
    vec3 depth = localVolumeAbsorption[index].rgb * (profileSum * (span.y - entry) / (isGrid ? ${LOCAL_VOLUME_GRID_SHADOW_TAPS}.0 : ${LOCAL_VOLUME_SURFACE_SHADOW_TAPS}.0));
    if (isGrid) gridDepth += depth; else depthSum += depth;
  }
  return exp(-(depthSum * ${LOCAL_VOLUME_SHADOW_STRENGTH.toFixed(3)} + gridDepth));
}
// The light behind a volume, blurred by the optical depth in front of it: taps of the frame spread over a disc whose radius grows with the depth,
// each counted only where its surface lies at or past the ray's first volume entry, so an object in front of the volume is never smeared into it.
vec3 localVolumeBlurred(vec3 background, float opticalDepth, float firstEntry, vec3 origin, vec3 direction) {
  float radiusPixels = ${LOCAL_VOLUME_BLUR_PIXELS.toFixed(1)} * (resolution.y / 540.0) * (1.0 - exp(-${LOCAL_VOLUME_BLUR_RATE.toFixed(2)} * opticalDepth));
  if (radiusPixels < 0.05) return background;
  float lod = max(0.0, log2(radiusPixels * 0.5) - 1.0);
  float footprint = exp2(lod) + 1.0;
  vec3 sum = background;
  float weight = 1.0;
  for (int tap = 0; tap < 12; tap++) {
    float index = float(tap) + 0.5;
    vec2 offsetPixels = vec2(cos(index * 2.4), sin(index * 2.4)) * (radiusPixels * sqrt(index / 12.0));
    vec2 coordinate = textureCoordinate + offsetPixels / resolution;
    // The surface at the tap and one filter footprint to each side of it: the filter blends the colour of an object in front of the volume into a tap whose own depth is still the far one.
    float nearestTap = 1e30;
    for (int side = 0; side < 5; side++) {
      vec2 shift = side == 0 ? vec2(0.0) : (side == 1 ? vec2(footprint, 0.0) : (side == 2 ? vec2(-footprint, 0.0) : (side == 3 ? vec2(0.0, footprint) : vec2(0.0, -footprint))));
      vec2 sideCoordinate = coordinate + shift / resolution;
      vec4 sidePoint = inverseViewProjection * vec4(sideCoordinate * 2.0 - 1.0, texture(sceneDepth, sideCoordinate).r * 2.0 - 1.0, 1.0);
      nearestTap = min(nearestTap, sidePoint.w > 0.0 ? dot(sidePoint.xyz - origin * sidePoint.w, direction) / sidePoint.w : 1e30);
    }
    if (nearestTap < firstEntry) continue;
    sum += textureLod(frameTexture, coordinate, lod).rgb;
    weight += 1.0;
  }
  return mix(background, sum / weight, min(radiusPixels, 1.0));
}
int localVolumeShapeSteps(int index, float length) {
  int steps = int(localVolumeSteps[index].x);
${noiseOctaves ? `  int octaves = 1 + int(localVolumeAxes[index * 3 + 1].w + 0.5);
  if (localVolumeAbsorption[index].w > 0.0 && octaves > 1) return max(steps, min(${LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS}, int(ceil(length * localVolumeEmission[index].w * exp2(float(octaves - 1)) * ${LOCAL_VOLUME_STEPS_PER_NOISE_CELL.toFixed(1)}))));
` : ''}  if (localVolumeAbsorption[index].w > 0.0) steps = min(${LOCAL_VOLUME_MAXIMUM_STEPS}, max(steps, int(ceil(length * localVolumeEmission[index].w * ${LOCAL_VOLUME_STEPS_PER_NOISE_CELL.toFixed(1)}))));
  return steps;
}
vec3 localVolumes(vec3 background) {
  vec2 clipXY = textureCoordinate * 2.0 - 1.0;
  vec4 farPoint = inverseViewProjection * vec4(clipXY, 1.0, 1.0);
  vec4 nearPoint = inverseViewProjection * vec4(clipXY, -1.0, 1.0);
  vec3 origin = localOrthographic > 0.5 ? nearPoint.xyz / nearPoint.w : eye;
  vec3 direction = normalize(farPoint.xyz - origin * farPoint.w);
  float depth = texture(sceneDepth, textureCoordinate).r;
  vec4 surfacePoint = inverseViewProjection * vec4(clipXY, depth * 2.0 - 1.0, 1.0);
  float surfaceDistance = 1e30;
  if (surfacePoint.w > 0.0) surfaceDistance = max(0.0, dot(surfacePoint.xyz - origin * surfacePoint.w, direction) / surfacePoint.w);
  float entries[8];
  float exits[8];
  for (int index = 0; index < 8; index++) {
    entries[index] = 1e30;
    exits[index] = 0.0;
    if (index >= localVolumeCount) continue;
    if (localVolumeCenters[index].w > 1.5) {
      // A closed mesh: the mesh pass stored the length inside this pixel's ray and the nearest entry (see mesh-volume-pass.js).
      vec2 inside = texelFetch(localMeshVolumes, ivec2(gl_FragCoord.xy) + ivec2(0, int(localVolumeSteps[index].y) * int(resolution.y)), 0).rg;
      // A back face past the far plane is clipped and leaves only its front face, a negative sum; that ray ends at the surface.
      float insideLength = inside.x < -1e-5 * surfaceDistance ? inside.x + surfaceDistance : inside.x;
      if (insideLength > 0.0) {
        entries[index] = inside.y < 1e29 ? inside.y : 0.0;
        exits[index] = entries[index] + insideLength;
      }
      continue;
    }
    vec2 span = localVolumeInterval(index, origin, direction);
    float entry = max(span.x, 0.0);
    float exitDistance = min(span.y, surfaceDistance);
    if (exitDistance > entry) {
      entries[index] = entry;
      exits[index] = exitDistance;
    }
  }
  // The bloom was added to the frame before this step. It is the light of a glowing part spreading over its neighbours, so the volume's blur and the surface shadow leave it alone and only the volume's transmittance dims it (#1360).
  vec3 bloomLight = POST_BLOOM ? texture(bloomTexture, textureCoordinate).rgb * bloomStrength : vec3(0.0);
  vec3 transmittance = vec3(1.0);
  vec3 radiance = vec3(0.0);
  float blurDepth = 0.0;
  float blurEntry = 1e30;
  for (int pass = 0; pass < 16; pass++) {
    int nearest = -1;
    float nearestEntry = 1e29;
    for (int index = 0; index < 8; index++) {
      if (entries[index] < nearestEntry) {
        nearestEntry = entries[index];
        nearest = index;
      }
    }
    if (nearest < 0) break;
    float entry = entries[nearest];
    float exitDistance = exits[nearest];
    entries[nearest] = 1e30;
    if (localVolumeCenters[nearest].w > 1.5) {
      // Uniform density, so the march has a closed form: the light behind is dimmed by exp(-k L) and the emission adds
      // (1 - exp(-k L)) / k, or L where k is 0, wherever the stretches inside lie along the ray.
      float insideLength = exitDistance - entry;
      vec3 absorption = localVolumeAbsorption[nearest].rgb;
      vec3 factor = exp(-absorption * insideLength);
      vec3 gain = mix(vec3(insideLength), (1.0 - factor) / max(absorption, vec3(1e-6)), step(vec3(1e-6), absorption));
      radiance += transmittance * localVolumeEmission[nearest].rgb * gain;
      transmittance *= factor;
      blurDepth += localVolumeSteps[nearest].w * dot(absorption, vec3(0.3333)) * insideLength;
      blurEntry = min(blurEntry, entry);
      continue;
    }
${withGrid ? `    if (localVolumeGrid[nearest].x > 0.5) {
      int gridSteps = int(localVolumeSteps[nearest].x);
      float gridStepSize = (exitDistance - entry) / float(gridSteps);
      float gridJitter = fract(localVolumeJitter() + float(nearest) * 0.618034);
      float gridScatter = localVolumeSteps[nearest].z;
      for (int step = 0; step < ${LOCAL_VOLUME_GRID_MAXIMUM_STEPS}; step++) {
        if (step >= gridSteps) break;
        vec3 position = origin + direction * (entry + (float(step) + gridJitter) * gridStepSize);
        ${motion ? LOCAL_MOTION_SAMPLE_POSITION : 'vec3 cell = localGridSample(nearest, position);'}
        vec3 extinction = localVolumeAbsorption[nearest].rgb * (cell.x * gridStepSize);
        vec3 gridStepLight = (localVolumeEmission[nearest].rgb * cell.z + localGridBlackbody(nearest, ${motion ? 'samplePosition' : 'position'}) * localVolumeGrid[nearest].z) * gridStepSize;
        if (localVolumeRampSetup[nearest].y > 0.5) gridStepLight += localVolumeRampLight(nearest, localVolumeRampSetup[nearest].x < 1.5 ? cell.x : (localVolumeRampSetup[nearest].x < 2.5 ? cell.y : cell.z)) * gridStepSize;
        radiance += transmittance * gridStepLight * volumeStepIntegral(extinction);
        if (gridScatter > 0.0 && cell.x > 0.0) radiance += transmittance * (gridScatter * (1.0 - exp(-extinction))) * localVolumeInScatterGrid(nearest, position, direction);
        transmittance *= exp(-extinction);
        blurDepth += localVolumeSteps[nearest].w * dot(extinction, vec3(0.3333));
      }
      blurEntry = min(blurEntry, entry);
      continue;
    }
` : ''}${withShape ? `    // Overlapping box and sphere volumes march together (#1722): the volume starting here joins in, density and emission add per step.
    int partner = -1;
    float segmentEnd = exitDistance;
    for (int other = 0; other < 8; other++) {
      if (other >= localVolumeCount || entries[other] > 1e29 || localVolumeCenters[other].w > 1.5 || localVolumeGrid[other].x > 0.5) continue;
      if (entries[other] <= entry) {
        if (partner < 0) partner = other;
      } else {
        segmentEnd = min(segmentEnd, entries[other]);
      }
    }
    if (partner >= 0) segmentEnd = min(segmentEnd, exits[partner]);
    int steps = localVolumeShapeSteps(nearest, segmentEnd - entry);
    if (partner >= 0) steps = max(steps, localVolumeShapeSteps(partner, segmentEnd - entry));
    float stepSize = (segmentEnd - entry) / float(steps);
    float jitter = fract(localVolumeJitter() + float(nearest) * 0.618034);
    float jitterSecond = fract(localVolumeJitter() + float(partner) * 0.618034);
    for (int step = 0; step < ${noiseOctaves ? LOCAL_VOLUME_MAXIMUM_OCTAVE_STEPS : 32}; step++) {
      if (step >= steps) break;
      vec3 stepExtinction = vec3(0.0);
      vec3 stepLight = vec3(0.0);
      for (int lane = 0; lane < 2; lane++) {
        int member = lane == 0 ? nearest : partner;
        if (member < 0) break;
        vec3 position = origin + direction * (entry + (float(step) + (lane == 0 ? jitter : jitterSecond)) * stepSize);
        float profile = localVolumeProfile(member, position, true);
        stepLight += localVolumeEmission[member].rgb * (profile * stepSize);
        if (localVolumeRampSetup[member].y > 0.5) stepLight += localVolumeRampLight(member, profile) * stepSize;
        vec3 extinction = localVolumeAbsorption[member].rgb * (profile * stepSize);
        if (localVolumeSteps[member].z > 0.0 && profile > 0.0) radiance += transmittance * (localVolumeSteps[member].z * (1.0 - exp(-extinction))) * localVolumeInScatterShape(member, position, direction);
        stepExtinction += extinction;
        blurDepth += localVolumeSteps[member].w * dot(extinction, vec3(0.3333));
      }
      radiance += transmittance * stepLight * volumeStepIntegral(stepExtinction);
      transmittance *= exp(-stepExtinction);
    }
    blurEntry = min(blurEntry, entry);
    if (segmentEnd < exitDistance) entries[nearest] = segmentEnd;
    if (partner >= 0) entries[partner] = segmentEnd < exits[partner] ? segmentEnd : 1e30;
` : ''}  }
  if (blurDepth > 0.0) background = localVolumeBlurred(background - bloomLight, blurDepth, blurEntry, origin, direction) + bloomLight;
  if (depth < 1.0 && surfacePoint.w > 0.0 && max(volumeLightColor.r, max(volumeLightColor.g, volumeLightColor.b)) > 0.0) {
    vec3 surfaceWorld = surfacePoint.xyz / surfacePoint.w;
    vec3 shade = mix(vec3(1.0), localVolumeSurfaceShadow(surfaceWorld, normalize(volumeLightDirection)), keyVisibility(surfaceWorld));
    vec3 glow = bloomLight + (localEmissionMaskReady > 0.5 ? texelFetch(localEmissionMask, ivec2(gl_FragCoord.xy), 0).rgb : vec3(0.0));
    background = glow + max(background - glow, vec3(0.0)) * shade;
  }
  return background * transmittance + radiance;
}
`;
};

// The key light's side of the fog and of a scattering local volume: the shadow map, the light and the phase function. Both steps read these,
// so post.js compiles this block in whenever either is on.
const KEY_LIGHT_DECLARATIONS = `
uniform highp sampler2DShadow volumeShadowMap;
uniform mat4 volumeLightProjection;
uniform vec3 volumeLightDirection;
uniform vec3 volumeLightColor;
`;

const KEY_LIGHT_FUNCTIONS = `
float henyeyGreenstein(float cosine, float anisotropy) {
  return (1.0 - anisotropy * anisotropy) / (12.5663706 * pow(1.0 + anisotropy * anisotropy - 2.0 * anisotropy * cosine, 1.5));
}
// The share of the key light that reaches a point: the shadow map.
float keyVisibility(vec3 position) {
  vec4 lightPosition = volumeLightProjection * vec4(position, 1);
  vec3 shadow = lightPosition.xyz / lightPosition.w * 0.5 + 0.5;
  if (all(greaterThanEqual(shadow, vec3(0))) && all(lessThanEqual(shadow, vec3(1)))) {
    return texture(volumeShadowMap, vec3(shadow.xy, shadow.z - 0.0008));
  }
  return 1.0;
}
`;

function packLights(renderer) {
  renderer.fogLightBuffers ??= createFogLightBuffers();
  packFogLights(renderer.lighting, renderer.fogLightBuffers);
}

registerShaderFeatureCode('volumeFog', {
  // The JavaScript half, which the renderer calls for a frame that draws a volume fog.
  support: { packLights, localGridTexture, bindUniforms, usesDetail: fogUsesDetail, prepareLocalVolumes, bindLocalVolumes, withVolumeFireLights, drawEmissionMask, compositeLocalVolumes, releaseLocalVolumeComposite },
  keyDeclarations: KEY_LIGHT_DECLARATIONS,
  keyFunctions: KEY_LIGHT_FUNCTIONS,
  localDeclarations: LOCAL_VOLUME_DECLARATIONS,
  localMotionDeclarations: LOCAL_MOTION_DECLARATIONS,
  localFunctions: localVolumeFunctions,
  postDeclarations: `
uniform float volumeDensity;
uniform vec3 volumeMinimum;
uniform vec3 volumeMaximum;
uniform vec3 volumeColor;
uniform vec3 volumeAmbient;
uniform vec3 volumeDrift;
uniform int volumeSteps;
uniform float volumeAnisotropy;
uniform float volumeShadowAmbient;
uniform float volumeGridFog; // 1 when an irradiance grid lights the fog: the ambient then stands for the sky only
uniform float volumeNoiseAmount;
uniform float volumeNoiseScale;
uniform float volumeMaxDistance;
uniform float volumeHeightFalloff;
uniform sampler2D volumeField;
uniform float volumeProfile;
uniform float volumeFlowStrength;
uniform float volumeFlowPeriod;
uniform int volumeDetailOctaves;
uniform float volumeDetailAmount;
uniform float volumeWarp;
uniform float volumeContrast;
uniform float volumeProfileStart;
uniform float volumeKeyScattering;
uniform int volumeScatterOctaves;
uniform float volumeMultiScatter;
uniform float volumeMultiExtinction;
uniform float volumeMultiAnisotropy;
uniform float volumeKeyTransmittance;
uniform float volumeSurfaceTransmittance;
uniform float volumeBeamRadius;
uniform int volumeLightCount;
uniform vec4 volumeLightPositions[8];
uniform vec4 volumeLightColors[8];
uniform vec4 volumeLightDirections[8];
uniform vec4 volumeLightCones[8];
uniform float orthographic;
uniform highp sampler3D fogSkyVisibility;
`,
  postFunctions: `
float fogLightAttenuation(float distanceSquared, float range, float radius) {
  float cutoff = 1.0;
  if (range > 0.0) {
    float squaredRatio = distanceSquared / (range * range);
    float fade = max(1.0 - squaredRatio * squaredRatio, 0.0);
    cutoff = fade * fade;
  }
  return cutoff / max(distanceSquared, radius * radius);
}
vec3 fogLightScattering(vec3 position, vec3 direction) {
  vec3 total = vec3(0);
  for (int index = 0; index < 8; index++) {
    if (index >= volumeLightCount) break;
    vec3 offset = volumeLightPositions[index].xyz - position;
    float distanceSquared = dot(offset, offset);
    if (distanceSquared < 1e-12) continue;
    vec3 toLight = offset * inversesqrt(distanceSquared);
    float attenuation = fogLightAttenuation(distanceSquared, volumeLightPositions[index].w, volumeLightColors[index].w);
    if (volumeLightCones[index].y > 0.5) attenuation *= smoothstep(volumeLightDirections[index].w, volumeLightCones[index].x, dot(-toLight, volumeLightDirections[index].xyz));
    if (attenuation <= 0.0) continue;
    float denominator = 1.0 + volumeAnisotropy * volumeAnisotropy - 2.0 * volumeAnisotropy * dot(direction, toLight);
    total += volumeLightColors[index].rgb * (attenuation * (1.0 - volumeAnisotropy * volumeAnisotropy) / (12.5663706 * denominator * sqrt(denominator)));
  }
  return total;
}
float flowedNoise(vec3 samplePosition, vec2 velocity, float noiseScale) {
  float firstPhase = fract(time / volumeFlowPeriod);
  float secondPhase = fract(time / volumeFlowPeriod + 0.5);
  vec3 travel = vec3(velocity.x, 0.0, velocity.y) * volumeFlowStrength * volumeFlowPeriod;
  float first = cloudNoise((samplePosition - travel * firstPhase) * noiseScale);
  float second = cloudNoise((samplePosition - travel * secondPhase) * noiseScale);
  return mix(first, second, abs(2.0 * firstPhase - 1.0));
}
float noiseAt(vec3 samplePosition, vec2 velocity, float noiseScale) {
  return POST_FIELD ? flowedNoise(samplePosition, velocity, noiseScale) : cloudNoise(samplePosition * noiseScale);
}
// The density noise in 0..1. With the detail step compiled out this is the single lookup. With it, the position is warped by
// three low-frequency lookups (warp counts noise cells), up to two octaves at 2x and 4x frequency join in (weights 0.5 and 0.25
// times detailAmount, renormalised so the mean stays), and contrast stretches the result around its middle.
float densityNoise(vec3 samplePosition, vec2 velocity) {
  vec3 warped = samplePosition;
  if (POST_DETAIL && volumeWarp > 0.0) {
    vec3 seed = samplePosition * volumeNoiseScale * 0.5;
    vec3 offset = vec3(cloudNoise(seed + 17.0), cloudNoise(seed + 43.0), cloudNoise(seed + 71.0)) - 0.5;
    warped += offset * (2.0 * volumeWarp / volumeNoiseScale);
  }
  float lookup = noiseAt(warped, velocity, volumeNoiseScale);
  if (POST_DETAIL) {
    float total = 1.0;
    float sum = lookup;
    if (volumeDetailOctaves > 1) {
      float weight = 0.5 * volumeDetailAmount;
      sum += weight * noiseAt(warped, velocity, volumeNoiseScale * 2.0);
      total += weight;
    }
    if (volumeDetailOctaves > 2) {
      float weight = 0.25 * volumeDetailAmount;
      sum += weight * noiseAt(warped, velocity, volumeNoiseScale * 4.0);
      total += weight;
    }
    lookup = clamp(0.5 + (sum / total - 0.5) * volumeContrast, 0.0, 1.0);
  }
  return lookup;
}
float layerProfile(float relativeHeight) {
  return volumeProfile > 0.5 ? 1.0 - smoothstep(volumeProfileStart, 1.0, relativeHeight) : exp(-relativeHeight);
}
// The density factor at one point: the noise, times the field's layer profile or the height falloff. Zero where the fog is absent.
float fogDensityFactor(vec3 position) {
  float noise = 1.0;
  vec4 field = POST_FIELD ? texture(volumeField, (position.xz - volumeMinimum.xz) / (volumeMaximum.xz - volumeMinimum.xz)) : vec4(1);
  if (volumeNoiseAmount > 0.0) {
    float lookup = densityNoise(position - volumeDrift * time, field.zw);
    noise = mix(1.0, lookup * 2.0, volumeNoiseAmount);
  }
  if (POST_FIELD) noise *= field.r * layerProfile((position.y - volumeMinimum.y) / max(field.g, 0.0001));
  else if (volumeHeightFalloff > 0.0) noise *= exp((volumeMinimum.y - position.y) / volumeHeightFalloff);
  return noise;
}
// The optical depth of the fog between a point and the sun, from three taps along the light direction up to the box exit.
float sunOpticalDepth(vec3 position, vec3 towardSun) {
  float exitDistance = volumeMaxDistance;
  for (int axis = 0; axis < 3; axis++) {
    if (towardSun[axis] == 0.0) continue;
    float first = (volumeMinimum[axis] - position[axis]) / towardSun[axis];
    float second = (volumeMaximum[axis] - position[axis]) / towardSun[axis];
    exitDistance = min(exitDistance, max(first, second));
  }
  exitDistance = max(exitDistance, 0.0);
  float sum = 0.0;
  for (int tap = 0; tap < 3; tap++) sum += fogDensityFactor(position + towardSun * (exitDistance * (float(tap) + 0.5) / 3.0));
  return volumeDensity * sum * exitDistance / 3.0;
}
// The sun's in-scatter at a point. The octave sum approximates multiple scattering (Wrenninge et al. 2015, "Oz: the great and
// volumetric"): octave n scatters multiScatter^n as much, sees half^n of the extinction and has half^n of the anisotropy.
// With beamRadius above 0 the octaves beyond the first count only as far as the sun reaches around the point: multiple scattering
// of a narrow shaft leaves it sideways, so its glow stays narrow, and a wide beam keeps all of it. beamShare is the lit share of four taps that far
// off the point across the sun's direction.
float beamShare(vec3 position, vec3 towardSun) {
  vec3 across = normalize(cross(towardSun, abs(towardSun.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
  vec3 upward = cross(towardSun, across);
  return 0.25 * (keyVisibility(position + across * volumeBeamRadius) + keyVisibility(position - across * volumeBeamRadius) + keyVisibility(position + upward * volumeBeamRadius) + keyVisibility(position - upward * volumeBeamRadius));
}
float keyInScatter(float cosine, float opticalDepth, float octaveShare) {
  float total = 0.0;
  float weight = 1.0;
  float extinction = 1.0;
  float anisotropy = volumeAnisotropy;
  for (int octave = 0; octave < 4; octave++) {
    if (octave >= volumeScatterOctaves) break;
    total += weight * henyeyGreenstein(cosine, anisotropy) * exp(-opticalDepth * volumeKeyTransmittance * extinction);
    weight *= volumeMultiScatter * octaveShare;
    extinction *= volumeMultiExtinction;
    anisotropy *= volumeMultiAnisotropy;
  }
  return total;
}
vec3 volumeFog(vec3 background) {
  vec2 clipXY = textureCoordinate * 2.0 - 1.0;
  vec4 farPoint = inverseViewProjection * vec4(clipXY, 1.0, 1.0);
  vec4 nearPoint = inverseViewProjection * vec4(clipXY, -1.0, 1.0);
  vec3 origin = orthographic > 0.5 ? nearPoint.xyz / nearPoint.w : eye;
  vec3 direction = normalize(farPoint.xyz - origin * farPoint.w);
  float depth = texture(sceneDepth, textureCoordinate).r;
  vec4 surfacePoint = inverseViewProjection * vec4(clipXY, depth * 2.0 - 1.0, 1.0);
  float surfaceDistance = volumeMaxDistance;
  if (surfacePoint.w > 0.0) surfaceDistance = max(0.0, dot(surfacePoint.xyz - origin * surfacePoint.w, direction) / surfacePoint.w);
  float exitDistance = min(volumeMaxDistance, surfaceDistance);
  float boxExit = volumeMaxDistance;
  float entry = 0.0;
  for (int axis = 0; axis < 3; axis++) {
    if (direction[axis] == 0.0) {
      if (origin[axis] < volumeMinimum[axis] || origin[axis] > volumeMaximum[axis]) return background;
    } else {
      float first = (volumeMinimum[axis] - origin[axis]) / direction[axis];
      float second = (volumeMaximum[axis] - origin[axis]) / direction[axis];
      entry = max(entry, min(first, second));
      exitDistance = min(exitDistance, max(first, second));
      boxExit = min(boxExit, max(first, second));
    }
  }
  if (entry >= exitDistance) return background;
  float stepSize = (exitDistance - entry) / float(volumeSteps);
  vec3 lightDirection = normalize(volumeLightDirection);
  float cosine = dot(direction, lightDirection);
  float anisotropy = volumeAnisotropy;
  vec3 towardSun = lightDirection;
  bool sunTransmittance = volumeKeyTransmittance > 0.0 || volumeScatterOctaves > 1;
  float jitter = hash(vec3(gl_FragCoord.xy, 0));
  float transmittance = 1.0;
  vec3 accumulated = vec3(0);
  for (int index = 0; index < 48; index++) {
    if (index >= volumeSteps) break;
    vec3 position = origin + direction * (entry + (float(index) + jitter) * stepSize);
    float noise = fogDensityFactor(position);
    float opacity = 1.0 - exp(-volumeDensity * noise * stepSize);
    float visibility = keyVisibility(position);
    vec4 skyCell = POST_SKY ? texture(fogSkyVisibility, (position - volumeMinimum) / (volumeMaximum - volumeMinimum)) : vec4(0);
    float shadowShare = POST_SKY ? 0.1 + 0.9 * min(1.0, 30.0 * skyCell.r) : volumeShadowAmbient;
    float ambientShare = mix(shadowShare, 1.0, visibility);
    if (volumeGridFog > 0.5) ambientShare = min(1.0, 30.0 * skyCell.r);
    float opticalDepth = 0.0;
    if (sunTransmittance && visibility > 0.001) opticalDepth = sunOpticalDepth(position, towardSun);
    float octaveShare = 1.0;
    if (volumeBeamRadius > 0.0 && volumeScatterOctaves > 1 && visibility > 0.001) octaveShare = beamShare(position, towardSun);
    float phase = keyInScatter(cosine, opticalDepth, octaveShare);
    vec3 scattering = volumeColor * (volumeAmbient * ambientShare + 0.6 * skyCell.gba + volumeLightColor * (phase * visibility * volumeKeyScattering));
    if (POST_LIGHTS) scattering += volumeColor * fogLightScattering(position, direction);
    accumulated += transmittance * opacity * scattering;
    transmittance *= 1.0 - opacity;
    if (transmittance < 0.001) break;
  }
  for (int tap = 0; tap < 24; tap++) {
    float index = float(tap) + 0.5;
    float radius = 0.03 + 0.0002 * index * index;
    vec2 offset = vec2(cos(index * 2.4) * resolution.y / resolution.x, sin(index * 2.4)) * radius;
    accumulated += textureLod(frameTexture, textureCoordinate + offset, log2(0.7 * radius * resolution.y)).rgb * volumeColor * (0.009 * (1.0 - transmittance) / (1.0 + 0.04 * index));
  }
  float surfaceSun = 1.0;
  if (volumeSurfaceTransmittance > 0.0 && surfacePoint.w > 0.0 && surfaceDistance <= boxExit) {
    // A surface inside the box: its sun passes through the fog too. A lit surface takes mostly sun, so the whole colour dims by its share.
    vec3 surfacePosition = origin + direction * surfaceDistance + towardSun * 0.05;
    float surfaceVisibility = keyVisibility(surfacePosition);
    if (surfaceVisibility > 0.001) surfaceSun = mix(1.0, exp(-sunOpticalDepth(surfacePosition, towardSun) * volumeSurfaceTransmittance), surfaceVisibility);
  }
  return accumulated + background * transmittance * surfaceSun;
}
`,
});
