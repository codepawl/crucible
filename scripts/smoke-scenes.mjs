import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { viteChildEnvironment, viteOutputMentionsAddress } from './vite-output.mjs';

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5179', '--strictPort'], { windowsHide: true, stdio: 'pipe', env: viteChildEnvironment() });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Scene smoke server did not start.')), 15000);
    server.stdout.on('data', (data) => {
      if (viteOutputMentionsAddress(data, '127.0.0.1:5179')) { clearTimeout(timeout); resolve(); }
    });
    server.on('error', reject);
    server.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Scene server exited ${code}.`)); });
  });
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}), args: ['--enable-webgl', '--ignore-gpu-blocklist', '--disable-audio-output'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const size of [{ width: 1280, height: 800 }, { width: 1024, height: 700 }, { width: 1024, height: 768 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(size);
    await page.goto('http://127.0.0.1:5179/object.html');
    await page.waitForSelector('#benchmark');
    const toolbarProblems = await page.evaluate(() => {
      const bar = document.querySelector('.viewer-main').getBoundingClientRect();
      const items = [...document.querySelectorAll('.toolbar-actions button')];
      const boxes = items.map((item) => ({ name: item.textContent.trim(), box: item.getBoundingClientRect() }));
      const problems = [];
      for (const [index, { name, box }] of boxes.entries()) {
        if (box.left < bar.left - 0.5 || box.right > bar.right + 0.5) problems.push(`${name} overflows the viewer`);
        if (box.height > 0 && box.height < 32) problems.push(`${name} is under 32 px tall`);
        for (const other of boxes.slice(index + 1)) {
          if (box.left < other.box.right && box.right > other.box.left && box.top < other.box.bottom && box.bottom > other.box.top) problems.push(`${name} overlaps ${other.name}`);
        }
      }
      const actions = [...document.querySelectorAll('.toolbar-actions button')];
      if (actions.some((button) => button.getBoundingClientRect().height > 50)) problems.push('a toolbar button label wraps');
      if (document.documentElement.scrollWidth > window.innerWidth) problems.push('the page scrolls sideways');
      return problems;
    });
    assert.deepEqual(toolbarProblems, [], `Object studio toolbar does not fit at ${size.width}x${size.height}.`);
    const overlaps = await page.evaluate(() => {
      const panel = document.querySelector('.controls').getBoundingClientRect();
      const footerItems = ['#benchmark', '#cpu', '#parts'].map((selector) => document.querySelector(selector).getBoundingClientRect());
      return footerItems.filter((item) => item.width > 0 && item.left < panel.right && item.right > panel.left && item.top < panel.bottom && item.bottom > panel.top).length;
    });
    assert.equal(overlaps, 0, `Object studio footer overlaps the settings panel at ${size.width}x${size.height}.`);
    const autoOrbitProblems = await page.evaluate(() => {
      const orbit = document.querySelector('#rotate').getBoundingClientRect();
      const panel = document.querySelector('.controls').getBoundingClientRect();
      const problems = [];
      if (orbit.left < 0 || orbit.top < 0 || orbit.right > window.innerWidth || orbit.bottom > window.innerHeight) problems.push('sits outside the viewport');
      if (orbit.height < 32) problems.push('is under 32 px tall');
      if (orbit.left < panel.right && orbit.right > panel.left && orbit.top < panel.bottom && orbit.bottom > panel.top) problems.push('overlaps the settings panel');
      return problems;
    });
    assert.deepEqual(autoOrbitProblems, [], `Object studio Auto orbit button is not fully visible at ${size.width}x${size.height}.`);
    const lastRowReachable = await page.evaluate(() => {
      const panel = document.querySelector('.controls');
      panel.scrollTop = panel.scrollHeight;
      const lastRow = document.querySelector('#quality').getBoundingClientRect();
      return lastRow.bottom <= panel.getBoundingClientRect().bottom;
    });
    assert.ok(lastRowReachable, `Object studio Resolution row cannot be scrolled into view at ${size.width}x${size.height}.`);
    const fade = await page.evaluate(async () => {
      const panel = document.querySelector('.controls');
      const read = async (top) => {
        panel.scrollTop = top;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return parseFloat(getComputedStyle(panel).getPropertyValue('--controls-fade')) || 0;
      };
      return { overflows: panel.scrollHeight > panel.clientHeight, atTop: await read(0), atBottom: await read(panel.scrollHeight) };
    });
    if (fade.overflows) {
      assert.ok(fade.atTop > 0, `Object studio panel shows no fade while more controls are below at ${size.width}x${size.height}.`);
      assert.equal(fade.atBottom, 0, `Object studio panel still fades at its bottom edge at ${size.width}x${size.height}.`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:5179/nature.html');
  await page.waitForFunction(() => window.__nature?.renderer);
  assert.equal(await page.evaluate(() => window.__nature.state.paused), true);
  await page.screenshot({ path: 'artifacts/nature-wide.png' });
  await page.locator('#daylight').fill('0.25');
  await page.locator('#wind').fill('0.75');
  assert.equal(await page.evaluate(() => window.__nature.state.daylight), 0.25);
  assert.equal(await page.evaluate(() => window.__nature.state.wind), 0.75);
  await page.locator('#viewpoint').selectOption('1');
  await page.locator('#detail').selectOption('low');
  await page.waitForFunction(() => window.__nature.state.detail === 'low' && window.__nature.world.parts.length < 2000);
  await page.locator('#viewpoint').selectOption('0');
  await page.locator('#viewport').click({ position: { x: 720, y: 630 } });
  assert.ok(await page.evaluate(() => window.__nature.state.rippleTime >= 0));
  await page.locator('#viewport').focus();
  const natureAzimuth = await page.evaluate(() => window.__nature.state.azimuth);
  await page.keyboard.press('ArrowRight');
  assert.notEqual(await page.evaluate(() => window.__nature.state.azimuth), natureAzimuth);
  const downloadReady = page.waitForEvent('download');
  await page.locator('#save-image').click();
  await (await downloadReady).saveAs('artifacts/nature-download.png');
  await page.setViewportSize({ width: 320, height: 700 });
  await page.screenshot({ path: 'artifacts/nature-narrow.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://127.0.0.1:5179/film.html');
  await page.waitForFunction(() => window.__filmReady);
  async function filmPixels(time) {
    return page.evaluate((seconds) => {
      window.renderAt(seconds);
      const renderer = window.__film.renderer;
      const context = renderer.context;
      const pixels = new Uint8Array(renderer.canvas.width * renderer.canvas.height * 4);
      context.readPixels(0, 0, renderer.canvas.width, renderer.canvas.height, context.RGBA, context.UNSIGNED_BYTE, pixels);
      let checksum = 2166136261;
      for (const byte of pixels) checksum = Math.imul(checksum ^ byte, 16777619);
      return { checksum: checksum >>> 0, error: context.getError() };
    }, time);
  }
  const ignition = await filmPixels(183.5);
  await page.screenshot({ path: 'artifacts/film-wide.png' });
  await filmPixels(5.5);
  await filmPixels(101);
  assert.deepEqual(await filmPixels(183.5), ignition);
  assert.equal(ignition.error, 0);
  await page.locator('#film-time').fill('1');
  await page.getByRole('button', { name: 'Play film', exact: true }).click();
  await page.waitForFunction(() => window.__film.score.readyState >= 2 && window.__film.score.currentTime > 1.1);
  const timeline = await page.locator('#film-time').boundingBox();
  await page.mouse.move(timeline.x + timeline.width * 0.7, timeline.y + timeline.height / 2);
  await page.mouse.down();
  await page.mouse.move(timeline.x + timeline.width * 0.25, timeline.y + timeline.height / 2);
  await page.waitForFunction(() => window.__film.scrubbing && !window.__film.playing);
  await page.waitForTimeout(150);
  const heldTime = Number(await page.locator('#film-time').inputValue());
  assert.ok(heldTime > 40 && heldTime < 55);
  assert.ok(Math.abs(await page.evaluate(() => window.__film.currentTime) - heldTime) < 0.1);
  await page.waitForTimeout(100);
  assert.equal(Number(await page.locator('#film-time').inputValue()), heldTime);
  await page.mouse.up();
  await page.waitForFunction(() => window.__film.playing && !window.__film.scrubbing);
  await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => window.__film.currentTime) >= heldTime);
  await page.getByRole('button', { name: 'Pause film', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__film.score.paused), true);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.locator('#film-time').fill('183.5');
  await page.screenshot({ path: 'artifacts/film-narrow.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  const controls = await page.locator('.transport button, .transport a').evaluateAll((elements) => elements.map((element) => {
    const rectangle = element.getBoundingClientRect();
    return { left: rectangle.left, right: rectangle.right, bottom: rectangle.bottom };
  }));
  assert.ok(controls.every((control) => control.left >= 0 && control.right <= 320 && control.bottom <= 700));
  assert.deepEqual(errors, []);
  const result = { checks: 'Nature daylight, wind, viewpoints, detail, ripple, keyboard and PNG; deterministic film seeks, audio playback, mobile layout and reduced motion', errors };
  await writeFile('artifacts/scenes-verification.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  server.kill();
}
