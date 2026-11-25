#!/usr/bin/env node
// Usage: node scripts/check-preview.mjs <candidate> [--reference <still>] [--at <seconds>] [--from <seconds>]
//        [--frames <count>] [--width <pixels>] [--min-similarity <0..1>] [--lossless <frames-folder>] [--json]
// Measures a look preview before it goes to review: exposure (against a Cook or Cycles still of the same scene and
// camera when given), texels that shimmer between frames, and the camera passing into a wall. PNG stills are read
// directly; JPEG, WebP and clips are decoded with ffmpeg. Exits 1 when a check fails.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { decodePng } from './agent-icon-png.mjs';
import { checkPreview, luminanceFromPixels, resizePlane } from './preview-checks.mjs';

const CLIP_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.gif']);

function parseArguments(argv) {
  const options = { width: 640, frames: 240, from: 0, at: null, json: false, minimumSimilarity: null, reference: null, lossless: null, candidate: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${argument} needs a value.`);
      return next;
    };
    if (argument === '--reference') options.reference = value();
    else if (argument === '--at') options.at = positiveNumber(argument, value(), true);
    else if (argument === '--from') options.from = positiveNumber(argument, value(), true);
    else if (argument === '--frames') options.frames = Math.round(positiveNumber(argument, value()));
    else if (argument === '--width') options.width = Math.round(positiveNumber(argument, value()));
    else if (argument === '--min-similarity') options.minimumSimilarity = positiveNumber(argument, value(), true);
    else if (argument === '--lossless') options.lossless = value();
    else if (argument === '--json') options.json = true;
    else if (argument.startsWith('--')) throw new Error(`Unknown option ${argument}. Options: --reference, --at, --from, --frames, --width, --min-similarity, --lossless, --json.`);
    else if (!options.candidate) options.candidate = argument;
    else throw new Error(`Only one candidate is checked at a time; got ${options.candidate} and ${argument}.`);
  }
  if (!options.candidate) throw new Error('Pass the still or clip to check: node scripts/check-preview.mjs <candidate> [--reference <still>].');
  if (options.frames < 1 || options.frames > 240) throw new Error(`--frames must be between 1 and 240; got ${options.frames}.`);
  if (options.width < 64 || options.width > 2048) throw new Error(`--width must be between 64 and 2048; got ${options.width}.`);
  return options;
}

function positiveNumber(name, text, allowZero = false) {
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) throw new Error(`${name} needs a ${allowZero ? 'non-negative' : 'positive'} number; got ${text}.`);
  return number;
}

function runTool(command, argumentList, binary = false) {
  const result = spawnSync(command, argumentList, { maxBuffer: 1 << 30, encoding: binary ? 'buffer' : 'utf8' });
  if (result.error) throw new Error(`${command} is needed to read this file and could not start: ${result.error.message}. Install ffmpeg or pass a PNG.`);
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr).trim().split('\n').pop()}`);
  return result.stdout;
}

function probe(path) {
  const output = runTool('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', path]);
  const stream = JSON.parse(output).streams?.[0];
  if (!stream) throw new Error(`${path} has no video stream.`);
  const [numerator, denominator] = String(stream.r_frame_rate ?? '0/1').split('/').map(Number);
  return { width: stream.width, height: stream.height, fps: denominator ? numerator / denominator : 0 };
}

function analysisSize(width, height, targetWidth) {
  const scaledWidth = Math.min(targetWidth, width);
  return { width: scaledWidth, height: Math.max(1, Math.round((height * scaledWidth) / width)) };
}

/** Luminance planes of the numbered PNG frames in a folder (render-media --kind stills --frames), in name order. */
function readLosslessFrames(folder, { width: targetWidth, frames: frameCount }) {
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--lossless needs a folder of PNG frames such as the output of render-media --kind stills --frames 0-71; got ${folder}.`);
  const names = readdirSync(folder).filter(name => extname(name).toLowerCase() === '.png').sort().slice(0, frameCount);
  if (!names.length) throw new Error(`--lossless folder ${folder} has no PNG frames. Render the same camera path with --kind stills --frames first.`);
  const frames = names.map(name => {
    const image = decodePng(readFileSync(join(folder, name)));
    const size = analysisSize(image.width, image.height, targetWidth);
    return resizePlane(luminanceFromPixels(image), size.width, size.height);
  });
  return { frames, fps: 0 };
}

/** Decoded luminance planes of a still or of consecutive clip frames, at the analysis width. */
function readFrames(path, { width: targetWidth, frames: frameCount, from }) {
  const extension = extname(path).toLowerCase();
  if (extension === '.png') {
    const image = decodePng(readFileSync(path));
    const size = analysisSize(image.width, image.height, targetWidth);
    return { frames: [resizePlane(luminanceFromPixels(image), size.width, size.height)], fps: 0 };
  }
  const source = probe(path);
  const size = analysisSize(source.width, source.height, targetWidth);
  const isClip = CLIP_EXTENSIONS.has(extension) || extension === '.webp' && source.fps > 0;
  const count = isClip ? frameCount : 1;
  const argumentsList = ['-v', 'error'];
  if (isClip && from > 0) argumentsList.push('-ss', String(from));
  argumentsList.push('-i', path, '-frames:v', String(count), '-vf', `scale=${size.width}:${size.height}:flags=area,format=rgb24`, '-f', 'rawvideo', '-');
  const raw = runTool('ffmpeg', argumentsList, true);
  const frameBytes = size.width * size.height * 3;
  const frames = [];
  for (let offset = 0; offset + frameBytes <= raw.length; offset += frameBytes) {
    frames.push(luminanceFromPixels({ width: size.width, height: size.height, data: raw.subarray(offset, offset + frameBytes), channels: 3 }));
  }
  if (!frames.length) throw new Error(`No frames could be decoded from ${path}.`);
  return { frames, fps: source.fps };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  // Lossless frames, when given, are what the checks measure, so the encoder's loss is not blamed on the renderer.
  const candidate = options.lossless ? readLosslessFrames(options.lossless, options) : readFrames(options.candidate, options);
  const reference = options.reference ? readFrames(options.reference, { ...options, frames: 1, from: 0, width: 4096 }).frames[0] : null;
  const referenceFrame = options.at !== null && candidate.fps ? Math.round((options.at - options.from) * candidate.fps) : 0;
  const report = checkPreview({ frames: candidate.frames, reference, referenceFrame, minimumSimilarity: options.minimumSimilarity });
  if (options.json) {
    console.log(JSON.stringify({ candidate: options.candidate, reference: options.reference, frames: candidate.frames.length, framesFrom: options.lossless ? 'lossless' : 'candidate', ...report }, null, 2));
  } else {
    for (const result of report.results) {
      const status = result.skipped ? 'SKIP' : result.pass ? 'PASS' : 'FAIL';
      const detail = result.skipped ?? Object.entries(result.measured ?? {}).map(([key, value]) => `${key} ${value}`).join(', ');
      const referenceDetail = result.reference ? ` | reference ${Object.entries(result.reference).map(([key, value]) => `${key} ${value}`).join(', ')}` : '';
      console.log(`${status} ${result.name}: ${detail}${referenceDetail}`);
      for (const problem of result.problems) console.log(`  - ${problem}`);
    }
    const frameSummary = `${candidate.frames.length} frame${candidate.frames.length === 1 ? '' : 's'}${options.lossless ? ` read from ${options.lossless}` : ''}`;
    console.log(report.pass ? `PASS ${options.candidate} (${frameSummary})` : `FAIL ${options.candidate}: fix the checks above before sending this preview for review.`);
  }
  process.exitCode = report.pass ? 0 : 1;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
