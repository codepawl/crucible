import { ktx2WorkerConfigFor } from '../src/gltf.js';

// Browser-side Basis Universal KTX2 decoder for MCP preview pages (#2982).
// Dispatches transcodes to same-origin Dedicated Workers (/vendor/ktx2-worker.js) so embind stays off the page CSP.
const TRANSCODE_ETC1 = 0;
const TRANSCODE_ETC2_RGBA = 1;
const TRANSCODE_BC1 = 2;
const TRANSCODE_BC3 = 3;
const TRANSCODE_BC7_M5 = 7;
const TRANSCODE_ASTC_4X4 = 10;
const TRANSCODE_RGBA32 = 13;

const GL_ETC2_RGB = 0x9274;
const GL_ETC2_RGBA = 0x9278;
const GL_BC1_RGB = 0x83f0;
const GL_BC3_RGBA = 0x83f3;
const GL_BC7_RGBA = 0x8e8c;
const GL_ASTC_4X4 = 0x93b0;

const NO_COMPRESSION_SUPPORT = Object.freeze({});
const MAX_WORKERS = Math.min(4, Math.max(1, globalThis.navigator?.hardwareConcurrency || 2));

/** Picks the Basis transcoder target format and corresponding linear WebGL compressed format enum, or null for RGBA32. */
export function chooseKtx2Target({ isUastc, width, height, hasAlpha, workerConfig }) {
  const support = workerConfig ?? NO_COMPRESSION_SUPPORT;
  const multipleOfFour = width % 4 === 0 && height % 4 === 0;
  if (isUastc) {
    if (support.astcSupported) return { transcoderFormat: TRANSCODE_ASTC_4X4, glFormat: GL_ASTC_4X4 };
    if (support.bptcSupported) return { transcoderFormat: TRANSCODE_BC7_M5, glFormat: GL_BC7_RGBA };
    if (support.etc2Supported) return { transcoderFormat: hasAlpha ? TRANSCODE_ETC2_RGBA : TRANSCODE_ETC1, glFormat: hasAlpha ? GL_ETC2_RGBA : GL_ETC2_RGB };
    if (support.dxtSupported && multipleOfFour) return { transcoderFormat: hasAlpha ? TRANSCODE_BC3 : TRANSCODE_BC1, glFormat: hasAlpha ? GL_BC3_RGBA : GL_BC1_RGB };
    return { transcoderFormat: TRANSCODE_RGBA32, glFormat: null };
  }
  if (support.etc2Supported) return { transcoderFormat: hasAlpha ? TRANSCODE_ETC2_RGBA : TRANSCODE_ETC1, glFormat: hasAlpha ? GL_ETC2_RGBA : GL_ETC2_RGB };
  if (support.bptcSupported) return { transcoderFormat: TRANSCODE_BC7_M5, glFormat: GL_BC7_RGBA };
  if (support.dxtSupported && multipleOfFour) return { transcoderFormat: hasAlpha ? TRANSCODE_BC3 : TRANSCODE_BC1, glFormat: hasAlpha ? GL_BC3_RGBA : GL_BC1_RGB };
  return { transcoderFormat: TRANSCODE_RGBA32, glFormat: null };
}

