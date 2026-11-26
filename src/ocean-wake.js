// A wake on the ocean: a bounded trail of points behind a moving hull. Each point is [x, z, strength, width] in the sea's
// horizontal plane. Where a point reaches a vertex it raises the `foam` group to lace and adds a small, choppy
// displacement, so the churned water behind the boat is rough and white and never an ironed-flat patch. The trail is a pure
// function of the points, so the same hull path gives the same vertices on every run.

export const MAX_WAKE_POINTS = 64;
export const WAKE_FOAM_REACH = 1.5;

const DEFAULT_WAKE_HEIGHT = 0.06;
const MAXIMUM_WAKE_HEIGHT = 2;
const MAXIMUM_WAKE_WIDTH = 1000;
const REFERENCE_SPEED = 3;
// The trail starts this fraction of `width` wide at the stern and spreads by this multiple of `width` over its life: a V that opens.
const STERN_WIDTH_FRACTION = 0.5;
const SPREAD_PER_LIFETIME = 1.5;
// The water shader draws foam where the group is above 0.5, as lace whose holes close as the group rises, so a wake writes
// 0.5 + 0.5 * mask. The mask is capped at 0.6 (a group value of 0.8): lace with the sea showing through, never opaque white.
// The mask follows strength, so the trail breaks up and thins out along its length.
const FOAM_MASK_CAP = 0.6;
const FOAM_GAIN = 1.1;
const MINIMUM_STRENGTH = 0.01;
// Radians per metre of the churn swells: a wavelength of 5 m, more than eleven cells of the 0.44 m sea mesh of the boat recipe.
const CHURN_FREQUENCY = 2 * Math.PI / 5;

function describe(value) {
  return Array.isArray(value) ? `an array of ${value.length}` : value === null ? 'null' : typeof value;
}

/**
 * Validate the `wake` field of an ocean node: `points` (up to 64 of [x, z, strength, width]; strength 0 to 1 and width in
 * metres) and `height`, the largest choppy displacement the wake adds in metres (0 to 2, default 0.06).
 */
