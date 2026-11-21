import { createHash } from 'node:crypto';
import { open, readdir, realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { clipDisplayName } from '../src/clip-name.js';
import { AGENT_ASSET_LIMITS, assetBytesLimitMessage } from '../src/agent-asset-limits.js';
import { MAXIMUM_CATALOG_ENVIRONMENT_BYTES, MAXIMUM_CATALOG_LOOK_BYTES } from '../src/look-catalog.js';
import { imageLimitProblem, readImageDimensions } from '../src/image-header.js';
import { TEXTURE_SEQUENCE_LIMITS } from '../src/texture-sequence-limits.js';
import { decompressDracoGlb, usesDraco } from './agent-draco.mjs';
import { transcodeKtx2Glb, usesKtx2 } from './agent-ktx2.mjs';
import { findSequenceRuns } from './agent-asset-sequences.mjs';

const MAXIMUM_ASSETS = AGENT_ASSET_LIMITS.maxAssets;
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp)$/i;

const IMAGE_EXTENSIONS = { png: /\.png$/i, jpeg: /\.jpe?g$/i, webp: /\.webp$/i };
/**
 * A file the catalog refuses for its size, its pixel bounds or a texture it cannot find (#2072). Listing skips it and says why, so one such file does not hide the
 * others; reading it by name still throws.
 */
export class SkippableCatalogFileError extends RangeError {
  constructor(message) {
    super(message);
    this.name = 'SkippableCatalogFileError';
  }
}

/** 'environment' for a Radiance .hdr and 'look' for a .cube file, by extension and a first-bytes check; the preview decodes them. */
function lookFileKind(filename, bytes) {
  const isHdr = /\.hdr$/i.test(filename);
  const isCube = /\.cube$/i.test(filename);
  if (!isHdr && !isCube) return null;
  const limitBytes = isHdr ? MAXIMUM_CATALOG_ENVIRONMENT_BYTES : MAXIMUM_CATALOG_LOOK_BYTES;
  if (bytes.length > limitBytes) {
    const kindName = isHdr ? 'An .hdr catalog file' : 'A .cube catalog file';
    const advice = isHdr ? 'Use a 2k or smaller HDRI.' : 'Use a smaller LUT, for example 33 points on a side.';
    throw new SkippableCatalogFileError(`${kindName} is at most ${limitBytes / 1048576} MiB; this one is ${(bytes.length / 1048576).toFixed(1)} MiB. ${advice}`);
  }
  if (isHdr) {
    if (!/^#\?(?:RADIANCE|RGBE)/.test(bytes.toString('latin1', 0, 10))) throw new Error('An .hdr catalog file must be a Radiance file starting with #?RADIANCE or #?RGBE.');
    return 'environment';
  }
  if (!bytes.toString('utf8').includes('LUT_3D_SIZE')) throw new Error('A .cube catalog file must be a 3D look (LUT_3D_SIZE).');
  return 'look';
}

const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** 'png', 'jpeg' or 'webp' from the file signature, else null. Catalog images are decoded by the preview, never by the server. */
export function imageKind(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'webp';
  return null;
}

const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;

function glbDocument(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new Error('Asset must be a complete glTF 2.0 binary file.');
  }
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== JSON_CHUNK || jsonLength % 4 !== 0 || jsonLength > bytes.length - 20) {
    throw new Error('GLB must start with a bounded JSON chunk.');
  }
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  if (document.asset?.version !== '2.0') {
    throw new Error('Asset must declare glTF version 2.0.');
  }
  return { document, jsonLength };
}

