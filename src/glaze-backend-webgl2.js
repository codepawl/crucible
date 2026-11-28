// The WebGL2 implementation of the Glaze backend boundary (glaze-backend.js). Every method issues the calls that
// CrucibleRenderer made itself before the boundary existed, in the same order, so a frame does not change.

import { startProgram, finishProgram, compileProgram, isLinkComplete, setPreparing, releaseStartedPrograms } from './gl-program.js';

const CONTEXT_OPTIONS_BASE = { antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance' };

function dataTextureSpec(context, format) {
  const specs = {
    r8: [context.R8, context.RED, context.UNSIGNED_BYTE],
    rgba8: [context.RGBA8, context.RGBA, context.UNSIGNED_BYTE],
    rgb8: [context.RGB8, context.RGB, context.UNSIGNED_BYTE],
    rgba16f: [context.RGBA16F, context.RGBA, context.HALF_FLOAT],
    rgba16fFloat: [context.RGBA16F, context.RGBA, context.FLOAT],
    rgba32f: [context.RGBA32F, context.RGBA, context.FLOAT],
    rg32f: [context.RG32F, context.RG, context.FLOAT],
    r32f: [context.R32F, context.RED, context.FLOAT],
    rgba32ui: [context.RGBA32UI, context.RGBA_INTEGER, context.UNSIGNED_INT],
  };
  const spec = specs[format];
  if (!spec) throw new RangeError(`Unsupported texture format "${format}".`);
  return spec;
}

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
    const context = this.context;
    const bufferTarget = target === 'element' ? context.ELEMENT_ARRAY_BUFFER : target === 'array' ? context.ARRAY_BUFFER : target;
    const bufferUsage = usage === 'dynamic' ? context.DYNAMIC_DRAW : usage === 'static' ? context.STATIC_DRAW : usage;
    context.bindBuffer(bufferTarget, buffer);
    context.bufferData(bufferTarget, data, bufferUsage);
  }

  updateBuffer(buffer, data, sourceOffset = 0, length = data.length) {
    const context = this.context;
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    context.bufferSubData(context.ARRAY_BUFFER, 0, data, sourceOffset, length);
  }

  bindArrayBuffer(buffer = null) {
    this.context.bindBuffer(this.context.ARRAY_BUFFER, buffer);
  }

  bindElementBuffer(buffer = null) {
    this.context.bindBuffer(this.context.ELEMENT_ARRAY_BUFFER, buffer);
  }

  deleteBuffer(buffer) {
    this.context.deleteBuffer(buffer);
  }

  attribLocation(program, name) {
    return this.context.getAttribLocation(program, name);
  }

  enableVertexAttribute(location, size, stride = 0, offset = 0, divisor = 0, integer = false) {
    const context = this.context;
    context.enableVertexAttribArray(location);
    if (integer) context.vertexAttribIPointer(location, size, context.UNSIGNED_INT, stride, offset);
    else context.vertexAttribPointer(location, size, context.FLOAT, false, stride, offset);
    if (divisor) context.vertexAttribDivisor(location, divisor);
  }

  bindVertexAttributes(buffer, attributes) {
    this.bindArrayBuffer(buffer);
    for (const { location, size, stride = 0, offset = 0, divisor = 0 } of attributes) {
      this.enableVertexAttribute(location, size, stride, offset, divisor);
    }
  }

  setConstantAttribute(location, ...values) {
    const context = this.context;
    context.disableVertexAttribArray(location);
    if (values.length === 2) context.vertexAttrib2f(location, values[0], values[1]);
    else if (values.length === 3) context.vertexAttrib3f(location, values[0], values[1], values[2]);
    else context.vertexAttrib1f(location, values[0] ?? 0);
  }

  setConstantAttribute1f(location, value = 0) {
    this.setConstantAttribute(location, value);
  }

  createVertexArray(attributes = null, indexBuffer = null) {
    const context = this.context;
    const vertexArray = context.createVertexArray();
    if (!attributes) return vertexArray;
    context.bindVertexArray(vertexArray);
    attributes.forEach((attribute, location) => {
      context.bindBuffer(context.ARRAY_BUFFER, attribute.buffer);
      this.enableVertexAttribute(location, attribute.size, 0, 0, attribute.divisor ?? 0, Boolean(attribute.integer));
    });
    if (indexBuffer) context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, indexBuffer);
    context.bindVertexArray(null);
    return vertexArray;
  }

  bindVertexArray(vertexArray) {
    this.context.bindVertexArray(vertexArray);
  }

  deleteVertexArray(vertexArray) {
    this.context.deleteVertexArray(vertexArray);
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
    const internalFormat = colorFormat === 'rgba16f' ? context.RGBA16F : colorFormat === 'rgba8' ? context.RGBA8 : colorFormat;
    const limited = Math.min(requested, context.getParameter(context.MAX_SAMPLES));
    const colorCounts = Array.from(context.getInternalformatParameter(context.RENDERBUFFER, internalFormat, context.SAMPLES));
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

  createTexture() {
    return this.context.createTexture();
  }

  createTexture2D(internalFormat, width, height, format, type, filter, clamp = false, data = null) {
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    try {
      context.texImage2D(context.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
      if (clamp) {
        this.setClampedFiltering(filter);
      } else {
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, filter);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, filter);
      }
    } catch (error) {
      context.deleteTexture(texture);
      throw error;
    }
    return texture;
  }

  createStorageTexture2D(internalFormat, width, height, levels, minFilter, magFilter = minFilter, clamp = true) {
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texStorage2D(context.TEXTURE_2D, levels, internalFormat, width, height);
    if (clamp) {
      this.setClampedFiltering(minFilter, magFilter);
    } else {
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, minFilter);
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, magFilter);
    }
    return texture;
  }

  /** A single-sample framebuffer with a linear colour texture and, with `depth`, a readable 24-bit depth texture. Returns { framebuffer, colorTexture, depthTexture }. */
  createResolveTarget({ width, height, hdr, depth }) {
    const target = this.createFramebufferTarget({ width, height, hdr, depth, depthAsTexture: true, linear: true, clamp: true });
    if (!target.complete) {
      this.deleteFramebuffer(target.framebuffer);
      this.deleteTexture(target.colorTexture);
      if (target.depthTexture) this.deleteTexture(target.depthTexture);
      throw new Error('Resolve framebuffer allocation failed. Choose a lower quality preset.');
    }
    return { framebuffer: target.framebuffer, colorTexture: target.colorTexture, depthTexture: target.depthTexture };
  }

  /** A single-sample framebuffer with optional colour texture (`rgba8` / `rgba16f` / `rg32f`) and depth store (`depth24` / `depth32f`). */
  createFramebufferTarget({ width, height, color = true, hdr = false, colorFormat = hdr ? 'rgba16f' : 'rgba8', depth = false, floatDepth = false, depthAsTexture = false, linear = false, colorFilter = linear ? this.context.LINEAR : this.context.NEAREST, clamp = false, storage = false, levels = 1, unbind = false }) {
    const context = this.context;
    const colorSpec = color ? dataTextureSpec(context, colorFormat) : null;
    const colorMinFilter = storage && levels > 1 && linear ? context.LINEAR_MIPMAP_LINEAR : colorFilter;
    const colorTexture = color ? (storage
      ? this.createStorageTexture2D(colorSpec[0], width, height, levels, colorMinFilter, colorFilter, clamp)
      : this.createTexture2D(colorSpec[0], width, height, colorSpec[1], colorSpec[2], colorFilter, clamp)) : null;
    const framebuffer = context.createFramebuffer();
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    if (colorTexture) context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, colorTexture, 0);
    let depthTexture = null;
    let depthRenderbuffer = null;
    if (depth && depthAsTexture) {
      const depthInternal = floatDepth ? context.DEPTH_COMPONENT32F : context.DEPTH_COMPONENT24;
      depthTexture = storage
        ? this.createStorageTexture2D(depthInternal, width, height, 1, context.NEAREST, context.NEAREST, clamp)
        : this.createTexture2D(depthInternal, width, height, context.DEPTH_COMPONENT, floatDepth ? context.FLOAT : context.UNSIGNED_INT, context.NEAREST, clamp);
      context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, depthTexture, 0);
    } else if (depth) {
      depthRenderbuffer = context.createRenderbuffer();
      context.bindRenderbuffer(context.RENDERBUFFER, depthRenderbuffer);
      context.renderbufferStorage(context.RENDERBUFFER, floatDepth ? context.DEPTH_COMPONENT32F : context.DEPTH_COMPONENT24, width, height);
      context.framebufferRenderbuffer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.RENDERBUFFER, depthRenderbuffer);
    }
    const complete = context.checkFramebufferStatus ? context.checkFramebufferStatus(context.FRAMEBUFFER) === context.FRAMEBUFFER_COMPLETE : true;
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

  setClampedFiltering(filter, magFilter = filter) {
    const context = this.context;
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, filter);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, magFilter);
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

  blitTarget(source, destination, width, height, mask = 'color') {
    const context = this.context;
    const bits = mask === 'color' ? context.COLOR_BUFFER_BIT : mask === 'depth' ? context.DEPTH_BUFFER_BIT : mask;
    context.bindFramebuffer(context.READ_FRAMEBUFFER, source);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, destination);
    context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, bits, context.NEAREST);
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

  isProgramLinkComplete(program) {
    return isLinkComplete(this.context, program);
  }

  setPreparing(preparing) {
    setPreparing(this.context, preparing);
  }

  releaseStartedPrograms() {
    releaseStartedPrograms(this.context);
  }

  deleteStartedProgram({ program, shaders }) {
    const context = this.context;
    context.getProgramParameter(program, context.LINK_STATUS);
    shaders.forEach((shader) => context.deleteShader(shader));
    context.deleteProgram(program);
  }

  initializeSampler2DUniforms(program, unit = 1) {
    const context = this.context;
    context.useProgram(program);
    const count = context.getProgramParameter(program, context.ACTIVE_UNIFORMS);
    for (let index = 0; index < count; index++) {
      const uniform = context.getActiveUniform(program, index);
      if (uniform.type === context.SAMPLER_2D) context.uniform1iv(context.getUniformLocation(program, uniform.name), new Int32Array(uniform.size).fill(unit));
    }
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

  uniform4f(location, first, second, third, fourth) {
    this.context.uniform4f(location, first, second, third, fourth);
  }

  uniform4fv(location, values) {
    this.context.uniform4fv(location, values);
  }

  uniformMatrix3fv(location, values) {
    this.context.uniformMatrix3fv(location, false, values);
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

  uniform1i(location, value) {
    this.context.uniform1i(location, value);
  }

  uniform1iv(location, values) {
    this.context.uniform1iv(location, values);
  }

  uniform2f(location, first, second) {
    this.context.uniform2f(location, first, second);
  }

  uniform2fv(location, values) {
    this.context.uniform2fv(location, values);
  }

  maxTextureSize() {
    return this.context.getParameter(this.context.MAX_TEXTURE_SIZE);
  }

  maxRenderbufferAndTextureSize() {
    const context = this.context;
    return Math.min(context.getParameter(context.MAX_RENDERBUFFER_SIZE), context.getParameter(context.MAX_TEXTURE_SIZE));
  }

  textureUnitLimits() {
    const context = this.context;
    return {
      vertex: context.getParameter(context.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
      combined: context.getParameter(context.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    };
  }

  error() {
    return this.context.getError();
  }

  boundTexture2D() {
    return this.context.getParameter(this.context.TEXTURE_BINDING_2D);
  }

  setTexture2DParameters({ wrapS, wrapT, minFilter, magFilter }) {
    const context = this.context;
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, wrapS);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, wrapT);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, minFilter);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, magFilter);
  }

  uploadTexture2DMipLevels(mipLevels, linear) {
    const context = this.context;
    const format = linear ? context.RGBA8 : context.SRGB8_ALPHA8;
    mipLevels.forEach((level, index) => {
      context.texImage2D(context.TEXTURE_2D, index + 1, format, level.width, level.height, 0, context.RGBA, context.UNSIGNED_BYTE, level.data);
    });
  }

  createColorTexture2D(map, prepare, onConfigure) {
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    const previousFlip = context.getParameter(context.UNPACK_FLIP_Y_WEBGL);
    const previousColorSpace = context.getParameter(context.UNPACK_COLORSPACE_CONVERSION_WEBGL);
    try {
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, map?.flipY ?? false);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
      if (map) {
        const info = prepare(this.maxTextureSize());
        if (map.image.compressed) map.image.compressed.upload(context);
        else context.texImage2D(context.TEXTURE_2D, 0, map.colorSpace === 'linear' ? context.RGBA8 : context.SRGB8_ALPHA8, context.RGBA, context.UNSIGNED_BYTE, map.image);
        onConfigure(info);
      } else {
        context.texImage2D(context.TEXTURE_2D, 0, context.RGBA8, 1, 1, 0, context.RGBA, context.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
        context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
      }
    } catch (error) {
      context.deleteTexture(texture);
      throw error;
    } finally {
      context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, previousFlip);
      context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, previousColorSpace);
    }
    return texture;
  }

  uploadDepthTexture2D(texture, width, height, { linear = false, compare = false, unit = 0 } = {}) {
    const context = this.context;
    this.bindTextureUnit(unit, texture);
    if (width !== null) context.texImage2D(context.TEXTURE_2D, 0, context.DEPTH_COMPONENT24, width, height, 0, context.DEPTH_COMPONENT, context.UNSIGNED_INT, null);
    this.setClampedFiltering(linear ? context.LINEAR : context.NEAREST);
    if (compare) context.texParameteri(context.TEXTURE_2D, context.TEXTURE_COMPARE_MODE, context.COMPARE_REF_TO_TEXTURE);
  }

  attachDepthTexture(framebuffer, texture, label = null) {
    const context = this.context;
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, context.TEXTURE_2D, texture, 0);
    context.drawBuffers([context.NONE]);
    context.readBuffer(context.NONE);
    if (label && context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) {
      throw new Error(`${label} framebuffer is incomplete.`);
    }
  }

  activeTextureUnit(unit) {
    this.context.activeTexture(this.context.TEXTURE0 + unit);
  }

  bindTextureUnit(unit, texture, target = false) {
    const context = this.context;
    this.activeTextureUnit(unit);
    const textureTarget = target === '3d' ? context.TEXTURE_3D : target ? context.TEXTURE_2D_ARRAY : context.TEXTURE_2D;
    context.bindTexture(textureTarget, texture);
  }

  generateMipmap(array = false) {
    const context = this.context;
    context.generateMipmap(array ? context.TEXTURE_2D_ARRAY : context.TEXTURE_2D);
  }

  /** Enables or restores linear mipmapped filtering on a 2D texture, optionally binding it on `unit`. */
  setTextureMipmaps(texture, enabled, unit = 0) {
    const context = this.context;
    if (unit !== null) this.bindTextureUnit(unit, texture);
    else context.bindTexture(context.TEXTURE_2D, texture);
    if (enabled) context.generateMipmap(context.TEXTURE_2D);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, enabled ? context.LINEAR_MIPMAP_LINEAR : context.LINEAR);
  }

  /** Allocates an immutable RGBA16F 2D texture with optional mip chain and horizontal repeat. */
  createHalfFloatStorageTexture({ width, height, levels = 1, repeatHorizontal = false }) {
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texStorage2D(context.TEXTURE_2D, levels, context.RGBA16F, width, height);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, levels > 1 ? context.LINEAR_MIPMAP_LINEAR : context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, repeatHorizontal ? context.REPEAT : context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    return texture;
  }

  uploadFloatTexture2D(texture, x, y, width, height, data) {
    const context = this.context;
    if (texture) context.bindTexture(context.TEXTURE_2D, texture);
    context.texSubImage2D(context.TEXTURE_2D, 0, x, y, width, height, context.RGBA, context.FLOAT, data);
  }

  applyAnisotropy(target, maximum = 16) {
    const context = this.context;
    const extension = this.extension('EXT_texture_filter_anisotropic');
    if (!extension) return;
    this.maximumAnisotropy ??= context.getParameter(extension.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    context.texParameterf(target, extension.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(maximum, this.maximumAnisotropy));
  }

  /** Allocates a 2D texture array (`depth24`, `rgba8`, `srgb8Alpha8`) with optional mip chain, wrapping and anisotropy. */
  createTextureArray({ width, height, layers, format = 'rgba8', mipmaps = false, wrap = null, linear = false, data = null, unpackRaw = false, anisotropy = 0 }) {
    const context = this.context;
    const formats = {
      depth24: [context.DEPTH_COMPONENT24, context.DEPTH_COMPONENT, context.UNSIGNED_INT],
      rgba8: [context.RGBA8, context.RGBA, context.UNSIGNED_BYTE],
      srgb8Alpha8: [context.SRGB8_ALPHA8, context.RGBA, context.UNSIGNED_BYTE],
    };
    const spec = formats[format];
    if (!spec) throw new RangeError(`Unsupported texture array format "${format}". Pass depth24, rgba8 or srgb8Alpha8.`);
    const [internalFormat, uploadFormat, uploadType] = spec;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_2D_ARRAY, texture);
    if (mipmaps) {
      const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
      context.texStorage3D(context.TEXTURE_2D_ARRAY, levels, internalFormat, width, height, layers);
      if (unpackRaw) {
        context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
        context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
      }
      if (data) context.texSubImage3D(context.TEXTURE_2D_ARRAY, 0, 0, 0, 0, width, height, layers, uploadFormat, uploadType, data);
      context.generateMipmap(context.TEXTURE_2D_ARRAY);
    } else {
      context.texImage3D(context.TEXTURE_2D_ARRAY, 0, internalFormat, width, height, layers, 0, uploadFormat, uploadType, data);
    }
    const minFilter = mipmaps ? (linear ? context.LINEAR_MIPMAP_LINEAR : context.NEAREST_MIPMAP_NEAREST) : (linear ? context.LINEAR : context.NEAREST);
    const magFilter = linear ? context.LINEAR : context.NEAREST;
    if (wrap) {
      const wrapMode = wrap === 'repeat' ? context.REPEAT : context.CLAMP_TO_EDGE;
      context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_WRAP_S, wrapMode);
      context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_WRAP_T, wrapMode);
    }
    context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_MIN_FILTER, minFilter);
    context.texParameteri(context.TEXTURE_2D_ARRAY, context.TEXTURE_MAG_FILTER, magFilter);
    if (anisotropy > 0) this.applyAnisotropy(context.TEXTURE_2D_ARRAY, anisotropy);
    return texture;
  }

  createFramebuffer() {
    return this.context.createFramebuffer();
  }

  beginDepthOnlyPass(framebuffer, width, height) {
    const context = this.context;
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.drawBuffers([context.NONE]);
    context.readBuffer(context.NONE);
    context.viewport(0, 0, width, height);
    context.enable(context.DEPTH_TEST);
    context.enable(context.CULL_FACE);
  }

  bindDepthTextureLayer(texture, layer, clear = true) {
    const context = this.context;
    context.framebufferTextureLayer(context.FRAMEBUFFER, context.DEPTH_ATTACHMENT, texture, 0, layer);
    if (clear) context.clear(context.DEPTH_BUFFER_BIT);
  }

  setFullscreenState() {
    const context = this.context;
    this.prepareFullscreenDraw();
    context.disable(context.BLEND);
    context.disable(context.SCISSOR_TEST);
  }

  prepareFullscreenDraw(program = null) {
    const context = this.context;
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.bindVertexArray(null);
    if (program) context.useProgram(program);
  }

  beginFullscreenPass(framebuffer, width, height, program = null) {
    this.bindFramebuffer(framebuffer);
    this.setViewport(width, height);
    this.prepareFullscreenDraw(program);
  }

  drawFullscreenTriangles() {
    this.context.drawArrays(this.context.TRIANGLES, 0, 3);
  }

  drawIntoTextureLevel(framebuffer, texture, level, width, height, errorMessage = 'Framebuffer is incomplete.') {
    const context = this.context;
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, level);
    if (context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE) throw new Error(errorMessage);
    context.viewport(0, 0, width, height);
    this.drawFullscreenTriangles();
  }

  finish() {
    this.context.finish();
  }

  isContextLost() {
    return Boolean(this.context.isContextLost?.());
  }

  hasCanvasAlpha() {
    return Boolean(this.context.getContextAttributes?.()?.alpha);
  }

  bindFramebuffer(framebuffer = null) {
    this.context.bindFramebuffer(this.context.FRAMEBUFFER, framebuffer);
  }

  setViewport(width, height, x = 0, y = 0) {
    this.context.viewport(x, y, width, height);
  }

  clearColorBuffer(attachmentIndex, values) {
    this.context.clearBufferfv(this.context.COLOR, attachmentIndex, values);
  }

  clearColorAndDepth(color, depth, depthOnly = false) {
    const context = this.context;
    context.clearColor(...color);
    context.clearDepth(depth);
    context.clear(depthOnly ? context.DEPTH_BUFFER_BIT : context.COLOR_BUFFER_BIT | context.DEPTH_BUFFER_BIT);
    context.clearDepth(1);
  }

  isBlendEnabled() {
    return Boolean(this.context.isEnabled(this.context.BLEND));
  }

  setRenderState({ depthTest, depthWrite, depthFunc, cullFace, cullMode, blend, blendMode, blendEquation, colorMask, sampleAlphaToCoverage, polygonOffset } = {}) {
    const context = this.context;
    if (depthTest !== undefined) context[depthTest ? 'enable' : 'disable'](context.DEPTH_TEST);
    if (depthWrite !== undefined) context.depthMask(depthWrite);
    if (depthFunc === 'less') context.depthFunc(context.LESS);
    else if (depthFunc === 'greater') context.depthFunc(context.GREATER);
    if (cullFace !== undefined) context[cullFace ? 'enable' : 'disable'](context.CULL_FACE);
    if (cullMode === 'front') context.cullFace(context.FRONT);
    else if (cullMode === 'back') context.cullFace(context.BACK);
    if (sampleAlphaToCoverage !== undefined) context[sampleAlphaToCoverage ? 'enable' : 'disable'](context.SAMPLE_ALPHA_TO_COVERAGE);
    if (polygonOffset === false) context.disable(context.POLYGON_OFFSET_FILL);
    else if (polygonOffset) { context.enable(context.POLYGON_OFFSET_FILL); context.polygonOffset(...polygonOffset); }
    if (blend !== undefined) context[blend ? 'enable' : 'disable'](context.BLEND);
    if (blendMode === 'one') context.blendFunc(context.ONE, context.ONE);
    else if (blendMode === 'premultiplied') context.blendFuncSeparate(context.ONE, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE_MINUS_SRC_ALPHA);
    else if (blendMode === 'alpha') context.blendFuncSeparate(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE_MINUS_SRC_ALPHA);
    else if (blendMode === 'dstColor') context.blendFuncSeparate(context.DST_COLOR, context.ZERO, context.ONE, context.ONE);
    else if (blendMode === 'srcAlphaOne') context.blendFuncSeparate(context.SRC_ALPHA, context.ONE, context.ZERO, context.ONE);
    else if (Array.isArray(blendMode)) context.blendFuncSeparate(...blendMode.map((factor) => (typeof factor === 'string' ? context[factor] : factor)));
    if (blendEquation === 'add') context.blendEquation(context.FUNC_ADD);
    else if (blendEquation === 'min') context.blendEquation(context.MIN);
    else if (blendEquation === 'addMin') context.blendEquationSeparate(context.FUNC_ADD, context.MIN);
    if (colorMask) context.colorMask(...colorMask);
  }

  drawIndexed(count, shortIndices = false) {
    const context = this.context;
    context.drawElements(context.TRIANGLES, count, shortIndices ? context.UNSIGNED_SHORT : context.UNSIGNED_INT, 0);
  }

  drawInstancedStrip(vertexCount, instanceCount) {
    this.context.drawArraysInstanced(this.context.TRIANGLE_STRIP, 0, vertexCount, instanceCount);
  }

  drawInstancedTriangles(vertexCount, instanceCount) {
    this.context.drawArraysInstanced(this.context.TRIANGLES, 0, vertexCount, instanceCount);
  }

  createTexture3D({ width, height, depth, data = null }) {
    const context = this.context;
    const texture = context.createTexture();
    context.bindTexture(context.TEXTURE_3D, texture);
    context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_3D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    for (const wrap of [context.TEXTURE_WRAP_S, context.TEXTURE_WRAP_T, context.TEXTURE_WRAP_R]) {
      context.texParameteri(context.TEXTURE_3D, wrap, context.CLAMP_TO_EDGE);
    }
    context.pixelStorei(context.UNPACK_ALIGNMENT, 1);
    context.texImage3D(context.TEXTURE_3D, 0, context.RGBA16F, width, height, depth, 0, context.RGBA, context.HALF_FLOAT, data);
    return texture;
  }

  uploadTexture3D(texture, { width, height, depth, data }) {
    const context = this.context;
    context.bindTexture(context.TEXTURE_3D, texture);
    context.pixelStorei(context.UNPACK_ALIGNMENT, 1);
    context.texSubImage3D(context.TEXTURE_3D, 0, 0, 0, 0, width, height, depth, context.RGBA, context.HALF_FLOAT, data);
  }

  createDataTexture2D({ width, height, format = 'rgba8', linear = false, clamp = false, data = null, unit = null, restoreBinding = false }) {
    const context = this.context;
    const [internalFormat, uploadFormat, uploadType] = dataTextureSpec(context, format);
    const previousBinding = restoreBinding ? context.getParameter(context.TEXTURE_BINDING_2D) : null;
    if (unit !== null) this.activeTextureUnit(unit);
    const texture = this.createTexture2D(internalFormat, width, height, uploadFormat, uploadType, linear ? context.LINEAR : context.NEAREST, clamp, data);
    if (restoreBinding) context.bindTexture(context.TEXTURE_2D, previousBinding);
    return texture;
  }

  uploadDataTexture2D(texture, { x = 0, y = 0, width, height, format = 'rgba8', data, reallocate = false, unit = null }) {
    const context = this.context;
    const [internalFormat, uploadFormat, uploadType] = dataTextureSpec(context, format);
    if (unit !== null) this.activeTextureUnit(unit);
    context.bindTexture(context.TEXTURE_2D, texture);
    if (reallocate) {
      context.texImage2D(context.TEXTURE_2D, 0, internalFormat, width, height, 0, uploadFormat, uploadType, data);
    } else {
      context.texSubImage2D(context.TEXTURE_2D, 0, x, y, width, height, uploadFormat, uploadType, data);
    }
  }

  copyFramebufferToTexture(framebuffer, texture, width, height) {
    const context = this.context;
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.bindTexture(context.TEXTURE_2D, texture);
    context.copyTexSubImage2D(context.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
    if (framebuffer) this.bindCanvasTarget();
  }

  readIntegerTexture2D(texture, width, height, destination) {
    const context = this.context;
    const previousFramebuffer = context.getParameter(context.READ_FRAMEBUFFER_BINDING);
    const previousPackBuffer = context.getParameter(context.PIXEL_PACK_BUFFER_BINDING);
    const framebuffer = context.createFramebuffer();
    context.bindBuffer(context.PIXEL_PACK_BUFFER, null);
    context.bindFramebuffer(context.READ_FRAMEBUFFER, framebuffer);
    context.framebufferTexture2D(context.READ_FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, 0);
    context.readPixels(0, 0, width, height, context.RGBA_INTEGER, context.UNSIGNED_INT, destination);
    context.bindFramebuffer(context.READ_FRAMEBUFFER, previousFramebuffer);
    context.bindBuffer(context.PIXEL_PACK_BUFFER, previousPackBuffer);
    context.deleteFramebuffer(framebuffer);
  }

  createMultisampleColorAttachment(framebuffer, attachmentIndex, samples, width, height) {
    const context = this.context;
    const renderbuffer = context.createRenderbuffer();
    context.bindRenderbuffer(context.RENDERBUFFER, renderbuffer);
    context.renderbufferStorageMultisample(context.RENDERBUFFER, samples, context.RGBA8, width, height);
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.framebufferRenderbuffer(context.FRAMEBUFFER, context[`COLOR_ATTACHMENT${attachmentIndex}`], context.RENDERBUFFER, renderbuffer);
    context.drawBuffers([context.COLOR_ATTACHMENT0, context.NONE]);
    this.bindCanvasTarget();
    return renderbuffer;
  }

  clearColorAttachment(framebuffer, attachmentIndex, values) {
    const context = this.context;
    context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
    context.drawBuffers([context.NONE, context[`COLOR_ATTACHMENT${attachmentIndex}`]]);
    context.clearBufferfv(context.COLOR, attachmentIndex, values);
    context.drawBuffers([context.COLOR_ATTACHMENT0, context.NONE]);
  }

  resolveColorAttachment(source, destination, attachmentIndex, width, height) {
    const context = this.context;
    context.bindFramebuffer(context.READ_FRAMEBUFFER, source);
    context.readBuffer(context[`COLOR_ATTACHMENT${attachmentIndex}`]);
    context.bindFramebuffer(context.DRAW_FRAMEBUFFER, destination);
    context.blitFramebuffer(0, 0, width, height, 0, 0, width, height, context.COLOR_BUFFER_BIT, context.NEAREST);
    context.readBuffer(context.COLOR_ATTACHMENT0);
  }

  watchProgramAttachment(attachmentIndex, activeFramebuffer, shouldEnable) {
    const context = this.context;
    const useProgram = context.useProgram.bind(context);
    const attachment = context[`COLOR_ATTACHMENT${attachmentIndex}`];
    context.useProgram = (program) => {
      useProgram(program);
      const framebuffer = activeFramebuffer();
      if (framebuffer && context.getParameter(context.DRAW_FRAMEBUFFER_BINDING) === framebuffer) {
        context.drawBuffers([context.COLOR_ATTACHMENT0, shouldEnable(program) ? attachment : context.NONE]);
      }
    };
  }
}
