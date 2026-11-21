import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gamePhysicsProblem, hasTexturedMaterial, parentTranslation } from '../src/game-needs.js';
import { gameImageIds } from '../src/game-assets.js';

// Writes a playable game as one folder that any static host can serve: index.html, game.json (the recipe with its game
// section) and engine/ (the built Crucible modules that index.html imports, found by following the import statements from
// build/game.js). There is no server code. The folder is bounded, so an export never fills the disk.

export const WEB_EXPORT_LIMITS = Object.freeze({ maxEngineBytes: 12 * 1024 * 1024, maxEngineFiles: 400, maxTitleLength: 64, maxRecipeBytes: 1024 * 1024, maxAssetBytes: 64 * 1024 * 1024, maxPhysicsBytes: 8 * 1024 * 1024 });

/** The file extension of a catalog image, from its first bytes. The page decodes by content, so an unknown kind only loses its extension. */
function imageExtension(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x52 && bytes[8] === 0x57) return 'webp';
  return 'bin';
}
const ASSET_ID = /^[a-f0-9]{64}$/;

// The physics engine ships beside the page: Jolt's loader fetches the .wasm file that sits next to it by a relative URL.
const PHYSICS_DIRECTORY = 'engine/physics';
const PHYSICS_LOADER = 'jolt-physics.wasm.js';
const PHYSICS_WASM = 'jolt-physics.wasm.wasm';
// The chunk that loads the physics engine; an export without physics leaves it and what only it needs out.
const PHYSICS_ENTRY_CHUNK = /^game-physics(?:-|[.])/;
// The texture swap addon, loaded for a recipe with a pattern or a map.
const TEXTURED_ENTRY_CHUNK = /^replace-textured-parts(?:-|[.])/;

