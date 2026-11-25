import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeshData } from '../src/mesh-data.js';
import { edgeLoop, edgeRing, faceLoop, growSelection, selectLinked, shrinkSelection } from '../src/mesh-select-topology.js';

// Loop, ring, linked, grow and shrink selection on known meshes (#3293).

const SIDES = 8;

function meshOf(positionList, faceList) {
  const faceOffsets = new Uint32Array(faceList.length + 1);
  faceList.forEach((face, index) => { faceOffsets[index + 1] = faceOffsets[index] + face.length; });
  return createMeshData({
    positions: new Float32Array(positionList.flat()),
    faceOffsets,
    cornerVertices: new Uint32Array(faceList.flat()),
  });
}

// Three rings of 8 vertices (ring r, side i is vertex r * 8 + i), two bands of 8 quads (band 0 faces 0 to 7, band 1 faces 8 to 15)
// and an 8-sided cap at each end (faces 16 and 17).
function cylinder() {
  const positions = [];
  for (let ring = 0; ring < 3; ring += 1) {
    for (let side = 0; side < SIDES; side += 1) {
      const angle = (side / SIDES) * Math.PI * 2;
      positions.push([Math.cos(angle), ring, Math.sin(angle)]);
    }
  }
  const faces = [];
  for (let band = 0; band < 2; band += 1) {
    for (let side = 0; side < SIDES; side += 1) {
      const next = (side + 1) % SIDES;
      faces.push([band * SIDES + side, band * SIDES + next, (band + 1) * SIDES + next, (band + 1) * SIDES + side]);
    }
  }
  faces.push([...Array(SIDES).keys()].reverse());
  faces.push([...Array(SIDES).keys()].map(side => 2 * SIDES + side));
  return meshOf(positions, faces);
}

// A 3 by 3 grid of quads: vertex (column, row) is row * 4 + column, face (column, row) is row * 3 + column.
function gridPositions() {
  const positions = [];
  for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) positions.push([column, row, 0]);
  return positions;
}

function gridFaces() {
  const faces = [];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const corner = row * 4 + column;
      faces.push([corner, corner + 1, corner + 5, corner + 4]);
    }
  }
  return faces;
}

const grid = () => meshOf(gridPositions(), gridFaces());

// The grid with its middle quad cut into two triangles.
function gridWithTriangles() {
  const faces = gridFaces();
  faces.splice(4, 1, [5, 6, 10], [5, 10, 9]);
  return meshOf(gridPositions(), faces);
}

// The grid and, apart from it, one quad of its own (vertices 16 to 19).
function gridAndLooseQuad() {
  const positions = [...gridPositions(), [10, 0, 0], [11, 0, 0], [11, 1, 0], [10, 1, 0]];
  return meshOf(positions, [...gridFaces(), [16, 17, 18, 19]]);
}

function edgeBetween(mesh, first, second) {
  for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
    const ends = [mesh.edgeVertices[edge * 2], mesh.edgeVertices[edge * 2 + 1]];
    if (ends.includes(first) && ends.includes(second)) return edge;
  }
  throw new Error(`no edge between ${first} and ${second}`);
}

function edgesBetween(mesh, pairs) {
  return pairs.map(([first, second]) => edgeBetween(mesh, first, second)).sort((a, b) => a - b);
}

test('an edge loop around the middle of a cylinder is its 8 edges, from any one of them', () => {
  const mesh = cylinder();
  const middleRing = edgesBetween(mesh, [...Array(SIDES).keys()].map(side => [SIDES + side, SIDES + (side + 1) % SIDES]));
  for (const edge of middleRing) assert.deepEqual(edgeLoop(mesh, edge), middleRing);
  assert.equal(middleRing.length, 8);
});

test('an edge loop stops at the 3-valent corners of a cylinder end, so an end edge and a side edge stay short', () => {
  const mesh = cylinder();
  const endEdge = edgeBetween(mesh, 0, 1);
  assert.deepEqual(edgeLoop(mesh, endEdge), [endEdge]);
  const lowerSide = edgeBetween(mesh, 0, SIDES);
  const upperSide = edgeBetween(mesh, SIDES, 2 * SIDES);
  assert.deepEqual(edgeLoop(mesh, lowerSide), [lowerSide, upperSide].sort((a, b) => a - b));
});

test('an edge loop on a grid runs to the boundary and stops there', () => {
  const mesh = grid();
  const inner = edgeBetween(mesh, 5, 6);
  assert.deepEqual(edgeLoop(mesh, inner), edgesBetween(mesh, [[4, 5], [5, 6], [6, 7]]));
  const boundary = edgeBetween(mesh, 1, 2);
  assert.deepEqual(edgeLoop(mesh, boundary), [boundary]);
});