export function normalizeWake(input, label = 'wake') {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object like { points: [[0, 0, 1, 1.2]] }, got ${describe(input)}`);
  }
  for (const key of Object.keys(input)) {
    if (key !== 'points' && key !== 'height') throw new TypeError(`${label}.${key} is unsupported; use points or height`);
  }
  const points = input.points ?? [];
  if (!Array.isArray(points) || points.length > MAX_WAKE_POINTS) {
    throw new RangeError(`${label}.points must be an array of at most ${MAX_WAKE_POINTS} points [x, z, strength, width], such as [[0, 0, 1, 1.2]], got ${describe(points)}`);
  }
  const height = input.height ?? DEFAULT_WAKE_HEIGHT;
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 0 || height > MAXIMUM_WAKE_HEIGHT) {
    throw new RangeError(`${label}.height must be a number from 0 to ${MAXIMUM_WAKE_HEIGHT}, such as ${DEFAULT_WAKE_HEIGHT}`);
  }
  const checked = [];
  for (let index = 0; index < points.length; index++) {
    checked.push(checkedPoint(points, index, label));
  }
  return { points: checked, height };
}

const POINT_SHAPE = '[x, z, strength, width], such as [0, 0, 1, 1.2]';

function checkedPoint(points, index, label) {
  const point = points[index];
  const name = `${label}.points[${index}]`;
  const isFilled = Array.isArray(point) && point.length === 4 && [0, 1, 2, 3].every(position => position in point);
  if (!isFilled || !Array.from(point).every(Number.isFinite)) throw new RangeError(`${name} must be four finite numbers ${POINT_SHAPE}`);
  const [, , strength, width] = point;
  if (strength < 0 || strength > 1) throw new RangeError(`${name} strength must be from 0 to 1, got ${strength}; the point is ${POINT_SHAPE}`);
  if (width <= 0 || width > MAXIMUM_WAKE_WIDTH) throw new RangeError(`${name} width must be above 0 and at most ${MAXIMUM_WAKE_WIDTH} metres, got ${width}; the point is ${POINT_SHAPE}`);
  return point.slice();
}

/**
 * A repeatable value from -1 to 1 for one horizontal position: the same position always gives the same churn. It is two
 * crossing swells about 5 m long, not a hash per position: a hash gave neighbouring sea vertices unrelated heights, so the
 * surface normal the water shader aligns its foam lace to turned at random from one vertex to the next and the wake drew
 * zigzag streaks (#3070). Swells keep the normal turning slowly, so the lace runs smoothly along the trail.
 */
export function wakeChurn(positionX, positionZ) {
  const first = Math.sin(CHURN_FREQUENCY * (positionX + 0.7 * positionZ));
  const second = Math.sin(CHURN_FREQUENCY * (-0.6 * positionX + positionZ) + 1.3);
  return 0.5 * (first + second);
}

/** Foam (0 to 1) and surface offset in metres that a wake adds at one horizontal position. */
export function wakeAt(wake, positionX, positionZ) {
  let foam = 0;
  let weight = 0;
  for (const [pointX, pointZ, strength, width] of wake.points) {
    const distance = Math.hypot(positionX - pointX, positionZ - pointZ) / width;
    if (distance > WAKE_FOAM_REACH) continue;
    const reach = strength * Math.exp(-(distance ** 4));
    foam = Math.max(foam, FOAM_MASK_CAP * Math.min(1, FOAM_GAIN * reach));
    weight = Math.max(weight, reach);
  }
  return { foam: foam > 0.001 ? 0.5 + 0.5 * foam : 0, offset: weight > 0 ? wake.height * weight * wakeChurn(positionX, positionZ) : 0 };
}

const SLAM_MEMORY_LIFETIMES = 4;
// Foam under this strength is gone, so a faded burst ends instead of leaving a trace.
const SLAM_FLOOR = 0.02;
// Ripples and drift are not slams: the closing speed (m/s) and the forward speed (m/s) below these count as nothing.
const SLAM_CLOSING_DEAD_ZONE = 0.5;
const SLAM_FORWARD_DEAD_ZONE = 0.3;

/**
 * Instantaneous slam factor (0 to 1) for a hull closing speed and forward speed in m/s.
 * Below 0.5 m/s closing and 0.3 m/s forward count as ripple and drift, so a hull at rest or riding the swell makes 0.
 */
export function slamPulse({ closingSpeed, forwardSpeed, fullSpeed, fullForward }) {
  const closing = Math.min(1, Math.max(0, closingSpeed - SLAM_CLOSING_DEAD_ZONE) / fullSpeed);
  if (closing <= 0) return 0;
  const forward = Math.min(1, Math.max(0, forwardSpeed - SLAM_FORWARD_DEAD_ZONE) / fullForward);
  return closing * forward;
}

/**
 * Foam strength (0 to 1) left by hull slams at `time`. `closingSpeedAt(moment)` is how fast the hull closes on the water surface
 * under it, in m/s (0 when it is rising away). `forwardSpeedAt(moment)` is the hull's speed over the water. Closing speed above 0.5 m/s and forward speed above 0.3 m/s count (below that is ripple and drift); `fullSpeed` of closing at `fullForward` of forward speed makes full foam, each scaling it linearly, so a hull at rest makes none, and the foam fades by e every
 * `decay` seconds, so a bow that slams down bursts white and then calms, and a hull riding the swell makes none.
 */
export function slamStrength({ closingSpeedAt, forwardSpeedAt, time, decay, fullSpeed, fullForward, step }) {
  const earliest = Math.max(0, time - SLAM_MEMORY_LIFETIMES * decay);
  let strongest = 0;
  for (let moment = time; moment >= earliest; moment -= step) {
    const pulse = slamPulse({ closingSpeed: closingSpeedAt(moment), forwardSpeed: forwardSpeedAt(moment), fullSpeed, fullForward });
    const fresh = pulse * Math.exp(-(time - moment) / decay);
    strongest = Math.max(strongest, fresh);
  }
  return strongest < SLAM_FLOOR ? 0 : strongest;
}

/**
 * The wake points of a hull at `time`: the last `lifetime` seconds of its path, `count` samples (at most 64) evenly spaced.
 * `sample(time)` returns the stern as { x, z, speed }, and may answer for a time before 0 when the hull was already under way.
 * The newest point is wide and strong and older ones are wider and weaker, so the trail opens like a V and fades out. Keep
 * `lifetime` short enough that a turning hull does not cross its own trail.
 */
export function wakeTrail({ sample, time, lifetime, width, strength, count = MAX_WAKE_POINTS }) {
  const points = [];
  const total = Math.min(count, MAX_WAKE_POINTS);
  for (let index = 0; index < total; index++) {
    const age = lifetime * index / total;
    const stern = sample(time - age);
    const fade = (1 - age / lifetime) ** 2;
    const pointStrength = strength * Math.min(1, stern.speed / REFERENCE_SPEED) * fade;
    // Written so that NaN (a zero lifetime, a missing speed) is skipped too.
    if (!(pointStrength >= MINIMUM_STRENGTH)) continue;
    points.push([stern.x, stern.z, pointStrength, width * (STERN_WIDTH_FRACTION + SPREAD_PER_LIFETIME * age / lifetime)]);
  }
  return points;
}
