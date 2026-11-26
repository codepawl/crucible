import { LOOK_VIEW_NAMES } from './look-views.js';
import { VIEW_TRANSFORM_NAMES, LOOK_NAMES } from './view-transform-names.js';
import { BUNDLED_ENVIRONMENT_NAMES, BUNDLED_CUBE_LOOK_NAMES } from './look-catalog.js';
import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from './light-limits.js';
import { BVH_LIMITS } from './bvh-limits.js';
import {
  MESH_EDIT_OPERATIONS, MAX_MESH_EDITS, MAX_SELECTED_ELEMENTS, STACK_OPERATIONS, MAX_STACK_NODES,
  FIELD_OPERATOR_NAMES, FIELD_ATTRIBUTES, MAX_FIELD_NODES, MAX_FIELD_DEPTH, MAX_FIELD_ELEMENTS, INSTANCE_SOURCES, MAX_INSTANCE_CANDIDATES,
  IMPORTED_MESH_EDIT_LIMITS,
} from './mesh-operations.js';
import { MATERIAL_PATTERN_TYPES, MATERIAL_MAPPINGS, MATERIAL_GRAPH_OUTPUTS, MATERIAL_GRAPH_OPERATORS, MESH_MAP_NAMES, SURFACE_OUTPUTS, SURFACE_SPACES, MATERIAL_GRAPH_LIMITS } from './material-name-lists.js';
import { CURVE_TEXT_LIMITS } from './curve-text-limits.js';
import { LIGHTING_SETUP_NAMES } from './lighting-setup-names.js';
export { MATERIAL_PATTERN_TYPES, MATERIAL_MAPPINGS, MATERIAL_GRAPH_OUTPUTS, MATERIAL_GRAPH_OPERATORS, MESH_MAP_NAMES, SURFACE_OUTPUTS, SURFACE_SPACES, MATERIAL_GRAPH_LIMITS, CURVE_TEXT_LIMITS, LIGHTING_SETUP_NAMES };
import { MATERIAL_LAYER_FIELDS, MATERIAL_LAYER_SCALAR_RANGES, MATERIAL_LAYER_COLOR_RANGES } from './material-layers.js';

// What agent scenes support and their default limits, as plain data. The MCP server reads these without bundling
// the scene engine (geometry, three.js decoders, the mesh core), which runs in the preview page instead.

export const AGENT_SCENE_DEFAULT_LIMITS = Object.freeze({
  maxNodes: 4096, maxDepth: 256, maxGeometries: 256, maxMaterials: 256,
  maxVertices: 250_000, maxGeometryBytes: 32 * 1024 * 1024,
  maxOperations: 256, maxCheckpoints: 16, maxRecipeBytes: 1024 * 1024,
});

// The values of the water presets (src/world-material-shader.js holds the same numbers; a test keeps them in step), written out
// here so the capabilities do not pull the shader addon into every agent scene.
const WATER_PRESETS_SUMMARY = Object.freeze({
  lake: Object.freeze({ absorption: Object.freeze([0.35, 0.07, 0.04]), turbidity: 0.02 }),
  sea: Object.freeze({ absorption: Object.freeze([0.4, 0.06, 0.02]), turbidity: 0.1 }),
  river: Object.freeze({ absorption: Object.freeze([0.8, 0.9, 1.6]), turbidity: 0.75 }),
});

// What each recipe material layer does, beside its range; the MCP schema keeps one short line per field.
const MATERIAL_LAYER_NOTES = Object.freeze({
  toonEdge: 'Toon step edge: 0 soft, 1 hard, 2 hard with Bayer 4x4 dither; needs toon.',
  clearcoat: 'Lacquer lobe over the base, surface tag.',
  clearcoatRoughness: 'Coat roughness.',
  transmission: 'Refracts the opaque scene behind it, surface or liquid tag, blurred by roughness; a blended glass keeps its alpha as coverage; an additive part wholly behind the glass is drawn first, so the glass refracts it and dims it only by its own transmittance; no anisotropy, iridescence, sheen or coat.',
  thickness: 'Metres crossed; 0 does not bend the view.',
  ior: 'Glass 1.5, water 1.33, diamond 2.42; sets the base reflectance.',
  dispersion: 'Colour fringes through glass, 20 over the Abbe number; diamond 0.36; path traced only.',
  attenuationColor: 'Linear RGB kept after attenuationDistance.',
  attenuationDistance: 'Metres to reach attenuationColor; omit for none.',
  sheenColor: 'Linear RGB glow at grazing angles; black is off.',
  sheenRoughness: 'Glow width.',
  specular: 'Non-metal reflection, 1 is normal.',
  specularColor: 'Linear RGB tint.',
  anisotropy: 'Stretches highlights along the grain; the grain follows the UV direction, or rings the up axis without UVs.',
  anisotropyRotation: 'Turns the grain around the normal, radians.',
  iridescence: 'Thin-film colour shift on reflections.',
  iridescenceIor: 'Film index of refraction.',
  iridescenceThickness: 'Film nanometres; colours cycle as it grows.',
  softEdge: 'Fades alpha toward the silhouette by the facing cosine to this power, so a translucent sphere reads as a soft round blob with no edge (dust, haze); 0 off. Pair with opacity and an unlit tag.',
  toon: 'Light steps (toon); 0 off. Add toonColors, one linear [r,g,b] (0-4) per step from darkest to lightest and as many as toon, to give each step its own colour; the side facing away from the light shows ambient.',
});

// Recipe physics body shapes, the one list the validator, the MCP schema and scene_capabilities share.
export const PHYSICS_BODY_SHAPES = Object.freeze(['box', 'ball', 'capsule', 'cylinder', 'cone', 'convex', 'trimesh', 'compound']);
export const MAX_MATERIAL_PATTERNS = 16;
export const CURVE_TEXT_DETAILS = Object.freeze({
  curve: 'bends along path, 2-64 points [x,y,z] (Catmull-Rom); the coordinate along axis (x) is the distance from the path start, so model from 0.',
  splines: 'Geometry curve takes points (kind bezier|poly|nurbs, closed; nurbs also weights, order 2-8 default 4, and for open splines knotMode clamped|uniform or knots: point count plus order values that never decrease), or shape {type arc|spiral|star} (arc: radius, startAngle, sweep radians, segments; spiral: rotations, startRadius, endRadius, height, pointsPerRotation, reverse; star: points, innerRadius, outerRadius, innerTwist), or splines: up to 64 of those in one mesh. trim {start, end, length}: factors 0-1 of the arc length, or lengths when length is true; a trimmed curve is open. grow {name, steps 2-16, value}: morph targets of the curve grown step by step; animate with a motion track { kind: "morph", id: <name>, property: "weight", keyframes 0-1 } so a vine grows. See docs/modeling.md.',
  sdf: 'Geometry sdf: root is a tree meshed by surface nets, resolution 4-128 cells along the longest side (default 32). Primitive {shape sphere|box|roundBox|capsule|cylinder|torus, radius, size, height, tubeRadius, position, rotation (Euler radians), scale (uniform)}. Operation {op union|subtract|intersect, smooth (blend radius), children: 2-16} (subtract removes the rest from the first) or {op offset, distance, child}. At most 64 nodes, 8 levels. See docs/modeling.md.',
  text: 'Extruded text, baseline y=0 along +X, facing +Z. text (\n for lines), size (1), depth (0.2), align left|center|right, curveSegments, font. See docs/modeling.md.',
});
export const MATERIAL_GRAPH_NODES = Object.freeze({
  outputs: 'color (linear RGB; a number is grey), roughness, metallic, emission (defaults to 1), height (normal map), opacity (alpha), clearcoat, transmission (masks), aov (linear RGB or scalar).',
  textures: Object.freeze({
    noise: '{"noise":{"scale":8,"seed":1,"octaves":4,"kind":"fbm"|"ridged"|"billow","lacunarity":2,"gain":0.5}} kind: fbm soft clouds (default), ridged sharp crests for rock, mountains and veins, billow rounded hills; lacunarity 1-4 is the frequency step per octave, gain 0-1 the amplitude step (Blender Roughness).',
    voronoi: '{"voronoi":{"scale":6,"jitter":1,"output":"distance"|"edge"|"cell"|"f2"|"f2MinusF1"|"smoothF1","smoothness":1}} distance is F1 (nearest point); f2MinusF1 (same as edge) is 0 on the line between cells: cracks, cobble joints, dry mud; f2 the second nearest point; smoothF1 is F1 with soft seams for organic blobs and scales (smoothness 0-1, only with smoothF1); cell a random value per cell. jitter 0-1 is how far points stray from cell centres: 0 a regular grid, 1 the default.',
    wave: '{"wave":{"frequency":4,"direction":"u"|"v"|"diagonal","shape":"sine"|"saw"|"triangle"}}',
    checker: '{"checker":{"count":8}} (even)',
    gradient: '{"gradient":{"type":"u"|"v"|"radial"}}',
    whiteNoise: '{"whiteNoise":{"scale":16,"seed":1,"output":"value"|"color"}} one random value per cell, tiles.',
    image: '{"image":{"asset":"<64 hex catalog image asset ID>","output":"color"|"alpha"|"r"|"g"|"b"|"luminance"}} bilinear, repeats; color is linear RGB, decoded from sRGB; alpha, r, g, b and luminance are numbers read as stored (0 to 1), so a greyscale roughness, metallic or AO map feeds roughness directly. The host decodes catalog images (scene_asset_catalog); no URLs.',
    brick: '{"brick":{"columns":8,"rows":4,"mortar":0.05,"offset":0.5,"seed":1,"output":"mortar"|"edge"|"cell"}} running bond; rows even.',
    note: 'Each takes "at", a vector such as {"uv":"both"}, and "warp": {"node":n,"strength":0-4}, which moves the lookup by (n - 0.5) * strength tiles: a number moves u and v together, a vector (such as {"vec":[noiseA,noiseB,0]}) moves u by its first part and v by its second. Warp a wave or a noise by a noise for marble and flowing rock. Scales are whole numbers 1-64 (noise and voronoi up to 1024 when the bake resolution is at least 4 times the scale).',
  }),
  uv: '{"uv":"u"|"v"|"both"} coordinates.',
  coordinates: '{"coord":"generated"|"object"|"world"} vector of where the texel sits: generated is the unit tile, object and world are metres across the tile (u * size); the third axis is 0 because a baked texture is projected. {"mapping":{"vector":node,"scale":n|[x,y,z],"offset":[x,y,z],"rotate":radians}} scales, turns around Z and moves a vector (default: generated). Feed either to "at". Meshes without UVs use box mapping; vertex_color already multiplies the baked colour. In graphs: fresnel, only as an emission factor. Mesh data per pixel (curvature, AO, thickness): meshMap; slope and height: surface.',
  ramp: '{"ramp":{"value":node,"stops":[[0,[r,g,b]],[1,[r,g,b]]]}} 2-8 stops rising from 0 to 1.',
  fresnel: '{"fresnel":{"ior":1.5}} ior 1.01-3. View dependent, so only as a factor of emission, alone or {"mul":[node,{"fresnel":{...}}]}: emission rises toward grazing angles, rendered per pixel by the rasterizer and the CPU path tracer.',
  surface: '{"surface":{"output":"slope"|"normalY"|"height","space":"world"|"object","range":[low,high]}} a number 0-1 from the mesh surface at each texel, baked into UV space like vertexGroup. slope is the angle from straight up as a share of a right angle: 0 on a flat surface facing up, 1 on a wall and under an overhang (snow: make it the mask of a layer). normalY is the up part of the normal, 0 down, 0.5 wall, 1 up. height is the up position from the bottom to the top of the mesh, or between range [low, high] metres (height only; the default is the whole mesh). space defaults to world, so a rock turned on its side still has snow on top; object uses the mesh as modelled. world places the mesh with the world matrix of the part when the scene is built, so it is baked, not live: move the part and build again to update it. Needs pattern mapping "uv" and a mesh with UVs; every backend reads the baked texture. A material used on two meshes bakes once per mesh. One texel covers a lot of ground on a mesh as large as a mountain and the edge of a mask shows stair steps: gate the layer with material.surfaceCover instead (materialSurfaceCover), which works the mask out per pixel.',
  base: '{"base":{"output":"color"|"roughness"|"metallic"|"normal"}} the own texture of the placed scan at the texel UV; only in asset.pattern or asset.materials[].pattern, where unwritten outputs keep the scan texture. color and normal are vectors, roughness and metallic numbers.',
  meshMap: '{"meshMap":{"name":"curvature"|"ao"|"thickness"}} a number 0-1 baked per texel from the mesh itself, so it is as fine as the texture and not as coarse as the vertices: curvature is 0.5 flat, up to 1 on a convex edge, down to 0 in a concave one, measured in 3D so a UV seam does not split a bevel (edge wear); ao is the share of rays above the surface that hit the mesh (cavity dirt); thickness is how far rays below the surface travel inside the mesh, 0 thin to 1 thick (translucency). Needs pattern mapping "uv" and a mesh with UVs. Mixes with noise, ramps and layers; every backend reads the baked texture. A material used on two meshes bakes once per mesh.',
  vertexGroup: '{"vertexGroup":{"name":"edge"}} a number 0-1: the weight of that vertex group of the mesh, drawn into UV space and read at the texel, so it mixes with noise, ramps and layers. Needs pattern mapping "uv" and a mesh with UVs and the group (make it with a vertex_group mesh edit); every backend reads the baked texture. A material used on two meshes bakes once per mesh.',
  mixing: '{"layer":{"base","top","mask","edge","softness"}}; {"hue":{"color","shift","saturation","value"}}; {"curve":{"value","points":[[x,y]]}}.',
  maths: 'add sub mul div min max pow take [a,b]; abs floor fract sqrt invert take one node; clamp smoothstep mix take [a,b,c]; {"vec":[r,g,b]}.',
  mapping: 'box (default) projects along object axes, no UVs; uv follows geometry UVs. size and axis only apply to box.',
});