/** A GLB whose buffers are embedded. Image `uri` fields are allowed here; embedSiblingImages turns them into embedded images. */
function selfContainedGlb(bytes) {
  const parsed = glbDocument(bytes);
  for (const collection of ['buffers', 'images']) {
    const resources = parsed.document[collection];
    if (resources !== undefined && !Array.isArray(resources)) {
      throw new Error(`GLB ${collection} must be an array.`);
    }
    for (const resource of resources ?? []) {
      if (!resource || typeof resource !== 'object') {
        throw new Error(`GLB ${collection} entries must be objects.`);
      }
      if (collection === 'buffers' && Object.hasOwn(resource, 'uri')) {
        throw new Error('Catalog GLBs must embed all buffers; a .bin file next to the GLB is not loaded. Re-export the model as a single .glb.');
      }
    }
  }
  return parsed;
}

/** The path segments of an image beside the GLB, or an error that names the GLB, the URI and what to pass instead. */
function siblingImageSegments(filename, uri) {
  const prefix = `${filename}: image uri "${uri}"`;
  if (typeof uri !== 'string' || !uri || uri.length > 512) {
    throw new Error(`${prefix} must be a relative file path of at most 512 characters, such as "Textures/colormap.png".`);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
    throw new Error(`${prefix} is a remote or embedded address, which the catalog does not fetch. Put the image file next to the GLB and use a relative path, such as "colormap.png", or embed the image in the GLB.`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new Error(`${prefix} is not valid percent-encoding. Use a plain relative path, such as "Textures/colormap.png".`);
  }
  const segments = decoded.split(/[\\/]/);
  if (decoded.startsWith('/') || decoded.startsWith('\\') || /^[a-z]:/i.test(decoded) || segments.includes('..')) {
    throw new Error(`${prefix} leaves the GLB's folder. Copy the image into the folder (or a folder below it) and use a relative path, such as "colormap.png".`);
  }
  return segments.filter(segment => segment && segment !== '.');
}

function padded(buffer, fill) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, fill)]) : buffer;
}

/** Rebuilds the GLB with every image `uri` read from the GLB's folder and stored in the binary chunk, so the stored asset is self-contained. */
async function embedSiblingImages(bytes, parsed, filename, readSibling) {
  const { document, jsonLength } = parsed;
  const binaryStart = 20 + jsonLength;
  const hasBinary = bytes.length >= binaryStart + 8 && bytes.readUInt32LE(binaryStart + 4) === BINARY_CHUNK;
  if (!hasBinary || !Array.isArray(document.buffers) || document.buffers.length === 0) {
    throw new Error(`${filename}: a GLB that points at image files needs a binary chunk to hold them. Re-export it with its mesh data embedded.`);
  }
  const binaryLength = bytes.readUInt32LE(binaryStart);
  const chunks = [padded(bytes.subarray(binaryStart + 8, binaryStart + 8 + binaryLength), 0)];
  let size = chunks[0].length;
  if (!Array.isArray(document.bufferViews)) document.bufferViews = [];
  const embeddedByPath = new Map();
  for (const image of document.images) {
    if (image.uri === undefined) continue;
    const segments = siblingImageSegments(filename, image.uri);
    const key = segments.join('/');
    if (!embeddedByPath.has(key)) {
      const { imageBytes, format } = await readSibling(filename, image.uri, segments);
      const imageChunk = padded(imageBytes, 0);
      const total = bytes.length + (size - binaryLength) + imageChunk.length;
      if (total > AGENT_ASSET_LIMITS.maxBytes) throw new RangeError(`${filename}: with its images next to it the asset reaches ${total} bytes. ${assetBytesLimitMessage(total)}`);
      document.bufferViews.push({ buffer: 0, byteOffset: size, byteLength: imageBytes.length });
      embeddedByPath.set(key, { view: document.bufferViews.length - 1, mimeType: IMAGE_MIME[format] });
      chunks.push(imageChunk);
      size += imageChunk.length;
    }
    const embedded = embeddedByPath.get(key);
    delete image.uri;
    image.bufferView = embedded.view;
    image.mimeType = embedded.mimeType;
  }
  document.buffers[0].byteLength = size;
  const binary = Buffer.concat(chunks);
  const json = padded(Buffer.from(JSON.stringify(document)), 0x20);
  const total = 12 + 8 + json.length + 8 + binary.length;
  const result = Buffer.alloc(total);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(total, 8);
  result.writeUInt32LE(json.length, 12);
  result.writeUInt32LE(JSON_CHUNK, 16);
  json.copy(result, 20);
  const binaryOffset = 20 + json.length;
  result.writeUInt32LE(binary.length, binaryOffset);
  result.writeUInt32LE(BINARY_CHUNK, binaryOffset + 4);
  binary.copy(result, binaryOffset + 8);
  return result;
}

