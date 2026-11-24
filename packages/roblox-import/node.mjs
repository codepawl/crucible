// Node helpers for the Roblox importer: read an .rbxlx or .rbxmx file, and turn a local asset folder into the table that
// importRoblox() takes as `options.assets`. Everything is read from disk; nothing is fetched.
//
// The asset folder holds the mesh and image files and an `asset-map.json` that maps a Roblox asset id to a file in the folder:
//   { "rbxassetid://123456": "tree.glb", "789": "wall.png" }
// An id may be written as rbxassetid://N, as an asset URL with ?id=N (only the number is used) or as the bare number.
import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { RobloxImportError, importRoblox, robloxAssetKey } from './index.mjs';

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_COUNT = 4096;
const MAX_XML_BYTES = 256 * 1024 * 1024;
const MAX_MAP_BYTES = 4 * 1024 * 1024;
const MAP_FILE = 'asset-map.json';
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function isInside(root, path) {
  return path === root || path.startsWith(root + sep);
}

/**
 * Opens a file once and reads it from that handle, so the size and type come from fstat of the open handle and the file cannot
 * change between the check and the read. With `root`, the path is resolved after the open and the file must lie inside the
 * folder, and the open handle must be that same file (device and inode, which a link swapped in meanwhile would break).
 * Returns `{ bytes, resolvedPath }`.
 */
export async function readFileOnce(path, { maxBytes, tooLarge, notFile, root, outside }) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new RobloxImportError(notFile);
    if (info.size > BigInt(maxBytes)) throw new RobloxImportError(tooLarge);
    let resolvedPath = resolve(path);
    if (root !== undefined) {
      resolvedPath = await realpath(path);
      if (!isInside(root, resolvedPath)) throw new RobloxImportError(outside);
      const target = await stat(resolvedPath, { bigint: true });
      if (target.dev !== info.dev || target.ino !== info.ino) {
        throw new RobloxImportError(`"${path}" changed while it was being read: the file that was opened is not the one the path now resolves to. Do not move or relink files while importing.`);
      }
    }
    const size = Number(info.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { bytes: bytes.subarray(0, offset), resolvedPath };
  } finally {
    await handle.close();
  }
}

// Column-major 4x4 of a glTF node: its `matrix`, or translation, rotation (XYZW) and scale.
function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiplyColumnMajor(left, right) {
  const product = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) product[column * 4 + row] += left[k * 4 + row] * right[column * 4 + k];
    }
  }
  return product;
}

// The box of every mesh in the default scene, from the min and max each POSITION accessor already stores (no mesh data is
// decoded) moved by the node matrices. Null when an accessor has no min and max.
export function glbBounds(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== GLB_MAGIC) return null;
  const chunkLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== JSON_CHUNK || 20 + chunkLength > bytes.length) return null;
  const document = JSON.parse(bytes.subarray(20, 20 + chunkLength).toString('utf8'));
  const nodes = document.nodes ?? [];
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  let invalid = false;
  const visited = new Set();
  const walk = (index, parentMatrix) => {
    if (visited.has(index) || !nodes[index]) return;
    visited.add(index);
    const matrix = multiplyColumnMajor(parentMatrix, nodeMatrix(nodes[index]));
    const mesh = document.meshes?.[nodes[index].mesh];
    for (const primitive of mesh?.primitives ?? []) {
      const accessor = document.accessors?.[primitive.attributes?.POSITION];
      if (!accessor?.min || !accessor?.max) {
        invalid = true;
        continue;
      }
      for (let corner = 0; corner < 8; corner += 1) {
        const point = [0, 1, 2].map(axis => ((corner >> axis) & 1 ? accessor.max[axis] : accessor.min[axis]));
        for (let axis = 0; axis < 3; axis += 1) {
          const value = matrix[axis] * point[0] + matrix[4 + axis] * point[1] + matrix[8 + axis] * point[2] + matrix[12 + axis];
          low[axis] = Math.min(low[axis], value);
          high[axis] = Math.max(high[axis], value);
        }
      }
    }
    for (const child of nodes[index].children ?? []) walk(child, matrix);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const sceneRoots = document.scenes?.[document.scene ?? 0]?.nodes ?? [];
  sceneRoots.forEach(index => walk(index, identity));
  if (invalid || !low.every(Number.isFinite) || !high.every(Number.isFinite)) return null;
  return { size: high.map((value, axis) => value - low[axis]), center: high.map((value, axis) => (value + low[axis]) / 2) };
}

