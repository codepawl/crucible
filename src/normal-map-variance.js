// Specular anti-aliasing from a normal map (Toksvig with spreads measured when the mip chain is made, #3142).
// A mip level of a normal map averages texels whose normals disagree. The mean normal is shorter than 1 by the amount they disagree,
// and that shortfall widens the highlight so a pixel that covers many tilted normals does not catch a light once per pixel.
// The shader cannot read the shortfall from the stored mip: 8 bits and a renormalised direction lose it (measured on the Khronos
// NormalTangentTest, the sampled length barely shortens at the glint pixels). So a small GPU pass builds each level from the level
// above, keeps the renormalised mean direction in RGB and stores the spread in the alpha channel, which a normal map does not otherwise use.

/** Alpha of a normal map that was not baked (precompressed, updated in place): the shader falls back to the stored normal length. */
export const UNBAKED_ALPHA = 255;
/** Largest alpha a baked level can hold, so a baked texel never reads as unbaked. */
export const MAXIMUM_BAKED_ALPHA = 254;
/** The shader treats an alpha above this (0 to 1) as unbaked. */
export const UNBAKED_ALPHA_THRESHOLD = '0.999';
/** Gain of the baked spread in the specular fade, against the screen-space change of the normal. The glints sit on texels whose spread is tiny (about 1e-3); 100 takes the rim to the path tracer without dimming the interior highlight (#3142). */
export const NORMAL_SPREAD_GAIN = 100;

const VERTEX_SHADER = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

