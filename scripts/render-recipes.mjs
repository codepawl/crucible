// Renders the pictures and clips of the site's recipe pages (public/recipes/*.json, listed in scripts/recipe-catalog.mjs) through the
// MCP render job tools, from the same recipe files the pages show.
// Usage: node scripts/render-recipes.mjs <output directory> [--size <width>x<height>] [--no-clip] [slug ...]
// Writes <slug>-<frame id>.png for each frame and, for a recipe with a clip, <slug>.mp4. The default size is 1280x720; run it through gpu-lock.
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { RECIPES, recipeForFrame } from './recipe-catalog.mjs';

const serverEntry = new URL('../bin/crucible-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

function parseArguments(argumentList) {
  const options = { directory: null, width: 1280, height: 720, clip: true, slugs: [] };
  for (let index = 0; index < argumentList.length; index++) {
    const argument = argumentList[index];
    if (argument === '--size') {
      const match = /^(\d+)x(\d+)$/.exec(argumentList[++index] ?? '');
      if (!match) throw new Error('Pass --size as <width>x<height>, for example --size 1920x1080.');
      options.width = Number(match[1]);
      options.height = Number(match[2]);
    } else if (argument === '--no-clip') options.clip = false;
    else if (!options.directory) options.directory = resolve(argument);
    else options.slugs.push(argument);
  }
  if (!options.directory) throw new Error('Pass the output directory: node scripts/render-recipes.mjs <directory> [slug ...]');
  const known = RECIPES.map(recipe => recipe.slug);
  for (const slug of options.slugs) if (!known.includes(slug)) throw new Error(`Unknown recipe "${slug}". Pass one of: ${known.join(', ')}.`);
  return options;
}

async function renderJob(call, sessionId, settings) {
  const submitted = await call('scene_render_submit', { sessionId, expectedRevision: 0, settings });
  if (submitted.isError) throw new Error(submitted.content?.[0]?.text);
  const { jobId } = submitted.structuredContent;
  for (;;) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (record.state === 'completed') break;
    if (['cancelled', 'failed'].includes(record.state)) throw new Error(`Render job ${record.state}: ${record.reason}`);
    await delay(250);
  }
  const result = (await call('scene_render_result', { jobId })).structuredContent;
  return result.artifacts[0].path;
}

async function renderRecipe(call, recipe, options) {
  for (const frame of recipe.frames) {
    const created = await call('scene_create', { recipe: recipeForFrame(recipe.slug, frame.id) });
    if (created.isError) throw new Error(`${recipe.slug} ${frame.id}: ${created.content?.[0]?.text}`);
    const { sessionId } = created.structuredContent;
    const settings = { kind: 'image', width: options.width, height: options.height };
    if (recipe.clip) settings.motion = { start: frame.time };
    const artifact = await renderJob(call, sessionId, settings);
    await copyFile(artifact, join(options.directory, `${recipe.slug}-${frame.id}.png`));
    if (frame.id === 'after' && recipe.clip && options.clip) {
      const video = await renderJob(call, sessionId, { kind: 'video', width: options.width, height: options.height, fps: recipe.clip.fps, duration: recipe.clip.duration, motion: { start: 0 } });
      await copyFile(video, join(options.directory, `${recipe.slug}.mp4`));
    }
    await call('scene_dispose', { sessionId });
    console.log(`${recipe.slug} ${frame.id} rendered`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!existsSync(new URL('../build/mcp/server.mjs', import.meta.url))) throw new Error('Run npm run build and node scripts/build-mcp.mjs first: the MCP server is not built.');
  await mkdir(options.directory, { recursive: true });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry, '--jobs', join(tmpdir(), `crucible-recipes-${process.pid}`)], stderr: 'ignore' });
  const client = new Client({ name: 'render-recipes', version: '1.0.0' });
  await client.connect(transport);
  try {
    const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 600000 });
    for (const recipe of RECIPES) {
      if (options.slugs.length === 0 || options.slugs.includes(recipe.slug)) await renderRecipe(call, recipe, options);
    }
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
