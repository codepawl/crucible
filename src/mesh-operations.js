// The mesh edit vocabulary as plain data, with no geometry code, so capability listings and the MCP server can
// describe it without bundling the mesh engine.

export const MAX_MESH_EDITS = 64;

// A mesh geometry can name material slots, and every face points at one by index (the face attribute below). The count is
// bounded so the slot index fits one byte and a mesh stays a handful of draw calls.
export const MAX_MATERIAL_SLOTS = 16;
export const MATERIAL_SLOT_ATTRIBUTE = 'material_slot';

// Most vertex indices or edge pairs one selection lists, for the vertex rule { "vertices": [...] } on a move and the edge rule
// { "edges": [[a, b], ...] } on every edge-taking edit. A larger selection uses a rule such as inside, angle or a tag.
export const MAX_SELECTED_ELEMENTS = 4096;

// Modifiers that work on the whole mesh and take no selection or name. Their fields are checked in mesh-modifiers.js and
// each one is described for agents by MESH_MODIFIER_NOTES in agent-scene-capabilities.js.
const operation = (fields = [], tags = []) => ({ fields, tags });

export const MODIFIER_OPERATIONS = /* @__PURE__ */ Object.freeze({
  weld: operation(['distance']),
  triangulate: operation(['minVertices']),
  edge_split: operation(['angle']),
  smooth: operation(['factor', 'iterations']),
  simple_deform: operation(['mode', 'axis', 'angle', 'factor']),
  cast: operation(['factor', 'size']),
  screw: operation(['axis', 'angle', 'steps', 'iterations', 'lift']),
  wireframe: operation(['thickness', 'offset', 'evenOffset', 'replace']),
  skin: operation(['radius']),
  lattice: operation(['divisions', 'moves']),
  curve: operation(['path', 'axis']),
  hook: operation(['center', 'radius', 'translation', 'strength', 'falloff']),
  smooth_laplacian: operation(['factor', 'iterations', 'preserveVolume', 'pinBoundary', 'group']),
  warp: operation(['from', 'to', 'radius', 'curve', 'twist']),
  wave: operation(['height', 'width', 'narrowness', 'speed', 'time', 'timeOffset', 'start', 'cyclic', 'axes', 'normal']),
  weighted_normal: operation(['angle', 'weight']),
  smooth_by_angle: operation(['angle', 'ignoreSharp']),
  join: operation(['geometry', 'matrix', 'slotMap']),
  bounding_box: operation(),
  convex_hull: operation(),
  build: operation(['order', 'axis', 'seed', 'frame', 'start', 'length', 'reverse']),
  ocean: operation(['axis', 'windSpeed', 'direction', 'choppiness', 'size', 'seed', 'time', 'resolution', 'coverage', 'foamMemory', 'wake', 'spray']),
});

// translate and transform_selection take one of these instead of select: the vertices of a vertex rule, or the ends of the
// edges an edge rule picks. They sit beside the fields list so the list keeps naming the face rule every edit shares.
export const ELEMENT_SELECTION_FIELDS = /* @__PURE__ */ Object.freeze(['verts', 'edges']);
export const ELEMENT_MOVE_OPERATIONS = /* @__PURE__ */ Object.freeze(['translate', 'transform_selection']);

// Where merge_verts puts the vertex: the centre of the picked ones, the first or last one picked, or each connected group at its own centre.
export const MERGE_TARGETS = /* @__PURE__ */ Object.freeze(['center', 'first', 'last', 'collapse']);