// mask cuts out where the base colour map alpha is under alphaCutoff (default 0.5).
export const RECIPE_ALPHA_MODES = Object.freeze(['opaque', 'mask', 'blend', 'add']);

// Named lighting setups (see lighting-setups.js) and the occlusion strength that recipes get when they set none.
export const DEFAULT_LIGHTING_SETUP = 'daylight';
export const DEFAULT_AMBIENT_OCCLUSION = 0;

// Render passes a render job can write next to the lit image (see RENDER_PASS_MODES in render-passes.js, which lists the same names, wireframe being drawn as its diffuse mode).
export const RENDER_PASS_NAMES = Object.freeze(['albedo', 'normal', 'emission', 'depth', 'objectId', 'diffuse', 'glossy', 'shadow', 'ao', 'mist', 'position', 'velocity', 'uv', 'transmission', 'volume', 'environment', 'cryptomatte', 'aov', 'roughness', 'metallic', 'lighting', 'wireframe']);
// Video encoders a render job can choose (nvenc is h264_nvenc and fails the job when the GPU or ffmpeg lacks it), the
// longest video, and the audio file names a job may mix in from the --audio folder: one path segment with a known
// extension, no drive or protocol syntax.
export const VIDEO_ENCODERS = Object.freeze(['cpu', 'nvenc']);
export const MAXIMUM_VIDEO_SECONDS = 60;
// File formats of an image or stills job (8-bit PNG by default, 16-bit PNG, OpenEXR) and the highest video frame rate.
export const RENDER_OUTPUT_FORMATS = Object.freeze(['png', 'png16', 'exr']);
export const MAXIMUM_JOB_FPS = 60;
export const MAXIMUM_JOB_FRAMES = 900;
// Frames one stills job may write when it sets `frames`; a longer clip is rendered in parts with motion.start.
export const MAXIMUM_STILLS_FRAMES = 300;
/** Recipe bake presets and ranges. A bake inline on the page fails the edit after 20 s, before the 30 s page deadline; on a worker it has 90 s. */
export const BAKE_PRESETS = Object.freeze({
  draft: Object.freeze({ samples: 32, bounces: 1, texelsPerUnit: 3 }),
  standard: Object.freeze({ samples: 128, bounces: 3, texelsPerUnit: 6 }),
  // An alias of standard: measured on the five reference rooms, no samples and density mix within the 20 s limit scored better (bench/reference/README.md).
  fine: Object.freeze({ samples: 128, bounces: 3, texelsPerUnit: 6 }),
});
export const BAKE_RANGES = Object.freeze({ samples: [1, 256], bounces: [1, 8], texelsPerUnit: [1, 12] });
export const BAKE_MAXIMUM_SECONDS = 20;
/** The limit when the bake runs on a worker, which does not block the page: a busy machine still finishes a preset. */
export const BAKE_WORKER_MAXIMUM_SECONDS = 90;
/**
 * Path steps (texels x samples x bounces) a preset is scaled down to. Measured at 1.8 to 3.1
 * microseconds per path step on a closed 56 part room and the 57 node demo room, so this is 9 to 16 s, under the 20 s limit. The two rooms cost
 * the same per path step, so the budget does not depend on the number of lights.
 */
export const BAKE_PRESET_PATH_WORK = 5_000_000;
/**
 * The hard upper bound on path steps for explicit samples, bounces and texelsPerUnit: about 5 times the demo room at 96
 * samples, 2 bounces, texelsPerUnit 3. Below it the bake runs until BAKE_MAXIMUM_SECONDS, which fails cleanly and leaves
 * the scene unchanged.
 */
export const BAKE_EXPLICIT_PATH_WORK_LIMIT = 24_000_000;
/**
 * Render job output. An `image` job takes each side up to 3840 and never more pixels than 3840x2160 (so 2880x1620
 * fits); `stills` and `video` jobs keep each side up to 1920 and at most 1920x1080 pixels (portrait 1080x1920 fits).
 * A frame that the memory budget cannot hold at the size asked for is refused, naming the --memory it needs.
 */
export const MAXIMUM_JOB_SIDE = 3840;
export const MAXIMUM_JOB_PIXELS = 3840 * 2160;
export const MAXIMUM_SEQUENCE_JOB_SIDE = 1920;
export const MAXIMUM_SEQUENCE_JOB_PIXELS = 1920 * 1080;
// The longest side of a square frame each limit allows, so a square overlay can be sized before the submit.
export const MAXIMUM_SQUARE_JOB_SIDE = Math.floor(Math.sqrt(MAXIMUM_JOB_PIXELS));
export const MAXIMUM_SQUARE_SEQUENCE_JOB_SIDE = Math.floor(Math.sqrt(MAXIMUM_SEQUENCE_JOB_PIXELS));
/**
 * Largest --memory value in MiB the MCP server accepts. Measured: a 1920x1080 frame needs about 175 MiB of targets
 * (planRenderSize estimate, 4 samples), Node RSS peaks under 180 MiB, so 384 leaves about 200 MiB for scene textures and geometry.
 */
export const MAXIMUM_MEMORY_MIB = 384;
/** The largest --memory on any machine, however much RAM it has (#1776, #1696). */
export const MEMORY_CEILING_MIB = 4096;

/**
 * The largest --memory this machine accepts: half of its RAM, so the server never takes more than half of what the owner has,
 * bounded above by MEMORY_CEILING_MIB and below by MAXIMUM_MEMORY_MIB, which every machine accepts as before.
 * Pure: pass os.totalmem().
 */
export function maximumMemoryMiB(totalMemoryBytes) {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    throw new RangeError(`maximumMemoryMiB needs the machine's total memory in bytes (os.totalmem()), got ${totalMemoryBytes}.`);
  }
  const halfOfMemoryMiB = Math.floor(totalMemoryBytes / 2 / 1024 ** 2);
  return Math.max(MAXIMUM_MEMORY_MIB, Math.min(MEMORY_CEILING_MIB, halfOfMemoryMiB));
}

/** The --memory range error shared by the server flag check and the runtime factory, naming the machine's maximum. */
export function memoryRangeError(memory, maximumMiB) {
  return new RangeError(`memory must be an integer from 32 to ${maximumMiB} MiB on this machine (half of its RAM, at most ${MEMORY_CEILING_MIB}), got ${memory}.`);
}
/**
 * Rewrites the renderer's "Fix: pass { memoryBudgetMiB: N }." hint for a tool caller. No MCP tool takes memoryBudgetMiB: the budget
 * is the server's --memory, so the hint names what the agent can do in its call (smaller bakes, fewer textures) and what the
 * operator can do (restart with --memory N, or that N is over what this machine accepts) (#3205). Other messages pass through.
 */
export function agentMemoryBudgetMessage(message, { memory, maximumMemory }) {
  const hint = /Fix: pass \{ memoryBudgetMiB: (\d+) \}\./.exec(message);
  if (!hint) return message;
  const requiredMiB = Number(hint[1]);
  const ownCall = 'set the resolution of baked textures to 512 (1024 costs four times the bytes), use fewer textures, or remove parts';
  const operator = requiredMiB <= maximumMemory
    ? `ask the server operator to restart it with --memory ${requiredMiB} or more (now ${memory}, at most ${maximumMemory} on this machine)`
    : `--memory cannot reach ${requiredMiB} on this machine (at most ${maximumMemory})`;
  return message.replace(hint[0], `Fix: no tool call takes a memory budget; ${ownCall}, or ${operator}.`);
}
export const AUDIO_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(wav|mp3|ogg|flac)$/;

