// The pour scene of the home page, rendered live by Crucible as round splats with their light already in the colour. The page
// scroll is the timeline: the pot tilts, the stream fills an icosahedron mould, the cast cools, leaves the mould and turns.
import { CrucibleRenderer } from './renderer.js';
import { box, cylinder, sphere } from './geometry.js';
import { installUserPasses } from './user-pass.js';
import * as splatEngine from './gaussian-splats.js';

// Pot profile as [radius, height] pairs: thick base, walls that widen to a rolled lip, then the inside wall back down.
const POT_PROFILE = [
  [0.0, 0.0], [0.3, 0.0], [0.44, 0.06], [0.54, 0.22], [0.59, 0.48], [0.57, 0.74], [0.51, 0.9], [0.52, 0.97], [0.6, 1.02],
  [0.6, 1.06], [0.52, 1.06], [0.45, 0.94], [0.5, 0.72], [0.52, 0.48], [0.47, 0.24], [0.36, 0.13], [0.0, 0.12],
];
const POT_SEGMENTS = 96;
// The spout pulls the upper wall out along +X into a pinched beak.
const SPOUT_REACH = 0.17;
const SPOUT_HALF_ANGLE = 0.3;
const SPOUT_START_HEIGHT = 0.8;
// The pot turns about a trunnion close to the lip, so the spout tip moves little while it pours.
const POT_PIVOT = [0.62, 0.9];
const REST_TILT = 0.1;
const POUR_TILT = 1.3;
const MOULD_CENTRE = [1.3, -5.4, 0];
const CAST_RADIUS = 0.62;
const FLASK_HALF = [0.95, 0.95, 0.7];
const SPRUE_TOP = MOULD_CENTRE[1] + FLASK_HALF[1] + 0.16;
const FILL_LEVELS = 24;
const STREAM_SEGMENTS = 30;
const SPRUE_SEGMENTS = 4;
const GRAVITY = 9.8;
const SMALLEST_SCALE = 0.001;
const LARGEST_CANVAS_PIXELS = 2600000;
const POUR_TEMPERATURE = 1400;
const ROOM_TEMPERATURE = 40;

const clampUnit = (value) => Math.max(0, Math.min(1, value));
export const easeUnit = (value) => clampUnit(value) * clampUnit(value) * (3 - 2 * clampUnit(value));
const mixNumber = (from, to, amount) => from + (to - from) * amount;
const mixVector = (from, to, amount) => from.map((value, index) => mixNumber(value, to[index], amount));
const subtract = (first, second) => [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
const cross = (first, second) => [first[1] * second[2] - first[2] * second[1], first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]];
const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
const normalize = (vector) => {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
};

function linearFromHex(hex) {
  return [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
}

function smoothProfile(profile, stepsPerSpan) {
  const points = [];
  const pointAt = (index) => profile[Math.max(0, Math.min(profile.length - 1, index))];
  for (let index = 0; index < profile.length - 1; index++) {
    for (let step = 0; step < stepsPerSpan; step++) {
      const amount = step / stepsPerSpan;
      const point = [0, 1].map((axis) => {
        const before = pointAt(index - 1)[axis];
        const start = pointAt(index)[axis];
        const end = pointAt(index + 1)[axis];
        const after = pointAt(index + 2)[axis];
        return 0.5 * (2 * start + (end - before) * amount + (2 * before - 5 * start + 4 * end - after) * amount ** 2 + (3 * start - before - 3 * end + after) * amount ** 3);
      });
      points.push([Math.max(0, point[0]), point[1]]);
    }
  }
  points.push(profile[profile.length - 1]);
  return points;
}

// Smooth normals from the triangles, so the spout shades correctly without an analytic normal.
function smoothNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let index = 0; index < indices.length; index += 3) {
    const corners = [0, 1, 2].map((corner) => {
      const offset = indices[index + corner] * 3;
      return [positions[offset], positions[offset + 1], positions[offset + 2]];
    });
    const faceNormal = cross(subtract(corners[1], corners[0]), subtract(corners[2], corners[0]));
    for (let corner = 0; corner < 3; corner++) {
      const offset = indices[index + corner] * 3;
      normals[offset] += faceNormal[0];
      normals[offset + 1] += faceNormal[1];
      normals[offset + 2] += faceNormal[2];
    }
  }
  return normals;
}

// A lathe of the profile whose upper rows are pulled out along +X into a pour spout.
function potGeometry() {
  const profile = smoothProfile(POT_PROFILE, 5);
  const ringSize = POT_SEGMENTS + 1;
  const positions = new Float32Array(profile.length * ringSize * 3);
  const indices = new Uint32Array((profile.length - 1) * POT_SEGMENTS * 6);
  for (let row = 0; row < profile.length; row++) {
    const heightWeight = easeUnit((profile[row][1] - SPOUT_START_HEIGHT) / (1.04 - SPOUT_START_HEIGHT));
    for (let segment = 0; segment < ringSize; segment++) {
      const angle = (segment / POT_SEGMENTS) * Math.PI * 2;
      const wrapped = angle > Math.PI ? angle - Math.PI * 2 : angle;
      const pinch = Math.exp(-((wrapped / SPOUT_HALF_ANGLE) ** 2));
      const offset = (row * ringSize + segment) * 3;
      positions[offset] = profile[row][0] * Math.cos(angle) + SPOUT_REACH * heightWeight * pinch;
      positions[offset + 1] = profile[row][1] + 0.05 * heightWeight * pinch;
      positions[offset + 2] = profile[row][0] * Math.sin(angle) * (1 - 0.25 * heightWeight * pinch);
    }
  }
  let cursor = 0;
  for (let row = 0; row < profile.length - 1; row++) {
    for (let segment = 0; segment < POT_SEGMENTS; segment++) {
      const lower = row * ringSize + segment;
      const upper = lower + ringSize;
      indices.set([lower, upper, lower + 1, upper, upper + 1, lower + 1], cursor);
      cursor += 6;
    }
  }
  const normals = smoothNormals(positions, indices);
  for (let row = 0; row < profile.length; row++) {
    const first = row * ringSize * 3;
    const last = (row * ringSize + POT_SEGMENTS) * 3;
    for (let axis = 0; axis < 3; axis++) {
      const shared = normals[first + axis] + normals[last + axis];
      normals[first + axis] = shared;
      normals[last + axis] = shared;
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const unit = normalize([normals[offset], normals[offset + 1], normals[offset + 2]]);
    normals.set(unit, offset);
  }
  // The pour point is the mesh vertex furthest out on the lip of the spout.
  let tipOffset = 0;
  for (let offset = 0; offset < positions.length; offset += 3) {
    if (positions[offset] + 4 * positions[offset + 1] > positions[tipOffset] + 4 * positions[tipOffset + 1]) tipOffset = offset;
  }
  const spoutTip = [positions[tipOffset], positions[tipOffset + 1], positions[tipOffset + 2]];
  return { geometry: { positions, normals, indices }, spoutTip };
}

function icosahedronVertices(radius) {
  const golden = (1 + Math.sqrt(5)) / 2;
  const vertices = [];
  for (const first of [-1, 1]) {
    for (const second of [-1, 1]) {
      vertices.push([0, first, second * golden], [first, second * golden, 0], [second * golden, 0, first]);
    }
  }
  return vertices.map((vertex) => normalize(vertex).map((value) => value * radius));
}

function icosahedronFaces(vertices) {
  const edgeLength = Math.min(...vertices.slice(1).map((vertex) => Math.hypot(...subtract(vertex, vertices[0]))));
  const joined = (first, second) => Math.abs(Math.hypot(...subtract(vertices[first], vertices[second])) - edgeLength) < edgeLength * 0.01;
  const faces = [];
  const edges = [];
  for (let first = 0; first < vertices.length; first++) {
    for (let second = first + 1; second < vertices.length; second++) {
      if (!joined(first, second)) continue;
      edges.push([vertices[first], vertices[second]]);
      for (let third = second + 1; third < vertices.length; third++) {
        if (!joined(first, third) || !joined(second, third)) continue;
        const corners = [vertices[first], vertices[second], vertices[third]];
        const outward = dot(cross(subtract(corners[1], corners[0]), subtract(corners[2], corners[0])), corners[0]) > 0;
        faces.push(outward ? corners : [corners[0], corners[2], corners[1]]);
      }
    }
  }
  return { faces, edges };
}

// Flat-shaded geometry: every triangle keeps its own three vertices and one normal.
function flatGeometry(triangles) {
  const positions = new Float32Array(triangles.length * 9);
  const normals = new Float32Array(triangles.length * 9);
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((triangle, index) => {
    const faceNormal = normalize(cross(subtract(triangle[1], triangle[0]), subtract(triangle[2], triangle[0])));
    for (let corner = 0; corner < 3; corner++) {
      positions.set(triangle[corner], index * 9 + corner * 3);
      normals.set(faceNormal, index * 9 + corner * 3);
      indices[index * 3 + corner] = index * 3 + corner;
    }
  });
  return { positions, normals, indices };
}

// The part of a convex solid below a height, closed with a level cap: the molten metal at one fill level.
function filledTriangles(faces, level) {
  const triangles = [];
  const capPoints = [];
  for (const face of faces) {
    const kept = [];
    for (let corner = 0; corner < 3; corner++) {
      const start = face[corner];
      const end = face[(corner + 1) % 3];
      if (start[1] <= level) kept.push(start);
      if ((start[1] <= level) !== (end[1] <= level)) {
        const crossing = mixVector(start, end, (level - start[1]) / (end[1] - start[1]));
        kept.push(crossing);
        capPoints.push(crossing);
      }
    }
    for (let corner = 1; corner < kept.length - 1; corner++) triangles.push([kept[0], kept[corner], kept[corner + 1]]);
  }
  if (capPoints.length >= 3) {
    const centre = capPoints.reduce((sum, point) => [sum[0] + point[0] / capPoints.length, level, sum[2] + point[2] / capPoints.length], [0, level, 0]);
    const ordered = capPoints.slice().sort((first, second) => Math.atan2(first[2] - centre[2], first[0] - centre[0]) - Math.atan2(second[2] - centre[2], second[0] - centre[0]));
    for (let index = 0; index < ordered.length; index++) {
      const next = ordered[(index + 1) % ordered.length];
      if (Math.hypot(...subtract(next, ordered[index])) > 1e-5) triangles.push([centre, next, ordered[index]]);
    }
  }
  return triangles;
}

// Column-major 4x4 from three axis vectors and a position.
const matrixFromAxes = (axisX, axisY, axisZ, position) => new Float32Array([...axisX, 0, ...axisY, 0, ...axisZ, 0, ...position, 1]);
const placedBox = (position, size) => matrixFromAxes([size[0], 0, 0], [0, size[1], 0], [0, 0, size[2]], position);
const HIDDEN_MATRIX = placedBox([0, -60, 0], [SMALLEST_SCALE, SMALLEST_SCALE, SMALLEST_SCALE]);
const transformPoint = (matrix, point) => [0, 1, 2].map((axis) => matrix[axis] * point[0] + matrix[4 + axis] * point[1] + matrix[8 + axis] * point[2] + matrix[12 + axis]);

// A unit cylinder (radius 1, height 1 along Y) stretched from one point to another.
function rodMatrix(start, end, radius, flatten = 1) {
  const along = subtract(end, start);
  const length = Math.hypot(...along) || 1;
  const direction = along.map((value) => value / length);
  const side = normalize(cross(direction, Math.abs(direction[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]));
  const front = cross(side, direction);
  return matrixFromAxes(side.map((value) => value * radius), along, front.map((value) => value * radius * flatten), mixVector(start, end, 0.5));
}

function boundsOf(geometry) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < geometry.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], geometry.positions[offset + axis]);
      high[axis] = Math.max(high[axis], geometry.positions[offset + axis]);
    }
  }
  return { low, high };
}

