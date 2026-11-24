import { answerCapabilities, MAX_TOPICS_PER_CALL } from './capabilities-topics.mjs';
import { configureAssetByteLimit } from '../src/agent-asset-limits.js';
import { MOTION_TRACK_KIND_NAMES } from '../src/motion-track-kinds.js';
import { CONSTRAINT_TYPE_NAMES } from '../src/motion-constraint-types.js';
import { DRIVER_VARIABLE_KIND_NAMES } from '../src/motion-driver-variable-kinds.js';
import { IK_SOLVER_TYPE_NAMES } from '../src/motion-ik-solver-types.js';
import { MOTION_PROPERTY_KIND_NAMES } from '../src/motion-property-kinds.js';
import { BRANCH_NAME_PATTERN } from '../src/agent-branches.js';
import { TEXTURE_SEQUENCE_LIMITS } from '../src/texture-sequence-limits.js';
import { HEIGHT_PARALLAX_LIMITS, NORMAL_CONVENTIONS, TEXTURE_MAP_FIELDS, UV_TRANSFORM_LIMITS } from '../src/texture-set-fields.js';
import { readEnvironmentVariable } from '../src/environment-variable.js';
import { McpServer } from '@modelcontextprotocol/server';
import { resolveJobRoot } from './agent-job-root.mjs';
import { createGpuQueueFromFlags } from './agent-gpu-queue.mjs';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { describeSchemaInputsWithReceivedValues } from './mcp-input-errors.mjs';
import { setPriority, constants, totalmem } from 'node:os';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import packageMetadata from '../package.json' with { type: 'json' };
import { MESH_EDIT_OPERATIONS, MODIFIER_OPERATIONS } from '../src/mesh-operations.js';
import { VIEW_TRANSFORM_NAMES, LOOK_NAMES } from '../src/view-transform-names.js';
import { BUNDLED_ENVIRONMENT_NAMES, BUNDLED_CUBE_LOOK_NAMES, CATALOG_FILE_ID } from '../src/look-catalog.js';
import { describeReceived } from '../src/field-error.js';
import { LOOK_VIEW_NAMES } from '../src/look-views.js';
import { MATERIAL_PATTERN_TYPES, MATERIAL_MAPPINGS, LIGHTING_SETUP_NAMES, RENDER_PASS_NAMES, RENDER_OUTPUT_FORMATS, MAXIMUM_JOB_FPS, VIDEO_ENCODERS, MAXIMUM_JOB_SIDE, maximumMemoryMiB, memoryRangeError, MAXIMUM_STILLS_FRAMES, RECIPE_ALPHA_MODES, PHYSICS_BODY_SHAPES } from '../src/agent-scene-capabilities.js';
import { MATERIAL_LAYER_SCALAR_RANGES, MATERIAL_LAYER_COLOR_RANGES, TOON_COLOR_MAXIMUM } from '../src/material-layers.js';
import { SUBSURFACE_RANGES } from '../src/subsurface-limits.js';
import { responseFormatField, chosenFormat, conciseReview, conciseJobStatus, conciseJobResult, conciseCapabilities } from './mcp-response-format.mjs';
import { resolveAddons } from './mcp-addons.mjs';
import { createCallLogger, CALL_LOG_ENVIRONMENT_VARIABLE } from './mcp-call-log.mjs';
import { startUpdateCheck, updateNoticeText, describeUpdateCheck } from '../src/mcp-update-check.js';
import { installVolumeGridFiles } from '../src/mcp-volume-grids.js';
import { setExplosionBakeStore } from '../src/explosion-grids.js';
import { bakeCacheDirectory, createExplosionBakeCache } from '../src/explosion-bake-cache.js';
import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from '../src/light-limits.js';
import { MINIMUM_SPOT_ANGLE, MAXIMUM_SPOT_ANGLE, spotAngleExpectation } from '../src/spot-angle-advice.js';
import { annotateViewHtml, clientSupportsMcpApps, ANNOTATE_VIEW_URI, MCP_APPS_MIME_TYPE } from './annotate-app-view.mjs';
import { loadAskUserFixture, describeAskUserFixture } from './ask-user-fixture.mjs';
import { MCP_OPTION_NAMES, mcpOptionSummary } from '../bin/crucible-mcp-flags.mjs';
import { resolvePacksOption } from '../bin/crucible-pack-folder.mjs';
import { FOLDED_APPLY_OPERATION_TYPES } from '../src/apply-operation-notes.js';
import { FIT_PARAMETER_NAMES } from '../src/look-fit-parameters.js';
import { REVIEW_CAMERA_FIELDS } from './agent-review.mjs';

describeSchemaInputsWithReceivedValues();

const finite = z.number().min(-3.4028234663852886e38).max(3.4028234663852886e38);
const positive = finite.positive();
const nonnegative = finite.nonnegative();
const unit = z.number().min(0).max(1);
const identifier = z.string().min(1).max(128).regex(/\S/).describe('Stable resource or node ID, with at least one non-space character.').meta({ id: 'Identifier' });
const vector3 = z.tuple([finite, finite, finite]).meta({ id: 'Vector3' });
const color = z.tuple([unit, unit, unit]).meta({ id: 'Color' });
const quaternion = z.tuple([finite, finite, finite, finite]).meta({ id: 'Quaternion' });
const point2 = z.tuple([finite, finite]);
// A tool lists a short object (its common fields and one line naming the rest) while the full strict schema still validates
// every call, because a pipe publishes its input side. scene_capabilities serves the full schema as an outline by topic.
const outlineSources = new Map();
function listed(topic, fullSchema, description, coreShape = {}) {
  if (!outlineSources.has(topic)) outlineSources.set(topic, fullSchema);
  return z.looseObject(coreShape).describe(description).pipe(fullSchema);
}
const coreOf = (strictShape, names) => Object.fromEntries(names.map(name => [name, strictShape[name]]));
const detail = (minimum, maximum) => z.number().int().min(minimum).max(maximum).optional();
const segments = detail(3, 2048);
const ring = z.array(point2).min(3).max(4096);
const skinSpec = z.strictObject({
  armature: identifier.describe('ID of an entry in recipe armatures.'),
  maxInfluences: z.number().int().min(1).max(4).optional().describe('Bones that move one vertex. Defaults to 4.'),
  maxDistance: positive.optional().describe('Metres from the nearest bone beyond which a vertex counts as unweighted in scene_inspect rig. Defaults to a quarter of the rig size.'),
}).describe('Bind this mesh node to an armature with automatic weights: each vertex follows its nearest bones, by distance to the bone segments. Needs the armature at rest where the mesh is.');
const relationList = z.array(z.record(z.string(), z.unknown())).max(8).describe('Relations against other mesh nodes; fields in scene_capabilities relations. [] removes them.').meta({ id: 'Relations' });
const placedAsset = z.record(z.string(), z.unknown()).describe('Catalog GLB placed at this group node: {id or name,materials,clip,drive}; see scene_capabilities placedAssets.').meta({ id: 'PlacedAsset' });
const placedVegetation = z.record(z.string(), z.unknown()).describe('Trees at this group node: {species} for one, or {mix, scatter:{ground,...}} over a terrain node; see scene_capabilities vegetation.').meta({ id: 'PlacedVegetation' });
const placedClutter = z.unknown();
const placedGrass = z.unknown();
// Left open here and checked by the scene (normalizeRayVisibility), whose errors say what to pass; the shape is in scene_capabilities renderFlags.
const rayVisibility = z.unknown();
const nodeFields = {
  relations: relationList.optional(),
  asset: placedAsset.optional(),
  vegetation: placedVegetation.optional(),
  clutter: placedClutter.optional(),
  grass: placedGrass.optional(),
  skin: listed('skin', skinSpec, 'Bind this mesh node to an armature with automatic weights: { armature, maxInfluences, maxDistance }.', coreOf(skinSpec.shape, ['armature'])).optional(),
  decal: z.boolean().optional(),
  billboard: z.record(z.string(), z.unknown()).optional().describe('Plane that faces the camera; scene_capabilities billboard.'),
  faceImages: z.array(z.record(z.string(), z.unknown())).max(6).nullable().optional().describe('scene_capabilities faceImages.'),
  depthLayer: z.number().int().min(0).max(4).optional(),
  visible: z.boolean().optional().describe('false hides the node and children; keyable in motion. Flags: scene_capabilities renderFlags.'),
  castShadow: z.boolean().optional(),
  receiveShadow: z.boolean().optional(),
  holdout: z.boolean().optional(),
  shadowCatcher: z.boolean().optional(),
  shadowOnly: z.boolean().optional(),
  rayVisibility: rayVisibility.optional(),
  blend: z.strictObject({ radius: z.number().min(0.005).max(2) }).optional().describe('Soft seam into another mesh, radius in m; docs/mesh-blend.md.'),
  label: z.string().max(256).optional().describe('Human-readable label. Identity remains the node ID.'),
  parent: identifier.nullable().optional().describe('Parent node ID, or null for a root. Local transforms stay unchanged.'),
  translation: vector3.optional().describe('Local XYZ of the node centre in metres, Y up, relative to its parent.'),
  rotation: quaternion.optional().describe('Nonzero local XYZW quaternion. The backend normalizes it.'),
  scale: z.tuple([positive, positive, positive]).optional().describe('Positive local XYZ scale.'),
};
const fieldExpression = z.union([finite, z.boolean(), vector3, z.record(z.string(), z.unknown())]).describe('Field expression, plain JSON and never code; driver expressions use the same language. A number, a boolean or [x,y,z] is a constant; an object holds one operator: math add mul sub div mod pow atan2 min max clamp saturate mix smoothstep neg abs sqrt sin cos floor ceil round fract sign; comparison lt lte gt gte eq; logic and or not if [cond,a,b]; vectors vec [x,y,z] dot cross distance length normalize x y z; sources {"attr":"position"|"normal"|"index"|"tag","component":"x"|"y"|"z","name":tag}, {"noise":{"scale":3,"seed":7,"octaves":1}} in 0..1, {"random":{"seed":1}} per element in 0..1. Limits in scene_capabilities fieldExpressions.');
const instanceCount = z.number().int().min(1).max(2048);
const instanceSpec = z.strictObject({
  grid: z.strictObject({ counts: z.tuple([instanceCount, instanceCount, instanceCount]), spacing: vector3 }).optional().describe('Grid of counts[0] x counts[1] x counts[2] points centred on the group.'),
  scatter: z.strictObject({ count: instanceCount, min: vector3, max: vector3 }).optional().describe('Seeded random points in a box.'),
  surface: z.strictObject({ geometry: identifier, count: instanceCount }).optional().describe("Seeded random points on the surface of a recipe geometry, in that geometry's own space; parent the instanced node to the node that carries it."),
  curve: z.strictObject({ points: z.array(vector3).min(2).max(256), count: instanceCount, closed: z.boolean().optional(), fillet: z.number().positive().optional() }).optional().describe('Equal steps along a polyline; fillet is a corner radius.'),
  seed: z.number().int().min(0).max(2147483647).optional(),
  where: fieldExpression.optional().describe('Number expression over the points (position, normal, index); points where it is 0 are dropped.'),
  place: z.record(z.string(), z.unknown()).optional().describe('scene_capabilities instancing.'),
  yaw: z.boolean().optional().describe('Random turn about up.'),
  alignToNormal: z.boolean().optional().describe('Surface or curve: turn up to the normal or direction.'),
  scale: z.tuple([z.number().min(0.001).max(1000), z.number().min(0.001).max(1000)]).optional().describe('Random uniform scale range [min, max].'),
}).describe('One of grid, scatter, surface or curve. Expands at scene_create into a group node plus one child node per point (<id>.0, <id>.1, ...) that share geometry and material and draw as one instanced batch. At most 2048 candidate points.');
const nodeRecord = z.strictObject({ armature: identifier.optional().describe('Set on nodes an armature generates, and ignored on input. Edit bones through armatures.'), id: identifier, geometry: identifier.optional(), material: identifier.optional(), instances: listed('instances', instanceSpec, 'Repeat geometry and material at points; needs both ids. Only in scene_create, not in add-node. One of grid {counts, spacing}, scatter {count, min, max}, surface {geometry, count} or curve {points, count, closed, fillet}; also seed, where, yaw, alignToNormal, scale.').optional(), ...nodeFields });
const materialGraph = z.record(z.string(), z.unknown()).describe('Node graph as plain JSON, never code. Outputs, nodes, inputs and limits are in scene_capabilities materialGraph.');
const materialPattern = z.strictObject({
  type: z.enum([...MATERIAL_PATTERN_TYPES, 'graph']).describe('Surface look: a preset, or graph for your own node graph (give graph). Directional presets (wood, planks, metal) run along axis.'),
  graph: materialGraph.optional().describe('Only with type graph.'),
  mapping: z.enum(MATERIAL_MAPPINGS).optional().describe('box (default) or uv, which needs UVs; see scene_capabilities.'),
  colors: z.array(color).min(2).max(3).optional().describe('Two linear RGB colours to mix, darker first. Only bricks accepts a third, the mortar; any other type rejects three. Each type has good defaults.'),
  size: z.number().min(0.01).max(100).optional().describe('Metres per repeat of the texture, so it keeps its real size on any object and node scale.'),
  count: z.number().int().min(1).max(64).optional().describe('Features per repeat: planks, bricks across, tiles across, wood rings or noise cells.'),
  bump: z.number().min(0).max(4).optional().describe('Relief strength. 0 is flat.'),
  seed: z.number().int().min(0).max(2147483647).optional(),
  axis: z.enum(['x', 'y', 'z']).optional().describe('Object axis the grain runs along. Defaults to y.'),
  resolution: z.union([z.literal(256), z.literal(512), z.literal(1024)]).optional().describe('Texture size. Defaults to 512; each pattern takes about 4 MiB at 512.'),
}).describe('Procedural texture; box mapping needs no UVs. color tints it, roughness and metallic scale it.');
function layerNumber(field) {
  const [minimum, maximum] = MATERIAL_LAYER_SCALAR_RANGES[field];
  const ranged = z.number()
    .min(minimum, `${field} must be at least ${minimum}. Raise it to ${minimum} or more.`)
    .max(maximum, `${field} must be at most ${maximum}. Lower it to ${maximum} or less.`);
  return z.number().pipe(ranged).optional();
}

function layerColor(field) {
  const [minimum, maximum] = MATERIAL_LAYER_COLOR_RANGES[field];
  const component = z.number().min(minimum, `${field} components must be at least ${minimum}.`).max(maximum, `${field} components must be at most ${maximum}. Use linear values.`);
  return z.array(z.number()).length(3).pipe(z.tuple([component, component, component])).optional();
}

// Ranges and one line per field are in scene_capabilities materialLayers; the server still checks each range.
const materialLayerFields = {
  clearcoat: layerNumber('clearcoat'),
  clearcoatRoughness: layerNumber('clearcoatRoughness'),
  transmission: layerNumber('transmission'),
  thickness: layerNumber('thickness'),
  ior: layerNumber('ior'),
  dispersion: layerNumber('dispersion'),
  attenuationColor: layerColor('attenuationColor'),
  attenuationDistance: z.number().positive('attenuationDistance must be above 0. Leave it out for no absorption.').max(3.4e38).describe('Metres to reach attenuationColor.').optional(),
  sheenColor: layerColor('sheenColor'),
  sheenRoughness: layerNumber('sheenRoughness'),
  specular: layerNumber('specular'),
  specularColor: layerColor('specularColor'),
  anisotropy: layerNumber('anisotropy'),
  anisotropyRotation: layerNumber('anisotropyRotation'),
  iridescence: layerNumber('iridescence'),
  iridescenceIor: layerNumber('iridescenceIor'),
  iridescenceThickness: layerNumber('iridescenceThickness'),
  toon: layerNumber('toon'),
  toonEdge: layerNumber('toonEdge'),
  softEdge: layerNumber('softEdge'),
  toonColors: z.array(z.array(z.number().min(0).max(TOON_COLOR_MAXIMUM)).length(3)).min(1).max(8).optional().describe('One linear [r,g,b] per toon step, darkest first; the count must equal toon.'),
};


const waterFields = {
  waterPreset: z.enum(['lake', 'sea', 'river']).optional().describe('Water tag.'),
  absorption: z.array(z.number().min(0).max(20)).length(3).optional().describe('Water tag: RGB per metre.'),
  turbidity: unit.optional().describe('Water tag: 0 clear to 1 murky.'),
  foamVeins: z.strictObject({
    amount: unit.optional().describe('0 off to 1, 0.6 default.'),
    scale: z.number().min(0.25).max(4).optional().describe('Larger is finer veins, 1 default.'),
  }).optional().describe('Water tag: foam veins spreading from the crests.'),
  foamEdge: z.enum(['soft', 'hard']).optional().describe('Water tag: soft lace (default) or a hard painted edge.'),
  foamWidth: z.number().min(0.25).max(4).optional().describe('Water tag: foam spread, 1 default.'),
  foamColor: z.array(unit).length(3).optional().describe('Water tag: foam RGB, white default.'),
  contactFoam: z.strictObject({
    width: z.number().min(1).max(64).optional().describe('Line width in screen pixels, 6 default.'),
    hardness: unit.optional().describe('0 soft edge to 1 one pixel edge, 1 default.'),
    noise: unit.optional().describe('How much the edge breaks up, 0.3 default.'),
    drift: unit.optional().describe('0 static rim (default); above 0 the rim tears into segments that slide with time.'),
    rim: z.boolean().optional().describe('false draws no contact line (default true).'),
    color: z.array(z.number().min(0).max(1)).length(3).optional().describe('RGB, white default.'),
  }).optional().describe('Water tag with alphaMode blend: foam line where the water meets other surfaces.'),
  caustics: z.record(z.string(), z.unknown()).nullable().optional().describe('Water tag: sun caustics on the bed, {scale, speed, intensity, depthFade}; scene_capabilities water.'),
  waterRamp: z.record(z.string(), z.unknown()).optional().describe('Water tag: flat colour ramp, see scene_capabilities water.'),
  ripples: z.strictObject({
    strength: unit.optional().describe('0 calm to 1 (default).'),
    speed: z.number().min(0).max(2).optional().describe('1 default; 0 holds them still.'),
    windDirection: z.number().min(-360).max(360).optional().describe('Degrees the small ripples run along.'),
  }).optional().describe('Water tag: the small ripples; lower strength or speed to stop shimmer.'),
};
const subsurfaceTriple = ([minimum, maximum]) => z.tuple([0, 1, 2].map(() => z.number().min(minimum).max(maximum)));
const subsurface = z.strictObject({
  weight: z.number().min(SUBSURFACE_RANGES.weight[0]).max(SUBSURFACE_RANGES.weight[1]).optional(),
  radius: subsurfaceTriple(SUBSURFACE_RANGES.radius).optional().describe('RGB mean free path in scale units.'),
  scale: z.number().min(SUBSURFACE_RANGES.scale[0]).max(SUBSURFACE_RANGES.scale[1]).optional().describe('Metres per radius unit.'),
  color: subsurfaceTriple(SUBSURFACE_RANGES.color).optional(),
}).describe('Subsurface scattering (skin, wax, leaves) as Blender Principled BSDF; details in scene_capabilities materialSubsurface.');

