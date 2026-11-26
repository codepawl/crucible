import { createMeshData, deriveEdges } from './mesh-data.js';
import { registerModifierNormalizer, registerModifierRunner } from './mesh-modifiers.js';
import { faceSlotsOf, refuseSlottedJoin } from './mesh-material-slots.js';
import { MAX_MATERIAL_SLOTS, MATERIAL_SLOT_ATTRIBUTE } from './mesh-operations.js';
import { editField } from './mesh-edit-field.js';

// The `join` modifier: the faces of another recipe geometry are added to this mesh, placed by a 4x4 matrix that takes the
// other geometry's space into this mesh's space. Nothing is welded: the two parts stay separate shells, and every face
// keeps its tags, uv and colours. It is how Studio's Join turns two objects into one.

export const MAX_JOIN_MATRIX_MAGNITUDE = 1e6;
const AFFINE_BOTTOM_ROW = Object.freeze([0, 0, 0, 1]);
const SINGULAR_LIMIT = 1e-12;

function determinant3(matrix) {
  const column = index => [matrix[index * 4], matrix[index * 4 + 1], matrix[index * 4 + 2]];
  const [first, second, third] = [column(0), column(1), column(2)];
  return first[0] * (second[1] * third[2] - second[2] * third[1])
    - second[0] * (first[1] * third[2] - first[2] * third[1])
    + third[0] * (first[1] * second[2] - first[2] * second[1]);
}

/** Checks the fields of a join edit: the geometry to read and the column-major matrix that places it. */
export function normalizeJoinEdit(edit, normalized, index, { finiteNumber }) {
  if (typeof edit.geometry !== 'string' || edit.geometry === '') {
    throw editField(index, 'geometry', edit.geometry, 'the ID of the recipe geometry to add, such as "wheel"');
  }
  normalized.geometry = edit.geometry;
  const matrix = edit.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (!Array.isArray(matrix) || matrix.length !== 16) {
    throw editField(index, 'matrix', matrix, 'sixteen numbers, a column-major 4x4 matrix that places the geometry, such as [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]');
  }
  normalized.matrix = matrix.map(value => finiteNumber(value, index, 'matrix', { minimum: -MAX_JOIN_MATRIX_MAGNITUDE, maximum: MAX_JOIN_MATRIX_MAGNITUDE }));
  const bottomRow = [normalized.matrix[3], normalized.matrix[7], normalized.matrix[11], normalized.matrix[15]];
  if (bottomRow.some((value, position) => Math.abs(value - AFFINE_BOTTOM_ROW[position]) > 1e-9)) {
    throw editField(index, 'matrix', bottomRow, 'an affine matrix whose entries 3, 7, 11 and 15 are 0, 0, 0 and 1');
  }
  if (Math.abs(determinant3(normalized.matrix)) < SINGULAR_LIMIT) {
    throw editField(index, 'matrix', normalized.matrix, 'a matrix that does not flatten the geometry: no scale of 0');
  }
  if (edit.slotMap !== undefined) {
    if (!Array.isArray(edit.slotMap) || edit.slotMap.length < 1 || edit.slotMap.length > MAX_MATERIAL_SLOTS) {
      throw editField(index, 'slotMap', edit.slotMap, `an array of 1 to ${MAX_MATERIAL_SLOTS} slot indices from 0 to ${MAX_MATERIAL_SLOTS - 1}`);
    }
    normalized.slotMap = edit.slotMap.map((slot, slotIndex) => {
      if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_MATERIAL_SLOTS) {
        throw editField(index, `slotMap[${slotIndex}]`, slot, `a whole number from 0 to ${MAX_MATERIAL_SLOTS - 1}`);
      }
      return slot;
    });
  }
}

