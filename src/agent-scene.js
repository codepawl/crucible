import { mat4, mat3 } from 'gl-matrix';
import { roomJoinedBoxNodeIds } from './room-box-joins.js';
import { box, checkTorusShape, circle, cone, cylinder, grid, icoSphere, sphere, torus } from './geometry.js';
import { createSceneGraph } from './scene-graph.js';
import { invalidField, withFieldPrefix } from './field-error.js';
import { createRepeatTracker, partFingerprint, unchangedFindingsLine } from './diagnostic-repeats.js';
import { applyProjection, validateCameraShift, CAMERA_LENS_FIELDS } from './camera.js';
import { checkLocalVolumePartNames } from './local-volume-resolve.js';
import { normalizeAgentLook, environmentPatchWithSetup, environmentLinksLights, agentEnvironmentMap, agentEnvironmentKey, SKY_OVERRIDABLE_FIELDS, VOLUME_FOG_FIELDS, EFFECT_GROUP_FIELDS } from './agent-look.js';
import { cameraFieldsToClear, splitClearedLookFields, mergeGroupPatch } from './agent-clear-fields.js';
import { postStepSupport } from './shader-registry.js';
import { agentSceneModule, agentSceneModuleActive, agentSceneModuleLoaded, defaultStageModulesNamed } from './agent-scene-modules.js';
import { CURVE_TEXT_LIMITS, AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS, MAX_MATERIAL_PATTERNS, RECIPE_ALPHA_MODES } from './agent-scene-capabilities.js';
import { TEXTURE_SET_RECIPE_FIELDS, TEXTURE_MAP_FIELDS, UV_TRANSFORM_FIELDS, HEIGHT_PARALLAX_FIELDS } from './texture-set-fields.js';
import { normalizeMaterialWear, geometryWithSurfaceMasks } from './material-wear.js';
import { ALL_LIGHTS_MASK, MATERIAL_LAYER_FIELDS, validateMaterialLayers } from './material-layers.js';
import { recipeDiagnostics, closedRoomDiagnostic, droppedVertexAlphaDiagnostics } from './agent-diagnostics.js';
import { closedRoomShare, CLOSED_ROOM_SHARE } from './closed-room.js';
import { roomEdgeLeakDiagnostic } from './room-edge-leak.js';
import { depthLayerOf, flushOrderOf, MAXIMUM_DEPTH_LAYER, setFlushOrder } from './depth-layer.js';
import { normalizeRayVisibility } from './ray-visibility.js';
import { armatureNodes, bakeRigExport, bindSkins, createSkinStages, normalizeArmatures, publishSkinPoses, restWorldMatrix, rigReport, stageSkinPoses, transformedBounds, withoutArmatureNodes } from './rig.js';
export { AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS };

/**
 * Earlier revisions a session keeps for scene_restore with a revision. Each one holds a recipe copy (a few kilobytes) and
 * shares geometry buffers with the live scene, so four cost little; their geometry still counts in the allocation budget.
 */
export const REVISION_HISTORY_LIMIT = 4;
const FIELD_EDIT_OPERATIONS = new Set(['set-node', 'set-material', 'set-camera', 'set-motion']);
// Fields of a set-node operation that move or show a node without changing the graph's shape, the geometry or the materials.
const POSE_EDIT_FIELDS = new Set(['type', 'id', 'translation', 'rotation', 'scale', 'visible']);
const TRANSFORM_FIELDS = ['translation', 'rotation', 'scale'];

/** The IDs of the nodes a batch of set-node operations moves, or null when the batch edits anything besides pose and visibility. */
function poseEditNodeIds(operations) {
  const movedNodes = new Set();
  for (const operation of operations) {
    if (operation.type !== 'set-node' || Object.keys(operation).some(field => !POSE_EDIT_FIELDS.has(field))) return null;
    if (TRANSFORM_FIELDS.some(field => Object.hasOwn(operation, field))) movedNodes.add(operation.id);
  }
  return movedNodes;
}
export { normalizeAgentLook, resolveAgentShadow } from './agent-look.js';
import { OWN_SECTIONS as NULLABLE_SECTION_OPERATIONS } from './agent-apply-report.js';
import { markLiveGeometry } from './live-geometry.js';
export { describeApplication } from './agent-apply-report.js';
export {
  needsMeshBooleans, loadMeshBooleans, meshBooleansLoaded, setManifoldModuleLoader,
  needsPhysics, needsBuoyancy, loadPhysicsEngine, physicsEngineLoaded, setPhysicsModuleLoader,
  loadAgentSceneModules, loadAllAgentSceneModules, registerAgentSceneFont, allAgentSceneModulesLoaded, agentSceneModulesNeeded,
} from './agent-scene-modules.js';

const DEFAULT_LIMITS = AGENT_SCENE_DEFAULT_LIMITS;
const MAX_MESH_REPORTS = 16;
// A boolean cutter may name another recipe geometry, which may itself cut with a third. Both bounds are static, so they
// do not depend on what the evaluation cache holds.
const MAX_CUTTER_DEPTH = 4;
const MAX_CUTTER_WORK_VERTICES = 250_000;
// Where a geometry is checked before the whole recipe is known: references stay unresolved and count nothing.
const PENDING_CUTTER_SCOPE = Object.freeze({ definitions: null, chain: Object.freeze([]) });
// Terrain meshes carry one more float for each vertex (sky visibility) than the 56 bytes the budget estimates.
const TERRAIN_SKY_VISIBILITY_BYTES = 4;
const CAMERA_DEFAULTS = Object.freeze({ eye: [4, 3, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 1000 });
// Per-node render flags: `visible` hides a node and its children; the rest become renderer part flags of a mesh node.
const RENDER_FLAG_FIELDS = ['visible', 'castShadow', 'receiveShadow', 'holdout', 'shadowCatcher', 'shadowOnly'];
const PART_FLAG_FIELDS = RENDER_FLAG_FIELDS.slice(1);
// On an asset placement these two flags reach each part it expands to.
const ASSET_PLACEMENT_FLAG_FIELDS = ['castShadow', 'receiveShadow'];
const NODE_FIELDS = ['translation', 'rotation', 'scale', 'parent', 'label', 'geometry', 'material', 'skin', 'relations', 'asset', 'vegetation', 'clutter', 'grass', 'decal', 'faceImages', 'depthLayer', 'billboard', 'blend', 'rayVisibility', ...RENDER_FLAG_FIELDS];
const MATERIAL_FIELDS = ['color', 'metallic', 'roughness', 'emission', 'emissiveColor', 'opacity', 'alphaMode', 'alphaCutoff', 'doubleSided', 'depthTest', 'pattern', 'map', 'text', 'subsurface', 'snippet', 'preset', 'waterPreset', 'absorption', 'turbidity', 'foamEdge', 'foamWidth', 'foamColor', 'foamVeins', 'contactFoam', 'caustics', 'ripples', 'waterRamp', 'aov', 'wear', 'surfaceCover', 'retro', 'emissionMask', 'toonColors', ...MATERIAL_LAYER_FIELDS];
const PATTERN_TEXTURE_FIELDS = ['map', 'normalMap', 'metallicRoughnessMap', 'emissiveMap', 'layerMaps', 'transmissionMap', 'aovMap', 'emissionFresnel', 'boxMapScale', 'boxMapAxis'];
const CAMERA_FIELDS = [...Object.keys(CAMERA_DEFAULTS), ...CAMERA_LENS_FIELDS];
// Fields of an optional shader module join the list here, so the long list above stays a line each material feature does not rewrite.
MATERIAL_FIELDS.push('waterGlint');
const LOOK_OPERATION_FIELDS = Object.freeze({
  'set-environment': 'environment',
  'set-effects': 'effects',
  'set-shadow': 'shadow',
});
const ADDITION_FIELDS = Object.freeze({
  'add-geometry': ['geometries', 'geometry'],
  'add-material': ['materials', 'material'],
  'add-node': ['nodes', 'node'],
});
const REMOVAL_FIELDS = Object.freeze({
  'remove-geometry': 'geometries',
  'remove-material': 'materials',
});
// Rejects a batch that removes a geometry or material and leaves nodes pointing at it, naming them and the fix.
function assertRemovedResourcesUnused(candidate, removals) {
  for (const { type, id } of removals) {
    const kind = type.slice(7);
    const users = candidate.nodes.filter(node => node[kind] === id).map(node => node.id);
    if (users.length > 0 && !candidate[REMOVAL_FIELDS[type]].some(record => record.id === id)) {
      const more = users.length > 8 ? ` and ${users.length - 8} more` : '';
      throw invalidField('id', id, `${kind} ${id} is used by nodes ${users.slice(0, 8).join(', ')}${more}; set-node them to another ${kind} or remove-node them first`);
    }
  }
}


function knownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField(label, value, 'an object, such as {}', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidField(`${label}.${key}`, value[key], `one of the fields ${allowed.join(', ')}; remove ${key}`, TypeError);
    }
  }
}

// An edit that names no field is almost always a typo or a dropped field name, so it fails and lists what the operation takes
// instead of spending a revision on a change that changed nothing.
function requireChange(namesAField, operation, acceptedFields) {
  if (!namesAField) {
    throw invalidField('operation', operation, `${operation.type} with at least one field to change: ${acceptedFields.join(', ')}`);
  }
}

function resolveLimits(input) {
  knownKeys(input, Object.keys(DEFAULT_LIMITS), 'limits');
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidField(`limits.${key}`, value, 'a positive whole number, such as 1024');
    }
  }
  if (result.maxNodes > 4096) {
    throw new RangeError('maxNodes cannot exceed 4096.');
  }
  return Object.freeze(result);
}

// Copy only JSON data. Reject accessors before reading them and bound traversal before serialization.
function assertWithinRecipeBytes(bytes, maximum) {
  if (bytes > maximum) {
    throw new RangeError('JSON exceeds maxRecipeBytes. Reduce the input.');
  }
}

function copiedJson(input, maximum) {
  let bytes = 0;
  const ancestors = new Set();
  const encoder = new TextEncoder();
  // Recipes repeat the same keys and ids thousands of times, so each distinct string is measured once.
  const stringBytes = new Map();
  function jsonStringBytes(text) {
    let size = stringBytes.get(text);
    if (size === undefined) {
      size = encoder.encode(JSON.stringify(text)).length;
      stringBytes.set(text, size);
    }
    return size;
  }
  function charge(count) {
    bytes += count;
    assertWithinRecipeBytes(bytes, maximum);
  }
  function copy(value, depth) {
    if (depth > 64) {
      throw new RangeError('JSON nesting exceeds 64 levels.');
    }
    if (value === null || typeof value === 'boolean') {
      charge(value === null ? 4 : String(value).length);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      charge(String(value).length);
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > maximum) {
        throw new RangeError('JSON exceeds maxRecipeBytes.');
      }
      charge(jsonStringBytes(value));
      return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) {
      throw new TypeError('Recipe must contain finite, acyclic JSON data.');
    }
    const array = Array.isArray(value);
    if (array && value.length > maximum) {
      throw new RangeError('JSON exceeds maxRecipeBytes.');
    }
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Recipe objects must be plain JSON objects.');
    }
    ancestors.add(value);
    charge(2);
    const result = array ? [] : {};
    const keys = Reflect.ownKeys(value);
    let entryCount = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key === '__proto__') {
        throw new TypeError('Invalid JSON key.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('JSON accessors and hidden fields are unsupported.');
      }
      if (array && key !== String(result.length)) {
        throw new TypeError('JSON arrays must be dense without extra fields.');
      }
      // Commas are counted exactly (one between entries) so this running size equals the serialized size
      // that normalizeRecipe checks after a field edit; both paths then accept and refuse the same recipes.
      const separatorBytes = entryCount === 0 ? 0 : 1;
      entryCount += 1;
      charge(array ? separatorBytes : jsonStringBytes(key) + 1 + separatorBytes);
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (array && result.length !== value.length) {
      throw new TypeError('JSON arrays must be dense without trailing holes.');
    }
    ancestors.delete(value);
    return result;
  }
  const result = copy(input, 0);
  if (encoder.encode(JSON.stringify(result)).length > maximum) {
    throw new RangeError('JSON exceeds maxRecipeBytes.');
  }
  return result;
}

function finite(value, label) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
    throw invalidField(label, value, 'a finite number that fits Float32, such as 0.5', TypeError);
  }
  return value;
}

function vector(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    const example = `[${Array.from({ length }, (_, index) => (index === length - 1 && length === 4 ? 1 : 0)).join(', ')}]`;
    throw invalidField(label, value, `an array of ${length} numbers, such as ${example}`, TypeError);
  }
  return value.map((component, index) => finite(component, `${label}[${index}]`));
}

function defaultValue(value, fallback) {
  return value === undefined ? fallback : value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidField(label, value, `a whole number from ${minimum} to ${maximum}, such as ${minimum}`);
  }
  return value;
}

function identifier(value, label = 'id') {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw invalidField(label,value, 'a string of 1 to 128 characters, such as "wall-left"', TypeError);
  }
  return value;
}

/**
 * Checks a list of records and returns the normalized copies. A record in `alreadyNormalized` came out of `validate` before
 * and nobody has changed it since, so it is kept as it is; `validate` adds the records it returns when `isShareable` says
 * no later stage rewrites them in place.
 */
function resources(values, maximum, label, validate, { alreadyNormalized = null, isShareable = null } = {}) {
  if (!Array.isArray(values) || values.length > maximum) {
    throw invalidField(label, Array.isArray(values) ? `${values.length} entries` : values, `an array of at most ${maximum} entries, such as []`);
  }
  const seen = new Set();
  return values.map((value, index) => {
    if (alreadyNormalized?.has(value)) {
      if (seen.has(value.id)) {
        throw invalidField(`${label}[${index}].id`, value.id, `an ID no other ${label} entry uses; rename one, or remove the other`);
      }
      seen.add(value.id);
      return value;
    }
    return withFieldPrefix(`${label}[${index}]`, () => {
      identifier(value?.id);
      if (seen.has(value.id)) {
        throw invalidField('id', value.id, `an ID no other ${label} entry uses; rename one, or remove the other`);
      }
      seen.add(value.id);
      const normalized = validate(value);
      if (alreadyNormalized && isShareable(normalized)) alreadyNormalized.add(normalized);
      return normalized;
    });
  });
}

function copyMaterialLayers(value, result) {
  for (const field of MATERIAL_LAYER_FIELDS) {
    if (value[field] === undefined) continue;
    result[field] = Array.isArray(value[field]) ? vector(value[field], 3, field) : value[field];
  }
  if (value.toonColors !== undefined) {
    result.toonColors = Array.isArray(value.toonColors)
      ? Object.freeze(value.toonColors.map((color, index) => Object.freeze(vector(color, 3, `toonColors[${index}]`))))
      : value.toonColors;
  }
  validateMaterialLayers(result);
  if (value.emissionMask !== undefined) {
    result.emissionMask = Object.freeze(agentSceneModule('emissionMask').normalizeEmissionMask(value.emissionMask));
  }
  if (value.subsurface !== undefined) result.subsurface = agentSceneModule('subsurfaceShader').copySubsurface(value.subsurface, result.tag);
  if (value.snippet) result.snippet = agentSceneModule('materialSnippet').normalizeMaterialSnippet(value.snippet, { hasMap: Boolean(value.map || value.pattern) });
  if (result.anisotropy > 0 || result.iridescence > 0 || result.softEdge > 0 || JSON.stringify(value.pattern?.graph?.emission ?? null).includes('"fresnel"')) agentSceneModule('layerShaders');
  if (result.toon > 0) agentSceneModule('lineArt');
}

/** alphaCutoff is the alpha below which a masked surface is cut out; it means nothing for other alpha modes, so it is refused there. */
function applyAlphaCutoff(value, result) {
  if (value.alphaCutoff === undefined) {
    if (result.alphaMode === 'mask') result.alphaCutoff = 0.5;
    return;
  }
  if (result.alphaMode !== 'mask') {
    throw invalidField('alphaCutoff', value.alphaCutoff, `omitted, or set alphaMode to "mask" (alphaMode is "${result.alphaMode}")`);
  }
  finite(value.alphaCutoff, 'alphaCutoff');
  if (value.alphaCutoff < 0 || value.alphaCutoff > 1) {
    throw invalidField('alphaCutoff', value.alphaCutoff, 'a number from 0 to 1, such as 0.5');
  }
  result.alphaCutoff = value.alphaCutoff;
}

function materialFrom(recipeValue) {
  const value = recipeValue.preset === undefined ? recipeValue : agentSceneModule('materialPresets').applyMaterialPreset(recipeValue, (given, expected) => invalidField('preset', given, expected));
  knownKeys(recipeValue, ['id', 'tag', ...MATERIAL_FIELDS, ...TEXTURE_SET_RECIPE_FIELDS], 'material');
  // A pattern or a catalog colour map brings its own colours, so the color field tints it and leaves it unchanged by default.
  const defaultColor = value.pattern === undefined && value.colorMap === undefined && value.text === undefined ? [0.5, 0.5, 0.5] : [1, 1, 1];
  const graph = value.pattern?.type === 'graph' ? value.pattern.graph : {};
  // A graph that makes roughness, metallic or emission passes it through as written, so the factors default to 1.
  const graphFactor = (output, fallback) => (Object.hasOwn(graph ?? {}, output) ? 1 : fallback);
  const result = { id: value.id, tag: defaultValue(value.tag, 'surface'), color: vector(defaultValue(value.color, defaultColor), 3, 'color'),
    ...(graphFactor('clearcoat', 0) && { clearcoat: 1 }), ...(graphFactor('transmission', 0) && { transmission: 1 }),
    metallic: defaultValue(value.metallic, graphFactor('metallic', value.metallicMap === undefined ? 0 : 1)), roughness: defaultValue(value.roughness, graphFactor('roughness', value.roughnessMap === undefined ? 0.5 : 1)), emission: defaultValue(value.emission, graphFactor('emission', 0)) };
  if (!AGENT_SCENE_CAPABILITIES.materialTags.includes(result.tag)) {
    throw invalidField('tag', result.tag, `one of ${AGENT_SCENE_CAPABILITIES.materialTags.join(', ')}`);
  }
  if (value.map !== undefined) agentSceneModule('assets').applyMapSequence(value, result);
  if (value.text !== undefined) {
    if (result.tag !== 'surface' && result.tag !== 'unlit') throw invalidField('text', value.text?.content, 'a material with the surface or unlit tag; remove text or set tag to unlit for a sign that glows');
    if (value.pattern !== undefined || value.map !== undefined || value.colorMap !== undefined) throw invalidField('text', value.text?.content, 'nothing besides it: a material draws a text panel, a pattern, a map sequence or a catalog colour map, not two of them', TypeError);
    result.text = agentSceneModule('textPanel').normalizeTextPanel(value.text);
  }
  if (TEXTURE_SET_RECIPE_FIELDS.some(field => value[field] !== undefined)) agentSceneModule('assets').applyTextureMaps(value, result);
  if (value.pattern !== undefined) {
    if (result.tag !== 'surface') throw invalidField('pattern', value.pattern?.type, 'a material with the surface tag; remove pattern or set tag to surface');
    result.pattern = agentSceneModule('patterns').normalizeMaterialPattern(value.pattern);
  }
  result.opacity = defaultValue(value.opacity, 1);
  finite(result.opacity, 'opacity');
  if (result.opacity < 0 || result.opacity > 1) {
    throw invalidField('opacity', result.opacity, 'a number from 0 to 1, such as 0.5');
  }
  // A panel without a background is transparent, so it blends unless the recipe says otherwise.
  const requestedAlphaMode = defaultValue(value.alphaMode, result.text && !result.text.background ? 'blend' : 'opaque');
  if (!RECIPE_ALPHA_MODES.includes(requestedAlphaMode)) {
    throw invalidField('alphaMode', requestedAlphaMode, `one of ${RECIPE_ALPHA_MODES.join(', ')}`);
  }
  // The renderer ignores opacity on opaque surfaces, so any opacity below one means blending (additive stays additive).
  const graphHasOpacity = graphFactor('opacity', 0);
  result.alphaMode = (result.opacity < 1 || graphHasOpacity) && requestedAlphaMode === 'opaque' ? 'blend' : requestedAlphaMode;
  applyAlphaCutoff(value, result);
  result.doubleSided = defaultValue(value.doubleSided, false);
  if (typeof result.doubleSided !== 'boolean') {
    throw invalidField('doubleSided', result.doubleSided, 'true or false', TypeError);
  }
  if (value.depthTest !== undefined) {
    if (typeof value.depthTest !== 'boolean') {
      throw invalidField('depthTest', value.depthTest, 'true or false', TypeError);
    }
    result.depthTest = value.depthTest;
  }
  for (const field of ['metallic', 'roughness']) {
    finite(result[field], field);
    if (result[field] < 0 || result[field] > 1) {
      throw invalidField(field, result[field], 'a number from 0 to 1, such as 0.5');
    }
  }
  finite(result.emission, 'emission');
  if (result.emission < 0) {
    throw invalidField('emission', result.emission, 'a number of 0 or more, such as 1');
  }
  if (result.color.some(component => component < 0 || component > 1)) {
    throw invalidField('color', result.color, 'three numbers from 0 to 1, such as [0.8, 0.2, 0.1]');
  }
  if (value.emissiveColor !== undefined) {
    result.emissiveColor = vector(value.emissiveColor, 3, 'emissiveColor');
    if (result.emissiveColor.some(component => component < 0)) {
      throw invalidField('emissiveColor', result.emissiveColor, 'three numbers of 0 or more, such as [1, 0.5, 0.2]');
    }
  }
  if (value.aov !== undefined) {
    const aov = typeof value.aov === 'number' ? [finite(value.aov, 'aov'), value.aov, value.aov] : vector(value.aov, 3, 'aov');
    if (aov.some(component => component < 0 || component > 1)) {
      throw invalidField('aov', value.aov, 'a number or three numbers from 0 to 1, such as [1, 0.5, 0]');
    }
    result.aov = aov;
  }
  copyMaterialLayers(value, result);
  if (value.wear) result.wear = normalizeMaterialWear(value.wear);
  if (value.surfaceCover !== undefined && value.surfaceCover !== null) {
    if (result.tag !== 'surface') throw invalidField('surfaceCover', value.surfaceCover, 'a material with the surface tag; remove surfaceCover or set tag to surface');
    result.surfaceCover = agentSceneModule('surfaceCover').normalizeSurfaceCover(value.surfaceCover);
  }
  if (value.waterGlint !== undefined && value.waterGlint !== null) {
    if (result.tag !== 'water') throw invalidField('waterGlint', value.waterGlint, 'a water material: set tag "water" on the material, or remove waterGlint');
    result.waterGlint = agentSceneModule('glitterShader').normalizeWaterGlint(value.waterGlint);
  }
  if (value.retro !== undefined && value.retro !== null) result.retro = agentSceneModule('retroShader').normalizeMaterialRetro(value.retro);
  if (agentSceneModuleLoaded('worldMaterials')) {
    agentSceneModule('worldMaterials').copyWaterFields(value, result, vector);
    agentSceneModule('worldMaterials').copyWaterRamp(value, result, vector);
  }
  const emissiveColor = result.emissiveColor ?? result.color;
  for (const component of emissiveColor) {
    const radiance = Math.fround(component) * Math.fround(result.emission);
    if (!Number.isFinite(Math.fround(radiance))) {
      throw invalidField('emission', result.emission, 'an emission that keeps color times emission within Float32 range, such as 2');
    }
    if (result.tag === 'unlit' && radiance > 65500) {
      throw invalidField('emission', result.emission, 'an unlit emission that keeps color times emission at or below 65500, such as 2');
    }
  }
  return result;
}

