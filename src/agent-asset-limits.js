// Limits for GLB files an agent imports through the MCP asset catalog. The catalog, the runtime, the preview page and the
// render jobs all read this one object, so the numbers cannot drift apart.
//
// These are tighter than the loadGltf defaults (256 MiB, 8,000,000 vertices) on purpose. The server reads the whole file,
// turns it into a base64 string and hands it to the preview page in one browser call. Measured with a local Chrome:
// 64 MiB and 72 MiB crossed that call (a rise of 128 and 264 MiB in server memory, in 2.7 s and 4.9 s), and 80 MiB and
// above crashed the page. 64 MiB keeps a margin under that ceiling. A scene beyond it loads through loadGltf in code, where the file never
// crosses that call.
const MEBIBYTE = 1024 * 1024;
const DEFAULT_ASSET_BYTES = 64 * MEBIBYTE;
/** Highest value --max-asset-bytes takes: the default loadGltf file limit. From 80 MiB a local Chrome test lost the preview page (measurement above), so a raise is the person's risk. */
export const MAXIMUM_RAISED_ASSET_BYTES = 256 * MEBIBYTE;
let assetByteLimit = DEFAULT_ASSET_BYTES;

export const AGENT_ASSET_LIMITS = Object.freeze({
  // Both byte limits follow one number, the 64 MiB default or what --max-asset-bytes set at startup.
  get maxBytes() { return assetByteLimit; },
  // Catalog index only: how many GLB, BVH, HDR and CUBE files --assets may list. One scene still places at most ASSET_PLACEMENT_LIMITS.maxAssets different ones, so unused variants cost nothing per scene (#2989).
  maxAssets: 256,
  // The same ceiling for the sum of every asset one call hands to the preview page in one browser message (placed assets,
  // motion sources and sequence frames together). Files that are each under maxBytes can still cross the crash size together.
  get maxCombinedBytes() { return assetByteLimit; },
  // About 32 bytes a vertex fills a 64 MiB file with 2,000,000; half of that keeps the decoded copy inside the preview memory budget.
  maxVertices: 1_000_000,
  maxParts: 4096,
  maxTexturePixels: 4_194_304,
  maxJoints: 1024,
  maxClips: 256,
});

/**
 * Raises (or lowers) both byte limits for this process; the server calls it once at startup from --max-asset-bytes. The default stays the measured 64 MiB.
 * Throws a RangeError that names the accepted range when the value is not a whole number of bytes in it.
 */
export function configureAssetByteLimit(bytes) {
  if (!Number.isInteger(bytes) || bytes < MEBIBYTE || bytes > MAXIMUM_RAISED_ASSET_BYTES) {
    throw new RangeError(`--max-asset-bytes must be a whole number of bytes from ${MEBIBYTE} (1 MiB) to ${MAXIMUM_RAISED_ASSET_BYTES} (${describeAssetBytes(MAXIMUM_RAISED_ASSET_BYTES)}), got ${String(bytes)}. The default is ${DEFAULT_ASSET_BYTES} (64 MiB).`);
  }
  assetByteLimit = bytes;
}

/** Back to the 64 MiB default; tests use it to leave no setting behind. */
export function resetAssetByteLimit() {
  assetByteLimit = DEFAULT_ASSET_BYTES;
}

/** The options `parseGltf` takes for a catalog file. An MCP decode fetches no external resource, so a uri in the file never reaches the network. */
export function agentAssetDecodeOptions() {
  const { maxBytes, maxVertices, maxParts, maxTexturePixels, maxJoints } = AGENT_ASSET_LIMITS;
  return { maxBytes, maxVertices, maxParts, maxTexturePixels, maxJoints, allowExternalResources: false };
}

/** "64 MiB" for byte limits, so a message and the docs read the same. */
export function describeAssetBytes(bytes) {
  return bytes % MEBIBYTE === 0 ? `${bytes / MEBIBYTE} MiB` : `${bytes} bytes`;
}

const SHRINK_ADVICE = 'Shrink the largest files: gltf-transform simplify (for example --ratio 0.15), gltf-transform meshopt, or textures at a smaller resolution (1k instead of 4k). On a machine you control, start the server with --max-asset-bytes <bytes> (up to 256 MiB; a local Chrome test lost the preview page from 80 MiB).';

/** "tree.glb 66.0 MiB" */
function describeNamedAsset({ name, bytes }) {
  return `${name} ${(bytes / MEBIBYTE).toFixed(1)} MiB`;
}

