// Runs the transparent order benchmark in Chrome: node bench/transparent-order/run.mjs [still|cost] [outputPrefix] [rootFolder]
// `rootFolder` is the checkout whose src/ is drawn (default: the current folder), so the same page measures before and after.
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [mode = 'cost', outputPrefix = 'artifacts/transparent-order/run', rootFolder = '.'] = process.argv.slice(2);
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
await mkdir(resolve(outputPrefix, '..'), { recursive: true });
const server = await createServer({ root: resolve(rootFolder), server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-audio-output', '--disable-renderer-backgrounding'] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/bench/transparent-order/harness.html`, { timeout: 180000 });
  await page.waitForFunction(() => window.harnessReady && window.runOrbit, null, { timeout: 180000 });
  if (mode === 'still') {
    const { image } = await page.evaluate(label => window.runStill({ label: label }));
    await writeFile(`${outputPrefix}.png`, Buffer.from(image, 'base64'));
    console.log(`wrote ${outputPrefix}.png`);
  } else if (mode === 'frames') {
    await page.setViewportSize({ width: 1080, height: 1920 });
    await page.evaluate(() => window.startOrbit({ width: 1080, height: 1920 }));
    const orders = [];
    for (let frame = 0; frame < 60; frame++) {
      const { image, order, ideal } = await page.evaluate(index => window.renderOrbitFrame(index), frame);
      await writeFile(`${outputPrefix}-${String(frame).padStart(2, '0')}.png`, Buffer.from(image, 'base64'));
      orders.push({ frame, order, ideal });
    }
    await writeFile(`${outputPrefix}-orders.json`, JSON.stringify(orders));
    console.log(`wrote ${orders.length} frames`);
  } else if (mode === 'diagnose' || mode === 'orbit') {
    const runner = mode === 'diagnose' ? 'runDiagnose' : 'runOrbit';
    const { image, ...numbers } = await page.evaluate(([name, label]) => window[name]({ label }), [runner, process.env.STILL_LABEL ?? '']);
    await writeFile(`${outputPrefix}.png`, Buffer.from(image, 'base64'));
    console.log(JSON.stringify(numbers));
  } else {
    for (const [count, kinds, stacked] of [[50, 1, false], [500, 1, false], [50, 3, false], [50, 3, true], [500, 3, false], [500, 3, true]]) {
      console.log(JSON.stringify(await page.evaluate(parameters => window.runCost(parameters), { count, kinds, stacked })));
    }
  }
} finally {
  await browser.close();
  await server.close();
}
