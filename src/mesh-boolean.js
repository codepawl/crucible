import { createMeshData, TAG_PREFIX } from './mesh-data.js';
import { lintMesh } from './mesh-lint.js';
import { triangulateMesh } from './mesh-render.js';
import { faceNormals } from './mesh-normals.js';
import { joinTriangles } from './mesh-convert.js';

// Mesh booleans through the Manifold library (Apache-2.0, the solver Blender 4.5 added), compiled to WebAssembly.
// Manifold needs closed, consistently wound inputs; in return it is robust and fast. The module loads lazily,
// once, because the WebAssembly binary is about a megabyte.

let manifoldPromise = null;
let manifoldModule = null;
let loadManifoldModule = () => import('manifold-3d');

/** Replace how the Manifold module is imported, for hosts that serve it from elsewhere. Call before loading. */
export function setManifoldModuleLoader(loader) {
  if (typeof loader !== 'function') throw new TypeError('The Manifold loader must be a function returning a module promise.');
  loadManifoldModule = loader;
}

/**
 * Load the boolean engine. In Node the binary is found next to the package; in a browser bundle pass the binary
 * bytes as `wasmBinary` (an ArrayBuffer or Uint8Array). Safe to call repeatedly.
 */
export function loadMeshBooleans({ wasmBinary } = {}) {
  manifoldPromise ??= loadManifoldModule().catch(error => {
    throw new Error(`Mesh booleans need the optional peer dependency manifold-3d 3.5.4: npm install manifold-3d@3.5.4 (${error.message}).`);
  }).then(async ({ default: createModule }) => {
    const module = await createModule(wasmBinary ? { wasmBinary } : undefined);
    module.setup();
    manifoldModule = module;
    return module;
  }).catch(error => {
    manifoldPromise = null;
    throw error;
  });
  return manifoldPromise;
}

export function meshBooleansLoaded() {
  return manifoldModule !== null;
}

function requireMeshArgument(label, value) {
  if (!value?.faceOffsets) throw new TypeError(`meshBoolean: ${label} must be mesh data, got ${value}.`);
}

function requireModule() {
  if (!manifoldModule) throw new Error('Mesh booleans are not loaded yet. Await loadMeshBooleans() before running a boolean edit.');
  return manifoldModule;
}

const CUTTER_MARK = 'boolean-cutter-faces';
export const BOOLEAN_OPERATIONS = Object.freeze(['union', 'difference', 'intersect']);

function hasCornerUv(mesh) {
  return mesh.attributes.corner.uv?.size === 2;
}

/** Triangulated Manifold input: positions (plus UV) per corner-vertex, triangle face IDs offset by faceIdOffset. */
function manifoldInput(module, mesh, faceIdOffset, propertyCount) {
  const { normals } = faceNormals(mesh);
  const { triangleCorners, triangleFaces } = triangulateMesh(mesh, normals);
  // One property vertex per (vertex, uv) pair would be ideal; one per corner is simpler and Mesh.merge() welds
  // positions back together for the solver while keeping UV seams as properties.
  const uv = hasCornerUv(mesh) ? mesh.attributes.corner.uv.data : null;
  const vertexProperties = new Float32Array(mesh.cornerCount * propertyCount);
  for (let corner = 0; corner < mesh.cornerCount; corner++) {
    const vertex = mesh.cornerVertices[corner];
    vertexProperties[corner * propertyCount] = mesh.positions[vertex * 3];
    vertexProperties[corner * propertyCount + 1] = mesh.positions[vertex * 3 + 1];
    vertexProperties[corner * propertyCount + 2] = mesh.positions[vertex * 3 + 2];
    if (propertyCount === 5 && uv) {
      vertexProperties[corner * propertyCount + 3] = uv[corner * 2];
      vertexProperties[corner * propertyCount + 4] = uv[corner * 2 + 1];
    }
  }
  const faceID = new Uint32Array(triangleFaces.length);
  for (let triangle = 0; triangle < triangleFaces.length; triangle++) faceID[triangle] = triangleFaces[triangle] + faceIdOffset;
  const input = new module.Mesh({
    numProp: propertyCount,
    vertProperties: vertexProperties,
    triVerts: new Uint32Array(triangleCorners),
    faceID,
  });
  input.merge();
  return input;
}

function solverError(module, manifold, label) {
  const status = manifold.status();
  if (status === 'NoError' || status === module.ErrorStatus?.NoError || status === 0) return null;
  return `${label} is not a closed manifold for the boolean solver (${status}). Run mesh_inspect: every edge needs exactly two faces with matching winding. Fix open edges or merge_by_distance first.`;
}