const catalogImageId = z.string().regex(/^[a-f0-9]{64}$/i).describe('Catalog image asset ID from scene_asset_catalog.');

const uvScaleNumber = z.number().min(UV_TRANSFORM_LIMITS.scale[0]).max(UV_TRANSFORM_LIMITS.scale[1]);
const worldScaleNumber = z.number().min(UV_TRANSFORM_LIMITS.worldScale[0]).max(UV_TRANSFORM_LIMITS.worldScale[1]);
const uvOffsetNumber = z.number().min(UV_TRANSFORM_LIMITS.offset[0]).max(UV_TRANSFORM_LIMITS.offset[1]);
const materialFields = {
  ...waterFields,
  ...materialLayerFields,
  subsurface: listed('subsurface', subsurface, 'Subsurface scattering (skin, wax, leaves): weight, radius [r,g,b], scale, color [r,g,b]; ranges in scene_capabilities materialSubsurface.').optional(),
  snippet: z.record(z.string(), z.unknown()).nullable().optional().describe('GLSL fragment hook; scene_capabilities materialSnippet.'),
  wear: z.record(z.string(), z.unknown()).nullable().optional().describe('Metal showing through paint and dirt, from vertex groups; scene_capabilities materialWear.'),
  surfaceCover: z.record(z.string(), z.unknown()).nullable().optional().describe('Layer (snow, dust) over a surface that faces up or sits high, masked per pixel so the edge stays sharp on huge meshes; scene_capabilities materialSurfaceCover.'),
  text: z.record(z.string(), z.unknown()).optional().describe('Text drawn as the colour map; scene_capabilities textPanel.'),
  retro: z.record(z.string(), z.unknown()).nullable().optional().describe('PS1 look, raster only: vertexSnap [w, h] and affineUV; scene_capabilities materialRetro.'),
  waterGlint: z.record(z.string(), z.unknown()).nullable().optional().describe('Water tag only, raster only: stylized highlights, edge { threshold } and sparkle { density, size, shape dot or star }; scene_capabilities materialWaterGlint.'),
  pattern: listed('pattern', materialPattern, 'Procedural texture; box mapping needs no UVs. type is a preset or graph (give graph); also mapping, colors, size, count, bump, seed, axis, resolution; see scene_capabilities pattern.', coreOf(materialPattern.shape, ['type'])).optional(),
  map: z.strictObject({ sequence: z.strictObject({
    frames: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(2).max(TEXTURE_SEQUENCE_LIMITS.maxFrames),
    fps: z.number().positive().max(60),
    loop: z.boolean().optional(),
  }) }).optional().describe('Image sequence colour map of catalog images; scene_capabilities textureSequence.'),
  textureSet: z.string().max(256).optional().describe('Name of a catalog texture set (scene_asset_catalog textureSets): fills colorMap, normalMap, roughnessMap, metallicMap, occlusionMap and heightMap; scene_capabilities textureSet.'),
  ...Object.fromEntries(TEXTURE_MAP_FIELDS.map(field => [field, catalogImageId.optional()])),
  normalConvention: z.enum(NORMAL_CONVENTIONS).optional().describe('opengl (default) or directx normal map; directx has its green channel flipped on load.'),
  heightScale: z.number().min(HEIGHT_PARALLAX_LIMITS.scale[0]).max(HEIGHT_PARALLAX_LIMITS.scale[1]).optional().describe('Metres a heightMap sinks below the surface; above 0 draws it as parallax relief (raster only); scene_capabilities textureSet.'),
  heightFade: z.number().min(HEIGHT_PARALLAX_LIMITS.fade[0]).max(HEIGHT_PARALLAX_LIMITS.fade[1]).optional().describe('Metres from the eye where the relief has faded to plain normal mapping.'),
  heightSteps: z.number().int().min(HEIGHT_PARALLAX_LIMITS.steps[0]).max(HEIGHT_PARALLAX_LIMITS.steps[1]).optional().describe('Ray steps of the relief.'),
  uvScale: z.union([uvScaleNumber, z.tuple([uvScaleNumber, uvScaleNumber])]).optional().describe('Tiles of every catalog map: one number or [u, v]; with the other UV fields it follows glTF KHR_texture_transform.'),
  uvOffset: z.tuple([uvOffsetNumber, uvOffsetNumber]).optional().describe('[u, v] shift of every catalog map, in tiles.'),
  uvRotation: z.number().min(UV_TRANSFORM_LIMITS.rotation[0]).max(UV_TRANSFORM_LIMITS.rotation[1]).optional().describe('Degrees every catalog map turns.'),
  worldScale: z.union([worldScaleNumber, z.tuple([worldScaleNumber, worldScaleNumber])]).optional().describe('Metres one tile covers, number or [u, v]; not with uvScale.'),
  color: color.optional().describe('Linear RGB base color, each component between zero and one.'),
  metallic: unit.optional(),
  roughness: unit.optional(),
  emission: nonnegative.optional().describe('Emission multiplier. Backend checks Float32 radiance products.'),
  emissiveColor: z.tuple([nonnegative, nonnegative, nonnegative]).optional().describe('Independent linear RGB emission color.'),
  opacity: unit.optional().describe('Surface opacity. Any value below one draws the material blended (glass, windows, visors).'),
  alphaMode: z.enum(RECIPE_ALPHA_MODES).optional().describe('mask cuts out where the map alpha is under alphaCutoff (hard edge, crisp shadow); blend draws after opaque geometry, sorted back to front; add adds its light to what is behind it.'),
  alphaCutoff: unit.optional().describe('With alphaMode mask only: alpha below this is cut out (0.5 default).'),
  doubleSided: z.boolean().optional().describe('Draw and light both faces (thin sheets, leaves, cloth).'),
  depthTest: z.boolean().optional().describe('Test against the depth buffer (true default); false draws blend or add materials through opaque geometry.'),
  aov: z.union([unit, color]).optional(),
};
const materialTag = z.enum(['surface', 'unlit', 'liquid', 'foam', 'foliage', 'grass', 'water']).optional().describe('Surface kind; liquid, foam, foliage, grass and water change how it renders: see scene_capabilities materialTags and water.');
const materialCore = coreOf(materialFields, ['color', 'metallic', 'roughness', 'emission', 'opacity']);
const materialMore = 'More fields: tag, alphaMode, alphaCutoff, doubleSided, depthTest, emissiveColor, map, pattern, subsurface, snippet, wear, surfaceCover, retro, waterPreset, absorption, turbidity, caustics, foamEdge, foamWidth, foamVeins, contactFoam, waterRamp and the layers clearcoat, clearcoatRoughness, transmission, thickness, ior, dispersion, attenuationColor, attenuationDistance, sheenColor, sheenRoughness, specular, specularColor, anisotropy, anisotropyRotation, iridescence, iridescenceIor, iridescenceThickness, toon, toonColors, toonEdge; see scene_capabilities materialFields.';
const materialListed = (strictSchema, description, extraCore) => listed('materialFields', strictSchema, `${description} ${materialMore}`, { ...extraCore, ...materialCore });
const liquidOptics = z.strictObject({
  thickness: z.number().min(0).max(100).optional().describe('Metres of liquid where it faces the camera.'),
  ior: z.number().min(1).max(3).optional(),
  refraction: z.number().min(0).max(4).optional(),
  scattering: z.number().min(0).max(10).optional(),
  foamOpacity: unit.optional(),
  foamSoftness: unit.optional(),
});
const cameraFields = {
  eye: vector3.optional(),
  target: vector3.optional(),
  up: vector3.optional(),
  fov: finite.gt(0).lt(180).optional().describe('Vertical perspective field of view in degrees. Not with focalLength.'),
  near: positive.optional(),
  far: positive.optional(),
  projection: z.enum(['perspective', 'orthographic']).optional(),
  orthoScale: positive.optional(),
  focalLength: positive.max(10000).optional().describe('Lens in mm, instead of fov.'),
  sensorWidth: positive.max(1000).optional(),
  shift: z.tuple([z.number().min(-1).max(1), z.number().min(-1).max(1)]).optional(),
  fStop: z.number().min(0.7).max(64).optional(),
  focusDistance: positive.optional(),
};
const bounded = (minimum, maximum) => z.number().min(minimum).max(maximum);
const spotAngleMessage = issue => `expected ${spotAngleExpectation(issue.input)} (got ${issue.input})`;
const spotAngle = z.number().min(MINIMUM_SPOT_ANGLE, { error: spotAngleMessage }).max(MAXIMUM_SPOT_ANGLE, { error: spotAngleMessage });
const boundedVector = (minimum, maximum) => z.tuple([bounded(minimum, maximum), bounded(minimum, maximum), bounded(minimum, maximum)]);
const volumeFog = z.strictObject({
  density: bounded(0, 10).optional(),
  minimum: boundedVector(-1e5, 1e5).optional(),
  maximum: boundedVector(-1e5, 1e5).optional(),
  color: color.optional(),
  ambient: boundedVector(0, 10).optional(),
  drift: boundedVector(-100, 100).optional(),
  steps: z.number().int().min(8).max(48).optional(),
  anisotropy: bounded(-0.9, 0.9).optional(),
  noiseAmount: unit.optional(),
  noiseScale: bounded(0.001, 100).optional(),
  maxDistance: bounded(0.01, 1e4).optional(),
  shadowAmbient: unit.optional(),
  detailOctaves: z.number().int().min(1).max(3).optional(),
  detailAmount: unit.optional(),
  warp: bounded(0, 4).optional(),
  contrast: bounded(0, 4).optional(),
  profileSoftness: bounded(0, 0.95).optional(),
  keyScattering: bounded(0, 10).optional(),
  heightFalloff: finite.optional(),
  scatterOctaves: finite.optional(),
  multiScatter: finite.optional(),
  multiExtinction: finite.optional(),
  multiAnisotropy: finite.optional(),
  keyTransmittance: finite.optional(),
  surfaceTransmittance: finite.optional(),
});
const affects = z.array(z.string()).optional();
const iesProfile = z.any().optional();
const lines = z.record(z.string(), z.unknown()).describe('Outlines, toon light and polylines as plain JSON; fields and limits in scene_capabilities lineArt. null clears.');
// An invalid name says which names work. The union alone reports only its 64-hex branch (issue 2049).
function catalogReference(names, fileKind) {
  const error = issue => `Invalid value: expected a built-in name (${names.join(', ')}), or a 64-character ${fileKind} ID from scene_asset_catalog (got ${describeReceived(issue.input)})`;
  return z.union([z.enum(names, { error }), z.string().regex(CATALOG_FILE_ID, { error })], { error });
}

