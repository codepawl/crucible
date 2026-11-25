/**
 * Diagnostics for things that load or validate without error but do not do what the agent probably meant: a material
 * field the renderer ignores, an asset feature that is accepted but not drawn, a rig with nothing to move. Each has a
 * kind, a severity, a target (the material, node or asset it concerns), a message and a fix that names the next action.
 * Reads of an inspected scene include them only when there is something to say, to keep default results small.
 */
import { agentSceneModule } from './agent-scene-modules.js';
import { realismDiagnostics } from './realism-checks.js';

const PLAIN_SURFACE_TAGS = new Set(['surface', 'gltf']);
const LAYER_FIELDS = ['clearcoat', 'sheenColor', 'specular', 'specularColor', 'anisotropy', 'iridescence'];
// The pass that draws transmission is a separate shader without these layers.
const FIELDS_IGNORED_BY_TRANSMISSION = ['anisotropy', 'iridescence'];
// The water tag draws in the standard shader (shaders.js baseReflectance), so its specular layer sets the surface reflectance.
const SPECULAR_FIELDS_READ_ON_WATER = ['specular', 'specularColor'];
const TRANSMISSION_DETAIL_FIELDS = ['thickness', 'attenuationColor', 'attenuationDistance'];

export function diagnostic(kind, severity, target, message, fix) {
  return { kind, severity, target, message, fix };
}

function hasValue(material, field) {
  const value = material[field];
  if (Array.isArray(value)) return value.some(component => component !== 0);
  return typeof value === 'number' && value !== 0;
}

function materialProblems(material) {
  const problems = [];
  const tag = material.tag ?? 'surface';
  const transmitting = hasValue(material, 'transmission');
  if (tag !== 'surface' && tag !== 'liquid') {
    for (const field of LAYER_FIELDS.filter(layer => hasValue(material, layer) && !(tag === 'water' && SPECULAR_FIELDS_READ_ON_WATER.includes(layer)))) {
      problems.push(diagnostic('ignored-material-field', 'warning', material.id,
        `${field} is ignored on a material with tag ${tag}.`,
        `Remove ${field}, or set the material tag to surface with scene_apply set-material.`));
    }
  }
  if (material.heightMap !== undefined && !(material.heightScale > 0)) {
    problems.push(diagnostic('ignored-material-field', 'warning', material.id,
      'heightMap is ignored: heightScale is 0 or missing, so the rasterizer draws no parallax relief from it, and no renderer displaces the mesh.',
      'Set heightScale above 0 (for example 0.02, metres) to draw the relief in the rasterizer, or remove heightMap and rely on normalMap.'));
  }
  if (transmitting) {
    for (const field of FIELDS_IGNORED_BY_TRANSMISSION.filter(layer => hasValue(material, layer))) {
      problems.push(diagnostic('ignored-material-field', 'warning', material.id,
        `${field} is ignored on a transmitting material.`,
        `Set transmission to 0 to see ${field}, or remove ${field}.`));
    }
  } else {
    for (const field of TRANSMISSION_DETAIL_FIELDS.filter(detail => hasValue(material, detail))) {
      problems.push(diagnostic('ignored-material-field', 'warning', material.id,
        `${field} only matters with transmission, and transmission is 0.`,
        `Set transmission above 0 for glass or gems, or remove ${field}.`));
    }
  }
  if (transmitting && (material.alphaMode === 'blend' || material.opacity < 1)) {
    problems.push(diagnostic('transmission-blended', 'warning', material.id,
      'A transmitting material that is also blended does not refract what is behind it.',
      'Set opacity to 1 and alphaMode to opaque for refraction, or drop transmission and keep the blended look.'));
  }
  if (material.pattern && (tag === 'liquid' || tag === 'foam' || tag === 'unlit')) {
    problems.push(diagnostic('ignored-material-field', 'warning', material.id,
      `pattern is not applied to a material with tag ${tag}.`,
      'Move the pattern to a surface material, or remove it.'));
  }
  return problems;
}

// A mesh geometry may cut with another recipe geometry that no node draws (`edits[].cutter.geometry`), and that one with a third.
function geometryIdsInUse({ geometries, nodes }) {
  const inUse = new Set();
  const visit = id => {
    if (id === undefined || inUse.has(id)) return;
    inUse.add(id);
    geometries.find(geometry => geometry.id === id)?.edits?.forEach(edit => visit(edit?.cutter?.geometry));
  };
  nodes.forEach(node => visit(node.geometry));
  return inUse;
}

