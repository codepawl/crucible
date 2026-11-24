// Usage: node crops.mjs <scene>: 2x crop of the changed region (main | branch | path tracer), a 4x crop of the exact/fallback border, and a seam statistic.
import sharp from 'sharp';
const [scene] = process.argv.slice(2);
const width = 640, height = 640;
const load = async p => (await sharp(p).removeAlpha().raw().toBuffer());
const [main, branch, pt] = await Promise.all([`out/main-${scene}.png`, `out/branch-${scene}.png`, `out/pt-${scene}.png`].map(load));
const changed = new Uint8Array(width * height);
for (let p = 0; p < width * height; p++) changed[p] = [0, 1, 2].some(c => Math.abs(main[p * 3 + c] - branch[p * 3 + c]) > 2) ? 1 : 0;
let minX = width, maxX = 0, minY = height, maxY = 0;
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (changed[y * width + x]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
const centreX = Math.round((minX + maxX) / 2), centreY = Math.round((minY + maxY) / 2);
const crop = async (path, cx, cy, half, zoom) => sharp(path).extract({ left: Math.max(0, cx - half), top: Math.max(0, cy - half), width: half * 2, height: half * 2 }).resize(half * 2 * zoom, half * 2 * zoom, { kernel: 'nearest' }).removeAlpha().toBuffer();
const tiles = await Promise.all([`out/main-${scene}.png`, `out/branch-${scene}.png`, `out/pt-${scene}.png`].map(p => crop(p, centreX, centreY, 100, 2)));
await sharp({ create: { width: 1200, height: 400, channels: 3, background: '#000' } }).composite(tiles.map((input, i) => ({ input, left: i * 400, top: 0 }))).png().toFile(`out/crop2x-${scene}.png`);
// Border pixels: changed pixels with an unchanged 4-neighbour. Seam statistic = mean neighbour difference of the branch image across them against the same statistic over all changed and all unchanged pixels.
const border = [];
for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) { const p = y * width + x; if (changed[p] && (!changed[p - 1] || !changed[p + 1] || !changed[p - width] || !changed[p + width])) border.push([x, y]); }
const step = (image, x, y) => { const p = (y * width + x) * 3; let sum = 0; for (const q of [p + 3, p + width * 3]) for (let c = 0; c < 3; c++) sum += Math.abs(image[p + c] - image[q + c]); return sum / 6; };
const mean = (image, points) => points.reduce((total, [x, y]) => total + step(image, x, y), 0) / points.length;
const all = [], unchangedPoints = [];
for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) (changed[y * width + x] ? all : unchangedPoints).push([x, y]);
const stats = { scene, bbox: [minX, minY, maxX, maxY], borderPixels: border.length, borderStepBranch: +mean(branch, border).toFixed(2), borderStepMain: +mean(main, border).toFixed(2), changedStepBranch: +mean(branch, all).toFixed(2), unchangedStepBranch: +mean(branch, unchangedPoints).toFixed(2) };
// 4x crop on the longest vertical run of border pixels near the middle of the region.
const pick = border.filter(([x, y]) => Math.abs(y - centreY) < 40).sort((a, b) => a[0] - b[0])[Math.floor(border.filter(([x, y]) => Math.abs(y - centreY) < 40).length / 2)] ?? [centreX, centreY];
const fourTiles = await Promise.all([`out/main-${scene}.png`, `out/branch-${scene}.png`, `out/pt-${scene}.png`].map(p => crop(p, pick[0], pick[1], 50, 4)));
await sharp({ create: { width: 1200, height: 400, channels: 3, background: '#000' } }).composite(fourTiles.map((input, i) => ({ input, left: i * 400, top: 0 }))).png().toFile(`out/crop4x-${scene}.png`);
stats.cropCentre = pick;
console.log(JSON.stringify(stats));
