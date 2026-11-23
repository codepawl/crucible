import { compileProgram, fullscreenVertex } from './gl-program.js';

/** Largest side of a pixel grid and of its outer pad, in grid pixels. */
export const MAXIMUM_PIXEL_GRID_SIDE = 4096;
export const MAXIMUM_PIXEL_GRID_PAD = 32;
export const DEFAULT_PIXEL_GRID_PAD = 2;

/**
 * Checks the recipe field pixelGrid: `{ width, height, pad }` in grid pixels, or null for the normal full-resolution render.
 * `pad` (default 2) is the extra ring of pixels rendered outside the visible grid so a sub-pixel camera shift always has
 * something to show at the edge. Returns the grid with every field filled in.
 */
export function normalizePixelGrid(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`pixelGrid must be an object like {"width":256,"height":144,"pad":2} or null, got ${JSON.stringify(input)}.`);
  }
  const unknownKeys = Object.keys(input).filter(key => !['width', 'height', 'pad'].includes(key));
  if (unknownKeys.length > 0) throw new TypeError(`pixelGrid has no field "${unknownKeys[0]}". Fix: pass only width, height and pad.`);
  const { width, height, pad = DEFAULT_PIXEL_GRID_PAD } = input;
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(value) || value < 1 || value > MAXIMUM_PIXEL_GRID_SIDE) {
      throw new RangeError(`pixelGrid.${name} must be a whole number of pixels from 1 to ${MAXIMUM_PIXEL_GRID_SIDE}, got ${JSON.stringify(value)}. Fix: pass the low-resolution size you want, for example 256 by 144.`);
    }
  }
  if (!Number.isInteger(pad) || pad < 0 || pad > MAXIMUM_PIXEL_GRID_PAD) {
    throw new RangeError(`pixelGrid.pad must be a whole number of pixels from 0 to ${MAXIMUM_PIXEL_GRID_PAD}, got ${JSON.stringify(pad)}. Fix: 1 or 2 covers a half-pixel camera shift.`);
  }
  return { width, height, pad };
}

/** The size of the internal render target: the visible grid plus the pad on every side. */
export function paddedGridSize(grid) {
  return { width: grid.width + 2 * grid.pad, height: grid.height + 2 * grid.pad };
}

