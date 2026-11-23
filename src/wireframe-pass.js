import { mat4 } from 'gl-matrix';
import { compileProgram } from './gl-program.js';
import { polygonMeshOf } from './agent-mesh.js';
import { MAXIMUM_WIREFRAME_SEGMENTS, WIREFRAME_KINDS, WIREFRAME_SEGMENT_STRIDE, meshWireframe } from './mesh-wireframe.js';

// The wireframe render pass: the shaded surface of the diffuse pass with every polygon edge drawn over it, and the edges
// that need repair in a colour of their own (see docs/render-passes.md). It draws into the pass target of render-passes.js
// after that pass, so the recipe, its geometry and the lit image are untouched.

/** The most segments one frame draws over all parts. Parts after the limit are left out and listed in the report. */
export const MAXIMUM_WIREFRAME_FRAME_SEGMENTS = 1_000_000;
/** The most parts the report lists by name. */
export const MAXIMUM_WIREFRAME_REPORTED_PARTS = 20;
/** Edge colours by kind number (WIREFRAME_KINDS order): regular dark, boundary orange, non-manifold red, flipped cyan, degenerate magenta. */
export const WIREFRAME_COLORS = Object.freeze([[0.06, 0.07, 0.09], [1, 0.55, 0], [1, 0.05, 0.05], [0, 0.85, 1], [1, 0, 0.9]]);
// Half the line width in pixels, so a fault is drawn about twice as wide as a regular edge.
const HALF_WIDTHS = Object.freeze([0.7, 1.6, 1.6, 1.6, 1.6]);
/** The defaults of the style options of withWireframe. */
export const WIREFRAME_STYLE_DEFAULTS = Object.freeze({ faults: true, color: WIREFRAME_COLORS[0], halfWidth: HALF_WIDTHS[0] });
const MAXIMUM_HALF_WIDTH = 32;
// Pulls edges toward the camera in normalized depth so they win against the surface they lie on.
const DEPTH_BIAS = 2e-4;

const wireframeVertex = `#version 300 es
precision highp float;
layout(location = 0) in vec3 endpointA;
layout(location = 1) in vec3 endpointB;
layout(location = 2) in float kind;
uniform mat4 modelViewProjection;
uniform vec2 viewportSize;
uniform float halfWidths[5];
uniform float depthBias;
flat out float edgeKind;
void main() {
  const vec2 corners[6] = vec2[6](vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0), vec2(0.0, -1.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
  vec4 clipA = modelViewProjection * vec4(endpointA, 1.0);
  vec4 clipB = modelViewProjection * vec4(endpointB, 1.0);
  edgeKind = kind;
  const float nearW = 1e-4;
  if (clipA.w < nearW && clipB.w < nearW) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  if (clipA.w < nearW) clipA = mix(clipA, clipB, (nearW - clipA.w) / (clipB.w - clipA.w));
  if (clipB.w < nearW) clipB = mix(clipB, clipA, (nearW - clipB.w) / (clipA.w - clipB.w));
  vec2 screenA = clipA.xy / clipA.w * viewportSize * 0.5;
  vec2 screenB = clipB.xy / clipB.w * viewportSize * 0.5;
  vec2 along = screenB - screenA;
  vec2 direction = length(along) > 1e-6 ? normalize(along) : vec2(1.0, 0.0);
  vec2 side = vec2(-direction.y, direction.x);
  vec2 corner = corners[gl_VertexID];
  vec4 clip = mix(clipA, clipB, corner.x);
  vec2 offset = (side * corner.y + direction * (corner.x * 2.0 - 1.0)) * halfWidths[int(kind + 0.5)] / (viewportSize * 0.5);
  clip.xy += offset * clip.w;
  clip.z -= depthBias * clip.w;
  gl_Position = clip;
}`;

const wireframeFragment = `#version 300 es
precision highp float;
uniform vec3 colors[5];
flat in float edgeKind;
out vec4 outputColor;
void main() { outputColor = vec4(colors[int(edgeKind + 0.5)], 1.0); }`;

const programs = new WeakMap();

