// Runs in the page. Loads one scene file the way src/file-scene.js does, then times each pass of Glaze on the GPU.
import { CrucibleRenderer } from '../../src/renderer.js';
import { createSharedTextures, loadGltf } from '../../src/gltf.js';
import { loadHdri } from '../../src/hdri.js';
import { addLodsToDenseParts, withSceneFileRendererDefaults } from '../../src/dense-lods.js';
import { createCascadedShadows } from '../../src/cascaded-shadows.js';
import { installVariantEmulation } from './variant-programs.js';
import { installColourProgramRecorder, describeColourPrograms } from './program-report.js';
import { measureOverdraw, measureOpaqueOrder } from './opaque-order.js';
import { blockMedians, median, rotatedOrder, summarizeAfterWarmup, summarizeRounds } from './frame-statistics.mjs';

const WARMUP_FRAMES = 20;
const NANOSECONDS_PER_MILLISECOND = 1e6;
const ONE_PIXEL = new Uint8Array(4);
const SUN_TURN_RADIANS_PER_FRAME = 0.002;
const OTHER_SEGMENT = 'opaque or other';
const TIMED_METHODS = ['createShadowMap', 'updateLocalShadows', 'drawEnvironmentBackground', 'drawTranslucent', 'drawBlendBatches', 'resolveFrame'];

// One GPU timer query may run at a time, so the frame is cut into consecutive segments: each timed method closes the
// segment that was open and opens its own, and the code after it belongs to the segment named OTHER_SEGMENT.
function createSegmentTimer(context) {
  const extension = context.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!extension) throw new Error('This browser has no EXT_disjoint_timer_query_webgl2.');
  let open = null;
  let frameSegments = [];
  let segmentsEnabled = true;
  const finishedFrames = [];
  return {
    start(name) {
      this.stop();
      const query = context.createQuery();
      context.beginQuery(extension.TIME_ELAPSED_EXT, query);
      open = { name, query };
    },
    stop() {
      if (!open) return;
      context.endQuery(extension.TIME_ELAPSED_EXT);
      frameSegments.push(open);
      open = null;
    },
    // Closes the frame: its queries wait in line until the GPU has finished them.
    endFrame() {
      this.stop();
      finishedFrames.push(frameSegments);
      frameSegments = [];
    },
    // Returns the per-segment milliseconds of every frame whose queries are all ready, oldest first. A frame the GPU
    // reported as disjoint is dropped.
    drain() {
      const ready = [];
      while (finishedFrames.length) {
        const segments = finishedFrames[0];
        if (!segments.every(({ query }) => context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE))) break;
        const disjoint = context.getParameter(extension.GPU_DISJOINT_EXT);
        const milliseconds = {};
        for (const { name, query } of segments) {
          milliseconds[name] = (milliseconds[name] ?? 0) + context.getQueryParameter(query, context.QUERY_RESULT) / NANOSECONDS_PER_MILLISECOND;
          context.deleteQuery(query);
        }
        finishedFrames.shift();
        if (!disjoint) ready.push(milliseconds);
      }
      return ready;
    },
    pendingFrames: () => finishedFrames.length,
    // With segments off the timed methods run untimed, so one query can cover the whole frame.
    setSegmentsEnabled(enabled) { segmentsEnabled = enabled; },
    segmentsEnabled: () => segmentsEnabled,
  };
}

function wrapSegment(owner, methodName, timer) {
  const original = owner[methodName].bind(owner);
  owner[methodName] = (...parameters) => {
    if (!timer.segmentsEnabled()) return original(...parameters);
    timer.start(methodName);
    const result = original(...parameters);
    timer.start(OTHER_SEGMENT);
    return result;
  };
}

const TRIVIAL_FRAGMENT = '#version 300 es\nprecision highp float;\nout vec4 outputColour;\nvoid main() { outputColour = vec4(1.0); }';
const TRIVIAL_VERTEX = '#version 300 es\nprecision highp float;\nlayout(location=0) in vec3 position;\nlayout(location=2) in mat4 instanceMatrix;\nuniform mat4 viewProjection;\nvoid main() { gl_Position = viewProjection * (instanceMatrix * vec4(position, 1.0)); }';

// Experiment only: swaps the colour pass shaders for trivial ones to find how much of the frame is the shaders.
function replaceColourShaders(replaceVertex) {
  const original = WebGL2RenderingContext.prototype.shaderSource;
  WebGL2RenderingContext.prototype.shaderSource = function shaderSource(shader, source) {
    const isColourFragment = source.includes('worldPosition') && source.includes('shadowPosition') && source.includes('out vec4') && source.includes('baseColor');
    const isColourVertex = source.includes('layout(location=2) in mat4 instanceMatrix') && source.includes('gl_Position = viewProjection * world;') && source.includes('out vec4 shadowPosition');
    if (isColourFragment) return original.call(this, shader, TRIVIAL_FRAGMENT);
    if (replaceVertex && isColourVertex) return original.call(this, shader, TRIVIAL_VERTEX);
    return original.call(this, shader, source);
  };
}


