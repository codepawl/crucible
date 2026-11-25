// Procedural RGBA textures for vegetation: leaf sprigs with alpha, bark and grass cards.
// Pixel arrays are built in plain JavaScript so tests and Node tools can use them without a canvas.

import { FULL_TURN, clamp, createRandom, valueNoise } from './vegetation-geometry.js';

const TEXTURE_SIZE = 128;
const descriptorCache = new Map();

function createPixels(fillColor, size = TEXTURE_SIZE) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = fillColor[0];
    data[offset + 1] = fillColor[1];
    data[offset + 2] = fillColor[2];
    data[offset + 3] = 0;
  }
  return { width: size, height: size, data };
}

function compositePixel(pixels, x, y, color, coverage) {
  const offset = (y * pixels.width + x) * 4;
  const existingAlpha = pixels.data[offset + 3] / 255;
  const outputAlpha = coverage + existingAlpha * (1 - coverage);
  if (outputAlpha <= 0) return;
  for (let channel = 0; channel < 3; channel++) {
    const mixed = (color[channel] * coverage + pixels.data[offset + channel] * existingAlpha * (1 - coverage)) / outputAlpha;
    pixels.data[offset + channel] = mixed;
  }
  pixels.data[offset + 3] = outputAlpha * 255;
}

// Angle zero points up the image; the leaf grows from (baseX, baseY) along that axis.
const PLAIN_PROFILE = along => Math.sin(Math.PI * along ** 0.7);

function paintLeaf(pixels, { baseX, baseY, angle, length, width, color, shade, profile = PLAIN_PROFILE, bounds = null, midribLift = 0.2 }) {
  const axisX = Math.sin(angle);
  const axisY = -Math.cos(angle);
  const sideX = -axisY;
  const sideY = axisX;
  const reach = Math.ceil(length + width);
  const minimumY = Math.max(bounds?.minY ?? 0, Math.floor(baseY - reach));
  const maximumY = Math.min(bounds?.maxY ?? pixels.height - 1, Math.ceil(baseY + reach));
  const minimumX = Math.max(bounds?.minX ?? 0, Math.floor(baseX - reach));
  const maximumX = Math.min(bounds?.maxX ?? pixels.width - 1, Math.ceil(baseX + reach));
  for (let y = minimumY; y <= maximumY; y++) {
    for (let x = minimumX; x <= maximumX; x++) {
      const offsetX = x + 0.5 - baseX;
      const offsetY = y + 0.5 - baseY;
      const along = (offsetX * axisX + offsetY * axisY) / length;
      if (along < 0 || along > 1) continue;
      const across = offsetX * sideX + offsetY * sideY;
      const halfWidth = width / 2 * profile(along);
      const coverage = clamp(halfWidth - Math.abs(across) + 0.5, 0, 1);
      if (coverage <= 0) continue;
      const sideDistance = Math.abs(across) / (halfWidth + 1e-3);
      const midrib = Math.abs(across) < 0.7 ? midribLift : 0;
      const vein = (along * 7 + sideDistance * 0.9) % 1 < 0.1 ? -0.1 : 0;
      const brightness = shade * (0.82 + 0.3 * (1 - sideDistance) + midrib + vein);
      compositePixel(pixels, x, y, color.map(channel => channel * brightness), coverage);
    }
  }
}

function paintStem(pixels, fromX, fromY, toX, toY, color, bounds = null) {
  const steps = Math.ceil(Math.hypot(toX - fromX, toY - fromY) * 2);
  for (let step = 0; step <= steps; step++) {
    const progress = step / steps;
    const x = Math.round(fromX + (toX - fromX) * progress);
    const y = Math.round(fromY + (toY - fromY) * progress);
    if (bounds && (x < bounds.minX || x + 1 > bounds.maxX || y < bounds.minY || y > bounds.maxY)) continue;
    for (let spread = 0; spread < 2; spread++) {
      if (x + spread < pixels.width) compositePixel(pixels, x + spread, y, color, 1);
    }
  }
}

