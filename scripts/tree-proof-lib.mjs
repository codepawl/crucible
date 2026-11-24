// The measuring half of scripts/tree-proof.mjs (#3041): every part here runs on the CPU in Node, so a test can check it
// without a GPU or a browser. The script adds the stills and the sheet.
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
const TWIG_TEXTURE_PIXELS = 256;
const LARGE_TEXTURE_KINDS = ['twig', 'frond', 'pine'];

// Painted leaf length in pixels of the 128 px leaf texture, as (shortest, longest) of the painters in
// src/vegetation-textures.js: a sprig paints 22 to 32 px leaves and a 40 px tip leaf, a twig of the 256 px card 19 to 29 px leaves, a needle spray 19 to 34 px needles,
// a single frond leaf 96 to 124 px, a clump 24 to 36 px leaves.
export const PAINTED_LEAF_PIXELS = Object.freeze({
  sprig: Object.freeze([22, 40]),
  twig: Object.freeze([19, 29]),
  needles: Object.freeze([19, 34]),
  pine: Object.freeze([18, 30]),
  frond: Object.freeze([24, 115]),
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
  const textureKind = typeof texture === 'string' && texture.startsWith('twig') ? 'twig' : texture;
  const pixels = Object.hasOwn(PAINTED_LEAF_PIXELS, textureKind) ? PAINTED_LEAF_PIXELS[textureKind] : null;
  if (!pixels) throw new RangeError(`texture must be one of ${Object.keys(PAINTED_LEAF_PIXELS).join(', ')}; got ${texture}`);
  if (!(cardHeightMeters > 0)) throw new RangeError('cardHeightMeters must be a positive number of meters, such as 1.1');
  const textureSize = LARGE_TEXTURE_KINDS.includes(textureKind) ? TWIG_TEXTURE_PIXELS : LEAF_TEXTURE_PIXELS;
  return pixels.map(length => length / textureSize * cardHeightMeters * leafScale * 100);
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
export function growTree({ preset, seed = DEFAULT_SEED, tree }) {
  return createTree({ preset, ...(tree === undefined ? {} : { tree }) }, seed);
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
export function measureTreeLevels({ preset, seed = DEFAULT_SEED, height, frameSize, tree: growth }) {
  const growthOptions = growth === undefined ? {} : { tree: growth };
  const tree = createTree({ preset, ...(height === undefined ? {} : { height }), ...growthOptions }, seed);
  const { preset: grown } = resolveTreePreset({ preset, ...growthOptions });
  const leaf = grown.leaf;
  return tree.levels.map((level, index) => {
    const setting = LEVEL_SETTINGS[index];
    const paintsLeaves = setting.leafKeep > 0 && !(setting.clumps && leaf.farClumps) && leaf.cardSize && leaf.texture;
    return {
      preset, seed, level: index,
      foliageTriangles: trianglesOf(level.parts, 'foliage'),
      barkTriangles: trianglesOf(level.parts, 'bark'),
      solidity: crownSolidity(tree, index, frameSize === undefined ? {} : { frameSize }),
      leafCentimeters: paintsLeaves ? paintedLeafLengthCentimeters({ texture: leaf.texture, cardHeightMeters: leaf.cardSize[1], leafScale: leaf.frondRibbon ? 1 : leaf.farCards?.[index]?.leafScale ?? setting.leafScale }) : null,
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

// ---- Crown metrics (#3057) ----------------------------------------------------------------------------------------
// Row-span solidity above approved a crown that looks like a stack of plates, because it ignores the notches at the rim
// and the size of the sky holes. These metrics read a crown mask normalised to CROWN_MASK_HEIGHT pixels tall:
//   hullFill         opaque pixels over the pixels inside the convex hull of the crown (1 is a solid blob)
//   bayShare         hull pixels that are empty and open to the sky outside (notches in the rim)
//   skyHole          side of the largest enclosed sky hole over the crown height (kept for history: the ragged rim of a crown
//                    leaves specks that count as enclosed holes, so it reads high on a dense crown)
//   interiorHole     side of the largest empty patch inside the hull pulled in by INTERIOR_INSET of the crown width, over the
//                    crown height: a gap between branch tiers counts, rim specks do not
//   interiorOpen     share of that inner hull that is empty: how much light shows through the inside
//   widthOverHeight  crown width over crown height
//   widestRow        height of the widest row above the crown base, 0 at the base and 1 at the top
//   rowSolidity      the old row-span measure, for history only
export const CROWN_MASK_HEIGHT = 256;
// The crown ends at the lowest row that is still this share of the widest row; the trunk below it is dropped.
const CROWN_BASE_SPAN_SHARE = 0.3;
// The inner hull keeps the pixels at least this share of the crown width inside the hull edge.
export const INTERIOR_INSET = 0.05;
const WIDEST_ROW_TOLERANCE = 0.97;
const WIDEST_ROW_SMOOTHING = 5;
const FOUR_NEIGHBOURS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);
export const CROWN_METRIC_NAMES = Object.freeze(['hullFill', 'bayShare', 'skyHole', 'interiorHole', 'interiorOpen', 'widthOverHeight', 'widestRow', 'rowSolidity']);
export const BAND_METRIC_NAMES = Object.freeze(['hullFill', 'bayShare', 'interiorHole', 'interiorOpen', 'widthOverHeight', 'widestRow']);

function requireMask(mask, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('width and height must be whole numbers of pixels, such as 256');
  }
  if (mask.length !== width * height) throw new RangeError(`mask has ${mask.length} entries; pass width * height = ${width * height}`);
}

function rowSpans(mask, width, height) {
  const spans = new Array(height).fill(0);
  for (let row = 0; row < height; row++) {
    let first = -1;
    let last = -1;
    for (let column = 0; column < width; column++) {
      if (!mask[row * width + column]) continue;
      if (first < 0) first = column;
      last = column;
    }
    if (first >= 0) spans[row] = last - first + 1;
  }
  return spans;
}

// The share of the source box [sourceLeft, sourceRight) x [sourceTop, sourceBottom) that is opaque.
function opaqueShare(mask, width, box, limits) {
  let covered = 0;
  let opaque = 0;
  for (let row = Math.floor(box.top); row < Math.ceil(box.bottom) && row <= limits.bottom; row++) {
    const rowWeight = Math.min(row + 1, box.bottom) - Math.max(row, box.top);
    for (let column = Math.floor(box.left); column < Math.ceil(box.right) && column <= limits.right; column++) {
      const weight = rowWeight * (Math.min(column + 1, box.right) - Math.max(column, box.left));
      covered += weight;
      if (mask[row * width + column]) opaque += weight;
    }
  }
  return covered > 0 ? opaque / covered : 0;
}

/** Cuts the crown out of a tree mask (the trunk below it is dropped) and rescales it to `CROWN_MASK_HEIGHT` rows. Returns `{ mask, width, height }`. */
export function normaliseCrownMask(mask, width, height) {
  requireMask(mask, width, height);
  const spans = rowSpans(mask, width, height);
  const widest = Math.max(...spans);
  if (widest === 0) throw new RangeError('mask has no opaque pixel; pass a mask where the crown is nonzero');
  const top = spans.findIndex(span => span > 0);
  let bottom = height - 1;
  while (spans[bottom] < widest * CROWN_BASE_SPAN_SHARE) bottom--;
  let left = width;
  let right = -1;
  for (let row = top; row <= bottom; row++) {
    for (let column = 0; column < width; column++) {
      if (!mask[row * width + column]) continue;
      left = Math.min(left, column);
      right = Math.max(right, column);
    }
  }
  const scale = CROWN_MASK_HEIGHT / (bottom - top + 1);
  const outputWidth = Math.max(1, Math.round((right - left + 1) * scale));
  const output = new Uint8Array(outputWidth * CROWN_MASK_HEIGHT);
  for (let outputRow = 0; outputRow < CROWN_MASK_HEIGHT; outputRow++) {
    for (let outputColumn = 0; outputColumn < outputWidth; outputColumn++) {
      const box = { top: top + outputRow / scale, bottom: top + (outputRow + 1) / scale, left: left + outputColumn / scale, right: left + (outputColumn + 1) / scale };
      output[outputRow * outputWidth + outputColumn] = opaqueShare(mask, width, box, { bottom, right }) >= 0.5 ? 1 : 0;
    }
  }
  return { mask: output, width: outputWidth, height: CROWN_MASK_HEIGHT };
}

function convexHull(points) {
  const sorted = [...points].sort((first, second) => first[0] - second[0] || first[1] - second[1]);
  const cross = (origin, first, second) => (first[0] - origin[0]) * (second[1] - origin[1]) - (first[1] - origin[1]) * (second[0] - origin[0]);
  const chainOf = (list) => {
    const chain = [];
    for (const point of list) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], point) <= 0) chain.pop();
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...chainOf(sorted), ...chainOf([...sorted].reverse())];
}

// Marks the pixel centers inside the convex polygon.
function rasterHull(hull, width, height) {
  const inside = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const y = row + 0.5;
    let low = Infinity;
    let high = -Infinity;
    for (let index = 0; index < hull.length; index++) {
      const [x1, y1] = hull[index];
      const [x2, y2] = hull[(index + 1) % hull.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        const x = x1 + (y - y1) / (y2 - y1) * (x2 - x1);
        low = Math.min(low, x);
        high = Math.max(high, x);
      }
    }
    for (let column = 0; column < width; column++) {
      if (column + 0.5 >= low && column + 0.5 <= high) inside[row * width + column] = 1;
    }
  }
  return inside;
}

// The empty pixels connected to `seeds` through empty pixels. Returns `{ reached, size }`.
function floodEmpty(mask, width, height, seeds) {
  const reached = new Uint8Array(width * height);
  const queue = [];
  for (const seed of seeds) {
    if (!mask[seed] && !reached[seed]) {
      reached[seed] = 1;
      queue.push(seed);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const column = queue[head] % width;
    const row = (queue[head] - column) / width;
    for (const [stepColumn, stepRow] of FOUR_NEIGHBOURS) {
      const nextColumn = column + stepColumn;
      const nextRow = row + stepRow;
      if (nextColumn < 0 || nextRow < 0 || nextColumn >= width || nextRow >= height) continue;
      const next = nextRow * width + nextColumn;
      if (mask[next] || reached[next]) continue;
      reached[next] = 1;
      queue.push(next);
    }
  }
  return { reached, size: queue.length };
}

function largestEnclosedHole(mask, width, height, openToSky) {
  let largest = 0;
  const visited = new Uint8Array(width * height);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (mask[pixel] || openToSky[pixel] || visited[pixel]) continue;
    const { reached, size } = floodEmpty(mask, width, height, [pixel]);
    for (let index = 0; index < reached.length; index++) if (reached[index]) visited[index] = 1;
    largest = Math.max(largest, size);
  }
  return largest;
}

// The pixel centers inside the convex polygon and at least `inset` pixels from every edge of it.
function insetHull(hull, width, height, inset) {
  const inside = new Uint8Array(width * height);
  if (hull.length < 3) return inside;
  const edges = hull.map(([x1, y1], index) => {
    const [x2, y2] = hull[(index + 1) % hull.length];
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    return { x1, y1, normalX: (y2 - y1) / length, normalY: -(x2 - x1) / length };
  });
  // The hull is counter-clockwise in a y-down picture or clockwise in a y-up one; pick the sign that puts the centroid inside.
  const centerX = hull.reduce((total, point) => total + point[0], 0) / hull.length;
  const centerY = hull.reduce((total, point) => total + point[1], 0) / hull.length;
  const sign = edges.every(edge => (centerX - edge.x1) * edge.normalX + (centerY - edge.y1) * edge.normalY >= 0) ? 1 : -1;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      let nearest = Infinity;
      for (const edge of edges) nearest = Math.min(nearest, sign * ((column + 0.5 - edge.x1) * edge.normalX + (row + 0.5 - edge.y1) * edge.normalY));
      if (nearest >= inset) inside[row * width + column] = 1;
    }
  }
  return inside;
}

