// How a tree crown is lit as a volume (issue #2991), worked out once at build time and stored in the leaves' vertex colours and
// normals, so drawing it costs nothing more. The crown is the ellipsoid that fits the leaf sites: a wide oak and a narrow birch
// are each deep at their own centre and shallow at their own hull, where a sphere would call the oak's flat top "deep".
import { addVectors, clamp, normalized, scaleVector, subtractVectors, vectorLength } from './vegetation-geometry.js';

const WORLD_UP = [0, 1, 0];
const MINIMUM_RADIUS = 0.1;
// The semi-axis that makes the ellipsoid hold a filled ball: along one axis a ball of radius R has a root mean square of R / sqrt(5).
const ELLIPSOID_FIT = Math.sqrt(5);

/** Centre, radius (the farthest site), per-axis `radii` of the fitted ellipsoid and a `tintSalt` that seeds the clump colours. */
export function describeCrownShape(positions) {
  const center = scaleVector(positions.reduce((sum, position) => addVectors(sum, position), [0, 0, 0]), 1 / positions.length);
  const radius = Math.max(...positions.map(position => vectorLength(subtractVectors(position, center))), MINIMUM_RADIUS);
  const radii = [0, 1, 2].map((axis) => {
    const meanSquare = positions.reduce((sum, position) => sum + (position[axis] - center[axis]) ** 2, 0) / positions.length;
    return Math.max(Math.sqrt(meanSquare) * ELLIPSOID_FIT, MINIMUM_RADIUS);
  });
  return { center, radius, radii, tintSalt: saltOf(center) };
}

// A whole number from the crown centre, so one seed always gives one set of clump colours and another seed another.
function saltOf(center) {
  let salt = 0x811c9dc5;
  for (const value of center) salt = Math.imul(salt ^ Math.round(value * 1000), 16777619);
  return (salt >>> 0) % 1048576;
}

/** How deep a point sits in the crown: 0 at the centre, 1 on the fitted ellipsoid and beyond. */
export function crownDepth(crown, position) {
  const offset = subtractVectors(position, crown.center);
  const ellipsoidDistance = Math.hypot(...offset.map((value, axis) => value / crown.radii[axis]));
  return clamp(ellipsoidDistance, 0, 1);
}

/**
 * The normal a leaf is lit with: out of the ellipsoid's surface (its gradient, so a flat crown top points up and a wide
 * flank points sideways, which is what ez-tree's `roundedNormals` does on a sphere) with a lift toward the sky.
 */
export function roundedCanopyNormal(crown, position, skyLift) {
  const offset = subtractVectors(position, crown.center);
  const gradient = offset.map((value, axis) => value / (crown.radii[axis] * crown.radii[axis]));
  const outward = vectorLength(gradient) < 1e-6 ? WORLD_UP : normalized(gradient);
  return normalized(addVectors(outward, scaleVector(WORLD_UP, skyLift)));
}

const DEFAULT_SKY_LIFT = 0.35;

/**
 * How a species rounds its crown (`leaf.roundedNormals`): `blend` is how much of a card's own normal gives way to the crown's
 * (a species without one keeps the blend its card kind always had, `fallbackBlend`), `skyLift` tilts the crown's normal up.
 */
export function roundedNormalSettings(leafSpec, fallbackBlend) {
  const settings = leafSpec.roundedNormals ?? {};
  return { blend: settings.blend ?? fallbackBlend, skyLift: settings.skyLift ?? DEFAULT_SKY_LIFT };
}

// Light new growth at the branch tips, a share of the leaves at the outside of the crown (depth above `TIP_START`).
const TIP_START = 0.72;
const TIP_LIGHTEN = 0.1;
const TIP_NEW_GROWTH = [0.03, 0.02, -0.03];

/** Colour multiplier of the outermost leaves: lighter and yellower, like the young leaves at a branch tip. */
export function tipTint(depth) {
  const tip = clamp((depth - TIP_START) / (1 - TIP_START), 0, 1);
  const smooth = tip * tip * (3 - 2 * tip);
  return TIP_NEW_GROWTH.map(shift => 1 + TIP_LIGHTEN * smooth + shift * smooth);
}

// How bright the leaves are from the centre of the crown to its hull, as a multiple of the species' leaf colour. Light reaches
// the hull directly and the centre only through other leaves, so the hull is brighter than the leaf colour and the centre a good
// deal darker, and `exponent` keeps the dark part to the inside: a crown reads as a lit shell around a shaded core.
const DEFAULT_CROWN_LIGHT = Object.freeze({ core: 0.14, hull: 3.1, exponent: 5.5 });
const SKY_SIDE_GAIN = 0.12;

/** The species' crown light (`leaf.crownLight { core, hull, exponent }`), each number defaulting to the oak's. */
export function crownLightSettings(leafSpec) {
  return { ...DEFAULT_CROWN_LIGHT, ...(leafSpec.crownLight ?? {}) };
}

/** Leaf brightness at `depth` (0 centre, 1 hull) and `heightFraction` (0 bottom, 1 top of the crown). */
export function crownBrightness(light, depth, heightFraction) {
  return light.core + (light.hull - light.core) * depth ** light.exponent + SKY_SIDE_GAIN * heightFraction;
}
