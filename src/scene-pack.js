// Compiles a recipe (format crucible.scene) in Node into a runtime-only web bundle (docs/pack.md).
// The compiler stays here; the page loads src/crucible-scene.js, which reads the result without any agent-scene code.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createAgentScene, loadAllAgentSceneModules } from './agent-scene.js';
import { graphImageAssets } from './material-graph.js';
import { fitAgentShadow, resolveAgentShadow } from './agent-look.js';
import { agentSceneModulesNeeded } from './agent-scene-modules.js';
import { parseRadianceHdr } from './hdri.js';
import { BUNDLED_ENVIRONMENT_NAMES, catalogEnvironmentSource, registerCatalogEnvironment } from './look-catalog.js';
import { encodePack } from './scene-pack-format.js';
import { PACK_MAX_IMAGE_TEXELS, checkImageBudget, countImageTexels } from './scene-pack-limits.js';
import { PACK_PATTERN_RESOLUTIONS, packedMaterial, recipeWithPatternResolution } from './scene-pack-patterns.js';
import { packedSkyOf } from './scene-pack-sky.js';
import { PACK_SHADER_MODULES, PACK_UNSUPPORTED_MODULES } from './scene-pack-shaders.js';

export const PACK_FILE_NAME = 'scene.pack';
export const PACK_RUNTIME_FILE_NAME = 'crucible-scene.js';
export const PACK_POSTER_EXTENSIONS = Object.freeze(['.webp', '.png', '.jpg', '.jpeg']);
export { PACK_MAX_IMAGE_TEXELS };
const RECIPE_FORMAT = 'crucible.scene';
const BUNDLED_SKY_FOLDER = new URL('../assets/looks/', import.meta.url);
// The material fields that name an image of the asset catalog.
const MATERIAL_IMAGE_FIELDS = Object.freeze(['colorMap', 'normalMap', 'roughnessMap', 'metallicMap', 'occlusionMap', 'heightMap']);
// Lightmap texels one pack may carry: 262,144 is 1 MB of raw RGBA bytes. A recipe build may trace up to 1,000,000 texels,
// but a page downloads every texel, so a pack holds a quarter of that.
export const PACK_MAX_LIGHTMAP_TEXELS = 262_144;
// The bake writes bounced light into the emissive slot (parts with their own emission use the light map slot) and sky visibility into the occlusion slot.
const LIGHTMAP_SLOTS = Object.freeze(['emissiveMap', 'lightMap', 'occlusionMap']);
// Sections of a recipe that move or simulate. Slice 1 of #2178 packs the scene at time zero only.
const UNSUPPORTED_SECTIONS = Object.freeze(['motion', 'timeline', 'physics', 'cloth', 'particles', 'game', 'postPasses', 'armatures']);

function refuse(message) {
  throw new TypeError(message);
}

/** The checks that need no compile: they name the recipe field and what to pass instead. */
export function validatePackRecipe(recipe) {
  if (recipe === null || typeof recipe !== 'object' || Array.isArray(recipe)) {
    refuse('recipe: got something that is not an object; pass a scene.json written for format crucible.scene.');
  }
  if (recipe.format !== RECIPE_FORMAT) {
    refuse(`recipe.format: got ${JSON.stringify(recipe.format)}; expected "${RECIPE_FORMAT}". Pass a scene recipe, not a glTF or a pack.`);
  }
  for (const section of UNSUPPORTED_SECTIONS) {
    if (recipe[section] !== undefined) {
      refuse(`recipe.${section}: crucible pack writes a still scene for now; remove "${section}" from the recipe (animated packs are planned in #2178).`);
    }
  }
  const needed = agentSceneModulesNeeded(recipe);
  for (const name of needed) {
    if (Object.hasOwn(PACK_UNSUPPORTED_MODULES, name)) {
      refuse(`recipe: it uses ${PACK_UNSUPPORTED_MODULES[name]}, which crucible pack does not carry yet; remove it from the recipe (planned in #2178).`);
    }
  }
  const environment = recipe.environment ?? {};
  if (environment.sky) {
    refuse('recipe.environment.sky: crucible pack lights a scene with a lighting setup or an HDRI sky image for now; remove "sky" and set environment.setup (daylight, studio and the other names scene_capabilities lists) or environment.hdri.');
  }
}

/** The texels of every baked light texture on the parts. */
export function countLightmapTexels(parts) {
  let texels = 0;
  for (const part of parts) {
    for (const slot of LIGHTMAP_SLOTS) {
      const image = part.material?.[slot]?.image;
      if (image) texels += image.width * image.height;
    }
  }
  return texels;
}