const SHADER_CUTS = [
  { name: 'cut-shadow', from: 'float visibility = shadowBlind > 0.5 ? 1.0 : shadowVisibility(normal);', to: 'float visibility = 1.0;' },
  { name: 'cut-fill', from: 'if (FILL_ON) {', to: 'if (false) {' },
  { name: 'cut-room', from: 'float room = 1.0 - smoothstep(0.01, 0.06, dot(environmentDiffuse(vec3(0, 1, 0)), vec3(1)) / max(dot(keyColor, vec3(1)), 0.003));', to: 'float room = 0.0;' },
  { name: 'cut-tint', from: '(USES_TINTED_SHADOWS && shadowBlind < 0.5 && tintBlind < 0.5) ?', to: 'false ?' },
  { name: 'cut-specular-aa', from: 'if (specularAntiAliasing > 0.0) {', to: 'if (false) {' },
  { name: 'cut-brdf-lookup', from: 'directSpecularGain = multipleScatterGain(brdfLookup, baseReflectance);', to: '' },
  { name: 'cut-key-light', from: 'vec3 radiance = illuminate(normal, viewDirection, normalize(lightDirection), keyColor', to: 'vec3 radiance = vec3(0.0) * illuminate(normal, viewDirection, normalize(lightDirection), keyColor' },
  { name: 'cut-normal-map', from: 'if (USES_NORMAL_MAP) normal = ensureValidReflection', to: 'if (false) normal = ensureValidReflection' },
  { name: 'cut-base-map', from: 'if (USES_BASE_MAP) {', to: 'if (false) {' },
  { name: 'cut-metallic-roughness-map', from: 'if (USES_METALLIC_ROUGHNESS_MAP) {', to: 'if (false) {' },
  // Base shading cuts (#2144): each removes one piece of the work every pixel does, to price it by itself (the picture changes).
  { name: 'cut-ibl-diffuse-tap', from: 'return (environmentIrradianceGrid(mapped) + environmentBounce) * environmentDiffuseFrame.z;', to: 'return (vec3(0.3) + environmentBounce) * environmentDiffuseFrame.z;' },
  { name: 'cut-ibl-specular-tap', from: 'vec3 specular = environmentRadiance(reflected, roughness * environmentLevelMax) * specularColor;', to: 'vec3 specular = vec3(0.3) * specularColor;' },
  { name: 'cut-ibl-brdf-tap', from: 'vec2 lookup = environmentBrdfLookup(normalView, roughness);', to: 'vec2 lookup = vec2(0.6, 0.05);' },
  { name: 'cut-ibl-off', from: 'return (specular + diffuse) * occlusion * ambient;', to: 'return vec3(0.0);' },
  { name: 'cut-fog', from: 'float fog = 1.0 - exp(-length(worldPosition - eye) * fogDensity);', to: 'float fog = 0.0;' },
  { name: 'cut-hdr-encode', from: 'return hdrEnabled > 0.5 ? clamp(radiance * exposure, vec3(0), vec3(65504.0)) : pow(toneMap(radiance * exposure), vec3(1.0 / 2.2));', to: 'return radiance * exposure;' },
  { name: 'cut-blend-output', from: 'outputColor = blendedOutput(displayedColor, displayedDiffuse, alpha);', to: 'outputColor = vec4(displayedColor, 1.0);' },
  { name: 'cut-material-setup', from: 'vec3 color = mix(baseColor, armorColor, step(0.5, surface.w) * (1.0 - step(1.5, surface.w)));\n  if (!USES_SPLAT) color *= vertexTint;', to: 'vec3 color = baseColor;' },
  { name: 'cut-armor-surface', from: 'if (surface.w > 0.5 && surface.w < 1.5) {', to: 'if (false) {' },
  // Standalone variants: they replace text another cut removes, so cumulative runs leave them out.
  { name: 'ibl-fixed-mip', standalone: true, from: 'environmentRadiance(reflected, roughness * environmentLevelMax)', to: 'environmentRadiance(reflected, 3.0)' },
  // Occupancy probes (#2144): the picture must not change.
  // Variant probe (#2144): the three map branches the courtyard program still has become constants (the 343 parts without maps would sample placeholders, so the picture is only near).
  { name: 'static-maps-on', standalone: true, transform: makeMapBranchesConstant },
  { name: 'occupancy-constant-uniforms', standalone: true, transform: constifyUniforms },
  { name: 'occupancy-extra-uniforms', standalone: true, transform: addUsedUniforms },
  { name: 'occupancy-mediump', standalone: true, transform: useMediumPrecision },
];

function makeMapBranchesConstant(source) {
  let changed = source;
  for (const macro of ['USES_NORMAL_MAP', 'USES_BASE_MAP', 'USES_METALLIC_ROUGHNESS_MAP']) {
    const pattern = new RegExp('^#define ' + macro + ' \\(.*\\)$', 'm');
    if (!pattern.test(changed)) throw new Error('Variant probe: #define ' + macro + ' is no longer a uniform branch; update makeMapBranchesConstant.');
    changed = changed.replace(pattern, '#define ' + macro + ' true');
  }
  return changed;
}

