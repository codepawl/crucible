import { MAX_SELECTED_ELEMENTS, MERGE_TARGETS } from './mesh-operations.js';

// Planning helpers for Studio edit mode commands: convert the current vertex, edge or face selection
// into deterministic recipe edit entries (`make_face`, `fill_holes`, `grid_fill`, `bridge_edge_loops`,
// `subdivide_edges`, `symmetrize`, `dissolve_*`, `merge_verts`).

const SYMMETRIZE_AXES = Object.freeze(['x', 'y', 'z']);
const SYMMETRIZE_KEEP = Object.freeze(['positive', 'negative']);

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
      for (let corner = mesh.faceOffsets[element]; corner < mesh.faceOffsets[element + 1]; corner += 1) {
        vertices.add(mesh.cornerVertices[corner]);
      }
    }
  }
  return vertices;
}

/** The edges a selection covers: the picked ones, those between two picked vertices, or those around a picked face. */
export function edgesOfSelection(mesh, mode, selected) {
  if (mode === 'edge') {
    return [...selected].sort((first, second) => first - second);
  }
  if (mode === 'vertex') {
    const edges = [];
    for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
      if (selected.has(mesh.edgeVertices[edge * 2]) && selected.has(mesh.edgeVertices[edge * 2 + 1])) {
        edges.push(edge);
      }
    }
    return edges;
  }
  const edges = new Set();
  for (const face of selected) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner += 1) {
      edges.add(mesh.cornerEdges[corner]);
    }
  }
  return [...edges].sort((first, second) => first - second);
}

function edgePairsOf(mesh, edges) {
  return edges.map(edge => [mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]]);
}

function pickedVerticesInOrder(mesh, mode, selected) {
  if (mode === 'vertex') {
    return [...selected];
  }
  return [...verticesOfSelection(mesh, mode, selected)].sort((first, second) => first - second);
}

function refuseTooManyElements(count, noun, verb) {
  if (count > MAX_SELECTED_ELEMENTS) {
    throw new RangeError(`${verb} more than ${MAX_SELECTED_ELEMENTS} ${noun} at once is not possible; pick fewer.`);
  }
}

/** The log entry for F (Make face or edge): connects two vertices on a face, or creates a face from 3+ vertices. */
export function planMeshMakeFace(mesh, mode, selected) {
  const vertices = pickedVerticesInOrder(mesh, mode, selected);
  if (vertices.length < 2) {
    throw new RangeError('Pick at least two vertices on a face to make an edge, or three or more vertices to make a face.');
  }
  refuseTooManyElements(vertices.length, 'vertices', 'Making a face from');
  return { op: 'make_face', vertices };
}

/** The log entry for Fill: fills the selected vertices/loop with a face, or caps all open boundaries when nothing is picked. */
export function planMeshFill(mesh, mode, selected) {
  if (selected.size === 0) {
    return { op: 'fill_holes' };
  }
  const vertices = pickedVerticesInOrder(mesh, mode, selected);
  if (vertices.length < 3) {
    throw new RangeError('Fill needs a closed boundary loop or at least three vertices; pick a loop or clear the selection to fill all open holes.');
  }
  refuseTooManyElements(vertices.length, 'vertices', 'Filling');
  return { op: 'make_face', vertices };
}

/** The log entry for Grid Fill: fills closed even-sided boundary loops in the selection with quad grids. */
export function planMeshGridFill(mesh, mode, selected) {
  const edges = edgesOfSelection(mesh, mode, selected);
  if (edges.length === 0) {
    throw new RangeError('Grid Fill needs a closed boundary loop of edges: pick an open loop first.');
  }
  refuseTooManyElements(edges.length, 'edges', 'Grid-filling');
  return { op: 'grid_fill', edges: { edges: edgePairsOf(mesh, edges) } };
}

/** The log entry for Bridge Edge Loops: joins two boundary loops in the selection with a strip of quads. */
export function planMeshBridge(mesh, mode, selected, { segments = 1, twistOffset = 0 } = {}) {
  if (!Number.isInteger(segments) || segments < 1 || segments > 64) {
    throw new RangeError(`Bridge segments must be a whole number from 1 to 64, not ${String(segments)}.`);
  }
  if (!Number.isInteger(twistOffset) || twistOffset < -4096 || twistOffset > 4096) {
    throw new RangeError(`Bridge twist offset must be a whole number from -4096 to 4096, not ${String(twistOffset)}.`);
  }
  const edges = edgesOfSelection(mesh, mode, selected);
  if (edges.length === 0) {
    throw new RangeError('Bridge Edge Loops needs two open boundary loops: pick the edges or vertices of two loops first.');
  }
  refuseTooManyElements(edges.length, 'edges', 'Bridging');
  return { op: 'bridge_edge_loops', edges: { edges: edgePairsOf(mesh, edges) }, segments, twistOffset };
}

