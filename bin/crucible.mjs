#!/usr/bin/env node
// The crucible command line: `crucible agent` (docs/cli-agent.md), `crucible auth`, `crucible pack` (docs/pack.md), and `crucible packs` (docs/packs.md).
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_USAGE = `Usage: crucible agent "<prompt>" [--scene <in.json>] [--out <out.json>] [--model <name>] [--max-turns <1..60>] [--backend cpu|gpu] [--jobs <dir>] [--json] [--quiet]
       crucible auth login [--no-browser] | status [--json] | logout
       crucible pack <scene.json> --out <dir> [--poster <picture.webp> | --no-poster] [--poster-size <w>x<h>] [--runtime <crucible-scene.js>]
       crucible packs add|list|remove [<name>]`;
const PROMO_TIP = 'Tip: Run `crucible auth login` for 250 free credits, no card needed, to use `crucible agent`, or connect your own agent free via `crucible-mcp`.';
const PACK_FLAGS = Object.freeze(['--out', '--poster', '--poster-size', '--runtime']);
const PACK_SWITCHES = Object.freeze(['--no-poster']);

export function usageText({ noPromo = process.env.CRUCIBLE_NO_PROMO === '1' } = {}) {
  return noPromo ? BASE_USAGE : `${BASE_USAGE}\n${PROMO_TIP}`;
}

export function parsePackArguments(argumentList) {
  const options = { recipePath: null };
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (PACK_SWITCHES.includes(argument)) {
      options.noPoster = true;
    } else if (PACK_FLAGS.includes(argument)) {
      const value = argumentList[index + 1];
      if (value === undefined || value.startsWith('--')) throw new TypeError(`${argument}: pass a value, such as ${argument} <path>.`);
      options[flagKey(argument)] = value;
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new TypeError(`${argument}: unknown option; crucible pack takes ${[...PACK_FLAGS, ...PACK_SWITCHES].join(', ')}.`);
    } else if (options.recipePath === null) {
      options.recipePath = argument;
    } else {
      throw new TypeError(`${argument}: only one scene.json can be packed at a time; pass the others in separate runs.`);
    }
  }
  checkPosterOptions(options);
  return options;
}

// --poster-size becomes options.posterSize.
function flagKey(flag) {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function checkPosterOptions(options) {
  if (options.poster && options.noPoster) throw new TypeError('--poster and --no-poster: pass one; --poster uses your picture, --no-poster packs without one.');
  if (options.posterSize && (options.poster || options.noPoster)) {
    throw new TypeError('--poster-size: it sizes the poster that pack renders; drop it when you pass --poster or --no-poster.');
  }
}

// A published package carries build/scene-pack.js; a source checkout runs src/scene-pack.js directly.
async function loadPackModule() {
  const built = join(packageRoot, 'build', 'scene-pack.js');
  return import(pathToFileURL(existsSync(built) ? built : join(packageRoot, 'src', 'scene-pack.js')).href);
}

async function loadPosterModule() {
  const built = join(packageRoot, 'build', 'scene-pack-poster.js');
  return import(pathToFileURL(existsSync(built) ? built : join(packageRoot, 'src', 'scene-pack-poster.js')).href);
}

async function main(argumentList) {
  const [command, ...rest] = argumentList;
  if (command === '--help' || command === '-h') {
    console.log(usageText());
    return 0;
  }
  if (command === 'agent') {
    const { runAgentCommand } = await import('./crucible-agent.mjs');
    return runAgentCommand(rest);
  }
  if (command === 'auth') {
    const { runAuthCommand } = await import('./crucible-auth.mjs');
    return runAuthCommand(rest);
  }
  if (command === 'packs') {
    const { runPacksCommand } = await import('./crucible-packs.mjs');
    return runPacksCommand(rest);
  }
  if (command !== 'pack') {
    const usage = usageText();
    console.error(command === undefined ? usage : `${command}: unknown command; the commands are agent, auth, pack, and packs.\n${usage}`);
    return 1;
  }
  try {
    const options = parsePackArguments(rest);
    const posterModule = options.poster || options.noPoster ? null : await loadPosterModule();
    // The size is read before packing, so a bad --poster-size fails before any work.
    const posterSize = options.posterSize ? posterModule?.parsePosterSize(options.posterSize) : undefined;
    const { packRecipeFile } = await loadPackModule();
    const result = await packRecipeFile({
      recipePath: options.recipePath,
      outDir: options.out,
      posterPath: options.poster,
      runtimePath: options.runtime,
      packageRoot,
    });
    if (posterModule) {
      const title = basename(options.recipePath, extname(options.recipePath));
      result.files.push(await posterModule.addGeneratedPoster({ outDir: result.outDir, title, size: posterSize }));
    }
    console.log(`Packed ${result.packBytes} bytes into ${result.outDir}: ${result.files.join(', ')}`);
    return 0;
  } catch (error) {
    console.error(`crucible pack: ${error.message}\n${usageText()}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