export const MESH_EDIT_OPERATIONS = /* @__PURE__ */ Object.freeze({
  extrude_face_region: operation(['select', 'name', 'offset', 'direction', 'alongNormals'], ['cap', 'side']),
  extrude_individual: operation(['select', 'name', 'offset', 'direction'], ['cap', 'side']),
  inset_region: operation(['select', 'name', 'thickness', 'depth'], ['cap', 'rim']),
  inset_individual: operation(['select', 'name', 'thickness', 'depth'], ['cap', 'rim']),
  delete: operation(['select']),
  flip_normals: operation(['select']),
  translate: operation(['select', 'offset', 'falloff']),
  transform_selection: operation(['select', 'pivot', 'rotation', 'scale', 'falloff']),
  merge_by_distance: operation(['distance']),
  merge_verts: operation(['vertices', 'at']),
  tag: operation(['select', 'name']),
  material_slot: operation(['select', 'slot']),
  boolean: operation(['name', 'operation', 'cutter', 'translation', 'rotation', 'scale'], ['cut']),
  mirror: operation(['name', 'axis', 'merge'], ['mirrored']),
  array: operation(['name', 'count', 'offset', 'relativeOffset', 'merge'], ['last']),
  solidify: operation(['name', 'thickness', 'offset', 'evenThickness'], ['inner', 'rim']),
  bevel: operation(['name', 'edges', 'width', 'segments', 'profile', 'clampOverlap'], ['strip', 'corner']),
  loop_cut: operation(['name', 'edges', 'cuts', 'factor'], ['band-<k>']),
  uv_unwrap: operation(['seams', 'margin', 'maxDistortion']),
  uv_project: operation(['mode', 'axis', 'pack', 'margin', 'rotate']),
  uv_pack: operation(['margin', 'rotate']),
  subdivide: operation(['levels', 'crease', 'sharpness']),
  fill_holes: operation(['name', 'sides'], ['fill']),
  make_face: operation(['vertices', 'name'], ['fill']),
  dissolve_faces: operation(['select', 'name'], ['merged']),
  dissolve_edges: operation(['edges', 'removeStraight', 'name'], ['merged']),
  dissolve_verts: operation(['verts', 'name'], ['merged']),
  dissolve_limited: operation(['edges', 'angle', 'name'], ['merged']),
  bisect_plane: operation(['name', 'point', 'normal', 'distance', 'clearInner', 'clearOuter', 'fill'], ['inner', 'outer', 'cap']),
  bridge_edge_loops: operation(['edges', 'name', 'segments', 'twistOffset'], ['bridge']),
  subdivide_edges: operation(['edges', 'name', 'cuts'], ['split']),
  grid_fill: operation(['edges', 'name'], ['fill']),
  knife_project: operation(['name', 'path', 'direction'], ['cut']),
  poke: operation(['select', 'name', 'offset', 'relative'], ['poke']),
  dual: operation(['name'], ['dual']),
  tris_to_quads: operation(['select', 'name', 'angle'], ['merged']),
  symmetrize: operation(['name', 'axis', 'keep', 'distance'], ['mirrored']),
  scale_elements: operation(['select', 'scale']),
  extrude_edges: operation(['edges', 'name', 'offset'], ['side']),
  split_edges: operation(['edges', 'name']),
  delete_loose: operation(),
  flatten: operation(['verts', 'normal', 'factor']),
  unsubdivide: operation(),
  circularize: operation(['verts', 'factor', 'regular']),
  set_position: operation(['select', 'position', 'offset']),
  displace: operation(['select', 'field', 'source', 'strength', 'midlevel', 'direction', 'group']),
  vertex_group: operation(['select', 'name', 'weight', 'field', 'gradient', 'measure', 'gain', 'angle', 'rays', 'distance', 'seed']),
  vertex_color: operation(['select', 'color', 'field', 'gradient']),
  decimate: operation(['ratio']),
  remesh: operation(['voxelSize', 'resolution']),
  sculpt: operation(['select', 'strokes']),
  shrinkwrap: operation(['select', 'target', 'translation', 'rotation', 'scale', 'mode', 'direction', 'offset', 'maxDistance', 'onMiss']),
  ...MODIFIER_OPERATIONS,
});

// Limits of the sculpt and shrinkwrap edits, and their vocabulary, as plain data.
export const SCULPT_STROKE_TYPES = /* @__PURE__ */ Object.freeze(['inflate', 'displace', 'smooth']);
export const MAX_SCULPT_STROKES = 32;
export const MAX_SCULPT_VISITS = 5_000_000;
export const SHRINKWRAP_MODES = /* @__PURE__ */ Object.freeze(['nearest', 'project']);
export const MAX_SHRINKWRAP_TRIANGLE_TESTS = 20_000_000;

export const STACK_OPERATIONS = /* @__PURE__ */ Object.freeze(['mirror', 'array', 'solidify', 'bevel', 'uv_unwrap', 'uv_project', 'uv_pack', 'subdivide', 'set_position', 'displace', 'decimate', 'remesh', ...Object.keys(MODIFIER_OPERATIONS)]);
export const MAX_STACK_NODES = 16;
export const MAX_ARRAY_COUNT = 256;

// Field expressions (mesh-fields.js) and instancing (mesh-instances.js): limits and names as plain data. A test
// keeps FIELD_OPERATOR_NAMES equal to the operators the language really has.
export const MAX_FIELD_NODES = 64;
export const MAX_FIELD_DEPTH = 12;
export const MAX_FIELD_ELEMENTS = 250_000;
export const MAX_FIELD_WORK = 8_000_000;
export const FIELD_ATTRIBUTES = /* @__PURE__ */ Object.freeze(['position', 'normal', 'index', 'tag', 'group']);
export const FIELD_OPERATOR_NAMES = /* @__PURE__ */ Object.freeze([
  'add', 'mul', 'min', 'max', 'sub', 'div', 'mod', 'pow', 'atan2', 'clamp', 'mix', 'smoothstep',
  'neg', 'abs', 'sqrt', 'sin', 'cos', 'floor', 'ceil', 'round', 'fract', 'sign', 'saturate',
  'lt', 'lte', 'gt', 'gte', 'eq', 'and', 'or', 'not', 'if',
  'vec', 'dot', 'cross', 'distance', 'length', 'normalize', 'x', 'y', 'z',
  'rotate', 'align', 'transform',
  'attr', 'noise', 'voronoi', 'random', 'nearest', 'raycast',
  'faceArea', 'edgeAngle', 'island', 'neighbors', 'accumulate', 'statistic', 'blur', 'sampleIndex', 'rank',
]);
export const INSTANCE_SOURCES = /* @__PURE__ */ Object.freeze(['grid', 'scatter', 'surface', 'curve']);
export const MAX_INSTANCE_CANDIDATES = 2048;

// Imported GLB parts take the same edits. Skin weights, morph deltas and vertex colours of new geometry come from the
// nearest point of the original surface; an edit that reaches farther than this fraction of the part's bounds
// diagonal from that surface is rejected on a skinned or morphed part, because the transfer would be a guess.
export const IMPORTED_MESH_EDIT_LIMITS = /* @__PURE__ */ Object.freeze({ maxTransferFraction: 0.25, maxEditedParts: 64 });
