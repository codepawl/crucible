// Reads FEATURES.md, the feature map that scripts/drive.mjs works from. No browser code lives here so tests can load it.

const FEATURE_HEADING = /^###\s+`([^`]+)`\s*$/;
const SECTION_HEADING = /^##\s+(.+?)\s*$/;
const FIELD_LINE = /^-\s+([A-Za-z]+):\s*(.*?)\s*$/;
const FIRST_BACKTICKED = /`([^`]+)`/;

export function parseFeatures(markdown) {
  const features = [];
  let section = '';
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const sectionMatch = line.match(SECTION_HEADING);
    if (sectionMatch && !line.startsWith('###')) {
      section = sectionMatch[1];
      current = null;
      continue;
    }
    const headingMatch = line.match(FEATURE_HEADING);
    if (headingMatch) {
      current = { id: headingMatch[1], section, fields: {} };
      features.push(current);
      continue;
    }
    const fieldMatch = line.match(FIELD_LINE);
    if (current && fieldMatch) current.fields[fieldMatch[1].toLowerCase()] = fieldMatch[2];
  }
  return features.map(toFeature);
}

function toFeature({ id, section, fields }) {
  const reachValue = fields.reach?.match(FIRST_BACKTICKED)?.[1] ?? '';
  const readyValue = fields.ready?.match(FIRST_BACKTICKED)?.[1] ?? null;
  return {
    id,
    section,
    name: fields.name ?? '',
    surface: fields.surface ?? '',
    reach: fields.reach ?? '',
    route: reachValue.startsWith('/') ? reachValue : null,
    source: fields.source ?? '',
    ready: readyValue,
    drive: fields.drive ?? '',
  };
}

export function findFeature(features, id) {
  const feature = features.find(candidate => candidate.id === id);
  if (feature) return feature;
  const similar = features.filter(candidate => candidate.id.includes(id)).map(candidate => candidate.id).slice(0, 8);
  const hint = similar.length ? ` Did you mean: ${similar.join(', ')}?` : ' Run `node scripts/drive.mjs list` to see the ids.';
  throw new Error(`No feature with id "${id}" in FEATURES.md.${hint}`);
}

export function requirePage(feature) {
  if (feature.route) return feature.route;
  throw new Error(`Feature "${feature.id}" is not a page (${feature.reach}). Pass a feature whose Reach is a route; ${feature.drive}.`);
}

export function formatFeatureList(features, surface = null) {
  const selected = surface ? features.filter(feature => feature.surface.toLowerCase() === surface.toLowerCase()) : features;
  const idWidth = Math.max(0, ...selected.map(feature => feature.id.length));
  return selected.map(feature => `${feature.id.padEnd(idWidth)}  [${feature.surface}] ${feature.reach}  ${feature.name}`).join('\n');
}

const VALUE_FLAGS = new Set(['out', 'origin', 'width', 'height', 'surface', 'settle', 'scale']);
const POSITIVE_NUMBER_FLAGS = new Set(['width', 'height', 'scale']);
const BOOLEAN_FLAGS = new Set(['no-gpu-lock', 'full-page']);

function readFlagValue(name, value) {
  if (value === undefined) throw new Error(`--${name} needs a value.`);
  if (value.startsWith('--')) {
    throw new Error(`--${name} got ${JSON.stringify(value)}, which looks like another flag. Pass a value after --${name}, for example --${name} <value>.`);
  }
  if (POSITIVE_NUMBER_FLAGS.has(name) || name === 'settle') requireNumber(name, value, POSITIVE_NUMBER_FLAGS.has(name));
  return value;
}

function requireNumber(name, value, mustBePositive) {
  const number = value.trim() === '' ? Number.NaN : Number(value);
  const valid = Number.isFinite(number) && (mustBePositive ? number > 0 : number >= 0);
  if (valid) return;
  const expectation = mustBePositive ? 'a finite number above 0' : 'a finite number of milliseconds, 0 or above';
  throw new Error(`--${name} got ${JSON.stringify(value)}. Pass ${expectation}.`);
}

export function parseCommandLine(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = rest[++index];
      flags[name] = readFlagValue(name, value);
    } else {
      throw new Error(`Unknown flag --${name}.`);
    }
  }
  return { command, positional, flags };
}