const NO_VERTEX = 0xFFFFFFFF;

function hashPair(first, second, mask) {
  let hash = Math.imul(first, 0x9E3779B1) ^ Math.imul(second, 0x85EBCA6B);
  hash ^= hash >>> 15;
  return hash & mask;
}

function tableSizeFor(entryCount) {
  let size = 8;
  while (size < entryCount * 2) size *= 2;
  return size;
}

/**
 * Scratch tables for one source face's triangles, allocated once for the largest group and reused. The directed edge
 * table and the vertex table are open-addressing hash tables over typed arrays, cleared per group only as far as the
 * group uses them, so a quad's two triangles cost a few slots rather than a Set and two Maps of strings.
 */
function createGroupScratch(largestGroup) {
  const edgeCapacity = largestGroup * 3;
  const tableSize = tableSizeFor(edgeCapacity);
  return {
    edgeFrom: new Uint32Array(tableSize),
    edgeTo: new Uint32Array(tableSize),
    edgeUsed: new Uint8Array(tableSize),
    listFrom: new Uint32Array(edgeCapacity),
    listTo: new Uint32Array(edgeCapacity),
    vertexKey: new Uint32Array(tableSize),
    vertexUsed: new Uint8Array(tableSize),
    vertexProperty: new Uint32Array(tableSize),
    vertexNext: new Uint32Array(tableSize),
  };
}

/** Slot of the directed edge in the group's edge table, or the empty slot where it would go. */
function edgeSlot(scratch, mask, from, to) {
  let slot = hashPair(from, to, mask);
  while (scratch.edgeUsed[slot] && !(scratch.edgeFrom[slot] === from && scratch.edgeTo[slot] === to)) slot = (slot + 1) & mask;
  return slot;
}

/** Slot of the vertex in the group's vertex table, or the empty slot where it would go. */
function vertexSlot(scratch, mask, vertex) {
  let slot = hashPair(vertex, 0, mask);
  while (scratch.vertexUsed[slot] && scratch.vertexKey[slot] !== vertex) slot = (slot + 1) & mask;
  return slot;
}

/** Source face ids in order of first appearance, and each group's triangles in output order (a counting sort). */
function groupTrianglesBySourceFace(triangleFaceIds) {
  let highestId = 0;
  for (let triangle = 0; triangle < triangleFaceIds.length; triangle++) {
    if (triangleFaceIds[triangle] > highestId) highestId = triangleFaceIds[triangle];
  }
  const groupOfId = new Int32Array(highestId + 1).fill(-1);
  const groupIds = [];
  const groupSizes = [];
  for (let triangle = 0; triangle < triangleFaceIds.length; triangle++) {
    const id = triangleFaceIds[triangle];
    let group = groupOfId[id];
    if (group === -1) {
      group = groupIds.length;
      groupOfId[id] = group;
      groupIds.push(id);
      groupSizes.push(0);
    }
    groupSizes[group]++;
  }
  const groupStarts = new Uint32Array(groupIds.length + 1);
  let largestGroup = 0;
  for (let group = 0; group < groupIds.length; group++) {
    groupStarts[group + 1] = groupStarts[group] + groupSizes[group];
    if (groupSizes[group] > largestGroup) largestGroup = groupSizes[group];
  }
  const nextFree = groupStarts.slice(0, groupIds.length);
  const groupTriangles = new Uint32Array(triangleFaceIds.length);
  for (let triangle = 0; triangle < triangleFaceIds.length; triangle++) {
    groupTriangles[nextFree[groupOfId[triangleFaceIds[triangle]]]++] = triangle;
  }
  return { groupIds, groupStarts, groupTriangles, largestGroup };
}

/** Fill the group's tables: each distinct directed edge once, in order, and each vertex's first property vertex. */
function indexGroupTriangles(scratch, mask, tableSize, triangles, weldedTriangles, propertyTriangles) {
  scratch.edgeUsed.fill(0, 0, tableSize);
  scratch.vertexUsed.fill(0, 0, tableSize);
  let edgeCount = 0;
  for (const triangle of triangles) {
    for (let corner = 0; corner < 3; corner++) {
      const from = weldedTriangles[triangle * 3 + corner];
      const to = weldedTriangles[triangle * 3 + (corner + 1) % 3];
      const slot = edgeSlot(scratch, mask, from, to);
      if (!scratch.edgeUsed[slot]) {
        scratch.edgeUsed[slot] = 1;
        scratch.edgeFrom[slot] = from;
        scratch.edgeTo[slot] = to;
        scratch.listFrom[edgeCount] = from;
        scratch.listTo[edgeCount++] = to;
      }
      const slotOfVertex = vertexSlot(scratch, mask, from);
      if (!scratch.vertexUsed[slotOfVertex]) {
        scratch.vertexUsed[slotOfVertex] = 1;
        scratch.vertexKey[slotOfVertex] = from;
        scratch.vertexProperty[slotOfVertex] = propertyTriangles[triangle * 3 + corner];
        scratch.vertexNext[slotOfVertex] = NO_VERTEX;
      }
    }
  }
  return edgeCount;
}

