// Usage: node rmse.mjs <scene> <raster.png> <pt.png> [diff-out.png]. RMSE (0..255, 3 channels) inside the union of the outer cubes' silhouettes.
import sharp from 'sharp';
import { camera, size, footprintCubes } from './scenes.mjs';
const [sceneName, rasterPath, tracePath, diffOut] = process.argv.slice(2);
const load = async path => (await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
const [raster, trace] = [await load(rasterPath), await load(tracePath)];
const sub = (a, b) => a.map((v, i) => v - b[i]); const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const f = unit(sub(camera.target, camera.eye)); const r = unit([f[2], 0, -f[0]]);
const up = [r[1]*f[2]-r[2]*f[1], r[2]*f[0]-r[0]*f[2], r[0]*f[1]-r[1]*f[0]];
const focal = (size.height / 2) / Math.tan(camera.fov * Math.PI / 360);
const project = p => { const d = sub(p, camera.eye); const z = dot(d, f); return [size.width / 2 + focal * dot(d, r) / z, size.height / 2 - focal * dot(d, up) / z]; };
const rotate = (q, v) => { const [x, y, z, w] = q; const t = [2*(y*v[2]-z*v[1]), 2*(z*v[0]-x*v[2]), 2*(x*v[1]-y*v[0])]; return [v[0]+w*t[0]+(y*t[2]-z*t[1]), v[1]+w*t[1]+(z*t[0]-x*t[2]), v[2]+w*t[2]+(x*t[1]-y*t[0])]; };
function hull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]); const cross = (o, a, b) => (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]);
  const build = list => { const out = []; for (const p of list) { while (out.length >= 2 && cross(out.at(-2), out.at(-1), p) <= 0) out.pop(); out.push(p); } out.pop(); return out; };
  return [...build(sorted), ...build([...sorted].reverse())];
}
const hulls = footprintCubes(sceneName).map(cube => hull([-1,1].flatMap(x => [-1,1].flatMap(y => [-1,1].map(z => project(rotate(cube.rotation, [x*cube.scale/2, y*cube.scale/2, z*cube.scale/2]).map((v, i) => v + cube.translation[i])))))));
const inside = (poly, x, y) => poly.every((p, i) => { const q = poly[(i + 1) % poly.length]; return (q[0]-p[0])*(y-p[1]) - (q[1]-p[1])*(x-p[0]) >= 0; });
// Shrink by testing the pixel centre only; keep a 3 pixel margin off the silhouette edge so edge antialiasing does not count.
const mask = (x, y) => hulls.some(poly => [[0,0],[3,0],[-3,0],[0,3],[0,-3]].every(([dx, dy]) => inside(poly, x + 0.5 + dx, y + 0.5 + dy)));
let sum = 0, count = 0; const diff = Buffer.alloc(size.width * size.height * 3);
for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
  const i = (y * size.width + x) * 3; const d = [0,1,2].map(c => raster[i+c] - trace[i+c]); const inMask = mask(x, y);
  if (inMask) { sum += d[0]*d[0]+d[1]*d[1]+d[2]*d[2]; count += 3; }
  const m = Math.min(255, Math.abs(d[0])+Math.abs(d[1])+Math.abs(d[2])); diff[i] = m*(inMask?1:0.3); diff[i+1] = m*0.3; diff[i+2] = m*0.3;
}
if (diffOut) await sharp(diff, { raw: { width: size.width, height: size.height, channels: 3 } }).png().toFile(diffOut);
console.log(JSON.stringify({ scene: sceneName, pixels: count / 3, rmse: +Math.sqrt(sum / count).toFixed(2) }));
