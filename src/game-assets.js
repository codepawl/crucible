import { parseGltf } from './gltf.js';
import { agentAssetDecodeOptions } from './agent-asset-limits.js';
import { assetCopyKey, recipeAssetNeeds } from './agent-scene-assets.js';
import { sequenceFrameIds } from './agent-texture-sequence.js';
import { decodeCatalogImage } from './decode-catalog-image.js';
import { TEXTURE_SEQUENCE_LIMITS } from './texture-sequence-limits.js';

// The catalog assets a game recipe places or retargets clips from, decoded for startGame. The web export writes each asset
// as assets/<id>.glb and tells the page its URL (images the materials read too, see loadGameImages); this file fetches and decodes them, one decoded copy per copy the scene needs.

export const GAME_ASSET_LIMITS = Object.freeze({ maxAssets: 16, maxCopiesPerAsset: 18 });
const ASSET_ID = /^[a-f0-9]{64}$/;

/** The ids of every catalog asset the game needs: the placed ones and the sources of its animation clips. */
export function gameAssetIds(recipe) {
  const ids = new Set(recipeAssetNeeds(recipe).map(need => need.id));
  const npcs = Array.isArray(recipe.game?.npcs) ? recipe.game.npcs : [];
  const animations = [recipe.game?.player?.animation, ...npcs.map(npc => npc?.animation)];
  for (const animation of animations) {
    for (const clip of Object.values(animation?.clips ?? {})) {
      const id = clip?.from?.asset;
      if (typeof id === 'string' && ASSET_ID.test(id)) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Fetch and decode the assets of a recipe. `assetUrls` maps an asset id to the URL of its GLB; `fetchBytes(url)` returns an
 * ArrayBuffer (the global fetch by default). Returns the Map that createAgentScene takes, keyed by assetCopyKey(id, copy).
 */
export async function loadGameAssets(recipe, assetUrls, fetchBytes = defaultFetchBytes) {
  const ids = gameAssetIds(recipe);
  if (ids.length > GAME_ASSET_LIMITS.maxAssets) {
    throw new RangeError(`This game uses ${ids.length} catalog assets; the limit is ${GAME_ASSET_LIMITS.maxAssets}.`);
  }
  const copiesById = new Map(recipeAssetNeeds(recipe).map(need => [need.id, need.copies]));
  // Checked before any download: past the limit the scene would fail later with "copy N is not loaded" (#2403).
  for (const [id, copies] of copiesById) {
    if (copies <= GAME_ASSET_LIMITS.maxCopiesPerAsset) continue;
    throw new RangeError(`The game's asset ${id.slice(0, 12)} needs ${copies} decoded copies (one for the still placements and one for each of its ${copies - 1} animated, driven or posed placements); a game loads at most ${GAME_ASSET_LIMITS.maxCopiesPerAsset}. Animate at most ${GAME_ASSET_LIMITS.maxCopiesPerAsset - 1} placements of it.`);
  }
  const assets = new Map();
  for (const id of ids) {
    const url = assetUrls?.[id];
    if (typeof url !== 'string') {
      throw new RangeError(`The game places or retargets from asset ${id.slice(0, 12)}, but assetUrls has no URL for it. Export the game again with the web export, which writes assets/<id>.glb.`);
    }
    const bytes = await fetchBytes(url);
    const copies = copiesById.get(id) ?? 1;
    for (let copy = 0; copy < copies; copy++) {
      assets.set(assetCopyKey(id, copy), await parseGltf(bytes.slice(0), agentAssetDecodeOptions()));
    }
  }
  return assets;
}

async function defaultFetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}.`);
  return response.arrayBuffer();
}

export const GAME_IMAGE_LIMITS = Object.freeze({ maxImages: 64 });

/** The ids of the catalog images the game's materials read: material graph `image` nodes and map sequence frames. */
export function gameImageIds(recipe) {
  return sequenceFrameIds(recipe);
}

/**
 * Fetch and decode the catalog images of a recipe, the way the MCP preview does before it creates the scene. `imageUrls` maps an
 * image id to its URL. Returns the Map of decoded pixels that createAgentScene takes as `sequenceFrames`.
 */
export async function loadGameImages(recipe, imageUrls, fetchBytes = defaultFetchBytes, decode = decodeCatalogImage) {
  const ids = gameImageIds(recipe);
  if (ids.length > GAME_IMAGE_LIMITS.maxImages) {
    throw new RangeError(`This game uses ${ids.length} catalog images; the limit is ${GAME_IMAGE_LIMITS.maxImages}.`);
  }
  const images = new Map();
  let decodedBytes = 0;
  for (const id of ids) {
    const url = imageUrls?.[id];
    if (typeof url !== 'string') {
      throw new RangeError(`A material reads the catalog image ${id.slice(0, 12)}, but imageUrls has no URL for it. Export the game again with the web export, which writes assets/<id> for each image.`);
    }
    const frame = await decode(id, new Uint8Array(await fetchBytes(url)));
    decodedBytes += frame.data.length;
    if (decodedBytes > TEXTURE_SEQUENCE_LIMITS.maxDecodedBytes) {
      throw new RangeError(`The game's images decode to more than ${TEXTURE_SEQUENCE_LIMITS.maxDecodedBytes / 1048576} MiB. Use fewer or smaller images.`);
    }
    images.set(id, frame);
  }
  return images;
}
