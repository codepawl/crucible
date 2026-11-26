// Shared display-unit conversion, formatting and parsing for Studio lengths.
// Scene recipes always store lengths in metres; this module translates only at the UI boundary.

export const STUDIO_LENGTH_UNITS = Object.freeze(['m', 'cm', 'mm', 'ft', 'in']);

export const METRES_PER_LENGTH_UNIT = Object.freeze({
  m: 1,
  cm: 0.01,
  mm: 0.001,
  ft: 0.3048,
  in: 0.0254,
});

export const STUDIO_LENGTH_UNIT_LABELS = Object.freeze({
  m: 'Metres',
  cm: 'Centimetres',
  mm: 'Millimetres',
  ft: 'Feet',
  in: 'Inches',
});

const LENGTH_UNIT_ALIASES = Object.freeze({
  m: 'm',
  meter: 'm',
  meters: 'm',
  metre: 'm',
  metres: 'm',
  cm: 'cm',
  centimeter: 'cm',
  centimeters: 'cm',
  centimetre: 'cm',
  centimetres: 'cm',
  mm: 'mm',
  millimeter: 'mm',
  millimeters: 'mm',
  millimetre: 'mm',
  millimetres: 'mm',
  ft: 'ft',
  foot: 'ft',
  feet: 'ft',
  "'": 'ft',
  in: 'in',
  inch: 'in',
  inches: 'in',
  '"': 'in',
});

const NUMERIC_PREFIX_PATTERN = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(.*)$/iu;
const MAXIMUM_DISPLAYED_DECIMALS = 3;

/** Returns a supported length unit, falling back to metres when given anything unknown. */
export function resolveLengthUnit(unit) {
  return Object.hasOwn(METRES_PER_LENGTH_UNIT, unit) ? unit : 'm';
}

/** Converts a recipe length in metres into the given display unit. */
export function lengthToUnit(metres, unit = 'm') {
  return metres / METRES_PER_LENGTH_UNIT[resolveLengthUnit(unit)];
}

/** Converts a value in the given display unit back into metres for the recipe. */
export function lengthFromUnit(value, unit = 'm') {
  return value * METRES_PER_LENGTH_UNIT[resolveLengthUnit(unit)];
}

/** Formats a recipe length in metres as an unpadded number string in the active display unit. */
export function formatLengthInputValue(metres, unit = 'm', decimals = MAXIMUM_DISPLAYED_DECIMALS) {
  if (!Number.isFinite(metres)) {
    return '';
  }
  const scaled = lengthToUnit(metres, unit);
  const scale = 10 ** decimals;
  const rounded = Math.round(scaled * scale) / scale;
  return rounded === 0 ? '0' : String(rounded);
}

/** Formats a recipe length in metres with its unit suffix, used by the size readout and drag labels. */
export function formatLength(metres, unit = 'm', { signed = false, fixedDecimals = null } = {}) {
  const resolved = resolveLengthUnit(unit);
  return `${formatLengthMagnitude(metres, resolved, { signed, fixedDecimals })} ${resolved}`;
}

/** Formats a tuple of recipe lengths sharing one unit suffix, such as "0.42 × 0.90 × 0.42 m". */
export function formatLengthTuple(values, unit = 'm', separator = ' × ') {
  const resolved = resolveLengthUnit(unit);
  return `${values.map(value => formatLengthMagnitude(value, resolved)).join(separator)} ${resolved}`;
}

function formatLengthMagnitude(metres, unit, { signed = false, fixedDecimals = null } = {}) {
  const scaled = lengthToUnit(metres, unit);
  const zeroed = Math.abs(scaled) < 1e-9 ? 0 : scaled;
  const decimals = fixedDecimals ?? (Math.abs(zeroed) >= 100 ? 0 : 2);
  const sign = signed && zeroed >= 0 ? '+' : '';
  return `${sign}${zeroed.toFixed(decimals)}`;
}

/**
 * Parses typed length input into metres. A plain number uses `defaultUnit`; an explicit unit suffix (`m`, `cm`, `mm`,
 * `ft`, `in` and common long names or `'`/`"`) converts from that suffix regardless of `defaultUnit`. Unknown text gives null.
 */
export function parseLengthInput(raw, defaultUnit = 'm') {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? lengthFromUnit(raw, defaultUnit) : null;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const match = NUMERIC_PREFIX_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const suffix = match[2].trim().toLowerCase();
  if (suffix === '') {
    return lengthFromUnit(numeric, defaultUnit);
  }
  const resolvedSuffix = Object.hasOwn(LENGTH_UNIT_ALIASES, suffix) ? LENGTH_UNIT_ALIASES[suffix] : null;
  return resolvedSuffix ? lengthFromUnit(numeric, resolvedSuffix) : null;
}
