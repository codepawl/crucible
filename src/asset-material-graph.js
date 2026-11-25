import { invalidField } from './field-error.js';
import { registerAssetGraphModule } from './agent-scene-assets.js';
import { baseMapKey, BASE_OUTPUT_SOURCES, graphBaseOutputs, graphImageAssets, graphSurfaceSettings, normalizeMaterialGraph } from './material-graph.js';
import { checkGroupInputs, groupMapsOf, materialPatternTextures, normalizeMaterialPattern } from './material-patterns.js';

// A material graph on a placed asset part (#3202). The graph bakes in the part's UV space like a recipe pattern with
// mapping "uv", and it can read the scan's own textures through `base` nodes. Whatever the graph does not write keeps the
// imported texture: a graph that only sets `color` leaves the scan's roughness, metallic and normal maps as they were.
// The module loads on demand with the other pattern code (src/agent-scene-modules.js).

// `axis` and `mapping` are what a normalized pattern carries, so a normalized recipe normalizes to itself.
const PATTERN_FIELDS = ['type', 'graph', 'resolution', 'size', 'bump', 'axis', 'mapping'];
const UV_TOLERANCE = 1e-3;
const PATTERN_EXAMPLE = '{ "graph": { "color": { "layer": { "base": { "base": { "output": "color" } }, "top": [0.9, 0.92, 0.95], "mask": { "surface": { "output": "slope", "space": "world" } } } } } }';

