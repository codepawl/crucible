// The WebGL2 implementation of the Glaze backend boundary (glaze-backend.js). Every method issues the calls that
// CrucibleRenderer made itself before the boundary existed, in the same order, so a frame does not change.

import { startProgram, finishProgram, compileProgram } from './gl-program.js';

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

  /** Returns the WebGL2 extension object for `name`, or null when unavailable. */
  extension(name) {
    return this.context.getExtension?.(name) ?? null;
  }

  /** True when the WebGL2 context runs on a known CPU software rasterizer (WARP / Basic Render Driver, SwiftShader, llvmpipe). */
  isSoftwareRenderer() {
    if (this.softwareRenderer === undefined) {
      const debugInfo = this.extension('WEBGL_debug_renderer_info');
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

  createTexture2D(internalFormat, width, height, format, type, filter, clamp = false) {
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texImage2D(context.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
    if (clamp) {
      this.setClampedFiltering(filter);
    } else {
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, filter);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, filter);
    }
    return texture;
  }

  /** A single-sample framebuffer with a linear colour texture and, with `depth`, a readable 24-bit depth texture. Returns { framebuffer, colorTexture, depthTexture }. */
  createResolveTarget({ width, height, hdr, depth }) {
    const target = this.createFramebufferTarget({ width, height, hdr, depth, depthAsTexture: true, colorFilter: this.context.LINEAR, clamp: true });
    if (!target.complete) {
      this.deleteFramebuffer(target.framebuffer);
      this.deleteTexture(target.colorTexture);
      if (target.depthTexture) this.deleteTexture(target.depthTexture);
      throw new Error('Resolve framebuffer allocation failed. Choose a lower quality preset.');
    }
    return { framebuffer: target.framebuffer, colorTexture: target.colorTexture, depthTexture: target.depthTexture };
  }

  /** A single-sample framebuffer with optional colour texture (`rgba8` / `rgba16f`) and depth store (`depth24` / `depth32f`). */
  createFramebufferTarget({ width, height, color = true, hdr = false, depth = false, floatDepth = false, depthAsTexture = false, colorFilter = this.context.NEAREST, clamp = false, unbind = false }) {
    const context = this.context;
    const colorTexture = color ? this.createTexture2D(
      hdr ? context.RGBA16F : context.RGBA8,
      width,
      height,
      context.RGBA,
      hdr ? context.HALF_FLOAT : context.UNSIGNED_BYTE,
      colorFilter,
      clamp,
    ) : null;
    const framebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    if (colorTexture) context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, colorTexture, 0);
    let depthTexture = null;
    let depthRenderbuffer = null;
    if (depth && depthAsTexture) {
      depthTexture = this.createTexture2D(
        floatDepth ? context.DEPTH_COMPONENT32F : context.DEPTH_COMPONENT24,
        width,
        height,
        context.DEPTH_COMPONENT,
        floatDepth ? context.FLOAT : context.UNSIGNED_INT,
        context.NEAREST,
        clamp,
      );
      context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, depthTexture, 0);
    } else if (depth) {
      depthRenderbuffer = context.createRenderbuffer();
      context.bindRenderbuffer(context.RENDERBUFFER, depthRenderbuffer);
      context.renderbufferStorage(context.RENDERBUFFER, floatDepth ? context.DEPTH_COMPONENT32F : context.DEPTH_COMPONENT24, width, height);
      context.framebufferRenderbuffer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.RENDERBUFFER, depthRenderbuffer);
    }
    const complete = context.checkFramebufferStatus(context.FRAMEBUFFER) === context.FRAMEBUFFER_COMPLETE;
    if (unbind) this.bindCanvasTarget();
    return { framebuffer, colorTexture, depthTexture, depthRenderbuffer, complete };
  }

  /** Respecifies existing depth stores as 32-bit float and returns whether every framebuffer stays complete. */
  setFloatDepthTargets({ multisampleDepth, multisampleSamples, depthTexture, framebuffers, width, height }) {
    const context = this.context;
    context.bindRenderbuffer(context.RENDERBUFFER, multisampleDepth);
    context.renderbufferStorageMultisample(context.RENDERBUFFER, multisampleSamples, context.DEPTH_COMPONENT32F, width, height);
    if (depthTexture) {
      context.bindTexture(context.TEXTURE_2D, depthTexture);
      context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT32F, width, height, 0, context.DEPTH_COMPONENT, context.FLOAT, null);
    }
    const complete = framebuffers.every((framebuffer) => {
      context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
      return context.checkFramebufferStatus(context.FRAMEBUFFER) === context.FRAMEBUFFER_COMPLETE;
    });
    this.bindCanvasTarget();
    return complete;
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

  blitTarget(source, destination, width, height, mask) {
    const context = this.context;
    context.bindFramebuffer(context.READ_FRAMEBUFFER, source);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, destination);
    context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, mask, context.NEAREST);
  }

  /** Resolves a multisample target into a single-sample one with the nearest filter; depth is copied too when `depth` is set. */
  resolveMultisample({ source, destination, width, height, depth }) {
    const context = this.context;
    this.blitTarget(source, destination, width, height, context.COLOR_BUFFER_BIT | (depth ? context.DEPTH_BUFFER_BIT : 0));
  }

  /** Copies the depth attachment from `source` to `destination` using nearest filtering. */
  copyDepth({ source, destination, width, height }) {
    this.blitTarget(source, destination, width, height, this.context.DEPTH_BUFFER_BIT);
  }

  /** Starts building a program without waiting for the driver (see gl-program.js). */
  startProgram(vertexSource, fragmentSource) {
    return startProgram(this.context, vertexSource, fragmentSource);
  }

  finishProgram(pendingProgram) {
    return finishProgram(this.context, pendingProgram);
  }

  compileProgram(vertexSource, fragmentSource) {
    return compileProgram(this.context, vertexSource, fragmentSource);
  }

  deleteProgram(program) {
    this.context.deleteProgram(program);
  }

  useProgram(program) {
    this.context.useProgram(program);
  }

  uniformLocation(program, name) {
    return this.context.getUniformLocation(program, name);
  }

  uniform1f(location, value) {
    this.context.uniform1f(location, value);
  }

  uniform1fv(location, values) {
    this.context.uniform1fv(location, values);
  }

  uniform3f(location, first, second, third) {
    this.context.uniform3f(location, first, second, third);
  }

  uniform3fv(location, values) {
    this.context.uniform3fv(location, values);
  }

  uniform4fv(location, values) {
    this.context.uniform4fv(location, values);
  }

  uniformMatrix4fv(location, values) {
    this.context.uniformMatrix4fv(location, false, values);
  }

  /** Draws a full-viewport triangle sampling `texture` on unit 0 into `framebuffer` (null for the canvas). */
  drawFullscreenTexture({ framebuffer = null, width, height, program, textureUniform, texture, depthWriteOnly = false }) {
    const context = this.context;
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.viewport(0, 0, width, height);
    context.useProgram(program);
    context.activeTexture(context.TEXTURE0);
    context.bindTexture(context.TEXTURE_2D, texture);
    context.uniform1i(textureUniform, 0);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    if (depthWriteOnly) {
      context.enable(context.DEPTH_TEST);
      context.depthFunc(context.ALWAYS);
      context.colorMask(false, false, false, false);
    } else {
      context.disable(context.DEPTH_TEST);
    }
    context.drawArrays(context.TRIANGLES, 0, 3);
    if (depthWriteOnly) {
      context.colorMask(true, true, true, true);
      context.depthFunc(context.LESS);
      context.disable(context.DEPTH_TEST);
    }
  }

  /** Switches clip-space depth between 0..1 (reversed-Z, GREATER) and -1..1 (standard, LESS). */
  setClipControlZeroToOne(extension, enabled) {
    const context = this.context;
    extension.clipControlEXT(extension.LOWER_LEFT_EXT, enabled ? extension.ZERO_TO_ONE_EXT : extension.NEGATIVE_ONE_TO_ONE_EXT);
    context.depthFunc(enabled ? context.GREATER : context.LESS);
  }

  /** Clears the depth buffer to `depth` and restores the default clear depth of 1. */
  clearDepthBuffer(depth) {
    const context = this.context;
    context.clearDepth(depth);
    context.clear(context.DEPTH_BUFFER_BIT);
    context.clearDepth(1);
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

  /** Reads a rectangle of `framebuffer` as RGBA float32 into `destination`. */
  readFloatPixels(framebuffer, x, y, width, height, destination) {
    const context = this.context;
    context.bindFramebuffer(context.READ_FRAMEBUFFER, framebuffer);
    this.readPixels(x, y, width, height, context.RGBA, context.FLOAT, destination);
    context.bindFramebuffer(context.READ_FRAMEBUFFER, null);
  }
}
