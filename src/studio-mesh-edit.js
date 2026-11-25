// Studio edit mode: pick vertices, edges and faces of a mesh geometry on its cage and move them with the move handles. It
// loads on the first Tab (studio.js imports it on demand), so the core entry carries none of it.
//
// A move is written as one entry of the mesh edit log (`edit-mesh`), so undo, save and agents see what the person did:
// a `translate` of faces when the moved vertices are exactly the vertices of some faces, else a `set_position` of an index
// mask, which holds at most 19 vertices (a field expression stops at 64 nodes). The log holds at most 64 entries.
import { mat4 } from 'gl-matrix';
import { gatherRenderPositions } from './mesh-render.js';
import { meshEditSourceOf } from './agent-mesh.js';
import { roundVector } from './studio-controller.js';
import { isLiveGeometry, unmarkLiveGeometry } from './live-geometry.js';
import { updatePartVertices } from './update-part-vertices.js';
import { edgeLoop, edgeRing, faceLoop, growSelection, selectLinked, shrinkSelection } from './mesh-select-topology.js';
import { spatialFalloffWeights } from './mesh-ops.js';
import { proportionalCirclePath } from './studio-proportional.js';
import { MAX_SELECTED_ELEMENTS, MERGE_TARGETS } from './mesh-operations.js';

export const MESH_SELECTION_MODES = Object.freeze(['vertex', 'edge', 'face']);
export const MAX_MASK_VERTICES = 19;
export const MAX_LOG_ENTRIES = 64;
// The cage of a larger mesh is not drawn, as the selection outline of Studio is not (SILHOUETTE_TRIANGLE_BUDGET).
export const CAGE_TRIANGLE_BUDGET = 8000;
const VERTEX_PICK_RADIUS_PIXELS = 14;
const EDGE_PICK_RADIUS_PIXELS = 10;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const NEEDS_A_MESH = 'Edit mode needs a mesh geometry or a shape of the Add menu.';
const NEEDS_NO_MODIFIERS = 'Edit mode does not work on a mesh with modifiers yet. Add a plain shape from the Mesh group and edit that, or have the modifiers applied first.';
const TOO_MANY_SEEDS = `Proportional editing moves at most ${MAX_SELECTED_ELEMENTS} vertices that are not whole faces; select fewer, or whole faces.`;
const LOG_IS_FULL = `This mesh already has ${MAX_LOG_ENTRIES} edits, the most one mesh holds, so it cannot take another move.`;
const LOG_IS_FULL_FOR_EDIT = `This mesh already has ${MAX_LOG_ENTRIES} edits, the most one mesh holds, so it cannot take a dissolve or a merge.`;
const TOO_MANY_VERTICES = `Moving more than ${MAX_MASK_VERTICES} vertices that are not whole faces is not possible yet; select whole faces or fewer vertices.`;
const MESH_CHANGED = 'Edit mode ended because this object uses a different mesh now.';
// Circle select (C): the brush is in screen pixels, the wheel changes it by a factor per notch, and it stays between sessions.
export const CIRCLE_BRUSH_DEFAULT_PIXELS = 25;
export const CIRCLE_BRUSH_MIN_PIXELS = 4;
export const CIRCLE_BRUSH_MAX_PIXELS = 400;
// How much of the surface stays drawn while the see-through view is on.
export const SEE_THROUGH_SURFACE_OPACITY = 0.1;
const CIRCLE_BRUSH_STEP_FACTOR = 1.15;
// A wheel step is 100 pixels of travel; a line is a third of a notch and a page is three notches (the wheel's deltaMode).
const WHEEL_PIXELS_PER_STEP = 100;
const WHEEL_PIXELS_PER_LINE = WHEEL_PIXELS_PER_STEP / 3;
const WHEEL_PIXELS_PER_PAGE = WHEEL_PIXELS_PER_STEP * 3;
const WHEEL_DELTA_LINE = 1;
const WHEEL_DELTA_PAGE = 2;
const CIRCLE_SELECT_HINT = 'Circle select: drag to select, middle drag or Shift to deselect, wheel to resize, right click or Esc to leave.';
const EDIT_MODE_HINT = 'Edit mode: pick a vertex, edge or face.';
const TOO_LARGE_TO_DRAW = `This mesh has more than ${CAGE_TRIANGLE_BUDGET.toLocaleString('en-US')} triangles, so only the selection is drawn.`;

function indexMask(vertices) {
  let terms = vertices.map(vertex => ({ eq: [{ attr: 'index' }, vertex] }));
  while (terms.length > 1) {
    const groups = [];
    for (let start = 0; start < terms.length; start += 8) {
      const group = terms.slice(start, start + 8);
      groups.push(group.length === 1 ? group[0] : { max: group });
    }
    terms = groups;
  }
  return terms[0];
}

function facesInsideVertexSet(mesh, vertexSet) {
  const faces = [];
  const covered = new Set();
  for (let face = 0; face < mesh.faceCount; face += 1) {
    const first = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    let inside = true;
    for (let corner = first; corner < end && inside; corner += 1) {
      inside = vertexSet.has(mesh.cornerVertices[corner]);
    }
    if (!inside) continue;
    faces.push(face);
    for (let corner = first; corner < end; corner += 1) covered.add(mesh.cornerVertices[corner]);
  }
  return { faces, covered };
}

/**
 * The log entry that moves `vertices` of `mesh` by `localDelta`: a face `translate` when the vertices are exactly those of
 * some faces, else a `set_position` over an index mask. With a `falloff` ({ radius, curve }, proportional editing) the move is
 * a `translate` either way, naming the vertices when they are not whole faces. Throws a sentence that says why when the move cannot be written.
 */
export function planMeshMove(mesh, vertices, localDelta, falloff = null) {
  const offset = roundVector(localDelta);
  const vertexSet = new Set(vertices);
  const { faces, covered } = facesInsideVertexSet(mesh, vertexSet);
  const falloffField = falloff ? { falloff: { radius: falloff.radius, curve: falloff.curve } } : {};
  if (faces.length > 0 && covered.size === vertexSet.size) {
    return { op: 'translate', select: { faces }, offset, ...falloffField };
  }
  if (falloff) {
    // The recipe's falloff moves the vertices around a selection, so a vertex that is no whole face is named in the edit (`verts`).
    if (vertexSet.size > MAX_SELECTED_ELEMENTS) throw new RangeError(TOO_MANY_SEEDS);
    const sortedSeeds = [...vertexSet].sort((first, second) => first - second);
    return { op: 'translate', verts: { vertices: sortedSeeds }, offset, ...falloffField };
  }
  if (vertexSet.size > MAX_MASK_VERTICES) throw new RangeError(TOO_MANY_VERTICES);
  const sorted = [...vertexSet].sort((first, second) => first - second);
  return { op: 'set_position', offset: { mul: [offset, indexMask(sorted)] } };
}

function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function transformDirection(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z,
    matrix[1] * x + matrix[5] * y + matrix[9] * z,
    matrix[2] * x + matrix[6] * y + matrix[10] * z,
  ];
}

function distanceToSegmentSquared(pointX, pointY, startX, startY, endX, endY) {
  const directionX = endX - startX;
  const directionY = endY - startY;
  const lengthSquared = directionX * directionX + directionY * directionY;
  const along = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((pointX - startX) * directionX + (pointY - startY) * directionY) / lengthSquared));
  const nearestX = startX + directionX * along;
  const nearestY = startY + directionY * along;
  return (pointX - nearestX) ** 2 + (pointY - nearestY) ** 2;
}

