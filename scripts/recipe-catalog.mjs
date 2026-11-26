// The recipes of the site's /recipes.html: one scene recipe per rendering technique, kept as JSON in public/recipes/ so a reader can
// fetch it from the site and the picture on the page is drawn from the same bytes the page shows. A recipe file is the finished
// scene. A `<slug>.before.json` file, where a page has one, holds the `environment` fields that undo the technique; the "before"
// picture is the recipe with those fields merged into its environment, which is what a `scene_apply` `set-environment` call does.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const recipesFolder = fileURLToPath(new URL('../public/recipes/', import.meta.url));

export const RECIPES = [
  {
    slug: 'hdri-lighting',
    title: 'HDRI lighting against a flat key light',
    summary: 'A metal kettle lit by one key light and flat ambient, then by a studio HDRI.',
    why: [
      'Metal shows what is around it. With one light and flat ambient there is nothing to reflect, so steel reads as grey plastic.',
      'An HDRI gives the metal a room to reflect: soft boxes, a bright window, a dark floor. Set the key light to 0, because the HDRI already carries the light.',
    ],
    frames: [
      { id: 'before', label: 'Flat key and ambient', time: 0 },
      { id: 'after', label: 'studio-softbox HDRI', time: 0 },
    ],
  },
  {
    slug: 'view-transform',
    title: 'View transform: ACES against AgX on a warm lamp',
    summary: 'The same lamp, the same light, two display curves.',
    why: [
      'The view transform turns scene light into the pixels on screen. ACES pushes the bright orange of the bulb toward yellow and adds contrast. AgX keeps the shade orange and rolls the bulb off to a warm white.',
      'Pick it on purpose: ACES is the default, AgX suits lit scenes and matches Blender, neutral keeps product colours as authored.',
    ],
    frames: [
      { id: 'before', label: 'ACES', time: 0 },
      { id: 'after', label: 'AgX', time: 0 },
    ],
  },
  {
    slug: 'dolly-zoom',
    title: 'Field of view: a dolly zoom from FOV 75 to FOV 20',
    summary: 'The figure keeps its size while the room behind it changes shape.',
    why: [
      'A wide lens up close and a long lens far away frame the subject the same, but the background does not agree: the colonnade is stretched at FOV 75 and squeezed flat at FOV 20.',
      'Two camera tracks do it. One animates the FOV. The other moves the camera back to distance 1.35 / tan(FOV / 2) from the figure, so the frame always covers 2.7 m at the figure and the figure keeps its size.',
    ],
    clip: { duration: 4.8, fps: 30 },
    frames: [
      { id: 'before', label: 'FOV 75', time: 0 },
      { id: 'after', label: 'FOV 20', time: 4.8 },
    ],
  },
  {
    slug: 'cumulus-towers',
    title: 'Cumulus towers: procedural cloud lobes over ocean waves',
    summary: 'Three seeded cloud meshes with soft lobes and a six-step cool-to-warm toon ramp over an ocean mesh.',
    why: [
      'Each cloud is a declarative cloud geometry with three nested levels of soft lobes and a flat base, seeded separately so the three towers read as distinct shapes.',
      'A six-step toon ramp shifts shadows cool blue-grey and highlights warm cream under a physical sky.',
    ],
    frames: [
      { id: 'still', label: 'Cumulus towers', image: '/recipes/cumulus-towers.webp', time: 0 },
    ],
  },
];

export function loadRecipe(slug) {
  return JSON.parse(readFileSync(`${recipesFolder}${slug}.json`, 'utf8'));
}

export function recipeSource(slug) {
  return readFileSync(`${recipesFolder}${slug}.json`, 'utf8').trimEnd();
}

export function beforeSource(slug) {
  try {
    return readFileSync(`${recipesFolder}${slug}.before.json`, 'utf8').trimEnd();
  } catch {
    return null;
  }
}

/** The recipe a frame is drawn from: the finished scene, or the scene with its before environment fields merged in. */
export function recipeForFrame(slug, frameId) {
  const recipe = loadRecipe(slug);
  const before = beforeSource(slug);
  if (frameId !== 'before' || !before) return recipe;
  return { ...recipe, environment: { ...recipe.environment, ...JSON.parse(before) } };
}