/** Material and resource diagnostics for a normalized procedural recipe. */
export function recipeDiagnostics(recipe) {
  const problems = recipe.materials.flatMap(materialProblems);
  const usedMaterials = new Set(recipe.nodes.map(node => node.material).filter(Boolean));
  const usedGeometries = geometryIdsInUse(recipe);
  for (const material of recipe.materials.filter(candidate => !usedMaterials.has(candidate.id))) {
    problems.push(diagnostic('unused-material', 'info', material.id,
      `Material ${material.id} is used by no node.`,
      'Assign it to a node with scene_apply set-node, or remove it with remove-material.'));
  }
  for (const geometry of recipe.geometries.filter(candidate => !usedGeometries.has(candidate.id))) {
    problems.push(diagnostic('unused-geometry', 'info', geometry.id,
      `Geometry ${geometry.id} is used by no node, so nothing draws it.`,
      'Add a node that uses it with scene_apply add-node, or remove it with remove-geometry.'));
  }
  problems.push(...recipe.geometries.filter(geometry => geometry.type === 'terrain').flatMap(geometry => agentSceneModule('terrain').terrainHoleDiagnostics(geometry)));
  problems.push(...realismDiagnostics(recipe));
  if (typeof recipe.camera?.roll === 'number' && Math.abs(recipe.camera.roll) > Math.PI) {
    problems.push(diagnostic('camera-roll-range', 'warning', 'camera.roll',
      `camera.roll value ${recipe.camera.roll} exceeds +/-pi; camera roll is in radians, not degrees.`,
      'Convert degrees to radians (degrees * Math.PI / 180) with scene_apply set-camera.'));
  }
  if (recipe.motion) problems.push(...agentSceneModule('motion').cameraRollDiagnostics(recipe));
  problems.push(...portalProblems(recipe.environment?.areaLights ?? []));
  return problems;
}

/** A portal emits nothing in the raster view and the WebGL tracer, so a render there shows no window light. */
function portalProblems(areaLights) {
  return areaLights.flatMap((light, index) => (light.portal === true
    ? [diagnostic('portal-ignored-by-raster', 'info', `environment.areaLights[${index}]`,
      'This portal emits nothing in the raster view and the WebGL tracer.',
      'Render with Cook, the CPU tracer or the WebGPU tracer, or remove portal for an emitting panel.')]
    : []));
}

/**
 * The scene looks like a closed room and asks for no bake, so the world's light reaches it through the walls and the room
 * renders lifted and flat. `share` is the share of rays from the middle of the scene that hit an inner face.
 */
export function closedRoomDiagnostic(share, litByLampsOnly = false) {
  if (litByLampsOnly) {
    return diagnostic('closed-room-without-bake', 'warning', 'bake',
      `${Math.round(share * 100)} percent of rays from the middle of the scene hit a wall, so this is a closed room lit only by its point, spot or area lights. Without a bake the walls bounce light only as one average colour over the whole room: no brighter corner beside a lamp, no colour bleeding off a red wall onto the floor next to it.`,
      'Add "bake": { "preset": "standard" } (scene_apply set-bake) for bounced light that follows the lamps and the wall colours.');
  }
  return diagnostic('closed-room-without-bake', 'warning', 'bake',
    `${Math.round(share * 100)} percent of rays from the middle of the scene hit a wall, so this is a closed room, and without a bake the world's light still reaches it: the room renders lifted and grey, with weak contact shadows.`,
    'Add "bake": { "preset": "standard" } (scene_apply set-bake). It darkens what the sky cannot see and adds bounced light, halving the indirect-light error of a closed room.');
}

/**
 * Rig and asset diagnostics. `warnings` are the decoder's notes about features it accepted but does not draw.
 */
export function assetDiagnostics({ assetId, warnings = [], skinnedParts, jointCount, clipCount }) {
  const problems = warnings.map(warning => diagnostic('unsupported-asset-feature', 'warning', assetId,
    String(warning),
    'The asset loads without it. Remove the feature from the GLB, or bake it into the base colour texture.'));
  if (skinnedParts > 0 && jointCount === 0) {
    problems.push(diagnostic('rig-without-joints', 'error', assetId,
      `${skinnedParts} meshes are skinned but the asset has no joint nodes, so no pose or ik can move them.`,
      'Re-export the GLB with its armature, or use an asset that has joints.'));
  }
  if (skinnedParts === 0 && jointCount > 0) {
    problems.push(diagnostic('rig-without-skin', 'warning', assetId,
      `The asset has ${jointCount} joint nodes but no mesh is skinned to them, so moving a joint changes nothing you can see.`,
      'Move the parent node with set-asset-node instead, or fix the skin binding in the source file.'));
  }
  if (clipCount === 0) {
    problems.push(diagnostic('asset-without-clips', 'info', assetId,
      'The asset has no animation clips, so set-animation and the export clip option are unavailable.',
      'Pose it with motion tracks or ik, or choose an asset that ships clips.'));
  }
  return problems;
}

/**
 * Parts whose mesh carries a COLOR_0 alpha that the renderer drops, because a material with `wear` uses the same vertex
 * component for its masks (see `hasVertexAlpha` in renderer.js).
 */
export function droppedVertexAlphaDiagnostics(parts) {
  return parts.filter(part => part.geometry?.colorAlpha && part.geometry.surfaceMasks).map(part => diagnostic('vertex-alpha-dropped', 'warning', part.name,
    `Part ${part.name} has a vertex colour alpha, but its material uses wear, so the alpha is ignored and the part draws opaque.`,
    'Remove wear from the material to keep the alpha, or give the part a material without wear.'));
}
