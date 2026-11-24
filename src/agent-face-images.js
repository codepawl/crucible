import { invalidField } from './field-error.js';

// `faceImages` on a box node: an image, a tiled texture or a per-frame image sequence on one face of the part (Roblox Decal and
// Texture). Each entry becomes a child quad that covers the face from just outside it, so the image follows the part when it
// moves, turns or is resized, and a `tile` size in metres keeps the tiling constant while the part is resized. The quad's material
// is an ordinary recipe material, so alpha, tint, colorMap and map sequences behave exactly as they do there.

export const FACE_IMAGE_LIMITS = Object.freeze({ maxPerNode: 6, maxDepthLayer: 4, standOffMetres: 0.0005, tileMetres: [0.001, 100000] });

const SQRT_HALF = Math.SQRT1_2;

// Each face of the unit box: the quaternion that turns the quad (facing +z, image upright) to look out of that face, and the axis it sits on.
const FACES = Object.freeze({
  '+z': { rotation: [0, 0, 0, 1], axis: 2, sign: 1 },
  '-z': { rotation: [0, 1, 0, 0], axis: 2, sign: -1 },
  '+x': { rotation: [0, SQRT_HALF, 0, SQRT_HALF], axis: 0, sign: 1 },
  '-x': { rotation: [0, -SQRT_HALF, 0, SQRT_HALF], axis: 0, sign: -1 },
  '+y': { rotation: [-SQRT_HALF, 0, 0, SQRT_HALF], axis: 1, sign: 1 },
  '-y': { rotation: [SQRT_HALF, 0, 0, SQRT_HALF], axis: 1, sign: -1 },
});

export const FACE_NAMES = Object.freeze(Object.keys(FACES));

const ENTRY_FIELDS = ['face', 'colorMap', 'map', 'color', 'opacity', 'alphaMode', 'alphaCutoff', 'tile', 'offset', 'rotation'];
export const FACE_QUAD_GEOMETRY_ID = 'face-image-quad';

// The ids this expansion creates for a node, so a second expansion (a set-node that changes faceImages) can replace them.
function generatedIdPattern(nodeId) {
  const escaped = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}\\.face-\\d+$`);
}

function checkedEntry(entry, index, node) {
  const path = `faceImages[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw invalidField(path, entry, 'an object such as { "face": "+z", "colorMap": "<catalog image asset ID>" }', TypeError);
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_FIELDS.includes(key)) throw invalidField(`${path}.${key}`, entry[key], `no such field; use one of ${ENTRY_FIELDS.join(', ')}`, TypeError);
  }
  if (!Object.hasOwn(FACES, entry.face)) {
    throw invalidField(`${path}.face`, entry.face, `one of ${FACE_NAMES.join(', ')}, the face of node "${node.id}" that carries the image`, TypeError);
  }
  if ((entry.colorMap === undefined) === (entry.map === undefined)) {
    throw invalidField(`${path}.colorMap`, entry.colorMap ?? entry.map, 'exactly one of colorMap (one catalog image asset ID) or map ({ "sequence": { "frames": [...], "fps": 30 } }, a per-frame image list)', TypeError);
  }
  if (entry.tile !== undefined) {
    const [low, high] = FACE_IMAGE_LIMITS.tileMetres;
    const valid = Array.isArray(entry.tile) && entry.tile.length === 2 && entry.tile.every(side => Number.isFinite(side) && side >= low && side <= high);
    if (!valid) throw invalidField(`${path}.tile`, entry.tile, `[u, v], the metres one tile covers along the face (each ${low} to ${high}), such as [1, 1]; leave it out to stretch one image over the whole face`, TypeError);
  }
  if (entry.offset !== undefined && !(Array.isArray(entry.offset) && entry.offset.length === 2 && entry.offset.every(Number.isFinite))) {
    throw invalidField(`${path}.offset`, entry.offset, '[u, v] in tiles, such as [0.25, 0]', TypeError);
  }
}

function faceMaterial(entry, materialId) {
  const material = { id: materialId, alphaMode: 'blend', roughness: 1 };
  for (const field of ['colorMap', 'map', 'color', 'opacity', 'alphaMode', 'alphaCutoff']) {
    if (entry[field] !== undefined) material[field] = entry[field];
  }
  if (entry.tile !== undefined) material.worldScale = entry.tile;
  if (entry.offset !== undefined) material.uvOffset = entry.offset;
  if (entry.rotation !== undefined) material.uvRotation = entry.rotation;
  return material;
}

