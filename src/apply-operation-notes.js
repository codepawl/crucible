// What scene_capabilities topic applyOperations says. scene_apply types these rarely used operations as one shared
// branch to keep its schema small, so their fields live here. The backend checks every field and names the fix.
// It lives apart from agent-scene-capabilities.js, which every agent scene bundle carries; the MCP host adds it.

export const FOLDED_APPLY_OPERATION_NOTES = Object.freeze({
  'bake-motion': '{ nodes [node IDs, 32 at most], start, end, step, tolerance }: samples motion into keyframes. More: topic motionBake.',
  'fracture-node': '{ node, cells 2-64, strength N s, seed, impact [x,y,z], impactRadius, density, friction }: breaks a convex root node into glued physics pieces. More: topic physics.',
  'add-explosion': '{ id, center [x,y,z], size m 0.5-100, ... }: layered blast. More: topic explosion.',
  'apply-transform': '{ node, parts?: ["location", "rotation", "scale"] }: folds location, rotation and scale into the geometry of the node (all three when parts is left out); the node then reads 0, no turn and 1 and looks the same. A shape becomes a mesh; a geometry other nodes share is copied for this node. Refused for a node with children, modifiers, a motion track or an imported file. A negative scale keeps faces outward. More: docs/agent-scene.md.',
  'set-origin': '{ node, to: "geometry" | "bottom" | "point", point?: [x,y,z] }: moves the point the node turns and scales about, in the unscaled space of the object: the middle of its bounds, the middle of its lowest face, or point. Nothing moves on screen; children stay in place.',
  settle: '{ settle: { id, geometry, material, colliders, ... } }: drops parts until they rest. More: topic settle.',
  'set-armatures': '{ armatures: [...] or null }: the same array as recipe.armatures in scene_create, 16 at most. More: topic armatures.',
  'set-physics': '{ physics: {...} or null }: the same object as recipe.physics in scene_create. More: topic physics.',
  'set-cloth': '{ cloth: {...} or null }: the same object as recipe.cloth in scene_create. More: topic cloth.',
  'set-timeline': '{ timeline: {...} or null }: the same object as recipe.timeline in scene_create. More: topic timeline.',
  'set-particles': '{ particles: {...} or null }: the same object as recipe.particles in scene_create. More: topic particles.',
  'set-bake': '{ bake: {...} or null }: the same object as recipe.bake in scene_create. More: topic bake.',
  'set-pixel-grid': '{ pixelGrid: { width, height, pad } or null }: low-res pixel-art render, as recipe.pixelGrid.',
  'set-post-passes': '{ postPasses: [{ name, fragment, uniforms, scale }] or null }: as recipe.postPasses. More: topic postPasses.',
  'set-game': '{ game: {...} or null }: playable setup as plain JSON, never code, as recipe.game. More: topic game.',
  'set-shadow': '{ shadow: { target [x,y,z], extent, distance, near, far, hard } }: directional shadow coverage; only the fields given change.',
  'remove-material': '{ id }: removes a material that no node uses.',
});

export const FOLDED_APPLY_OPERATION_TYPES = Object.freeze(Object.keys(FOLDED_APPLY_OPERATION_NOTES));
