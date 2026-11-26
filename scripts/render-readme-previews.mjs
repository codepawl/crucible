// Rebuilds the pictures at the top of README.md (public/previews/*.webp) from the current code, so they show today's look.
//   node scripts/render-readme-previews.mjs [name ...] [--preview <dir>] [--pairs <dir>] [--skip-cook]   (--help lists the options)
// The table of the eight pictures is scripts/readme-previews-plan.mjs. Rendering reuses scripts/render-media.mjs (site pages and
// showcase scenes), scripts/render-file-native.mjs (Cook, for the Blender demo scenes) and the MCP render job tools (clips built from
// the recipes in scripts/readme-previews/). Needs Google Chrome and FFmpeg; Cook previews also need Blender (BLENDER, or `blender` on
// the PATH) and the Cook native addon. The Blender demo files are downloaded into the cache folder, never into the repository.
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DEMO_SOURCES, PREVIEW_COOK_SAMPLES, USAGE, drawSize, needsCook, parseArguments, renderSize, selectPreviews } from './readme-previews-plan.mjs';

import { applyBlenderWorld, readBlenderWorld } from './blender-world-sky.mjs';

const root = resolve(import.meta.dirname, '..');
const publishedFolder = join(root, 'public', 'previews');
const SKY_FILE = join(root, 'public', 'showcase', 'airport', 'sky.hdr');
const PREVIEW_WEBP_QUALITY = 40;
const CLIP_QUALITY_LADDER = [95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45, 40, 35];

function ffmpegPath() {
  const local = join(homedir(), '.local', 'bin', 'ffmpeg.exe');
  return existsSync(local) ? local : 'ffmpeg';
}