function programFor(renderer) {
  let program = programs.get(renderer);
  if (program) return program;
  const context = renderer.context;
  const handle = compileProgram(context, wireframeVertex, wireframeFragment);
  program = {
    handle,
    modelViewProjection: context.getUniformLocation(handle, 'modelViewProjection'),
    viewportSize: context.getUniformLocation(handle, 'viewportSize'),
    halfWidths: context.getUniformLocation(handle, 'halfWidths[0]'),
    depthBias: context.getUniformLocation(handle, 'depthBias'),
    colors: context.getUniformLocation(handle, 'colors[0]'),
  };
  programs.set(renderer, program);
  return program;
}

// One instanced vertex array per geometry for the frame being drawn: each segment is an instance of the six corners of a
// screen-space quad. The entries live in `frameEntries` and drawWireframe deletes their GL objects when the frame is done.
function buffersFor(renderer, geometry, frameEntries) {
  let entry = frameEntries.get(geometry);
  if (entry) return entry;
  let wireframe;
  try {
    wireframe = meshWireframe(polygonMeshOf(geometry), { maximumSegments: MAXIMUM_WIREFRAME_SEGMENTS });
  } catch (error) {
    // Geometry that has no polygon view (every triangle collapses, no triangles) is listed as skipped instead of failing the job.
    if (!(error instanceof RangeError || error instanceof TypeError)) throw error;
    entry = { unreadable: true, count: 0 };
    frameEntries.set(geometry, entry);
    return entry;
  }
  const context = renderer.context;
  const buffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  context.bufferData(context.ARRAY_BUFFER, wireframe.segments, context.STATIC_DRAW);
  const vertexArray = context.createVertexArray();
  context.bindVertexArray(vertexArray);
  const stride = WIREFRAME_SEGMENT_STRIDE * 4;
  for (const [location, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 1, 24]]) {
    context.enableVertexAttribArray(location);
    context.vertexAttribPointer(location, size, context.FLOAT, false, stride, offset);
    context.vertexAttribDivisor(location, 1);
  }
  entry = { buffer, vertexArray, count: wireframe.count, counts: wireframe.counts, truncated: wireframe.truncated };
  frameEntries.set(geometry, entry);
  return entry;
}

function drawnParts(renderer) {
  return renderer.batches.filter(batch => renderer.drawsInOpaqueLoop(batch)).flatMap(batch => batch.parts);
}

function releaseEntries(context, frameEntries) {
  for (const entry of frameEntries.values()) {
    if (!entry.vertexArray) continue;
    context.deleteVertexArray(entry.vertexArray);
    context.deleteBuffer(entry.buffer);
  }
}

// Validates the style options at the public boundary and returns the colour and half width of each edge kind. With
// faults: true the regular edges take the colour and width given and the faults keep theirs; with faults: false every kind does.
function resolveStyle(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('withWireframe options must be an object such as { faults: false, color: [0.1, 0.1, 0.1], halfWidth: 1 }.');
  }
  const { faults, color, halfWidth } = { ...WIREFRAME_STYLE_DEFAULTS, ...options };
  if (typeof faults !== 'boolean') throw new TypeError(`withWireframe faults must be true or false, got ${String(faults)}. Pass faults: false to draw every edge the same.`);
  const isChannel = channel => typeof channel === 'number' && channel >= 0 && channel <= 1;
  if (!Array.isArray(color) || color.length !== 3 || !color.every(isChannel)) {
    throw new TypeError('withWireframe color must be three numbers from 0 to 1, for example [0.06, 0.07, 0.09].');
  }
  if (typeof halfWidth !== 'number' || !(halfWidth > 0 && halfWidth <= MAXIMUM_HALF_WIDTH)) {
    throw new RangeError(`withWireframe halfWidth must be a number above 0 and at most ${MAXIMUM_HALF_WIDTH} (half the line width in pixels), got ${String(halfWidth)}.`);
  }
  const colors = WIREFRAME_COLORS.map((faultColor, kind) => (kind === 0 || !faults ? color : faultColor));
  const halfWidths = HALF_WIDTHS.map((faultWidth, kind) => (kind === 0 || !faults ? halfWidth : faultWidth));
  return { colors: colors.flat(), halfWidths };
}

function faultCounts(counts) {
  const { regular, ...faults } = counts;
  return faults;
}

