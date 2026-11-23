// Packing of splat covariances and the in-place update of an attached splat set (#2756): checks what a caller passes to
// `update`, writes it into the CPU copy of the data texture and says which texture rows changed.

export const DATA_TEXTURE_WIDTH = 2048;
export const TEXELS_PER_SPLAT = 3;
export const WORDS_PER_TEXEL = 4;
const MAXIMUM_SCALE = 1e19;

// A quaternion of any length stands for the rotation of its unit version; all zero stands for no rotation.
function unitQuaternion(rotations, index) {
  if (rotations === null) return [1, 0, 0, 0];
  const [w, x, y, z] = rotations.subarray(index * 4, index * 4 + 4);
  const length = Math.hypot(w, x, y, z);
  if (!(length > 0) || !Number.isFinite(length)) return length === 0 ? [1, 0, 0, 0] : [w, x, y, z];
  return [w / length, x / length, y / length, z / length];
}

// `rotations` may be null for splats that are not rotated.
export function covarianceOf(scales, rotations, index) {
  const [w, x, y, z] = unitQuaternion(rotations, index);
  const rotation = [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y),
  ];
  // rotation is stored by columns; scaling the columns by the axis lengths gives M = R S.
  const scaled = rotation.map((value, entry) => value * scales[index * 3 + Math.floor(entry / 3)]);
  const product = (row, column) => scaled[row] * scaled[column] + scaled[3 + row] * scaled[3 + column] + scaled[6 + row] * scaled[6 + column];
  return [product(0, 0), product(0, 1), product(0, 2), product(1, 1), product(1, 2), product(2, 2)];
}

export function checkCovarianceFinite(covariance, index) {
  if (!covariance.every(value => Number.isFinite(Math.fround(value)))) {
    throw new RangeError(`Gaussian splat ${index} has a covariance that overflows 32-bit floats (its scales or rotation are non-finite or too large). Re-export the file or drop that splat.`);
  }
}

const UPDATE_FIELDS = [
  { field: 'positions', stride: 3, types: [Float32Array, Float64Array], meaning: 'x, y, z per splat' },
  { field: 'colors', stride: 4, types: [Uint8Array, Uint8ClampedArray], meaning: 'red, green, blue, opacity bytes per splat' },
  { field: 'scales', stride: 3, types: [Float32Array, Float64Array], meaning: 'three axis lengths per splat' },
  { field: 'rotations', stride: 4, types: [Float32Array, Float64Array], meaning: 'quaternion w, x, y, z per splat' },
];
const UPDATE_KEYS = new Set(['count', 'start', 'length', 'bounds', ...UPDATE_FIELDS.map(description => description.field)]);

function checkWholeNumber(name, value, minimum, maximum, advice) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`update ${name} must be a whole number from ${minimum} to ${maximum}, got ${String(value)}. ${advice}`);
  }
}

function checkUpdateArray({ field, stride, types, meaning }, values, length) {
  const typeNames = types.map(type => type.name).join(' or ');
  if (!types.some(type => values instanceof type)) {
    throw new TypeError(`update needs ${field} as a ${typeNames} of ${length * stride} values (${length} splats x ${stride}: ${meaning}), got ${values === null ? 'null' : typeof values === 'object' ? values.constructor?.name ?? 'an object' : typeof values}`);
  }
  if (values.length < length * stride) {
    throw new RangeError(`update needs ${field} to hold ${length * stride} values (${length} splats x ${stride}: ${meaning}), got ${values.length}. Pass ${stride} values for every splat in the range, or lower length`);
  }
  if (field === 'positions' || field === 'scales' || field === 'rotations') {
    for (let index = 0; index < length * stride; index++) {
      if (!Number.isFinite(values[index])) throw new RangeError(`update ${field}[${index}] is ${String(values[index])}; every value must be a finite number`);
      // A squared scale past the 32-bit float range overflows the covariance; refuse it before anything is written.
      if (field === 'scales' && Math.abs(values[index]) > MAXIMUM_SCALE) throw new RangeError(`update scales[${index}] is ${values[index]}; a scale above ${MAXIMUM_SCALE} overflows 32-bit floats. Pass a smaller axis length`);
    }
  }
}

