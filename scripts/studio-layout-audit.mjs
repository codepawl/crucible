#!/usr/bin/env node
// Measures the real DOM of the Studio screens in headless Chrome and fails when the spacing breaks the rules of
// studio-layout-rules.mjs: unequal insets around the content of a padded container, a gap or padding off the spacing
// scale, or a gap between groups smaller than the gap inside one. Every failure names the selector, the numbers and the fix.
//
//   node scripts/studio-layout-audit.mjs [--json] [--origin url] [--only setup|settings|keyboard|studio|rename|popover|export|workspaces|newscene|dialog|notice|notices|editmenu|history|agent|helpmenu] [--width pixels] [--records file.json]
//
// Without --origin it starts a Vite dev server on a free port and stops it (by its own PID) at the end. Screens: the Studio
// page, each of its popover menus, the five steps of the setup dialog, and the New scene chooser with its unsaved-changes
// question, each in the dark and the light theme at 1280 by 720 (--width changes the width, for example 720).
// The Agent card is measured with a sample chat host (clearly sample data, a scripted reply with two steps): empty, streaming,
// replied, with a notice and minimized.
// The Export workspace is measured before and after its three actions ran, at 1280 and at 720 pixels wide.
// The History panel is measured at 1280 and 720 after six edits with two undone, and the Edit menu with its History row beside it.
// The notices (a draft found in storage, the paused picture after a lost context) and the recipe, settings and shortcuts
// dialogs are measured at 1280 and at 720 pixels wide, because their buttons wrap first when the window narrows.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SELECTABLE_SELECTOR, findSelectionProblems, findSpacingProblems } from './studio-layout-rules.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const STUDIO_PAGE = '/bench/studio/index.html?setup=off';
const READY_EXPRESSION = 'Boolean(window.__studioPage?.renderer) && !document.getElementById("studio-loading")';
const PREFERENCES_KEY = 'crucible-studio-preferences';
const DRAFT_KEY = 'crucible.studio.draft';
const THEMES = ['dark', 'light'];
const VIEWPORT = { width: 1280, height: 720 };
const NARROW_VIEWPORT = { width: 720, height: 720 };
const DRAFT_STORAGE_KEY = 'crucible.studio.draft';
// A genuine draft, as the autosave writes it: a scene that differs from the one that opened, so Studio offers it by itself.
const SEEDED_DRAFT = JSON.stringify({ fileName: 'room.scene.json', recipe: { format: 'crucible.scene', nodes: [{ id: 'seeded-draft-node' }] } });
const DIALOG_SELECTORS = Object.freeze({
  'recipe dialog': 'dialog[aria-labelledby="crucible-studio-json-title"]',
  'settings dialog': 'dialog.crucible-studio-settings-dialog',
  'shortcuts dialog': 'dialog.crucible-studio-shortcuts-dialog',
});
const SERVER_START_TIMEOUT_MS = 60000;
const PANELS_TOGGLE = 'button[title="Show or hide the panels"]';
const USAGE = 'Usage: node scripts/studio-layout-audit.mjs [--json] [--origin url] [--only setup|settings|keyboard|studio|rename|popover|export|workspaces|newscene|dialog|notice|notices|editmenu|history|agent|helpmenu] [--width pixels] [--records file.json]';
const CHROME_PATH = process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
const GPU_ARGUMENTS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-audio-output'];
// A signed-in host (isSignedIn, sign out, billing) with every optional field, so the Account section of Settings is on screen and measured.
const SAMPLE_ACCOUNT_HOST = `globalThis.crucibleShell = { account: {
  isSignedIn: async () => true,
  get: async () => ({ name: 'Sample Person', email: 'sample.person@example.com', remainingText: '1,240 credits left', planText: 'Studio plan' }),
  signIn: async () => {}, signOut: async () => {}, buyCredits: () => {}, manageBilling: async () => ({ opened: true }),
} };`;
// A host that offers an agent chat, only for the screens of the Agent card: the reply is scripted, with two steps, and
// window.__sampleChat.emit lets the audit push an event of its own.
const SAMPLE_CHAT_HOST = `(() => {
  let listener = null;
  let timers = [];
  let endRun = null;
  const emit = event => listener?.(event);
  const script = [
    [150, { type: 'text', text: 'Sure. I will lift the cube ' }],
    [300, { type: 'text', text: 'and make it a little larger.' }],
    [500, { type: 'step', label: 'Moved the cube up', nodeId: 'cube' }],
    [900, { type: 'step', label: 'Scaled the cube', nodeId: 'cube' }],
    [1300, { type: 'text', text: 'It is done: the cube now sits higher.' }],
    [1500, { type: 'done' }],
  ];
  window.__sampleChat = { emit };
  globalThis.crucibleShell = {
    ...(globalThis.crucibleShell ?? {}),
    agentChat: {
      subscribe: next => { listener = next; return () => { listener = null; }; },
      stop: () => {
        timers.forEach(clearTimeout);
        timers = [];
        emit({ type: 'stopped' });
        endRun?.();
      },
      send: () => new Promise(resolve => {
        endRun = resolve;
        timers = script.map(([delay, event]) => setTimeout(() => {
          emit(event);
          if (event.type === 'done') resolve();
        }, delay));
      }),
    },
  };
})();`;
const SOFTWARE_ARGUMENTS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--disable-audio-output'];

// An uneven inset or an off-scale value that is meant. Each entry names the kind, the selector (a substring of the
// reported one) and why. Keep this short: a real finding is fixed in the CSS, never listed here.
export const ALLOWLIST = Object.freeze([
  { kind: 'uneven-inset', selector: 'crucible-studio-toolbar', reason: 'The tool rail is a strip as tall as the window; its buttons sit at the top and the strip ends below them.' },
  { kind: 'uneven-inset', selector: 'crucible-studio-tree-row', reason: 'The visibility button at the end of an outliner row is a hit area with its own room, so the row keeps 2px on that side.' },
  { kind: 'uneven-inset', selector: 'crucible-studio-popover > button', reason: 'A menu row is a full-width hit area whose label starts at the leading edge; the free space is the end of the row.' },
  { kind: 'uneven-inset', selector: 'button.crucible-studio-switch', reason: 'A switch is a track whose knob travels from one end to the other, so its content sits at unequal insets by design.' },
  { kind: 'uneven-inset', selector: 'crucible-studio-settings-section', reason: 'A section of the Settings list is a full-width hit area whose icon and label start at the leading edge; the free space is the end of the row.' },
]);

// Runs inside the page. Returns one record per visible element under `rootElement`; the rules read them in Node.
function collectSpacingRecords(rootElement, selectableSelector) {
  const skippedSelector = '.crucible-studio-setup-preview, svg, canvas';
  const pixels = value => {
    const number = parseFloat(value);
    return Number.isFinite(number) ? number : 0;
  };
  const isVisible = element => {
    if (element.closest('[hidden="until-found"]')) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.display === 'contents' || style.visibility === 'hidden' || style.contentVisibility === 'hidden') return false;
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
  const pathOf = element => {
    const parts = [];
    for (let current = element; current && current !== rootElement.parentElement && parts.length < 4; current = current.parentElement) {
      const firstClass = current.classList[0];
      parts.unshift(firstClass ? `${current.localName}.${firstClass}` : current.localName);
    }
    return parts.join(' > ');
  };
  const ownTextOf = element => Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim().slice(0, 40);
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
    const selection = { path: pathOf(element), ownText: ownTextOf(element), userSelect: style.userSelect, selectable: element.matches(selectableSelector) };
    return { ...selection, selector: describe(element), gaps: ownGap(element), padding, insets, visibleEdge, uniformPadding, childGap: childGaps.length ? Math.max(...childGaps) : 0 };
  });
}

