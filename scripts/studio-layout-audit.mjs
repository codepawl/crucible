#!/usr/bin/env node
// Measures the real DOM of the Studio screens in headless Chrome and fails when the spacing breaks the rules of
// studio-layout-rules.mjs: unequal insets around the content of a padded container, a gap or padding off the spacing
// scale, or a gap between groups smaller than the gap inside one. Every failure names the selector, the numbers and the fix.
//
//   node scripts/studio-layout-audit.mjs [--json] [--origin url] [--only setup|settings|studio|popover|newscene|dialog|notice|notices] [--width pixels] [--records file.json]
//
// Without --origin it starts a Vite dev server on a free port and stops it (by its own PID) at the end. Screens: the Studio
// page, each of its popover menus, the five steps of the setup dialog, and the New scene chooser with its unsaved-changes
// question, each in the dark and the light theme at 1280 by 720 (--width changes the width, for example 720).
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
const USAGE = 'Usage: node scripts/studio-layout-audit.mjs [--json] [--origin url] [--only setup|settings|studio|popover|newscene|dialog|notice|notices] [--width pixels] [--records file.json]';
const CHROME_PATH = process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
const GPU_ARGUMENTS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-audio-output'];
// A signed-in host with every optional field, so the Account section of Settings is on screen and measured.
const SAMPLE_ACCOUNT_HOST = `globalThis.crucibleShell = { account: {
  get: async () => ({ signedIn: true, name: 'Sample Person', email: 'sample.person@example.com', remainingText: '1,240 credits left', planText: 'Studio plan' }),
  signIn: async () => {}, signOut: async () => {}, buyCredits: () => {}, manageBilling: () => {},
} };`;
const SOFTWARE_ARGUMENTS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--disable-audio-output'];

// An uneven inset or an off-scale value that is meant. Each entry names the kind, the selector (a substring of the
// reported one) and why. Keep this short: a real finding is fixed in the CSS, never listed here.
export const ALLOWLIST = Object.freeze([
  { kind: 'uneven-inset', selector: 'crucible-studio-toolbar', reason: 'The tool rail is a strip as tall as the window; its buttons sit at the top and the strip ends below them.' },
  { kind: 'uneven-inset', selector: 'crucible-studio-tree-row', reason: 'The visibility button at the end of an outliner row is a hit area with its own room, so the row keeps 2px on that side.' },
  { kind: 'uneven-inset', selector: 'crucible-studio-popover > button', reason: 'A menu row is a full-width hit area whose label starts at the leading edge; the free space is the end of the row.' },
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

export async function openStudio(browser, origin, theme, extraCss = '', { viewport = VIEWPORT, draft = false, savedDraft = null } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(FAKE_POINTER_LOCK_SCRIPT);
  await context.addInitScript(SAMPLE_ACCOUNT_HOST);
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

async function measureScreens(page, theme, only) {
  const screens = [];
  if (!only || only === 'studio') screens.push({ name: `studio (${theme})`, records: await measure(page, '.crucible-studio') });
  if (!only || only === 'popover') {
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

// `extraCss` is added to the page before measuring: the test uses it to seed a spacing mistake the audit must catch.
export async function runAudit({ origin, only, extraCss, viewport = VIEWPORT } = {}) {
  const server = origin ? { origin, stop: () => {} } : await startDevServer();
  const browser = await launchBrowser();
  try {
    const screens = [];
    for (const theme of THEMES) {
      const { context, page } = await openStudio(browser, server.origin, theme, extraCss, { viewport });
      screens.push(...await measureScreens(page, theme, only));
      await context.close();
      if (!only || only === 'notice') screens.push(await measureDraftNotice(browser, server.origin, theme, extraCss));
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
  const behavior = await runSelectionBehavior({ origin: flags.origin });
  for (const check of behavior.filter(item => !item.passed)) findings.push({ kind: 'selectable-chrome', message: `behaviour: ${check.name} left ${check.selected} characters selected where the rule says otherwise.`, surfaces: ['behaviour'] });
  const bySurface = countBySurface(findings);
  if (flags.json) {
    console.log(JSON.stringify({ screens: screens.length, failures: findings.length, bySurface, findings, allowlist: ALLOWLIST, allowlistUsed: allowed }, null, 2));
  } else {
    for (const finding of findings) console.log(`[${finding.kind}] ${finding.message}\n    seen on: ${finding.surfaces.join(', ')}`);
    console.log(`\nStudio layout audit: ${screens.length} screens, ${findings.length} failures (${Object.entries(bySurface).map(([surface, count]) => `${surface} ${count}`).join(', ') || 'none'}).`);
    for (const screen of screens) console.log(`  selection read ${screen.name}: ${screen.records.filter(record => record.ownText).length} elements with text, ${screen.records.filter(record => record.selectable).length} on the allowed list`);
    for (const check of behavior) console.log(`  selection ${check.passed ? 'ok  ' : 'FAIL'} ${check.name}: ${check.selected} characters`);
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