function paintSprig(pixels, color, random) {
  const stemColor = [color[0] * 0.55, color[1] * 0.5, color[2] * 0.4];
  paintStem(pixels, 64, 126, 64, 30, stemColor);
  for (let pair = 0; pair < 6; pair++) {
    const baseY = 106 - pair * 13;
    const length = 22 + 10 * Math.sin((pair + 1) / 6 * Math.PI);
    for (const side of [-1, 1]) {
      const angle = side * (1.0 + random() * 0.3);
      paintLeaf(pixels, { baseX: 64, baseY: baseY - (side > 0 ? 6 : 0), angle, length, width: length * 0.55, color, shade: 0.85 + random() * 0.3 });
    }
  }
  paintLeaf(pixels, { baseX: 64, baseY: 44, angle: 0, length: 40, width: 25, color, shade: 1.05 });
}

// Spray cards (#3041, #3057): the twig texture is a 256 px atlas of 2 x 2 spray variants, one shoot of a real species per cell. A cell is a card
// of about 0.6 m, so a pixel is about 4.7 mm: birch leaves of 3 to 7 cm are 6 to 15 px, oak leaves of 10 to 12 cm 21 to 26 px, and an ash leaf
// of 20 to 35 cm is a 43 to 75 px rachis with 7 to 13 leaflets. Sprays are painted at twice the size and boxed down, which smooths every edge.
// Sizes below are in final pixels.
export const TWIG_TEXTURE_SIZE = 256;
const SPRAY_CELL = TWIG_TEXTURE_SIZE / 2;
const SPRAY_SCALE = 2;
const SPRAY_MARGIN = 4;
export const FROND_TEXTURE_SIZE = 256;
export const PINE_TEXTURE_SIZE = 256;

const LEAF_PROFILES = {
  oak: (along, phase) => Math.sin(Math.PI * along ** 0.8) * (0.4 + 0.6 * (0.5 - 0.5 * Math.cos(2 * Math.PI * (3 * along + phase * 0.4))) ** 0.7),
  // Triangular with a sawtooth edge: six teeth along the blade.
  birch: along => (along < 0.3 ? (along / 0.3) ** 0.7 : ((1 - along) / 0.7) ** 0.9) * (0.7 + 0.3 * ((along * 6) % 1)),
  // Nearly round with a flattened base, a short pointed tip and a fine crenate edge.
  aspen: along => Math.sqrt(Math.max(0, 1 - ((along - 0.45) / 0.55) ** 2)) * Math.min(1, ((1 - along) / 0.14) ** 0.7) * (0.9 + 0.1 * Math.abs(Math.sin(along * Math.PI * 9))),
  // Lanceolate: widest a third of the way up, tapering to a point.
  ash: along => Math.sin(Math.PI * along ** 0.65) ** 1.3,
};

// Multipliers of the leaf colour: a normal leaf, now and then an old yellowing one, and a pale underside turned to the light.
const LEAF_TONES = [[1, 1, 1], [1.5, 1.05, 0.55], [1.2, 1.25, 1.3]];

function between(random, low, high) {
  return low + random() * (high - low);
}

function leafColor(random, color) {
  const roll = random();
  const tone = LEAF_TONES[roll > 0.9 ? 1 : roll < 0.2 ? 2 : 0];
  const hue = between(random, -0.08, 0.08);
  const hueTone = [1 + hue * 1.5, 1 - hue * 0.5, 1 - hue];
  return color.map((channel, index) => clamp(channel * tone[index] * hueTone[index], 0, 255));
}

function sprayBounds(cell, margin) {
  return {
    minX: (cell.x + margin) * SPRAY_SCALE, maxX: (cell.x + SPRAY_CELL - margin) * SPRAY_SCALE - 1,
    minY: (cell.y + margin) * SPRAY_SCALE, maxY: (cell.y + SPRAY_CELL - margin) * SPRAY_SCALE - 1,
  };
}

const BIRCH_MARGIN = 12;

function bezierPoint(start, control, end, progress) {
  const rest = 1 - progress;
  return [0, 1].map(axis => rest * rest * start[axis] + 2 * rest * progress * control[axis] + progress * progress * end[axis]);
}