function parseArguments(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unknown argument ${argument}. ${USAGE}`);
    const name = argument.slice(2);
    flags[name] = ['origin', 'only', 'records', 'width'].includes(name) ? argv[++index] : true;
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

// The widths of the rename screens: the standard one, the narrow one, and the two sides of the width (920) where the
// top bar changes layout. The long name is the 60 characters of a name that fills the bar.
const RENAME_WIDTHS = [1280, 921, 919, 720];
const LONG_NAME = 'a-scene-name-that-is-as-long-as-sixty-characters-in-all-ok-1234';
const BESIDE_ERROR_MIN_WIDTH = 1180;

const SETTLED_FRAMES = 3;
const SETTLE_TIMEOUT_MS = 10000;

// Runs inside the page: one signature of the top bar that changes when anything about its layout changes. The compact layout
// is applied by a ResizeObserver on the frame after a resize, so a bar read before that frame still has the wide layout
// (its islands reach past the window), and a loaded machine can make that frame late.
function readTopBarSignature() {
  const bar = document.querySelector('.crucible-studio-menubar');
  const boxes = Array.from(bar.querySelectorAll(':scope > .crucible-studio-island, .crucible-studio-filepill, .crucible-studio-name-editor')).map(element => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return [element.className, left, right, top, bottom];
  });
  return JSON.stringify({ width: window.innerWidth, compact: document.querySelector('.crucible-studio').dataset.compact, boxes });
}

// Resolves once the top bar has the same signature on SETTLED_FRAMES animation frames in a row. Each read waits for a frame
// of its own, so a late frame makes it wait longer instead of reading early as a fixed wait does.
export async function waitForSettledLayout(page, { framesNeeded = SETTLED_FRAMES, timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let unchangedFrames = 1;
  while (Date.now() < deadline) {
    const signature = await page.evaluate(`new Promise(resolveFrame => requestAnimationFrame(() => resolveFrame((${readTopBarSignature.toString()})())))`);
    unchangedFrames = signature === previous ? unchangedFrames + 1 : 1;
    if (unchangedFrames >= framesNeeded) return;
    previous = signature;
  }
  throw new Error(`The top bar was still changing size after ${timeoutMs} ms, so it cannot be measured.`);
}

// Runs inside the page: what the name (or its editor) and its reason do to the rest of the top bar. Returns sentences, empty when fine.
function collectBarOverlaps(besideErrorMinWidth) {
  const problems = [];
  const box = element => (element ? element.getBoundingClientRect() : null);
  const meet = (first, second) => first && second && first.left < second.right - 0.5 && second.left < first.right - 0.5 && first.top < second.bottom - 0.5 && second.top < first.bottom - 0.5;
  const islands = Array.from(document.querySelectorAll('.crucible-studio-menubar > .crucible-studio-island'));
  const own = islands.find(island => island.querySelector('.crucible-studio-filepill'));
  const others = islands.filter(island => island !== own);
  const ownBox = box(own);
  const nameElement = [...document.querySelectorAll('.crucible-studio-name-editor, .crucible-studio-filepill')].find(candidate => candidate.getBoundingClientRect().width > 0);
  const nameBox = box(nameElement);
  if (!nameBox) problems.push('the scene name is not on screen');
  for (const other of others) {
    if (meet(ownBox, box(other))) problems.push(`the island of the name overlaps ${other.className.split(' ').slice(0, 2).join('.')}`);
  }
  if (ownBox && nameBox && (nameBox.left < ownBox.left - 0.5 || nameBox.right > ownBox.right + 0.5)) problems.push('the name leaves its island');
  if (ownBox && ownBox.right > window.innerWidth + 0.5) problems.push('the island of the name leaves the window');
  for (const control of document.querySelectorAll('.crucible-studio-menubar .crucible-studio-menu-button')) {
    if (meet(nameBox, box(control)) && getComputedStyle(control).display !== 'none') problems.push(`the name overlaps the ${control.textContent.trim()} menu`);
  }
  const reason = document.querySelector('.crucible-studio-name-error:not([hidden])');
  const outliner = document.querySelector('.crucible-studio-outliner');
  if (reason && getComputedStyle(outliner).display !== 'none' && meet(box(reason), box(outliner))) problems.push('the reason covers the Scene panel');
  if (reason && box(reason).left < -0.5) problems.push('the reason leaves the window');
  for (const other of others) {
    if (reason && meet(box(reason), box(other))) problems.push(`the reason overlaps ${other.className.split(' ').slice(0, 2).join('.')}`);
  }
  const suffix = document.querySelector('.crucible-studio-name-suffix');
  const field = document.querySelector('.crucible-studio-name-field');
  if (suffix && field && box(suffix).left < box(field).right - 0.5) problems.push('the type of the file sits inside the ring of the name');
  if (suffix && ownBox && box(suffix).right > ownBox.right + 0.5) problems.push('the type of the file leaves the top bar');
  const pillSuffix = document.querySelector('.crucible-studio-filepill-suffix');
  if (pillSuffix && pillSuffix.getBoundingClientRect().width > 0 && ownBox && box(pillSuffix).right > ownBox.right + 0.5) problems.push('the type of the file leaves the top bar');
  return problems;
}

function measureBarOverlaps(page) {
  return page.evaluate(`(${collectBarOverlaps.toString()})(${BESIDE_ERROR_MIN_WIDTH})`);
}

// The top bar with the scene name editor open, then with a reason under or beside it, at each width; then with a name of
// 60 characters. The name is a button until it is clicked. Each screen also reports what the name does to the rest of the bar.
async function measureRenameScreens(page, theme) {
  const screens = [];
  const openEditor = async () => {
    await page.click('.crucible-studio-filepill');
    await page.waitForSelector('.crucible-studio-name-editor input');
    await page.waitForTimeout(100);
  };
  for (const width of RENAME_WIDTHS) {
    await page.setViewportSize({ width, height: VIEWPORT.height });
    await waitForSettledLayout(page);
    await openEditor();
    screens.push({ name: `rename editing ${width} (${theme})`, records: await measure(page, '.crucible-studio'), overlaps: await measureBarOverlaps(page) });
    await page.fill('.crucible-studio-name-editor input', 'bad|name');
    await page.waitForTimeout(100);
    screens.push({ name: `rename error ${width} (${theme})`, records: await measure(page, '.crucible-studio'), overlaps: await measureBarOverlaps(page) });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: RENAME_WIDTHS[0], height: VIEWPORT.height });
  await waitForSettledLayout(page);
  await openEditorWithName(page, LONG_NAME);
  for (const width of RENAME_WIDTHS) {
    await page.setViewportSize({ width, height: VIEWPORT.height });
    await waitForSettledLayout(page);
    const closedOverlaps = await measureBarOverlaps(page);
    await openEditor();
    await waitForSettledLayout(page);
    const overlaps = [...closedOverlaps.map(problem => `(name shown) ${problem}`), ...await measureBarOverlaps(page)];
    screens.push({ name: `rename long ${width} (${theme})`, records: await measure(page, '.crucible-studio'), overlaps });
    await page.fill('.crucible-studio-name-editor input', `bad|${LONG_NAME}`);
    await page.waitForTimeout(100);
    screens.push({ name: `rename long error ${width} (${theme})`, records: await measure(page, '.crucible-studio'), overlaps: await measureBarOverlaps(page) });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(300);
  return screens;
}

async function openEditorWithName(page, name) {
  await page.click('.crucible-studio-filepill');
  await page.waitForSelector('.crucible-studio-name-editor input');
  await page.fill('.crucible-studio-name-editor input', name);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
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
  // Headless Chrome hides scrollbars unless told not to; the scroll cue of the panel column has to show in the pictures and the audit.
  const options = { headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: process.platform === 'win32' ? GPU_ARGUMENTS : SOFTWARE_ARGUMENTS };
  if (CHROME_PATH && existsSync(CHROME_PATH)) return chromium.launch({ ...options, executablePath: CHROME_PATH });
  return chromium.launch(options).catch(() => chromium.launch({ ...options, channel: 'chrome' }));
}

export async function openStudio(browser, origin, theme, extraCss = '', { viewport = VIEWPORT, draft = false, savedDraft = null, chatHost = false } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(FAKE_POINTER_LOCK_SCRIPT);
  await context.addInitScript(SAMPLE_ACCOUNT_HOST);
  if (chatHost) await context.addInitScript(SAMPLE_CHAT_HOST);
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [PREFERENCES_KEY, JSON.stringify({ theme, setupDone: true })]);
  if (draft) await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [DRAFT_STORAGE_KEY, SEEDED_DRAFT]);
  if (savedDraft) await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [DRAFT_KEY, JSON.stringify(savedDraft)]);
  const page = await context.newPage();
  await page.goto(origin + STUDIO_PAGE, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(READY_EXPRESSION, null, { timeout: 120000 });
  if (extraCss) await page.addStyleTag({ content: extraCss });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  return { context, page };
}

function measure(page, selector) {
  return page.evaluate(`(${collectSpacingRecords.toString()})(document.querySelector(${JSON.stringify(selector)}), ${JSON.stringify(SELECTABLE_SELECTOR)})`);
}

// The notices that appear over the picture, each caused by what a person does: an error toast from bad JSON in the Recipe JSON dialog, a
// plain toast from Duplicate, and the paused notice from a real lost WebGL context (before and after it offers Reload).
async function measureNotices(page, theme) {
  const screens = [];
  const measureToast = async (name, expectedText) => {
    await page.waitForFunction(text => document.querySelector('.crucible-studio-status[data-state="in"]')?.textContent.includes(text), expectedText);
    await page.waitForTimeout(250);
    screens.push({ name: `${name} (${theme})`, records: await measure(page, '.crucible-studio-status') });
  };
  await page.evaluate(() => document.getElementById('crucible-studio-json-title').closest('dialog').showModal());
  await page.locator('textarea[aria-label="Scene recipe JSON"]').fill('{ not json');
  await page.getByRole('button', { name: 'Apply JSON' }).click();
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
  await measureToast('error toast', 'JSON');
  await page.evaluate(() => window.__studioPage.selectNode('cube'));
  await page.keyboard.press('Control+d');
  await measureToast('toast', 'Duplicated');
  await page.keyboard.press('Numpad1');
  await page.waitForSelector('.crucible-studio-numpad-notice:not([hidden])');
  screens.push({ name: `numpad notice (${theme})`, records: await measure(page, '.crucible-studio-numpad-notice') });
  await page.locator('.crucible-studio-numpad-notice button', { hasText: 'Keep number row' }).click();
  await page.evaluate(() => {
    // A lost context returns no extension, so the handle is kept to restore it.
    window.loseContextExtension = document.querySelector('.crucible-studio canvas').getContext('webgl2').getExtension('WEBGL_lose_context');
    window.loseContextExtension.loseContext();
  });
  await page.waitForSelector('.crucible-studio-paused:not([hidden])');
  await page.waitForTimeout(250);
  screens.push({ name: `paused notice (${theme})`, records: await measure(page, '.crucible-studio-paused') });
  await page.waitForSelector('.crucible-studio-paused button:not([hidden])');
  screens.push({ name: `paused notice with Reload (${theme})`, records: await measure(page, '.crucible-studio-paused') });
  await page.evaluate(() => window.loseContextExtension.restoreContext());
  return screens;
}

// The draft notice shows when storage holds an unsaved draft that differs from the opened scene, so a second page loads with one seeded.
async function measureDraftNotice(browser, origin, theme, extraCss) {
  const draft = { fileName: 'room.scene.json', recipe: { format: 'crucible.scene', nodes: [] } };
  const { context, page } = await openStudio(browser, origin, theme, extraCss, { savedDraft: draft });
  try {
    await page.waitForSelector('.crucible-studio-draft:not([hidden])');
    return { name: `draft notice (${theme})`, records: await measure(page, '.crucible-studio-draft') };
  } finally {
    await context.close();
  }
}

// Settings > Keyboard in each state a person meets: the list, a key waiting for a press, a clash with Swap and Cancel and a refused
// browser combination. Escape while recording must cancel the recording and leave Settings open. Nothing is saved: the clash is cancelled.
// Runs in the page. A row cut by the top or bottom edge of the shortcut list must have the fade marker of that edge, and a clash's
// buttons end where the key column ends (the same right edge within a pixel), inside the row they belong to.
function checkKeyboardScrollCue() {
  const list = document.querySelector('.crucible-studio-keyboard-list');
  const box = list.getBoundingClientRect();
  const problems = [];
  for (const row of list.querySelectorAll('.crucible-studio-keyboard-row')) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom < box.top || rect.top > box.bottom) continue;
    const label = row.querySelector('.crucible-studio-keyboard-name').textContent.trim();
    if (rect.top < box.top - 1 && list.dataset.above !== 'true') problems.push(label + ' is cut at the top without a fade');
    if (rect.bottom > box.bottom + 1 && list.dataset.more !== 'true') problems.push(label + ' is cut at the bottom without a fade');
  }
  const unnotedHeights = [...list.querySelectorAll('.crucible-studio-keyboard-row:not([data-noted])')].map(row => row.getBoundingClientRect().height);
  if (unnotedHeights.some(height => Math.abs(height - unnotedHeights[0]) > 0.5)) problems.push('rows differ in height (' + [...new Set(unnotedHeights)].join(', ') + ' px); a changed row must be as tall as the others');
  const toolbarRight = Math.max(...[...document.querySelectorAll('.crucible-studio-keyboard-head button, .crucible-studio-keyboard-head select, .crucible-studio-keyboard-head input')].map(control => control.getBoundingClientRect().right));
  const keysRight = Math.max(...[...list.querySelectorAll('button.crucible-studio-keyboard-keys')].map(button => button.getBoundingClientRect().right));
  if (Math.abs(toolbarRight - keysRight) > 1) problems.push('the toolbar ends at ' + toolbarRight + 'px and the key buttons at ' + keysRight + 'px; they share one right edge');
  const footerRight = Math.max(...[...document.querySelectorAll('dialog.crucible-studio-settings-dialog .crucible-studio-dialog-actions button')].map(button => button.getBoundingClientRect().right));
  const presetRight = document.querySelector('.crucible-studio-settings-pane[data-section="keys"] select').getBoundingClientRect().right;
  if (Math.abs(footerRight - keysRight) > 1) problems.push('the key column ends at ' + keysRight + 'px and the footer buttons at ' + footerRight + 'px; they share one right edge');
  if (Math.abs(footerRight - presetRight) > 1) problems.push('the preset field ends at ' + presetRight + 'px and the footer buttons at ' + footerRight + 'px; they share one right edge');
  const labelLeft = row => row.querySelector('.crucible-studio-keyboard-name > span:last-child').getBoundingClientRect().left;
  const rows = [...list.querySelectorAll('.crucible-studio-keyboard-row')];
  if (rows.some(row => Math.abs(labelLeft(row) - labelLeft(rows[0])) > 1)) problems.push('row labels do not share one left edge');
  const groups = [...list.querySelectorAll('.crucible-studio-keyboard-group')];
  const groupRows = groups.map(group => [...group.querySelectorAll('.crucible-studio-keyboard-row')]);
  if (groups.length > 1) {
    const rowGap = groupRows[0][1].getBoundingClientRect().top - groupRows[0][0].getBoundingClientRect().bottom;
    const titleGap = groups[1].querySelector('h4').getBoundingClientRect().top - groupRows[0].at(-1).getBoundingClientRect().bottom;
    if (titleGap < rowGap + 16) problems.push(`the gap above a group title (${titleGap}px) is not 16px larger than the gap between rows (${rowGap}px)`);
  }
  const note = list.querySelector('.crucible-studio-keyboard-row[data-noted="true"]');
  if (note) {
    const block = note.getBoundingClientRect();
    const lastButton = [...note.querySelectorAll('.crucible-studio-keyboard-note button')].at(-1);
    if (lastButton) {
      const leftInset = labelLeft(note) - block.left;
      const rightInset = block.right - lastButton.getBoundingClientRect().right;
      if (Math.abs(leftInset - rightInset) > 1) problems.push(`the tinted block has ${leftInset}px of room left of the label and ${rightInset}px right of the buttons`);
    }
    const noteChildren = [...note.children].map(child => child.getBoundingClientRect());
    const insets = [
      Math.min(...noteChildren.map(child => child.top)) - block.top,
      block.bottom - Math.max(...noteChildren.map(child => child.bottom)),
      Math.min(...noteChildren.map(child => child.left)) - block.left,
      block.right - Math.max(...noteChildren.map(child => child.right)),
    ];
    if (Math.max(...insets) - Math.min(...insets) > 1) problems.push('the tinted block has unequal room around its content (top, bottom, left, right: ' + insets.join(', ') + ' px)');
    const above = note.previousElementSibling ?? note.closest('.crucible-studio-keyboard-group').querySelector('h4');
    const gapAbove = block.top - above.getBoundingClientRect().bottom;
    if (gapAbove < 8) problems.push('the tinted block starts ' + gapAbove + 'px under the row or title above it; it keeps at least 8px');
    const trackGap = box.right - (list.offsetWidth - list.clientWidth) - block.right;
    if (trackGap < 8) problems.push('the tinted block ends ' + trackGap + 'px from the scrollbar; it keeps at least 8px');
    const keysRight = note.querySelector('.crucible-studio-keyboard-keys').getBoundingClientRect().right;
    const buttons = [...note.querySelectorAll('.crucible-studio-keyboard-note button')];
    if (buttons.length > 0 && Math.abs(buttons.at(-1).getBoundingClientRect().right - keysRight) > 1) problems.push('the clash buttons do not end at the key column edge');
    if (buttons.some(button => button.getBoundingClientRect().bottom > note.getBoundingClientRect().bottom + 1)) problems.push('a clash button leaves its row');
  }
  return problems;
}

async function assertKeyboardScrollCue(page, state) {
  const problems = await page.evaluate(`(${checkKeyboardScrollCue.toString()})()`);
  if (problems.length > 0) throw new Error(`keyboard list (${state}): ${problems.join('; ')}`);
}

async function measureKeyboard(page, theme) {
  const dialogSelector = 'dialog.crucible-studio-settings-dialog';
  const keysButton = actionId => page.locator(`button[data-key-action="${actionId}"]`);
  const screens = [];
  await openSettingsFromMenu(page);
  await page.locator('.crucible-studio-settings-section[data-section="keys"]').click();
  await page.waitForTimeout(200);
  screens.push({ name: `keyboard default (${theme})`, records: await measure(page, dialogSelector) });
  await assertKeyboardScrollCue(page, 'top');
  await page.evaluate(() => { document.querySelector('.crucible-studio-keyboard-list').scrollTop = 333; });
  await page.waitForTimeout(100);
  await assertKeyboardScrollCue(page, 'middle');
  await page.evaluate(() => { document.querySelector('.crucible-studio-keyboard-list').scrollTop = 0; });
  await keysButton('tool.select').click();
  await page.waitForTimeout(150);
  screens.push({ name: `keyboard recording (${theme})`, records: await measure(page, dialogSelector) });
  await page.keyboard.press('Control+w');
  await page.waitForTimeout(150);
  screens.push({ name: `keyboard refused (${theme})`, records: await measure(page, dialogSelector) });
  await page.keyboard.press('g');
  await page.waitForTimeout(150);
  screens.push({ name: `keyboard clash (${theme})`, records: await measure(page, dialogSelector) });
  await assertKeyboardScrollCue(page, 'clash');
  await page.locator('.crucible-studio-keyboard-note button', { hasText: 'Cancel' }).click();
  await keysButton('tool.select').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const state = await page.evaluate(() => ({
    open: document.querySelector('dialog.crucible-studio-settings-dialog').open,
    recording: document.querySelector('[data-recording="true"]') !== null,
    saved: document.querySelector('.crucible-studio-keyboard-row[data-changed="true"]') !== null,
  }));
  if (!state.open || state.recording || state.saved) {
    throw new Error('Escape while recording must cancel the recording, keep Settings open and save nothing: ' + JSON.stringify(state));
  }
  // A changed row shows its dot in the gutter, so its label keeps the left edge of the others. The key is really changed here and put back
  // with the row's own reset, so the screens measured after this one start from the preset.
  await keysButton('tool.select').click();
  await page.keyboard.press('j');
  await page.waitForTimeout(150);
  const changedRows = () => page.evaluate(() => document.querySelectorAll('.crucible-studio-keyboard-row[data-changed="true"]').length);
  if (await changedRows() !== 1) throw new Error('Pressing a free key while recording must change exactly that row.');
  await assertKeyboardScrollCue(page, 'changed row');
  await page.locator('.crucible-studio-keyboard-actions button', { hasText: 'Reset shortcuts' }).click();
  await page.waitForTimeout(150);
  const keepHasFocus = await page.evaluate(() => document.activeElement?.textContent.trim() === 'Keep');
  if (!keepHasFocus) throw new Error('The reset confirmation must open with the focus on Keep.');
  screens.push({ name: `keyboard reset confirm (${theme})`, records: await measure(page, dialogSelector) });
  await assertKeyboardScrollCue(page, 'reset confirm');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const afterEscape = await page.evaluate(() => ({
    open: document.querySelector('dialog.crucible-studio-settings-dialog').open,
    confirming: document.querySelector('.crucible-studio-keyboard-confirm') !== null,
  }));
  if (!afterEscape.open || afterEscape.confirming) throw new Error('Escape in the reset confirmation must pick Keep and keep Settings open: ' + JSON.stringify(afterEscape));
  await page.locator('button.crucible-studio-keyboard-reset').first().click();
  await page.waitForTimeout(150);
  if (await changedRows() !== 0) throw new Error('The reset of a changed row must put the preset key back and leave no changed row.');
  await page.evaluate(() => document.querySelector('dialog.crucible-studio-settings-dialog').close());
  return screens;
}

// Runs inside the page: the spacing and the key text contrast of the open shortcut sheet. Returns the problems and the numbers.
function probeShortcutSheet() {
  const dialog = document.querySelector('dialog.crucible-studio-shortcuts-dialog');
  const style = getComputedStyle(dialog);
  const problems = [];
  const insets = ['Top', 'Right', 'Bottom', 'Left'].map(side => parseFloat(style['padding' + side]));
  if (new Set(insets).size !== 1 || ![16, 24].includes(insets[0])) problems.push('The sheet padding is ' + insets.join('/') + ' px: use one value, 16 or 24.');
  const head = dialog.querySelector('.crucible-studio-shortcuts-head').getBoundingClientRect();
  const body = dialog.querySelector('.crucible-studio-shortcuts').getBoundingClientRect();
  const headGap = Math.round(body.top - head.bottom);
  if (headGap !== 16) problems.push('The title row to the first group gap is ' + headGap + ' px: use 16.');
  const firstGroup = dialog.querySelector('.crucible-studio-shortcut-column');
  const groups = Array.from(firstGroup.querySelectorAll('.crucible-studio-shortcut-group'));
  const rows = Array.from(groups[0].querySelectorAll('.crucible-studio-shortcut-item'));
  const rowGap = Math.round(rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom);
  const groupGap = Math.round(groups[1].getBoundingClientRect().top - groups[0].getBoundingClientRect().bottom);
  if (groupGap <= rowGap) problems.push('The gap between groups (' + groupGap + ' px) must be larger than the gap between rows (' + rowGap + ' px).');
  const columns = Array.from(dialog.querySelectorAll('.crucible-studio-shortcut-column')).map(column => column.getBoundingClientRect());
  if (columns.length === 2 && columns[1].left > columns[0].left) {
    const columnGap = Math.round(columns[1].left - columns[0].right);
    if (columnGap <= rowGap) problems.push('The gap between columns (' + columnGap + ' px) must be larger than the gap between rows (' + rowGap + ' px).');
  }
  const toRgb = color => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
  };
  const luminance = rgb => {
    const [red, green, blue] = rgb.map(channel => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const textLuminance = luminance(toRgb(getComputedStyle(dialog.querySelector('.crucible-studio-shortcut-keys')).color));
  const surfaceLuminance = luminance(toRgb(style.backgroundColor));
  const contrast = (Math.max(textLuminance, surfaceLuminance) + 0.05) / (Math.min(textLuminance, surfaceLuminance) + 0.05);
  if (contrast < 4.5) problems.push('The key text contrast is ' + contrast.toFixed(2) + ':1: it must be 4.5:1 or more.');
  const scrollBody = dialog.querySelector('.crucible-studio-shortcuts');
  const scrolls = scrollBody.scrollHeight > scrollBody.clientHeight;
  if (scrolls && scrollBody.offsetWidth - scrollBody.clientWidth <= 0) problems.push('The sheet scrolls but shows no scrollbar track: keep scrollbar-gutter stable and the thin scrollbar.');
  if (scrolls && scrollBody.scrollTop === 0 && scrollBody.dataset.more !== 'true') problems.push('The sheet has rows below but shows no fade at its bottom edge.');
  const tallRows = Array.from(dialog.querySelectorAll('.crucible-studio-shortcut-item')).filter(row => row.getBoundingClientRect().height > 20);
  if (tallRows.length > 0) problems.push('These sheet rows wrap to more than one line: ' + tallRows.map(row => row.textContent).join(', ') + '.');
  const dialogBox = dialog.getBoundingClientRect();
  const keyRights = Array.from(dialog.querySelectorAll('.crucible-studio-shortcut-keys')).map(keys => keys.getBoundingClientRect().right);
  const labelLefts = Array.from(dialog.querySelectorAll('.crucible-studio-shortcut-item > span:first-child')).map(label => label.getBoundingClientRect().left);
  const leftInset = Math.round((Math.min(...labelLefts) - dialogBox.left) * 10) / 10;
  const rightInset = Math.round((dialogBox.right - Math.max(...keyRights)) * 10) / 10;
  const scrollbarWidth = scrollBody.offsetWidth - scrollBody.clientWidth;
  const scrollbarLeft = scrollBody.getBoundingClientRect().right - scrollbarWidth;
  const scrollbarGap = Math.round((scrollbarLeft - Math.max(...keyRights)) * 10) / 10;
  if (scrolls && scrollbarGap < 8) problems.push('The key text ends ' + scrollbarGap + ' px from the scrollbar: keep at least 8.');
  if (!scrolls && Math.abs(leftInset - rightInset) > 1) problems.push('The text is ' + leftInset + ' px from the left edge of the sheet and ' + rightInset + ' px from the right one: they must match within 1 px.');
  const columnCount = dialog.querySelectorAll('.crucible-studio-shortcut-column').length;
  return { problems, numbers: { padding: insets[0], headGap, rowGap, groupGap, contrast: Number(contrast.toFixed(2)), columns: columnCount, scrolls, leftInset, rightInset, scrollbarGap } };
}

// With a short window the sheet scrolls inside itself: the last group is reachable and the title row with the close button stays in view.
async function probeShortWindow(page) {
  await page.locator('button.crucible-studio-menu-button', { hasText: 'Help' }).click();
  await page.locator('#crucible-studio-pop-help button', { hasText: 'Keyboard shortcuts' }).click();
  await page.waitForSelector('dialog.crucible-studio-shortcuts-dialog[open]');
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const body = document.querySelector('.crucible-studio-shortcuts');
    body.scrollTop = body.scrollHeight;
  });
  const state = await page.evaluate(() => {
    const dialog = document.querySelector('dialog.crucible-studio-shortcuts-dialog');
    const body = dialog.querySelector('.crucible-studio-shortcuts');
    const groups = Array.from(body.querySelectorAll('.crucible-studio-shortcut-group'));
    const lastRow = groups[groups.length - 1].querySelector('.crucible-studio-shortcut-item:last-child').getBoundingClientRect();
    const closeBox = dialog.querySelector('.crucible-studio-shortcuts-head button').getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    return {
      scrolls: body.scrollHeight > body.clientHeight,
      lastRowReachable: lastRow.bottom <= bodyBox.bottom + 1 && lastRow.top >= bodyBox.top,
      closeVisible: closeBox.top >= 0 && closeBox.bottom <= window.innerHeight && closeBox.right <= window.innerWidth,
    };
  });
  if (!state.scrolls || !state.lastRowReachable || !state.closeVisible) {
    throw new Error('In a 720 by 480 window the sheet must scroll inside itself, reach its last row and keep the close button in view: ' + JSON.stringify(state));
  }
  return { name: 'shortcut sheet 720x480 short window', records: await measure(page, 'dialog.crucible-studio-shortcuts-dialog') };
}

// The Help menu open, then the shortcut sheet opened from it. Escape must close the sheet and give the focus back to the Help button.
async function measureHelpMenu(page, theme, label) {
  const screens = [];
  await page.locator('button.crucible-studio-menu-button', { hasText: 'Help' }).click();
  await page.waitForTimeout(250);
  screens.push({ name: `help menu${label} (${theme})`, records: await measure(page, '#crucible-studio-pop-help') });
  await page.locator('#crucible-studio-pop-help button', { hasText: 'Keyboard shortcuts' }).click();
  await page.waitForSelector('dialog.crucible-studio-shortcuts-dialog[open]');
  await page.waitForTimeout(250);
  screens.push({ name: `shortcut sheet${label} (${theme})`, records: await measure(page, 'dialog.crucible-studio-shortcuts-dialog') });
  const probe = await page.evaluate(probeShortcutSheet);
  console.log(`Shortcut sheet${label} (${theme}): ${JSON.stringify(probe.numbers)}`);
  if (label === '' && probe.numbers.scrolls) {
    throw new Error(`In a 1280x720 window the shortcut sheet must fit without scrolling: ${JSON.stringify(probe.numbers)}`);
  }
  if (probe.problems.length > 0) throw new Error(probe.problems.join(' '));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const state = await page.evaluate(() => ({
    sheetOpen: document.querySelector('dialog.crucible-studio-shortcuts-dialog').open,
    focusedLabel: document.activeElement?.textContent ?? '',
  }));
  if (state.sheetOpen || state.focusedLabel !== 'Help') {
    throw new Error(`The shortcut sheet must close on Escape and return the focus to the Help button: it is ${state.sheetOpen ? 'still open' : 'closed'} and the focus is on "${state.focusedLabel}".`);
  }
  return screens;
}

// Every top bar menu button stays visible, single-line and reachable by pointer and keyboard at 720 px (#3376).
async function probeNarrowMenus(page, theme) {
  await waitForSettledLayout(page);
  const buttonInfo = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('.crucible-studio-menus .crucible-studio-menu-button'));
    return buttons.map(button => {
      const box = button.getBoundingClientRect();
      return {
        label: button.textContent.trim(),
        target: button.getAttribute('popovertarget'),
        display: getComputedStyle(button).display,
        width: box.width,
        height: box.height,
        left: box.left,
        right: box.right,
        windowWidth: window.innerWidth,
      };
    });
  });
  for (const item of buttonInfo) {
    if (item.display === 'none' || item.width <= 0 || item.height <= 0) {
      throw new Error(`Narrow 720 px top bar (${theme}) hides menu button "${item.label}".`);
    }
    if (item.height > 36 || item.left < 0 || item.right > item.windowWidth) {
      throw new Error(`Narrow 720 px top bar (${theme}) clips or wraps "${item.label}": ${JSON.stringify(item)}.`);
    }
    const locator = page.locator(`.crucible-studio-menus .crucible-studio-menu-button[popovertarget="${item.target}"]`);
    await locator.click();
    const openedByClick = await page.evaluate(id => document.getElementById(id)?.matches(':popover-open') ?? false, item.target);
    if (!openedByClick) throw new Error(`Narrow 720 px menu "${item.label}" (${theme}) failed to open on click.`);
    await page.keyboard.press('Escape');
    await locator.focus();
    await page.keyboard.press('Enter');
    const openedByKey = await page.evaluate(id => document.getElementById(id)?.matches(':popover-open') ?? false, item.target);
    if (!openedByKey) throw new Error(`Narrow 720 px menu "${item.label}" (${theme}) failed to open from keyboard.`);
    await page.keyboard.press('Escape');
  }
  return { name: `narrow top bar menus 720 (${theme})`, records: await measure(page, '.crucible-studio-menubar'), overlaps: await measureBarOverlaps(page) };
}

function openSettingsFromMenu(page) {
  return page.evaluate(() => [...document.querySelectorAll('.crucible-studio button')].find(button => button.textContent.trim().startsWith('Settings')).click());
}

const SETTINGS_FOOTER_GAP = 16;
const EXTRA_ROWS = 3;

// Runs in the page. Settings opened the way a person opens it, in a 600 px high window with three more rows than the longest section has:
// the dialog keeps its height, the rows scroll inside themselves, the last row stays at least 16 px above the footer, focus rests on the
// dialog, and Done is the one filled button.
function checkSettingsFit(extraRows, footerGap) {
  const dialog = document.querySelector('dialog.crucible-studio-settings-dialog');
  const problems = [];
  const report = (kind, detail, message) => problems.push({ kind, selector: 'crucible-studio-settings-dialog', detail, message });
  const heightOf = element => element.getBoundingClientRect().height;
  const rows = dialog.querySelector('.crucible-studio-settings-pane[data-section="viewport"] .crucible-studio-settings-rows');
  const clones = [];
  for (let index = 0; index < extraRows; index += 1) {
    const clone = rows.firstElementChild.cloneNode(true);
    clones.push(clone);
    rows.append(clone);
  }
  [...document.querySelectorAll('.crucible-studio button')].find(button => button.textContent.trim().startsWith('Settings')).click();
  if (document.activeElement !== dialog) report('settings-focus', 'open', 'Settings must open with focus on the dialog, so every section looks the same and no ring is drawn.');
  if (dialog.querySelector('.crucible-studio-settings-pane[data-current="true"]').dataset.section !== 'interface') report('settings-focus', 'section', 'Settings must open on its first section.');
  const heightBefore = heightOf(dialog);
  for (const section of ['interface', 'viewport', 'editing', 'keys']) {
    dialog.querySelector(`nav button[data-section="${section}"]`).click();
    const pane = dialog.querySelector(`.crucible-studio-settings-pane[data-section="${section}"]`);
    const area = pane.querySelector('.crucible-studio-settings-rows');
    const footer = dialog.querySelector('.crucible-studio-dialog-actions').getBoundingClientRect();
    if (Math.abs(heightOf(dialog) - heightBefore) > 0.5) report('settings-height', section, `The Settings dialog changed height on ${section} (${heightBefore} to ${heightOf(dialog)} px); it keeps one height.`);
    if (footer.top - area.getBoundingClientRect().bottom < footerGap) report('settings-footer-gap', section, `The rows of ${section} end less than ${footerGap} px above the footer.`);
    if (section === 'viewport' && area.scrollHeight <= area.clientHeight) report('settings-scroll', section, `With ${extraRows} more rows the Viewport rows must scroll inside themselves; they did not.`);
    const innerRight = dialog.getBoundingClientRect().right - parseFloat(getComputedStyle(dialog).paddingRight) - parseFloat(getComputedStyle(dialog).borderRightWidth);
    for (const control of area.querySelectorAll('select, input, button')) {
      if (control.getBoundingClientRect().right > innerRight + 0.5 && getComputedStyle(pane).visibility !== 'hidden') report('settings-inset', section, 'A control reaches past the dialog inset.');
    }
  }
  const buttons = [...dialog.querySelectorAll('.crucible-studio-dialog-actions button')];
  const fillOf = button => getComputedStyle(button).backgroundColor;
  const done = buttons.find(button => button.textContent === 'Done');
  if (buttons.some(button => button !== done && fillOf(button) === fillOf(done))) report('settings-primary', 'Done', 'Done must be the one filled button of the dialog.');
  dialog.close();
  for (const clone of clones) clone.remove();
  return problems;
}

async function measureSettingsFit(page) {
  await page.setViewportSize({ width: VIEWPORT.width, height: 600 });
  await page.waitForTimeout(250);
  const problems = await page.evaluate(`(${checkSettingsFit.toString()})(${EXTRA_ROWS}, ${SETTINGS_FOOTER_GAP})`);
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(250);
  return problems;
}

// Edit mode builds its own popover on the first Tab (the proportional editing settings), so enter it once and leave: the
// popover stays in the page and the loop below measures it with the others.
async function createEditModePopovers(page) {
  await page.keyboard.press('Tab');
  await page.waitForSelector('.crucible-studio[data-mesh-edit="true"]');
  await page.keyboard.press('Tab');
  await page.waitForSelector('.crucible-studio[data-mesh-edit="false"]');
}

async function measureScreens(page, theme, only) {
  const screens = [];
  if (!only || only === 'studio') screens.push({ name: `studio (${theme})`, records: await measure(page, '.crucible-studio') });
  if (!only || only === 'studio') {
    // The Modifiers tab with two blocks, one folded away from the default, so its cards and rows are measured too.
    // A narrow window starts with the panels put away: they are opened the way a person opens them, and put away again after.
    const panelsWerePutAway = await page.evaluate(() => document.querySelector('.crucible-studio').dataset.inspectorCollapsed === 'true');
    if (panelsWerePutAway) await page.click(PANELS_TOGGLE);
    await page.evaluate(() => window.__studioPage.setActiveTab('modifiers'));
    for (const modifier of ['mirror', 'array']) {
      await page.click('.crucible-studio-modifier-add');
      await page.click(`.crucible-studio-modifier-add-menu [data-modifier="${modifier}"]`);
    }
    // Scrolled to the end, so the bottom inset of the last block is measured too.
    await page.evaluate(() => document.querySelector('.crucible-studio-panels').scrollTo(0, 1e6));
    await page.waitForTimeout(250);
    screens.push({ name: `modifiers (${theme})`, records: await measure(page, '.crucible-studio') });
    await page.click('.crucible-studio-modifier-add');
    await page.evaluate(() => document.querySelector('.crucible-studio-panels').scrollTo(0, 0));
    await page.waitForTimeout(250);
    screens.push({ name: `modifiers add menu (${theme})`, records: await measure(page, '.crucible-studio') });
    await page.click('.crucible-studio-modifier-add');
    await page.evaluate(() => document.activeElement?.blur());
    // The two blocks are undone, so the screens after this one start from the plain object again: edit mode refuses a mesh with modifiers.
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelectorAll('.crucible-studio-modifier-list .crucible-studio-modifier-head').length === 0);
    await page.evaluate(() => window.__studioPage.setActiveTab('node'));
    if (panelsWerePutAway) await page.click(PANELS_TOGGLE);
  }
  if (!only || only === 'rename') screens.push(...await measureRenameScreens(page, theme));
  if (!only || only === 'popover') {
    await createEditModePopovers(page);
    const identifiers = await page.evaluate(() => Array.from(document.querySelectorAll('.crucible-studio [popover]')).map(element => element.id).filter(Boolean));
    for (const identifier of identifiers) {
      await page.evaluate(id => document.getElementById(id).showPopover(), identifier);
      await page.waitForTimeout(250);
      screens.push({ name: `${identifier} (${theme})`, records: await measure(page, `#${identifier}`) });
      await page.evaluate(id => document.getElementById(id).hidePopover(), identifier);
    }
  }
  if (!only || only === 'settings') {
    await openSettingsFromMenu(page);
    const sections = page.locator('.crucible-studio-settings-section');
    for (let index = 0; index < await sections.count(); index += 1) {
      await sections.nth(index).click();
      await page.waitForTimeout(200);
      const sectionName = await sections.nth(index).getAttribute('data-section');
      screens.push({ name: `settings ${sectionName} (${theme})`, records: await measure(page, 'dialog.crucible-studio-settings-dialog') });
    }
    await page.evaluate(() => document.querySelector('dialog.crucible-studio-settings-dialog').close());
    screens.push({ name: `settings fit (${theme})`, records: [], problems: await measureSettingsFit(page) });
  }
  if (!only || only === 'keyboard') screens.push(...await measureKeyboard(page, theme));
  if (!only || only === 'dialog') {
    const titles = await page.evaluate(() => Array.from(document.querySelectorAll('.crucible-studio dialog:not(.crucible-studio-setup-dialog)')).map(dialog => dialog.querySelector('h2')?.id).filter(Boolean));
    for (const title of titles) {
      await page.evaluate(identifier => document.getElementById(identifier).closest('dialog').showModal(), title);
      await page.waitForTimeout(250);
      screens.push({ name: `${title.replace('crucible-studio-', '')} dialog (${theme})`, records: await measure(page, `dialog:has(#${title})`) });
      await page.evaluate(identifier => document.getElementById(identifier).closest('dialog').close(), title);
    }
  }
  if (!only || only === 'notice') screens.push(...await measureNotices(page, theme));
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
  if (!only || only === 'newscene') screens.push(...await measureNewSceneScreens(page, theme));
  return screens;
}

