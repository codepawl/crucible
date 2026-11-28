// Mesh blend: a screen-space pass that softens the seam where one mesh cuts into another (a rock sunk into terrain, a trunk
// into the ground). A part opts in with `blend: { radius }`, the distance in metres over which its colour mixes with the
// colour of the surface it meets. Nothing here is in the core renderer: installMeshBlend adds a post stage and wraps
// render, and a frame with no `blend` part runs untouched, so a scene without it draws the same pixels.
//
// A pixel of a blend part looks at taps on a spiral within `radius` (in screen pixels at its distance) and counts the taps
// that show another part. A tap counts only when its surface point lies within a short reach of this pixel (a depth match:
// a silhouette against the sky or a far wall is skipped) and the surfaces do not run parallel (a normal discontinuity,
// rebuilt from the depth). The part IDs are written by the lit pass itself into a second colour attachment (the shader feature
// `meshBlend`, requested only when a part has `blend`), so there is no second draw; the depth is the depth texture of the frame,
// so the renderer needs `depth: true`. Cost: the extra attachment and a fullscreen pass that exits early outside blend parts.

import { registerShaderFeatureCode, shaderTransforms } from './shader-registry.js';
import { backendFor } from './glaze-backend.js';

export const MESH_BLEND_LIMITS = Object.freeze({ radius: Object.freeze([0.005, 2]) });
export const MESH_BLEND_TAPS = Object.freeze({ count: 24, angleStep: 2.39996323 });
const TAP_COUNT = MESH_BLEND_TAPS.count;
const MAXIMUM_PIXEL_RADIUS = 40;
const TABLE_WIDTH = 1024;

// The taps lie on a golden-angle spiral, denser near the pixel; a tap's weight falls off with its distance. The shader reads
// them from a constant table, so it computes no square root, sine or cosine per tap.
function spiralTaps() {
  return Array.from({ length: TAP_COUNT }, (unused, index) => {
    const fraction = Math.sqrt((index + 0.5) / TAP_COUNT);
    const angle = index * MESH_BLEND_TAPS.angleStep;
    return [Math.cos(angle) * fraction, Math.sin(angle) * fraction, 1 - fraction];
  });
}
const glslFloat = value => (Number.isInteger(value) ? `${value}.0` : String(Math.fround(value)));
const TAPS = spiralTaps();
const TAP_TABLE = TAPS.map(tap => `vec3(${tap.map(glslFloat).join(', ')})`).join(', ');
const TAP_TOTAL_WEIGHT = glslFloat(TAPS.reduce((sum, tap) => sum + tap[2], 0));