/**
 * Link every boundary edge (one whose reverse is not in the group) from its start vertex to its end vertex.
 * Returns the boundary edge count, whether two boundary edges leave one vertex, and the first boundary start vertex.
 */
function linkBoundaryEdges(scratch, mask, edgeCount) {
  let boundaryCount = 0;
  let branching = false;
  let firstVertex = NO_VERTEX;
  for (let edge = 0; edge < edgeCount; edge++) {
    const from = scratch.listFrom[edge];
    const to = scratch.listTo[edge];
    if (scratch.edgeUsed[edgeSlot(scratch, mask, to, from)]) continue;
    boundaryCount++;
    if (firstVertex === NO_VERTEX) firstVertex = from;
    const slot = vertexSlot(scratch, mask, from);
    if (scratch.vertexNext[slot] !== NO_VERTEX) branching = true;
    scratch.vertexNext[slot] = to;
  }
  return { boundaryCount, branching, firstVertex };
}

/**
 * Walk the boundary loop into `loopVertices` from `loopStart`. Returns the loop length, or 0 when the boundary
 * does not close into one loop of exactly `boundaryCount` vertices (holes, separate pieces).
 */
function traceBoundaryLoop(scratch, mask, firstVertex, boundaryCount, loopVertices, loopStart) {
  let length = 0;
  let vertex = firstVertex;
  do {
    if (length > boundaryCount) return 0;
    loopVertices[loopStart + length++] = vertex;
    const slot = vertexSlot(scratch, mask, vertex);
    if (!scratch.vertexUsed[slot]) return 0;
    vertex = scratch.vertexNext[slot];
    if (vertex === NO_VERTEX) return 0;
  } while (vertex !== firstVertex);
  return length === boundaryCount ? length : 0;
}

/**
 * Group output triangles by source face and turn each group back into one polygon when its triangles form a single
 * boundary loop; otherwise (holes, separate pieces) keep the group's triangles. Works on welded vertex indices, so
 * property vertices that Manifold keeps apart at one position do not open fake boundaries.
 * Returns the polygons as flat arrays: per polygon its source face and corner range, per corner its welded vertex
 * and one property vertex for interpolated attributes.
 */
function polygonsFromTriangles(weldedTriangles, propertyTriangles, triangleFaceIds) {
  const { groupIds, groupStarts, groupTriangles, largestGroup } = groupTrianglesBySourceFace(triangleFaceIds);
  const scratch = createGroupScratch(largestGroup);
  const sourceFaces = new Uint32Array(triangleFaceIds.length);
  const faceOffsets = new Uint32Array(triangleFaceIds.length + 1);
  // One slot more than three per triangle: a loop that fails to close may write one corner past its boundary count.
  const cornerVertices = new Uint32Array(triangleFaceIds.length * 3 + 1);
  const cornerProperties = new Uint32Array(triangleFaceIds.length * 3 + 1);
  let polygonCount = 0;
  let cornerCount = 0;
  for (let group = 0; group < groupIds.length; group++) {
    const triangles = groupTriangles.subarray(groupStarts[group], groupStarts[group + 1]);
    const tableSize = tableSizeFor(triangles.length * 3);
    const mask = tableSize - 1;
    const edgeCount = indexGroupTriangles(scratch, mask, tableSize, triangles, weldedTriangles, propertyTriangles);
    const { boundaryCount, branching, firstVertex } = linkBoundaryEdges(scratch, mask, edgeCount);
    const loopLength = !branching && boundaryCount >= 3
      ? traceBoundaryLoop(scratch, mask, firstVertex, boundaryCount, cornerVertices, cornerCount)
      : 0;
    if (loopLength) {
      for (let corner = 0; corner < loopLength; corner++) {
        const slot = vertexSlot(scratch, mask, cornerVertices[cornerCount + corner]);
        cornerProperties[cornerCount + corner] = scratch.vertexProperty[slot];
      }
      sourceFaces[polygonCount] = groupIds[group];
      cornerCount += loopLength;
      faceOffsets[++polygonCount] = cornerCount;
      continue;
    }
    for (const triangle of triangles) {
      const first = weldedTriangles[triangle * 3];
      const second = weldedTriangles[triangle * 3 + 1];
      const third = weldedTriangles[triangle * 3 + 2];
      if (first === second || second === third || first === third) continue;
      cornerVertices[cornerCount] = first;
      cornerVertices[cornerCount + 1] = second;
      cornerVertices[cornerCount + 2] = third;
      cornerProperties.set(propertyTriangles.subarray(triangle * 3, triangle * 3 + 3), cornerCount);
      sourceFaces[polygonCount] = groupIds[group];
      cornerCount += 3;
      faceOffsets[++polygonCount] = cornerCount;
    }
  }
  return {
    polygonCount,
    sourceFaces: sourceFaces.slice(0, polygonCount),
    faceOffsets: faceOffsets.slice(0, polygonCount + 1),
    cornerVertices: cornerVertices.slice(0, cornerCount),
    cornerProperties: cornerProperties.slice(0, cornerCount),
  };
}