// The File menu with Open recent expanded over a few remembered scenes, which the page keeps in its own storage.
async function measureRecentMenu(page, theme) {
  await page.evaluate(() => {
    const entries = ['porch.scene.json', 'a-long-scene-name-that-has-to-be-cut-by-the-menu-width.scene.json', 'trip.scene.json'].map((name, index) => ({ id: `seed-${index}`, name, kind: 'copy' }));
    localStorage.setItem('crucible.studio.recent', JSON.stringify(entries));
  });
  await page.locator('.crucible-studio-menu-button', { hasText: 'File' }).click();
  await page.locator('#crucible-studio-pop-new button[aria-controls="crucible-studio-recent-list"]:not([disabled])').click();
  await page.waitForSelector('#crucible-studio-recent-list:not([hidden]) button');
  await page.waitForTimeout(250);
  const screen = { name: `file menu with recent scenes (${theme})`, records: await measure(page, '#crucible-studio-pop-new') };
  await page.evaluate(() => {
    localStorage.removeItem('crucible.studio.recent');
    document.getElementById('crucible-studio-pop-new').hidePopover();
  });
  return screen;
}

// The chooser with every picture loaded, then the question about unsaved changes that a change to the scene brings up.
async function measureNewSceneScreens(page, theme) {
  const screens = [];
  await page.evaluate(() => { window.__newSceneChoice = window.__studioPage.openNewScene(); });
  await page.waitForSelector('dialog.crucible-studio-new-dialog[open]');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.crucible-studio-new-card img')).every(picture => picture.complete && picture.naturalWidth > 0));
  await page.waitForTimeout(200);
  screens.push({ name: `new scene (${theme})`, records: await measure(page, 'dialog.crucible-studio-new-dialog') });
  await page.evaluate(() => window.__studioPage.controller.updateNodeTransform('cube', { translation: [1.5, 0.5, 0] }));
  await page.locator('.crucible-studio-new-card').nth(1).click();
  await page.waitForSelector('dialog.crucible-studio-confirm-dialog[open]');
  await page.waitForTimeout(200);
  const confirmButtonHeights = await page.evaluate(() => Array.from(document.querySelectorAll('dialog.crucible-studio-confirm-dialog .crucible-studio-dialog-actions button')).map(button => button.getBoundingClientRect().height));
  screens.push({ name: `unsaved changes (${theme})`, records: await measure(page, 'dialog.crucible-studio-confirm-dialog'), buttonRowHeights: confirmButtonHeights });
  await page.locator('dialog.crucible-studio-confirm-dialog button', { hasText: 'Cancel' }).click();
  await page.evaluate(() => window.__newSceneChoice);
  screens.push(await measureRecentMenu(page, theme));
  return screens;
}

