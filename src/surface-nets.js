// Surface nets on a regular grid of signed distances (negative inside): one vertex in each cell the surface crosses,
// one quad around each crossing grid edge. Shared by the voxel remesh and the sdf geometry.

const CELL_CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const CELL_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

const MAX_GRID_CELLS = 16_777_216;

/** One vertex per crossed cell, at the mean of the edge crossings. Returns the cell-to-vertex map and positions. */
export function placeCellVertices(distances, grid, origin) {
  const points = grid?.points;
  if (!Array.isArray(points) || points.length !== 3 || !points.every(count => Number.isInteger(count) && count >= 2)) {
    throw new RangeError('Surface nets grid.points must be three integers of at least 2.');
  }
  const [pointsX, pointsY, pointsZ] = points;
  const cellsX = pointsX - 1;
  const cellsY = pointsY - 1;
  const cellCount = cellsX * cellsY * (pointsZ - 1);
  if (cellCount > MAX_GRID_CELLS) {
    throw new RangeError(`Surface nets grid has ${cellCount} cells, over the limit of ${MAX_GRID_CELLS}.`);
  }
  const cellVertex = new Int32Array(cellCount).fill(-1);
  const positions = [];
  const values = new Float64Array(8);
  for (let z = 0; z < pointsZ - 1; z++) {
    for (let y = 0; y < cellsY; y++) {
      for (let x = 0; x < cellsX; x++) {
        let negative = 0;
        for (let corner = 0; corner < 8; corner++) {
          const [dx, dy, dz] = CELL_CORNERS[corner];
          values[corner] = distances[((z + dz) * pointsY + y + dy) * pointsX + x + dx];
          if (values[corner] < 0) negative++;
        }
        if (negative === 0 || negative === 8) continue;
        const sum = [0, 0, 0];
        let crossings = 0;
        for (const [start, end] of CELL_EDGES) {
          if ((values[start] < 0) === (values[end] < 0)) continue;
          const fraction = values[start] / (values[start] - values[end]);
          for (let axis = 0; axis < 3; axis++) {
            sum[axis] += CELL_CORNERS[start][axis] + fraction * (CELL_CORNERS[end][axis] - CELL_CORNERS[start][axis]);
          }
          crossings++;
        }
        cellVertex[(z * cellsY + y) * cellsX + x] = positions.length / 3;
        positions.push(
          origin[0] + (x + sum[0] / crossings) * grid.edge,
          origin[1] + (y + sum[1] / crossings) * grid.edge,
          origin[2] + (z + sum[2] / crossings) * grid.edge,
        );
      }
    }
  }
  return { cellVertex, positions };
}

// For each axis, its two other axes in cyclic order (u, v). Seen from the positive axis, the four cells around an
// edge run counterclockwise through (-1,-1), (0,-1), (0,0), (-1,0) in (u, v).
const AXIS_BASES = [[1, 2], [2, 0], [0, 1]];
const QUAD_OFFSETS = [[-1, -1], [0, -1], [0, 0], [-1, 0]];

/**
 * One quad of cell vertices per grid edge that crosses the surface, wound so the normal points outward. When
 * `insidePoints` or `outsidePoints` is an array, it receives the inside or the outside grid point of each quad (one
 * entry per quad, in quad order), for `splitSaddleVertices`.
 */
export function quadsAroundEdges(distances, grid, cellVertex, insidePoints = null, outsidePoints = null) {
  const cellsPerAxis = grid.points.map(count => count - 1);
  const [pointsX, pointsY, pointsZ] = grid.points;
  const strides = [1, pointsX, pointsX * pointsY];
  const quads = [];
  const point = [0, 0, 0];
  for (let z = 0; z < pointsZ; z++) {
    for (let y = 0; y < pointsY; y++) {
      for (let x = 0; x < pointsX; x++) {
        point[0] = x;
        point[1] = y;
        point[2] = z;
        const index = (z * pointsY + y) * pointsX + x;
        for (let axis = 0; axis < 3; axis++) {
          const [u, v] = AXIS_BASES[axis];
          if (point[axis] + 1 >= grid.points[axis] || point[u] === 0 || point[v] === 0) continue;
          const here = distances[index];
          if ((here < 0) === (distances[index + strides[axis]] < 0)) continue;
          const quad = QUAD_OFFSETS.map(([stepU, stepV]) => cellVertexAt(cellVertex, cellsPerAxis, point, axis, u, v, stepU, stepV));
          if (quad.includes(-1)) continue;
          quads.push(here < 0 ? quad : quad.reverse());
          insidePoints?.push(here < 0 ? index : index + strides[axis]);
          outsidePoints?.push(here < 0 ? index + strides[axis] : index);
        }
      }
    }
  }
  return quads;
}

function cellVertexAt(cellVertex, cellsPerAxis, point, axis, u, v, stepU, stepV) {
  const cell = [point[0], point[1], point[2]];
  cell[u] += stepU;
  cell[v] += stepV;
  if (cell[0] >= cellsPerAxis[0] || cell[1] >= cellsPerAxis[1] || cell[2] >= cellsPerAxis[2]) return -1;
  return cellVertex[(cell[2] * cellsPerAxis[1] + cell[1]) * cellsPerAxis[0] + cell[0]];
}

// A grid face whose four corners alternate inside and outside (a saddle) crosses the surface on all four of its edges,
// so the four quads around those edges all join the same two cell vertices and that edge has four quads. Every quad
// belongs to the grid edge between one inside and one outside point; the two quads that share an inside point are the
// two halves of one sheet, so the pair of cell vertices is split in two and each sheet keeps its own copy. A cell with
// several saddle faces splits into one copy for each sheet that passes through it.
const SPLIT_PULL = 0.1;

