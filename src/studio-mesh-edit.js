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
import { CONVERTIBLE_PRIMITIVES, meshGeometryOfPrimitive, planOwnMesh } from './studio-own-mesh.js';

export { meshGeometryOfPrimitive };

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
const LOG_IS_FULL = `This mesh already has ${MAX_LOG_ENTRIES} edits, the most one mesh holds, so it cannot take another move.`;
const TOO_MANY_VERTICES = `Moving more than ${MAX_MASK_VERTICES} vertices that are not whole faces is not possible yet; select whole faces or fewer vertices.`;
const MESH_CHANGED = 'Edit mode ended because this object uses a different mesh now.';
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
 * some faces, else a `set_position` over an index mask. Throws a sentence that says why when the move cannot be written.
 */
export function planMeshMove(mesh, vertices, localDelta) {
  const offset = roundVector(localDelta);
  const vertexSet = new Set(vertices);
  const { faces, covered } = facesInsideVertexSet(mesh, vertexSet);
  if (faces.length > 0 && covered.size === vertexSet.size) {
    return { op: 'translate', select: { faces }, offset };
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

/**
 * The edit mode of one Studio: `enter()` on the selected node, pick with `pick()`, move with the handles of the
 * controller (this editor installs an element session on it), `leave()`. `updatePart` writes a drag preview into the GPU
 * buffers of the part; `getRenderer` returns the renderer it needs, or null for a headless Studio (the cage still moves).
 */
export function createMeshEditor({ controller, announce = () => {}, getRenderer = () => null, updatePart = updatePartVertices } = {}) {
  let state = null;
  let drag = null;
  // True while this editor writes its own entry: the mesh it reads back has the same topology, so the pick stays.
  let writingOwnEntry = false;
  // True from entering edit mode until the first pick selects something: the hint goes away with that pick.
  let hintShowing = false;

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
    if (sameMesh && (writingOwnEntry || logsShareTheirPrefix(previous.logEntries, state.logEntries))) state.selected = new Set(selectedBefore);
    return null;
  }

  // The geometry of the node becomes a mesh of its own before the first edit, in one scene change (one undo step).
  function giveNodeItsOwnMesh(nodeId) {
    const { operations } = planOwnMesh(controller.exportRecipe(), nodeId);
    if (operations.length > 0) controller.applyImportOperations(operations, { detail: { kind: 'topology', nodeId } });
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
    // The controller drag goes first, through the session, so the cage, the buffers and the pointer state are put back.
    if (controller.dragging) controller.cancelGizmoDrag();
    cancelDrag();
    state = null;
    controller.setElementSession(null);
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

  function projectCage() {
    const project = controller.worldPointProjector();
    const matrix = state.part.matrix;
    const vertexCount = state.mesh.vertexCount;
    const screenX = new Float32Array(vertexCount);
    const screenY = new Float32Array(vertexCount);
    const visible = new Uint8Array(vertexCount);
    const { nearVertex, nearEdge } = nearSideOf();
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const world = transformPoint(matrix, state.positions[vertex * 3], state.positions[vertex * 3 + 1], state.positions[vertex * 3 + 2]);
      const point = project(world);
      screenX[vertex] = point.x;
      screenY[vertex] = point.y;
      visible[vertex] = point.visible ? 1 : 0;
    }
    return { screenX, screenY, visible, nearVertex, nearEdge };
  }

  // A vertex or an edge is on the far side when every face that uses it faces away from the camera.
  function nearSideOf() {
    const { mesh, positions } = state;
    const nearVertex = new Uint8Array(mesh.vertexCount);
    const nearEdge = new Uint8Array(mesh.edgeCount);
    const inverse = mat4.invert(mat4.create(), state.part.matrix);
    if (!inverse) {
      nearVertex.fill(1);
      nearEdge.fill(1);
      return { nearVertex, nearEdge };
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
      for (let corner = first; corner < end; corner += 1) {
        nearVertex[mesh.cornerVertices[corner]] = 1;
        nearEdge[mesh.cornerEdges[corner]] = 1;
      }
    }
    return { nearVertex, nearEdge };
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

  /** Picks the element of the current mode under the pixel; `additive` (Shift) toggles it, a click on nothing clears. */
  function pick(pixelX, pixelY, { additive = false } = {}) {
    if (!state || drag) return null;
    let hit;
    if (state.mode === 'face') {
      hit = faceUnderPointer(pixelX, pixelY);
    } else {
      const projected = projectCage();
      hit = state.mode === 'vertex' ? nearestVertex(pixelX, pixelY, projected) : nearestEdge(pixelX, pixelY, projected);
    }
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

  function selectionCentreWorld() {
    const vertices = selectedVertices();
    if (vertices.size === 0) return null;
    const sum = [0, 0, 0];
    for (const vertex of vertices) {
      for (let axis = 0; axis < 3; axis += 1) sum[axis] += state.positions[vertex * 3 + axis];
    }
    return transformPoint(state.part.matrix, sum[0] / vertices.size, sum[1] / vertices.size, sum[2] / vertices.size);
  }

  function writePreview() {
    if (!drag.previewing) return;
    try {
      gatherRenderPositions({ positions: state.positions }, state.renderVertexSource, drag.renderPositions);
      previewNormalsOf(state.part.geometry.indices, drag.renderPositions, drag.renderNormals);
      updatePart(getRenderer(), state.part, drag.renderPositions, drag.renderNormals);
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
        updatePart(getRenderer(), state.part, drag.originalRenderPositions, drag.originalRenderNormals);
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

  function beginDrag() {
    if (!state) throw new RangeError('Enter edit mode before moving the selection.');
    const vertices = [...selectedVertices()];
    if (vertices.length === 0) throw new RangeError('Pick a vertex, edge or face to move first.');
    if (state.editCount >= MAX_LOG_ENTRIES) throw new RangeError(LOG_IS_FULL);
    // Refused here, before the pointer moves: a finished drag is never thrown away.
    planMeshMove(state.mesh, vertices, [0, 0, 0]);
    const basePositions = new Float32Array(vertices.length * 3);
    vertices.forEach((vertex, slot) => {
      for (let axis = 0; axis < 3; axis += 1) basePositions[slot * 3 + axis] = state.positions[vertex * 3 + axis];
    });
    const previewing = state.previewable && getRenderer() !== null;
    drag = {
      vertices,
      basePositions,
      localDelta: [0, 0, 0],
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
    drag.vertices.forEach((vertex, slot) => {
      for (let axis = 0; axis < 3; axis += 1) state.positions[vertex * 3 + axis] = drag.basePositions[slot * 3 + axis] + localDelta[axis];
    });
    writePreview();
  }

  function finishDrag(changed) {
    if (!drag) return;
    const { vertices, localDelta } = drag;
    restoreDraggedPositions();
    drag = null;
    // A move below the rounding step would be an entry that moves nothing and takes one of the 64 slots.
    if (!changed || roundVector(localDelta).every(component => component === 0)) return;
    const { nodeId, geometryId } = state;
    writingOwnEntry = true;
    try {
      const edit = planMeshMove(state.mesh, vertices, localDelta);
      controller.applyImportOperations([{ type: 'edit-mesh', geometry: geometryId, edits: [edit] }], { detail: { kind: 'topology', nodeId } });
    } catch (error) {
      announce(error.message);
    }
    refresh();
    writingOwnEntry = false;
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
    get cage() { return state ? { positions: state.positions, mesh: state.mesh, tooLarge: state.tooLarge, editCount: state.editCount } : null; },
    conversionOf,
    enter,
    leave,
    setMode,
    clearSelection,
    pick,
    refresh,
    cagePaths,
    selectionScreenRadius,
    draw,
  });
}