/** The log entry for Subdivide: splits the selected edges (and subdivides quads across them). */
export function planMeshSubdivide(mesh, mode, selected, { cuts = 1 } = {}) {
  if (!Number.isInteger(cuts) || cuts < 1 || cuts > 16) {
    throw new RangeError(`Subdivide cuts must be a whole number from 1 to 16, not ${String(cuts)}.`);
  }
  const edges = edgesOfSelection(mesh, mode, selected);
  if (edges.length === 0) {
    throw new RangeError('Subdivide needs at least one edge: pick an edge, two vertices that share one, or a face.');
  }
  refuseTooManyElements(edges.length, 'edges', 'Subdividing');
  return { op: 'subdivide_edges', edges: { edges: edgePairsOf(mesh, edges) }, cuts };
}

/** The faces whose every corner vertex belongs to `vertexSet`, and the covered vertices. */
export function facesInsideVertexSet(mesh, vertexSet) {
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

function facesOfSelection(mesh, mode, selected) {
  if (mode === 'face') return [...selected].sort((first, second) => first - second);
  return facesInsideVertexSet(mesh, verticesOfSelection(mesh, mode, selected)).faces;
}

/** The log entry that dissolves the selection as `kind` ("vertices", "edges" or "faces"), from the Delete menu. */
export function planMeshDissolve(mesh, mode, selected, kind) {
  if (kind === 'vertices') {
    const vertices = [...verticesOfSelection(mesh, mode, selected)].sort((first, second) => first - second);
    if (vertices.length === 0) throw new RangeError('Pick a vertex, edge or face to dissolve first.');
    refuseTooManyElements(vertices.length, 'vertices', 'Dissolving');
    return { op: 'dissolve_verts', verts: { vertices } };
  }
  if (kind === 'edges') {
    const edges = edgesOfSelection(mesh, mode, selected);
    if (edges.length === 0) throw new RangeError('Dissolve Edges needs at least one edge: pick an edge, two vertices that share one, or a face.');
    refuseTooManyElements(edges.length, 'edges', 'Dissolving');
    return { op: 'dissolve_edges', edges: { edges: edgePairsOf(mesh, edges) }, removeStraight: true };
  }
  if (kind === 'faces') {
    const faces = facesOfSelection(mesh, mode, selected);
    if (faces.length === 0) throw new RangeError('Dissolve Faces needs at least one whole face: pick a face, or every vertex of one.');
    refuseTooManyElements(faces.length, 'faces', 'Dissolving');
    return { op: 'dissolve_faces', select: { faces } };
  }
  throw new RangeError(`Unknown dissolve kind "${String(kind)}"; use one of vertices, edges, faces.`);
}

/** The log entry that merges the selected vertices at `at` (center, first, last or collapse), from the Merge menu. */
export function planMeshMerge(mesh, mode, selected, at) {
  if (!MERGE_TARGETS.includes(at)) throw new RangeError(`Unknown merge target "${String(at)}"; use one of ${MERGE_TARGETS.join(', ')}.`);
  if ((at === 'first' || at === 'last') && mode !== 'vertex') {
    throw new RangeError('At First and At Last follow the order the vertices were picked, so they work in vertex mode (key 1).');
  }
  const vertices = pickedVerticesInOrder(mesh, mode, selected);
  if (vertices.length < 2) throw new RangeError('Pick at least two vertices to merge.');
  refuseTooManyElements(vertices.length, 'vertices', 'Merging');
  return { op: 'merge_verts', vertices, at };
}

/** The log entry for Symmetrize: cuts the mesh along an axis plane and mirrors the kept side. */
export function planMeshSymmetrize(_mesh, _mode, _selected, { axis = 'x', keep = 'positive' } = {}) {
  if (!SYMMETRIZE_AXES.includes(axis)) {
    throw new RangeError(`Unknown symmetrize axis "${String(axis)}"; use one of ${SYMMETRIZE_AXES.join(', ')}.`);
  }
  if (!SYMMETRIZE_KEEP.includes(keep)) {
    throw new RangeError(`Unknown symmetrize keep side "${String(keep)}"; use one of ${SYMMETRIZE_KEEP.join(', ')}.`);
  }
  return { op: 'symmetrize', axis, keep };
}
