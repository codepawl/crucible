import { weldMesh } from './mesh-ops.js';
import { invalidField } from './field-error.js';
import { MERGE_TARGETS, MAX_SELECTED_ELEMENTS } from './mesh-operations.js';

// merge_verts: the picked vertices become one vertex at their centre, at the first or at
// the last one picked, or each connected group of them becomes one vertex at its own centre (Collapse). The picked list
// is ordered, because first and last follow the order of the picks. Faces that shrink below three corners or repeat a
// vertex are dropped, and so is a face that repeats another one.

const PICK_HINT = `an array of 2 to ${MAX_SELECTED_ELEMENTS} different vertex indices in pick order, such as [4, 7]`;

/** Check the picked vertex list of a merge_verts edit against the mesh it runs on and return it. */
export function checkPickedVertices(mesh, vertices) {
  if (!Array.isArray(vertices) || vertices.length < 2 || vertices.length > MAX_SELECTED_ELEMENTS) {
    throw invalidField('vertices', vertices, PICK_HINT);
  }
  const seen = new Set();
  for (const vertex of vertices) {
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= mesh.vertexCount) {
      throw invalidField('vertices', vertex, `a whole vertex index from 0 to ${mesh.vertexCount - 1} (this mesh has ${mesh.vertexCount} vertices at this edit)`, RangeError);
    }
    if (seen.has(vertex)) throw invalidField('vertices', vertices, `${PICK_HINT}; vertex ${vertex} is listed twice`);
    seen.add(vertex);
  }
  return vertices;
}

function findRoot(parents, vertex) {
  let root = vertex;
  while (parents.get(root) !== root) root = parents.get(root);
  return root;
}

// The picked vertices in pick order, split into the groups that merge: one group for centre, first and last; for collapse
// the groups the picked vertices form through mesh edges between two picked vertices.
function mergeGroups(mesh, vertices, at) {
  if (at !== 'collapse') return [vertices];
  const parents = new Map(vertices.map(vertex => [vertex, vertex]));
  for (let edge = 0; edge < mesh.edgeCount; edge++) {
    const first = mesh.edgeVertices[edge * 2];
    const second = mesh.edgeVertices[edge * 2 + 1];
    if (!parents.has(first) || !parents.has(second)) continue;
    const firstRoot = findRoot(parents, first);
    const secondRoot = findRoot(parents, second);
    if (firstRoot !== secondRoot) parents.set(Math.max(firstRoot, secondRoot), Math.min(firstRoot, secondRoot));
  }
  const groups = new Map();
  for (const vertex of vertices) {
    const root = findRoot(parents, vertex);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(vertex);
  }
  return [...groups.values()].filter(group => group.length > 1);
}

function centreOf(mesh, group) {
  const sum = [0, 0, 0];
  for (const vertex of group) {
    for (let axis = 0; axis < 3; axis++) sum[axis] += mesh.positions[vertex * 3 + axis];
  }
  return sum.map(value => value / group.length);
}

function survivorOf(group, at) {
  if (at === 'first') return group[0];
  if (at === 'last') return group.at(-1);
  return Math.min(...group);
}

/**
 * Merge the picked vertices. `at` is one of MERGE_TARGETS. Returns { mesh, mergedVertices, removedFaces } where
 * mergedVertices is how many vertices the merge removed. Throws a sentence that says what to pass instead.
 */
export function mergeVertices(mesh, vertices, { at = 'center' } = {}) {
  if (!MERGE_TARGETS.includes(at)) throw invalidField('at', at, `one of ${MERGE_TARGETS.map(target => `"${target}"`).join(', ')}`);
  checkPickedVertices(mesh, vertices);
  const groups = mergeGroups(mesh, vertices, at);
  if (groups.length === 0) {
    throw invalidField('vertices', vertices, 'picked vertices that share an edge for collapse (it merges each connected group), or use at "center", "first" or "last" to merge vertices that are apart');
  }
  const survivorByVertex = new Map();
  const centreBySurvivor = new Map();
  for (const group of groups) {
    const survivor = survivorOf(group, at);
    for (const vertex of group) survivorByVertex.set(vertex, survivor);
    if (at === 'center' || at === 'collapse') centreBySurvivor.set(survivor, centreOf(mesh, group));
  }
  const weldMap = new Int32Array(mesh.vertexCount);
  const representatives = [];
  const weldedOfSurvivor = new Map();
  const positionOverrides = new Map();
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    const survivor = survivorByVertex.get(vertex) ?? vertex;
    if (!weldedOfSurvivor.has(survivor)) {
      weldedOfSurvivor.set(survivor, representatives.length);
      representatives.push(survivor);
      if (centreBySurvivor.has(survivor)) positionOverrides.set(representatives.length - 1, centreBySurvivor.get(survivor));
    }
    weldMap[vertex] = weldedOfSurvivor.get(survivor);
  }
  const merged = weldMesh(mesh, weldMap, representatives, {
    emptyMessage: 'merge_verts left no face. Pick fewer vertices, or vertices that are not all of one face.',
    positionOverrides,
    dropDuplicateFaces: true,
  });
  const pickedInGroups = groups.reduce((total, group) => total + group.length, 0);
  return { mesh: merged.mesh, mergedVertices: pickedInGroups - groups.length, removedFaces: merged.removedFaces };
}
