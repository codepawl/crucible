import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { padded, readGlb, writeGlb } from './agent-glb-io.mjs';

// KTX2 textures through MCP (#1709). The preview page cannot be handed a KTX2 loader by an agent, so the server transcodes
// every KTX2 image of a GLB to a plain PNG as it reads the catalog file, with the Basis Universal transcoder that the optional
// three package ships (three/examples/jsm/libs/basis). The texture then points at the PNG and the extension is dropped.
// three is an optional peer dependency and loads only when a file uses the extension. Only the base mip level is kept.

export const KTX2_EXTENSION = 'KHR_texture_basisu';

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const TRANSCODE_TO_RGBA32 = 13;
const MAXIMUM_IMAGE_PIXELS = 4096 * 4096;
const MAXIMUM_TOTAL_PIXELS = 64 * 1024 * 1024;
const TRANSCODER_SOURCE = 'three/examples/jsm/libs/basis/basis_transcoder.js';
const TRANSCODER_BINARY = 'three/examples/jsm/libs/basis/basis_transcoder.wasm';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const KTX2_MISSING_ADVICE = 'Install the optional transcoder where the MCP server runs (npm install three) and call again, or re-export the GLB with PNG or JPEG textures instead of KTX2.';

/** Whether a glTF document lists the KTX2 texture extension. */
export function usesKtx2(document) {
  return [document?.extensionsUsed, document?.extensionsRequired].some(list => Array.isArray(list) && list.includes(KTX2_EXTENSION));
}

let defaultTranscoderModule = null;

function evaluateTranscoder(require) {
  const sourcePath = require.resolve(TRANSCODER_SOURCE);
  const source = readFileSync(sourcePath, 'utf8');
  // The file is an Emscripten script that declares a global BASIS factory and has no CommonJS export under three's ESM package.
  const createTranscoder = new Function('require', 'process', '__filename', '__dirname', `${source}\nreturn BASIS;`);
  const factory = createTranscoder(require, process, sourcePath, dirname(sourcePath));
  const wasmBinary = readFileSync(require.resolve(TRANSCODER_BINARY));
  return new Promise(resolve => {
    const transcoder = { wasmBinary, onRuntimeInitialized: () => resolve(transcoder) };
    factory(transcoder);
  }).then(transcoder => {
    transcoder.initializeBasis();
    return transcoder;
  });
}

/** The Basis transcoder module, created once per process. Throws an error that says how to install it when it is missing. */
export function loadDefaultKtx2Transcoder() {
  if (!defaultTranscoderModule) {
    const require = createRequire(import.meta.url);
    try {
      require.resolve(TRANSCODER_SOURCE);
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND' && error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      throw new Error(`This GLB uses ${KTX2_EXTENSION} and the Basis transcoder is not installed. ${KTX2_MISSING_ADVICE}`);
    }
    defaultTranscoderModule = evaluateTranscoder(require);
  }
  return defaultTranscoderModule;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

/** Encodes RGBA8 pixels as a PNG file. */
export function encodeRgbaPng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowBytes = width * 4;
  const scanlines = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row++) {
    Buffer.from(pixels.buffer, pixels.byteOffset + row * rowBytes, rowBytes).copy(scanlines, row * (rowBytes + 1) + 1);
  }
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(scanlines)), pngChunk('IEND', Buffer.alloc(0))]);
}

function isKtx2(bytes) {
  return bytes.length >= 28 && KTX2_IDENTIFIER.every((value, index) => bytes[index] === value);
}

/** Opens and validates one KTX2 image against pixel limits, ready for transcoding. Caller must close and delete `file`. */
function openValidatedKtx2(transcoder, ktx2Bytes, label, budget) {
  const file = new transcoder.KTX2File(new Uint8Array(ktx2Bytes.buffer, ktx2Bytes.byteOffset, ktx2Bytes.byteLength));
  try {
    if (!file.isValid()) throw new Error(`${label}: the KTX2 file is not valid. Re-export it.`);
    const width = file.getWidth();
    const height = file.getHeight();
    if (file.isHDR?.()) throw new Error(`${label}: HDR KTX2 textures are not supported. Re-export the texture as PNG or JPEG.`);
    if (width < 1 || height < 1 || width * height > MAXIMUM_IMAGE_PIXELS) {
      throw new Error(`${label}: the KTX2 image is ${width}x${height}; the limit is ${MAXIMUM_IMAGE_PIXELS} pixels (4096x4096). Resize the texture.`);
    }
    budget.pixels += width * height;
    if (budget.pixels > MAXIMUM_TOTAL_PIXELS) throw new Error(`${label}: the KTX2 textures of this GLB reach more than ${MAXIMUM_TOTAL_PIXELS} pixels together. Resize them.`);
    if (!file.startTranscoding()) throw new Error(`${label}: the KTX2 transcoder could not start. The file may be damaged; re-export it.`);
    return { file, width, height };
  } catch (error) {
    file.close();
    file.delete();
    throw error;
  }
}

function validateKtx2Image(transcoder, ktx2Bytes, label, budget) {
  const { file } = openValidatedKtx2(transcoder, ktx2Bytes, label, budget);
  file.close();
  file.delete();
}

