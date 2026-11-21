// Sea height above its calm level in the galleon scene: the same ocean parameters as build-round7.mjs, sampled over the ship's footprint for 6 s.
import { oceanWaves } from '../../../.claude/worktrees/w2758h/src/ocean-waves.js';
import { seaHeightAt } from '../../../.claude/worktrees/w2758h/src/physics-buoyancy.js';

const waves = oceanWaves({ windSpeed: 10, direction: 0, size: 70, seed: 23, resolution: 6 });
const ocean = { waves, choppiness: 1.5, time: 0, level: 0 };
const halfLength = 17.1;
const halfWidth = 4.2;
let lowest = Infinity;
let highest = -Infinity;
const heights = [];
for (let time = 0; time <= 6; time += 0.25) {
  for (let x = -halfLength; x <= halfLength; x += 1.5) {
    for (const z of [-halfWidth, 0, halfWidth]) {
      const height = seaHeightAt(ocean, x, z, time);
      heights.push(height);
      lowest = Math.min(lowest, height);
      highest = Math.max(highest, height);
    }
  }
}
heights.sort((first, second) => first - second);
const quantile = fraction => heights[Math.floor(fraction * (heights.length - 1))].toFixed(2);
console.log(`sea height near the ship, 0..6 s: min ${lowest.toFixed(2)} p5 ${quantile(0.05)} median ${quantile(0.5)} p95 ${quantile(0.95)} max ${highest.toFixed(2)} metres`);
