import { readdir, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { readImageDimensions } from '../src/image-header.js';
import { MAXIMUM_TEXTURE_SET_FOLDERS, groupTextureSetFiles } from '../src/texture-set-names.js';
import { TEXTURE_MAP_FIELD_BY_ROLE } from '../src/texture-set-fields.js';

const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp)$/i;
const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/** The sub-folders of `root` to look in: real folders directly below it (no links), at most MAXIMUM_TEXTURE_SET_FOLDERS, by name. */
async function candidateFolders(root, skipped) {
  const folders = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (folders.length > MAXIMUM_TEXTURE_SET_FOLDERS) {
    skipped.push({ name: `${folders.length} folders`, reason: `only the first ${MAXIMUM_TEXTURE_SET_FOLDERS} folders of --assets are searched for texture sets; move the others out or into one of those` });
  }
  return folders.slice(0, MAXIMUM_TEXTURE_SET_FOLDERS);
}

async function realFolder(root, name) {
  const path = join(root, name);
  if (!(await lstat(path)).isDirectory()) return null;
  const resolved = await realpath(path);
  const offset = relative(root, resolved);
  return offset.startsWith(`..${sep}`) || offset === '..' || isAbsolute(offset) ? null : resolved;
}

async function readMaps(folderName, folder, groups, readCatalogFile, isSkippable, skipped) {
  const maps = {};
  const members = [];
  for (const [role, { filename, convention }] of Object.entries(groups)) {
    let result;
    try {
      result = await readCatalogFile(folder, filename);
    } catch (error) {
      if (!isSkippable(error)) throw error;
      skipped.push({ name: `${folderName}/${filename}`, reason: error.message });
      continue;
    }
    const { width, height } = readImageDimensions(result.bytes);
    const name = `${folderName}/${filename}`;
    maps[role] = { assetId: result.assetId, name, width, height, bytes: result.bytes.length, ...(convention ? { convention } : {}) };
    members.push({ directory: folder, filename, metadata: Object.freeze({ assetId: result.assetId, name, bytes: result.bytes.length, kind: 'image', mimeType: IMAGE_MIME[result.imageFormat] }) });
  }
  return { maps, members };
}

/**
 * The texture sets below `root`: each sub-folder whose image files carry at least two standard map names (see
 * groupTextureSetFiles). Returns `{ name, metadata, members }` per set: the catalog record (`kind: "textureSet"`, the maps found with
 * their asset IDs and sizes) and the image entries the catalog can read by ID. A folder that is not a set is left alone; one with two
 * files for the same map, or a map file the catalog refuses, is reported in `skipped`.
 */
export async function scanTextureSets(root, { readCatalogFile, isSkippable, skipped }) {
  const sets = [];
  for (const folderName of await candidateFolders(root, skipped)) {
    const folder = await realFolder(root, folderName);
    if (!folder) continue;
    const imageNames = (await readdir(folder, { withFileTypes: true })).filter(entry => entry.isFile() && IMAGE_FILE_PATTERN.test(entry.name)).map(entry => entry.name);
    const { maps: groups, problem } = groupTextureSetFiles(imageNames);
    if (problem) skipped.push({ name: folderName, reason: `texture set folder ${problem}` });
    if (!groups) continue;
    const { maps, members } = await readMaps(folderName, folder, groups, readCatalogFile, isSkippable, skipped);
    if (Object.keys(maps).length < 2) continue;
    sets.push({ name: folderName, members, metadata: Object.freeze({ kind: 'textureSet', name: folderName, maps }) });
  }
  return sets;
}

/** The recipe material fields a set fills: `{ colorMap, normalMap, ... }` with asset IDs, plus normalConvention when the normal map is DirectX. */
export function textureSetFields(metadata) {
  const fields = {};
  for (const [role, map] of Object.entries(metadata.maps)) {
    fields[TEXTURE_MAP_FIELD_BY_ROLE[role]] = map.assetId;
    if (role === 'normal' && map.convention === 'directx') fields.normalConvention = 'directx';
  }
  return fields;
}