// A short curved branch that tapers from 3 px to about 1 px, painted as discs along a quadratic curve.
function paintBough(pixels, spray, start, control, end) {
  const { bounds } = spray;
  for (let step = 0; step <= 48; step++) {
    const progress = step / 48;
    const [centerX, centerY] = bezierPoint(start, control, end, progress).map(value => Math.round(value * SPRAY_SCALE));
    const radius = (1.6 - progress) * SPRAY_SCALE;
    for (let offsetY = -Math.ceil(radius); offsetY <= radius; offsetY++) {
      for (let offsetX = -Math.ceil(radius); offsetX <= radius; offsetX++) {
        const x = centerX + offsetX;
        const y = centerY + offsetY;
        const inside = x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
        if (inside && offsetX * offsetX + offsetY * offsetY <= radius * radius) compositePixel(pixels, x, y, spray.stemColor, 1);
      }
    }
  }
}

function paintSprayStem(pixels, spray, fromX, fromY, toX, toY) {
  const [from, to] = [[fromX, fromY], [toX, toY]].map(point => point.map(value => Math.round(value * SPRAY_SCALE)));
  paintStem(pixels, ...from, ...to, spray.stemColor, spray.bounds);
  paintStem(pixels, from[0], from[1] + 1, to[0], to[1] + 1, spray.stemColor, spray.bounds);
}

// Whether a leaf's tip stays inside the cell margin; one that does not is left out, stalk and all.
function leafFits(spray, baseX, baseY, angle, leafLength, leafWidth, stalk = 0) {
  const { bounds } = spray;
  const length = (leafLength + stalk) * spray.scale;
  const tipX = (baseX + Math.sin(angle) * length) * SPRAY_SCALE;
  const tipY = (baseY - Math.cos(angle) * length) * SPRAY_SCALE;
  const reach = leafWidth * spray.scale * SPRAY_SCALE / 2;
  return tipX - reach >= bounds.minX && tipX + reach <= bounds.maxX && tipY - reach >= bounds.minY && tipY + reach <= bounds.maxY;
}

// One leaf or leaflet on a stalk of `stalk` px, painted first.
function paintSprayLeaf(pixels, spray, baseX, baseY, angle, leafLength, leafWidth, stalk = 0) {
  const { random, bounds } = spray;
  const length = leafLength * spray.scale;
  const startX = baseX + Math.sin(angle) * stalk * spray.scale;
  const startY = baseY - Math.cos(angle) * stalk * spray.scale;
  if (!leafFits(spray, baseX, baseY, angle, leafLength, leafWidth, stalk)) return;
  if (stalk > 0) paintSprayStem(pixels, spray, baseX, baseY, startX, startY);
  const phase = random();
  const profile = along => spray.profile(along, phase);
  const shade = between(random, 0.7, 1.15);
  paintLeaf(pixels, {
    baseX: startX * SPRAY_SCALE, baseY: startY * SPRAY_SCALE, angle, length: length * SPRAY_SCALE, width: leafWidth * spray.scale * SPRAY_SCALE,
    color: leafColor(random, spray.color), shade, profile, bounds, midribLift: spray.recipe?.midribLift,
  });
}

// A shoot grows from (x, y) along `angle`, bending by `curve` radians over its length. Each node carries a leaf on alternating sides (or a
// pair), on a stalk; the tip carries a cluster or a leaf of its own, and every few nodes a side shoot leaves.
function paintShoot(pixels, spray, shoot) {
  const { random, recipe } = spray;
  const { x: originX, y: originY, angle: originAngle, length, curve, depth } = shoot;
  const nodeCount = Math.max(2, Math.round(length / (recipe.nodeSpacing * spray.spacing)));
  const step = length / nodeCount;
  const paintLeavesAt = (x, y, angle, side, progress) => {
    if (progress < recipe.leavesFrom) return;
    const cluster = progress === 1 && recipe.tipCluster;
    const count = cluster ? recipe.tipCluster[0] + Math.floor(random() * (recipe.tipCluster[1] - recipe.tipCluster[0] + 1)) : recipe.pair ? 2 : 1;
    for (let leaf = 0; leaf < count; leaf++) {
      const fan = cluster ? (leaf - (count - 1) / 2) * 0.65 + between(random, -0.15, 0.15) : (count === 1 ? side : leaf ? 1 : -1) * between(random, ...recipe.leafSpread);
      const leafLength = between(random, ...recipe.leafLength) * (1 - 0.3 * progress);
      paintSprayLeaf(pixels, spray, x, y, angle + fan, leafLength, leafLength * recipe.leafWidth, between(random, ...recipe.stalk));
    }
  };
  let [x, y, angle] = [originX, originY, originAngle];
  for (let node = 1; node <= nodeCount; node++) {
    const nextX = x + Math.sin(angle) * step;
    const nextY = y - Math.cos(angle) * step;
    if (recipe.trim && !leafFits(spray, nextX, nextY, angle, recipe.trim, recipe.trim)) break;
    paintSprayStem(pixels, spray, x, y, nextX, nextY);
    [x, y] = [nextX, nextY];
    angle += curve / nodeCount;
    if (node === nodeCount) break;
    const side = node % 2 ? 1 : -1;
    paintLeavesAt(x, y, angle, side, node / nodeCount);
    if (depth > 0 && node % spray.branchEvery === 0) {
      paintShoot(pixels, spray, { x, y, angle: angle - side * between(random, 0.6, 0.9), length: length * 0.55, curve: side * 0.5, depth: depth - 1 });
    }
  }
  paintLeavesAt(x, y, angle, 1, 1);
}