// Uniforms the Lone Monk courtyard frame never changes become constants, so the program has fewer to hold.
const CONSTANT_UNIFORMS = [['float', 'hdrEnabled', '1.0'], ['float', 'inspection', '0.0'], ['float', 'compositeMode', '0.0'], ['float', 'renderPassMode', '0.0']];
function constifyUniforms(source) {
  let changed = source;
  for (const [type, name, value] of CONSTANT_UNIFORMS) {
    const declaration = `uniform ${type} ${name};`;
    if (!changed.includes(declaration)) throw new Error('Occupancy cut: ' + declaration + ' is no longer declared; update CONSTANT_UNIFORMS.');
    changed = changed.replace(declaration, `const ${type} ${name} = ${value};`);
  }
  return changed;
}

// Adds 32 vec4 uniforms the shader reads, to see whether a larger uniform file by itself slows the frame.
function addUsedUniforms(source) {
  const withDeclaration = source.replace('uniform float compositeMode;', 'uniform float compositeMode;\nuniform vec4 occupancyPadding[32];');
  if (withDeclaration === source) throw new Error('Occupancy cut: compositeMode is no longer declared; update addUsedUniforms.');
  const read = 'vec4 occupancySum = vec4(0.0);\n  for (int index = 0; index < 32; index++) occupancySum += occupancyPadding[index];\n  outputColor.rgb += occupancySum.rgb * 0.0;\n';
  return withDeclaration.replace(/\n\}\s*$/, '\n  ' + read + '}');
}

// Default precision drops to mediump after the last uniform, so uniforms and varyings stay highp across both stages.
function useMediumPrecision(source) {
  const marker = 'uniform float compositeMode;';
  if (!source.includes(marker)) throw new Error('Occupancy cut: compositeMode is no longer declared; update useMediumPrecision.');
  return source.replace(marker, marker + '\nprecision mediump float;');
}

function applyCut(cut, source) {
  if (cut.transform) return cut.transform(source);
  if (!source.includes(cut.from)) throw new Error('Shader cut ' + cut.name + ' no longer matches the shader source.');
  return source.replace(cut.from, cut.to);
}

