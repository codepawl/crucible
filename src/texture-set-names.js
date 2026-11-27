// Texture sets: a folder of scanned PBR maps (Poly Haven, ambientCG) that one recipe material uses. The file name rules of the
// catalog scan and the capability text agents read; the scene core imports only texture-set-fields.js.

export const MAXIMUM_TEXTURE_SET_FOLDERS = 64;

const ROLE_WORDS = Object.freeze({
  color: ['color', 'colour', 'albedo', 'diffuse', 'diff', 'col'],
  normal: ['normal', 'nor', 'nrm', 'norm'],
  roughness: ['roughness', 'rough'],
  metallic: ['metallic', 'metalness', 'metal'],
  occlusion: ['ao', 'occlusion'],
  height: ['height', 'displacement', 'disp'],
});
const OPENGL_WORDS = ['gl', 'opengl'];
const DIRECTX_WORDS = ['dx', 'directx'];

function filenameWords(filename) {
  const stem = filename.replace(/\.[^.]+$/, '');
  return stem.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * The role a standard map file name carries, or null: `rock_diff_1k.png`, `Rock030_1K-PNG_NormalGL.png` and `bark_ao.jpg` all
 * qualify. For a normal map, `convention` is "directx" for a dx name and "opengl" otherwise. The last matching word wins, so a
 * prefix such as "metal_plate" does not hide the role at the end of the name.
 */
export function classifyTextureMapName(filename) {
  const words = filenameWords(filename);
  for (let index = words.length - 1; index >= 0; index--) {
    const role = Object.keys(ROLE_WORDS).find(candidate => ROLE_WORDS[candidate].includes(words[index]));
    if (!role) continue;
    if (role !== 'normal') return { role };
    return { role, convention: words.some(word => DIRECTX_WORDS.includes(word)) && !words.some(word => OPENGL_WORDS.includes(word)) ? 'directx' : 'opengl' };
  }
  return null;
}

/**
 * Groups the image file names of one folder by map role. `maps` holds `{ filename, convention? }` by role; a folder with fewer than
 * two roles is not a set (`maps` is null). When both an OpenGL and a DirectX normal map exist the OpenGL one is used. Two files
 * for the same role make the folder ambiguous: `problem` says which, and `maps` is null.
 */
export function groupTextureSetFiles(filenames) {
  const maps = {};
  const candidates = {};
  for (const filename of [...filenames].sort()) {
    const classified = classifyTextureMapName(filename);
    if (!classified) continue;
    (candidates[classified.role] ??= []).push({ filename, convention: classified.convention });
  }
  for (const [role, files] of Object.entries(candidates)) {
    const preferred = role === 'normal' && files.some(file => file.convention === 'opengl') ? files.filter(file => file.convention === 'opengl') : files;
    if (preferred.length > 1) {
      return { maps: null, problem: `has ${preferred.length} files for the ${role} map (${preferred.map(file => file.filename).join(', ')}); keep one per map so the set is unambiguous` };
    }
    maps[role] = role === 'normal' ? { filename: preferred[0].filename, convention: preferred[0].convention } : { filename: preferred[0].filename };
  }
  return { maps: Object.keys(maps).length >= 2 ? maps : null, problem: null };
}

export const TEXTURE_SET_CAPABILITIES = Object.freeze({
  fields: 'material.textureSet = "<set name from scene_asset_catalog textureSets>" fills colorMap, normalMap, roughnessMap, metallicMap, occlusionMap and heightMap; each field also takes one catalog image asset ID (64 hex) and wins over the set. normalConvention "opengl" (default) or "directx": a DirectX normal map has its green channel flipped on load. uvScale (one number or [u, v], 0.001 to 10000 tiles), uvOffset ([u, v], -10000 to 10000), uvRotation (degrees, -360 to 360) and worldScale (metres per tile, 0.001 to 100000, not with uvScale) move every map together like glTF KHR_texture_transform, baked into the mesh UVs at its rest size.',
  catalog: 'a sub-folder of --assets whose image files carry standard map names (color/albedo/diffuse/diff, normal or nor_gl/nor_dx/NormalGL/NormalDX, roughness/rough, metallic/metal, ao/occlusion, height/displacement/disp) with at least two maps is listed as kind "textureSet" with the maps it found and their sizes. Its images are not listed one by one.',
  channels: 'a grey roughness image becomes the green channel and a grey metallic image the blue channel of one glTF metallicRoughness texture (red 255); a missing one is 255, so the roughness and metallic factors still scale it. roughness and metallic default to 1 when their map is set. All maps of one material that are repacked must share one size.',
  limits: 'surface tag, not combined with pattern, map or a colour from a pattern; needs UVs (grid, box and similar). heightMap with heightScale > 0 draws parallax relief in the rasterizer and geometric displacement in path tracers. occlusionMap is drawn by the rasterizer; the cpu and webgpu path tracers draw it on indirect light and the other tracers ignore it. Images are PNG, JPEG or WebP, at most 2048 px a side.',
});