// An ash leaf: a straight rachis with leaflets in strictly opposite pairs (4 to 6) and one at the tip, 9 to 13 in all. A pair is kept or
// dropped together, so the two sides never turn into an alternate arrangement.
function paintCompoundLeaf(pixels, spray, baseX, baseY, angle) {
  const { random } = spray;
  const rachis = between(random, 78, 92);
  const pairs = 4 + Math.floor(random() * 3);
  const tilt = between(random, 0.95, 1.15);
  paintSprayStem(pixels, spray, baseX, baseY, baseX + Math.sin(angle) * rachis, baseY - Math.cos(angle) * rachis);
  for (let pair = 0; pair <= pairs; pair++) {
    const progress = 0.2 + 0.8 * pair / pairs;
    const nodeX = baseX + Math.sin(angle) * rachis * progress;
    const nodeY = baseY - Math.cos(angle) * rachis * progress;
    const leafletLength = between(random, 22, 28) * (1 - 0.3 * Math.abs(progress - 0.55));
    if (pair === pairs) {
      paintSprayLeaf(pixels, spray, nodeX, nodeY, angle, leafletLength, leafletLength * 0.46);
      continue;
    }
    const sides = [-1, 1].map(side => angle + side * tilt);
    if (!sides.every(sideAngle => leafFits(spray, nodeX, nodeY, sideAngle, leafletLength, leafletLength * 0.46, 2))) continue;
    for (const sideAngle of sides) paintSprayLeaf(pixels, spray, nodeX, nodeY, sideAngle, leafletLength, leafletLength * 0.46, 2);
  }
}

const SPRAY_RECIPES = {
  oak: { leafLength: [22, 28], leafWidth: 0.72, leafSpread: [0.7, 1.1], nodeSpacing: 12, stalk: [2, 4], leavesFrom: 0.45, tipCluster: [4, 6] },
  birch: { leafLength: [8, 13], leafWidth: 0.8, leafSpread: [0.7, 1.3], nodeSpacing: 6, stalk: [1, 3], leavesFrom: 0, trim: 10 },
  aspen: { leafLength: [16, 21], leafWidth: 0.95, leafSpread: [0.55, 1.0], nodeSpacing: 6, stalk: [13, 18], leavesFrom: 0, trim: 20, midribLift: 0.5 },
};