function checkLightmapBudget(recipe, parts, maxLightmapTexels) {
  const texels = countLightmapTexels(parts);
  if (texels <= maxLightmapTexels) return;
  const density = recipe.bake?.texelsPerUnit ?? recipe.bake?.preset ?? 'standard';
  refuse(`recipe.bake.texelsPerUnit: the bake wrote ${texels} lightmap texels, over the ${maxLightmapTexels} one pack carries (the page downloads every texel). Lower bake.texelsPerUnit (now ${density}; 1 to 12), set bake.preset to "draft", or bake fewer and smaller parts.`);
}

function isSkyRegistered(reference) {
  try {
    catalogEnvironmentSource(reference);
    return true;
  } catch {
    return false;
  }
}

// The command line has no asset catalog: a bundled sky name is read from assets/looks, a catalog file ID is refused by name.
function registerBundledSky(recipe) {
  const reference = recipe.environment?.hdri;
  if (typeof reference !== 'string' || isSkyRegistered(reference)) return;
  if (!BUNDLED_ENVIRONMENT_NAMES.includes(reference)) {
    refuse(`recipe.environment.hdri: crucible pack reads only the bundled skies (${BUNDLED_ENVIRONMENT_NAMES.join(', ')}); the catalog file ${reference.slice(0, 16)} is not available to the command line. Use a bundled name, or export the web pack from Studio, which has the catalog.`);
  }
  registerCatalogEnvironment(reference, parseRadianceHdr(readFileSync(new URL(`${reference}.hdr`, BUNDLED_SKY_FOLDER))));
}

function requireCatalogImages(recipe, catalogImages) {
  if (catalogImages) return;
  for (const material of recipe.materials ?? []) {
    const field = MATERIAL_IMAGE_FIELDS.find(name => material[name] !== undefined);
    if (field) {
      refuse(`recipe.materials["${material.id}"].${field}: crucible pack cannot read the asset catalog that holds this image. Export the web pack from Studio, which has the catalog, or remove the ${field}.`);
    }
    if (material.pattern?.graph && graphImageAssets(material.pattern.graph).length > 0) {
      refuse(`recipe.materials["${material.id}"].pattern.graph: an image node reads the asset catalog, which crucible pack cannot read here. Export the web pack from Studio, which has the catalog, or remove the image node.`);
    }
  }
}

// A pattern bakes at its recipe resolution up to 512; when the textures then pass the pack budget the patterns are baked at
// 256 before the budget check refuses the recipe.
function buildSceneWithinImageBudget(recipe, catalogImages, maxImageTexels) {
  const options = catalogImages ? { sequenceFrames: catalogImages } : undefined;
  let scene = null;
  for (const resolution of PACK_PATTERN_RESOLUTIONS) {
    scene = createAgentScene(recipeWithPatternResolution(recipe, resolution), {}, options);
    if (countImageTexels(scene.parts).texels <= maxImageTexels) break;
  }
  return scene;
}

/**
 * Compiles a recipe to the bytes of a `.pack` file: its parts, camera, lighting and effects, ready for the runtime.
 * A recipe `bake` runs here, in Node, and its lightmaps travel in the pack as bytes: the page never traces.
 * `catalogImages` is a Map of catalog image IDs to decoded { width, height, data }, for a host that has an asset catalog.
 */
export async function compileRecipeToPack(recipe, { maxLightmapTexels = PACK_MAX_LIGHTMAP_TEXELS, maxImageTexels = PACK_MAX_IMAGE_TEXELS, catalogImages = null } = {}) {
  validatePackRecipe(recipe);
  requireCatalogImages(recipe, catalogImages);
  registerBundledSky(recipe);
  await loadAllAgentSceneModules();
  const scene = buildSceneWithinImageBudget(recipe, catalogImages, maxImageTexels);
  const environment = scene.environment;
  if (recipe.bake) checkLightmapBudget(recipe, scene.parts, maxLightmapTexels);
  checkImageBudget(scene.parts, maxImageTexels);
  return encodePack({
    shaderModules: agentSceneModulesNeeded(recipe).filter(name => Object.hasOwn(PACK_SHADER_MODULES, name)),
    camera: scene.camera,
    environment,
    environmentMap: packedSkyOf(environment),
    effects: scene.effects,
    shadowBounds: resolveAgentShadow(fitAgentShadow(scene.shadow, scene.parts), environment.lightDirection),
    parts: scene.parts.map(part => ({ name: part.name, geometry: part.geometry, material: packedMaterial(part.material), matrix: part.matrix })),
  });
}