// The Export workspace as a person finds it, then with each export done: the result lines show under the actions.
export async function measureExportScreens(page, theme, viewport) {
  const screens = [];
  // A narrow window starts with the panels closed; the Export panel is what this measures, so it is opened.
  await page.evaluate(() => {
    window.__studioPage.setInspectorCollapsed(false);
    window.__studioPage.setActiveTab('export');
  });
  await page.waitForTimeout(300);
  screens.push({ name: `export workspace ${viewport.width} (${theme})`, records: await measure(page, '.crucible-studio') });
  await page.evaluate(async () => {
    for (const kind of ['image', 'model', 'pack']) {
      document.querySelector(`[data-export="${kind}"]`).click();
      await new Promise(resolveWait => setTimeout(resolveWait, 400));
    }
  });
  await page.waitForTimeout(300);
  screens.push({ name: `export results ${viewport.width} (${theme})`, records: await measure(page, '.crucible-studio') });
  return screens;
}

export async function runSelectionBehavior({ origin } = {}) {
  const server = origin ? { origin, stop: () => {} } : await startDevServer();
  const browser = await launchBrowser();
  try {
    const { context, page } = await openStudio(browser, server.origin, 'dark');
    const checks = await probeSelectionBehavior(page);
    await context.close();
    return checks;
  } finally {
    await browser.close();
    server.stop();
  }
}

