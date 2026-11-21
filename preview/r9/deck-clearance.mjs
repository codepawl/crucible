// Deck clearance per waterline: the lowest height of the main deck (4.0 m above the keel) over the local sea surface, over the whole clip, in the ship's frame.
// Run from a Crucible checkout: node deck-clearance.mjs
import { seaFollow, seaSurfaceHeight } from './ship-follow.mjs';

const DECK_HEIGHT = Number(process.argv[2] ?? 4.0);
const DECK_POINTS = [];
for (const x of [-10, -6, -2, 2, 6]) {
  for (const z of [-3, 0, 3]) DECK_POINTS.push([x + 3.3, DECK_HEIGHT, z]);
}

function rotate(quaternion, vector) {
  const [qx, qy, qz, qw] = quaternion;
  const [vx, vy, vz] = vector;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + qy * tz - qz * ty, vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx];
}

for (const waterline of [3.2, 3.8, 4.3, 4.8]) {
  const { tracks } = seaFollow(6, waterline);
  const translations = tracks[0].keyframes;
  const rotations = tracks[1].keyframes;
  let lowest = Infinity;
  let wettest = 0;
  for (let index = 0; index < translations.length; index++) {
    const time = translations[index].time;
    let wetPoints = 0;
    for (const point of DECK_POINTS) {
      const turned = rotate(rotations[index].value, point);
      const x = translations[index].value[0] + turned[0];
      const y = translations[index].value[1] + turned[1];
      const z = translations[index].value[2] + turned[2];
      const clearance = y - (0.5 + seaSurfaceHeight(x, z, time));
      lowest = Math.min(lowest, clearance);
      if (clearance < 0) wetPoints++;
    }
    wettest = Math.max(wettest, wetPoints);
  }
  console.log(`waterline ${waterline}: lowest deck clearance ${lowest.toFixed(2)} m, most deck points under water in one frame ${wettest} of ${DECK_POINTS.length}`);
}