/** Transcodes the base level of one KTX2 file to RGBA8 pixels. `budget.pixels` counts what the file has decoded so far. */
function transcodeToPng(transcoder, ktx2Bytes, label, budget) {
  const { file, width, height } = openValidatedKtx2(transcoder, ktx2Bytes, label, budget);
  try {
    const pixels = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, TRANSCODE_TO_RGBA32));
    if (!file.transcodeImage(pixels, 0, 0, 0, TRANSCODE_TO_RGBA32, 0, -1, -1)) {
      throw new Error(`${label}: the KTX2 transcoder could not decode the image. The file may be damaged; re-export it.`);
    }
    return encodeRgbaPng(width, height, pixels);
  } finally {
    file.close();
    file.delete();
  }
}

function withoutKtx2Extension(list) {
  if (!Array.isArray(list)) return list;
  const kept = list.filter(name => name !== KTX2_EXTENSION);
  return kept.length ? kept : undefined;
}

function imageBytesOf(image, document, binary, label) {
  const view = document.bufferViews?.[image?.bufferView];
  if (!view || (view.buffer ?? 0) !== 0) throw new Error(`${label}: a KTX2 image must sit in the GLB's binary chunk.`);
  const start = view.byteOffset ?? 0;
  if (start + view.byteLength > binary.length) throw new Error(`${label}: the image bufferView runs past the binary chunk.`);
  return binary.subarray(start, start + view.byteLength);
}

/**
 * Returns the GLB with every KTX2 image transcoded to PNG in place, every texture's KHR_texture_basisu extension removed and
 * the extension dropped from the lists. The KTX2 bytes stay in the binary chunk, unreferenced. `loadTranscoder` returns the
 * Basis transcoder module.
 */
export async function transcodeKtx2Glb(bytes, { filename = 'GLB', loadTranscoder = loadDefaultKtx2Transcoder } = {}) {
  const { document, binary } = readGlb(bytes, 'A KTX2 GLB');
  const transcoder = await loadTranscoder();
  const chunks = [padded(Buffer.from(binary), 0)];
  let size = chunks[0].length;
  const budget = { pixels: 0 };
  const replaced = new Set();
  for (const [textureIndex, texture] of (document.textures ?? []).entries()) {
    const extension = texture.extensions?.[KTX2_EXTENSION];
    if (!extension) continue;
    const label = `${filename} texture ${textureIndex}`;
    const imageIndex = extension.source;
    const image = document.images?.[imageIndex];
    if (!image) throw new Error(`${label}: ${KTX2_EXTENSION} points at image ${imageIndex}, which does not exist.`);
    if (!replaced.has(imageIndex)) {
      const ktx2Bytes = imageBytesOf(image, document, binary, label);
      if (!isKtx2(ktx2Bytes)) throw new Error(`${label}: image ${imageIndex} is not a KTX2 file.`);
      const png = transcodeToPng(transcoder, ktx2Bytes, label, budget);
      document.bufferViews.push({ buffer: 0, byteOffset: size, byteLength: png.length });
      image.bufferView = document.bufferViews.length - 1;
      image.mimeType = 'image/png';
      const chunk = padded(png, 0);
      chunks.push(chunk);
      size += chunk.length;
      replaced.add(imageIndex);
    }
    texture.source = imageIndex;
    delete texture.extensions[KTX2_EXTENSION];
    if (Object.keys(texture.extensions).length === 0) delete texture.extensions;
  }
  for (const listName of ['extensionsUsed', 'extensionsRequired']) {
    const kept = withoutKtx2Extension(document[listName]);
    if (kept === undefined) delete document[listName];
    else document[listName] = kept;
  }
  document.buffers[0].byteLength = size;
  return { bytes: writeGlb(document, Buffer.concat(chunks)), images: replaced.size };
}

/** Validates every KTX2 image in a GLB against the Basis transcoder and pixel budgets without rewriting the GLB. */
export async function validateKtx2Glb(bytes, { filename = 'GLB', loadTranscoder = loadDefaultKtx2Transcoder } = {}) {
  const { document, binary } = readGlb(bytes, 'A KTX2 GLB');
  const transcoder = await loadTranscoder();
  const budget = { pixels: 0 };
  const validated = new Set();
  for (const [textureIndex, texture] of (document.textures ?? []).entries()) {
    const extension = texture.extensions?.[KTX2_EXTENSION];
    if (!extension) continue;
    const label = `${filename} texture ${textureIndex}`;
    const imageIndex = extension.source;
    const image = document.images?.[imageIndex];
    if (!image) throw new Error(`${label}: ${KTX2_EXTENSION} points at image ${imageIndex}, which does not exist.`);
    if (validated.has(imageIndex)) continue;
    const ktx2Bytes = imageBytesOf(image, document, binary, label);
    if (!isKtx2(ktx2Bytes)) throw new Error(`${label}: image ${imageIndex} is not a KTX2 file.`);
    validateKtx2Image(transcoder, ktx2Bytes, label, budget);
    validated.add(imageIndex);
  }
  return { images: validated.size };
}