function findRoot(parents, slot) {
  let root = slot;
  while (parents[root] !== root) root = parents[root];
  while (parents[slot] !== root) {
    const next = parents[slot];
    parents[slot] = root;
    slot = next;
  }
  return root;
}

function quadsByEdge(quads) {
  const edges = new Map();
  quads.forEach((quad, quadIndex) => {
    for (let corner = 0; corner < 4; corner++) {
      const first = quad[corner];
      const second = quad[(corner + 1) % 4];
      const key = first < second ? `${first},${second}` : `${second},${first}`;
      if (!edges.has(key)) edges.set(key, { first: Math.min(first, second), second: Math.max(first, second), quadIndices: [] });
      edges.get(key).quadIndices.push(quadIndex);
    }
  });
  return edges;
}

// The quads that stay one sheet at this edge: both of a plain edge, or the two that share a grid point on a saddle.
function sheetPairs(quadIndices, sheetPoints) {
  if (quadIndices.length !== 4) return [quadIndices];
  const byPoint = new Map();
  for (const quadIndex of quadIndices) {
    const point = sheetPoints[quadIndex];
    byPoint.set(point, [...(byPoint.get(point) ?? []), quadIndex]);
  }
  const groups = [...byPoint.values()];
  return groups.length === 2 && groups.every(group => group.length === 2) ? groups : [quadIndices];
}

function hasFourQuadEdge(quads) {
  return [...quadsByEdge(quads).values()].some(edge => edge.quadIndices.length === 4);
}

function splitBySheetPoints(quads, sheetPoints, positions) {
  const edges = quadsByEdge(quads);
  const parents = Int32Array.from({ length: quads.length * 4 }, (value, slot) => slot);
  const slotOf = (quadIndex, vertex) => quadIndex * 4 + quads[quadIndex].indexOf(vertex);
  for (const { first, second, quadIndices } of edges.values()) {
    for (const group of sheetPairs(quadIndices, sheetPoints)) {
      for (const vertex of [first, second]) {
        const rootSlot = findRoot(parents, slotOf(group[0], vertex));
        for (const quadIndex of group.slice(1)) parents[findRoot(parents, slotOf(quadIndex, vertex))] = rootSlot;
      }
    }
  }
  return rebuildWithCopies(quads, positions, parents);
}

/**
 * Splits cell vertices where four quads share an edge, so every such edge joins exactly two quads. `insidePoints` and
 * `outsidePoints` are the arrays `quadsAroundEdges` filled. The quads are paired by their shared inside point (a convex
 * saddle); when a four-quad edge is left, by their shared outside point (a concave one). When neither pairing separates
 * the sheets, it throws. Returns new quads and positions; the input is left as it was.
 */
export function splitSaddleVertices(quads, insidePoints, positions, outsidePoints = null, fixHint = 'Use a smaller or a different voxelSize.') {
  if (!hasFourQuadEdge(quads)) return { quads, positions };
  const attempts = outsidePoints ? [insidePoints, outsidePoints] : [insidePoints];
  for (const sheetPoints of attempts) {
    const split = splitBySheetPoints(quads, sheetPoints, positions);
    if (!hasFourQuadEdge(split.quads)) return split;
  }
  throw new RangeError(`the mesh met a saddle it could not separate: the surface is thinner than one cell where two parts touch at a corner. ${fixHint}`);
}

function rebuildWithCopies(quads, positions, parents) {
  const copyOfRoot = new Map();
  const copiesPerVertex = new Map();
  const copyMembers = new Map();
  const nextPositions = positions.slice();
  const nextQuads = quads.map((quad, quadIndex) => quad.map((vertex, corner) => {
    const root = findRoot(parents, quadIndex * 4 + corner);
    if (!copyOfRoot.has(root)) {
      const copiesSoFar = copiesPerVertex.get(vertex) ?? 0;
      const copyIndex = copiesSoFar === 0 ? vertex : nextPositions.length / 3;
      if (copiesSoFar > 0) nextPositions.push(0, 0, 0);
      copiesPerVertex.set(vertex, copiesSoFar + 1);
      copyOfRoot.set(root, copyIndex);
      copyMembers.set(copyIndex, { vertex, quadIndices: new Set() });
    }
    const copyIndex = copyOfRoot.get(root);
    copyMembers.get(copyIndex).quadIndices.add(quadIndex);
    return copyIndex;
  }));
  pullCopiesApart({ copyMembers, copiesPerVertex, quads, positions, nextPositions });
  return { quads: nextQuads, positions: nextPositions };
}

// Copies of one cell vertex start at the same point; each moves a tenth of the way to the middle of its own sheet so the
// two sheets do not touch and no later edit welds them back together.
function pullCopiesApart({ copyMembers, copiesPerVertex, quads, positions, nextPositions }) {
  for (const [copyIndex, { vertex, quadIndices }] of copyMembers) {
    if (copiesPerVertex.get(vertex) < 2) continue;
    const middle = [0, 0, 0];
    let count = 0;
    for (const quadIndex of quadIndices) {
      for (const other of quads[quadIndex]) {
        for (let axis = 0; axis < 3; axis++) middle[axis] += positions[other * 3 + axis];
        count++;
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      const here = positions[vertex * 3 + axis];
      nextPositions[copyIndex * 3 + axis] = here + SPLIT_PULL * (middle[axis] / count - here);
    }
  }
}
