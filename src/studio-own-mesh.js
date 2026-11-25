// Giving a node a mesh geometry of its own, shared by edit mode (studio-mesh-edit.js) and the modifier panel
// (studio-modifier-panel.js): both write to a geometry that no other object may use, and neither can write to a plain shape.

// The shapes of the Add menu's Mesh group turn into a mesh on the first Tab or the first modifier. A box and a cylinder lose their bevel
// on the way: as a mesh the bevel is hundreds of tiny faces (a box of 6 faces becomes 1,482), which nobody can pick one by one. A written 0
// is needed: without a bevel field the shape builds with its default one.
// A plane is written back by the recipe as a grid.
export const CONVERTIBLE_PRIMITIVES = new Set(['plane', 'grid', 'box', 'circle', 'sphere', 'icoSphere', 'cylinder', 'cone', 'torus']);
const PRIMITIVES_WITHOUT_BEVEL = new Set(['box', 'cylinder']);

/** The mesh geometry a shape becomes: its own description as the base, or null for a geometry that is no such shape. */
export function meshGeometryOfPrimitive(geometrySpec) {
  if (!geometrySpec || !CONVERTIBLE_PRIMITIVES.has(geometrySpec.type)) return null;
  const { id, ...base } = structuredClone(geometrySpec);
  if (PRIMITIVES_WITHOUT_BEVEL.has(base.type)) base.bevel = 0;
  return { type: 'mesh', base };
}

export function uniqueGeometryId(recipe, wanted) {
  const taken = new Set((recipe.geometries ?? []).map(geometry => geometry.id));
  let candidate = wanted;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${wanted}-${suffix}`;
  return candidate;
}

/**
 * The scene operations that make the geometry of `nodeId` a mesh no other node uses, and that mesh's id. A geometry another node
 * uses is copied: the edit log and the stack belong to the geometry, so the twin would change too. A shape becomes the mesh of its own
 * description, and the shape itself goes when nothing else uses it. A node that already has such a mesh needs no operation.
 */
export function planOwnMesh(recipe, nodeId) {
  const node = recipe.nodes.find(candidate => candidate.id === nodeId);
  const spec = recipe.geometries.find(candidate => candidate.id === node.geometry);
  const sharing = recipe.nodes.filter(candidate => candidate.geometry === node.geometry).length > 1;
  const converted = meshGeometryOfPrimitive(spec);
  if (!sharing && !converted) return { operations: [], geometryId: spec.id };
  const ownId = uniqueGeometryId(recipe, converted ? `${spec.id}-mesh` : `${spec.id}-${nodeId}`);
  const ownGeometry = converted ?? structuredClone(spec);
  const operations = [{ type: 'add-geometry', geometry: { ...ownGeometry, id: ownId } }, { type: 'set-node', id: nodeId, geometry: ownId }];
  if (converted && !sharing) operations.push({ type: 'remove-geometry', id: spec.id });
  return { operations, geometryId: ownId };
}
