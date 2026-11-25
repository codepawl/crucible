// Finds pairs of triangles that draw the same plane in the same place (issue #751): inside one part and across parts, exactly
// flush or a few millimetres to centimetres apart. Such pairs z-fight, since the rasteriser snaps two triangles on one plane to
// slightly different depths. flush-resolve.js turns the pairs into a draw rank per triangle.
//
// Triangles are hashed by their normal (sign folded, so opposite faces meet) and by a grid over their boxes. A triangle is
// native to the finest grid where it spans few cells and a guest in the coarser ones, so a wall of two triangles and the
// thousand small faces on it meet without the wall being listed in a thousand cells. Nothing is cut short silently: parts
// past the triangle budget come back in `unchecked`, and `truncated` says the pair budget ran out.

import { drainSteps } from './flush-search-runner.js';
import { createTrianglePairSet } from './triangle-pair-set.js';
import { isLiveGeometry } from './live-geometry.js';
import { entryContaining, forgetSearch, matchRemembered, partSignature, rememberSearch, rememberedTriangleCount, reusedPairs, subTableOf, triangleIdsNearChanged } from './flush-search-reuse.js';

/** Shared area under this share of the smaller triangle is edge contact or rounding, not a fight. */
export const FLUSH_MINIMUM_AREA_SHARE = 1e-4;
const FLUSH_MINIMUM_AREA = 1e-8;
const DEFAULT_TRIANGLE_BUDGET = 2_000_000;
const DEFAULT_PAIR_BUDGET = 4_000_000;
const MAXIMUM_TESTED_PAIRS = 8_000_000;
const SWEEP_AXIS_LEAN = 0.5;
const SAME_FACING =Math.cos(Math.PI / 180);
// Normals one degree apart differ by at most 0.0175 per component. Each triangle is listed in every normal cell within half
// of that, so two such triangles always share a cell.
const NORMAL_STEPS = 20;
const NORMAL_REACH = 0.0088;
const NORMAL_RANGE = 2 * NORMAL_STEPS + 3;
const NEAR_DOMINANT = 0.02;
const NATIVE_CELL_LIMIT = 64;
// How much work a search does between two checkpoints (issue #2905), where the runner may hand the thread back: triangles read,
// triangles listed in the grid, grid cells flattened, and pair tests (one unit is about a box test).
const READ_CHECKPOINT_TRIANGLES = 8192;
const LIST_CHECKPOINT_TRIANGLES = 512;
const FLATTEN_CHECKPOINT_CELLS = 16384;
const TEST_CHECKPOINT_WORK = 16384;
const SWEEP_WORK_CAP = 256;
const GRID_LEVEL_SCALE = 16;
const GRID_LEVELS = 2;
const CELL_SAMPLES = 4096;
// A part's box is made from the corners of its local box, a triangle's from its own corners: the two differ by rounding, a few units in the last place.
// This share of the scene's diagonal is far above that and far below any real gap.
const PART_BOX_SLACK = 1e-6;
// A JS Map holds at most 2^24 entries and throws a bare RangeError past it. The grid stops listing triangles at this many
// native cells and is built again with cells twice as wide, up to MAXIMUM_GRID_COARSENINGS times.
const MAXIMUM_GRID_ENTRIES = 16_000_000;
const MAXIMUM_GRID_COARSENINGS = 8;
// Tags whose vertex shader moves vertices (renderer.js DEFORMING_TAGS): their triangles are not where the geometry says.
const DEFORMING_TAGS = new Set(['foliage', 'grass', 'water', 'fire', 'smoke']);

const localBoundsByGeometry = new WeakMap();

// A live geometry has its positions rewritten in place, so its bounds are measured again on every call.
export function localBounds(geometry) {
  const live = isLiveGeometry(geometry);
  let bounds = live ? undefined : localBoundsByGeometry.get(geometry);
  if (bounds) return bounds;
  bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const { positions } = geometry;
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      bounds[axis] = Math.min(bounds[axis], positions[offset + axis]);
      bounds[3 + axis] = Math.max(bounds[3 + axis], positions[offset + axis]);
    }
  }
  if (!live) localBoundsByGeometry.set(geometry, bounds);
  return bounds;
}

export function worldBounds(part) {
  const local = localBounds(part.geometry);
  const matrix = part.matrix;
  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? local[3] : local[0];
    const y = corner & 2 ? local[4] : local[1];
    const z = corner & 4 ? local[5] : local[2];
    for (let axis = 0; axis < 3; axis++) {
      const value = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
      bounds[axis] = Math.min(bounds[axis], value);
      bounds[3 + axis] = Math.max(bounds[3 + axis], value);
    }
  }
  return bounds;
}

export function determinantSign(matrix) {
  const determinant = matrix[0] * (matrix[5] * matrix[10] - matrix[6] * matrix[9])
    - matrix[4] * (matrix[1] * matrix[10] - matrix[2] * matrix[9])
    + matrix[8] * (matrix[1] * matrix[6] - matrix[2] * matrix[5]);
  return determinant < 0 ? -1 : 1;
}

export function boundsDiagonal(bounds) {
  return Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]);
}

/** The distance between neighbouring float32 values at this magnitude. */
export function float32Step(magnitude) {
  return 2 ** (Math.floor(Math.log2(Math.max(magnitude, 1e-30))) - 23);
}

/** Planes closer than this (metres) are one plane: 0.1 mm, or eight float32 steps of the largest coordinate when that is more. */
export function flushTolerance(largestCoordinate) {
  return Math.max(1e-4, 8 * float32Step(largestCoordinate));
}

