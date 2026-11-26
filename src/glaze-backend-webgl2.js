// The WebGL2 implementation of the Glaze backend boundary (glaze-backend.js). Every method issues the calls that
// CrucibleRenderer made itself before the boundary existed, in the same order, so a frame does not change.

import { startProgram, finishProgram } from './gl-program.js';

const CONTEXT_OPTIONS_BASE = { antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance' };

export class WebGL2GlazeBackend {
  /** `context` is the raw WebGL2 context. Pass files not yet ported to the boundary still draw with it directly. */
  constructor(context) {
    this.name = 'webgl2';
    this.context = context;
  }

  /** Opens the WebGL2 context of a canvas. Throws when the browser has none. */
  static create(canvas, { transparent = false } = {}) {
    const context = canvas.getContext('webgl2', { ...CONTEXT_OPTIONS_BASE, alpha: Boolean(transparent) });
    if (!context) throw new Error('WebGL2 is unavailable. Enable hardware acceleration or use a supported browser.');
    return new WebGL2GlazeBackend(context);
  }

  createBuffer() {
    return this.context.createBuffer();
  }

  /** Fills a buffer. Kept apart from createBuffer so a caller owns the buffer before an upload that may throw. */
  uploadBuffer(target, buffer, data, usage = this.context.STATIC_DRAW) {
    this.context.bindBuffer(target, buffer);
    this.context.bufferData(target, data, usage);
  }

  deleteBuffer(buffer) {
    this.context.deleteBuffer(buffer);
  }

  /** True when the WebGL2 context runs on a known CPU software rasterizer (WARP / Basic Render Driver, SwiftShader, llvmpipe). */
  isSoftwareRenderer() {
    if (this.softwareRenderer === undefined) {
      const debugInfo = this.context.getExtension?.('WEBGL_debug_renderer_info');
      this.softwareRenderer = Boolean(debugInfo && /basic render driver|swiftshader|llvmpipe/i.test(this.context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)));
    }
    return this.softwareRenderer;
  }

  /** The largest MSAA sample count at most `requested` that the driver offers for both `colorFormat` and a 24-bit depth store (0 when none). */
  supportedSampleCount(colorFormat, requested) {
    const context = this.context;
    const limited = Math.min(requested, context.getParameter(context.MAX_SAMPLES));
    const colorCounts = Array.from(context.getInternalformatParameter(context.RENDERBUFFER, colorFormat, context.SAMPLES));
    const depthCounts = Array.from(context.getInternalformatParameter(context.RENDERBUFFER, context.DEPTH_COMPONENT24, context.SAMPLES));
    return Math.max(0, ...colorCounts.filter((count) => count <= limited && depthCounts.includes(count)));
  }

  /** A multisampled colour and 24-bit depth framebuffer. Returns { framebuffer, colorBuffer, depthBuffer }. */
  createMultisampleTarget({ width, height, samples, hdr }) {
    const context = this.context;
    const framebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    const colorBuffer = context.createRenderbuffer();
    context.bindRenderbuffer(context.RENDERBUFFER, colorBuffer);
    context.renderbufferStorageMultisample(context.RENDERBUFFER, samples, hdr ? context.RGBA16F : context.RGBA8, width, height);
    context.framebufferRenderbuffer(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.RENDERBUFFER, colorBuffer);
    const depthBuffer = context.createRenderbuffer();
    context.bindRenderbuffer(context.RENDERBUFFER, depthBuffer);
    context.renderbufferStorageMultisample(context.RENDERBUFFER, samples, context.DEPTH_COMPONENT24, width, height);
    context.framebufferRenderbuffer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.RENDERBUFFER, depthBuffer);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
      context.deleteFramebuffer(framebuffer);
      context.deleteRenderbuffer(colorBuffer);
      context.deleteRenderbuffer(depthBuffer);
      throw new Error('Multisample framebuffer allocation failed. Choose a lower quality preset.');
    }
    return { framebuffer, colorBuffer, depthBuffer };
  }

  /** A single-sample framebuffer with a linear colour texture and, with `depth`, a readable 24-bit depth texture. Returns { framebuffer, colorTexture, depthTexture }. */
  createResolveTarget({ width, height, hdr, depth }) {
    const context = this.context;
    const colorTexture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, colorTexture);
    context.texImage2D(context.TEXTURE_2D, 0, hdr ? context.RGBA16F : context.RGBA8, width, height, 0, context.RGBA, hdr ? context.HALF_FLOAT : context.UNSIGNED_BYTE, null);
    this.setClampedFiltering(context.LINEAR);
    const framebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, colorTexture, 0);
    let depthTexture = null;
    if (depth) {
      depthTexture = context.createTexture();
      context.bindTexture(context.TEXTURE_2D, depthTexture);
      context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT24, width, height, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
      this.setClampedFiltering(context.NEAREST);
      context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, depthTexture, 0);
    }
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
      context.deleteFramebuffer(framebuffer);
      context.deleteTexture(colorTexture);
      if (depthTexture) context.deleteTexture(depthTexture);
      throw new Error('Resolve framebuffer allocation failed. Choose a lower quality preset.');
    }
    return { framebuffer, colorTexture, depthTexture };
  }

  setClampedFiltering(filter) {
    const context = this.context;
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, filter);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, filter);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
  }

  deleteFramebuffer(framebuffer) {
    this.context.deleteFramebuffer(framebuffer);
  }

  deleteRenderbuffer(renderbuffer) {
    this.context.deleteRenderbuffer(renderbuffer);
  }

  deleteTexture(texture) {
    this.context.deleteTexture(texture);
  }

  /** Draws to the canvas again. */
  bindCanvasTarget() {
    this.context.bindFramebuffer(this.context.FRAMEBUFFER, null);
  }

  /** Resolves a multisample target into a single-sample one with the nearest filter; depth is copied too when `depth` is set. */
  resolveMultisample({ source, destination, width, height, depth }) {
    const context = this.context;
    context.bindFramebuffer(context.READ_FRAMEBUFFER, source);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, destination);
    context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.COLOR_BUFFER_BIT | (depth ? context.DEPTH_BUFFER_BIT : 0), context.NEAREST);
  }

  /** Starts building a program without waiting for the driver (see gl-program.js). */
  startProgram(vertexSource, fragmentSource) {
    return startProgram(this.context, vertexSource, fragmentSource);
  }

  finishProgram(pendingProgram) {
    return finishProgram(this.context, pendingProgram);
  }

  /** Draws `indexCount` 32-bit indices as triangles, `instanceCount` times, from index `firstIndex` of the bound vertex array. */
  drawIndexedInstanced(indexCount, instanceCount, firstIndex = 0) {
    this.context.drawElementsInstanced(this.context.TRIANGLES, indexCount, this.context.UNSIGNED_INT, firstIndex * 4, instanceCount);
  }

  /** Mirrored geometry reverses screen winding: clockwise triangles are then the front faces. */
  setFrontFaceClockwise(clockwise) {
    this.context.frontFace(clockwise ? this.context.CW : this.context.CCW);
  }

  /** Reads a rectangle of the bound framebuffer into `destination`. */
  readPixels(x, y, width, height, format, type, destination) {
    this.context.readPixels(x, y, width, height, format, type, destination);
  }
}
