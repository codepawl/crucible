import { MATERIAL_GRAPH_LIMITS } from './material-name-lists.js';
import {
  compileMaterialGraph,
  checkMaterialGraphWork,
  normalizeMaterialGraph,
  graphImageAssets,
  graphVertexGroupNames,
  graphMeshMapNames,
  graphSurfaceSettings,
  graphBaseOutputs,
} from './material-graph.js';
import { clampUnit, linearToSrgbByte, createImage, normalMapFromHeights } from './material-texture-kit.js';

// Multi-layer PBR stack (#2859): blends 1 to 4 layers (preset pattern, bounded graph, or direct PBR channels) per texel
// and sharpens upper-layer mask transitions using heightBlend so higher ridges show through lower cover.
export const MATERIAL_LAYER_STACK_LIMITS = Object.freeze({
  minLayers: 1,
  maxLayers: 4,
  heightBlend: Object.freeze([0, 1]),
});

export const STACK_GRAPH_OUTPUTS = Object.freeze(['color', 'roughness', 'metallic', 'height']);
const LAYER_FIELDS = Object.freeze(['pattern', 'graph', 'color', 'roughness', 'metallic', 'height', 'mask', 'heightBlend']);
const METALLIC_PRESET_TYPES = new Set(['metal', 'rust']);
const PRESET_LAYER_WORK = 12;
const BLEND_STEP_WORK = 2;