/** One image file below a catalog folder: a regular file, not a link, inside the folder, a real PNG, JPEG or WebP, within the byte bound. */
async function readSiblingImage(directory, glbName, uri, segments) {
  const label = `${glbName}: image "${uri}"`;
  // glTF resolves an image URI against the GLB's own folder, which inside a pack may be a subfolder.
  const path = join(directory, dirname(glbName), ...segments);
  let original;
  try {
    original = await lstat(path);
  } catch {
    throw new SkippableCatalogFileError(`${label} was not found next to the GLB. Copy that file into the GLB's folder at the same relative path.`);
  }
  if (!original.isFile() || original.isSymbolicLink()) throw new Error(`${label} must be a regular file, without links.`);
  const resolved = await realpath(path);
  const offset = relative(directory, resolved);
  if (offset.startsWith(`..${sep}`) || offset === '..' || isAbsolute(offset)) throw new Error(`${label} leaves the GLB's folder. Copy the image into the folder and use a relative path.`);
  if (original.size > AGENT_ASSET_LIMITS.maxBytes) throw new RangeError(`${label}: ${assetBytesLimitMessage(original.size)}`);
  const handle = await open(resolved, 'r');
  try {
    const imageBytes = Buffer.alloc(original.size);
    let position = 0;
    while (position < imageBytes.length) {
      const result = await handle.read(imageBytes, position, imageBytes.length - position, position);
      if (result.bytesRead === 0) throw new Error(`${label} was truncated during reading.`);
      position += result.bytesRead;
    }
    const format = imageKind(imageBytes);
    if (!format) throw new Error(`${label} is not a PNG, JPEG or WebP file. Convert it to one of those.`);
    return { imageBytes, format };
  } finally {
    await handle.close();
  }
}

/**
 * Reads one catalog file (GLB, image, .hdr or .cube) inside a real directory: its bytes, kind and content ID. `filename` may be a
 * relative path with forward slashes. A GLB whose images point at files beside it gets those images embedded, so the ID binds
 * the self-contained bytes. `enforceImageLimits: false` skips the sequence frame pixel limits, for an image that is never a frame.
 */
// The preview page has no Draco decoder, so a compressed GLB is decoded here (#1698). A missing decoder or a mesh that
// grows past the size limit skips the file with the reason, so the catalog lists it instead of failing as a whole.
async function decompressedDraco(bytes, filename) {
  let result;
  try {
    result = await decompressDracoGlb(bytes, { filename });
  } catch (error) {
    throw new SkippableCatalogFileError(`${filename}: ${error.message}`);
  }
  if (result.bytes.length > AGENT_ASSET_LIMITS.maxBytes) {
    throw new SkippableCatalogFileError(`${filename}: decoded from Draco the asset reaches ${result.bytes.length} bytes. ${assetBytesLimitMessage(result.bytes.length)}`);
  }
  return result.bytes;
}

// The preview page has no KTX2 loader, so KHR_texture_basisu images are transcoded to PNG here (#1709), with the same skip rules.
async function transcodedKtx2(bytes, filename) {
  let result;
  try {
    result = await transcodeKtx2Glb(bytes, { filename });
  } catch (error) {
    throw new SkippableCatalogFileError(`${filename}: ${error.message}`);
  }
  if (result.bytes.length > AGENT_ASSET_LIMITS.maxBytes) {
    throw new SkippableCatalogFileError(`${filename}: transcoded from KTX2 the asset reaches ${result.bytes.length} bytes. ${assetBytesLimitMessage(result.bytes.length)}`);
  }
  return result.bytes;
}

