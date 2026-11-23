// Lists the speckle pixels (same metric as speckle.mjs) of the metal spheres of a render, per label, with their bounding box.
// Usage: node mirror-locate.mjs <model> <label> [label...]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../../package.json', import.meta.url))('sharp');
const [model, ...labels] = process.argv.slice(2);
const circles = JSON.parse(readFileSync(`${model}-main.json`, 'utf8')).parts;
const columns = [...new Set(circles.map(circle => Math.round(circle.centerX)))].sort((a, b) => a - b);
const metalColumns = new Set(columns.slice(-2));
for (const label of labels) {
  const { data, info } = await sharp(`${model}-${label}.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const luminance = new Float32Array(info.width * info.height);
  for (let index = 0; index < luminance.length; index++) luminance[index] = 0.2126 * data[index * 3] + 0.7152 * data[index * 3 + 1] + 0.0722 * data[index * 3 + 2];
  const found = [];
  for (const circle of circles.filter(circle => metalColumns.has(Math.round(circle.centerX)))) {
    for (let y = Math.floor(circle.centerY - circle.radius - 2); y <= Math.ceil(circle.centerY + circle.radius + 2); y++) {
      for (let x = Math.floor(circle.centerX - circle.radius - 2); x <= Math.ceil(circle.centerX + circle.radius + 2); x++) {
        const distance = Math.hypot(x + 0.5 - circle.centerX, y + 0.5 - circle.centerY);
        if (distance < circle.radius - 5 || distance > circle.radius + 1) continue;
        const neighbours = [];
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) neighbours.push(luminance[Math.min(info.height - 1, Math.max(0, y + dy)) * info.width + Math.min(info.width - 1, Math.max(0, x + dx))]);
        neighbours.sort((a, b) => a - b);
        if (luminance[y * info.width + x] - neighbours[12] > 25) found.push({ x, y, sphere: `${Math.round(circle.centerX)},${Math.round(circle.centerY)}` });
      }
    }
  }
  const bySphere = {};
  for (const pixel of found) (bySphere[pixel.sphere] ??= []).push([pixel.x, pixel.y]);
  console.log(label, found.length, JSON.stringify(Object.fromEntries(Object.entries(bySphere).map(([sphere, pixels]) => [sphere, { count: pixels.length, box: [Math.min(...pixels.map(p => p[0])), Math.min(...pixels.map(p => p[1])), Math.max(...pixels.map(p => p[0])), Math.max(...pixels.map(p => p[1]))] }]))));
}