function nodeFrom(value) {
  knownKeys(value, ['id', 'geometry', 'material', ...NODE_FIELDS], 'node');
  const result = { ...value, parent: value.parent ?? null,
    translation: vector(defaultValue(value.translation, [0, 0, 0]), 3, 'translation'),
    rotation: vector(defaultValue(value.rotation, [0, 0, 0, 1]), 4, 'rotation'),
    scale: vector(defaultValue(value.scale, [1, 1, 1]), 3, 'scale') };
  if (result.parent !== null) {
    identifier(result.parent, 'parent');
  }
  if (result.label !== undefined && (typeof result.label !== 'string' || result.label.length > 256)) {
    throw invalidField('label', result.label, 'a string of at most 256 characters, such as "left wall"', TypeError);
  }
  if (result.scale.some(component => component <= 0 || Math.fround(component) <= 0)) {
    throw invalidField('scale', result.scale, 'three positive numbers, such as [1, 1, 1]');
  }
  const length = Math.hypot(...result.rotation);
  if (length === 0) {
    throw invalidField('rotation', result.rotation, 'a nonzero quaternion [x, y, z, w], such as [0, 0, 0, 1] for no rotation');
  }
  result.rotation = result.rotation.map(component => component / length);
  if ((value.geometry !== undefined) !== (value.material !== undefined)) {
    throw invalidField(value.geometry === undefined ? 'geometry' : 'material', value.geometry ?? value.material, `set together with ${value.geometry === undefined ? 'material' : 'geometry'} to draw a mesh, or drop both for a group node`, TypeError);
  }
  if (value.geometry !== undefined) {
    identifier(value.geometry);
    identifier(value.material);
  }
  if (value.asset !== undefined) {
    if (value.geometry !== undefined || value.skin !== undefined) {
      throw invalidField('asset', value.geometry ?? value.skin, 'an asset node without geometry, material and skin; an asset node is a group', TypeError);
    }
    result.asset = agentSceneModule('assets').normalizeAssetPlacement(value.asset);
  }
  if (value.vegetation !== undefined) result.vegetation = agentSceneModule('vegetation').normalizeVegetation(value.vegetation, value);
  if (value.clutter !== undefined) result.clutter = agentSceneModule('clutter').normalizeClutter(value.clutter, value);
  if (value.grass !== undefined) result.grass = agentSceneModule('grass').normalizeGrass(value.grass, value);
  if (value.decal !== undefined && typeof value.decal !== 'boolean') {
    throw invalidField('decal', value.decal, 'true or false', TypeError);
  }
  if (value.billboard !== undefined) {
    if (value.geometry === undefined) throw invalidField('billboard', value.billboard, 'a field on a mesh node whose geometry is a plane; remove it from group nodes', TypeError);
    result.billboard = agentSceneModule('textBillboard').normalizeBillboard(value.billboard);
    // A tag is a flat sheet that faces the camera: its shadow is a stray line on the ground, so it casts none unless castShadow is true.
    if (value.castShadow === undefined && value.shadowOnly !== true) result.castShadow = false;
  }
  if (value.depthLayer !== undefined) {
    integer(value.depthLayer, 0, MAXIMUM_DEPTH_LAYER, 'depthLayer');
  }
  for (const flag of RENDER_FLAG_FIELDS) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw invalidField(flag, value[flag], 'true or false', TypeError);
    const placesAsset = value.asset !== undefined && ASSET_PLACEMENT_FLAG_FIELDS.includes(flag);
    if (flag !== 'visible' && value[flag] !== undefined && value.geometry === undefined && !placesAsset) throw invalidField(flag, value[flag], 'a flag on a mesh node with geometry and material; remove it from group nodes', TypeError);
  }
  if (value.rayVisibility !== undefined) {
    if (value.geometry === undefined) throw invalidField('rayVisibility', value.rayVisibility, 'a field on a mesh node; remove it from group nodes', TypeError);
    const rayVisibility = normalizeRayVisibility(value.rayVisibility);
    if (rayVisibility === undefined) delete result.rayVisibility;
    else result.rayVisibility = rayVisibility;
    if (rayVisibility?.shadow === false && value.shadowOnly === true) {
      throw invalidField('rayVisibility', value.rayVisibility, 'shadow rays on when shadowOnly is true', TypeError);
    }
  }
  if (value.holdout === true && value.shadowCatcher === true) throw invalidField('shadowCatcher', value.shadowCatcher, 'false when holdout is true; a node is a holdout or a shadow catcher, not both', TypeError);
  if (value.shadowOnly === true && (value.castShadow === false || value.holdout === true || value.shadowCatcher === true)) {
    throw invalidField('shadowOnly', value.shadowOnly, 'false with castShadow false, holdout or shadowCatcher', TypeError);
  }
  if (value.skin !== undefined) {
    if (value.geometry === undefined) {
      throw invalidField('skin', value.skin, 'a skin on a mesh node with geometry and material; remove skin from group nodes', TypeError);
    }
    knownKeys(value.skin, ['armature', 'maxInfluences', 'maxDistance'], 'skin');
    identifier(value.skin.armature);
    if (value.skin.maxInfluences !== undefined) {
      integer(value.skin.maxInfluences, 1, 4, 'skin maxInfluences');
    }
    if (value.skin.maxDistance !== undefined && !(Number.isFinite(value.skin.maxDistance) && value.skin.maxDistance > 0)) {
      throw invalidField('skin.maxDistance', value.skin.maxDistance, 'a positive number of metres, such as 0.5');
    }
  }
  return result;
}

// The section as normalised with nothing set: its keys always have a value, so null cannot clear them.
function splitClearedLookPatch(lookField, patch) {
  if (!Object.values(patch).includes(null)) return { kept: patch, cleared: [] };
  const defaults = normalizeAgentLook({})[lookField];
  const groupFields = lookField === 'effects' ? Object.keys(EFFECT_GROUP_FIELDS) : [];
  return splitClearedLookFields(lookField, patch, { requiredDefaults: defaults, valueFields: lookField === 'environment' ? ['fogDensity'] : [], groupFields });
}

// bloom, depthOfField and motionBlur merge field by field; a field set to null leaves a group of defaults when it has none.
function mergeEffectGroups(currentEffects, patch, merged) {
  const defaults = normalizeAgentLook({}).effects;
  for (const [group, fields] of Object.entries(EFFECT_GROUP_FIELDS)) {
    if (!Object.hasOwn(patch, group)) continue;
    knownKeys(patch[group], [...Object.keys(currentEffects[group]), ...fields], group);
    merged[group] = mergeGroupPatch(group, currentEffects[group], patch[group], defaults[group]);
  }
}

/** Sets the given camera fields on a camera; a focal length replaces fov and a fov replaces focal length and sensor, never both. */
export function applyCameraFields(camera, fields) {
  rejectFovWithFocalLength(fields);
  rejectFocusDistanceWithoutFStop(fields);
  // null clears an optional lens field back to not set (fStop takes focusDistance with it); a required field refuses null.
  for (const field of cameraFieldsToClear(fields, CAMERA_DEFAULTS)) delete camera[field];
  for (const field of CAMERA_FIELDS) {
    if (Object.hasOwn(fields, field) && fields[field] !== null) camera[field] = fields[field];
  }
  if (Object.hasOwn(fields, 'focalLength')) delete camera.fov;
  // Back to a perspective view: the old orthographic size no longer applies.
  if (fields.projection === 'perspective' && !Object.hasOwn(fields, 'orthoScale')) delete camera.orthoScale;
  if (Object.hasOwn(fields, 'fov')) {
    delete camera.focalLength;
    delete camera.sensorWidth;
  }
  return camera;
}

function rejectFocusDistanceWithoutFStop(fields) {
  if (fields.fStop === null && fields.focusDistance !== undefined && fields.focusDistance !== null) {
    throw invalidField('camera.focusDistance', fields.focusDistance, 'null or left out: fStop null already clears focusDistance; to keep depth of field pass a number fStop such as 2.8');
  }
}

function rejectFovWithFocalLength(fields) {
  if (fields.fov !== undefined && fields.focalLength !== undefined) {
    throw invalidField('camera.focalLength', fields.focalLength, 'only one of fov (degrees) or focalLength (millimetres with sensorWidth), such as fov 45; remove the other');
  }
}

function checkCameraLens(camera) {
  if (camera.projection !== undefined && camera.projection !== 'perspective' && camera.projection !== 'orthographic') {
    throw invalidField('camera.projection', camera.projection, 'perspective or orthographic');
  }
  const orthographic = camera.projection === 'orthographic';
  if (camera.orthoScale !== undefined) {
    if (!orthographic) throw invalidField('camera.orthoScale', camera.orthoScale, 'a field of an orthographic camera; set projection to orthographic, or remove orthoScale');
    if (!Number.isFinite(camera.orthoScale) || camera.orthoScale <= 0) throw invalidField('camera.orthoScale', camera.orthoScale, 'a positive view height in metres, such as 10');
  }
  if (camera.sensorWidth !== undefined && camera.focalLength === undefined) throw invalidField('camera.sensorWidth', camera.sensorWidth, 'a field used with focalLength, such as focalLength 35; add focalLength or remove sensorWidth');
  if (camera.focalLength !== undefined) {
    if (orthographic) throw invalidField('camera.focalLength', camera.focalLength, 'a field of a perspective camera; an orthographic camera is sized by orthoScale, so remove focalLength');
    if (!Number.isFinite(camera.focalLength) || camera.focalLength <= 0 || camera.focalLength > 10000) throw invalidField('camera.focalLength', camera.focalLength, 'a lens length above 0 and up to 10000 millimetres, such as 35');
    if (camera.sensorWidth !== undefined && !(Number.isFinite(camera.sensorWidth) && camera.sensorWidth > 0 && camera.sensorWidth <= 1000)) throw invalidField('camera.sensorWidth', camera.sensorWidth, 'a width above 0 and up to 1000 millimetres, such as 36');
  }
  if (camera.shift !== undefined) validateCameraShift(camera.shift);
  if (camera.fStop !== undefined && !(Number.isFinite(camera.fStop) && camera.fStop >= 0.7 && camera.fStop <= 64)) {
    throw invalidField('camera.fStop', camera.fStop, 'a number from 0.7 to 64, such as 2.8 (smaller numbers blur more)');
  }
  if (camera.focusDistance !== undefined) {
    if (camera.fStop === undefined) throw invalidField('camera.focusDistance', camera.focusDistance, 'a field used with fStop, such as fStop 2.8; add fStop or remove focusDistance');
    if (!(Number.isFinite(camera.focusDistance) && camera.focusDistance > 0)) {
      throw invalidField('camera.focusDistance', camera.focusDistance, 'a positive distance in metres along the view axis, such as 3.5 (default: the distance to target)');
    }
  }
}

function cameraFrom(value = {}) {
  knownKeys(value, CAMERA_FIELDS, 'camera');
  rejectFovWithFocalLength(value);
  const result = { ...CAMERA_DEFAULTS, ...value };
  if (result.focalLength !== undefined) delete result.fov;
  checkCameraLens(result);
  result.eye = vector(result.eye, 3, 'camera.eye');
  result.target = vector(result.target, 3, 'camera.target');
  result.up = vector(result.up, 3, 'camera.up');
  const upLength = Math.hypot(...result.up);
  if (upLength === 0) {
    throw invalidField('camera.up', result.up, 'a nonzero direction, such as [0, 1, 0]');
  }
  result.up = result.up.map(component => component / upLength);
  for (const field of ['fov', 'near', 'far']) {
    if (result[field] !== undefined) finite(result[field], `camera.${field}`);
  }
  // Without fov the lens is a focal length, which gives a valid angle at any positive size.
  if ((result.fov !== undefined && (Math.fround(result.fov) <= 0 || Math.fround(result.fov) >= 180)) || Math.fround(result.near) <= 0 || Math.fround(result.far) <= Math.fround(result.near)) {
    if (result.fov !== undefined && (Math.fround(result.fov) <= 0 || Math.fround(result.fov) >= 180)) {
      throw invalidField('camera.fov', result.fov, 'degrees above 0 and below 180, such as 50');
    }
    throw invalidField('camera.near', [result.near, result.far], 'near above 0 and far above near, such as near 0.1 and far 100');
  }
  if (result.eye.every((component, axis) => Math.fround(component) === Math.fround(result.target[axis]))) {
    throw invalidField('camera.target', result.target, `a point different from eye ${JSON.stringify(result.eye)}, such as [0, 0, 0]`);
  }
  const direction = result.target.map((component, axis) => component - result.eye[axis]);
  const directionLength = Math.hypot(...direction);
  const unitDirection = direction.map(component => component / directionLength);
  const crossLength = Math.hypot(unitDirection[1] * result.up[2] - unitDirection[2] * result.up[1],
    unitDirection[2] * result.up[0] - unitDirection[0] * result.up[2], unitDirection[0] * result.up[1] - unitDirection[1] * result.up[0]);
  if (Math.fround(crossLength) === 0) {
    throw invalidField('camera.up', result.up, `a direction not parallel to the view from eye to target, such as [0, 1, 0]`);
  }
  const view = mat4.lookAt(mat4.create(), result.eye, result.target, result.up);
  const projection = applyProjection(mat4.create(), result, 1);
  for (const matrix of [view, projection]) {
    const determinant = mat4.determinant(matrix);
    if (!matrix.every(Number.isFinite) || !Number.isFinite(determinant) || determinant === 0) {
      throw new RangeError('Camera matrices must remain finite and nonsingular at Float32 precision.');
    }
  }
  return result;
}

const GEOMETRY_FIELDS = {
  box: ['bevel', 'subdivisions'], cylinder: ['segments', 'bevel', 'bevelSegments'],
  sphere: ['segments', 'rings'], grid: ['segments'], plane: ['segments'],
  cone: ['radiusTop', 'radiusBottom', 'segments'], icoSphere: ['subdivisions'], circle: ['segments', 'innerRadius'],
  line: ['from', 'to', 'radius', 'radialSegments'], torus: ['tubeRadius', 'segments', 'sides', 'arc', 'start'],
  lathe: ['profile', 'segments', 'startAngle', 'sweep'],
  extrude: ['contour', 'holes', 'depth', 'steps', 'bevel', 'bevelThickness', 'bevelSegments'],
  tube: ['path', 'radius', 'segments', 'radialSegments', 'closed'],
  sdf: ['root', 'resolution'],
  curve: ['points', 'shape', 'splines', 'closed', 'kind', 'weights', 'order', 'knots', 'knotMode', 'trim', 'grow', 'radius', 'taper', 'profile', 'resolution', 'radialSegments'],
  text: ['text', 'size', 'depth', 'font', 'align', 'curveSegments'],
  mesh: ['base', 'edits', 'stack', 'smoothAngle', 'shapeKeys', 'slots'],
  terrain: ['size', 'resolution', 'seed', 'amplitude', 'holes', 'featureSize', 'octaves', 'warp', 'ridged', 'mountainAmplitude', 'mountainMask', 'chunks', 'levels', 'paths'],
  cloud: ['seed', 'puffs', 'width', 'height', 'flatBase', 'resolution', 'levels', 'upBias', 'unionSoftness'],
  fragment: ['source', 'seed', 'cells', 'index', 'impact', 'impactRadius'],
  dented: ['source', 'impacts', 'stiffness', 'maxDepth', 'radius'],
  floorPlan: ['walls', 'openings', 'height', 'thickness', 'part'],
};

// A line is a two-point curve; both ends must be finite and apart.
function lineEnds(value) {
  const ends = [value.from, value.to];
  for (const end of ends) vector(end, 3, 'line end');
  if (ends[0].every((component, axis) => component === ends[1][axis])) {
    throw invalidField('to', value.to, `a point different from from ${JSON.stringify(value.from)}, such as [0, 1, 0]`);
  }
  return ends;
}

// A sharp box under a mesh keeps its subdivisions as a grid on each face, welded by the mesh, so edits have vertices to move (#2201).
function meshBaseSplitsBox(base) {
  return base.type === 'box' && base.bevel === 0 && base.subdivisions !== undefined && base.subdivisions !== null;
}

function geometryEstimate(value, scope = PENDING_CUTTER_SCOPE) {
  if (!Object.hasOwn(GEOMETRY_FIELDS, value.type)) {
    throw invalidField('type', value.type, `one of ${Object.keys(GEOMETRY_FIELDS).join(', ')}`, TypeError);
  }
  knownKeys(value, ['id', 'type', ...GEOMETRY_FIELDS[value.type]], 'geometry');
  function detail(field, fallback, minimum, maximum) {
    return integer(value[field] ?? fallback, minimum, maximum, field);
  }
  function points(input, size, minimum, field = 'points') {
    if (!Array.isArray(input) || input.length < minimum || input.length > 4096) {
      throw invalidField(field, Array.isArray(input) ? `${input.length} points` : input, `a list of ${minimum} to 4096 points of ${size} numbers, such as ${JSON.stringify(Array.from({ length: minimum }, (_, index) => Array.from({ length: size }, () => index)))}`);
    }
    for (const point of input) {
      vector(point, size, 'geometry point');
    }
    return input.length;
  }
  for (const field of GEOMETRY_FIELDS[value.type]) {
    // Terrain checks its own numbers (a whole resolution from 2 to 499), so its message names the real range; null is not absent there, so it still fails below.
    if (value.type === 'terrain' && ['size', 'resolution', 'amplitude', 'featureSize', 'octaves', 'warp', 'ridged', 'mountainAmplitude', 'mountainMask', 'chunks', 'levels'].includes(field) && value[field] !== null) continue;
    if (value.type === 'cloud' && value[field] !== null) continue;
    if (value[field] !== undefined && !['profile', 'contour', 'holes', 'path', 'closed', 'base', 'edits', 'stack', 'shapeKeys', 'slots', 'points', 'taper', 'text', 'font', 'align', 'from', 'to', 'shape', 'splines', 'kind', 'weights', 'order', 'knots', 'knotMode', 'trim', 'grow', 'root', 'source', 'impact', 'impacts', 'walls', 'openings', 'part', 'paths'].includes(field)) {
      finite(value[field], field);
    }
  }
  switch (value.type) {
    case 'box':
      return value.bevel === 0 ? 24 : 6 * (2 * detail('subdivisions', 6, 1, 128) + 2) ** 2;
    case 'cylinder':
      return (detail('segments', 80, 3, 2048) + 1) * 2 * (detail('bevelSegments', 6, 1, 128) + 1) + 2 * ((value.segments ?? 80) + 2);
    case 'sphere':
      return (detail('segments', 64, 3, 2048) + 1) * (detail('rings', 40, 2, 2048) + 1);
    case 'grid':
    case 'plane':
      return (detail('segments', 16, 1, 64) + 1) ** 2;
    case 'cone':
      return (detail('segments', 64, 3, 2048) + 1) * 2 + 2 * ((value.segments ?? 64) + 2);
    case 'icoSphere':
      return 10 * 4 ** detail('subdivisions', 2, 0, 7) + 2;
    case 'circle':
      return value.innerRadius > 0 ? (detail('segments', 64, 3, 2048) + 1) * 2 : detail('segments', 64, 3, 2048) + 2;
    case 'line': {
      const sides = detail('radialSegments', 8, 3, 128);
      lineEnds(value);
      return 2 * sides * 2 + 2 * (sides + 1);
    }
    case 'torus':
      checkTorusShape(value.tubeRadius, value.arc);
      return (detail('segments', 96, 3, 2048) + 1) * (detail('sides', 24, 3, 128) + 1) + 2 * ((value.sides ?? 24) + 2);
    case 'lathe': {
      const profileCount = points(value.profile, 2, 2, 'profile');
      agentSceneModule('modeling').checkLatheProfile(value.profile);
      return (detail('segments', 64, 3, 2048) + 1) * profileCount;
    }
    case 'tube':
      points(value.path, 3, value.closed ? 3 : 2, 'path');
      if (value.closed !== undefined && typeof value.closed !== 'boolean') {
        throw invalidField('closed', value.closed, 'true or false', TypeError);
      }
      agentSceneModule('modeling').checkTubeInputs(value.path, value.radius ?? 0.1, value.closed ?? false);
      return (detail('segments', 64, 3, 2048) + 1) * (detail('radialSegments', 12, 3, 128) + 1);
    case 'curve': {
      if (['shape', 'splines', 'kind', 'weights', 'order', 'knots', 'knotMode', 'trim', 'grow'].some(field => value[field] !== undefined)) {
        return agentSceneModule('modeling').curveGeometryVertexCount(value);
      }
      const knots = value.points;
      if (!Array.isArray(knots) || knots.length < 2 || knots.length > CURVE_TEXT_LIMITS.maxCurvePoints) {
        throw invalidField('points', Array.isArray(knots) ? `${knots.length} points` : knots, `a list of 2 to ${CURVE_TEXT_LIMITS.maxCurvePoints} points, such as [[0, 0, 0], [0, 1, 0]]`);
      }
      const curveChecks = agentSceneModule('modeling');
      curveChecks.checkCurveRadius(value.radius ?? 0.05);
      curveChecks.checkClosedFlag(value.closed ?? false);
      const sides = value.profile === undefined ? detail('radialSegments', 8, 3, 128) : points(value.profile, 2, 3, 'profile');
      const rings = (value.closed ? knots.length : knots.length - 1) * detail('resolution', 12, 1, 64) + 1;
      return rings * sides * 2 + 2 * (sides + 1);
    }
    case 'sdf':
      return agentSceneModule('modeling').sdfVertexEstimate(value);
    case 'text': {
      if (typeof value.text !== 'string') throw invalidField('text', value.text, 'a string, such as "Hello"', TypeError);
      const visible = [...value.text].filter(character => !/\s/.test(character)).length;
      const isDefaultFont = value.font === undefined || value.font === 'default';
      const perSegment = isDefaultFont ? CURVE_TEXT_LIMITS.verticesPerCharacterSegment : CURVE_TEXT_LIMITS.verticesPerCustomCharacterSegment;
      return visible * perSegment * detail('curveSegments', 4, 1, 16);
    }
    case 'terrain':
      return agentSceneModule('terrain').terrainVertexEstimate(value);
    case 'floorPlan':
      return agentSceneModule('floorPlan').floorPlanVertexEstimate(value);
    case 'cloud':
      return agentSceneModule('modeling').cloudVertexEstimate(value);
    case 'extrude': {
      const holes = value.holes ?? [];
      if (!Array.isArray(holes) || holes.length > 128) {
        throw invalidField('holes', Array.isArray(holes) ? `${holes.length} rings` : holes, 'a list of at most 128 rings of points, such as []');
      }
      const count = points(value.contour, 2, 3, 'contour') + holes.reduce((total, hole) => total + points(hole, 2, 3, 'holes'), 0);
      if (count > 4096) {
        throw invalidField('contour', `${count} points`, 'a contour and holes with at most 4096 points in total; simplify them');
      }
      agentSceneModule('modeling').checkExtrudeRings(value.contour, holes);
      const beveled = (value.bevel ?? 0) > 0 || (value.bevelThickness ?? value.bevel ?? 0) > 0;
      return 6 * (count + holes.length * 2 - 2) + 6 * count * (detail('steps', 1, 1, 256) + (beveled ? detail('bevelSegments', 3, 1, 32) * 2 : 0));
    }
    case 'fragment':
      return fragmentEstimate(value, scope);
    case 'dented':
      return agentSceneModule('vehicleDamage').dentedVertexEstimate(value, scope.definitions, source => geometryEstimate(source, { definitions: scope.definitions, chain: [] }));
    case 'mesh': {
      const base = value.base;
      if (!base || typeof base !== 'object' || Array.isArray(base) || base.type === 'mesh' || Object.hasOwn(base, 'id')) {
        throw invalidField('base', base, 'a primitive or profile record without an id, such as { "type": "box" } (box, cylinder, sphere, torus, lathe, extrude, tube, grid or plane)', TypeError);
      }
      let estimate = meshBaseSplitsBox(base) ? 6 * (integer(base.subdivisions, 1, 128, 'subdivisions') + 1) ** 2 : geometryEstimate({ id: 'base', ...base });
      const cutterScope = meshCutterScope(value, scope);
      let referencedWork = 0;
      for (const edit of agentSceneModule('mesh').normalizeMeshEdits(value.edits ?? [])) {
        const reference = geometryReferenceOf(edit);
        if (!reference) continue;
        const cutterVertices = cutterEstimate(reference, cutterScope);
        estimate += cutterVertices;
        if (isCutterReference(reference)) referencedWork += cutterVertices;
      }
      if (referencedWork > MAX_CUTTER_WORK_VERTICES) {
        throw invalidField('cutter.geometry', `${referencedWork} estimated cutter vertices in ${cutterScope.chain.join(' -> ')}`, `cutter geometries that total at most ${MAX_CUTTER_WORK_VERTICES} estimated vertices; use fewer segments or fewer referenced cutters`);
      }
      // Stack nodes multiply the mesh: arrays by their count, mirror and solidify at most by two.
      for (const node of agentSceneModule('mesh').normalizeMeshStack(value.stack ?? [])) estimate *= node.op === 'array' ? node.count : 2;
      if (value.shapeKeys !== undefined) agentSceneModule('mesh').normalizeShapeKeys(value.shapeKeys);
      if (value.slots !== undefined) agentSceneModule('mesh').normalizeMaterialSlots(value.slots);
      if (value.smoothAngle !== undefined && (value.smoothAngle < 0 || value.smoothAngle > 180)) {
        throw invalidField('smoothAngle', value.smoothAngle, 'degrees from 0 to 180, such as 30');
      }
      // Edits can grow the mesh; the real size is checked against maxVertices after generation.
      return estimate * 2;
    }
  }
}