const environment = z.strictObject({
  world: z.boolean().optional().describe('Draw the sky and apply surface fog.'),
  ground: z.boolean().optional().describe('false: no automatic floor.'),
  setup: z.enum(LIGHTING_SETUP_NAMES).optional().describe('Named lighting; resets key, fill and ambient fields. Default daylight.'),
  environmentIntensity: bounded(0, 100).optional().describe('Scales the setup environment light and its reflections.'),
  hdri: catalogReference(BUNDLED_ENVIRONMENT_NAMES, '.hdr').nullable().optional().describe('HDRI instead of the setup sky; scene_capabilities catalogLooks.'),
  keyFromHdri: z.boolean().optional().describe('With an hdri: the key light takes the HDRI sun direction, colour and strength, and the sun leaves the map.'),
  environmentRotation: bounded(-100, 100).optional().describe('Turns the setup environment around the vertical axis, in radians.'),
  lightDirection: boundedVector(-1e6, 1e6).optional().describe('Direction toward the key light; shadows follow.'),
  keyColor: boundedVector(0, 1000).optional(),
  keyIntensity: bounded(0, 100).optional(),
  fillIntensity: bounded(0, 100).optional(),
  ambientIntensity: bounded(0, 100).optional().describe('Scales the sky ambient and, with an hdri or setup environment map, that map\'s diffuse light and reflections too. 0 blacks the map out; for an HDRI-only scene keep it above 0 and set key and fill to 0.'),
  skybox: z.record(z.string(), z.string()).nullable().optional(),
  ambientColor: z.union([boundedVector(0, 10), z.strictObject({ sky: boundedVector(0, 10), ground: boundedVector(0, 10) })]).optional().describe('Flat ambient [r,g,b] or { sky, ground }. With ambientMix above 0 it replaces that share of the HDRI diffuse light.'),
  ambientMix: bounded(0, 1).optional().describe('0 keeps the HDRI diffuse light, 1 lights with ambientColor alone. Needs ambientColor.'),
  fillColor: z.union([boundedVector(0, 100), z.tuple([boundedVector(0, 100), boundedVector(0, 100)])]).optional().describe('Colour of both fill lights, or one per light. Default [0.8,2,1.8] and [0.6,0.7,0.8].'),
  environmentDiffuseScale: bounded(0, 100).optional(),
  daylight: bounded(0, 100).optional(),
  keyAffects: affects.describe('Node IDs lit; default all.'),
  shadowCascades: z.number().int().min(0).max(4).optional().describe('Sun shadow slices; 0 one map.'),
  sunAngularRadius: z.number().optional(),
  pointLights: z.array(z.strictObject({
    position: boundedVector(-1e6, 1e6).optional(),
    parent: z.string().min(1).max(256).optional().describe('Node ID or glTF part name the light follows; position and direction are then in its space.'),
    color: color.optional(),
    intensity: bounded(0, 1e5).optional(),
    radius: bounded(0.001, 1e6).optional(),
    range: z.union([z.literal(0), bounded(0.001, 1e6)]).optional(),
    castShadow: z.boolean().optional().describe('Casts a shadow; 6 atlas tiles.'),
    affects,
  })).max(MAX_POINT_LIGHTS).optional().describe('Replaces the list; [] clears. Intensity in candela.'),
  spotLights: z.array(z.strictObject({
    position: boundedVector(-1e6, 1e6).optional(),
    parent: z.string().min(1).max(256).optional().describe('Node ID or glTF part name the light follows; position and direction are then in its space.'),
    direction: boundedVector(-1e6, 1e6).describe('Nonzero direction the cone points along.'),
    angle: spotAngle.optional().describe('Outer half angle in radians (not degrees), 0.01 to just under pi/2; default pi/4.'),
    penumbra: unit.optional().describe('Soft edge, 0 hard; default 0.15.'),
    color: color.optional(),
    intensity: bounded(0, 1e5).optional().describe('Candela.'),
    radius: bounded(0.001, 1e6).optional(),
    range: z.union([z.literal(0), bounded(0.001, 1e6)]).optional(),
    castShadow: z.boolean().optional().describe('Casts a shadow; 1 atlas tile.'),
    ies: iesProfile,
    affects,
  })).max(MAX_SPOT_LIGHTS).optional().describe('Replaces the list; [] clears.'),
  areaLights: z.array(z.strictObject({
    position: boundedVector(-1e6, 1e6).optional().describe('Center of the rectangle.'),
    direction: boundedVector(-1e6, 1e6).optional().describe('Direction the rectangle faces; emits that side only.'),
    parent: z.string().min(1).max(256).optional().describe('Node ID or glTF part name the light follows; position and direction are then in its space.'),
    face: z.enum(['+x', '-x', '+y', '-y', '+z', '-z']).optional().describe('With parent: the face of that part that shines, sized to it; no position, direction, up, width or height.'),
    faceOffset: bounded(0, 100).optional(),
    up: boundedVector(-1e6, 1e6).optional().describe('Height axis direction; default world up.'),
    width: bounded(0.001, 1e4).optional(),
    height: bounded(0.001, 1e4).optional(),
    color: color.optional(),
    intensity: bounded(0, 1e5).optional().describe('Candela head on.'),
    castShadow: z.boolean().optional(),
    ies: iesProfile,
    portal: z.boolean().optional().describe('Window: emits nothing, Cook samples the sky through it; raster ignores it.'),
    affects,
  })).max(MAX_AREA_LIGHTS).optional().describe('Replaces the list; [] clears.'),
  skyTop: color.optional(),
  skyBottom: color.optional(),
  fogColor: color.optional(),
  fogDensity: bounded(0, 10).nullable().optional().describe('Null (what scene_export_recipe writes) leaves the fog density to the setup.'),
  volumeFog: volumeFog.optional().describe('Light-shaft fog; needs HDR.'),
  localVolumes: z.array(z.record(z.string(), z.unknown())).max(8).optional().describe('Up to 8 absorbing and emitting volumes; fields in scene_capabilities localVolumes.'),
  liquid: liquidOptics.optional().describe('Optics for materials tagged liquid or foam.'),
  lines: lines.nullable().optional(),
  objectReflections: z.boolean().optional().describe("false turns off reflection probes on smooth metal parts."),
  floorSkyTrace: z.boolean().optional().describe('false turns off the sky traced into floors of sun-lit closed rooms.'),
  sunBounce: z.number().min(0).optional().describe('Sun bounce in a closed room: 0 off, 1 default.'),
  specularAntiAliasing: z.number().min(0).max(4).optional().describe('Specular anti-aliasing: 0 off, 1 default; widens highlights that sparkle on grainy normal-mapped metal.'),
  wetness: z.number().min(0).max(1).nullable().optional().describe('Wet ground: 0 dry, 0.5 damp, 1 soaked; darkens porous surfaces and lowers roughness, metals untouched. null clears.'),
  puddles: z.strictObject({ coverage: bounded(0, 1).optional(), from: z.literal('height').optional() }).nullable().optional().describe('Puddles on wet ground: coverage 0 to 1 (scaled by wetness), from "height" (low spots). Flat water that mirrors the sky.'),
  resolveCoplanar: z.union([z.literal('offset'), z.literal(false)]).optional().describe("Flush faces are ranked at draw time by default ('offset'); false opts out."),
  viewTransform: z.enum(VIEW_TRANSFORM_NAMES).optional().describe('Display transform, agx or standard to compare with Blender.'),
  look: catalogReference([...LOOK_NAMES, ...BUNDLED_CUBE_LOOK_NAMES], '.cube').nullable().optional().describe('Look preset or .cube; scene_capabilities catalogLooks. null clears.'),
  sky: z.record(z.string(), z.unknown()).nullable().optional().describe('Physical sky: {type:"physical", sunElevation, sunRotation, turbidity, groundAlbedo, aerialPerspective}; sets key light, sky and fog. Or {type:"gradient", stops:[{at,color}], horizonGlow:{color,width,intensity}}. Fields in scene_capabilities physicalSky, gradientSky.'),
  wind: z.strictObject({ strength: bounded(0, 4).optional(), direction: bounded(-360, 360).optional().describe('Degrees: 0 toward +x, 90 toward +z.') }).optional().describe('Sway of foliage and grass materials; strength defaults to 0.3.'),
});
// Every tool lists the same short environment; the full schema is served by scene_capabilities topic environment.
const environmentListed = listed('environment', environment, 'Lighting and sky. More fields: sky (physicalSky), hdri, look, viewTransform, keyColor, keyIntensity, fillIntensity, ambientIntensity, ambientColor, ambientMix, fillColor, environmentDiffuseScale, daylight, keyAffects, shadowCascades, pointLights, spotLights, areaLights, skyTop, skyBottom, fogColor, fogDensity, volumeFog (density, scatterOctaves, multiScatter, keyTransmittance, surfaceTransmittance and more: scene_capabilities environment), liquid, lines, wind, objectReflections, floorSkyTrace, sunBounce, specularAntiAliasing, wetness, puddles, resolveCoplanar; see scene_capabilities environment.', coreOf(environment.shape, ['setup', 'world', 'ground', 'lightDirection', 'environmentIntensity']));
// Named post steps are checked by the engine and listed in docs/agent-look.md; every tool that takes a recipe repeats this schema.
const looseField = z.unknown().optional();
const effects = z.strictObject({
  exposure: bounded(0.01, 16).optional(),
  saturation: bounded(0, 2).optional(),
  contrast: bounded(0.1, 2).optional(),
  temperature: bounded(-1, 1).optional(),
  vignette: unit.optional(),
  grain: bounded(0, 0.1).optional(),
  ambientOcclusion: unit.optional().describe('Screen-space contact darkening, 0 off to 1 full. Default 0 (off) when unset; above 0 turns the pass on.'),
  ambientOcclusionRadius: bounded(0.01, 100).optional().describe('World-space reach of the occlusion; default 0.5.'),
  bloom: z.strictObject({
    strength: bounded(0, 8).optional(),
    threshold: bounded(0, 10).optional(),
    keepHue: z.boolean().optional().describe('Bloom keeps the hue of emissive parts: a coloured glow stays that colour instead of clipping to white. Default false.'),
    radius: bounded(0.1, 16).optional(),
  }).optional(),
  depthOfField: z.strictObject({ blur: unit.optional(), focusDistance: bounded(0.01, 100000).optional() }).optional().describe('Lens blur: blur 0 to 1, focusDistance metres.'),
  motionBlur: z.strictObject({ shutter: bounded(0, 0.5).optional(), objects: bounded(0, 1).optional() }).optional().describe('Motion smear, shutter in seconds. objects 0 to 1 also smears each moving part along its own motion (off at 0).'),
  colorBalance: looseField,
  colorCorrection: looseField,
  sunRays: looseField,
  flash: looseField,
  distortion: looseField,
  glare: looseField,
  lensDistortion: looseField,
  stylize: looseField,
  composite: looseField,
  localToneMapping: looseField,
  colorCorrection: looseField,
  autoExposure: looseField,
});
const effectsListed = listed('effects', effects, 'Post effects: exposure, saturation, contrast, temperature, vignette, grain, ambientOcclusion, ambientOcclusionRadius, bloom {strength, threshold, radius}, depthOfField {blur, focusDistance}, motionBlur {shutter}, colorBalance, colorCorrection {brightness, contrast, saturation, tint}, sunRays {intensity, spread}, glare, lensDistortion, stylize, composite, localToneMapping, autoExposure {metering, key, minimum, maximum, speed}; see scene_capabilities effects.', coreOf(effects.shape, ['exposure']));
const shadow = z.strictObject({
  target: boundedVector(-1e6, 1e6).optional(),
  extent: bounded(0.01, 1e5).optional(),
  distance: bounded(0.01, 1e6).optional(),
  near: bounded(0.001, 1e6).optional(),
  far: bounded(0.001, 1e6).optional(),
  hard: z.boolean().optional(),
}).describe('Directional shadow coverage. Backend checks Float32 view/projection consistency.');
// Curve and text sit in the geometry list only, not in mesh bases or cutters. Value types and limits are checked by the
// engine and listed in scene_capabilities curveText, because every tool that takes a recipe repeats this schema.
function curveAndTextGeometries(id) {
  return [
    z.strictObject({ ...id, type: z.literal('curve'), points: z.array(z.unknown()).max(1024).optional(), shape: looseField, splines: z.array(z.unknown()).max(64).optional(), kind: looseField, weights: z.array(z.unknown()).max(1024).optional(), trim: looseField, grow: looseField, closed: looseField, radius: looseField, taper: looseField, profile: looseField, resolution: looseField, radialSegments: looseField })
      .refine(curve => curve.points !== undefined || curve.shape !== undefined || curve.splines !== undefined, { message: 'A curve needs one of points (an array of [x, y, z]), shape ({ type: "arc" | "spiral" | "star" }) or splines (an array of up to 64 splines). See scene_capabilities curveText.' })
      .describe('Sweep along points, a shape or splines; see scene_capabilities curveText.'),
    z.strictObject({ ...id, type: z.literal('sdf'), root: z.record(z.string(), z.unknown()), resolution: looseField }).describe('Signed-distance shapes with smooth union; see scene_capabilities curveText.'),
    z.strictObject({ ...id, type: z.literal('text'), text: z.string().max(256), size: looseField, depth: looseField, font: looseField, align: looseField, curveSegments: looseField }).describe('3D text; see scene_capabilities curveText.'),
    z.strictObject({ ...id, type: z.literal('cloud'), seed: looseField, puffs: looseField, width: looseField, height: looseField, flatBase: looseField, resolution: looseField, levels: z.array(z.unknown()).max(4).optional(), upBias: looseField, unionSoftness: looseField }).describe('Seeded cumulus of round puffs; see scene_capabilities cloud.'),
    z.strictObject({ ...id, type: z.literal('terrain'), size: looseField, resolution: looseField, seed: looseField, amplitude: looseField, featureSize: looseField, octaves: looseField, warp: looseField, ridged: looseField, mountainAmplitude: looseField, mountainMask: looseField, chunks: looseField, levels: looseField, paths: z.array(z.unknown()).max(16).optional(), holes: z.array(z.unknown()).max(16).optional() }).describe('Hills with round holes; see scene_capabilities terrain.'),
    z.strictObject({ ...id, type: z.literal('floorPlan'), walls: z.array(z.unknown()).max(256), openings: z.array(z.unknown()).max(256).optional(), height: looseField, thickness: looseField, part: looseField }).describe('Walls, openings, floor, ceiling and door and window presets from a plan; see scene_capabilities floorPlan.'),
  ];
}
function primitiveGeometries(identified) {
  const id = identified ? { id: identifier } : {};
  return [
    z.strictObject({ ...id, type: z.literal('box'), bevel: finite.optional().describe('Unit cube, -0.5 to 0.5. The default bevel of 0.08 rounds its edges and is scaled with the node; set 0 for exact sizes and crisp edges.'), subdivisions: detail(1, 128) }),
    z.strictObject({ ...id, type: z.literal('cylinder'), segments, bevel: finite.optional().describe('The default bevel of 0.025 rounds its rims; set 0 for exact sizes and crisp edges.'), bevelSegments: detail(1, 128) }).describe('Radius 1, height 1: node scale x and z are the radius, not the diameter. With 6 segments the flats sit on Z, 1.732 x scale apart, and the corners on X, 2 x scale apart.'),
    z.strictObject({ ...id, type: z.literal('sphere'), segments, rings: detail(2, 2048) }).describe('Radius 1: node scale is the radius.'),
    z.strictObject({ ...id, type: z.literal('torus'), tubeRadius: finite.optional(), segments, sides: detail(3, 128), arc: finite.optional(), start: finite.optional() }),
    z.strictObject({ ...id, type: z.literal('lathe'), profile: z.array(point2).min(2).max(4096), segments, startAngle: finite.optional(), sweep: finite.optional() }),
    z.strictObject({ ...id, type: z.literal('extrude'), contour: ring, holes: z.array(ring).max(128).optional(), depth: finite.optional(), steps: detail(1, 256), bevel: finite.optional(), bevelThickness: finite.optional(), bevelSegments: detail(1, 32) }),
    z.strictObject({ ...id, type: z.literal('tube'), path: z.array(vector3).min(2).max(4096), radius: finite.optional(), segments, radialSegments: detail(3, 128), closed: z.boolean().optional() }),
    ...(identified ? curveAndTextGeometries(id) : []),
  ];
}
const selectRule = z.record(z.string(), z.unknown()).describe('Face rule: {"all":true}, {"tag":"top"}, {"normal":[0,1,0],"maxAngle":10}, {"inside":{"min":[x,y,z],"max":[x,y,z]}} (centroids), {"faces":[i]}, {"and"|"or":[rules]}, {"not":rule}, {"grow":rule,"steps":1}, {"boundary":rule}, {"field":expr}. Tags: top, bottom, side, left, right, front, back, <name>.cap|side|rim.');
const editName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/).optional().describe('Tag prefix. Defaults to <op>-<index>.');
const edgeRule = z.record(z.string(), z.unknown()).describe('Edge rule: {"all":true}, {"angle":30}, {"along":[x,y,z]}, {"between":[faceRule,faceRule]}, {"boundaryOf":faceRule} or {"open":true} for boundary edges (also {"open":{"inside":{"min":[x,y,z],"max":[x,y,z]}}}).');
const shortSelect = z.record(z.string(), z.unknown()).describe('Face rule, as in set_position.');
const shortField = z.union([finite, z.record(z.string(), z.unknown())]);
const vertexRule = z.record(z.string(), z.unknown()).describe('Vertex rule: {"all":true}, {"vertices":[indices]}, {"valence":2} or {"inside":{"min":[x,y,z],"max":[x,y,z]}}.');
const meshEdit = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('extrude_face_region'), select: selectRule.optional(), name: editName, offset: finite.describe('Distance along each connected region\'s average normal (negative pushes in).'), direction: vector3.optional().describe('Move along this direction instead of the normal.'), alongNormals: z.boolean().optional().describe('Move each vertex along its own normal instead, keeping the region joined: use for rings and curved bands.') }),
  z.strictObject({ op: z.literal('extrude_individual'), select: selectRule.optional(), name: editName, offset: finite.describe('Distance along each face\'s own normal.'), direction: vector3.optional() }),
  z.strictObject({ op: z.literal('inset_region'), select: selectRule.optional(), name: editName, thickness: finite.describe('Rim width, positive.'), depth: finite.optional().describe('Move the inner faces along the normal afterwards.') }),
  z.strictObject({ op: z.literal('inset_individual'), select: selectRule.optional(), name: editName, thickness: finite, depth: finite.optional() }),
  z.strictObject({ op: z.literal('delete'), select: selectRule }),
  z.strictObject({ op: z.literal('flip_normals'), select: selectRule.optional() }),
  z.strictObject({ op: z.literal('translate'), select: selectRule.optional(), offset: vector3, falloff: z.strictObject({ radius: finite, curve: z.enum(['smooth', 'sphere', 'root', 'sharp', 'linear', 'constant', 'inverseSquare']).optional(), connected: z.boolean().optional().describe('Measure distance along edges instead of straight lines.') }).optional() }),
  z.strictObject({ op: z.literal('transform_selection'), select: selectRule.optional(), pivot: vector3.optional().describe('Point to turn and scale about. Defaults to the mean of the selected vertices.'), rotation: z.strictObject({ axis: vector3, angle: bounded(-6.283185307179586, 6.283185307179586).describe('Radians, not degrees: 90 degrees is 1.5708.') }).optional(), scale: z.union([bounded(0.000001, 1000), z.array(bounded(0.000001, 1000)).length(3)]).optional().describe('Factor above 0, or one per axis; applied before the rotation.'), falloff: z.strictObject({ radius: finite, curve: z.enum(['smooth', 'sphere', 'root', 'sharp', 'linear', 'constant', 'inverseSquare']).optional(), connected: z.boolean().optional().describe('Measure distance along edges instead of straight lines.') }).optional() }).describe('Rotate and/or scale the selected vertices about a pivot; falloff fades the move to nothing at its radius.'),
  z.strictObject({ op: z.literal('merge_by_distance'), distance: finite.optional() }),
  z.strictObject({
    op: z.literal('loop_cut'), name: editName,
    edges: z.record(z.string(), z.unknown()).describe('Edge rule that picks the ring to cut across, usually {"along":[x,y,z]} for edges parallel to a direction: {"along":[0,1,0]} cuts around a box horizontally. Also between, angle, boundaryOf or all.'),
    cuts: z.number().int().min(1).max(16).optional().describe('New loops per ring, evenly spaced. Defaults to 1.'),
    factor: bounded(0, 1).optional().describe('Single cut only: position from the low side of each ring edge. Defaults to 0.5.'),
  }).describe('Loop cut across quads. Bands between cuts get <name>.band-0 (low side) to <name>.band-<cuts>.'),
  z.strictObject({ op: z.literal('fill_holes'), name: editName, sides: z.number().int().min(3).max(4096).optional().describe('Skip boundary loops with more edges than this.') }).describe('Cap each closed boundary loop with one polygon, tagged <name>.fill. Fixes the lint boundary-edge warning.'),
  z.strictObject({ op: z.literal('dissolve_faces'), name: editName, select: selectRule }).describe('Merge connected selected faces into one polygon each, tagged <name>.merged.'),
  z.strictObject({ op: z.literal('dissolve_edges'), name: editName, edges: edgeRule }).describe('Merge the two faces beside each selected edge, tagged <name>.merged.'),
  z.strictObject({ op: z.literal('dissolve_verts'), name: editName, verts: z.record(z.string(), z.unknown()).describe('Vertex rule: {"all":true}, {"vertices":[indices]}, {"valence":2} or {"inside":{"min":[x,y,z],"max":[x,y,z]}}.') }).describe('Remove vertices. Two-edge vertices leave their faces; others merge the faces around them.'),
  z.strictObject({ op: z.literal('dissolve_limited'), name: editName, edges: edgeRule.optional().describe('Defaults to all edges.'), angle: bounded(0, 180).optional().describe('Degrees of bend still counted as flat. Defaults to 5.') }).describe('Dissolve flat edges and the straight vertices left behind; undoes a loop cut.'),
  z.strictObject({
    op: z.literal('bisect_plane'), name: editName,
    point: vector3.describe('A point on the plane, in the mesh\'s local space.'), normal: vector3.describe('Plane normal. The inner side is behind it, the outer side in front.'),
    distance: bounded(0, 1000).optional().describe('Vertices this close to the plane count as on it. Defaults to 0.0001.'),
    clearInner: z.boolean().optional(), clearOuter: z.boolean().optional(),
    fill: z.boolean().optional().describe('Cap the cut, tagged <name>.cap. With both sides kept the halves become two closed shells.'),
  }).describe('Cut at a plane. Faces get <name>.inner or <name>.outer by side.'),
  z.strictObject({
    op: z.literal('bridge_edge_loops'), name: editName, edges: edgeRule.describe('Rule that selects exactly two boundary loops with the same edge count, usually {"open":true}.'),
    segments: z.number().int().min(1).max(64).optional().describe('Quads across the strip. Defaults to 1.'), twistOffset: z.number().int().min(-4096).max(4096).optional().describe('Rotate the second loop by this many vertices after the closest match.'),
  }).describe('Join two boundary loops with a strip of quads, tagged <name>.bridge.'),
  z.strictObject({ op: z.literal('subdivide_edges'), name: editName, edges: edgeRule, cuts: z.number().int().min(1).max(16).optional().describe('New points per edge. Defaults to 1.') }).describe('Split edges. Quads with opposite edges split become bands, with all four a grid; others keep an n-gon. New faces get <name>.split.'),
  z.strictObject({ op: z.literal('grid_fill'), name: editName, edges: edgeRule.describe('Rule that selects closed boundary loops of an even edge count, usually {"open":true}.') }).describe('Fill each closed boundary loop with a grid of quads, tagged <name>.fill.'),
  z.strictObject({
    op: z.literal('knife_project'), name: editName,
    path: z.array(vector3).min(2).max(256).describe('Polyline in the mesh\'s local space.'), direction: vector3.describe('Direction the line is projected along, for example [0,0,-1].'),
  }).describe('Cut along a polyline projected along a direction, through front and back faces. Split faces get <name>.cut.'),
  z.strictObject({ op: z.literal('poke'), select: selectRule.optional(), name: editName, offset: finite.optional().describe('Move each new centre along the face normal. Defaults to 0.'), relative: z.boolean().optional().describe('Scale offset by the face\'s average corner distance.') }).describe('Replace each selected face with a triangle fan around a centre vertex, tagged <name>.poke.'),
  z.strictObject({ op: z.literal('dual'), name: editName }).describe('Dual mesh: a vertex per face centre, a face per vertex, tagged <name>.dual. Needs a closed, consistently wound mesh.'),
  z.strictObject({ op: z.literal('tris_to_quads'), select: selectRule.optional(), name: editName, angle: bounded(0, 180).optional().describe('Largest angle in degrees between the two triangle normals. Defaults to 40.') }).describe('Join adjacent triangles into convex quads, best-shaped first, tagged <name>.merged.'),
  z.strictObject({ op: z.literal('symmetrize'), name: editName, axis: z.enum(['x', 'y', 'z']).optional(), keep: z.enum(['positive', 'negative']).optional().describe('Side of the plane kept and mirrored. Defaults to positive.'), distance: bounded(0, 1).optional().describe('Vertices this close to the plane count as on it. Defaults to 0.0001.') }).describe('Cut at the plane through the origin, drop the other half and mirror the kept half. Mirrored faces get <name>.mirrored.'),
  z.strictObject({ op: z.literal('scale_elements'), select: selectRule.optional(), scale: finite.describe('Factor above 0 about each connected group of selected faces.') }).describe('Scale connected groups of selected faces about their own centres.'),
  z.strictObject({ op: z.literal('extrude_edges'), name: editName, edges: edgeRule.describe('Edges to extrude, usually {"open":true} for a boundary.'), offset: vector3.describe('Where the copied vertices move.') }).describe('Extrude edges into quads, tagged <name>.side.'),
  z.strictObject({ op: z.literal('split_edges'), name: editName, edges: edgeRule.describe('Edges to open.') }).describe('Open the surface along these edges.'),
  z.strictObject({ op: z.literal('delete_loose') }).describe('Remove vertices no face uses.'),
  z.strictObject({ op: z.literal('flatten'), verts: vertexRule, normal: vector3.optional().describe('Plane normal.'), factor: unit.optional().describe('0 to 1, default 1.') }).describe('Move vertices onto a plane.'),
  z.strictObject({ op: z.literal('unsubdivide') }).describe('Reverse one Catmull-Clark level.'),
  z.strictObject({ op: z.literal('circularize'), verts: vertexRule, factor: unit.optional().describe('0 to 1, default 1.'), regular: z.boolean().optional().describe('Default true.') }).describe('Put each closed loop of vertices on a circle.'),
  z.strictObject({ op: z.literal('tag'), select: selectRule, name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/).describe('Tag to add to the selected faces.') }),
  z.strictObject({
    op: z.literal('boolean'), name: editName,
    operation: z.enum(['union', 'difference', 'intersect']),
    cutter: z.discriminatedUnion('type', primitiveGeometries(false)).describe('Closed cutting shape in the mesh\'s local space, before translation, rotation and scale. Faces it contributes get the tag <name>.cut.'),
    translation: vector3.optional(), rotation: quaternion.optional().describe('XYZW quaternion.'), scale: vector3.optional().describe('Positive per-axis scale.'),
  }).describe('Manifold boolean. Both the mesh and the cutter must be closed; mesh_inspect lists open edges.'),
  z.strictObject({
    op: z.literal('sculpt'), select: selectRule.optional(),
    strokes: z.array(z.strictObject({
      type: z.enum(['inflate', 'displace', 'smooth']), center: vector3, radius: finite, strength: finite, direction: vector3.optional(),
    })).min(1).max(32),
  }).describe('Brush strokes on the vertices of the selected faces, in order. Fields and units in scene_capabilities meshSculpt.'),
  z.strictObject({ op: z.literal('vertex_group'), name: z.string().max(48), select: shortSelect.optional(), weight: unit.optional(), field: shortField.optional(), gradient: z.record(z.string(), z.unknown()).optional() }).describe('Vertex group weights 0-1: weight, field or gradient. See meshAttributes.'),
  z.strictObject({ op: z.literal('vertex_color'), select: shortSelect.optional(), color: vector3.optional(), field: shortField.optional(), gradient: z.record(z.string(), z.unknown()).optional() }).describe('Vertex colors: color, vector field or gradient. See meshAttributes.'),
  z.strictObject({
    op: z.literal('shrinkwrap'), select: selectRule.optional(),
    target: z.record(z.string(), z.unknown()).describe('Primitive to wrap onto, a record like a boolean cutter ({"type":"sphere"}), placed by translation, rotation and scale.'),
    translation: vector3.optional(), rotation: quaternion.optional(), scale: vector3.optional(),
    mode: z.enum(['nearest', 'project']).optional(), direction: vector3.optional(), offset: finite.optional(), maxDistance: finite.optional(), onMiss: z.enum(['error', 'keep']).optional(),
  }).describe('Move the selected vertices onto the target surface, like Blender Shrinkwrap. Fields and defaults in scene_capabilities meshSculpt.'),
]);
const stackNodes = [
  z.strictObject({
    op: z.literal('set_position'), select: selectRule.optional(),
    position: fieldExpression.optional().describe('Vector expression for the new position of each selected vertex. Defaults to the current position.'),
    offset: fieldExpression.optional().describe('Vector expression added after position, for example {"vec":[0,{"noise":{"scale":3}},0]}. Give position, offset or both.'),
  }).describe('Blender Set Position with field expressions, evaluated on the input positions, for the vertices of the selected faces.'),
  z.strictObject({
    op: z.literal('displace'), select: selectRule.optional(),
    field: fieldExpression.describe('Number expression used as the texture.'),
    strength: finite.optional().describe('Defaults to 1.'), midlevel: finite.optional().describe('Field value that does not move. Defaults to 0.5, the middle of noise.'),
    direction: z.enum(['normal', 'x', 'y', 'z']).optional().describe('Defaults to normal.'),
    group: z.string().max(48).optional(),
  }).describe('Blender Displace with a field as the texture: each vertex moves by (field - midlevel) * strength.'),
  z.strictObject({ op: z.literal('mirror'), name: editName, axis: z.enum(['x', 'y', 'z']).optional().describe('Mirror across the plane through the local origin perpendicular to this axis. Defaults to x.'), merge: bounded(0, 1000).optional().describe('Vertices this close to the plane are shared by both halves. Defaults to 0.001. Faces lying in the plane are removed, so a closed half becomes a closed whole.') }),
  z.strictObject({ op: z.literal('array'), name: editName, count: z.number().int().min(1).max(256).optional(), offset: vector3.optional().describe('Constant step between copies.'), relativeOffset: vector3.optional().describe('Step in bounding-box sizes. Defaults to [1, 0, 0] unless offset is given.'), merge: bounded(0, 1000).optional().describe('Weld touching copies and remove the faces between them.') }),
  z.strictObject({ op: z.literal('solidify'), name: editName, thickness: finite.describe('Wall thickness, positive.'), offset: bounded(-1, 1).optional().describe('-1 grows inward (default), 1 outward, 0 centred.'), evenThickness: z.boolean().optional() }),
  z.strictObject({
    op: z.literal('bevel'), name: editName,
    edges: z.record(z.string(), z.unknown()).optional().describe('Edge rule: {"between":[faceRule,faceRule]} (for example top and side for a rim), {"angle":30} (edges bending at least this many degrees, the default), {"boundaryOf":faceRule}, or {"all":true}.'),
    width: finite.describe('Distance from the edge into each face, positive.'),
    segments: z.number().int().min(1).max(16).optional().describe('1 is a flat chamfer; 3 or more reads as round.'),
    profile: bounded(0, 1).optional().describe('0 flat, 0.5 round (default), 1 boxy.'),
    clampOverlap: z.boolean().optional().describe('Shrink width so neighbouring bevels cannot cross. Defaults to true; the result reports clamped.'),
  }),
  z.strictObject({
    op: z.literal('uv_unwrap'),
    seams: z.record(z.string(), z.unknown()).optional().describe('Edge rule for seams, the same rules as bevel. Defaults to {"angle":60}. Extra cuts are added where an island would not lie flat.'),
    margin: bounded(0, 0.2).optional().describe('Gap between islands and around the square, as a fraction of it. Defaults to 0.01.'),
    maxDistortion: bounded(0, 100).optional().describe('Islands stretching more than this (mean |area ratio - 1|) are split into charts by facing axis. Defaults to 0.25.'),
  }).describe('Conformal UV unwrap into the corner attribute uv, packed into 0..1. Put it last (or as the last stack node): later edits do not keep UVs exact. The result reports islands, flipped triangles and areaDistortion.'),
  z.strictObject({ op: z.literal('uv_project'), mode: z.enum(['cube', 'cylinder', 'sphere']), axis: z.enum(['x', 'y', 'z']).optional(), pack: z.boolean().optional(), margin: bounded(0, 0.2).optional(), rotate: z.boolean().optional() }).describe('Cube, cylinder or sphere uv projection, packed into 0..1. Detail: scene_capabilities meshUv.'),
  z.strictObject({ op: z.literal('uv_pack'), margin: bounded(0, 0.2).optional(), rotate: z.boolean().optional() }).describe('Pack the existing uv islands into 0..1 with one scale.'),
  z.strictObject({
    op: z.literal('subdivide'),
    levels: z.number().int().min(1).max(4).optional().describe('Catmull-Clark levels; each multiplies the faces by about 4 (n-gons become n quads). Defaults to 1.'),
    crease: z.record(z.string(), z.unknown()).optional().describe('Edge rule for creased edges, the same rules as bevel: {"angle":60} keeps the rims of a cylinder sharp. Boundary edges are always sharp.'),
    sharpness: bounded(0, 10).optional().describe('Crease strength, only with crease. A crease stays fully sharp for that many levels and a fraction blends smooth and sharp. Defaults to 10, sharp at every level.'),
  }).describe('Catmull-Clark subdivision with semi-sharp creases, like the Subdivision Surface modifier of Blender. Faces keep their tags and corner attributes such as uv blend linearly. Put it before uv_unwrap. Check the budget: 3 levels make 64 times the faces.'),
  z.strictObject({
    op: z.literal('decimate'),
    ratio: z.number().gt(0).max(1).describe('Share of the triangles to keep, counted after triangulation. 0.25 keeps a quarter.'),
  }).describe('Quadric edge collapse like Blender Decimate. Open boundaries and tag borders stay, tags carry over, uv and colour are dropped, so unwrap after it. Reports triangles and stoppedEarly.'),
  z.strictObject({
    op: z.literal('remesh'),
    voxelSize: z.number().positive().optional().describe('Edge of one grid cell. Give this or resolution.'),
    resolution: z.number().int().min(4).max(192).optional().describe('Cells along the longest side. Give this or voxelSize.'),
  }).describe('Voxel remesh like Blender Remesh: a closed quad surface of even cells. The mesh must be closed (fill_holes first); tags and attributes are dropped. Over 192 cells per side is refused.'),
];
// A whole-mesh modifier is a free record { op, ...fields }: its ops and fields live in scene_capabilities meshModifiers, so
// the schema does not grow with each modifier, and the backend validates every field.
const modifierRecord = z.record(z.string(), z.unknown()).describe(`Whole-mesh modifier { op, ...fields }, op one of: ${Object.keys(MODIFIER_OPERATIONS).join(', ')}.`);
const stackNodeUnion = z.union([z.discriminatedUnion('op', stackNodes), modifierRecord]);
const meshEditUnion = z.union([z.discriminatedUnion('op', [...meshEdit.options, ...stackNodes]), modifierRecord]);
const stackOperationNames = [...stackNodes.map(node => node.shape.op.value), ...Object.keys(MODIFIER_OPERATIONS)];
const editOperationNames = [...meshEdit.options.map(option => option.shape.op.value), ...stackOperationNames];
// The tool's op list must be the engine's list (MESH_EDIT_OPERATIONS, also what scene_capabilities meshEdits reports): an op the engine
// takes but this schema lacks, or the reverse, is refused here at load instead of by an agent mid-edit.
const engineOperationNames = Object.keys(MESH_EDIT_OPERATIONS);
const missingFromSchema = engineOperationNames.filter(name => !editOperationNames.includes(name));
const missingFromEngine = editOperationNames.filter(name => !engineOperationNames.includes(name));
if (missingFromSchema.length > 0 || missingFromEngine.length > 0) {
  throw new Error(`mesh_edit schema and MESH_EDIT_OPERATIONS differ: schema lacks [${missingFromSchema.join(', ')}], engine lacks [${missingFromEngine.join(', ')}]. Add the op to both.`);
}
const meshStack = z.array(listed('meshStack', stackNodeUnion, 'Stack node { op, ...fields }; fields per op: scene_capabilities meshStack.', { op: z.enum(stackOperationNames) })).max(16);
const meshEdits = z.array(listed('meshEdit', meshEditUnion, 'Edit { op, ...fields }, applied in order; fields per op: scene_capabilities meshEdit, or meshEdit.<op> for one op.', { op: z.enum(editOperationNames) })).max(64);
// The full edit and stack schemas live in mesh_edit and mesh_stack. Repeating them in every recipe cost about 45 KB
// per tool; the backend still validates each item and names the valid ops when one is wrong.
const recipeMeshEdits = z.array(z.record(z.string(), z.unknown())).max(64);
const recipeMeshStack = z.array(z.record(z.string(), z.unknown())).max(16);
const geometry = z.discriminatedUnion('type', [
  ...primitiveGeometries(true),
  z.strictObject({ id: identifier, type: z.enum(['grid', 'plane']), segments: detail(1, 64) }).describe('Unit sheet in XY facing +Z; plane = grid.'),
  z.strictObject({ id: identifier, type: z.literal('cone'), radiusTop: finite.optional(), radiusBottom: finite.optional(), segments }).describe('Along Y, height 1; radiusTop 0 is a point, radiusBottom 1.'),
  z.strictObject({ id: identifier, type: z.literal('icoSphere'), subdivisions: detail(0, 7) }),
  z.strictObject({ id: identifier, type: z.literal('circle'), segments, innerRadius: finite.optional() }).describe('Unit disc facing +Z; innerRadius makes a ring.'),
  z.strictObject({ id: identifier, type: z.literal('line'), from: vector3, to: vector3, radius: finite.optional(), radialSegments: detail(3, 128) }),
  z.strictObject({ id: identifier, type: z.literal('fragment'), source: identifier, index: z.number().int().min(0).max(63), cells: z.number().int().min(2).max(64), seed: detail(0, 4294967295), impact: vector3.optional(), impactRadius: positive.optional() }).describe('Piece of a fractured geometry; made by fracture-node.'),
  z.strictObject({ id: identifier, type: z.literal('dented'), source: identifier, impacts: z.array(z.strictObject({ point: vector3, direction: vector3, impulse: z.number().min(0).max(1e9) })).min(1).max(8), stiffness: z.number().min(1e-6).max(1e9).optional(), maxDepth: z.number().min(1e-6).max(2).optional(), radius: z.number().min(1e-6).max(100).optional() }).describe('Source pushed in at hits; see scene_capabilities vehicleDamage.'),
  z.strictObject({ id: identifier, type: z.literal('mesh'), base: z.discriminatedUnion('type', [...primitiveGeometries(false), z.strictObject({ type: z.enum(['grid', 'plane']), segments: detail(1, 64) })]).describe('Starting shape, converted to welded quads with axis face tags.'), edits: recipeMeshEdits.optional().describe('Replayable edit log, applied in order. Each item has the shape of one mesh_edit edit; read that tool for every op and field.'), stack: recipeMeshStack.optional().describe('Non-destructive modifier stack evaluated after the edits. Each item has the shape of one mesh_stack node; read that tool for the ops.'), smoothAngle: bounded(0, 180).optional().describe('Edges bending more than this many degrees render hard. Defaults to 30.'), shapeKeys: recipeMeshEdits.optional().describe('Named morph targets, at most 16: { name, offsets | edits, value }. See scene_capabilities meshShapeKeys.') }),
]);
// No description: this field repeats in every motion track schema. A wrong name fails with every valid form, and docs/agent-motion.md lists them.
const easingField = z.string().max(80).optional();
// Fields every motion track takes; the backend (src/animation-modifiers.js) checks the extrapolation rule and each modifier.
const trackEffectFields = {
  extrapolation: z.enum(['constant', 'linear']).optional().describe('Past the first and last keyframe: constant holds, linear continues the end slope (not for rotation). scene_capabilities motionModifiers.'),
  modifiers: z.array(z.record(z.string(), z.unknown())).max(8).optional().describe('Up to 8 [{type: cycles|stepped|noise|generator|limits|envelope, ...}]; scene_capabilities motionModifiers.'),
};
function motionTrack(kind, property, value, tangent) {
  return z.strictObject({
    kind: z.literal(kind),
    ...(kind === 'camera' ? {} : { id: identifier }),
    property: z.literal(property),
    interpolation: z.enum(['LINEAR', 'STEP', 'SMOOTH', 'CUBICSPLINE']).optional(),
    keyframes: z.array(z.strictObject({
      time: z.number().min(0).max(30), value,
      inTangent: tangent.optional(), outTangent: tangent.optional(),
      easing: easingField,
    })).min(1).max(64),
    ...trackEffectFields,
  });
}
// Lights, sun, sky and effects share one track shape: the backend names the valid light IDs and properties of each kind when one is wrong.
const lookTrack = z.strictObject({
  kind: z.enum(['light', 'sun', 'environment', 'effects']).describe('Properties per kind: scene_capabilities motionLook.'),
  id: z.string().max(16).optional().describe('Light only: point:0, spot:0, area:0.'),
  property: z.string().max(24),
  interpolation: z.enum(['LINEAR', 'STEP', 'SMOOTH']).optional(),
  keyframes: z.array(z.strictObject({ time: z.number().min(0).max(30), value: z.union([finite, vector3]), easing: easingField })).min(1).max(64),
  ...trackEffectFields,
});
const ikKeyframes = (value, description) => z.strictObject({
  interpolation: z.enum(['LINEAR', 'STEP', 'SMOOTH']).optional(),
  keyframes: z.array(z.strictObject({ time: z.number().min(0).max(30), value })).min(1).max(64),
}).describe(description);
const ikPoint = z.union([
  vector3,
  z.strictObject({ node: identifier }).describe('Follow this node\'s world position.'),
  ikKeyframes(vector3, 'A moving world position.'),
]);
const ikWeight = z.union([unit, ikKeyframes(unit, 'Fade the solve in or out over time.')]).optional();
const degreeRange = z.tuple([z.number().min(-180).max(180), z.number().min(-180).max(180)]);
const jointLimit = z.strictObject({ x: degreeRange.optional(), y: degreeRange.optional(), z: degreeRange.optional() });
const axisName = z.enum(['x', 'y', 'z']);
const axisNames = z.array(axisName).min(1).max(3);
const signedAxis = z.enum(['+x', '-x', '+y', '-y', '+z', '-z']);
const constraintSpace = z.enum(['world', 'local']).optional();
const limitRange = z.tuple([z.number().min(-1e6).max(1e6), z.number().min(-1e6).max(1e6)]).optional();
// One entry per kind of DRIVER_VARIABLE_KIND_NAMES, so a kind the backend gains fails here until it has a shape.
const driverVariableShapes = {
  custom: z.strictObject({ node: identifier, name: z.string().max(64), component: axisName.optional() }),
  distance: z.strictObject({ from: identifier, to: identifier }),
  rotationDifference: z.strictObject({ from: identifier, to: identifier }),
};
function driverVariableSchemas() {
  return DRIVER_VARIABLE_KIND_NAMES.map(kind => {
    if (!driverVariableShapes[kind]) throw new Error('Driver variable kind without a schema: ' + kind);
    return z.strictObject({ [kind]: driverVariableShapes[kind] });
  });
}
// A bounded expression: data only, never code. See docs/agent-motion.md for the operators.
const expression = z.lazy(() => z.union([
  z.number().min(-1e6).max(1e6),
  z.literal('time'),
  z.strictObject({ node: identifier, property: z.enum(['translation', 'rotation', 'scale']), component: axisName, space: z.enum(['local', 'world']).optional() }),
  ...driverVariableSchemas(),
  z.record(z.string().max(24), z.union([z.array(expression).min(1).max(8), expression])),
])).describe('Number, "time", {"node","property","component","space"} read, or an operator like {"mul":[2,"time"]}, {"neg":x} too. Operators as in field expressions (scene_capabilities), no vectors, attributes or noise. At most 64 parts, 8 deep.').meta({ id: 'Expression' });
const influence = z.union([unit, expression]).optional().describe('0 to 1 blend of the constraint, or an expression.');
// Types without a schema of their own here; the backend checks their fields.
const describedConstraintTypes = ['copy_location', 'copy_rotation', 'copy_scale', 'limit_location', 'limit_rotation', 'track_to', 'child_of'];
const otherConstraintTypes = CONSTRAINT_TYPE_NAMES.filter(type => !describedConstraintTypes.includes(type));
const constraint = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('copy_location'), node: identifier, target: identifier, axes: axisNames.optional(), invert: axisNames.optional(), offset: z.boolean().optional(), space: constraintSpace, influence }),
  z.strictObject({ type: z.literal('copy_rotation'), node: identifier, target: identifier, axes: axisNames.optional(), invert: axisNames.optional(), mix: z.enum(['replace', 'add']).optional(), space: constraintSpace, influence }),
  z.strictObject({ type: z.literal('copy_scale'), node: identifier, target: identifier, axes: axisNames.optional(), offset: z.boolean().optional(), space: constraintSpace, influence }),
  z.strictObject({ type: z.literal('limit_location'), node: identifier, x: limitRange, y: limitRange, z: limitRange, space: constraintSpace, influence }),
  z.strictObject({ type: z.literal('limit_rotation'), node: identifier, x: degreeRange.optional(), y: degreeRange.optional(), z: degreeRange.optional(), space: constraintSpace, influence }),
  z.strictObject({ type: z.literal('track_to'), node: identifier, target: identifier, trackAxis: signedAxis.optional(), upAxis: axisName.optional(), worldUp: vector3.optional(), influence }),
  z.strictObject({ type: z.literal('child_of'), node: identifier, target: identifier, inverse: z.enum(['rest', 'none']).optional(), influence }),
  z.looseObject({ type: z.enum(otherConstraintTypes), node: identifier, influence }).describe('The other constraint types take their fields flat beside type and node: scene_capabilities motionConstraints lists the fields of each type, and the backend names a wrong one.'),
]);
const propertyValue = z.union([finite, vector3]);
const motionProperty = z.strictObject({
  node: identifier,
  name: z.string().min(1).max(64),
  kind: z.enum(MOTION_PROPERTY_KIND_NAMES).optional().describe('number (default), vector or color.'),
  value: propertyValue.optional().describe('Constant value; leave out when keys are given.'),
  min: finite.optional(),
  max: finite.optional(),
  keys: z.array(z.strictObject({ time: z.number().min(0).max(30), value: propertyValue })).min(1).max(16).optional().describe('Linear keys with rising times.'),
});
const driver = z.strictObject({
  target: z.union([
    z.strictObject({ kind: z.literal('node'), id: identifier, property: z.enum(['translation', 'rotation', 'scale']), component: axisName }),
    z.strictObject({ kind: z.literal('material'), id: identifier, property: z.enum(['color', 'emissiveColor', 'emission', 'metallic', 'roughness']), component: axisName.optional() }),
    z.strictObject({ kind: z.literal('light'), id: identifier.describe('point:N, spot:N or area:N'), property: z.enum(['intensity', 'color']), component: axisName.optional() }),
    z.strictObject({ kind: z.literal('morph'), id: identifier, property: z.literal('weight') }),
    z.strictObject({ kind: z.literal('camera'), property: z.enum(['eye', 'target', 'fov', 'roll']), component: axisName.optional() }),
  ]),
  expression,
});
const otherIkSolverTypes = IK_SOLVER_TYPE_NAMES.filter(type => type !== 'two-bone' && type !== 'aim');
const ikSolver = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('two-bone'),
    root: identifier, middle: identifier, end: identifier,
    target: ikPoint.describe('Where end should reach: [x, y, z] in world metres, {"node":id}, or keyframes.'),
    pole: ikPoint.optional().describe('World point the middle joint bends toward. Give one, or a straight limb has no bend direction.'),
    weight: ikWeight,
    keepEndRotation: z.boolean().optional().describe('Default true: end keeps its world rotation, so a foot or gripper stays level.'),
    limits: z.strictObject({ root: jointLimit.optional(), middle: jointLimit.optional() }).optional().describe('Joint limits in degrees: how far root or middle may turn from its rest rotation, per axis of its own, as Euler XYZ. scene_inspect motionIk lists each pose a limit changed.'),
    bendToward: vector3.optional().describe('World direction the middle joint should bend toward, such as [0, 0, 1] for a knee on a character facing +z. motionIk warns with wrong-bend when the solve bends the other way. Rigs that rest bent need none.'),
  }).describe('Limb of three nodes, each a descendant of the one before: shoulder, elbow, wrist. Computes their rotations, so you need no quaternions. Nodes with IK nodes below them must have uniform scale: put sizes on child mesh nodes.'),
  z.strictObject({
    type: z.literal('aim'),
    joint: identifier.optional(),
    joints: z.array(identifier).min(1).max(16).optional().describe('A chain from its base to the aiming node, sharing the turn.'),
    worldForward: vector3.optional().describe('The world direction the character faces in its rest pose, such as [0, 0, 1]. Use this on imported rigs, whose bone axes vary.'),
    forward: vector3.optional().describe('Instead of worldForward: the aiming node\'s local axis to point at the target. Defaults to [0, 0, 1], the front of an unrotated recipe node.'),
    target: ikPoint,
    maxAngle: z.number().min(0.001).max(180).optional().describe('Limits the whole turn, in degrees.'),
    weight: ikWeight,
  }).describe('Point a node, such as a head, lamp or camera, at a target.'),
  z.looseObject({ type: z.enum(otherIkSolverTypes), weight: ikWeight }).describe('A chain of any length (type chain: chain or root and end, target, pole, stretch, iterations, limits) or a chain along a curve (type spline: chain or root and end, curve, stretch). Fields are flat beside type: scene_capabilities motionIk lists them.'),
]);
// Properties of the tracks the schema accepts; light, sun, environment and effects take any property name here and the backend checks it.
const motionTrackProperties = {
  node: ['translation', 'rotation', 'scale', 'opacity'],
  material: ['color', 'emissiveColor', 'emission', 'metallic', 'roughness'],
  camera: ['eye', 'target', 'fov', 'roll'],
  morph: ['weight'],
  geometry: ['oceanTime'],
};
// The backend's list, so scene_create and set-motion accept the same kinds.
const motionTrackKinds = MOTION_TRACK_KIND_NAMES;
const motionTrackFields = ['kind', 'id', 'property', 'interpolation', 'keyframes', 'extrapolation', 'modifiers'];
// A union reports only "Invalid input"; name the field and the allowed ones the way set-motion does.
function motionTrackUnionMessage(issue) {
  const track = issue.input;
  if (!track || typeof track !== 'object' || Array.isArray(track)) return 'A motion track is an object {kind, id, property, keyframes: [{time, value}]}.';
  const allowedFields = track.kind === 'camera' ? motionTrackFields.filter(field => field !== 'id') : motionTrackFields;
  const unknownField = Object.keys(track).find(field => !allowedFields.includes(field));
  if (unknownField !== undefined) return `Unknown or unsupported motion track field: ${unknownField}. Allowed fields: ${allowedFields.join(', ')}.`;
  const kindList = motionTrackKinds.join(', ');
  if (track.kind === undefined) return `A motion track needs kind (${kindList}), id, property and keyframes.`;
  if (!motionTrackKinds.includes(track.kind)) return `Unknown motion track kind: ${JSON.stringify(track.kind)}. Kinds: ${kindList}.`;
  const properties = motionTrackProperties[track.kind];
  if (properties && !properties.includes(track.property)) return `Unknown ${track.kind} track property: ${JSON.stringify(track.property)}. ${track.kind} properties: ${properties.join(', ')}.`;
  return undefined;
}
const motion = z.strictObject({
  duration: z.number().min(0.1).max(30),
  ik: z.array(ikSolver).max(16).optional().describe('Inverse kinematics run after the tracks and any selected clip, in order, on recipes and imported assets. IDs are recipe node IDs or an asset\'s node-N IDs; find them with scene_inspect kind hierarchy. scene_inspect reports motionIk: whether each solver reaches its target across the clip.'),
  springs: z.record(z.string(), z.unknown()).optional().describe('Spring bones for hair, tails and soft parts, VRM model: { chains: [{ bones, stiffness, dragForce, gravityPower, gravityDir, hitRadius, colliders }], colliders: [{ id, bone, type, offset, radius }] }. scene_capabilities springBones has the ranges.'),
  constraints: z.array(constraint).max(32).optional().describe('Blender-style node constraints, run in order after the tracks, drivers and IK, each on the pose the one before left: copy_location, copy_rotation, copy_scale, limit_location, limit_rotation, track_to, child_of, floor. Euler angles are XYZ in degrees; space defaults to world. Same result at any time, so seeking equals playing.'),
  drivers: z.array(driver).max(32).optional().describe('Drive one node component or material property from a bounded expression over time and other nodes\' values. A driven property cannot also have a track.'),
  properties: z.array(motionProperty).max(32).optional().describe('Custom properties on nodes: named values, constant or keyed, that driver expressions and constraint influence read with {"custom":{"node","name"}}. A property holds one number, vector or colour inside its min and max.'),
  loop: z.boolean().optional(),
  tracks: z.array(z.union([
    motionTrack('node', 'translation', vector3, vector3),
    motionTrack('node', 'rotation', quaternion, quaternion),
    motionTrack('node', 'scale', z.tuple([positive, positive, positive]), vector3),
    motionTrack('node', 'opacity', unit, finite),
    motionTrack('material', 'color', color, vector3),
    motionTrack('material', 'emissiveColor', z.tuple([nonnegative, nonnegative, nonnegative]), vector3),
    motionTrack('material', 'emission', nonnegative, finite),
    motionTrack('material', 'metallic', unit, finite),
    motionTrack('material', 'roughness', unit, finite),
    motionTrack('camera', 'eye', vector3, vector3),
    motionTrack('camera', 'target', vector3, vector3),
    motionTrack('camera', 'fov', finite.gt(0).lt(180), finite),
    motionTrack('camera', 'roll', finite, finite),
    motionTrack('morph', 'weight', unit, finite),
    motionTrack('geometry', 'oceanTime', finite.min(-1e6).max(1e6), finite),
    lookTrack,
  ], { error: motionTrackUnionMessage })).max(128).optional().describe('Keyframe tracks; leave out for a motion made only of drivers, ik or constraints.'),
}).describe('One absolute-time procedural clip. Local node transforms propagate through parents. Cubic tangents are derivatives per second. Backend checks references, duplicate tracks, 2048 total keys and every sampled pose.');
const physicsCompoundPart = z.strictObject({
  shape: z.enum(['box', 'ball', 'capsule', 'cylinder', 'cone']),
  translation: vector3.optional().describe('Part centre in body space.'),
  rotation: quaternion.optional().describe('Part rotation in body space.'),
  halfExtents: z.tuple([positive, positive, positive]).optional().describe('Box parts only.'),
  radius: positive.optional().describe('Ball, capsule, cylinder and cone parts.'),
  halfHeight: positive.optional().describe('Capsule, cylinder and cone parts, along local Y.'),
});
const physicsBody = z.strictObject({
  node: identifier.describe('Root node with a geometry; the collider is fitted to it and the body drives its pose.'),
  type: z.enum(['dynamic', 'fixed', 'kinematic']).optional().describe('Defaults to dynamic.'),
  shape: z.enum(PHYSICS_BODY_SHAPES).optional().describe('Defaults: box for dynamic and sensors, trimesh for fixed. Cylinder and cone fit the geometry bounds along local Y. Trimesh (at most 20000 triangles) needs a fixed or kinematic body; convex takes at most 2048 distinct vertices; compound needs shapes.'),
  shapes: z.array(physicsCompoundPart).max(16).optional().describe('Only with shape compound: 1-16 sub-colliders, each { shape box|ball|capsule|cylinder|cone, translation, rotation, halfExtents or radius and halfHeight }.'),
  mass: positive.optional().describe('Kilograms; mass or density, not both.'),
  density: positive.optional().describe('Defaults to 1.'),
  friction: nonnegative.optional(),
  restitution: unit.optional(),
  sensor: z.boolean().optional().describe('Trigger volume; scene_inspect lists enter and leave times.'),
  velocity: vector3.optional(),
  angularVelocity: vector3.optional(),
  layer: z.number().int().min(0).max(15).optional(),
  collidesWith: z.array(z.number().int().min(0).max(15)).max(16).optional().describe('Layers hit; both bodies must list each other. Defaults to all.'),
  float: z.record(z.string(), z.unknown()).optional().describe('Floats on physics.ocean (dynamic bodies only): drag 2 and angularDrag 2 (1/s, 0-100) damp the body while it is under water; points is 1-16 [x,y,z] in body space (default a 2 x 2 grid at mid height). Each point pushes up by waterDensity x gravity x (volume / points) x its submerged fraction, so density 500 settles at half depth; spread points over a hull so it rolls upright. Needs a volume: not trimesh. boat: {thrust 4 and rudder 1 (m/s2 at the stern), keelDrag 4, forward "-z", stern [x,y,z], controls up to 256 {time, throttle, rudder} keyframes (-1..1), wake {width 1.2, strength 1, height 0.06, lifetime 5} (needs an oceanTime track on the sea)} makes it a steerable boat.'),
});
const physicsJoint = z.strictObject({
  type: z.enum(['spherical', 'revolute', 'prismatic', 'fixed', 'spring']),
  bodyA: identifier,
  bodyB: identifier,
  anchorA: vector3.optional(),
  anchorB: vector3.optional(),
  axis: vector3.optional().describe('Unit vector for revolute and prismatic joints.'),
  limits: z.tuple([finite, finite]).optional().describe('Radians for revolute, metres for prismatic.'),
  name: identifier.optional().describe('Joint name that physics.events jointMotor events refer to; fracture-node writes glue-a-b.'),
  breakImpulse: positive.optional().describe('Fixed joints only: contact impulse in N s that breaks the joint in one step.'),
  contactsEnabled: z.boolean().optional().describe('Whether the two bodies still collide with each other.'),
  motor: z.strictObject({
    mode: z.enum(['position', 'velocity']),
    target: bounded(-1e4, 1e4),
    stiffness: bounded(1e-6, 1e6).optional().describe('Position motors only.'),
    damping: bounded(0, 1e6).optional(),
    maxForce: bounded(1e-6, 1e8).optional(),
  }).nullable().optional().describe('Drives the joint toward a target angle or speed.'),
  restLength: bounded(0, 1e6).optional().describe('Spring joints only.'),
  stiffness: bounded(1e-6, 1e6).optional().describe('Spring joints only; required there.'),
  damping: bounded(0, 1e6).optional().describe('Spring joints only.'),
});
const physics =z.strictObject({
  duration: z.number().min(0.1).max(10),
  gravity: vector3.optional().describe('Defaults to [0, -9.81, 0].'),
  bodies: z.array(physicsBody).min(1).max(64),
  joints: z.array(physicsJoint).max(64).optional().describe('Joint bodies are the node IDs of physics bodies.'),
  events: z.array(z.record(z.string(), z.unknown())).max(128).optional().describe('Scheduled impulse, kinematicPose and jointMotor events by time or tick; docs/physics.md.'),
  fields: z.array(z.record(z.string(), z.unknown())).max(8).optional().describe('Force fields: wind, turbulence, vortex, drag, magnet.'),
  ragdoll: z.record(z.string(), z.unknown()).optional().describe('{ armature, density, friction, restitution, layer }: one body per bone of a recipe armature.'),
  ocean: z.record(z.string(), z.unknown()).optional().describe('Sea for floating bodies: geometry is a mesh geometry whose stack has an ocean node (axis y) whose waves they ride; level is the world height of the calm sea (leave it out to follow the drawn sea; a different value adds a warning to the scene_inspect physics report); waterDensity 1000 kg/m3. The sea clock at physics time 0 is the ocean node time, so drive an oceanTime track at 1 s per s to keep the drawn sea in step.'),
}).describe('Rigid bodies recorded offline with Rapier (optional peer) at 60 fps and seeked by motionTime. scene_inspect reports contacts and resting state. A node cannot have a body and a motion translation or rotation track.');
const looseRecord = z.record(z.string(), z.unknown()).meta({ id: 'LooseRecord' });
const clothSheet = z.strictObject({
  node: identifier.describe('Root mesh node.'),
  pin: z.array(z.enum(['top', 'bottom', 'left', 'right', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'])).max(8).optional(),
  pinGroup: z.string().max(48).optional(),
  pinTo: looseRecord.optional(),
  stiffnessGroup: z.string().max(48).optional(), softBody: looseRecord.optional(), selfCollision: z.boolean().optional(),
  stiffness: unit.optional(), bend: unit.optional(), bendModel: z.enum(['distance', 'dihedral']).optional(), bendYield: z.number().min(0).max(Math.PI).optional(), bendSet: unit.optional(), density: positive.optional(), damping: nonnegative.optional(), friction: unit.optional(), staticFriction: unit.optional(), thickness: nonnegative.optional(),
});
const cloth = z.strictObject({
  duration: z.number().min(0.1).max(10),
  gravity: vector3.optional(),
  wind: vector3.optional(),
  sheets: z.array(clothSheet).min(1).max(8),
  colliders: z.array(looseRecord).max(80).optional().describe('Fields: scene_capabilities cloth.'),
  fields: z.array(looseRecord).max(8).optional().describe('Force fields: scene_capabilities particles.'),
}).describe('Baked at 60 fps, seeked by motionTime. Units, defaults: scene_capabilities cloth.');
// The full motion schema (tracks, ik, constraints, drivers) is in scene_create's recipe. scene_apply and asset recipes
// take the same object, validated by the backend, without repeating about 35 KB of schema in each tool.
const packName = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64);
const recipeMotionReference = z.record(z.string(), z.unknown()).describe('The same object as recipe.motion in scene_create: duration, loop, tracks, ik, constraints, drivers. Read that tool for the fields. On an imported asset it also takes layers, up to 8 clips played at motion time before tracks and ik: { clip (scene_inspect animations id), mask: { joints, descendants, exclude } of node IDs, weight, speed, offset, loop, additive, reference, bones: { clip node: asset node } to retarget by name, morph } or from: { asset, clip } for a clip of another catalog asset retargeted onto this humanoid (scale, rootMotion). motion also takes drive (a car along a path, see scene_capabilities motionDrive) and footLock (true or { contactHeight, contactSpeed, blend, ground }) and { kind: "morph", id: target name, property: "weight" } tracks. A masked layer waves while another walks.');
const boneRecord = z.strictObject({
  name: z.string().min(1).max(64).describe('Unique within the armature. Humanoid rigs use the canonical names (hips, spine, chest, neck, head, leftUpperArm, leftLowerArm, leftHand, leftUpperLeg, leftLowerLeg, leftFoot, leftToes, and right...) so retarget works.'),
  parent: z.string().min(1).max(64).nullable().optional().describe('Parent bone name, or null for a root bone.'),
  head: vector3.describe('Rest position of the joint in armature space.'),
  tail: vector3.optional().describe('Where the bone ends. Defaults to the mean of its children, so give it on leaf bones.'),
});
const armature = z.strictObject({
  id: identifier,
  parent: identifier.nullable().optional().describe('Node the armature hangs from.'),
  translation: vector3.optional(), rotation: quaternion.optional(),
  prefix: z.string().max(64).optional().describe('Prepended to each bone node ID, for a second character or a clash with another node.'),
  preset: z.enum(['humanoid', 'quadruped']).optional().describe('Places bones from fit. A humanoid faces +Z with Y up; its knees sit slightly forward of the leg line and its elbows slightly behind, so poleless two-bone IK bends the right way. A quadruped lies along Z.'),
  fit: z.strictObject({
    node: identifier.optional().describe('A mesh node whose bounds size the preset.'),
    bounds: z.strictObject({ min: vector3, max: vector3 }).optional().describe('Or explicit bounds in armature space.'),
    landmarks: z.record(z.string(), vector3).optional().describe('Move a bone head by bone name, or its tail as <name>Tail, for arms held out or an odd shape.'),
  }).optional(),
  bones: z.array(boneRecord).min(1).max(128).optional().describe('Explicit bones, instead of a preset.'),
}).describe('A skeleton. Each bone becomes a recipe node named after it (parented like the bones, rotating about its head), so motion tracks, motion.ik and set-node address bones by name. Mesh nodes bind with skin. scene_inspect rig lists unweighted vertices, bones with no vertices and joint axis problems.');
const armaturesReference = z.array(z.record(z.string(), z.unknown())).max(16).describe('The same array as recipe.armatures in scene_create: id, parent, preset, fit, bones. Read that tool for the fields.');
const timelineReference = z.record(z.string(), z.unknown()).describe('Shots in order, up to 60 s; fields in scene_capabilities filmTimeline.');
const geometryTypes = geometry.options.flatMap(option => option.shape.type.options ?? [option.shape.type.value]);
const geometryListed = listed('geometries', geometry, 'Geometry { id, type, ...fields of that type }; mesh also takes base, edits, stack, smoothAngle. Fields per type: scene_capabilities geometries. box and cylinder are unit solids (box -0.5..0.5) sized by node scale; their default bevel rounds the edges, so give bevel 0 for exact sizes. uv_unwrap stretches under a non-uniform node scale: bake the size into the vertices first (set_position, position {mul:[{attr:position},[x,y,z]]}).', { id: identifier, type: z.enum(geometryTypes) });
const motionListed = listed('motion', motion, 'One absolute-time clip: duration in s, loop, tracks [{kind, id, property, interpolation, keyframes [{time, value, easing}]}], ik, constraints, drivers; see scene_capabilities motion.', coreOf(motion.shape, ['duration', 'loop']));
const physicsListed = listed('physics', physics, 'Rigid bodies recorded offline with Rapier: duration, gravity, bodies [{node, type, shape, mass, ...}], joints; see scene_capabilities physics.', coreOf(physics.shape, ['duration']));
const clothListed = listed('cloth', cloth, 'Baked cloth sheets: duration, gravity, wind, sheets [{node, pin, pinTo, stiffness, ...}], colliders; see scene_capabilities cloth.', coreOf(cloth.shape, ['duration']));
const armatureListed = listed('armatures', armature, 'A skeleton { id, parent, preset humanoid|quadruped, fit, bones [{name, parent, head, tail}], prefix, translation, rotation }; see scene_capabilities armatures.', { id: identifier });
const gameReference = z.record(z.string(), z.unknown()).describe('Playable setup as plain JSON, never code: {player:{node}, camera, input, physics, ground, rules}. Fields and an example: scene_capabilities game.');
const recipe = z.strictObject({
  format: z.literal('crucible.scene'),
  schemaVersion: z.literal(1),
  geometries: z.array(geometryListed).max(256).optional(),
  materials: z.array(materialListed(z.strictObject({ id: identifier, tag: materialTag, ...materialFields }), 'Material.', { id: identifier })).max(256).optional().describe('Omit for none.'),
  nodes: z.array(nodeRecord).max(4096),
  armatures: z.array(armatureListed).max(16).optional(),
  camera: z.strictObject(cameraFields).optional(),
  environment: environmentListed.optional(),
  effects: effectsListed.optional(),
  shadow: shadow.optional(),
  motion: motionListed.nullable().optional(),
  physics: physicsListed.nullable().optional(),
  cloth: clothListed.nullable().optional(),
  timeline: timelineReference.nullable().optional(),
  particles: z.record(z.string(), z.unknown()).nullable().optional().describe('Particle emitters and hair, seeked by motionTime. Fields: scene_capabilities particles.'),
  bake: z.record(z.string(), z.unknown()).nullable().optional().describe('Bounced light baked at build time. Fields: scene_capabilities bake.'),
  postPasses: z.array(z.record(z.string(), z.unknown())).nullable().optional().describe('Full-screen GLSL passes, [{name, fragment, uniforms, scale}]. Rules: scene_capabilities postPasses.'),
  postPassesAntialias: z.enum(['fxaa', 'off']).optional(),
  pixelGrid: z.record(z.string(), z.unknown()).nullable().optional().describe('{width,height,pad}: low-res pixel-art render.'),
  game: gameReference.nullable().optional(),
}).describe('Bounded scene recipe; the backend validates it.');
const assetRecipe = z.strictObject({
  format: z.literal('crucible.asset'),
  schemaVersion: z.literal(1),
  assetId: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('SHA-256 asset ID from scene_asset_catalog, or assetName.'),
  assetName: z.string().max(256).optional(),
  camera: z.strictObject(cameraFields).optional(),
  environment: environmentListed.optional(),
  effects: effectsListed.optional(),
  shadow: shadow.optional(),
  root: z.strictObject({
    translation: vector3.optional(), rotation: quaternion.optional(),
    scale: z.tuple([positive, positive, positive]).optional(),
  }).optional(),
  animation: z.strictObject({ clip: z.number().int().min(0), time: nonnegative }).nullable().optional().describe('Absolute clip/time sample. null selects the original decoded pose.'),
  materialOverrides: z.array(materialListed(z.strictObject({ id: identifier, ...materialFields }), 'Override of a source material.', { id: identifier })).max(4096).optional(),
  nodeOverrides: z.array(z.strictObject({ id: identifier, translation: vector3.optional(), rotation: quaternion.optional(), scale: z.tuple([positive, positive, positive]).optional() })).max(4096).optional(),
  motion: recipeMotionReference.nullable().optional(),
});
// Agents copy the add-node shape into set-node and set-material and wrap the fields in a node or material key. Name the
// fix in the message instead of the bare "unrecognized key".
function flatFieldsHint(operationType, wrapperKey) {
  return issue => issue.code === 'unrecognized_keys' && issue.keys.includes(wrapperKey)
    ? `${operationType} takes its fields beside type, not inside ${wrapperKey}: {"type":"${operationType}","id":"<id>",...fields}. Move the fields of ${wrapperKey} up one level.`
    : undefined;
}
const nodeOperations = (nodeFieldShape, nodeSchema) => [
  z.strictObject({ type: z.literal('set-node'), id: identifier, geometry: identifier.optional(), material: identifier.optional(), ...nodeFieldShape }, { error: flatFieldsHint('set-node', 'node') }),
  z.strictObject({ type: z.literal('add-node'), node: nodeSchema }),
];
const otherOperations = [
  materialListed(z.strictObject({ type: z.literal('set-material'), id: identifier, ...materialFields }, { error: flatFieldsHint('set-material', 'material') }), 'Change a material.', { type: z.literal('set-material'), id: identifier }),
  z.strictObject({ type: z.literal('set-camera'), ...cameraFields, fStop: cameraFields.fStop.nullable().optional(), focusDistance: positive.nullable().optional() }),
  z.strictObject({ type: z.literal('set-motion'), motion: recipeMotionReference.nullable().optional(), removeTracks: z.array(z.record(z.string(), z.string())).min(1).max(64).optional().describe('Instead of motion: selectors { kind, id, property } of tracks to drop.') })
    .refine(operationBody => (operationBody.motion !== undefined) !== (operationBody.removeTracks !== undefined), { message: 'set-motion takes one of motion or removeTracks.' }),
  // Rarely used edits share one branch so every turn carries fewer schema bytes (#3047). The backend checks their fields
  // and names the fix; scene_capabilities applyOperations lists them.
  z.looseObject({ type: z.enum(FOLDED_APPLY_OPERATION_TYPES) }).describe('Fields sit beside type. Each one: scene_capabilities applyOperations.<type>.'),
  z.strictObject({ type: z.literal('set-environment'), environment: environmentListed }),
  z.strictObject({ type: z.literal('set-effects'), effects: effectsListed }),
  z.strictObject({ type: z.literal('set-root'), translation: vector3.optional(), rotation: quaternion.optional(), scale: z.tuple([positive, positive, positive]).optional() }),
  z.strictObject({ type: z.literal('set-asset-node'), id: identifier, translation: vector3.optional(), rotation: quaternion.optional(), scale: z.tuple([positive, positive, positive]).optional() }),
  z.strictObject({ type: z.literal('set-animation'), clip: z.number().int().min(0).nullable().optional(), time: nonnegative.optional() }),
  z.strictObject({ type: z.literal('remove-node'), id: identifier, recursive: z.boolean().optional().describe('Remove descendants too. Defaults to false; dangling children reject the batch.') }),
  z.strictObject({ type: z.literal('add-geometry'), geometry: geometryListed }),
  z.strictObject({ type: z.literal('remove-geometry'), id: identifier }),
  z.strictObject({ type: z.literal('add-material'), material: materialListed(z.strictObject({ id: identifier, tag: materialTag, ...materialFields }), 'New material.', { id: identifier, tag: materialTag }) }),
];
const operation = z.discriminatedUnion('type', [...nodeOperations(nodeFields, nodeRecord), ...otherOperations]);
// The same schemas without the relations field, for the benchmark switch --relations off.
const { relations: _relationsField, ...nodeFieldsWithoutRelations } = nodeFields;
const nodeRecordWithoutRelations = nodeRecord.omit({ relations: true });
const recipeWithoutRelations = recipe.extend({ nodes: z.array(nodeRecordWithoutRelations).max(4096) });
function withoutRelationsAdvice(capabilities) {
  const { relations: _relationsAdvice, ...scene } = capabilities.scene;
  return { ...capabilities, scene };
}
const operationWithoutRelations = z.discriminatedUnion('type', [...nodeOperations(nodeFieldsWithoutRelations, nodeRecordWithoutRelations), ...otherOperations]);
const branchName = z.string().regex(BRANCH_NAME_PATTERN).describe('Branch name, up to 24 characters.');
const labelsFlag = z.boolean().optional().describe('Draw part names, tags and lint problems on the image; returned with pixel positions.');
const sessionFields = { sessionId: z.uuid('sessionId is not a valid UUID. Leave it out to use the last used scene.').optional().describe('Leave out: the last used scene.') };
const checkpointFields = { ...sessionFields, checkpointId: z.uuid().describe('Checkpoint UUID returned by scene_checkpoint for this session.') };
const expectedRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe('Current revision returned by create, inspect, apply or restore. Stale edits fail atomically.');
const jobFields = { jobId: z.uuid().describe('Render job UUID returned by scene_render_submit or capabilities jobs.records.') };
const jobWithFormatFields = { ...jobFields, response_format: responseFormatField };
const INLINE_IMAGE_LIMIT = 8;
const jobResultFields = {
  ...jobWithFormatFields,
  images: z.union([z.boolean(), z.array(z.number().int().min(0)).max(INLINE_IMAGE_LIMIT)]).optional().describe('false: paths only; indexes: those frames.'),
};
// Job tools take jobId alone; an agent that carries sessionId over from the scene tools gets told to drop it.
function jobKeysHint(toolName, acceptedKeys) {
  const accepted = acceptedKeys.length > 1 ? `${acceptedKeys[0]} (and ${acceptedKeys.slice(1).join(', ')})` : acceptedKeys[0];
  return issue => (issue.code === 'unrecognized_keys'
    ? `${toolName} takes ${accepted} only: remove ${issue.keys.join(', ')}. A render job is addressed by its jobId, not by sessionId; scene_render_submit returned it.`
    : undefined);
}
const renderSettings = z.strictObject({
  kind: z.enum(['image', 'stills', 'video', 'icons']),
  width: z.number().int().min(64).max(MAXIMUM_JOB_SIDE).optional(),
  height: z.number().int().min(64).max(MAXIMUM_JOB_SIDE).optional(),
  items: z.array(z.string().max(260)).min(1).max(256).optional().describe('icons: catalog GLB names or asset ids; a PNG each plus atlas.png, icons.json. See scene_capabilities jobs.icons.'),
  size: z.union([z.literal(64), z.literal(128), z.literal(256), z.literal(512)]).optional(),
  style: z.enum(['clean', 'toon', 'sketch']).optional().describe('icons: clean (default), toon or sketch.'),
  viewpoint: z.union([z.literal('three-quarter'), z.strictObject({ azimuth: z.number().optional(), elevation: z.number().optional() })]).optional().describe('icons: three-quarter or azimuth/elevation degrees.'),
  scale: z.enum(['fit', 'relative']).optional(),
  padding: z.number().optional(),
  angles: z.number().optional(),
  breakdown: z.boolean().optional(),
  seed: z.number().optional(),
  sketch: z.looseObject({}).optional(),
  fps: z.number().int().min(1).max(MAXIMUM_JOB_FPS).optional(),
  duration: z.number().min(0.1).max(60).optional(),
  animation: z.strictObject({ clip: z.number().int().min(0), start: z.number().min(0).max(3600).optional() }).optional(),
  motion: z.strictObject({ start: z.number().min(0).max(3600).optional() }).optional(),
  rendererTime: z.strictObject({ start: z.number().min(0).max(3600).optional(), rate: z.number().min(-16).max(16).optional() }).optional(),
  renderer: z.looseObject({ type: z.literal('pathTracer'), backend: z.enum(['cpu', 'gpu', 'native']).optional() }).meta({ description: 'Path tracer. Also samples, bounces, denoise, seed, maxSeconds, noiseThreshold: scene_capabilities topic jobs, key pathTracer.' }).pipe(z.strictObject({ type: z.literal('pathTracer'), backend: z.enum(['cpu', 'gpu', 'native']).optional(), samples: z.number().optional(), bounces: z.number().optional(), denoise: z.union([z.boolean(), z.enum(['wavelet', 'oidn', 'none'])]).optional(), seed: z.number().optional(), maxSeconds: z.number().optional(), noiseThreshold: z.number().optional() })).optional(),
  quality: z.enum(['draft', 'realtime', 'realtime-high', 'final']).optional().describe('What the render is for; picks the renderer. Not with renderer or budget. scene_capabilities jobs.'),
  budget: z.strictObject({ secondsPerFrame: z.number().optional(), framesPerSecond: z.number().optional(), memoryMiB: z.number().optional() }).optional().describe('Pick renderer, samples and size to fit; not with renderer. scene_capabilities jobs.'),
  timeline: z.strictObject({ start: z.number().min(0).max(60).optional() }).optional().describe('Play the recipe timeline from start (default 0); leave motion and animation out.'),
  audio: z.strictObject({ file: z.string().max(68), offset: z.number().min(0).max(3600).optional(), track: z.enum(['aac', 'pcm']).optional() }).optional().describe('Video only: a file in the --audio folder (a-z A-Z 0-9 . _ -; .wav .mp3 .ogg .flac), mixed in from offset seconds.'),
  encoder: z.enum(VIDEO_ENCODERS).optional().describe('Video only: cpu (default) or nvenc.'),
  passes: z.array(z.enum(RENDER_PASS_NAMES)).min(1).max(RENDER_PASS_NAMES.length).optional().describe('image, stills: also a raw PNG per pass; opaque geometry only.'),
  mattes: z.array(z.strictObject({ object: z.string().max(120).optional(), material: z.string().max(120).optional() })).max(8).optional().describe('One ID matte PNG per part or material; see jobs.'),
  stillCount: z.number().int().min(2).max(MAXIMUM_STILLS_FRAMES).optional(),
  transparent: z.boolean().optional().describe('image and stills: lit image with alpha; no sky, auto ground or volume fog.'),
  format: z.enum(RENDER_OUTPUT_FORMATS).optional().describe('image and stills: png (default), png16 or exr (depth in metres).'),
  multilayer: z.boolean().optional().describe('With format exr and passes: pack Combined and every pass into one EXR per frame.'),
  region: z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(16), height: z.number().int().min(16) }).optional().describe('Pixels to keep from the top left. Not with renderer.'),
}).describe('Snapshot render: one PNG, eight evenly spaced PNGs, or H.264 MP4 (even dimensions). Defaults: 24 fps, one second. motion.start plays recipe tracks, animation an imported clip, both layer. Omitted motion holds time zero.');
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Changes nothing in the scene, but opens a page for the person and waits, so a repeat call asks again.
const askUser = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const edit = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// Only these three remove something that cannot be restored: the scene, a checkpoint slot, a job's files.
const destroy = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const TOOL_TITLES = {
  scene_capabilities: 'Scene capabilities', scene_create: 'Create scene', scene_asset_catalog: 'Asset catalog', scene_create_asset: 'Create scene from asset',
  scene_inspect: 'Inspect scene', scene_walkmap: 'Walkable map', mesh_inspect: 'Inspect meshes', mesh_edit: 'Edit mesh', mesh_stack: 'Set mesh modifiers',
  scene_apply: 'Apply scene edits', scene_look: 'Look at scene', scene_fit_look: 'Fit the look to reference regions', scene_ask_user: 'Ask the user to mark the scene', scene_ask_user_submit: 'Send marks from the inline view', scene_review: 'Review camera samples', scene_checkpoint: 'Save checkpoint',
  scene_restore: 'Restore checkpoint', scene_release_checkpoint: 'Release checkpoint', scene_export_recipe: 'Export recipe', scene_export_glb: 'Export GLB', scene_export_web: 'Export web game',
  scene_dispose: 'Dispose scene', scene_render_submit: 'Submit render job', scene_render_status: 'Render job status', scene_render_cancel: 'Cancel render job',
  scene_render_result: 'Render job result', scene_render_release: 'Release render job',
};

