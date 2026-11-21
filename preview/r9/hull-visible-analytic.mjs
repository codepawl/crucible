// Which hull points does the camera see over the water? Points of the lower hull (up to 3.0 m above the keel) are moved by the ship's baked track, then
// each is tested with a ray from the clip camera against the sea surface the sea mesh draws (calm level 0.5 m plus seaHeightAt).
// Run from a Crucible checkout: node hull-visible-analytic.mjs <galleon.glb>
import { readFileSync } from 'node:fs';
import { seaFollow, seaSurfaceHeight } from './ship-follow.mjs';

const buffer = readFileSync(process.argv[2]);
const jsonLength = buffer.readUInt32LE(12);
const json = JSON.parse(buffer.slice(20, 20 + jsonLength).toString('utf8'));
const binary = buffer.slice(20 + jsonLength + 8);
const groupOffset = json.nodes[json.scenes[0].nodes[0]].translation[1];
const hullNode = json.nodes.find(node => node.name === 'dutch_ship_large_01_hull');
const accessor = json.accessors[json.meshes[hullNode.mesh].primitives[0].attributes.POSITION];
const view = json.bufferViews[accessor.bufferView];
const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
const stride = view.byteStride || 12;
const points = [];
for (let vertex = 0; vertex < accessor.count; vertex += 40) {
  const point = [binary.readFloatLE(base + stride * vertex), binary.readFloatLE(base + stride * vertex + 4) + groupOffset, binary.readFloatLE(base + stride * vertex + 8)];
  if (point[1] <= 3.0 && point[2] < 0) points.push(point);
}

function rotate(quaternion, vector) {
  const [qx, qy, qz, qw] = quaternion;
  const [vx, vy, vz] = vector;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + qw * tx + qy * tz - qz * ty, vy + qw * ty + qz * tx - qx * tz, vz + qw * tz + qx * ty - qy * tx];
}

function cameraEye(time) {
  const fraction = time / 6;
  return [30 + (24 - 30) * fraction, 3.6 + (3.3 - 3.6) * fraction, -27 + (-33 + 27) * fraction];
}

const times = [0, 1, 2, 3, 4, 5];
console.log('waterline | hull samples seen above the water (share of the near-side lower hull) | lowest seen height above the keel (m), mean over 6 times | rounded bottom (under 1.2 m) seen');
for (const waterline of [3.2, 3.8, 4.3, 4.8]) {
  const { tracks } = seaFollow(6, waterline);
  let seenShare = 0;
  let lowestSeen = 0;
  let bottomSeen = 0;
  for (const time of times) {
    const index = Math.round(time / 0.1);
    const translation = tracks[0].keyframes[index].value;
    const rotation = tracks[1].keyframes[index].value;
    const eye = cameraEye(time);
    let seen = 0;
    let lowest = Infinity;
    let bottom = 0;
    for (const point of points) {
      const turned = rotate(rotation, point);
      const world = [translation[0] + turned[0], translation[1] + turned[1], translation[2] + turned[2]];
      let hidden = false;
      for (let step = 1; step <= 40 && !hidden; step++) {
        const along = step / 41;
        const x = eye[0] + (world[0] - eye[0]) * along;
        const y = eye[1] + (world[1] - eye[1]) * along;
        const z = eye[2] + (world[2] - eye[2]) * along;
        if (y < 0.5 + seaSurfaceHeight(x, z, time)) hidden = true;
      }
      if (world[1] < 0.5 + seaSurfaceHeight(world[0], world[2], time) - 0.05) hidden = true;
      if (!hidden) {
        seen++;
        lowest = Math.min(lowest, point[1]);
        if (point[1] < 1.2) bottom++;
      }
    }
    seenShare += seen / points.length;
    lowestSeen += Number.isFinite(lowest) ? lowest : 3.0;
    bottomSeen += bottom;
  }
  console.log(`${waterline} | ${(100 * seenShare / times.length).toFixed(1)}% | ${(lowestSeen / times.length).toFixed(2)} | ${(bottomSeen / times.length).toFixed(1)} of ${points.filter(point => point[1] < 1.2).length}`);
}
