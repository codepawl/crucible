import { createEnvironmentMap, createEnvironmentResources } from './environment.js';
import { fullscreenVertex } from './gl-program.js';
import { layerTextureSupport, liquidProbeSupport, registerShaderFeatureCode } from './shader-registry.js';
import { probeEnabledState, probeLookupGlsl, probeUniformsGlsl } from './probe-glsl.js';
import { boundsCentre, traceProbes, worldBounds } from './probe-trace.js';

// Reflection probes: the room around a point, traced once and prefiltered like an environment map, so a glossy part
// reflects the objects around it and not only the sky. This module is optional. A scene without a probe never loads it,
// and the renderer's only link to it is the material field `environmentProbe`, which batches parts by probe.
export { MAXIMUM_PROBES, isReflectivePart, normalizeProbeList, roomCentreProbe, traceObjectProbes, traceProbes } from './probe-trace.js';

// A probe lights the specular term only. Diffuse light stays with the environment and the light bake, which already hold it.

const MAP_STATE_PROBE = 19;

/** The nearest probe whose radius reaches the point, or null; a tie goes to the earlier probe. */
export function selectProbe(probes, point) {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const probe of probes) {
    const distance = Math.hypot(point[0] - probe.position[0], point[1] - probe.position[1], point[2] - probe.position[2]);
    if (distance <= probe.radius && distance < nearestDistance) {
      nearest = probe;
      nearestDistance = distance;
    }
  }
  return nearest;
}

// A part wrapped once per probe keeps reading every other field from the live material, so motion on colour still works.
function probedMaterial(liveMaterial, probeMap, wrappers) {
  const byProbe = wrappers.get(liveMaterial) ?? new Map();
  wrappers.set(liveMaterial, byProbe);
  if (!byProbe.has(probeMap)) {
    const wrapper = {};
    for (const field of Object.keys(liveMaterial)) {
      if (field === 'environmentProbe') {
        continue;
      }
      Object.defineProperty(wrapper, field, { enumerable: true, get: () => liveMaterial[field] });
    }
    Object.defineProperty(wrapper, 'environmentProbe', { enumerable: true, value: probeMap });
    byProbe.set(probeMap, Object.freeze(wrapper));
  }
  return byProbe.get(probeMap);
}

/** Gives each part the nearest probe that reaches it, as a material wrapper that keeps reading the live material. */
export function placeProbes(parts, probeTrace, { rotation = 0, wrappers = new Map() } = {}) {
  const probes = probeTrace.traced.map(({ position, radius, width, height, data, hitFraction, part, floorHeight = null }) => {
    const map = createEnvironmentMap({ width, height, data, intensity: 1, rotation });
    // An object probe knows the floor under it, so the lookup can follow the ray from the shaded point to that floor.
    const parallax = part !== undefined && floorHeight !== null ? [...position, floorHeight] : null;
    return { position, radius, hitFraction, part, map: parallax ? Object.freeze({ ...map, parallax }) : map };
  });
  const probesByPart = new Map(probes.filter(probe => probe.part !== undefined).map(probe => [probe.part, probe]));
  const sharedProbes = probes.filter(probe => probe.part === undefined);
  const probedParts = parts.map((part, index) => {
    const probe = probesByPart.get(index) ?? selectProbe(sharedProbes, boundsCentre(worldBounds(part)));
    return probe ? Object.freeze({ ...part, material: probedMaterial(part.material, probe.map, wrappers) }) : part;
  });
  const report = {
    automatic: probeTrace.automatic,
    requested: probeTrace.requested,
    placed: probes.map(({ position, radius, hitFraction }) => ({ position, radius, hitFraction })),
    skipped: probeTrace.skipped,
    glb: probes.length > 0 ? 'Probes are not written to GLB: glTF has no standard for them.' : null,
    partsWithProbe: probedParts.filter((part, index) => part !== parts[index]).length,
  };
  return { parts: Object.freeze(probedParts), probes, report };
}

/** Traces the probes (see traceProbes) and places them: for code that holds parts and lights and no recipe. */
export function applyReflectionProbes(parts, lighting, specs, options = {}) {
  return placeProbes(parts, traceProbes(parts, lighting, specs, options), options);
}

registerShaderFeatureCode('probe', Object.freeze({
  declarations: probeUniformsGlsl + probeLookupGlsl,
  // Divides out the world-mode weight the surroundings get below, because a probe's radiance is already the real light.
  probeSurroundings: '    if (probeEnabled > 0.5) surroundings = environmentRadiance(reflected, roughness * environmentLevelMax) / max(mix(1.0, 0.5 * daylight, worldMode), 0.05);\n',
  probeReflection: '  reflected = probeSampleDirection(reflected, worldPosition);\n',
}));

const rendererStates = new WeakMap();
const probeResourceCaches = new WeakMap();

/** The prefiltered textures a renderer holds for its probes, by probe data. Exported so a test can stand in for the GPU. */
export function probeResourcesOf(renderer) {
  if (!probeResourceCaches.has(renderer)) probeResourceCaches.set(renderer, new Map());
  return probeResourceCaches.get(renderer);
}

// Adding a feature (a render pass asks for its own) links a new program, whose uniforms sit at new locations and start at their
// defaults, so the locations are looked up again for each program. A location of another program makes the next uniform call fail.
function stateOf(renderer) {
  if (!rendererStates.has(renderer)) {
    rendererStates.set(renderer, { resources: probeResourcesOf(renderer), program: null, enabledLocation: null, floorLocation: null, bound: false });
  }
  const state = rendererStates.get(renderer);
  if (state.program !== renderer.program) {
    state.program = renderer.program;
    state.enabledLocation = renderer.context.getUniformLocation(renderer.program, 'probeEnabled');
    state.floorLocation = renderer.context.getUniformLocation(renderer.program, 'probeFloor');
    // The new program starts with its probe off, and the global environment is what it was given.
    state.bound = false;
  }
  return state;
}