// --tools picks the tools a client lists. The inline annotate view's submit tool follows scene_ask_user and is never named.
const INTERNAL_TOOLS = new Set(['scene_ask_user_submit']);
export const SELECTABLE_TOOL_NAMES = Object.freeze(Object.keys(TOOL_TITLES).filter(name => !INTERNAL_TOOLS.has(name)));

// Returns the tool names of a --tools value, or undefined for every tool.
export function parseToolSelection(value) {
  if (value === undefined) return undefined;
  const names = [...new Set(String(value).split(',').map(name => name.trim()).filter(Boolean))];
  const unknown = names.filter(name => !SELECTABLE_TOOL_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new Error(`--tools names unknown tools: ${unknown.join(', ')}. Pass a comma-separated list of: ${SELECTABLE_TOOL_NAMES.join(', ')}.`);
  }
  if (!names.includes('scene_capabilities')) {
    throw new Error('--tools must include scene_capabilities: the other tools point to it for the fields they take. Add it to the list.');
  }
  return names;
}

function selectedToolsInstructions(selectedTools) {
  return selectedTools ? ` This server lists only these tools: ${selectedTools.join(', ')}. Ignore advice about any other tool.` : '';
}

// Top-level fields only and loose nested objects: every output schema is sent with tools/list, so it counts against the tool-cost ceilings.
const OUTPUT_SCHEMAS = {
  scene_capabilities: z.looseObject({ phase: z.string().optional() }),
  scene_inspect: z.looseObject({ sessionId: z.string().optional(), revision: z.number().int().optional() }),
  scene_checkpoint: z.looseObject({ checkpointId: z.string(), revision: z.number().int().optional() }),
  scene_release_checkpoint: z.looseObject({ released: z.boolean(), checkpointId: z.string().optional() }),
  scene_render_status: z.looseObject({ jobId: z.string(), state: z.string() }),
  scene_render_result: z.looseObject({ jobId: z.string(), artifacts: z.array(z.looseObject({ filename: z.string(), mimeType: z.string(), bytes: z.number(), path: z.string() })) }),
};

