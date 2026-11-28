// The built-in addons listed on the marketplace page: one row per `./addons/*` export of package.json.
// tests/addon-catalog.test.js fails when an export has no row here, when a row has no export, and when a row has no summary or area.
// `doc: true` means docs/<name>.md exists; any other row links to its source file.

export const ADDON_AREAS = [
  { id: 'modeling', label: 'Modeling' },
  { id: 'look', label: 'Look' },
  { id: 'light', label: 'Light' },
  { id: 'render', label: 'Render' },
  { id: 'motion', label: 'Motion' },
  { id: 'game', label: 'Game' },
  { id: 'world', label: 'World' },
];

export const PACKAGE_NAME = '@codepawlhq/crucible';

export const ADDON_CATALOG = [
  { name: 'model', area: 'modeling', summary: 'Load the sample microscope as explodable parts.' },
  { name: 'studio', area: 'modeling', summary: 'A visual editor that works on the same scene recipe as agents.', doc: true },
  { name: 'modeling', area: 'modeling', summary: 'Lathe, sweep and other agent modeling geometry.', doc: true },
  { name: 'mesh', area: 'modeling', summary: 'Polygon mesh core: half-edge edit mesh, normals and lint.', doc: true },
  { name: 'mesh-query', area: 'modeling', summary: 'Ray, closest-point and distance queries on meshes.', doc: true },
  { name: 'kinetic-text', area: 'motion', summary: 'Split 3D text into letters or words and stagger one animation across them.', doc: true },
  { name: 'mesh-blend', area: 'modeling', summary: 'Soften the seam where one mesh cuts into another.', doc: true },
  { name: 'sculpt', area: 'modeling', summary: 'Serializable brush strokes that sculpt a mesh.', doc: true },
  { name: 'surface', area: 'modeling', summary: 'Patches that conform to the surface of another part.', doc: true },
  { name: 'surface-attachment', area: 'modeling', summary: 'Stick a part to a triangle that follows a deforming mesh.', doc: true },
  { name: 'shrinkwrap', area: 'modeling', summary: 'Wrap one mesh onto the surface of another.', doc: true },
  { name: 'fracture', area: 'modeling', summary: 'Voronoi fracture of a closed convex mesh, with glue between pieces.' },
  { name: 'export-mesh', area: 'modeling', summary: 'Export parts to OBJ with MTL, or to binary STL.' },
  { name: 'gltf', area: 'modeling', summary: 'Load glTF and GLB assets, including very large scenes.', doc: true },
  { name: 'agent-asset', area: 'modeling', summary: 'Authoring state and measurements for assets an agent builds.', doc: true },
  { name: 'agent-scene', area: 'modeling', summary: 'Scene editing with revisions, as the MCP tools use it.', doc: true },
  { name: 'canvas2d', area: 'modeling', summary: 'Draw 2D scene recipes on a canvas.' },
  { name: 'update-part-vertices', area: 'modeling', summary: 'Write new vertex positions into a part that already drew.' },
  { name: 'replace-textured-parts', area: 'modeling', summary: 'Add and remove textured parts on a live renderer.' },
  { name: 'texture-update', area: 'modeling', summary: 'Push new pixels from a canvas, video or simulation into a texture.' },
  { name: 'texture-set', area: 'modeling', summary: 'Load a scanned material set: color, normal, roughness, height.' },
  { name: 'three-bridge', area: 'modeling', summary: 'Convert between live three.js object trees and Crucible parts.', doc: true },

  { name: 'material-layer-shaders', area: 'look', summary: 'Anisotropy and iridescence material layers.' },
  { name: 'subsurface-shader', area: 'look', summary: 'Subsurface scattering for skin, wax and leaves.' },
  { name: 'liquid-shader', area: 'look', summary: 'Liquid, transmissive and foam materials.' },
  { name: 'world-material-shader', area: 'look', summary: 'Water bodies with absorption and turbidity.' },
  { name: 'glitter-shader', area: 'look', summary: 'Stylized water glint with a hard edge and sparkle.' },
  { name: 'height-parallax-shader', area: 'look', summary: 'Parallax relief from a height map on a material.' },
  { name: 'detail-normal-shader', area: 'look', summary: 'Tiled detail normal map and micro-roughness modulation on standard PBR materials.' },
  { name: 'retro-shader', area: 'look', summary: 'The PlayStation 1 look: vertex snap and affine textures.' },
  { name: 'surface-cover', area: 'look', summary: 'A snow or dust layer masked per pixel, smooth on huge meshes.' },
  { name: 'splat-shader', area: 'look', summary: 'Splat-mapped ground material blended by a control texture.' },
  { name: 'fog-shader', area: 'look', summary: 'Volume fog that scatters light through a box.' },
  { name: 'view-transform', area: 'look', summary: 'AgX, Khronos Neutral and Standard display transforms and look LUTs.' },
  { name: 'view-transform-shader', area: 'look', summary: 'The GLSL of the view transforms and the look LUT.' },
  { name: 'linear-output-shader', area: 'look', summary: 'Write linear scene radiance with no view transform.' },
  { name: 'line-art', area: 'look', summary: 'Ink outlines and line-art rendering.', doc: true },
  { name: 'camera-effects', area: 'look', summary: 'Depth of field and camera motion blur.' },
  { name: 'user-pass', area: 'look', summary: 'Your own GLSL post pass on the finished frame.' },
  { name: 'hdri', area: 'look', summary: 'Read Radiance HDR images as environment maps.' },
  { name: 'compact-color', area: 'look', summary: 'Store the HDR frame in 4 bytes a pixel.' },

  { name: 'light-bake', area: 'light', summary: 'Bounced light baked into one lightmap per part.', doc: true },
  { name: 'light-bake-gpu', area: 'light', summary: 'Bake lightmap texels on the GPU path tracer.' },
  { name: 'ground-bounce', area: 'light', summary: 'Light that bounces off the ground onto the scene.' },
  { name: 'floor-sky-visibility', area: 'light', summary: 'Sky visibility and sunlit patches for a closed room.' },
  { name: 'light-linking', area: 'light', summary: 'Limit a light to the parts it lights.' },
  { name: 'light-shapes', area: 'light', summary: 'Soft area light shadows and IES light profiles.' },
  { name: 'cascaded-shadows', area: 'light', summary: 'Cascaded sun shadows, up to four slices.' },
  { name: 'reflection-probes', area: 'light', summary: 'Trace the room around a point so glossy parts reflect it.' },
  { name: 'water-reflection', area: 'light', summary: 'Mirror reflection on lakes, rivers and polished floors.' },

  { name: 'path-tracer', area: 'render', summary: 'Offline path-traced stills with denoising.', doc: true },
  { name: 'denoise-oidn', area: 'render', summary: 'Native Intel Open Image Denoise (OIDN) wrapper for path-traced stills.' },
  { name: 'path-tracer-progressive', area: 'render', summary: 'A progressive view of the GPU path tracer.' },
  { name: 'path-tracer-realtime', area: 'render', summary: 'A real-time hybrid view of the GPU path tracer.' },
  { name: 'render-passes', area: 'render', summary: 'Depth, normals, object IDs and other render passes.' },
  { name: 'wireframe-pass', area: 'render', summary: 'Polygon edges drawn over the shaded surface, with or without repair colours.' },
  { name: 'coplanar-overlap', area: 'render', summary: 'Stop z-fighting between near-flush triangles.' },
  { name: 'scene-audit', area: 'render', summary: 'Instancing-aware geometry audit for coplanar overlaps, intersections, floating parts and inverted shells.', doc: true },
  { name: 'dev-scene-hints', area: 'render', summary: 'Opt-in dev health hints for unlit geometry, coplanar faces and floating parts.' },
  { name: 'meshlets', area: 'render', summary: 'Build meshoptimizer meshlets and cull clusters per draw on dense meshes.', doc: true },
  { name: 'reversed-depth', area: 'render', summary: 'Reversed-Z depth for far-away precision.' },
  { name: 'crucible-scene', area: 'render', summary: 'The <crucible-scene> web component for packed scenes.' },
  { name: 'showcase', area: 'render', summary: 'Interactive 3D product showcase viewer with Prototype and Studio themes.', doc: true },

  { name: 'motion', area: 'motion', summary: 'Motion scenes: one geometry graph and a bound player.' },
  { name: 'morph', area: 'motion', summary: 'Morph targets with a static preflight.' },
  { name: 'skinning', area: 'motion', summary: 'Skeletal skinning for characters.', doc: true },
  { name: 'skeleton-pose', area: 'motion', summary: 'Layered skeletal poses with inverse kinematics.', doc: true },
  { name: 'prop-grip', area: 'motion', summary: 'Attach handheld props to character grip sockets with auto finger curl.', doc: true },
  { name: 'retarget', area: 'motion', summary: 'Retarget a clip between humanoid skeletons.', doc: true },
  { name: 'crowd-skinning', area: 'motion', summary: 'GPU crowds from one character and one clip.' },
  { name: 'cloth', area: 'motion', summary: 'Position-based cloth recorded offline as frames.' },
  { name: 'spume', area: 'motion', summary: 'Play back a liquid bake from Spume.', doc: true },
  { name: 'physics', area: 'motion', summary: 'Rigid bodies with Rapier, recorded for film.', doc: true },
  { name: 'settle', area: 'motion', summary: 'Drop props onto colliders and keep where they rest.' },
  { name: 'vehicle', area: 'motion', summary: 'Vehicle body, wheels and suspension.', doc: true },

  { name: 'runtime', area: 'game', summary: 'Live game loop that runs ordered systems.', doc: true },
  { name: 'game', area: 'game', summary: 'Play the game section of a scene recipe in a page.', doc: true },
  { name: 'game-rules', area: 'game', summary: 'Game logic as JSON: variables, triggers and actions.', doc: true },
  { name: 'input', area: 'game', summary: 'Input sources, named actions and axes.', doc: true },
  { name: 'player', area: 'game', summary: 'Character controllers and camera rigs.', doc: true },
  { name: 'animation-graph', area: 'game', summary: 'Animation states, blend spaces and layers for live play.', doc: true },
  { name: 'physics-runtime', area: 'game', summary: 'Live physics: bodies, joints, queries and contact events.', doc: true },
  { name: 'physics-jolt', area: 'game', summary: 'The Jolt engine adapter for live physics.' },
  { name: 'audio', area: 'game', summary: 'Spatial audio played from events.', doc: true },
  { name: 'netcode', area: 'game', summary: 'Multiplayer state sync with an authority.', doc: true },
  { name: 'streaming', area: 'game', summary: 'Load, swap and free assets by distance while playing.', doc: true },
  { name: 'navmesh', area: 'game', summary: 'Walkable grid and smooth paths over triangle geometry.' },
  { name: 'scene-query', area: 'game', summary: 'Ask a scene what is walkable, blocked or in the way.', doc: true },

  { name: 'nature', area: 'world', summary: 'Whole nature worlds with createNatureWorld.' },
  { name: 'terrain', area: 'world', summary: 'Chunked terrain with level of detail and exact heights.', doc: true },
  { name: 'heightfield', area: 'world', summary: 'A mesh grid over georeferenced rasters.' },
  { name: 'vegetation', area: 'world', summary: 'Trees, bushes and scattering on terrain.', doc: true },
  { name: 'grass', area: 'world', summary: 'Grass fields made of real blades.', doc: true },
  { name: 'clutter', area: 'world', summary: 'Pebbles, twigs and leaves scattered in streamable tiles.', doc: true },
  { name: 'rain', area: 'world', summary: 'Camera-local falling rain streaks, ground splashes and wet surfaces.', doc: true },
  { name: 'gaussian-splats', area: 'world', summary: 'Gaussian splat scenes and objects.', doc: true },
];

function camelCase(name) {
  return name.replace(/-(\w)/g, (_match, letter) => letter.toUpperCase());
}

// The line a reader pastes to use an addon: `mesh-query` becomes `import * as meshQuery from ...`.
export function addonImportLine(name) {
  return `import * as ${camelCase(name)} from '${PACKAGE_NAME}/addons/${name}';`;
}
