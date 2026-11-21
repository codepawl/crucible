#!/usr/bin/env node
// One driver for every page in FEATURES.md, so nobody writes a throwaway browser script.
//
//   node scripts/drive.mjs list [--surface Site|Bench|MCP|CLI]
//   node scripts/drive.mjs shot <id> [--out file.png] [--origin url] [--width 1440] [--height 900] [--scale 1] [--settle ms] [--full-page]
//   node scripts/drive.mjs console <id> [--origin url] [--settle ms]       prints console errors, exits 1 when there are any
//
// Without --origin it uses a Vite dev server already answering on 127.0.0.1:5173, or starts one on a free port and stops it
// (by its own PID) at the end. Chrome runs headless on the GPU, and on this Windows machine the whole run is wrapped in
// gpu-lock as a light job (--no-gpu-lock skips that). Every page gets a fake pointer lock: a real one would grab the desktop cursor.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFeatureList, findFeature, parseCommandLine, parseFeatures, requirePage } from './drive-features.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_ORIGIN = 'http://127.0.0.1:5173';
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const GPU_ARGUMENTS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const GIT_BASH_PATH = 'C:/Program Files/Git/bin/bash.exe';
// Forward slashes: gpu-lock.sh finds its Rust binary by splitting its own path on /.
// Optional GPU job queue on the maintainer's machine; set GPU_LOCK_SCRIPT to use another one. Skipped when absent.
const GPU_LOCK_SCRIPT = process.env.GPU_LOCK_SCRIPT || [homedir().replaceAll('\\', '/'), '.agents', 'tools', 'gpu-lock.sh'].join('/');
const ALREADY_LOCKED_VARIABLE = 'DRIVE_GPU_LOCK_ACTIVE';
const SERVER_START_TIMEOUT_MS = 60000;

const FAKE_POINTER_LOCK_SCRIPT = () => {
  let lockedElement = null;
  Object.defineProperty(Document.prototype, 'pointerLockElement', { get: () => lockedElement, configurable: true });
  Element.prototype.requestPointerLock = function requestFakePointerLock() {
    lockedElement = this;
    document.dispatchEvent(new Event('pointerlockchange'));
    return Promise.resolve();
  };
  Document.prototype.exitPointerLock = function exitFakePointerLock() {
    lockedElement = null;
    document.dispatchEvent(new Event('pointerlockchange'));
  };
};

function loadFeatures() {
  return parseFeatures(readFileSync(join(projectRoot, 'FEATURES.md'), 'utf8'));
}

function rerunUnderGpuLock(argv) {
  const gpuLockAvailable = process.platform === 'win32' && existsSync(GIT_BASH_PATH) && existsSync(GPU_LOCK_SCRIPT);
  if (!gpuLockAvailable) return null;
  const result = spawnSync(GIT_BASH_PATH, [GPU_LOCK_SCRIPT, process.execPath, fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit',
    env: { ...process.env, [ALREADY_LOCKED_VARIABLE]: '1' },
  });
  return result.status ?? 1;
}

async function isAnswering(origin) {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

function findFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

async function startDevServer() {
  const port = await findFreePort();
  const viteEntry = join(projectRoot, 'node_modules/vite/bin/vite.js');
  if (!existsSync(viteEntry)) throw new Error('vite is not installed here. Run `npm ci`, or pass --origin <url> of a running server.');
  const child = spawn(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: projectRoot,
    stdio: 'ignore',
  });
  const origin = `http://127.0.0.1:${port}`;
  // Ctrl+C or a kill must not leave the dev server running after the driver is gone.
  const stopOnSignal = () => {
    child.kill();
    process.exit(130);
  };
  process.once('SIGINT', stopOnSignal);
  process.once('SIGTERM', stopOnSignal);
  process.once('exit', () => child.kill());
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The Vite dev server exited with code ${child.exitCode} before it answered.`);
    if (await isAnswering(origin)) return { origin, stop: () => child.kill() };
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  child.kill();
  throw new Error(`The Vite dev server did not answer on ${origin} within ${SERVER_START_TIMEOUT_MS / 1000} s.`);
}

async function resolveOrigin(flags) {
  if (flags.origin) return { origin: flags.origin.replace(/\/$/, ''), stop: () => {} };
  if (await isAnswering(DEFAULT_ORIGIN)) return { origin: DEFAULT_ORIGIN, stop: () => {} };
  return startDevServer();
}

async function openFeature(feature, flags, origin) {
  const route = requirePage(feature);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: GPU_ARGUMENTS });
  try {
    const width = Number(flags.width ?? 1440);
    const height = Number(flags.height ?? 900);
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: Number(flags.scale ?? 1) });
    await page.addInitScript(FAKE_POINTER_LOCK_SCRIPT);
    const problems = [];
    page.on('console', message => {
      if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
    });
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    page.on('requestfailed', request => problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`));
    await page.goto(origin + route, { waitUntil: 'load', timeout: 120000 });
    await waitUntilRendered(page, feature, Number(flags.settle ?? 1500));
    return { browser, page, problems };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function waitUntilRendered(page, feature, settleMilliseconds) {
  if (feature.ready) {
    await page.waitForFunction(feature.ready, null, { timeout: 120000 });
  } else if (await page.locator('canvas').count()) {
    await page.locator('canvas').first().waitFor({ state: 'attached', timeout: 30000 });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(settleMilliseconds);
}

async function runShot(features, positional, flags) {
  const feature = findFeature(features, requireId(positional, 'shot'));
  const outputPath = resolve(flags.out ?? join(projectRoot, 'artifacts/drive', `${feature.id}.png`));
  await mkdir(dirname(outputPath), { recursive: true });
  const server = await resolveOrigin(flags);
  let session;
  try {
    session = await openFeature(feature, flags, server.origin);
    await session.page.screenshot({ path: outputPath, fullPage: Boolean(flags['full-page']) });
    console.log(outputPath);
    if (session.problems.length) console.error(`${session.problems.length} console problem(s); run \`console ${feature.id}\` to read them.`);
  } finally {
    await session?.browser.close();
    server.stop();
  }
}

async function runConsole(features, positional, flags) {
  const feature = findFeature(features, requireId(positional, 'console'));
  const server = await resolveOrigin(flags);
  let session;
  try {
    session = await openFeature(feature, flags, server.origin);
    if (!session.problems.length) {
      console.log(`${feature.id}: no console errors`);
      return 0;
    }
    for (const problem of session.problems) console.log(problem);
    return 1;
  } finally {
    await session?.browser.close();
    server.stop();
  }
}

function requireId(positional, command) {
  if (!positional[0]) throw new Error(`Usage: node scripts/drive.mjs ${command} <id>. Run \`list\` for the ids.`);
  return positional[0];
}

const USAGE = 'Usage: node scripts/drive.mjs list [--surface Site] | shot <id> [--out file.png] | console <id>   (flags: --origin --width --height --scale --settle --full-page --no-gpu-lock)';

async function main(argv) {
  const { command, positional, flags } = parseCommandLine(argv);
  const features = loadFeatures();
  if (command === 'list') {
    console.log(formatFeatureList(features, flags.surface));
    return 0;
  }
  if (command !== 'shot' && command !== 'console') {
    console.error(USAGE);
    return 2;
  }
  if (!flags['no-gpu-lock'] && !process.env[ALREADY_LOCKED_VARIABLE]) {
    const lockedStatus = rerunUnderGpuLock(argv);
    if (lockedStatus !== null) return lockedStatus;
  }
  if (command === 'shot') {
    await runShot(features, positional, flags);
    return 0;
  }
  return runConsole(features, positional, flags);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    status => process.exit(status),
    error => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
