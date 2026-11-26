import { invalidField } from './field-error.js';

export function recipeUsesVisibility(recipe) {
  return recipe.nodes.some(node => node.visible !== undefined) || Boolean(recipe.motion?.tracks?.some(track => track.kind === 'node' && track.property === 'visible'));
}

/** Node IDs a node opacity track fades: each tracked node and everything under it. Empty when no track animates opacity. */
export function opacityNodeIds(recipe) {
  const tracked = new Set((recipe.motion?.tracks ?? []).filter(track => track.kind === 'node' && track.property === 'opacity').map(track => track.id));
  if (tracked.size === 0) return tracked;
  const byId = new Map(recipe.nodes.map(node => [node.id, node]));
  const faded = new Set();
  for (const node of recipe.nodes) {
    for (let cursor = node, depth = 0; cursor && depth < 256; cursor = byId.get(cursor.parent), depth++) {
      if (tracked.has(cursor.id)) {
        faded.add(node.id);
        break;
      }
    }
  }
  return faded;
}

/** What each faded node draws at a pose, as a multiple of its material opacity: its own sampled opacity times its parents'. */
export function sampledOpacities(recipe, fadedIds, sampled) {
  const opacities = new Map();
  if (fadedIds.size === 0) return opacities;
  const byId = new Map(recipe.nodes.map(node => [node.id, node]));
  for (const id of fadedIds) {
    let opacity = 1;
    for (let cursor = byId.get(id), depth = 0; cursor && depth < 256; cursor = byId.get(cursor.parent), depth++) {
      opacity *= sampled?.nodes.get(cursor.id)?.opacity ?? 1;
    }
    opacities.set(id, opacity);
  }
  return opacities;
}

const blendedViews = new WeakMap();

// Own live getters, not a prototype link, so a copy of the view (the renderer's spread, a structured clone) keeps every field.
function blendedView(material) {
  const view = {};
  for (const field of Object.keys(material)) Object.defineProperty(view, field, { enumerable: true, configurable: true, get: () => material[field] });
  Object.defineProperty(view, 'alphaMode', { enumerable: true, value: 'blend' });
  return Object.freeze(view);
}

/** The material a faded part draws with: blend and add materials as they are, an opaque one as a blended view. Shared materials stay untouched. */
export function fadeMaterial(material, nodeId) {
  const alphaMode = material.alphaMode ?? 'opaque';
  if (alphaMode === 'blend' || alphaMode === 'add') return material;
  if (alphaMode === 'mask') throw invalidField(`materials.${material.id}.alphaMode`, alphaMode, `opaque or blend, because node "${nodeId}" has an opacity track and a mask cutout is fixed per batch (or animate scale or visible instead)`);
  if (!blendedViews.has(material)) blendedViews.set(material, blendedView(material));
  return blendedViews.get(material);
}

/** Node IDs hidden at a pose: a node set invisible by its field or a sampled track, and everything under it. */
export function hiddenNodeIds(recipe, sampled) {
  const hidden = new Set();
  if (!recipeUsesVisibility(recipe)) return hidden;
  const byId = new Map(recipe.nodes.map(node => [node.id, node]));
  const hiddenOwn = node => {
    const keyed = sampled?.nodes.get(node.id)?.visible;
    return keyed === undefined ? node.visible === false : keyed < 0.5;
  };
  for (const node of recipe.nodes) {
    for (let cursor = node, depth = 0; cursor && depth < 256; cursor = byId.get(cursor.parent), depth++) {
      if (hiddenOwn(cursor)) {
        hidden.add(node.id);
        break;
      }
    }
  }
  return hidden;
}
