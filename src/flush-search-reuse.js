// Keeps the last flush search so an edit that adds a part searches only what the new part touches (issue #2842).
//
// A pair of triangles is found or missed by the two parts that own them, their geometry, their matrices and whether one
// shows both sides; nothing else in the scene. So when the scene changes by a part or two, the pairs between parts that
// stayed are still the pairs a cold search would find, and only the pairs that involve a new part need searching. The memory
// holds numbers and pair records, never parts, geometries or triangle tables, so a scene that is dropped can be collected.

import { isLiveGeometry } from './live-geometry.js';

const REMEMBERED_PAIR_LIMIT = 200_000;
const CHANGED_PART_LIMIT = 256;
// Triangles handled between two checkpoints of the generators below (issue #2905).
const CHECKPOINT_TRIANGLES = 8192;

let remembered = null;
let nextGeometryNumber = 1;
let nextLiveStamp = 1;
const geometryNumbers = new WeakMap();

function geometryNumber(geometry) {
  let number = geometryNumbers.get(geometry);
  if (number === undefined) {
    number = nextGeometryNumber++;
    geometryNumbers.set(geometry, number);
  }
  return number;
}

/**
 * What decides the pairs of one searched part (a rule for every writer of geometry: an edit in place of a geometry's
 * positions or indices must call markLiveGeometry, because this key is the geometry object): its geometry, its matrix and whether it shows both sides. A live geometry
 * (cloth, updatePartVertices) has its positions rewritten in place, so its object says nothing about its data: every
 * signature of one is new and the part always counts as changed.
 */
export function partSignature(part) {
  if (isLiveGeometry(part.geometry)) return `live|${nextLiveStamp++}`;
  const doubleSided = part.material?.doubleSided === true ? 1 : 0;
  return `${geometryNumber(part.geometry)}|${doubleSided}|${Array.prototype.join.call(part.matrix, ',')}`;
}

/** The id of the first triangle of every entry, and one more for the total, from the table's owner column. */
export function entryStarts(table, entryCount) {
  const starts = new Uint32Array(entryCount + 1);
  for (let id = 0; id < table.count; id++) starts[table.owner[id] + 1]++;
  for (let entry = 0; entry < entryCount; entry++) starts[entry + 1] += starts[entry];
  return starts;
}

/** Stores a finished search for the next one to build on; a search that hit a budget, or a very large one, is not kept. */
export function rememberSearch({ signatures, starts, pairs, testedPairs, reach, complete, limitsKey }) {
  remembered = complete && pairs.length <= REMEMBERED_PAIR_LIMIT ? { signatures, starts, pairs, testedPairs, reach, limitsKey } : null;
}

/** Drops the stored search, so the next one is cold. */
export function forgetSearch() {
  remembered = null;
}

// For every new entry, the entry of the last search with the same signature, or -1. The matches keep the order they had, so
// a pair's first triangle stays the one with the lower id.
function matchEntries(previousSignatures, signatures) {
  const queues = new Map();
  previousSignatures.forEach((signature, index) => {
    const queue = queues.get(signature) ?? [];
    queue.push(index);
    queues.set(signature, queue);
  });
  const matches = new Int32Array(signatures.length).fill(-1);
  let lastMatched = -1;
  signatures.forEach((signature, index) => {
    const queue = queues.get(signature);
    while (queue?.length && queue[0] <= lastMatched) queue.shift();
    if (!queue?.length) return;
    lastMatched = queue.shift();
    matches[index] = lastMatched;
  });
  return matches;
}