// Heat 0 to 1 as a glow colour: dull red, orange, then yellow-white, the order hot metal passes through.
function heatColour(heat) {
  const stops = [[0, [0.25, 0.01, 0]], [0.35, [0.9, 0.07, 0.01]], [0.7, [1, 0.34, 0.05]], [1, [1, 0.5, 0.12]]];
  for (let index = 1; index < stops.length; index++) {
    if (heat <= stops[index][0]) return mixVector(stops[index - 1][1], stops[index][1], (heat - stops[index - 1][0]) / (stops[index][0] - stops[index - 1][0]));
  }
  return stops[stops.length - 1][1];
}

const BAYER_GLSL = 'const float bayer[16] = float[16] (0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);';
const TONGUE_START = [0.3, 1.0, 0];

// Voxel models shared by the stack and splat looks. A cell is addressed by whole-number steps from an anchor point,
// so a point placed on the anchor (the spout tip) always sits in the middle of a cell.
const VOXEL_FACES = [
  { normal: [1, 0, 0], across: [0, 1, 0], upward: [0, 0, 1] },
  { normal: [-1, 0, 0], across: [0, 0, 1], upward: [0, 1, 0] },
  { normal: [0, 1, 0], across: [0, 0, 1], upward: [1, 0, 0] },
  { normal: [0, -1, 0], across: [1, 0, 0], upward: [0, 0, 1] },
  { normal: [0, 0, 1], across: [1, 0, 0], upward: [0, 1, 0] },
  { normal: [0, 0, -1], across: [0, 1, 0], upward: [1, 0, 0] },
];
const cellKey = (index) => `${index[0]},${index[1]},${index[2]}`;
const cellBeside = (index, face) => [index[0] + face.normal[0], index[1] + face.normal[1], index[2] + face.normal[2]];

function voxelSetFromMesh(geometry, cellSize, anchor) {
  const cells = new Map();
  const corner = (vertex) => [geometry.positions[vertex * 3], geometry.positions[vertex * 3 + 1], geometry.positions[vertex * 3 + 2]];
  for (let offset = 0; offset < geometry.indices.length; offset += 3) {
    const first = corner(geometry.indices[offset]);
    const second = corner(geometry.indices[offset + 1]);
    const third = corner(geometry.indices[offset + 2]);
    const longest = Math.max(Math.hypot(...subtract(second, first)), Math.hypot(...subtract(third, second)), Math.hypot(...subtract(first, third)));
    const steps = Math.max(1, Math.ceil(longest / (cellSize * 0.5)));
    for (let along = 0; along <= steps; along++) {
      for (let aside = 0; aside <= steps - along; aside++) {
        const index = [0, 1, 2].map((axis) => Math.round((first[axis] + ((second[axis] - first[axis]) * along + (third[axis] - first[axis]) * aside) / steps - anchor[axis]) / cellSize));
        cells.set(cellKey(index), index);
      }
    }
  }
  return cells;
}

function voxelSetFromInside(inside, reach, cellSize) {
  const cells = new Map();
  const count = Math.ceil(reach / cellSize);
  for (let stepX = -count; stepX <= count; stepX++) {
    for (let stepY = -count; stepY <= count; stepY++) {
      for (let stepZ = -count; stepZ <= count; stepZ++) {
        if (inside([stepX * cellSize, stepY * cellSize, stepZ * cellSize])) cells.set(cellKey([stepX, stepY, stepZ]), [stepX, stepY, stepZ]);
      }
    }
  }
  return cells;
}

// One point per cell that has an open side, with the direction it faces. Cells open on opposite sides face away from the middle.
function surfacePoints(cells, cellSize, anchor, middle) {
  const points = [];
  for (const index of cells.values()) {
    const facing = [0, 0, 0];
    let openSides = 0;
    for (const face of VOXEL_FACES) {
      if (cells.has(cellKey(cellBeside(index, face)))) continue;
      openSides += 1;
      for (let axis = 0; axis < 3; axis++) facing[axis] += face.normal[axis];
    }
    if (openSides === 0) continue;
    const position = [0, 1, 2].map((axis) => anchor[axis] + index[axis] * cellSize);
    const normal = Math.hypot(...facing) > 0.5 ? normalize(facing) : normalize([position[0] - middle[0], 0.4, position[2] - middle[2]]);
    points.push({ position, normal });
  }
  return points;
}

// Grid of points on the six faces of a box, cached by size, for the splat look.
const boxPointCache = new Map();
function boxSurfacePoints(size, cellSize) {
  const key = size.map((value) => value.toFixed(3)).join(',');
  if (boxPointCache.has(key)) return boxPointCache.get(key);
  const points = [];
  for (const face of VOXEL_FACES) {
    const depthAxis = face.normal.findIndex((value) => value !== 0);
    const acrossAxis = face.across.findIndex((value) => value !== 0);
    const upwardAxis = face.upward.findIndex((value) => value !== 0);
    const acrossCount = Math.max(1, Math.round(size[acrossAxis] / cellSize));
    const upwardCount = Math.max(1, Math.round(size[upwardAxis] / cellSize));
    for (let acrossStep = 0; acrossStep < acrossCount; acrossStep++) {
      for (let upwardStep = 0; upwardStep < upwardCount; upwardStep++) {
        const offset = [0, 0, 0];
        offset[depthAxis] = face.normal[depthAxis] * size[depthAxis] * 0.5;
        offset[acrossAxis] = ((acrossStep + 0.5) / acrossCount - 0.5) * size[acrossAxis];
        offset[upwardAxis] = ((upwardStep + 0.5) / upwardCount - 0.5) * size[upwardAxis];
        points.push({ offset, normal: face.normal });
      }
    }
  }
  boxPointCache.set(key, points);
  return points;
}