window.measureScene = async function measureScene({ description, glbUrl, hdriUrl, frames = 200, capture = false, alternate = false, segmented = true, width = 1280, height = 720, rendererOverrides = {}, denseLods = false, denseLodsMinimumTriangles = undefined, experiment = null, sequence = null, profile = null, cumulativeCuts = null, programReport = false, variantEmulation = false, variantRun = null, overdraw = null, opaqueOrder = null }) {
  const canvas = document.querySelector('#viewport');
  const experiments = new Set(String(experiment ?? '').split(','));
  if (experiments.has('no-invariant')) {
    const originalSource = WebGL2RenderingContext.prototype.shaderSource;
    WebGL2RenderingContext.prototype.shaderSource = function shaderSource(shader, source) {
      return originalSource.call(this, shader, source.replace('invariant gl_Position;', ''));
    };
  }
  if (experiments.has('light-prepass-vertex')) {
    // Experiment only: the prepass program (the colour vertex shader that follows the colour fragment shader) gets a position-only vertex shader.
    const originalSource = WebGL2RenderingContext.prototype.shaderSource;
    let afterColourFragment = false;
    WebGL2RenderingContext.prototype.shaderSource = function shaderSource(shader, source) {
      if (source.includes('worldPosition') && source.includes('shadowPosition') && source.includes('baseColor') && source.includes('out vec4')) afterColourFragment = true;
      const isColourVertex = source.includes('gl_Position = viewProjection * world;') && source.includes('out vec4 shadowPosition');
      if (isColourVertex && afterColourFragment) {
        afterColourFragment = false;
        return originalSource.call(this, shader, TRIVIAL_VERTEX);
      }
      return originalSource.call(this, shader, source);
    };
  }
  // Experiment only: each name cuts one piece out of the colour fragment shader, to price it by itself (the picture changes).
  const shaderCuts = SHADER_CUTS.filter(cut => experiments.has(cut.name));
  if (shaderCuts.length) {
    const originalSource = WebGL2RenderingContext.prototype.shaderSource;
    WebGL2RenderingContext.prototype.shaderSource = function shaderSource(shader, source) {
      if (!source.includes('float shadowVisibility')) return originalSource.call(this, shader, source);
      let cutSource = source;
      for (const cut of shaderCuts) cutSource = applyCut(cut, cutSource);
      return originalSource.call(this, shader, cutSource);
    };
  }
  const variantEmulator = variantEmulation ? installVariantEmulation() : null;
  if (experiment === 'trivial-fragment') replaceColourShaders(false);
  if (experiment === 'trivial-both') replaceColourShaders(true);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  description = { ...description, renderer: { ...(description.renderer ?? {}), ...rendererOverrides } };
  const [model, map] = await Promise.all([
    fetch(glbUrl).then(response => response.blob()),
    loadHdri(hdriUrl, description.hdriOptions ?? {}),
  ]);
  const asset = await loadGltf(model, { baseUrl: new URL('.', new URL(glbUrl, location.href)).href, sharedTextures: createSharedTextures(), ...(description.gltfOptions ?? {}) });
  const rendererOptions = withSceneFileRendererDefaults(description.renderer);
  const lodStarted = performance.now();
  const renderedParts = denseLods ? addLodsToDenseParts(asset.parts, { pixels: width * height, minimumTriangles: denseLodsMinimumTriangles }) : asset.parts;
  const lodBuildMs = Number((performance.now() - lodStarted).toFixed(0));
  const createRenderer = () => new CrucibleRenderer(canvas, renderedParts, {
    ground: false, hdr: true, samples: 4, ...rendererOptions,
    shadowCascades: rendererOptions.shadowCascades ? createCascadedShadows(rendererOptions.shadowCascades) : undefined,
    environment: { ...(rendererOptions.environment ?? {}), map },
  });
  if (programReport) {
    const recorder = installColourProgramRecorder();
    const reportRenderer = createRenderer();
    reportRenderer.render({ exposure: description.exposure ?? 1, ...(description.frame ?? {}), eye: description.eye, target: description.target });
    const programs = describeColourPrograms(recorder, renderedParts);
    recorder.uninstall();
    const rendererFeatures = [...reportRenderer.shaderFeatures].sort();
    reportRenderer.dispose();
    return { programs, rendererFeatures, partCount: renderedParts.length };
  }
  if (variantRun) {
    variantEmulator?.uninstall();
    const runFrame = { exposure: description.exposure ?? 1, ...(description.frame ?? {}), eye: description.eye, target: description.target };
    return { ...await measureVariantRun({ createRenderer, canvas, frame: runFrame, ...variantRun }), lodBuildMs };
  }
  if (cumulativeCuts) {
    const cumulativeFrame = { exposure: description.exposure ?? 1, ...(description.frame ?? {}), eye: description.eye, target: description.target };
    return { ...await measureCumulativeCuts({ createRenderer, canvas, frame: cumulativeFrame, ...cumulativeCuts }), lodBuildMs };
  }
  if (overdraw || opaqueOrder) {
    const orderFrame = { exposure: description.exposure ?? 1, ...(description.frame ?? {}), eye: description.eye, target: description.target };
    if (overdraw) return { ...await measureOverdraw({ createRenderer, canvas, frame: orderFrame, ...overdraw }), lodBuildMs };
    return { ...await measureOpaqueOrder({ createRenderer, canvas, frame: orderFrame, timeFrames, createSegmentTimer, totalOf, median, rotatedOrder, ...opaqueOrder }), lodBuildMs };
  }
  const renderer = createRenderer();
  const context = renderer.context;
  const timer = createSegmentTimer(context);
  // The renderer's own timer would open a query inside ours, and WebGL allows one at a time.
  renderer.gpuTimer = null;
  const frame = { exposure: description.exposure ?? 1, ...(description.frame ?? {}), eye: description.eye, target: description.target };
  if (segmented || profile) {
    for (const methodName of TIMED_METHODS) wrapSegment(renderer, methodName, timer);
    if (renderer.shadowCascades) wrapSegment(renderer.shadowCascades, 'update', timer);
  }
  if (profile) return { ...await measureProfile({ renderer, context, canvas, timer, frame, ...profile }), ...describeRun(context, canvas, width, height, renderer), lodBuildMs, drawCounts: countDrawCalls(renderer, context, frame) };
  if (experiment === 'discard') {
    // Vertex work only: the rasterizer throws every triangle away, so no pixel is shaded.
    const originalDraw = renderer.drawAlphaBatch.bind(renderer);
    renderer.drawAlphaBatch = (...parameters) => {
      context.enable(context.RASTERIZER_DISCARD);
      const result = originalDraw(...parameters);
      context.disable(context.RASTERIZER_DISCARD);
      return result;
    };
  }
  if (alternate) {
    // The depth prepass alone: the colour draws are skipped, to price the prepass by itself.
    const shadeBatch = renderer.drawShadedBatch.bind(renderer);
    renderer.drawShadedBatch = (...parameters) => (prepassOnly ? undefined : shadeBatch(...parameters));
  }
  const perSegment = {};
  const wallMilliseconds = [];
  const totals = [];
  // With `alternate`, frames alternate between the depth prepass off and on, so both see the same load of a shared card.
  const alternating = { off: [], on: [], only: [] };
  const alternatingSegments = { off: {}, on: {}, only: {} };
  const frameModes = [];
  let prepassOnly = false;
  let framesSeen = 0;
  const record = (milliseconds) => {
    const mode = frameModes.shift();
    framesSeen++;
    if (framesSeen <= WARMUP_FRAMES) return;
    const total = Object.values(milliseconds).reduce((sum, value) => sum + value, 0);
    totals.push(total);
    for (const [name, value] of Object.entries(milliseconds)) (perSegment[name] ??= []).push(value);
    if (!alternate) return;
    alternating[mode].push(total);
    for (const [name, value] of Object.entries(milliseconds)) (alternatingSegments[mode][name] ??= []).push(value);
  };
  for (let index = 0; index < WARMUP_FRAMES + frames; index++) {
    const started = performance.now();
    const mode = ['off', 'on', 'only'][index % 3];
    if (alternate) {
      renderer.setDepthPrepass(mode !== 'off');
      prepassOnly = mode === 'only';
    }
    frameModes.push(mode);
    timer.start(segmented ? 'setup before first pass' : 'whole frame');
    renderer.render(frame);
    timer.endFrame();
    context.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, context.RGBA, context.UNSIGNED_BYTE, ONE_PIXEL);
    if (index >= WARMUP_FRAMES) wallMilliseconds.push(performance.now() - started);
    timer.drain().forEach(record);
  }
  for (let attempt = 0; attempt < 200 && timer.pendingFrames(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    timer.drain().forEach(record);
  }
  // One counted frame: the triangles and draw calls Glaze sends after culling and level selection.
  const drawCounts = { drawCalls: 0, triangles: 0 };
  const originalDrawInstanced = context.drawElementsInstanced.bind(context);
  context.drawElementsInstanced = (mode, count, type, offset, instances) => {
    drawCounts.drawCalls++;
    drawCounts.triangles += (count / 3) * instances;
    return originalDrawInstanced(mode, count, type, offset, instances);
  };
  renderer.render(frame);
  context.drawElementsInstanced = originalDrawInstanced;
  let capturedFrame = null;
  if (capture) {
    // One more frame, read back whole in the same task, so the canvas still holds it.
    renderer.render(frame);
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
    let binary = '';
    for (let offset = 0; offset < pixels.length; offset += 0x8000) binary += String.fromCharCode(...pixels.subarray(offset, offset + 0x8000));
    capturedFrame = btoa(binary);
  }
  let sequenceTriangles = null;
  if (sequence) sequenceTriangles = await captureSequence({ renderer, context, canvas, frame, eye: description.eye, target: description.target, ...sequence });
  if (experiment === "probe") return probeAlongView(asset.parts, description.eye, description.target);
  const geometries = new Set(asset.parts.map(part => part.geometry));
  const geometryStats = {
    vertices: [...geometries].reduce((sum, geometry) => sum + geometry.positions.length / 3, 0),
    indices: [...geometries].reduce((sum, geometry) => sum + geometry.indices.length, 0),
    batches: renderer.batches.length,
    batchesWithFlushRanges: renderer.batches.filter(batch => batch.flushOrder?.ranges).length,
    flushRangeDraws: renderer.batches.reduce((sum, batch) => sum + (batch.flushOrder?.ranges?.length ?? 0), 0),
    batchIndexTotal: renderer.batches.reduce((sum, batch) => sum + batch.indexCount * batch.instanceCount, 0),
  };
  return {
    geometryStats,
    parts: asset.parts.length,
    lodBuildMs,
    drawCounts,
    canvas: [canvas.width, canvas.height],
    samples: totals.length,
    wallMedianMs: Number(median(wallMilliseconds).toFixed(3)),
    gpuTotalMedianMs: Number(median(totals).toFixed(3)),
    segmentMedianMs: Object.fromEntries(Object.entries(perSegment).map(([name, values]) => [name, Number(median(values).toFixed(3))])),
    depthPrepassActive: renderer.depthPrepassActive,
    shaderFeatures: [...renderer.shaderFeatures].sort(),
    alternating: alternate ? Object.fromEntries(['off', 'on', 'only'].map(mode => [mode, {
      gpuTotalMedianMs: Number(median(alternating[mode]).toFixed(3)),
      gpuTotalRangeMs: [Number(Math.min(...alternating[mode]).toFixed(3)), Number(Math.max(...alternating[mode]).toFixed(3))],
      segmentMedianMs: Object.fromEntries(Object.entries(alternatingSegments[mode]).map(([name, values]) => [name, Number(median(values).toFixed(3))])),
    }])) : undefined,
    pairedOnOverOffMedian: alternate ? Number(median(alternating.on.slice(0, alternating.off.length).map((value, index) => value / alternating.off[index])).toFixed(3)) : undefined,
    capturedFrame,
    variantStatistics: variantEmulator?.describe(),
    sequenceTriangles,
    centerPixel: Array.from(ONE_PIXEL),
    glError: context.getError(),
    ...describeRun(context, canvas, width, height, renderer),
  };
};
window.harnessReady = true;