/** Transcodes a KTX2 ArrayBuffer using a supplied Basis module to GPU-compressed mip levels or RGBA8 pixel data. */
export function transcodeKtx2Buffer(transcoder, buffer, workerConfig) {
  const file = new transcoder.KTX2File(new Uint8Array(buffer));
  try {
    if (!file.isValid()) throw new Error('Invalid KTX2 texture.');
    if (file.isHDR?.()) throw new Error('HDR KTX2 textures are not supported.');
    const width = file.getWidth();
    const height = file.getHeight();
    const levelCount = file.getLevels();
    if (width < 1 || height < 1 || levelCount < 1) throw new Error('Invalid KTX2 texture dimensions.');
    const isUastc = Boolean(file.isUASTC?.());
    const isEtc1s = Boolean(file.isETC1S?.());
    if (!isUastc && !isEtc1s) throw new Error('Unsupported Basis KTX2 encoding.');
    if (!file.startTranscoding()) throw new Error('KTX2 transcoder could not start.');
    const hasAlpha = Boolean(file.getHasAlpha?.());
    const { transcoderFormat, glFormat } = chooseKtx2Target({ isUastc, width, height, hasAlpha, workerConfig });
    if (glFormat === null) {
      const pixels = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, TRANSCODE_RGBA32));
      if (!file.transcodeImage(pixels, 0, 0, 0, TRANSCODE_RGBA32, 0, -1, -1)) {
        throw new Error('KTX2 transcode to RGBA8 failed.');
      }
      return { isCompressedTexture: false, image: { width, height, data: pixels }, dispose() {} };
    }
    const mipmaps = [];
    for (let mip = 0; mip < levelCount; mip++) {
      const levelInfo = file.getImageLevelInfo(mip, 0, 0);
      const data = new Uint8Array(file.getImageTranscodedSizeInBytes(mip, 0, 0, transcoderFormat));
      if (!file.transcodeImage(data, mip, 0, 0, transcoderFormat, 0, -1, -1)) {
        throw new Error(`KTX2 transcode failed at mip level ${mip}.`);
      }
      mipmaps.push({ width: levelInfo.origWidth, height: levelInfo.origHeight, data });
    }
    return { isCompressedTexture: true, format: glFormat, mipmaps, dispose() {} };
  } finally {
    file.close();
    file.delete();
  }
}

const workerPool = [];
let nextRequestId = 1;
let cachedWorkerConfig = null;

function createKtx2WorkerSlot() {
  const worker = new Worker('/vendor/ktx2-worker.js');
  const pending = new Map();
  const slot = { worker, pending };
  worker.onmessage = ({ data: { id, result, error } }) => {
    const callbacks = pending.get(id);
    if (!callbacks) return;
    pending.delete(id);
    if (error) callbacks.reject(new Error(error));
    else callbacks.resolve({ ...result, dispose() {} });
  };
  worker.onerror = event => {
    const index = workerPool.indexOf(slot);
    if (index >= 0) workerPool.splice(index, 1);
    const failure = new Error(event?.message || 'KTX2 worker failed to load.');
    for (const callbacks of pending.values()) callbacks.reject(failure);
    pending.clear();
    worker.terminate();
  };
  return slot;
}

function acquireKtx2WorkerSlot() {
  const idle = workerPool.find(slot => slot.pending.size === 0);
  if (idle) return idle;
  if (workerPool.length < MAX_WORKERS) {
    const created = createKtx2WorkerSlot();
    workerPool.push(created);
    return created;
  }
  return workerPool.reduce((best, slot) => (slot.pending.size < best.pending.size ? slot : best));
}

function transcodeWithWorker(buffer, workerConfig) {
  return new Promise((resolve, reject) => {
    const slot = acquireKtx2WorkerSlot();
    const id = nextRequestId++;
    slot.pending.set(id, { resolve, reject });
    slot.worker.postMessage({ id, buffer, workerConfig }, [buffer]);
  });
}

function probeKtx2WorkerConfig() {
  if (cachedWorkerConfig) return cachedWorkerConfig;
  const probe = typeof globalThis.document?.createElement === 'function' ? globalThis.document.createElement('canvas') : null;
  const gl = probe?.getContext?.('webgl2') ?? null;
  if (!gl) return NO_COMPRESSION_SUPPORT;
  cachedWorkerConfig = ktx2WorkerConfigFor(gl);
  gl.getExtension?.('WEBGL_lose_context')?.loseContext();
  return cachedWorkerConfig;
}

/** Creates a decoder object matching parseGltf's options.decoders.ktx2 interface for the preview browser page. */
export function createPreviewKtx2Decoder({ preferRgba = false, loadTranscoder, probeConfig = probeKtx2WorkerConfig } = {}) {
  const workerConfig = preferRgba ? NO_COMPRESSION_SUPPORT : probeConfig();
  return {
    workerConfig,
    parse(buffer, onLoad, onError) {
      if (loadTranscoder) {
        loadTranscoder()
          .then(transcoder => transcodeKtx2Buffer(transcoder, buffer, workerConfig))
          .then(onLoad, onError);
        return;
      }
      transcodeWithWorker(buffer, workerConfig).then(onLoad, onError);
    },
  };
}