// One Voronoi piece of the geometry named by `source`. Its size is only bounded by the source, so it is checked against maxVertices once built.
function fragmentEstimate(value, scope) {
  if (typeof value.source !== 'string') {
    throw invalidField('source', value.source, 'the ID of a convex geometry in geometries, such as "wall"', TypeError);
  }
  const cells = integer(value.cells, 2, 64, 'cells');
  integer(value.index, 0, cells - 1, 'index');
  integer(value.seed ?? 1, 0, 4294967295, 'seed');
  if (value.impact !== undefined) vector(value.impact, 3, 'impact');
  if (value.impactRadius !== undefined && !(value.impactRadius > 0)) {
    throw invalidField('impactRadius', value.impactRadius, 'a distance above 0 in the source local space, such as 0.5');
  }
  if (!scope.definitions) return 16 * cells;
  const source = scope.definitions.get(value.source);
  if (!source || source.type === 'fragment') {
    const reason = source ? 'a geometry that is not itself a fragment' : `the ID of a geometry in geometries, one of ${[...scope.definitions.keys()].slice(0, 8).join(', ') || 'none yet'}`;
    throw invalidField(`geometries.${value.id}.source`, value.source, reason);
  }
  return geometryEstimate(source, { definitions: scope.definitions, chain: [] }) + 16 * cells;
}

function hasFaceImages(nodes) {
  return Array.isArray(nodes) && nodes.some(node => node?.faceImages !== undefined);
}

function hasInstancedNodes(nodes) {
  return !Array.isArray(nodes) || nodes.some(node => node && typeof node === 'object' && Object.hasOwn(node, 'instances'));
}

function isCutterReference(cutter) {
  return Object.hasOwn(cutter, 'geometry');
}

function meshCutterScope(meshDefinition, scope) {
  return scope && { ...scope, chain: scope.chain.length ? scope.chain : [meshDefinition.id] };
}

function cutterEstimate(cutter, scope) {
  if (isCutterReference(cutter)) return referencedCutterEstimate(cutter, scope);
  if (cutter.type === 'mesh' || Object.hasOwn(cutter, 'id')) {
    throw invalidField('cutter', cutter, 'a primitive or profile record without an id, such as { "type": "box" } (box, cylinder, sphere, torus, lathe, extrude or tube), or { "geometry": "<recipe geometry id>" }', TypeError);
  }
  return geometryEstimate({ id: 'cutter', ...cutter });
}

// A cutter naming a recipe geometry. scope.chain lists the meshes on the way here, the first being the mesh being built.
function referencedCutterEstimate(cutter, scope) {
  if (Object.keys(cutter).length !== 1 || typeof cutter.geometry !== 'string') {
    throw invalidField('cutter', cutter, 'only { "geometry": "<recipe geometry id>" }; put translation, rotation and scale on the boolean edit', TypeError);
  }
  if (!scope) {
    throw invalidField('cutter.geometry', cutter.geometry, 'a primitive or profile record such as { "type": "box" }; only recipe meshes can name another geometry');
  }
  const chain = [...scope.chain, cutter.geometry];
  if (chain.indexOf(cutter.geometry) !== chain.length - 1) {
    throw invalidField('cutter.geometry', chain.join(' -> '), `a geometry that does not cut with itself; remove ${cutter.geometry} from the cutters of ${scope.chain[scope.chain.length - 1]} or give it another cutter`);
  }
  if (chain.length - 1 > MAX_CUTTER_DEPTH) {
    throw invalidField('cutter.geometry', chain.join(' -> '), `a chain of at most ${MAX_CUTTER_DEPTH} cutter geometries; build the inner cutters into one geometry`);
  }
  if (!scope.definitions) return 0;
  const definition = scope.definitions.get(cutter.geometry);
  if (!definition) {
    throw invalidField('cutter.geometry', chain.join(' -> '), `the ID of a geometry in geometries, one of ${[...scope.definitions.keys()].join(', ') || 'none yet'}; add ${cutter.geometry} or pick one of them`);
  }
  return geometryEstimate(definition, { definitions: scope.definitions, chain });
}

// What an edit reads from another recipe geometry or primitive: a boolean's cutter, or the geometry a join adds.
function geometryReferenceOf(edit) {
  if (edit?.op === 'boolean') return edit.cutter;
  if (edit?.op === 'join') return { geometry: edit.geometry };
  return null;
}

function namesCutterGeometry(edit) {
  return typeof geometryReferenceOf(edit)?.geometry === 'string';
}

// The records of the cutter geometries a mesh names, nested ones included: what its result depends on beyond its own record.
function cutterDependencySignature(meshDefinition, definitions) {
  const parts = [];
  for (const edit of meshDefinition.edits ?? []) {
    if (!namesCutterGeometry(edit)) continue;
    const definition = definitions.get(geometryReferenceOf(edit).geometry);
    parts.push(JSON.stringify(definition), cutterDependencySignature(definition, definitions));
  }
  return parts.join('|');
}

// Validates the cutter chain (cycles, depth, missing IDs, work) before returning its signature, so the signature walk ends.
function checkedCutterDependencies(meshDefinition, definitions) {
  if (!(meshDefinition.edits ?? []).some(namesCutterGeometry)) return '';
  geometryEstimate(meshDefinition, { definitions, chain: [] });
  return cutterDependencySignature(meshDefinition, definitions);
}

/** Cache identity of a geometry record: its own fields plus the cutter geometries it depends on. */
function geometrySignature(definition, definitions, heightSources) {
  if (definition.type === 'fragment') {
    // The pieces depend on the source record, so editing the source changes the key. Estimating first rejects a missing or fragment source.
    geometryEstimate(definition, { definitions, chain: [] });
    return `${JSON.stringify(definition)}|source|${geometrySignature(definitions.get(definition.source), definitions, heightSources)}`;
  }
  if (definition.type === 'dented') {
    geometryEstimate(definition, { definitions, chain: [] });
    return `${JSON.stringify(definition)}|source|${geometrySignature(definitions.get(definition.source), definitions, heightSources)}`;
  }
  const dependencies = definition.type === 'mesh' ? checkedCutterDependencies(definition, definitions) : '';
  const heights = definition.type === 'mesh' ? heightDependencies(definition, heightSources) : '';
  return `${JSON.stringify(definition)}${dependencies ? `|cutters|${dependencies}` : ''}${heights ? `|heights|${heights}` : ''}`;
}

// The materials a displace source reads, so editing a graph height rebuilds the mesh that follows it.
function heightDependencies(meshDefinition, heightSources) {
  return agentSceneModule('mesh').displaceHeightSignature(meshDefinition, heightSources?.materials);
}

/** The materials and decoded images a mesh displace edit reads its height from. */
function heightSourcesOf(recipe, images) {
  return { materials: new Map(recipe.materials.map(material => [material.id, material])), images };
}

function geometryDefinitions(geometries) {
  return new Map(geometries.map(definition => [definition.id, definition]));
}

function cutterScopeOf(geometries, heightSources) {
  return { definitions: geometryDefinitions(geometries), chain: [], heightSources };
}

/** Render geometry of a boolean cutter record, checked like the cutters of recipe meshes. Used by imported-part edits. */
export function generateCutterGeometry(cutter, maxVertices) {
  cutterEstimate(cutter);
  return generateGeometry(cutter, maxVertices);
}

// The box a room's walls are drawn with where they meet (#2298): its edges are sharp, so joined walls leave no groove for light to enter.
let sharpJoinBox = null;
function sharpJoinBoxGeometry() {
  sharpJoinBox ??= Object.freeze(box(0));
  return sharpJoinBox;
}

function generateGeometry(value, maxVertices, scope) {
  switch (value.type) {
    case 'box':
      return box(value.bevel, value.subdivisions);
    case 'cylinder':
      return cylinder(value.segments, value.bevel, value.bevelSegments);
    case 'sphere':
      return sphere(value.segments, value.rings);
    case 'grid':
    case 'plane':
      return grid(value.segments);
    case 'cone':
      return cone(value.radiusTop, value.radiusBottom, value.segments);
    case 'icoSphere':
      return icoSphere(value.subdivisions);
    case 'circle':
      return circle(value.segments, value.innerRadius);
    case 'line':
      return agentSceneModule('modeling').curve(lineEnds(value), { radius: value.radius, radialSegments: value.radialSegments, resolution: 1, maxVertices });
    case 'torus':
      return torus(value.tubeRadius, value.segments, value.sides, value.arc, value.start);
    case 'lathe':
      return agentSceneModule('modeling').lathe(value.profile, { ...value, maxVertices });
    case 'extrude':
      return agentSceneModule('modeling').extrude(value.contour, { ...value, maxVertices });
    case 'tube':
      return agentSceneModule('modeling').tube(value.path, { ...value, maxVertices });
    case 'sdf':
      return agentSceneModule('modeling').sdfGeometry(value, maxVertices);
    case 'curve':
      return agentSceneModule('modeling').curveGeometry(value, maxVertices);
    case 'text':
      return agentSceneModule('text').text(value.text, { ...value, maxVertices });
    case 'terrain':
      return agentSceneModule('terrain').generateTerrainGeometry(value, maxVertices);
    case 'floorPlan':
      return agentSceneModule('floorPlan').generateFloorPlanGeometry(value, maxVertices);
    case 'cloud':
      return agentSceneModule('modeling').cloudGeometry(value, maxVertices);
    case 'fragment': {
      if (!scope) throw invalidField('type', 'fragment', 'a geometry inside a recipe, where its source geometry is found by ID');
      const source = scope.definitions.get(value.source);
      return agentSceneModule('fracture').fragmentGeometry(value, geometrySignature(source, scope.definitions),
        () => generateGeometry(source, maxVertices, { ...scope, chain: [] }));
    }
    case 'dented': {
      if (!scope) throw invalidField('type', 'dented', 'a geometry inside a recipe, where its source geometry is found by ID');
      const { source, id, type, ...dent } = value;
      return agentSceneModule('vehicleDamage').dentGeometry(generateGeometry(scope.definitions.get(source), maxVertices, { ...scope, chain: [] }), dent);
    }
    case 'mesh': {
      const cutterScope = meshCutterScope(value, scope);
      const dependencies = scope ? checkedCutterDependencies(value, scope.definitions) : '';
      const heights = heightDependencies(value, scope?.heightSources);
      return agentSceneModule('mesh').generateMeshGeometry(() => meshBaseSplitsBox(value.base) ? box(0, value.base.subdivisions, true) : generateGeometry(value.base, maxVertices), value.edits ?? [], {
        maxVertices, smoothAngle: value.smoothAngle,
        stack: value.stack ?? [], shapeKeys: value.shapeKeys ?? [], slots: value.slots,
        // The edits only name a cutter geometry, so that geometry's own record joins the key: editing it changes the key.
        cacheKey: `${JSON.stringify(value.base)}${dependencies ? `|cutters|${dependencies}` : ''}${heights ? `|heights|${heights}` : ''}`,
        heightSources: scope?.heightSources,
        resolveCutter: cutter => {
          cutterEstimate(cutter, cutterScope);
          if (!isCutterReference(cutter)) return generateGeometry(cutter, maxVertices);
          const chain = [...cutterScope.chain, cutter.geometry];
          return generateGeometry(scope.definitions.get(cutter.geometry), maxVertices, { ...scope, chain });
        },
      });
    }
  }
}

/** Render geometry of a candidate recipe's geometry by ID, for an operation that needs the real mesh (fracture-node). */
function generateOperationGeometry(candidate, geometryId, limits) {
  const definitions = geometryDefinitions(candidate.geometries);
  const definition = definitions.get(geometryId);
  if (!definition) {
    throw invalidField('node', geometryId, `a node whose geometry exists; add the geometry ${geometryId} first`);
  }
  geometryEstimate(definition, { definitions, chain: [] });
  return generateGeometry(definition, Math.min(limits.maxVertices, 1_000_000), { definitions, chain: [] });
}

function compile(recipe, geometries, localBounds, limits) {
  const materials = new Map(recipe.materials.map(material => [material.id, material]));
  const graph = createSceneGraph(recipe.nodes.map(node => {
    if (node.geometry !== undefined && (!geometries.has(node.geometry) || !materials.has(node.material))) {
      const missingField = geometries.has(node.geometry) ? 'material' : 'geometry';
      throw invalidField(`nodes.${node.id}.${missingField}`, node[missingField], `one of ${(geometries.has(node.geometry) ? [...materials.keys()] : [...geometries.keys()]).join(', ')}`);
    }
    return { name: node.id, parent: node.parent,
      matrix: node.assetPart ? mat4.clone(node.assetPart.matrix) : mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale),
      geometry: geometries.get(node.geometry), material: materials.get(node.material) };
  }), limits);
  validateGraph(graph, localBounds);
  return graph;
}

function validateGraph(graph, localBounds) {
  const normal = mat3.create();
  for (const node of graph.nodes) {
    if (!mat3.normalFromMat4(normal, node.worldMatrix) || !normal.every(Number.isFinite)) {
      throw new RangeError(`Node ${node.name} normal transform exceeds Float32 range.`);
    }
    if (node.geometry) {
      const bounds = localBounds.get(node.geometry);
      const matrix = node.worldMatrix;
      for (let corner = 0; corner < 8; corner++) {
        const pointX = corner & 1 ? bounds.max[0] : bounds.min[0];
        const pointY = corner & 2 ? bounds.max[1] : bounds.min[1];
        const pointZ = corner & 4 ? bounds.max[2] : bounds.min[2];
        for (let axis = 0; axis < 3; axis++) {
          // Bound every multiplication and possible addition order, before cancellation.
          const absoluteSum = Math.abs(matrix[axis] * pointX) + Math.abs(matrix[4 + axis] * pointY) +
            Math.abs(matrix[8 + axis] * pointZ) + Math.abs(matrix[12 + axis]);
          if (!Number.isFinite(Math.fround(absoluteSum))) {
            throw new RangeError(`Node ${node.name} world geometry bounds exceed Float32 range.`);
          }
        }
      }
    }
  }
}

function boundsFor(geometry, matrix) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const positions = geometry.positions;
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * positions[offset] + matrix[4 + axis] * positions[offset + 1] + matrix[8 + axis] * positions[offset + 2] + matrix[12 + axis];
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  return { min: minimum, max: maximum };
}

// An armature's nodes come first and are regenerated from it each time, so edits go through armatures, not through bone nodes.
function addArmatures(recipe, limits) {
  if (!Object.hasOwn(recipe, 'armatures')) {
    for (const node of recipe.nodes) {
      if (node.skin) {
        throw invalidField(`nodes.${node.id}.skin`, node.skin, 'a skin only when the recipe has armatures; add an armatures list or remove skin');
      }
    }
    return;
  }
  const userNodes = new Map(recipe.nodes.map(node => [node.id, node]));
  const resolveBounds = (armature, nodeId) => {
    const node = userNodes.get(nodeId);
    if (!node?.geometry) {
      throw invalidField(`armatures.${armature.id}.fit`, nodeId, 'the ID of a mesh node with a geometry, such as one scene_inspect lists');
    }
    const definition = recipe.geometries.find(geometry => geometry.id === node.geometry);
    const bounds = boundsFor(generateGeometry(definition, Math.min(limits.maxVertices, 1_000_000), cutterScopeOf(recipe.geometries, heightSourcesOf(recipe))), mat4.create());
    const toArmature = mat4.invert(mat4.create(), restWorldMatrix(armature.id, userNodes, [armature]));
    const toWorld = restWorldMatrix(node.id, userNodes);
    return transformedBounds(bounds, mat4.multiply(mat4.create(), toArmature, toWorld));
  };
  recipe.armatures = normalizeArmatures(recipe.armatures, { resolveBounds });
  const derived = recipe.armatures.flatMap(armatureNodes);
  for (const node of derived) {
    if (userNodes.has(node.id)) {
      throw invalidField(`armatures.${node.id}`, node.id, 'a bone node ID no other node uses; give the armature a prefix, such as "rig-"');
    }
  }
  if (new Set(derived.map(node => node.id)).size !== derived.length) {
    throw invalidField('armatures', recipe.armatures.map(armature => armature.id), 'armatures that generate different node IDs; give one a prefix, such as "rig-"');
  }
  for (const node of recipe.nodes) {
    if (node.skin && !recipe.armatures.some(armature => armature.id === node.skin.armature)) {
      throw invalidField(`nodes.${node.id}.skin.armature`, node.skin.armature, `one of ${recipe.armatures.map(armature => armature.id).join(', ')}`);
    }
  }
  recipe.nodes = [...derived, ...recipe.nodes];
}

const DEFAULT_MATERIAL_ID = 'default';

/**
 * A node that names a geometry and no material gets the material "default" (neutral grey, every field at its default),
 * added to the recipe when it is missing, so the normalized and exported recipe stays explicit.
 */
function withDefaultMaterial(recipe) {
  const materials = recipe.materials;
  const nodes = Array.isArray(recipe.nodes) ? recipe.nodes : [];
  const unpainted = nodes.filter(node => node?.geometry !== undefined && node.material === undefined);
  if (unpainted.length === 0 || !Array.isArray(materials)) {
    return materials;
  }
  for (const node of unpainted) {
    node.material = DEFAULT_MATERIAL_ID;
  }
  const alreadyDefined = materials.some(material => material?.id === DEFAULT_MATERIAL_ID);
  return alreadyDefined ? materials : [...materials, { id: DEFAULT_MATERIAL_ID }];
}

// A name that matches no node would leave the light lighting nothing without a sign, so it fails and says what to do.
function checkLightLinkNames(recipe) {
  if (!environmentLinksLights(recipe.environment)) {
    return;
  }
  agentSceneModule('lightLinking').requireKnownLightLinkNames(recipe.environment, recipe.nodes);
}

// A typo in lines.nodes would turn nothing off without a sign. A node that exists but is hidden stays valid.
function checkLineNodeNames(recipe) {
  const lines = recipe.environment?.lines;
  if (!lines?.nodes) {
    return;
  }
  const unknown = agentSceneModule('lineArt').unknownLineNodeNames(lines, recipe.nodes);
  if (unknown.length > 0) {
    throw invalidField('environment.lines.nodes', unknown.slice(0, 4), `node IDs that exist in nodes${unknown.length > 4 ? ` (${unknown.length - 4} more are unknown too)` : ''}; scene_inspect lists them. After remove-node, drop that node's entry from lines.nodes in the same call`);
  }
  // A group that draws nothing itself (an expanded instances node, a plain group) would do nothing without a sign.
  // A placed asset, vegetation and crowd nodes are groups too, but their parts name them in `group`.
  const drawsNothing = recipe.nodes.find(node => Object.hasOwn(lines.nodes, node.id) && node.geometry === undefined && !node.asset && !growsParts(node));
  if (drawsNothing) {
    const childIds = recipe.nodes.filter(node => node.parent === drawsNothing.id).map(node => node.id);
    throw invalidField(`environment.lines.nodes.${drawsNothing.id}`, drawsNothing.id, `the ID of a node that draws a part; ${JSON.stringify(drawsNothing.id)} is a group with no geometry of its own. ${childIds.length > 0 ? `Name its children instead, such as ${childIds.slice(0, 3).join(', ')}` : 'It has no children, so remove its entry from lines.nodes'}`);
  }
}

