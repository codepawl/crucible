import { buildTraceSceneForDevice, refuseLocalVolumes } from './path-tracer-scene.js';
import { createCamera } from './path-tracer.js';
import * as webGpuTracer from './path-tracer-webgpu.js';
import { REALTIME_KERNEL_PIECES } from './path-tracer-realtime-webgpu-kernel.js';
import { cacheCellSizes, noteIgnoredClipStart } from './path-tracer-realtime-options.js';
import { createWebGpuDenoiser, createWebGpuRadianceCache } from './path-tracer-realtime-webgpu-passes.js';
import { PART_MOTION_CHANGED, PART_MOTION_FLOATS, partMotionTable } from './path-tracer-reprojection.js';
import { MAX_TRACE_PARTS } from './path-tracer-scene.js';

// The WebGPU backend of the real-time path tracer (issue #624): the same frame as path-tracer-realtime.js, one path per
// pixel at half the output size, two bounces ended by the radiance cache, then the temporal denoiser, but every step is a
// compute pass of one command buffer and the tracing is the WebGPU megakernel (path-tracer-webgpu.js, which compiles in
// under a second). The kernel pieces are in path-tracer-realtime-webgpu-kernel.js, the cache and denoiser passes in
// path-tracer-realtime-webgpu-passes.js. The picture goes to `canvas` through a buffer to texture copy.

const TILE_CELL_SIZE_WORD = 48;
const TILE_LEVEL_DISTANCE_WORD = 49;
const SAMPLE_INDEX_WORD = 43;

const watchedDevices = new WeakSet();

// A rejected command does not throw in the page; the device reports it here, and the frame stays black or stale.
function reportDeviceErrors(device) {
  if (watchedDevices.has(device)) return;
  watchedDevices.add(device);
  device.addEventListener('uncapturederror', event => console.error(`WebGPU real-time tracer: ${event.error.message}`));
}