function crossProduct(first, second) {
  return [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
}

function normalized(vector) {
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map(component => component / length);
}

function dotProduct(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

/**
 * Prepares one camera frame for the padded grid. An orthographic frame has its eye and target moved onto whole texels of the
 * view plane (a texel is orthographicHeight / grid height) and its height widened to cover the pad; what the snap moved is
 * returned as `remainder`, in texels along the camera's right and up, for the final blit to put back, and the whole texel the
 * eye landed on as `texel`. Any other frame is returned unchanged with a zero remainder and texel.
 */
export function snapFrameToGrid(frame, grid) {
  if (frame.projection !== 'orthographic' || frame.reflectionTarget) return { frame, remainder: [0, 0], texel: [0, 0] };
  const visibleHeight = frame.orthographicHeight ?? frame.orthoScale ?? 4;
  if (!Number.isFinite(visibleHeight) || visibleHeight <= 0) throw new RangeError('Orthographic height must be positive and finite');
  const eye = frame.eye;
  const target = frame.target ?? [0, 1.2, 0];
  const forward = normalized([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  const right = normalized(crossProduct(forward, frame.up ?? [0, 1, 0]));
  const up = crossProduct(right, forward);
  const texelSize = visibleHeight / grid.height;
  const rightOffset = dotProduct(eye, right);
  const upOffset = dotProduct(eye, up);
  const snappedRight = Math.round(rightOffset / texelSize) * texelSize;
  const snappedUp = Math.round(upOffset / texelSize) * texelSize;
  const moveRight = snappedRight - rightOffset;
  const moveUp = snappedUp - upOffset;
  const move = [0, 1, 2].map(axis => right[axis] * moveRight + up[axis] * moveUp);
  const padded = paddedGridSize(grid);
  const snapped = {
    ...frame,
    eye: eye.map((value, axis) => value + move[axis]),
    target: target.map((value, axis) => value + move[axis]),
    orthographicHeight: visibleHeight * padded.height / grid.height,
  };
  delete snapped.orthoScale;
  return { frame: snapped, remainder: [-moveRight / texelSize, -moveUp / texelSize], texel: [Math.round(rightOffset / texelSize), Math.round(upOffset / texelSize)] };
}

/**
 * Where blocks of `blockSize` grid pixels start, so they stay on the same geometry while the snapped camera moves: a block edge
 * sits at every grid pixel p with (p + origin) a multiple of blockSize. `texel` is the eye's whole texel from snapFrameToGrid.
 */
export function blockLatticeOrigin(texel, blockSize) {
  return texel.map(index => ((index % blockSize) + blockSize) % blockSize);
}

// Reads the padded grid with texelFetch, so no filtering can blend two grid pixels: each output pixel takes the one grid pixel under
// its centre, after the sub-pixel remainder moves the window back to where the unsnapped camera would have put it.
const blitFragment = `#version 300 es
precision highp float;
precision highp int;
in vec2 textureCoordinate;
uniform sampler2D sourceTexture;
uniform vec2 gridSize;
uniform float pad;
uniform vec2 remainder;
out vec4 outputColor;
void main() {
  vec2 sourceTexel = vec2(pad) + textureCoordinate * gridSize + remainder;
  ivec2 size = textureSize(sourceTexture, 0);
  ivec2 paddedSize = min(size, ivec2(gridSize + 2.0 * pad));
  outputColor = texelFetch(sourceTexture, clamp(ivec2(floor(sourceTexel)), ivec2(0), paddedSize - 1), 0);
}`;

/** Maps the size and position the rest of the renderer reads from canvas onto the internal grid, and passes everything else to the real canvas. */
function createRenderSurface(realCanvas, state) {
  return new Proxy(realCanvas, {
    get(target, property) {
      if (property === 'width' || property === 'clientWidth') return state.size.width;
      if (property === 'height' || property === 'clientHeight') return state.size.height;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === 'width' || property === 'height') return true;
      return Reflect.set(target, property, value, target);
    },
  });
}

/**
 * Adds the pixel-art grid to a renderer. `renderer.pixelGrid.set({ width, height, pad })` makes the main pass, render passes, line
 * art and user passes run on a (width + 2 pad) by (height + 2 pad) target with one sample, snaps an orthographic camera to whole
 * texels, and finishes with a nearest-neighbour blit of the visible grid onto the canvas, moved by the part of a texel the snap
 * took. `set(null)` restores the normal render. Install it last, after user passes, so the blit is the final step of a frame.
 */
export function installPixelGrid(renderer) {
  if (renderer.pixelGrid) return renderer;
  const realCanvas = renderer.canvas;
  const state = { grid: null, size: { width: 1, height: 1 }, remainder: [0, 0], passRemainder: [0, 0], texel: [0, 0], saved: null, blit: null, texture: null, textureSize: null };
  let surface = null;

  function releaseBlitTexture() {
    if (state.texture) renderer.context.deleteTexture(state.texture);
    state.texture = null;
    state.textureSize = null;
  }

  function blitTexture(width, height) {
    const context = renderer.context;
    if (state.texture && state.textureSize.width === width && state.textureSize.height === height) return state.texture;
    releaseBlitTexture();
    const withAlpha = Boolean(context.getContextAttributes()?.alpha);
    state.texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, state.texture);
    context.texImage2D(context.TEXTURE_2D, 0, withAlpha ? context.RGBA8 : context.RGB8, width, height, 0, withAlpha ? context.RGBA : context.RGB, context.UNSIGNED_BYTE, null);
    for (const parameter of [context.TEXTURE_MIN_FILTER, context.TEXTURE_MAG_FILTER]) context.texParameteri(context.TEXTURE_2D, parameter, context.NEAREST);
    state.textureSize = { width, height };
    return state.texture;
  }

  // Draws the padded grid in the lower-left corner of `sourceTexture` across `outputWidth` by `outputHeight` pixels of
  // `destinationFramebuffer` (null is the canvas), cropped to the visible grid and moved by `remainder`.
  function drawBlit(sourceTexture, destinationFramebuffer, outputWidth, outputHeight, remainder) {
    const context = renderer.context;
    if (!state.blit) {
      const program = compileProgram(context, fullscreenVertex, blitFragment);
      state.blit = { program, uniforms: Object.fromEntries(['sourceTexture', 'gridSize', 'pad', 'remainder'].map(name => [name, context.getUniformLocation(program, name)])) };
    }
    context.bindFramebuffer(context.FRAMEBUFFER, destinationFramebuffer);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.disable(context.BLEND);
    context.bindVertexArray(null);
    context.viewport(0, 0, outputWidth, outputHeight);
    context.useProgram(state.blit.program);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, sourceTexture);
    context.uniform1i(state.blit.uniforms.sourceTexture, 0);
    context.uniform2f(state.blit.uniforms.gridSize, state.grid.width, state.grid.height);
    context.uniform1f(state.blit.uniforms.pad, state.grid.pad);
    context.uniform2f(state.blit.uniforms.remainder, remainder[0], remainder[1]);
    context.drawArrays(context.TRIANGLES, 0, 3);
  }

  // The frame is on the canvas's lower-left corner at the grid size; copy it out and draw it back across the whole canvas.
  function presentGrid(remainder = state.remainder) {
    const context = renderer.context;
    const { width, height } = state.size;
    context.bindFramebuffer(context.FRAMEBUFFER, null);
    context.bindTexture(context.TEXTURE_2D, blitTexture(width, height));
    context.copyTexSubImage2D(context.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
    drawBlit(state.texture, null, realCanvas.width, realCanvas.height, remainder);
  }

  const resize = renderer.resize;
  renderer.resize = function resizeForPixelGrid() {
    if (!state.grid) return resize.call(this);
    const outputWidth = Math.max(1, Math.round(realCanvas.clientWidth * state.saved.pixelRatio));
    const outputHeight = Math.max(1, Math.round(realCanvas.clientHeight * state.saved.pixelRatio));
    if (outputWidth < state.size.width || outputHeight < state.size.height) {
      throw new RangeError(`The canvas is ${outputWidth}x${outputHeight} but the pixel grid with its pad needs ${state.size.width}x${state.size.height}. Fix: make the canvas at least that large, or lower pixelGrid width, height or pad.`);
    }
    resize.call(this);
    if (realCanvas.width !== outputWidth) realCanvas.width = outputWidth;
    if (realCanvas.height !== outputHeight) realCanvas.height = outputHeight;
  };

  const render = renderer.render;
  renderer.render = function renderOnPixelGrid(frame, ...rest) {
    if (!state.grid) return render.call(this, frame, ...rest);
    const snapped = snapFrameToGrid(frame, state.grid);
    if (frame.pass === undefined && !frame.reflectionTarget) {
      state.remainder = snapped.remainder;
      state.texel = snapped.texel;
    }
    const result = render.call(this, snapped.frame, ...rest);
    // A render pass (depth, normal, object ID) is copied to the canvas at the grid size too; it gets the same crop and shift as the
    // lit frame, so an exported pass lines up with it pixel for pixel.
    if (frame.pass !== undefined && !frame.reflectionTarget && !frame.emissionMaskPass && !this.benchmark) {
      state.passRemainder = snapped.remainder;
      presentGrid(snapped.remainder);
    }
    return result;
  };

  const resolveFrame = renderer.resolveFrame;
  renderer.resolveFrame = function resolveFrameOnPixelGrid(frame, ...rest) {
    resolveFrame.call(this, frame, ...rest);
    if (state.grid && !this.benchmark && !frame.outputFramebuffer && frame.pass === undefined && !frame.reflectionTarget) presentGrid();
  };

  renderer.postStages?.push({ name: 'Pixel grid', apply: () => null, releaseTargets: releaseBlitTexture, dispose: releaseBlitTexture });

  function applyGrid(grid) {
    if (grid && !state.saved) {
      state.saved = { pixelRatio: renderer.pixelRatio, baseSamples: renderer.baseSamples, denseSamples: renderer.denseSamples };
    }
    if (!grid && state.saved) {
      Object.assign(renderer, { pixelRatio: state.saved.pixelRatio, baseSamples: state.saved.baseSamples, denseSamples: state.saved.denseSamples });
    }
    state.grid = grid;
    if (grid) {
      // One sample and a pixel ratio of 1: the grid is the render size, and nothing in it may be smoothed.
      state.size = paddedGridSize(grid);
      Object.assign(renderer, { pixelRatio: 1, baseSamples: 1, denseSamples: null });
      renderer.multisampleSamples = renderer.backend.supportedSampleCount(renderer.hdr ? renderer.context.RGBA16F : renderer.context.RGBA8, 1);
      renderer.capabilities.samples = renderer.multisampleSamples;
      surface ??= createRenderSurface(realCanvas, state);
      renderer.canvas = surface;
    } else {
      renderer.canvas = realCanvas;
      state.saved = null;
      if (!renderer.benchmark) renderer.multisampleSamples = renderer.chooseMultisampleSamples(renderer.densityParts ?? renderer.sceneParts);
      renderer.capabilities.samples = renderer.multisampleSamples;
    }
    renderer.resize();
    if (!renderer.benchmark) renderer.allocateFrameTargets(renderer.canvas.width, renderer.canvas.height);
  }

  renderer.pixelGrid = {
    /** Turns the grid on with `{ width, height, pad }`, or off with null. A grid equal to the current one changes nothing. */
    set(input) {
      const grid = normalizePixelGrid(input);
      if (JSON.stringify(grid) === JSON.stringify(state.grid)) return;
      applyGrid(grid);
    },
    /**
     * Float readback of the last lit frame or pass: draws the padded grid in the corner of `texture` (a half-float texture of
     * any size at least the padded grid) into `framebuffer` of `width` by `height`, with the crop, shift and nearest
     * enlargement of the PNG present, so an EXR matches the PNG pixel for pixel.
     */
    blitToFloat({ texture, framebuffer, width, height, source }) {
      if (!state.grid) throw new Error('blitToFloat needs a pixel grid. Fix: call it only while renderer.pixelGrid.active is true.');
      drawBlit(texture, framebuffer, width, height, source === 'pass' ? state.passRemainder : state.remainder);
    },
    get active() {
      return state.grid !== null;
    },
    get grid() {
      return state.grid ? { ...state.grid } : null;
    },
    /** The block lattice of `stylize.pixelate` and of post passes below scale 1 for this frame; [0, 0] while the grid is off. */
    latticeOrigin(blockSize) {
      return state.grid ? blockLatticeOrigin(state.texel, blockSize) : [0, 0];
    },
  };
  return renderer;
}