// Every light's affects list in light order: the mask of a part depends on these lists and nothing else of the environment.
function lightLinksKey(environment) {
  const lights = [...environment.pointLights, ...(environment.spotLights ?? []), ...(environment.areaLights ?? [])];
  return JSON.stringify([environment.keyAffects ?? null, ...lights.map(light => light.affects ?? null)]);
}

// A part that a light skips needs its own material object with the light mask, but it must still read every other
// field from the live material, so motion tracks keep driving it. One wrapper per material and mask keeps batches.
function linkedMaterial(liveMaterial, lightMask, wrappers) {
  const byMask = wrappers.get(liveMaterial) ?? new Map();
  wrappers.set(liveMaterial, byMask);
  if (!byMask.has(lightMask)) {
    const wrapper = {};
    for (const field of Object.keys(liveMaterial)) {
      Object.defineProperty(wrapper, field, { enumerable: true, get: () => liveMaterial[field] });
    }
    Object.defineProperty(wrapper, 'lightMask', { enumerable: true, value: lightMask });
    byMask.set(lightMask, Object.freeze(wrapper));
  }
  return byMask.get(lightMask);
}

// Nodes the normalizer returned that nothing rewrites afterwards; a staged recipe is read-only, so a later edit that shares them skips checking them again.
const NORMALIZED_NODES = new WeakSet();

function normalizeRecipe(input, limits, { alreadyCopied = false } = {}) {
  let recipe = alreadyCopied ? input : copiedJson(input, limits.maxRecipeBytes);
  knownKeys(recipe, ['format', 'schemaVersion', 'geometries', 'materials', 'nodes', 'armatures', 'camera', 'environment', 'effects', 'shadow', 'motion', 'physics', 'cloth', 'timeline', 'particles', 'bake', 'postPasses', 'postPassesAntialias', 'pixelGrid', 'game'], 'recipe');
  if (recipe.format !== 'crucible.scene' || recipe.schemaVersion !== 1) {
    throw invalidField(recipe.format !== 'crucible.scene' ? 'format' : 'schemaVersion', recipe.format !== 'crucible.scene' ? recipe.format : recipe.schemaVersion, recipe.format !== 'crucible.scene' ? '"crucible.scene"' : '1');
  }
  // A scene with no mesh, or whose nodes all take the default material, has nothing to list: absent means empty.
  // Placed assets generate their own geometries, materials and part nodes each time; an exported or checkpointed recipe may still carry them.
  recipe.geometries ??= [];
  recipe.materials ??= [];
  if (hasFaceImages(recipe.nodes)) recipe.nodes = agentSceneModule('assets').expandFaceImages(recipe, limits);
  if (Array.isArray(recipe.geometries)) recipe.geometries = recipe.geometries.filter(geometry => geometry?.type !== 'asset');
  if (Array.isArray(recipe.materials)) recipe.materials = recipe.materials.filter(material => !material?.assetSource);
  if (Array.isArray(recipe.nodes)) recipe.nodes = recipe.nodes.filter(node => !node?.assetPart);
  recipe.geometries = resources(recipe.geometries, limits.maxGeometries, 'geometries', value => {
    geometryEstimate(value);
    const definition = { id: value.id, type: value.type === 'plane' ? 'grid' : value.type };
    for (const field of GEOMETRY_FIELDS[value.type]) {
      if (Object.hasOwn(value, field)) {
        definition[field] = value[field];
      }
    }
    return definition;
  });
  // Every geometry exists now, so cutter IDs, cycles, depth and work can be checked.
  const definitionsById = geometryDefinitions(recipe.geometries);
  recipe.geometries.forEach((definition, index) => {
    if (definition.type === 'mesh') withFieldPrefix(`geometries[${index}]`, () => checkedCutterDependencies(definition, definitionsById));
  });
  recipe.materials = resources(withDefaultMaterial(recipe), limits.maxMaterials, 'materials', materialFrom);
  const slottedGeometries = new Set(recipe.geometries.filter(definition => definition.slots !== undefined).map(definition => definition.id));
  const skinnedSlotted = (recipe.nodes ?? []).find(node => node.skin !== undefined && slottedGeometries.has(node.geometry));
  if (skinnedSlotted) {
    throw invalidField(`nodes.${skinnedSlotted.id}.skin`, skinnedSlotted.skin, `a node whose geometry has no material slots: geometry ${skinnedSlotted.geometry} has slots, and a skin rebuilds the mesh the slots were measured on; remove skin, or remove slots from ${skinnedSlotted.geometry}`);
  }
  recipe.geometries.forEach((definition, index) => {
    if (definition.type === 'mesh') withFieldPrefix(`geometries[${index}]`, () => agentSceneModule('mesh').checkDisplaceMaterials(definition, heightSourcesOf(recipe).materials));
    if (definition.type === 'mesh') withFieldPrefix(`geometries[${index}]`, () => agentSceneModule('mesh').checkMaterialSlots(definition, new Set(recipe.materials.map(material => material.id))));
  });
  const distinctPatterns = new Set(recipe.materials.filter(material => material.pattern).map(material => JSON.stringify(material.pattern)));
  if (distinctPatterns.size > MAX_MATERIAL_PATTERNS) {
    throw invalidField('materials', `${distinctPatterns.size} different patterns`, `at most ${MAX_MATERIAL_PATTERNS} different material patterns; reuse one and tint it with color`);
  }
  recipe.nodes = withoutArmatureNodes(recipe.nodes);
  if (hasInstancedNodes(recipe.nodes)) recipe.nodes = agentSceneModule('mesh').expandInstancedNodes(recipe.nodes, {
    maxNodes: limits.maxNodes,
    resolveSurface: id => {
      const definition = recipe.geometries.find(geometry => geometry.id === id);
      if (!definition) throw invalidField('instances.surface', id, `the ID of a geometry in geometries, such as ${recipe.geometries[0]?.id ?? 'ground'}`);
      return generateGeometry(definition, Math.min(limits.maxVertices, 1_000_000), cutterScopeOf(recipe.geometries, heightSourcesOf(recipe)));
    },
  }, recipe.geometries);
  recipe.nodes = resources(recipe.nodes, limits.maxNodes, 'nodes', nodeFrom, { alreadyNormalized: NORMALIZED_NODES, isShareable: node => NODE_KEYS_NEEDING_OWN_COPY.every(key => node[key] === undefined) });
  addArmatures(recipe, limits);
  if (recipe.nodes.some(node => node.relations !== undefined)) {
    recipe.nodes = agentSceneModule('relations').normalizeRelations(recipe.nodes);
  }
  recipe.camera = cameraFrom(recipe.camera);
  const look = {};
  for (const field of ['environment', 'effects', 'shadow']) {
    if (Object.hasOwn(recipe, field)) {
      look[field] = recipe[field];
    }
  }
  Object.assign(recipe, normalizeAgentLook(look));
  if (recipe.camera.fStop !== undefined && recipe.effects?.depthOfField.blur > 0) {
    throw invalidField('camera.fStop', recipe.camera.fStop, 'a camera without effects.depthOfField.blur above 0; set blur to 0 or set-camera fStop null');
  }
  checkLightLinkNames(recipe);
  checkLineNodeNames(recipe);
  if (recipe.effects?.distortion || recipe.effects?.flash) agentSceneModule('postSteps').checkAirStepNodes(recipe);
  if (Object.hasOwn(recipe, 'motion')) {
    recipe.motion = recipe.motion === null || recipe.motion === undefined ? null : agentSceneModule('motion').normalizeAgentMotion(recipe.motion, recipe);
  }
  if (Object.hasOwn(recipe, 'physics')) {
    recipe.physics = agentSceneModule('physics').normalizeAgentPhysics(recipe.physics, recipe);
  }
  if (Object.hasOwn(recipe, 'cloth')) {
    recipe.cloth = agentSceneModule('cloth').normalizeAgentCloth(recipe.cloth, recipe);
  }
  if (Object.hasOwn(recipe, 'timeline')) {
    if (recipe.timeline === null) {
      delete recipe.timeline;
    } else {
      recipe.timeline = agentSceneModule('timeline').normalizeFilmTimeline(recipe.timeline, recipe, { checkCamera: shotCameraOverrides => cameraOverridesFrom(recipe.camera, shotCameraOverrides) });
    }
  }
  if (Object.hasOwn(recipe, 'particles')) {
    recipe.particles = agentSceneModule('particles').normalizeAgentParticles(recipe.particles, recipe);
  }
  if (Object.hasOwn(recipe, 'bake')) {
    recipe.bake = recipe.bake === null ? null : agentSceneModule('bake').normalizeAgentBake(recipe.bake);
  }
  if (Object.hasOwn(recipe, 'postPasses')) recipe.postPasses = agentSceneModule('userPass').normalizeUserPasses(recipe.postPasses ?? []);
  if (Object.hasOwn(recipe, 'postPassesAntialias')) recipe.postPassesAntialias = agentSceneModule('userPass').normalizePostPassesAntialias(recipe.postPassesAntialias);
  if (Object.hasOwn(recipe, 'pixelGrid')) {
    // Cleared with null, the recipe reads as if it never had a grid, and the on-demand grid module is not needed.
    if (recipe.pixelGrid === null) delete recipe.pixelGrid;
    else recipe.pixelGrid = agentSceneModule('pixelGrid').normalizePixelGrid(recipe.pixelGrid);
  }
  if (recipe.nodes.some(node => node.billboard)) agentSceneModule('textBillboard').checkBillboardMaterials(recipe);
  if (Object.hasOwn(recipe, 'game')) {
    if (recipe.game === null) delete recipe.game;
    else recipe.game = agentSceneModule('game').normalizeGameSetup(recipe.game, recipe.nodes);
  }
  if (alreadyCopied) {
    // The input was checked JSON and each step above returns checked JSON, so only the size can have grown.
    assertWithinRecipeBytes(new TextEncoder().encode(JSON.stringify(recipe)).length, limits.maxRecipeBytes);
    return recipe;
  }
  recipe = copiedJson(recipe, limits.maxRecipeBytes);
  return recipe;
}

// A shot camera is a partial camera: it must be valid on top of the recipe camera, and only its own fields are kept.
function cameraOverridesFrom(baseCamera, overrides) {
  cameraFrom({ ...baseCamera, ...overrides });
  return structuredClone(overrides);
}

const viewBytes = values => values.reduce((total, value) => total + (ArrayBuffer.isView(value) ? value.byteLength : 0), 0);

/** Bytes a geometry holds: its typed arrays and the arrays of its morph targets, which are not typed fields themselves. */
export function geometryBufferBytes(geometry) {
  return viewBytes(Object.values(geometry)) + viewBytes((geometry.morphTargets ?? []).flatMap(target => [target.positions, target.normals]));
}

// geometryBytes is the generated geometry the scene's maxGeometryBytes budget limits. assetBytes is the decoded asset geometry the
// asset decoder bounds instead; residentBytes is both, the memory the scene really holds.
function geometryStats(records) {
  let vertices = 0;
  let geometryBytes = 0;
  let residentBytes = 0;
  let estimatedGeometryBytes = 0;
  for (const record of records) {
    vertices += record.vertices;
    geometryBytes += record.geometryBytes;
    residentBytes += record.geometryBytes + (record.assetBytes ?? 0);
    estimatedGeometryBytes += record.estimatedVertices * 56;
  }
  return { vertices, geometryBytes, estimatedGeometryBytes, residentBytes };
}

function batchSignature(material) {
  // Textures are fixed per renderer, so a changed pattern rebuilds it like a changed tag does.
  // Transmission moves a material to the pass that sees the opaque scene, which is fixed per renderer.
  // Snippet uniform values bind per draw, so only changing the compiled feature or mask needs a new handle (#3163).
  return `${material.tag}|${material.alphaMode}|${material.alphaCutoff}|${material.opacity}|${material.transmission > 0}|${material.doubleSided}|${material.depthTest !== false}|${JSON.stringify(material.pattern ?? material.map ?? material.text ?? null)}|${material.snippet?.feature}|${material.snippet?.mask}${textureMapSignature(material)}`;
}

// A material's uvScale, uvOffset, uvRotation and worldScale are baked into the UVs of the geometry it draws, like glTF KHR_texture_transform.
// A material without them returns the geometry untouched, so its parts, uploads and pixels are as before.
function geometryWithMaterialUvs(geometry, recipe, materialId, graph, nodeId) {
  const material = recipe.materials.find(candidate => candidate.id === materialId);
  if (!material || !UV_TRANSFORM_FIELDS.some(field => material[field] !== undefined)) return geometry;
  return agentSceneModule('assets').geometryWithUvTransform(geometry, material, graph.getNode(nodeId).worldMatrix, nodeId);
}

// The catalog maps of a material are textures fixed per renderer like a pattern, so another map or convention builds a new handle. Empty for a material without them.
function textureMapSignature(material) {
  const maps = TEXTURE_MAP_FIELDS.filter(field => material[field] !== undefined).map(field => `${field}:${material[field]}`);
  return maps.length ? `|${maps.join(',')}|${material.normalConvention ?? ''}` : '';
}

function materialHandle(snapshot, sequence, images) {
  const holder = { snapshot, sequence, images };
  holder.catalogTextures = catalogTexturesOf(holder);
  const output = {};
  for (const field of ['id', 'tag', ...MATERIAL_FIELDS, ...HEIGHT_PARALLAX_FIELDS]) {
    Object.defineProperty(output, field, {
      enumerable: true,
      configurable: true,
      get() {
        return holder.snapshot[field];
      },
    });
  }
  for (const field of PATTERN_TEXTURE_FIELDS) {
    Object.defineProperty(output, field, {
      enumerable: true,
      // Baked on first read, so validating or inspecting a recipe never pays for it.
      get() {
        if (field === 'map' && holder.sequence) return holder.sequence.descriptor;
        if (holder.catalogTextures) return holder.catalogTextures()[field];
        return holder.snapshot.pattern ? agentSceneModule('patterns').materialPatternTextures(holder.snapshot.pattern, holder.images)[field] : undefined;
      },
    });
  }
  defineCatalogOnlyTextureFields(output, holder);
  return { holder, output: Object.freeze(output) };
}

// Catalog maps (colorMap, normalMap and the rest) become texture descriptors on first read, like a baked pattern, from the decoded images of the pool.
// Null for a material without them, so its handle is built exactly as before.
function catalogTexturesOf(holder) {
  if (holder.snapshot.text) {
    let panelTextures;
    return () => {
      panelTextures ??= agentSceneModule('textPanel').createTextPanelTextures(holder.snapshot.text);
      return panelTextures;
    };
  }
  if (!TEXTURE_MAP_FIELDS.some(field => holder.snapshot[field] !== undefined)) return null;
  let textures;
  return () => {
    textures ??= agentSceneModule('assets').createTextureMaps(holder.snapshot.id, holder.snapshot, holder.images);
    return textures;
  };
}

// The two catalog map fields that no pattern bakes: they exist on the handle only for a material that names them.
function defineCatalogOnlyTextureFields(output, holder) {
  if (!holder.catalogTextures) return;
  for (const field of ['occlusionMap', 'heightMap']) {
    Object.defineProperty(output, field, { enumerable: true, configurable: true, get: () => holder.catalogTextures()[field] });
  }
}

function immutableMaterial(snapshot) {
  for (const field of ['color', 'emissiveColor', 'absorption', 'aov']) {
    if (snapshot[field]) {
      Object.freeze(snapshot[field]);
    }
  }
  return Object.freeze(snapshot);
}

const NO_ASSETS = Object.freeze({ placements: [], animators: [], geometryParts: new Map(), materialOutputs: new Map(), partExtras: new Map() });

// A placed asset's material is the decoded one, shared by every placement that uses the same overrides.
// The fields a motion track drives on a placed asset's material; every other field keeps its decoded value, textures included.
const ANIMATED_ASSET_FIELDS = ['color', 'emissiveColor', 'emission', 'metallic', 'roughness'];

// A decoded material is frozen, so a handled override gets a view of it that reads the animated fields from the live snapshot.
function liveAssetOutput(decoded, holder) {
  const output = {};
  for (const field of Object.keys(decoded)) {
    Object.defineProperty(output, field, { enumerable: true, configurable: true, get: () => decoded[field] });
  }
  for (const field of ANIMATED_ASSET_FIELDS) {
    Object.defineProperty(output, field, {
      enumerable: true,
      configurable: true,
      get() {
        const value = holder.snapshot[field];
        // Same rule as materialOutput: emission with no emissive colour glows white.
        if (field === 'emissiveColor' && holder.snapshot.emission > 0 && !value?.some(component => component > 0)) return Object.freeze([1, 1, 1]);
        return value;
      },
    });
  }
  return Object.freeze(output);
}

function assetMaterialHandle(snapshot, output, ...candidates) {
  const reusable = candidates.find(handle => handle?.source === output);
  if (reusable) return reusable;
  const holder = { snapshot };
  return { holder, output: snapshot.animatable === true ? liveAssetOutput(output, holder) : output, source: output };
}

function retainedMatrices(parts) {
  for (const part of parts) {
    if (part.matrix.length !== 16 || part.matrix.byteLength !== 64) {
      throw new RangeError('Retained render matrices must not be detached.');
    }
  }
}

function cameraPoseFrom(pose) {
  const camera = cameraFrom({
    eye: Array.from(pose.eye), target: Array.from(pose.target), up: Array.from(pose.up),
    ...(pose.focalLength === undefined ? { fov: pose.fov } : {}), near: pose.near, far: pose.far,
    ...Object.fromEntries(CAMERA_LENS_FIELDS.filter(field => pose[field] !== undefined).map(field => [field, pose[field]])),
  });
  const view = mat4.lookAt(mat4.create(), camera.eye, camera.target, camera.up);
  for (const aspect of [1 / 16, 16]) {
    const projection = applyProjection(mat4.create(), camera, aspect);
    const combined = mat4.multiply(mat4.create(), projection, view);
    if (![projection, combined].every(matrix => matrix.every(Number.isFinite))) {
      throw new RangeError('Motion camera matrices exceed the supported Float32 aspect range.');
    }
  }
  return camera;
}

// Physics holds its last pose after its duration, so a seek past the end is the resting state.
function simulatedPose(stagedState, time) {
  return time === null ? null : stagedState.physicsSampler?.sample(Math.min(time, stagedState.physicsSampler.duration));
}

// A light with a parent loads the light-parenting module with the recipe, so a scene without one never reads it.
function hasParentedLights(environment) {
  return ['pointLights', 'spotLights', 'areaLights'].some(field => environment[field]?.some(light => light.parent !== undefined));
}

/** The local transform of a node at a sampled motion and simulated pose: a body, then a track, then the rest value. */
function localTransformOf(node, sampled, simulated) {
  const patch = sampled?.nodes.get(node.id);
  const bodyPatch = simulated?.get(node.id);
  return {
    translation: bodyPatch?.translation ?? patch?.translation ?? node.translation,
    rotation: bodyPatch?.rotation ?? patch?.rotation ?? node.rotation,
    scale: patch?.scale ?? node.scale,
  };
}

/**
 * The world matrix of a node at a scene time: its animated or physics-baked local transform composed with its parents' (#2829).
 * It reads the samplers only, so the same time gives the same matrix whatever was sampled before.
 */
function worldMatrixAt(stagedState, nodeId, time) {
  const nodesById = new Map(stagedState.recipe.nodes.map(node => [node.id, node]));
  const sampled = stagedState.motionSampler?.sample(time) ?? null;
  const simulated = simulatedPose(stagedState, time);
  const world = mat4.create();
  const local = mat4.create();
  for (let cursor = nodesById.get(nodeId), depth = 0; cursor && depth < 256; cursor = nodesById.get(cursor.parent), depth++) {
    const { translation, rotation, scale } = localTransformOf(cursor, sampled, simulated);
    mat4.multiply(world, mat4.fromRotationTranslationScale(local, rotation, translation, scale), world);
  }
  return world;
}

/** What a bake-motion operation samples: the committed scene's local node transforms at any time, without touching the pose. */
function motionBakeSource(stagedState) {
  const nodesById = new Map(stagedState.recipe.nodes.map(node => [node.id, node]));
  return {
    animated: Boolean(stagedState.motionSampler || stagedState.physicsSampler),
    motionDuration: stagedState.recipe.motion?.duration ?? 0,
    physicsDuration: stagedState.physicsSampler?.duration ?? 0,
    sampleLocalTransforms(time, ids) {
      const sampled = stagedState.motionSampler?.sample(time) ?? null;
      const simulated = simulatedPose(stagedState, time);
      return new Map(ids.map(id => [id, localTransformOf(nodesById.get(id), sampled, simulated)]));
    },
  };
}

// Candidate buffers are private. A failed seek cannot publish half a pose to render handles.
function stagePose(stagedState, time) {
  const sampled = time === null ? null : stagedState.motionSampler?.sample(time);
  const hiddenNodes = hiddenNodeIds(stagedState.recipe, sampled);
  const opacities = sampledOpacities(stagedState.recipe, stagedState.fadedNodeIds, sampled);
  const simulated = simulatedPose(stagedState, time);
  const graph = stagedState.poseGraph ?? stagedState.graph;
  if (stagedState.poseGraph) {
    for (const node of stagedState.recipe.nodes) {
      const { translation, rotation, scale } = localTransformOf(node, sampled, simulated);
      if (Array.from(scale).some(component => !Number.isFinite(Math.fround(component)) || Math.fround(component) <= 0)) {
        throw new RangeError('Motion scale must remain positive at Float32 precision.');
      }
      if (node.assetPart) {
        graph.getNode(node.id).localMatrix.set(node.assetPart.matrix);
        continue;
      }
      mat4.fromRotationTranslationScale(graph.getNode(node.id).localMatrix, rotation, translation, scale);
    }
    graph.update();
    validateGraph(graph, stagedState.localBounds);
  }
  stageSkinPoses(stagedState.skinStages, graph);
  const materialUpdates = [];
  for (const material of stagedState.recipe.materials) {
    const patch = sampled?.materials.get(material.id);
    let snapshot = material;
    if (patch) {
      const definition = { ...material, ...patch };
      for (const field of ['color', 'emissiveColor']) {
        if (definition[field]) {
          definition[field] = Array.from(definition[field]);
        }
      }
      // A placed asset's material carries decoded fields that materialFrom does not know; only the driven fields change.
      snapshot = immutableMaterial(material.assetSource ? definition : materialFrom(definition));
    }
    materialUpdates.push({ holder: stagedState.materialHandles.get(material.id).holder, snapshot });
  }
  const camera = sampled?.camera ? cameraPoseFrom(sampled.camera) : stagedState.recipe.camera;
  retainedMatrices(stagedState.parts);
  const clothGeometries = withTerrainLod(sampledGeometries(stagedState, time, sampled, camera), stagedState, graph, camera);
  // Staged last: a pose pending on a decoded asset must be committed or discarded, so nothing above may throw after it.
  const assetClips = stagedState.assetRuntime.animators.length ? agentSceneModule('assets').stageAssetClips(stagedState.assetRuntime, graph, time) : null;
  const movedLook = stagedState.motionSampler && agentSceneModule('motion').motionMovesLook(sampled) ? sampled : null;
  return { graph, materialUpdates, camera, time, clothGeometries, assetClips, hiddenNodes, opacities, movedLook, morphs: sampled?.morphs ?? null };
}