// Moller-Trumbore: the distance along the ray to the triangle, or null.
function rayTriangleDistance(origin, direction, cornerA, cornerB, cornerC) {
  const edgeOne = [cornerB[0] - cornerA[0], cornerB[1] - cornerA[1], cornerB[2] - cornerA[2]];
  const edgeTwo = [cornerC[0] - cornerA[0], cornerC[1] - cornerA[1], cornerC[2] - cornerA[2]];
  const pVector = [direction[1] * edgeTwo[2] - direction[2] * edgeTwo[1], direction[2] * edgeTwo[0] - direction[0] * edgeTwo[2], direction[0] * edgeTwo[1] - direction[1] * edgeTwo[0]];
  const determinant = edgeOne[0] * pVector[0] + edgeOne[1] * pVector[1] + edgeOne[2] * pVector[2];
  if (Math.abs(determinant) < 1e-12) return null;
  const toOrigin = [origin[0] - cornerA[0], origin[1] - cornerA[1], origin[2] - cornerA[2]];
  const u = (toOrigin[0] * pVector[0] + toOrigin[1] * pVector[1] + toOrigin[2] * pVector[2]) / determinant;
  if (u < 0 || u > 1) return null;
  const qVector = [toOrigin[1] * edgeOne[2] - toOrigin[2] * edgeOne[1], toOrigin[2] * edgeOne[0] - toOrigin[0] * edgeOne[2], toOrigin[0] * edgeOne[1] - toOrigin[1] * edgeOne[0]];
  const v = (direction[0] * qVector[0] + direction[1] * qVector[1] + direction[2] * qVector[2]) / determinant;
  if (v < 0 || u + v > 1) return null;
  const distance = (edgeTwo[0] * qVector[0] + edgeTwo[1] * qVector[1] + edgeTwo[2] * qVector[2]) / determinant;
  return distance > 0 ? distance : null;
}

/**
 * Smooth normals for a drag preview: the area weighted sum of the triangles that share each render vertex, so a cube whose
 * corners are split per face stays flat and a shared vertex is averaged. Writes into `normals` (3 per vertex) and returns it;
 * the release builds the real ones.
 */
export function previewNormalsOf(indices, positions, normals) {
  normals.fill(0);
  for (let corner = 0; corner + 2 < indices.length; corner += 3) {
    const first = indices[corner] * 3;
    const second = indices[corner + 1] * 3;
    const third = indices[corner + 2] * 3;
    const edgeOneX = positions[second] - positions[first];
    const edgeOneY = positions[second + 1] - positions[first + 1];
    const edgeOneZ = positions[second + 2] - positions[first + 2];
    const edgeTwoX = positions[third] - positions[first];
    const edgeTwoY = positions[third + 1] - positions[first + 1];
    const edgeTwoZ = positions[third + 2] - positions[first + 2];
    const crossX = edgeOneY * edgeTwoZ - edgeOneZ * edgeTwoY;
    const crossY = edgeOneZ * edgeTwoX - edgeOneX * edgeTwoZ;
    const crossZ = edgeOneX * edgeTwoY - edgeOneY * edgeTwoX;
    for (const vertexOffset of [first, second, third]) {
      normals[vertexOffset] += crossX;
      normals[vertexOffset + 1] += crossY;
      normals[vertexOffset + 2] += crossZ;
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
    if (length < 1e-12) {
      normals[offset + 1] = 1;
    } else {
      normals[offset] /= length;
      normals[offset + 1] /= length;
      normals[offset + 2] /= length;
    }
  }
  return normals;
}

/** The vertices a selection of `mode` covers: the picked ones, the ends of picked edges, or the corners of picked faces. */
export function verticesOfSelection(mesh, mode, selected) {
  const vertices = new Set();
  for (const element of selected) {
    if (mode === 'vertex') {
      vertices.add(element);
    } else if (mode === 'edge') {
      vertices.add(mesh.edgeVertices[element * 2]);
      vertices.add(mesh.edgeVertices[element * 2 + 1]);
    } else {
      for (let corner = mesh.faceOffsets[element]; corner < mesh.faceOffsets[element + 1]; corner += 1) vertices.add(mesh.cornerVertices[corner]);
    }
  }
  return vertices;
}

// The edges a selection dissolves: the picked ones, those between two picked vertices, or those around a picked face.
function edgesOfSelection(mesh, mode, selected) {
  if (mode === 'edge') return [...selected].sort((first, second) => first - second);
  if (mode === 'vertex') {
    const edges = [];
    for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
      if (selected.has(mesh.edgeVertices[edge * 2]) && selected.has(mesh.edgeVertices[edge * 2 + 1])) edges.push(edge);
    }
    return edges;
  }
  const edges = new Set();
  for (const face of selected) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner += 1) edges.add(mesh.cornerEdges[corner]);
  }
  return [...edges].sort((first, second) => first - second);
}

// The faces a selection dissolves: the picked ones, or those whose every corner is picked.
function facesOfSelection(mesh, mode, selected) {
  if (mode === 'face') return [...selected].sort((first, second) => first - second);
  return facesInsideVertexSet(mesh, verticesOfSelection(mesh, mode, selected)).faces;
}

function refuseTooMany(count, noun) {
  if (count > MAX_SELECTED_ELEMENTS) throw new RangeError(`Dissolving more than ${MAX_SELECTED_ELEMENTS} ${noun} at once is not possible; pick fewer.`);
}

/**
 * The log entry that dissolves the selection as `kind` ("vertices", "edges" or "faces"), from the Delete menu. Dissolving
 * edges also removes the vertices that are left with two edges, so a dissolved loop leaves clean polygons. Throws a sentence that
 * says what to pick when the selection holds none of that kind.
 */
export function planMeshDissolve(mesh, mode, selected, kind) {
  if (kind === 'vertices') {
    const vertices = [...verticesOfSelection(mesh, mode, selected)].sort((first, second) => first - second);
    if (vertices.length === 0) throw new RangeError('Pick a vertex, edge or face to dissolve first.');
    refuseTooMany(vertices.length, 'vertices');
    return { op: 'dissolve_verts', verts: { vertices } };
  }
  if (kind === 'edges') {
    const edges = edgesOfSelection(mesh, mode, selected);
    if (edges.length === 0) throw new RangeError('Dissolve Edges needs at least one edge: pick an edge, two vertices that share one, or a face.');
    refuseTooMany(edges.length, 'edges');
    const pairs = edges.map(edge => [mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]]);
    return { op: 'dissolve_edges', edges: { edges: pairs }, removeStraight: true };
  }
  if (kind === 'faces') {
    const faces = facesOfSelection(mesh, mode, selected);
    if (faces.length === 0) throw new RangeError('Dissolve Faces needs at least one whole face: pick a face, or every vertex of one.');
    refuseTooMany(faces.length, 'faces');
    return { op: 'dissolve_faces', select: { faces } };
  }
  throw new RangeError(`Unknown dissolve kind "${String(kind)}"; use one of vertices, edges, faces.`);
}

/**
 * The log entry that merges the selected vertices at `at` (center, first, last or collapse), from the Merge menu. First
 * and last follow the order of the picks, which only vertex mode keeps, so the other modes refuse them.
 */
export function planMeshMerge(mesh, mode, selected, at) {
  if (!MERGE_TARGETS.includes(at)) throw new RangeError(`Unknown merge target "${String(at)}"; use one of ${MERGE_TARGETS.join(', ')}.`);
  if ((at === 'first' || at === 'last') && mode !== 'vertex') {
    throw new RangeError('At First and At Last follow the order the vertices were picked, so they work in vertex mode (key 1).');
  }
  const vertices = mode === 'vertex' ? [...selected] : [...verticesOfSelection(mesh, mode, selected)].sort((first, second) => first - second);
  if (vertices.length < 2) throw new RangeError('Pick at least two vertices to merge.');
  if (vertices.length > MAX_SELECTED_ELEMENTS) throw new RangeError(`Merging more than ${MAX_SELECTED_ELEMENTS} vertices at once is not possible; pick fewer.`);
  return { op: 'merge_verts', vertices, at };
}

function triangleCountOf(mesh) {
  let triangles = 0;
  for (let face = 0; face < mesh.faceCount; face += 1) {
    triangles += Math.max(0, mesh.faceOffsets[face + 1] - mesh.faceOffsets[face] - 2);
  }
  return triangles;
}

function logsShareTheirPrefix(first, second) {
  const shared = Math.min(first.length, second.length);
  for (let index = 0; index < shared; index += 1) {
    if (first[index] !== second[index]) return false;
  }
  return true;
}

