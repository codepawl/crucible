// A sun position from a clock time (environment.sky.clockTime). Standard solar geometry with a circular year: the declination
// follows the day of the year, the hour angle is 15 degrees per hour from solar noon, and the azimuth is a compass bearing from
// north turned clockwise seen from above. The scene's north is -Z, so `northOffset` turns that bearing for a scene whose north is
// elsewhere. It is an approximation to a fraction of a degree: no equation of time, no refraction, no longitude.

export const CLOCK_TIME_FIELDS = Object.freeze(['hours', 'latitude', 'dayOfYear', 'northOffset']);

const CLOCK_TIME_DEFAULTS = Object.freeze({ latitude: 0, dayOfYear: 80, northOffset: 0 });
const CLOCK_TIME_LIMITS = Object.freeze({
  hours: [0, 24, 'solar hours on a 24 hour clock where 12 is noon, such as 14.5'],
  latitude: [-90, 90, 'degrees north of the equator, such as 41.7'],
  dayOfYear: [1, 366, 'a day number from 1 (January 1) to 366, where 80 is the March equinox'],
  northOffset: [-360, 360, 'degrees the scene north is turned clockwise from -Z, such as 90'],
});
const AXIAL_TILT_DEGREES = 23.44;

const toRadians = degrees => degrees * Math.PI / 180;
const toDegrees = radians => radians * 180 / Math.PI;

/** Checks the clockTime fields; `fail(path, value, accepted)` builds the error. Returns the fields with their defaults. */
export function resolveClockTime(input, fail) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw fail('environment.sky.clockTime', input, `an object such as { "hours": 14.5 } with fields ${CLOCK_TIME_FIELDS.join(', ')}`);
  }
  const unknown = Object.keys(input).find(key => !CLOCK_TIME_FIELDS.includes(key));
  if (unknown !== undefined) {
    throw fail(`environment.sky.clockTime.${unknown}`, input[unknown], `one of the fields ${CLOCK_TIME_FIELDS.join(', ')}`);
  }
  const resolved = {};
  for (const [field, [minimum, maximum, example]] of Object.entries(CLOCK_TIME_LIMITS)) {
    const value = input[field] ?? CLOCK_TIME_DEFAULTS[field];
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      const required = field === 'hours' ? ' (hours is required)' : '';
      throw fail(`environment.sky.clockTime.${field}`, value, `a number from ${minimum} to ${maximum}, ${example}${required}`);
    }
    resolved[field] = value;
  }
  return resolved;
}

/** `{ sunElevation, sunRotation }` in degrees for a resolved clockTime; the rotation is in [0, 360) clockwise from -Z. */
export function sunAnglesFromClock({ hours, latitude, dayOfYear, northOffset }) {
  const declination = toRadians(AXIAL_TILT_DEGREES) * Math.sin(2 * Math.PI * (284 + dayOfYear) / 365);
  const hourAngle = toRadians(15 * (hours - 12));
  const latitudeRadians = toRadians(latitude);
  const sine = Math.sin(latitudeRadians) * Math.sin(declination) + Math.cos(latitudeRadians) * Math.cos(declination) * Math.cos(hourAngle);
  const north = Math.sin(declination) * Math.cos(latitudeRadians) - Math.cos(declination) * Math.sin(latitudeRadians) * Math.cos(hourAngle);
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const bearing = toDegrees(Math.atan2(east, north)) + northOffset;
  return { sunElevation: toDegrees(Math.asin(Math.max(-1, Math.min(1, sine)))), sunRotation: ((bearing % 360) + 360) % 360 };
}