export async function readCatalogFile(directory, filename, { enforceImageLimits = true } = {}) {
  const path = join(directory, filename);
  const original = await lstat(path);
  if (!original.isFile() || original.isSymbolicLink()) {
    throw new Error('Catalog assets must be regular files, without links.');
  }
  const resolved = await realpath(path);
  const offset = relative(directory, resolved);
  if (offset.startsWith(`..${sep}`) || offset === '..' || isAbsolute(offset) || offset.split(sep).join('/') !== filename) {
    throw new Error('Asset must remain inside its configured directory.');
  }
  const handle = await open(resolved, 'r');
  try {
    const current = await handle.stat();
    if (current.isFile() && current.size > AGENT_ASSET_LIMITS.maxBytes) {
      throw new RangeError(`${filename}: ${assetBytesLimitMessage(current.size)}`);
    }
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino || current.size < 20) {
      throw new Error('Asset changed during opening or is too small to be a GLB.');
    }
    let bytes = Buffer.alloc(current.size);
    let position = 0;
    while (position < bytes.length) {
      const result = await handle.read(bytes, position, bytes.length - position, position);
      if (result.bytesRead === 0) throw new Error('Asset was truncated during reading.');
      position += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) {
      throw new Error('Asset changed during reading.');
    }
    const lookKind = lookFileKind(filename, bytes);
    const imageFormat = lookKind ? null : imageKind(bytes);
    if (imageFormat && !IMAGE_EXTENSIONS[imageFormat].test(filename)) throw new Error('Image extension must match its PNG, JPEG or WebP content.');
    // The header gives the size, so an oversized frame is refused here, before the preview page decodes its pixels.
    const imageProblem = imageFormat && enforceImageLimits ? imageLimitProblem(bytes, filename, TEXTURE_SEQUENCE_LIMITS, 'Resize it before adding it to the --assets or --packs folder.') : null;
    if (imageProblem) throw new SkippableCatalogFileError(imageProblem);
    if (!imageFormat && !lookKind && !/\.glb$/i.test(filename)) throw new Error('Catalog files must be GLB, PNG, JPEG, WebP, HDR or CUBE, with a matching extension.');
    let document = null;
    if (!imageFormat && !lookKind) {
      const parsed = selfContainedGlb(bytes);
      document = parsed.document;
      if (document.images?.some(image => Object.hasOwn(image, 'uri'))) {
        const readSibling = (glbName, uri, segments) => readSiblingImage(directory, glbName, uri, segments);
        bytes = await embedSiblingImages(bytes, parsed, filename, readSibling);
        document = glbDocument(bytes).document;
      }
      if (usesDraco(document)) {
        bytes = await decompressedDraco(bytes, filename);
        document = glbDocument(bytes).document;
      }
      if (usesKtx2(document)) {
        bytes = await transcodedKtx2(bytes, filename);
        document = glbDocument(bytes).document;
      }
    }
    const assetId = createHash('sha256').update(bytes).digest('hex');
    return { bytes, document, assetId, imageFormat, lookKind, kind: lookKind ?? (imageFormat ? 'image' : 'glb') };
  } finally {
    await handle.close();
  }
}

/** The catalog record of a file read by readCatalogFile; `name` is what the agent sees. */
export function describeCatalogFile(name, { bytes, document, assetId, imageFormat, lookKind }) {
  if (lookKind) return Object.freeze({ assetId, name, bytes: bytes.length, kind: lookKind });
  if (imageFormat) return Object.freeze({ assetId, name, bytes: bytes.length, kind: 'image', mimeType: IMAGE_MIME[imageFormat] });
  const animations = document.animations ?? [];
  if (!Array.isArray(animations)) throw new Error('GLB animations must be an array.');
  return Object.freeze({
    assetId, name, bytes: bytes.length, kind: 'glb',
    meshes: document.meshes?.length ?? 0,
    skins: document.skins?.length ?? 0,
    images: document.images?.length ?? 0,
    animationCount: animations.length,
    animationsTruncated: animations.length > 16,
    animations: animations.slice(0, 16).map((animation, index) => ({ index, name: clipDisplayName(animation, index).slice(0, 80) })),
  });
}


