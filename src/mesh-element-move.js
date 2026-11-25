import { editMesh, meshData } from './mesh-edit.js';
import { editField } from './mesh-edit-field.js';
import { selectVertices } from './mesh-dissolve.js';
import { selectEdges, edgeFaces } from './mesh-bevel.js';
import { editEdgeRule } from './mesh-edit-field.js';
import { maskedVertices, maskedEdgeVertices, translateVertices, transformVertices } from './mesh-ops.js';
import { MAX_SELECTED_ELEMENTS, ELEMENT_MOVE_OPERATIONS } from './mesh-operations.js';

// translate and transform_selection move the vertices of a face rule (select), of a vertex rule (verts) or of the
// edges an edge rule picks (edges). Exactly one of the three is given; the vertices of an edge selection are the two
// ends of each edge, so a vertex shared by several edges moves once.

const SELECTION_FIELDS = ['select', 'verts', 'edges'];

function isRuleObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check which selection a move names and copy a vertex or edge selection into `normalized`. Returns true when the move
 * selects vertices or edges, so the caller leaves the face rule (and its default of every face) out.
 */
export function normalizeMoveSelection(edit, normalized, index) {
  if (!ELEMENT_MOVE_OPERATIONS.includes(edit.op)) return false;
  const given = SELECTION_FIELDS.filter(field => edit[field] !== undefined);
  if (given.length > 1) {
    throw editField(index, given[1], edit[given[1]], `left out, because ${edit.op} already has ${given[0]}; pass exactly one of select (faces), verts (vertices) or edges`);
  }
  if (given[0] === 'verts') {
    if (!isRuleObject(edit.verts)) throw editField(index, 'verts', edit.verts, 'a vertex rule such as { "vertices": [0, 1, 2] }, { "all": true } or { "inside": { "min": [x, y, z], "max": [x, y, z] } }');
    const listed = edit.verts.vertices;
    if (Array.isArray(listed) && (listed.length < 1 || listed.length > MAX_SELECTED_ELEMENTS || !listed.every(vertex => Number.isInteger(vertex) && vertex >= 0))) {
      throw editField(index, 'verts.vertices', listed, `an array of 1 to ${MAX_SELECTED_ELEMENTS} whole vertex indices, such as [0, 1, 2]; use { "inside": ... } for a larger selection`);
    }
    normalized.verts = edit.verts;
    return true;
  }
  if (given[0] === 'edges') {
    normalized.edges = editEdgeRule(edit.edges, index, 'edges', 'an edge rule such as { "edges": [[0, 1], [1, 2]] } (vertex pairs), { "angle": 30 } or { "all": true }');
    return true;
  }
  return false;
}

export function isElementMove(edit) {
  return ELEMENT_MOVE_OPERATIONS.includes(edit.op) && (edit.verts !== undefined || edit.edges !== undefined);
}

function selectedVertices(editable, mesh, edit) {
  if (edit.verts !== undefined) return { vertices: maskedVertices(editable, selectVertices(mesh, edit.verts)), field: 'verts', noun: 'vertex' };
  const mask = selectEdges(mesh, edit.edges, edgeFaces(mesh));
  return { vertices: maskedEdgeVertices(editable, mask), field: 'edges', noun: 'edge' };
}

/** Run a translate or transform_selection on a vertex or edge selection. `fail` wraps an error with its edit position. */
export function runElementMove(mesh, edit, index, result, fail) {
  const editable = editMesh(mesh);
  let selection;
  try {
    selection = selectedVertices(editable, mesh, edit);
  } catch (error) {
    throw fail(error, index, edit.op);
  }
  if (selection.vertices.size === 0) {
    throw editField(index, selection.field, edit[selection.field], `a rule that matches at least one ${selection.noun}, such as ${selection.field === 'verts' ? '{ "vertices": [0] }' : '{ "edges": [[0, 1]] }'}`, RangeError);
  }
  result.selectedVertices = selection.vertices.size;
  const outcome = edit.op === 'translate' ? translateVertices(editable, selection.vertices, edit) : transformVertices(editable, selection.vertices, edit);
  result.movedVertices = outcome.movedVertices;
  return { mesh: meshData(editable), result };
}
