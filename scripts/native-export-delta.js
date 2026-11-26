// The tables of a native video frame, sent as what changed since the frame before (#1861).
//
// The page packs the whole scene every frame, and almost all of the bytes come out the same: the static meshes, the lights, the
// environment. The page keeps the tables of its last export, finds the byte ranges that differ and puts only those in the Blob
// the job runner reads. The job runner holds the tables it got last time and patches them, so it ends with the same bytes a full
// export gives; a table of another length patches the bytes it shares with the old one, then appends or cuts (#2180). This file is shared by the page (planning) and the job runner (patching); it touches no browser or Node API.

/** Two changed words closer than this many bytes share one range, so a particle tail is a few ranges instead of thousands. */
export const DELTA_GAP_BYTES = 1024;
/** A table that changes in more places than this goes whole. */
export const DELTA_MAXIMUM_RANGES = 4096;
/** The page keeps its last tables only when they are no bigger than this, so a huge scene is not held twice. */
export const DELTA_MAXIMUM_BASELINE_BYTES = 256 * 1024 ** 2;

const WORD_BYTES = 4;

/**
 * The byte ranges `[offset, length]` in which `after` differs from `before` (two Uint8Arrays of the same length), in order.
 * Ranges merge across gaps up to DELTA_GAP_BYTES. Returns null when there are more than DELTA_MAXIMUM_RANGES of them.
 */
export function changedRanges(before, after) {
  const wordCount = after.byteLength >> 2;
  const aligned = before.byteOffset % WORD_BYTES === 0 && after.byteOffset % WORD_BYTES === 0;
  const ranges = [];
  let rangeStart = -1;
  let rangeEnd = 0;
  const closeRange = () => {
    if (rangeStart >= 0) ranges.push([rangeStart, rangeEnd - rangeStart]);
  };
  const noteChange = (offset, length) => {
    if (rangeStart >= 0 && offset - rangeEnd <= DELTA_GAP_BYTES) {
      rangeEnd = offset + length;
      return true;
    }
    closeRange();
    rangeStart = offset;
    rangeEnd = offset + length;
    return ranges.length <= DELTA_MAXIMUM_RANGES;
  };
  if (aligned) {
    const beforeWords = new Uint32Array(before.buffer, before.byteOffset, wordCount);
    const afterWords = new Uint32Array(after.buffer, after.byteOffset, wordCount);
    for (let word = 0; word < wordCount; word++) {
      if (beforeWords[word] !== afterWords[word] && !noteChange(word * WORD_BYTES, WORD_BYTES)) return null;
    }
  } else {
    for (let byte = 0; byte < wordCount * WORD_BYTES; byte++) {
      if (before[byte] !== after[byte] && !noteChange(byte, 1)) return null;
    }
  }
  for (let byte = wordCount * WORD_BYTES; byte < after.byteLength; byte++) {
    if (before[byte] !== after[byte] && !noteChange(byte, 1)) return null;
  }
  closeRange();
  return ranges.length > DELTA_MAXIMUM_RANGES ? null : ranges;
}

/**
 * The ranges that turn `before` into `after` when the two tables have different lengths: the changes inside the bytes both hold
 * (the shared prefix), then everything past the old end when `after` is longer (merged into the trailing range when within
 * DELTA_GAP_BYTES). A shorter `after` needs no more ranges, since the applier cuts the old table to the new length. Returns null
 * when the result would exceed DELTA_MAXIMUM_RANGES.
 */
export function prefixPatchRanges(before, after) {
  const sharedBytes = Math.min(before.byteLength, after.byteLength);
  const ranges = changedRanges(before.subarray(0, sharedBytes), after.subarray(0, sharedBytes));
  if (ranges === null) return null;
  if (after.byteLength === sharedBytes) return ranges;
  const last = ranges[ranges.length - 1];
  if (last && sharedBytes - (last[0] + last[1]) <= DELTA_GAP_BYTES) {
    last[1] = after.byteLength - last[0];
    return ranges;
  }
  if (ranges.length >= DELTA_MAXIMUM_RANGES) return null;
  ranges.push([sharedBytes, after.byteLength - sharedBytes]);
  return ranges;
}