// The Edit menu open, with its History row. When STUDIO_AUDIT_STILLS names a folder, each screen is also saved there as a picture.
async function measureEditMenu(page, theme, label) {
  const capture = createCapture(page, theme, label);
  await page.locator('.crucible-studio-menu-button', { hasText: 'Edit' }).click();
  await capture('edit menu', '#crucible-studio-pop-edit');
  return capture.screens;
}

function createCapture(page, theme, label) {
  const screens = [];
  const stillsFolder = process.env.STUDIO_AUDIT_STILLS;
  const capture = async (name, selector, extra = {}) => {
    // The pointer waits away from the list, so no row shows the highlight of a hover.
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height - 24);
    await page.waitForTimeout(250);
    screens.push({ name: `${name}${label} (${theme})`, records: await measure(page, selector), ...extra });
    if (stillsFolder) await page.screenshot({ path: `${stillsFolder}/${name.replace(/ /g, '-')}${label.replace(/ /g, '-')}-${theme}.png` });
  };
  capture.screens = screens;
  return capture;
}

// The column rule and the whole-row rule, measured: History is a whole number of rows, at most six (four in a compact window), the
// first row shown starts at the top of the list, History takes at most a third of the column and leaves Properties 240 px or more,
// and a dimmed row is the plain muted token with no opacity on top of it. Returns the Properties height for the collapsed check.
async function checkHistoryLayout(page) {
  const found = await page.evaluate(() => {
    const root = document.querySelector('.crucible-studio');
    const list = document.querySelector('.crucible-studio-history-list');
    const rows = [...list.children];
    const style = getComputedStyle(list);
    const gap = parseFloat(style.rowGap);
    const padding = parseFloat(style.paddingTop);
    const pitch = rows[0].getBoundingClientRect().height + gap;
    const listBox = list.getBoundingClientRect();
    const wholeRows = (list.clientHeight - padding * 2 + gap) / pitch;
    const firstShown = rows.find(row => row.getBoundingClientRect().bottom > listBox.top + 1);
    const inspector = document.querySelector('.crucible-studio-inspector');
    const undone = rows.find(row => row.dataset.state === 'undone');
    const lastBox = rows.at(-1).getBoundingClientRect();
    const probe = document.createElement('span');
    probe.style.color = 'var(--studio-muted)';
    root.append(probe);
    const mutedColor = getComputedStyle(probe).color;
    probe.remove();
    return {
      compact: root.dataset.compact === 'true',
      wholeRows,
      lastRowCut: lastBox.bottom - listBox.bottom,
      firstTopGap: firstShown.getBoundingClientRect().top - listBox.top,
      columnHeight: document.querySelector('.crucible-studio-side').getBoundingClientRect().height,
      historyHeight: document.querySelector('.crucible-studio-history').getBoundingClientRect().height,
      inspectorHeight: inspector.getBoundingClientRect().height,
      inspectorShown: getComputedStyle(inspector).display !== 'none',
      undoneOpacity: getComputedStyle(undone).opacity,
      nameOpacity: getComputedStyle(undone.querySelector('.crucible-studio-history-name')).opacity,
      nameColor: getComputedStyle(undone.querySelector('.crucible-studio-history-name')).color,
      mutedColor,
    };
  });
  const expect = (condition, message) => {
    if (!condition) throw new Error(`History panel layout: ${message}: ${JSON.stringify(found)}`);
  };
  expect(Math.abs(found.wholeRows - Math.round(found.wholeRows)) < 0.02, 'the list is not a whole number of rows tall');
  expect(found.firstTopGap >= -0.5, 'the first row shown starts above the top of the list');
  expect(found.lastRowCut <= 1, 'the newest row is cut at the bottom of the list');
  expect(Math.round(found.wholeRows) <= (found.compact ? 4 : 6), 'the list shows more rows than its limit');
  if (!found.compact) {
    expect(found.historyHeight <= found.columnHeight / 3 + 1, 'History takes more than a third of the column');
    expect(found.inspectorShown && found.inspectorHeight >= 239, 'Properties is under 240 px');
  }
  expect(found.undoneOpacity === '1' && found.nameOpacity === '1', 'a dimmed row also has an opacity');
  expect(found.nameColor === found.mutedColor, 'the text of a dimmed row is not the plain muted token');
  return found;
}

// The scroll cue of the panel column: a body whose content is taller than its card shows a scrollbar track at least 6 px wide, the
// fade marker is set on the edge that hides content (top once scrolled down, bottom while more remains) and on no other edge, and
// the fade is a real mask. A body that does not scroll carries no marker.
async function checkScrollCue(page, step) {
  const found = await page.evaluate(() => [
    '.crucible-studio-panels',
    '.crucible-studio-history-list',
    '.crucible-studio-agent-list',
    '.crucible-studio-tree',
  ].map(selector => {
    const body = document.querySelector(selector);
    const shown = Boolean(body) && body.getBoundingClientRect().height > 0;
    if (!shown) return { selector, shown };
    const hiddenBelow = body.scrollHeight - body.clientHeight - body.scrollTop;
    return {
      selector,
      shown,
      scrolls: body.scrollHeight - body.clientHeight > 1,
      trackWidth: body.offsetWidth - body.clientWidth,
      hiddenAbove: body.scrollTop > 1,
      hiddenBelow: hiddenBelow > 1,
      fadeTop: body.dataset.fadeTop === 'true',
      fadeBottom: body.dataset.fadeBottom === 'true',
      masked: getComputedStyle(body).maskImage !== 'none',
    };
  }));
  for (const body of found.filter(entry => entry.shown)) {
    const fail = message => { throw new Error(`Scroll cue (${step}): ${body.selector} ${message}: ${JSON.stringify(body)}`); };
    if (body.scrolls && body.trackWidth < 6) fail('scrolls but shows no scrollbar track');
    if (body.scrolls && body.hiddenAbove !== body.fadeTop) fail('has the top fade marker wrong');
    if (body.scrolls && body.hiddenBelow !== body.fadeBottom) fail('has the bottom fade marker wrong');
    if (!body.scrolls && (body.fadeTop || body.fadeBottom)) fail('carries a fade marker without scrolling');
    if ((body.fadeTop || body.fadeBottom) && !body.masked) fail('has a fade marker but no fade');
  }
  return found;
}