/** The catalog record of a collapsed run of numbered images: pattern, first and last frame number, count and frame size. */
async function describeSequenceRun(directory, run, skipped) {
  let first;
  try {
    first = await readCatalogFile(directory, run.names[0]);
  } catch (error) {
    if (!(error instanceof SkippableCatalogFileError)) throw error;
    skipped.push({ name: run.pattern, reason: `first frame ${run.names[0]}: ${error.message}` });
    return null;
  }
  const { width, height } = readImageDimensions(first.bytes);
  return Object.freeze({ kind: 'sequence', name: run.pattern, first: run.first, last: run.last, frames: run.names.length, width, height });
}

const HASH_CONCURRENCY = 16;

/** Reads and hashes every frame of a sequence (a few at a time) and records each in `frameEntries`; returns the IDs in frame order. */
async function hashFrames(sequence, frameEntries) {
  const frameIds = new Array(sequence.names.length);
  let next = 0;
  async function worker() {
    while (next < sequence.names.length) {
      const index = next++;
      const name = sequence.names[index];
      let result;
      try {
        result = await readCatalogFile(sequence.directory, name);
      } catch (error) {
        throw new error.constructor(`${sequence.metadata.name}: frame ${name}: ${error.message}`);
      }
      frameIds[index] = result.assetId;
      if (!frameEntries.has(result.assetId)) frameEntries.set(result.assetId, { directory: sequence.directory, filename: name, metadata: describeCatalogFile(name, result) });
    }
  }
  await Promise.all(Array.from({ length: HASH_CONCURRENCY }, worker));
  return frameIds;
}

/**
 * A cheap summary of the catalog files in `root` (name, size and modification time, no bytes read), so the runtime can tell whether a
 * file was added, removed or rewritten since the catalog was built (#2209). Only the files the catalog lists are looked at, and at
 * most as many as the catalog accepts plus one, so a huge folder costs a bounded number of stats.
 */
export async function fingerprintAssetDirectory(root) {
  let directory;
  let listing;
  try {
    directory = await realpath(root);
    listing = await readdir(directory, { withFileTypes: true });
  } catch {
    // An unreadable folder has no fingerprint; building the catalog reports the real error with its own advice.
    return 'unreadable';
  }
  const names = listing.filter(entry => /\.(glb|png|jpe?g|webp|hdr|cube)$/i.test(entry.name)).map(entry => entry.name).sort();
  const parts = [`${names.length}`];
  for (const name of names.slice(0, MAXIMUM_ASSETS + TEXTURE_SEQUENCE_LIMITS.maxFrames + 1)) {
    const status = await lstat(join(directory, name)).catch(() => null);
    parts.push(`${name}:${status ? `${status.size}:${status.mtimeMs}` : 'gone'}`);
  }
  return parts.join('|');
}

/**
 * Explicit local directory catalog. IDs bind bytes, rather than agent-supplied file paths.
 * `packFiles` adds the validated GLB, image, .hdr and .cube files of installed packs (scripts/agent-packs.mjs),
 * each `{ directory, filename, assetId, metadata }`. With a null root only pack files are listed.
 */