/** Same-facing planes up to this far apart (metres) can still fight far from the camera; `diagonal` spans both parts. */
export function nearTolerance(diagonal) {
  return Math.min(0.25, Math.max(0.002, 1.5e-4 * diagonal));
}

/** Whether a part's drawn triangles leave its geometry (skin, morph, crowd, wind, liquid), so a search of the geometry says nothing. */
export function isDeformingPart(part) {
  const { geometry, material } = part;
  if (part.skin || part.morph || part.crowd || geometry.skinIndices || geometry.morphTargets) return true;
  return DEFORMING_TAGS.has(material?.tag) || material?.transmission > 0;
}

// Parts with one geometry and one matrix are stacked copies (hundreds of dust motes parked at one spot). They draw the same
// depth bit for bit, so two of them stand for the stack.
function searchableParts(parts) {
  const stacks = new Map();
  const searchable = [];
  for (const part of parts) {
    if (!part.geometry?.indices?.length || isDeformingPart(part)) continue;
    const stack = stacks.get(part.geometry) ?? new Map();
    stacks.set(part.geometry, stack);
    const pose = Array.prototype.join.call(part.matrix, ',');
    const copies = stack.get(pose) ?? 0;
    if (copies >= 2) continue;
    stack.set(pose, copies + 1);
    searchable.push(part);
  }
  return searchable;
}

// Past the budget the largest parts are searched, since a large flush face is the one people see; the rest is `unchecked`.
function withinTriangleBudget(parts, triangleBudget) {
  const entries = parts.map((part, order) => ({ part, order, bounds: worldBounds(part), triangles: part.geometry.indices.length / 3 }));
  const total = entries.reduce((sum, entry) => sum + entry.triangles, 0);
  if (total <= triangleBudget) return { entries, unchecked: [] };
  const bySize = [...entries].sort((first, second) => boundsDiagonal(second.bounds) - boundsDiagonal(first.bounds));
  const kept = [];
  const unchecked = [];
  let used = 0;
  for (const entry of bySize) {
    if (used + entry.triangles <= triangleBudget) {
      used += entry.triangles;
      kept.push(entry);
    } else {
      unchecked.push(entry.part);
    }
  }
  kept.sort((first, second) => first.order - second.order);
  return { entries: kept, unchecked };
}

function newTriangleTable(capacity) {
  return {
    count: 0,
    corners: new Float64Array(capacity * 9),
    normals: new Float64Array(capacity * 3),
    boxes: new Float64Array(capacity * 6),
    areas: new Float64Array(capacity),
    owner: new Uint32Array(capacity),
    local: new Uint32Array(capacity),
    starts: null,
    loaded: null,
  };
}

// World-space corners (9 numbers), unit normal (3), box (6) and area of every non-degenerate triangle, part after part.
// `starts` holds the first id of every entry and one more for the total; `loaded` flags the entries whose rows are filled in.
function* readTriangles(entries) {
  const capacity = entries.reduce((sum, entry) => sum + entry.triangles, 0);
  const table = newTriangleTable(capacity);
  table.starts = new Uint32Array(entries.length + 1);
  table.loaded = new Uint8Array(entries.length).fill(1);
  for (let partIndex = 0; partIndex < entries.length; partIndex++) {
    table.count = yield* readPartTriangles(table, entries[partIndex].part, partIndex, table.count);
    table.starts[partIndex + 1] = table.count;
  }
  return table;
}

// Writes the row of one triangle of a part at `row`, or leaves the row untouched and returns false when the triangle has no area. The
// corners are worked out in `worldCorners` first: a row that stays free is the first row of the part after it, which may already be filled in.
const worldCorners = new Float64Array(9);