// What a person does in the History panel, in a real browser: Edit > History shows it with focus on the current row, a click on
// an earlier row steps back and dims the rows after it, a click on a dimmed row steps forward, and a new edit drops the dimmed rows.
async function checkHistoryBehavior(page) {
  const state = () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('.crucible-studio-history-row')];
    const colorOf = state => {
      const row = rows.find(candidate => candidate.dataset.state === state);
      return row ? getComputedStyle(row).color : null;
    };
    const list = document.querySelector('.crucible-studio-history-list');
    const listStyle = getComputedStyle(list);
    return {
      states: rows.map(row => row.dataset.state),
      focusedState: document.activeElement?.dataset?.state ?? null,
      currentColor: colorOf('current'),
      doneColor: colorOf('done'),
      undoneColor: colorOf('undone'),
      listInsets: [listStyle.paddingTop, listStyle.paddingRight, listStyle.paddingBottom, listStyle.paddingLeft],
      currentVisible: (() => {
        const current = rows.find(row => row.dataset.state === 'current')?.getBoundingClientRect();
        const box = list.getBoundingClientRect();
        return Boolean(current) && current.top >= box.top - 1 && current.bottom <= box.bottom + 1;
      })(),
    };
  });
  const expect = (condition, message, found) => {
    if (!condition) throw new Error(`History panel behavior: ${message}: ${JSON.stringify(found)}`);
  };
  await page.locator('.crucible-studio-menu-button', { hasText: 'Edit' }).click();
  await page.locator('#crucible-studio-pop-edit button', { hasText: 'History' }).click();
  let found = await state();
  expect(found.states.filter(value => value === 'undone').length === 2, 'two rows are undone', found);
  expect(found.focusedState === 'current', 'focus starts on the current row', found);
  expect(found.currentVisible, 'the current row is scrolled into view', found);
  expect(found.undoneColor !== found.currentColor && found.undoneColor !== found.doneColor, 'dimmed rows differ from the current row and the done rows', found);
  expect(new Set(found.listInsets).size === 1, 'the list has even insets', found);
  await page.locator('.crucible-studio-history-row[data-state="undone"]').last().click();
  found = await state();
  expect(found.states.at(-1) === 'current' && !found.states.includes('undone'), 'a click on the last dimmed row steps forward to it', found);
  await page.locator('.crucible-studio-history-row[data-state="done"]').nth(2).click();
  found = await state();
  expect(found.states.filter(value => value === 'undone').length >= 1, 'a click on an earlier row dims the rows after it', found);
  await page.evaluate(() => window.__studioPage.controller.updateNodeTransform('cube', { translation: [2, 0.5, 0] }));
  found = await state();
  expect(!found.states.includes('undone') && found.states.at(-1) === 'current', 'a new edit removes the dimmed rows', found);
}

// The History panel after six edits, two of them undone, shown through Edit > History.
async function measureHistoryPanel(page, theme, label) {
  await page.evaluate(() => {
    const controller = window.__studioPage.controller;
    controller.updateNodeTransform('cube', { translation: [1, 0.5, 0] });
    controller.updateNodeTransform('cube', { rotationDegrees: [0, 45, 0] });
    controller.updateNodeTransform('cube', { scale: [1.2, 1.2, 1.2] });
    controller.addPrimitive('box');
    controller.updateNodeTransform('cube', { visible: false });
    controller.updateNodeTransform('cube', { visible: true });
    controller.undo();
    controller.undo();
  });
  const capture = createCapture(page, theme, label);
  await page.locator('.crucible-studio-menu-button', { hasText: 'Edit' }).click();
  await page.locator('#crucible-studio-pop-edit button', { hasText: 'History' }).click();
  await page.waitForSelector('.crucible-studio-history:not([hidden])');
  const menuStillOpen = await page.evaluate(() => document.getElementById('crucible-studio-pop-edit').matches(':popover-open'));
  if (menuStillOpen) throw new Error('History panel behavior: the Edit menu stays open over the scene after History is chosen');
  await capture('history panel', '.crucible-studio-history');
  const layout = await checkHistoryLayout(page);
  await page.waitForTimeout(100);
  await checkScrollCue(page, 'History shown');
  await page.evaluate(() => { document.querySelector('.crucible-studio-history-list').scrollTop = 0; });
  await page.waitForTimeout(100);
  await checkScrollCue(page, 'History at the first row');
  await page.evaluate(() => { const list = document.querySelector('.crucible-studio-history-list'); list.scrollTop = list.scrollHeight; });
  await page.waitForTimeout(100);
  await checkScrollCue(page, 'History at the last row');
  await page.locator('.crucible-studio-history button[aria-label="Minimize History"]').click();
  await capture('history panel collapsed', '.crucible-studio-history');
  const collapsed = await page.evaluate(() => ({
    minimized: document.querySelector('.crucible-studio').dataset.historyMinimized,
    historyHeight: document.querySelector('.crucible-studio-history').getBoundingClientRect().height,
    inspectorHeight: document.querySelector('.crucible-studio-inspector').getBoundingClientRect().height,
  }));
  await page.waitForTimeout(100);
  await checkScrollCue(page, 'History minimized');
  if (collapsed.minimized !== 'true' || collapsed.historyHeight > 60) throw new Error(`History panel layout: it does not collapse to its title row: ${JSON.stringify(collapsed)}`);
  if (!layout.compact && collapsed.inspectorHeight <= layout.inspectorHeight) throw new Error(`History panel layout: Properties does not get the room back: ${JSON.stringify({ collapsed, layout })}`);
  await page.locator('.crucible-studio-history button[aria-label="Expand History"]').click();
  await checkHistoryBehavior(page);
  return capture.screens;
}

// The column rule for the Agent card, measured. Stacked, it ends inside the column with the same bottom gap as the other cards,
// Scene keeps 192 px and Properties 240 px beside it. In a window too short for that the card and Properties take turns, both
// keep a title row in the column and the one that is away folds to it, and in a compact window the card lies over the scene. The list keeps four whole rows (112 px) and nothing scrolls
// sideways. Returns the rectangles, which the stills report.
async function checkAgentLayout(page, step) {
  const found = await page.evaluate(() => {
    const rectOf = selector => {
      const element = document.querySelector(selector);
      const visible = element && getComputedStyle(element).display !== 'none';
      return visible ? element.getBoundingClientRect() : null;
    };
    const rounded = rect => rect && { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) };
    const root = document.querySelector('.crucible-studio');
    const card = rectOf('.crucible-studio-agent');
    const column = rectOf('.crucible-studio-side');
    const scene = rectOf('.crucible-studio-outliner');
    const properties = rectOf('.crucible-studio-inspector');
    const list = document.querySelector('.crucible-studio-agent-list');
    const compact = root.dataset.compact === 'true';
    const above = properties ?? scene;
    return {
      compact,
      tight: root.dataset.agentTight === 'true',
      card: rounded(card),
      scene: rounded(scene),
      properties: rounded(properties),
      columnBottom: compact ? window.innerHeight : Math.round(column.bottom),
      bottomGap: Math.round((compact ? window.innerHeight : column.bottom) - card.bottom),
      gapAbove: compact || !above ? null : Math.round(card.top - above.bottom),
      listHeight: Math.round(list.clientHeight),
      sidewaysScroll: list.scrollWidth > list.clientWidth + 1,
      fieldFits: document.querySelector('.crucible-studio-agent-field').getBoundingClientRect().right <= card.right,
      lastRowInside: card.height <= 60 ? null : Math.round(card.bottom - Math.max(...['.crucible-studio-agent-status', '.crucible-studio-agent-field'].map(selector => rectOf(selector)?.bottom ?? 0))),
    };
  });
  const expect = (condition, message) => {
    if (!condition) throw new Error(`Agent card layout (${step}): ${message}: ${JSON.stringify(found)}`);
  };
  expect(found.bottomGap >= (found.compact ? 0 : 7), 'the card ends past the column bottom or without its bottom gap');
  expect(found.lastRowInside === null || found.lastRowInside >= 7, 'the last row of the bar (the status row, or the field) is under 7 px from the card bottom, so it is cut or touches the edge');
  expect(!found.sidewaysScroll, 'the list scrolls sideways');
  expect(found.fieldFits, 'the message field runs past the card');
  expect(found.listHeight >= 112 || found.card.height <= 60, 'the list is under four whole rows');
  if (!found.compact) {
    expect(found.gapAbove >= 3 && found.gapAbove <= 5, 'the gap above the card is not the column gap');
    expect(found.scene.height >= 191, 'the Scene card is under its floor');
    expect(found.tight ? found.properties !== null && found.properties.height <= 60 : found.properties.height >= 239, 'Properties is under its floor, or is not folded to its title row while the card has the turn');
  }
  return found;
}

// The host's status: the row of model, effort and mode and the usage ring, at each level, with the popover of its numbers. The
// ring stands in the middle of the field's height, the row has the room it needs, and the popover stays inside the window.
const STATUS_LEVELS = Object.freeze([['plenty', 10], ['half', 30], ['low', 42], ['empty', 50]]);
async function checkStatusBar(page, capture) {
  await page.evaluate(() => window.__sampleChat.emit({ type: 'status', model: 'Fable 5.2', effort: 'high', mode: 'Plan' }));
  for (const [level, used] of STATUS_LEVELS) {
    await page.evaluate(spent => window.__sampleChat.emit({ type: 'usage', used: spent, limit: 50, resetsAt: Date.UTC(2026, 11, 1, 12) }), used);
    await page.waitForTimeout(300);
    await capture(`agent card status ${level}`, '.crucible-studio-agent');
    const found = await page.evaluate(() => {
      const ring = document.querySelector('.crucible-studio-agent-usage');
      const field = document.querySelector('.crucible-studio-agent-field');
      const svg = ring.querySelector('svg').getBoundingClientRect();
      const fieldBox = field.getBoundingClientRect();
      const items = [...document.querySelectorAll('.crucible-studio-agent-status-item')];
      const cardBox = document.querySelector('.crucible-studio-agent').getBoundingClientRect();
      return {
        level: ring.dataset.level,
        name: ring.getAttribute('aria-label'),
        centreOffset: Math.round(Math.abs((svg.top + svg.bottom) / 2 - (fieldBox.top + fieldBox.bottom) / 2)),
        items: items.map(item => item.dataset.field),
        itemsInside: items.every(item => item.getBoundingClientRect().right <= cardBox.right && item.getBoundingClientRect().left >= cardBox.left),
        fieldWidth: Math.round(fieldBox.width),
      };
    });
    if (found.level !== level) throw new Error(`Agent status behavior: the ring is at level ${found.level}, not ${level}: ${JSON.stringify(found)}`);
    if (found.centreOffset > 1) throw new Error(`Agent status layout (${level}): the ring is off the middle of the field: ${JSON.stringify(found)}`);
    if (found.items.join() !== 'model,effort,mode' || !found.itemsInside) throw new Error(`Agent status layout (${level}): the row is not the three values inside the card: ${JSON.stringify(found)}`);
    if (found.fieldWidth < 120) throw new Error(`Agent status layout (${level}): the field is under 120 px wide: ${JSON.stringify(found)}`);
    await checkAgentLayout(page, `status ${level}`);
  }
  await page.evaluate(() => window.__sampleChat.emit({ type: 'status', model: 'W'.repeat(40), effort: 'high', mode: 'Plan' }));
  await page.waitForTimeout(150);
  const longName = await page.evaluate(() => {
    const row = document.querySelector('.crucible-studio-agent-status');
    const values = row.querySelector('.crucible-studio-agent-status-values').getBoundingClientRect();
    const shownItems = [...row.querySelectorAll('.crucible-studio-agent-status-item')].map(item => item.getBoundingClientRect()).filter(box => box.top < values.bottom);
    return { rowHeight: Math.round(row.getBoundingClientRect().height), shownItems: shownItems.length, cutItem: shownItems.some(box => box.right > values.right + 1) };
  });
  if (longName.rowHeight > 18 || longName.shownItems < 1 || longName.cutItem) throw new Error(`Agent status layout: a long model name does not keep the row to one line, with whole values only: ${JSON.stringify(longName)}`);
  await page.evaluate(() => window.__sampleChat.emit({ type: 'status', model: 'Fable 5.2', effort: 'high', mode: 'Plan' }));
  await page.locator('.crucible-studio-agent-usage').focus();
  await page.waitForSelector('.crucible-studio-agent-usage-tip:popover-open');
  await page.waitForTimeout(250);
  const tip = await page.evaluate(() => {
    const box = document.querySelector('.crucible-studio-agent-usage-tip').getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, text: document.querySelector('.crucible-studio-agent-usage-tip').textContent, width: window.innerWidth, height: window.innerHeight };
  });
  if (tip.left < 0 || tip.top < 0 || tip.right > tip.width || tip.bottom > tip.height) throw new Error(`Agent status layout: the popover runs outside the window: ${JSON.stringify(tip)}`);
  if (!/^0 of 50 credits left/.test(tip.text) || !/Resets \d+ Dec/.test(tip.text)) throw new Error(`Agent status behavior: the popover does not say the numbers: ${tip.text}`);
  await capture('agent card status popover', '.crucible-studio-side');
  await page.keyboard.press('Escape');
  const stillOpen = await page.evaluate(() => document.querySelector('.crucible-studio-agent-usage-tip').matches(':popover-open'));
  if (stillOpen) throw new Error('Agent status behavior: Esc does not close the popover');
  await page.evaluate(() => window.__sampleChat.emit({ type: 'usage', used: 10, limit: 50 }));
}