function paintSprayCell(pixels, color, random, kind, cell) {
  const spray = {
    cell, color, random, profile: LEAF_PROFILES[kind], recipe: SPRAY_RECIPES[kind], bounds: sprayBounds(cell, kind === 'birch' ? BIRCH_MARGIN : SPRAY_MARGIN),
    stemColor: [color[0] * 0.55, color[1] * 0.5, color[2] * 0.4], scale: between(random, 0.88, 1.12), spacing: between(random, 0.85, 1.2),
    branchEvery: random() < 0.5 ? 2 : 3,
  };
  const side = random() < 0.5 ? -1 : 1;
  const baseX = cell.x + SPRAY_CELL / 2 + between(random, -6, 6);
  const baseY = cell.y + SPRAY_CELL - SPRAY_MARGIN - 1;
  if (kind === 'ash') {
    const leaves = random() < 0.25 ? 1 : 2;
    for (let leaf = 0; leaf < leaves; leaf++) {
      const angle = leaves === 1 ? between(random, -0.08, 0.08) : (leaf - 0.5) * 0.44 + between(random, -0.06, 0.06);
      paintCompoundLeaf(pixels, spray, baseX + (leaves - 1) * (leaf - 0.5) * 12, baseY, angle);
    }
    return;
  }
  if (kind === 'birch') {
    // Pendulous twigs hang from a short curved bough that enters at a top corner.
    const bough = side * between(random, 36, 44);
    const startX = side > 0 ? cell.x + BIRCH_MARGIN + 2 : cell.x + SPRAY_CELL - BIRCH_MARGIN - 2;
    const startY = cell.y + BIRCH_MARGIN + 2;
    const start = [startX, startY];
    const control = [startX + bough * 0.5, startY + between(random, 0, 4)];
    const end = [startX + bough, startY + between(random, 8, 14)];
    paintBough(pixels, spray, start, control, end);
    for (const progress of [0.25, 0.5, 0.75, 1]) {
      const [x, y] = bezierPoint(start, control, end, progress);
      paintSprayLeaf(pixels, spray, x, y, Math.PI + side * between(random, 0.3, 0.9), between(random, 9, 12), 8, 2);
    }
    for (const progress of [0.08, 0.38, 0.68, 1]) {
      const [x, y] = bezierPoint(start, control, end, progress);
      paintShoot(pixels, spray, { x, y, angle: Math.PI - side * (0.05 + 0.3 * progress + between(random, -0.1, 0.1)), length: between(random, 64, 82), curve: between(random, -0.5, 0.5), depth: 1 });
    }
    return;
  }
  if (kind === 'aspen') {
    // A few flexible twigs, each bending its own way, with a leaf on a long stalk at every node.
    for (const lean of [-0.5, -0.17, 0.17, 0.5]) {
      const x = baseX + lean * 30;
      paintShoot(pixels, spray, { x, y: baseY, angle: lean + between(random, -0.12, 0.12), length: between(random, 60, 76), curve: between(random, 0.4, 0.9) * (lean < 0 ? -1 : 1), depth: 0 });
    }
    return;
  }
  const length = between(random, 62, 78);
  paintShoot(pixels, spray, { x: baseX, y: baseY, angle: between(random, -0.2, 0.2), length, curve: between(random, -0.3, 0.3), depth: 1 });
}

function paintSprayAtlas(kind) {
  return (pixels, color, random) => {
    for (let index = 0; index < 4; index++) {
      const cell = { x: (index % 2) * SPRAY_CELL, y: Math.floor(index / 2) * SPRAY_CELL };
      paintSprayCell(pixels, color, random, kind, cell);
    }
  };
}

// Boxes the painted atlas down to its final size, weighting colour by alpha so transparent pixels do not darken the edge.
function boxDownsample(source, fillColor) {
  const size = source.width / SPRAY_SCALE;
  const target = createPixels(fillColor, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sums = [0, 0, 0, 0];
      for (let dy = 0; dy < SPRAY_SCALE; dy++) {
        for (let dx = 0; dx < SPRAY_SCALE; dx++) {
          const offset = ((y * SPRAY_SCALE + dy) * source.width + x * SPRAY_SCALE + dx) * 4;
          const alpha = source.data[offset + 3];
          for (let channel = 0; channel < 3; channel++) sums[channel] += source.data[offset + channel] * alpha;
          sums[3] += alpha;
        }
      }
      const offset = (y * size + x) * 4;
      if (sums[3] > 0) for (let channel = 0; channel < 3; channel++) target.data[offset + channel] = sums[channel] / sums[3];
      target.data[offset + 3] = sums[3] / (SPRAY_SCALE * SPRAY_SCALE);
    }
  }
  return target;
}

const ALPHA_CUTOFF = 128;

