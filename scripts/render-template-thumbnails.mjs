#!/usr/bin/env node
// Renders one picture of each Studio starting scene with Studio itself and writes it to assets/studio-templates/<key>.webp,
// the pictures on the cards of File > New scene. The scene, camera and look come from src/studio-templates.js, so the
// pictures change only when a template does; run this again after one changes.
//
//   node scripts/render-template-thumbnails.mjs [--origin url]
//
// Without --origin it starts a Vite dev server on a free port and stops it at the end. It opens headless Chrome on the GPU,
// so on a shared machine start it through that machine's GPU queue.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTemplateRecipe, STUDIO_TEMPLATES } from '../src/studio-templates.js';
import { launchBrowser, openStudio, startDevServer } from './studio-layout-audit.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_FOLDER = join(projectRoot, 'assets/studio-templates');
const PICTURE_WIDTH = 320;
const PICTURE_HEIGHT = 200;
const WEBP_QUALITY = 0.8;
const SETTLE_MILLISECONDS = 600;

// Runs in the page: draws the still of the scene, cropped from the middle to the card's shape, as a WebP data URL.
async function captureThumbnail({ recipe, width, height, quality }) {
  const studio = window.__studioPage;
  await studio.openRecipe(recipe);
  studio.selectNode(null);
  studio.setGridVisible(false);
  studio.renderNow();
  await new Promise(resolve => setTimeout(resolve, 400));
  studio.renderNow();
  const still = new Image();
  still.src = studio.capturePngDataUrl();
  await still.decode();
  const scale = Math.max(width / still.naturalWidth, height / still.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(still, (width - still.naturalWidth * scale) / 2, (height - still.naturalHeight * scale) / 2, still.naturalWidth * scale, still.naturalHeight * scale);
  return canvas.toDataURL('image/webp', quality);
}

async function main() {
  const originFlag = process.argv.indexOf('--origin');
  const server = originFlag > 0 ? { origin: process.argv[originFlag + 1], stop: () => {} } : await startDevServer();
  const browser = await launchBrowser();
  try {
    const { context, page } = await openStudio(browser, server.origin, 'dark');
    mkdirSync(OUTPUT_FOLDER, { recursive: true });
    let totalBytes = 0;
    for (const templateKey of Object.keys(STUDIO_TEMPLATES)) {
      const dataUrl = await page.evaluate(captureThumbnail, { recipe: buildTemplateRecipe(templateKey), width: PICTURE_WIDTH, height: PICTURE_HEIGHT, quality: WEBP_QUALITY });
      const outputPath = join(OUTPUT_FOLDER, `${templateKey}.webp`);
      writeFileSync(outputPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
      const bytes = statSync(outputPath).size;
      totalBytes += bytes;
      console.log(`${templateKey}.webp ${bytes} bytes`);
      await page.waitForTimeout(SETTLE_MILLISECONDS);
    }
    console.log(`total ${totalBytes} bytes`);
    await context.close();
  } finally {
    await browser.close();
    server.stop();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