// An error the host says is free to repeat: the button and its word sit under the message inside the card, and pressing it
// takes the offer away and starts the run again.
async function checkFreeRetry(page, capture) {
  await page.evaluate(() => window.__sampleChat.emit({ type: 'error', message: 'The agent stopped before it finished', retryFree: true }));
  await page.waitForSelector('.crucible-studio-agent-retry button');
  await capture('agent card retry free', '.crucible-studio-agent');
  const found = await page.evaluate(() => {
    const row = document.querySelector('.crucible-studio-agent-outcome[data-retry="true"]');
    const button = row.querySelector('button').getBoundingClientRect();
    const hint = row.querySelector('.crucible-studio-agent-retry-hint').getBoundingClientRect();
    const card = document.querySelector('.crucible-studio-agent').getBoundingClientRect();
    const message = row.querySelector('.crucible-studio-agent-line').getBoundingClientRect();
    return { buttonText: row.querySelector('button').textContent, hintText: row.querySelector('.crucible-studio-agent-retry-hint').textContent, inside: button.right <= card.right && hint.right <= card.right, belowMessage: button.top >= message.bottom - 1, sameLine: Math.abs((button.top + button.bottom) / 2 - (hint.top + hint.bottom) / 2) <= 1 };
  });
  if (found.buttonText !== 'Try again' || found.hintText !== 'Free' || !found.inside || !found.belowMessage || !found.sameLine) throw new Error(`Agent card layout: the free retry is not laid out: ${JSON.stringify(found)}`);
  await checkAgentLayout(page, 'retry free');
  await page.locator('.crucible-studio-agent-retry button').click();
  await page.waitForFunction(() => !document.querySelector('.crucible-studio-agent-retry'));
  await page.waitForFunction(() => document.querySelector('.crucible-studio-agent-send').textContent === 'Send', null, { timeout: 5000 });
}

// In a window too short to stack the cards, both title rows stay in the column, each with a name a screen reader says, and
// pressing the one that is away gives it the room. The card is then open for the checks that follow.
async function checkShortWindowTurns(page, capture) {
  const state = await page.evaluate(() => {
    const root = document.querySelector('.crucible-studio');
    const nameOf = selector => document.querySelector(selector)?.getAttribute('aria-label') ?? null;
    const titleRow = selector => {
      const element = document.querySelector(selector);
      return element && getComputedStyle(element).display !== 'none' ? Math.round(element.getBoundingClientRect().height) : null;
    };
    const propertiesButton = [...document.querySelectorAll('.crucible-studio-inspector button')].find(button => /^(Minimize|Expand) Properties$/.test(button.getAttribute('aria-label') ?? ''));
    return {
      tight: root.dataset.agentTight === 'true',
      agentName: nameOf('.crucible-studio-agent button[aria-label]'),
      agentHeight: titleRow('.crucible-studio-agent'),
      propertiesName: propertiesButton?.getAttribute('aria-label') ?? null,
      propertiesHeight: titleRow('.crucible-studio-inspector'),
    };
  });
  if (!state.tight) return;
  const problems = [];
  if (state.agentName !== 'Expand Agent') problems.push('the Agent title row does not offer "Expand Agent" while Properties has the room');
  if (!state.agentHeight || state.agentHeight > 60) problems.push('the Agent title row is not in the column');
  if (!state.propertiesName) problems.push('Properties has no named collapse control');
  if (problems.length) throw new Error(`Agent card layout (short window): ${problems.join('; ')}: ${JSON.stringify(state)}`);
  await capture('agent card away, Properties open', '.crucible-studio-side');
  await page.locator('.crucible-studio-agent button[aria-label="Expand Agent"]').click();
  await page.waitForTimeout(300);
  const turned = await page.evaluate(() => [...document.querySelectorAll('.crucible-studio-inspector button')].map(button => button.getAttribute('aria-label')).find(name => /Properties$/.test(name ?? '')));
  if (turned !== 'Expand Properties') throw new Error(`Agent card layout (short window): Properties does not fold to a titled row when the card opens: ${turned}`);
}

// The Agent card with a sample host: empty, a run streaming with its steps, the reply, one notice of each kind outside the list,
// and minimized. A window too short to stack the cards, and a compact one, start with the card closed, and the View menu is not
// in the bar of a compact window, so the key shows it.
async function measureAgentCard(page, theme, label) {
  const capture = createCapture(page, theme, label);
  const shown = await page.evaluate(() => document.querySelector('.crucible-studio').dataset.agentCollapsed === 'false');
  if (!shown) {
    await page.evaluate(() => document.querySelector('.crucible-studio canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'µ', code: 'KeyM', altKey: true, bubbles: true })));
  }
  await page.waitForSelector('.crucible-studio-agent');
  await page.waitForTimeout(300);
  await checkShortWindowTurns(page, capture);
  await capture('agent card empty', '.crucible-studio-agent');
  await checkAgentLayout(page, 'empty');
  await checkStatusBar(page, capture);
  await page.locator('.crucible-studio-agent-field').fill('Lift the cube and make it a little larger');
  await page.locator('.crucible-studio-agent-field').press('Enter');
  await page.waitForSelector('.crucible-studio-agent-step');
  await capture('agent card streaming', '.crucible-studio-agent');
  const streaming = await page.evaluate(() => document.querySelector('.crucible-studio-agent-send').textContent);
  if (streaming !== 'Stop') throw new Error(`Agent card behavior: the Send button reads "${streaming}" while a run goes on, not "Stop"`);
  await page.waitForSelector('.crucible-studio-agent-outcome');
  await checkAgentLayout(page, 'replied');
  await checkScrollCue(page, 'Agent replied');
  await capture('agent card replied', '.crucible-studio-agent');
  await checkFreeRetry(page, capture);
  const notices = [
    ['signedOut', 'Sign in to keep working', 'Sign in'],
    ['quota-warning', 'Credits are running low this month', 'Buy credits'],
    ['quota', 'No credits left for this month', 'Buy credits'],
    ['error', 'The agent could not be reached', 'Try again'],
  ];
  for (const [kind, message, actionLabel] of notices) {
    await page.evaluate(([noticeKind, noticeMessage, noticeAction]) => {
      window.__sampleChat.emit({ type: 'notice', kind: noticeKind, message: noticeMessage, actionLabel: noticeAction, action: () => {} });
    }, [kind, message, actionLabel]);
    await capture(`agent card notice ${kind}`, '.crucible-studio-agent');
    const noticeInsideList = await page.evaluate(() => Boolean(document.querySelector('.crucible-studio-agent-list .crucible-studio-agent-notice')));
    if (noticeInsideList) throw new Error('Agent card behavior: a notice shows inside the message list');
    await checkAgentLayout(page, `notice ${kind}`);
    await page.locator('.crucible-studio-agent-notice button').click();
  }
  await page.locator('.crucible-studio-agent button[aria-label="Minimize Agent"]').click();
  await capture('agent card minimized', '.crucible-studio-agent');
  const minimized = await page.evaluate(() => {
    const card = document.querySelector('.crucible-studio-agent').getBoundingClientRect();
    const compact = document.querySelector('.crucible-studio').dataset.compact === 'true';
    const above = [...document.querySelectorAll('.crucible-studio-inspector, .crucible-studio-outliner')].filter(element => getComputedStyle(element).display !== 'none').map(element => element.getBoundingClientRect().bottom).sort((a, b) => b - a)[0];
    return { height: card.height, gapAbove: compact ? null : Math.round(card.top - above), label: document.querySelector('.crucible-studio-agent button[aria-label]').getAttribute('aria-label'), title: document.querySelector('.crucible-studio-agent button[aria-label]').title };
  });
  if (minimized.height > 60) throw new Error(`Agent card layout: it does not fold to its title row: ${JSON.stringify(minimized)}`);
  if (minimized.gapAbove !== null && (minimized.gapAbove < 3 || minimized.gapAbove > 5)) throw new Error(`Agent card layout: the gap above the minimized card is not the column gap: ${JSON.stringify(minimized)}`);
  if (minimized.label !== 'Expand Agent' || minimized.title !== 'Expand Agent') throw new Error(`Agent card behavior: the minimized button does not say what it does: ${JSON.stringify(minimized)}`);
  await page.locator('.crucible-studio-agent button[aria-label="Expand Agent"]').click();
  return capture.screens;
}

// Runs on a page loaded with a seeded draft, so the draft notice is there on its own and the paused notice comes from a real
// lost WebGL context. The dialogs are opened the way the menu opens them, with showModal.
async function measureNoticesAndDialogs(page, theme, label) {
  const screens = [];
  await page.waitForSelector('.crucible-studio-draft:not([hidden])');
  screens.push({ name: `draft notice${label} (${theme})`, records: await measure(page, '.crucible-studio-draft') });
  for (const [dialogName, selector] of Object.entries(DIALOG_SELECTORS)) {
    await page.evaluate(dialogSelector => document.querySelector(dialogSelector).showModal(), selector);
    await page.waitForTimeout(250);
    screens.push({ name: `${dialogName}${label} (${theme})`, records: await measure(page, selector) });
    await page.evaluate(dialogSelector => document.querySelector(dialogSelector).close(), selector);
  }
  await page.locator('.crucible-studio-draft button', { hasText: 'Discard' }).click();
  await page.evaluate(() => {
    const canvas = document.querySelector('.crucible-studio canvas');
    const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    context.getExtension('WEBGL_lose_context').loseContext();
  });
  await page.waitForSelector('.crucible-studio-paused:not([hidden])');
  screens.push({ name: `paused notice${label} (${theme})`, records: await measure(page, '.crucible-studio-paused') });
  return screens;
}

// The four workspace tabs in order with icons, plus the empty-selection panel state in Build/Look/Animate/Export at 1280 and 720 px (#3370).
async function measureWorkspaceTabs(page, theme, viewport) {
  const screens = [];
  await page.evaluate(() => {
    window.__studioPage.selectNode(null);
    window.__studioPage.setInspectorCollapsed(false);
  });
  await waitForSettledLayout(page);
  for (const workspaceId of ['build', 'look', 'animate', 'export']) {
    await page.click(`.crucible-studio-workspaces button[data-workspace="${workspaceId}"]`);
    if (workspaceId === 'animate') {
      await page.click('#crucible-studio-tab-node');
    }
    await waitForSettledLayout(page);
    await page.waitForTimeout(200);
    const barState = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('.crucible-studio-workspaces button'));
      const bar = document.querySelector('.crucible-studio-workspaces').getBoundingClientRect();
      return {
        order: buttons.map(button => button.dataset.workspace),
        labels: buttons.map(button => button.getAttribute('aria-label')),
        items: buttons.map(button => {
          const box = button.getBoundingClientRect();
          const icon = button.querySelector('svg')?.getBoundingClientRect();
          return {
            id: button.dataset.workspace,
            width: box.width,
            height: box.height,
            insideBar: box.left >= bar.left - 0.5 && box.right <= bar.right + 0.5,
            iconWidth: icon?.width ?? 0,
            iconHeight: icon?.height ?? 0,
          };
        }),
      };
    });
    if (barState.order.join(',') !== 'build,look,animate,export' || barState.labels.join(',') !== 'Build,Look,Animate,Export') {
      throw new Error(`Workspace tab order mismatch at ${viewport.width} (${theme}): ${JSON.stringify(barState)}`);
    }
    for (const item of barState.items) {
      if (!(item.width > 0 && item.height > 0 && item.height <= 36 && item.insideBar && item.iconWidth > 0 && item.iconHeight > 0)) {
        throw new Error(`Workspace tab "${item.id}" failed fit/icon check at ${viewport.width} (${theme}): ${JSON.stringify(item)}`);
      }
    }
    screens.push({
      name: `workspace ${workspaceId} empty ${viewport.width} (${theme})`,
      records: await measure(page, '.crucible-studio'),
      overlaps: await measureBarOverlaps(page),
    });
  }
  return screens;
}