function run(command, argumentList, label) {
  const result = spawnSync(command, argumentList, { cwd: root, stdio: 'inherit' });
  if (result.error) throw new Error(`${label}: could not start ${command} (${result.error.message}).`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

function runNode(scriptAndArguments, label) {
  run(process.execPath, scriptAndArguments, label);
}

// ---------- Blender demo scenes (Cook) ----------

const DEMO_MAXIMUM_BYTES = 512 * 1024 * 1024;

export function demoDownloadArguments(sourceName, cacheFolder, destination) {
  const source = DEMO_SOURCES[sourceName];
  let parsed;
  try {
    parsed = new URL(source?.url ?? '');
  } catch {
    throw new Error(`Untrusted demo source for ${sourceName}.`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'download.blender.org') {
    throw new Error(`Untrusted demo source for ${sourceName}.`);
  }
  const safeRoot = `${resolve(cacheFolder)}${sep}`;
  const safeTarget = resolve(destination);
  if (!safeTarget.startsWith(safeRoot)) {
    throw new Error(`Refusing to write outside cache folder: ${safeTarget}`);
  }
  return ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-filesize', String(DEMO_MAXIMUM_BYTES), '--output', safeTarget, parsed.href];
}

function downloadDemoArchive(sourceName, cacheFolder, destination) {
  const argumentList = demoDownloadArguments(sourceName, cacheFolder, destination);
  const result = spawnSync('curl', argumentList, { cwd: root, encoding: 'utf8' });
  if (result.error) throw new Error(`Download of ${sourceName} failed: could not start curl (${result.error.message}).`);
  if (result.status !== 0) throw new Error(`Download of ${sourceName} failed (curl exit ${result.status}): ${result.stderr || 'unknown error'}`);
}

async function findBlendFile(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.blend')) return join(entry.parentPath, entry.name);
  }
  throw new Error(`No .blend file found in ${folder}.`);
}

function unzip(archive, folder) {
  // Git Bash puts its GNU tar first on the PATH, and that tar reads "C:" in a path as a remote host; Windows ships bsdtar, which unzips.
  const windowsTar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const [command, argumentList] = process.platform === 'win32' ? [windowsTar, ['-xf', archive, '-C', folder]] : ['unzip', ['-oq', archive, '-d', folder]];
  run(command, argumentList, `unzip ${archive}`);
}

/** Downloads the demo file once and converts it to scene.glb with scripts/blender-demo-to-glb.py; returns the folder that holds scene.glb. */
async function prepareDemoGlb(sourceName, cacheFolder) {
  const source = DEMO_SOURCES[sourceName];
  const sourceFolder = join(cacheFolder, sourceName);
  if (existsSync(join(sourceFolder, 'scene.glb'))) return sourceFolder;
  await mkdir(sourceFolder, { recursive: true });
  const downloaded = join(sourceFolder, source.zipped ? `${sourceName}.zip` : `${sourceName}.blend`);
  if (!existsSync(downloaded)) downloadDemoArchive(sourceName, cacheFolder, downloaded);
  if (source.zipped) {
    await mkdir(join(sourceFolder, 'unzipped'), { recursive: true });
    unzip(downloaded, join(sourceFolder, 'unzipped'));
  }
  const blendFile = source.zipped ? await findBlendFile(join(sourceFolder, 'unzipped')) : downloaded;
  run(process.env.BLENDER ?? 'blender', ['-b', blendFile, '-t', '6', '--disable-autoexec', '--python', join(root, 'scripts', 'blender-demo-to-glb.py'), '--', sourceFolder], `Blender export of ${sourceName}`);
  return sourceFolder;
}

function demoSceneDescription(preview) {
  return {
    id: preview.source, glb: 'scene.glb', hdri: 'sky.hdr',
    hdriOptions: { intensity: 1, showBackground: true, backgroundBlur: 0 },
    gltfOptions: { maxTexturePixels: 33554432 },
    exposure: 1, eye: preview.eye, target: preview.target,
    renderer: { ground: false, world: false, hdr: true, samples: 8, pixelRatio: 1, memoryBudgetMiB: 3072 },
    frame: { fov: preview.fov, near: 0.05, far: 2000, exposure: 1, effects: { saturation: 1.05, contrast: 1.05, vignette: 0.15 } },
  };
}

async function renderCookStill(preview, size, options, workFolder, outputPng) {
  const cacheFolder = resolve(options.cache ?? join(homedir(), '.cache', 'crucible-readme-previews'));
  const demoFolder = await prepareDemoGlb(preview.source, cacheFolder);
  // A demo whose world is an analytic sky has its own baked sky.hdr and world.json from the export (#2761); the others get the airport sky.
  const world = readBlenderWorld(demoFolder);
  if (!world) await copyFile(SKY_FILE, join(demoFolder, 'sky.hdr'));
  const sceneFile = join(demoFolder, `${preview.name}.scene.json`);
  await writeFile(sceneFile, JSON.stringify(applyBlenderWorld(demoSceneDescription(preview), world), null, 2));
  const prefix = join(workFolder, preview.name);
  const samples = options.preview ? PREVIEW_COOK_SAMPLES : preview.samples;
  runNode(['scripts/render-file-native.mjs', '--config', sceneFile, '--out', prefix, '--width', String(size.width), '--height', String(size.height),
    '--samples', String(samples), '--bounces', String(preview.bounces), '--denoise', 'oidn'], `Cook render of ${preview.name}`);
  await copyFile(`${prefix}.png`, outputPng);
}

// ---------- Clips from recipes (MCP render job tools) ----------

async function renderRecipeClip(preview, size, options, outputMp4) {
  if (!existsSync(join(root, 'build', 'mcp', 'server.mjs'))) throw new Error('The MCP server is not built. Run "npm run build" and "node scripts/build-mcp.mjs" first.');
  const recipeModule = await import(pathToFileURL(join(root, 'scripts', 'readme-previews', `${preview.recipe}.recipe.mjs`)).href);
  const samples = options.preview ? PREVIEW_COOK_SAMPLES / 2 : preview.samples;
  const settings = recipeModule.renderSettings({ width: size.width, height: size.height, fps: preview.renderFps, seconds: preview.renderSeconds, samples });
  const jobsFolder = await mkdtemp(join(tmpdir(), 'readme-previews-jobs-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'bin', 'crucible-mcp.mjs'), '--jobs', jobsFolder], stderr: 'ignore' });
  const client = new Client({ name: 'render-readme-previews', version: '1.0.0' });
  await client.connect(transport);
  try {
    const call = async (name, toolArguments) => {
      const result = await client.callTool({ name, arguments: toolArguments }, { timeout: 900000 });
      if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
      return result.structuredContent;
    };
    const created = await call('scene_create', { recipe: recipeModule.recipe });
    const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: created.revision, settings });
    for (;;) {
      const record = await call('scene_render_status', { jobId: submitted.jobId });
      if (record.state === 'completed') break;
      if (['cancelled', 'failed', 'interrupted'].includes(record.state)) throw new Error(`Render job of ${preview.name} ${record.state}: ${record.reason ?? ''}`);
      await delay(500);
    }
    const result = await call('scene_render_result', { jobId: submitted.jobId });
    await copyFile(result.artifacts[0].path, outputMp4);
  } finally {
    await client.close();
    await rm(jobsFolder, { recursive: true, force: true });
  }
}

// ---------- Site pages and showcase scenes (render-media) ----------

function renderMedia(preview, size, outputPath) {
  const kindArguments = preview.kind === 'clip'
    ? ['--kind', 'video', '--start', '0', '--duration', String(preview.renderSeconds), '--fps', String(preview.renderFps)]
    : ['--kind', 'image'];
  runNode(['scripts/render-media.mjs', ...kindArguments, ...preview.mediaArguments, '--width', String(size.width), '--height', String(size.height), '--output', outputPath], `render-media of ${preview.name}`);
}

// ---------- Encoding ----------

async function writeStill(pngFile, destination, preview, size, quality) {
  await sharp(pngFile).resize(size.width, size.height, { fit: 'fill' }).webp({ quality, effort: 6 }).toFile(destination);
}

function encodeClipAt(mp4File, destination, preview, size, quality) {
  const speedFilter = `scale=${size.width}:${size.height}:flags=lanczos,setpts=PTS*${preview.renderFps}/${preview.playFps}`;
  run(ffmpegPath(), ['-y', '-loglevel', 'error', '-i', mp4File, '-vf', speedFilter, '-r', String(preview.playFps), '-an',
    '-c:v', 'libwebp_anim', '-quality', String(quality), '-compression_level', '6', '-loop', '0', destination], `WebP encode of ${preview.name}`);
}

/** Encodes the clip at the best quality that keeps the file under the size of the one it replaces; preview mode uses one low quality. */
async function writeClip(mp4File, destination, preview, size, previewMode) {
  if (previewMode) {
    encodeClipAt(mp4File, destination, preview, size, PREVIEW_WEBP_QUALITY);
    return;
  }
  for (const quality of CLIP_QUALITY_LADDER) {
    encodeClipAt(mp4File, destination, preview, size, quality);
    if ((await stat(destination)).size <= preview.maxBytes) return;
  }
  throw new Error(`${preview.name} stays over ${preview.maxBytes} bytes even at quality ${CLIP_QUALITY_LADDER.at(-1)}. Shorten the clip or lower its size in scripts/readme-previews-plan.mjs.`);
}

// ---------- Old and new side by side ----------

const LABEL_HEIGHT = 36;

function labelSvg(text, width) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_HEIGHT}"><rect width="100%" height="100%" fill="#111"/><text x="12" y="25" font-family="Arial, sans-serif" font-size="20" fill="#fff">${text}</text></svg>`);
}

