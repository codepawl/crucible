// Plain name lists and limits for materials. Runtime modules import them from here, not from agent-scene-capabilities.js,
// so a packed <crucible-scene> page does not download the capability text only the MCP tools read.
import { MAX_FIELD_NODES, MAX_FIELD_DEPTH } from './mesh-operations.js';

export const MATERIAL_PATTERN_TYPES =Object.freeze(['noise', 'wood', 'planks', 'bricks', 'tiles', 'marble', 'stone', 'concrete', 'metal', 'rust', 'fabric']);
export const MATERIAL_MAPPINGS = Object.freeze(['box', 'uv']);
// A material graph bakes to textures on the CPU and never becomes shader text. Its node and depth limits are the field
// expression limits; maxWork is work units per pixel times pixels, so a costly graph needs a smaller texture.
export const MATERIAL_GRAPH_OUTPUTS = Object.freeze(['color', 'roughness', 'metallic', 'emission', 'height', 'opacity', 'clearcoat', 'transmission', 'aov']);
export const MATERIAL_GRAPH_OPERATORS = Object.freeze([
  'uv', 'coord', 'mapping', 'vec', 'ramp', 'image', 'noise', 'whiteNoise', 'brick', 'voronoi', 'wave', 'checker', 'gradient',
  'add', 'sub', 'mul', 'div', 'min', 'max', 'pow', 'abs', 'floor', 'fract', 'sqrt', 'invert', 'clamp', 'smoothstep', 'mix',
  'layer', 'hue', 'curve', 'fresnel', 'vertexGroup', 'meshMap', 'surface', 'base',
]);
export const MESH_MAP_NAMES = Object.freeze(['curvature', 'ao', 'thickness']);
export const SURFACE_OUTPUTS = Object.freeze(['slope', 'normalY', 'height']);
export const SURFACE_SPACES = Object.freeze(['object', 'world']);
export const MATERIAL_GRAPH_LIMITS = Object.freeze({ maxNodes: MAX_FIELD_NODES, maxDepth: MAX_FIELD_DEPTH, maxStops: 8, maxWork: 60_000_000 });
