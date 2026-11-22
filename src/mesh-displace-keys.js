// The recipe side of a mesh `displace` edit that reads its height from a material graph or a catalog image (#2863):
// validation of the `source` field and the cache identity. It loads with the lazy mesh module, like the sampling in
// mesh-displace-source.js; the core scene builder reaches it through agentSceneModule('mesh').

const ASSET_ID_PATTERN = /^[a-f0-9]{64}$/;
const MATERIAL_ID_PATTERN = /^[A-Za-z0-9._-]{1,48}$/;

export const DISPLACE_SOURCE_FIELDS = Object.freeze(['material', 'image']);

export const displaceSourceFailure = message => new TypeError(`displace source: ${message}`);

/**
 * Validate the `source` of a displace edit and return a plain copy: exactly one of `{ "material": "<id>" }`, the ID of a
 * recipe material whose graph has a `height` output, or `{ "image": "<64 hex characters>" }`, a catalog image ID.
 */
export function normalizeDisplaceSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw displaceSourceFailure('pass an object such as { "material": "rock" } or { "image": "<64 hex characters of a catalog image ID>" }.');
  }
  const unknown = Object.keys(source).filter(key => !DISPLACE_SOURCE_FIELDS.includes(key));
  if (unknown.length) throw displaceSourceFailure(`${unknown.join(', ')} is not a field. Use one of ${DISPLACE_SOURCE_FIELDS.join(', ')}.`);
  const named = DISPLACE_SOURCE_FIELDS.filter(key => source[key] !== undefined);
  if (named.length !== 1) throw displaceSourceFailure(`pass exactly one of ${DISPLACE_SOURCE_FIELDS.join(' or ')}, such as { "material": "rock" }.`);
  if (named[0] === 'material') {
    if (typeof source.material !== 'string' || !MATERIAL_ID_PATTERN.test(source.material)) throw displaceSourceFailure('material must be the ID of a recipe material, 1 to 48 letters, digits, dots, dashes or underscores.');
    return { material: source.material };
  }
  const image = typeof source.image === 'string' ? source.image.toLowerCase() : source.image;
  if (typeof image !== 'string' || !ASSET_ID_PATTERN.test(image)) throw displaceSourceFailure('image must be the 64 hexadecimal characters of a catalog image asset ID; scene_asset_catalog lists them. Remote URLs are not accepted.');
  return { image };
}

/** The graph pattern of a material that can give a displacement height, or an error that says what to change. */
export function heightPatternOf(material, id) {
  const pattern = material?.pattern;
  if (!pattern || pattern.type !== 'graph' || !pattern.graph) throw displaceSourceFailure(`material ${id} has no graph. Give it a pattern such as { "type": "graph", "mapping": "uv", "graph": { "height": ... } }.`);
  if (pattern.graph.height === undefined) throw displaceSourceFailure(`the graph of material ${id} has no height output. Add one, such as "height": { "noise": { "scale": 6 } }.`);
  if (pattern.mapping !== 'uv') throw displaceSourceFailure(`material ${id} maps its pattern along the object axes, so its height cannot line up with the mesh. Set "mapping": "uv" on its pattern.`);
  return pattern;
}

/** Throw when a displace edit of a mesh geometry names a material the recipe lacks or one without a usable height. */
export function checkDisplaceMaterials(meshDefinition, materials) {
  for (const edit of [...(meshDefinition.edits ?? []), ...(meshDefinition.stack ?? [])]) {
    if (edit?.op !== 'displace' || !edit.source?.material) continue;
    const material = materials.get(edit.source.material);
    if (!material) throw displaceSourceFailure(`material ${edit.source.material} is not in the recipe. Use one of ${[...materials.keys()].join(', ') || 'none yet; add the material first'}.`);
    heightPatternOf(material, edit.source.material);
  }
}

// What decides a source's height: an image by its ID, a material by the height of its graph and how the graph is scaled.
function displaceSourceDependency(source, materials) {
  if (source.image) return `image:${source.image}`;
  const pattern = materials?.get(source.material)?.pattern;
  return `material:${source.material}:${JSON.stringify(pattern?.graph?.height ?? null)}:${pattern?.size ?? ''}:${pattern?.mapping ?? ''}`;
}

/** One string for every height source the edits and stack of a mesh geometry name, for the cache key of the geometry that holds them. */
export function displaceHeightSignature(meshDefinition, materials) {
  return [...(meshDefinition.edits ?? []), ...(meshDefinition.stack ?? [])]
    .filter(edit => edit?.op === 'displace' && edit.source)
    .map(edit => displaceSourceDependency(edit.source, materials))
    .join('|');
}