async function pairFrame(oldFrame, newFrame, size) {
  const labelled = async (frame, text) => sharp({ create: { width: size.width, height: size.height + LABEL_HEIGHT, channels: 3, background: '#111' } })
    .composite([{ input: labelSvg(text, size.width), top: 0, left: 0 }, { input: await sharp(frame).resize(size.width, size.height, { fit: 'fill' }).png().toBuffer(), top: LABEL_HEIGHT, left: 0 }])
    .png().toBuffer();
  const left = await labelled(oldFrame, 'old (public/previews)');
  const right = await labelled(newFrame, 'new');
  return sharp({ create: { width: size.width * 2, height: size.height + LABEL_HEIGHT, channels: 3, background: '#111' } })
    .composite([{ input: left, top: 0, left: 0 }, { input: right, top: 0, left: size.width }]).png().toBuffer();
}

async function framesOf(webpFile) {
  const { pages = 1 } = await sharp(webpFile, { animated: true }).metadata();
  return Promise.all(Array.from({ length: pages }, (_, page) => sharp(webpFile, { page }).png().toBuffer()));
}

async function writePair(preview, newWebp, pairsFolder, size, workFolder) {
  await mkdir(pairsFolder, { recursive: true });
  const oldWebp = join(publishedFolder, `${preview.name}.webp`);
  const oldFrames = await framesOf(oldWebp);
  const newFrames = await framesOf(newWebp);
  const pairSize = preview.kind === 'clip' ? { width: size.width, height: size.height } : size;
  if (preview.kind === 'still') {
    await writeFile(join(pairsFolder, `readme-${preview.name}-pair.png`), await pairFrame(oldFrames[0], newFrames[0], pairSize));
    return;
  }
  const frameFolder = await mkdtemp(join(workFolder, `${preview.name}-pair-`));
  const frameCount = Math.max(oldFrames.length, newFrames.length);
  for (let index = 0; index < frameCount; index++) {
    const frame = await pairFrame(oldFrames[index % oldFrames.length], newFrames[index % newFrames.length], pairSize);
    await writeFile(join(frameFolder, `${String(index).padStart(4, '0')}.png`), frame);
  }
  const evenHeight = 2 * Math.ceil((pairSize.height + LABEL_HEIGHT) / 2);
  run(ffmpegPath(), ['-y', '-loglevel', 'error', '-framerate', String(preview.playFps), '-i', join(frameFolder, '%04d.png'),
    '-vf', `pad=${pairSize.width * 2}:${evenHeight}:0:0:#111111`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', join(pairsFolder, `readme-${preview.name}-pair.mp4`)], `pair video of ${preview.name}`);
  await rm(frameFolder, { recursive: true, force: true });
}

// ---------- Main ----------

async function renderPreview(preview, options, workFolder) {
  const previewMode = Boolean(options.preview);
  const size = renderSize(preview, previewMode);
  const drawnSize = drawSize(preview, previewMode);
  const destination = join(options.preview ? resolve(options.preview) : publishedFolder, `${preview.name}.webp`);
  const intermediate = join(workFolder, `${preview.name}.${preview.kind === 'clip' ? 'mp4' : 'png'}`);
  if (preview.renderer === 'cook-file') await renderCookStill(preview, size, options, workFolder, intermediate);
  else if (preview.renderer === 'recipe') await renderRecipeClip(preview, drawnSize, options, intermediate);
  else renderMedia(preview, drawnSize, intermediate);
  if (preview.kind === 'clip') await writeClip(intermediate, destination, preview, size, previewMode);
  else await writeStill(intermediate, destination, preview, size, previewMode ? PREVIEW_WEBP_QUALITY : preview.quality);
  const { size: bytes } = await stat(destination);
  const publishedFile = join(publishedFolder, `${preview.name}.webp`);
  const publishedNote = existsSync(publishedFile) ? `published ${(await stat(publishedFile)).size}` : 'not published yet';
  console.log(`${preview.name}: ${size.width}x${size.height}, ${bytes} bytes (${publishedNote}) -> ${destination}`);
  if (options.pairs && existsSync(publishedFile)) await writePair(preview, destination, resolve(options.pairs), size, workFolder);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const previews = selectPreviews(options);
  const workFolder = resolve(options.work ?? join(root, 'artifacts', 'readme-previews'));
  await mkdir(workFolder, { recursive: true });
  if (options.preview) await mkdir(resolve(options.preview), { recursive: true });
  const failures = [];
  for (const preview of previews) {
    try {
      await renderPreview(preview, options, workFolder);
    } catch (error) {
      failures.push(`${preview.name}${needsCook(preview) ? ' (Cook)' : ''}: ${error.message}`);
      console.error(`${preview.name} failed: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`${failures.length} preview(s) failed:\n${failures.join('\n')}`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
