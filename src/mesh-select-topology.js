// Selection by topology: edge and face loops, edge rings, linked parts, grow and shrink. Pure functions over a MeshData;
// every one takes element numbers (vertex, edge or face indices) and returns a sorted array of element numbers.
// A loop or a ring walks across the opposite sides of quads and stops at a pole (a vertex that is not 4-valent), a boundary,
// a triangle or a larger polygon, and when it comes back to where it began.

import { UnionFind, edgeCornerTable } from './mesh-topology.js';

const SELECTION_MODES = Object.freeze(['vertex', 'edge', 'face']);

function sortedNumbers(set) {
  return [...set].sort((first, second) => first - second);
}

function assertIndex(name, value, count) {
  if (!Number.isInteger(value) || value < 0 || value >= count) {
    throw new RangeError(`${name} must be a whole number from 0 to ${count - 1}; got ${String(value)}.`);
  }
}

function assertMode(mode) {
  if (!SELECTION_MODES.includes(mode)) {
    throw new RangeError(`Unknown selection mode "${String(mode)}"; use one of ${SELECTION_MODES.join(', ')}.`);
  }
}

function elementCountOf(mesh, mode) {
  if (mode === 'vertex') return mesh.vertexCount;
  return mode === 'edge' ? mesh.edgeCount : mesh.faceCount;
}

function cornersOfFace(mesh, face) {
  return mesh.faceOffsets[face + 1] - mesh.faceOffsets[face];
}

/** The faces that use each edge, as one array of face numbers per edge. */
function facesOfEdges(mesh) {
  const { edgeOffsets, edgeCorners } = edgeCornerTable(mesh);
  const faceOfCorner = new Uint32Array(mesh.cornerCount);
  for (let face = 0; face < mesh.faceCount; face += 1) {
    faceOfCorner.fill(face, mesh.faceOffsets[face], mesh.faceOffsets[face + 1]);
  }
  const faces = [];
  for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
    const row = [];
    for (let slot = edgeOffsets[edge]; slot < edgeOffsets[edge + 1]; slot += 1) row.push(faceOfCorner[edgeCorners[slot]]);
    faces.push(row);
  }
  return faces;
}

/** The edge of a quad face that does not touch `edge`, or -1 when the face is not a quad. */
function oppositeEdgeInQuad(mesh, face, edge) {
  if (cornersOfFace(mesh, face) !== 4) return -1;
  const start = mesh.faceOffsets[face];
  for (let offset = 0; offset < 4; offset += 1) {
    if (mesh.cornerEdges[start + offset] === edge) return mesh.cornerEdges[start + (offset + 2) % 4];
  }
  return -1;
}

/** The edges and faces around each vertex, as arrays per vertex. */
function aroundVertices(mesh) {
  const edges = Array.from({ length: mesh.vertexCount }, () => []);
  const faces = Array.from({ length: mesh.vertexCount }, () => []);
  for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
    edges[mesh.edgeVertices[edge * 2]].push(edge);
    edges[mesh.edgeVertices[edge * 2 + 1]].push(edge);
  }
  for (let face = 0; face < mesh.faceCount; face += 1) {
    for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner += 1) faces[mesh.cornerVertices[corner]].push(face);
  }
  return { edges, faces };
}

/**
 * The edge that continues `edge` straight through `vertex`: the one of the four edges there that shares no face with it.
 * -1 at a pole, a boundary or anywhere the surface around the vertex is not four quads.
 */
function straightThrough(mesh, around, facesByEdge, vertex, edge) {
  const edgesHere = around.edges[vertex];
  if (edgesHere.length !== 4 || around.faces[vertex].length !== 4) return -1;
  if (around.faces[vertex].some(face => cornersOfFace(mesh, face) !== 4)) return -1;
  const facesOfThisEdge = facesByEdge[edge];
  if (facesOfThisEdge.length !== 2) return -1;
  const across = edgesHere.filter(other => other !== edge && !facesByEdge[other].some(face => facesOfThisEdge.includes(face)));
  return across.length === 1 ? across[0] : -1;
}

function otherEnd(mesh, edge, vertex) {
  const first = mesh.edgeVertices[edge * 2];
  return first === vertex ? mesh.edgeVertices[edge * 2 + 1] : first;
}

/** The edges of the loop through `edge`: the edge itself and the ones that carry straight on from both of its ends. */
export function edgeLoop(mesh, edge) {
  assertIndex('edge', edge, mesh.edgeCount);
  const around = aroundVertices(mesh);
  const facesByEdge = facesOfEdges(mesh);
  const loop = new Set([edge]);
  for (const startVertex of [mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]]) {
    let current = edge;
    let vertex = startVertex;
    for (;;) {
      const next = straightThrough(mesh, around, facesByEdge, vertex, current);
      if (next === -1 || loop.has(next)) break;
      loop.add(next);
      vertex = otherEnd(mesh, next, vertex);
      current = next;
    }
  }
  return sortedNumbers(loop);
}

/** The edges of the ring through `edge`: the opposite edge of every quad on both sides, then the next quad, and so on. */
export function edgeRing(mesh, edge) {
  assertIndex('edge', edge, mesh.edgeCount);
  const facesByEdge = facesOfEdges(mesh);
  const ring = new Set([edge]);
  for (const startFace of facesByEdge[edge]) {
    let face = startFace;
    let current = edge;
    for (;;) {
      const next = oppositeEdgeInQuad(mesh, face, current);
      if (next === -1 || ring.has(next)) break;
      ring.add(next);
      const beyond = facesByEdge[next].filter(other => other !== face);
      if (facesByEdge[next].length !== 2 || beyond.length !== 1) break;
      face = beyond[0];
      current = next;
    }
  }
  return sortedNumbers(ring);
}

