import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding', '--disable-audio-output'];
const ARTIFACTS_DIR = resolve('artifacts');
const EVIDENCE_PATH = resolve('artifacts/meshlets-bench.png');
const REPORT_PATH = resolve('artifacts/meshlets-bench.json');

function decodePngDataUrl(dataUrl) {
  const prefix = 'data:image/png;base64,';
  return Buffer.from(dataUrl.slice(prefix.length), 'base64');
}

async function tileFromDataUrl(dataUrl) {
  return sharp(decodePngDataUrl(dataUrl)).resize(480, 270).toBuffer();
}

async function main() {
  const server = await createServer({ root: resolve('.'), server: { port: 0 }, logLevel: 'silent' });
  await server.listen();
  const address = server.httpServer.address();
  const baseUrl = `http://localhost:${address.port}`;

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${baseUrl}/bench/meshlets/harness.html`);
    await page.waitForFunction(() => typeof window.runMeshletBench === 'function');
    const results = await page.evaluate(() => window.runMeshletBench(24));
    if (errors.length > 0) throw new Error(`Bench page error: ${errors.join('\n')}`);

    await mkdir(ARTIFACTS_DIR, { recursive: true });
    const boulder = results.find(entry => entry.name === 'boulder-close');
    const cave = results.find(entry => entry.name === 'cave-inside');
    const tiles = [
      await tileFromDataUrl(boulder.withoutClusters.dataUrl),
      await tileFromDataUrl(boulder.withClusters.dataUrl),
      await tileFromDataUrl(cave.withoutClusters.dataUrl),
      await tileFromDataUrl(cave.withClusters.dataUrl),
    ];

    await sharp({
      create: { width: 960, height: 540, channels: 4, background: { r: 16, g: 16, b: 18, alpha: 1 } },
    })
      .composite([
        { input: tiles[0], left: 0, top: 0 },
        { input: tiles[1], left: 480, top: 0 },
        { input: tiles[2], left: 0, top: 270 },
        { input: tiles[3], left: 480, top: 270 },
      ])
      .png()
      .toFile(EVIDENCE_PATH);

    const summary = results.map(({ withoutClusters, withClusters, ...rest }) => ({
      ...rest,
      withoutClusters: { ...withoutClusters, dataUrl: undefined },
      withClusters: { ...withClusters, dataUrl: undefined },
    }));
    await writeFile(REPORT_PATH, `${JSON.stringify(summary, null, 2)}\n`);

    for (const entry of summary) {
      if (entry.withoutClusters.glError !== 0 || entry.withClusters.glError !== 0) {
        throw new Error(`${entry.name} reported WebGL error (${entry.withoutClusters.glError}, ${entry.withClusters.glError})`);
      }
      const gpuText = entry.withoutClusters.medianGpuMs != null && entry.withClusters.medianGpuMs != null
        ? ` | gpu ${entry.withoutClusters.medianGpuMs.toFixed(2)} ms -> ${entry.withClusters.medianGpuMs.toFixed(2)} ms`
        : '';
      console.log(
        `${entry.name}: tris ${entry.withoutClusters.trianglesDrawn} -> ${entry.withClusters.trianglesDrawn} `
        + `| wall ${entry.withoutClusters.medianMs.toFixed(2)} ms -> ${entry.withClusters.medianMs.toFixed(2)} ms`
        + `${gpuText} | rmse ${entry.rmse.toFixed(4)} | multiDraw ${entry.multiDrawSupport}`,
      );
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main();