// Interior light: the largest connected empty patch (side over `crownHeight`) and the empty share, both inside `inner`.
function interiorLight(crown, inner, width, height) {
  let innerPixels = 0;
  let emptyPixels = 0;
  let largest = 0;
  const visited = new Uint8Array(width * height);
  for (let pixel = 0; pixel < crown.length; pixel++) {
    if (!inner[pixel]) continue;
    innerPixels++;
    if (crown[pixel]) continue;
    emptyPixels++;
    if (visited[pixel]) continue;
    const queue = [pixel];
    visited[pixel] = 1;
    for (let head = 0; head < queue.length; head++) {
      const column = queue[head] % width;
      const row = (queue[head] - column) / width;
      for (const [stepColumn, stepRow] of FOUR_NEIGHBOURS) {
        const nextColumn = column + stepColumn;
        const nextRow = row + stepRow;
        if (nextColumn < 0 || nextRow < 0 || nextColumn >= width || nextRow >= height) continue;
        const next = nextRow * width + nextColumn;
        if (!inner[next] || crown[next] || visited[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
    largest = Math.max(largest, queue.length);
  }
  return { interiorHole: Math.sqrt(largest) / height, interiorOpen: innerPixels > 0 ? emptyPixels / innerPixels : 0 };
}

function widestRowHeight(spans) {
  const reach = WIDEST_ROW_SMOOTHING >> 1;
  const smoothed = spans.map((_, row) => {
    const near = spans.slice(Math.max(0, row - reach), row + reach + 1);
    return near.reduce((total, span) => total + span, 0) / near.length;
  });
  const widest = Math.max(...smoothed);
  const rows = smoothed.flatMap((span, row) => span >= widest * WIDEST_ROW_TOLERANCE ? [row] : []);
  const center = rows.reduce((total, row) => total + row, 0) / rows.length + 0.5;
  return 1 - center / spans.length;
}

/**
 * The crown metrics of a mask, normalised first (see the block comment above). `mask` has one entry per pixel, nonzero
 * where the crown is opaque. Returns an object with every name in CROWN_METRIC_NAMES.
 */
export function crownMetrics(mask, width, height) {
  const { mask: crown, width: crownWidth, height: crownHeight } = normaliseCrownMask(mask, width, height);
  const points = [];
  for (let row = 0; row < crownHeight; row++) {
    for (let column = 0; column < crownWidth; column++) if (crown[row * crownWidth + column]) points.push([column + 0.5, row + 0.5]);
  }
  const hull = convexHull(points);
  const insideHull = hull.length >= 3 ? rasterHull(hull, crownWidth, crownHeight) : crown;
  const borderSeeds = [];
  for (let column = 0; column < crownWidth; column++) borderSeeds.push(column, (crownHeight - 1) * crownWidth + column);
  for (let row = 0; row < crownHeight; row++) borderSeeds.push(row * crownWidth, row * crownWidth + crownWidth - 1);
  const { reached: openToSky } = floodEmpty(crown, crownWidth, crownHeight, borderSeeds);
  let hullPixels = 0;
  let bays = 0;
  for (let pixel = 0; pixel < insideHull.length; pixel++) {
    if (!insideHull[pixel]) continue;
    hullPixels++;
    if (openToSky[pixel] && !crown[pixel]) bays++;
  }
  const spans = rowSpans(crown, crownWidth, crownHeight);
  const inner = insetHull(hull, crownWidth, crownHeight, INTERIOR_INSET * crownWidth);
  return {
    ...interiorLight(crown, inner, crownWidth, crownHeight),
    hullFill: points.length / hullPixels,
    bayShare: bays / hullPixels,
    skyHole: Math.sqrt(largestEnclosedHole(crown, crownWidth, crownHeight, openToSky)) / crownHeight,
    widthOverHeight: crownWidth / crownHeight,
    widestRow: widestRowHeight(spans),
    rowSolidity: solidityFromMask(crown, crownWidth, crownHeight).solidity,
  };
}

function averageMetrics(list) {
  return Object.fromEntries(CROWN_METRIC_NAMES.map(name => [name, list.reduce((total, metrics) => total + metrics[name], 0) / list.length]));
}

/** The crown metrics of `tree` at `level`: the mean over the baked frames near the horizon (CPU baker, foliage only), each frame normalised. */
export function modelCrownMetrics(tree, level = 0, { frameSize = CROWN_MASK_HEIGHT } = {}) {
  const atlas = bakeImpostorAtlas(foliageOnly(tree), { frameSize, level });
  return averageMetrics(horizonCells().map(({ column, row }) => {
    const mask = new Uint8Array(frameSize * frameSize);
    for (let y = 0; y < frameSize; y++) {
      for (let x = 0; x < frameSize; x++) {
        mask[y * frameSize + x] = atlas.colorPixels[((row * frameSize + y) * atlas.width + column * frameSize + x) * 4 + 3] > 0 ? 1 : 0;
      }
    }
    return crownMetrics(mask, frameSize, frameSize);
  }));
}

/**
 * Marks the tree pixels of an RGB picture against the sky. A pixel is tree when it is darker than the Otsu split of the
 * picture's brightness, or clearly green or yellow (leaves lit brighter than a pale sky). Blue and grey sky stay empty.
 * Only the largest connected piece of tree is kept (pieces within 2 pixels join), so a neighbour tree cut by the crop
 * or a speck in the clouds does not count. `rgb` holds three bytes per pixel.
 */
export function segmentSky(rgb, width, height) {
  if (rgb.length !== width * height * 3) throw new RangeError(`rgb has ${rgb.length} bytes; pass width * height * 3 = ${width * height * 3}`);
  const pixelCount = width * height;
  const brightness = new Uint8Array(pixelCount);
  const histogram = new Array(256).fill(0);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    brightness[pixel] = Math.round(0.299 * rgb[pixel * 3] + 0.587 * rgb[pixel * 3 + 1] + 0.114 * rgb[pixel * 3 + 2]);
    histogram[brightness[pixel]]++;
  }
  const split = otsuSplit(histogram, pixelCount);
  const tree = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const greenOverBlue = rgb[pixel * 3 + 1] - rgb[pixel * 3 + 2];
    const redOverBlue = rgb[pixel * 3] - rgb[pixel * 3 + 2];
    tree[pixel] = brightness[pixel] < split || greenOverBlue > 10 || redOverBlue > 25 ? 1 : 0;
  }
  return keepLargestPiece(tree, width, height);
}

function otsuSplit(histogram, total) {
  const sum = histogram.reduce((accumulated, count, value) => accumulated + count * value, 0);
  let below = 0;
  let belowSum = 0;
  let bestVariance = -1;
  let split = 128;
  for (let value = 0; value < 256; value++) {
    below += histogram[value];
    belowSum += histogram[value] * value;
    if (below === 0 || below === total) continue;
    const variance = below * (total - below) * (belowSum / below - (sum - belowSum) / (total - below)) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      split = value;
    }
  }
  return split;
}

function dilate(mask, width, height, reach) {
  const joined = new Uint8Array(mask.length);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      if (!mask[row * width + column]) continue;
      for (let nearRow = Math.max(0, row - reach); nearRow <= Math.min(height - 1, row + reach); nearRow++) {
        for (let nearColumn = Math.max(0, column - reach); nearColumn <= Math.min(width - 1, column + reach); nearColumn++) joined[nearRow * width + nearColumn] = 1;
      }
    }
  }
  return joined;
}