// Draws the edges into the pass target while the pass is still in its depth state: reversed-Z (cleared to 0, GREATER, a
// reversed projection) where EXT_clip_control exists, standard depth otherwise.
function drawWireframe(renderer, style) {
  const context = renderer.context;
  const program = programFor(renderer);
  const reversed = renderer.reversedDepth === true;
  const viewProjection = reversed ? renderer.rasterViewProjection : renderer.viewProjection;
  context.bindFramebuffer(context.FRAMEBUFFER, renderer.passSupport.framebuffer);
  context.viewport(0, 0, renderer.canvas.width, renderer.canvas.height);
  context.useProgram(program.handle);
  context.uniform2f(program.viewportSize, renderer.canvas.width, renderer.canvas.height);
  context.uniform1fv(program.halfWidths, style.halfWidths);
  context.uniform1f(program.depthBias, reversed ? -DEPTH_BIAS : DEPTH_BIAS);
  context.uniform3fv(program.colors, style.colors);
  context.enable(context.DEPTH_TEST);
  context.depthFunc(reversed ? context.GEQUAL : context.LEQUAL);
  context.depthMask(false);
  context.disable(context.CULL_FACE);
  const totals = Object.fromEntries(WIREFRAME_KINDS.map(name => [name, 0]));
  const faulty = [];
  const modelViewProjection = mat4.create();
  let drawn = 0;
  let partsOmitted = 0;
  let partsSkipped = 0;
  let truncated = false;
  const frameEntries = new Map();
  try {
    for (const part of drawnParts(renderer)) {
      const entry = buffersFor(renderer, part.geometry, frameEntries);
      if (entry.unreadable) {
        partsSkipped++;
        continue;
      }
      if (drawn + entry.count > MAXIMUM_WIREFRAME_FRAME_SEGMENTS) {
        partsOmitted++;
        continue;
      }
      drawn += entry.count;
      truncated ||= entry.truncated;
      for (const name of WIREFRAME_KINDS) totals[name] += entry.counts[name];
      const faults = faultCounts(entry.counts);
      if (Object.values(faults).some(count => count > 0)) faulty.push({ part: part.name, ...faults });
      mat4.multiply(modelViewProjection, viewProjection, part.matrix);
      context.uniformMatrix4fv(program.modelViewProjection, false, modelViewProjection);
      context.bindVertexArray(entry.vertexArray);
      context.drawArraysInstanced(context.TRIANGLES, 0, 6, entry.count);
    }
  } finally {
    context.bindVertexArray(null);
    releaseEntries(context, frameEntries);
  }
  context.depthMask(true);
  context.depthFunc(reversed ? context.GREATER : context.LESS);
  context.enable(context.CULL_FACE);
  const faultTotal = part => part.boundary + part.nonManifold + part.flipped + part.degenerate;
  faulty.sort((first, second) => faultTotal(second) - faultTotal(first));
  return {
    edges: totals,
    faultyParts: faulty.slice(0, MAXIMUM_WIREFRAME_REPORTED_PARTS),
    faultyPartsOmitted: Math.max(0, faulty.length - MAXIMUM_WIREFRAME_REPORTED_PARTS),
    partsOmitted,
    partsSkipped,
    truncated,
  };
}

/**
 * Runs `renderFrame`, which must draw one `wireframe` pass frame with this renderer, and draws the polygon edges of every part
 * the pass shows over its surface before the frame reaches the canvas. Returns what the agent needs to read the picture: edge
 * counts by kind over the drawn parts, the parts that have faults (up to MAXIMUM_WIREFRAME_REPORTED_PARTS, worst first) and
 * whether anything was left out to stay within the limits.
 *
 * `options` styles the edges: `faults` (default true) draws boundary, non-manifold, flipped and degenerate edges in their repair
 * colours at double width, and false draws every edge as a regular one; `color` (three numbers from 0 to 1) and `halfWidth`
 * (pixels, half the line width) style the regular edges, and all edges when faults is false. The report counts every kind either way.
 */
export function withWireframe(renderer, renderFrame, options = {}) {
  const style = resolveStyle(options);
  let report = null;
  renderer.passSupport.overlay = () => { report = drawWireframe(renderer, style); };
  try {
    renderFrame();
  } finally {
    renderer.passSupport.overlay = null;
  }
  if (!report) throw new Error('The wireframe pass drew no frame.');
  return report;
}