// A render result carries the files by path and digest. A PNG that fits is also sent inline so a client can show it,
// and every artifact gets a resource link to its file. Video and larger files stay on disk.
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const INLINE_IMAGE_MAXIMUM_BYTES = 1024 * 1024;

function isAttachableImage(artifact) {
  return INLINE_IMAGE_TYPES.has(artifact.mimeType) && artifact.bytes <= INLINE_IMAGE_MAXIMUM_BYTES;
}

// images: undefined or true attaches every PNG of a small job and none of a larger one (a 96-frame job would put
// ~100 MB in the transcript); false attaches none; an array of artifact indexes attaches exactly those.
function indexesToAttach(artifacts, images) {
  if (Array.isArray(images)) {
    const outOfRange = images.filter(index => index >= artifacts.length);
    if (outOfRange.length > 0) throw new RangeError(`images index ${outOfRange[0]} is past the last artifact (${artifacts.length - 1}). Pass indexes from 0 to ${artifacts.length - 1} of the artifacts list, or images: false for paths only.`);
    return new Set(images);
  }
  if (images === false) return new Set();
  const imageIndexes = artifacts.flatMap((artifact, index) => (isAttachableImage(artifact) ? [index] : []));
  return new Set(imageIndexes.length <= INLINE_IMAGE_LIMIT ? imageIndexes : []);
}