// gl-program.js is not imported on purpose: this module loads on demand (see line-art.js).
const fullscreenVertex = `#version 300 es
precision highp float;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Checks a part's `blend` option and returns it normalized: { radius } in metres. */
export function normalizeBlend(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('blend must be an object such as { "radius": 0.15 }.');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'radius') throw new RangeError(`blend has no field ${key}. Fix: use { "radius": metres }.`);
  }
  const [minimum, maximum] = MESH_BLEND_LIMITS.radius;
  if (typeof input.radius !== 'number' || !(input.radius >= minimum && input.radius <= maximum)) {
    throw new RangeError(`blend.radius must be a number of metres between ${minimum} and ${maximum}.`);
  }
  return { radius: input.radius };
}

/**
 * The radius each object ID mixes over, indexed by ID (slot 0 is the background): the parts the ID pass numbers in order.
 * A part's own `blend` wins; `radii` maps a part name to a radius for hosts whose parts do not carry the option (a recipe's nodes).
 */
export function blendRadiusTable(parts, radii = new Map()) {
  const table = new Float32Array(parts.length + 1);
  parts.forEach((part, index) => {
    table[index + 1] = part.blend?.radius ?? radii.get(part.name) ?? 0;
  });
  return table;
}

// What scene_capabilities reports: one line, since every byte there is paid on each call. The limits are in the docs.
export const MESH_BLEND_CAPABILITIES = 'nodes[].blend {radius: metres 0.005-2} softens seams; needs depth; docs/mesh-blend.md';

// tapOffsets holds each tap's offset at a radius of one pixel (x, y) and its weight (z). partAt needs no depth fetch: the ID
// attachment is cleared to zero each frame, which fails the checksum, so the background reads as no part. The multisample
// resolve averages the IDs of an edge pixel into a value that is no ID, so the alpha channel carries a checksum of the three
// ID bytes; a pixel that fails it is an edge pixel and reads as no part too.
export const blendFragment = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
uniform sampler2D sceneDepth;
uniform sampler2D partTexture;
uniform sampler2D radiusTexture;
uniform mat4 inverseViewProjection;
uniform vec3 eye;
uniform float pixelsPerMetre;
uniform float orthographic;
out vec4 outputColor;
const vec3 tapOffsets[${TAP_COUNT}] = vec3[${TAP_COUNT}](${TAP_TABLE});
ivec2 lastPixel;
int partAt(ivec2 pixel) {
  ivec2 clamped = clamp(pixel, ivec2(0), lastPixel);
  ivec4 bytes = ivec4(texelFetch(partTexture, clamped, 0) * 255.0 + 0.5);
  if (bytes.w == 0) return 0;
  if (bytes.w != (bytes.x * 3 + bytes.y * 5 + bytes.z * 11) % 251 + 1) return -1;
  return bytes.x + bytes.y * 256 + bytes.z * 65536;
}
float radiusOf(int part) {
  return part > 0 ? texelFetch(radiusTexture, ivec2(part & ${TABLE_WIDTH - 1}, part / ${TABLE_WIDTH}), 0).r : 0.0;
}
vec3 positionAt(ivec2 pixel) {
  ivec2 clamped = clamp(pixel, ivec2(0), lastPixel);
  float depth = texelFetch(sceneDepth, clamped, 0).r;
  vec4 ndc = vec4((vec2(clamped) + 0.5) / vec2(lastPixel + 1) * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = inverseViewProjection * ndc;
  return world.xyz / world.w;
}
// The shorter step of the two sides, skipping a zero step and staying on the same part where a neighbour crosses a seam.
vec3 shorterStep(vec3 first, vec3 second) {
  float firstLength = dot(first, first);
  float secondLength = dot(second, second);
  return (secondLength < 1e-14 || (firstLength >= 1e-14 && firstLength < secondLength)) ? first : second;
}
vec3 stepAlong(ivec2 pixel, ivec2 delta, vec3 center, int part) {
  vec3 forward = positionAt(pixel + delta) - center;
  vec3 backward = center - positionAt(pixel - delta);
  bool forwardSame = partAt(pixel + delta) == part;
  bool backwardSame = partAt(pixel - delta) == part;
  if (forwardSame != backwardSame) return forwardSame ? forward : backward;
  return shorterStep(forward, backward);
}
vec3 normalAt(ivec2 pixel, vec3 center, int part) {
  vec3 raw = cross(stepAlong(pixel, ivec2(1, 0), center, part), stepAlong(pixel, ivec2(0, 1), center, part));
  vec3 toEye = normalize(eye - center);
  if (dot(raw, raw) < 1e-20) return toEye;
  vec3 normal = normalize(raw);
  return dot(normal, toEye) < 0.0 ? -normal : normal;
}
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  lastPixel = textureSize(sourceTexture, 0) - 1;
  vec4 source = texelFetch(sourceTexture, pixel, 0);
  outputColor = source;
  int part = partAt(pixel);
  if (part == 0) return;
  ivec2 normalPixel = pixel;
  float radius = radiusOf(part);
  if (part < 0) {
    const ivec2 neighbours[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
    for (int side = 0; side < 4; side++) {
      ivec2 neighbour = pixel + neighbours[side];
      int candidate = partAt(neighbour);
      float candidateRadius = radiusOf(candidate);
      if (candidateRadius > radius) {
        part = candidate;
        radius = candidateRadius;
        normalPixel = neighbour;
      }
    }
  }
  if (radius <= 0.0) return;
  vec3 center = positionAt(normalPixel);
  float pixelRadius = radius * pixelsPerMetre / (orthographic > 0.5 ? 1.0 : length(center - eye));
  pixelRadius = clamp(pixelRadius, 1.0, ${MAXIMUM_PIXEL_RADIUS}.0);
  float reach = radius * 3.0;
  vec3 colorSum = vec3(0.0);
  float otherWeight = 0.0;
  ivec2 nearestTap = pixel;
  vec3 nearestPosition = center;
  int nearestPart = 0;
  bool found = false;
  for (int index = 0; index < ${TAP_COUNT}; index++) {
    vec3 tapOffset = tapOffsets[index];
    ivec2 tap = pixel + ivec2(round(tapOffset.xy * pixelRadius));
    int tapPart = partAt(tap);
    if (tapPart <= 0 || tapPart == part || radiusOf(tapPart) > 0.0) continue;
    vec3 tapPosition = positionAt(tap);
    if (distance(tapPosition, center) > reach) continue;
    if (!found) {
      nearestTap = tap;
      nearestPosition = tapPosition;
      nearestPart = tapPart;
    }
    found = true;
    colorSum += tapOffset.z * texelFetch(sourceTexture, clamp(tap, ivec2(0), lastPixel), 0).rgb;
    otherWeight += tapOffset.z;
  }
  if (!found) return;
  float creased = smoothstep(0.05, 0.4, 1.0 - dot(normalAt(normalPixel, center, part), normalAt(nearestTap, nearestPosition, nearestPart)));
  float amount = smoothstep(0.0, 0.5, otherWeight / ${TAP_TOTAL_WEIGHT}) * creased;
  outputColor.rgb = mix(source.rgb, colorSum / otherWeight, amount);
}`;