function layerError(message) {
  return new RangeError(`Material layers: ${message}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function imagePoolMap(images) {
  if (!images) return new Map();
  return images instanceof Map ? images : new Map(Object.entries(images));
}

/**
 * Computes the cover weight in [0, 1] for an upper layer over a base layer using `heightBlend`.
 * `heightBlend === 0` keeps the mask unchanged; higher values contrast-sharpen around the height difference.
 */
export function heightBlendWeight(mask, baseHeight, topHeight, heightBlend) {
  const clampedMask = clampUnit(finiteOrZero(mask));
  if (heightBlend <= 0) return clampedMask;
  const heightDifference = clampUnit(finiteOrZero(topHeight)) - clampUnit(finiteOrZero(baseHeight));
  const shifted = clampedMask + heightDifference * clampedMask * (1 - clampedMask) * 2 * heightBlend;
  const band = 1 - heightBlend * 0.92;
  return clampUnit((shifted - 0.5) / band + 0.5);
}

function channelGraphFromLayer(layer) {
  const outputs = {};
  if (layer.graph !== undefined) {
    Object.assign(outputs, layer.graph);
  }
  for (const field of STACK_GRAPH_OUTPUTS) {
    if (layer[field] !== undefined) {
      outputs[field] = layer[field];
    }
  }
  return Object.keys(outputs).length > 0 ? outputs : null;
}

function validateStackLayer(layer, index, resolution, normalizePreset) {
  if (!isPlainObject(layer)) {
    throw layerError(`layer ${index} must be a JSON object.`);
  }
  for (const key of Object.keys(layer)) {
    if (!LAYER_FIELDS.includes(key)) {
      throw layerError(`layer ${index} has unknown field "${key}". Allowed: ${LAYER_FIELDS.join(', ')}.`);
    }
  }
  if (layer.pattern !== undefined && layer.graph !== undefined) {
    throw layerError(`layer ${index} cannot set both pattern and graph; use one or the other.`);
  }
  const hasChannel = STACK_GRAPH_OUTPUTS.some(field => layer[field] !== undefined);
  if (layer.pattern === undefined && layer.graph === undefined && !hasChannel) {
    throw layerError(`layer ${index} needs pattern, graph, or at least one PBR field (${STACK_GRAPH_OUTPUTS.join(', ')}).`);
  }
  const normalized = {};
  if (layer.pattern !== undefined) {
    if (!isPlainObject(layer.pattern) || layer.pattern.type === 'graph' || layer.pattern.type === 'layers') {
      throw layerError(`layer ${index}.pattern must be a preset pattern (such as "stone" or "wood"); use layer.graph for a material graph.`);
    }
    normalized.pattern = normalizePreset(layer.pattern);
  }
  if (layer.graph !== undefined) {
    if (!isPlainObject(layer.graph)) {
      throw layerError(`layer ${index}.graph must be an object with outputs: ${STACK_GRAPH_OUTPUTS.join(', ')}.`);
    }
    for (const key of Object.keys(layer.graph)) {
      if (!STACK_GRAPH_OUTPUTS.includes(key)) {
        throw layerError(`layer ${index}.graph output "${key}" is not supported; use ${STACK_GRAPH_OUTPUTS.join(', ')}.`);
      }
      if (layer[key] !== undefined) {
        throw layerError(`layer ${index} sets ${key} in both layer.${key} and layer.graph.${key}; keep one.`);
      }
    }
    normalized.graph = normalizeMaterialGraph(layer.graph, resolution);
  }
  for (const field of STACK_GRAPH_OUTPUTS) {
    if (layer[field] !== undefined) {
      normalized[field] = normalizeMaterialGraph({ [field]: layer[field] }, resolution)[field];
    }
  }
  if (index === 0) {
    if (layer.mask !== undefined || layer.heightBlend !== undefined) {
      throw layerError('layer 0 is the base layer and does not take mask or heightBlend.');
    }
    return normalized;
  }
  if (layer.mask === undefined) {
    throw layerError(`layer ${index} needs mask (a number 0 to 1 or a scalar material graph node).`);
  }
  normalized.mask = normalizeMaterialGraph({ roughness: layer.mask }, resolution).roughness;
  const heightBlend = layer.heightBlend ?? 0;
  const [minBlend, maxBlend] = MATERIAL_LAYER_STACK_LIMITS.heightBlend;
  if (typeof heightBlend !== 'number' || !Number.isFinite(heightBlend) || heightBlend < minBlend || heightBlend > maxBlend) {
    throw layerError(`layer ${index}.heightBlend must be a number between ${minBlend} and ${maxBlend}.`);
  }
  normalized.heightBlend = heightBlend;
  return normalized;
}

function compileStack(layers, resolution, options = {}) {
  let totalNodes = 0;
  let totalCost = 0;
  let maxFinestScale = 0;
  const compiledLayers = layers.map((layer, index) => {
    const entry = {
      pattern: layer.pattern ?? null,
      channels: null,
      mask: null,
      heightBlend: layer.heightBlend ?? 0,
    };
    if (layer.pattern) {
      totalNodes += 1;
      totalCost += PRESET_LAYER_WORK;
    }
    const channelGraph = channelGraphFromLayer(layer);
    if (channelGraph) {
      const compiledChannels = compileMaterialGraph(channelGraph, options);
      totalNodes += compiledChannels.nodeCount;
      totalCost += compiledChannels.cost;
      maxFinestScale = Math.max(maxFinestScale, compiledChannels.finestScale);
      entry.channels = compiledChannels.outputs;
    }
    if (index > 0) {
      const compiledMask = compileMaterialGraph({ roughness: layer.mask }, options);
      totalNodes += compiledMask.nodeCount;
      totalCost += compiledMask.cost + BLEND_STEP_WORK;
      maxFinestScale = Math.max(maxFinestScale, compiledMask.finestScale);
      entry.mask = compiledMask.outputs.roughness;
    }
    return entry;
  });
  if (totalNodes > MATERIAL_GRAPH_LIMITS.maxNodes) {
    throw layerError(`stack uses ${totalNodes} graph nodes across all layers; the limit is ${MATERIAL_GRAPH_LIMITS.maxNodes}.`);
  }
  checkMaterialGraphWork({ cost: totalCost, finestScale: maxFinestScale }, resolution);
  return compiledLayers;
}

/** Validates 1 to 4 PBR layers against shared graph node and work limits, returning normalized copies. */
export function normalizeMaterialLayerStack(layers, resolution, normalizePreset) {
  if (!Array.isArray(layers) || layers.length < MATERIAL_LAYER_STACK_LIMITS.minLayers || layers.length > MATERIAL_LAYER_STACK_LIMITS.maxLayers) {
    throw layerError(`expected ${MATERIAL_LAYER_STACK_LIMITS.minLayers} to ${MATERIAL_LAYER_STACK_LIMITS.maxLayers} layers.`);
  }
  const normalized = layers.map((layer, index) => validateStackLayer(layer, index, resolution, normalizePreset));
  compileStack(normalized, resolution, { size: 1 });
  return normalized;
}

function collectAcrossLayers(layers, reader) {
  const seen = [];
  const seenKeys = new Set();
  for (const layer of layers) {
    const fragments = [channelGraphFromLayer(layer), layer.mask !== undefined ? { roughness: layer.mask } : null];
    for (const fragment of fragments) {
      if (!fragment) continue;
      for (const item of reader(fragment)) {
        const key = typeof item === 'string' ? item : JSON.stringify(item);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          seen.push(item);
        }
      }
    }
  }
  return seen;
}

/** Image asset IDs referenced by any graph channel or mask in the layer stack. */
export function stackImageAssets(layers) {
  return collectAcrossLayers(layers, graphImageAssets);
}

/** Plain pixel data for every image asset read by the layer stack, safe for kernel workers and hashing. */
export function stackImageData(layers, pool) {
  const used = {};
  for (const asset of stackImageAssets(layers)) {
    const id = asset.toLowerCase();
    const frame = pool?.get(id);
    if (frame) used[id] = { width: frame.width, height: frame.height, data: frame.data };
  }
  return used;
}

/** Vertex group names referenced by any graph channel or mask in the layer stack. */
export function stackVertexGroupNames(layers) {
  return collectAcrossLayers(layers, graphVertexGroupNames);
}

/** Baked mesh map names referenced by any graph channel or mask in the layer stack. */
export function stackMeshMapNames(layers) {
  return collectAcrossLayers(layers, graphMeshMapNames);
}

/** Distinct baked surface settings referenced by any graph channel or mask in the layer stack. */
export function stackSurfaceSettings(layers) {
  return collectAcrossLayers(layers, graphSurfaceSettings);
}

/** Distinct placed-asset base outputs referenced by any graph channel or mask in the layer stack. */
export function stackBaseOutputs(layers) {
  return collectAcrossLayers(layers, graphBaseOutputs);
}

function readColor(compiledColor, u, v, fallbackRed, fallbackGreen, fallbackBlue) {
  if (!compiledColor) return [fallbackRed, fallbackGreen, fallbackBlue];
  if (compiledColor.kind === 'scalar') {
    const channel = finiteOrZero(compiledColor.evaluate(u, v));
    return [channel, channel, channel];
  }
  return [
    finiteOrZero(compiledColor.parts[0](u, v)),
    finiteOrZero(compiledColor.parts[1](u, v)),
    finiteOrZero(compiledColor.parts[2](u, v)),
  ];
}

function evaluateCompiledLayer(compiledLayer, samplePreset, u, v) {
  let red = 0.5;
  let green = 0.5;
  let blue = 0.5;
  let roughness = 0.5;
  let metallic = 0;
  let height = 0.5;
  if (compiledLayer.pattern) {
    const presetSample = samplePreset(compiledLayer.pattern, u, v);
    red = presetSample.red;
    green = presetSample.green;
    blue = presetSample.blue;
    roughness = presetSample.roughness;
    metallic = METALLIC_PRESET_TYPES.has(compiledLayer.pattern.type) ? presetSample.metal : 0;
    height = presetSample.height;
  }
  const channels = compiledLayer.channels;
  if (channels) {
    if (channels.color) [red, green, blue] = readColor(channels.color, u, v, red, green, blue);
    if (channels.roughness) roughness = clampUnit(finiteOrZero(channels.roughness.evaluate(u, v)));
    if (channels.metallic) metallic = clampUnit(finiteOrZero(channels.metallic.evaluate(u, v)));
    if (channels.height) height = clampUnit(finiteOrZero(channels.height.evaluate(u, v)));
  }
  return { red, green, blue, roughness, metallic, height };
}

/** Bakes a normalized multi-layer PBR stack into colour, normal, and metallic-roughness texture descriptors. Deterministic. */
export function bakeMaterialLayerStack(layers, { resolution, bump, size = 1 }, images, groups, samplePreset) {
  const compiledLayers = compileStack(layers, resolution, {
    size,
    images: imagePoolMap(images),
    groups: groups ? imagePoolMap(groups) : undefined,
  });
  const pixelCount = resolution * resolution;
  const heights = new Float32Array(pixelCount);
  const colorData = new Uint8ClampedArray(pixelCount * 4);
  const surfaceData = new Uint8ClampedArray(pixelCount * 4);
  for (let row = 0; row < resolution; row++) {
    const v = (row + 0.5) / resolution;
    for (let column = 0; column < resolution; column++) {
      const u = (column + 0.5) / resolution;
      const pixel = row * resolution + column;
      const base = evaluateCompiledLayer(compiledLayers[0], samplePreset, u, v);
      let red = base.red;
      let green = base.green;
      let blue = base.blue;
      let roughness = base.roughness;
      let metallic = base.metallic;
      let height = base.height;
      for (let index = 1; index < compiledLayers.length; index++) {
        const layer = compiledLayers[index];
        const maskValue = clampUnit(finiteOrZero(layer.mask.evaluate(u, v)));
        if (maskValue <= 0) continue;
        const top = evaluateCompiledLayer(layer, samplePreset, u, v);
        const weight = heightBlendWeight(maskValue, height, top.height, layer.heightBlend);
        if (weight <= 0) continue;
        const remaining = 1 - weight;
        red = red * remaining + top.red * weight;
        green = green * remaining + top.green * weight;
        blue = blue * remaining + top.blue * weight;
        roughness = roughness * remaining + top.roughness * weight;
        metallic = metallic * remaining + top.metallic * weight;
        height = height * remaining + top.height * weight;
      }
      const offset = pixel * 4;
      colorData[offset] = linearToSrgbByte(red);
      colorData[offset + 1] = linearToSrgbByte(green);
      colorData[offset + 2] = linearToSrgbByte(blue);
      colorData[offset + 3] = 255;
      surfaceData[offset] = 255;
      surfaceData[offset + 1] = Math.round(clampUnit(roughness) * 255);
      surfaceData[offset + 2] = Math.round(clampUnit(metallic) * 255);
      surfaceData[offset + 3] = 255;
      heights[pixel] = clampUnit(height);
    }
  }
  const normalData = normalMapFromHeights(heights, resolution, bump);
  return {
    map: { image: createImage(colorData, resolution, resolution), colorSpace: 'srgb' },
    normalMap: { image: createImage(normalData, resolution, resolution), colorSpace: 'linear' },
    metallicRoughnessMap: { image: createImage(surfaceData, resolution, resolution), colorSpace: 'linear' },
  };
}
