// Proves the resource governor (issue #2179) with real WebGL draw calls in Chrome, and that compact HDR targets cut VRAM.
//
//   node scripts/smoke-idle-governor.mjs [output-directory]      (needs Chrome; CHROME_PATH overrides the install path)
//
// A 1920x1080 live loop (createRuntime with isIdle) is measured in four phases: idle, after a pointer move, busy and onscreen,
// busy and scrolled offscreen. It must draw nothing while idle or offscreen, draw again after input and after scrolling back.
// Then renderer.memoryReport() is read for an opaque HDR canvas (compact R11F_G11F_B10F by default), the same canvas with
// compactColor:false, and a transparent canvas, which must keep RGBA16F. Writes result.json and exits 1 when a check fails.
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(process.argv[2] ?? join(root, 'artifacts', '2179'));
const MIME = { '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PHASE_MILLISECONDS = 3000;
const MINIMUM_SAVED_MEGABYTES = 30;
const MAXIMUM_COMPACT_RMSE = 2;

const server = createServer(async (request, response) => {
  const relative = normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
  const file = join(root, relative === '/' || relative === '\\' ? 'scripts/smoke-idle-governor.html' : relative);
  if (!file.startsWith(root) || !(await stat(file).then(info => info.isFile(), () => false))) {
    response.statusCode = 404;
    response.end('not found');
    return;
  }
  response.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(response);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME_PATH,
  args: ['--no-sandbox', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-audio-output'],
});
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
let report;
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const problems = [];
  page.on('pageerror', error => problems.push(error.message));
  // The favicon request has no file to answer it; that 404 is the browser's, not the page's.
  page.on('console', message => { if (message.type() === 'error' && !/status of 404/.test(message.text())) problems.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.idleProofReady === true, null, { timeout: 60000 }).catch(error => {
    console.error(problems.join('\n'));
    throw error;
  });

  await page.evaluate(() => window.startLiveLoop());
  await page.waitForFunction(() => window.readCounters().renderCalls >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(1000);
  const phases = [];
  // Counts the draws between two snapshots around `action`, so a frame an input wakes is inside the window.
  const measurePhase = async (label, action = async () => {}) => {
    const before = await page.evaluate(() => window.readCounters());
    await action();
    await page.waitForTimeout(PHASE_MILLISECONDS);
    const after = await page.evaluate(() => window.readCounters());
    return { label, seconds: PHASE_MILLISECONDS / 1000, renderCalls: after.renderCalls - before.renderCalls, glDrawCalls: after.glDrawCalls - before.glDrawCalls };
  };

  phases.push({ ...(await measurePhase('idle (first frame already drawn)')), flags: await page.evaluate(() => window.liveFlags()) });
  phases.push({ ...(await measurePhase('after pointer move (loop is idle again)', async () => {
    await page.mouse.move(300, 300);
    await page.mouse.move(340, 320);
  })), flags: await page.evaluate(() => window.liveFlags()) });
  phases.push({ ...(await measurePhase('busy, onscreen', () => page.evaluate(() => window.setBusy(true)))), flags: await page.evaluate(() => window.liveFlags()) });
  await page.evaluate(() => window.scrollTo(0, 4000));
  await page.waitForTimeout(500);
  phases.push({ ...(await measurePhase('busy, scrolled offscreen')), flags: await page.evaluate(() => window.liveFlags()) });
  phases.push({ ...(await measurePhase('busy, scrolled back onscreen', () => page.evaluate(() => window.scrollTo(0, 0)))), flags: await page.evaluate(() => window.liveFlags()) });
  await page.evaluate(() => window.setBusy(false));
  await page.waitForTimeout(500);
  phases.push({ ...(await measurePhase('idle again')), flags: await page.evaluate(() => window.liveFlags()) });

  const [idle, afterInput, busy, offscreen, backOnscreen, idleAgain] = phases;
  check(idle.renderCalls === 0 && idle.glDrawCalls === 0, `idle drew ${idle.renderCalls} frames and ${idle.glDrawCalls} GL draws, expected 0`);
  check(idle.flags.sleeping, 'idle loop does not report sleeping');
  check(offscreen.renderCalls === 0 && offscreen.glDrawCalls === 0, `offscreen drew ${offscreen.renderCalls} frames and ${offscreen.glDrawCalls} GL draws, expected 0`);
  check(offscreen.flags.paused, 'offscreen loop does not report paused');
  check(busy.renderCalls > 10 && busy.glDrawCalls > 0, `busy onscreen drew only ${busy.renderCalls} frames`);
  check(backOnscreen.renderCalls > 10, `scrolling back drew only ${backOnscreen.renderCalls} frames, the loop did not wake`);
  check(idleAgain.renderCalls === 0 && idleAgain.glDrawCalls === 0, `idle again drew ${idleAgain.renderCalls} frames, expected 0`);
  // Pointer input wakes the loop for one frame per event batch, then it sleeps again: between 1 and a few frames, never continuous.
  check(afterInput.renderCalls >= 1 && afterInput.renderCalls <= 6, `pointer move drew ${afterInput.renderCalls} frames, expected 1 to a few`);
  check(afterInput.flags.sleeping, 'loop did not go back to sleep after the pointer move');

  const memory = await page.evaluate(() => window.measureMemory());
  const [compact, full, transparent] = memory.results;
  const savedMegabytes = (full.colorBytes - compact.colorBytes) / 1048576;
  check(compact.colorFormat === 'R11F_G11F_B10F', `opaque default uses ${compact.colorFormat}, expected R11F_G11F_B10F`);
  check(full.colorFormat === 'RGBA16F', `compactColor:false uses ${full.colorFormat}, expected RGBA16F`);
  check(transparent.colorFormat === 'RGBA16F', `transparent canvas uses ${transparent.colorFormat}, expected RGBA16F`);
  check(savedMegabytes >= MINIMUM_SAVED_MEGABYTES, `compact saves ${savedMegabytes.toFixed(2)} MB, expected at least ${MINIMUM_SAVED_MEGABYTES}`);
  check(memory.compactVersusFullRmse <= MAXIMUM_COMPACT_RMSE, `compact frame differs from RGBA16F by RMSE ${memory.compactVersusFullRmse.toFixed(3)} of 255`);
  check(problems.length === 0, `console errors: ${problems.join(' | ')}`);

  report = { phaseSeconds: PHASE_MILLISECONDS / 1000, phases, memory, savedMegabytes: Number(savedMegabytes.toFixed(2)), drawsPerSecond: Object.fromEntries(phases.map(phase => [phase.label, Number((phase.glDrawCalls / phase.seconds).toFixed(1))])), failures };
} finally {
  await browser.close();
  server.close();
}
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, 'result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failures.length) {
  console.error(`FAILED:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('idle governor smoke passed');
