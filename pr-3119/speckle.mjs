// Counts speckle pixels in the rim band of a rendered Khronos normal map test model. Deterministic, no randomness.
// Usage: node speckle.mjs <model> <label> [label...]   (reads <model>-<label>.png and <model>-main.json next to this file)
// Rim band: pixels between RIM_WIDTH pixels inside and 1 pixel outside the projected silhouette circle of each raised sphere
// (circles come from the main render's JSON, found by render.mjs from the model's raised connected pieces).
// Speckle pixel: a rim pixel whose luminance exceeds the median of its 5x5 neighbourhood by more than SPECKLE_THRESHOLD (0..255 scale).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const sharp = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'))('sharp');
const RIM_WIDTH = 5;
const METAL_COLUMNS = 2;
const SPECKLE_THRESHOLD = 25;
const folder = dirname(fileURLToPath(import.meta.url));

async function load(name) {
  const { data, info } = await sharp(join(folder, name)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function luminanceOf(image) {
  const values = new Float32Array(image.width * image.height);
  for (let index = 0; index < values.length; index++) {
    values[index] = 0.2126 * image.data[index * 3] + 0.7152 * image.data[index * 3 + 1] + 0.0722 * image.data[index * 3 + 2];
  }
  return values;
}

function rimBand(circles, width, height) {
  const band = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (const circle of circles) {
        const distance = Math.hypot(x + 0.5 - circle.centerX, y + 0.5 - circle.centerY);
        if (distance >= circle.radius - RIM_WIDTH && distance <= circle.radius + 1) band[y * width + x] = 1;
      }
    }
  }
  return band;
}

function neighbourhoodMedian(values, width, height, x, y) {
  const neighbours = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const sx = Math.min(width - 1, Math.max(0, x + dx));
      const sy = Math.min(height - 1, Math.max(0, y + dy));
      neighbours.push(values[sy * width + sx]);
    }
  }
  neighbours.sort((a, b) => a - b);
  return neighbours[12];
}

// Mean luminance of the 100 brightest pixels inside the metal spheres (further than RIM_WIDTH from the silhouette): the main highlight.
function highlightLuminance(luminance, width, circles) {
  const values = [];
  for (const circle of circles) {
    for (let y = Math.floor(circle.centerY - circle.radius); y <= Math.ceil(circle.centerY + circle.radius); y++) {
      for (let x = Math.floor(circle.centerX - circle.radius); x <= Math.ceil(circle.centerX + circle.radius); x++) {
        if (Math.hypot(x + 0.5 - circle.centerX, y + 0.5 - circle.centerY) < circle.radius - RIM_WIDTH) values.push(luminance[y * width + x]);
      }
    }
  }
  values.sort((a, b) => b - a);
  return Math.round(values.slice(0, 100).reduce((sum, value) => sum + value, 0) / 100 * 10) / 10;
}

const [model, ...labels] = process.argv.slice(2);
if (!model || labels.length === 0) throw new Error('Usage: node speckle.mjs <model> <label> [label...]');
const circles = JSON.parse(readFileSync(join(folder, `${model}-main.json`), 'utf8')).parts;
for (const label of labels) {
  const image = await load(`${model}-${label}.png`);
  const luminance = luminanceOf(image);
  const perSphere = circles.map(circle => ({ centerX: Math.round(circle.centerX), centerY: Math.round(circle.centerY), specklePixels: 0 }));
  for (let sphereIndex = 0; sphereIndex < circles.length; sphereIndex++) {
    const circle = circles[sphereIndex];
    for (let y = Math.floor(circle.centerY - circle.radius - 2); y <= Math.ceil(circle.centerY + circle.radius + 2); y++) {
      for (let x = Math.floor(circle.centerX - circle.radius - 2); x <= Math.ceil(circle.centerX + circle.radius + 2); x++) {
        const distance = Math.hypot(x + 0.5 - circle.centerX, y + 0.5 - circle.centerY);
        if (distance < circle.radius - RIM_WIDTH || distance > circle.radius + 1) continue;
        if (luminance[y * image.width + x] - neighbourhoodMedian(luminance, image.width, image.height, x, y) > SPECKLE_THRESHOLD) perSphere[sphereIndex].specklePixels++;
      }
    }
  }
  // Metal spheres sit in the olive right-hand block: the two rightmost columns of spheres.
  const columns = [...new Set(perSphere.map(sphere => sphere.centerX))].sort((a, b) => a - b);
  const metalColumns = new Set(columns.slice(-METAL_COLUMNS));
  const total = columnSet => perSphere.filter(sphere => columnSet.has(sphere.centerX)).reduce((sum, sphere) => sum + sphere.specklePixels, 0);
  const highlight = highlightLuminance(luminance, image.width, circles.filter(circle => Math.round(circle.centerX) === columns.at(-1)));
  console.log(JSON.stringify({ model, label, highlightLuminance: highlight, metalSpecklePixels: total(metalColumns), plainMetalColumn: total(new Set([columns.at(-METAL_COLUMNS)])), mappedMetalColumn: total(new Set([columns.at(-1)])), allSpheres: total(new Set(columns)), rimWidth: RIM_WIDTH, speckleThreshold: SPECKLE_THRESHOLD }));
}