function faceNode(node, entry, slot, depthLayer) {
  const face = FACES[entry.face];
  const translation = [0, 0, 0];
  // The quad stands a fixed distance off the face in metres, whatever the node's scale along that axis.
  translation[face.axis] = face.sign * (0.5 + FACE_IMAGE_LIMITS.standOffMetres / node.scale[face.axis]);
  return {
    id: `${node.id}.face-${slot}`, parent: node.id, geometry: FACE_QUAD_GEOMETRY_ID, material: `${node.id}.face-${slot}`,
    translation, rotation: [...face.rotation], scale: [1, 1, 1], decal: true, depthLayer, castShadow: false,
  };
}

/**
 * Replaces each node's `faceImages` with child quads, materials and the shared quad geometry. Works on the raw recipe lists in place:
 * `geometries` and `materials` gain entries and the returned node list holds the children after their parent. A node that already has
 * children from an earlier expansion gets them replaced.
 */
export function expandFaceImages(recipe, { maxNodes }) {
  if (!Array.isArray(recipe.geometries) || !Array.isArray(recipe.materials)) return recipe.nodes;
  const regenerated = recipe.nodes.filter(node => node && Object.hasOwn(node, 'faceImages') && typeof node.id === 'string');
  const stale = regenerated.map(node => generatedIdPattern(node.id));
  const isStale = id => typeof id === 'string' && stale.some(pattern => pattern.test(id));
  recipe.materials = recipe.materials.filter(material => !isStale(material?.id));
  const expanded = [];
  for (const node of recipe.nodes) {
    if (node && isStale(node.id)) continue;
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, 'faceImages')) {
      expanded.push(node);
      continue;
    }
    const { faceImages, ...rest } = node;
    expanded.push(rest);
    if (faceImages === null) continue;
    if (!Array.isArray(faceImages) || faceImages.length > FACE_IMAGE_LIMITS.maxPerNode) {
      throw invalidField('faceImages', Array.isArray(faceImages) ? `${faceImages.length} entries` : faceImages, `a list of at most ${FACE_IMAGE_LIMITS.maxPerNode} entries such as [{ "face": "+z", "colorMap": "<catalog image asset ID>" }], or null to remove them`, TypeError);
    }
    const geometry = recipe.geometries.find(candidate => candidate?.id === node.geometry);
    if (geometry?.type !== 'box') {
      throw invalidField('faceImages', geometry?.type ?? node.geometry, `a node whose geometry is a box, so each face is a flat rectangle: node "${node.id}" has ${geometry ? `a ${geometry.type}` : 'no geometry'}; use a box part, or put the image on a quad node with a colorMap or map sequence material`);
    }
    const scale = Array.isArray(node.scale) && node.scale.length === 3 && node.scale.every(component => component > 0) ? node.scale : [1, 1, 1];
    const layersByFace = new Map();
    faceImages.forEach((entry, slot) => {
      checkedEntry(entry, slot, node);
      const layer = layersByFace.get(entry.face) ?? 0;
      if (layer > FACE_IMAGE_LIMITS.maxDepthLayer) {
        throw invalidField(`faceImages[${slot}].face`, entry.face, `a face with at most ${FACE_IMAGE_LIMITS.maxDepthLayer + 1} stacked images; put the rest on another face`);
      }
      layersByFace.set(entry.face, layer + 1);
      const child = faceNode({ id: node.id, scale }, entry, slot, layer);
      recipe.materials.push(faceMaterial(entry, child.material));
      expanded.push(child);
    });
    if (faceImages.length > 0 && !recipe.geometries.some(candidate => candidate?.id === FACE_QUAD_GEOMETRY_ID)) {
      recipe.geometries.push({ id: FACE_QUAD_GEOMETRY_ID, type: 'grid', segments: 1 });
    }
    if (expanded.length > maxNodes) throw new RangeError(`faceImages expand past the limit of ${maxNodes} nodes.`);
  }
  return expanded;
}
