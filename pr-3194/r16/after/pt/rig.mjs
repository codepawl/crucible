// The r10 rig: one big asphalt slab, a dark wall and a thin dark pole behind the hero puddle, open sky over the other half.
// The puddle centre comes from the JS port of the shader noise (the deepest basin point in the window ahead of the camera).
import { textureIds, facadeIds } from './scene-assets.mjs';
import { wetBasin } from 'file:///C:/Users/nxan2/Documents/crucible/.claude/worktrees/w-2874/tests/support/wetness-noise-port.mjs';

function deepestBasinPoint(minimumX, maximumX, minimumZ, maximumZ) {
  let best = { x: 0, z: 0, value: -Infinity };
  for (let x = minimumX; x <= maximumX; x += 0.1) {
    for (let z = minimumZ; z <= maximumZ; z += 0.1) {
      let sum = 0;
      let samples = 0;
      for (let offsetX = -0.8; offsetX <= 0.8; offsetX += 0.4) {
        for (let offsetZ = -0.8; offsetZ <= 0.8; offsetZ += 0.4) {
          sum += wetBasin(x + offsetX, z + offsetZ);
          samples++;
        }
      }
      if (sum / samples > best.value) best = { x, z, value: sum / samples };
    }
  }
  return best;
}
export const centre = deepestBasinPoint(-15, 15, -25, -5);
const { x: centreX, z: centreZ } = centre;

// Round 12: the road is one real CC0 scan (ambientCG Asphalt025A) dry and wet alike; legacyScene keeps the procedural road of rounds 8 to 11 for the dry-hash guard.
const legacyAsphalt = { id: 'asphalt', color: [0.12, 0.12, 0.13], roughness: 0.95, pattern: { type: 'concrete', size: 3, bump: 0.2, seed: 4 } };
const asphalt = { id: 'asphalt', color: [1, 1, 1], roughness: 1, colorMap: textureIds.color, normalMap: textureIds.normal, roughnessMap: textureIds.roughness, worldScale: 1.5 };
export const baseScene = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'slab', type: 'box', bevel: 0 }, { id: 'post', type: 'cylinder' }, { id: 'ball', type: 'sphere' }],
  materials: [
    asphalt,
    { id: 'darkwall', color: [0.04, 0.04, 0.045], roughness: 0.9 },
    // Round 16: the wall is a real building (ambientCG Facade018A, CC0, colour map lightened 1.8x in linear light, plaster not dark brick): brick and windows. DARKWALL=1 keeps the flat dark wall of rounds 10 to 15 for the hash guard.
    { id: 'facade', color: [1, 1, 1], roughness: 1, colorMap: facadeIds.color, normalMap: facadeIds.normal, roughnessMap: facadeIds.roughness, worldScale: 8 },
    { id: 'pole', color: [0.03, 0.03, 0.03], roughness: 0.6 },
    { id: 'brick', color: [0.45, 0.2, 0.15], roughness: 0.9 },
    { id: 'bark', color: [0.2, 0.12, 0.07], roughness: 0.9 },
    { id: 'leaf', color: [0.08, 0.3, 0.08], roughness: 0.9 },
  ],
  nodes: [
    { id: 'ground', geometry: 'slab', material: 'asphalt', translation: [0, -0.05, 0], scale: [90, 0.1, 90] },
    // The wall stands behind the left third of the puddle only; the rest of it mirrors the open sky.
    { id: 'wall', geometry: 'slab', material: process.env.DARKWALL === '1' ? 'darkwall' : 'facade', translation: [centreX - 9.6, 4, centreZ - 9], scale: [16, 8, 0.4] },
    { id: 'pole', geometry: 'post', material: 'pole', translation: [centreX + 0.9, 1.5, centreZ - 2.5], scale: [0.12, 3, 0.12] },
    { id: 'brick-wall', geometry: 'slab', material: 'brick', translation: [centreX + 6, 2, centreZ - 3], scale: [0.4, 4, 8] },
    { id: 'trunk', geometry: 'post', material: 'bark', translation: [centreX - 4.5, 1.2, centreZ - 1.5], scale: [0.35, 2.4, 0.35] },
    { id: 'crown', geometry: 'ball', material: 'leaf', translation: [centreX - 4.5, 3.4, centreZ - 1.5], scale: [2.6, 2.6, 2.6] },
  ],
};
export const views = {
  hero: { eye: [centreX, 1.6, centreZ + 3.2], target: [centreX, 0, centreZ], fov: 40 },
  steep: { eye: [centreX, 3, centreZ + 1.73], target: [centreX, 0, centreZ], fov: 40 },
  grazing: { eye: [centreX + 0.4, 0.42, centreZ + 9], target: [centreX, 0.15, centreZ - 1], fov: 40 },
  edge: { eye: [centreX + 0.9, 1.6, centreZ + 7], target: [centreX + 0.9, 1.0, centreZ - 2.5], fov: 40 },
  wallcrop: { eye: [centreX + 2, 1.6, centreZ + 4], target: [centreX + 6, 2, centreZ - 3], fov: 40 },
  crowncrop: { eye: [centreX - 4.5, 1.8, centreZ + 4.5], target: [centreX - 4.5, 3.4, centreZ - 1.5], fov: 40 },
};
export const sun = rotation => ({ setup: 'daylight', world: true, environmentIntensity: 1, keyIntensity: 1.5, sky: { type: 'physical', sunElevation: 16, sunRotation: rotation } });
export function wetEnvironment(sunRotation, wetness, coverage = 0.5, puddles = true) {
  if (wetness <= 0) return sun(sunRotation);
  return { ...sun(sunRotation), wetness, ...(puddles ? { puddles: { coverage, from: 'height' } } : {}) };
}
export const recipeFor = (view, environment, scene = baseScene) => ({ ...scene, camera: views[view], environment });