// The one palette of the pixel-art looks: brand neutrals, then the cooling ramp from white-hot to ember.
const PIXEL_PALETTE = [
  [17, 17, 20], [42, 40, 45], [57, 56, 66], [110, 108, 115], [169, 166, 159], [217, 214, 204], [248, 247, 241],
  [255, 246, 216], [255, 178, 94], [252, 145, 50], [223, 88, 41], [143, 42, 28], [74, 26, 22],
];
const HEAT_SWATCHES = [7, 8, 9, 10, 11, 12].map((entry) => PIXEL_PALETTE[entry]);
const SPLAT_RAMPS = {
  pot: [3, 2, 1], flask: [2, 1, 0], panel: [1, 0, 0], plinth: [5, 4, 3], cage: [6, 5, 4], cold: [4, 3, 2], char: [3, 2, 1],
};
const SPLAT_CAPACITY = 60000;
const SPLAT_BOUNDS = { minimum: [-4, -9, -3], maximum: [6, 3, 3] };

// Pixel-art resolve for the stack and splat looks. It runs at the art-pixel size, so every effect here lands on whole
// pixels: nearest palette colour with ordered dither, an ink outline, a dithered glow around the hot metal, a heat
// shimmer that shifts whole rows, and steam drawn as loose pixels.
const PIXEL_FRAGMENT = `${BAYER_GLSL}
const vec3 swatch[13] = vec3[13](${PIXEL_PALETTE.map((entry) => `vec3(${entry.map((value) => (value / 255).toFixed(4)).join(', ')})`).join(', ')});
float cellNoise(vec2 cell) { return fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453); }
float coverAt(vec2 at) { return texture(sceneColor, at).a; }
float rangeAt(vec2 at) { return length(worldPointAt(at) - eyeAt); }
vec4 userPass(vec2 uv) {
  vec2 texel = 1.0 / resolution;
  float wideness = resolution.x / resolution.y;
  ivec2 cell = ivec2(gl_FragCoord.xy) & 3;
  float threshold = (bayer[cell.y * 4 + cell.x] + 0.5) / 16.0;
  vec2 fromHot = uv - hot;
  float column = step(abs(fromHot.x), 0.08) * step(0.0, fromHot.y) * step(fromHot.y, 0.3) * step(0.3, warmth);
  float shift = floor(sin(gl_FragCoord.y * 0.9 + clock * 7.0) * 1.4 + 0.5) * column;
  vec2 at = uv + vec2(shift * texel.x, 0.0);
  vec4 scene = texture(sceneColor, at);
  vec2 wide = fromHot * vec2(wideness, 1.0);
  float halo = warmth * exp(-dot(wide, wide) * 26.0);
  if (scene.a < 0.5) {
    float around = max(max(coverAt(at + vec2(texel.x, 0.0)), coverAt(at - vec2(texel.x, 0.0))), max(coverAt(at + vec2(0.0, texel.y)), coverAt(at - vec2(0.0, texel.y))));
    if (around >= 0.5) return vec4(swatch[0], 1.0);
    vec2 rise = (uv - smokeAt) * vec2(wideness, 1.0);
    float plume = smoke * step(0.0, rise.y) * exp(-rise.x * rise.x / (0.003 + rise.y * 0.05)) * (1.0 - smoothstep(0.12, 0.4, rise.y));
    float puff = cellNoise(floor(gl_FragCoord.xy / 2.0) - vec2(0.0, floor(clock * 8.0)));
    if (plume * puff > 0.4) return vec4(swatch[puff > 0.8 ? 3 : 4], 1.0);
    if (min(halo, 0.42) > threshold + 0.06) return vec4(swatch[halo > 0.45 ? 8 : (halo > 0.22 ? 9 : 10)], 1.0);
    return vec4(paper, 1.0);
  }
  vec3 tone = scene.rgb;
  float coolness = smoothstep(0.0, 0.05, max(tone.g, tone.b) - tone.r);
  tone = mix(tone, vec3(dot(tone, vec3(0.3, 0.59, 0.11))) * vec3(1.0, 0.98, 1.05), coolness);
  tone += vec3(0.55, 0.2, 0.02) * halo * spill + (threshold - 0.5) * spread;
  int best = 0;
  float closest = 100.0;
  for (int index = 0; index < 13; index++) {
    vec3 gap = tone - swatch[index];
    float apart = dot(gap, gap);
    if (apart < closest) {
      closest = apart;
      best = index;
    }
  }
  if (edges > 0.5) {
    float here = rangeAt(at);
    float nearer = min(min(rangeAt(at + vec2(texel.x, 0.0)), rangeAt(at - vec2(texel.x, 0.0))), min(rangeAt(at + vec2(0.0, texel.y)), rangeAt(at - vec2(0.0, texel.y))));
    if (here - nearer > 0.3) best = 0;
  }
  return vec4(swatch[best], 1.0);
}`;

const LIGHT_PAPER = [248 / 255, 247 / 255, 241 / 255];
const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

