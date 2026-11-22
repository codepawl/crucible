// Recipes of the #3043 evidence: the boat of scripts/boat-wake-recipe.mjs driving straight on throttle, on swell (wind 14) or
// calm water (wind 1), with bow slam foam on (slamSpeed 1.5) or off. Each returns a recipe and the settings used.
const WORKTREE = 'file:///C:/Users/nxan2/Documents/crucible/.claude/worktrees/w-3043';
const { buildBoatRecipe } = await import(`${WORKTREE}/scripts/boat-wake-recipe.mjs`);

export function slamRecipe({ wind, slam, boatAssetId = null, duration = 6, cameraPath = null }) {
  const recipe = buildBoatRecipe(boatAssetId ?? 'unused', duration);
  if (!boatAssetId) recipe.nodes = recipe.nodes.filter(node => node.id !== 'boat');
  recipe.nodes.find(node => node.id === 'hull').translation = [3, 0, -3];
  const sea = recipe.geometries.find(geometry => geometry.id === 'sea').stack[0];
  sea.windSpeed = wind;
  sea.choppiness = 0.6;
  const boat = recipe.physics.bodies[0].float.boat;
  boat.controls = [{ time: 0, throttle: 1, rudder: 0 }];
  boat.wake = { width: 1.6, strength: 1, height: 0.15, lifetime: 3, ...(slam ? { slamSpeed: 1.5 } : {}) };
  if (cameraPath) {
    const keyframes = offset => cameraPath.map(([x, z], index) => ({ time: index * 0.5, value: [x + offset[0], offset[1], z + offset[2]] }));
    const [eye, target] = recipe.motion.tracks;
    eye.keyframes = keyframes([5, 2.2, -4]);
    target.keyframes = keyframes([0, 0.8, 1.5]);
  }
  return recipe;
}