function writeTriangleRow(table, part, partIndex, triangle, row, flip) {
  const { positions, indices } = part.geometry;
  const matrix = part.matrix;
  const { corners, normals, boxes } = table;
  for (let corner = 0; corner < 3; corner++) {
    const vertex = indices[triangle + corner] * 3;
    const x = positions[vertex];
    const y = positions[vertex + 1];
    const z = positions[vertex + 2];
    worldCorners[corner * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    worldCorners[corner * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    worldCorners[corner * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  }
  const edgeOneX = worldCorners[3] - worldCorners[0];
  const edgeOneY = worldCorners[4] - worldCorners[1];
  const edgeOneZ = worldCorners[5] - worldCorners[2];
  const edgeTwoX = worldCorners[6] - worldCorners[0];
  const edgeTwoY = worldCorners[7] - worldCorners[1];
  const edgeTwoZ = worldCorners[8] - worldCorners[2];
  const normalX = edgeOneY * edgeTwoZ - edgeOneZ * edgeTwoY;
  const normalY = edgeOneZ * edgeTwoX - edgeOneX * edgeTwoZ;
  const normalZ = edgeOneX * edgeTwoY - edgeOneY * edgeTwoX;
  const length = Math.hypot(normalX, normalY, normalZ);
  if (!(length > 1e-12)) return false;
  const scale = flip / length;
  normals[row * 3] = normalX * scale;
  normals[row * 3 + 1] = normalY * scale;
  normals[row * 3 + 2] = normalZ * scale;
  corners.set(worldCorners, row * 9);
  for (let axis = 0; axis < 3; axis++) {
    const low = Math.min(worldCorners[axis], worldCorners[3 + axis], worldCorners[6 + axis]);
    const high = Math.max(worldCorners[axis], worldCorners[3 + axis], worldCorners[6 + axis]);
    boxes[row * 6 + axis] = low;
    boxes[row * 6 + 3 + axis] = high;
  }
  table.areas[row] = length / 2;
  table.owner[row] = partIndex;
  table.local[row] = triangle / 3;
  return true;
}

// Writes the rows of one part from `firstRow` on and returns the row after its last one.
function* readPartTriangles(table, part, partIndex, firstRow) {
  let row = firstRow;
  const { indices } = part.geometry;
  const flip = determinantSign(part.matrix);
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    if (triangle > 0 && triangle % (READ_CHECKPOINT_TRIANGLES * 3) === 0) yield;
    if (writeTriangleRow(table, part, partIndex, triangle, row, flip)) row++;
  }
  return row;
}

// A part that changed since the last search is read on its own first, because how many triangles it keeps decides every id after it.
function* readChangedParts(entries, match) {
  const tables = new Map();
  for (let index = 0; index < entries.length; index++) {
    if (!match.changed[index]) continue;
    const alone = newTriangleTable(entries[index].triangles);
    alone.count = yield* readPartTriangles(alone, entries[index].part, index, 0);
    tables.set(index, alone);
  }
  return tables;
}

function firstRows(entries, match, changedTables) {
  const starts = new Uint32Array(entries.length + 1);
  for (let index = 0; index < entries.length; index++) {
    const count = match.changed[index] ? changedTables.get(index).count : rememberedTriangleCount(match, index);
    starts[index + 1] = starts[index] + count;
  }
  return starts;
}

function copyRows(table, alone, firstRow) {
  table.corners.set(alone.corners.subarray(0, alone.count * 9), firstRow * 9);
  table.normals.set(alone.normals.subarray(0, alone.count * 3), firstRow * 3);
  table.boxes.set(alone.boxes.subarray(0, alone.count * 6), firstRow * 6);
  table.areas.set(alone.areas.subarray(0, alone.count), firstRow);
  table.owner.set(alone.owner.subarray(0, alone.count), firstRow);
  table.local.set(alone.local.subarray(0, alone.count), firstRow);
}

// Reads the rows of one more part into a table that is partly filled in. False when the part has other triangles than the last search
// recorded for it, which only happens when geometry was rewritten in place without markLiveGeometry.
function* loadEntry(table, entries, index) {
  if (table.loaded[index]) return true;
  const end = yield* readPartTriangles(table, entries[index].part, index, table.starts[index]);
  table.loaded[index] = 1;
  return end === table.starts[index + 1];
}

// Whether two world boxes are within `margin` of each other on every axis.
function boundsNear(first, second, margin) {
  for (let axis = 0; axis < 3; axis++) {
    if (first[3 + axis] < second[axis] - margin || first[axis] > second[3 + axis] + margin) return false;
  }
  return true;
}

// The entries to read whole for a search that builds on the last one: the changed parts and the parts whose box is near one of them. A
// triangle lies inside its part's box (up to rounding, which `margin` covers), so a part whose box is farther than `reach` from every
// changed box has no triangle within `reach` of one.
function entriesNearChanged(entries, match, margin) {
  const wanted = new Uint8Array(entries.length);
  const changedBounds = entries.filter((entry, index) => match.changed[index]).map(entry => entry.bounds);
  entries.forEach((entry, index) => {
    if (match.changed[index] || changedBounds.some(bounds => boundsNear(entry.bounds, bounds, margin))) wanted[index] = 1;
  });
  return wanted;
}

// The rows of the triangles that a pair kept from the last search joins are read one by one: the later steps (cuts, ranks) look at these
// and at no other triangle of a part far from the edit. A part with a triangle of no area numbers its rows apart from its triangles, so
// that part is read whole instead, and the rows to read one by one come back.
function pairRowsToRead(entries, starts, pairs, wanted) {
  const rows = [];
  for (const pair of pairs) {
    for (const row of [pair.first, pair.second]) {
      const entry = entryContaining(starts, row);
      if (wanted[entry]) continue;
      if (starts[entry + 1] - starts[entry] === entries[entry].triangles) rows.push(row);
      else wanted[entry] = 1;
    }
  }
  return rows;
}

// Reads one row of a part that has no triangle of no area, where row and triangle have the same offset into the part.
function readRow(table, entries, row) {
  const entry = entryContaining(table.starts, row);
  const part = entries[entry].part;
  return writeTriangleRow(table, part, entry, (row - table.starts[entry]) * 3, row, determinantSign(part.matrix));
}

// The triangle table of a search that builds on the last one, with only the parts the edit can have changed and the triangles that a kept
// pair joins read; every other triangle keeps its id but no row. Null when a part no longer matches what the last search recorded for it.
function* readTrianglesForReuse(entries, match, margin) {
  const changedTables = yield* readChangedParts(entries, match);
  const starts = firstRows(entries, match, changedTables);
  const table = newTriangleTable(starts[entries.length]);
  table.count = starts[entries.length];
  table.starts = starts;
  table.loaded = new Uint8Array(entries.length);
  for (let index = 0; index < entries.length; index++) table.owner.fill(index, starts[index], starts[index + 1]);
  for (const [index, alone] of changedTables) {
    copyRows(table, alone, starts[index]);
    table.loaded[index] = 1;
  }
  const pairs = reusedPairs(match, starts);
  const wanted = entriesNearChanged(entries, match, margin);
  const pairRows = pairRowsToRead(entries, starts, pairs, wanted);
  for (let index = 0; index < entries.length; index++) {
    if (wanted[index] && !(yield* loadEntry(table, entries, index))) return null;
  }
  for (const row of pairRows) {
    if (!table.loaded[entryContaining(starts, row)] && !readRow(table, entries, row)) return null;
  }
  return { table, reused: { pairs, testedPairs: match.previous.testedPairs, changed: match.changed, changedCount: match.changedCount } };
}

function* loadRemainingEntries(table, entries) {
  for (let index = 0; index < entries.length; index++) {
    if (!(yield* loadEntry(table, entries, index))) return false;
  }
  return true;
}

// Twice the median triangle extent: most triangles then touch a handful of cells.
function gridCellSize(table, reach) {
  const extents = [];
  const stride = Math.max(1, Math.floor(table.count / CELL_SAMPLES));
  for (let id = 0; id < table.count; id += stride) {
    const box = id * 6;
    extents.push(Math.max(table.boxes[box + 3] - table.boxes[box], table.boxes[box + 4] - table.boxes[box + 1], table.boxes[box + 5] - table.boxes[box + 2]));
  }
  extents.sort((first, second) => first - second);
  return Math.max(2 * extents[extents.length >> 1], 4 * reach, 1e-6);
}

// The normal cells a triangle is listed in. The sign is folded by the dominant component; when another component is nearly
// as large and has the other sign, both folds are listed, so two near-equal normals never fold apart.
function normalCellsOf(table, id, cells) {
  const x = table.normals[id * 3];
  const y = table.normals[id * 3 + 1];
  const z = table.normals[id * 3 + 2];
  const largest = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  let positive = false;
  let negative = false;
  for (const component of [x, y, z]) {
    if (Math.abs(component) < largest - NEAR_DOMINANT) continue;
    if (component < 0) negative = true;
    else positive = true;
  }
  cells.length = 0;
  for (const sign of [1, -1]) {
    if (sign > 0 ? !positive : !negative) continue;
    const lowX = Math.round((x * sign - NORMAL_REACH) * NORMAL_STEPS);
    const highX = Math.round((x * sign + NORMAL_REACH) * NORMAL_STEPS);
    const lowY = Math.round((y * sign - NORMAL_REACH) * NORMAL_STEPS);
    const highY = Math.round((y * sign + NORMAL_REACH) * NORMAL_STEPS);
    const lowZ = Math.round((z * sign - NORMAL_REACH) * NORMAL_STEPS);
    const highZ = Math.round((z * sign + NORMAL_REACH) * NORMAL_STEPS);
    for (let cellX = lowX; cellX <= highX; cellX++) {
      for (let cellY = lowY; cellY <= highY; cellY++) {
        for (let cellZ = lowZ; cellZ <= highZ; cellZ++) {
          const cell = ((cellX + NORMAL_STEPS + 1) * NORMAL_RANGE + cellY + NORMAL_STEPS + 1) * NORMAL_RANGE + cellZ + NORMAL_STEPS + 1;
          if (!cells.includes(cell)) cells.push(cell);
        }
      }
    }
  }
  return cells;
}

const cellRange = new Int32Array(6);
const estimateNormalCells = [];

// The grid cells a triangle's box touches at one level, grown by half the reach so two boxes within the reach share a cell.
// Returns how many cells that is.
function cellRangeOf(table, id, cellSize, reach) {
  let cells = 1;
  for (let axis = 0; axis < 3; axis++) {
    const low = Math.floor((table.boxes[id * 6 + axis] - reach / 2) / cellSize);
    const high = Math.floor((table.boxes[id * 6 + 3 + axis] + reach / 2) / cellSize);
    cellRange[axis] = low;
    cellRange[3 + axis] = high;
    cells *= high - low + 1;
  }
  return cells;
}

// The finest grid level where the triangle spans at most NATIVE_CELL_LIMIT cells.
function nativeLevelOf(table, id, cellSize, reach) {
  let level = 0;
  while (level < GRID_LEVELS && cellRangeOf(table, id, cellSize * GRID_LEVEL_SCALE ** level, reach) > NATIVE_CELL_LIMIT) level++;
  return level;
}

// How many native cell entries buildCells would make, projected from CELL_SAMPLES evenly spaced triangles.
function estimateNativeEntries(table, cellSize, reach) {
  const stride = Math.max(1, Math.floor(table.count / CELL_SAMPLES));
  let sampledEntries = 0;
  let sampled = 0;
  for (let id = 0; id < table.count; id += stride) {
    const level = nativeLevelOf(table, id, cellSize, reach);
    const normalCellCount = normalCellsOf(table, id, estimateNormalCells).length;
    sampledEntries += level === GRID_LEVELS ? normalCellCount : normalCellCount * cellRangeOf(table, id, cellSize * GRID_LEVEL_SCALE ** level, reach);
    sampled++;
  }
  return (sampledEntries / sampled) * table.count;
}

function cellKey(normalCell, level, cellX, cellY, cellZ) {
  const mixed = Math.imul(cellX, 73856093) ^ Math.imul(cellY, 19349663) ^ Math.imul(cellZ, 83492791) ^ Math.imul(normalCell * GRID_LEVELS + level, 0x9e3779b1);
  return mixed >>> 0;
}

// Lists every triangle in the cells of its own level (`natives`), then as a guest in the coarser cells that hold a native.
// The last level is one cell per normal cell, for triangles too large for any grid. Returns null when the natives would pass
// MAXIMUM_GRID_ENTRIES, so the caller can try wider cells.
function* buildCells(table, cellSize, reach) {
  const levels = Array.from({ length: GRID_LEVELS + 1 }, () => new Map());
  const nativeLevel = new Uint8Array(table.count);
  const normalCells = [];
  const visitCells = (id, level, visit) => {
    normalCellsOf(table, id, normalCells);
    if (level === GRID_LEVELS) {
      for (const normalCell of normalCells) visit(normalCell);
      return;
    }
    cellRangeOf(table, id, cellSize * GRID_LEVEL_SCALE ** level, reach);
    const [lowX, lowY, lowZ, highX, highY, highZ] = cellRange;
    for (const normalCell of normalCells) {
      for (let cellX = lowX; cellX <= highX; cellX++) {
        for (let cellY = lowY; cellY <= highY; cellY++) {
          for (let cellZ = lowZ; cellZ <= highZ; cellZ++) visit(cellKey(normalCell, level, cellX, cellY, cellZ));
        }
      }
    }
  };
  let nativeEntries = 0;
  for (let id = 0; id < table.count; id++) {
    const level = nativeLevelOf(table, id, cellSize, reach);
    nativeLevel[id] = level;
    const cells = levels[level];
    visitCells(id, level, key => {
      nativeEntries++;
      const cell = cells.get(key);
      if (cell) cell.natives.push(id);
      else cells.set(key, { natives: [id], guests: [] });
    });
    if (nativeEntries > MAXIMUM_GRID_ENTRIES) return null;
    if (id % LIST_CHECKPOINT_TRIANGLES === LIST_CHECKPOINT_TRIANGLES - 1) yield;
  }
  for (let id = 0; id < table.count; id++) {
    for (let level = nativeLevel[id] + 1; level <= GRID_LEVELS; level++) {
      const cells = levels[level];
      if (cells.size === 0) continue;
      visitCells(id, level, key => cells.get(key)?.guests.push(id));
    }
    if (id % LIST_CHECKPOINT_TRIANGLES === LIST_CHECKPOINT_TRIANGLES - 1) yield;
  }
  const flattened = [];
  let flattenedSinceCheckpoint = 0;
  for (const cells of levels) {
    for (const cell of cells.values()) {
      flattened.push(cell);
      if (++flattenedSinceCheckpoint === FLATTEN_CHECKPOINT_CELLS) {
        flattenedSinceCheckpoint = 0;
        yield;
      }
    }
  }
  return flattened;
}

// Wider cells list each triangle in fewer of them and leave the pairs found the same. A grid is made wider only when a sample
// of the triangles projects past MAXIMUM_GRID_ENTRIES, or when building it passes that, so every scene that fit keeps its grid.
function* buildCoarsenedCells(table, reach) {
  let cellSize = gridCellSize(table, reach);
  for (let coarsening = 0; coarsening <= MAXIMUM_GRID_COARSENINGS; coarsening++, cellSize *= 2) {
    const projectedEntries = estimateNativeEntries(table, cellSize, reach);
    yield;
    if (projectedEntries > MAXIMUM_GRID_ENTRIES) continue;
    const cells = yield* buildCells(table, cellSize, reach);
    if (cells) return cells;
  }
  throw new RangeError(`The coplanar search has ${table.count} triangles in a scene too large to index. Pass environment.resolveCoplanar: false to skip the search, or split the scene into smaller ones.`);
}

// The axis a triangle's plane is measured along: the one its normal leans on most. The other two are where its shared area is.
function droppedAxisOf(normals, id) {
  const absoluteX = Math.abs(normals[id * 3]);
  const absoluteY = Math.abs(normals[id * 3 + 1]);
  const absoluteZ = Math.abs(normals[id * 3 + 2]);
  if (absoluteY > absoluteX && absoluteY >= absoluteZ) return 1;
  if (absoluteZ > absoluteX && absoluteZ > absoluteY) return 2;
  return 0;
}

function droppedAxesOf(table) {
  const droppedAxes = new Uint8Array(table.count);
  for (let id = 0; id < table.count; id++) droppedAxes[id] = droppedAxisOf(table.normals, id);
  return droppedAxes;
}

const clipFirst = new Float64Array(32);
const clipSecond = new Float64Array(32);
const sharedCentre = new Float64Array(2);

// Clips triangle `second` against triangle `first` on the plane's two largest axes (Sutherland-Hodgman). Returns the shared
// area in square metres and leaves the centre of the shared piece in `sharedCentre`.
function sharedArea(table, first, second, dropped, axisU, axisV) {
  const { corners, normals } = table;
  let polygon = clipFirst;
  let next = clipSecond;
  let size = 3;
  for (let corner = 0; corner < 3; corner++) {
    polygon[corner * 2] = corners[second * 9 + corner * 3 + axisU];
    polygon[corner * 2 + 1] = corners[second * 9 + corner * 3 + axisV];
  }
  const base = first * 9;
  const turn = (corners[base + 3 + axisU] - corners[base + axisU]) * (corners[base + 6 + axisV] - corners[base + axisV])
    - (corners[base + 3 + axisV] - corners[base + axisV]) * (corners[base + 6 + axisU] - corners[base + axisU]) >= 0 ? 1 : -1;
  for (let edge = 0; edge < 3 && size > 0; edge++) {
    const startU = corners[base + edge * 3 + axisU];
    const startV = corners[base + edge * 3 + axisV];
    const edgeU = corners[base + ((edge + 1) % 3) * 3 + axisU] - startU;
    const edgeV = corners[base + ((edge + 1) % 3) * 3 + axisV] - startV;
    let nextSize = 0;
    let previousU = polygon[size * 2 - 2];
    let previousV = polygon[size * 2 - 1];
    let previousSide = turn * (edgeU * (previousV - startV) - edgeV * (previousU - startU));
    for (let index = 0; index < size; index++) {
      const currentU = polygon[index * 2];
      const currentV = polygon[index * 2 + 1];
      const currentSide = turn * (edgeU * (currentV - startV) - edgeV * (currentU - startU));
      if ((currentSide >= 0) !== (previousSide >= 0)) {
        const along = previousSide / (previousSide - currentSide);
        next[nextSize * 2] = previousU + (currentU - previousU) * along;
        next[nextSize * 2 + 1] = previousV + (currentV - previousV) * along;
        nextSize++;
      }
      if (currentSide >= 0) {
        next[nextSize * 2] = currentU;
        next[nextSize * 2 + 1] = currentV;
        nextSize++;
      }
      previousU = currentU;
      previousV = currentV;
      previousSide = currentSide;
    }
    const swap = polygon;
    polygon = next;
    next = swap;
    size = nextSize;
  }
  if (size < 3) return 0;
  let doubled = 0;
  let centreU = 0;
  let centreV = 0;
  for (let index = 0; index < size; index++) {
    const following = (index + 1) % size;
    doubled += polygon[index * 2] * polygon[following * 2 + 1] - polygon[following * 2] * polygon[index * 2 + 1];
    centreU += polygon[index * 2];
    centreV += polygon[index * 2 + 1];
  }
  sharedCentre[0] = centreU / size;
  sharedCentre[1] = centreV / size;
  return Math.abs(doubled) / 2 / Math.max(Math.abs(normals[first * 3 + dropped]), 1e-12);
}

// Where a triangle's plane sits along the dropped axis above the point (u, v).
function planeHeight(table, id, dropped, axisU, axisV, u, v) {
  const { corners, normals } = table;
  const slope = normals[id * 3 + axisU] * (u - corners[id * 9 + axisU]) + normals[id * 3 + axisV] * (v - corners[id * 9 + axisV]);
  return corners[id * 9 + dropped] - slope / normals[id * 3 + dropped];
}

function createPairTest(table, entries, reach, pairBudget, testedPairLimit, result) {
  const { corners, normals, boxes, areas, owner } = table;
  const seen = createTrianglePairSet();
  const tolerances = new Map();
  const pairTolerance = (firstPart, secondPart) => {
    const key = Math.min(firstPart, secondPart) * entries.length + Math.max(firstPart, secondPart);
    let tolerance = tolerances.get(key);
    if (tolerance === undefined) {
      const first = entries[firstPart].bounds;
      const second = entries[secondPart].bounds;
      tolerance = nearTolerance(Math.hypot(
        Math.max(first[3], second[3]) - Math.min(first[0], second[0]),
        Math.max(first[4], second[4]) - Math.min(first[1], second[1]),
        Math.max(first[5], second[5]) - Math.min(first[2], second[2]),
      ));
      tolerances.set(key, tolerance);
    }
    return tolerance;
  };
  // Measures a pair that has passed the box tests of measureCandidates: within reach on every axis, overlapping across the plane's two axes.
  function measurePair(one, other) {
    // Two cells of one triangle can hash to one key, which lists it twice.
    if (one === other) return;
    const first = Math.min(one, other);
    const second = Math.max(one, other);
    const normalX = normals[first * 3];
    const normalY = normals[first * 3 + 1];
    const normalZ = normals[first * 3 + 2];
    const dropped = droppedAxisOf(normals, first);
    const axisU = (dropped + 1) % 3;
    const axisV = (dropped + 2) % 3;
    // A pair measured from another cell has passed every test below, so it is answered before them.
    if (seen.has(first, second)) return;
    const facing = normalX * normals[second * 3] + normalY * normals[second * 3 + 1] + normalZ * normals[second * 3 + 2];
    if (Math.abs(facing) < SAME_FACING) return;
    const opposite = facing < 0;
    // A face against a floor looks away from it and is culled, unless one of the two shows both sides.
    if (opposite && entries[owner[first]].part.material?.doubleSided !== true && entries[owner[second]].part.material?.doubleSided !== true) return;
    const tolerance = pairTolerance(owner[first], owner[second]);
    for (let corner = 0; corner < 3; corner++) {
      const distance = (corners[second * 9 + corner * 3] - corners[first * 9]) * normalX
        + (corners[second * 9 + corner * 3 + 1] - corners[first * 9 + 1]) * normalY
        + (corners[second * 9 + corner * 3 + 2] - corners[first * 9 + 2]) * normalZ;
      if (Math.abs(distance) > tolerance) return;
    }
    // A big flat part beside dense props can have more pairs than fit in memory: stop the search at a limit instead.
    if (seen.size >= testedPairLimit) {
      result.truncated = true;
      result.truncatedAt ??= entries[owner[second]].part.name;
      return;
    }
    seen.add(first, second);
    const area = sharedArea(table, first, second, dropped, axisU, axisV);
    if (area < Math.max(FLUSH_MINIMUM_AREA, FLUSH_MINIMUM_AREA_SHARE * Math.min(areas[first], areas[second]))) return;
    if (result.pairs.length >= pairBudget) {
      result.truncated = true;
      result.truncatedAt ??= entries[owner[second]].part.name;
      return;
    }
    const lift = planeHeight(table, second, dropped, axisU, axisV, sharedCentre[0], sharedCentre[1]) - planeHeight(table, first, dropped, axisU, axisV, sharedCentre[0], sharedCentre[1]);
    const gap = lift * normals[first * 3 + dropped];
    // The two planes are one plane when the gap is within the rounding of the coordinates of these two triangles, not of the
    // whole scene: a far backdrop must not blur the order of faces near the origin.
    let largestCoordinate = 0;
    for (let value = 0; value < 6; value++) largestCoordinate = Math.max(largestCoordinate, Math.abs(boxes[first * 6 + value]), Math.abs(boxes[second * 6 + value]));
    result.pairs.push({ first, second, gap, area, opposite, flush: Math.abs(gap) <= flushTolerance(largestCoordinate) });
  }
  // `measure` is what the grid walk calls once a pair has passed its box tests (measureCandidates); `droppedAxes` holds the axis
  // every triangle's plane drops, which that walk reads. `testedCount` is how many pairs were measured, which the tested-pair limit counts.
  return { measure: measurePair, droppedAxes: droppedAxesOf(table), testedCount: () => seen.size };
}

// A triangle never drops an axis its normal barely leans on (the dropped axis has a component of at least 0.577), so that axis
// is one the shared area is measured along: two triangles only share area when their boxes overlap there, with no reach.
function inPlaneSweepAxis(normals, id) {
  let axis = 0;
  for (let candidate = 1; candidate < 3; candidate++) {
    if (Math.abs(normals[id * 3 + candidate]) < Math.abs(normals[id * 3 + axis])) axis = candidate;
  }
  return Math.abs(normals[id * 3 + axis]) < SWEEP_AXIS_LEAN ? axis : -1;
}

// Natives are swept along one axis against each other; every native is also tested against every guest of the cell. A cell is
// tested a range of natives at a time, so a cell with a great many natives can be split across checkpoints.
function* testCells(cells, table, reach, pairTest) {
  const { boxes, normals } = table;
  let workSinceCheckpoint = 0;
  for (const cell of cells) {
    const { natives, guests } = cell;
    const sweepAxis = natives.length > 2 ? inPlaneSweepAxis(normals, natives[0]) : -1;
    const sweepFrom = Math.max(sweepAxis, 0);
    if (natives.length > 2) natives.sort((first, second) => boxes[first * 6 + sweepFrom] - boxes[second * 6 + sweepFrom]);
    const workPerNative = guests.length + Math.min(natives.length, SWEEP_WORK_CAP) + 1;
    const nativesPerRange = Math.max(1, Math.floor(TEST_CHECKPOINT_WORK / workPerNative));
    for (let from = 0; from < natives.length; from += nativesPerRange) {
      const to = Math.min(natives.length, from + nativesPerRange);
      testNativeRange(cell, boxes, sweepAxis, from, to, reach, pairTest);
      workSinceCheckpoint += (to - from) * workPerNative;
      if (workSinceCheckpoint >= TEST_CHECKPOINT_WORK) {
        workSinceCheckpoint = 0;
        yield;
      }
    }
  }
}

const PLANE_AXIS_U = [1, 2, 0];
const PLANE_AXIS_V = [2, 0, 1];

// Measures `native` against `candidates` from `from` on. Most candidates fail a box test, so those are made here with the native's
// box in locals: the reach test, then the overlap across the plane's two axes (triangles that only touch along an edge share no
// area, which drops the neighbours of one dense flat mesh before they cost a plane test, a pair entry and a clip, issue #1216;
// the plane is the one of the lower triangle, as in measurePair). A native is swept against the natives after it and stops at the first one past `sweepEnd`; a guest list has no such order.
function measureCandidates(pairTest, boxes, native, candidates, from, reach, sweepFrom, sweepEnd, sweeping) {
  const { droppedAxes, measure } = pairTest;
  const nativeBox = native * 6;
  const lowX = boxes[nativeBox];
  const lowY = boxes[nativeBox + 1];
  const lowZ = boxes[nativeBox + 2];
  const highX = boxes[nativeBox + 3];
  const highY = boxes[nativeBox + 4];
  const highZ = boxes[nativeBox + 5];
  for (let index = from; index < candidates.length; index++) {
    const candidate = candidates[index];
    const candidateBox = candidate * 6;
    if (sweeping && boxes[candidateBox + sweepFrom] > sweepEnd) break;
    if (highX < boxes[candidateBox] - reach || boxes[candidateBox + 3] < lowX - reach) continue;
    if (highY < boxes[candidateBox + 1] - reach || boxes[candidateBox + 4] < lowY - reach) continue;
    if (highZ < boxes[candidateBox + 2] - reach || boxes[candidateBox + 5] < lowZ - reach) continue;
    const dropped = droppedAxes[native < candidate ? native : candidate];
    const axisU = PLANE_AXIS_U[dropped];
    const axisV = PLANE_AXIS_V[dropped];
    if (boxes[nativeBox + 3 + axisU] <= boxes[candidateBox + axisU] || boxes[candidateBox + 3 + axisU] <= boxes[nativeBox + axisU]) continue;
    if (boxes[nativeBox + 3 + axisV] <= boxes[candidateBox + axisV] || boxes[candidateBox + 3 + axisV] <= boxes[nativeBox + axisV]) continue;
    measure(native, candidate);
  }
}

function testNativeRange(cell, boxes, sweepAxis, from, to, reach, pairTest) {
  const { natives, guests } = cell;
  const sweepReach = sweepAxis < 0 ? reach : 0;
  const sweepFrom = Math.max(sweepAxis, 0);
  for (let index = from; index < to; index++) {
    const native = natives[index];
    const sweepEnd = boxes[native * 6 + 3 + sweepFrom] + sweepReach;
    measureCandidates(pairTest, boxes, native, natives, index + 1, reach, sweepFrom, sweepEnd, true);
    measureCandidates(pairTest, boxes, native, guests, 0, reach, sweepFrom, sweepEnd, false);
  }
}

/**
 * Pairs of triangles that draw the same plane in the same place. A part is `{ name, geometry: { positions, indices }, matrix,
 * material? }`; deforming parts (isDeformingPart) are left out. Returns `{ parts, count, owner, local, areas, corners, pairs,
 * unchecked, truncated }`: `corners` holds nine world coordinates per triangle, `pairs` holds `{ first, second, gap, area, opposite, flush }` with triangle ids below `count`, `owner[id]` the
 * index into `parts` and `local[id]` the triangle inside that part's geometry. `gap` is in metres along the first triangle's
 * normal, positive when the second triangle is in front of it; `flush` says the gap is within rounding (flushTolerance), so the
 * two lie on one plane; `opposite` marks a pair that faces opposite ways (one part is double sided). `unchecked` lists parts
 * past `triangleBudget`.
 */
export function findFlushPairs(parts, options) {
  return drainSteps(findFlushPairsSteps(parts, options));
}

/**
 * The same search as findFlushPairs, written as a generator that yields at checkpoints (issue #2905): a runner can stop at any
 * of them and go on later, and the result is the one findFlushPairs returns. Nothing outside the search is changed before it
 * returns, so a search that is dropped at a checkpoint leaves no trace; another search may run between two checkpoints.
 */
export function* findFlushPairsSteps(parts, options = {}) {
  const { triangleBudget = DEFAULT_TRIANGLE_BUDGET, pairBudget = DEFAULT_PAIR_BUDGET, testedPairLimit = MAXIMUM_TESTED_PAIRS } = options;
  const { entries, unchecked } = withinTriangleBudget(searchableParts(parts), triangleBudget);
  yield;
  const sceneBounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const { bounds } of entries) {
    for (let axis = 0; axis < 3; axis++) {
      sceneBounds[axis] = Math.min(sceneBounds[axis], bounds[axis]);
      sceneBounds[3 + axis] = Math.max(sceneBounds[3 + axis], bounds[3 + axis]);
    }
  }
  // No pair of parts spans more than the scene, so this is the widest gap any pair is tested with.
  const reach = nearTolerance(boundsDiagonal(sceneBounds));
  const signatures = entries.map(entry => partSignature(entry.part));
  const limitsKey = `${triangleBudget}|${pairBudget}|${testedPairLimit}`;
  const match = unchecked.length === 0 ? matchRemembered(signatures, reach, limitsKey) : null;
  const reading = match ? yield* readTrianglesForReuse(entries, match, reach + PART_BOX_SLACK * boundsDiagonal(sceneBounds)) : null;
  if (match && !reading) {
    forgetSearch();
    return yield* findFlushPairsSteps(parts, options);
  }
  const table = reading ? reading.table : yield* readTriangles(entries);
  const reused = reading ? reading.reused : null;
  const result = { parts: entries.map(entry => entry.part), count: table.count, owner: table.owner, local: table.local, areas: table.areas, corners: table.corners, pairs: [], unchecked, truncated: false, searched: 0, testedPairs: 0 };
  if (table.count < 2) return result;
  yield;
  if (!(reused && (yield* searchChangedParts(table, entries, reused, reach, { pairBudget, testedPairLimit }, result)))) {
    result.pairs = [];
    result.truncated = false;
    delete result.truncatedAt;
    if (!(yield* loadRemainingEntries(table, entries))) {
      forgetSearch();
      return yield* findFlushPairsSteps(parts, options);
    }
    yield* searchAllParts(table, entries, reach, { pairBudget, testedPairLimit }, result);
  }
  result.pairs.sort((first, second) => first.first - second.first || first.second - second.second);
  rememberSearch({ signatures, starts: table.starts, pairs: result.pairs, testedPairs: result.testedPairs, reach, complete: !result.truncated && unchecked.length === 0, limitsKey });
  return result;
}

function* searchAllParts(table, entries, reach, { pairBudget, testedPairLimit }, result) {
  const pairTest = createPairTest(table, entries, reach, pairBudget, testedPairLimit, result);
  yield* testCells(yield* buildCoarsenedCells(table, reach), table, reach, pairTest);
  result.searched = table.count;
  result.testedPairs = pairTest.testedCount();
}

// Keeps the pairs between parts that did not change and searches only the triangles near a part that did. Returns false
// when a budget ran out, so the caller searches everything and the result never depends on what was searched before.
function* searchChangedParts(table, entries, reused, reach, { pairBudget, testedPairLimit }, result) {
  const nearIds = yield* triangleIdsNearChanged(table, entries, reused.changed, reach);
  const near = yield* subTableOf(table, nearIds);
  const fresh = { pairs: [], truncated: false };
  const pairTest = createPairTest(near, entries, reach, pairBudget - reused.pairs.length, testedPairLimit, fresh);
  const changedPairTest = {
    droppedAxes: pairTest.droppedAxes,
    measure(one, other) {
      if (reused.changed[near.owner[one]] || reused.changed[near.owner[other]]) pairTest.measure(one, other);
    },
  };
  yield;
  if (near.count > 1) {
    yield* testCells(yield* buildCoarsenedCells(near, reach), near, reach, changedPairTest);
  }
  // A cold search counts every pair it measured, also those with no shared area. The earlier count plus this one bounds it.
  const testedPairs = reused.testedPairs + pairTest.testedCount();
  if (fresh.truncated || testedPairs >= testedPairLimit || reused.pairs.length + fresh.pairs.length > pairBudget) return false;
  result.testedPairs = testedPairs;
  for (const pair of fresh.pairs) result.pairs.push({ ...pair, first: nearIds[pair.first], second: nearIds[pair.second] });
  // A loop, not push(...reused.pairs): a spread of a few hundred thousand pairs overflows the call stack.
  for (const pair of reused.pairs) result.pairs.push(pair);
  result.searched = near.count;
  return true;
}