/**
 * The faces of the loop that crosses `edge` of `face`: the face, the one over the edge, the one over its opposite edge, and so
 * on in both directions, through quads only. `edge` must be one of the face's edges.
 */
export function faceLoop(mesh, face, edge) {
  assertIndex('face', face, mesh.faceCount);
  assertIndex('edge', edge, mesh.edgeCount);
  let touchesFace = false;
  for (let corner = mesh.faceOffsets[face]; corner < mesh.faceOffsets[face + 1]; corner += 1) {
    if (mesh.cornerEdges[corner] === edge) touchesFace = true;
  }
  if (!touchesFace) throw new RangeError(`Edge ${edge} is not an edge of face ${face}; pass one of the face's own edges.`);
  const facesByEdge = facesOfEdges(mesh);
  const loop = new Set([face]);
  const exits = [edge];
  const opposite = oppositeEdgeInQuad(mesh, face, edge);
  if (opposite !== -1) exits.push(opposite);
  for (const exitEdge of exits) {
    let current = face;
    let crossing = exitEdge;
    for (;;) {
      const beyond = facesByEdge[crossing].filter(other => other !== current);
      if (facesByEdge[crossing].length !== 2 || beyond.length !== 1 || loop.has(beyond[0])) break;
      const next = beyond[0];
      if (cornersOfFace(mesh, next) !== 4) break;
      loop.add(next);
      crossing = oppositeEdgeInQuad(mesh, next, crossing);
      current = next;
    }
  }
  return sortedNumbers(loop);
}

/** Every element of `mode` in the connected pieces that hold `elements` (pieces join through shared vertices). */
export function selectLinked(mesh, mode, elements) {
  assertMode(mode);
  const seeds = vertexSetOf(mesh, mode, elements);
  const pieces = new UnionFind(mesh.vertexCount);
  for (let face = 0; face < mesh.faceCount; face += 1) {
    const first = mesh.cornerVertices[mesh.faceOffsets[face]];
    for (let corner = mesh.faceOffsets[face] + 1; corner < mesh.faceOffsets[face + 1]; corner += 1) pieces.union(first, mesh.cornerVertices[corner]);
  }
  const chosenPieces = new Set([...seeds].map(vertex => pieces.find(vertex)));
  const inside = vertex => chosenPieces.has(pieces.find(vertex));
  const linked = [];
  if (mode === 'vertex') {
    for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) if (inside(vertex)) linked.push(vertex);
  } else if (mode === 'edge') {
    for (let edge = 0; edge < mesh.edgeCount; edge += 1) if (inside(mesh.edgeVertices[edge * 2])) linked.push(edge);
  } else {
    for (let face = 0; face < mesh.faceCount; face += 1) if (inside(mesh.cornerVertices[mesh.faceOffsets[face]])) linked.push(face);
  }
  return linked;
}

function vertexSetOf(mesh, mode, elements) {
  const count = elementCountOf(mesh, mode);
  const vertices = new Set();
  for (const element of elements) {
    assertIndex(`${mode} index`, element, count);
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

/** The vertices of each element of `mode`, as an array per element. */
function verticesOfElements(mesh, mode) {
  const rows = [];
  for (let element = 0; element < elementCountOf(mesh, mode); element += 1) rows.push([...vertexSetOf(mesh, mode, [element])]);
  return rows;
}

/**
 * Elements next to each element. Vertices are next to each other along an edge; edges and faces are next to each other when
 * they share a vertex.
 */
function neighbourTable(mesh, mode) {
  const count = elementCountOf(mesh, mode);
  const neighbours = Array.from({ length: count }, () => new Set());
  if (mode === 'vertex') {
    for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
      const first = mesh.edgeVertices[edge * 2];
      const second = mesh.edgeVertices[edge * 2 + 1];
      neighbours[first].add(second);
      neighbours[second].add(first);
    }
    return neighbours;
  }
  const rows = verticesOfElements(mesh, mode);
  const atVertex = Array.from({ length: mesh.vertexCount }, () => []);
  rows.forEach((vertices, element) => vertices.forEach(vertex => atVertex[vertex].push(element)));
  for (const sharing of atVertex) {
    for (const element of sharing) for (const other of sharing) if (other !== element) neighbours[element].add(other);
  }
  return neighbours;
}

/** The selection plus every element next to it. */
export function growSelection(mesh, mode, elements) {
  assertMode(mode);
  const count = elementCountOf(mesh, mode);
  const grown = new Set();
  for (const element of elements) assertIndex(`${mode} index`, element, count);
  const neighbours = neighbourTable(mesh, mode);
  for (const element of elements) {
    grown.add(element);
    for (const neighbour of neighbours[element]) grown.add(neighbour);
  }
  return sortedNumbers(grown);
}

/** The selection without the elements that are next to an element that is not selected. */
export function shrinkSelection(mesh, mode, elements) {
  assertMode(mode);
  const count = elementCountOf(mesh, mode);
  const selected = new Set();
  for (const element of elements) {
    assertIndex(`${mode} index`, element, count);
    selected.add(element);
  }
  const neighbours = neighbourTable(mesh, mode);
  const kept = [...selected].filter(element => [...neighbours[element]].every(neighbour => selected.has(neighbour)));
  return sortedNumbers(kept);
}
