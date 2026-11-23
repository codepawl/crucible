// What `scene_export_glb` leaves out of the file, as plain strings an agent reads before it ships the GLB.
// A leaf module: the MCP server bundle and the preview page both import it.

/** The node track properties the exported clip carries. */
export const BAKED_NODE_PROPERTIES = Object.freeze(['translation', 'rotation', 'scale']);

/** What the GLB carries and drops, served by scene_capabilities topic export. */
export const GLB_EXPORT_NOTES = Object.freeze({
  writes: [
    'Meshes in their current pose (IK, node overrides and motion at motionTime included), materials, pattern and imported textures, skins and morph weights.',
    'Motion tracks of node translation, rotation and scale, and of bones, as one clip named motion baked at 30 frames a second (up to 901 keys and 128 moving parts; a part under a moved group moves with it). Pass motionTime for one pose without a clip.',
    'The camera (a glTF perspective camera at its current pose) and the point and spot lights (KHR_lights_punctual, which scene_asset_catalog reads back).',
    'With clip on an imported asset: that source clip (translation, rotation, scale and morph weights).',
  ],
  drops: [
    'Motion tracks of node visible and opacity, material, morph, camera, light, sky and effects. The file holds their current pose.',
    'Area lights, the sun, sky, fog and effects.',
  ],
  result: 'The result lists each authored thing left out in omitted, such as "motion tracks (3: camera 1, material 1, node 1)" or "area lights (2)". An empty omitted list means nothing authored was dropped.',
});

function trackCountsByKind(tracks) {
  const counts = new Map();
  for (const track of tracks) counts.set(track.kind, (counts.get(track.kind) ?? 0) + 1);
  return [...counts].sort(([first], [second]) => first.localeCompare(second)).map(([kind, count]) => `${kind} ${count}`);
}

/**
 * Lists the authored things a GLB export did not write.
 * `written` says what it did write: `boneIds` (nodes whose tracks the rig clip baked), `nodeTracks` (the node translation,
 * rotation and scale tracks baked into the clip), `camera` and `lights` (point and spot lights).
 */
export function omittedFromGlb(recipe, { boneIds = [], nodeTracks = false, camera = false, lights = false } = {}) {
  const bones = new Set(boneIds);
  const omitted = [];
  const tracks = (recipe.motion?.tracks ?? []).filter(track => !(track.kind === 'node'
    && (bones.has(track.id) || (nodeTracks && BAKED_NODE_PROPERTIES.includes(track.property)))));
  if (tracks.length) omitted.push(`motion tracks (${tracks.length}: ${trackCountsByKind(tracks).join(', ')})`);
  if (recipe.camera && !camera) omitted.push('camera');
  const environment = recipe.environment ?? {};
  const areaLightCount = environment.areaLights?.length ?? 0;
  const unwrittenPointAndSpot = lights ? 0 : (environment.pointLights?.length ?? 0) + (environment.spotLights?.length ?? 0);
  if (unwrittenPointAndSpot) omitted.push(`lights (${unwrittenPointAndSpot + areaLightCount})`);
  else if (areaLightCount) omitted.push(`area lights (${areaLightCount})`);
  return omitted;
}