// Experiment only: the parts whose bounding box the view ray crosses, nearest first, with their material.
function probeAlongView(parts, eye, target) {
  const direction = [0, 1, 2].map(axis => target[axis] - eye[axis]);
  const length = Math.hypot(...direction);
  const unit = direction.map(value => value / length);
  const hits = [];
  parts.forEach((part, index) => {
    const positions = part.geometry.positions;
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    const matrix = part.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let offset = 0; offset < positions.length; offset += 3 * 8) {
      const [x, y, z] = [positions[offset], positions[offset + 1], positions[offset + 2]];
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
        low[axis] = Math.min(low[axis], value);
        high[axis] = Math.max(high[axis], value);
      }
    }
    let near = 0;
    let far = 200;
    for (let axis = 0; axis < 3; axis++) {
      if (Math.abs(unit[axis]) < 1e-9) {
        if (eye[axis] < low[axis] || eye[axis] > high[axis]) { near = Infinity; break; }
        continue;
      }
      const first = (low[axis] - eye[axis]) / unit[axis];
      const second = (high[axis] - eye[axis]) / unit[axis];
      near = Math.max(near, Math.min(first, second));
      far = Math.min(far, Math.max(first, second));
    }
    if (near <= far) hits.push({ index, name: part.name, near: Number(near.toFixed(2)), far: Number(far.toFixed(2)), size: low.map((value, axis) => Number((high[axis] - value).toFixed(1))), material: part.material });
  });
  hits.sort((first, second) => first.near - second.near);
  return { hits: hits.slice(0, 12) };
}

