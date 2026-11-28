// A half-float colour target for the frame's last pass, and a float readback of any framebuffer, so a render job can
// write 16-bit PNG and EXR files from more than the 8 bits the canvas keeps. Needs WebGL 2 and EXT_color_buffer_float.

import { asGlazeBackend, backendFor } from './glaze-backend.js';

const FLOAT_EXTENSION = 'EXT_color_buffer_float';

/** Accepts either a GlazeBackend or a raw WebGL2 context so standalone callers keep working. */
export function asBackend(contextOrBackend) {
  return asGlazeBackend(contextOrBackend);
}

export function requireFloatTargets(contextOrBackend) {
  if (!asBackend(contextOrBackend).extension(FLOAT_EXTENSION)) {
    throw new Error('16-bit PNG and EXR output need EXT_color_buffer_float, which this browser or GPU does not offer. Use format png.');
  }
}

/** One RGBA16F framebuffer of the given size. The frame's post pass draws into it instead of the canvas. */
export function createFloatOutput(contextOrBackend, width, height) {
  const backend = asBackend(contextOrBackend);
  requireFloatTargets(backend);
  const target = backend.createFramebufferTarget({ width, height, hdr: true, unbind: true });
  if (!target.complete) {
    backend.deleteFramebuffer(target.framebuffer);
    backend.deleteTexture(target.colorTexture);
    throw new Error('The float output framebuffer could not be allocated. Use format png.');
  }
  return {
    width,
    height,
    framebuffer: target.framebuffer,
    texture: target.colorTexture,
    dispose() {
      backend.deleteFramebuffer(target.framebuffer);
      backend.deleteTexture(target.colorTexture);
    },
  };
}

/**
 * Reads a region of a framebuffer as RGBA float32, rows bottom to top as WebGL stores them. `region` counts pixels
 * from the top left, like an image, and defaults to the whole frame.
 */
export function readFloatPixels(contextOrBackend, framebuffer, frameWidth, frameHeight, region = { x: 0, y: 0, width: frameWidth, height: frameHeight }) {
  if (!Number.isInteger(frameWidth) || frameWidth < 1 || !Number.isInteger(frameHeight) || frameHeight < 1) {
    throw new RangeError('Frame size must be positive integers.');
  }
  if (!region || typeof region !== 'object' || ![region.x, region.y, region.width, region.height].every(Number.isInteger)) {
    throw new RangeError('The region must use integer x, y, width and height.');
  }
  if (region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 || region.x + region.width > frameWidth || region.y + region.height > frameHeight) {
    throw new RangeError('The region lies outside the rendered frame.');
  }
  const pixels = new Float32Array(region.width * region.height * 4);
  asBackend(contextOrBackend).readFloatPixels(framebuffer, region.x, frameHeight - region.y - region.height, region.width, region.height, pixels);
  return pixels;
}

/** A target kept on the session record under `key` and rebuilt when the renderer or the size changes. */
function cachedOutput(record, key, canvas) {
  const cached = record[key];
  if (cached && cached.renderer === record.renderer && cached.output.width === canvas.width && cached.output.height === canvas.height) return cached.output;
  cached?.output.dispose();
  const output = createFloatOutput(backendFor(record.renderer), canvas.width, canvas.height);
  record[key] = { renderer: record.renderer, output };
  return output;
}

/** The target a floatOutput frame draws into. */
export function outputFor(record, canvas) {
  return cachedOutput(record, 'floatOutput', canvas);
}

/**
 * The float image of the last frame or pass as one framebuffer of the canvas size. On a pixel grid the frame sits in the
 * padded-grid corner of its target, so it is cropped, shifted and enlarged into a second target like the PNG present.
 */
function readableOutput(record, canvas, source) {
  const grid = record.renderer.pixelGrid;
  const sourceTarget = source === 'pass' ? { texture: record.renderer.passSupport.texture, framebuffer: record.renderer.passSupport.framebuffer } : outputFor(record, canvas);
  if (!grid?.active) return sourceTarget.framebuffer;
  const enlarged = cachedOutput(record, 'gridFloatOutput', canvas);
  grid.blitToFloat({ texture: sourceTarget.texture, framebuffer: enlarged.framebuffer, width: canvas.width, height: canvas.height, source });
  return enlarged.framebuffer;
}

/** The last frame, or its pass, as base64 RGBA float32 (rows bottom to top) cropped to `region`. */
export function readFrame(record, canvas, source, region) {
  const framebuffer = readableOutput(record, canvas, source);
  const pixels = readFloatPixels(backendFor(record.renderer), framebuffer, canvas.width, canvas.height, region);
  const bytes = new Uint8Array(pixels.buffer);
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { width: region?.width ?? canvas.width, height: region?.height ?? canvas.height, data: btoa(text) };
}