function placedPositions(mesh, matrix) {
  const positions = new Float32Array(mesh.positions.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = mesh.positions[offset];
    const y = mesh.positions[offset + 1];
    const z = mesh.positions[offset + 2];
    positions[offset] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    positions[offset + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    positions[offset + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  }
  return positions;
}

// An attribute both meshes carry joins as one array; one only the first or second mesh carries is zero on the other side.
// A name the two meshes store with different sizes or types is dropped, since no honest value fills the gap.
function mergedAttributes(firstAttributes, secondAttributes, total, firstPlacement, secondPlacement) {
  const merged = {};
  for (const name of new Set([...Object.keys(firstAttributes), ...Object.keys(secondAttributes)])) {
    const first = firstAttributes[name];
    const second = secondAttributes[name];
    if (first && second && (first.size !== second.size || first.data.constructor !== second.data.constructor)) continue;
    const { size } = first ?? second;
    const data = new (first ?? second).data.constructor(total * size);
    for (const [attribute, placement] of [[first, firstPlacement], [second, secondPlacement]]) {
      if (!attribute) continue;
      for (let item = 0; item < placement.count; item++) {
        const source = placement.source(item) * size;
        data.set(attribute.data.subarray(source, source + size), placement.destination(item) * size);
      }
    }
    merged[name] = { data, size };
  }
  return merged;
}

// Corner normals are stored as final shading directions, so the placed copy gets them turned by the matrix. A normal moves by
// the inverse transpose of the matrix. The rows below are the rows of the inverse times the determinant, so the inverse
// transpose sends a normal to the sum of those rows weighted by its components, and the sign of the determinant keeps it
// pointing outward under a mirror (the faces flip their winding, the outside stays outside).
function placedCornerNormals(normals, matrix) {
  const [firstColumn, secondColumn, thirdColumn] = [0, 4, 8].map(start => [matrix[start], matrix[start + 1], matrix[start + 2]]);
  const cross = (left, right) => [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
  const rows = [cross(secondColumn, thirdColumn), cross(thirdColumn, firstColumn), cross(firstColumn, secondColumn)];
  const determinantSign = Math.sign(firstColumn[0] * rows[0][0] + firstColumn[1] * rows[0][1] + firstColumn[2] * rows[0][2]) || 1;
  const data = new Float32Array(normals.data.length);
  for (let offset = 0; offset < data.length; offset += 3) {
    const placed = [0, 1, 2].map(axis => determinantSign * (rows[0][axis] * normals.data[offset] + rows[1][axis] * normals.data[offset + 1] + rows[2][axis] * normals.data[offset + 2]));
    const length = Math.hypot(...placed) || 1;
    for (let axis = 0; axis < 3; axis++) data[offset + axis] = placed[axis] / length;
  }
  return { data, size: 3 };
}

// Corner normals join only when both meshes carry them: a side without them has no shading to copy, and zero-filled normals
// would draw black. Without the attribute the renderer derives normals from the faces for the whole joined mesh.
function joinedCornerAttributes(first, second, matrix) {
  const firstCorner = { ...first.attributes.corner };
  const secondCorner = { ...second.attributes.corner };
  if (firstCorner.normal && secondCorner.normal) {
    secondCorner.normal = placedCornerNormals(secondCorner.normal, matrix);
  } else {
    delete firstCorner.normal;
    delete secondCorner.normal;
  }
  return [firstCorner, secondCorner];
}

const identityPlacement = (count, offset = 0) => ({ count, source: item => item, destination: item => item + offset });

function joinFaceSlotAttribute(first, second, slotMap) {
  const firstSlots = faceSlotsOf(first);
  const secondSlots = faceSlotsOf(second);
  if (!slotMap && !firstSlots && !secondSlots) return null;
  if (!slotMap) {
    refuseSlottedJoin(first, second);
    return null;
  }
  const totalFaces = first.faceCount + second.faceCount;
  const merged = new Uint8Array(totalFaces);
  if (firstSlots) merged.set(firstSlots, 0);
  for (let face = 0; face < second.faceCount; face++) {
    const sourceSlot = secondSlots ? secondSlots[face] : 0;
    if (sourceSlot >= slotMap.length) {
      throw new RangeError(`join slotMap has ${slotMap.length} entries, but a joined face points at slot ${sourceSlot}; pass a slotMap covering slots 0 to ${sourceSlot}.`);
    }
    merged[first.faceCount + face] = slotMap[sourceSlot];
  }
  return { data: merged, size: 1 };
}

/**
 * The first mesh and the second one placed by `matrix`, as one mesh. A matrix that mirrors the second mesh flips its faces
 * so they keep facing outward.
 */
export function joinMeshes(first, second, matrix, slotMap = null) {
  const joinedSlots = joinFaceSlotAttribute(first, second, slotMap);
  const mirrored = determinant3(matrix) < 0;
  const vertexCount = first.vertexCount + second.vertexCount;
  const positions = new Float32Array(vertexCount * 3);
  positions.set(first.positions, 0);
  positions.set(placedPositions(second, matrix), first.vertexCount * 3);
  const faceOffsets = new Uint32Array(first.faceCount + second.faceCount + 1);
  faceOffsets.set(first.faceOffsets, 0);
  const cornerVertices = new Uint32Array(first.cornerCount + second.cornerCount);
  cornerVertices.set(first.cornerVertices, 0);
  // secondCorners[k]: the corner of the second mesh that new corner first.cornerCount + k copies.
  const secondCorners = new Uint32Array(second.cornerCount);
  const secondEdgeSources = new Uint32Array(second.cornerCount);
  for (let face = 0; face < second.faceCount; face++) {
    const start = second.faceOffsets[face];
    const end = second.faceOffsets[face + 1];
    const size = end - start;
    for (let position = 0; position < size; position++) {
      const corner = mirrored ? end - 1 - position : start + position;
      // The edge after a corner leads to the next corner; reversed, that is the edge of the corner that followed it.
      const edgeCorner = mirrored ? end - 1 - ((position + 1) % size) : corner;
      secondCorners[start + position] = corner;
      secondEdgeSources[start + position] = second.cornerEdges[edgeCorner];
      cornerVertices[first.cornerCount + start + position] = second.cornerVertices[corner] + first.vertexCount;
    }
    faceOffsets[first.faceCount + face + 1] = first.cornerCount + end;
  }
  const edges = deriveEdges(vertexCount, faceOffsets, cornerVertices);
  const secondCornerPlacement = {
    count: second.cornerCount,
    source: item => secondCorners[item],
    destination: item => item + first.cornerCount,
  };
  const firstEdgePlacement = { count: first.cornerCount, source: corner => first.cornerEdges[corner], destination: corner => edges.cornerEdges[corner] };
  const secondEdgePlacement = { count: second.cornerCount, source: item => secondEdgeSources[item], destination: item => edges.cornerEdges[item + first.cornerCount] };
  const [firstCornerAttributes, secondCornerAttributes] = joinedCornerAttributes(first, second, matrix);
  const attributes = {
    point: mergedAttributes(first.attributes.point, second.attributes.point, vertexCount, identityPlacement(first.vertexCount), identityPlacement(second.vertexCount, first.vertexCount)),
    face: mergedAttributes(first.attributes.face, second.attributes.face, first.faceCount + second.faceCount, identityPlacement(first.faceCount), identityPlacement(second.faceCount, first.faceCount)),
    corner: mergedAttributes(firstCornerAttributes, secondCornerAttributes, cornerVertices.length, identityPlacement(first.cornerCount), secondCornerPlacement),
    edge: mergedAttributes(first.attributes.edge, second.attributes.edge, edges.edgeCount, firstEdgePlacement, secondEdgePlacement),
  };
  if (joinedSlots) attributes.face[MATERIAL_SLOT_ATTRIBUTE] = joinedSlots;
  return createMeshData({ positions, faceOffsets, cornerVertices, edgeVertices: edges.edgeVertices, cornerEdges: edges.cornerEdges, attributes });
}

function runJoinEdit(mesh, edit, { maxVertices, maxFaces, resolveJoinMesh } = {}) {
  if (!resolveJoinMesh) {
    throw new TypeError('join reads another recipe geometry, so it works as an edit of a recipe mesh, not in the modifier stack.');
  }
  const other = resolveJoinMesh(edit.geometry);
  if (!edit.slotMap) refuseSlottedJoin(mesh, other);
  if (mesh.vertexCount + other.vertexCount > maxVertices || mesh.faceCount + other.faceCount > maxFaces) {
    throw new RangeError(`join would make ${mesh.vertexCount + other.vertexCount} vertices and ${mesh.faceCount + other.faceCount} faces, over the limit of ${maxVertices} vertices and ${maxFaces} faces. Join a smaller geometry or simplify one of them.`);
  }
  return { mesh: joinMeshes(mesh, other, edit.matrix, edit.slotMap ?? null), result: { joinedFaces: other.faceCount, joinedVertices: other.vertexCount } };
}

registerModifierNormalizer('join', normalizeJoinEdit);
registerModifierRunner('join', runJoinEdit);
