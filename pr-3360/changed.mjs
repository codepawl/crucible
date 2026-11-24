// Usage: node changed.mjs <scene>: RMSE against the path tracer over only the pixels where main and the branch differ.
import sharp from 'sharp';
const [scene] = process.argv.slice(2);
const load = async p => (await sharp(p).removeAlpha().raw().toBuffer());
const [main, branch, pt] = await Promise.all([`out/main-${scene}.png`, `out/branch-${scene}.png`, `out/pt-${scene}.png`].map(load));
let count = 0, mainSum = 0, branchSum = 0;
for (let i = 0; i < main.length; i += 3) {
  const differs = [0, 1, 2].some(c => Math.abs(main[i + c] - branch[i + c]) > 2);
  if (!differs) continue;
  count++;
  for (let c = 0; c < 3; c++) { mainSum += (main[i + c] - pt[i + c]) ** 2; branchSum += (branch[i + c] - pt[i + c]) ** 2; }
}
console.log(JSON.stringify({ scene, changedPixels: count, mainRmse: +Math.sqrt(mainSum / (3 * count)).toFixed(2), branchRmse: +Math.sqrt(branchSum / (3 * count)).toFixed(2) }));
