#!/usr/bin/env node
// Measures the real DOM of the Studio screens in headless Chrome and fails when the spacing breaks the rules of
// studio-layout-rules.mjs: unequal insets around the content of a padded container, a gap or padding off the spacing
// scale, or a gap between groups smaller than the gap inside one. Every failure names the selector, the numbers and the fix.
//
//   node scripts/studio-layout-audit.mjs [--json] [--origin url] [--only setup|studio|rename|popover] [--records file.json]
//
// Without --origin it starts a Vite dev server on a free port and stops it (by its own PID) at the end. Screens: the Studio
// page, each of its popover menus, and the five steps of the setup dialog, each in the dark and the light theme at 1280 by 720.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findSpacingProblems } from './studio-layout-rules.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const STUDIO_PAGE = '/bench/studio/index.html?setup=off';
const READY_EXPRESSION = 'Boolean(window.__studioPage?.renderer) && !document.getElementById("studio-loading")';
const PREFERENCES_KEY = 'crucible-studio-preferences';
const THEMES = ['dark', 'light'];
const VIEWPORT = { width: 1280, height: 720 };
const SERVER_START_TIMEOUT_MS = 60000;
const USAGE = 'Usage: node scripts/studio-layout-audit.mjs [--json] [--origin url] [--only setup|studio|rename|popover] [--records file.json]';
const CHROME_PATH = process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
const GPU_ARGUMENTS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-audio-output'];
const SOFTWARE_ARGUMENTS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--disable-audio-output'];

// An uneven inset or an off-scale value that is meant. Each entry names the kind, the selector (a substring of the
// reported one) and why. Keep this short: a real finding is fixed in the CSS, never listed here.
export const ALLOWLIST = Object.freeze([
  { kind: 'uneven-inset', selector: 'crucible-studio-toolbar', reason: 'The tool rail is a strip as tall as the window; its buttons sit at the top and the strip ends below them.' },
  { kind: 'uneven-inset', selector: 'crucible-studio-tree-row', reason: 'The visibility button at the end of an outliner row is a hit area with its own room, so the row keeps 2px on that side.' },
  { kind: 'uneven-inset', selector: 'crucible-studio-popover > button', reason: 'A menu row is a full-width hit area whose label starts at the leading edge; the free space is the end of the row.' },
]);

// Runs inside the page. Returns one record per visible element under `rootElement`; the rules read them in Node.
function collectSpacingRecords(rootElement) {
  const skippedSelector = '.crucible-studio-setup-preview, svg, canvas';
  const pixels = value => {
    const number = parseFloat(value);
    return Number.isFinite(number) ? number : 0;
  };
  const isVisible = element => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.display === 'contents' || style.visibility === 'hidden') return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const isInFlow = element => !['absolute', 'fixed'].includes(getComputedStyle(element).position);
  const flowChildren = element => Array.from(element.children).filter(child => isVisible(child) && isInFlow(child));
  const ownGap = element => {
    const style = getComputedStyle(element);
    if (!/flex|grid/.test(style.display) || flowChildren(element).length < 2) return null;
    return { row: pixels(style.rowGap), column: pixels(style.columnGap) };
  };
  const describe = element => {
    const own = Array.from(element.classList).slice(0, 2).map(name => `.${name}`).join('');
    if (own) return `${element.localName}${own}`;
    const parent = element.parentElement;
    const parentOwn = parent ? Array.from(parent.classList).slice(0, 1).map(name => `.${name}`).join('') : '';
    return `${parentOwn} > ${element.localName}`.trim();
  };
  const elements = [rootElement, ...rootElement.querySelectorAll('*')].filter(element => !element.closest(skippedSelector) && isVisible(element));
  return elements.map(element => {
    const style = getComputedStyle(element);
    const children = flowChildren(element);
    const padding = { top: pixels(style.paddingTop), right: pixels(style.paddingRight), bottom: pixels(style.paddingBottom), left: pixels(style.paddingLeft) };
    const padded = Object.values(padding).some(value => value > 0);
    const scrolls = /auto|scroll/.test(style.overflowX + style.overflowY);
    let insets = null;
    if (padded && children.length > 0 && !scrolls) {
      const box = element.getBoundingClientRect();
      const innerLeft = box.left + element.clientLeft;
      const innerTop = box.top + element.clientTop;
      const boxes = children.map(child => child.getBoundingClientRect());
      insets = {
        left: Math.min(...boxes.map(item => item.left)) - innerLeft,
        top: Math.min(...boxes.map(item => item.top)) - innerTop,
        right: innerLeft + element.clientWidth - Math.max(...boxes.map(item => item.right)),
        bottom: innerTop + element.clientHeight - Math.max(...boxes.map(item => item.bottom)),
      };
    }
    const isClear = color => color === 'transparent' || /(,\s*0\)|\/\s*0\))$/.test(color);
    const visibleEdge = (pixels(style.borderTopWidth) > 0 && !isClear(style.borderTopColor)) || !isClear(style.backgroundColor) || style.backgroundImage !== 'none';
    const uniformPadding = padded && new Set(Object.values(padding)).size === 1;
    const childGaps = children.map(ownGap).filter(Boolean).map(gap => Math.max(gap.row, gap.column));
    return { selector: describe(element), gaps: ownGap(element), padding, insets, visibleEdge, uniformPadding, childGap: childGaps.length ? Math.max(...childGaps) : 0 };
  });
}