// The shapes of the Add menu's Mesh group turn into a mesh on the first Tab. A box and a cylinder lose their bevel on the way:
// as a mesh the bevel is hundreds of tiny faces (a box of 6 faces becomes 1,482), which nobody can pick one by one. A written 0 is
// needed: without a bevel field the shape builds with its default one.
// A plane is written back by the recipe as a grid.
const CONVERTIBLE_PRIMITIVES = new Set(['plane', 'grid', 'box', 'circle', 'sphere', 'icoSphere', 'cylinder', 'cone', 'torus']);
const PRIMITIVES_WITHOUT_BEVEL = new Set(['box', 'cylinder']);

/** The mesh geometry a shape becomes in edit mode: its own description as the base, or null for a geometry that is no such shape. */
export function meshGeometryOfPrimitive(geometrySpec) {
  if (!geometrySpec || !CONVERTIBLE_PRIMITIVES.has(geometrySpec.type)) return null;
  const { id, ...base } = structuredClone(geometrySpec);
  if (PRIMITIVES_WITHOUT_BEVEL.has(base.type)) base.bevel = 0;
  return { type: 'mesh', base };
}

function uniqueGeometryId(recipe, wanted) {
  const taken = new Set((recipe.geometries ?? []).map(geometry => geometry.id));
  let candidate = wanted;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${wanted}-${suffix}`;
  return candidate;
}

/**
 * The edit mode of one Studio: `enter()` on the selected node, pick with `pick()`, move with the handles of the
 * controller (this editor installs an element session on it), `leave()`. `updatePart` writes a drag preview into the GPU
 * buffers of the part; `getRenderer` returns the renderer it needs, or null for a headless Studio (the cage still moves).
 */
export function createMeshEditor({ controller, announce = () => {}, getRenderer = () => null, updatePart = updatePartVertices, proportional = null } = {}) {
  let state = null;
  let drag = null;
  // True while this editor writes its own entry: the mesh it reads back has the same topology, so the pick stays.
  let writingOwnEntry = false;
  // True from entering edit mode until the first pick selects something: the hint goes away with that pick.
  let hintShowing = false;
  // Circle select: null when off, else where the brush circle is drawn (centre is null until the pointer is over the viewport).
  let circle = null;
  let brushRadius = CIRCLE_BRUSH_DEFAULT_PIXELS;
  // See-through is view state: it outlives one edit session, and while it is on every element counts as reachable.
  let seeThrough = false;
  // Box select: `armed` from the key until one rectangle is dragged; `rectangle` is the one being dragged, in pixels, or null.
  let boxArmed = false;
  let boxRectangle = null;
  let wheelTravel = 0;

  function refuse(message) {
    announce(message);
    return { ok: false, message };
  }

  function geometrySpecOf(recipe, nodeId) {
    const node = recipe.nodes.find(candidate => candidate.id === nodeId);
    return recipe.geometries?.find(candidate => candidate.id === node?.geometry) ?? null;
  }

  // What a person can do instead is in each sentence: edit mode runs on a mesh, or on a shape of the Add menu that turns into one.
  function kindOfObjectWithoutGeometry(recipe, nodeId) {
    const node = recipe.nodes.find(candidate => candidate.id === nodeId);
    if (!node) return recipe.lights?.some(light => light.id === nodeId) ? 'a light' : 'not an object of the scene';
    if (node.asset) return 'an imported file';
    if (recipe.nodes.some(candidate => candidate.parent === nodeId)) return 'a group';
    return 'an empty object';
  }

  function refusalFor(geometrySpec, recipe, nodeId) {
    if (!geometrySpec) return `This object is ${kindOfObjectWithoutGeometry(recipe, nodeId)}, which has no mesh to edit. Select a shape or a mesh.`;
    if ((geometrySpec.stack ?? []).length > 0) return NEEDS_NO_MODIFIERS;
    if (geometrySpec.type === 'text') return 'Text cannot be edited as a mesh yet. Change its words in the properties panel, or add a shape from the Mesh group.';
    if (geometrySpec.type !== 'mesh' && !CONVERTIBLE_PRIMITIVES.has(geometrySpec.type)) return NEEDS_A_MESH;
    return null;
  }

  function loadCage(nodeId, selectedBefore) {
    const geometrySpec = geometrySpecOf(controller.exportRecipe(), nodeId);
    const refusal = refusalFor(geometrySpec, controller.exportRecipe(), nodeId);
    if (refusal) return refusal;
    if (geometrySpec.type !== 'mesh') return NEEDS_A_MESH;
    const part = controller.scene.parts.find(candidate => candidate.name === nodeId);
    const source = part ? meshEditSourceOf(part.geometry) : null;
    if (!source) return NEEDS_A_MESH;
    const mesh = source.mesh;
    const previous = state;
    const edits = geometrySpec.edits ?? [];
    state = {
      nodeId,
      geometryId: geometrySpec.id,
      editCount: edits.length,
      logEntries: edits.map(entry => JSON.stringify(entry)),
      part,
      mesh,
      positions: Float32Array.from(mesh.positions),
      renderVertexSource: source.renderVertexSource,
      previewable: source.renderVertexSource.length * 3 === part.geometry.positions.length,
      tooLarge: triangleCountOf(mesh) > CAGE_TRIANGLE_BUDGET,
      mode: previous?.mode ?? 'face',
      selected: new Set(),
    };
    // A pick is a number in this mesh, so it stays only while the cage has the same counts and the two logs agree up to the
    // shorter one: an undo or a redo of a move keeps it, an edit that replaced an entry may have renumbered everything.
    const sameMesh = previous && previous.nodeId === nodeId && previous.geometryId === geometrySpec.id
      && previous.mesh.vertexCount === mesh.vertexCount && previous.mesh.edgeCount === mesh.edgeCount && previous.mesh.faceCount === mesh.faceCount;
    state.ghostPart = previous?.part === part ? previous.ghostPart : null;
    showSurface();
    if (sameMesh && (writingOwnEntry || logsShareTheirPrefix(previous.logEntries, state.logEntries))) state.selected = new Set(selectedBefore);
    return null;
  }

  // The geometry of the node becomes a mesh of its own before the first edit, in one scene change (one undo step). A geometry
  // another node uses is copied: the preview writes into the geometry's buffers and the edit log belongs to the geometry, so the
  // twin would move too. A shape becomes the mesh of its own description; the shape itself goes when nothing else uses it.
  function giveNodeItsOwnMesh(nodeId) {
    const recipe = controller.exportRecipe();
    const node = recipe.nodes.find(candidate => candidate.id === nodeId);
    const spec = recipe.geometries.find(candidate => candidate.id === node.geometry);
    const sharing = recipe.nodes.filter(candidate => candidate.geometry === node.geometry).length > 1;
    const converted = meshGeometryOfPrimitive(spec);
    if (!sharing && !converted) return;
    const ownId = uniqueGeometryId(recipe, converted ? `${spec.id}-mesh` : `${spec.id}-${nodeId}`);
    const ownGeometry = converted ?? structuredClone(spec);
    const operations = [{ type: 'add-geometry', geometry: { ...ownGeometry, id: ownId } }, { type: 'set-node', id: nodeId, geometry: ownId }];
    if (converted && !sharing) operations.push({ type: 'remove-geometry', id: spec.id });
    controller.applyImportOperations(operations, { detail: { kind: 'topology', nodeId } });
  }

  // The mesh the node would become on Tab, or null: Studio loads the code that builds it before it calls enter().
  function conversionOf(nodeId) {
    return meshGeometryOfPrimitive(geometrySpecOf(controller.exportRecipe(), nodeId));
  }

  function enter() {
    if (state) return { ok: true };
    const nodeId = controller.selectedNodeId;
    if (!nodeId) return refuse('Select a mesh to edit it.');
    const recipe = controller.exportRecipe();
    const refusal = refusalFor(geometrySpecOf(recipe, nodeId), recipe, nodeId);
    if (refusal) return refuse(refusal);
    giveNodeItsOwnMesh(nodeId);
    const loadFailure = loadCage(nodeId, []);
    if (loadFailure) return refuse(loadFailure);
    controller.setTool('translate');
    controller.setElementSession(session);
    if (state.tooLarge) {
      announce(TOO_LARGE_TO_DRAW);
    } else {
      announce(EDIT_MODE_HINT);
      hintShowing = true;
    }
    return { ok: true };
  }

  function leave() {
    if (!state) return;
    hintShowing = false;
    circle = null;
    endBoxSelect();
    // The controller drag goes first, through the session, so the cage, the buffers and the pointer state are put back.
    if (controller.dragging) controller.cancelGizmoDrag();
    cancelDrag();
    state = null;
    controller.setElementSession(null);
  }

  // The surface of the edited part is drawn faint while see-through is on, so the far side shows through it. Parts are frozen
  // and the scene never changes: Studio draws this copy of the part in its place (`partsToDraw`), so nothing reaches the
  // recipe or the undo history.
  function showSurface() {
    if (!state) return;
    if (!seeThrough) {
      state.ghostPart = null;
      return;
    }
    if (state.ghostPart) return;
    const { part } = state;
    state.ghostPart = Object.freeze({
      ...part,
      material: {
        ...part.material,
        alphaMode: 'blend',
        opacity: Math.min(part.material.opacity ?? 1, SEE_THROUGH_SURFACE_OPACITY),
        doubleSided: true,
      },
    });
  }

  /** The parts Studio draws: the same list, with the edited part faint while see-through is on. */
  function partsToDraw(parts) {
    if (!state?.ghostPart) return parts;
    return parts.map(part => (part === state.part ? state.ghostPart : part));
  }

  /** Turns the see-through view on or off. Returns the new value. It changes how the cage draws and what a pick reaches, never the mesh. */
  function setSeeThrough(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError(`Pass true or false to turn see-through on or off, not ${String(enabled)}.`);
    }
    seeThrough = enabled;
    showSurface();
    return seeThrough;
  }

  function selectedVertices() {
    const vertices = new Set();
    if (!state) return vertices;
    const { mesh } = state;
    for (const element of state.selected) {
      if (state.mode === 'vertex') {
        vertices.add(element);
      } else if (state.mode === 'edge') {
        vertices.add(mesh.edgeVertices[element * 2]);
        vertices.add(mesh.edgeVertices[element * 2 + 1]);
      } else {
        for (let corner = mesh.faceOffsets[element]; corner < mesh.faceOffsets[element + 1]; corner += 1) vertices.add(mesh.cornerVertices[corner]);
      }
    }
    return vertices;
  }

  // The selection follows a change of mode through its vertices: an edge or a face stays selected when all its vertices are.
  function setMode(mode) {
    if (!MESH_SELECTION_MODES.includes(mode)) {
      throw new RangeError(`Unknown selection mode "${String(mode)}"; use one of ${MESH_SELECTION_MODES.join(', ')}.`);
    }
    if (!state || state.mode === mode || drag) return;
    const vertices = selectedVertices();
    const { mesh } = state;
    const converted = new Set();
    if (mode === 'vertex') {
      for (const vertex of vertices) converted.add(vertex);
    } else if (mode === 'edge') {
      for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
        if (vertices.has(mesh.edgeVertices[edge * 2]) && vertices.has(mesh.edgeVertices[edge * 2 + 1])) converted.add(edge);
      }
    } else {
      for (const face of facesInsideVertexSet(mesh, vertices).faces) converted.add(face);
    }
    state.mode = mode;
    state.selected = converted;
    controller.setTool('translate');
  }

  function clearSelection() {
    if (!state || state.selected.size === 0) return false;
    state.selected = new Set();
    controller.setTool('translate');
    return true;
  }

  function noteSelectionChanged() {
    controller.setTool('translate');
    if (hintShowing && state.selected.size > 0) {
      hintShowing = false;
      announce('');
    }
  }

  /** Alt+A: nothing selected, in any mode. True when something was selected. */
  function selectNone() {
    return clearSelection();
  }

  /** Ctrl+I: every element of the current mode that was not selected becomes selected, and the selected ones are not. */
  function invertSelection() {
    if (!state || drag) return false;
    const { mesh } = state;
    const count = state.mode === 'vertex' ? mesh.vertexCount : state.mode === 'edge' ? mesh.edgeCount : mesh.faceCount;
    const inverted = new Set();
    for (let element = 0; element < count; element += 1) {
      if (!state.selected.has(element)) inverted.add(element);
    }
    state.selected = inverted;
    noteSelectionChanged();
    return true;
  }

  /** C: the brush. Returns false outside edit mode or in the middle of a drag. */
  function beginCircleSelect() {
    if (!state || drag) return false;
    if (circle) return true;
    endBoxSelect();
    circle = { centre: null };
    wheelTravel = 0;
    hintShowing = false;
    announce(CIRCLE_SELECT_HINT);
    return true;
  }

  function endCircleSelect() {
    if (!circle) return false;
    circle = null;
    wheelTravel = 0;
    announce('');
    return true;
  }

  /**
   * The wheel as the page reports it: the travel is summed, so a trackpad swipe and a mouse wheel of the same distance
   * resize alike. One step per 100 pixels up (bigger) or down (smaller); the remainder waits for the next event and a turn around drops it.
   */
  function wheelCircleBrush(deltaY, deltaMode = 0) {
    if (!Number.isFinite(deltaY) || deltaY === 0) return brushRadius;
    const pixelsPerUnit = deltaMode === WHEEL_DELTA_PAGE ? WHEEL_PIXELS_PER_PAGE : deltaMode === WHEEL_DELTA_LINE ? WHEEL_PIXELS_PER_LINE : 1;
    const travel = -deltaY * pixelsPerUnit;
    if (Math.sign(travel) !== Math.sign(wheelTravel)) wheelTravel = 0;
    wheelTravel += travel;
    const steps = Math.trunc(wheelTravel / WHEEL_PIXELS_PER_STEP);
    if (steps === 0) return brushRadius;
    wheelTravel -= steps * WHEEL_PIXELS_PER_STEP;
    return resizeCircleBrush(steps);
  }

  /** The wheel: one notch up (steps > 0) makes the brush bigger, one down smaller; the result stays inside the brush limits. */
  function resizeCircleBrush(steps) {
    if (!Number.isFinite(steps)) {
      throw new RangeError(`Resize the brush by a finite number of wheel steps, not ${String(steps)}.`);
    }
    const resized = brushRadius * CIRCLE_BRUSH_STEP_FACTOR ** steps;
    brushRadius = Math.min(CIRCLE_BRUSH_MAX_PIXELS, Math.max(CIRCLE_BRUSH_MIN_PIXELS, Math.round(resized)));
    return brushRadius;
  }

  function moveCircle(pixelX, pixelY) {
    if (circle) circle.centre = { x: pixelX, y: pixelY };
  }

  // The brush reaches only what faces the camera.
  function circleHits(pixelX, pixelY) {
    const projected = projectCage();
    const { mesh } = state;
    const radiusSquared = brushRadius ** 2;
    const hits = [];
    if (state.mode === 'vertex') {
      for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
        if (!projected.visible[vertex] || !projected.nearVertex[vertex]) continue;
        if ((projected.screenX[vertex] - pixelX) ** 2 + (projected.screenY[vertex] - pixelY) ** 2 <= radiusSquared) hits.push(vertex);
      }
    } else if (state.mode === 'edge') {
      for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
        const start = mesh.edgeVertices[edge * 2];
        const end = mesh.edgeVertices[edge * 2 + 1];
        if (!projected.nearEdge[edge] || !projected.visible[start] || !projected.visible[end]) continue;
        const distance = distanceToSegmentSquared(pixelX, pixelY, projected.screenX[start], projected.screenY[start], projected.screenX[end], projected.screenY[end]);
        if (distance <= radiusSquared) hits.push(edge);
      }
    } else {
      for (let face = 0; face < mesh.faceCount; face += 1) {
        if (projected.nearFace[face] && faceTouchesCircle(face, projected, pixelX, pixelY, radiusSquared)) hits.push(face);
      }
    }
    return hits;
  }

  // A face is under the brush when the circle overlaps its drawn polygon: an edge within reach, or the circle centre inside it.
  function faceTouchesCircle(face, projected, pixelX, pixelY, radiusSquared) {
    const { mesh } = state;
    const first = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    let inside = false;
    for (let corner = first; corner < end; corner += 1) {
      const current = mesh.cornerVertices[corner];
      const following = mesh.cornerVertices[corner + 1 < end ? corner + 1 : first];
      if (!projected.visible[current] || !projected.visible[following]) return false;
      const currentX = projected.screenX[current];
      const currentY = projected.screenY[current];
      const followingX = projected.screenX[following];
      const followingY = projected.screenY[following];
      if (distanceToSegmentSquared(pixelX, pixelY, currentX, currentY, followingX, followingY) <= radiusSquared) return true;
      const crossesRay = (currentY > pixelY) !== (followingY > pixelY);
      if (crossesRay && pixelX < ((followingX - currentX) * (pixelY - currentY)) / (followingY - currentY) + currentX) inside = !inside;
    }
    return inside;
  }

  /** One dab of the brush at a pixel: every element of the mode under it joins the selection, or leaves it with `deselect`. Returns how many changed. */
  function paintCircle(pixelX, pixelY, { deselect = false } = {}) {
    if (!state || !circle || drag) return 0;
    circle.centre = { x: pixelX, y: pixelY };
    let changed = 0;
    for (const element of circleHits(pixelX, pixelY)) {
      if (deselect) {
        if (state.selected.delete(element)) changed += 1;
      } else if (!state.selected.has(element)) {
        state.selected.add(element);
        changed += 1;
      }
    }
    if (changed > 0) noteSelectionChanged();
    return changed;
  }

  function projectCage() {
    const project = controller.worldPointProjector();
    const matrix = state.part.matrix;
    const vertexCount = state.mesh.vertexCount;
    const screenX = new Float32Array(vertexCount);
    const screenY = new Float32Array(vertexCount);
    const visible = new Uint8Array(vertexCount);
    const { nearVertex, nearEdge, nearFace } = nearSideOf();
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const world = transformPoint(matrix, state.positions[vertex * 3], state.positions[vertex * 3 + 1], state.positions[vertex * 3 + 2]);
      const point = project(world);
      screenX[vertex] = point.x;
      screenY[vertex] = point.y;
      visible[vertex] = point.visible ? 1 : 0;
    }
    return { screenX, screenY, visible, nearVertex, nearEdge, nearFace };
  }

  // A vertex or an edge is on the far side when every face that uses it faces away from the camera; with see-through on, nothing is.
  function nearSideOf() {
    const { mesh, positions } = state;
    const nearVertex = new Uint8Array(mesh.vertexCount);
    const nearEdge = new Uint8Array(mesh.edgeCount);
    const nearFace = new Uint8Array(mesh.faceCount);
    const inverse = mat4.invert(mat4.create(), state.part.matrix);
    if (!inverse || seeThrough) {
      nearVertex.fill(1);
      nearEdge.fill(1);
      nearFace.fill(1);
      return { nearVertex, nearEdge, nearFace };
    }
    const camera = controller.viewCamera;
    const eye = transformPoint(inverse, ...camera.eye);
    const forward = transformDirection(inverse, camera.target[0] - camera.eye[0], camera.target[1] - camera.eye[1], camera.target[2] - camera.eye[2]);
    const orthographic = camera.projection === 'orthographic';
    const mirrored = mat4.determinant(state.part.matrix) < 0;
    for (let face = 0; face < mesh.faceCount; face += 1) {
      const first = mesh.faceOffsets[face];
      const end = mesh.faceOffsets[face + 1];
      let normalX = 0;
      let normalY = 0;
      let normalZ = 0;
      for (let corner = first; corner < end; corner += 1) {
        const current = mesh.cornerVertices[corner] * 3;
        const following = mesh.cornerVertices[corner + 1 < end ? corner + 1 : first] * 3;
        normalX += (positions[current + 1] - positions[following + 1]) * (positions[current + 2] + positions[following + 2]);
        normalY += (positions[current + 2] - positions[following + 2]) * (positions[current] + positions[following]);
        normalZ += (positions[current] - positions[following]) * (positions[current + 1] + positions[following + 1]);
      }
      const anchor = mesh.cornerVertices[first] * 3;
      const towardX = orthographic ? -forward[0] : eye[0] - positions[anchor];
      const towardY = orthographic ? -forward[1] : eye[1] - positions[anchor + 1];
      const towardZ = orthographic ? -forward[2] : eye[2] - positions[anchor + 2];
      const facing = normalX * towardX + normalY * towardY + normalZ * towardZ;
      if (mirrored ? facing >= 0 : facing <= 0) continue;
      nearFace[face] = 1;
      for (let corner = first; corner < end; corner += 1) {
        nearVertex[mesh.cornerVertices[corner]] = 1;
        nearEdge[mesh.cornerEdges[corner]] = 1;
      }
    }
    return { nearVertex, nearEdge, nearFace };
  }

  function beginBoxSelect() {
    if (!state || drag) return false;
    circle = null;
    boxArmed = true;
    return true;
  }

  function endBoxSelect() {
    if (boxArmed) announce('');
    boxArmed = false;
    boxRectangle = null;
  }

  /** The rectangle being dragged, drawn until the pointer lets go; null takes it away. */
  function previewBox(rectangle) {
    if (boxArmed) boxRectangle = rectangle;
  }

  /**
   * Selects every element of the mode that lies wholly inside the rectangle (pixels, any two opposite corners). A far-side element
   * joins only while see-through is on. `additive` keeps the current selection. Returns how many elements are selected afterwards.
   */
  function selectInRectangle(firstX, firstY, secondX, secondY, { additive = false } = {}) {
    if (!state || drag) return 0;
    for (const value of [firstX, firstY, secondX, secondY]) {
      if (!Number.isFinite(value)) throw new RangeError(`Pass the rectangle as four finite pixel values, not ${String(value)}.`);
    }
    const left = Math.min(firstX, secondX);
    const right = Math.max(firstX, secondX);
    const top = Math.min(firstY, secondY);
    const bottom = Math.max(firstY, secondY);
    const projected = projectCage();
    const { mesh } = state;
    const inside = vertex => projected.visible[vertex] 
      && projected.screenX[vertex] >= left && projected.screenX[vertex] <= right && projected.screenY[vertex] >= top && projected.screenY[vertex] <= bottom;
    const hits = [];
    if (state.mode === 'vertex') {
      for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
        if (projected.nearVertex[vertex] && inside(vertex)) hits.push(vertex);
      }
    } else if (state.mode === 'edge') {
      for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
        if (projected.nearEdge[edge] && inside(mesh.edgeVertices[edge * 2]) && inside(mesh.edgeVertices[edge * 2 + 1])) hits.push(edge);
      }
    } else {
      for (let face = 0; face < mesh.faceCount; face += 1) {
        if (!projected.nearFace[face]) continue;
        let wholly = true;
        for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner += 1) wholly = wholly && inside(mesh.cornerVertices[corner]);
        if (wholly) hits.push(face);
      }
    }
    state.selected = additive ? new Set([...state.selected, ...hits]) : new Set(hits);
    noteSelectionChanged();
    return state.selected.size;
  }

  function nearestVertex(pixelX, pixelY, projected) {
    const best = { near: null, far: null };
    const bestDistance = { near: VERTEX_PICK_RADIUS_PIXELS ** 2, far: VERTEX_PICK_RADIUS_PIXELS ** 2 };
    for (let vertex = 0; vertex < state.mesh.vertexCount; vertex += 1) {
      if (!projected.visible[vertex]) continue;
      const distance = (projected.screenX[vertex] - pixelX) ** 2 + (projected.screenY[vertex] - pixelY) ** 2;
      const side = projected.nearVertex[vertex] ? 'near' : 'far';
      if (distance < bestDistance[side]) {
        bestDistance[side] = distance;
        best[side] = vertex;
      }
    }
    return best.near ?? best.far;
  }

  function nearestEdge(pixelX, pixelY, projected) {
    const best = { near: null, far: null };
    const bestDistance = { near: EDGE_PICK_RADIUS_PIXELS ** 2, far: EDGE_PICK_RADIUS_PIXELS ** 2 };
    const { edgeVertices } = state.mesh;
    for (let edge = 0; edge < state.mesh.edgeCount; edge += 1) {
      const start = edgeVertices[edge * 2];
      const end = edgeVertices[edge * 2 + 1];
      if (!projected.visible[start] || !projected.visible[end]) continue;
      const distance = distanceToSegmentSquared(pixelX, pixelY, projected.screenX[start], projected.screenY[start], projected.screenX[end], projected.screenY[end]);
      const side = projected.nearEdge[edge] ? 'near' : 'far';
      if (distance < bestDistance[side]) {
        bestDistance[side] = distance;
        best[side] = edge;
      }
    }
    return best.near ?? best.far;
  }

  function faceUnderPointer(pixelX, pixelY) {
    const ray = controller.screenRay(pixelX, pixelY);
    const inverse = mat4.invert(mat4.create(), state.part.matrix);
    if (!inverse) return null;
    const origin = transformPoint(inverse, ...ray.origin);
    const direction = transformDirection(inverse, ...ray.direction);
    const { mesh, positions } = state;
    const cornerPoint = corner => {
      const vertex = mesh.cornerVertices[corner];
      return [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
    };
    let best = null;
    let bestDistance = Infinity;
    for (let face = 0; face < mesh.faceCount; face += 1) {
      const first = mesh.faceOffsets[face];
      const anchor = cornerPoint(first);
      for (let corner = first + 1; corner + 1 < mesh.faceOffsets[face + 1]; corner += 1) {
        const distance = rayTriangleDistance(origin, direction, anchor, cornerPoint(corner), cornerPoint(corner + 1));
        if (distance !== null && distance < bestDistance) {
          bestDistance = distance;
          best = face;
        }
      }
    }
    return best;
  }

  // With see-through on, a click reaches every face drawn under the pointer, front or back: the one whose centre is nearest wins.
  function faceBehindPointer(pixelX, pixelY) {
    const projected = projectCage();
    const { mesh } = state;
    let best = null;
    let bestDistance = Infinity;
    for (let face = 0; face < mesh.faceCount; face += 1) {
      if (!faceTouchesCircle(face, projected, pixelX, pixelY, 0)) continue;
      const first = mesh.faceOffsets[face];
      const end = mesh.faceOffsets[face + 1];
      let centreX = 0;
      let centreY = 0;
      for (let corner = first; corner < end; corner += 1) {
        centreX += projected.screenX[mesh.cornerVertices[corner]];
        centreY += projected.screenY[mesh.cornerVertices[corner]];
      }
      const distance = (centreX / (end - first) - pixelX) ** 2 + (centreY / (end - first) - pixelY) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = face;
      }
    }
    return best;
  }

  /** Picks the element of the current mode under the pixel; `additive` (Shift) toggles it, a click on nothing clears. */
  function pick(pixelX, pixelY, { additive = false } = {}) {
    if (!state || drag) return null;
    const { hit } = elementUnderPointer(pixelX, pixelY);
    if (hit === null) {
      if (!additive) state.selected = new Set();
    } else if (!additive) {
      state.selected = new Set([hit]);
    } else if (state.selected.has(hit)) {
      state.selected.delete(hit);
    } else {
      state.selected.add(hit);
    }
    controller.setTool('translate');
    if (hintShowing && state.selected.size > 0) {
      hintShowing = false;
      announce('');
    }
    return hit;
  }

  // The element of the current mode under the pixel, as pick() finds it, with the projected cage the hit was found on.
  function elementUnderPointer(pixelX, pixelY) {
    const projected = projectCage();
    if (state.mode === 'face') {
      return { hit: seeThrough ? faceBehindPointer(pixelX, pixelY) : faceUnderPointer(pixelX, pixelY), projected };
    }
    const hit = state.mode === 'vertex' ? nearestVertex(pixelX, pixelY, projected) : nearestEdge(pixelX, pixelY, projected);
    return { hit, projected };
  }

  // The edge of a face whose screen segment is nearest the pixel.
  function nearestEdgeOfFace(face, pixelX, pixelY, projected) {
    const { mesh } = state;
    let best = mesh.cornerEdges[mesh.faceOffsets[face]];
    let bestDistance = Infinity;
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner += 1) {
      const edge = mesh.cornerEdges[corner];
      const start = mesh.edgeVertices[edge * 2];
      const end = mesh.edgeVertices[edge * 2 + 1];
      const distance = distanceToSegmentSquared(pixelX, pixelY, projected.screenX[start], projected.screenY[start], projected.screenX[end], projected.screenY[end]);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = edge;
      }
    }
    return best;
  }

  // The next edge round a quad, which a face ring crosses instead of the nearest one; any other face has only its nearest.
  function neighbouringEdgeOfFace(face, edge) {
    const { mesh } = state;
    const first = mesh.faceOffsets[face];
    if (mesh.faceOffsets[face + 1] - first !== 4) return edge;
    for (let offset = 0; offset < 4; offset += 1) {
      if (mesh.cornerEdges[first + offset] === edge) return mesh.cornerEdges[first + (offset + 1) % 4];
    }
    return edge;
  }

  function verticesOfEdges(edges) {
    const vertices = new Set();
    for (const edge of edges) {
      vertices.add(state.mesh.edgeVertices[edge * 2]);
      vertices.add(state.mesh.edgeVertices[edge * 2 + 1]);
    }
    return [...vertices];
  }

  function applySelection(elements, additive) {
    state.selected = additive ? new Set([...state.selected, ...elements]) : new Set(elements);
    noteSelectionChanged();
  }

  /**
   * Alt+click: the loop under the pixel. An edge (or a vertex, by its edges) picks the loop of the nearest edge; a face picks the band of faces
   * that crosses the edge nearest the pixel. `ring` (Ctrl+Alt+click) picks the ring of edges, or in face mode the band across
   * the next edge round the face. Returns how many elements are selected, or null when nothing is under the pixel.
   */
  function pickLoop(pixelX, pixelY, { ring = false, additive = false } = {}) {
    if (!state || drag) return null;
    const { mesh } = state;
    let found = null;
    if (state.mode === 'face') {
      const { hit, projected } = elementUnderPointer(pixelX, pixelY);
      if (hit !== null) {
        const nearest = nearestEdgeOfFace(hit, pixelX, pixelY, projected);
        found = faceLoop(mesh, hit, ring ? neighbouringEdgeOfFace(hit, nearest) : nearest);
      }
    } else {
      const projected = projectCage();
      const edge = nearestEdge(pixelX, pixelY, projected);
      if (edge !== null) {
        const edges = ring ? edgeRing(mesh, edge) : edgeLoop(mesh, edge);
        found = state.mode === 'vertex' ? verticesOfEdges(edges) : edges;
      }
    }
    if (found === null) {
      if (!additive) state.selected = new Set();
      return null;
    }
    applySelection(found, additive);
    return found.length;
  }

  /** L: everything joined to the element under the pixel joins the selection. Returns how many are selected, or null when nothing is there. */
  function selectLinkedAt(pixelX, pixelY) {
    if (!state || drag) return null;
    const { hit } = elementUnderPointer(pixelX, pixelY);
    if (hit === null) return null;
    applySelection(selectLinked(state.mesh, state.mode, [hit]), true);
    return state.selected.size;
  }

  /** Ctrl+L: everything joined to the selection joins it. Returns how many are selected. */
  function selectLinkedFromSelection() {
    if (!state || drag || state.selected.size === 0) return 0;
    applySelection(selectLinked(state.mesh, state.mode, [...state.selected]), false);
    return state.selected.size;
  }

  /** One step of adjacency outward (direction 1) or inward (direction -1) in the current mode. Returns how many are selected. */
  function stepSelection(direction) {
    if (!state || drag || state.selected.size === 0) return 0;
    const step = direction > 0 ? growSelection : shrinkSelection;
    applySelection(step(state.mesh, state.mode, [...state.selected]), false);
    return state.selected.size;
  }

  function selectionCentreWorld() {
    const vertices = selectedVertices();
    if (vertices.size === 0) return null;
    const sum = [0, 0, 0];
    for (const vertex of vertices) {
      for (let axis = 0; axis < 3; axis += 1) sum[axis] += state.positions[vertex * 3 + axis];
    }
    return transformPoint(state.part.matrix, sum[0] / vertices.size, sum[1] / vertices.size, sum[2] / vertices.size);
  }

  /** The mean of the picked vertices in the object's own space, or null when nothing is picked. */
  function selectionCentreLocal() {
    const vertices = selectedVertices();
    if (!state || vertices.size === 0) return null;
    const sum = [0, 0, 0];
    for (const vertex of vertices) {
      for (let axis = 0; axis < 3; axis += 1) sum[axis] += state.positions[vertex * 3 + axis];
    }
    return sum.map(component => component / vertices.size);
  }

  function writePreview() {
    if (!drag.previewing) return;
    try {
      gatherRenderPositions({ positions: state.positions }, state.renderVertexSource, drag.renderPositions);
      previewNormalsOf(state.part.geometry.indices, drag.renderPositions, drag.renderNormals);
      updatePart(getRenderer(), state.ghostPart ?? state.part, drag.renderPositions, drag.renderNormals);
    } catch {
      // A part the renderer cannot rewrite in place (skinned, morphed, LOD) keeps its look; only the cage moves.
      drag.previewing = false;
    }
  }

  function restoreDraggedPositions() {
    const { vertices, basePositions } = drag;
    vertices.forEach((vertex, slot) => {
      for (let axis = 0; axis < 3; axis += 1) state.positions[vertex * 3 + axis] = basePositions[slot * 3 + axis];
    });
    if (drag.previewing) {
      try {
        updatePart(getRenderer(), state.ghostPart ?? state.part, drag.originalRenderPositions, drag.originalRenderNormals);
      } catch {
        drag.previewing = false;
      }
    }
    // The preview marked the geometry live (its values change in place); its values are final again, so caches may measure it.
    if (!drag.wasLive) unmarkLiveGeometry(state.part.geometry);
  }

  function cancelDrag() {
    if (!drag) return;
    restoreDraggedPositions();
    drag = null;
  }

  // The vertices a move changes with their weights (1 for the picked ones, the falloff curve for the ones around them), and where
  // each of them stands before the move.
  function dragTargets(seeds, falloff) {
    let vertices = seeds;
    let weights = null;
    if (falloff) {
      const weightOf = spatialFalloffWeights(state.positions, state.mesh.vertexCount, new Set(seeds), falloff);
      vertices = [...weightOf.keys()];
      weights = Float32Array.from(weightOf.values());
    }
    const basePositions = new Float32Array(vertices.length * 3);
    vertices.forEach((vertex, slot) => {
      for (let axis = 0; axis < 3; axis += 1) basePositions[slot * 3 + axis] = state.positions[vertex * 3 + axis];
    });
    return { vertices, weights, basePositions };
  }

  function beginDrag() {
    if (!state) throw new RangeError('Enter edit mode before moving the selection.');
    const vertices = [...selectedVertices()];
    if (vertices.length === 0) throw new RangeError('Pick a vertex, edge or face to move first.');
    if (state.editCount >= MAX_LOG_ENTRIES) throw new RangeError(LOG_IS_FULL);
    const falloff = proportional?.falloff() ?? null;
    // Refused here, before the pointer moves: a finished drag is never thrown away.
    planMeshMove(state.mesh, vertices, [0, 0, 0], falloff);
    const previewing = state.previewable && getRenderer() !== null;
    drag = {
      seeds: vertices,
      falloff,
      ...dragTargets(vertices, falloff),
      localDelta: [0, 0, 0],
      worldDelta: [0, 0, 0],
      previewing,
      wasLive: isLiveGeometry(state.part.geometry),
      renderPositions: previewing ? new Float32Array(state.part.geometry.positions.length) : null,
      renderNormals: previewing ? new Float32Array(state.part.geometry.normals.length) : null,
      originalRenderPositions: previewing ? Float32Array.from(state.part.geometry.positions) : null,
      originalRenderNormals: previewing ? Float32Array.from(state.part.geometry.normals) : null,
    };
  }

  function moveDrag(worldDelta) {
    if (!drag) return;
    // The edit is in the geometry's own space, so the world move goes through the inverse of the node's matrix: rotation and
    // any non-uniform scale included.
    const inverse = mat4.invert(mat4.create(), state.part.matrix);
    if (!inverse) return;
    const localDelta = transformDirection(inverse, worldDelta[0], worldDelta[1], worldDelta[2]);
    drag.localDelta = localDelta;
    drag.worldDelta = worldDelta;
    drag.vertices.forEach((vertex, slot) => {
      const weight = drag.weights ? drag.weights[slot] : 1;
      for (let axis = 0; axis < 3; axis += 1) state.positions[vertex * 3 + axis] = drag.basePositions[slot * 3 + axis] + localDelta[axis] * weight;
    });
    writePreview();
  }

  function finishDrag(changed) {
    if (!drag) return;
    const { seeds, falloff, localDelta } = drag;
    restoreDraggedPositions();
    drag = null;
    // A move below the rounding step would be an entry that moves nothing and takes one of the 64 slots.
    if (!changed || roundVector(localDelta).every(component => component === 0)) return;
    try {
      writeEntry(planMeshMove(state.mesh, seeds, localDelta, falloff));
    } catch (error) {
      announce(error);
    }
  }

  // One entry of the edit log, as one scene change (one undo step); the cage is read again after it.
  function writeEntry(edit) {
    const { nodeId, geometryId } = state;
    writingOwnEntry = true;
    try {
      controller.applyImportOperations([{ type: 'edit-mesh', geometry: geometryId, edits: [edit] }], { detail: { kind: 'topology', nodeId } });
    } finally {
      refresh();
      writingOwnEntry = false;
    }
  }

  // The topology edits of the Delete and Merge menus: the selection goes in as one entry. The pick is gone after it, because
  // the numbers of the old mesh mean nothing in the new one.
  function runTopologyEdit(plan, done) {
    if (!state) return refuse('Enter edit mode before dissolving or merging.');
    if (drag) return refuse('Let go of the move before dissolving or merging.');
    if (state.editCount >= MAX_LOG_ENTRIES) return refuse(LOG_IS_FULL_FOR_EDIT);
    try {
      writeEntry(plan());
    } catch (error) {
      return refuse(error.message);
    }
    announce(done);
    return { ok: true };
  }

  /** Dissolves the selection as "vertices", "edges" or "faces" (the Delete menu): one undo step. */
  function dissolve(kind) {
    return runTopologyEdit(() => planMeshDissolve(state.mesh, state.mode, state.selected, kind), `Dissolved ${kind}`);
  }

  /** Merges the selected vertices at "center", "first", "last" or "collapse" (the Merge menu): one undo step. */
  function merge(at) {
    return runTopologyEdit(() => planMeshMerge(state.mesh, state.mode, state.selected, at), `Merged the vertices ${at === 'collapse' ? 'by collapse' : `at ${at}`}`);
  }

  /**
   * The radius or the curve changed while a move is held: the vertices it reaches are chosen again from where they stood before
   * the move, and the move already made is applied to them, so the hill widens under the pointer.
   */
  function reweighDrag() {
    if (!drag || !drag.falloff) return;
    const { vertices, basePositions } = drag;
    vertices.forEach((vertex, slot) => {
      for (let axis = 0; axis < 3; axis += 1) state.positions[vertex * 3 + axis] = basePositions[slot * 3 + axis];
    });
    drag.falloff = proportional.falloff() ?? drag.falloff;
    Object.assign(drag, dragTargets(drag.seeds, drag.falloff));
    moveDrag(drag.worldDelta);
  }

  const session = {
    pivot: () => (state ? selectionCentreWorld() : null),
    begin: beginDrag,
    move: moveDrag,
    finish: finishDrag,
    cancel: cancelDrag,
  };

  function sceneStillHoldsDraggedPart() {
    return controller.selectedNodeId === state.nodeId && controller.scene.parts.find(candidate => candidate.name === state.nodeId) === state.part;
  }

  function cancelRunningDrag() {
    if (controller.dragging) {
      controller.cancelGizmoDrag();
    } else {
      cancelDrag();
    }
  }

  /** Reads the cage again after the scene changed under it (undo, redo, a load); the selection stays while its indices still fit. */
  function refresh() {
    if (!state) return;
    if (drag) {
      // A drag keeps its cage while the scene under it is the same one it began on. An undo, a redo or a load that replaced or
      // removed the edited geometry puts the drag away first, then the cage is read again (or edit mode ends) below.
      if (!sceneStillHoldsDraggedPart()) cancelRunningDrag();
      if (drag) return;
    }
    if (controller.selectedNodeId !== state.nodeId) {
      leave();
      return;
    }
    if (geometrySpecOf(controller.exportRecipe(), state.nodeId)?.id !== state.geometryId) {
      announce(MESH_CHANGED);
      leave();
      return;
    }
    const loadFailure = loadCage(state.nodeId, [...state.selected]);
    if (loadFailure) {
      announce(loadFailure);
      leave();
    }
  }

  /**
   * How far the picked element reaches from the move handles' centre on screen, in pixels (0 for one vertex or nothing picked).
   * The handles read it to leave that much of the middle clear, so the picked element stays in view.
   */
  function selectionScreenRadius() {
    const vertices = selectedVertices();
    const centre = selectionCentreWorld();
    if (!centre || vertices.size === 0) return 0;
    const project = controller.worldPointProjector();
    const middle = project(centre);
    let reach = 0;
    for (const vertex of vertices) {
      const world = transformPoint(state.part.matrix, state.positions[vertex * 3], state.positions[vertex * 3 + 1], state.positions[vertex * 3 + 2]);
      const point = project(world);
      if (point.visible) reach = Math.max(reach, Math.hypot(point.x - middle.x, point.y - middle.y));
    }
    return reach;
  }

  // The stroke and fill of these paths come from the stylesheet (`--studio-*` tokens), so the cage follows the theme. `layer` says
  // whether a path goes under the move handles or over them: picked vertices and edges go over, or the handles' centre dot hides them.
  // The circle of the proportional radius around the picked elements, facing the camera. The radius is in the mesh's own units,
  // so the node's scale turns it into a world length.
  function proportionalReachPath() {
    const falloff = proportional?.falloff();
    const centre = falloff ? selectionCentreWorld() : null;
    if (!centre) return '';
    const matrix = state.part.matrix;
    const scale = (Math.hypot(matrix[0], matrix[1], matrix[2]) + Math.hypot(matrix[4], matrix[5], matrix[6]) + Math.hypot(matrix[8], matrix[9], matrix[10])) / 3;
    const project = controller.worldPointProjector();
    const middle = project(centre);
    if (!middle.visible) return '';
    return proportionalCirclePath(centre, falloff.radius * scale, controller.screenRay(middle.x, middle.y).direction, project);
  }

  function cagePaths() {
    if (!state) return [];
    const { screenX, screenY, visible, nearVertex, nearEdge } = projectCage();
    const { mesh } = state;
    const paths = [];
    const point = vertex => `${screenX[vertex].toFixed(1)} ${screenY[vertex].toFixed(1)}`;
    const edgeSegment = edge => {
      const start = mesh.edgeVertices[edge * 2];
      const end = mesh.edgeVertices[edge * 2 + 1];
      return visible[start] && visible[end] ? `M${point(start)}L${point(end)}` : '';
    };
    const dot = vertex => (visible[vertex] ? `M${point(vertex)}h0` : '');
    if (!state.tooLarge) {
      let nearEdges = '';
      let farEdges = '';
      for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
        if (nearEdge[edge]) nearEdges += edgeSegment(edge);
        else farEdges += edgeSegment(edge);
      }
      paths.push({ className: 'crucible-studio-cage-halo', pathData: nearEdges, layer: 'under' });
      paths.push({ className: 'crucible-studio-cage-edges-far', pathData: farEdges, layer: 'under' });
      paths.push({ className: 'crucible-studio-cage-edges', pathData: nearEdges, layer: 'under' });
      if (state.mode === 'vertex') {
        let nearDots = '';
        let farDots = '';
        for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
          if (nearVertex[vertex]) nearDots += dot(vertex);
          else farDots += dot(vertex);
        }
        paths.push({ className: 'crucible-studio-cage-vertices-halo', pathData: nearDots, layer: 'under' });
        paths.push({ className: 'crucible-studio-cage-vertices-far', pathData: farDots, layer: 'under' });
        paths.push({ className: 'crucible-studio-cage-vertices', pathData: nearDots, layer: 'under' });
      }
    }
    let selectedShape = '';
    for (const element of state.selected) {
      if (state.mode === 'vertex') {
        selectedShape += dot(element);
      } else if (state.mode === 'edge') {
        selectedShape += edgeSegment(element);
      } else {
        const corners = [];
        for (let corner = mesh.faceOffsets[element]; corner < mesh.faceOffsets[element + 1]; corner += 1) corners.push(mesh.cornerVertices[corner]);
        if (corners.every(vertex => visible[vertex])) selectedShape += `M${corners.map(point).join('L')}Z`;
      }
    }
    if (state.mode === 'face') {
      paths.push({ className: 'crucible-studio-cage-selected crucible-studio-cage-selected-face', pathData: selectedShape, layer: 'under' });
    } else {
      paths.push({ className: `crucible-studio-cage-selected-halo crucible-studio-cage-selected-halo-${state.mode}`, pathData: selectedShape, layer: 'over' });
      paths.push({ className: `crucible-studio-cage-selected crucible-studio-cage-selected-${state.mode}`, pathData: selectedShape, layer: 'over' });
    }
    const reach = proportionalReachPath();
    if (reach) paths.push({ className: 'crucible-studio-proportional-reach', pathData: reach, layer: 'over' });
    if (boxRectangle) {
      const { left, top, right, bottom } = boxRectangle;
      paths.push({ className: 'crucible-studio-cage-box', pathData: `M${left.toFixed(1)} ${top.toFixed(1)}H${right.toFixed(1)}V${bottom.toFixed(1)}H${left.toFixed(1)}Z`, layer: 'over' });
    }
    if (circle?.centre) {
      const { x, y } = circle.centre;
      const diameter = brushRadius * 2;
      const outline = `M${(x - brushRadius).toFixed(1)} ${y.toFixed(1)}a${brushRadius} ${brushRadius} 0 1 0 ${diameter} 0a${brushRadius} ${brushRadius} 0 1 0 ${-diameter} 0`;
      paths.push({ className: 'crucible-studio-cage-brush', pathData: outline, layer: 'over' });
    }
    return paths;
  }

  // The cage goes under the move handles, which are already in the svg; the picked vertices and edges go over them.
  function draw(documentReference, svg) {
    const under = [];
    const over = [];
    for (const { className, pathData, layer } of cagePaths()) {
      if (pathData === '') continue;
      const path = documentReference.createElementNS(SVG_NAMESPACE, 'path');
      path.setAttribute('class', className);
      path.setAttribute('d', pathData);
      (layer === 'over' ? over : under).push(path);
    }
    svg.prepend(...under);
    svg.append(...over);
  }

  return Object.freeze({
    get active() { return state !== null; },
    get mode() { return state?.mode ?? null; },
    get nodeId() { return state?.nodeId ?? null; },
    get selection() { return state ? { mode: state.mode, indices: [...state.selected].sort((first, second) => first - second) } : null; },
    get selectionCentre() { return state ? selectionCentreWorld() : null; },
    get cage() { return state ? { positions: state.positions, mesh: state.mesh, tooLarge: state.tooLarge, editCount: state.editCount } : null; },
    conversionOf,
    enter,
    leave,
    setMode,
    clearSelection,
    dissolve,
    merge,
    selectNone,
    invertSelection,
    selectInRectangle,
    beginBoxSelect,
    endBoxSelect,
    previewBox,
    get boxSelecting() { return boxArmed; },
    setSeeThrough,
    partsToDraw,
    get seeThrough() { return seeThrough; },
    beginCircleSelect,
    endCircleSelect,
    resizeCircleBrush,
    wheelCircleBrush,
    moveCircle,
    paintCircle,
    get circleSelecting() { return circle !== null; },
    get brushRadius() { return brushRadius; },
    pick,
    pickLoop,
    selectLinkedAt,
    selectLinkedFromSelection,
    growSelection: () => stepSelection(1),
    shrinkSelection: () => stepSelection(-1),
    refresh,
    cagePaths,
    selectionScreenRadius,
    selectionCentreLocal,
    reweighDrag,
    get holdingMove() { return drag !== null; },
    proportional,
    draw,
  });
}