async function renderResultContent(result, shown = result, { images } = {}) {
  const content = [{ type: 'text', text: JSON.stringify(shown) }];
  const attachIndexes = indexesToAttach(result.artifacts, images);
  for (const [index, artifact] of result.artifacts.entries()) {
    if (attachIndexes.has(index) && isAttachableImage(artifact)) {
      content.push({ type: 'image', data: (await readFile(artifact.path)).toString('base64'), mimeType: artifact.mimeType });
    }
    content.push({ type: 'resource_link', uri: pathToFileURL(artifact.path).href, name: artifact.filename, mimeType: artifact.mimeType, size: artifact.bytes });
  }
  return { content, structuredContent: shown };
}

// Errors from the preview page arrive as "page.evaluate: RangeError: <message>\n    at <bundle url>...": the stack
// names bundle internals the agent cannot act on, so only the message is returned.
export function readableErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const readable = message.split(/\s+at (?:[^\n(]+ \()?https?:\/\//)[0].replace(/^page\.evaluate: (?:\w*Error: )?/, '').trim();
  if (!isEngineFault(readable)) {
    return readable;
  }
  console.error(`Crucible internal error: ${readable}`);
  return ENGINE_FAULT_ADVICE;
}

// The messages a JavaScript engine raises for a bug in our code (a missing field read, a wrong type called), as opposed
// to the validation messages we write ourselves. They name no input the agent can change, so the agent gets advice and
// the detail goes to the server log.
const ENGINE_FAULT = /Cannot (?:read|set) propert(?:y|ies) of (?:undefined|null)|Cannot destructure|is not a function|is not iterable|is not defined|Cannot convert undefined or null/;
const ENGINE_FAULT_ADVICE = 'Internal error in the Crucible server, not caused by your input. Call scene_inspect to check the scene, retry once, and if it repeats, leave out the optional field you just added (for example labels) or report the tool name.';

// A guide on the site follows main and can name a field the installed release does not have yet. A refusal of an unknown
// field says which version refused it, so the agent can tell a typo from a field that arrives later.
const UNKNOWN_FIELD_REFUSAL = /is not a field|is not a known field|has unknown fields|has an unknown field|unknown fields? /;

export function withVersionHint(message, version) {
  if (!UNKNOWN_FIELD_REFUSAL.test(message)) return message;
  return `${message} This server is Crucible ${version}; a field in a newer guide may only arrive in a later release, so check the {since X.Y.Z} tag in the guide.`;
}

function isEngineFault(message) {
  return ENGINE_FAULT.test(message);
}

// After a failed create no scene exists, so mesh_inspect and the other tools cannot look into the failure. Agents tried
// anyway (5 of 32 errors in one recorded run) and met a second error.
const CREATE_TOOLS = new Set(['scene_create', 'scene_create_asset']);
const SCENE_NOT_CREATED_ADVICE = 'No scene was created, so the other tools have nothing to inspect: fix the recipe as the message says and call scene_create again.';

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

export function createAgentMcpServer(runtime, { version = packageMetadata.version, branches = true, relations = true, findings = true, tools: selectedTools, callLogPath = readEnvironmentVariable(CALL_LOG_ENVIRONMENT_VARIABLE), updateAvailable = () => null } = {}) {
  const newerVersion = updateAvailable();
  let updateReported = false;
  const logCall = createCallLogger(callLogPath);
  // Without branches the schemas carry no branch field and the instructions do not mention variants (a benchmark switch).
  const branchField = branches ? { branch: branchName.optional().describe('Fork: store the result as this branch (up to 8), leaving the scene unchanged.') } : {};
  const reviewBranchField = branches ? { branch: branchName.optional().describe('Render this scene_apply branch.') } : {};
  const restoreBranchField = branches ? { branch: branchName.optional() } : {};
  const restoreCheckpointId = checkpointFields.checkpointId.optional();
  const branchInstructions = branches ? ' To try variants, give scene_apply a branch name for each (the scene stays put), compare them in one scene_review with a branch per shot, then keep the best with scene_restore and its branch.' : '';
  installVolumeGridFiles();
  const server = new McpServer({ name: 'crucible-scene', version }, {
    instructions: 'Start with scene_capabilities. Create a procedural recipe with scene_create, or select a configured GLB digest from scene_asset_catalog and use scene_create_asset. Pass its sessionId to work on several open scenes; without it the last used scene is used. Inspect stable IDs and save a checkpoint before editing. Apply small batches with the current expectedRevision and check committed, revision and renderSucceeded. A committed edit can have a separate renderError; do not retry it with an old revision.'+branchInstructions+' Pass labels: true to scene_look or scene_review to match part names to the image. Use scene_look to judge the actual image, or scene_review with the current expectedRevision to compare independent camera and motion samples in one grid while preserving the source pose. When jobs are configured, scene_render_submit captures an immutable snapshot. Poll scene_render_status, cancel when needed, and retrieve verified local artifact metadata with scene_render_result after completion. Preview rendering and edits pause during a job; source revision and checkpoints survive. Release outputs with scene_render_release. Export the final recipe and dispose the scene when finished. No arbitrary JavaScript, remote URLs or caller-selected output paths are exposed.'+selectedToolsInstructions(selectedTools)+(newerVersion ? updateNoticeText(newerVersion) : ''),
  });
  let closePromise;
  server.server.onclose = () => {
    closePromise ??= Promise.resolve().then(() => runtime.close());
    closePromise.then(
      () => console.error('Crucible preview resources closed.'),
      error => console.error(`Crucible runtime cleanup failed: ${error.message}`),
    );
  };
  // A call that leaves sessionId out means the last used scene. A stale, evicted or invented ID is still
  // rejected by the runtime: acting on a scene the caller did not name could edit the wrong one.
  function withActiveSession(argumentsValue, inputSchema) {
    const takesSession = inputSchema.shape !== undefined && 'sessionId' in inputSchema.shape;
    if (!takesSession || argumentsValue.sessionId !== undefined) {
      return argumentsValue;
    }
    const activeSessionId = runtime.activeSessionId();
    return activeSessionId ? { ...argumentsValue, sessionId: activeSessionId } : argumentsValue;
  }
  const registeredTools = new Map();
  function isToolSelected(name) {
    return !selectedTools || selectedTools.includes(name);
  }
  function register(name, description, inputSchema, annotations, run, extraConfig = {}) {
    const registeredTool = server.registerTool(name, { title: TOOL_TITLES[name], description, inputSchema, annotations: { title: TOOL_TITLES[name], ...annotations }, ...(OUTPUT_SCHEMAS[name] ? { outputSchema: OUTPUT_SCHEMAS[name] } : {}), ...extraConfig }, async argumentsValue => {
      const call = async () => {
      try {
        return await run(withActiveSession(argumentsValue, inputSchema));
      } catch (error) {
        const message = withVersionHint(readableErrorMessage(error), version);
        const sceneMissing = CREATE_TOOLS.has(name);
        return { isError: true, content: [{ type: 'text', text: `${name} failed: ${message}${sceneMissing ? ` ${SCENE_NOT_CREATED_ADVICE}` : ''}` }] };
      }
      };
      return logCall ? logCall(name, call) : call();
    });
    registeredTools.set(name, registeredTool);
    return registeredTool;
  }
  const capabilitiesTopic = z.union([z.string().min(1).max(64), z.array(z.string()).max(MAX_TOPICS_PER_CALL)]).optional().describe('A name, name.branch (meshEdit.bevel) or a list of up to 8. Omit for the index.');
  register('scene_capabilities', 'Index of supported recipe features and runtime budgets; pass topic for the detail of one. Read it before authoring. Does not launch a browser.', z.strictObject({ topic: capabilitiesTopic, response_format: responseFormatField }), readOnly, async ({ topic, response_format }) => {
    const answer = answerCapabilities(relations ? await runtime.capabilities() : withoutRelationsAdvice(await runtime.capabilities()), topic, outlineSources);
    const shown = chosenFormat('scene_capabilities', response_format) === 'concise' ? conciseCapabilities(answer) : answer;
    // Once per server: the first answer carries the update offer, later ones stay unchanged.
    const pendingUpdate = updateReported ? null : updateAvailable();
    updateReported = updateReported || pendingUpdate !== null;
    return jsonResult(pendingUpdate === null ? shown : { ...shown, updateAvailable: pendingUpdate });
  });
  register('scene_create', 'Create a render scene from a JSON recipe; the result has its sessionId. Several scenes stay open; past the cap the least recently used one is closed.', z.strictObject({ recipe: relations ? recipe : recipeWithoutRelations }), { ...edit, destructiveHint: false }, async argumentsValue => jsonResult(await runtime.create(argumentsValue)));
  register('scene_asset_catalog', 'List content-bound GLB, BVH motion capture, image, HDRI and look IDs from the asset directory and installed packs. pack with recipe or material reads that item. No paths or downloads; scene_capabilities packs.', z.strictObject({ pack: packName.optional(), recipe: packName.optional(), material: packName.optional() }), readOnly, async argumentsValue => jsonResult(await runtime.assetCatalog(argumentsValue)));
  register('scene_create_asset', 'Create the active scene from a catalog GLB and editable asset recipe. Preserves supported maps, skins, morphs and clips. The result has its sessionId.', z.strictObject({ recipe: assetRecipe, checkMesh: z.boolean().optional() }), { ...edit, destructiveHint: false }, async argumentsValue => jsonResult(await runtime.createAsset(argumentsValue)));
  register('scene_inspect', 'Read revision, counts and selected nodes. For a recipe with physics, the result lists body final positions, resting times, contacts and sensor enter/leave events. Bounds describe authored geometry rather than shader displacement.', z.strictObject({ ...sessionFields, ids: z.array(identifier).max(4096).optional().describe('Selected node IDs; an imported node means its parts and those below. Omit to inspect scene order.'), kind: z.enum(['meshes', 'hierarchy']).optional().describe('Imported assets only: hierarchy exposes stable source-node IDs and joints.'), offset: z.number().int().min(0).max(4096).optional().describe('Imported assets only: pagination offset.'), limit: z.number().int().min(1).max(4096).optional().describe('Maximum returned node records. Defaults to 64.'), includeBounds: z.boolean().optional().describe('Include world geometry bounds. Defaults to false.'), path: z.record(z.string(), z.unknown()).optional().describe('Walking route over a ground node, around holes: fields in scene_capabilities navigation.'), profile: z.boolean().optional().describe('Add ms per frame, draw calls, triangles, texture bytes; scene_capabilities profile.'), profileFrames: z.number().int().min(1).max(120).optional().describe('Frames to time, default 30.') }), readOnly, async argumentsValue => jsonResult(await runtime.inspect(argumentsValue)));
  register('scene_walkmap', 'Walkable map on a grid: rows of . walkable, x blocked, # no surface. keepOut (m) avoids obstacles. assetId: query a big catalog GLB, no render.', z.strictObject({ ...sessionFields, assetId: z.string().regex(/^[a-f0-9]{64}$/).optional(), min: z.tuple([z.number(), z.number()]), max: z.tuple([z.number(), z.number()]), cellSize: z.number().min(0.05).default(1), clearance: z.number().min(0).default(2), keepOut: z.number().min(0).optional(), streetY: z.number().optional(), includeCells: z.boolean().optional() }), readOnly, async argumentsValue => jsonResult(await runtime.walkMap(argumentsValue)));
  register('mesh_inspect', 'Check recipe geometries as polygon meshes: vertex, edge and face counts, triangles/quads/n-gons, connected and closed parts, face tags (top, bottom, side, left, right, front, back), bounds, and lint problems (non-manifold, inconsistent winding, inverted, degenerate, open, loose) with a suggested fix each. Also imported asset parts (mesh-0). Read-only and cached per geometry.', z.strictObject({ ...sessionFields, geometry: identifier.optional().describe('One geometry ID to check, as in mesh_edit.'), geometries: z.array(identifier).min(1).max(16).optional().describe('Geometry IDs to check. Omit both to check the first 16 geometries.') }), readOnly, async ({ geometry: geometryId, geometries, ...rest }) => jsonResult(await runtime.inspectMeshes({ ...rest, ...(geometries || geometryId ? { geometries: [...(geometries ?? []), ...(geometryId ? [geometryId] : [])] } : {}) })));
  register('mesh_edit', 'Append edits to a recipe mesh geometry or an imported asset part such as mesh-0 (or replace its edit log), atomically like scene_apply: extrude, inset, delete, flip, translate with falloff, tag, loop cut, bevel, mirror, array, solidify, UV unwrap, set_position and displace with field expressions (math, noise, attributes), booleans with a primitive cutter, sculpt brush strokes and shrinkwrap onto a primitive. Edits that select no faces or break limits fail without changing the scene. Returns the new revision, render status and the mesh report with per-edit results.', z.strictObject({ ...sessionFields, expectedRevision, geometry: identifier.describe('ID of a geometry with type mesh, or an imported part such as mesh-0.'), edits: meshEdits.min(1), replace: z.boolean().optional().describe('Replace the whole edit log instead of appending.') }), edit, async argumentsValue => jsonResult(await runtime.editMesh(argumentsValue)));
  register('mesh_stack', 'Set the non-destructive modifier stack of a recipe mesh geometry (ops and fields: scene_capabilities meshModifiers), evaluated after its edits, each prefix cached. apply: n moves the first n nodes into the edit log, as Blender\'s Apply modifier. Atomic like scene_apply. Returns the revision, render status and mesh report.', z.strictObject({ ...sessionFields, expectedRevision, geometry: identifier.describe('ID of a geometry with type mesh.'), stack: meshStack.optional().describe('The whole new stack. Omit to keep the current stack (for example with apply).'), apply: z.number().int().min(0).max(16).optional() }), edit, async argumentsValue => jsonResult(await runtime.setMeshStack(argumentsValue)));
  register('scene_apply', 'Atomically edit transforms, look, camera or materials. Procedural scenes support membership and set-motion authoring. Imported assets support set-root, set-asset-node, set-motion and absolute set-animation sampling. Successful batches increment revision once. Returns results (one entry per operation, with a warning when it changed nothing) and a diff of added, removed and changed IDs, not the node list (call scene_inspect for that).', z.strictObject({ ...sessionFields, expectedRevision, operations: z.array(relations ? operation : operationWithoutRelations).min(1).max(256).describe('Node/material/camera/root/animation commands use flat fields. Motion, look patches and add commands contain nested records. Backend validates each scene mode before publication.'), ...branchField }), edit, async argumentsValue => jsonResult(await runtime.apply(argumentsValue)));
  register('scene_look', 'Render the active scene as a bounded PNG, optionally with part labels. Optional authored motionTime seeks without changing revision; null restores the authored base pose. Omit to retain the last preview pose.', z.strictObject({ ...sessionFields, motionTime: z.number().min(0).max(3600).nullable().optional(), width: z.number().int().min(64).max(1024).default(768).describe('PNG width in pixels.'), height: z.number().int().min(64).max(1024).default(512).describe('PNG height in pixels.'), labels: labelsFlag, view: z.string().max(16).optional().describe(`${LOOK_VIEW_NAMES.join(', ')}: one channel instead of the lit image. Default beauty.`) }), readOnly, async argumentsValue => {
    const { data, mimeType, metadata: lookMetadata } = await runtime.look(argumentsValue);
    // --findings off is the benchmark control: the same look without the structured findings.
    const { diagnostics: _findings, ...metadataWithoutFindings } = lookMetadata;
    const metadata = findings ? lookMetadata : metadataWithoutFindings;
    return { content: [{ type: 'image', data, mimeType }, { type: 'text', text: JSON.stringify(metadata) }], structuredContent: metadata };
  });
  const fitVector = z.tuple([z.number(), z.number(), z.number()]);
  const fitRect = z.tuple([z.number(), z.number(), z.number(), z.number()]);
  register('scene_fit_look', 'Fit look parameters to reference colours: least squares over OKLab means of labelled regions, rendering candidates in the preview. Returns scene_apply operations and error per region before and after. The look is restored but the revision advances: use the returned one. Details: scene_capabilities topic fitLook.', z.strictObject({ ...sessionFields,
    shots: z.array(z.strictObject({ id: z.string().max(48), camera: z.strictObject({ eye: fitVector.optional(), target: fitVector.optional(), fov: z.number().optional() }).optional() })).min(1).max(4),
    regions: z.array(z.strictObject({ label: z.string().max(48), shot: z.string().max(48), rect: fitRect, exclude: z.array(fitRect).max(4).optional(), lab: fitVector, holdout: z.boolean().optional() })).min(1).max(32),
    free: z.array(z.strictObject({ parameter: z.enum(FIT_PARAMETER_NAMES), min: z.number().optional(), max: z.number().optional(), start: z.number().optional() })).min(1).max(8),
    maxIterations: z.number().int().min(1).max(8).optional(), width: z.number().int().min(64).max(512).optional(), height: z.number().int().min(64).max(512).optional() }), edit, async argumentsValue => jsonResult(await runtime.fitLook(argumentsValue)));
  const askUserTool = register('scene_ask_user', 'Open the view in the browser so the person pins points with notes; waits for Send. Use for a change hard to say in words. Returns marks with partId, point, normal, note, and the marked PNG. materialSharedWith: own material first. reviewFile: the text a review page saved, read instead of opening the browser.', z.strictObject({ ...sessionFields, reviewFile: z.string().max(16384).optional().describe('Text of the file a scene_export_web review page saved.'), prompt: z.string().max(200).optional().describe('Line shown above the picture.'), motionTime: z.number().min(0).max(3600).optional(), maxMarks: z.number().int().min(1).max(16).default(16), timeoutSeconds: z.number().int().min(10).max(900).default(300) }), askUser, async argumentsValue => {
    const { content, image, viewMeta } = await runtime.askUser(clientShowsApps ? { ...argumentsValue, inline: true } : argumentsValue);
    return { content: [...(image ? [{ type: 'image', data: image, mimeType: 'image/png' }] : []), { type: 'text', text: JSON.stringify(content) }], ...(viewMeta ? { _meta: { 'crucible/annotate': viewMeta } } : {}) };
  });
  // MCP Apps (#923): a host that advertises the extension shows the annotate view inline. The submit tool, the view resource and the
  // tool's UI link stay off until the client says so, so every other host sees the same tool list and the same browser flow as before.
  let clientShowsApps = false;
  const annotateViewResource = server.registerResource('annotate_view', ANNOTATE_VIEW_URI, { title: 'Mark the scene', description: 'Inline view for scene_ask_user.', mimeType: MCP_APPS_MIME_TYPE },
    async uri => ({ contents: [{ uri: uri.href, mimeType: MCP_APPS_MIME_TYPE, text: annotateViewHtml() }] }));
  annotateViewResource.disable();
  const submitAskUserTool = register('scene_ask_user_submit', 'Used by the inline annotate view only: send the pins the person placed. Not for the agent.', z.strictObject({
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    marks: z.array(z.strictObject({ x: z.number(), y: z.number(), note: z.string().max(280).optional() })).min(1).max(16),
    image: z.string().max(1500000),
  }), askUser, async argumentsValue => {
    const { content, image } = await runtime.submitAskUser(argumentsValue);
    return { content: [...(image ? [{ type: 'image', data: image, mimeType: 'image/png' }] : []), { type: 'text', text: JSON.stringify(content) }] };
  }, { _meta: { ui: { visibility: ['app'] } } });
  submitAskUserTool.disable();
  const previousInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    previousInitialized?.();
    if (!isToolSelected('scene_ask_user') || !clientSupportsMcpApps(server.server.getClientCapabilities())) return;
    clientShowsApps = true;
    annotateViewResource.enable();
    submitAskUserTool.enable();
    askUserTool.update({ _meta: { ui: { resourceUri: ANNOTATE_VIEW_URI } } });
  };
  register('scene_review', 'Compare one to four independent camera or motion samples in one labeled PNG grid. Preserves source revision, transient pose, viewport and checkpoints. Omitted motionTime restores authored base pose; omitted animation uses the authored asset clip pose; rendererTime defaults to the shot motionTime (or animation time), else zero. No render job store is required. wedge replaces shots: one picture per value of a parameter (target environment, effects, shadow or a material ID; topic wedge).', z.strictObject({
    ...sessionFields, expectedRevision,
    width: z.number().int().min(64).max(480).optional(),
    height: z.number().int().min(64).max(480).optional(),
    labels: labelsFlag,
    checks: z.literal('realism').optional().describe('realism: pass or fail list with fixes.'),
    response_format: responseFormatField,
    shots: z.array(z.strictObject({
      label: z.string().max(48).optional(),
      ...reviewBranchField,
      camera: z.strictObject(coreOf(cameraFields, REVIEW_CAMERA_FIELDS)).optional(),
      animation: z.strictObject({ clip: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), time: z.number().min(0).max(3600) }).optional(),
      motionTime: z.number().min(0).max(3600).nullable().optional(),
      rendererTime: z.number().min(0).max(3600).optional(),
    })).min(1).max(4).optional(),
    wedge: z.strictObject({ target: z.string().max(128), parameter: z.string().max(64), values: z.array(z.unknown()).min(2).max(8) }).optional(),
  }), readOnly, async ({ response_format, ...reviewInput }) => {
    const { data, mimeType, metadata } = await runtime.review(reviewInput);
    const shown = chosenFormat('scene_review', response_format) === 'concise' ? conciseReview(metadata) : metadata;
    return { content: [{ type: 'image', data, mimeType }, { type: 'text', text: JSON.stringify(shown) }], structuredContent: shown };
  });
  register('scene_checkpoint', 'Save a private recipe snapshot. Up to 16 are kept per scene; past that the oldest is evicted.', z.strictObject(sessionFields), { ...edit, destructiveHint: false }, async argumentsValue => jsonResult(await runtime.checkpoint(argumentsValue)));
  register('scene_restore', 'Restore a checkpoint atomically using the current revision. The checkpoint remains available and revision increments. Pass exactly one of checkpointId, revision or branch. With revision (last 4 kept), undo with no checkpoint. With branch, keep that branch (one revision) and drop all branches.', z.strictObject({ ...sessionFields, checkpointId: restoreCheckpointId, revision: z.number().int().min(0).optional(), ...restoreBranchField, expectedRevision }), edit, async argumentsValue => jsonResult(await runtime.restore(argumentsValue)));
  register('scene_release_checkpoint', 'Release one checkpoint slot. Released or foreign checkpoints fail.', z.strictObject(checkpointFields), destroy, async argumentsValue => jsonResult(await runtime.releaseCheckpoint(argumentsValue)));
  register('scene_export_recipe', 'Read a detached canonical JSON recipe for reproduction.', z.strictObject(sessionFields), readOnly, async argumentsValue => jsonResult(await runtime.exportRecipe(argumentsValue)));
  register('scene_export_glb', 'Write the active scene as a GLB file in the configured jobs folder, under a server-chosen name (the result has the path, byte count and SHA-256). Needs --jobs. Exports the current pose with pattern and imported textures, skins, morph weights and IK as posed, plus camera, lights and node tracks (one 30 fps clip); omitted lists what it left out (topic export); motionTime: one pose, no clip. For an imported asset, clip adds that source clip (translation, rotation, scale and morph weight tracks) on the source skeleton, which needs no animation, node overrides or motion in the scene. At most eight files are kept, oldest removed first; the GLB is at most 32 MiB.', z.strictObject({ ...sessionFields, clip: z.union([z.number().int().min(0).max(255), z.string().min(1).max(256)]).optional().describe('Imported assets only: source clip index or name, as scene_asset_catalog lists.'), motionTime: z.number().min(0).max(3600).optional().describe('Seek motion (and IK) to this time, export that pose with no clip. Leaves the preview there, like scene_look.'), maxTextureSize: z.number().int().min(1).max(4096).optional().describe('Largest texture side in pixels. Defaults to 2048.') }), edit, async argumentsValue => jsonResult(await runtime.exportGlb(argumentsValue)));
  register('scene_export_web', 'Write the scene with its game as a static web build in the jobs folder: index.html, game.json and engine/, which any static host serves with no server code. Needs --jobs and a game set with set-game. Procedural scenes only; the newest four builds are kept. review: true writes a page of the current view for a person to pin on a phone instead (no game); read its saved file with scene_ask_user reviewFile.', z.strictObject({ ...sessionFields, title: z.string().max(64).optional().describe('Page title.'), review: z.boolean().optional() }), edit, async argumentsValue => jsonResult(await runtime.exportWeb(argumentsValue)));
  register('scene_dispose', 'Dispose the active scene and its checkpoints, releasing renderer resources.', z.strictObject(sessionFields), destroy, async argumentsValue => jsonResult(await runtime.dispose(argumentsValue)));
  register('scene_render_submit', 'Start one asynchronous snapshot job in the configured private job store. Requires the current revision. Temporarily leases the preview renderer; does not change source revision or checkpoints.', z.strictObject({ ...sessionFields, expectedRevision, settings: renderSettings }), { ...edit, destructiveHint: false }, async argumentsValue => jsonResult(await runtime.submitJob(argumentsValue)));
  register('scene_render_status', 'Read render job state and durable frame progress. Terminal states are completed, cancelled, failed and interrupted.', z.strictObject(jobWithFormatFields, { error: jobKeysHint('scene_render_status', Object.keys(jobWithFormatFields)) }), readOnly, async ({ response_format, ...jobInput }) => {
    const record = await runtime.jobStatus(jobInput);
    return jsonResult(chosenFormat('scene_render_status', response_format) === 'concise' ? conciseJobStatus(record) : record);
  });
  register('scene_render_cancel', 'Request cancellation of one job. Poll status until terminal before using the preview again.', z.strictObject(jobFields, { error: jobKeysHint('scene_render_cancel', Object.keys(jobFields)) }), { ...edit, idempotentHint: true }, async argumentsValue => jsonResult(await runtime.cancelJob(argumentsValue)));
  register('scene_render_result', 'Read completed local output paths, MIME types, byte counts, SHA-256 digests and measured render metrics. Attaches each PNG of a job of up to 8 (images: false for paths only, or indexes of frames) and a resource link per file; video stays on disk.', z.strictObject(jobResultFields, { error: jobKeysHint('scene_render_result', Object.keys(jobResultFields)) }), readOnly, async ({ response_format, images, ...jobInput }) => {
    const result = await runtime.jobResult(jobInput);
    return renderResultContent(result, chosenFormat('scene_render_result', response_format) === 'concise' ? conciseJobResult(result) : result, { images });
  });
  register('scene_render_release', 'Delete the owned files and record for a terminal job, freeing store quota. Active jobs must be cancelled first.', z.strictObject(jobFields, { error: jobKeysHint('scene_render_release', Object.keys(jobFields)) }), destroy, async argumentsValue => jsonResult(await runtime.releaseJob(argumentsValue)));
  // Removed after registration so every schema is still built the same way and the default list stays byte-identical.
  for (const [name, registeredTool] of registeredTools) {
    const selected = INTERNAL_TOOLS.has(name) ? isToolSelected('scene_ask_user') : isToolSelected(name);
    if (!selected) registeredTool.remove();
  }
  return server;
}