/** The error for an audio file name AUDIO_FILE_PATTERN refuses: names the value received, the rule and the fix. */
export function audioFileNameError(file) {
  const received = typeof file === 'string' ? JSON.stringify(file) : `a ${file === null ? 'null' : typeof file} value`;
  return new TypeError(`Audio file ${received} is not allowed: use a plain file name of letters, digits, ".", "_" or "-" (starting with a letter or digit, up to 64 characters) with a lower-case extension .wav, .mp3, .ogg or .flac. Rename the file in the audio folder and pass that name as settings.audio.file.`);
}
// Metres that depth pass values 0 to 65535 span, measured from the camera.
export const RENDER_PASS_DEPTH_RANGE = 100;

// Fields and defaults of the whole-mesh modifiers, which the tool schemas leave out to stay small.
export const MESH_MODIFIER_NOTES = Object.freeze({
  weld: 'distance 0.001: merge closer vertices.',
  triangulate: 'minVertices 4: split faces with that many corners or more.',
  edge_split: 'angle 30: split edges bending more than this many degrees.',
  smooth: 'factor 0.5 (-2 to 2) steps toward the neighbour mean; iterations 1 to 64.',
  simple_deform: 'mode twist or bend use angle (45 degrees), taper or stretch use factor (0.5); axis x, y or z (z).',
  cast: 'sphere about the origin: factor 0 to 1 (0.5), size radius (0 = mean vertex distance).',
  screw: 'revolves every edge about axis x, y or z (z) through the origin, dropping faces: angle 360, steps 16 (1-256) and iterations 1-64, lift 0 per iteration. A whole number of turns with no lift closes the ring.',
  wireframe: 'rim of thickness 0.02 on each face: offset -1..1 (0) moves the strut inside..outside, evenOffset true, replace true drops the faces.',
  skin: 'closed square tube per edge: radius 0.1 or a scalar field per vertex (above 0). Simple: tubes overlap, no branch solver.',
  lattice: 'divisions [2,2,2] (2-8) control points over the mesh bounds; moves up to 64 of {point:[i,j,k], offset:[x,y,z]}; trilinear blend.',
  curve: 'bends the mesh along path, 2 to 64 points [x,y,z] through a Catmull-Rom spline. The coordinate along axis (x) is the distance from the path start, the other two become offsets in a twist-free frame; past the ends the mesh continues straight. Model the mesh along the axis starting at 0.',
  hook: 'vertices within radius 1 of center [0,0,0] move by translation [0,0,0] times strength 0-1 (1); falloff smooth, linear or constant.',
  smooth_laplacian: 'smoothing that keeps a closed mesh from shrinking: factor above 0 up to 1 (0.5), iterations 1-64 (1), preserveVolume true (false is plain shrinking Laplacian), pinBoundary true keeps the rim of an open mesh, group names a vertex group that scales each vertex step.',
  warp: 'moves the vertices within radius 1 of point from toward point to, weighted by curve smooth (default), linear or constant, so the vertex at from lands on to and vertices beyond the radius stay; twist in degrees (0) also turns them about the from-to axis.',
  wave: 'a gaussian ripple of height 0.5 along z (normal true: along the vertex normal) travelling from start [0,0] over axes xy (default), x or y; width 1.5, narrowness 0-50 (1.5), speed 0.25 per frame, time 0 (a frame), timeOffset 0, cyclic true repeats it. Matches Blender Wave.',
  weighted_normal: 'corner normals weighted by face area ^ (weight/50), weight 1-100 (50), smoothed across edges under angle 30 that are not sharp. Put it last in the stack.',
  smooth_by_angle: 'edges bending over angle 30 (0-180) become sharp, others smooth, over smoothAngle; ignoreSharp true also clears hand-made sharp edges.',
  join: 'geometry (ID of a recipe geometry), matrix (16 numbers, column-major, from that geometry space into this mesh space; the identity if left out): adds its faces as a separate shell. Not in the stack.',
  bounding_box: 'becomes its axis-aligned box.',
  convex_hull: 'becomes its convex hull, up to 8192 vertices.',
  build: 'shows faces one by one as frame runs from start 0 over length 60 frames (frame 0; give the current frame, e.g. from your film clock): order index (default), random (seed 0) or axis (axis y, lowest centroid first); reverse true unbuilds. Unused vertices drop; while none shows, one zero-area triangle stays.',
  ocean: 'seeded sea: lifts axis (y) by waves of windSpeed 10 m/s (0-60) toward direction 0 deg, size 100 m (repeats), seed 0, time 0 s, resolution 8 (1-16); choppiness 1 (0-4) pulls points to crests; foam is where the surface folds (Jacobian), sized to the whitecap share of the wind W = 3.84e-6 U^3.41 (Monahan 1980); coverage 0 (-1 to 1, the foam strength knob) is that physical sea, negative keeps only the top peaks, positive multiplies the foam by 6^coverage; foamMemory 0 s by default (off, opt-in; 0-30, costs 8 extra evaluations per vertex) lets foam fade behind crests, so an oceanTime track leaves a trail. Writes group foam; spray true also writes group spray (foam where the surface rises) and the vector spray (surface velocity m/s) for particles emitter group spray + velocityFrom spray. Spray depends on time, size, resolution, windSpeed and choppiness: a sea with no spray at its time makes the emitter refuse ("no weight in vertex group spray"); a sea with an oceanTime geometry track is followed (droplets leave the crests of their birth time). A water material draws foam as lace, or as a painted shape with foamEdge hard (foamWidth 0.25-4, foamColor [r,g,b]); foamVeins {amount 0-1, scale 0.25-4} adds a net of foam veins trailing out behind the crests; contactFoam {width px, hardness, noise, drift 0-1 tears the rim and slides it with time, rim false draws no contact line, color} draws a line where blended water (alphaMode blend, any opacity) meets a hull or shore. wake {points up to 64 [x, z, strength, width], height 0.06} adds white foam and a small choppy displacement along a boat trail (physics float.boat.wake fills it).',
});

// Vertex colors and groups. Details stay here so the tool schemas stay small.
export const MESH_ATTRIBUTE_NOTES = Object.freeze({
  vertex_group: 'name (required) sets the weights 0-1 of the vertices of the selected faces; the rest keep theirs. One of weight (1), field, gradient { axis x|y|z, range [low, high], weights [atLow, atHigh] } or measure curvature (gain 0.1-16, 2; 0.5 flat, up convex), edge (angle 1-179 deg, 30; convex folds) or occlusion (rays 1-128, 32; distance m; seed). Max 32 groups. displace takes group: name and scales each move by the weight; cloth takes pinGroup. A stack node that rebuilds the mesh drops groups.',
  vertex_color: 'sets the corner colors (0-1, linear, white until set) of the selected faces. One of color [r, g, b], field (vector expression of the vertex) or gradient { axis, range [low, high], colors [[r,g,b] atLow, [r,g,b] atHigh] } or { group, colors } of 2 or 3 stops along the weights of a vertex group (edge wear: curvature group, colors [dirt, paint, metal]). Drawn, written as COLOR_0 in a GLB, and multiplies the material color.',
});

// UV projection and packing edits. Details stay here so the tool schemas stay small.
export const MESH_UV_NOTES = Object.freeze({
  uv_project: 'mode cube (each face by its dominant axis), cylinder (sides wrap around axis, caps flat) or sphere (longitude and latitude); axis x|y|z (y) for the last two, measured from the bounds centre; wrapped faces cut opposite the first radial axis. pack true (default) packs into 0..1 with one scale for every island so texel density is even; false leaves uv in mesh units for a later uv_pack. margin 0-0.2 (0.01); rotate true lays tall islands on their side. Reports islands. Texel density: cube exact, cylinder within about 15 percent, sphere stretches toward the poles.',
  uv_pack: 'repacks the islands already in uv (faces joined across edges whose two ends share uv) into 0..1 with one scale. margin 0-0.2 (0.01), rotate true. Needs uv from uv_unwrap or uv_project. Reports islands.',
});

// What an edit can select. Details stay here so the tool schemas stay small.
export const MESH_SELECTION_NOTES = `translate and transform_selection take one of select (a face rule, default every face), verts (a vertex rule such as {"vertices":[0,5]}, {"all":true} or {"inside":{min,max}}) or edges (an edge rule): the selected vertices, or both ends of the selected edges, move once each in the mesh's local space, with the same falloff. Every edge rule also takes {"edges":[[a,b],...]}: an edge named by the two vertices it joins (either order, boundary edges too). Pairs are stable where edge numbers are not. Vertex indices, in verts and in pairs, are those of the mesh just before that edit: after earlier edits, before the modifier stack. An earlier edit that adds or removes vertices (subdivide, merge_by_distance, dissolve, delete) changes the count and can renumber them, and a wrong but valid index moves another corner: after a subdivide of a box, 0 to 7 are still the corners but 8 and up are new midpoints. Out-of-range indices throw with the vertex count. A vertex or pair named twice counts once. At most ${MAX_SELECTED_ELEMENTS} vertices or pairs per selection.`;

// Shape keys on a recipe mesh. Details stay here so the tool schemas stay small.
export const MESH_SHAPE_KEY_NOTES = Object.freeze({
  shapeKeys: 'On a mesh geometry, at most 16: { name, offsets, value } or { name, edits, value }. offsets is a list of { select, offset: [x,y,z], falloff } moves like the translate edit; edits are vertex-moving mesh edits run after the stack. value (0, 0 to 1) is the weight without motion. Each key becomes a glTF morph target. Animate it with a motion track { kind: "morph", id: <key name>, property: "weight", keyframes }.',
});

// Organic shaping edits. Details stay here so the tool schemas stay small.
export const MESH_SCULPT_NOTES = Object.freeze({
  sculpt: 'strokes run in order on the vertices of the selected faces; a tag confines them. A stroke has type inflate (along the vertex normal), displace (along direction, needed) or smooth (strength 0-1), center and radius, strength in mesh units. Falloff is smooth to zero at the radius.',
  shrinkwrap: 'target is a primitive record placed by translation, rotation and scale. mode nearest (default) moves each selected vertex to the closest point; project moves it along direction (needed) to the first hit. offset (0) stands it off along the normal. maxDistance limits the search; onMiss error (default) or keep. For a decal, use enough grid cells, then solidify.',
});