function parseArguments(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unknown argument ${argument}. ${USAGE}`);
    const name = argument.slice(2);
    flags[name] = ['origin', 'only', 'records'].includes(name) ? argv[++index] : true;
  }
  return flags;
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

async function isAnswering(origin) {
  try {
    return (await fetch(origin, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

export async function startDevServer() {
  const viteEntry = join(projectRoot, 'node_modules/vite/bin/vite.js');
  if (!existsSync(viteEntry)) throw new Error('vite is not installed here. Run `npm ci`, or pass --origin <url> of a running server.');
  const port = await findFreePort();
  const child = spawn(process.execPath, [viteEntry, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: projectRoot, stdio: 'ignore' });
  process.once('exit', () => child.kill());
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The Vite dev server exited with code ${child.exitCode} before it answered.`);
    if (await isAnswering(origin)) return { origin, stop: () => child.kill() };
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  child.kill();
  throw new Error(`The Vite dev server did not answer on ${origin} within ${SERVER_START_TIMEOUT_MS / 1000} s.`);
}

const RENAME_WIDTHS = [1280, 720];

// The top bar with the scene name editor open, then with an error under it, at both widths. The name is a button until it is clicked.
async function measureRenameScreens(page, theme) {
  const screens = [];
  for (const width of RENAME_WIDTHS) {
    await page.setViewportSize({ width, height: VIEWPORT.height });
    await page.waitForTimeout(400);
    await page.click('.crucible-studio-filepill');
    await page.waitForSelector('.crucible-studio-name-editor input');
    screens.push({ name: `rename editing ${width} (${theme})`, records: await measure(page, '.crucible-studio') });
    await page.fill('.crucible-studio-name-editor input', 'bad|name');
    await page.waitForTimeout(100);
    screens.push({ name: `rename error ${width} (${theme})`, records: await measure(page, '.crucible-studio') });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(300);
  return screens;
}

// A real pointer lock would grab the desktop cursor of whoever runs this.
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

export async function launchBrowser() {
  const { chromium } = await import('playwright');
  const options = { headless: true, args: process.platform === 'win32' ? GPU_ARGUMENTS : SOFTWARE_ARGUMENTS };
  if (CHROME_PATH && existsSync(CHROME_PATH)) return chromium.launch({ ...options, executablePath: CHROME_PATH });
  return chromium.launch(options).catch(() => chromium.launch({ ...options, channel: 'chrome' }));
}

export async function openStudio(browser, origin, theme, extraCss = '') {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await context.addInitScript(FAKE_POINTER_LOCK_SCRIPT);
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [PREFERENCES_KEY, JSON.stringify({ theme, setupDone: true })]);
  const page = await context.newPage();
  await page.goto(origin + STUDIO_PAGE, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(READY_EXPRESSION, null, { timeout: 120000 });
  if (extraCss) await page.addStyleTag({ content: extraCss });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  return { context, page };
}

function measure(page, selector) {
  return page.evaluate(`(${collectSpacingRecords.toString()})(document.querySelector(${JSON.stringify(selector)}))`);
}

async function measureScreens(page, theme, only) {
  const screens = [];
  if (!only || only === 'studio') screens.push({ name: `studio (${theme})`, records: await measure(page, '.crucible-studio') });
  if (!only || only === 'rename') screens.push(...await measureRenameScreens(page, theme));
  if (!only || only === 'popover') {
    const identifiers = await page.evaluate(() => Array.from(document.querySelectorAll('.crucible-studio [popover]')).map(element => element.id).filter(Boolean));
    for (const identifier of identifiers) {
      await page.evaluate(id => document.getElementById(id).showPopover(), identifier);
      await page.waitForTimeout(250);
      screens.push({ name: `${identifier} (${theme})`, records: await measure(page, `#${identifier}`) });
      await page.evaluate(id => document.getElementById(id).hidePopover(), identifier);
    }
  }
  if (!only || only === 'setup') {
    await page.evaluate(() => window.__studioPage.openSetup());
    await page.waitForSelector('dialog.crucible-studio-setup-dialog[open]');
    const steps = page.locator('.crucible-studio-setup-step');
    for (let index = 0; index < await steps.count(); index += 1) {
      await steps.nth(index).click();
      await page.waitForTimeout(200);
      const stepName = (await steps.nth(index).innerText()).trim().toLowerCase();
      screens.push({ name: `setup ${stepName} (${theme})`, records: await measure(page, 'dialog.crucible-studio-setup-dialog') });
    }
    await page.evaluate(() => document.querySelector('dialog.crucible-studio-setup-dialog').close());
  }
  return screens;
}

// `extraCss` is added to the page before measuring: the test uses it to seed a spacing mistake the audit must catch.
export async function runAudit({ origin, only, extraCss } = {}) {
  const server = origin ? { origin, stop: () => {} } : await startDevServer();
  const browser = await launchBrowser();
  try {
    const screens = [];
    for (const theme of THEMES) {
      const { context, page } = await openStudio(browser, server.origin, theme, extraCss);
      screens.push(...await measureScreens(page, theme, only));
      await context.close();
    }
    return screens;
  } finally {
    await browser.close();
    server.stop();
  }
}

function surfaceOf(screenName) {
  return screenName.replace(/ \((dark|light)\)$/, '');
}

// One entry per distinct problem, with the surfaces it showed on, so a problem seen in both themes is read once.
export function summarize(screens, allowlist = ALLOWLIST) {
  const merged = new Map();
  const allowedMerged = new Map();
  for (const screen of screens) {
    const { findings, allowed } = findSpacingProblems(screen.records, { allowlist });
    for (const [list, target] of [[findings, merged], [allowed, allowedMerged]]) {
      for (const problem of list) {
        const key = `${problem.kind}|${problem.selector}|${problem.detail}|${problem.message}`;
        const entry = target.get(key) ?? { ...problem, surfaces: new Set() };
        entry.surfaces.add(surfaceOf(screen.name));
        target.set(key, entry);
      }
    }
  }
  const listed = target => [...target.values()].map(entry => ({ ...entry, surfaces: [...entry.surfaces] }));
  return { findings: listed(merged), allowed: listed(allowedMerged) };
}

function countBySurface(findings) {
  const counts = {};
  for (const finding of findings) {
    for (const surface of finding.surfaces) counts[surface] = (counts[surface] ?? 0) + 1;
  }
  return counts;
}

async function main() {
  const flags = parseArguments(process.argv.slice(2));
  const screens = await runAudit({ origin: flags.origin, only: flags.only });
  if (flags.records) writeFileSync(flags.records, JSON.stringify(screens));
  const { findings, allowed } = summarize(screens);
  const bySurface = countBySurface(findings);
  if (flags.json) {
    console.log(JSON.stringify({ screens: screens.length, failures: findings.length, bySurface, findings, allowlist: ALLOWLIST, allowlistUsed: allowed }, null, 2));
  } else {
    for (const finding of findings) console.log(`[${finding.kind}] ${finding.message}\n    seen on: ${finding.surfaces.join(', ')}`);
    console.log(`\nStudio layout audit: ${screens.length} screens, ${findings.length} failures (${Object.entries(bySurface).map(([surface, count]) => `${surface} ${count}`).join(', ') || 'none'}).`);
    console.log(`Allowlist: ${ALLOWLIST.length} declared, ${allowed.length} used.`);
    for (const entry of ALLOWLIST) console.log(`  ${entry.kind} ${entry.selector}: ${entry.reason}`);
  }
  process.exitCode = findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}