// One texel of the level above as the mean vector of the normals it stands for: its direction times (1 - spread). Alpha is the
// square root of the spread, and a level 0 texel has alpha 0, so the first pass averages plain unit normals.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform highp sampler2D source;
uniform ivec2 sourceSize;
out vec4 result;
vec3 meanVector(ivec2 texel) {
  vec4 stored = texelFetch(source, min(texel, sourceSize - 1), 0);
  vec3 direction = stored.xyz * 2.0 - 1.0;
  float directionLength = length(direction);
  direction = directionLength < 1e-6 ? vec3(0.0, 0.0, 1.0) : direction / directionLength;
  return direction * (1.0 - stored.w * stored.w);
}
void main() {
  ivec2 first = ivec2(gl_FragCoord.xy) * 2;
  vec3 mean = 0.25 * (meanVector(first) + meanVector(first + ivec2(1, 0)) + meanVector(first + ivec2(0, 1)) + meanVector(first + ivec2(1, 1)));
  float meanLength = length(mean);
  vec3 direction = meanLength < 1e-6 ? vec3(0.0, 0.0, 1.0) : mean / meanLength;
  float spread = clamp(1.0 - meanLength, 0.0, 1.0);
  result = vec4(direction * 0.5 + 0.5, min(round(255.0 * sqrt(spread)), ${MAXIMUM_BAKED_ALPHA}.0) / 255.0);
}
`;

const programsByContext = new WeakMap();

function compile(context, type, source) {
  const shader = context.createShader(type);
  context.shaderSource(shader, source);
  context.compileShader(shader);
  if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) throw new Error(`The normal map spread shader did not compile: ${context.getShaderInfoLog(shader)}`);
  return shader;
}

function spreadProgram(context) {
  if (programsByContext.has(context)) return programsByContext.get(context);
  const program = context.createProgram();
  const vertex = compile(context, context.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(context, context.FRAGMENT_SHADER, FRAGMENT_SHADER);
  context.attachShader(program, vertex);
  context.attachShader(program, fragment);
  context.linkProgram(program);
  context.deleteShader(vertex);
  context.deleteShader(fragment);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error(`The normal map spread program did not link: ${context.getProgramInfoLog(program)}`);
  const entry = { program, sourceLocation: context.getUniformLocation(program, 'source'), sizeLocation: context.getUniformLocation(program, 'sourceSize'), vertexArray: context.createVertexArray() };
  programsByContext.set(context, entry);
  return entry;
}

const TOGGLED_STATES = ['SCISSOR_TEST', 'BLEND', 'DEPTH_TEST', 'CULL_FACE', 'STENCIL_TEST', 'DITHER'];

// What the pass changes, put back by the returned function: the renderer binds its own program, vertex array and targets before every draw, but a texture is
// created in the middle of a frame and the pass must not leave a target or a mask behind.
function saveState(context) {
  const framebuffer = context.getParameter(context.FRAMEBUFFER_BINDING);
  const viewport = context.getParameter(context.VIEWPORT);
  const program = context.getParameter(context.CURRENT_PROGRAM);
  const vertexArray = context.getParameter(context.VERTEX_ARRAY_BINDING);
  const colorMask = context.getParameter(context.COLOR_WRITEMASK);
  const enabled = TOGGLED_STATES.map(name => context.isEnabled(context[name]));
  return () => {
    TOGGLED_STATES.forEach((name, index) => (enabled[index] ? context.enable(context[name]) : context.disable(context[name])));
    context.colorMask(...colorMask);
    context.bindVertexArray(vertexArray);
    context.useProgram(context.isProgram(program) ? program : null);
    context.viewport(...viewport);
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
  };
}

/**
 * Replaces the mip chain of the linear RGBA8 normal map bound to TEXTURE_2D (level 0 uploaded) with levels whose alpha holds the spread
 * of the unit normals each texel averages, sqrt-coded and at most 254 (level 0 gets alpha 0), and whose RGB is their renormalised mean.
 * Each level is drawn from the one above into a scratch texture the size of level 1 and copied into the map's own storage, so the
 * map takes no extra memory once the pass is done and no pixel is read back to the CPU: it takes milliseconds where a CPU pass took
 * 0.3 s on a 2048 map. An odd edge clamps, as a driver's own chain does. Deterministic on one device.
 * Returns false and leaves the levels for the caller's generateMipmap (the shader then falls back to the stored length) when the
 * texture cannot be drawn into.
 */
export function bakeNormalMapVariance(context, texture, width, height) {
  const restoreState = saveState(context);
  const framebuffer = context.createFramebuffer();
  const scratch = context.createTexture();
  let baked = false;
  try {
    const { program, sourceLocation, sizeLocation, vertexArray } = spreadProgram(context);
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) return false;
    TOGGLED_STATES.forEach(name => context.disable(context[name]));
    context.colorMask(false, false, false, true);
    context.clearColor(0, 0, 0, 0);
    context.clear(context.COLOR_BUFFER_BIT);
    context.colorMask(true, true, true, true);
    const unit = context.getParameter(context.ACTIVE_TEXTURE);
    const firstWidth = Math.max(1, width >> 1);
    const firstHeight = Math.max(1, height >> 1);
    context.bindTexture(context.TEXTURE_2D, scratch);
    context.texImage2D(context.TEXTURE_2D, 0, context.RGBA8, firstWidth, firstHeight, 0, context.RGBA, context.UNSIGNED_BYTE, null);
    context.bindTexture(context.TEXTURE_2D, texture);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, scratch, 0);
    context.useProgram(program);
    context.bindVertexArray(vertexArray);
    context.uniform1i(sourceLocation, unit - context.TEXTURE0);
    let sourceWidth = width;
    let sourceHeight = height;
    for (let level = 1; sourceWidth > 1 || sourceHeight > 1; level++) {
      const levelWidth = Math.max(1, sourceWidth >> 1);
      const levelHeight = Math.max(1, sourceHeight >> 1);
      // The map is only sampled here (the target is the scratch texture), so reading level - 1 alone is allowed.
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_BASE_LEVEL, level - 1);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAX_LEVEL, level - 1);
      context.viewport(0, 0, levelWidth, levelHeight);
      context.uniform2i(sizeLocation, sourceWidth, sourceHeight);
      context.drawArrays(context.TRIANGLES, 0, 3);
      context.copyTexImage2D(context.TEXTURE_2D, level, context.RGBA8, 0, 0, levelWidth, levelHeight, 0);
      sourceWidth = levelWidth;
      sourceHeight = levelHeight;
    }
    baked = true;
  } finally {
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_BASE_LEVEL, 0);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAX_LEVEL, 1000);
    context.deleteFramebuffer(framebuffer);
    context.deleteTexture(scratch);
    restoreState();
  }
  return baked;
}