// Boolean cutters on a recipe mesh. Details stay here so the tool schemas stay small.
export const MESH_BOOLEAN_NOTES = Object.freeze({
  cutter: 'A primitive or profile record such as { type: "cylinder" }, or { geometry: "<id>" } naming another recipe geometry (a mesh with its own edits and stack, or a primitive). Put translation, rotation and scale on the edit. References form a DAG: a cycle or an unknown ID fails with the chain; at most 4 cutter geometries deep and 250000 estimated cutter vertices per mesh. Editing the cutter geometry rebuilds only the meshes that name it. Imported-part edits take inline records only.',
});

export const AGENT_SCENE_CAPABILITIES = Object.freeze({
  format: 'crucible.scene', schemaVersion: 1,
  geometryTypes: Object.freeze(['box', 'cylinder', 'sphere', 'cone', 'icoSphere', 'torus', 'lathe', 'extrude', 'tube', 'curve', 'sdf', 'text', 'grid', 'plane', 'circle', 'line', 'terrain', 'cloud', 'mesh', 'fragment', 'dented', 'floorPlan']),
  camera: 'eye, target, up, near, far, then fov (vertical degrees) or focalLength (mm, with sensorWidth mm, 36; not both). projection orthographic with orthoScale (view height in m, default 4). shift [x, y] moves the frame by a fraction of its size. fStop (0.7-64) turns on depth of field focused on target; 1.4 or lower is full blur; focusDistance (m along the view axis, with fStop; default the distance to target) moves the focus plane without moving target (not the effects.focusDistance of the blur effect). effects.depthOfField.blur must stay 0. set-camera fStop null turns depth of field off (clears focusDistance); focusDistance null clears only it. roll is in radians. Orthographic/shifted cameras use the rasterizer.',
  clearing: 'null clears an optional field back to not set in set-camera (projection, orthoScale, focalLength, sensorWidth, shift, fStop, focusDistance), set-environment (ground, hdri, reflectionHdri, sunBounce, specularAntiAliasing, wetness, puddles, shadowCascades, objectReflections, floorSkyTrace, resolveCoplanar, sky, look, viewTransform and the other fields a fresh scene leaves out) and set-effects (optional post steps); clearing a field that is not set changes nothing. A field every scene has (camera eye, target, up, fov, near, far; keyIntensity, exposure, ...) cannot be cleared: null errors with the default to pass. set-effects merges bloom, depthOfField and motionBlur field by field like volumeFog; null on the group returns it to its defaults, null on motionBlur.objects removes it. fogDensity null is a value (no override).',
  cloud: 'Geometry cloud: one closed, smooth mesh of round puffs for cumulus, a wide base with a tower of smaller lobes above, the flat base at y = 0. seed 1 (whole, 0-2147483647), puffs 14 (2-48), width 10 m (0.5-2000), height 5 m (0.25-2000, measured before the base is cut), flatBase 0.6 (0 keeps a round underside, 1 cuts flattest), resolution 48 cells (16-96). levels:[{count, sizeRatio}] (1-4 levels, 1000 lobes in all, first count 1-48) grows each level of lobes on the surface of the level before, such as [{count:7,sizeRatio:1},{count:60,sizeRatio:0.35},{count:680,sizeRatio:0.12}] for a tower covered in rounded bumps; each level may add softness 0.02-1 (its own blend, a share of its lobe radius; left out it takes unionSoftness), so small cauliflower bumps can stay crisp on big soft lobes; with levels, puffs is not used, resolution is 16-160 (default 128, at most 150000 faces), upBias 0-1 (0.5; 1 never grows down) and unionSoftness 0.02-1 (0.3 of the lobe radius of each level; also blends a cloud without levels, default 0.14) apply. Normals come from the field gradient, so toon steps stay clean. The same seed gives the same bytes; toon-shade it (material toon: 3) for clean lobes.',
  floorPlan: 'Geometry floorPlan {walls:[{from:[x,z],to:[x,z],thickness?}] 1-256, openings:[{wall,offset,width?,height?,sill?,kind: door|window}] up to 256, height 2.7 m, thickness 0.2 m, part}: mitred walls on y = 0 with cut openings, a floor and ceiling per closed room and door and window presets. part all, walls, floor, ceiling, doors, windows or glass; see docs/floor-plan.md.',
  terrain: 'One mesh, x and z from -size/2 to size/2, hills about y = 0. size 40 m (1-2000), resolution 64 cells (2-499, the 250000-vertex scene cap), seed 1, amplitude 1 m (0-200), holes up to 16 of {center:[x,z],radius}, no surface inside; radius a few cells or more. Optional: featureSize m (size/4), octaves 1-8 (6), warp m (0), ridged true, mountainMask 0-1 (not with ridged), mountainAmplitude m (46); chunks 1-64 and levels 1-6 (1): resolution is per chunk, divisible by 2^(levels-1), and the mesh follows the camera at each pose. paths (up to 16, 2-256 points each) carve roads: {points:[[x,z],...], width m 3, depth m 0.2, falloff m (width), ruts m 0, crown m 0, shoulder m 0, name}. The bed is the centre-line height minus depth across the width, blending back over falloff; each path has a mask by name for splat rules (terrain.pathMasks).',
  vehicleDamage: 'Geometry dented {source, impacts:[{point, direction, impulse N s}] 1-8, stiffness 2000, maxDepth 0.25 m, radius 0.4}: the source (not a fragment or dent) pushed in around each point by min(maxDepth, impulse/stiffness); a part that comes off is a body on a fixed joint with breakImpulse. docs/vehicle.md.',
  placedAssets: 'Node field asset:{id or name,materials?,flatten?,clip?,drive?} turns a group node into a catalog GLB (id from asset_catalog, or name: its exact file name, stored as the id; give one). Its transform places it. scene_apply add-node with an asset field places the first or any later instance, so a scene need not start with its assets. materials:[{name,id?,color,metallic,roughness,opacity,emission,emissiveColor}] override source materials by name; an id (such as "stool-heat") gives that material a handle that a set-motion material track can drive: emission and emissiveColor fade a heat glow, one id per placement. emissionMask:{axis:x|y|z,from,to} (metres in the own space of the part, smooth ramp, from above to flips it) multiplies emission so the glow sits only at one end while texture and shading stay; rasterizer only, path tracers ignore it. flatten:{color?,unlit?} flattens every material of the placement in one call: unlit true draws them without lighting, color [r,g,b] paints them one colour (textures dropped), both give a flat silhouette; a named override still wins. clip:{index (number or "all": every clip together, as long as the longest),start=0,speed=1,loop=true} plays it from scene time start; set-motion tracks move the node and scene time seeks the clip. drive:{path | legs, cruiseSpeed | speed, wheels, lights} drives a car along a path in the placement frame (docs/vehicle.md). Max 512 placements, 32 different assets, 16 animated.',
  profile: 'scene_inspect profile:true draws profileFrames (1-120, default 30) real frames at the preview size and returns profile:{frames, millisecondsPerFrame (median, CPU submit plus GPU wait), millisecondsMinimum, millisecondsMaximum, drawCalls and triangles per frame (shadow and post passes included), textureBytes (all textures, splatBytes included), splatBytes, width, height, heaviestNodes:[{id,triangles,parts}] top 5}. It needs a GPU preview; without profile the answer is unchanged. Cut the heaviest nodes or textures first; read ms as a range, other work on the machine moves it.',
  askUser: 'scene_ask_user opens the current view in their browser; they pin up to maxMarks (16) points, each with a note, and press Send. Ask when a change is hard to say in words ("warmer here", "this bit"), not for facts you can inspect. Each mark returns partId, point, normal, note, distance and material (null on sky), plus view.camera and a PNG with numbered pins. Apply the change the note names to that partId, then to similar parts (same material or name prefix) when the note says so. A mark with kind "lasso" is an outline around a region: apply the note to every part in its parts list (partId, coverage, material, most covered first), and skip a part with a tiny coverage that the note does not fit. A part with materialSharedWith has that material on parts outside the mark: give it its own material before you change it. A part with edge true only grazes the outline. outcome cancelled or timeout returns no marks: ask in text. For a film scene pass motionTime to mark one moment; view.motionTime names it. Edits made while they mark change revision; the result warns.',
  navigation: 'scene_inspect path:{ground,from:[x,z],to:[x,z]} returns a route over the ground node around its holes, steep slopes and the nodes in avoid:[ids] (box footprints), as keyframes [{time,value:[x,y,z]}] for a translation track with interpolation LINEAR. radius 0.3 m; maxSlope 40 degrees; cellSize defaults to radius; seconds or speed (1.4 m/s); lift adds y.',
  meshEdits: Object.freeze({ operations: Object.freeze(Object.keys(MESH_EDIT_OPERATIONS)), maxEdits: MAX_MESH_EDITS, selections: MESH_SELECTION_NOTES }),
  meshStack: Object.freeze({ operations: STACK_OPERATIONS, maxNodes: MAX_STACK_NODES }),
  meshModifiers: MESH_MODIFIER_NOTES,
  meshSculpt: MESH_SCULPT_NOTES,
  meshAttributes: MESH_ATTRIBUTE_NOTES,
  meshUv: MESH_UV_NOTES,
  meshBoolean: MESH_BOOLEAN_NOTES,
  meshShapeKeys: MESH_SHAPE_KEY_NOTES,
  fieldExpressions: Object.freeze({
    operators: FIELD_OPERATOR_NAMES, attributes: FIELD_ATTRIBUTES,
    maxNodes: MAX_FIELD_NODES, maxDepth: MAX_FIELD_DEPTH, maxElements: MAX_FIELD_ELEMENTS,
    rotation: 'rotate [v, axis, rad]; align [dir]: Euler of +Y to dir; transform [p, move, euler, size].',
    meshShape: 'faceArea {}; edgeAngle {} (radians, 0 on a border); island {}; neighbors {read edges|faces}. Over points faceArea is the mean of the faces around. A point set has no mesh and rejects them.',
    wholeDomain: 'accumulate {value, group}; statistic {value, mode min|max|mean|sum|range, group}; blur {value, iterations 1-32, weight 0-1}; sampleIndex {value, index} (clamped); rank {value, descending} (Sort Elements index). value and group are number expressions.',
    surfaces: 'nearest {surface, at, read distance|point|normal}; raycast {surface, at, direction, read hit|distance|point|normal, miss}. at defaults to position; rays go forward. surface: geometry id (instances where) or record (mesh edits). attr group + name reads a vertex group.',
  }),
  instancing: Object.freeze({
    sources: INSTANCE_SOURCES, maxCandidatePoints: MAX_INSTANCE_CANDIDATES,
    place: 'place {at vertices|faces, spacing, density 0-1, variants [id|{geometry, material}], variant, rotation Euler, size}; the last are fields.',
  }),
  operations: Object.freeze([
    'set-node', 'set-material', 'set-camera', 'add-node', 'remove-node',
    'add-geometry', 'remove-geometry', 'add-material', 'remove-material',
    'set-environment', 'set-effects', 'set-shadow', 'set-motion', 'set-armatures', 'set-physics', 'set-cloth', 'set-timeline', 'set-particles', 'set-bake', 'set-post-passes', 'set-pixel-grid', 'set-game', 'bake-motion', 'fracture-node', 'add-explosion', 'settle', 'separate-faces', 'join-meshes', 'assign-face-material', 'apply-transform', 'set-origin',
  ]),
  materialTags: Object.freeze(['surface', 'unlit', 'liquid', 'foam', 'foliage', 'grass', 'water']),
  materialPresets: Object.freeze({
    field: 'material.preset',
    names: Object.freeze(['smoothPlastic', 'wood', 'grass', 'neon', 'glass', 'brick']),
    rule: 'Fills unset fields; color tints; yours win (docs/agent-scene.md). Glass: blended pane, opacity 0.8, thin rim, no refraction; grass: sparse blades; neon: glows (pair bloom.keepHue).',
  }),
  // A flat water sheet; the largest sets the level. A bed d metres down keeps exp(-absorption * d) per channel (RGB per metre).
  water: Object.freeze({ presets: WATER_PRESETS_SUMMARY, default: 'lake', note: 'absorption 0..20, turbidity 0..1 softens shadows below; opacity under 1 shows the bed. caustics {scale m 0.05-50, speed 0-10, intensity 0-10, depthFade 0-10} adds a moving sun net on surfaces below (off unless given, raster only). waterRamp {colors [3-5 display colours, deep to bright: #rrggbb shows as that hex, rgb numbers as their sRGB encoding], drivers {height, facing, sun: weights 0-1; default height 1}, heightRange [low, high] world y (-1, 1), steps hard|soft (hard), crestTint {color, strength 0-1}} paints flat tones that own the colour (no sky reflection; foam and glint stay), off by default.' }),
  materialLayers: Object.freeze(Object.fromEntries(MATERIAL_LAYER_FIELDS.map(field => [field, Object.freeze({
    range: MATERIAL_LAYER_SCALAR_RANGES[field] ?? MATERIAL_LAYER_COLOR_RANGES[field] ?? 'above 0',
    note: MATERIAL_LAYER_NOTES[field],
  })]))),
  materialSubsurface: 'material.subsurface { weight, radius, scale, color } as Blender Principled BSDF Subsurface; surface tag, rasterizer only. Ranges in scene_create.',
  materialRetro: 'material.retro { vertexSnap [width, height] (whole numbers 16 to 4096), affineUV true }: the PS1 look. vertexSnap rounds each vertex to a width by height screen grid so vertices jitter as the camera moves; affineUV interpolates texture coordinates without perspective correction so textures swim on large triangles. Set either or both. Raster renders only; the path tracer ignores it. Shadows ignore it. A material without retro renders exactly as before.',
  materialWaterGlint: 'material.waterGlint { edge { threshold 0.05 to 0.95 (0.4), intensity 0 to 4 (1) }, sparkle { density 0 to 1 (0.35), size 0.02 to 2 m (0.12), threshold 0.9 to 0.9999 (0.985), shape dot | star (star), twinkle 0 to 8 per second (1), intensity 0 to 4 (1) } } on a water material, both parts off unless named: stylized highlights. edge replaces the soft sun glint with its lobe cut at threshold into a flat hard-edged shape that follows the waves; raise threshold for a smaller shape. sparkle cuts the water into size-metre cells and lights the share given by density whose tilted facet mirrors the sun within threshold (a cosine, higher is fewer and tighter), so sparkles twinkle with the camera, the waves and time and never show on the side away from the sun. Sparkles fade in far water where a cell is under two pixels. Raster renders only; the path tracer ignores it. Painted light streaks are not built yet.',
  materialSurfaceCover: 'material.surfaceCover { output slope (default) | normalY | height, range [low, high] metres (height only, required), edge 0.5, softness 0.1, noise { scale 1 (cells per metre), amount 0.4, seed 0 }, color [0.9, 0.92, 0.95], roughness 0.85 }: a layer (snow, dust) drawn over the material where the surface faces up (slope, normalY) or sits high (height), the mask worked out per pixel in the shader from the interpolated world normal and world position, so its edge is smooth at any distance on a mesh as big as a mountain. The graph surface node bakes the same masks into one texture per mesh (at most 1024 square) and shows stair steps on a large mesh: use surfaceCover for the mask that gates a layer there, and the graph for everything else. The cover is smoothstep(edge - softness, edge + softness, signal + noise.amount * (noise - 0.5)), with signal 1 for an up facing surface and 0 for a wall (slope), the up normal as 0 to 1 (normalY) or the world height over range (height); noise is two octaves of world space value noise. The covered pixels take color and roughness, lose their metallic and clear coat. World space only; the surface tag; the base material or pattern under it stays baked. Rasterizer only, the path tracer ignores it. A material without surfaceCover renders exactly as before.',
  bloomKeepHue: 'effects.bloom.keepHue true (default false): bloom keeps the hue of bright emissive parts, so a red or blue neon face stays saturated and its halo keeps the colour instead of washing to pink or cyan. Pair it with a moderate strength (0.25 to 1) and a wide radius (up to 16). Scenes without it draw exactly as before. Raster post pass only: the path tracer (no bloom), the native post pass and the volume fog composite ignore it.',
  materialWear: 'material.wear { mask, threshold 0.5, softness 0.25, metal { color, metallic 1, roughness 0.3 }, dirt { mask, threshold, softness, color, roughness 0.9 } }: the material own color, metallic and roughness are the paint; per pixel it turns to the metal layer where the vertex group mask is high, then to dirt (no metal, rougher) where the dirt group is high. Masks are vertex groups of the node mesh (vertex_group measure edge, curvature or occlusion), so a mesh with no UVs works. Rasterizer only; not with baked sky visibility.',
  alphaModes: RECIPE_ALPHA_MODES,
  materialPatterns: MATERIAL_PATTERN_TYPES, maxMaterialPatterns: MAX_MATERIAL_PATTERNS,
  materialMappings: MATERIAL_MAPPINGS,
  lookViews: Object.freeze({ names: LOOK_VIEW_NAMES, argument: 'scene_look view', default: 'beauty', note: 'The raster preview always draws a view (there is no path traced look). Values are linear, like the render job passes: albedo is the base colour, normal is the shading normal as n*0.5+0.5, roughness and metallic are grey after maps and wear, ao is the occlusion term, lighting is the diffuse light on a white non-metal surface (no albedo). A view leaves out the exposure findings. Path traced jobs write the lit image only.' }),
  renderPasses: Object.freeze({ names: RENDER_PASS_NAMES, files: 'render-<pass>.png/.exr or frame-N-<pass>.png/.exr (multilayer: true packs all into render.exr)', depth: `16 bits in red and green over ${RENDER_PASS_DEPTH_RANGE} m`, objectId: '24 bits in RGB; metrics.objectNames lists parts, metrics.objectNodes maps nodes to IDs', cryptomatte: 'R object hash, G material hash, B coverage; metrics.cryptomatte holds manifests', aov: 'material.aov or pattern.graph.aov linear RGB', wireframe: 'polygon edges over diffuse; open orange, non-manifold red, flipped cyan, degenerate magenta; metrics.wireframe' }),
  // Recipe timeline (src/film-timeline.js), rendered with settings.timeline; the rest is in docs/agent-render-jobs.md.
  filmTimeline: Object.freeze({
    maxShots: 64, maxTotalSeconds: 60, maxShotSeconds: 30,
    shot: 'name (unique), duration or endAt (a marker name: the shot ends at that cue), motionStart (default: the shot start, so non-looping motion must cover it), camera (partial: eye target up fov near far), focusDistance (m) and blur (0 to 1) for the depth of field of the shot, dip (s; fades through black at the cut into this shot).',
    markers: 'timeline.markers [{ name, time }] and timeline.beatGrid { bpm, offset, count } (markers beat-0, beat-1 ...) name cue times in timeline seconds; no audio analysis.',
    notSupported: 'layers, overlaps, crossfades, events, imported assets',
  }),
  curveText: Object.freeze({
    maxCurvePoints: CURVE_TEXT_LIMITS.maxCurvePoints, maxProfilePoints: CURVE_TEXT_LIMITS.maxProfilePoints,
    maxTextCharacters: CURVE_TEXT_LIMITS.maxTextCharacters, maxTextLines: CURVE_TEXT_LIMITS.maxTextLines,
    verticesPerCharacterSegment: CURVE_TEXT_LIMITS.verticesPerCharacterSegment,
    details: CURVE_TEXT_DETAILS,
  }),
  materialGraph: Object.freeze({ outputs: MATERIAL_GRAPH_OUTPUTS, operators: MATERIAL_GRAPH_OPERATORS, ...MATERIAL_GRAPH_LIMITS, nodes: MATERIAL_GRAPH_NODES }),
  // mesh_edit on an imported GLB part (geometry mesh-<n>, listed by scene_inspect). Edits run in the part's local space
  // (mesh_inspect gives localToWorldScale and localAxesInWorld) on a welded mesh with axis tags and a material tag.
  importedMeshEdits: Object.freeze({
    ...IMPORTED_MESH_EDIT_LIMITS,
    transfer: 'New vertices take skin weights, morph deltas and colours from the nearest original surface point; faces without UVs read the nearest UV island. Unsupported: mesh_stack, relations, instancing.',
    rejects: 'Skinned or morphed part: an edit farther than maxTransferFraction of the bounds diagonal from the original surface; booleans on open parts (fill_holes first).',
  }),
  fixedResources: false, dynamicTopology: true, checkpoints: true, positiveScaleOnly: true,
  gltfImport: 'Optional extensions and line primitives load with a warning; unlit and punctual lights are read.',
  authoredLook: true, maxPointLights: MAX_POINT_LIGHTS,
  catalogLooks: Object.freeze({ hdri: 'environment.hdri', hdris: BUNDLED_ENVIRONMENT_NAMES, cubeLooks: BUNDLED_CUBE_LOOK_NAMES, look: 'environment.look', catalogId: '64-hex ID of a .hdr or .cube in scene_asset_catalog', note: 'environmentIntensity and environmentRotation apply; keyIntensity 0 if the HDRI has a sun' }),
  bvhMotion: Object.freeze({
    catalog: 'A .bvh file in --assets is listed by scene_asset_catalog as a skeleton-only GLB (meshes 0, skins 1, one clip named after the file; End Sites become joints named <parent>_End).',
    use: 'Pass its assetId as motion.layers[].from.asset with clip 0 on a rigged humanoid asset: the clip is retargeted by the humanoid bone map (see motion.layers from, and retargets in scene_inspect hierarchy). layer.scale multiplies the hips travel; rootMotion false keeps the walk in place.',
    units: 'Auto: rest height up to 4 is metres, below 40 the CMU unit (1 / 0.45 inch), else centimetres; the file is stored in metres. The retarget scales hips travel by the rest hip heights, so units do not change the result on a target.',
    channels: 'Any rotation order (first listed is outermost); a position channel gives its axis outright. Frame Time sets the clip times. Rest pose: a first frame that is a straight T-pose (common in CMU files) becomes the rest pose and is not played, so the zero pose splay is not copied onto the character.',
    limits: Object.freeze({ maxJoints: BVH_LIMITS.maxJoints, maxFrames: BVH_LIMITS.maxFrames, maxFileBytes: BVH_LIMITS.maxBytes, maxChannelValues: BVH_LIMITS.maxChannelValues }),
    note: 'Both skeletons face the same way with +Y up. A syntax error stops the catalog and names the file and line; a file over a limit is skipped with its reason. docs/retarget.md.',
  }),
  skyboxAndSunRays: 'environment.skybox {front, back, left, right, up, down}: six catalog image IDs (scene_asset_catalog, no URLs, all six, not with hdri or sky), folded into one environment map that is the background, diffuse light and reflections; faces are upright images as a viewer inside sees them (front -Z, right +X, left -X, back +Z, up +Y and down -Y as the top and bottom of a cross around front), sRGB 8-bit; effects.colorCorrection {brightness -1..1 stops of two (0), contrast -1..1 (0), saturation -1..1 (0), tint [r,g,b] 0..4 (1,1,1)}: identity and skipped at the defaults; effects.sunRays {intensity 0..4 (0.25; 0 off), spread 0..1 (1)}: screen-space shafts toward lightDirection that break up where geometry hides the sky (docs/agent-look.md)',
  environmentLight: 'environment.ambientColor [r,g,b] 0-10 (absent): flat linear diffuse fill that fades where the key light reaches the surface (it tints shadow, not sunlit ground), a Roblox OutdoorAmbient (0.3 is a clear daytime fill); environment.environmentDiffuseScale 0-100 (1): scales the environment diffuse light only, reflections stay, a Roblox EnvironmentDiffuseScale; both are raster only (the path tracers ignore them) and ambientIntensity multiplies the result; environment.sky.clockTime {hours, latitude, dayOfYear, northOffset} places the sun from a clock time (docs/agent-look.md)',
  physicalSky: 'environment.sky {type:physical, preset: golden-hour|sunset|blue-hour, clockTime {hours 0-24, latitude, dayOfYear, northOffset} instead of sunElevation and sunRotation, sunElevation, sunRotation, turbidity, groundAlbedo, aerialPerspective} drives key, sky, fog; a low sun warms them; type:gradient {stops:[{at,color}], horizonGlow:{color,width,intensity}} only picks colours',
  lightingSetups: LIGHTING_SETUP_NAMES,defaultLightingSetup: DEFAULT_LIGHTING_SETUP,
  ambientOcclusion: Object.freeze({ default: DEFAULT_AMBIENT_OCCLUSION, defaultRadius: 0.5, off: 0 }),
  // Local lights: spot and rectangular area lights. Shadows share one 2048 x 3072 depth atlas of 24 tiles; a shadowed
  // point light uses 6 tiles, a shadowed spot or area light 1. Recipes reach light linking and cascaded sun shadows through lightLinking and shadowCascades below.
  maxSpotLights: MAX_SPOT_LIGHTS, maxAreaLights: MAX_AREA_LIGHTS,
  localShadows: Object.freeze({ lights: Object.freeze(['pointLights', 'spotLights', 'areaLights']), atlasTiles: 24, pointLightTiles: 6, spotLightTiles: 1, areaLightTiles: 1, tileSize: 512 }),
  lightParenting: Object.freeze({ fields: Object.freeze(['pointLights[].parent', 'spotLights[].parent', 'areaLights[].parent', 'areaLights[].face', 'areaLights[].faceOffset']), parent: 'node ID or placed asset part label; position and direction are then in its space; follows motion, physics and glTF clips; bake uses the rest pose', face: 'area light with parent: +x -x +y -y +z -z, that face of the part, shining outward; no position, direction, up, width or height; faceOffset 0-100 m (0.002)' }),
  lightLinking: Object.freeze({ fields: Object.freeze(['environment.keyAffects', 'pointLights[].affects', 'spotLights[].affects', 'areaLights[].affects']), unlisted: 'a light without affects lights every node', unknownNode: 'rejected', bake: 'honoured', pathTracer: 'ignored, named in report.ignored' }),
  lightPortals: Object.freeze({ field: 'environment.areaLights[].portal', note: 'true marks a window: emits nothing, direction points into the room; Cook, CPU and WebGPU sample the sky through it, raster and WebGL ignore it (diagnostic portal-ignored-by-raster)' }),
  localVolumes: Object.freeze({ field: 'environment.localVolumes', maximum: 8, shapes: Object.freeze(['box', 'sphere', 'mesh', 'grid']), fields: 'shape, center, size (box) or radius (sphere) or part + fit bounds|mesh (mesh: the named part, bounds by default; fit mesh fills a closed part, ignoring falloff, noise and steps), density 0-100 (1), falloff 0-1 (0.5), absorption rgb 0-1 (1,1,1), emission rgb 0-1, emissionStrength 0-1000 (1), scatter 0-1 (0; lit by the key light and the sky, not with fit mesh), lightsScene true adds a point light at the emission so the volume lights the scene (false; not for mesh), emissionRamp {kelvin [cool,hot] 300-30000 | stops 2-8 colours, source density (grid: temperature or flame), range [low,high] (0,1), exposure 0-1000 (1)} grades the glow by the source through a blackbody or a colour ramp, not for mesh volumes, drawn by the rasterizer and the cpu tracer only, shadowDetail true makes the sun shadow inside a scattering box or sphere follow its noise (false), castShadow true makes a box, sphere or grid shade the surfaces under it from the sun (false; opaque emissive parts under it keep their glow, which costs one more draw of the scene), scatterOctaves 1-4 adds multiple scattering to the key light of a scattering volume (1), blur 0-1 (1; softens the light behind it by optical depth, max 24 px at 540 rows), noiseAmount 0-1 (0; also ripples the faded edge, so use falloff 0.8 to 0.9 for a round cloud), noiseScale (1), noiseOctaves 1-5 (1; whole number, adds finer noise on the large lumps for a ragged smoke or fire edge, each octave at twice the scale and half the weight; raise steps with it; not on the WebGPU tracer), steps 4-32 (16); grid: center, size (taken from the grid file when omitted), grid (a name.67vg in the grid folder or a registered name; scripts/vdb-to-grid.py makes it from a VDB) or frames (a list of up to 512 such names for an animation; one resolution, 256 MiB in all by the loader and at most 64 MiB of grid files in one MCP call) with fps 0.01-240 (24) and loop (true), the frame following the motion time, density scales the grid density, emission and emissionStrength light the flame channel, temperatureScale kelvin per grid unit (1), blackbodyIntensity 0-1 (0; lights the temperature channel with the physical blackbody of Blender, 0.09 at 1500 K and 1.5 at 3000 K times emissionStrength), anisotropy -0.9-0.9 (0), steps 4-128 (64); one grid per scene, no falloff or noise', note: 'Absorb and emit; scatter above 0 lights the volume with the key light (shadow map, own depth toward the sun) and the sky term, 0 draws as before; density is extinction per metre times absorption, light behind = exp(-density * absorption * metres): about 0.3 is a thin haze (half shows through), 3 is thick smoke (under 3 percent); needs hdr and depth like volumeFog; noise is the same field in the rasterizer and the CPU path tracer; path tracer: backend cpu or webgpu for every shape, native for grid only (gpu throws); a bake leaves them out, so an emissive volume lights no baked surface (bake report: skippedLocalVolumes, warnings).' }),
  shadowCascades: Object.freeze({ field: 'environment.shadowCascades', counts: Object.freeze([0, 1, 2, 3, 4]), zero: 'one shadow map', automatic: 'three cascades when shadow.extent is above 40 and the field is unset', maximumDistance: 150, note: 'volume fog and water read the single map; shadow.hard true gives one-texel sun shadow edges with a texel-snapped view and replaces the automatic cascades' }),
  lineArt: Object.freeze({ field: 'environment.lines', fields: 'width px 0.25-16 (1.5), color, boundaries, silhouetteSide both|front, creaseAngle deg (35), convexHighlight 0-4, depthJump (0.08), colorMode solid|darken, darkenFactor 0-1, toon steps 0-8, polylines [{points [x,y,z] 2-256, color, width, depthTest, closed}] max 64, nodes {id:{lines,silhouetteOnly,color}}; {} turns on, null clears; material toon 0-8', note: 'docs/line-art.md' }),
  rain: Object.freeze({ field: 'environment.rain', fields: 'intensity 0-1 (0.6), intensityCurve [{time,value}] 2-64, density 100-6000 (2400), volume [w,h,d] 2-120 ([24,18,28]), speed 2-40 (16), streakLength 0.05-2 (0.45), streakWidth 0.002-0.06 (0.014), wind [x,z] -20..20 ([1.2,0.4]), color [r,g,b] 0-2, opacity 0-1 (0.42), splashes (true), splashCount 0-1200 (400), groundHeight (0), wetness 0-1|null (pairs with environment.wetness when unset), seed (1); {} turns on, null clears; rendererTime drives animation and path tracers ignore it', note: 'docs/rain.md' }),
  viewTransform: Object.freeze({
    field: 'environment.viewTransform', names: VIEW_TRANSFORM_NAMES, default: 'aces', look: 'environment.look', looks: LOOK_NAMES,
    choose: 'agx for lit scenes and Blender comparisons, neutral for product and brand colour, standard to match a Blender Standard reference (sRGB, no tone curve, values above 1 clip), aces for contrast; needs loadAgentSceneModules',
  }),
  // Flush surfaces flicker (z-fighting). They are ranked at draw time by default; coplanar-overlap warns about what is left.
  renderFlags: Object.freeze({ nodeFields: Object.freeze(['visible', 'castShadow', 'receiveShadow', 'holdout', 'shadowCatcher', 'shadowOnly']), rayVisibility: "mesh node, path tracer only: 'glass' (a pane lets shadow rays through) or {camera,diffuse,glossy,transmission,shadow,volumeScatter: false} hides it from that ray; emitters cannot hide from the last three", motion: 'node track property visible: 1 or 0, STEP', note: 'visible:false hides a node and children; holdout and shadowCatcher need a transparent canvas (CrucibleRenderer transparent:true); flags split batches. Blended and transmissive parts cast a sun shadow weighted by opacity and tinted by colour (1024 map, one extra draw of those parts only); shadowOnly:true casts a shadow and is not drawn (gobo); castShadow:false turns it off, and cascades or splat/3-layer-map receivers skip the tint.' }),
  depthBias: Object.freeze({ nodeFields: Object.freeze(['decal', 'depthLayer']), maxDepthLayer: 4, environment: 'environment.resolveCoplanar', modes: Object.freeze(['offset', false]), default: 'offset', warning: 'coplanar-overlap', note: 'Automatic: flush or near-flush faces, inside one mesh or across parts, are ranked per triangle at draw time, the front face wins, geometry never moves; no field needed. resolveCoplanar false opts out. decal wins over the surface below; depthLayer stacks decals. scene_inspect flush.ranked counts ranked parts. A coplanar-overlap warning carries reason rank-overflow (over 15 stacked faces: remove duplicates), double-sided-gap, unchecked or collapsed-node.' }),
  // Wet ground from one environment value; the code is src/wetness.js and compiles only when wetness is above 0.
  wetness: Object.freeze({ environment: Object.freeze(['environment.wetness', 'environment.puddles']), wetness: '0 dry to 1 soaked (0.5 acts as 0.75); darkens porous surfaces, metals untouched; null clears', puddles: Object.freeze({ coverage: '0-1 (0.5)', from: Object.freeze(['height', 'cavity', 'mask']), mask: '64-hex catalog image ID when from is "mask"', note: 'height: basin; cavity: occlusionMap/crevices; mask: ground mask. docs/agent-look.md' }), renderers: 'Rasterizer only; path tracers ignore it.' }),
  proceduralMotion: true,
  motionIk: Object.freeze(['two-bone', 'aim', 'chain', 'spline']),
  // Authored rigs: armatures expand into bone nodes, and a node `skin` binds a mesh with automatic weights (four influences).
  // Node relations place a mesh node against other mesh nodes (world bounds), solved again after every edit.
  relations: Object.freeze({
    maxPerNode: 8, maxNodes: 256, sides: Object.freeze(['+x', '-x', '+y', '-y', '+z', '-z']),
    kinds: Object.freeze({
      attach: 'to, side, offset: touch the target face on side and centre on the other axes; offset is distance, negative sinks in',
      gap: 'to, side, offset: as attach on that axis only',
      flush: 'to, side, offset: own face on side level with the same face of the target',
      align: 'to, axis, at (min, center, max), offset: anchor on one axis',
      centered: 'to, axes (default x, y, z): centre on those axes',
      level: 'at (bottom, center, top), y: no to; that face of the part sits at world height y',
    }),
    notes: 'Region (mesh tag): target faces only. One relation per axis, no loops, mesh nodes only. A relation sets translation on its axes. set-node with relations [] removes them.',
  }),
  rigging: Object.freeze({ presets: Object.freeze(['humanoid', 'quadruped']), maxArmatures: 16, maxBones: 128, maxInfluences: 4, weights: 'bone-distance' }),
  motionConstraints: Object.freeze(['copy_location', 'copy_rotation', 'copy_scale', 'limit_location', 'limit_rotation', 'track_to', 'child_of', 'floor', 'copy_transforms', 'limit_distance', 'limit_scale', 'stretch_to', 'locked_track', 'transformation', 'action', 'maintain_volume', 'damped_track', 'pivot', 'follow_path', 'clamp_to', 'shrinkwrap', 'armature']),
  motionDrivers: Object.freeze({ maxDrivers: 32, maxConstraints: 32, maxProperties: 32, maxPropertyKeys: 16, targets: Object.freeze(['node', 'material', 'light', 'morph', 'camera']), variables: Object.freeze(['time', 'node', 'custom', 'distance', 'rotationDifference']), maxExpressionParts: 64, maxExpressionDepth: 8 }),
  // Recipe physics: Rapier (an optional peer) bakes bodies on nodes offline; playback is a seek into the bake.
  physics: Object.freeze({
    bodyTypes: Object.freeze(['dynamic', 'fixed', 'kinematic']),
    shapes: PHYSICS_BODY_SHAPES,
    compound: 'shapes (1-16, with shape compound): { shape, translation, rotation, halfExtents, radius, halfHeight }',
    bodyEnabled: 'body enabled false keeps it out of the simulation until a spawn or enable event; it starts at its definition pose and velocity',
    jointTypes: Object.freeze(['spherical', 'revolute', 'prismatic', 'fixed', 'spring']),
    jointFields: 'type, bodyA, bodyB, anchorA, anchorB, axis, limits, name (what jointMotor events refer to), contactsEnabled, motor {mode position|velocity, target, stiffness (position only), damping, maxForce}, breakImpulse (fixed only), restLength and stiffness and damping (spring only)',
    events: 'impulse (default, dynamic), kinematicPose (kinematic), jointMotor (named revolute/prismatic joint), spawn/enable (body; enables a disabled body at its tick) by time or tick',
    sensors: true, collisionLayers: 16,
    breakableJoints: 'fixed joint breakImpulse (N s): breaks when a body takes a contact impulse (force x 1/60 s) over it in one step; scene_inspect lists jointBreaks. scene_apply fracture-node { node, cells 2-64, strength N s, seed 1, impact [x,y,z] in geometry space, impactRadius, density 1, friction }: replaces a convex root node by cells nodes NAME-frag-i (fragment geometries) with convex bodies and one breakable fixed joint NAME-glue-a-b per neighbour pair; send it after the set-physics that holds the floor, ball and duration (set-physics replaces the section). docs/physics.md.',
    ragdoll: 'physics.ragdoll {armature}: limp capsule per bone; needs a floor',
    film: 'render motion {start 0} plays this bake, cloth and particles with no bake-motion; video duration defaults to the bake.',
    limits: Object.freeze({ maxBodies: 128, maxJoints: 512, maxDuration: 10, framesPerSecond: 60, maxTrimeshTriangles: 20000, maxHullPoints: 2048 }),
  }),
  // Recipe cloth: a position-based solver (no peer dependency) records any root mesh node as a deformable sheet.
  cloth: Object.freeze({
    sheetGeometry: 'grid { segments 1-64 }: unit sheet in XY facing +Z, sized by node scale; any triangle mesh works',
    defaults: Object.freeze({ stiffness: 0.9, bend: 0.1, density: 0.2, damping: 0.3, friction: 0.3, thickness: 0.01, colliderShape: 'box' }),
    notes: 'density kg/m2, damping 1/s, thickness m, wind m/s steady. Colliders { node, shape ball|box } fit geometry bounds; like sheets they are root nodes without a motion track or body. Moving: { attach, shape ball|capsule, radius, offset, to, toOffset } or { armature, radiusFraction, exclude }. Sheet pinGroup: a vertex group whose vertices (weight 0.5 or more) are held. Sheet pinTo { node, weight } rides pinned edges on a node. Sheet stiffnessGroup: vertex group whose weights scale stiffness (floor 0.05). Sheet softBody { shape 0-1 (0.2), pressure 0-3 (1), bounce 0-1 (0) }: shape matching plus a volume term; pressure needs a closed mesh, a node with an open mesh fails and says to set pressure 0. bounce is the share of its landing speed the body keeps when it turns around; lower shape or sheet stiffness makes a softer, deeper dent. Sheet bendModel distance (default) or dihedral: dihedral holds the angle between neighbouring triangles, so a fine sheet folds in many soft ripples instead of one crease; set bend about 0.15 with it. Sheet bendYield (radians, dihedral only, off by default) lets a fold keep its crease: past that bend angle the rest angle follows the cloth by bendSet (0-1, 0.1) of the excess each substep, so a crumpled sheet stays crumpled. Sheet pinTo.releaseAt (seconds, optional) lets the pinned edges go at that time and fall with the rest. Sheet staticFriction (0-1, 0) holds cloth still on a collider when its sideways travel is under that multiple of the contact depth, so it rests on a slope below its friction angle. Sheet selfCollision true or false (a recipe takes no { radius }; that is the createCloth library option): particles of the sheet push apart (radius 0.9 of half the shortest edge, or the sheet thickness when set, up to 5000 particles); cloth does not collide with other sheets.',
    limits: Object.freeze({ maxSheets: 8, maxColliders: 16, maxMovingColliders: 64, maxDuration: 10, maxParticles: 5000, framesPerSecond: 60, substeps: 4, iterations: 8 }),
  }),
  // Recipe particles: closed-form from seeded launch values, so any time is computed directly and a seek never replays.
  particles: Object.freeze({
    emitter: 'Not for a blast: an explosion, blast or fireball is scene_apply add-explosion (topic explosion); particles only add optional sparks or debris beside one. System node geometry is the particle shape; its transform does not move them. Fields (defaults): node, seed (1), count (100), rate (per second; omit: burst at 0), start (alias delay: seconds before the first birth, 0), stop (an absolute time in seconds on the scene clock, not a duration after start, and above start: nothing is born at or after it), lifetime, speed, size (number or [min, max]; 1, 1, 0.05), direction ([0,1,0]), spread (cone degrees, 30), emitter { shape point|box|sphere|disc|mesh, position, halfExtents, radius, follow (node id: the emitter, its offset and direction ride the animated or physics pose of that node at each birth; not for mesh); mesh fields: mesh: mesh node, group (vertex group weighting surface, vertices or edges), groupThreshold 0-1 (0: only points where the group weighs at least this emit), from surface (area weighted)|vertices|edges (length weighted)|volume (closed mesh), sharpAngle (degrees, edges only: keep open or bent edges), normalSpeed m/s along the normal, velocityFrom (name of a mesh vector such as spray from the ocean; surface or vertices) with velocityScale (1, -1000 to 1000) adds that velocity to each particle, region { center, halfExtents } (a world-space box: births only on the part of the mesh inside it, with the full count; a box that holds no part of the mesh is an error) }, instances [node ids, up to 8: each particle draws one], orient none|random|normal (mesh surface, vertices or edges)|billboard (a plane card faces the camera; for spray, mist, smoke wisps), fade darken|opacity (see-through alpha on a blend material), scale constant|shrink|grow, drag (1/s, 0), floor (world y they land on).',
    hair: 'type hair grows strands from a read-only root surface node into node (its own geometry is ignored). Fields (defaults): surface, seed, count, length (m, number or [min, max], 0.1), segments (1-8, 4), width (m, 0.004), droop (0.5), lean (0.2), sway (tip travel m, off), swayRate (Hz, 0.5). Tapering tubes, no UVs.',
    flipbook: 'Emitter field flipbook { rows, columns (1-16), frames (rows*columns), fps (omit: the sheet plays once across each life), loop (true with fps) }: each particle shows one cell of the material map, cell 0 top left, read left to right then down; the system node needs UVs (a plane). Also on emitters: sizeOverLife (number, [start, end] or [[time 0-1, value]] up to 8 stops, multiplies size), alpha and color accept the same stops ([[t, [r,g,b]]] for color), gravityScale (1) and acceleration ([0,0,0] m/s2 added to gravity) for smoke that rises.',
    presets: 'Emitter field preset smoke|fire|sparkles fills the fields you leave out (yours win): smoke rises and grows in soft grey puffs (needs an alphaMode blend material, fade opacity), fire is camera-facing cards from yellow through orange to dark red (use alphaMode add), sparkles are small twinkling points (alphaMode add). Draw them on a plane node with segments 1 and a soft round map; a plane with no segments is drawn as one quad. Rain is its own feature.',
    beam: 'type beam { node, from, to (node ID or { node, offset [x,y,z] }), width (m, number, [start,end] or stops along the length, 0.2), segments (1-64, 8), curve ([x,y,z] lift of the middle, [0,0,0]), scroll (texture u per second, 0), repeat (u tiles along the length, 1), color, alpha (stops along the length), fade darken|opacity }: a strip between two nodes that follows their animated poses and turns around its axis to face the camera; v runs 0 to 1 across it. The node is replaced by the strip.',
    trail: 'type trail { node, follow (node ID), offset ([0,0,0]), lifetime (0.05-10 s, 0.5), segments (1-128, 24), width (over age, [0.2, 0]), alpha (over age, [1, 0]), color, repeat (u tiles along the trail, 1), fade }: a ribbon through where the followed node was over the last lifetime. Ring i reads the node pose at time minus lifetime*i/segments, so a frame depends on its time only, never on frames drawn before. Ages before time 0 are hidden.',
    sparks: 'type sparks (preset explosion, delay s): cooling streaks; node material tag unlit; docs/physics.md',
    sectionFields: 'systems, gravity ([0,-9.81,0]), wind (m/s; moves emitter particles only with drag > 0, and sets the hair sway direction), fields (also cloth; wind, turbulence, vortex, drag, magnet: docs/physics.md)',
    collision: 'colliders [node ids], bounce 0-1 (0.3 with colliders), friction 0-1 (0.5), spin deg/s, color [[r,g,b] birth, [r,g,b] death], alpha [birth, death].',
    notes: 'Pure function of seed, index and time; raising count keeps earlier ones. No hair collision.',
    limits: Object.freeze({ maxSystems: 4, maxParticlesPerSystem: 2000, maxParticles: 4000, maxVertices: 100000, maxLifetime: 60 }),
  }),
  // Recipe bake: bounced light written into lightmaps at build time (src/light-bake.js, loaded on demand).
  bake: Object.freeze({
    fields: 'preset, or samples (1-256), bounces (1-8), texelsPerUnit (1-12) over it; irradianceGrid true or 8-40 nodes: baked bounced diffuse light in place of lightmaps (opt in, static); gridFog true adds the fog (sunlit closed rooms); probes room by default, false for none, or up to 4 {position, radius?}; rebake true bakes each sampled pose (4 kept).',
    presets: BAKE_PRESETS,
    notes: 'Bounced light from point, spot, area and key lights. Skips alpha, skin, morph, hair, cloth (bake.skipped). A preset shrinks to fit (bake.used, bake.reduction); explicit settings over maxPathWork shrink the same way and fail past maxSeconds. No environment map or specular; probes are specular, not in glTF.',
    limits: Object.freeze({ maxSeconds: BAKE_MAXIMUM_SECONDS, workerMaxSeconds: BAKE_WORKER_MAXIMUM_SECONDS, maxPathWork: BAKE_EXPLICIT_PATH_WORK_LIMIT, maxPointLights: MAX_POINT_LIGHTS }),
  }),
  heightParallax: 'Material heightMap (or textureSet height) with heightScale above 0 (metres, 0-0.5, off by default) draws parallax relief in the rasterizer: texel 1 is the surface, texel 0 lies heightScale below it, and the colour, roughness, occlusion, emission and normal maps all shift with the ray. heightFade (default 12 m, 0.1-1000) is where the relief has faded to plain normal mapping, heightSteps (default 16, 4-32) the ray steps. Needs a standard PBR material with UVs (no boxMapScale, tag or alphaMode mask); the silhouette stays flat, and the path tracers ignore it and say so.',
  textPanel: 'material.text { content (1-512 characters, up to 32 lines; "\n" breaks a line; a character the font lacks draws as "?"), width and height (metres the panel covers, 0.01-100: the face it is drawn for), font sans (DejaVu Sans, the only family bundled; same pixels on every machine), fontSize (metres per line before the 1.2 line gap, default half the height), color [r,g,b] 0-1 (white), background [r,g,b] (omit: transparent, and the material blends), align left|center|right (center), verticalAlign top|middle|bottom (middle), wrap (true: breaks at the width, and inside a word wider than a line), padding (metres, 5% of the short side), resolution (pixels per metre 16-2048, 256) }. Drawn on the CPU to a colour map at most 1024 pixels a side, so the bytes are the same for the same input. The material needs the surface or unlit tag (unlit for a sign that glows) and no pattern, map or colorMap. A sign on one face of a part is a plane node (geometry { type plane }, sized by scale [width, height, 1]) that is a child of the part, placed 1 mm off the face (translation [0, 0, half depth + 0.001] faces +Z) with decal true. docs/agent-scene.md.',
  billboard: 'node.billboard { size [width, height] metres, or screenHeight 0.002-1 (share of the frame height at any distance; the width follows the text panel), offset [x,y,z] world metres from the node (left out: the tag stands above the top of the world bounding box of the parent node, children included, with a gap of 20 percent of its own height; an explicit offset, even [0,0,0], wins), castShadow is a node flag that defaults to false on a billboard node (a tag casts no shadow line; castShadow true turns it on), alwaysOnTop (false: a part in front hides the tag, like a Roblox BillboardGui; true draws it through parts and needs a material with depthTest false and alphaMode blend, a pair that is checked) }: the node must draw a plane (geometry type plane); its sheet turns to the camera at every sampled time, follows the node under a moving parent, and ignores the node rotation and scale. Pair with a material.text for a name tag (topic textPanel). The camera is the recipe camera or the camera track at that time; perspective and orthographic both work (screenHeight with a focalLength lens needs fov, so give fov). Not in scene_export_web packs. scene_inspect lists billboards. docs/agent-scene.md.',
  explosion: 'scene_apply add-explosion { id, center, size m 0.5-100, start s (0), seed (1), fuel dry|oily, ground y, shake 0-1 (0.4), sparks streaks (default)|specks|none|{ count, speed, lifetime }, motionBlur (true: velocity grids, shutter of effects.motionBlur or 0.0417), debris { node } }: writes flash, ring, one gas-sim grid volume for fire and smoke (physical blackbody, castShadow, lightsScene; frames explosion-<fuel>-<seed>[-velocity]_NNNN.67vg are baked from the name, no files needed), stronger bloom, sparks, dust and rubble particles (delay start), an id-scorch decal and a camera eye shake into plain sections, IDs starting id-. debris.node (convex mesh, after set-physics with a fixed floor) breaks into 12 pieces thrown at start. Needs no other grid volume (one per scene), 3 particle systems; start is bounded by the grid frame list (error gives the limit). docs/agent-scene.md.',
  airSteps: 'effects.distortion and effects.flash: up to 4 sources each on the scene clock; effects tracks distortionStrength and flashIntensity fade them. See docs/agent-look.md.',
  motionLook: Object.freeze({
    light: 'id point:N, spot:N or area:N (index in its list): position, color, intensity; direction on spot and area',
    sun: 'direction, color, intensity (lightDirection, keyColor, keyIntensity)',
    environment: 'skyTop, skyBottom, fogColor, fogDensity, volumeFogDensity, ambientIntensity, fillIntensity, environmentIntensity, environmentRotation (key light is sun kind)',
    effects: 'exposure, focusDistance (depthOfField.blur > 0), distortionStrength, flashIntensity, bloomStrength, glareStreaks (glare), lensDispersion (lensDistortion)',
    note: 'Same keyframes and easing as other tracks. After sampleMotion, scene.environment and scene.effects hold the sampled values.',
  }),
  motionModifiers: 'Track extrapolation constant|linear; modifiers [{type: cycles|stepped|noise|generator|limits|envelope, ...}], 8 at most; cycles and stepped remap time first.',
  motionLimits: Object.freeze({ maxTracks: 128, maxKeyframesPerTrack: 256, maxKeyframes: 2048, maxDuration: 30 }),
  motionRemoveTracks: 'scene_apply set-motion { removeTracks: [{ kind?, id?, property? }] } (64 at most, instead of motion) drops the tracks whose fields equal the selector, a field left out matching any: { kind: "camera" } drops the camera track, { kind: "node", id: "cube" } every track of that node. Other motion fields stay; a selector that matches nothing is an error listing the tracks; no motion left becomes null.',
  motionBake: 'scene_apply bake-motion { nodes (32 at most), start 0, end (motion or physics duration), step 1/30 (512 samples), tolerance { position m, angle deg, scale } }: samples tracks, IK, constraints, drivers and physics into LINEAR tracks and removes those sources (an IK solver or the physics world only when all its nodes are baked). tolerance drops keys within it; without it a track keeps every sample, 256 keys at most. Procedural scenes only.',
  springBones: 'motion.springs { chains: [{ bones: [node IDs root to tip, each the child of the one before, 16 per chain, 64 in all], stiffness 0-4 (1), dragForce 0-1 (0.4), gravityPower 0-2 (0), gravityDir [0,-1,0], hitRadius (0.02), tipLength (0.07), colliders: [ids] }] (16 at most), colliders: [{ id, bone, type sphere|capsule, offset, radius, tail }] }: VRM spring bones for hair and tails; fixed 1/60 s steps, sample times in increasing order; bake-motion bakes whole chains; needs loadAgentSceneModules.',
});

/** Degrees between faces above which a mesh geometry keeps a hard edge, as Blender's auto smooth does. */
export const MESH_SMOOTH_ANGLE_DEFAULT = 30;