/**
 * Boolean of two closed meshes. Faces from `mesh` keep their tags and other face attributes; faces from `cutter`
 * get the tag `cutTag` (when given). Corner UVs are interpolated where both inputs have them.
 * Returns { mesh, cutterFaces }, the faces that came from this cutter (0 without cutTag).
 */
export function meshBoolean(mesh, cutter, operation, { cutTag } = {}) {
  if (!BOOLEAN_OPERATIONS.includes(operation)) throw new RangeError(`Boolean operation must be one of ${BOOLEAN_OPERATIONS.join(', ')}.`);
  requireMeshArgument('mesh', mesh);
  requireMeshArgument('cutter', cutter);
  if (cutTag !== undefined && !(typeof cutTag === 'string' && cutTag)) throw new TypeError(`meshBoolean: cutTag was ${JSON.stringify(cutTag)}; pass a non-empty string.`);
  const module = requireModule();
  for (const [label, input] of [['The mesh', mesh], ['The cutter', cutter]]) {
    const report = lintMesh(input, { topology: false });
    const open = report.problems.filter(problem => ['boundary-edge', 'non-manifold-edge', 'inconsistent-winding', 'inverted-part'].includes(problem.kind));
    if (open.length) {
      throw new RangeError(`${label} must be closed and outward facing for a boolean: ${open.map(problem => `${problem.count} ${problem.kind}`).join(', ')}. ${open[0].fix}`);
    }
  }
  const propertyCount = hasCornerUv(mesh) ? 5 : 3;
  const resources = [];
  try {
    const inputA = manifoldInput(module, mesh, 0, propertyCount);
    resources.push(inputA);
    const inputB = manifoldInput(module, cutter, mesh.faceCount, propertyCount);
    resources.push(inputB);
    const solidA = new module.Manifold(inputA);
    resources.push(solidA);
    const solidB = new module.Manifold(inputB);
    resources.push(solidB);
    const problem = solverError(module, solidA, 'The mesh') ?? solverError(module, solidB, 'The cutter');
    if (problem) throw new RangeError(problem);
    const result = operation === 'union' ? solidA.add(solidB) : operation === 'difference' ? solidA.subtract(solidB) : solidA.intersect(solidB);
    resources.push(result);
    const output = result.getMesh();
    resources.push(output);
    if (!output.triVerts.length) throw new RangeError(`The ${operation} leaves nothing. Check the cutter's position and size against mesh_inspect bounds.`);
    return rebuildOutput(mesh, output, propertyCount, cutTag);
  } catch (error) {
    if (error?.constructor?.name !== 'ManifoldError') throw error;
    throw new RangeError(`The ${operation} failed in the solver (${error.message}); rescale extremely small or large parts.`);
  } finally {
    for (const resource of resources.reverse()) resource.delete?.();
  }
}

/**
 * Weld property vertices that share an exact position (Manifold keeps UV seams apart; the mesh does not). Positions
 * compare by value, so 0 and -0 weld together and the first one seen is kept.
 */