function createColorTarget(backend, width, height, floatColor, linear) {
  const target = backend.createFramebufferTarget({ width, height, hdr: Boolean(floatColor), linear, clamp: true });
  if (!target.complete) {
    backend.deleteFramebuffer(target.framebuffer);
    backend.deleteTexture(target.colorTexture);
    throw new Error('Mesh blend framebuffer allocation failed. Choose a lower quality preset.');
  }
  return { texture: target.colorTexture, framebuffer: target.framebuffer };
}

function sameTable(first, second) {
  return first?.length === second.length && first.every((value, index) => value === second[index]);
}

// The main opaque pass writes the part ID into a second colour attachment while this feature is on. The ID is the object ID of the
// render passes (the draw order of opaque instances, plus one) in three bytes, with a checksum byte (WebGL2 has no multisampled
// integer target, so the resolve averages; see partAt). Blended parts write 0: they draw over the opaque pixel without writing depth.
registerShaderFeatureCode('meshBlend', Object.freeze({
  declarations: 'layout(location = 1) out highp vec4 partIdentifier;\n',
  surfaceHook: `  uint partNumber = canopyShaded || TAG_WATER || alphaMode > 1.5 ? 0u : uint(renderPassObjectBase + instanceEmission.w + 1.0);
  uvec3 partBytes = uvec3(partNumber & 255u, (partNumber >> 8) & 255u, partNumber >> 16);
  partIdentifier = vec4(vec3(partBytes), float((partBytes.x * 3u + partBytes.y * 5u + partBytes.z * 11u) % 251u + 1u)) / 255.0;
`,
}));

// With two outputs the colour output needs its own location too, so a source that declares the ID output gets it spelled out.
shaderTransforms.push(source => (source.includes('partIdentifier') ? source.replace('\nout vec4 outputColor;', '\nlayout(location = 0) out vec4 outputColor;') : source));

function createPartTarget(backend, width, height) {
  const target = backend.createFramebufferTarget({ width, height, hdr: false, linear: false, clamp: false });
  if (!target.complete) {
    backend.deleteFramebuffer(target.framebuffer);
    backend.deleteTexture(target.colorTexture);
    throw new Error('Mesh blend framebuffer allocation failed. Choose a lower quality preset.');
  }
  return { texture: target.colorTexture, framebuffer: target.framebuffer };
}

