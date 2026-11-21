import { gradientSkyFields } from '../src/gradient-sky.js';

function sameVector(first, second) {
  return Array.isArray(first) && first.length === second.length && first.every((component, index) => component === second[index]);
}

/**
 * A gradient sky writes skyTop, skyBottom and fogColor into the recipe as radiance, which is above 1 for a bright stop, and
 * the scene check of a hand-written colour allows 0 to 1 only. A render job or review builds the scene again from the
 * snapshot, so those derived values go back through that check and a bright stop fails (#2820). The sky derives them
 * again on load, so the snapshot leaves them out. A fogColor that differs from the derived one was set beside the sky, and stays.
 */
export function withoutDerivedSkyColors(recipe) {
  const sky = recipe?.environment?.sky;
  if (sky?.type !== 'gradient') {
    return recipe;
  }
  const derived = gradientSkyFields(sky, recipe.environment.viewTransform);
  const { skyTop, skyBottom, fogColor, ...environment } = recipe.environment;
  if (!sameVector(fogColor, derived.fogColor) && fogColor !== undefined) {
    environment.fogColor = fogColor;
  }
  return { ...recipe, environment };
}

/** A snapshot or branch recipe holder with its recipe passed through withoutDerivedSkyColors. */
export function withSnapshotSkyColors(holder) {
  return holder?.recipe ? { ...holder, recipe: withoutDerivedSkyColors(holder.recipe) } : holder;
}