/** A mesh stack built with every ocean node's `time` set to `oceanTime`: the sea the renderer draws at that moment of an oceanTime track. */
function oceanTimeGeometry(recipe, maxGeometryVertices, geometryId, oceanTime, wakeField) {
  const definition = recipe.geometries.find(candidate => candidate.id === geometryId);
  const stack = definition.stack.map(node => (node.op === 'ocean' ? { ...node, ...wakeField, time: oceanTime } : node));
  return Object.freeze(generateGeometry({ ...definition, stack }, maxGeometryVertices, cutterScopeOf(recipe.geometries, heightSourcesOf(recipe))));
}

/**
 * Geometries of mesh stacks whose ocean time a geometry track drives, keyed by node ID. Each one is built from the cached edits with
 * every ocean node's `time` set to the sampled value, so it equals the still of a recipe that writes that time into the node. The last
 * result of each geometry is kept, so a repeated time reuses the geometry and the renderer sees no change.
 */
function oceanTimeGeometries(stagedState, sampled, time) {
  const patches = sampled?.geometries;
  if (!patches?.size) {
    return new Map();
  }
  const frames = stagedState.oceanFrames ??= new Map();
  const geometries = new Map();
  for (const [geometryId, patch] of patches) {
    let frame = frames.get(geometryId);
    const wakeField = stagedState.physicsSampler?.wakeField?.(geometryId, time);
    // The frames outlive an edit (#2730), so the key names the stack they were built from as well as the time.
    const source = `${stagedState.geometryRecords.get(geometryId)?.signature}|${stagedState.maxGeometryVertices}|${patch.oceanTime}`;
    const key = wakeField ? `${source}|${time}` : source;
    if (frame?.key !== key) {
      frame = { key, wake: Boolean(wakeField), geometry: oceanTimeGeometry(stagedState.recipe, stagedState.maxGeometryVertices, geometryId, patch.oceanTime, wakeField) };
      frames.set(geometryId, frame);
    }
    for (const node of stagedState.recipe.nodes) {
      if (node.geometry !== geometryId) continue;
      // A water part draws the ocean's foam group as foam, as the first build of the part does.
      const material = stagedState.recipe.materials?.find(candidate => candidate.id === node.material);
      const drawn = material && frame.geometry.vertexGroups?.foam ? agentSceneModule('mesh').waterFoamGeometry(frame.geometry, material) : frame.geometry;
      geometries.set(node.id, drawn);
    }
  }
  return geometries;
}

/** IDs of the nodes drawing a mesh whose ocean time a geometry track drives. */
function oceanTrackNodeIds(recipe) {
  const oceanGeometries = new Set((recipe.motion?.tracks ?? []).filter(track => track.kind === 'geometry' && track.property === 'oceanTime').map(track => track.id));
  return new Set(recipe.nodes.filter(node => oceanGeometries.has(node.geometry)).map(node => node.id));
}

// What an ocean time moves in a sea geometry. The triangle indices move too: the diagonal of each quad follows the waves.
const SEA_MOVING_FIELDS = ['positions', 'normals', 'skyVisibility', 'indices'];

// True when the two seas differ only in what an ocean time moves: the same fields and vertex groups, the same array sizes and
// types, and the same UVs, so the arrays of one can be overwritten with the other. Any other field (surface masks, colours) is
// not known to stay put, so it sends the sea to the part swap.
function seaOnlyMoved(live, next) {
  const fields = Object.keys(next);
  if (fields.length !== Object.keys(live).length || !fields.every(field => field in live && (SEA_MOVING_FIELDS.includes(field) || field === 'uvs' || field === 'vertexGroups'))) return false;
  if (next.uvs && (live.uvs.length !== next.uvs.length || next.uvs.some((value, index) => value !== live.uvs[index]))) return false;
  if (!SEA_MOVING_FIELDS.every(field => !next[field] || (live[field].length === next[field].length && live[field].constructor === next[field].constructor))) return false;
  const groups = Object.keys(next.vertexGroups ?? {});
  return groups.length === Object.keys(live.vertexGroups ?? {}).length && groups.every(name => live.vertexGroups[name]?.length === next.vertexGroups[name].length);
}

// A copy of a sea with its own moving arrays, which later times overwrite. The geometry a frame cache holds stays untouched.
function liveSea(sea) {
  const vertexGroups = sea.vertexGroups && Object.fromEntries(Object.entries(sea.vertexGroups).map(([name, weights]) => [name, weights.slice()]));
  const copy = { ...sea, ...(vertexGroups && { vertexGroups }) };
  for (const field of SEA_MOVING_FIELDS) {
    if (sea[field]) copy[field] = sea[field].slice();
  }
  return markLiveGeometry(Object.freeze(copy), { reindexed: true });
}

/**
 * Each sea an ocean time track drives keeps one geometry per node, so a renderer keeps its part and uploads new positions,
 * normals, foam and triangle indices (updatePartVertices) instead of building a batch for every time. A sea that changed in any
 * other way, such as its vertex or triangle count, replaces the kept one and the renderer swaps its parts as before.
 */
function seasKeptInPlace(stagedState, geometries) {
  const seaNodeIds = oceanTrackNodeIds(stagedState.recipe);
  const kept = stagedState.liveSeas ??= new Map();
  let result = geometries;
  for (const nodeId of seaNodeIds) {
    const next = geometries.get(nodeId);
    if (!next) continue;
    const live = kept.get(nodeId);
    if (live && seaOnlyMoved(live, next)) {
      for (const field of SEA_MOVING_FIELDS) {
        if (next[field]) live[field].set(next[field]);
      }
      for (const [name, weights] of Object.entries(next.vertexGroups ?? {})) live.vertexGroups[name].set(weights);
    } else {
      kept.set(nodeId, liveSea(next));
    }
    if (result === geometries) result = new Map(geometries);
    result.set(nodeId, kept.get(nodeId));
  }
  return result;
}

// Cloth and particles replace the geometry of their own nodes at a sampled time; no node belongs to both.
function sampledGeometries(stagedState, time, sampled, camera) {
  // A billboard faces the camera even in a scene with no clock, so it samples at 0 there.
  if (time === null && !stagedState.billboardSampler) {
    return null;
  }
  const geometries = time === null ? new Map() : oceanTimeGeometries(stagedState, sampled, time);
  for (const sampler of time === null ? [stagedState.billboardSampler] : [stagedState.clothSampler, stagedState.particleSampler, stagedState.billboardSampler]) {
    sampler?.sample(time ?? 0, camera)?.forEach((geometry, nodeId) => geometries.set(nodeId, geometry));
  }
  return geometries.size ? geometries : null;
}

function partFlagsOf(node) {
  const flags = Object.fromEntries(PART_FLAG_FIELDS.filter(flag => node[flag] !== undefined).map(flag => [flag, node[flag]]));
  if (node.rayVisibility !== undefined) flags.rayVisibility = node.rayVisibility;
  return flags;
}

function sameRayVisibility(first, second) {
  return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
}

function sameRenderFlags(part, node, usesVisibility, assetExtras, fades = false) {
  return PART_FLAG_FIELDS.every(flag => part[flag] === (node[flag] ?? assetExtras?.[flag])) && sameRayVisibility(part.rayVisibility, node.rayVisibility) && Boolean(part.visibility) === usesVisibility && Boolean(part.opacityScale) === fades;
}

function recipeUsesVisibility(recipe) {
  return recipe.nodes.some(node => node.visible !== undefined) || Boolean(recipe.motion?.tracks?.some(track => track.kind === 'node' && track.property === 'visible'));
}

