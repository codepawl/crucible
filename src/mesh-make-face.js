import { checkPickedVertices } from './mesh-merge.js';
import {
  buildPolygonMesh,
  edgeFaceCounts,
  facePolygons,
} from './mesh-polygons.js';

// Create a face from 3+ picked vertices (closing a boundary loop, chain, or planar cycle with consistent winding),
// or split a shared face with an edge between 2 picked vertices.

function pointOf(mesh, vertex) {
  const base = vertex * 3;
  return [mesh.positions[base], mesh.positions[base + 1], mesh.positions[base + 2]];
}

function addVector(first, second) {
  return [first[0] + second[0], first[1] + second[1], first[2] + second[2]];
}

function subtractVector(first, second) {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function dotVector(first, second) {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function crossVector(first, second) {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

function normalizeVector(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length <= 1e-12) {
    return null;
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function edgeExistsBetween(mesh, first, second) {
  for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
    const start = mesh.edgeVertices[edge * 2];
    const end = mesh.edgeVertices[edge * 2 + 1];
    if ((start === first && end === second) || (start === second && end === first)) {
      return true;
    }
  }
  return false;
}

function splitPolygonAcross(polygon, firstIndex, secondIndex, tag) {
  const lower = Math.min(firstIndex, secondIndex);
  const upper = Math.max(firstIndex, secondIndex);
  const tags = polygon.tags.includes(tag) ? [...polygon.tags] : [...polygon.tags, tag];
  const firstHalf = {
    vertices: polygon.vertices.slice(lower, upper + 1),
    sourceFace: polygon.sourceFace,
    sourceCorners: polygon.sourceCorners.slice(lower, upper + 1),
    sourceEdges: [...polygon.sourceEdges.slice(lower, upper), -1],
    keepTags: true,
    tags,
  };
  const secondHalf = {
    vertices: [...polygon.vertices.slice(upper), ...polygon.vertices.slice(0, lower + 1)],
    sourceFace: polygon.sourceFace,
    sourceCorners: [...polygon.sourceCorners.slice(upper), ...polygon.sourceCorners.slice(0, lower + 1)],
    sourceEdges: [...polygon.sourceEdges.slice(upper), ...polygon.sourceEdges.slice(0, lower), -1],
    keepTags: true,
    tags,
  };
  return [firstHalf, secondHalf];
}

function makeEdgeBetweenVertices(mesh, first, second, name) {
  if (edgeExistsBetween(mesh, first, second)) {
    throw new RangeError(`Vertices ${first} and ${second} already share an edge; pick two non-adjacent vertices on the same face to split it, or three or more vertices to make a face.`);
  }
  const polygons = facePolygons(mesh);
  const output = [];
  let splitFaces = 0;
  const tag = `${name}.fill`;
  for (const polygon of polygons) {
    const firstIndex = polygon.vertices.indexOf(first);
    const secondIndex = polygon.vertices.indexOf(second);
    if (firstIndex === -1 || secondIndex === -1) {
      output.push(polygon);
      continue;
    }
    const [halfA, halfB] = splitPolygonAcross(polygon, firstIndex, secondIndex, tag);
    output.push(halfA, halfB);
    splitFaces += 1;
  }
  if (splitFaces === 0) {
    throw new RangeError(`Vertices ${first} and ${second} do not share a face; a mesh cannot hold a loose edge. Pick two vertices on the same face to split it, or pick three or more vertices to make a face.`);
  }
  return { mesh: buildPolygonMesh(mesh, output), createdFaces: 0, splitFaces };
}

function faceAlreadyExists(mesh, vertexSet) {
  for (let face = 0; face < mesh.faceCount; face += 1) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    if (end - start !== vertexSet.size) {
      continue;
    }
    let matches = true;
    for (let corner = start; corner < end; corner += 1) {
      if (!vertexSet.has(mesh.cornerVertices[corner])) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

function collectSelectedEdges(mesh, vertexSet) {
  const counts = edgeFaceCounts(mesh);
  const boundaryMap = new Map();
  const boundaryAdjacency = new Map();
  const fullAdjacency = new Map();
  for (const vertex of vertexSet) {
    boundaryAdjacency.set(vertex, []);
    fullAdjacency.set(vertex, []);
  }
  for (let edge = 0; edge < mesh.edgeCount; edge += 1) {
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    if (!vertexSet.has(first) || !vertexSet.has(second)) {
      continue;
    }
    fullAdjacency.get(first).push(second);
    fullAdjacency.get(second).push(first);
    if (counts[edge] === 1) {
      boundaryAdjacency.get(first).push(second);
      boundaryAdjacency.get(second).push(first);
    }
  }
  for (let face = 0; face < mesh.faceCount; face += 1) {
    const start = mesh.faceOffsets[face];
    const end = mesh.faceOffsets[face + 1];
    for (let corner = start; corner < end; corner += 1) {
      const edge = mesh.cornerEdges[corner];
      if (counts[edge] !== 1) {
        continue;
      }
      const from = mesh.cornerVertices[corner];
      const nextCorner = corner + 1 === end ? start : corner + 1;
      const to = mesh.cornerVertices[nextCorner];
      if (!vertexSet.has(from) || !vertexSet.has(to)) {
        continue;
      }
      // Key stores the existing face's half-edge direction so the new face can oppose it.
      boundaryMap.set(`${from},${to}`, { edge, corner, face, nextCorner });
    }
  }
  for (const list of boundaryAdjacency.values()) {
    list.sort((left, right) => left - right);
  }
  for (const list of fullAdjacency.values()) {
    list.sort((left, right) => left - right);
  }
  return { boundaryMap, boundaryAdjacency, fullAdjacency };
}

function trySingleCycle(adjacency, vertexCount) {
  const vertices = [...adjacency.keys()].sort((left, right) => left - right);
  for (const vertex of vertices) {
    if (adjacency.get(vertex).length !== 2) {
      return null;
    }
  }
  const start = vertices[0];
  const ordered = [start];
  const visited = new Set([start]);
  let previous = start;
  let current = adjacency.get(start)[0];
  while (current !== start) {
    ordered.push(current);
    visited.add(current);
    const neighbours = adjacency.get(current);
    const next = neighbours[0] === previous ? neighbours[1] : neighbours[0];
    if (visited.has(next) && next !== start) {
      return null;
    }
    previous = current;
    current = next;
  }
  return ordered.length === vertexCount ? ordered : null;
}

function trySingleOpenChain(adjacency, vertexCount) {
  const endpoints = [];
  for (const [vertex, neighbours] of adjacency.entries()) {
    if (neighbours.length === 1) {
      endpoints.push(vertex);
    } else if (neighbours.length !== 2) {
      return null;
    }
  }
  if (endpoints.length !== 2) {
    return null;
  }
  endpoints.sort((left, right) => left - right);
  const ordered = [endpoints[0]];
  const visited = new Set([endpoints[0]]);
  let previous = -1;
  let current = endpoints[0];
  while (true) {
    const next = adjacency.get(current).find(candidate => candidate !== previous);
    if (next === undefined || visited.has(next)) {
      break;
    }
    ordered.push(next);
    visited.add(next);
    previous = current;
    current = next;
  }
  return ordered.length === vertexCount ? ordered : null;
}

function orientAgainstBoundary(ordered, boundaryMap) {
  let sameDirectionCount = 0;
  let oppositeDirectionCount = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const from = ordered[index];
    const to = ordered[(index + 1) % ordered.length];
    if (boundaryMap.has(`${from},${to}`)) {
      sameDirectionCount += 1;
    } else if (boundaryMap.has(`${to},${from}`)) {
      oppositeDirectionCount += 1;
    }
  }
  if (sameDirectionCount > oppositeDirectionCount) {
    return [...ordered].reverse();
  }
  return ordered;
}

function bestFitNormal(points) {
  let centroid = [0, 0, 0];
  for (const point of points) {
    centroid = addVector(centroid, point);
  }
  centroid = [centroid[0] / points.length, centroid[1] / points.length, centroid[2] / points.length];
  const offsets = points.map(point => subtractVector(point, centroid));
  // Build symmetric covariance matrix and take the cross product of the two most spread axes.
  let bestCross = null;
  let bestArea = 0;
  for (let first = 0; first < offsets.length; first += 1) {
    for (let second = first + 1; second < offsets.length; second += 1) {
      const candidate = crossVector(offsets[first], offsets[second]);
      const area = Math.hypot(candidate[0], candidate[1], candidate[2]);
      if (area > bestArea) {
        bestArea = area;
        bestCross = candidate;
      }
    }
  }
  if (!bestCross || bestArea <= 1e-10) {
    return null;
  }
  // Refine normal via Newell-style covariance weighting on the plane spanned by bestCross.
  const unit = normalizeVector(bestCross);
  if (!unit) {
    return null;
  }
  const axisSum = [0, 0, 0];
  for (let first = 0; first < offsets.length; first += 1) {
    for (let second = first + 1; second < offsets.length; second += 1) {
      const candidate = crossVector(offsets[first], offsets[second]);
      const sign = dotVector(candidate, unit) >= 0 ? 1 : -1;
      axisSum[0] += candidate[0] * sign;
      axisSum[1] += candidate[1] * sign;
      axisSum[2] += candidate[2] * sign;
    }
  }
  const refined = normalizeVector(axisSum) ?? unit;
  return { centroid, normal: refined };
}

function planeBasis(normal) {
  const reference = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const tangent = normalizeVector(crossVector(reference, normal));
  const bitangent = crossVector(normal, tangent);
  return { tangent, bitangent };
}

function orderByPlaneAngle(mesh, vertices) {
  const points = vertices.map(vertex => pointOf(mesh, vertex));
  const plane = bestFitNormal(points);
  if (!plane) {
    throw new RangeError('The selected vertices lie on a straight line and cannot form a face.');
  }
  const { centroid, normal } = plane;
  const { tangent, bitangent } = planeBasis(normal);
  const keyed = vertices.map((vertex, index) => {
    const offset = subtractVector(points[index], centroid);
    const angle = Math.atan2(dotVector(offset, bitangent), dotVector(offset, tangent));
    return { vertex, angle };
  });
  keyed.sort((left, right) => (Math.abs(left.angle - right.angle) > 1e-9 ? left.angle - right.angle : left.vertex - right.vertex));
  return keyed.map(entry => entry.vertex);
}

function deterministicFallbackOrientation(mesh, ordered) {
  let normalX = 0;
  let normalY = 0;
  let normalZ = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const current = pointOf(mesh, ordered[index]);
    const next = pointOf(mesh, ordered[(index + 1) % ordered.length]);
    normalX += (current[1] - next[1]) * (current[2] + next[2]);
    normalY += (current[2] - next[2]) * (current[0] + next[0]);
    normalZ += (current[0] - next[0]) * (current[1] + next[1]);
  }
  const dominant = Math.abs(normalX) >= Math.abs(normalY) && Math.abs(normalX) >= Math.abs(normalZ)
    ? normalX
    : Math.abs(normalY) >= Math.abs(normalZ)
      ? normalY
      : normalZ;
  return dominant < 0 ? [...ordered].reverse() : ordered;
}

function polygonAttributesFromBoundary(ordered, boundaryMap, name) {
  let sourceFace = -1;
  const sourceCorners = ordered.map(() => -1);
  const sourceEdges = ordered.map(() => -1);
  for (let index = 0; index < ordered.length; index += 1) {
    const from = ordered[index];
    const to = ordered[(index + 1) % ordered.length];
    const opposite = boundaryMap.get(`${to},${from}`);
    if (!opposite) {
      continue;
    }
    if (sourceFace === -1) {
      sourceFace = opposite.face;
    }
    sourceCorners[index] = opposite.nextCorner;
    sourceEdges[index] = opposite.edge;
  }
  return {
    vertices: ordered,
    sourceFace: sourceFace === -1 ? 0 : sourceFace,
    sourceCorners,
    sourceEdges,
    keepTags: false,
    tags: [`${name}.fill`],
  };
}

function orderVerticesForFace(mesh, vertices, vertexSet, edgesInfo) {
  const { boundaryMap, boundaryAdjacency, fullAdjacency } = edgesInfo;
  const boundaryCycle = trySingleCycle(boundaryAdjacency, vertices.length);
  if (boundaryCycle) {
    return orientAgainstBoundary(boundaryCycle, boundaryMap);
  }
  const boundaryChain = trySingleOpenChain(boundaryAdjacency, vertices.length);
  if (boundaryChain) {
    return orientAgainstBoundary(boundaryChain, boundaryMap);
  }
  const fullCycle = trySingleCycle(fullAdjacency, vertices.length);
  if (fullCycle) {
    const oriented = orientAgainstBoundary(fullCycle, boundaryMap);
    const hasBoundary = fullCycle.some((vertex, index) => {
      const next = fullCycle[(index + 1) % fullCycle.length];
      return boundaryMap.has(`${vertex},${next}`) || boundaryMap.has(`${next},${vertex}`);
    });
    return hasBoundary ? oriented : deterministicFallbackOrientation(mesh, oriented);
  }
  const planar = orderByPlaneAngle(mesh, vertices);
  const oriented = orientAgainstBoundary(planar, boundaryMap);
  const sharesBoundary = oriented.some((vertex, index) => {
    const next = oriented[(index + 1) % oriented.length];
    return boundaryMap.has(`${vertex},${next}`) || boundaryMap.has(`${next},${vertex}`);
  });
  return sharesBoundary ? oriented : deterministicFallbackOrientation(mesh, oriented);
}

/**
 * Make a face from 3+ picked vertices (closed boundary loops, open boundary chains, edge cycles or planar vertex sets,
 * wound opposite to adjacent boundary faces), or split a shared face with an edge when 2 vertices are picked.
 */
export function makeFace(mesh, vertices, { name = 'make' } = {}) {
  checkPickedVertices(mesh, vertices);
  if (vertices.length === 2) {
    return makeEdgeBetweenVertices(mesh, vertices[0], vertices[1], name);
  }
  const vertexSet = new Set(vertices);
  if (faceAlreadyExists(mesh, vertexSet)) {
    throw new RangeError('A face over these vertices already exists.');
  }
  const edgesInfo = collectSelectedEdges(mesh, vertexSet);
  const ordered = orderVerticesForFace(mesh, vertices, vertexSet, edgesInfo);
  const polygons = facePolygons(mesh);
  polygons.push(polygonAttributesFromBoundary(ordered, edgesInfo.boundaryMap, name));
  return { mesh: buildPolygonMesh(mesh, polygons), createdFaces: 1, splitFaces: 0 };
}