// Prefiltering draws into framebuffers, so the state a draw call depends on is put back after it.
function prefilterProbe(renderer, map) {
  const context = renderer.context;
  const framebuffer = context.getParameter(context.FRAMEBUFFER_BINDING);
  const viewport = context.getParameter(context.VIEWPORT);
  const program = context.getParameter(context.CURRENT_PROGRAM);
  const vertexArray = context.getParameter(context.VERTEX_ARRAY_BINDING);
  const activeUnit = context.getParameter(context.ACTIVE_TEXTURE);
  context.activeTexture(context.TEXTURE0);
  const firstUnitTexture = context.getParameter(context.TEXTURE_BINDING_2D);
  const enabled = [context.DEPTH_TEST, context.CULL_FACE, context.BLEND, context.SCISSOR_TEST].map(capability => [capability, context.isEnabled(capability)]);
  const compileProgram = (gl, vertexSource, fragmentSource) => renderer.compileEnvironmentProgram(gl, vertexSource, fragmentSource);
  const resources = createEnvironmentResources(context, map, { compileProgram, fullscreenVertex });
  context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  context.viewport(...viewport);
  context.useProgram(program);
  context.bindVertexArray(vertexArray);
  context.bindTexture(context.TEXTURE_2D, firstUnitTexture);
  context.activeTexture(activeUnit);
  for (const [capability, wasEnabled] of enabled) {
    if (wasEnabled) {
      context.enable(capability);
    } else {
      context.disable(capability);
    }
  }
  context.deleteTexture(resources.brdfTexture);
  // The renderer deletes everything in its texture table when it is disposed.
  renderer.textures.set(Symbol('reflection-probe'), resources.specularTexture);
  return resources;
}

function bindProbe(renderer, mapState) {
  if (!renderer.shaderFeatures?.has('probe')) {
    return;
  }
  const state = stateOf(renderer);
  const context = renderer.context;
  const probeMap = mapState[MAP_STATE_PROBE];
  const globalMap = renderer.activeMap;
  if (!probeMap) {
    if (!state.bound) {
      return;
    }
    state.bound = false;
    renderer.activateEnvironment(globalMap);
    if (globalMap) {
      renderer.applyEnvironmentUniforms(globalMap);
    }
    context.uniform1f(state.enabledLocation, 0);
    return;
  }
  state.bound = true;
  bindProbeSpecular(renderer, state, probeMap, renderer.uniforms);
  if (globalMap && renderer.environmentResources) {
    // The environment's irradiance still lights the diffuse term, with the global map's own rotation and intensity.
    renderer.applyDiffuseUniforms(globalMap, renderer.uniforms, false);
  }
  if (probeMap.parallax) context.uniform4fv(state.floorLocation, probeMap.parallax);
  context.uniform1f(state.enabledLocation, probeEnabledState(probeMap));
}

// Prefilters the probe once and points the environment sampler and its uniforms at it, in whichever program `uniforms` belongs to.
function bindProbeSpecular(renderer, state, probeMap, uniforms) {
  if (!state.resources.has(probeMap.data)) {
    state.resources.set(probeMap.data, prefilterProbe(renderer, probeMap));
  }
  const resources = state.resources.get(probeMap.data);
  const context = renderer.context;
  renderer.bindEnvironmentTextures(resources.specularTexture, renderer.environmentResources?.brdfTexture ?? renderer.whiteTexture);
  context.uniform1f(uniforms.environmentIntensity, 1);
  context.uniform2f(uniforms.environmentRotation, Math.cos(probeMap.rotation), Math.sin(probeMap.rotation));
  context.uniform1f(uniforms.environmentLevelMax, resources.levelCount - 1);
}

// The liquid pass draws glass and water with its own program: a batch with a probe reflects that room, and the next batch
// (and the lit program after the pass) gets the global environment back.
const renderersWithLiquidProbe = new WeakSet();

function restoreLiquidEnvironment(renderer, uniforms) {
  if (!renderersWithLiquidProbe.delete(renderer)) {
    return;
  }
  const globalMap = renderer.activeMap;
  renderer.activateEnvironment(globalMap);
  renderer.applyEnvironmentUniforms(globalMap, uniforms);
  renderer.context.uniform1f(uniforms.probeEnabled, 0);
}

liquidProbeSupport.bind = (renderer, uniforms, batch) => {
  if (!uniforms.probeEnabled) {
    return;
  }
  const probeMap = batch.mapState?.[MAP_STATE_PROBE];
  if (!probeMap) {
    restoreLiquidEnvironment(renderer, uniforms);
    return;
  }
  const context = renderer.context;
  bindProbeSpecular(renderer, stateOf(renderer), probeMap, uniforms);
  if (probeMap.parallax) context.uniform4fv(uniforms.probeFloor, probeMap.parallax);
  context.uniform1f(uniforms.probeEnabled, probeEnabledState(probeMap));
  renderersWithLiquidProbe.add(renderer);
};

liquidProbeSupport.finish = (renderer, uniforms) => {
  if (uniforms.probeEnabled) {
    restoreLiquidEnvironment(renderer, uniforms);
  }
};

const previousBind = layerTextureSupport.bind;
layerTextureSupport.bind = (renderer, mapState, layerState, batch) => {
  previousBind?.(renderer, mapState, layerState, batch);
  bindProbe(renderer, mapState);
};