/** Node IDs a node opacity track fades: each tracked node and everything under it. Empty when no track animates opacity. */
function opacityNodeIds(recipe) {
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
function sampledOpacities(recipe, fadedIds, sampled) {
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
function fadeMaterial(material, nodeId) {
  const alphaMode = material.alphaMode ?? 'opaque';
  if (alphaMode === 'blend' || alphaMode === 'add') return material;
  if (alphaMode === 'mask') throw invalidField(`materials.${material.id}.alphaMode`, alphaMode, `opaque or blend, because node "${nodeId}" has an opacity track and a mask cutout is fixed per batch (or animate scale or visible instead)`);
  if (!blendedViews.has(material)) blendedViews.set(material, blendedView(material));
  return blendedViews.get(material);
}

/** Node IDs hidden at a pose: a node set invisible by its field or a sampled track, and everything under it. */
function hiddenNodeIds(recipe, sampled) {
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

// Cloth keeps one geometry per sheet that every sample rewrites, so the parts of a later seek are the previous ones and the
// renderer sees no topology change. Particles still bring a new geometry per time, so those parts are replaced.
function withTerrainLod(geometries, stagedState, graph, camera) {
  if (!stagedState.terrainLodNodes?.length) return geometries;
  const drawn = agentSceneModule('terrain').terrainLodGeometries(stagedState.terrainLodNodes, graph, camera.eye, (geometry, nodeId, materialId) => {
    const wear = stagedState.materialHandles.get(materialId)?.output.wear;
    const masked = wear ? geometryWithSurfaceMasks(geometry, wear, nodeId) : geometry;
    return geometryWithMaterialUvs(masked, stagedState.recipe, materialId, graph, nodeId);
  });
  return geometries ? new Map([...geometries, ...drawn]) : drawn;
}

function partsWithCloth(restParts, clothGeometries, previousParts) {
  if (!clothGeometries) {
    return restParts;
  }
  const next = restParts.map((part, index) => {
    const geometry = clothGeometries.get(part.name);
    return !geometry ? part : previousParts[index]?.geometry === geometry ? previousParts[index] : Object.freeze({ ...part, geometry });
  });
  return next.every((part, index) => part === previousParts[index]) ? previousParts : Object.freeze(next);
}

// A shape key weighs what its morph track samples at this time, or its starting value when no track names it.
function publishShapeKeyWeights(part, sampledMorphs) {
  const { morphTargetNames, morphTargetValues, morphGrowth } = part.geometry;
  if (!morphTargetNames || !part.morph) return;
  if (morphGrowth) {
    const growth = sampledMorphs?.get(morphGrowth.name)?.weight ?? morphGrowth.value;
    agentSceneModule('modeling').growthWeights(morphGrowth.steps, growth).forEach((weight, index) => {
      part.morph.weights[index] = weight;
    });
    return;
  }
  morphTargetNames.forEach((name, index) => {
    part.morph.weights[index] = sampledMorphs?.get(name)?.weight ?? morphTargetValues[index];
  });
}

/** Returns true when the parts handed to a renderer changed, which the caller counts as a topology change. */
function publishPose(stagedState, pose) {
  for (const part of stagedState.restParts) {
    if (part.visibility) part.visibility.visible = !pose.hiddenNodes.has(part.name);
    if (part.opacityScale) part.opacityScale.value = pose.opacities.get(part.name) ?? 1;
    Float32Array.prototype.set.call(part.matrix, pose.graph.getNode(part.name).worldMatrix);
    publishShapeKeyWeights(part, pose.morphs);
  }
  for (const update of pose.materialUpdates) {
    update.holder.snapshot = update.snapshot;
  }
  publishSkinPoses(stagedState.skinStages);
  if (pose.assetClips) {
    pose.assetClips.commit();
    for (const part of stagedState.restParts) {
      const matrix = pose.assetClips.matrices.get(part.name);
      if (matrix) Float32Array.prototype.set.call(part.matrix, matrix);
    }
  }
  for (const sequence of stagedState.sequences) sequence.seek(pose.time);
  stagedState.renderCamera = pose.camera;
  stagedState.movedLook = pose.movedLook;
  stagedState.motionTime = pose.time;
  const previousParts = stagedState.parts;
  const sampledParts = partsWithCloth(stagedState.restParts, pose.clothGeometries && seasKeptInPlace(stagedState, pose.clothGeometries), previousParts);
  // Ranked also when the parts did not change: staging an edit ranks the rest parts, so the drawn parts get their ranks back.
  stagedState.parts = stagedState.rankFlushParts ? stagedState.rankFlushParts(sampledParts) : sampledParts;
  return stagedState.parts !== previousParts;
}

// The recipe an agent wrote: without the geometries, materials and part nodes that placed assets generate.
// The recipe without the nodes, geometries and materials a placed asset generates. Arrays are new, entries are shared.
function recipeWithoutAssetOutput(recipe) {
  return {
    ...recipe,
    nodes: recipe.nodes.filter(node => !node.assetPart),
    geometries: recipe.geometries.filter(geometry => geometry.type !== 'asset'),
    materials: recipe.materials.filter(material => !material.assetSource),
  };
}

function authoredRecipe(recipe) {
  return structuredClone(recipeWithoutAssetOutput(recipe));
}

// Node keys whose values the recipe normalizer may rebuild or rewrite in place, so a shared node could not be read-only.
// Node fields whose module generates part nodes at each edit; the last two scatter over a terrain from the camera eye.
const GROWN_PART_FIELDS = ['vegetation', 'clutter', 'grass'];
const growsParts = node => GROWN_PART_FIELDS.some(field => node[field]);
const NODE_KEYS_NEEDING_OWN_COPY = ['assetPart', 'asset', 'vegetation', 'clutter', 'grass', 'relations', 'skin', 'instances', 'armature'];

/**
 * A copy of the staged recipe for a batch of plain field edits that clones only what the batch can change: the touched
 * nodes, the materials and the small sections. Untouched nodes and the geometries stay shared with the staged recipe, which
 * is read-only once committed and which the normalizer only reads from. Returns null when the recipe holds anything
 * the normalizer could rewrite in place (placed assets, armatures, relations, instances), so the caller clones it all.
 */
function fieldEditCandidate(recipe, operations) {
  const sharesSafely = !Object.hasOwn(recipe, 'armatures') &&
    recipe.geometries.every(geometry => geometry.type !== 'asset') &&
    recipe.materials.every(material => !material.assetSource) &&
    recipe.nodes.every(node => NODE_KEYS_NEEDING_OWN_COPY.every(key => node[key] === undefined));
  if (!sharesSafely) return null;
  const touchedNodes = new Set(operations.filter(operation => operation.type === 'set-node').map(operation => operation.id));
  return {
    ...recipe,
    geometries: [...recipe.geometries],
    nodes: recipe.nodes.map(node => (touchedNodes.has(node.id) ? structuredClone(node) : node)),
    materials: structuredClone(recipe.materials),
    camera: structuredClone(recipe.camera),
  };
}

// The mesh geometry an edit names; `remedy` tells what to do when it is another type.
function meshGeometryTarget(candidate, operation, remedy) {
  identifier(operation.geometry);
  const target = candidate.geometries.find(geometry => geometry.id === operation.geometry);
  if (!target) {
    throw invalidField('geometry', operation.geometry, `one of ${[...candidate.geometries.map(known => known.id)].join(', ')}`);
  }
  if (target.type !== 'mesh') {
    throw invalidField('geometry', operation.geometry, `the ID of a mesh geometry, but it is a ${target.type}. ${remedy(target.type)}`, TypeError);
  }
  return target;
}

function removeNode(candidate, operation) {
  knownKeys(operation, ['type', 'id', 'recursive'], 'operation');
  identifier(operation.id);
  const recursive = operation.recursive === undefined ? false : operation.recursive;
  if (typeof recursive !== 'boolean') {
    throw invalidField('recursive', recursive, 'true or false', TypeError);
  }
  if (!candidate.nodes.some(node => node.id === operation.id)) {
    throw invalidField('id', operation.id, 'the ID of a node in nodes; scene_inspect lists them');
  }
  const children = new Map();
  for (const node of candidate.nodes) {
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node.id);
    children.set(node.parent, siblings);
  }
  if (!recursive && (children.get(operation.id)?.length ?? 0) > 0) {
    throw invalidField('recursive', recursive, 'true for a node with children, such as true; or remove the children first');
  }
  const removed = new Set([operation.id]);
  const pending = [operation.id];
  if (recursive) {
    for (let cursor = 0; cursor < pending.length; cursor++) {
      for (const child of children.get(pending[cursor]) ?? []) {
        if (!removed.has(child)) {
          removed.add(child);
          pending.push(child);
        }
      }
    }
  }
  candidate.nodes = candidate.nodes.filter(node => !removed.has(node.id));
  return removed;
}

/** A bounded CPU authoring session. Render adapters must treat geometry as immutable. */
export function createAgentScene(input, inputLimits = {}, options = {}) {
  const limits = resolveLimits(inputLimits);
  const assetOutputCache = new Map();
  // The on-demand modules this scene's recipe and edits named. Default stages (flush ranking, floor sky) run only for these.
  const requestedModules = new Set(defaultStageModulesNamed(input));
  let state = null;
  let revision = 0;
  let topologyRevision = 0;
  // Undo revisions the latest stage released to fit the vertex budget; the edit's answer tells the agent.
  let releasedRevisionCount = 0;
  let physicsBake = null;
  let clothBake = null;
  let particleBake = null;
  let lightBake = null;
  // Whether an edit of a built scene shows before its bake is done (#3052): null waits for it, 'previous' draws the last light
  // meanwhile, 'none' draws no light. `settling.pending` is the plan of the bake that is running.
  let bakeDeferral = options.deferBake ?? null;
  const settling = { pending: null };
  // Why the last stage's rebake could not run (a size limit), for the staged state to report.
  let skippedBake = null;
  let skippedReflections = null;
  let lightLinkCache = null;
  let objectReflectionCache = null;
  // Puts the staged graph's matrices back when an edit that moved them in place is refused after the move.
  let pendingGraphRestore = null;
  const skinCache = new Map();
  const checkpoints = new Map();
  // The states before the last edits, oldest first, each with the revision number it had.
  const revisionHistory = [];

  function snapshotState() {
    return {
      // The staged recipe is read-only once committed and a restore copies the snapshot's recipe, so the snapshot shares it.
      recipe: recipeWithoutAssetOutput(state.recipe),
      geometryRecords: new Map(state.geometryRecords),
      materialHandles: new Map(state.materialHandles),
      restParts: state.restParts,
      sourceRestParts: state.sourceRestParts,
    };
  }

  function drawnNodeGeometry(id, label) {
    identifier(id);
    const node = state.recipe.nodes.find(value => value.id === id);
    const geometry = node && state.geometries.get(node.geometry);
    if (!geometry) throw invalidField(`path.${label}`, id, 'the ID of a node with a drawn geometry; scene_inspect lists node IDs');
    return { geometry, worldMatrix: state.graph.getNode(id).worldMatrix };
  }

  // The route is computed over the authored pose of the ground and of the nodes to avoid, like the bounds in scene_inspect.
  const pathQuery = query => agentSceneModule('navigation').resolvePathQuery(query, drawnNodeGeometry, boundsFor);

  function ownedGeometryRecords() {
    const records = new Set(state?.geometryRecords.values() ?? []);
    const snapshots = [...checkpoints.values(), ...revisionHistory.map(entry => entry.snapshot)];
    for (const snapshot of snapshots) {
      for (const record of snapshot.geometryRecords.values()) {
        records.add(record);
      }
    }
    return records;
  }

  function geometryBudgetError({ residentStats, pendingVertices }, plans, budget, heldCheckpoints) {
    const largest = plans.filter(plan => !plan.existing).sort((first, second) => second.estimatedVertices - first.estimatedVertices)[0];
    const largestNote = largest === undefined ? 'no new geometry is added' : `largest new geometry "${largest.definition.id}" has ${largest.estimatedVertices}`;
    return invalidField('geometry.vertices', residentStats.vertices + pendingVertices, `a geometry preflight peak of at most ${budget.maxVertices} vertices and ${budget.maxGeometryBytes} bytes (this needs ${residentStats.geometryBytes + pendingVertices * 56} bytes): ${residentStats.vertices} vertices are already held by the active scene, checkpoints and staged resources and ${pendingVertices} are new; ${largestNote}. Reduce detail${heldCheckpoints ? ' or release checkpoints' : ''}`);
  }


  // The edit only moves nodes of a plain scene (no relations, placed assets, armatures or motion) and every geometry is
  // resident: the committed state's graph is moved in place instead of being built again.
  function canMoveStagedGraph(recipe, movedNodeIds, assetRuntime) {
    return Boolean(movedNodeIds && state && !state.poseGraph && assetRuntime === NO_ASSETS && !recipe.armatures &&
      state.recipe.nodes.length === recipe.nodes.length && !recipe.nodes.some(node => node.relations?.length || node.assetPart || node.asset || growsParts(node)));
  }

  function graphWithMovedNodes(recipe, movedNodeIds, localBounds) {
    if (movedNodeIds.size === 0) return state.graph;
    const matrices = new Map();
    for (const node of recipe.nodes) {
      if (movedNodeIds.has(node.id)) matrices.set(node.id, mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale));
    }
    pendingGraphRestore = state.graph.replaceLocalMatrices(matrices);
    validateGraph(state.graph, localBounds);
    return state.graph;
  }

  function stage(inputRecipe, preferred = null, removedNodes = new Set(), removedMaterials = new Set(), inputIsOwnedJson = false, movedNodeIds = null) {
    releasedRevisionCount = 0;
    const recipe = normalizeRecipe(inputRecipe, limits, { alreadyCopied: inputIsOwnedJson });
    const placedRuntime = recipe.nodes.some(node => node.asset)
      ? agentSceneModule('assets').expandAssetPlacements(recipe, options.assets, limits, assetOutputCache, recipe.nodes.some(node => node.asset?.drive) ? agentSceneModule('drive').createAssetDrive : null)
      : NO_ASSETS;
    // Grown vegetation travels the placed-asset channel; its module returns the placed runtime with its own parts added.
    const plantedRuntime = recipe.nodes.some(node => node.vegetation)
      ? agentSceneModule('vegetation').expandVegetation(recipe, limits, assetOutputCache, placedRuntime, options.sequenceFrames)
      : placedRuntime;
    // Scattered clutter and blade grass travel the same channel and add their parts after the trees.
    let assetRuntime = plantedRuntime;
    for (const [field, expand] of [['clutter', 'expandClutter'], ['grass', 'expandGrass']]) {
      if (recipe.nodes.some(node => node[field])) assetRuntime = agentSceneModule(field)[expand](recipe, limits, assetOutputCache, assetRuntime);
    }
    // Placed assets and grown vegetation add part nodes, so the part names are checked after the expansion, like the render binds them.
    if (recipe.environment.localVolumes) {
      const partNodeIds = recipe.nodes.filter(node => node.geometry !== undefined).map(node => node.id);
      checkLocalVolumePartNames(recipe.environment.localVolumes, partNodeIds);
    }
    if (state) {
      retainedMatrices(state.parts);
    }
    const definitionsById = geometryDefinitions(recipe.geometries);
    const buildHeightSources = heightSourcesOf(recipe, options.sequenceFrames);
    const planGeometry = () => {
      const ownedRecords = ownedGeometryRecords();
      const availableRecords = new Map();
      for (const record of ownedRecords) {
        availableRecords.set(record.signature, record);
      }
      // A recipe with no image map never loads the assets module, and needs no UVs (#3003).
      const uvWriters = agentSceneModuleLoaded('assets') && agentSceneModule('assets').primitiveUvWriters(recipe);
      const plans = recipe.geometries.map(definition => {
        const addUvs = uvWriters && uvWriters.get(definition.id);
        const signature = geometrySignature(definition, definitionsById, buildHeightSources) + (addUvs ? '|uvs' : '');
        const preferredRecord = preferred?.geometryRecords.get(definition.id);
        const activeRecord = state?.geometryRecords.get(definition.id);
        const existing = [preferredRecord, activeRecord, availableRecords.get(signature)]
          .find(record => record?.signature === signature);
        return { definition, signature, addUvs, existing, estimatedVertices: definition.type === 'asset' ? 0 : geometryEstimate(definition, { definitions: definitionsById, chain: [] }) };
      });
      const residentStats = geometryStats(ownedRecords);
      const pendingVertices = plans.filter(plan => !plan.existing).reduce((total, plan) => total + plan.estimatedVertices, 0);
      const overBudget = residentStats.vertices + pendingVertices > limits.maxVertices ||
        residentStats.geometryBytes + pendingVertices * 56 > limits.maxGeometryBytes;
      return { plans, residentStats, pendingVertices, overBudget };
    };
    let planned = planGeometry();
    // Automatic undo history never blocks an edit: drop the oldest kept revisions before refusing for budget.
    while (planned.overBudget && revisionHistory.length > 0) {
      revisionHistory.shift();
      releasedRevisionCount++;
      planned = planGeometry();
    }
    let { residentStats } = planned;
    const { plans, pendingVertices } = planned;
    if (planned.overBudget) {
      throw geometryBudgetError(planned, plans, limits, checkpoints.size);
    }

    // Validate references, hierarchy and matrix arithmetic before generating any new resource.
    const placeholders = new Map();
    const placeholderBounds = new Map();
    for (const plan of plans) {
      const geometry = plan.existing?.geometry ?? Object.freeze({});
      placeholders.set(plan.definition.id, geometry);
      placeholderBounds.set(geometry, plan.existing?.bounds ?? { min: [0, 0, 0], max: [0, 0, 0] });
    }
    // With every geometry resident and no relations to solve, the compile below sees the same inputs and checks the same things.
    const everyGeometryResident = plans.every(plan => plan.existing);
    const compiledBelow = everyGeometryResident && !recipe.nodes.some(node => node.relations?.length);
    const reusesGraph = everyGeometryResident && canMoveStagedGraph(recipe, movedNodeIds, assetRuntime);
    if (!compiledBelow && !reusesGraph) compile(recipe, placeholders, placeholderBounds, limits);

    const geometryRecords = new Map();
    for (const plan of plans) {
      let record = plan.existing;
      if (!record && plan.definition.type === 'asset') {
        // A decoded asset geometry is shared by every placement. Its size is bounded by the asset decoder, not by this scene's budget.
        const geometry = assetRuntime.geometryParts.get(plan.definition.id);
        record = Object.freeze({ signature: plan.signature, geometry, bounds: boundsFor(geometry, mat4.create()), vertices: 0, geometryBytes: 0, assetBytes: geometryBufferBytes(geometry), estimatedVertices: 0 });
      } else if (!record) {
        const built = generateGeometry(plan.definition, Math.min(limits.maxVertices, 1_000_000), { definitions: definitionsById, chain: [], heightSources: buildHeightSources });
        const geometry = Object.freeze(plan.addUvs ? plan.addUvs(built) : built);
        const geometryBytes = geometryBufferBytes(geometry);
        const vertices = geometry.positions.length / 3;
        if (plan.definition.type === 'mesh' || plan.definition.type === 'fragment') {
          // Edits can grow a mesh past its estimate. Undo history never blocks an edit, so release the oldest revisions before refusing.
          while (revisionHistory.length > 0 && residentStats.vertices + pendingVertices - plan.estimatedVertices + vertices > limits.maxVertices) {
            revisionHistory.shift();
            releasedRevisionCount++;
            residentStats = geometryStats(ownedGeometryRecords());
          }
          if (residentStats.vertices + pendingVertices - plan.estimatedVertices + vertices > limits.maxVertices) {
            if (plan.definition.type === 'fragment') {
              throw invalidField(`geometries.${plan.definition.id}`, `${vertices} render vertices`, 'pieces that fit maxVertices across the scene; use fewer cells or a coarser source geometry');
            }
            throw new RangeError(`Mesh ${plan.definition.id} has ${vertices} render vertices after its edits, which exceeds maxVertices across the scene. Reduce detail or edits.`);
          }
        } else if (vertices > plan.estimatedVertices || viewBytes(Object.values(geometry)) > plan.estimatedVertices * (56 + TERRAIN_SKY_VISIBILITY_BYTES)) {
          throw new RangeError('Generated geometry exceeds its conservative preflight bound.');
        }
        record = Object.freeze({
          signature: plan.signature, geometry,
          bounds: boundsFor(geometry, mat4.create()),
          vertices, geometryBytes, estimatedVertices: plan.estimatedVertices,
        });
      }
      geometryRecords.set(plan.definition.id, record);
    }
    const geometries = new Map([...geometryRecords].map(([id, record]) => [id, record.geometry]));
    const localBounds = new Map([...geometryRecords.values()].map(record => [record.geometry, record.bounds]));
    if (recipe.nodes.some(node => node.relations?.length)) {
      recipe.nodes = agentSceneModule('relations').solveRelations(recipe.nodes, (node, worldMatrix, region) => {
        const geometry = geometries.get(node.geometry);
        const regionGeometry = region === undefined ? geometry : agentSceneModule('mesh').taggedFacePositions(geometry, region);
        return boundsFor(regionGeometry, worldMatrix);
      });
    }
    const graph = (reusesGraph ? graphWithMovedNodes(recipe, movedNodeIds, localBounds) : compile(recipe, geometries, localBounds, limits));
    const skinBindings = bindSkins({ recipe, graph, geometryRecords, cache: skinCache });
    const materialHandles = new Map();
    const stagedMaterialSnapshots = [];
    for (const material of recipe.materials) {
      const snapshot = immutableMaterial(material);
      const preferredHandle = preferred?.materialHandles.get(material.id);
      const activeHandle = removedMaterials.has(material.id) ? null : state?.materialHandles.get(material.id);
      // The renderer keeps tag, blending, opacity and sidedness per batch, so a handle is reused only when all match.
      const existing = [preferredHandle, activeHandle].find(handle => handle && batchSignature(handle.holder.snapshot) === batchSignature(material));
      const assetOutput = assetRuntime.materialOutputs.get(material.id);
      const handle = assetOutput ? assetMaterialHandle(snapshot, assetOutput, preferredHandle, activeHandle) : existing ?? materialHandle(snapshot, material.map && agentSceneModule('assets').createTextureSequence(material.id, material.map, options.sequenceFrames), options.sequenceFrames);
      materialHandles.set(material.id, handle);
      stagedMaterialSnapshots.push({ id: material.id, holder: handle.holder, snapshot });
    }
    // A node with material slots is several parts of one name, one per slot, so reuse looks a part up by name and slot.
    const partKeyOf = part => part.materialSlot === undefined ? part.name : `${part.name}#slot-${part.materialSlot}`;
    const activeParts = new Map(state?.sourceRestParts.map(part => [partKeyOf(part), part]) ?? []);
    const preferredParts = new Map(preferred?.sourceRestParts.map(part => [partKeyOf(part), part]) ?? []);
    const usesVisibility = recipeUsesVisibility(recipe);
    const fadedNodeIds = opacityNodeIds(recipe);
    const roomJoinedNodeIds = roomJoinedBoxNodeIds(recipe);
    const buildPart = (node, materialId, slotGroup) => {
      const binding = skinBindings.get(node.id);
      const recipeMaterial = materialHandles.get(materialId);
      const sourceGeometry = binding?.geometry ?? (roomJoinedNodeIds.has(node.id) ? sharpJoinBoxGeometry() : geometries.get(node.geometry));
      const foamGeometry = sourceGeometry.vertexGroups?.foam ? agentSceneModule('mesh').waterFoamGeometry(sourceGeometry, recipeMaterial.output) : sourceGeometry;
      const maskedGeometry = recipeMaterial.output.wear ? geometryWithSurfaceMasks(foamGeometry, recipeMaterial.output.wear, node.id) : foamGeometry;
      const wholeGeometry = geometryWithMaterialUvs(maskedGeometry, recipe, materialId, graph, node.id);
      const geometry = slotGroup ? agentSceneModule('mesh').geometryOfSlot(wholeGeometry, slotGroup) : wholeGeometry;
      // A graph with a vertexGroup node bakes with this mesh's weights, so its textures belong to the mesh.
      const drawnMaterial = recipeMaterial.output.assetGraph ? agentSceneModule('assetGraph').assetGraphView(recipeMaterial.output, geometry, node.id, graph.getNode(node.id).worldMatrix) : recipeMaterial.output.pattern?.graph ? agentSceneModule('patterns').materialViewForGeometry(recipeMaterial.output, geometry, node.id, recipeMaterial.holder.images, graph.getNode(node.id).worldMatrix) : recipeMaterial.output;
      const fades = fadedNodeIds.has(node.id);
      const material = fades ? fadeMaterial(drawnMaterial, node.id) : drawnMaterial;
      const assetExtras = assetRuntime.partExtras.get(node.id);
      // Shape keys of a recipe mesh are morph targets with their own weights per part; an imported asset brings its own pose.
      const shapeKeyMorph = geometry.morphTargetValues && !assetExtras?.morph ? { weights: Float32Array.from(geometry.morphTargetValues) } : undefined;
      const partKey = slotGroup ? `${node.id}#slot-${slotGroup.slot}` : node.id;
      const activePart = removedNodes.has(node.id) ? null : activeParts.get(partKey);
      const existing = [activePart, preferredParts.get(partKey)]
        .find(part => part?.geometry === geometry && part.material === material && part.skin === (assetExtras?.skin ?? binding?.skin) && (assetExtras?.morph ? part.morph === assetExtras.morph : Boolean(part.morph) === Boolean(shapeKeyMorph)) && depthLayerOf(part) === depthLayerOf(node) && sameRenderFlags(part, node, usesVisibility, assetExtras, fades));
      return existing ?? Object.freeze({
        name: node.id, geometry, material,
        ...(slotGroup ? { materialSlot: slotGroup.slot } : {}),
        ...(depthLayerOf(node) ? { depthLayer: depthLayerOf(node) } : {}),
        ...partFlagsOf(node),
        // The renderer reads this holder every update, and publishPose rewrites it for each pose.
        ...(usesVisibility ? { visibility: { visible: true } } : {}),
        // The renderer multiplies the material opacity by this value, which publishPose rewrites for each pose.
        ...(fades ? { opacityScale: { value: 1 } } : {}),
        matrix: new Float32Array(graph.getNode(node.id).worldMatrix),
        ...(binding ? { skin: binding.skin } : {}),
        ...(shapeKeyMorph ? { morph: shapeKeyMorph } : {}),
        ...assetExtras,
      });
    };
    // A mesh with material slots draws as one part per slot, each with its slot's material instead of the node's.
    const nextParts = recipe.nodes.filter(node => node.geometry !== undefined).flatMap(node => {
      const { materialGroups, materialSlots } = geometries.get(node.geometry);
      return materialGroups ? materialGroups.map(group => buildPart(node, materialSlots[group.slot], group)) : [buildPart(node, node.material)];
    });
    retainedMatrices(nextParts);
    const sameParts = state && state.sourceRestParts.length === nextParts.length &&
      state.sourceRestParts.every((part, index) => part === nextParts[index]);
    const sourceRestParts = sameParts ? state.sourceRestParts : Object.freeze(nextParts);
    if (hasParentedLights(recipe.environment)) agentSceneModule('lightParenting').requireKnownLightParents(recipe.environment, recipe.nodes);
    const lightBakeResult = stageLightBake(recipe, sourceRestParts, graph, stagedMaterialSnapshots);
    const { reflected, restParts } = stageRestParts(recipe, sourceRestParts, lightBakeResult, graph);
    // Unchanged rest parts start from the parts the last pose drew (#2730): a pose that samples the same sea, cloth or
    // particles keeps those parts, and only a pose that differs swaps them, which publishPose counts as a topology change.
    const restUnchanged = Boolean(state) && restParts === state.restParts;
    const stagedState = {
      recipe, geometryRecords, geometries, graph, materialHandles, fadedNodeIds,
      // Part identity decides what the next stage reuses, so it compares the parts as built, before any bake.
      sourceRestParts,
      parts: restUnchanged ? state.parts : restParts, restParts,
      // A sea a wake deforms depends on the physics bake as well, so only frames built without one outlive the edit.
      oceanFrames: new Map([...(state?.oceanFrames ?? [])].filter(([, frame]) => !frame.wake)),
      // The kept sea of each node outlives an edit too: every pose overwrites it with the sea it stages, and it is replaced when the layout differs.
      liveSeas: new Map(state?.liveSeas ?? []),
      // Parts a pose replaces (cloth, particles, ocean) are new objects with no flush rank, so the pose ranks them again.
      rankFlushParts: parts => stageCoplanarOffsets(recipe, parts),
      bakeSkipped: skippedBake,
      settlingPlan: lightBakeResult?.plan,
      reflectionSkipped: skippedReflections,
      bakeReport: lightBakeResult ? agentSceneModule('bake').withLocalVolumeReport({ ...lightBakeResult.report, reused: lightBakeResult.reused }, recipe.environment.localVolumes) : null,
      reflectionReport: reflected ? reflected.report : null,
      topologyChanged: Boolean(state) && !restUnchanged,
      stats: geometryStats(geometryRecords.values()),
    };
    stagedState.assetRuntime = assetRuntime;
    stagedState.maxGeometryVertices = Math.min(limits.maxVertices, 1_000_000);
    stagedState.sequences = [...materialHandles.values()].map(handle => handle.holder.sequence).filter(Boolean);
    stagedState.localBounds = localBounds;
    stagedState.skinBindings = skinBindings;
    stagedState.skinStages = createSkinStages(skinBindings);
    stagedState.motionSampler = recipe.motion ? agentSceneModule('motion').compileAgentMotion(recipe.motion, recipe, { normalized: true }) : null;
    stagedState.physicsSampler = stagePhysics(recipe, geometryRecords);
    stagedState.clothSampler = stageCloth(recipe, geometryRecords, stagedState.motionSampler);
    stagedState.particleSampler = stageParticles(recipe, geometryRecords, stagedState);
    stagedState.billboardSampler = stageBillboards(recipe, geometryRecords, stagedState);
    stagedState.terrainLodNodes = recipe.geometries.some(geometry => geometry.type === 'terrain') ? agentSceneModule('terrain').terrainLodNodesOf(recipe) : [];
    const animated = Boolean(stagedState.motionSampler || stagedState.physicsSampler || stagedState.clothSampler || stagedState.particleSampler || stagedState.billboardSampler || assetRuntime.animators.length);
    stagedState.poseGraph = animated ? compile(recipe, geometries, localBounds, limits) : null;
    stagedState.initialPose = animated ? poseAtPlayhead(stagedState) : stagePose(stagedState, null);
    return stagedState;
  }

  // Parts a linked light skips carry a light mask in their material. The same parts and links give the same objects, so
  // an edit that changes neither is not a topology change for the renderer.
  function stageLightLinks(recipe, parts) {
    if (!environmentLinksLights(recipe.environment)) {
      return parts;
    }
    const { environment } = recipe;
    const linksKey = lightLinksKey(environment);
    if (lightLinkCache?.parts === parts && lightLinkCache.linksKey === linksKey) {
      return lightLinkCache.linked;
    }
    const linking = agentSceneModule('lightLinking');
    const masks = linking.lightMasksFor(parts, environment);
    const wrappers = new Map();
    const linked = Object.freeze(parts.map((part, index) => (masks[index] === ALL_LIGHTS_MASK ? part
      : Object.freeze({ ...part, material: linkedMaterial(part.material, masks[index], wrappers) }))));
    lightLinkCache = { parts, linksKey, linked };
    return linked;
  }

  // The bake no longer matches the frame: motion moved a light, the sun or a part off the pose it was traced at.
  // Only a scene with both a bake and motion pays for this check, and bake.rebake turns it off (it bakes each sampled pose).
  function staleBakeProblems() {
    return lightBake && state.recipe.bake && state.motionSampler && !settling.pending ? agentSceneModule('bake').staleBakeProblems(state, lightBake.key) : [];
  }

  function stageRestParts(recipe, sourceRestParts, lightBakeResult, graph) {
    if (options.recipeOnly) {
      return { restParts: sourceRestParts };
    }
    const baked = lightBakeResult?.parts ?? sourceRestParts;
    // Its floor sky and reflections wait for the real light while the edit's bake runs.
    if (lightBakeResult?.pending) {
      return { reflected: null, restParts: stageCoplanarOffsets(recipe, stageLightLinks(recipe, baked), { rest: true }) };
    }
    const reflected = stageObjectReflections(recipe, sourceRestParts, baked, graph);
    return { reflected, restParts: stageWetMirror(recipe, stageCoplanarOffsets(recipe, stageLightLinks(recipe, stageFloorSky(recipe, reflected ? reflected.parts : baked, graph)), { rest: true })) };
  }

  // bake.rebake: a frame sampled at a pose the bake was not traced at is lit by a bake of that pose, cached by its key.
  function rebakeAtPose(pose) {
    const rebaked = lightBake && state.recipe.bake?.rebake && agentSceneModule('bake').bakeAtSampledPose(lightBake, state.recipe, pose);
    if (rebaked) {
      state.restParts = stageRestParts(state.recipe, state.sourceRestParts, rebaked, pose.graph).restParts;
      state.bakeReport = agentSceneModule('bake').withLocalVolumeReport(rebaked.report, state.recipe.environment.localVolumes);
    }
  }

  // A light bake costs seconds of ray tracing: it runs when the parts, the lights, the materials or the bake fields
  // change, and every other edit, seek or camera move reuses the last result.
  // `options.recipeOnly` builds the scene without its bake and without staging its parts (flush ranking, floor sky, reflections),
  // for a scene made only to read its recipe.
  function stageLightBake(recipe, sourceRestParts, graph, stagedMaterialSnapshots) {
    skippedBake = null;
    if (!recipe.bake || options.recipeOnly) {
      return null;
    }
    const worldMatrices = new Map(sourceRestParts.map(part => [part.name, new Float32Array(graph.getNode(part.name).worldMatrix)]));
    const generatedGeometryGenerators = agentSceneModule('bake').bakeGenerators(recipe);
    const bakeEnvironment = hasParentedLights(recipe.environment) ? agentSceneModule('lightParenting').bakeEnvironmentOf(recipe.environment, recipe, sourceRestParts, worldMatrices, graph) : recipe.environment;
    const bakeRecipe = bakeEnvironment === recipe.environment ? recipe : { ...recipe, environment: bakeEnvironment };
    const key = agentSceneModule('bake').lightBakeKey(recipe, generatedGeometryGenerators, bakeEnvironment, worldMatrices);
    if (lightBake?.key === key && lightBake.sourceRestParts === sourceRestParts) {
      lightBake.currentKey = key;
      return { ...lightBake, reused: true };
    }
    if (bakeDeferral && state && !recipe.bake.rebake) {
      return agentSceneModule('bakeDeferred').stageSettling(settling, bakeDeferral, { key, recipe: bakeRecipe, sourceRestParts, worldMatrices, generatedGeometryGenerators, stagedMaterialSnapshots, lightBake, state });
    }
    // The first build of a scene still fails loudly. A later edit stays applied: the old bake no longer fits the edited parts, so it is dropped.
    const { baked, refusal } = agentSceneModule('bake').withStagedMaterials(stagedMaterialSnapshots, () => agentSceneModule('bake').bakeUnlessRefused(Boolean(state), sourceRestParts, worldMatrices, bakeEnvironment, recipe.bake, generatedGeometryGenerators));
    if (refusal) {
      lightBake = null;
      skippedBake = refusal;
      return null;
    }
    lightBake = { key, currentKey: key, sourceRestParts, parts: baked.parts, report: baked.report };
    return { ...lightBake, reused: false };
  }

  // Smooth metal parts get a probe of the scene around them (src/agent-reflections.js), unless environment.objectReflections
  // is false. It runs only when that code is loaded, which a recipe with a metallic value of 0.5 or more does.
  function stageObjectReflections(recipe, sourceRestParts, drawnParts, graph) {
    skippedReflections = null;
    if (recipe.environment.objectReflections === false || !agentSceneModuleLoaded('reflections')) {
      return null;
    }
    objectReflectionCache = agentSceneModule('reflections').stageObjectReflections(objectReflectionCache, recipe, sourceRestParts, drawnParts, graph, agentEnvironmentMap(recipe.environment));
    skippedReflections = objectReflectionCache.skipped;
    return objectReflectionCache.result;
  }

  // Wet ground with puddles mirrors the scene in them: the water mirror module flags the flat ground parts, and the host attaches the mirror.
  function stageWetMirror(recipe, parts) {
    const environment = recipe.environment;
    return environment.wetness > 0 && environment.puddles && agentSceneModuleActive('waterReflection', requestedModules) ? agentSceneModule('waterReflection').flagWetMirrorParts(parts) : parts;
  }

  // A closed room a sun lights gets the sky each floor texel sees; the lazy module decides, keeps its result and honours environment.floorSkyTrace.
  // The report of the latest default sky trace, kept so scene_inspect can say when the trace stopped at its time limit (#3389).
  let skyTraceReport = null;
  const rememberSkyTraceReport = report => (skyTraceReport = report);
  function stageFloorSky(recipe, parts, graph) {
    return agentSceneModuleActive('floorSky', requestedModules) ? agentSceneModule('floorSky').stageFloorSky(recipe.environment, parts, name => graph.getNode(name).worldMatrix, rememberSkyTraceReport) : parts;
  }

  // A scene that asks for no bake and looks like a closed room gets one diagnostic naming the bake. The ray test costs a
  // few milliseconds, so it runs for scene_inspect only and is kept until the scene changes.
  function isLitByLampsOnly(environment) {
    const lampCount = (environment.pointLights?.length ?? 0) + (environment.spotLights?.length ?? 0) + (environment.areaLights?.length ?? 0);
    const keyColor = environment.keyColor ?? [1, 1, 1];
    const keyLight = (environment.keyIntensity ?? 1) * (keyColor[0] + keyColor[1] + keyColor[2]);
    return lampCount > 0 && keyLight === 0;
  }

  let closedRoomCache = null;
  function closedRoomProblems() {
    if (closedRoomCache?.revision !== revision) {
      const worldMatrices = new Map(state.parts.map(part => [part, state.graph.getNode(part.name).worldMatrix]));
      closedRoomCache = { revision, share: closedRoomShare(state.parts, worldMatrices) };
    }
    const { share } = closedRoomCache;
    if (share === null || share < CLOSED_ROOM_SHARE) return [];
    const edgeLeak = roomEdgeLeakDiagnostic(state.recipe);
    return [...(state.recipe.bake ? [] : [closedRoomDiagnostic(share, isLitByLampsOnly(state.recipe.environment))]), ...(edgeLeak ? [edgeLeak] : [])];
  }

  // Near-coplanar triangles are ranked at draw time (issue #751) unless environment.resolveCoplanar is false, once the
  // coplanar code is loaded. The ranks sit beside the parts, so the parts and their geometry stay as they are. The search
  // runs again only when the parts are new objects.
  // Particle parts are left out (#2728): their specks move every frame, so a rank found for one frame is wrong for the next,
  // and searching thousands of small coplanar boxes on every seek took minutes at the 2,000 particle limit.
  // A sea with an oceanTime track is left out too (#2730): its waves move every frame, and each new frame searched the whole
  // still scene again, seconds per frame, so playback could not run.
  let flushCache = null;
  function partsToRank(recipe, parts) {
    const movingNodes = new Set([...(recipe.particles?.systems.map(system => system.node) ?? []), ...oceanTrackNodeIds(recipe)]);
    // Scattered clutter and blade grass are left out as well: thousands of irregular stones and blades have no flush faces, and ranking them took seconds per edit.
    const clutterPrefixes = recipe.nodes.filter(node => node.clutter || node.grass).map(node => `${node.id}/`);
    if (movingNodes.size === 0 && clutterPrefixes.length === 0) {
      return parts;
    }
    return parts.filter(part => !movingNodes.has(part.name) && !clutterPrefixes.some(prefix => part.name.startsWith(prefix)));
  }

  function sameParts(first, second) {
    return first.length === second.length && first.every((part, index) => part === second[index]);
  }

  // An edit of a scene that holds this many triangles to rank does not wait for the search (#2905): it returns with the parts
  // unranked and the search runs right after, on the next turn of the event loop. A new scene is still ranked inside the call,
  // so a render job built from a recipe never misses an offset. A scene whose parts move (#2787) searches its still parts the
  // same way; the rest parts and the posed parts of that edit share the one search (see joinPendingFlush).
  const DEFERRED_FLUSH_TRIANGLES = 100_000;
  let pendingFlush = null;

  function triangleCountOf(parts) {
    return parts.reduce((total, part) => total + (part.geometry?.indices?.length ?? 0) / 3, 0);
  }

  function cancelPendingFlush() {
    if (pendingFlush) {
      pendingFlush.runner.cancel();
      pendingFlush = null;
    }
  }

  function shouldDeferFlush(rankedParts) {
    return state !== null && triangleCountOf(rankedParts) >= (options.deferFlushTriangles ?? DEFERRED_FLUSH_TRIANGLES)
      && !rankedLists().some(candidate => sameParts(candidate.rankedParts, rankedParts));
  }

  // A pose of a moving sea or of particles stages new parts around the same still parts, so every set of parts staged while the
  // search runs waits for it. At most the rest parts and the latest posed parts are kept, rest first, which is the order a cold
  // edit ranks them in.
  function joinPendingFlush(parts, rest) {
    const kept = pendingFlush.targets.filter(target => target.rest !== rest);
    pendingFlush.targets = [...kept, { parts, rest }].sort((first, second) => Number(second.rest) - Number(first.rest));
  }

  function rankAndStage(coplanar, recipe, parts, rest, searched = null) {
    const list = rankedList(coplanar, partsToRank(recipe, parts), rest, searched);
    // Ranked parts batch apart, so the list they are staged in is a new one: the renderer then regroups, also when the
    // ranking is switched on or off for parts that did not change. The same parts, or their staged list, get it back.
    // The rest and posed parts of a moving sea share one ranking (#2730), so each keeps its own staged list.
    let staged = stagedByParts.get(parts);
    if (!staged) {
      staged = list.resolved.ranked ? Object.freeze([...parts]) : parts;
      stagedByParts.set(parts, staged);
      stagedByParts.set(staged, staged);
    }
    flushCache = { parts, staged, list, ...list.resolved };
    return staged;
  }

  // Finishes the deferred search now, whether the slices ran out or a caller needs the ranks first. It is the same search a cold
  // edit runs, so the result is byte for byte the same.
  function settleFlush() {
    if (!pendingFlush) {
      return false;
    }
    pendingFlush.runner.drain();
    return true;
  }

  // The drawn parts are swapped for the ranked list as a topology change.
  function finishFlush(pending, searched) {
    pendingFlush = null;
    let regrouped = false;
    for (const { parts, rest } of pending.targets) {
      const staged = rankAndStage(agentSceneModule('coplanar'), pending.recipe, parts, rest, searched);
      if (staged !== parts) {
        const drawnChanged = state.parts === parts;
        state.restParts = state.restParts === parts ? staged : state.restParts;
        state.parts = drawnChanged ? staged : state.parts;
        regrouped = true;
      }
    }
    if (regrouped) {
      topologyRevision++;
    }
  }

  function stageCoplanarOffsets(recipe, parts, { rest = false } = {}) {
    if (options.recipeOnly || !agentSceneModuleActive('coplanar', requestedModules)) {
      return parts;
    }
    const coplanar = agentSceneModule('coplanar');
    if (recipe.environment.resolveCoplanar === false) {
      cancelPendingFlush();
      for (const list of rankedLists()) {
        coplanar.clearFlushParts(list.rankedParts);
      }
      restRankedList = null;
      posedRankedLists = [];
      stagedByParts = new WeakMap();
      flushCache = null;
      return parts;
    }
    const rankedParts = partsToRank(recipe, parts);
    if (pendingFlush && sameParts(pendingFlush.rankedParts, rankedParts)) {
      if (!pendingFlush.targets.some(target => target.parts === parts)) {
        joinPendingFlush(parts, rest);
      }
      return parts;
    }
    if (flushCache?.parts !== parts && flushCache?.staged !== parts) {
      cancelPendingFlush();
      if (shouldDeferFlush(rankedParts)) {
        flushCache = { parts, staged: parts, list: null, ranked: 0, leftovers: [] };
        const pending = { targets: [{ parts, rest }], rankedParts, recipe, runner: null };
        const onFailure = () => { pendingFlush = null; };
        pending.runner = coplanar.startFlushParts(rankedParts, { onDone: searched => finishFlush(pending, searched), onFailure });
        pendingFlush = pending;
        return parts;
      }
      rankAndStage(coplanar, recipe, parts, rest);
    }
    return flushCache.staged;
  }

  // The rest parts ranked last and the last two posed lists. A scene whose pose replaces parts (a sea with an oceanTime track)
  // stages its rest parts and then its posed parts on every edit (#2730); going back to a list ranked before puts its stored
  // ranks back instead of searching the whole scene again. The rest list is kept apart, so seeking to new times does not push
  // it out and the next edit finds it. A seek that only swaps the particle parts finds the same list.
  let restRankedList = null;
  let posedRankedLists = [];
  let stagedByParts = new WeakMap();
  function rankedLists() {
    return restRankedList ? [restRankedList, ...posedRankedLists] : posedRankedLists;
  }
  function rankedList(coplanar, rankedParts, rest, searched = null) {
    let list = rankedLists().find(candidate => sameParts(candidate.rankedParts, rankedParts));
    if (!list) {
      const resolved = searched ?? coplanar.resolveFlushParts(rankedParts);
      list = { rankedParts, resolved, orders: rankedParts.map(flushOrderOf) };
      if (rest) restRankedList = list;
      else posedRankedLists = [list, ...posedRankedLists].slice(0, 2);
    } else if (list !== flushCache?.list) {
      list.rankedParts.forEach((part, index) => setFlushOrder(part, list.orders[index]));
    }
    return list;
  }

  // scene_inspect names what the ranking could not settle. A scene that opted out gets the pairs of parts that fight instead:
  // that check is bounded, runs on inspect only and is kept until the scene changes.
  const repeatTracker = createRepeatTracker();
  let coplanarReportCache = null;
  function coplanarProblems() {
    if (!agentSceneModuleActive('coplanar', requestedModules)) {
      return [];
    }
    if (state.recipe.environment.resolveCoplanar !== false) {
      settleFlush();
      return agentSceneModule('coplanar').flushLeftoverDiagnostics(flushCache?.leftovers ?? []);
    }
    if (coplanarReportCache?.revision !== revision) {
      const coplanar = agentSceneModule('coplanar');
      coplanarReportCache = { revision, problems: coplanar.coplanarOverlapDiagnostics(coplanar.findCoplanarOverlaps(state.parts)) };
    }
    return coplanarReportCache.problems;
  }

  // A bake costs a solver run, so an unchanged section on unchanged geometry reuses the last one.
  function stagePhysics(recipe, geometryRecords) {
    if (!recipe.physics) {
      return null;
    }
    const key = agentSceneModule('physics').physicsBakeKey(recipe, geometryRecords);
    if (physicsBake?.key !== key) {
      const geometries = new Map([...geometryRecords].map(([id, record]) => [id, record.geometry]));
      physicsBake = { key, sampler: agentSceneModule('physics').bakeAgentPhysics(recipe.physics, recipe, geometries) };
    }
    return physicsBake.sampler;
  }

  // Same rule as physics: an unchanged cloth section on unchanged geometry and nodes reuses the last bake.
  function stageCloth(recipe, geometryRecords, motionSampler) {
    if (!recipe.cloth) {
      return null;
    }
    const involved = new Set([...recipe.cloth.sheets, ...(recipe.cloth.colliders ?? [])].map(entry => entry.node));
    const involvedNodes = recipe.nodes.filter(node => involved.has(node.id));
    const followsMotion = recipe.cloth.sheets.some(sheet => sheet.pinTo) || (recipe.cloth.colliders ?? []).some(collider => collider.node === undefined);
    const key = JSON.stringify([recipe.cloth, involvedNodes, involvedNodes.map(node => geometryRecords.get(node.geometry)?.signature), followsMotion ? [recipe.motion, recipe.nodes, recipe.armatures] : null]);
    if (clothBake?.key !== key) {
      const geometries = new Map([...geometryRecords].map(([id, record]) => [id, record.geometry]));
      clothBake = { key, sampler: agentSceneModule('cloth').bakeAgentCloth(recipe.cloth, recipe, geometries, motionSampler) };
    }
    return clothBake.sampler;
  }

  // Particle launches are cheap to recompute, but an unchanged section on unchanged nodes still reuses them.
  function stageParticles(recipe, geometryRecords, stagedState) {
    if (!recipe.particles) {
      return null;
    }
    const emitterMeshes = new Set(recipe.particles.systems.map(system => system.emitter?.mesh));
    const involvedNodes = recipe.nodes.filter(node => emitterMeshes.has(node.id) || recipe.particles.systems.some(system => system.node === node.id));
    const oceanTracks = (recipe.motion?.tracks ?? []).filter(track => track.kind === 'geometry' && track.property === 'oceanTime');
    // An emitter that follows a node reads its animated transform, so the motion, the physics and the node tree are part of the key.
    const followsNode = recipe.particles.systems.some(system => system.emitter?.follow || system.type === 'beam' || system.type === 'trail');
    const followedPose = followsNode ? [recipe.motion, recipe.physics, recipe.armatures, recipe.nodes.map(node => [node.id, node.parent, node.translation, node.rotation, node.scale])] : null;
    const key = JSON.stringify([recipe.particles, involvedNodes, involvedNodes.map(node => geometryRecords.get(node.geometry).signature), oceanTracks, followedPose]);
    if (particleBake?.key !== key) {
      const geometries = new Map([...geometryRecords].map(([id, record]) => [id, record.geometry]));
      // An emitter on a sea with an oceanTime track samples the sea at the ocean time of each particle's birth (#2152).
      const sea = {
        oceanTimeAt: (geometryId, time) => stagedState.motionSampler?.sample(time)?.geometries?.get(geometryId)?.oceanTime ?? null,
        geometryAt: (geometryId, oceanTime) => oceanTimeGeometry(recipe, stagedState.maxGeometryVertices, geometryId, oceanTime),
      };
      particleBake = { key, sampler: agentSceneModule('particles').bakeAgentParticles(recipe.particles, recipe, geometries, sea, { matrixAt: (nodeId, time) => worldMatrixAt(stagedState, nodeId, time) }) };
    }
    return particleBake.sampler;
  }

  // A billboard node turns to the camera at each sampled time, so its sheet is rebuilt per pose (#3237).
  function stageBillboards(recipe, geometryRecords, stagedState) {
    if (!recipe.nodes.some(node => node.billboard)) return null;
    const geometries = new Map([...geometryRecords].map(([id, record]) => [id, record.geometry]));
    return agentSceneModule('textBillboard').bakeTextBillboards(recipe, geometries, { matrixAt: (nodeId, time) => worldMatrixAt(stagedState, nodeId, time) });
  }

  // An edit keeps the time the scene was sampled at (#2730): posing it at 0 again rebuilt and ranked every animated part,
  // and the host sampled the old time again right after. A rebaked light bake and a pose that fails at that time start at 0.
  function poseAtPlayhead(stagedState) {
    const time = state?.motionTime;
    if (typeof time !== 'number' || time === 0 || stagedState.recipe.bake?.rebake) {
      return stagePose(stagedState, 0);
    }
    try {
      return stagePose(stagedState, time);
    } catch {
      return stagePose(stagedState, 0);
    }
  }

  function commit(stagedState, incrementRevision) {
    // A pose that swaps in new parts (particles, cloth) is a topology change too: a renderer holding the old parts would
    // otherwise try to update parts it never saw, which failed with "Unknown part identity" (#2204).
    const posedPartsChanged = publishPose(stagedState, stagedState.initialPose);
    if (stagedState.topologyChanged || posedPartsChanged) {
      topologyRevision++;
    }
    if (incrementRevision && state) {
      revisionHistory.push({ revision, snapshot: snapshotState() });
      while (revisionHistory.length > REVISION_HISTORY_LIMIT) {
        revisionHistory.shift();
      }
    }
    state = stagedState;
    if (settling.pending || stagedState.settlingPlan) {
      agentSceneModule('bakeDeferred').adoptSettling(settling, stagedState.settlingPlan, finishSettledBake, stageSettledParts);
    }
    if (incrementRevision) {
      revision++;
    }
    return revision;
  }

  // What the landing stages on the baked parts runs in slices before it (#3052), in the landing's order, so it finds each result kept:
  // the reflections, the floor sky and the coplanar ranks.
  function* stageSettledParts(bakedParts) {
    const { recipe, graph } = state;
    const reflected = stageObjectReflections(recipe, state.sourceRestParts, bakedParts, graph);
    const sky = agentSceneModuleActive('floorSky', requestedModules) ? yield* agentSceneModule('floorSky').stageFloorSkySteps(recipe.environment, reflected ? reflected.parts : bakedParts, name => graph.getNode(name).worldMatrix, rememberSkyTraceReport) : reflected ? reflected.parts : bakedParts;
    const linked = stageLightLinks(recipe, sky);
    const rankedParts = partsToRank(recipe, linked);
    if (agentSceneModuleActive('coplanar', requestedModules) && recipe.environment.resolveCoplanar !== false && !rankedLists().some(list => sameParts(list.rankedParts, rankedParts))) {
      const coplanar = agentSceneModule('coplanar');
      rankAndStage(coplanar, recipe, linked, true, yield* coplanar.resolveFlushPartsSteps(rankedParts));
    }
  }

  // The bake of the last edit is done: the scene's parts are staged again with its light, like a fresh build, and swapped in as a
  // topology change. A bake a limit stopped leaves the scene drawn without light and says why, as an edit that skips its bake does.
  function finishSettledBake(plan, outcome) {
    const settled = agentSceneModule('bakeDeferred').settledBake(plan, outcome, state.recipe);
    lightBake = settled.lightBake;
    const { reflected, restParts } = stageRestParts(state.recipe, state.sourceRestParts, lightBake && { ...lightBake, reused: false }, state.graph);
    Object.assign(state, { restParts, bakeSkipped: settled.bakeSkipped, bakeReport: settled.bakeReport, reflectionReport: reflected ? reflected.report : null });
    publishPose(state, state.poseGraph ? poseAtPlayhead(state) : stagePose(state, null));
    topologyRevision++;
  }

  function expected(options) {
    knownKeys(options, ['expectedRevision'], 'transaction options');
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision !== revision) {
      throw invalidField('expectedRevision', options.expectedRevision, `the current revision, ${revision}; scene_inspect returns it`);
    }
  }

  commit(stage(input), false);
  return Object.freeze({
    capabilities: AGENT_SCENE_CAPABILITIES,
    limits,
    get parts() {
      return state.parts;
    },
    /** How many oldest undo revisions the latest edit released to fit maxVertices; 0 when none. */
    get releasedRevisions() {
      return releasedRevisionCount;
    },
    get revision() {
      return revision;
    },
    get topologyRevision() {
      return topologyRevision;
    },
    /** True while an edit of a heavy scene has not ranked its near-coplanar triangles yet (#2905); it finishes on its own right after the edit. */
    get flushPending() {
      return pendingFlush !== null;
    },
    /** Ranks the near-coplanar triangles of a pending edit now, so a render or an export never misses an offset. Returns whether it had to. */
    settleFlush,
    /** True while an edit shows before its light bake is done (#3052); the bake finishes on its own right after the edit. */
    get bakePending() {
      return Boolean(settling.pending);
    },
    /** Finishes the pending bake now, so a render or an export has the light a fresh build has. Returns whether it had to. */
    settleBake() {
      const waiting = Boolean(settling.pending);
      settling.pending?.runner.drain();
      return waiting;
    },
    /** Drops the pending bake of a scene nobody draws any more. */
    cancelBake() {
      settling.pending?.runner.cancel();
      settling.pending = null;
    },
    /** null: an edit waits for its bake. 'previous': it shows at once with the last light. 'none': it shows at once with no light. */
    setBakeDeferral(mode) {
      bakeDeferral = mode;
    },
    get camera() {
      return structuredClone(state.renderCamera);
    },
    get motionTime() {
      return state.motionTime;
    },
    /** Seconds each placed asset clip needs to play once, in placement order: the clips a render job can play on scene time. */
    placedClipEnds() {
      return state.assetRuntime.animators.length ? agentSceneModule('assets').placedClipEnds(state.assetRuntime) : [];
    },
    sequenceTextures() {
      return state.sequences;
    },
    sampleMotion(time) {
      if (time !== null && (!Number.isFinite(time) || time < 0 || time > 3600)) {
        throw invalidField('time', time, 'null or a number of seconds from 0 to 3600, such as 0.5');
      }
      if (time !== null && !state.motionSampler && !state.physicsSampler && !state.clothSampler && !state.particleSampler && !state.billboardSampler && !state.assetRuntime.animators.length && !state.sequences.length && !state.recipe.environment.localVolumes?.some(volume => volume.frames)) {
        throw invalidField('time', time, 'null, because this recipe has no motion, physics, cloth, particles, placed asset clip or grid volume frames to sample; add motion first');
      }
      const pose = stagePose(state, time);
      rebakeAtPose(pose);
      if (publishPose(state, pose)) {
        topologyRevision++;
      }
      return state.motionTime;
    },
    /**
     * Set the pose a game's animation graph computed for a placed asset: `nodeOverrides` (and optional `morphWeights`) as
     * `asset.stagePose` takes them. The next `sampleMotion` draws it. Only the player and NPC nodes of the game section are posable.
     */
    setAssetPose(nodeId, { nodeOverrides = [], morphWeights } = {}) {
      const record = state.assetRuntime.animators.find(candidate => candidate.node === nodeId && candidate.pose);
      if (!record) {
        throw invalidField('nodeId', nodeId, 'a placed asset node that game.player.animation or game.npcs[].animation animates; other placed assets play their asset.clip or asset.drive');
      }
      record.pose = { nodeOverrides, morphWeights };
    },
    // After sampleMotion, the lights, sun and sky the motion tracks set at that time; the recipe keeps its authored values.
    get environment() {
      const environment = structuredClone(agentEnvironmentKey(state.recipe.environment));
      // The time a grid sequence plays at (#1045): the rasterizer and the path tracer both pick the frame from it.
      if (environment.localVolumes?.some(volume => volume.frames)) environment.volumeTime = state.motionTime;
      const moved = state.movedLook ? agentSceneModule('motion').motionEnvironment(environment, state.movedLook) : environment;
      return hasParentedLights(moved) ? agentSceneModule('lightParenting').environmentAtPose(state, moved) : moved;
    },
    /** World bounds ({ name, min, max }) of the visible mesh parts in the current pose; parts with no known bounds are left out. */
    worldBounds() {
      const bounds = [];
      // A bake or a skin replaces a drawn part's geometry, so the bounds come from the part as built, in the drawn pose.
      const drawnParts = new Map(state.restParts.map(part => [part.name, part]));
      const measured = new Set();
      for (const sourcePart of state.sourceRestParts) {
        // A node with material slots is several parts of one name over the same vertices: it is measured once.
        if (measured.has(sourcePart.name)) continue;
        measured.add(sourcePart.name);
        const part = drawnParts.get(sourcePart.name);
        if (!part || part.visibility?.visible === false) continue;
        // Measured from the geometry itself: a water part with foam or a wear mask draws a copy the cached local bounds do not list.
        bounds.push({ name: part.name, ...boundsFor(sourcePart.geometry, part.matrix) });
      }
      return bounds;
    },
    /** The bake-stale warning, or none: see `staleBakeProblems` in `agent-bake.js`. */
    bakeStaleness: staleBakeProblems,
    /** The z-fighting the draw-time ranking could not settle, as coplanar-overlap findings; none when the scene opted out (the renderer reports its pairs) or has none. */
    flushLeftovers() {
      return state.recipe.environment.resolveCoplanar === false ? [] : coplanarProblems();
    },
    /**
     * The scene's findings for an edit answer (#2207): a coplanar overlap already reported with both parts unchanged is left out
     * and counted in one line. scene_inspect and scene_look still list every finding. Spread the result into the answer.
     */
    editDiagnostics() {
      const { shown, unchanged } = repeatTracker.filter(this.inspect().diagnostics ?? [], name => partFingerprint(state.parts.find(part => part.name === name)));
      const diagnostics = unchanged ? [...shown, { kind: 'coplanar-overlap-unchanged', severity: 'info', count: unchanged, message: unchangedFindingsLine(unchanged) }] : shown;
      return diagnostics.length ? { diagnostics } : {};
    },
    get postPasses() {
      return structuredClone(state.recipe.postPasses ?? []);
    },
    get pixelGrid() {
      return state.recipe.pixelGrid ? { ...state.recipe.pixelGrid } : null;
    },
    get postPassesAntialias() {
      return state.recipe.postPassesAntialias ?? 'fxaa';
    },
    get effects() {
      const effects = structuredClone(state.recipe.effects);
      const moved = state.movedLook?.effects ? agentSceneModule('motion').motionEffects(effects, state.movedLook) : effects;
      return moved.distortion || moved.flash ? agentSceneModule('postSteps').placeAirSteps(moved, state.motionTime, state.parts) : moved;
    },
    get shadow() {
      return structuredClone(state.recipe.shadow);
    },
    exportRecipe() {
      return authoredRecipe(state.recipe);
    },
    /** Bone nodes at rest and a clip baked from motion, as `exportGlb` options. Leaves the pose where it was. */
    rigExport(options = {}) {
      if (!state.recipe.armatures) {
        return { nodes: [], clips: [] };
      }
      const exported = bakeRigExport(state.recipe, state.graph, state.motionSampler, options);
      publishPose(state, stagePose(state, state.motionTime));
      return exported;
    },
    /** Gives a scene created without placed assets the pool of decoded catalog assets, so a later edit can place the first one. */
    provideAssets(pool) {
      options = { ...options, assets: pool };
    },
    apply(inputOperations, options = {}) {
      expected(options);
      if (!Array.isArray(inputOperations) || inputOperations.length === 0 || inputOperations.length > limits.maxOperations) {
        throw invalidField('operations', Array.isArray(inputOperations) ? `${inputOperations.length} operations` : inputOperations, `a list of 1 to ${limits.maxOperations} operations, such as [{ "type": "set-camera", "fov": 50 }]`);
      }
      const operations = copiedJson(inputOperations, limits.maxRecipeBytes);
      for (const name of defaultStageModulesNamed(operations)) requestedModules.add(name);
      const onlyFieldEdits = operations.every(operation => FIELD_EDIT_OPERATIONS.has(operation.type) && !('removeTracks' in operation));
      const candidate = (onlyFieldEdits && fieldEditCandidate(state.recipe, operations)) || authoredRecipe(state.recipe);
      const removedNodes = new Set();
      const removedMaterials = new Set();
      const removals = [];
      for (const operation of operations) {
        const section = Object.hasOwn(NULLABLE_SECTION_OPERATIONS, operation.type) ? NULLABLE_SECTION_OPERATIONS[operation.type] : null;
        if (section === 'motion' && 'removeTracks' in operation) {
          candidate.motion = agentSceneModule('motionTrackRemoval').removeMotionTracks(operation, candidate.motion);
          continue;
        }
        if (section) {
          knownKeys(operation, ['type', section], 'operation');
          if (!Object.hasOwn(operation, section)) {
            throw invalidField(section, undefined, `a ${section} value, or null to clear it, in a ${operation.type} operation`, TypeError);
          }
          candidate[section] = operation[section];
          if (candidate.armatures === null) delete candidate.armatures;
          continue;
        }
        const lookField = Object.hasOwn(LOOK_OPERATION_FIELDS, operation.type) ? LOOK_OPERATION_FIELDS[operation.type] : null;
        if (lookField) {
          knownKeys(operation, ['type', lookField], 'operation');
          const patch = operation[lookField];
          // Spot and area lights, cascades and sun links are absent from a recipe until it sets them.
          const optionalFields = lookField === 'environment' ? ['ground', 'spotLights', 'areaLights', 'shadowCascades', 'localVolumes', 'keyAffects', 'objectReflections', 'floorSkyTrace', 'sunBounce', 'specularAntiAliasing', 'sunAngularRadius', 'lines', 'resolveCoplanar', 'viewTransform', 'look', 'hdri', 'reflectionHdri', 'keyFromHdri', 'sky', 'wetness', 'puddles', 'ambientColor', 'ambientMix', 'fillColor', 'environmentDiffuseScale', 'skybox'] : lookField === 'effects' ? postStepSupport.fields : lookField === 'shadow' ? ['hard'] : [];
          knownKeys(patch, [...Object.keys(candidate[lookField]), ...optionalFields], lookField);
          requireChange(Object.keys(patch).length > 0, operation, [...Object.keys(candidate[lookField]), ...optionalFields]);
          const { kept: keptPatch, cleared: clearedFields } = splitClearedLookPatch(lookField, patch);
          const merged = { ...candidate[lookField], ...(lookField === 'environment' ? environmentPatchWithSetup(keptPatch) : keptPatch) };
          for (const field of clearedFields) delete merged[field];
          if (lookField === 'environment' && Object.hasOwn(patch, 'volumeFog')) {
            knownKeys(patch.volumeFog, [...Object.keys(candidate.environment.volumeFog), ...VOLUME_FOG_FIELDS], 'volumeFog');
            merged.volumeFog = { ...candidate.environment.volumeFog, ...patch.volumeFog };
          }
          if (lookField === 'effects') mergeEffectGroups(candidate.effects, keptPatch, merged);
          // A preset starts the sky again from its own sun, so fields kept from the earlier sky never hide it.
          if (patch.sky) {
            const kept = candidate[lookField].sky;
            const type = patch.sky.type ?? kept?.type ?? 'physical';
            merged.sky = { ...!patch.sky.preset && kept?.type === type && kept, type, ...patch.sky };
          }
          // The sky's derived colours kept from an earlier sky or setup are not choices: only the patch's own values beat the sky.
          if (lookField === 'environment' && merged.sky?.type === 'physical') {
            for (const field of SKY_OVERRIDABLE_FIELDS) if (!Object.hasOwn(patch, field)) delete merged[field];
          }
          candidate[lookField] = merged;
          continue;
        }
        const addition = Object.hasOwn(ADDITION_FIELDS, operation.type) ? ADDITION_FIELDS[operation.type] : null;
        if (addition) {
          const [collection, field] = addition;
          knownKeys(operation, ['type', field], 'operation');
          const record = operation[field];
          identifier(record?.id);
          if (operation.type === 'add-geometry') {
            geometryEstimate(record);
          } else if (operation.type === 'add-material') {
            materialFrom(record);
          } else {
            nodeFrom(record);
          }
          if (candidate[collection].some(existing => existing.id === record.id)) {
            throw invalidField(`${field}.id`, record.id, `an ID no ${collection} entry uses yet; pick a new ID, or remove the existing one first`);
          }
          candidate[collection].push(record);
          continue;
        }
        if (operation.type === 'bake-motion') {
          agentSceneModule('motionBake').bakeMotion(candidate, operation, motionBakeSource(state));
          continue;
        }
        if (operation.type === 'fracture-node') {
          const { id: fracturedId } = candidate.nodes.find(node => node.id === operation.node) ?? {};
          agentSceneModule('fracture').fractureNode(candidate, operation, geometryId => generateOperationGeometry(candidate, geometryId, limits));
          if (fracturedId !== undefined) removedNodes.add(fracturedId);
          continue;
        }
        if (operation.type === 'separate-faces' || operation.type === 'join-meshes') {
          agentSceneModule('meshParts').applyMeshPartsOperation(candidate, operation, removedNodes, geometryId => generateOperationGeometry(candidate, geometryId, limits));
          continue;
        }
        if (operation.type === 'add-explosion') {
          const sourceGeometry = geometryId => generateOperationGeometry(candidate, geometryId, limits);
          agentSceneModule('explosion').addExplosion(candidate, operation, { sourceGeometry, fractureNode: fracture => agentSceneModule('fracture').fractureNode(candidate, fracture, sourceGeometry) });
          if (typeof operation.debris?.node === 'string') removedNodes.add(operation.debris.node);
          continue;
        }
        if (operation.type === 'settle') {
          agentSceneModule('settle').applySettle(candidate, operation);
          continue;
        }
        if (operation.type === 'apply-transform') {
          agentSceneModule('applyTransform').applyNodeTransform(candidate, operation);
          continue;
        }
        if (operation.type === 'set-origin') {
          agentSceneModule('applyTransform').setNodeOrigin(candidate, operation, (recipe, geometryId) => generateOperationGeometry(recipe, geometryId, limits).positions);
          continue;
        }
        if (operation.type === 'edit-mesh') {
          knownKeys(operation, ['type', 'geometry', 'edits', 'replace'], 'operation');
          const target = meshGeometryTarget(candidate, operation, type => `Add a mesh geometry with base: { type: '${type}', ... } to edit it.`);
          if (operation.replace !== undefined && typeof operation.replace !== 'boolean') {
            throw invalidField('replace', operation.replace, 'true or false', TypeError);
          }
          if (!Array.isArray(operation.edits)) {
            throw invalidField('edits', operation.edits, 'an array of mesh edits, such as [{ "op": "extrude" }]', TypeError);
          }
          target.edits = operation.replace ? operation.edits : [...(target.edits ?? []), ...operation.edits];
          agentSceneModule('mesh').normalizeMeshEdits(target.edits);
          continue;
        }
        if (operation.type === 'set-mesh-stack') {
          knownKeys(operation, ['type', 'geometry', 'stack', 'apply'], 'operation');
          const target = meshGeometryTarget(candidate, operation, () => 'Only mesh geometries have a modifier stack.');
          const stack = operation.stack ?? target.stack ?? [];
          agentSceneModule('mesh').normalizeMeshStack(stack);
          const applied = operation.apply ?? 0;
          if (!Number.isInteger(applied) || applied < 0 || applied > stack.length) {
            throw invalidField('apply', applied, `a whole number from 0 to the stack length ${stack.length}, such as 0`);
          }
          const switchedOff = stack.slice(0, applied).findIndex(node => node.enabled === false);
          if (switchedOff >= 0) {
            throw invalidField('apply', applied, `a count that stops before stack node ${switchedOff}, which is switched off (enabled: false); switch it on or remove it first`);
          }
          // Applying moves the first nodes into the edit log, as Blender's Apply modifier does.
          target.edits = [...(target.edits ?? []), ...stack.slice(0, applied)];
          target.stack = stack.slice(applied);
          agentSceneModule('mesh').normalizeMeshEdits(target.edits);
          continue;
        }
        if (operation.type === 'remove-node') {
          for (const id of removeNode(candidate, operation)) {
            removedNodes.add(id);
          }
          continue;
        }
        const removal = Object.hasOwn(REMOVAL_FIELDS, operation.type) ? REMOVAL_FIELDS[operation.type] : null;
        if (removal) {
          knownKeys(operation, ['type', 'id'], 'operation');
          identifier(operation.id);
          const index = candidate[removal].findIndex(record => record.id === operation.id);
          if (index < 0) {
            throw invalidField('id', operation.id, `the ID of an existing ${removal} entry; scene_inspect lists them`);
          }
          removals.push(operation);
          candidate[removal].splice(index, 1);
          if (operation.type === 'remove-material') {
            removedMaterials.add(operation.id);
          }
          continue;
        }
        let target;
        let fields;
        if (operation.type === 'set-node') {
          fields = NODE_FIELDS;
          target = candidate.nodes.find(node => node.id === operation.id);
        } else if (operation.type === 'set-material') {
          fields = [...MATERIAL_FIELDS, 'map', ...TEXTURE_SET_RECIPE_FIELDS];
          target = candidate.materials.find(material => material.id === operation.id);
        } else if (operation.type === 'set-camera') {
          fields = CAMERA_FIELDS;
          target = candidate.camera;
        } else {
          throw invalidField('type', operation.type, `one of ${AGENT_SCENE_CAPABILITIES.operations.join(', ')}`, TypeError);
        }
        knownKeys(operation, ['type', ...(operation.type === 'set-camera' ? [] : ['id']), ...fields], 'operation');
        if (!target) {
          throw invalidField('id', operation.id, `the ID of an existing ${operation.type === 'set-node' ? 'node' : 'material'}; scene_inspect lists them, or add it first with an add operation`);
        }
        requireChange(Object.keys(operation).some(key => fields.includes(key)), operation, fields);
        if (operation.type === 'set-camera') {
          applyCameraFields(target, operation);
        } else {
          for (const field of fields) {
            if (Object.hasOwn(operation, field)) {
              target[field] = operation[field];
            }
          }
        }
      }
      assertRemovedResourcesUnused(candidate, removals);
      // Plain field edits put only values the operation copy already checked into the candidate, so the recipe is not copied and checked a second time.
      try {
        return commit(stage(candidate, null, removedNodes, removedMaterials, onlyFieldEdits, onlyFieldEdits ? poseEditNodeIds(operations) : null), true);
      } catch (error) {
        pendingGraphRestore?.();
        throw error;
      } finally {
        pendingGraphRestore = null;
      }
    },
    inspect(options = {}) {
      knownKeys(options, ['ids', 'limit', 'includeBounds', 'path'], 'inspection');
      const maximum = integer(options.limit ?? Math.min(64, limits.maxNodes), 1, limits.maxNodes, 'inspection limit');
      if (options.includeBounds !== undefined && typeof options.includeBounds !== 'boolean') {
        throw invalidField('includeBounds', options.includeBounds, 'true or false', TypeError);
      }
      if (options.ids !== undefined && (!Array.isArray(options.ids) || options.ids.length > limits.maxNodes)) {
        throw invalidField('ids', Array.isArray(options.ids) ? `${options.ids.length} IDs` : options.ids, `a list of at most ${limits.maxNodes} node IDs, such as ["body"]`);
      }
      const selected = options.ids === undefined ? state.recipe.nodes.filter(node => !node.assetPart) : options.ids.map(id => {
        identifier(id);
        const node = state.recipe.nodes.find(value => value.id === id);
        if (!node) {
          throw invalidField('ids', id, 'IDs of existing nodes; call scene_inspect without ids to list them');
        }
        return node;
      });
      const nodes = selected.slice(0, maximum).map(node => {
        const geometry = state.geometries.get(node.geometry);
        const result = {
          id: node.id, label: node.label ?? node.id, parent: node.parent,
          geometry: node.geometry ?? null, material: node.material ?? null,
          vertices: geometry ? geometry.positions.length / 3 : 0,
          triangles: geometry ? geometry.indices.length / 3 : 0,
        };
        if (options.includeBounds) {
          result.bounds = geometry ? boundsFor(geometry, state.graph.getNode(node.id).worldMatrix) : null;
        }
        return result;
      });
      const resident = geometryStats(ownedGeometryRecords());
      const diagnostics = [...recipeDiagnostics(state.recipe), ...droppedVertexAlphaDiagnostics(state.parts), ...closedRoomProblems(), ...(skyTraceReport ? agentSceneModule('floorSky').skyTraceProblems(skyTraceReport) : []), ...staleBakeProblems(), ...(state.bakeSkipped ? [agentSceneModule('bake').bakeSkippedDiagnostic(state.bakeSkipped)] : []),...(state.reflectionSkipped ? [agentSceneModule('reflections').reflectionSkippedDiagnostic(state.reflectionSkipped)] : []), ...coplanarProblems(), ...(agentSceneModuleLoaded('unsupportedPart') ? agentSceneModule('unsupportedPart').unsupportedPartProblems(state.parts, state.recipe, revision) : []), ...(state.particleSampler?.diagnostics() ?? []), ...(state.assetRuntime.animators.length ? agentSceneModule('assets').placedClipDiagnostics(state.assetRuntime) : [])];
      return {
        revision, topologyRevision,
        ...(state.recipe.motion?.ik?.length ? { motionIk: agentSceneModule('motion').compileAgentMotion(state.recipe.motion, state.recipe).sweepIk() } : {}),
        motion: state.recipe.motion ? { duration: state.recipe.motion.duration, loop: state.recipe.motion.loop, tracks: state.recipe.motion.tracks.length, time: state.motionTime } : null,
        physics: state.physicsSampler ? state.physicsSampler.report() : null,
        ...(state.clothSampler ? { cloth: state.clothSampler.report() } : {}),
        ...(state.particleSampler ? { particles: state.particleSampler.report() } : {}),
        ...(state.billboardSampler ? { billboards: state.billboardSampler.report() } : {}),
        ...(state.assetRuntime.vegetation ? { vegetation: state.assetRuntime.vegetation } : {}),
        ...(state.assetRuntime.clutter ? { clutter: state.assetRuntime.clutter } : {}),
        ...(state.assetRuntime.grass ? { grass: state.assetRuntime.grass } : {}),
        ...(state.assetRuntime.placements.length ? { assets: agentSceneModule('assets').describeAssetPlacements(state.assetRuntime, state.graph, geometry => state.localBounds.get(geometry)) } : {}),
        ...(state.sequences.length ? { textureSequences: state.sequences.map(sequence => sequence.describe()) } : {}),
        ...(state.bakeReport ? { bake: state.bakeReport } : {}),
        ...(state.recipe.postPasses?.length ? { postPasses: agentSceneModule('userPass').describeUserPasses(state.recipe.postPasses) } : {}),
        ...(state.reflectionReport ? { reflections: state.reflectionReport } : {}),
        ...(state.recipe.armatures ? { rig: rigReport(state.recipe, state.skinBindings) } : {}),
        boundsSpace: 'authored-base-world',
        ...(diagnostics.length ? { diagnostics } : {}),
        ...(flushCache?.ranked ? { flush: { ranked: flushCache.ranked } } : {}),
        counts: {
          nodes: state.recipe.nodes.length, parts: state.parts.length,
          geometries: state.geometries.size, materials: state.recipe.materials.length,
          vertices: state.stats.vertices,
        },
        geometryBytes: state.stats.residentBytes,
        estimatedGeometryBytes: state.stats.estimatedGeometryBytes,
        residentGeometryBytes: resident.residentBytes,
        residentGeometryVertices: resident.vertices,
        look: {
          world: state.recipe.environment.world,
          pointLights: state.recipe.environment.pointLights.length,
          spotLights: state.recipe.environment.spotLights?.length ?? 0,
          areaLights: state.recipe.environment.areaLights?.length ?? 0,
          volumeFogDensity: state.recipe.environment.volumeFog.density,
          exposure: state.recipe.effects.exposure,
          ...(state.recipe.effects.autoExposure ? { autoExposure: { ...state.recipe.effects.autoExposure, chosen: null } } : {}),
        },
        nodes, truncated: selected.length > nodes.length,
        ...(options.path === undefined ? {} : { path: pathQuery(options.path) }),
      };
    },
    /** Polygon counts, parts, face tags and lint problems for recipe geometries (all, or the given IDs). */
    inspectMeshes(options = {}) {
      knownKeys(options, ['geometries'], 'mesh inspection');
      const requested = options.geometries ?? [...state.geometries.keys()];
      if (!Array.isArray(requested) || (options.geometries !== undefined && requested.length > MAX_MESH_REPORTS)) {
        throw invalidField('geometries', Array.isArray(requested) ? `${requested.length} IDs` : requested, `a list of at most ${MAX_MESH_REPORTS} geometry IDs, such as ["block"]`);
      }
      const selected = requested.slice(0, MAX_MESH_REPORTS);
      const meshes = selected.map(id => {
        identifier(id);
        const geometry = state.geometries.get(id);
        if (!geometry) {
          throw invalidField('geometries', id, `one of ${[...state.geometries.keys()].join(', ')}`);
        }
        return { geometry: id, ...agentSceneModule('mesh').meshReport(geometry) };
      });
      return { revision, meshes, truncated: requested.length > selected.length };
    },
    checkpoint() {
      if (checkpoints.size >= limits.maxCheckpoints) {
        throw invalidField('checkpoints', `${checkpoints.size} saved`, `at most ${limits.maxCheckpoints} saved checkpoints; release one with scene_release_checkpoint first`);
      }
      const handle = Object.freeze({});
      checkpoints.set(handle, snapshotState());
      return handle;
    },
    restore(handle, options = {}) {
      expected(options);
      const checkpoint = checkpoints.get(handle);
      if (!checkpoint) {
        throw invalidField('checkpointId', handle, 'a checkpointId that scene_checkpoint returned and you have not released');
      }
      return commit(stage(checkpoint.recipe, checkpoint), true);
    },
    /** Go back to an earlier revision that scene_apply or scene_restore left behind; no checkpoint is needed. */
    restoreRevision(target, options = {}) {
      expected(options);
      const entry = revisionHistory.find(candidate => candidate.revision === target);
      if (!entry) {
        const kept = revisionHistory.map(candidate => candidate.revision);
        throw invalidField('revision', target, kept.length > 0
          ? `one of the kept revisions: ${kept.join(', ')} (the last ${REVISION_HISTORY_LIMIT} are kept; older ones are dropped)`
          : 'a revision this session kept, but none is kept yet because nothing has been edited; apply an edit first');
      }
      return commit(stage(entry.snapshot.recipe, entry.snapshot), true);
    },
    /**
     * Replace the recipe of this scene with another whole recipe, as one transaction. Geometry, material handles and parts
     * that both recipes hold stay the same objects, so a recipe that differs by one object costs about as much as that edit.
     */
    restoreRecipe(recipe, options = {}) {
      expected(options);
      return commit(stage(recipe), true);
    },
    releaseCheckpoint(handle) {
      if (!checkpoints.delete(handle)) {
        throw invalidField('checkpointId', handle, 'a checkpointId that scene_checkpoint returned and you have not released');
      }
    },
  });
}