// A dolly along the view direction, from `backMetres` behind the camera to `forwardMetres` in front of it. Each frame
// is read back whole and handed to window.deliverFrame(index, base64) (run.mjs writes it); returns the triangles drawn per frame.
async function captureSequence({ renderer, context, canvas, frame, eye, target, frames = 60, backMetres = 6, forwardMetres = 5 }) {
  const length = Math.hypot(...[0, 1, 2].map(axis => target[axis] - eye[axis]));
  const unit = [0, 1, 2].map(axis => (target[axis] - eye[axis]) / length);
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  const originalDrawInstanced = context.drawElementsInstanced.bind(context);
  const triangleCounts = [];
  for (let index = 0; index < frames; index++) {
    const metres = -backMetres + (backMetres + forwardMetres) * index / (frames - 1);
    const moved = { ...frame, eye: eye.map((value, axis) => value + unit[axis] * metres), target: target.map((value, axis) => value + unit[axis] * metres) };
    let triangles = 0;
    context.drawElementsInstanced = (mode, count, type, offset, instances) => {
      triangles += (count / 3) * instances;
      return originalDrawInstanced(mode, count, type, offset, instances);
    };
    renderer.render(moved);
    context.drawElementsInstanced = originalDrawInstanced;
    triangleCounts.push(triangles);
    context.readPixels(0, 0, canvas.width, canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
    let binary = '';
    for (let offset = 0; offset < pixels.length; offset += 0x8000) binary += String.fromCharCode(...pixels.subarray(offset, offset + 0x8000));
    await window.deliverFrame(index, btoa(binary));
  }
  return triangleCounts;
}

function describeRun(context, canvas, width, height, renderer) {
  const debugInfo = context.getExtension('WEBGL_debug_renderer_info');
  return {
    glRenderer: debugInfo ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'unknown',
    resolution: [canvas.width, canvas.height],
    requestedResolution: [width, height],
    msaaSamples: renderer.samples ?? null,
  };
}

// One frame counted the way the plain mode does: the draw calls and triangles Glaze sends after culling and level selection.
function countDrawCalls(renderer, context, frame) {
  const counts = { drawCalls: 0, triangles: 0 };
  const originalDrawInstanced = context.drawElementsInstanced.bind(context);
  context.drawElementsInstanced = (mode, count, type, offset, instances) => {
    counts.drawCalls++;
    counts.triangles += (count / 3) * instances;
    return originalDrawInstanced(mode, count, type, offset, instances);
  };
  renderer.render(frame);
  context.drawElementsInstanced = originalDrawInstanced;
  return counts;
}

// Renders warm-up plus counted frames and returns, per frame, the GPU milliseconds (whole frame, or one entry per pass when
// the timer's segments are on) and the wall milliseconds around render and a one pixel read back. Warm-up frames are included
// so the caller decides what to drop. The same loop times every mode of the profile, which is what makes them comparable.
async function timeFrames({ renderer, context, canvas, timer, frame, frames, warmupFrames = WARMUP_FRAMES, segmented }) {
  const wall = [];
  const gpu = [];
  const collect = ready => ready.forEach(milliseconds => gpu.push(milliseconds));
  timer.setSegmentsEnabled(segmented);
  for (let index = 0; index < warmupFrames + frames; index++) {
    const started = performance.now();
    timer.start(segmented ? 'setup before first pass' : 'whole frame');
    renderer.render(typeof frame === 'function' ? frame(index) : frame);
    timer.endFrame();
    context.readPixels(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1, context.RGBA, context.UNSIGNED_BYTE, ONE_PIXEL);
    wall.push(performance.now() - started);
    collect(timer.drain());
  }
  for (let attempt = 0; attempt < 200 && timer.pendingFrames(); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    collect(timer.drain());
  }
  return { wall, gpu };
}

function totalOf(milliseconds) {
  return Object.values(milliseconds).reduce((sum, value) => sum + value, 0);
}

// Every mode on one scale, in one page and one renderer: a cold run (to show whether the first frames cost more), then for each
// camera `rounds` rounds that alternate the whole-frame query and the per-pass queries in rotating order.
async function measureProfile({ renderer, context, canvas, timer, frame, cameras = [], rounds = 3, frames = 150, coldFrames = 300, coldBlockSize = 25, movingSun = false }) {
  const cold = await timeFrames({ renderer, context, canvas, timer, frame, frames: coldFrames, warmupFrames: 0, segmented: false });
  const coldGpu = cold.gpu.map(totalOf);
  const coldStart = {
    blockSize: coldBlockSize,
    gpuBlockMediansMs: blockMedians(coldGpu, coldBlockSize),
    wallBlockMediansMs: blockMedians(cold.wall, coldBlockSize),
    gpuAfterWarmup: summarizeAfterWarmup(coldGpu, WARMUP_FRAMES),
  };
  const perCamera = {};
  const baseLightDirection = renderer.environment?.lightDirection ?? [-3, 6, 4];
  // A sun that turns a little every frame makes Glaze redraw its shadow maps every frame, which a still frame never does.
  const turningSun = index => {
    const angle = index * SUN_TURN_RADIANS_PER_FRAME;
    const [x, y, z] = baseLightDirection;
    return [x * Math.cos(angle) - z * Math.sin(angle), y, x * Math.sin(angle) + z * Math.cos(angle)];
  };
  const cameraList = cameras.length ? cameras : [{ name: 'scene', eye: frame.eye, target: frame.target }];
  const runs = cameraList.flatMap(camera => [{ name: camera.name, camera, movingSun: false }, ...(movingSun ? [{ name: camera.name + '-moving-sun', camera, movingSun: true }] : [])]);
  for (const { name, camera, movingSun: sunTurns } of runs) {
    const staticFrame = { ...frame, eye: camera.eye, target: camera.target };
    const cameraFrame = sunTurns ? index => ({ ...staticFrame, environment: { ...(staticFrame.environment ?? {}), lightDirection: turningSun(index) } }) : staticFrame;
    const wholeGpu = [];
    const wholeWall = [];
    const segmentTotals = [];
    const segmentWall = [];
    const segmentRounds = {};
    for (let round = 0; round < rounds; round++) {
      for (const mode of rotatedOrder(['whole', 'segmented'], round)) {
        const segmented = mode === 'segmented';
        const result = await timeFrames({ renderer, context, canvas, timer, frame: cameraFrame, frames, segmented });
        const gpuFrames = result.gpu.slice(WARMUP_FRAMES);
        const wallFrames = result.wall.slice(WARMUP_FRAMES);
        if (!segmented) {
          wholeGpu.push(median(gpuFrames.map(totalOf)));
          wholeWall.push(median(wallFrames));
          continue;
        }
        segmentTotals.push(median(gpuFrames.map(totalOf)));
        segmentWall.push(median(wallFrames));
        for (const name of new Set(gpuFrames.flatMap(milliseconds => Object.keys(milliseconds)))) {
          (segmentRounds[name] ??= []).push(median(gpuFrames.map(milliseconds => milliseconds[name] ?? 0)));
        }
      }
    }
    perCamera[name] = {
      eye: camera.eye,
      target: camera.target,
      wholeFrame: { gpuMs: summarizeRounds(wholeGpu), wallMs: summarizeRounds(wholeWall), roundGpuMedians: wholeGpu.map(value => Number(value.toFixed(3))) },
      perPass: {
        gpuTotalMs: summarizeRounds(segmentTotals),
        wallMs: summarizeRounds(segmentWall),
        passMedianMs: Object.fromEntries(Object.entries(segmentRounds).map(([name, values]) => [name, summarizeRounds(values)])),
      },
    };
  }
  return { coldStart, perCamera, rounds, frames, warmupFrames: WARMUP_FRAMES };
}

// Times the colour fragment shader with cuts applied, one renderer per step on the same page, on the whole-frame GPU timer.
//   mode 'cumulative': the cuts stay off one after another, in listed order then reversed order (the reversed run starts again from none).
//   mode 'each': every cut alone against none, with none repeated at the end to show drift.
// `round` rotates which order runs first, so a card whose load drifts does not favour one. `cuts` names the cuts (default: the base shading cuts).
// Each step reports the largest colour program's active uniforms and the GL errors seen at each point of the step.
const BASE_SHADING_CUTS = ['cut-ibl-diffuse-tap', 'cut-ibl-specular-tap', 'cut-ibl-brdf-tap', 'cut-ibl-off', 'cut-fog', 'cut-hdr-encode', 'cut-blend-output', 'cut-material-setup'];
async function measureCumulativeCuts({ createRenderer, canvas, frame, frames = 100, round = 0, baselineOnly = false, cuts = BASE_SHADING_CUTS, mode = 'cumulative', keepRendererTimer = false }) {
  const unknown = cuts.filter(name => !SHADER_CUTS.some(cut => cut.name === name));
  if (unknown.length) throw new Error('Unknown shader cuts: ' + unknown.join(', ') + '. Pass names from SHADER_CUTS.');
  let activeCuts = [];
  const colourShaders = new WeakSet();
  const programsWithColourShader = new WeakSet();
  const linkedPrograms = [];
  const prototype = WebGL2RenderingContext.prototype;
  const originalSource = prototype.shaderSource;
  const originalAttach = prototype.attachShader;
  const originalLink = prototype.linkProgram;
  prototype.shaderSource = function shaderSource(shader, source) {
    if (!source.includes('float shadowVisibility')) return originalSource.call(this, shader, source);
    colourShaders.add(shader);
    let cutSource = source;
    for (const name of activeCuts) cutSource = applyCut(SHADER_CUTS.find(cut => cut.name === name), cutSource);
    return originalSource.call(this, shader, cutSource);
  };
  prototype.attachShader = function attachShader(program, shader) {
    if (colourShaders.has(shader)) programsWithColourShader.add(program);
    return originalAttach.call(this, program, shader);
  };
  prototype.linkProgram = function linkProgram(program) {
    originalLink.call(this, program);
    if (programsWithColourShader.has(program)) linkedPrograms.push({ context: this, program });
  };
  const drainErrors = context => {
    const found = [];
    for (let error = context.getError(); error !== context.NO_ERROR && found.length < 8; error = context.getError()) found.push(error);
    return found;
  };
  const measureStep = async (label, stepCuts) => {
    activeCuts = stepCuts;
    linkedPrograms.length = 0;
    const renderer = createRenderer();
    const context = renderer.context;
    const errorTrace = { beforeRenderer: drainErrors(context) };
    const timer = createSegmentTimer(context);
    // The renderer's own timer would open a query inside ours, and WebGL allows one at a time (keepRendererTimer leaves it on to show the INVALID_OPERATION that causes).
    if (!keepRendererTimer) renderer.gpuTimer = null;
    errorTrace.afterCreate = drainErrors(context);
    renderer.render(frame);
    errorTrace.afterFirstRender = drainErrors(context);
    const result = await timeFrames({ renderer, context, canvas, timer, frame, frames, segmented: false });
    errorTrace.afterTiming = drainErrors(context);
    const gpuFrames = result.gpu.slice(WARMUP_FRAMES).map(totalOf);
    const activeUniforms = Math.max(0, ...linkedPrograms.map(({ context: owner, program }) => owner.getProgramParameter(program, owner.ACTIVE_UNIFORMS)));
    renderer.dispose();
    return {
      label,
      cuts: stepCuts.length,
      lastCut: stepCuts.at(-1) ?? null,
      gpuMedianMs: Number(median(gpuFrames).toFixed(3)),
      gpuMinMs: Number(Math.min(...gpuFrames).toFixed(3)),
      wallMedianMs: Number(median(result.wall.slice(WARMUP_FRAMES)).toFixed(3)),
      activeUniforms,
      glErrors: errorTrace,
    };
  };
  const steps = [];
  try {
    steps.push({ order: 'none', ...await measureStep('none', []) });
    if (!baselineOnly) {
      const plans = mode === 'each'
        ? [{ order: 'each', lists: cuts.map(name => [name]) }]
        : [{ order: 'listed', lists: cuts.map((_, index) => cuts.slice(0, index + 1)) }, { order: 'reversed', lists: cuts.map((_, index) => [...cuts].reverse().slice(0, index + 1)) }];
      for (const { order, lists } of rotatedOrder(plans, round)) {
        for (const list of lists) steps.push({ order, ...await measureStep(`${order} ${list.length}`, list) });
      }
      steps.push({ order: 'none-again', ...await measureStep('none again', []) });
    }
  } finally {
    prototype.shaderSource = originalSource;
    prototype.attachShader = originalAttach;
    prototype.linkProgram = originalLink;
  }
  return { cumulative: steps, mode, cutOrder: cuts, round, frames };
}

// Whole-frame GPU time of the uber colour program against the emulated per material variants (variant-programs.js), on one page.
// Steps run uber, variants, uber, variants (reversed when `round` is odd) so a drifting card does not favour one; each step is a fresh renderer.
async function measureVariantRun({ createRenderer, canvas, frame, frames = 100, round = 0 }) {
  const order = round % 2 === 0 ? ['uber', 'variants', 'switch-only', 'uber', 'variants', 'switch-only'] : ['switch-only', 'variants', 'uber', 'switch-only', 'variants', 'uber'];
  const steps = [];
  for (const label of order) {
    const emulator = label === 'uber' ? null : installVariantEmulation({ keepUniformGates: label === 'switch-only' });
    const recorder = installColourProgramRecorder();
    const renderer = createRenderer();
    const context = renderer.context;
    const timer = createSegmentTimer(context);
    renderer.gpuTimer = null;
    renderer.render(frame);
    const result = await timeFrames({ renderer, context, canvas, timer, frame, frames, segmented: false });
    const gpuFrames = result.gpu.slice(WARMUP_FRAMES).map(totalOf);
    const uberProgram = describeColourPrograms(recorder, [])[0];
    recorder.uninstall();
    const glError = context.getError();
    steps.push({
      label,
      gpuMedianMs: Number(median(gpuFrames).toFixed(3)),
      gpuMinMs: Number(Math.min(...gpuFrames).toFixed(3)),
      wallMedianMs: Number(median(result.wall.slice(WARMUP_FRAMES)).toFixed(3)),
      uberProgram: { sourceLines: uberProgram.sourceLines, translatedLines: uberProgram.translatedLines, activeUniforms: uberProgram.activeUniforms },
      variantStatistics: emulator?.describe(),
      glError,
    });
    emulator?.uninstall();
    renderer.dispose();
  }
  return { variantRun: steps, round, frames };
}