function alphaTestedShare(level) {
  let passing = 0;
  for (let offset = 3; offset < level.data.length; offset += 4) if (level.data[offset] >= ALPHA_CUTOFF) passing++;
  return passing / (level.width * level.height);
}

/**
 * The mip chain of an alpha-tested card, from level 0 down to 1 px, with each level's alpha scaled so the share of texels at or above the
 * cutoff matches level 0 (Castano, "Computing alpha mipmaps"). A plain box filter loses thin stalks and small leaves at the small levels.
 */
export function createCoverageMips(base) {
  const target = alphaTestedShare(base);
  const levels = [base];
  for (let level = base; level.width > 1;) {
    level = boxDownsample(level, base.data.slice(0, 3));
    const keep = Math.round(target * level.width * level.height);
    const alphas = Array.from({ length: level.width * level.height }, (_, index) => level.data[index * 4 + 3]).sort((first, second) => second - first);
    const threshold = keep > 0 ? alphas[keep - 1] : 0;
    if (threshold > 0) for (let offset = 3; offset < level.data.length; offset += 4) level.data[offset] = Math.min(255, level.data[offset] * ALPHA_CUTOFF / threshold);
    levels.push(level);
  }
  return levels;
}

/** Leaf texture kinds painted as a 2 x 2 atlas of spray variants. `twig` stays as the name of the oak spray. */
export const SPRAY_KINDS = ['twig', 'twig-birch', 'twig-aspen', 'twig-ash'];

function paintNeedleSpray(pixels, color, random) {
  const stemColor = [color[0] * 0.7, color[1] * 0.6, color[2] * 0.5];
  paintStem(pixels, 64, 126, 64, 6, stemColor);
  for (let step = 0; step < 24; step++) {
    const baseY = 118 - step * 4.6;
    const length = 30 - step * 0.45 + random() * 4;
    for (const side of [-1, 1]) {
      paintLeaf(pixels, { baseX: 64, baseY, angle: side * (1.0 + random() * 0.2), length, width: 3.4, color, shade: 0.85 + random() * 0.3 });
    }
  }
}

function paintBlades(pixels, color, random, count, width) {
  for (let blade = 0; blade < count; blade++) {
    const spread = count > 1 ? (blade / (count - 1) - 0.5) * 0.9 : 0;
    const length = 96 + random() * 28;
    paintLeaf(pixels, { baseX: 64 + spread * 40, baseY: 127, angle: spread + (random() - 0.5) * 0.12, length, width, color, shade: 0.8 + random() * 0.4 });
  }
}

function paintClump(pixels, color, random) {
  for (let leaf = 0; leaf < 150; leaf++) {
    const angle = random() * FULL_TURN;
    const radius = Math.sqrt(random()) * 46;
    paintLeaf(pixels, {
      baseX: 64 + Math.cos(angle) * radius,
      baseY: 64 + Math.sin(angle) * radius * 0.8,
      angle: random() * FULL_TURN,
      length: 24 + random() * 12,
      width: 16 + random() * 8,
      color,
      shade: 0.6 + random() * 0.6,
    });
  }
}

// Complete tropical pinnate palm frond on a 256 px card: slender tapering rachis and feathery pointed leaflets (#3051).
function paintFrond(pixels, color, random) {
  const stemX = FROND_TEXTURE_SIZE / 2;
  const stemColor = [color[0] * 1.15, color[1] * 1.08, color[2] * 0.72];
  paintStem(pixels, stemX - 1, FROND_TEXTURE_SIZE - 1, stemX - 1, 14, stemColor);
  paintStem(pixels, stemX, FROND_TEXTURE_SIZE - 1, stemX, 120, stemColor);
  const pairs = 32;
  for (let pair = 0; pair < pairs; pair++) {
    const progress = 0.08 + (pair / (pairs - 1)) * 0.86;
    const baseY = FROND_TEXTURE_SIZE - 1 - progress * (FROND_TEXTURE_SIZE - 16);
    const envelope = Math.sin(Math.PI * Math.pow(clamp((progress - 0.05) / 0.93, 0, 1), 0.7));
    const width = 5.6 + 3.0 * envelope;
    for (const side of [-1, 1]) {
      const angle = side * (1.34 - 0.92 * Math.pow(progress, 1.15) + (random() - 0.5) * 0.12);
      const rawLength = (22 + 94 * envelope) * (0.92 + random() * 0.16);
      const maxTop = (baseY - 4) / Math.max(0.15, Math.cos(Math.abs(angle)));
      const length = Math.min(rawLength, maxTop);
      const shade = 0.78 + 0.34 * envelope + (random() - 0.5) * 0.22;
      paintLeaf(pixels, { baseX: stemX, baseY: baseY - (side > 0 ? 1.5 : 0), angle, length, width, color, shade });
    }
  }
  for (const offset of [-0.18, 0, 0.18]) {
    paintLeaf(pixels, { baseX: stemX, baseY: 24, angle: offset, length: 16 + random() * 4, width: 4.5, color, shade: 0.92 + random() * 0.16 });
  }
}

