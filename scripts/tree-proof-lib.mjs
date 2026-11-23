// The measuring half of scripts/tree-proof.mjs (#3041): every part here runs on the CPU in Node, so a test can check it
// without a GPU or a browser. The script adds the stills and the sheet.
import { TREE_PRESETS } from '../src/vegetation-presets.js';
import { LEVEL_SETTINGS, TREE_LEVEL_DISTANCES } from '../src/vegetation-species.js';
import { createTree, resolveTreePreset } from '../src/vegetation.js';
import { bakeImpostorAtlas, impostorFrameDirection } from '../src/vegetation-impostors.js';
import { IMPOSTOR_FRAMES } from '../src/impostor-shader.js';

export const PRESET_NAMES = Object.freeze(Object.keys(TREE_PRESETS));
export const DEFAULT_SEED = 4;
export const DEFAULT_LEVEL_MARGIN = 0.05;
// A baked frame counts as "near the horizon" when its view direction rises less than this (the sine of about 14 degrees).
export const HORIZON_ELEVATION_LIMIT = 0.25;
const SOLIDITY_FRAME_SIZE = 128;
const LEAF_TEXTURE_PIXELS = 128;

// Painted leaf length in pixels of the 128 px leaf texture, as (shortest, longest) of the painters in
// src/vegetation-textures.js: a sprig paints 22 to 32 px leaves and a 40 px tip leaf, a needle spray 19 to 34 px needles,
// a single frond leaf 96 to 124 px, a clump 24 to 36 px leaves.
export const PAINTED_LEAF_PIXELS = Object.freeze({
  sprig: Object.freeze([22, 40]),
  needles: Object.freeze([19, 34]),
  single: Object.freeze([96, 124]),
  clump: Object.freeze([24, 36]),
});

/**
 * The camera distances that probe each level switch: just inside and just outside every threshold, by `margin` of it.
 * Returns `{ level, distance, side }` in distance order; `level` is the level a tree draws at that distance.
 */
export function levelProbes(thresholds = TREE_LEVEL_DISTANCES, margin = DEFAULT_LEVEL_MARGIN) {
  if (!Array.isArray(thresholds) || thresholds.length === 0 || thresholds.some((value, index) => !(value > 0) || (index > 0 && value <= thresholds[index - 1]))) {
    throw new RangeError('thresholds must be a list of increasing distances in meters, such as [38, 95, 150]');
  }
  if (!(margin > 0 && margin < 1)) throw new RangeError('margin must be a fraction between 0 and 1, such as 0.05');
  return thresholds.flatMap((threshold, index) => [
    { level: index, distance: threshold * (1 - margin), side: 'below' },
    { level: index + 1, distance: threshold * (1 + margin), side: 'above' },
  ]);
}

/**
 * Crown solidity of one view: the opaque share of the crown silhouette. `mask` holds one entry per pixel, nonzero where
 * the foliage is opaque. The silhouette is the span between the leftmost and rightmost opaque pixel of each row, so the
 * gaps inside the crown count as empty and the empty sky beside it does not. Returns `{ opaque, silhouette, solidity }`.
 */
export function solidityFromMask(mask, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('width and height must be whole numbers of pixels, such as 128');
  }
  if (mask.length !== width * height) throw new RangeError(`mask has ${mask.length} entries; pass width * height = ${width * height}`);
  let opaque = 0;
  let silhouette = 0;
  for (let row = 0; row < height; row++) {
    let first = -1;
    let last = -1;
    let count = 0;
    for (let column = 0; column < width; column++) {
      if (!mask[row * width + column]) continue;
      if (first < 0) first = column;
      last = column;
      count++;
    }
    if (count === 0) continue;
    opaque += count;
    silhouette += last - first + 1;
  }
  return { opaque, silhouette, solidity: silhouette === 0 ? 0 : opaque / silhouette };
}

/** The atlas cells (`{ column, row }`) whose baked view rises less than `elevationLimit` above the horizon. */
export function horizonCells(elevationLimit = HORIZON_ELEVATION_LIMIT) {
  const cells = [];
  for (let row = 0; row < IMPOSTOR_FRAMES; row++) {
    for (let column = 0; column < IMPOSTOR_FRAMES; column++) {
      if (impostorFrameDirection(column, row)[1] < elevationLimit) cells.push({ column, row });
    }
  }
  return cells;
}

/**
 * Painted leaf length of a leaf card, in centimeters, as `[shortest, longest]`, or null when the level draws no leaf
 * cards. `texture` is the species leaf texture kind, `cardHeightMeters` the card height and `leafScale` the level's
 * enlargement of its cards (LEVEL_SETTINGS).
 */
export function paintedLeafLengthCentimeters({ texture, cardHeightMeters, leafScale = 1 }) {
  const pixels = Object.hasOwn(PAINTED_LEAF_PIXELS, texture) ? PAINTED_LEAF_PIXELS[texture] : null;
  if (!pixels) throw new RangeError(`texture must be one of ${Object.keys(PAINTED_LEAF_PIXELS).join(', ')}; got ${texture}`);
  if (!(cardHeightMeters > 0)) throw new RangeError('cardHeightMeters must be a positive number of meters, such as 1.1');
  return pixels.map(length => length / LEAF_TEXTURE_PIXELS * cardHeightMeters * leafScale * 100);
}