test('an edge loop stops at a triangle', () => {
  const mesh = gridWithTriangles();
  const edge = edgeBetween(mesh, 4, 5);
  assert.deepEqual(edgeLoop(mesh, edge), [edge]);
});

test('an edge ring crosses the quads of a grid and ends at the boundary', () => {
  const mesh = grid();
  assert.deepEqual(edgeRing(mesh, edgeBetween(mesh, 5, 6)), edgesBetween(mesh, [[1, 2], [5, 6], [9, 10], [13, 14]]));
});

test('an edge ring around a cylinder band is its 8 vertical edges, and stops at the end caps', () => {
  const mesh = cylinder();
  const lowerBand = edgesBetween(mesh, [...Array(SIDES).keys()].map(side => [side, SIDES + side]));
  assert.deepEqual(edgeRing(mesh, edgeBetween(mesh, 3, SIDES + 3)), lowerBand);
  const middleEdge = edgeBetween(mesh, SIDES, SIDES + 1);
  assert.deepEqual(edgeRing(mesh, middleEdge), edgesBetween(mesh, [[0, 1], [SIDES, SIDES + 1], [2 * SIDES, 2 * SIDES + 1]]));
});

test('a face loop walks across the opposite edges of quads all the way round a cylinder band', () => {
  const mesh = cylinder();
  const sharedWithNeighbour = edgeBetween(mesh, 1, SIDES + 1);
  assert.deepEqual(faceLoop(mesh, 0, sharedWithNeighbour), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('a face loop across the other pair of edges goes up the cylinder and stops at the cap', () => {
  const mesh = cylinder();
  assert.deepEqual(faceLoop(mesh, 0, edgeBetween(mesh, SIDES, SIDES + 1)), [0, 8]);
});

test('a face loop on a grid runs to the boundary on both sides, and stops at triangles', () => {
  assert.deepEqual(faceLoop(grid(), 4, edgeBetween(grid(), 5, 9)), [3, 4, 5]);
  const mesh = gridWithTriangles();
  assert.deepEqual(faceLoop(mesh, 3, edgeBetween(mesh, 5, 9)), [3]);
});

test('select linked takes the whole piece in the mode asked, and leaves the other piece alone', () => {
  const mesh = gridAndLooseQuad();
  assert.deepEqual(selectLinked(mesh, 'face', [0]), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(selectLinked(mesh, 'face', [9]), [9]);
  assert.deepEqual(selectLinked(mesh, 'vertex', [17]), [16, 17, 18, 19]);
  assert.equal(selectLinked(mesh, 'edge', [edgeBetween(mesh, 0, 1)]).length, 24);
  assert.deepEqual(selectLinked(mesh, 'face', [0, 9]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('grow adds the elements next to the selection in the current mode', () => {
  const mesh = grid();
  assert.deepEqual(growSelection(mesh, 'vertex', [0]), [0, 1, 4]);
  assert.deepEqual(growSelection(mesh, 'face', [0]), [0, 1, 3, 4]);
  assert.equal(growSelection(mesh, 'face', [4]).length, 9);
  const edge = edgeBetween(mesh, 0, 1);
  assert.deepEqual(growSelection(mesh, 'edge', [edge]), edgesBetween(mesh, [[0, 1], [0, 4], [1, 2], [1, 5]]));
  assert.deepEqual(growSelection(mesh, 'face', []), []);
});

test('shrink takes away the elements that are next to something not selected', () => {
  const mesh = grid();
  assert.deepEqual(shrinkSelection(mesh, 'vertex', [0, 1, 4]), [0]);
  assert.deepEqual(shrinkSelection(mesh, 'face', [0, 1, 3, 4]), [0]);
  const allFaces = [...Array(9).keys()];
  assert.deepEqual(shrinkSelection(mesh, 'face', allFaces), allFaces);
  const grownEdges = growSelection(mesh, 'edge', [edgeBetween(mesh, 5, 6)]);
  assert.deepEqual(shrinkSelection(mesh, 'edge', grownEdges), [edgeBetween(mesh, 5, 6)]);
});

test('grow then shrink brings a single face back', () => {
  const mesh = grid();
  assert.deepEqual(shrinkSelection(mesh, 'face', growSelection(mesh, 'face', [0])), [0]);
});

test('a bad element number or mode says what to pass', () => {
  const mesh = grid();
  assert.throws(() => edgeLoop(mesh, mesh.edgeCount), /edge must be a whole number from 0 to/);
  assert.throws(() => edgeRing(mesh, -1), RangeError);
  assert.throws(() => faceLoop(mesh, 0, edgeBetween(mesh, 10, 11)), /not an edge of face 0/);
  assert.throws(() => growSelection(mesh, 'corner', [0]), /Unknown selection mode "corner"/);
  assert.throws(() => selectLinked(mesh, 'face', [99]), /face index must be/);
});
