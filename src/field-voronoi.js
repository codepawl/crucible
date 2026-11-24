import { compileNode, isPlainObject, scalarValue } from './expression.js';
import { hashCell } from './seeded-random.js';
import { registerFieldSource } from './mesh-fields.js';

// The voronoi input of a field expression, the 3D form of the material graph's voronoi (#2856): the same outputs and
// the same names, so a recipe reads one way in a material height and in a mesh `displace` (#3203). Where a graph node
// looks up a UV, this one looks up a position, so a displaced surface has no seam and no UV is needed.
//   { "voronoi": { "scale": 4, "seed": 0, "output": "distance", "jitter": 1, "smoothness": 1, "at": <vector> } }
// Scale is cells per unit of position, so a 2 unit rock at scale 3 has about six cells across.

export const VORONOI_OUTPUTS = Object.freeze(['distance', 'edge', 'cell', 'f2', 'f2MinusF1', 'smoothF1']);
const MAX_VORONOI_SCALE = 1000;
const MAX_SEED = 0x7fffffff;
// One voronoi reads 27 neighbouring cells, so it counts as this many nodes against the work limit of a field.
const VORONOI_NODE_WEIGHT = 8;
const SETTING_KEYS = ['scale', 'seed', 'output', 'jitter', 'smoothness', 'at'];
const AXIS_SALTS = [0, 0x1b873593, 0x2545f491];
const CELL_SALT = 0x5bd1e995;

function voronoiError(message) {
  return new TypeError(`Field expression: ${message}`);
}

function checkedSettings(settings) {
  if (!isPlainObject(settings)) throw voronoiError(`voronoi takes { ${SETTING_KEYS.join(', ')} }.`);
  for (const key of Object.keys(settings)) {
    if (!SETTING_KEYS.includes(key)) throw voronoiError(`voronoi does not take ${JSON.stringify(key.slice(0, 24))}; fields: ${SETTING_KEYS.join(', ')}.`);
  }
  const scale = settings.scale ?? 4;
  if (typeof scale !== 'number' || !(scale > 0) || scale > MAX_VORONOI_SCALE) throw voronoiError(`voronoi scale must be above 0 and at most ${MAX_VORONOI_SCALE}.`);
  const seed = settings.seed ?? 0;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) throw voronoiError(`voronoi seed must be an integer from 0 to ${MAX_SEED}.`);
  const output = settings.output ?? 'distance';
  if (!VORONOI_OUTPUTS.includes(output)) throw voronoiError(`voronoi output must be one of ${VORONOI_OUTPUTS.join(', ')}.`);
  const jitter = settings.jitter ?? 1;
  if (typeof jitter !== 'number' || !(jitter >= 0 && jitter <= 1)) throw voronoiError('voronoi jitter must be a number from 0 to 1.');
  if (settings.smoothness !== undefined && output !== 'smoothF1') throw voronoiError('voronoi smoothness only applies to output "smoothF1"; remove it or set output to "smoothF1".');
  const smoothness = settings.smoothness ?? 1;
  if (typeof smoothness !== 'number' || !(smoothness >= 0 && smoothness <= 1)) throw voronoiError('voronoi smoothness must be a number from 0 to 1.');
  return { scale, seed, output, jitter, smoothness };
}

const clampUnit = value => Math.min(1, Math.max(0, value));

function smoothStep(value) {
  const position = clampUnit(value);
  return position * position * (3 - 2 * position);
}

// The feature point of a cell: its centre moved by up to half a cell on each axis, scaled by jitter.
function featurePoint(cellX, cellY, cellZ, seed, jitter) {
  const offset = salt => (hashCell(cellX, cellY, cellZ, seed ^ salt) - 0.5) * jitter + 0.5;
  return [cellX + offset(AXIS_SALTS[0]), cellY + offset(AXIS_SALTS[1]), cellZ + offset(AXIS_SALTS[2])];
}

/** Distance to the nearest and second nearest feature point (in cells) and the nearest cell's hash in 0 to 1. */
export function cellularNoise3(x, y, z, seed, jitter) {
  const floorX = Math.floor(x);
  const floorY = Math.floor(y);
  const floorZ = Math.floor(z);
  let nearest = Infinity;
  let second = Infinity;
  let nearestCell = [0, 0, 0];
  for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
    for (let offsetY = -1; offsetY <= 1; offsetY++) {
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        const cell = [floorX + offsetX, floorY + offsetY, floorZ + offsetZ];
        const point = featurePoint(cell[0], cell[1], cell[2], seed, jitter);
        const distance = Math.hypot(point[0] - x, point[1] - y, point[2] - z);
        if (distance < nearest) {
          second = nearest;
          nearest = distance;
          nearestCell = cell;
        } else if (distance < second) {
          second = distance;
        }
      }
    }
  }
  return { nearest, second, cell: hashCell(nearestCell[0], nearestCell[1], nearestCell[2], seed ^ CELL_SALT) };
}

/** The nearest distance with the hard minimum smoothed (Blender's Smooth F1), so cells melt into blobs. */
export function smoothCellularDistance3(x, y, z, seed, jitter, smoothness) {
  const blend = smoothness / 2;
  const floorX = Math.floor(x);
  const floorY = Math.floor(y);
  const floorZ = Math.floor(z);
  let smoothDistance = 8;
  for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
    for (let offsetY = -1; offsetY <= 1; offsetY++) {
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        const point = featurePoint(floorX + offsetX, floorY + offsetY, floorZ + offsetZ, seed, jitter);
        const distance = Math.hypot(point[0] - x, point[1] - y, point[2] - z);
        if (blend === 0) {
          smoothDistance = Math.min(smoothDistance, distance);
          continue;
        }
        const share = smoothStep(0.5 + 0.5 * (smoothDistance - distance) / blend);
        smoothDistance = smoothDistance + (distance - smoothDistance) * share - blend * share * (1 - share);
      }
    }
  }
  return smoothDistance;
}

function voronoiValue(output, x, y, z, { seed, jitter, smoothness }) {
  if (output === 'smoothF1') return clampUnit(smoothCellularDistance3(x, y, z, seed, jitter, smoothness));
  const { nearest, second, cell } = cellularNoise3(x, y, z, seed, jitter);
  if (output === 'cell') return cell;
  if (output === 'f2') return clampUnit(second);
  return clampUnit(output === 'distance' ? nearest : second - nearest);
}

function compileVoronoi(node, state, depth, positionInput) {
  const settings = checkedSettings(node.voronoi);
  const at = node.voronoi.at === undefined ? positionInput() : compileNode(node.voronoi.at, state, depth + 1);
  if (at.kind !== 'vector') throw voronoiError('voronoi "at" needs a vector.');
  state.nodeCount += VORONOI_NODE_WEIGHT - 1;
  const [partX, partY, partZ] = at.parts;
  const { scale, output } = settings;
  return scalarValue(index => voronoiValue(output, partX(index) * scale, partY(index) * scale, partZ(index) * scale, settings));
}

registerFieldSource('voronoi', compileVoronoi);
