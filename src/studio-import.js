import { AGENT_ASSET_LIMITS, describeAssetBytes, withCatalogLimitAdvice } from './agent-asset-limits.js';
import { MAXIMUM_CATALOG_ENVIRONMENT_BYTES } from './look-catalog.js';
import { NO_STORE_MESSAGE } from './studio-catalog.js';
import { imageLimitProblem, readImageDimensions } from './image-header.js';
import { TEXTURE_SEQUENCE_LIMITS } from './texture-sequence-limits.js';

// Brings one file from disk into the scene: a GLB placed at the origin, a Radiance .hdr as the sky, or a PNG, JPEG or WebP as
// the base colour of the selected object. The kind comes from the bytes, never the extension. Everything that can be refused is
// refused before the host stores the file, and the scene changes in one batch, so a refusal leaves the recipe, the undo stack
// and the pool as they were. This module loads on the first import, so a Studio nobody imports into never downloads it.

const IMPORT_FORMATS = 'a .glb model, a Radiance .hdr sky, or a .png, .jpg or .webp image';
const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46];
const MEBIBYTE = 1024 * 1024;
const MAXIMUM_NODE_ID_LENGTH = 40;
const MAXIMUM_LABEL_LENGTH = 64;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function refusal(message) {
  return new Error(message);
}