export async function runCheckUpdateCli({ version = packageMetadata.version } = {}) {
  console.log(await describeUpdateCheck({ currentVersion: version }));
}

export const ACCEPTED_CLI_OPTIONS = MCP_OPTION_NAMES;

export async function runMcpCli({ argumentsValue = process.argv.slice(2),
  previewUrl = new URL(/* @vite-ignore */ '../build/mcp/preview.js', import.meta.url), version = packageMetadata.version } = {}) {
  const options = { backend: 'gpu', memory: 192 };
  const allowedAddonNames = [];
  for (let index = 0; index < argumentsValue.length; index += 2) {
    const name = argumentsValue[index];
    const value = argumentsValue[index + 1];
    if (!MCP_OPTION_NAMES.includes(name) || value === undefined) {
      throw new Error(`Use ${mcpOptionSummary()}. Run crucible-mcp --help for the same list.`);
    }
    if (name === '--allow-addon') allowedAddonNames.push(value);
    else options[name.slice(2)] = name === '--memory' || name === '--max-asset-bytes' ? Number(value) : value;
  }
  options.packs = resolvePacksOption(options.packs);
  options.gpuQueue = createGpuQueueFromFlags({ queue: options['gpu-queue'], wait: options['gpu-queue-wait'] });
  delete options['gpu-queue'];
  delete options['gpu-queue-wait'];
  const addonSet = resolveAddons({ folder: options.addons, names: allowedAddonNames, version });
  for (const { name, reason } of addonSet.skipped) console.error(`Crucible addon ${name} skipped: ${reason}`);
  options.addons = addonSet;
  const selectedTools = parseToolSelection(options.tools);
  delete options.tools;
  for (const flag of ['branches', 'relations', 'findings']) {
    if (options[flag] !== undefined && !['on', 'off'].includes(options[flag])) {
      throw new Error(`--${flag} must be on or off, got "${options[flag]}".`);
    }
  }
  if (options['max-asset-bytes'] !== undefined) {
    configureAssetByteLimit(options['max-asset-bytes']);
    options.maxAssetBytes = options['max-asset-bytes'];
    delete options['max-asset-bytes'];
  }
  if (!['cpu', 'gpu'].includes(options.backend)) {
    throw new Error('Backend must be cpu or gpu.');
  }
  const maximumMemory = maximumMemoryMiB(totalmem());
  if (!Number.isInteger(options.memory) || options.memory < 32 || options.memory > maximumMemory) {
    throw memoryRangeError(options.memory, maximumMemory);
  }
  // Checked here, not in the runtime factory: the SDK calls the factory only when the first client connects.
  options.jobs = resolveJobRoot(options.jobs);
  const { createAgentRuntime, validateLaunchPaths } = await import('./agent-runtime.mjs');
  validateLaunchPaths(options);
  setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  // Add-explosion bakes take about 5 s a process; a cache folder lets the next process read them instead (#1768).
  const bakeCache = bakeCacheDirectory();
  if (bakeCache) setExplosionBakeStore(createExplosionBakeCache(bakeCache));
  // Not awaited: the check fills in while the client connects and never delays or fails the start.
  const updateCheck = startUpdateCheck({ currentVersion: version });
  // Test-only: answers for scene_ask_user from a file, set by whoever starts the server (#1956). Read once, here.
  const askUserFixture = loadAskUserFixture();
  if (askUserFixture) console.error(describeAskUserFixture(askUserFixture));
  const handle = serveStdio(() => createAgentMcpServer(createAgentRuntime({ ...options, previewUrl, askUserFixture }), { version, tools: selectedTools, branches: options.branches !== 'off', relations: options.relations !== 'off', findings: options.findings !== 'off', updateAvailable: updateCheck.current }), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 2 * 1024 * 1024 }),
    onerror: error => console.error(`Crucible MCP error: ${error.message}`),
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => handle.close().catch(error => console.error(`Crucible shutdown failed: ${error.message}`)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMcpCli().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