/** The camera eye of a level camera `distance` meters (straight line) from the tree base, at height `centerY` and sideways position `centerX`. */
export function levelCameraEye({ centerY, centerX = 0, distance }) {
  const depthSquared = distance * distance - centerY * centerY - centerX * centerX;
  if (!(depthSquared > 0)) throw new RangeError(`distance must be above ${Math.hypot(centerX, centerY)} m, the distance to the middle of the tree; pass a larger distance`);
  return [centerX, centerY, Math.sqrt(depthSquared)];
}

/** The axis-aligned bounds of every part of `tree` at `level`: `{ minimum, maximum }` in meters. */
export function levelBounds(tree, level) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of tree.levels[level].parts) {
    const { positions } = part.geometry;
    for (let index = 0; index < positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], positions[index + axis]);
        maximum[axis] = Math.max(maximum[axis], positions[index + axis]);
      }
    }
  }
  return { minimum, maximum };
}

/**
 * A level camera that keeps the whole tree in the picture: the field of view (degrees), the middle of the tree and the
 * visible height. The tree fills `photoFraction` of the picture height like the photo's tree, but never more than `margin`
 * of the height or of the width (`aspect` is width over height), so the base and the crown are always inside.
 */
export function fitFraming({ bounds, aspect, photoFraction, distance, margin = 0.9 }) {
  const width = Math.max(bounds.maximum[0] - bounds.minimum[0], bounds.maximum[2] - bounds.minimum[2]);
  const height = bounds.maximum[1] - bounds.minimum[1];
  const visibleHeight = Math.max(height / photoFraction, height / margin, width / (aspect * margin));
  return {
    fov: 2 * Math.atan(visibleHeight / 2 / distance) * 180 / Math.PI,
    centerX: (bounds.minimum[0] + bounds.maximum[0]) / 2,
    centerY: (bounds.minimum[1] + bounds.maximum[1]) / 2,
    visibleHeight,
  };
}

/** The tree the proof measures and renders (the same seed the recipe grows). */
export function growTree({ preset, seed = DEFAULT_SEED }) {
  return createTree({ preset }, seed);
}

function trianglesOf(parts, role) {
  return parts.filter(part => part.role === role).reduce((total, part) => total + part.geometry.indices.length / 3, 0);
}

function foliageOnly(tree) {
  return { ...tree, levels: tree.levels.map(level => ({ ...level, parts: level.parts.filter(part => part.role === 'foliage') })) };
}

/** Crown solidity of `tree` at `level`: the mean over the baked frames near the horizon (CPU baker, foliage only). */
export function crownSolidity(tree, level, { frameSize = SOLIDITY_FRAME_SIZE } = {}) {
  const atlas = bakeImpostorAtlas(foliageOnly(tree), { frameSize, level });
  const cells = horizonCells();
  let total = 0;
  for (const { column, row } of cells) {
    const mask = new Uint8Array(frameSize * frameSize);
    for (let y = 0; y < frameSize; y++) {
      for (let x = 0; x < frameSize; x++) {
        mask[y * frameSize + x] = atlas.colorPixels[((row * frameSize + y) * atlas.width + column * frameSize + x) * 4 + 3] > 0 ? 1 : 0;
      }
    }
    total += solidityFromMask(mask, frameSize, frameSize).solidity;
  }
  return total / cells.length;
}

/**
 * One row per level of the preset's tree: triangles of the foliage and the bark, crown solidity and painted leaf length.
 * `leafCentimeters` is `[shortest, longest]` or null (the crown clumps of the far levels paint no leaves).
 */
export function measureTreeLevels({ preset, seed = DEFAULT_SEED, height, frameSize }) {
  const tree = createTree({ preset, ...(height === undefined ? {} : { height }) }, seed);
  const { preset: grown } = resolveTreePreset({ preset });
  const leaf = grown.leaf;
  return tree.levels.map((level, index) => {
    const setting = LEVEL_SETTINGS[index];
    const paintsLeaves = setting.leafKeep > 0 && leaf.cardSize && leaf.texture;
    return {
      preset, seed, level: index,
      foliageTriangles: trianglesOf(level.parts, 'foliage'),
      barkTriangles: trianglesOf(level.parts, 'bark'),
      solidity: crownSolidity(tree, index, frameSize === undefined ? {} : { frameSize }),
      leafCentimeters: paintsLeaves ? paintedLeafLengthCentimeters({ texture: leaf.texture, cardHeightMeters: leaf.cardSize[1], leafScale: setting.leafScale }) : null,
    };
  });
}

/** The measured rows as aligned text, one line per preset level. */
export function formatProofTable(rows) {
  const header = ['preset', 'level', 'foliage tris', 'bark tris', 'solidity', 'leaf cm'];
  const lines = rows.map(row => [
    row.preset,
    String(row.level),
    String(row.foliageTriangles),
    String(row.barkTriangles),
    row.solidity.toFixed(2),
    row.leafCentimeters ? `${row.leafCentimeters[0].toFixed(0)}-${row.leafCentimeters[1].toFixed(0)}` : '-',
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...lines.map(line => line[column].length)));
  const format = cells => cells.map((cell, column) => column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])).join('  ');
  return [format(header), ...lines.map(format)].join('\n');
}