// `extraCss` is added to the page before measuring: the test uses it to seed a spacing mistake the audit must catch.
export async function runAudit({ origin, only, extraCss, viewport = VIEWPORT } = {}) {
  const server = origin ? { origin, stop: () => {} } : await startDevServer();
  const browser = await launchBrowser();
  try {
    const screens = [];
    for (const theme of THEMES) {
      const { context, page } = await openStudio(browser, server.origin, theme, extraCss, { viewport });
      screens.push(...await measureScreens(page, theme, only));
      if (!only || only === 'export') screens.push(...await measureExportScreens(page, theme, VIEWPORT));
      await context.close();
      if (!only || only === 'studio') {
        const narrowMenus = await openStudio(browser, server.origin, theme, extraCss, { viewport: NARROW_VIEWPORT });
        screens.push(await probeNarrowMenus(narrowMenus.page, theme));
        await narrowMenus.context.close();
      }
      if (!only || only === 'export') {
        const narrow = await openStudio(browser, server.origin, theme, extraCss, { viewport: NARROW_VIEWPORT });
        screens.push(...await measureExportScreens(narrow.page, theme, NARROW_VIEWPORT));
        await narrow.context.close();
      }
      if (!only || only === 'workspaces') {
        for (const targetViewport of [VIEWPORT, NARROW_VIEWPORT]) {
          const opened = await openStudio(browser, server.origin, theme, extraCss, { viewport: targetViewport });
          screens.push(...await measureWorkspaceTabs(opened.page, theme, targetViewport));
          await opened.context.close();
        }
      }
      if (!only || only === 'editmenu') {
        for (const [viewport, label] of [[VIEWPORT, ''], [NARROW_VIEWPORT, ' 720']]) {
          const opened = await openStudio(browser, server.origin, theme, extraCss, { viewport });
          screens.push(...await measureEditMenu(opened.page, theme, label));
          await opened.context.close();
        }
      }
      if (!only || only === 'history') {
        for (const [viewport, label] of [[VIEWPORT, ''], [NARROW_VIEWPORT, ' 720']]) {
          const opened = await openStudio(browser, server.origin, theme, extraCss, { viewport });
          screens.push(...await measureHistoryPanel(opened.page, theme, label));
          await opened.context.close();
        }
      }
      if (!only || only === 'agent') {
        for (const [viewport, label] of [[VIEWPORT, ''], [NARROW_VIEWPORT, ' 720'], [{ width: 1920, height: 1080 }, ' 1080']]) {
          const opened = await openStudio(browser, server.origin, theme, extraCss, { viewport, chatHost: true });
          screens.push(...await measureAgentCard(opened.page, theme, label));
          await opened.context.close();
        }
      }
      if (!only || only === 'notice') screens.push(await measureDraftNotice(browser, server.origin, theme, extraCss));
      if (!only || only === 'helpmenu') {
        for (const [viewport, label] of [[VIEWPORT, ''], [NARROW_VIEWPORT, ' 720']]) {
          const opened = await openStudio(browser, server.origin, theme, extraCss, { viewport });
          screens.push(...await measureHelpMenu(opened.page, theme, label));
          await opened.context.close();
        }
        const shortWindow = await openStudio(browser, server.origin, theme, extraCss, { viewport: { width: 720, height: 480 } });
        screens.push(await probeShortWindow(shortWindow.page));
        await shortWindow.context.close();
      }
      if (!only || only === 'notices') {
        for (const [viewport, label] of [[VIEWPORT, ''], [NARROW_VIEWPORT, ' 720']]) {
          const opened = await openStudio(browser, server.origin, theme, extraCss, { viewport, draft: true });
          screens.push(...await measureNoticesAndDialogs(opened.page, theme, label));
          await opened.context.close();
        }
      }
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
    const spacing = screen.selectionOnly ? { findings: [], allowed: [] } : findSpacingProblems(screen.records, { allowlist });
    const findings = [...spacing.findings, ...(screen.problems ?? []), ...findSelectionProblems(screen.records)];
    const rowHeights = screen.buttonRowHeights ?? [];
    if (rowHeights.length > 1 && Math.max(...rowHeights) - Math.min(...rowHeights) > 1) {
      findings.push({
        kind: 'uneven-height',
        selector: 'crucible-studio-dialog-actions > button',
        detail: rowHeights.join(','),
        message: `The buttons of one row are ${rowHeights.map(height => `${height} px`).join(', ')} tall; give them the same height (32 px).`,
      });
    }
    for (const [list, target] of [[findings, merged], [spacing.allowed, allowedMerged]]) {
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

// What a person gets when they try to select: the text the browser reports selected after each gesture. Chrome must report
// nothing for a drag, a double click and select all over the chrome, and the text itself inside a field or an opted-in block.
export async function probeSelectionBehavior(page) {
  const selectedText = () => page.evaluate(() => {
    const field = document.activeElement;
    const inField = field?.matches?.('input, textarea') ? field.value.slice(field.selectionStart, field.selectionEnd) : '';
    return inField || getSelection().toString();
  });
  const clearSelection = () => page.evaluate(() => getSelection().removeAllRanges());
  const checks = [];
  const record = async (name, expectation) => {
    const text = await selectedText();
    checks.push({ name, selected: text.length, passed: expectation === 'none' ? text.length === 0 : text.length > 0 });
    await clearSelection();
  };
  const dragAcross = async box => {
    await page.mouse.move(box.left, box.top);
    await page.mouse.down();
    await page.mouse.move(box.right, box.bottom, { steps: 10 });
    await page.mouse.up();
  };
  const boxOf = selector => page.evaluate(selection => {
    const box = document.querySelector(selection).getBoundingClientRect();
    return { left: box.left + 6, top: box.top + 6, right: box.right - 6, bottom: box.bottom - 6 };
  }, selector);

  await dragAcross({ left: 2, top: 2, right: VIEWPORT.width - 2, bottom: VIEWPORT.height - 2 });
  await record('main screen: drag across the whole window', 'none');
  await dragAcross({ left: VIEWPORT.width / 2, top: VIEWPORT.height / 2, right: VIEWPORT.width / 2 - 150, bottom: VIEWPORT.height / 2 - 100 });
  await record('main screen: drag that starts on the canvas', 'none');
  await page.locator('.crucible-studio button:visible').filter({ hasText: /\w/ }).first().dblclick();
  await record('main screen: double click on a label', 'none');
  await page.keyboard.press('Control+a');
  await record('main screen: Ctrl+A', 'none');

  await page.locator('.crucible-studio-tree-label').first().dblclick();
  await record('scene list: double click on a row', 'none');
  await dragAcross(await boxOf('.crucible-studio-tree-section'));
  await record('scene list: drag across the rows', 'none');
  await page.keyboard.press('Control+a');
  await record('scene list: Ctrl+A', 'none');

  await page.keyboard.press('Control+,');
  await page.waitForSelector('dialog.crucible-studio-settings-dialog[open]');
  await page.waitForTimeout(300);
  await dragAcross(await boxOf('dialog.crucible-studio-settings-dialog'));
  await record('Settings dialog: drag across the dialog', 'none');
  await page.locator('dialog.crucible-studio-settings-dialog label').first().dblclick();
  await record('Settings dialog: double click on a label', 'none');
  await page.keyboard.press('Control+a');
  await record('Settings dialog: Ctrl+A', 'none');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));

  await page.evaluate(() => {
    const dialog = document.getElementById('crucible-studio-json-title').closest('dialog');
    dialog.querySelector('textarea').value = '{"crucible": "scene"}';
    dialog.showModal();
  });
  await page.waitForTimeout(250);
  await page.locator('textarea[aria-label="Scene recipe JSON"]').click();
  await page.keyboard.press('Control+a');
  await record('Recipe JSON dialog: Ctrl+A inside the text', 'text');
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));

  const selectAllPrevented = selector => page.evaluate(target => {
    const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
    document.querySelector(target).dispatchEvent(event);
    return event.defaultPrevented;
  }, selector);
  // The host page of an embedded Studio keeps select all: an element outside the root is left alone.
  await page.evaluate(() => {
    const hostText = document.createElement('p');
    hostText.id = 'host-page-text';
    document.body.append(hostText);
  });
  const onHostPage = await selectAllPrevented('#host-page-text');
  checks.push({ name: 'Ctrl+A on the host page outside Studio keeps its browser default', selected: onHostPage ? 0 : 1, passed: !onHostPage });
  await page.evaluate(() => document.getElementById('host-page-text').remove());
  const outsideField = await selectAllPrevented('.crucible-studio');
  checks.push({ name: 'Ctrl+A outside a field has its browser default prevented', selected: outsideField ? 0 : 1, passed: outsideField });
  const insideField = await selectAllPrevented('textarea[aria-label="Scene recipe JSON"]');
  checks.push({ name: 'Ctrl+A inside a field keeps its browser default', selected: insideField ? 1 : 0, passed: !insideField });

  await page.evaluate(() => {
    const block = document.createElement('pre');
    block.className = 'crucible-studio-selectable';
    block.id = 'selection-probe';
    block.style.cssText = 'position: fixed; inset: 8px auto auto 8px; z-index: 2147483647; margin: 0';
    block.textContent = 'copy me';
    document.querySelector('.crucible-studio').append(block);
  });
  await page.locator('#selection-probe').dblclick();
  await record('a block with crucible-studio-selectable: double click', 'text');
  await page.evaluate(() => document.getElementById('selection-probe').remove());
  return checks;
}

async function main() {
  const flags = parseArguments(process.argv.slice(2));
  const screens = await runAudit({ origin: flags.origin, only: flags.only, viewport: flags.width ? { ...VIEWPORT, width: Number(flags.width) } : VIEWPORT });
  if (flags.records) writeFileSync(flags.records, JSON.stringify(screens));
  const { findings, allowed } = summarize(screens);
  const overlaps = screens.flatMap(screen => (screen.overlaps ?? []).map(problem => `${screen.name}: ${problem}`));
  const behavior = await runSelectionBehavior({ origin: flags.origin });
  for (const check of behavior.filter(item => !item.passed)) findings.push({ kind: 'selectable-chrome', message: `behaviour: ${check.name} left ${check.selected} characters selected where the rule says otherwise.`, surfaces: ['behaviour'] });
  const bySurface = countBySurface(findings);
  if (flags.json) {
    console.log(JSON.stringify({ screens: screens.length, failures: findings.length, overlaps, bySurface, findings, allowlist: ALLOWLIST, allowlistUsed: allowed }, null, 2));
  } else {
    for (const finding of findings) console.log(`[${finding.kind}] ${finding.message}\n    seen on: ${finding.surfaces.join(', ')}`);
    for (const overlap of overlaps) console.log(`[top-bar-overlap] ${overlap}`);
    console.log(`\nStudio layout audit: ${screens.length} screens, ${findings.length} spacing failures, ${overlaps.length} top bar overlaps (${Object.entries(bySurface).map(([surface, count]) => `${surface} ${count}`).join(', ') || 'none'}).`);
    for (const screen of screens) console.log(`  selection read ${screen.name}: ${screen.records.filter(record => record.ownText).length} elements with text, ${screen.records.filter(record => record.selectable).length} on the allowed list`);
    for (const check of behavior) console.log(`  selection ${check.passed ? 'ok  ' : 'FAIL'} ${check.name}: ${check.selected} characters`);
    console.log(`Allowlist: ${ALLOWLIST.length} declared, ${allowed.length} used.`);
    for (const entry of ALLOWLIST) console.log(`  ${entry.kind} ${entry.selector}: ${entry.reason}`);
  }
  process.exitCode = findings.length || overlaps.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}