export function indexHtml({ title, posterName }) {
  const posterAttribute = posterName ? ` poster="./${posterName}"` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>html,body{margin:0;height:100%;background:#111}crucible-scene{display:block;width:100%;height:100%}</style>
<script type="module" src="./${PACK_RUNTIME_FILE_NAME}"></script>
</head>
<body>
<crucible-scene src="./${PACK_FILE_NAME}"${posterAttribute}></crucible-scene>
</body>
</html>
`;
}

function requireFile(path, flag, what) {
  if (!path) refuse(`${flag}: pass the path of ${what}.`);
  if (!existsSync(path) || !statSync(path).isFile()) refuse(`${flag}: ${path} is not a file; pass the path of ${what}.`);
}

// A `from "./x.js"`, a bare `import "./x.js"` at the start of a statement or an `import("./x.js")`. An error message that
// only mentions an import ("add import './x.js'") does not count.
const RELATIVE_IMPORT = /(?:\bfrom\s*|(?:^|[;}\n])\s*import\s*|\bimport\s*\(\s*)["'](\.\/[^"']+\.js)["']/g;

// Pages that import the runtime also need the chunks it imports, so the whole relative import tree is copied beside it.
function runtimeFilesOf(entryPath) {
  const found = new Set();
  const pending = [entryPath];
  while (pending.length > 0) {
    const path = pending.pop();
    if (found.has(path)) continue;
    found.add(path);
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      pending.push(join(dirname(path), match[1]));
    }
  }
  return [...found];
}

/** The built runtime of this package, build/crucible-scene.js, or the file `--runtime` names. */
export function findRuntimeEntry(runtimePath, packageRoot) {
  if (runtimePath) {
    requireFile(runtimePath, '--runtime', 'a built crucible-scene.js');
    return resolve(runtimePath);
  }
  const built = join(packageRoot, 'build', PACK_RUNTIME_FILE_NAME);
  if (!existsSync(built)) refuse(`--runtime: ${built} does not exist; run npm run build, or pass --runtime <path to a built crucible-scene.js>.`);
  return built;
}

function readRecipe(recipePath) {
  requireFile(recipePath, '<scene.json>', 'the recipe to pack, such as scene.json');
  try {
    return JSON.parse(readFileSync(recipePath, 'utf8'));
  } catch (error) {
    return refuse(`<scene.json>: ${recipePath} is not valid JSON (${error.message}); pass a recipe file.`);
  }
}

function checkPosterFile(posterPath) {
  requireFile(posterPath, '--poster', 'a WebP, PNG or JPEG picture of the scene');
  if (!PACK_POSTER_EXTENSIONS.includes(extname(posterPath).toLowerCase())) {
    refuse(`--poster: ${posterPath} is not ${PACK_POSTER_EXTENSIONS.join(', ')}; pass a WebP, PNG or JPEG picture.`);
  }
}

/** Reads scene.json, writes <outDir>/scene.pack, the runtime, an optional poster and index.html. Returns what it wrote. */
export async function packRecipeFile({ recipePath, outDir, posterPath, runtimePath, packageRoot }) {
  const recipe = readRecipe(recipePath);
  if (!outDir) refuse('--out: pass the folder to write the web bundle into, such as --out dist/scene.');
  if (posterPath) checkPosterFile(posterPath);
  const runtimeEntry = findRuntimeEntry(runtimePath, packageRoot);
  const packBytes = await compileRecipeToPack(recipe);
  mkdirSync(outDir, { recursive: true });
  const files = [];
  writeFileSync(join(outDir, PACK_FILE_NAME), packBytes);
  files.push(PACK_FILE_NAME);
  for (const file of runtimeFilesOf(runtimeEntry)) {
    // The entry is always written as crucible-scene.js; its chunks keep their own names.
    const name = file === runtimeEntry ? PACK_RUNTIME_FILE_NAME : basename(file);
    copyFileSync(file, join(outDir, name));
    files.push(name);
  }
  const posterName = posterPath ? `poster${extname(posterPath).toLowerCase()}` : null;
  if (posterName) {
    copyFileSync(posterPath, join(outDir, posterName));
    files.push(posterName);
  }
  writeFileSync(join(outDir, 'index.html'), indexHtml({ title: basename(recipePath, extname(recipePath)), posterName }));
  files.push('index.html');
  return { outDir, files, packBytes: packBytes.length };
}