function remapPairs(previous, matches, starts) {
  const newEntryOf = new Int32Array(previous.starts.length - 1).fill(-1);
  matches.forEach((previousEntry, entry) => {
    if (previousEntry >= 0) newEntryOf[previousEntry] = entry;
  });
  const entryOfId = id => {
    let low = 0;
    let high = newEntryOf.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (previous.starts[middle] <= id) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const remapped = [];
  for (const pair of previous.pairs) {
    const firstEntry = entryOfId(pair.first);
    const secondEntry = entryOfId(pair.second);
    if (newEntryOf[firstEntry] < 0 || newEntryOf[secondEntry] < 0) continue;
    const first = starts[newEntryOf[firstEntry]] + pair.first - previous.starts[firstEntry];
    const second = starts[newEntryOf[secondEntry]] + pair.second - previous.starts[secondEntry];
    remapped.push({ ...pair, first, second });
  }
  return remapped;
}

/**
 * What the last search still settles for these entries: `{ pairs, changed }` with the pairs between entries that stayed, in
 * this search's triangle ids, and a flag per entry that is new or moved. Null when nothing can be reused: no earlier search,
 * a different `reach` (which decides how far apart boxes are still tested) or set of budgets, or too many new parts to be worth it.
 */
export function reusableSearch(signatures, starts, reach, limitsKey) {
  if (!remembered || remembered.reach !== reach || remembered.limitsKey !== limitsKey) return null;
  const matches = matchEntries(remembered.signatures, signatures);
  const changed = new Uint8Array(signatures.length);
  let changedCount = 0;
  matches.forEach((previousEntry, entry) => {
    if (previousEntry < 0) {
      changed[entry] = 1;
      changedCount++;
    }
  });
  if (changedCount > CHANGED_PART_LIMIT) return null;
  return { pairs: remapPairs(remembered, matches, starts), testedPairs: remembered.testedPairs, changed, changedCount };
}

/**
 * The ids of the triangles a search for the pairs of the changed entries has to look at: every triangle of a changed entry
 * and every other triangle whose box lies within `reach` of the bounds of one. Ascending, so a pair keeps its first triangle.
 */
export function* triangleIdsNearChanged(table, entries, changed, reach) {
  const changedBounds = entries.filter((entry, index) => changed[index]).map(entry => entry.bounds);
  const ids = [];
  const { boxes, owner } = table;
  for (let id = 0; id < table.count; id++) {
    if (id % CHECKPOINT_TRIANGLES === CHECKPOINT_TRIANGLES - 1) yield;
    if (changed[owner[id]] || nearAnyBounds(boxes, id, changedBounds, reach)) ids.push(id);
  }
  return Uint32Array.from(ids);
}

function nearAnyBounds(boxes, id, boundsList, reach) {
  const base = id * 6;
  return boundsList.some(bounds => (
    boxes[base + 3] >= bounds[0] - reach && boxes[base] <= bounds[3] + reach
    && boxes[base + 4] >= bounds[1] - reach && boxes[base + 1] <= bounds[4] + reach
    && boxes[base + 5] >= bounds[2] - reach && boxes[base + 2] <= bounds[5] + reach
  ));
}

/** A table of only the triangles in `ids`, in that order, sharing the columns' meaning of the full table. */
export function* subTableOf(table, ids) {
  const count = ids.length;
  const sub = {
    count,
    corners: new Float64Array(count * 9),
    normals: new Float64Array(count * 3),
    boxes: new Float64Array(count * 6),
    areas: new Float64Array(count),
    owner: new Uint32Array(count),
    local: new Uint32Array(count),
  };
  for (let index = 0; index < count; index++) {
    if (index % CHECKPOINT_TRIANGLES === CHECKPOINT_TRIANGLES - 1) yield;
    const id = ids[index];
    sub.corners.set(table.corners.subarray(id * 9, id * 9 + 9), index * 9);
    sub.normals.set(table.normals.subarray(id * 3, id * 3 + 3), index * 3);
    sub.boxes.set(table.boxes.subarray(id * 6, id * 6 + 6), index * 6);
    sub.areas[index] = table.areas[id];
    sub.owner[index] = table.owner[id];
    sub.local[index] = table.local[id];
  }
  return sub;
}