/**
 * What to send of `tables` (name to Uint8Array) given the `previous` ones: name to a list of `[offset, length]` ranges. A table
 * with no previous one or too many changes is one range over all of it; an unchanged table is an empty list. A table of another
 * length than before sends the changes in the bytes it shares with the old one, then the bytes past the old end (#2180).
 */
export function planExportDelta(previous, tables) {
  const ranges = {};
  for (const [name, bytes] of Object.entries(tables)) {
    const before = previous[name];
    let changed = null;
    if (before) changed = before.byteLength === bytes.byteLength ? changedRanges(before, bytes) : prefixPatchRanges(before, bytes);
    ranges[name] = changed ?? [[0, bytes.byteLength]];
  }
  return ranges;
}

/** The bytes a plan sends, as views of `tables` in manifest order, ready for `new Blob(pieces)`. */
export function deltaPieces(tables, ranges) {
  const pieces = [];
  for (const [name, bytes] of Object.entries(tables)) {
    for (const [offset, length] of ranges[name]) pieces.push(bytes.subarray(offset, offset + length));
  }
  return pieces;
}

/** How many bytes a plan sends. */
export function deltaByteLength(ranges) {
  let total = 0;
  for (const list of Object.values(ranges)) {
    for (const [, length] of list) total += length;
  }
  return total;
}

function requireRangesInside(name, list, byteLength) {
  let previousEnd = 0;
  for (const range of list) {
    const [offset, length] = Array.isArray(range) ? range : [];
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < previousEnd || length < 0 || offset + length > byteLength) {
      throw new RangeError(`The native scene export changed table "${name}" at ${JSON.stringify(range)}, outside its ${byteLength} bytes or out of order. Export the scene again without a baseline.`);
    }
    previousEnd = offset + length;
  }
}

// Whether the ranges (in order, not overlapping) between them cover every byte from `start` to the end of the table.
function coversFrom(list, start, end) {
  let covered = start;
  for (const [offset, length] of list) {
    if (offset + length <= covered) continue;
    if (offset > covered) return false;
    covered = offset + length;
  }
  return covered >= end;
}

/**
 * The full tables from the bytes a delta sent. `lengths` is the byte length of every table now, `ranges` what was sent, `sent` the
 * bytes of all ranges back to back, and `previous` the tables of the export the delta was made against. A table that changed gets a
 * buffer of its own (the previous one may still be held by a native session); a table that did not is the previous object.
 */
export function applyExportDelta({ previous, lengths, ranges, sent }) {
  const tables = {};
  let cursor = 0;
  for (const [name, byteLength] of Object.entries(lengths)) {
    const list = ranges[name];
    if (!Array.isArray(list)) throw new TypeError(`The native scene export delta has no ranges for table "${name}".`);
    requireRangesInside(name, list, byteLength);
    const wholeTable = list.length === 1 && list[0][0] === 0 && list[0][1] === byteLength;
    const before = previous?.[name];
    if (list.length === 0 && before?.byteLength === byteLength) {
      tables[name] = before;
      continue;
    }
    if (wholeTable) {
      tables[name] = sent.slice(cursor, cursor + byteLength);
      cursor += byteLength;
      continue;
    }
    if (!before) {
      throw new RangeError(`The native scene export sent only part of table "${name}", but the tables held here have no bytes for it. Export the scene again without a baseline.`);
    }
    if (before.byteLength < byteLength && !coversFrom(list, before.byteLength, byteLength)) {
      throw new RangeError(`The native scene export grew table "${name}" from ${before.byteLength} to ${byteLength} bytes but sent nothing for the bytes past the old end. Export the scene again without a baseline.`);
    }
    const patched = new Uint8Array(byteLength);
    patched.set(before.subarray(0, Math.min(before.byteLength, byteLength)));
    for (const [offset, length] of list) {
      patched.set(sent.subarray(cursor, cursor + length), offset);
      cursor += length;
    }
    tables[name] = patched;
  }
  if (cursor !== sent.byteLength) {
    throw new RangeError(`The native scene export delta sent ${sent.byteLength} bytes, and its ranges hold ${cursor}. The page changed the export while it was read.`);
  }
  return tables;
}