function createOutputCanvas(width, height) {
  const canvas = typeof document === 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** `resolved` is what `resolveRealtimeOptions` returns for the options of `createRealtimeTracer`; `suppliedCanvas` is optional. */
export async function createWebGpuRealtimeTracer(scene, resolved, suppliedCanvas) {
  const { outputWidth, outputHeight, traceWidth, traceHeight, options, historyLimit, filterIterations, cacheCellSize, followPartMotion } = resolved;
  let traceScene = null;
  let kernel = null;
  let device = null;
  let traced = null;
  let cache = null;
  let denoiser = null;
  let canvas = null;
  let context = null;
  let parameterBuffer = null;
  let recordBuffer = null;
  let motionBuffer = null;
  let currentParts = null;
  let currentEnvironment = null;
  let pendingMotion = null;
  let motionIsActive = false;
  let traceGroups = null;
  let cellSizes = null;
  const pixelCount = traceWidth * traceHeight;
  const swapped = navigator.gpu.getPreferredCanvasFormat() === 'bgra8unorm';
  let currentSet = 0;
  let frameIndex = 0;
  let view = null;
  let resetHistory = true;
  let clearCache = true;
  let disposed = false;

  // `motion` is for an update that moves parts of the same scene: the denoiser's history and the cache stay, and the table
  // tells the denoiser where each part was (path-tracer-reprojection.js, partMotionTable).
  const loadScene = async (parts, environment, motion = null) => {
    const keepHistory = motion !== null;
    // The real-time kernel reads a flat scene only, so the module it passes does not offer instancing.
    const nextTraceScene = await buildTraceSceneForDevice(parts, environment, { gpuTriangleLimit: webGpuTracer.gpuTriangleLimit });
    refuseLocalVolumes(nextTraceScene, 'the WebGPU realtime path tracer');
    const next = await webGpuTracer.prepareRealtimeKernel(nextTraceScene, options, REALTIME_KERNEL_PIECES);
    const previousKernel = kernel;
    const firstLoad = !traced;
    const created = [];
    const create = descriptor => {
      const buffer = next.device.createBuffer(descriptor);
      created.push(buffer);
      return buffer;
    };
    let nextTraced = traced;
    let nextRecord = recordBuffer;
    let nextParameter = parameterBuffer;
    let nextMotion = motionBuffer;
    let nextCache = cache;
    let nextDenoiser = denoiser;
    let nextCanvas = canvas;
    let nextContext = context;
    try {
      if (firstLoad) {
        nextTraced = [0, 1].map(index => create({ label: `traced ${index}`, size: pixelCount * 16 * 3, usage: GPUBufferUsage.STORAGE }));
        nextRecord = create({ label: 'cache records', size: pixelCount * 16, usage: GPUBufferUsage.STORAGE });
        nextParameter = create({ label: 'realtime parameters', size: 512, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        nextMotion = create({ label: 'part motion', size: MAX_TRACE_PARTS * PART_MOTION_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        nextCache = await createWebGpuRadianceCache(next.device);
        nextDenoiser = await createWebGpuDenoiser(next.device, { traceWidth, traceHeight, outputWidth, outputHeight, tracedBuffers: nextTraced, motionBuffer: nextMotion, historyLimit, filterIterations, swapped });
        nextCanvas = suppliedCanvas ?? createOutputCanvas(outputWidth, outputHeight);
        nextContext = nextCanvas.getContext('webgpu');
        nextContext.configure({ device: next.device, format: navigator.gpu.getPreferredCanvasFormat(), usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST, alphaMode: 'opaque' });
      }
      const nextTraceGroups = [0, 1].map(set => next.device.createBindGroup({
        layout: next.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: nextParameter, size: next.parameterBytes } },
          ...[...next.uploaded.buffers, nextTraced[set], nextCache.table, nextRecord].map((buffer, index) => ({ binding: index + 1, resource: { buffer } })),
        ],
      }));
      // Everything that can throw runs before the commit below, so a failed load leaves the previous scene whole.
      const nextCellSizes = cacheCellSizes(nextTraceScene, cacheCellSize);
      reportDeviceErrors(next.device);
      traceScene = nextTraceScene;
      kernel = next;
      device = next.device;
      traced = nextTraced;
      recordBuffer = nextRecord;
      parameterBuffer = nextParameter;
      motionBuffer = nextMotion;
      cache = nextCache;
      denoiser = nextDenoiser;
      canvas = nextCanvas;
      context = nextContext;
      traceGroups = nextTraceGroups;
      pendingMotion = motion;
      currentParts = parts;
      currentEnvironment = environment;
      cellSizes = nextCellSizes;
      if (!keepHistory) {
        view = null;
        resetHistory = true;
        clearCache = true;
      }
    } catch (error) {
      for (const buffer of created) buffer.destroy();
      for (const buffer of next.uploaded.buffers) buffer.destroy();
      if (firstLoad) {
        nextCache?.dispose();
        nextDenoiser?.dispose();
      }
      throw error;
    }
    // Last, once the new kernel is committed: the old one stays usable until then.
    previousKernel?.uploaded.buffers.forEach(buffer => buffer.destroy());
  };

  await loadScene(scene.parts, scene.environment ?? {});

  const writeParameters = (camera) => {
    const words = kernel.parameterWords(camera);
    const floats = new Float32Array(words.buffer);
    floats[TILE_CELL_SIZE_WORD] = cellSizes.cellSize;
    floats[TILE_LEVEL_DISTANCE_WORD] = cellSizes.levelDistance;
    words[SAMPLE_INDEX_WORD] = frameIndex + 1;
    device.queue.writeBuffer(parameterBuffer, 0, words);
  };

  // The motion table goes up with the first frame after an update, and a table of still parts follows it.
  const uploadPartMotion = () => {
    if (pendingMotion) {
      device.queue.writeBuffer(motionBuffer, 0, pendingMotion);
      pendingMotion = null;
      motionIsActive = true;
    } else if (motionIsActive) {
      device.queue.writeBuffer(motionBuffer, 0, partMotionTable(currentParts, currentParts));
      motionIsActive = false;
    }
  };

  const encodeFrame = (nextView, previousView) => {
    uploadPartMotion();
    const encoder = device.createCommandEncoder();
    if (clearCache) {
      cache.clear(encoder);
      clearCache = false;
    }
    const pass = encoder.beginComputePass();
    pass.setPipeline(kernel.pipeline);
    pass.setBindGroup(0, traceGroups[currentSet], [0]);
    pass.dispatchWorkgroups(Math.ceil(traceWidth / 8), Math.ceil(traceHeight / 8));
    cache.encode(pass, recordBuffer, pixelCount);
    denoiser.encode(pass, currentSet, { camera: nextView, previousCamera: previousView, resetHistory, farDistance: traceScene.farDistance });
    pass.end();
    encoder.copyBufferToTexture(
      { buffer: denoiser.outputBuffer, bytesPerRow: denoiser.rowWords * 4, rowsPerImage: outputHeight },
      { texture: context.getCurrentTexture() },
      { width: outputWidth, height: outputHeight },
    );
    device.queue.submit([encoder.finish()]);
  };

  const ignoredNotes = [];
  return {
    gpu: kernel.gpu,
    backend: 'webgpu',
    fallbackReason: null,
    ignored: ignoredNotes,
    get canvas() { return canvas; },
    width: outputWidth,
    height: outputHeight,
    traceWidth,
    traceHeight,
    get compileSeconds() { return kernel.compileSeconds; },
    get frameCount() { return frameIndex; },

    /**
     * New parts. The radiance cache and the denoiser's history start over, except when the part count and the environment are the
     * same and some part keeps its geometry: then a part that only moved (another matrix) is followed by the denoiser and a
     * part that changed in any other way loses its history, so a moving object does not leave a trail.
     */
    async update({ parts, environment } = {}) {
      const hasParts = parts !== undefined;
      const hasEnvironment = environment !== undefined;
      if (!hasParts && !hasEnvironment) return;
      const nextParts = hasParts ? parts : currentParts;
      const nextEnvironment = hasEnvironment ? (environment ?? {}) : (currentEnvironment ?? {});
      const sameScene = hasParts && currentParts?.length === nextParts.length && (!hasEnvironment || environment === currentEnvironment);
      const motion = sameScene ? partMotionTable(currentParts, nextParts) : null;
      const followsSomePart = motion !== null && nextParts.some((part, index) => motion[index * PART_MOTION_FLOATS + 12] !== PART_MOTION_CHANGED);
      await loadScene(nextParts, nextEnvironment, followsSomePart ? (followPartMotion ? motion : partMotionTable(nextParts, nextParts)) : null);
    },

    /** Forgets the denoiser's history (the cache stays: it only depends on the scene). */
    resetHistory() {
      resetHistory = true;
    },

    /** Draws one frame to `canvas` for a camera. With `wait` the result has a `done` promise that settles when the GPU is done, for timing. */
    frame(camera, { wait = false } = {}) {
      if (disposed) throw new Error('This real-time tracer was disposed.');
      const nextView = createCamera(camera, outputWidth, outputHeight);
      noteIgnoredClipStart(ignoredNotes, nextView);
      const previousView = view ?? nextView;
      writeParameters(nextView);
      view = nextView;
      encodeFrame(nextView, previousView);
      resetHistory = false;
      currentSet = 1 - currentSet;
      frameIndex++;
      return { frame: frameIndex, done: wait ? device.queue.onSubmittedWorkDone() : undefined };
    },

    /** The last frame as tone mapped bytes, top row first. */
    async readFrame() {
      const rowBytes = denoiser.rowWords * 4;
      const readback = device.createBuffer({ size: rowBytes * outputHeight, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(denoiser.outputBuffer, 0, readback, 0, rowBytes * outputHeight);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const packed = new Uint8Array(readback.getMappedRange());
      const rgba = new Uint8ClampedArray(outputWidth * outputHeight * 4);
      for (let row = 0; row < outputHeight; row++) {
        for (let column = 0; column < outputWidth; column++) {
          const source = row * rowBytes + column * 4;
          const target = (row * outputWidth + column) * 4;
          rgba[target] = packed[source + (swapped ? 2 : 0)];
          rgba[target + 1] = packed[source + 1];
          rgba[target + 2] = packed[source + (swapped ? 0 : 2)];
          rgba[target + 3] = 255;
        }
      }
      readback.destroy();
      return { width: outputWidth, height: outputHeight, rgba };
    },

    dispose() {
      disposed = true;
      cache.dispose();
      denoiser.dispose();
      for (const buffer of [...traced, recordBuffer, parameterBuffer, motionBuffer, ...kernel.uploaded.buffers]) buffer.destroy();
      context.unconfigure();
    },
  };
}
