import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-renderer-backgrounding', '--disable-audio-output'];
const ARTIFACTS_DIR = resolve('artifacts');
const EVIDENCE_PATH = resolve('artifacts/rain-street-portrait.png');
const REPORT_PATH = resolve('artifacts/rain-bench.json');

function decodePngDataUrl(dataUrl) {
  const prefix = 'data:image/png;base64,';
  return Buffer.from(dataUrl.slice(prefix.length), 'base64');
}

async function main() {
  const server = await createServer({ root: resolve('.'), server: { port: 0 }, logLevel: 'silent' });
  await server.listen();
  const address = server.httpServer.address();
  const baseUrl = `http://localhost:${address.port}`;

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${baseUrl}/bench/rain/harness.html`);
    await page.waitForFunction(() => typeof window.runRainBench === 'function');
    const result = await page.evaluate(() => window.runRainBench(24));
    if (errors.length > 0) throw new Error(`Rain bench page error: ${errors.join('\n')}`);
    if (result.glErrors.some(code => code !== 0)) {
      throw new Error(`Rain bench WebGL error: ${JSON.stringify(result.glErrors)}`);
    }

    await mkdir(ARTIFACTS_DIR, { recursive: true });
    const leftTile = await sharp(decodePngDataUrl(result.dryUrl)).resize(540, 960).toBuffer();
    const rightTile = await sharp(decodePngDataUrl(result.rainUrl)).resize(540, 960).toBuffer();
    await sharp({
      create: { width: 1080, height: 960, channels: 4, background: { r: 16, g: 16, b: 18, alpha: 1 } },
    })
      .composite([
        { input: leftTile, left: 0, top: 0 },
        { input: rightTile, left: 540, top: 0 },
      ])
      .png()
      .toFile(EVIDENCE_PATH);

    const summary = {
      width: result.width,
      height: result.height,
      dryTiming: result.dryTiming,
      rainTiming: result.rainTiming,
      seekRmse: result.seekRmse,
      dryVsRainRmse: result.dryVsRainRmse,
      glErrors: result.glErrors,
    };
    await writeFile(REPORT_PATH, `${JSON.stringify(summary, null, 2)}\n`);

    const gpuInfo = result.dryTiming.medianGpuMs != null && result.rainTiming.medianGpuMs != null
      ? ` | gpu ${result.dryTiming.medianGpuMs.toFixed(2)} ms -> ${result.rainTiming.medianGpuMs.toFixed(2)} ms`
      : '';
    console.log(
      `1080x1920 street: wall ${result.dryTiming.medianWallMs.toFixed(2)} ms -> ${result.rainTiming.medianWallMs.toFixed(2)} ms`
      + `${gpuInfo} | seekRmse ${result.seekRmse.toFixed(4)} | dryVsRainRmse ${result.dryVsRainRmse.toFixed(2)}`,
    );
  } finally {
    await browser.close();
    await server.close();
  }
}

main();
