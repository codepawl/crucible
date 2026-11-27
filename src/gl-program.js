// Shader program helpers shared by the renderer and its optional addons, kept apart so an addon does not pull in the renderer.

import { shaderTransforms } from './shader-registry.js';

export const fullscreenVertex = `#version 300 es
precision highp float;
out vec2 textureCoordinate;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  textureCoordinate = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

// Starting a program without asking for its result lets the driver build several programs at once.
export function startProgram(context, vertexSource, fragmentSource) {
  const program = context.createProgram();
  context.getExtension?.('KHR_parallel_shader_compile');
  const shaders = [];
  for (const [kind, source] of [[context.VERTEX_SHADER, vertexSource], [context.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = context.createShader(kind);
    context.shaderSource(shader, shaderTransforms.reduce((text, transform) => transform(text), source));
    context.compileShader(shader);
    context.attachShader(program, shader);
    shaders.push(shader);
  }
  context.linkProgram(program);
  return { program, shaders };
}

// While a context is being prepared, a program the driver has not finished building does not stall the page: finishing it throws
// ProgramNotReady, the caller waits for isLinkComplete(error.program) without blocking, and draws again (CrucibleRenderer.prepareFrame).
const preparingContexts = new WeakSet();
const startedBySource = new WeakMap();

export class ProgramNotReady extends Error {
  constructor(program) {
    super('A shader program is still building.');
    this.name = 'ProgramNotReady';
    this.program = program;
  }
}

/** True once the driver has finished building the program; always true where the driver cannot say, since asking then waits. */
export function isLinkComplete(context, program) {
  const parallelCompile = context.getExtension?.('KHR_parallel_shader_compile');
  return !parallelCompile || Boolean(context.getProgramParameter(program, parallelCompile.COMPLETION_STATUS_KHR));
}

export function setPreparing(context, preparing) {
  if (preparing) preparingContexts.add(context);
  else preparingContexts.delete(context);
}

/** Deletes the programs a draw started while preparing and nothing took over yet. Keyed by context, so it also takes those of another live renderer on the same context. Reads their link status so no link is deleted mid-flight (#1266). */
export function releaseStartedPrograms(context) {
  const started = startedBySource.get(context);
  if (!started) return;
  for (const { program, shaders } of started.values()) {
    context.getProgramParameter(program, context.LINK_STATUS);
    shaders.forEach((shader) => context.deleteShader(shader));
    context.deleteProgram(program);
  }
  startedBySource.delete(context);
}

export function finishProgram(context, { program, shaders }) {
  if (preparingContexts.has(context) && !isLinkComplete(context, program)) throw new ProgramNotReady(program);
  const linked = context.getProgramParameter(program, context.LINK_STATUS);
  // A linked program has compiled shaders, so the per-shader status and the logs are read only to explain a failure. Each of
  // those reads is a round trip to the GPU process that waits for everything queued before it (up to 70 ms on a busy card).
  if (linked) {
    shaders.forEach((shader) => context.deleteShader?.(shader));
    return program;
  }
  const failedShader = shaders.find(shader => !context.getShaderParameter(shader, context.COMPILE_STATUS));
  const message = failedShader ? context.getShaderInfoLog(failedShader) : context.getProgramInfoLog(program);
  shaders.forEach((shader) => context.deleteShader?.(shader));
  context.deleteProgram?.(program);
  // On a lost context every link reports false with a null log; the context is gone, so there is nothing to report (#541).
  if (context.isContextLost?.()) return program;
  throw new Error(failedShader ? `Shader compilation failed: ${message}` : `Shader linking failed: ${message}`);
}

// While preparing, a program that is not ready stays started under its source, so the draw that comes back for it finds it building.
export function compileProgram(context, vertexSource, fragmentSource) {
  if (!preparingContexts.has(context)) return finishProgram(context, startProgram(context, vertexSource, fragmentSource));
  if (!startedBySource.has(context)) startedBySource.set(context, new Map());
  const started = startedBySource.get(context);
  const key = `${vertexSource}\\0${fragmentSource}`;
  if (!started.has(key)) started.set(key, startProgram(context, vertexSource, fragmentSource));
  try {
    const program = finishProgram(context, started.get(key));
    started.delete(key);
    return program;
  } catch (error) {
    // A program still building stays started. A failed one is already deleted, and keeping it would hide its log on the next draw.
    if (!(error instanceof ProgramNotReady)) started.delete(key);
    throw error;
  }
}
