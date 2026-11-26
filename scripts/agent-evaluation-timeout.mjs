// How long one preview call may run before the runtime gives up on it (#1768, #1050, #2896).

/**
 * The first draw of a grid volume compiles the local-volume composite shader in the browser's graphics driver (ANGLE). That took 5 s warm and 15 s
 * after idle on a free GPU, and 23 to 32 s on a loaded one, so a call that adds a grid volume gets this many times a plain call. The compile is the
 * driver's own and cannot be shortened from here.
 */
export const GRID_VOLUME_TIMEOUT_FACTOR = 2;

/**
 * Shared-GPU runs (--gpu-queue) and streamed texture sequences contend for the graphics driver and frame decoder, so calls get extra time before dropping sessions (#3462).
 */
export const SHARED_GPU_TIMEOUT_FACTOR = 2;
export const STREAMED_SEQUENCE_TIMEOUT_FACTOR = 2;

/**
 * Extra time a call gets for each MiB of catalog GLB it hands to the page, which decodes the file, scales its images and uploads them before the
 * first draw. A hero asset with an 8K base colour and two 4K maps (12 MiB) added 2 s on a free GPU and 13 to 70 s on a loaded one (#2896).
 */
export const ASSET_TIMEOUT_MS_PER_MIB = 1500;

/** The most time placed assets can add to one call, so a call stays bounded however large the files are. */
export const MAXIMUM_ASSET_TIMEOUT_MS = 90000;

const MEBIBYTE = 1024 ** 2;

/** True when the recipe's environment holds a local volume of shape "grid". */
export function recipeHasGridVolume(recipe) {
  const volumes = recipe?.environment?.localVolumes;
  return Array.isArray(volumes) && volumes.some(volume => volume?.shape === 'grid');
}

/** True when an apply adds an explosion, whose fireball is a grid volume. */
export function operationsAddGridVolume(operations) {
  return Array.isArray(operations) && operations.some(operation => operation?.type === 'add-explosion');
}

/** Bytes of the files in an assetData map of base64 strings. */
export function assetDataBytes(assetData) {
  let total = 0;
  for (const encoded of Object.values(assetData ?? {})) total += Math.floor(String(encoded).length * 3 / 4);
  return total;
}

/** Bytes of all base64 asset, sequence frame, motion source and volume grid payloads sent to the preview page. */
export function payloadAssetBytes(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  return assetDataBytes(payload.assetData)
    + assetDataBytes(payload.sequenceData)
    + assetDataBytes(payload.sources)
    + assetDataBytes(payload.gridData)
    + (payload.data ? assetDataBytes({ data: payload.data }) : 0);
}

/** The time that assetBytes of placed catalog files add to a call, from 0 up to MAXIMUM_ASSET_TIMEOUT_MS. */
export function assetTimeoutAllowanceMs(assetBytes) {
  return Math.min(MAXIMUM_ASSET_TIMEOUT_MS, Math.ceil(assetBytes / MEBIBYTE * ASSET_TIMEOUT_MS_PER_MIB));
}

/** A bake has its own longer deadline and wins; otherwise grid volume, shared GPU or streamed sequences scale the plain deadline, plus time for catalog files. */
export function previewCallTimeoutMs({ bakes, addsGridVolume, sharedGpu = false, streamedSequence = false, plainTimeoutMs, bakeTimeoutMs, assetBytes = 0 }) {
  if (bakes) return bakeTimeoutMs;
  const factor = Math.max(
    addsGridVolume ? GRID_VOLUME_TIMEOUT_FACTOR : 1,
    sharedGpu ? SHARED_GPU_TIMEOUT_FACTOR : 1,
    streamedSequence ? STREAMED_SEQUENCE_TIMEOUT_FACTOR : 1,
  );
  return factor * plainTimeoutMs + assetTimeoutAllowanceMs(assetBytes);
}

/** The sentence a timed-out call appends: the three largest placed files and what to change. namedAssets is a list of { name, bytes }. */
export function slowAssetsNote(namedAssets) {
  if (!namedAssets.length) return '';
  const largest = [...namedAssets].sort((first, second) => second.bytes - first.bytes).slice(0, 3);
  const listed = largest.map(asset => `${asset.name} (${(asset.bytes / MEBIBYTE).toFixed(1)} MiB)`).join(', ');
  return ` The call placed catalog assets that the page decodes before the first draw, the largest ${listed}. Shrink their textures (8K maps cost the most) or place fewer, then call scene_create again.`;
}