/** The biggest few assets of one call, largest first, as a sentence; empty when no name is known (grid files and raw hand-off fields have none). */
export function describeLargestAssets(namedAssets, count = 3) {
  const largest = [...namedAssets].sort((first, second) => second.bytes - first.bytes).slice(0, count);
  return largest.length ? ` Largest: ${largest.map(describeNamedAsset).join(', ')}.` : '';
}

/** Message for a catalog file over its byte limit; it names the limit, the size it hit and the way out. */
export function assetBytesLimitMessage(size) {
  const limit = AGENT_ASSET_LIMITS.maxBytes;
  return `Asset is ${size} bytes, over the catalog maxBytes ${limit} (${describeAssetBytes(limit)}). ${SHRINK_ADVICE} Or split it into parts; a larger scene loads through loadGltf in code.`;
}

/** Message for one call whose assets together pass the combined limit; it names the limit, the total, the largest assets and the way out. */
export function combinedAssetBytesLimitMessage(total, namedAssets = []) {
  const limit = AGENT_ASSET_LIMITS.maxCombinedBytes;
  return `This call sends ${total} bytes of assets to the preview page at once, over the catalog maxCombinedBytes ${limit} (${describeAssetBytes(limit)}).${describeLargestAssets(namedAssets)} Place fewer or smaller assets in one call and add the rest in later calls. ${SHRINK_ADVICE} The frames of one volume grid cannot be split across calls: use fewer frames or convert them with a lower --max-resolution.`;
}

/**
 * Message for a scene whose unique assets pass the combined limit after an edit. A render job, and the page that recovers after it,
 * load every unique asset of the scene at once, so the limit holds for the whole scene and not only for the call that adds the last asset.
 */
export function sceneAssetBytesLimitMessage(total, namedAssets = []) {
  const limit = AGENT_ASSET_LIMITS.maxCombinedBytes;
  return `This edit would make the scene's unique assets ${total} bytes together, over the catalog maxCombinedBytes ${limit} (${describeAssetBytes(limit)}).${describeLargestAssets(namedAssets)} A render job loads all of them at once, so the scene cannot grow past this; an asset placed many times counts once. Remove an asset. ${SHRINK_ADVICE} A larger scene loads through loadGltf in code.`;
}

function decodedBase64Bytes(text) {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor(text.length * 3 / 4) - padding;
}

/** Decoded bytes of every base64 asset field in the input of one preview call. */
export function combinedAssetBytes(input) {
  let total = 0;
  for (const field of ['assetData', 'sequenceData', 'sources']) {
    for (const text of Object.values(input?.[field] ?? {})) {
      if (typeof text === 'string') total += decodedBase64Bytes(text);
    }
  }
  for (const text of Object.values(input?.gridData ?? {})) {
    if (typeof text === 'string') total += decodedBase64Bytes(text);
  }
  for (const entry of Object.values(input?.lookData ?? {})) {
    if (typeof entry?.base64 === 'string') total += decodedBase64Bytes(entry.base64);
    else if (typeof entry?.text === 'string') total += Buffer.byteLength(entry.text);
  }
  if (typeof input?.data === 'string') total += decodedBase64Bytes(input.data);
  return total;
}

/** Throws a RangeError when a byte total passes the combined limit. The runtime calls it with file sizes and the names of the files before it reads any file. */
export function assertCombinedByteTotal(total, describeLimit = combinedAssetBytesLimitMessage, namedAssets = []) {
  if (total > AGENT_ASSET_LIMITS.maxCombinedBytes) throw new RangeError(describeLimit(total, namedAssets));
}

/** Throws a RangeError when the assets in one preview call pass the combined limit. */
export function assertCombinedAssetBytes(input) {
  assertCombinedByteTotal(combinedAssetBytes(input));
}

/**
 * parseGltf tells a code caller to "pass { maxVertices: n }", which an MCP agent cannot do. Swap that advice for the
 * catalog limits and the way out.
 */
export function withCatalogLimitAdvice(error) {
  if (!(error instanceof RangeError) || !/Fix: pass \{[^}]*\}\./.test(error.message)) return error;
  const { maxBytes, maxVertices, maxParts, maxJoints, maxTexturePixels } = AGENT_ASSET_LIMITS;
  const advice = `The MCP catalog limits are maxBytes ${maxBytes}, maxVertices ${maxVertices}, maxParts ${maxParts}, maxJoints ${maxJoints} and maxTexturePixels ${maxTexturePixels}, and an agent cannot raise them. Simplify the asset (fewer vertices, meshopt compression, smaller textures) or load it with loadGltf in code.`;
  return new RangeError(error.message.replace(/Fix: pass \{[^}]*\}\./, advice));
}