export async function createAgentAssetCatalog(root, packFiles = []) {
  const entries = new Map();
  const skipped = [];
  const sequences = new Map();
  if (root !== null) {
    if (typeof root !== 'string' || !isAbsolute(root)) {
      throw new TypeError('Asset root must be an explicit absolute directory path.');
    }
    const directory = await realpath(root);
    if (!(await lstat(directory)).isDirectory()) {
      throw new TypeError('Asset root must be a directory.');
    }
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => /\.(glb|png|jpe?g|webp|hdr|cube)$/i.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name));
    // Image files are sequence frames, so they have their own cap: a film that changes a texture over time needs thousands.
    const imageFileCount = files.filter(entry => IMAGE_FILE_PATTERN.test(entry.name)).length;
    const otherFileCount = files.length - imageFileCount;
    if (otherFileCount > MAXIMUM_ASSETS) throw new RangeError(`Asset catalog has ${otherFileCount} files other than images, over its maxAssets ${MAXIMUM_ASSETS}. Remove files from the --assets directory.`);
    if (imageFileCount > TEXTURE_SEQUENCE_LIMITS.maxFrames) {
      throw new RangeError(`Asset catalog has ${imageFileCount} image files, over the ${TEXTURE_SEQUENCE_LIMITS.maxFrames} a texture sequence can use. Remove images from the --assets directory.`);
    }
    const runs = findSequenceRuns(files.filter(file => file.isFile() && IMAGE_FILE_PATTERN.test(file.name)).map(file => file.name));
    const collapsedNames = new Set(runs.flatMap(run => run.names));
    for (const file of files.filter(candidate => !collapsedNames.has(candidate.name))) {
      let result;
      try {
        result = await readCatalogFile(directory, file.name);
      } catch (error) {
        if (!(error instanceof SkippableCatalogFileError)) throw error;
        skipped.push({ name: file.name, reason: error.message });
        continue;
      }
      if (entries.has(result.assetId)) continue;
      entries.set(result.assetId, { directory, filename: file.name, metadata: describeCatalogFile(file.name, result) });
    }
    for (const run of runs) {
      const metadata = await describeSequenceRun(directory, run, skipped);
      if (metadata) sequences.set(run.pattern, { directory, names: run.names, metadata, frameIds: null });
    }
  }
  for (const file of packFiles) {
    if (!entries.has(file.assetId)) entries.set(file.assetId, { directory: file.directory, filename: file.filename, metadata: file.metadata });
  }
  // The frames of collapsed sequences are hashed when a recipe names the sequence, or when a pinned frame ID is not known yet
  // (a recipe from an earlier run), never at startup. The IDs go in frameEntries, which list() does not show.
  const frameEntries = new Map();
  const hashing = new Map();
  function hashSequenceFrames(pattern) {
    const sequence = sequences.get(pattern);
    if (sequence.frameIds) return Promise.resolve(sequence.frameIds);
    if (!hashing.has(pattern)) {
      hashing.set(pattern, hashFrames(sequence, frameEntries).then(frameIds => {
        sequence.frameIds = frameIds;
        return frameIds;
      }, error => {
        hashing.delete(pattern);
        throw error;
      }));
    }
    return hashing.get(pattern);
  }
  async function lookupEntry(assetId) {
    const known = entries.get(assetId) ?? frameEntries.get(assetId);
    if (known) return known;
    for (const pattern of sequences.keys()) await hashSequenceFrames(pattern);
    return frameEntries.get(assetId);
  }
  return Object.freeze({
    list() {
      return { assets: structuredClone([...entries.values()].map(entry => entry.metadata)), ...(sequences.size ? { sequences: [...sequences.values()].map(sequence => ({ ...sequence.metadata })) } : {}), maximumBytes: AGENT_ASSET_LIMITS.maxBytes, maximumAssets: MAXIMUM_ASSETS, ...(skipped.length ? { skipped: structuredClone(skipped) } : {}) };
    },
    /**
     * The asset id of the GLB listed under exactly this name (a file in --assets, or `pack/file` for a pack), so a recipe can name
     * a file that is re-exported often. Several GLBs under one name are refused rather than guessed.
     */
    resolveName(name) {
      if (typeof name !== 'string' || !name) {
        throw new TypeError('asset.name must be the file name of a catalog GLB, such as "sheep_body.glb"; scene_asset_catalog lists the names.');
      }
      const glbs = [...entries.entries()].filter(([, entry]) => entry.metadata.kind === 'glb');
      const matches = glbs.filter(([, entry]) => entry.metadata.name === name);
      if (matches.length === 1) return matches[0][0];
      if (matches.length > 1) {
        const ids = matches.map(([assetId]) => assetId.slice(0, 12)).join(', ');
        throw new Error(`${matches.length} catalog GLBs are named "${name}" (ids ${ids}). Pass asset.id with one full id from scene_asset_catalog instead of the name.`);
      }
      const wanted = name.toLowerCase();
      const near = glbs.map(([, entry]) => entry.metadata.name)
        .filter(candidate => candidate.toLowerCase().includes(wanted) || wanted.includes(candidate.toLowerCase())).slice(0, 5);
      const advice = near.length ? `Near names: ${near.map(candidate => `"${candidate}"`).join(', ')}.` : 'Run scene_asset_catalog to list the names.';
      throw new Error(`No catalog GLB is named "${name}". ${advice} A name must match exactly, such as "sheep_body.glb".`);
    },
    /**
     * The frame asset IDs, in frame order, of the sequence listed under exactly this pattern (such as "frame_####.png"), so a
     * recipe can write `map.sequence.catalog` instead of thousands of IDs. The frames are hashed on the first call.
     */
    async resolveSequence(pattern) {
      if (typeof pattern !== 'string' || !sequences.has(pattern)) {
        const near = [...sequences.keys()].filter(candidate => typeof pattern === 'string' && pattern && (candidate.includes(pattern) || pattern.includes(candidate))).slice(0, 5);
        const advice = near.length ? `Near patterns: ${near.map(candidate => `"${candidate}"`).join(', ')}.` : sequences.size ? 'Run scene_asset_catalog and pass the pattern of one of its sequences.' : 'The catalog lists no sequence: a run of more than 64 consecutively numbered images becomes one.';
        throw new RangeError(`map.sequence.catalog must be the pattern of a catalog sequence, such as "frame_####.png"; no sequence matches ${typeof pattern === 'string' ? `"${pattern.slice(0, 80)}"` : String(pattern)}. ${advice}`);
      }
      return [...(await hashSequenceFrames(pattern))];
    },
    /**
     * The length `read` returns, known from the catalog record without loading the file. A GLB whose images sit beside it is
     * larger than its file on disk, because `read` embeds those images.
     */
    async size(assetId) {
      const entry = await lookupEntry(assetId);
      if (!entry) throw new Error(`Unknown asset ID ${String(assetId).slice(0, 12)}. Call scene_asset_catalog and pass an assetId it lists.`);
      return entry.metadata.bytes;
    },
    /** The file name and byte length of an entry, for an error that names the largest assets of a call. */
    async describeSize(assetId) {
      const entry = await lookupEntry(assetId);
      if (!entry) throw new Error(`Unknown asset ID ${String(assetId).slice(0, 12)}. Call scene_asset_catalog and pass an assetId it lists.`);
      return { name: entry.metadata.name, bytes: entry.metadata.bytes };
    },
    async read(assetId) {
      const entry = await lookupEntry(assetId);
      if (!entry) throw new Error(`Unknown asset ID ${String(assetId).slice(0, 12)}. Call scene_asset_catalog and pass an assetId it lists.`);
      const result = await readCatalogFile(entry.directory, entry.filename);
      if (result.assetId !== assetId) throw new Error('Asset bytes changed since catalog creation. Restart the runtime to refresh the catalog.');
      const clipCount = result.document?.animations?.length ?? 0;
      if (clipCount > AGENT_ASSET_LIMITS.maxClips) throw new RangeError(`Asset has ${clipCount} animation clips, over the catalog maxClips ${AGENT_ASSET_LIMITS.maxClips}. Remove clips from the file.`);
      return result.bytes;
    },
  });
}