// Tufted Scots pine foliage cluster on a 256 px card: reddish-brown woody shoots and bristling needle rosettes (#3051).
const PINE_TUFT_SPACING = 22;
const PINE_ENVELOPE_RADIUS = PINE_TEXTURE_SIZE * 0.5 - 24;
const PINE_ENVELOPE_RAGGEDNESS = 16;

function paintPineCluster(pixels, color, random) {
  const baseX = PINE_TEXTURE_SIZE / 2;
  const baseY = PINE_TEXTURE_SIZE - 2;
  const center = PINE_TEXTURE_SIZE / 2;
  const twigColor = [122, 82, 54];
  const stemCount = 6;
  for (let stem = 0; stem < stemCount; stem++) {
    const spread = (stem / (stemCount - 1) - 0.5) * 1.45;
    const reach = 82 + random() * 44;
    paintStem(pixels, baseX, baseY, baseX + Math.sin(spread) * reach, baseY - Math.cos(spread) * reach, twigColor);
  }
  const tufts = [];
  for (let y = PINE_TUFT_SPACING / 2; y < PINE_TEXTURE_SIZE; y += PINE_TUFT_SPACING) {
    for (let x = PINE_TUFT_SPACING / 2; x < PINE_TEXTURE_SIZE; x += PINE_TUFT_SPACING) {
      const tx = x + (random() - 0.5) * PINE_TUFT_SPACING * 0.75;
      const ty = y + (random() - 0.5) * PINE_TUFT_SPACING * 0.75;
      const limit = PINE_ENVELOPE_RADIUS + (random() - 0.5) * 2 * PINE_ENVELOPE_RAGGEDNESS;
      if (Math.hypot(tx - center, ty - center) <= limit) tufts.push({ x: tx, y: ty, order: random() });
    }
  }
  tufts.sort((first, second) => first.order - second.order);
  for (const tuft of tufts) {
    const needles = 13 + Math.floor(random() * 3);
    const outward = Math.atan2(tuft.x - baseX, baseY - tuft.y);
    const radialFraction = Math.hypot(tuft.x - center, tuft.y - center) / PINE_ENVELOPE_RADIUS;
    const tuftShade = 0.72 + 0.36 * radialFraction + (random() - 0.5) * 0.14;
    for (let index = 0; index < needles; index++) {
      const baseAngle = (index / needles) * FULL_TURN + (random() - 0.5) * 0.4;
      const angle = baseAngle + Math.sin(outward - baseAngle) * 0.2;
      const length = 18 + random() * 12;
      const width = 3.2 + random() * 0.9;
      paintLeaf(pixels, { baseX: tuft.x, baseY: tuft.y, angle, length, width, color, shade: tuftShade * (0.9 + random() * 0.2) });
    }
  }
}

function bleedColorIntoTransparentPixels(pixels, color) {
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    if (pixels.data[offset + 3] > 0) continue;
    pixels.data[offset] = color[0] * 0.8;
    pixels.data[offset + 1] = color[1] * 0.8;
    pixels.data[offset + 2] = color[2] * 0.8;
  }
}

const LEAF_PAINTERS = {
  sprig: paintSprig,
  twig: paintSprayAtlas('oak'),
  'twig-birch': paintSprayAtlas('birch'),
  'twig-aspen': paintSprayAtlas('aspen'),
  'twig-ash': paintSprayAtlas('ash'),
  needles: paintNeedleSpray,
  pine: paintPineCluster,
  frond: paintFrond,
  single: (pixels, color, random) => paintBlades(pixels, color, random, 1, 38),
  grass: (pixels, color, random) => paintBlades(pixels, color, random, 9, 7),
  clump: paintClump,
};