const ENTRY_MODULE = 'game.js';
const IMPORT_PATTERN = /(?:from\s*|import\s*\(\s*|import\s*)["'](\.\/[A-Za-z0-9_.-]+\.js)["']/g;

/** Every module file build/game.js needs, including the ones it loads on demand, as names relative to the build folder. */
export async function engineModuleNames(buildDirectory, { physics = false, textured = false } = {}) {
  const found = new Set();
  const pending = [ENTRY_MODULE];
  while (pending.length) {
    const name = pending.pop();
    if (found.has(name) || (!physics && PHYSICS_ENTRY_CHUNK.test(name)) || (!textured && TEXTURED_ENTRY_CHUNK.test(name))) continue;
    let source;
    try {
      source = await readFile(join(buildDirectory, name), 'utf8');
    } catch {
      // A match inside an error message is not an import; only the entry module must exist.
      if (name !== ENTRY_MODULE) continue;
      throw new Error(`The web export needs the built engine, and ${name} is missing from ${buildDirectory}. Run npm run build:lib, or install the published package.`);
    }
    found.add(name);
    if (found.size > WEB_EXPORT_LIMITS.maxEngineFiles) throw new RangeError(`The engine has more than ${WEB_EXPORT_LIMITS.maxEngineFiles} modules, which is not expected. Rebuild the package.`);
    for (const match of source.matchAll(IMPORT_PATTERN)) pending.push(match[1].slice(2));
  }
  return [...found].sort();
}

// The Jolt loader and its wasm file from the optional jolt-physics package, which must be installed to export a game with physics.
async function joltFiles() {
  let loaderPath;
  try {
    loaderPath = createRequire(import.meta.url).resolve('jolt-physics/wasm');
  } catch {
    throw new Error('A game with physics needs the "jolt-physics" package to bundle its engine. Install it with `npm install jolt-physics`, or set game.physics to false with set-game.');
  }
  const wasmPath = join(dirname(loaderPath), PHYSICS_WASM);
  return Promise.all([[PHYSICS_LOADER, loaderPath], [PHYSICS_WASM, wasmPath]].map(async ([name, path]) => ({ name, path, bytes: (await stat(path)).size })));
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

function pageTitle(title) {
  const clean = String(title ?? 'Game').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, WEB_EXPORT_LIMITS.maxTitleLength);
  return escapeHtml(clean || 'Game');
}

/** The page. `?replay=name.json` plays a recording from the same folder instead of the keyboard, for tests and demos. */
export function indexHtml(title, assetUrls = {}, physicsUrl = undefined, imageUrls = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${pageTitle(title)}</title>
<style>html,body{margin:0;height:100%;background:#101014;overflow:hidden}canvas{display:block;width:100%;height:100%;touch-action:none}</style>
</head>
<body>
<canvas id="game"></canvas>
<script>
// A page that stops on an error says so on screen, so a stalled game is never silent.
function showFailure(reason) {
  const failure = document.getElementById('failure') ?? document.body.appendChild(Object.assign(document.createElement('pre'), { id: 'failure', role: 'alert' }));
  failure.style.cssText = 'position:fixed;inset:auto 0 0 0;margin:0;padding:12px;max-height:50%;overflow:auto;background:#3a0d0d;color:#ffd9d9;font:13px/1.4 monospace;white-space:pre-wrap';
  failure.textContent = reason?.message ?? String(reason);
}
addEventListener('error', event => showFailure(event.error ?? event.message));
addEventListener('unhandledrejection', event => showFailure(event.reason));
</script>
<script type="module">
import { startGame } from './engine/${ENTRY_MODULE}';
const canvas = document.getElementById('game');
const recipe = await (await fetch('./game.json')).json();
const replayName = new URLSearchParams(location.search).get('replay');
const replay = /^[\\w.-]+\\.json$/.test(replayName ?? '') ? await (await fetch('./' + replayName)).json() : undefined;
const assetUrls = ${JSON.stringify(assetUrls)};
${Object.keys(imageUrls).length ? `const imageUrls = ${JSON.stringify(imageUrls)};\n` : ''}${physicsUrl ? `const physicsUrl = ${JSON.stringify(physicsUrl)};\n` : ''}const touchControls = matchMedia('(pointer: coarse)').matches;
window.__game = await startGame(canvas, recipe, { replay, touchControls, assetUrls${Object.keys(imageUrls).length ? ', imageUrls' : ''}${physicsUrl ? ', physicsUrl' : ''} });
</script>
</body>
</html>
`;
}

/**
 * Write the web build of a recipe into `outputDirectory` (created, must not hold a build already) and return its summary.
 * `buildDirectory` is the package's build/ folder.
 */
export async function writeWebBuild({ recipe, buildDirectory, outputDirectory, title, assets = new Map(), images = new Map() }) {
  if (!recipe?.game) throw new Error('This scene has no game. Add one with scene_apply set-game (fields: scene_capabilities topic game), then export again.');
  // A node can be given a rotated parent after set-game ran, and the page would throw where no agent reads it.
  const nodes = recipe.nodes ?? [];
  parentTranslation(nodes, recipe.game.player?.node, 'game.player.node');
  for (const npc of recipe.game.npcs ?? []) parentTranslation(nodes, npc.node, 'game.npcs[].node');
  const withPhysics = recipe.game.physics === true;
  const physicsProblem = withPhysics ? gamePhysicsProblem(recipe) : null;
  if (physicsProblem) throw new Error(physicsProblem);
  if (recipe.nodes?.some(node => node.vegetation)) throw new Error('The web export does not carry grown vegetation yet. Remove it, or build the plants from geometry.');
  const missing = (recipe.nodes ?? []).filter(node => node.asset && !assets.has(node.asset.id)).map(node => node.id);
  if (missing.length) throw new Error(`The web export needs the bytes of the catalog assets placed by ${missing.join(', ')}. Pass them as assets (asset id to Buffer).`);
  const missingImages = gameImageIds(recipe).filter(id => !images.has(id));
  if (missingImages.length) throw new Error(`The web export needs the bytes of the catalog images the materials read (${missingImages.map(id => id.slice(0, 12)).join(', ')}). Pass them as images (image id to Buffer).`);
  if (recipe.format !== 'crucible.scene') throw new Error('The web export needs a crucible.scene recipe. Create the scene with scene_create.');
  const recipeText = JSON.stringify(recipe);
  if (Buffer.byteLength(recipeText) > WEB_EXPORT_LIMITS.maxRecipeBytes) throw new RangeError(`The recipe is larger than ${WEB_EXPORT_LIMITS.maxRecipeBytes} bytes. Simplify the scene.`);

  const names = await engineModuleNames(buildDirectory, { physics: withPhysics, textured: hasTexturedMaterial(recipe) });
  let engineBytes = 0;
  for (const name of names) engineBytes += (await stat(join(buildDirectory, name))).size;
  if (engineBytes > WEB_EXPORT_LIMITS.maxEngineBytes) throw new RangeError(`The engine is ${engineBytes} bytes, above the ${WEB_EXPORT_LIMITS.maxEngineBytes} byte limit. Rebuild the package.`);
  const physicsFiles = withPhysics ? await joltFiles() : [];
  const physicsBytes = physicsFiles.reduce((total, file) => total + file.bytes, 0);
  if (physicsBytes > WEB_EXPORT_LIMITS.maxPhysicsBytes) throw new RangeError(`The physics engine is ${physicsBytes} bytes, above the ${WEB_EXPORT_LIMITS.maxPhysicsBytes} byte limit.`);

  await mkdir(join(outputDirectory, 'engine'), { recursive: true });
  for (const name of names) await copyFile(join(buildDirectory, name), join(outputDirectory, 'engine', name));
  if (withPhysics) await mkdir(join(outputDirectory, PHYSICS_DIRECTORY), { recursive: true });
  for (const file of physicsFiles) await copyFile(file.path, join(outputDirectory, PHYSICS_DIRECTORY, file.name));
  await writeFile(join(outputDirectory, 'game.json'), recipeText);
  const assetUrls = {};
  let assetBytes = 0;
  if (assets.size) await mkdir(join(outputDirectory, 'assets'), { recursive: true });
  for (const [id, bytes] of assets) {
    if (!ASSET_ID.test(id)) throw new RangeError(`Asset id ${JSON.stringify(id)} is not a catalog id of 64 hexadecimal characters.`);
    assetBytes += bytes.byteLength;
    if (assetBytes > WEB_EXPORT_LIMITS.maxAssetBytes) throw new RangeError(`The placed assets are over ${WEB_EXPORT_LIMITS.maxAssetBytes} bytes together. Use fewer or smaller assets.`);
    await writeFile(join(outputDirectory, 'assets', `${id}.glb`), bytes);
    assetUrls[id] = `./assets/${id}.glb`;
  }
  const imageUrls = {};
  if (images.size) await mkdir(join(outputDirectory, 'assets'), { recursive: true });
  for (const [id, bytes] of images) {
    if (!ASSET_ID.test(id)) throw new RangeError(`Image id ${JSON.stringify(id)} is not a catalog id of 64 hexadecimal characters.`);
    assetBytes += bytes.byteLength;
    if (assetBytes > WEB_EXPORT_LIMITS.maxAssetBytes) throw new RangeError(`The placed assets and images are over ${WEB_EXPORT_LIMITS.maxAssetBytes} bytes together. Use fewer or smaller assets and images.`);
    const fileName = `${id}.${imageExtension(bytes)}`;
    await writeFile(join(outputDirectory, 'assets', fileName), bytes);
    imageUrls[id] = `./assets/${fileName}`;
  }
  const html = indexHtml(title, assetUrls, withPhysics ? `./${PHYSICS_DIRECTORY}/${PHYSICS_LOADER}` : undefined, imageUrls);
  await writeFile(join(outputDirectory, 'index.html'), html);
  const totalBytes = engineBytes + physicsBytes + assetBytes + Buffer.byteLength(recipeText) + Buffer.byteLength(html);
  return { directory: dirname(join(outputDirectory, 'index.html')), files: names.length + physicsFiles.length + 2 + assets.size + images.size, engineModules: names.length, bytes: totalBytes };
}