// The legacy scene is exactly the round 8 to 11 scene: procedural road and the wall where it stood (its dry pixel hash must stay e550c60a0ef2519f).
const legacyWall = { ...baseScene.nodes[1], material: 'darkwall', translation: [centreX - 8.3, 4, centreZ - 9] };
export const legacyScene = { ...baseScene, materials: baseScene.materials.map(material => (material.id === 'asphalt' ? legacyAsphalt : material)), nodes: baseScene.nodes.map(node => (node.id === 'wall' ? legacyWall : node)) };
// A tree crown against open sky behind the puddle: no wall, no pole.
const crownBlobs = [[0, 4.6, 0, 3.2], [-1.3, 4.1, 0.5, 2.4], [1.4, 4.3, -0.4, 2.6], [0.2, 5.5, 0.3, 2.2], [-0.4, 3.7, -0.8, 2.0]];
export const treeScene = {
  ...baseScene,
  geometries: baseScene.geometries,
  nodes: [
    baseScene.nodes[0],
    { id: 'tree-trunk', geometry: 'post', material: 'bark', translation: [centreX + 0.6, 1.6, centreZ - 3.6], scale: [0.45, 3.2, 0.45] },
    ...crownBlobs.map(([x, y, z, size], index) => ({ id: 'tree-crown-' + index, geometry: 'ball', material: 'leaf', translation: [centreX + 0.6 + x, y, centreZ - 3.6 + z], scale: [size, size, size] })),
  ],
};
views['hero-tree'] = { eye: [centreX, 1.6, centreZ + 3.2], target: [centreX, 0.4, centreZ], fov: 40 };
views['hero-clouds'] = views.hero;
export const cloudsEnvironment = (wetness, coverage = 0.5) => ({ setup: 'daylight', world: true, hdri: 'sky-clouds', environmentIntensity: 1, keyIntensity: 0, wetness, puddles: { coverage, from: 'height' } });
// Round 14 diagnostic views: the sky above the same hero camera, and a look up at the tree crown from underneath.
views['hero-sky'] = { eye: [centreX, 1.6, centreZ + 3.2], target: [centreX, 1.6 + 3.2 * Math.tan((15 * Math.PI) / 180), centreZ], fov: 40 };
views['tree-under'] = { eye: [centreX + 0.6, 1.5, centreZ - 0.6], target: [centreX + 0.6, 4.2, centreZ - 3.6], fov: 40 };
// Round 14: a low eye (0.6 m) and a farther puddle (the same basin seen from 4.2 m), where water mirrors much more of the sky (Fresnel), as in the reference photo.
views['hero-low'] = { eye: [centreX, 0.6, centreZ + 4.2], target: [centreX, 0.1, centreZ], fov: 40 };