/** RGBA leaf texture: the stem base sits at the bottom edge, transparent elsewhere. */
export function createLeafPixels(kind, color, seed = 1) {
  const painter = Object.hasOwn(LEAF_PAINTERS, kind) ? LEAF_PAINTERS[kind] : null;
  if (!painter) throw new RangeError(`Unknown leaf texture kind: ${kind}`);
  const isSpray = SPRAY_KINDS.includes(kind);
  const size = isSpray ? TWIG_TEXTURE_SIZE * SPRAY_SCALE : kind === 'frond' ? FROND_TEXTURE_SIZE : kind === 'pine' ? PINE_TEXTURE_SIZE : TEXTURE_SIZE;
  const painted = createPixels(color, size);
  painter(painted, color, createRandom(seed));
  const pixels = isSpray ? boxDownsample(painted, color) : painted;
  bleedColorIntoTransparentPixels(pixels, color);
  return pixels;
}

const BARK_STYLES = {
  rough: { base: [168, 142, 118], crevice: 0.28, stretch: 2 },
  birch: { base: [238, 235, 224], crevice: 0.12, stretch: 2 },
};

/** Opaque, tileable bark luminance texture with vertical furrows (rough) or dark lenticels (birch). */
export function createBarkPixels(kind, seed = 1) {
  const style = Object.hasOwn(BARK_STYLES, kind) ? BARK_STYLES[kind] : null;
  if (!style) throw new RangeError(`Unknown bark texture kind: ${kind}`);
  const pixels = createPixels(style.base);
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const unitX = x / TEXTURE_SIZE;
      const unitY = y / TEXTURE_SIZE;
      const furrow = valueNoise(unitX * 8, unitY * style.stretch, seed, 8, style.stretch);
      const fine = valueNoise(unitX * 24, unitY * 12, seed + 5, 24, 12);
      let brightness = 1 - style.crevice + style.crevice * (0.65 * furrow + 0.35 * fine) * 1.6;
      if (kind === 'birch') {
        const mark = valueNoise(unitX * 6, unitY * 40, seed + 9, 6, 40);
        if (mark > 0.7) brightness *= 0.28 + (1 - mark) * 1.6;
      } else {
        brightness *= 0.55 + 0.9 * furrow ** 1.4;
      }
      const offset = (y * TEXTURE_SIZE + x) * 4;
      for (let channel = 0; channel < 3; channel++) pixels.data[offset + channel] = clamp(style.base[channel] * brightness, 0, 255);
      pixels.data[offset + 3] = 255;
    }
  }
  return pixels;
}

/**
 * Texture descriptor for `material.map`. Descriptors are cached per key so every tree of
 * a species shares one GPU texture. In the browser the pixels become an ImageData.
 */
export function createTextureDescriptor(cacheKey, createPixelsForKey, { repeat }) {
  if (descriptorCache.has(cacheKey)) return descriptorCache.get(cacheKey);
  const pixels = createPixelsForKey();
  const image = typeof ImageData === 'undefined' ? pixels : new ImageData(pixels.data, pixels.width, pixels.height);
  const wrap = repeat ? 10497 : 33071;
  const descriptor = { image, colorSpace: 'srgb', wrapS: wrap, wrapT: wrap, minFilter: 9987, magFilter: 9729 };
  descriptorCache.set(cacheKey, descriptor);
  return descriptor;
}

export function leafTextureDescriptor(kind, color) {
  let pixels = null;
  const descriptor = createTextureDescriptor(`leaf:${kind}:${color.join(',')}`, () => (pixels = createLeafPixels(kind, color)), { repeat: false });
  if (pixels && SPRAY_KINDS.includes(kind)) descriptor.mipLevels = createCoverageMips(pixels).slice(1);
  return descriptor;
}

export function barkTextureDescriptor(kind) {
  return createTextureDescriptor(`bark:${kind}`, () => createBarkPixels(kind), { repeat: true });
}