function weldByPosition(vertProperties, outputProperties) {
  const vertexCount = vertProperties.length / outputProperties;
  const bits = new Uint32Array(vertProperties.buffer, vertProperties.byteOffset, vertProperties.length);
  const tableSize = tableSizeFor(vertexCount);
  const mask = tableSize - 1;
  const table = new Int32Array(tableSize).fill(-1);
  const meshVertexOf = new Uint32Array(vertexCount);
  const positions = new Float32Array(vertexCount * 3);
  let meshVertexCount = 0;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const base = vertex * outputProperties;
    const x = vertProperties[base];
    const y = vertProperties[base + 1];
    const z = vertProperties[base + 2];
    // Zero hashes as +0 so that -0 lands in the same bucket as the +0 it compares equal to.
    let slot = hashPair(hashPair(x === 0 ? 0 : bits[base], y === 0 ? 0 : bits[base + 1], 0x7FFFFFFF), z === 0 ? 0 : bits[base + 2], mask);
    let meshVertex = table[slot];
    while (meshVertex !== -1 && !(positions[meshVertex * 3] === x && positions[meshVertex * 3 + 1] === y && positions[meshVertex * 3 + 2] === z)) {
      slot = (slot + 1) & mask;
      meshVertex = table[slot];
    }
    if (meshVertex === -1) {
      meshVertex = meshVertexCount++;
      table[slot] = meshVertex;
      positions[meshVertex * 3] = x;
      positions[meshVertex * 3 + 1] = y;
      positions[meshVertex * 3 + 2] = z;
    }
    meshVertexOf[vertex] = meshVertex;
  }
  return { meshVertexOf, positions: positions.slice(0, meshVertexCount * 3) };
}

function rebuildOutput(mesh, output, propertyCount, cutTag) {
  const outputProperties = output.numProp;
  const { meshVertexOf, positions } = weldByPosition(output.vertProperties, outputProperties);
  const weldedTriangles = new Uint32Array(output.triVerts.length);
  for (let index = 0; index < output.triVerts.length; index++) weldedTriangles[index] = meshVertexOf[output.triVerts[index]];
  const polygons = polygonsFromTriangles(weldedTriangles, output.triVerts, output.faceID);
  const { polygonCount, sourceFaces, faceOffsets, cornerVertices } = polygons;
  let cornerUv = null;
  if (propertyCount === 5) {
    cornerUv = new Float32Array(cornerVertices.length * 2);
    for (let corner = 0; corner < cornerVertices.length; corner++) {
      const propertyBase = polygons.cornerProperties[corner] * outputProperties;
      cornerUv[corner * 2] = output.vertProperties[propertyBase + 3];
      cornerUv[corner * 2 + 1] = output.vertProperties[propertyBase + 4];
    }
  }
  const faceAttributes = {};
  const fromCutter = face => sourceFaces[face] >= mesh.faceCount;
  for (const [name, attribute] of Object.entries(mesh.attributes.face)) {
    const data = new attribute.data.constructor(polygonCount * attribute.size);
    for (let face = 0; face < polygonCount; face++) {
      if (fromCutter(face)) continue;
      data.set(attribute.data.subarray(sourceFaces[face] * attribute.size, (sourceFaces[face] + 1) * attribute.size), face * attribute.size);
    }
    faceAttributes[name] = { data, size: attribute.size };
  }
  if (cutTag) {
    const data = faceAttributes[TAG_PREFIX + cutTag]?.data ?? new Uint8Array(polygonCount);
    const cutterMark = new Uint8Array(polygonCount);
    for (let face = 0; face < polygonCount; face++) {
      if (!fromCutter(face)) continue;
      data[face] = 1;
      cutterMark[face] = 1;
    }
    faceAttributes[TAG_PREFIX + cutTag] = { data, size: 1 };
    // The tag may already mark faces of an earlier boolean, so the cutter's own faces are counted through a mark that
    // the join below keeps apart and that is dropped again afterwards.
    faceAttributes[CUTTER_MARK] = { data: cutterMark, size: 1 };
  }
  const triangles = createMeshData({
    positions,
    faceOffsets,
    cornerVertices,
    attributes: {
      face: faceAttributes,
      corner: cornerUv ? { uv: { data: cornerUv, size: 2 } } : {},
    },
  });
  // Faces with holes come back as triangle fans; join flat pairs that share every attribute back into quads.
  const joined = joinTriangles(triangles);
  if (!cutTag) return { mesh: joined, cutterFaces: 0 };
  return { mesh: withoutFaceAttribute(joined, CUTTER_MARK), cutterFaces: countMarked(joined.attributes.face[CUTTER_MARK].data) };
}

function countMarked(data) {
  let count = 0;
  for (const value of data) count += value ? 1 : 0;
  return count;
}

function withoutFaceAttribute(mesh, name) {
  const { [name]: dropped, ...faceAttributes } = mesh.attributes.face;
  return createMeshData({
    positions: mesh.positions,
    faceOffsets: mesh.faceOffsets,
    cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices,
    cornerEdges: mesh.cornerEdges,
    attributes: { ...mesh.attributes, face: faceAttributes },
  });
}