/**
 * Adds the seam blend to a renderer. The renderer needs `depth: true`. A part opts in with `blend: { radius }`; a frame whose
 * parts have none draws exactly as before (no shader output, no attachment, no pass). With a blend part, the lit pass writes the
 * part IDs into an extra attachment of the multisample framebuffer and the stage resolves it, so there is no second draw.
 */
export function installMeshBlend(renderer) {
  if (renderer.meshBlend) return renderer;
  const backend = backendFor(renderer);
  const state = { active: false, table: null };
  let program = null;
  let uniforms = null;
  let partTarget = null;
  let partRenderbuffer = null;
  let attachedFramebuffer = null;
  let outputTarget = null;
  let radiusTexture = null;

  function opaqueBatches() {
    return renderer.batches.filter(batch => renderer.drawsInOpaqueLoop(batch));
  }

  function uploadTable(table) {
    if (sameTable(state.table, table)) return;
    state.table = table;
    const rows = Math.ceil(table.length / TABLE_WIDTH);
    const padded = new Float32Array(rows * TABLE_WIDTH);
    padded.set(table);
    if (radiusTexture) {
      backend.uploadDataTexture2D(radiusTexture, { width: TABLE_WIDTH, height: rows, format: 'r32f', data: padded, reallocate: true });
    } else {
      radiusTexture = backend.createDataTexture2D({ width: TABLE_WIDTH, height: rows, format: 'r32f', linear: false, clamp: false, data: padded });
    }
  }

  function releasePartAttachment() {
    if (partRenderbuffer) backend.deleteRenderbuffer(partRenderbuffer);
    if (partTarget) {
      backend.deleteTexture(partTarget.texture);
      backend.deleteFramebuffer(partTarget.framebuffer);
    }
    partRenderbuffer = null;
    partTarget = null;
    attachedFramebuffer = null;
  }

  // The multisample framebuffer is made again on every resize, so the attachment follows it.
  function attachPartBuffer() {
    const { canvas } = renderer;
    if (attachedFramebuffer === renderer.multisampleFramebuffer) return;
    releasePartAttachment();
    partRenderbuffer = backend.createMultisampleColorAttachment(renderer.multisampleFramebuffer, 1, renderer.multisampleSamples, canvas.width, canvas.height);
    partTarget = createPartTarget(backend, canvas.width, canvas.height);
    renderer.renderTargets.record('partId', { width: canvas.width, height: canvas.height, format: 'RGBA8', samples: renderer.multisampleSamples });
    renderer.renderTargets.record('partIdResolved', { width: canvas.width, height: canvas.height, format: 'RGBA8' });
    attachedFramebuffer = renderer.multisampleFramebuffer;
  }

  // The sky never writes the ID attachment and the frame's clear may leave it out, so it is cleared here: the background then
  // reads as no part.
  function clearParts() {
    backend.clearColorAttachment(renderer.multisampleFramebuffer, 1, [0, 0, 0, 0]);
  }

  // The resolve averages the samples of an edge pixel; the checksum byte in the shader finds those pixels.
  function resolveParts() {
    const { canvas } = renderer;
    backend.resolveColorAttachment(renderer.multisampleFramebuffer, partTarget.framebuffer, 1, canvas.width, canvas.height);
  }

  function apply(rendererInUse, frame, effects, sourceTexture) {
    if (!state.active) return null;
    if (!renderer.depthTexture) throw new Error('Mesh blend requires depth:true on the renderer.');
    const { canvas } = renderer;
    resolveParts();
    if (!program) {
      program = backend.compileProgram(fullscreenVertex, blendFragment);
      uniforms = Object.fromEntries(['sourceTexture', 'sceneDepth', 'partTexture', 'radiusTexture', 'inverseViewProjection', 'eye', 'pixelsPerMetre', 'orthographic']
        .map(name => [name, backend.uniformLocation(program, name)]));
    }
    outputTarget ??= createColorTarget(backend, canvas.width, canvas.height, renderer.hdr, true);
    backend.beginFullscreenPass(outputTarget.framebuffer, canvas.width, canvas.height, program);
    [[sourceTexture, 'sourceTexture'], [renderer.depthTexture, 'sceneDepth'], [partTarget.texture, 'partTexture'], [radiusTexture, 'radiusTexture']].forEach(([texture, name], unit) => {
      backend.bindTextureUnit(unit, texture);
      backend.uniform1i(uniforms[name], unit);
    });
    backend.uniformMatrix4fv(uniforms.inverseViewProjection, renderer.inverseViewProjection);
    backend.uniform3fv(uniforms.eye, frame.eye);
    backend.uniform1f(uniforms.pixelsPerMetre, renderer.projection[5] * canvas.height / 2);
    backend.uniform1f(uniforms.orthographic, renderer.projection[15] === 1 ? 1 : 0);
    backend.drawFullscreenTriangles();
    return outputTarget.texture;
  }

  function releaseTargets() {
    if (outputTarget) {
      backend.deleteTexture(outputTarget.texture);
      backend.deleteFramebuffer(outputTarget.framebuffer);
    }
    outputTarget = null;
    releasePartAttachment();
    renderer.renderTargets.release('partId', 'partIdResolved');
  }

  function dispose() {
    releaseTargets();
    if (program) backend.deleteProgram(program);
    if (radiusTexture) backend.deleteTexture(radiusTexture);
    program = null;
    radiusTexture = null;
    state.table = null;
  }

  // A batch the frustum culls draws its visible instances packed, which renumbers them within the batch's own ID range. When
  // every part of the batch has the same radius and the batch draws in one call (a single level), any ID in that range still
  // reads the right radius and the IDs stay distinct, so the batch keeps its culling. Any other batch with a blend part draws
  // all of its instances in order for the frame, so the part IDs the shader writes stay the table's indices.
  function needsStableIds(radii, batch) {
    if (!radii.some(radius => radius > 0)) return false;
    if ((batch.levelErrors?.length ?? 1) > 1) return true;
    return radii.some(radius => radius !== radii[0]);
  }

  function pinBlendBatches(table) {
    const pinned = [];
    let firstId = 1;
    for (const batch of opaqueBatches()) {
      if (batch.cullable && needsStableIds(table.subarray(firstId, firstId + batch.parts.length), batch)) {
        batch.cullable = false;
        pinned.push(batch);
      }
      firstId += batch.parts.length;
    }
    return pinned;
  }

  // A draw into an enabled draw buffer its program has no output for is an error, and only the main program writes the ID, so
  // the ID attachment is enabled while that program draws into the multisample framebuffer and off for the sky, liquid and others.
  backend.watchProgramAttachment(1, () => (state.active ? renderer.multisampleFramebuffer : null), programUsed => programUsed === renderer.program);

  renderer.postStages.push({ name: 'Mesh blend', apply, releaseTargets, dispose });
  const drawFrame = renderer.render.bind(renderer);
  renderer.render = frame => {
    state.active = false;
    let pinned = [];
    if (frame.pass === undefined && !frame.reflectionTarget && !renderer.benchmark) {
      const table = blendRadiusTable(opaqueBatches().flatMap(batch => batch.parts), renderer.meshBlend.radii);
      if (table.some(radius => radius > 0)) {
        uploadTable(table);
        renderer.requireFeatureNames(['meshBlend']);
        attachPartBuffer();
        clearParts();
        pinned = pinBlendBatches(table);
        state.active = true;
      }
    }
    try {
      drawFrame(frame);
    } finally {
      state.active = false;
      for (const batch of pinned) batch.cullable = true;
    }
  };
  renderer.meshBlend = { limits: MESH_BLEND_LIMITS, radii: new Map() };
  return renderer;
}