// What an unwritten output falls back to: the imported texture, read through a base node.
const KEPT_OUTPUTS = Object.freeze([
  { output: 'color', baseOutput: 'color' },
  { output: 'roughness', baseOutput: 'roughness' },
  { output: 'metallic', baseOutput: 'metallic' },
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function withPath(error, path) {
  const wrapped = new error.constructor(`${path}: ${error.message}`);
  wrapped.fieldPath = path;
  return wrapped;
}

/**
 * Validate the `pattern` of a placed asset or of one of its material overrides. Returns a normalized graph pattern in
 * UV mapping. Named errors say what a placed asset does not take.
 */
export function normalizeAssetPattern(value, path) {
  if (!isPlainObject(value)) throw invalidField(path, value, `an object with a graph, such as ${PATTERN_EXAMPLE}`, TypeError);
  for (const key of Object.keys(value)) {
    if (!PATTERN_FIELDS.includes(key)) throw invalidField(`${path}.${key}`, value[key], `no such field; use one of ${PATTERN_FIELDS.join(', ')}`, TypeError);
  }
  if (value.type !== undefined && value.type !== 'graph') throw invalidField(`${path}.type`, value.type, '"graph", the only pattern a placed asset takes');
  if (value.mapping !== undefined && value.mapping !== 'uv') throw invalidField(`${path}.mapping`, value.mapping, '"uv", the only mapping a placed asset takes, since the graph bakes into the UV space of the scan');
  if (value.graph === undefined) throw invalidField(`${path}.graph`, value.graph, `a material graph, such as ${PATTERN_EXAMPLE}`);
  let pattern;
  try {
    pattern = normalizeMaterialPattern({ ...value, type: 'graph', mapping: 'uv' }, { allowBase: true });
  } catch (error) {
    throw withPath(error, path);
  }
  if (Object.hasOwn(pattern.graph, 'height')) {
    throw invalidField(`${path}.graph.height`, 'height', 'no height output: a placed asset keeps the scan\'s normal map, so shape the surface with color, roughness and metallic');
  }
  if (graphImageAssets(pattern.graph).length > 0) {
    throw invalidField(`${path}.graph`, 'an image node', 'a graph without image nodes: read the scan\'s own textures with a base node, such as {"base":{"output":"color"}}');
  }
  return pattern;
}

function checkReadableDescriptor(descriptor, sourceMap, path) {
  if ((descriptor.uvChannel ?? 0) !== 0 || descriptor.uvTransform) {
    throw invalidField(path, `${sourceMap} with ${descriptor.uvTransform ? 'a UV transform' : 'TEXCOORD_1'}`, `a material whose ${sourceMap} uses TEXCOORD_0 and no KHR_texture_transform; bake the transform into the UVs first`);
  }
}

/**
 * The pattern a placed part draws with: unwritten colour, roughness and metallic outputs read the part's own textures,
 * and every `base` node is checked against the maps the imported material has. Checks the work budget of the result.
 */
export function completeAssetPattern(pattern, material, path) {
  const graph = { ...pattern.graph };
  for (const { output, baseOutput } of KEPT_OUTPUTS) {
    if (graph[output] === undefined && material[BASE_OUTPUT_SOURCES[baseOutput]]) graph[output] = { base: { output: baseOutput } };
  }
  const missing = graphBaseOutputs(graph).find(output => !material[BASE_OUTPUT_SOURCES[output]]);
  if (missing) {
    const sourceMap = BASE_OUTPUT_SOURCES[missing];
    throw invalidField(`${path}.graph`, `base ${missing}`, `a base output the imported material has: material ${JSON.stringify(material.name ?? '')} has no ${sourceMap}, so drop that base node or pass it on a part that has one`);
  }
  for (const [output, sourceMap] of [['color', 'map'], ['roughness', 'metallicRoughnessMap'], ['metallic', 'metallicRoughnessMap']]) {
    if (graph[output] !== undefined && material[sourceMap]) checkReadableDescriptor(material[sourceMap], sourceMap, `${path}.graph.${output}`);
  }
  for (const sourceMap of new Set(graphBaseOutputs(graph).map(output => BASE_OUTPUT_SOURCES[output]))) checkReadableDescriptor(material[sourceMap], sourceMap, `${path}.graph`);
  try {
    normalizeMaterialGraph(graph, pattern.resolution);
  } catch (error) {
    throw withPath(error, `${path}.graph`);
  }
  return Object.freeze({ ...pattern, graph });
}

/** A short stable name for a pattern, so a placement's material id stays readable. */
export function assetPatternKey(pattern) {
  let hash = 2166136261;
  for (const character of JSON.stringify(pattern)) {
    hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const reducedByImage = new WeakMap();

// Averages whole blocks of texels, so a 4K scan does not make a 512 bake read 16 million pixels per output.
function reducedPixels(pixels, resolution) {
  const factor = Math.floor(Math.min(pixels.width, pixels.height) / resolution);
  if (factor < 2) return pixels;
  const width = Math.floor(pixels.width / factor);
  const height = Math.floor(pixels.height / factor);
  const data = new Uint8ClampedArray(width * height * 4);
  const blockArea = factor * factor;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      for (let channel = 0; channel < 4; channel++) {
        let sum = 0;
        for (let blockRow = 0; blockRow < factor; blockRow++) {
          for (let blockColumn = 0; blockColumn < factor; blockColumn++) {
            sum += pixels.data[(((row * factor) + blockRow) * pixels.width + (column * factor) + blockColumn) * 4 + channel];
          }
        }
        data[(row * width + column) * 4 + channel] = Math.round(sum / blockArea);
      }
    }
  }
  return { width, height, data };
}

function decodedPixels(image, label) {
  if (image?.data && image.width > 0 && image.height > 0 && image.data.length >= image.width * image.height * 4) {
    return { width: image.width, height: image.height, data: image.data };
  }
  if (image?.width > 0 && typeof OffscreenCanvas === 'function') {
    const context = new OffscreenCanvas(image.width, image.height).getContext('2d');
    context.drawImage(image, 0, 0);
    const read = context.getImageData(0, 0, image.width, image.height);
    return { width: read.width, height: read.height, data: read.data };
  }
  throw invalidField(label, 'a compressed or undecoded texture', 'a PNG or JPEG texture; a GPU-compressed (KTX2) map cannot be read by a base node');
}

function baseMapsOf(output, pattern, nodeId) {
  const maps = {};
  for (const baseOutput of graphBaseOutputs(pattern.graph)) {
    const sourceMap = BASE_OUTPUT_SOURCES[baseOutput];
    if (maps[baseMapKey(sourceMap)]) continue;
    const image = output[sourceMap].image;
    let reduced = reducedByImage.get(image);
    if (!reduced) {
      reduced = new Map();
      reducedByImage.set(image, reduced);
    }
    if (!reduced.has(pattern.resolution)) reduced.set(pattern.resolution, reducedPixels(decodedPixels(image, `nodes[${nodeId}] ${sourceMap}`), pattern.resolution));
    maps[baseMapKey(sourceMap)] = reduced.get(pattern.resolution);
  }
  return maps;
}

function checkUvRange(geometry, nodeId) {
  const { uvs } = geometry;
  if (!uvs) throw invalidField(`nodes[${nodeId}].material`, 'a mesh without UVs', 'a part with UVs, since a graph on a placed asset bakes in UV space');
  for (const coordinate of uvs) {
    if (coordinate < -UV_TOLERANCE || coordinate > 1 + UV_TOLERANCE) {
      throw invalidField(`nodes[${nodeId}].material`, `UVs reaching ${coordinate.toFixed(2)}`, 'a part whose UVs lie inside 0 to 1; this one tiles its texture, so a graph cannot be baked over it');
    }
  }
}

// The material fields each graph output writes into.
const OUTPUT_FIELDS = Object.freeze({
  color: ['map'], opacity: ['map'], roughness: ['metallicRoughnessMap'], metallic: ['metallicRoughnessMap'],
  emission: ['emissiveMap'], clearcoat: ['layerMaps'], transmission: ['transmissionMap'], aov: ['aovMap'],
});

function bakedField(source, baked, field) {
  if (field === 'layerMaps') return { ...source, ...baked.layerMaps };
  const descriptor = baked[field];
  return source ? { ...source, image: descriptor.image, colorSpace: descriptor.colorSpace, uvChannel: 0 } : descriptor;
}

const viewsByGeometry = new WeakMap();

/**
 * The material a part of `geometry` draws with: the imported material with the graph's baked textures laid over the maps
 * the graph writes. Baked on first read and kept per mesh and placement; `worldMatrix` places world-space surface masks.
 */
export function assetGraphView(output, geometry, nodeId, worldMatrix) {
  const { pattern } = output.assetGraph;
  checkUvRange(geometry, nodeId);
  const worldSpace = graphSurfaceSettings(pattern.graph).some(settings => settings.space === 'world');
  const placement = worldSpace && worldMatrix ? Array.from(worldMatrix).join(',') : '';
  let views = viewsByGeometry.get(geometry);
  if (!views) {
    views = new WeakMap();
    viewsByGeometry.set(geometry, views);
  }
  const remembered = views.get(output);
  if (remembered?.placement === placement) return remembered.view;
  checkGroupInputs(pattern, geometry, nodeId);
  const baseMaps = baseMapsOf(output, pattern, nodeId);
  const placedMatrix = worldMatrix ? Array.from(worldMatrix) : undefined;
  let groups;
  let baked;
  const bakedTextures = () => {
    groups ??= { ...groupMapsOf(pattern, geometry, nodeId, placedMatrix), ...baseMaps };
    baked ??= materialPatternTextures(pattern, undefined, groups);
    return baked;
  };
  const view = {};
  const merged = new Map();
  for (const field of Object.keys(output)) {
    Object.defineProperty(view, field, { enumerable: true, configurable: true, value: output[field] });
  }
  const written = new Set(Object.keys(pattern.graph).flatMap(name => OUTPUT_FIELDS[name] ?? []));
  for (const field of written) {
    // The renderer compares a part's texture by identity on every update, so each field is merged once.
    Object.defineProperty(view, field, { enumerable: true, configurable: true, get: () => {
      if (!merged.has(field)) merged.set(field, bakedField(output[field], bakedTextures(), field));
      return merged.get(field);
    } });
  }
  if (Object.hasOwn(pattern.graph, 'emission')) {
    Object.defineProperty(view, 'emissionFresnel', { enumerable: true, configurable: true, get: () => bakedTextures().emissionFresnel });
  }
  const frozen = Object.freeze(view);
  views.set(output, { placement, view: frozen });
  return frozen;
}

registerAssetGraphModule({ normalizeAssetPattern, completeAssetPattern, assetPatternKey });