function hasPrefix(bytes, prefix) {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function leadingCharacter(bytes) {
  const text = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart();
  return text.charAt(0);
}

function isWebp(bytes) {
  const latin1 = new TextDecoder('latin1');
  return bytes.length >= 12 && latin1.decode(bytes.subarray(0, 4)) === 'RIFF' && latin1.decode(bytes.subarray(8, 12)) === 'WEBP';
}

// 'asset', 'environment' or 'image' with the extension the host stores it under; null when the bytes are none of those.
function detectKind(bytes) {
  if (hasPrefix(bytes, GLB_MAGIC)) {
    return { kind: 'asset', extension: 'glb' };
  }
  if (/^#\?(?:RADIANCE|RGBE)/.test(new TextDecoder('latin1').decode(bytes.subarray(0, 10)))) {
    return { kind: 'environment', extension: 'hdr' };
  }
  if (readImageDimensions(bytes)) {
    if (hasPrefix(bytes, PNG_MAGIC)) {
      return { kind: 'image', extension: 'png' };
    }
    return { kind: 'image', extension: isWebp(bytes) ? 'webp' : 'jpg' };
  }
  return null;
}

function megabytes(size) {
  return `${(size / MEBIBYTE).toFixed(1)} MiB`;
}

function sizeProblem(kind, fileName, size) {
  const limit = kind === 'environment' ? MAXIMUM_CATALOG_ENVIRONMENT_BYTES : AGENT_ASSET_LIMITS.maxBytes;
  if (size <= limit) {
    return null;
  }
  const advice = kind === 'environment'
    ? 'Use a 2k or smaller HDRI.'
    : kind === 'asset'
      ? 'Simplify it first (fewer vertices, meshopt compression, textures at 1k instead of 4k) and import the smaller file.'
      : 'Save a smaller version of it and import that.';
  return `${fileName} is ${megabytes(size)}; Studio imports files up to ${describeAssetBytes(limit)} of this type. ${advice}`;
}

function unknownTypeMessage(bytes, fileName) {
  if (leadingCharacter(bytes) === '{') {
    return `${fileName} looks like a glTF JSON file, which usually points at separate .bin and image files. Export one self-contained .glb and import that.`;
  }
  return `${fileName} is not a file Studio can import. Import ${IMPORT_FORMATS}; a scene.json opens with Open.`;
}

function glbProblem(error, fileName) {
  const message = String(error?.message ?? error);
  const compression = /Unsupported glTF extension: (KHR_draco_mesh_compression|KHR_texture_basisu)/.exec(message);
  if (compression) {
    const name = compression[1] === 'KHR_draco_mesh_compression' ? 'Draco mesh compression' : 'KTX2 texture compression';
    return `${fileName} uses ${name}, which Studio has no decoder for. Export it again without that compression, or add it through the MCP asset catalog, which converts it.`;
  }
  if (/External glTF uri/.test(message)) {
    return `${fileName} points at files outside itself. Export one self-contained .glb (every buffer and texture inside the file) and import that.`;
  }
  if (error instanceof RangeError) {
    return withCatalogLimitAdvice(error).message;
  }
  return `${fileName} is not a glTF model Studio can read: ${message}`;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readBytes(file) {
  if (file.bytes) {
    return file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
  }
  return new Uint8Array(await file.arrayBuffer());
}

function baseName(fileName) {
  return fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
}

function uniqueNodeId(fileName, existingIds) {
  const stem = baseName(fileName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAXIMUM_NODE_ID_LENGTH).replace(/-+$/, '');
  const base = stem || 'import';
  if (!existingIds.has(base)) {
    return base;
  }
  let counter = 2;
  while (existingIds.has(`${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

// The material of the selected object, or a sentence saying what to do when it cannot take a colour image.
function selectedMaterialOrProblem(controller, fileName) {
  const recipe = controller.exportRecipe();
  const node = recipe.nodes.find(candidate => candidate.id === controller.selectedNodeId);
  if (!node || node.geometry === undefined) {
    return { problem: `Select the object that should wear ${fileName} first, then import it again.` };
  }
  const material = recipe.materials.find(candidate => candidate.id === node.material);
  if (!material) {
    return { problem: `${node.label ?? node.id} has no material to put ${fileName} on. Give it one in the Material tab, then import again.` };
  }
  if (material.tag !== 'surface') {
    return { problem: `${node.label ?? node.id} uses a ${material.tag} material, and only surface materials take an image. Pick another object, or give this one a surface material.` };
  }
  if (material.map !== undefined) {
    return { problem: `The material of ${node.label ?? node.id} already plays a map sequence as its colour, and an image cannot share it. Select an object with a plain material.` };
  }
  if (material.pattern !== undefined) {
    return { problem: `The material of ${node.label ?? node.id} is made from a procedural pattern, and an image cannot share it. Select an object with a plain material.` };
  }
  const unmappedProblem = unmappedUsersProblem(controller, recipe, material, fileName);
  if (unmappedProblem) return { problem: unmappedProblem };
  return { material };
}

const MILLISECONDS_PER_CHARACTER = 60;
const MAXIMUM_MESSAGE_MILLISECONDS = 12000;

/** How long the status line keeps an import message up: about 60 ms a character, never under the usual time, at most 12 s. */
export function importMessageDuration(message, minimumMilliseconds) {
  const proportional = message.length * MILLISECONDS_PER_CHARACTER;
  return Math.min(MAXIMUM_MESSAGE_MILLISECONDS, Math.max(minimumMilliseconds, proportional));
}

const MAXIMUM_NAMED_OBJECTS = 3;

// The renderer pauses the picture when a material map lands on geometry without UV coordinates, and the edit is in place,
// so every object that wears this material counts. A box, cylinder or cone gets its UVs once the map is on, so the recipe
// decides for those; the built geometry decides for everything else (docs/agent-scene.md, "Which geometries have UVs").
const GEOMETRY_TYPES_THAT_GAIN_UVS = ['box', 'cylinder', 'cone'];

function unmappedUsersProblem(controller, recipe, material, fileName) {
  const labelsByNodeId = new Map(recipe.nodes.map(node => [node.id, node.label ?? node.id]));
  const geometryIdsByNodeId = new Map(recipe.nodes.map(node => [node.id, node.geometry]));
  const typesByGeometryId = new Map(recipe.geometries.map(definition => [definition.id, definition.type]));
  const unmappedLabels = [];
  for (const part of controller.scene?.parts ?? []) {
    if (part.material?.id !== material.id) continue;
    const geometry = part.geometry ?? {};
    if (geometry.uvs || geometry.lightUvs || part.material.boxMapScale) continue;
    if (GEOMETRY_TYPES_THAT_GAIN_UVS.includes(typesByGeometryId.get(geometryIdsByNodeId.get(part.name)))) continue;
    const label = labelsByNodeId.get(part.name) ?? part.name;
    if (!unmappedLabels.includes(label)) unmappedLabels.push(label);
  }
  if (unmappedLabels.length === 0) return null;
  const shown = unmappedLabels.slice(0, MAXIMUM_NAMED_OBJECTS).join(', ');
  const hidden = unmappedLabels.length - MAXIMUM_NAMED_OBJECTS;
  const names = hidden > 0 ? `${shown} and ${hidden} more` : shown;
  return `${fileName} cannot go on this material: ${names} ${unmappedLabels.length === 1 ? 'has' : 'have'} no UV coordinates, so the picture would stop the viewport. Only sphere, box, cylinder, cone, torus, plane, grid and unwrapped mesh objects take an image. Select one of those, or give ${unmappedLabels.length === 1 ? 'that object its' : 'those objects their'} own material first.`;
}

function placeModel({ controller, fileName, id }) {
  const recipe = controller.exportRecipe();
  const nodeId = uniqueNodeId(fileName, new Set(recipe.nodes.map(node => node.id)));
  const node = { id: nodeId, label: baseName(fileName).slice(0, MAXIMUM_LABEL_LENGTH) || nodeId, translation: [0, 0, 0], asset: { id } };
  return {
    nextRecipe: { ...recipe, nodes: [...recipe.nodes, node] },
    operations: [{ type: 'add-node', node }],
    options: { selectNodeId: nodeId, detail: { kind: 'topology' } },
    message: `Placed ${fileName}`,
  };
}

function setSky({ controller, fileName, id }) {
  const recipe = controller.exportRecipe();
  return {
    nextRecipe: { ...recipe, environment: { ...recipe.environment, hdri: id } },
    operations: [{ type: 'set-environment', environment: { hdri: id } }],
    options: { detail: { kind: 'look' } },
    message: `Sky set to ${fileName}`,
  };
}

// The base colour is multiplied by the image, so the colour goes to white or the old tint would stain the picture.
function setColorMap({ controller, fileName, id }) {
  const recipe = controller.exportRecipe();
  const { material, problem } = selectedMaterialOrProblem(controller, fileName);
  if (problem) {
    throw refusal(problem);
  }
  const change = { colorMap: id, color: [1, 1, 1] };
  return {
    nextRecipe: { ...recipe, materials: recipe.materials.map(candidate => (candidate.id === material.id ? { ...candidate, ...change } : candidate)) },
    operations: [{ type: 'set-material', id: material.id, ...change }],
    options: { detail: { kind: 'material', materialId: material.id } },
    message: `Colour map of ${material.id} set from ${fileName}`,
  };
}

const PLANNERS = Object.freeze({ asset: placeModel, environment: setSky, image: setColorMap });

async function stageOrRefuse(catalog, { kind, id, bytes, fileName }) {
  try {
    return await catalog.stageFile(kind, id, bytes);
  } catch (error) {
    if (kind === 'asset') {
      throw refusal(glbProblem(error, fileName));
    }
    throw refusal(`${fileName} could not be read as ${kind === 'environment' ? 'a Radiance .hdr' : 'an image'}: ${error.message}`);
  }
}

/**
 * Imports `file` ({ name, bytes } or a File) into the scene of `controller` and resolves with the sentence to show. A refusal throws an
 * Error whose message says what to do. `catalog` is the Studio catalog, `prepareRecipe` loads the code and files a recipe needs.
 */
export async function importFile(file, { catalog, controller, prepareRecipe }) {
  if (!catalog.canStore || !globalThis.crypto?.subtle) {
    throw refusal(NO_STORE_MESSAGE);
  }
  const fileName = String(file.name || 'file').replace(/^.*[\\/]/, '');
  const knownSize = file.size ?? file.bytes?.byteLength;
  if (knownSize !== undefined) {
    const hinted = /\.hdr$/i.test(fileName) ? 'environment' : 'asset';
    const problem = sizeProblem(hinted, fileName, knownSize);
    if (problem) {
      throw refusal(problem);
    }
  }
  const bytes = await readBytes(file);
  const detected = detectKind(bytes);
  if (!detected) {
    throw refusal(unknownTypeMessage(bytes, fileName));
  }
  const { kind, extension } = detected;
  const problem = sizeProblem(kind, fileName, bytes.byteLength);
  if (problem) {
    throw refusal(problem);
  }
  if (kind === 'image') {
    const headerProblem = imageLimitProblem(bytes, fileName, TEXTURE_SEQUENCE_LIMITS, 'Resize it and import the smaller picture.');
    const { problem: selectionProblem } = selectedMaterialOrProblem(controller, fileName);
    if (headerProblem ?? selectionProblem) {
      throw refusal(headerProblem ?? selectionProblem);
    }
  }
  const id = await sha256Hex(bytes);
  const register = await stageOrRefuse(catalog, { kind, id, bytes, fileName });
  await catalog.storeFile({ kind, id, name: fileName, extension, bytes });
  register();
  const plan = PLANNERS[kind]({ controller, fileName, id });
  await prepareRecipe(plan.nextRecipe);
  controller.applyImportOperations(plan.operations, plan.options);
  return plan.message;
}