// The paper of the pixel art is the page background, so the text beside the scene stays readable in both colour schemes.
function readPagePaper() {
  const background = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(background);
  if (!hex) return LIGHT_PAPER;
  const value = parseInt(hex[1], 16);
  return [(value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

let pagePaper = readPagePaper();
window.matchMedia(DARK_SCHEME_QUERY).addEventListener('change', () => {
  pagePaper = readPagePaper();
});
const FOUNDRY_LOOKS = {
  splats: {
    hdr: false, pixelSize: 3, pixelArt: true, blocky: true, splats: true, cell: 0.05, streamWidth: 1.2, spread: 0, spill: 0.5, edges: 0, sparkCount: 14, emberCount: 8, emission: 0.55, blackbody: true, glowLight: 0.2, lightColour: [1, 0.6, 0.3],
    panel: { color: linearFromHex('#111114'), metallic: 0, roughness: 0.9 },
    environment: { lightDirection: [-0.5, 0.9, 0.7], keyIntensity: 1.5, fillIntensity: 0.6, ambientIntensity: 0.8 },
    pot: { color: linearFromHex('#393842'), metallic: 0, roughness: 0.8 }, mould: { color: linearFromHex('#2a282d'), metallic: 0, roughness: 0.8 },
    cage: { color: linearFromHex('#d9d6cc'), metallic: 0, roughness: 0.8 }, cold: { color: linearFromHex('#6e6c73'), metallic: 0, roughness: 0.8 },
    effects: {},
  },
};

// Everything the story shows at one scroll progress. Pure: the same progress always gives the same scene.
// Staged look: the melt reaches the lip before it pours, the level follows the volume poured, and the mould leaves the frame.
const stagedTiltAt = (progress) => REST_TILT + (POUR_TILT - REST_TILT) * (easeUnit((progress - 0.06) / 0.2) - easeUnit((progress - 0.56) / 0.1));

function stagedTimelineAt(progress, pourStart) {
  const poured = clampUnit((progress - 0.36) / 0.22);
  return {
    tilt: stagedTiltAt(progress),
    head: clampUnit((progress - pourStart) / (0.36 - pourStart)),
    tail: clampUnit((progress - 0.56) / 0.08),
    // The cavity is close to a ball, so equal volumes raise the level fast at the ends and slowly in the middle.
    fill: 0.5 - Math.sin(Math.asin(1 - 2 * poured) / 3),
    cool: clampUnit((progress - 0.6) / 0.18),
    open: easeUnit((progress - 0.78) / 0.1),
    rise: easeUnit((progress - 0.82) / 0.11),
    spin: easeUnit((progress - 0.8) / 0.2) * Math.PI * 1.5,
    followHead: easeUnit((progress - (pourStart + 0.05)) / 0.16),
    reachMould: easeUnit((progress - 0.31) / 0.08),
    drained: clampUnit((progress - pourStart) / (0.56 - pourStart)),
  };
}

function timelineAt(progress, staged = false, pourStart = 0.16) {
  if (staged) return stagedTimelineAt(progress, pourStart);
  return {
    tilt: REST_TILT + (POUR_TILT - REST_TILT) * (easeUnit((progress - 0.04) / 0.18) - easeUnit((progress - 0.56) / 0.1)),
    head: clampUnit((progress - 0.16) / 0.2),
    tail: clampUnit((progress - 0.56) / 0.08),
    fill: easeUnit((progress - 0.36) / 0.22),
    cool: clampUnit((progress - 0.62) / 0.16),
    open: easeUnit((progress - 0.74) / 0.1),
    rise: easeUnit((progress - 0.8) / 0.12),
    spin: easeUnit((progress - 0.78) / 0.22) * Math.PI * 2.5,
    followHead: easeUnit((progress - 0.15) / 0.14),
    reachMould: easeUnit((progress - 0.31) / 0.08),
  };
}

// Builds the foundry in a canvas with Crucible. Returns null when the engine, the pass addon or WebGL2 is not available.
export async function createFoundry(canvas) {
  const look = FOUNDRY_LOOKS.splats;
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 520;
  const sparkCount = smallScreen ? Math.ceil(look.sparkCount / 2) : look.sparkCount;
  const emberCount = smallScreen ? Math.ceil(look.emberCount / 2) : look.emberCount;
  const state = { progress: 0, time: 0, heroAmount: 0, region: null };
  const staged = Boolean(look.splats);
  const glowColour = (heat) => (look.blackbody ? heatColour(heat) : [1, 0.26, 0.03]);
  const moltenBase = look.blackbody ? [0.6, 0.12, 0.02] : [0.25, 0.03, 0];
  const moltenMaterial = { color: moltenBase, emissiveColor: glowColour(1), metallic: 0, roughness: 0.6, emission: look.emission };
  const castMaterial = { ...moltenMaterial, emissiveColor: glowColour(1) };
  const sparkMaterial = { ...moltenMaterial, emission: look.emission * 1.6 };
  const solid = (surface) => ({ ...surface, emission: 0 });
  const pot = potGeometry();
  const castVertices = icosahedronVertices(CAST_RADIUS);
  const cast = icosahedronFaces(castVertices);
  const castLow = Math.min(...castVertices.map((vertex) => vertex[1]));
  const castHigh = Math.max(...castVertices.map((vertex) => vertex[1]));
  const blocky = Boolean(look.blocky);
  const cellSize = blocky ? look.cell * (smallScreen ? 1.35 : 1) : 0;
  const castPlanes = cast.faces.map((face) => {
    const facing = normalize(cross(subtract(face[1], face[0]), subtract(face[2], face[0])));
    const outward = dot(facing, face[0]) > 0 ? facing : facing.map((value) => -value);
    return { normal: outward, reach: dot(outward, face[0]) };
  });
  const potCells = blocky ? voxelSetFromMesh(pot.geometry, cellSize, pot.spoutTip) : null;
  const castCells = blocky ? voxelSetFromInside((point) => castPlanes.every((plane) => dot(plane.normal, point) <= plane.reach), CAST_RADIUS, cellSize) : null;
  const lowestCell = blocky ? [...castCells.values()].reduce((lowest, index) => (index[1] < lowest[1] ? index : lowest)) : null;
  const potPoints = look.splats ? surfacePoints(potCells, cellSize, pot.spoutTip, [0, 0.5, 0]) : [];
  // Each cast cell takes the direction of the icosahedron face it lies under, so the facets keep their own tone.
  const faceOver = (position) => castPlanes.reduce((best, plane) => (dot(plane.normal, position) - plane.reach > dot(best.normal, position) - best.reach ? plane : best));
  const castPoints = look.splats ? surfacePoints(castCells, cellSize, [0, 0, 0], [0, 0, 0]).map((point) => ({ position: point.position, normal: faceOver(point.position).normal })) : [];
  const fillPoints = look.splats ? [...castCells.values()].map((index) => ({ position: index.map((value) => value * cellSize), outer: VOXEL_FACES.some((face) => !castCells.has(cellKey(cellBeside(index, face)))) })) : [];
  // Staged look: the melt keeps a level surface while the pot turns, so it climbs to the lip, pours and drains.
  const POT_BOWL_CENTRE = [0, 0.5, 0];
  const MELT_REST_ABOVE = 0.46;
  const MELT_SPENT_ABOVE = -0.12;
  const INNER_WALL = [[0.12, 0.36], [0.24, 0.47], [0.48, 0.52], [0.72, 0.5], [0.94, 0.45], [1.06, 0.52]];
  const innerRadiusAt = (height) => {
    for (let index = 1; index < INNER_WALL.length; index++) {
      if (height <= INNER_WALL[index][0]) return mixNumber(INNER_WALL[index - 1][1], INNER_WALL[index][1], (height - INNER_WALL[index - 1][0]) / (INNER_WALL[index][0] - INNER_WALL[index - 1][0]));
    }
    return INNER_WALL[INNER_WALL.length - 1][1];
  };
  // Distance from a point in pot space to the inner wall; zero or less means outside the melt's room.
  const potMargin = (local) => {
    const heightWeight = easeUnit((local[1] - SPOUT_START_HEIGHT) / (1.04 - SPOUT_START_HEIGHT));
    const angle = Math.atan2(local[2], local[0]);
    const pinch = Math.exp(-((angle / SPOUT_HALF_ANGLE) ** 2));
    const height = local[1] - 0.05 * heightWeight * pinch;
    if (height < 0.13 || height > 1.07) return 0;
    return innerRadiusAt(height) + (SPOUT_REACH + 0.07) * heightWeight * pinch - 0.03 - Math.hypot(local[0], local[2]);
  };
  const lipHeight = (potMatrix) => transformPoint(potMatrix, pot.spoutTip)[1] - 0.02;
  const meltLevel = (potMatrix, drained) => Math.min(transformPoint(potMatrix, POT_BOWL_CENTRE)[1] + mixNumber(MELT_REST_ABOVE, MELT_SPENT_ABOVE, drained), lipHeight(potMatrix));
  let pourStart = 0.16;
  if (staged) {
    for (let progress = 0.04; progress < 0.3; progress += 0.002) {
      const matrix = potMatrixAt(stagedTiltAt(progress));
      if (lipHeight(matrix) <= transformPoint(matrix, POT_BOWL_CENTRE)[1] + MELT_REST_ABOVE) {
        pourStart = progress;
        break;
      }
    }
  }
  const storyAt = (progress) => timelineAt(progress, staged, pourStart);
  const splashCount = smallScreen ? 6 : 10;
  let agitation = 0;
  let agitationTime = 0;
  let idleTurn = 0;
  let turnTime = 0;
  const parts = [];
  const groups = {};
  let renderer;
  let drawnParts = parts;
  let lastView = null;
  try {
    const rod = cylinder(blocky ? 4 : 12);
    const disc = cylinder(40);
    const block = box();
    const ball = blocky ? block : sphere(8, 6);
    const add = (group, name, geometry, material) => {
      const part = { name, geometry, matrix: HIDDEN_MATRIX, material, bounds: boundsOf(geometry) };
      parts.push(part);
      (groups[group] ||= []).push(part);
      return part;
    };
    add('pot', 'Pot', pot.geometry, solid(look.pot));
    add('melt', 'Melt', disc, moltenMaterial);
    add('tongue', 'Spout melt', rod, moltenMaterial);
    add('trunnion', 'Trunnion', rod, solid(look.mould));
    for (let index = 0; index < STREAM_SEGMENTS + SPRUE_SEGMENTS; index++) add('stream', `Stream ${index}`, rod, moltenMaterial);
    add('plinth', 'Plinth', block, solid(look.mould));
    for (let index = 0; index < 22; index++) add('flask', `Flask ${index}`, block, solid(index % 11 === 8 || index % 11 === 10 ? look.panel : look.mould));
    cast.edges.forEach((edge, index) => add('cage', `Cavity edge ${index}`, rod, solid(look.cage)));
    for (let level = 1; level < FILL_LEVELS; level++) {
      const fillTop = mixNumber(castLow, castHigh, level / FILL_LEVELS);
      add('fill', `Fill ${level}`, flatGeometry(filledTriangles(cast.faces, fillTop)), moltenMaterial);
    }
    add('riser', 'Riser', rod, castMaterial);
    add('cast', 'Cast', flatGeometry(cast.faces), castMaterial);
    for (let index = 0; index < sparkCount + emberCount; index++) add('spark', `Spark ${index}`, ball, sparkMaterial);
    const pixelRatio = look.pixelSize > 1 ? 1 : Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(LARGEST_CANVAS_PIXELS / Math.max(1, canvas.clientWidth * canvas.clientHeight)));
    if (look.splats) drawnParts = [{ name: 'Anchor', geometry: block, matrix: HIDDEN_MATRIX, material: solid(look.pot) }];
    renderer = new CrucibleRenderer(canvas, drawnParts, { ground: false, transparent: true, depth: true, hdr: look.hdr, samples: look.pixelArt ? 1 : 4, memoryBudgetMiB: 256, pixelRatio, environment: look.environment });
    installUserPasses(renderer);
  } catch (error) {
    console.warn('Crucible foundry unavailable:', error.message);
    return null;
  }

  function potMatrixAt(tilt) {
    const cosine = Math.cos(tilt);
    const sine = Math.sin(tilt);
    const axisX = [cosine, -sine, 0];
    const axisY = [sine, cosine, 0];
    const position = [POT_PIVOT[0] - (axisX[0] * POT_PIVOT[0] + axisY[0] * POT_PIVOT[1]), POT_PIVOT[1] - (axisX[1] * POT_PIVOT[0] + axisY[1] * POT_PIVOT[1]), 0];
    return matrixFromAxes(axisX, axisY, [0, 0, 1], position);
  }

  // The stream leaves along the spout axis and falls under gravity; its speed is the one that lands it in the mould gate.
  function streamPath(potMatrix, fillHeight) {
    const tip = transformPoint(potMatrix, pot.spoutTip);
    const axis = [potMatrix[0], potMatrix[1], 0];
    const reach = (MOULD_CENTRE[0] - tip[0]) / Math.max(0.2, axis[0]);
    const fallTime = Math.sqrt(Math.max(0.02, (2 * (tip[1] + reach * axis[1] - SPRUE_TOP)) / GRAVITY));
    const speed = reach / fallTime;
    const landing = [tip[0] + axis[0] * reach, SPRUE_TOP, 0];
    const split = STREAM_SEGMENTS / (STREAM_SEGMENTS + SPRUE_SEGMENTS);
    return (amount) => {
      if (amount <= split) {
        // Staged look: the stream is sampled finely near the lip, so its first piece leaves along the spout.
        const elapsed = (staged ? (amount / split) ** 1.5 : amount / split) * fallTime;
        return [tip[0] + axis[0] * speed * elapsed, tip[1] + axis[1] * speed * elapsed - 0.5 * GRAVITY * elapsed * elapsed, 0];
      }
      return [landing[0], mixNumber(SPRUE_TOP, fillHeight, (amount - split) / (1 - split)), 0];
    };
  }

  function layout() {
    const story = storyAt(state.progress);
    const potMatrix = potMatrixAt(story.tilt);
    const pouring = story.head > 0 && story.tail < 1;
    const heat = 1 - story.cool;
    for (const part of groups.pot) part.matrix = potMatrix;
    const inPot = (axisX, axisY, axisZ, position) => {
      const turned = (vector) => [potMatrix[0] * vector[0] + potMatrix[4] * vector[1], potMatrix[1] * vector[0] + potMatrix[5] * vector[1], vector[2]];
      return matrixFromAxes(turned(axisX), turned(axisY), turned(axisZ), transformPoint(potMatrix, position));
    };
    groups.melt[0].matrix = inPot([0.5, 0, 0], [0, 0.03, 0], [0, 0, 0.5], [0, 0.99, 0]);
    const tongueReach = easeUnit((story.tilt - 0.5) / 0.45) * (1 - story.tail);
    const tongueStart = TONGUE_START;
    const tongueEnd = mixVector(tongueStart, pot.spoutTip, Math.max(0.02, tongueReach));
    const tongueLocal = rodMatrix(tongueStart, tongueEnd, 0.085, 1.4);
    groups.tongue[0].matrix = tongueReach > 0.02 && !staged ? inPot([tongueLocal[0], tongueLocal[1], tongueLocal[2]], [tongueLocal[4], tongueLocal[5], tongueLocal[6]], [tongueLocal[8], tongueLocal[9], tongueLocal[10]], [tongueLocal[12], tongueLocal[13] - 0.03, tongueLocal[14]]) : HIDDEN_MATRIX;
    groups.trunnion[0].matrix = rodMatrix([POT_PIVOT[0], POT_PIVOT[1], -0.82], [POT_PIVOT[0], POT_PIVOT[1], 0.82], 0.07);

    const fillHeight = MOULD_CENTRE[1] + mixNumber(castLow, castHigh, story.fill);
    const path = streamPath(potMatrix, fillHeight);
    const segmentCount = STREAM_SEGMENTS + SPRUE_SEGMENTS;
    groups.stream.forEach((part, index) => {
      const startAmount = Math.max(story.tail, index / segmentCount);
      const endAmount = Math.min(story.head, (index + 1) / segmentCount + 0.004);
      const wobble = 1 + 0.1 * Math.sin(state.time * 9 - index * 0.9);
      const fallen = Math.min(1, index / STREAM_SEGMENTS);
      // Staged look: the stream is as thin as the lip it leaves and thickens only a little on the way down.
      const radius = staged ? (0.03 + 0.012 * fallen) * (0.75 + 0.25 * easeUnit(story.head * 4)) * (1 + (wobble - 1) * 0.5) : (0.07 - 0.025 * fallen) * wobble * (look.streamWidth ?? 1);
      part.matrix = pouring && endAmount - startAmount > 0.002 ? rodMatrix(path(startAmount), path(endAmount), radius) : HIDDEN_MATRIX;
    });

    const centre = MOULD_CENTRE;
    // Staged look: the halves are thrown clear of the frame and the plinth drops away, so only the cast is left.
    const slide = staged ? story.open * 0.6 + story.open * story.open * 7 : story.open * 1.5;
    const hop = staged ? 0.9 * story.open - 3.2 * story.open * story.open : 0;
    const plinthDrop = staged ? story.open * story.open * 6 : 0;
    groups.plinth[0].matrix = placedBox([centre[0], centre[1] - FLASK_HALF[1] - 0.2 - plinthDrop, 0], [3.4, 0.22, 2.2]);
    let flaskIndex = 0;
    const flaskBar = (side, position, size) => {
      groups.flask[flaskIndex].matrix = placedBox([centre[0] + side * (position[0] + slide), centre[1] + position[1] + hop, position[2]], size);
      flaskIndex += 1;
    };
    const bar = 0.1;
    for (const side of [-1, 1]) {
      for (const depth of [-1, 1]) {
        flaskBar(side, [FLASK_HALF[0], 0, depth * FLASK_HALF[2]], [bar, FLASK_HALF[1] * 2 + bar, bar]);
        for (const height of [-1, 1]) flaskBar(side, [FLASK_HALF[0] / 2 + 0.02, height * FLASK_HALF[1], depth * FLASK_HALF[2]], [FLASK_HALF[0] - 0.04, bar, bar]);
      }
      for (const height of [-1, 1]) flaskBar(side, [FLASK_HALF[0], height * FLASK_HALF[1], 0], [bar, bar, FLASK_HALF[2] * 2]);
      flaskBar(side, [FLASK_HALF[0] / 2 + 0.02, 0, -FLASK_HALF[2] - 0.02], [FLASK_HALF[0] - 0.04, FLASK_HALF[1] * 2, 0.05]);
      flaskBar(side, [0.2, FLASK_HALF[1] + 0.1, 0], [0.14, 0.3, 0.5]);
      flaskBar(side, [FLASK_HALF[0] / 2 + 0.02, -FLASK_HALF[1] - 0.02, 0], [FLASK_HALF[0] - 0.04, 0.05, FLASK_HALF[2] * 2]);
    }
    groups.cage.forEach((part, index) => {
      const edge = cast.edges[index];
      const side = edge[0][0] + edge[1][0] >= 0 ? 1 : -1;
      const place = (vertex) => [centre[0] + vertex[0] * 1.05 + side * slide, centre[1] + vertex[1] * 1.05 + hop, vertex[2] * 1.05];
      part.matrix = rodMatrix(place(edge[0]), place(edge[1]), 0.024);
    });

    // The hero pulls the camera back on a tall screen; the mould waits out of sight until the story starts.
    if (staged && state.region && state.heroAmount > 0) {
      for (const part of [groups.plinth[0], ...groups.flask, ...groups.cage]) part.matrix = HIDDEN_MATRIX;
    }
    const level = Math.round(story.fill * FILL_LEVELS);
    groups.fill.forEach((part, index) => {
      part.matrix = index + 1 === level && level < FILL_LEVELS ? placedBox(centre, [1, 1, 1]) : HIDDEN_MATRIX;
    });
    const castShown = level >= FILL_LEVELS;
    const castScale = 1 + 0.25 * story.rise;
    const castCentre = [centre[0], centre[1] + story.rise * 0.55, 0];
    // Staged look: once it is free the cast keeps turning slowly, by the time that passes and not by the clock.
    if (staged && state.time > turnTime) idleTurn += Math.min(0.1, state.time - turnTime) * 0.45 * story.rise;
    turnTime = state.time;
    const turn = story.spin + idleTurn;
    const cosine = Math.cos(turn);
    const sine = Math.sin(turn);
    const lean = 0.35 * story.rise;
    const castMatrix = castShown ? matrixFromAxes([cosine * castScale, 0, -sine * castScale], [sine * Math.sin(lean) * castScale, Math.cos(lean) * castScale, cosine * Math.sin(lean) * castScale], [sine * Math.cos(lean) * castScale, -Math.sin(lean) * castScale, cosine * Math.cos(lean) * castScale], castCentre) : HIDDEN_MATRIX;
    for (const part of groups.cast) part.matrix = castMatrix;
    const riserHeight = (1 - story.open) * (SPRUE_TOP - 0.1 - (centre[1] + castHigh));
    groups.riser[0].matrix = castShown && riserHeight > 0.02 ? rodMatrix([centre[0], centre[1] + castHigh - 0.05, 0], [centre[0], centre[1] + castHigh + riserHeight, 0], 0.1) : HIDDEN_MATRIX;

    const landed = pouring && story.head >= 1 && story.tail <= 0;
    groups.spark.forEach((part, index) => {
      const ember = index >= sparkCount;
      const life = (state.time * (ember ? 0.32 : 0.6) + index * 0.618) % 1;
      const direction = index * 2.399;
      const origin = ember ? path(((index * 0.37) % 1) * 0.7 * story.head) : [centre[0], SPRUE_TOP + 0.05, 0];
      const reach = (ember ? 0.5 : 0.35) + (index % 3) * 0.2;
      const height = ember ? -1.4 * life * life + 0.25 * life : (1.7 * life - 2.2 * life * life) * (0.6 + (index % 4) * 0.22);
      // Staged look: fewer embers, and none before the stream has left the lip.
      let thinned = 1;
      if (staged && ember) thinned = index % 2 === 0 ? easeUnit(story.head * 4 - 0.4) : 0;
      const size = (ember ? 0.012 : 0.02) * (1 - life) * ((ember ? pouring : landed) ? 1 : 0) * thinned;
      part.matrix = size > SMALLEST_SCALE ? placedBox([origin[0] + Math.cos(direction) * reach * life, origin[1] + height, origin[2] + Math.sin(direction) * reach * life], [size, size, size]) : HIDDEN_MATRIX;
    });

    moltenMaterial.emission = look.emission;
    castMaterial.emission = look.emission * heat * heat;
    castMaterial.emissiveColor = glowColour(heat);
    castMaterial.color = mixVector(look.cold.color, moltenBase, heat * heat);
    castMaterial.metallic = mixNumber(look.cold.metallic, 0, heat);
    castMaterial.roughness = mixNumber(look.cold.roughness, 0.6, heat);

    // The liquid in the mould is stirred while the stream lands and settles once it stops.
    if (state.time <= agitationTime) {
      agitation = landed ? 1 : 0;
    } else {
      agitation += ((landed ? 1 : 0) - agitation) * (1 - Math.exp(-Math.min(0.1, state.time - agitationTime) * (landed ? 6 : 1.4)));
    }
    agitationTime = state.time;
    const streamPoint = path(Math.max(story.tail, Math.min(story.head * 0.7, 0.3)));
    const meltTop = staged ? meltLevel(potMatrix, story.drained) : 0;
    const tip = transformPoint(potMatrix, pot.spoutTip);
    const headPoint = path(story.head);
    const mouldGlow = Math.max(landed ? 0.5 : 0, story.fill) * heat;
    return { story, potMatrix, tip, headPoint, castCentre, castScale, heat, mouldGlow, fillHeight, pouring, castShown, landed, agitation, streamPoint, meltTop };
  }

  function viewOf(scene) {
    const story = scene.story;
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    // The hero keeps the pot inside the part of the canvas that the words leave free.
    const region = state.region;
    const heroAmount = region ? state.heroAmount : 0;
    const heroWiden = region ? Math.max(1 / region.heightShare, 0.92 / (aspect * region.widthShare)) : 1;
    const widen = mixNumber(Math.max(1, 0.92 / aspect), heroWiden, heroAmount);
    let target = mixVector([0.42, 0.6, 0], [scene.headPoint[0] * 0.8 + 0.2, scene.headPoint[1] - 0.5, 0], story.followHead);
    target = mixVector(target, [MOULD_CENTRE[0], MOULD_CENTRE[1] + (staged ? -0.12 : 0.2), 0], story.reachMould);
    target = mixVector(target, [scene.castCentre[0], scene.castCentre[1] + 0.05, 0], story.rise);
    const distance = mixNumber(mixNumber(mixNumber(5.6, 6.6, story.followHead), staged ? 7 : 6.2, story.reachMould), 5.4, story.rise) * widen;
    const yaw = mixNumber(mixNumber(mixNumber(0.34, 0.16, story.followHead), -0.3, story.reachMould), -0.12, story.rise);
    const pitch = mixNumber(mixNumber(mixNumber(0.36, 0.08, story.followHead), 0.3, story.reachMould), 0.16, story.rise);
    const eye = [target[0] + Math.sin(yaw) * Math.cos(pitch) * distance, target[1] + Math.sin(pitch) * distance, target[2] + Math.cos(yaw) * Math.cos(pitch) * distance];
    if (heroAmount > 0) {
      const forward = normalize(subtract(target, eye));
      const right = normalize(cross(forward, [0, 1, 0]));
      const up = cross(right, forward);
      const halfHeight = Math.tan((30 * Math.PI) / 360) * distance;
      const across = -(2 * region.centreX - 1) * heroAmount * halfHeight * aspect;
      const upward = (2 * region.centreY - 1) * heroAmount * halfHeight;
      const moved = (point) => [0, 1, 2].map((axis) => point[axis] + right[axis] * across + up[axis] * upward);
      return { eye: moved(eye), target: moved(target), fov: 30, distance, aspect };
    }
    return { eye, target, fov: 30, distance, aspect };
  }

  // Projects a world point to CSS pixels inside the canvas, with the same camera the frame was drawn with.
  function project(view, point) {
    const forward = normalize(subtract(view.target, view.eye));
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const offset = subtract(point, view.eye);
    const depth = Math.max(0.01, dot(offset, forward));
    const scale = Math.tan((view.fov * Math.PI) / 360) * depth;
    const across = dot(offset, right) / (scale * view.aspect);
    const upward = dot(offset, up) / scale;
    return [(across * 0.5 + 0.5) * canvas.clientWidth, (0.5 - upward * 0.5) * canvas.clientHeight];
  }

  function passesFor(scene, view) {
    const toUv = (point) => {
      const pixel = project(view, point);
      return [pixel[0] / canvas.clientWidth, 1 - pixel[1] / canvas.clientHeight];
    };
    const story = scene.story;
    const hotPoint = story.reachMould > 0.5 ? [MOULD_CENTRE[0], Math.max(scene.fillHeight, scene.castCentre[1]), 0] : mixVector(scene.tip, scene.headPoint, 0.15);
    const heatNow = story.reachMould > 0.5 ? scene.mouldGlow + (scene.castShown ? scene.heat * 0.6 : 0) : 1;
    const smoke = scene.castShown ? Math.sin(Math.PI * clampUnit(story.cool * 0.8 + story.open * 0.2)) : 0;
    const focusPoint = story.followHead > 0 && story.reachMould < 1 ? mixVector(scene.headPoint, MOULD_CENTRE, story.reachMould) : view.target;
    const common = { hot: toUv(hotPoint), clock: state.time };
    if (look.pixelArt) {
      const pixelSize = canvas.clientWidth < 520 ? 2 : look.pixelSize;
      const uniforms = { ...common, paper: pagePaper, warmth: Math.min(1, heatNow), smoke, smokeAt: toUv([scene.castCentre[0], scene.castCentre[1] + CAST_RADIUS * 0.6, 0]), eyeAt: view.eye, spread: look.spread, spill: look.spill, edges: look.edges };
      return [{ name: 'pixel-art', scale: 1 / pixelSize, uniforms, fragment: PIXEL_FRAGMENT }];
    }
  }

  // Splat look: every frame the scene is written again as round splats with their light already in the colour.
  // Each list is derived from the same matrices the mesh looks submit, so the probe and the boxes stay true.
  const splatStore = look.splats ? { positions: new Float32Array(SPLAT_CAPACITY * 3), colors: new Uint8Array(SPLAT_CAPACITY * 4), scales: new Float32Array(SPLAT_CAPACITY * 3), rotations: new Float32Array(SPLAT_CAPACITY * 4), count: 0 } : null;
  if (splatStore) {
    for (let index = 0; index < SPLAT_CAPACITY; index++) splatStore.rotations[index * 4] = 1;
  }
  const lightDirection = normalize(look.environment.lightDirection);
  const bandOf = (normal) => {
    const lit = dot(normal, lightDirection);
    if (lit > 0.45) return 0;
    return lit > -0.15 ? 1 : 2;
  };
  const rampColour = (ramp, band) => PIXEL_PALETTE[ramp[band]];
  const putSplat = (position, colour, size) => {
    if (splatStore.count >= SPLAT_CAPACITY) return;
    const slot = splatStore.count;
    splatStore.positions.set(position, slot * 3);
    splatStore.colors.set([colour[0], colour[1], colour[2], 255], slot * 4);
    splatStore.scales.set([size, size, size], slot * 3);
    splatStore.count += 1;
  };
  const partShown = (part) => part.matrix !== HIDDEN_MATRIX;
  const partCentre = (part) => [part.matrix[12], part.matrix[13], part.matrix[14]];
  const pointsAlong = (part, spacing, visit) => {
    const centre = partCentre(part);
    const along = [part.matrix[4], part.matrix[5], part.matrix[6]];
    const steps = Math.max(1, Math.ceil(Math.hypot(...along) / spacing));
    for (let step = 0; step <= steps; step++) visit([0, 1, 2].map((axis) => centre[axis] + along[axis] * (step / steps - 0.5)), step / steps);
  };
  const heatSwatch = (heat, band) => (heat < 0.1 ? rampColour(SPLAT_RAMPS.cold, band) : HEAT_SWATCHES[Math.min(5, Math.floor((1 - heat) * 5.2) + band)]);

  function writeSplats(scene) {
    const story = scene.story;
    const splatSize = cellSize * 0.62;
    splatStore.count = 0;
    const potMatrix = scene.potMatrix;
    for (const point of potPoints) {
      const turned = [potMatrix[0] * point.normal[0] + potMatrix[4] * point.normal[1], potMatrix[1] * point.normal[0] + potMatrix[5] * point.normal[1], point.normal[2]];
      putSplat(transformPoint(potMatrix, point.position), rampColour(SPLAT_RAMPS.pot, bandOf(turned)), splatSize);
    }
    const meltStep = cellSize * 0.8;
    const bowl = transformPoint(potMatrix, POT_BOWL_CENTRE);
    const offsetY = scene.meltTop - potMatrix[13];
    for (let worldX = bowl[0] - 1.3; worldX <= bowl[0] + 1.3; worldX += meltStep) {
      const offsetX = worldX - potMatrix[12];
      const local = [potMatrix[0] * offsetX + potMatrix[1] * offsetY, potMatrix[4] * offsetX + potMatrix[5] * offsetY, 0];
      for (let worldZ = -0.62; worldZ <= 0.62; worldZ += meltStep) {
        local[2] = worldZ;
        const margin = potMargin(local);
        if (margin <= 0) continue;
        const shimmer = Math.sin(state.time * 3 + worldX * 9 + worldZ * 7) > 0.6;
        let ring = 2;
        if (margin > 0.1) ring = 1;
        if (margin > 0.24) ring = shimmer ? 1 : 0;
        putSplat([worldX, scene.meltTop, worldZ], HEAT_SWATCHES[ring], splatSize);
      }
    }
    groups.stream.forEach((part, segment) => {
      if (!partShown(part)) return;
      const width = Math.hypot(part.matrix[0], part.matrix[1], part.matrix[2]);
      pointsAlong(part, Math.min(cellSize * 0.5, width * 0.9), (position, amount) => {
        const flicker = Math.sin(state.time * 11 - (segment + amount) * 2.1);
        // The bright core sits on the centreline that starts at the spout tip; one darker flank behind it gives it a round body.
        putSplat([position[0] - width * 0.55, position[1], position[2] - width * 0.3], HEAT_SWATCHES[flicker > 0.3 ? 2 : 3], width * 0.55);
        putSplat(position, HEAT_SWATCHES[flicker > 0 ? 0 : 1], width * 0.7);
      });
    });
    const boxSplats = (part, ramp) => {
      if (!partShown(part)) return;
      const centre = partCentre(part);
      for (const point of boxSurfacePoints([part.matrix[0], part.matrix[5], part.matrix[10]], cellSize)) {
        putSplat([centre[0] + point.offset[0], centre[1] + point.offset[1], centre[2] + point.offset[2]], rampColour(ramp, bandOf(point.normal)), splatSize);
      }
    };
    boxSplats(groups.plinth[0], SPLAT_RAMPS.plinth);
    groups.flask.forEach((part, index) => boxSplats(part, index % 11 === 8 || index % 11 === 10 ? SPLAT_RAMPS.panel : SPLAT_RAMPS.flask));
    for (const part of groups.cage.filter(partShown)) pointsAlong(part, cellSize * 0.7, (position, amount) => putSplat(position, rampColour(SPLAT_RAMPS.cage, amount > 0.5 ? 0 : 1), splatSize * 0.7));
    if (story.fill > 0 && !scene.castShown) {
      // A cheap liquid: the surface tilts back and forth, rings run out from where the stream lands, and drops jump up.
      const base = scene.fillHeight - MOULD_CENTRE[1];
      const swell = scene.agitation * 0.08 * (1 - 0.6 * story.fill);
      const ringPhase = (fromCentre) => Math.cos(fromCentre * 16 - state.time * 9);
      const surfaceAt = (across, deep) => {
        const fromCentre = Math.hypot(across, deep);
        const slosh = (swell * (Math.sin(state.time * 5.5) * across + 0.6 * Math.sin(state.time * 4.1 + 1) * deep)) / CAST_RADIUS;
        const ripple = scene.agitation * 0.03 * ringPhase(fromCentre) * Math.exp(-fromCentre * 2.5);
        const mound = scene.landed ? 0.06 * Math.exp(-((fromCentre / 0.12) ** 2)) : 0;
        return base + slosh + ripple + mound;
      };
      for (const point of fillPoints) {
        const depth = surfaceAt(point.position[0], point.position[2]) - point.position[1];
        if (depth < 0) continue;
        if (!point.outer && depth > cellSize * 1.5) continue;
        let ring = Math.min(3, 1 + Math.floor(depth / (cellSize * 5)));
        if (depth < cellSize * 1.5) ring = scene.agitation > 0.2 && ringPhase(Math.hypot(point.position[0], point.position[2])) < -0.2 ? 1 : 0;
        putSplat([MOULD_CENTRE[0] + point.position[0], MOULD_CENTRE[1] + point.position[1], point.position[2]], HEAT_SWATCHES[ring], splatSize);
      }
      for (let index = 0; scene.landed && index < splashCount; index++) {
        const life = (state.time * 1.1 + index * 0.618) % 1;
        const direction = index * 2.399;
        const reach = (0.12 + (index % 3) * 0.09) * life;
        const local = [Math.cos(direction) * reach, base + (1.5 * life - 2.2 * life * life) * (0.35 + (index % 4) * 0.08), Math.sin(direction) * reach];
        if (!castPlanes.every((plane) => dot(plane.normal, local) <= plane.reach)) continue;
        putSplat([MOULD_CENTRE[0] + local[0], MOULD_CENTRE[1] + local[1], local[2]], HEAT_SWATCHES[index % 2], cellSize * 0.5 * (1 - 0.5 * life));
      }
    }
    if (scene.castShown) {
      const castMatrix = groups.cast[0].matrix;
      const castScale = Math.hypot(castMatrix[0], castMatrix[1], castMatrix[2]);
      castPoints.forEach((point, index) => {
        const turned = [0, 1, 2].map((axis) => (castMatrix[axis] * point.normal[0] + castMatrix[4 + axis] * point.normal[1] + castMatrix[8 + axis] * point.normal[2]) / castScale);
        // The cast cools through every heat swatch to charcoal and then to bare metal. Corners go first, cells change
        // one by one so the steps blend, and a few cracks stay hotter than the crust around them.
        const corner = clampUnit((Math.hypot(...point.position) / CAST_RADIUS - 0.79) / 0.21);
        const cooled = clampUnit(story.cool * 1.35 - 0.35 * (1 - corner));
        const scatter = (index * 0.618) % 1;
        const crack = (index * 0.381) % 1 < 0.05;
        const band = bandOf(turned);
        const step = Math.floor(cooled * 7.6 + (scatter - 0.5) * 0.9) - (crack && cooled < 0.95 ? 2 : 0);
        let swatch = rampColour(SPLAT_RAMPS.cold, band);
        if (step < 6) swatch = HEAT_SWATCHES[Math.max(0, Math.min(5, step + (band === 2 ? 1 : 0)))];
        if (step === 6) swatch = rampColour(SPLAT_RAMPS.char, band);
        putSplat(transformPoint(castMatrix, point.position), swatch, splatSize * castScale);
      });
      if (partShown(groups.riser[0])) pointsAlong(groups.riser[0], cellSize * 0.6, (position) => putSplat(position, heatSwatch(scene.heat, 1), splatSize * 1.6));
    }
    const sprue = [MOULD_CENTRE[0], SPRUE_TOP, 0];
    groups.spark.forEach((part, index) => {
      if (!partShown(part)) return;
      const position = partCentre(part);
      putSplat(position, HEAT_SWATCHES[index % 2], cellSize * 0.6);
      putSplat(mixVector(position, sprue, 0.08), HEAT_SWATCHES[1], cellSize * 0.48);
      putSplat(mixVector(position, sprue, 0.16), HEAT_SWATCHES[2], cellSize * 0.4);
      putSplat(mixVector(position, sprue, 0.25), HEAT_SWATCHES[3], cellSize * 0.32);
      putSplat(mixVector(position, sprue, 0.34), HEAT_SWATCHES[4], cellSize * 0.26);
    });
  }

  // The splats attach once; every later frame rewrites them in place with the update path (#2756).
  let splatHandle = null;
  function updateSplats(scene) {
    writeSplats(scene);
    const count = splatStore.count;
    const frameData = {
      count,
      positions: splatStore.positions.subarray(0, count * 3),
      colors: splatStore.colors.subarray(0, count * 4),
      scales: splatStore.scales.subarray(0, count * 3),
      rotations: splatStore.rotations.subarray(0, count * 4),
      bounds: SPLAT_BOUNDS,
    };
    if (splatHandle) {
      splatHandle.update(frameData);
      return;
    }
    const splats = splatEngine.createGaussianSplats(frameData, { maximumCount: SPLAT_CAPACITY, capacity: SPLAT_CAPACITY });
    splatHandle = splatEngine.attachGaussianSplats(renderer, splats);
  }

  function draw() {
    const scene = layout();
    const view = viewOf(scene);
    renderer.updateParts(drawnParts);
    renderer.userPasses.set(passesFor(scene, view));
    const glow = look.glowLight;
    const meltPoint = transformPoint(scene.potMatrix, [0.1, 1.2, 0]);
    if (look.splats) updateSplats(scene);
    renderer.render({
      eye: view.eye, target: view.target, fov: view.fov, effects: look.effects,
      environment: {
        ...look.environment,
        pointLights: [
          { position: [meltPoint[0], meltPoint[1], 0.2], color: look.lightColour, intensity: 0.01 + 6 * glow, radius: 0.2, range: 6 },
          { position: [MOULD_CENTRE[0], Math.max(scene.fillHeight, scene.castCentre[1]) + 0.5, 0.5], color: look.lightColour, intensity: 0.01 + 8 * glow * scene.mouldGlow + (scene.castShown ? 6 * glow * scene.heat : 0), radius: 0.2, range: 8 },
        ],
      },
    });
    lastView = { scene, view };
  }

  try {
    draw();
  } catch (error) {
    console.warn('Crucible foundry unavailable:', error.message);
    return null;
  }

  const partCorners = (part) => {
    const corners = [];
    for (const x of [part.bounds.low[0], part.bounds.high[0]]) for (const y of [part.bounds.low[1], part.bounds.high[1]]) for (const z of [part.bounds.low[2], part.bounds.high[2]]) corners.push(transformPoint(part.matrix, [x, y, z]));
    return corners;
  };

  return {
    set(values) { Object.assign(state, values); },
    draw,
    resize() { renderer.resize(); },
    // Values for the page readouts, taken from the scene state.
    readout() {
      const story = storyAt(state.progress);
      const pouring = story.head > 0 && story.tail < 1;
      const temperature = story.head <= 0 ? POUR_TEMPERATURE : Math.round(mixNumber(POUR_TEMPERATURE, ROOM_TEMPERATURE, story.cool ** 0.7));
      return { tiltDegrees: Math.round((story.tilt * 180) / Math.PI), fillPercent: Math.round(story.fill * 100), temperature, pouring, cool: story.cool, rise: story.rise };
    },
    // Where the spout tip and the start of the stream land on screen, each from the matrix the engine was given.
    probe() {
      const { scene, view } = lastView;
      const first = groups.stream[0].matrix;
      const attached = first !== HIDDEN_MATRIX && scene.story.tail <= 0;
      const tipPixel = project(view, transformPoint(groups.pot[0].matrix, pot.spoutTip));
      if (!attached) return { attached, tip: tipPixel };
      const startPixel = project(view, [first[12] - first[4] / 2, first[13] - first[5] / 2, first[14] - first[6] / 2]);
      const spoutAxis = normalize([groups.pot[0].matrix[0], groups.pot[0].matrix[1], groups.pot[0].matrix[2]]);
      const leaveAngle = (Math.acos(Math.min(1, dot(normalize([first[4], first[5], first[6]]), spoutAxis))) * 180) / Math.PI;
      const midPixel = project(view, [first[12], first[13], first[14]]);
      return { attached, tip: tipPixel, streamStart: startPixel, streamMid: midPixel, distance: Math.hypot(tipPixel[0] - startPixel[0], tipPixel[1] - startPixel[1]), leaveAngle };
    },
    // Where a callout should point, in CSS pixels inside the canvas: just clear of the thing it names.
    anchor(name, fromBelow = false) {
      const { scene, view } = lastView;
      const forward = normalize(subtract(view.target, view.eye));
      const right = normalize(cross(forward, [0, 1, 0]));
      const beside = (point, reach) => [0, 1, 2].map((axis) => point[axis] + right[axis] * reach);
      let point = null;
      if (name === 'pour' && scene.pouring) point = beside(scene.streamPoint, 0.08);
      if (name === 'fill') point = beside([MOULD_CENTRE[0], scene.fillHeight, 0], 1.22);
      if (name === 'cool') point = beside([MOULD_CENTRE[0], MOULD_CENTRE[1] + 0.2, 0], 1.22);
      if (name === 'cast') point = beside(scene.castCentre, CAST_RADIUS * scene.castScale * 1.08);
      // A note under the scene points up at the lowest part of the thing it names.
      if (fromBelow && name === 'pour' && scene.pouring) point = [scene.headPoint[0], scene.headPoint[1] - 0.12, 0];
      if (fromBelow && (name === 'fill' || name === 'cool')) point = [MOULD_CENTRE[0], MOULD_CENTRE[1] - FLASK_HALF[1] - 0.42, 1.15];
      if (fromBelow && name === 'cast') point = [scene.castCentre[0], scene.castCentre[1] - CAST_RADIUS * scene.castScale * 1.1, 0];
      return point ? project(view, point) : null;
    },
    // Screen boxes of every part that is drawn, in CSS pixels of the page.
    subjectBoxes() {
      const frame = canvas.getBoundingClientRect();
      const boxes = [];
      for (const part of parts) {
        if (part.matrix === HIDDEN_MATRIX) continue;
        const pixels = partCorners(part).map((corner) => project(lastView.view, corner));
        const left = Math.max(0, Math.min(...pixels.map((pixel) => pixel[0])));
        const right = Math.min(frame.width, Math.max(...pixels.map((pixel) => pixel[0])));
        const top = Math.max(0, Math.min(...pixels.map((pixel) => pixel[1])));
        const bottom = Math.min(frame.height, Math.max(...pixels.map((pixel) => pixel[1])));
        if (right > left && bottom > top) boxes.push({ name: part.name, left: frame.left + left, right: frame.left + right, top: frame.top + top, bottom: frame.top + bottom });
      }
      return boxes;
    },
  };
}