/**
 * Checks `change` against the splats it updates: `{ positions, colors, scales, rotations, count, start, length }`. The arrays hold
 * `length` splats that replace splats `start` to `start + length` (default: from 0 to the new count); `count` is the new number of
 * splats (default: unchanged, at most the capacity); `bounds` is the box that holds every centre (default: measured). Returns the change with the numbers resolved.
 */
export function resolveSplatUpdate(change, splats) {
  if (change === null || typeof change !== 'object') {
    throw new TypeError(`update needs an object such as { positions, colors, scales, rotations, count, start, length }, got ${change === null ? 'null' : typeof change}`);
  }
  const unknown = Object.keys(change).filter(key => !UPDATE_KEYS.has(key));
  if (unknown.length > 0) throw new TypeError(`update does not take ${unknown.join(', ')}. It takes ${[...UPDATE_KEYS].join(', ')}`);
  if (splats.harmonicBands) throw new Error('update does not support splats with spherical harmonic bands: their bands are fixed at create time. Create the splats without sphericalHarmonics to animate them');
  const total = change.count ?? splats.count;
  checkWholeNumber('count', total, 1, splats.capacity, 'Create the splats with a larger capacity option to hold more');
  const start = change.start ?? 0;
  checkWholeNumber('start', start, 0, splats.count, 'A range starts inside the splats or right after the last one');
  const length = change.length ?? total - start;
  checkWholeNumber('length', length, 0, total - start, 'The range must end inside the new count');
  const present = UPDATE_FIELDS.filter(description => change[description.field] !== undefined);
  for (const description of present) checkUpdateArray(description, change[description.field], length);
  if (change.rotations !== undefined && change.scales === undefined) throw new TypeError('update needs scales together with rotations: a splat shape comes from both. Pass scales too');
  if (total > splats.count) checkGrowth(change, splats.count, start, length, total);
  return { positions: change.positions ?? null, colors: change.colors ?? null, scales: change.scales ?? null, rotations: change.rotations ?? null, bounds: change.bounds ?? null, count: total, start, length };
}

function checkGrowth(change, oldCount, start, length, total) {
  if (start > oldCount || start + length < total) {
    throw new RangeError(`update grows the splats from ${oldCount} to ${total}, so its range must cover splats ${oldCount} to ${total}; got start ${start} and length ${length}`);
  }
  for (const field of ['positions', 'colors', 'scales']) {
    if (change[field] === undefined) throw new TypeError(`update grows the splats to ${total}, so it needs ${field} for the new splats. Pass positions, colors and scales`);
  }
}

// Writes the passed attributes into the CPU copy `words` (the data texture) and returns the texture rows that changed.
export function writeSplatUpdate(words, update) {
  const { positions, colors, scales, rotations, start, length } = update;
  const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
  for (let offset = 0; offset < length; offset++) {
    const base = (start + offset) * TEXELS_PER_SPLAT * WORDS_PER_TEXEL;
    if (positions) for (let axis = 0; axis < 3; axis++) floats[base + axis] = positions[offset * 3 + axis];
    if (colors) for (let channel = 0; channel < 4; channel++) bytes[(base + 3) * 4 + channel] = colors[offset * 4 + channel];
    if (scales) {
      const covariance = covarianceOf(scales, rotations, offset);
      checkCovarianceFinite(covariance, start + offset);
      floats.set(covariance, base + 4);
    }
  }
  const firstTexel = start * TEXELS_PER_SPLAT;
  const endTexel = (start + length) * TEXELS_PER_SPLAT;
  return { firstRow: Math.floor(firstTexel / DATA_TEXTURE_WIDTH), endRow: Math.ceil(endTexel / DATA_TEXTURE_WIDTH) };
}