function keepLargestPiece(mask, width, height) {
  const joined = dilate(mask, width, height, 2);
  const label = new Int32Array(mask.length).fill(-1);
  let bestLabel = -1;
  let bestSize = 0;
  let nextLabel = 0;
  for (let start = 0; start < joined.length; start++) {
    if (!joined[start] || label[start] >= 0) continue;
    const queue = [start];
    label[start] = nextLabel;
    let size = 0;
    for (let head = 0; head < queue.length; head++) {
      if (mask[queue[head]]) size++;
      const column = queue[head] % width;
      const row = (queue[head] - column) / width;
      for (const [stepColumn, stepRow] of FOUR_NEIGHBOURS) {
        const nextColumn = column + stepColumn;
        const nextRow = row + stepRow;
        if (nextColumn < 0 || nextRow < 0 || nextColumn >= width || nextRow >= height) continue;
        const next = nextRow * width + nextColumn;
        if (!joined[next] || label[next] >= 0) continue;
        label[next] = nextLabel;
        queue.push(next);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = nextLabel;
    }
    nextLabel++;
  }
  return mask.map((value, pixel) => value && label[pixel] === bestLabel ? 1 : 0);
}

export const PHOTO_WORKING_SIZE = 1024;

/**
 * The tree mask of one reference photo. `crop` is `[left, top, width, height]` as fractions of the picture, the box around
 * one whole tree. Returns `{ mask, width, height }`, ready for crownMetrics.
 */
export async function photoTreeMask(photoPath, crop = [0, 0, 1, 1]) {
  const valid = Array.isArray(crop) && crop.length === 4 && crop.every(value => value >= 0 && value <= 1) && crop[2] > 0 && crop[3] > 0 && crop[0] + crop[2] <= 1.0001 && crop[1] + crop[3] <= 1.0001;
  if (!valid) throw new RangeError('crop must be [left, top, width, height] as fractions of the photo between 0 and 1, such as [0.1, 0.05, 0.6, 0.9]');
  const upright = await sharp(photoPath).rotate().toBuffer({ resolveWithObject: true });
  const photoWidth = upright.info.width;
  const photoHeight = upright.info.height;
  const left = Math.round(crop[0] * photoWidth);
  const top = Math.round(crop[1] * photoHeight);
  const region = { left, top, width: Math.min(Math.max(1, Math.round(crop[2] * photoWidth)), photoWidth - left), height: Math.min(Math.max(1, Math.round(crop[3] * photoHeight)), photoHeight - top) };
  const { data, info } = await sharp(upright.data).extract(region).resize({ width: PHOTO_WORKING_SIZE, height: PHOTO_WORKING_SIZE, fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { mask: segmentSky(data, info.width, info.height), width: info.width, height: info.height };
}

/** Per-photo crown metrics for the species folder `<referenceFolder>/<species>`, from its credits.json (`photos: [{ file, kind, crop, licence }]`). */
export async function photoCrownMetrics(referenceFolder, species) {
  const creditsPath = join(referenceFolder, species, 'credits.json');
  if (!existsSync(creditsPath)) return [];
  const { photos } = JSON.parse(await readFile(creditsPath, 'utf8'));
  const rows = [];
  for (const photo of photos) {
    const path = join(referenceFolder, species, photo.file);
    if (!existsSync(path)) continue;
    const { mask, width, height } = await photoTreeMask(path, photo.crop);
    rows.push({ species, source: photo.file.replace(/\.jpe?g$/i, ''), file: photo.file, kind: photo.kind, licence: photo.licence, ...crownMetrics(mask, width, height) });
  }
  return rows;
}

/** The band of each banded metric over the in-leaf rows of one species: `{ name: [lowest, highest] }`, widened by `margin` of the metric's own range. */
export function photoBand(rows, margin = 0.1) {
  const leafRows = rows.filter(row => row.kind === 'leaf');
  if (leafRows.length === 0) throw new RangeError('rows has no in-leaf photo; pass rows from photoCrownMetrics with kind "leaf"');
  return Object.fromEntries(BAND_METRIC_NAMES.map((name) => {
    const values = leafRows.map(row => row[name]);
    const low = Math.min(...values);
    const high = Math.max(...values);
    return [name, [low - (high - low) * margin, high + (high - low) * margin]];
  }));
}

/** The banded metric names where `metrics` lies outside `band`. An empty list means the crown is inside the photo band. */
export function bandFailures(metrics, band) {
  return BAND_METRIC_NAMES.filter(name => !(metrics[name] >= band[name][0] && metrics[name] <= band[name][1]));
}

/** Rows of crown metrics (photo or model, each with `species`, `source` and optional `kind`) as aligned text. */
export function formatCrownTable(rows) {
  const header = ['species', 'source', 'kind', 'hull fill', 'bays', 'sky hole', 'in. hole', 'in. open', 'w/h', 'widest', 'row-span'];
  const lines = rows.map(row => [
    row.species, row.source, row.kind ?? 'leaf',
    row.hullFill.toFixed(2), row.bayShare.toFixed(2), row.skyHole.toFixed(3), row.interiorHole.toFixed(3), row.interiorOpen.toFixed(3), row.widthOverHeight.toFixed(2), row.widestRow.toFixed(2), row.rowSolidity.toFixed(2),
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...lines.map(line => line[column].length)));
  const format = cells => cells.map((cell, column) => column < 3 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])).join('  ');
  return [format(header), ...lines.map(format)].join('\n');
}

// The crown bands of the in-leaf reference photos, measured by `node scripts/tree-proof.mjs --crowns` on 2026-11-23, with the interior hole and interior light recomputed on 2026-11-24 by the same code (CC0 and
// public-domain photos from Wikimedia Commons, three per species except aspen, which has two; the photos stay out of the
// repository). Each entry is [lowest, highest] over the photos plus 10 percent of the spread. Aspen's bays and interior light were
// widened by hand because two photos agree to the hundredth. Width over height and the widest row depend on the crop box, so
// read them as rough. A model inside its band on all five metrics is as full and as open as a real tree of that species.
export const PHOTO_BANDS = Object.freeze({
  oak: Object.freeze({ hullFill: [0.76, 0.88], bayShare: [0.09, 0.19], interiorHole: [0.11, 0.17], interiorOpen: [0.07, 0.14], widthOverHeight: [1.15, 1.45], widestRow: [0.18, 0.28] }),
  ash: Object.freeze({ hullFill: [0.78, 0.85], bayShare: [0.09, 0.16], interiorHole: [0.1, 0.22], interiorOpen: [0.03, 0.22], widthOverHeight: [0.99, 2.92], widestRow: [0.11, 0.19] }),
  aspen: Object.freeze({ hullFill: [0.87, 0.91], bayShare: [0.06, 0.1], interiorHole: [0.05, 0.12], interiorOpen: [0.02, 0.06], widthOverHeight: [0.99, 1.39], widestRow: [0.18, 0.27] }),
  birch: Object.freeze({ hullFill: [0.65, 0.73], bayShare: [0.21, 0.26], interiorHole: [0.19, 0.4], interiorOpen: [0.14, 0.29], widthOverHeight: [0.63, 1.4], widestRow: [0, 0.23] }),
});