async function readMap(folder) {
  let text;
  try {
    const { bytes } = await readFileOnce(resolve(folder, MAP_FILE), {
      maxBytes: MAX_MAP_BYTES,
      tooLarge: `${MAP_FILE} is larger than ${MAX_MAP_BYTES} bytes. List only the assets the scene uses.`,
      notFile: `${MAP_FILE} must be a regular file.`,
      root: folder,
      outside: `${MAP_FILE} resolves outside the asset folder. Keep ${MAP_FILE} as a regular file inside the folder.`,
    });
    text = bytes.toString('utf8');
  } catch (error) {
    if (error instanceof RobloxImportError) throw error;
    throw new RobloxImportError(`The asset folder has no ${MAP_FILE}. Create ${MAP_FILE} there, a JSON object that maps each Roblox asset id to a file in the folder, such as { "rbxassetid://123": "tree.glb" }.`);
  }
  let map;
  try {
    map = JSON.parse(text);
  } catch (error) {
    throw new RobloxImportError(`${MAP_FILE} is not valid JSON (${error.message}). Write one object that maps asset ids to file names.`);
  }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new RobloxImportError(`${MAP_FILE} must be one object that maps asset ids to file names.`);
  return map;
}

/** Reads `<folder>/asset-map.json` and the files it names; returns the table for `options.assets`. Files stay inside the folder. */
export async function loadAssetFolder(folder) {
  const root = await realpath(resolve(folder));
  const map = await readMap(root);
  const entries = Object.entries(map);
  if (entries.length > MAX_ASSET_COUNT) throw new RobloxImportError(`${MAP_FILE} lists ${entries.length} assets, above the limit of ${MAX_ASSET_COUNT}. Split the scene or list only the assets it uses.`);
  const assets = {};
  for (const [reference, fileName] of entries.sort(([first], [second]) => first.localeCompare(second))) {
    const key = robloxAssetKey(reference);
    if (typeof fileName !== 'string' || fileName === '') throw new RobloxImportError(`${MAP_FILE} entry "${reference}" must name a file in the asset folder.`);
    let read;
    try {
      read = await readFileOnce(resolve(root, fileName), {
        maxBytes: MAX_ASSET_BYTES,
        tooLarge: `"${fileName}" is larger than ${MAX_ASSET_BYTES} bytes. Shrink the asset.`,
        notFile: `"${fileName}" is not a regular file. Map a file, not a folder.`,
        root,
        outside: `${MAP_FILE} entry "${reference}" names "${fileName}", outside the asset folder. Put the file inside the folder.`,
      });
    } catch (error) {
      if (error instanceof RobloxImportError) throw error;
      throw new RobloxImportError(`${MAP_FILE} entry "${reference}" names "${fileName}", which is not in the asset folder. Copy the file there or fix the name.`);
    }
    const { bytes, resolvedPath } = read;
    const extension = extname(resolvedPath).toLowerCase();
    const kind = extension === '.glb' ? 'glb' : IMAGE_EXTENSIONS.has(extension) ? 'image' : null;
    if (!kind) throw new RobloxImportError(`${MAP_FILE} entry "${reference}" names "${fileName}". Only .glb meshes and .png, .jpg, .jpeg or .webp images are read; convert the file first.`);
    assets[key] = { id: createHash('sha256').update(bytes).digest('hex'), kind, file: fileName };
    if (kind === 'glb') assets[key].bounds = glbBounds(bytes) ?? undefined;
  }
  return assets;
}

/** Reads an .rbxlx or .rbxmx file and imports it. Options as importRoblox, plus `assetFolder`. Returns the same result. */
export async function importRobloxFile(file, options = {}) {
  const { assetFolder, ...importOptions } = options;
  const path = resolve(file);
  const extension = extname(path).toLowerCase();
  if (extension === '.rbxl' || extension === '.rbxm') {
    throw new RobloxImportError(`${path} is a binary Roblox file. In Roblox Studio use File > Save As and choose ${extension}x (the XML format), then pass that file.`);
  }
  const { bytes: xmlBytes } = await readFileOnce(path, {
    maxBytes: Math.min(importOptions.maxBytes ?? MAX_XML_BYTES, MAX_XML_BYTES),
    tooLarge: `${path} is larger than the maxBytes limit. Raise maxBytes or export a smaller selection.`,
    notFile: `${path} is not a regular file. Pass an .rbxlx or .rbxmx file.`,
  });
  const assets = assetFolder === undefined ? {} : await loadAssetFolder(assetFolder);
  return importRoblox(xmlBytes.toString('utf8'), { ...importOptions, assets });
}
