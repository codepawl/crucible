import { cameraFieldOfView } from './camera.js';
import { DEFAULT_SUN_ANGULAR_RADIUS } from './environment-shading.js';
import { BUNDLED_ENVIRONMENT_NAMES } from './look-catalog.js';
import { DEFAULT_SPECULAR_ANTI_ALIASING, MAXIMUM_SPECULAR_ANTI_ALIASING } from './lighting.js';
import { formatLengthInputValue, lengthFromUnit, lengthToUnit, parseLengthInput } from './studio-units.js';

// The properties of the camera, the sun and the lights that Studio lets a person edit, as one declarative table.
// Studio draws its property panels from these rows, so a later area (world, effects) adds rows and no panel code.
// Ranges and enums repeat the validators of agent-look.js, agent-scene.js and camera.js, which stay the authority.
//
// A row says:
//   id             the name of the field in the recipe (or of the group of fields it writes)
//   label          the short title the panel shows; the group it sits in supplies the rest ("Strength" under Sun)
//   name           the full name for a screen reader, when the label alone would repeat in another group ("Sun strength")
//   unit           the unit the control shows beside its number: °, m or mm
//   displayScale   what a recipe value is multiplied by to show it in its unit (180 / pi for a radian field)
//   displayStep    the step of a number control in the shown unit, when it is not step times displayScale
//   control        number, slider, colour, toggle, vector or sunpad
//   appliesTo      the object kinds that show the row (camera, sun, point, spot, area)
//   section        the group title the row sits under
//   read           (source, context) => the value the control shows; source is the camera, the environment or one light
//   write          (value, source, context) => the patch for that object; undefined values remove a field
//   motionProperty the name a motion track or driver uses for this field when it differs from id
//   visibleWhen    (source) => false hides the row while it has no meaning (a focal length of an orthographic camera)
//   enabledWhen    (source) => false dims the row and locks it while it stays on screen (the f-stop while depth of field is off)
//   offValue       the number a clearable row shows while it is cleared and has shown none yet
//   context        { aspect, lastValueOf(id) }: the shape of the viewport and the last number the panel showed for a row

const POSITION_LIMIT = 1e6;
const DEFAULT_SENSOR_WIDTH = 36;
const DEFAULT_LIGHT_COLOR = Object.freeze([1, 1, 1]);
const LIGHT_KINDS = Object.freeze(['point', 'spot', 'area']);
const LIGHT_KINDS_WITH_RADIUS = Object.freeze(['point', 'spot']);
const LIGHT_KINDS_WITH_DIRECTION = Object.freeze(['spot', 'area']);

export const PROPERTY_SECTIONS = Object.freeze({
  light: 'Light',
  shape: 'Shape',
  shadow: 'Shadows',
  transform: 'Transform',
  lens: 'Lens',
  depthOfField: 'Depth of field',
  sun: 'Sun',
  world: 'World',
  atmosphere: 'Fog',
  film: 'Film',
  effects: 'Effects',
  sceneShadow: 'Shadows',
  quality: 'Quality',
});

// The scene-level kinds read one record of the recipe: the environment (world, quality), the effects or the shadow.
export const PROPERTY_SCENE_KINDS = Object.freeze(['world', 'quality', 'effects', 'shadow']);
const DEFAULT_SUN_BOUNCE = 1;
// Recipe values stay as the recipe spells them; these are only the names a person reads.
const CHOICE_DISPLAY_LABELS = Object.freeze({ aces: 'ACES', agx: 'AgX', neutral: 'Neutral', standard: 'Standard' });

/** The name a choice shows: a known option's own spelling (aces is ACES), else the value with its first letter capitalised and dashes read as spaces. */
export function choiceDisplayLabel(value) {
  if (CHOICE_DISPLAY_LABELS[value]) {
    return CHOICE_DISPLAY_LABELS[value];
  }
  const spaced = String(value).replace(/[-_]+/gu, ' ');
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

const HDRI_CHOICES = Object.freeze([{ value: null, label: 'None' }, ...BUNDLED_ENVIRONMENT_NAMES.map(name => ({ value: name, label: choiceDisplayLabel(name) }))]);
const DEFAULT_F_STOP = 2.8;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const MAXIMUM_DISPLAYED_DECIMALS = 3;
const HDRI_ID_PREFIX_LENGTH = 8;

/** A number as a person reads it: at most three decimals, trailing zeros trimmed, so 0.400 shows as 0.4 and 46.3241 as 46.324. */
export function formatPropertyNumber(value) {
  if (!Number.isFinite(value)) {
    return '';
  }
  const scale = 10 ** MAXIMUM_DISPLAYED_DECIMALS;
  const rounded = Math.round(value * scale) / scale;
  return rounded === 0 ? '0' : String(rounded);
}

/** The scale from the recipe's value to the shown one: 180 / pi for a field the recipe keeps in radians, else 1. */
function displayScaleOf(field) {
  return field.displayScale ?? 1;
}

/** The value a row shows for the recipe's value, in the unit the row names (degrees for a radian field, display length unit for metres). */
export function propertyDisplayValue(field, storedValue, lengthUnit = 'm') {
  return field.unit === 'm' ? lengthToUnit(storedValue, lengthUnit) : storedValue * displayScaleOf(field);
}

/** The recipe's value for what a person typed in the row's unit; the inverse of propertyDisplayValue. */
export function propertyStoredValue(field, displayedValue, lengthUnit = 'm') {
  return field.unit === 'm' ? lengthFromUnit(displayedValue, lengthUnit) : displayedValue / displayScaleOf(field);
}

/** The range and step a number control of this row takes, in the shown unit. */
export function propertyDisplayRange(field, lengthUnit = 'm') {
  if (field.unit === 'm') {
    return {
      min: lengthToUnit(field.min, lengthUnit),
      max: lengthToUnit(field.max, lengthUnit),
      step: lengthToUnit(field.step, lengthUnit),
    };
  }
  const scale = displayScaleOf(field);
  return { min: field.min * scale, max: field.max * scale, step: field.displayStep ?? field.step * scale };
}

/** The text a row shows for its value: the number in its unit's scale, three decimals at most (the unit is drawn apart). */
export function propertyValueText(field, storedValue, lengthUnit = 'm') {
  if (field.unit === 'm') {
    return formatLengthInputValue(storedValue, lengthUnit);
  }
  return formatPropertyNumber(propertyDisplayValue(field, storedValue));
}

/** Parses what a person typed into the recipe's stored value (accepting length unit suffixes when `field.unit === 'm'`). */
export function parsePropertyInput(field, rawText, lengthUnit = 'm') {
  if (field.unit === 'm') {
    return parseLengthInput(rawText, lengthUnit);
  }
  const text = String(rawText ?? '').trim();
  if (text === '') {
    return null;
  }
  const typed = Number(text);
  return Number.isFinite(typed) ? propertyStoredValue(field, typed) : null;
}

/** The unit symbol displayed next to a row's digits. */
export function propertyUnitMark(field, lengthUnit = 'm') {
  return field.unit === 'm' ? lengthUnit : (field.unit ?? '');
}

/** The name a screen reader and a test finds a row by; it keeps the group word the short visible label drops. */
export function propertyNameOf(field) {
  return field.name ?? field.label;
}

/** What the HDRI choice shows for an id: the catalog's name when `catalogNames` knows it, else "Custom" and the id's first characters. */
export function hdriChoiceLabel(id, catalogNames = {}) {
  return catalogNames[id] ?? `Custom ${id.slice(0, HDRI_ID_PREFIX_LENGTH)}`;
}

function isPerspective(camera) {
  return camera.projection !== 'orthographic';
}

function distanceBetween(from, to) {
  return Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]);
}

/** The focal length in millimetres of a camera, read from its focal length or worked out from its field of view. */
function focalLengthOf(camera, context) {
  if (camera.focalLength !== undefined) {
    return camera.focalLength;
  }
  const sensorWidth = camera.sensorWidth ?? DEFAULT_SENSOR_WIDTH;
  const verticalFieldOfView = cameraFieldOfView(camera, context.aspect);
  return sensorWidth / context.aspect / (2 * Math.tan((verticalFieldOfView * Math.PI) / 360));
}

/** The focal length in millimetres a camera shows, whether the recipe names it or names a field of view. */
export function cameraFocalLengthMillimetres(camera, context) {
  return focalLengthOf(camera, context);
}

function lightRow(id, label, control, section, appliesTo, extra = {}) {
  return { id, label, control, section, appliesTo, ...extra };
}

const LIGHT_ROWS = [
  lightRow('color', 'Color', 'colour', 'light', LIGHT_KINDS, {
    read: light => light.color ?? DEFAULT_LIGHT_COLOR,
    write: value => ({ color: value }),
  }),
  lightRow('intensity', 'Intensity', 'number', 'light', LIGHT_KINDS, {
    min: 0, max: 1e5, step: 0.1,
    read: light => light.intensity ?? 1,
    write: value => ({ intensity: value }),
  }),
  lightRow('radius', 'Radius', 'number', 'light', LIGHT_KINDS_WITH_RADIUS, {
    unit: 'm', min: 0.001, max: 1e6, step: 0.01,
    read: light => light.radius ?? 0.05,
    write: value => ({ radius: value }),
  }),
  lightRow('range', 'Range', 'number', 'light', LIGHT_KINDS_WITH_RADIUS, {
    unit: 'm', min: 0, max: 1e6, step: 0.5,
    read: light => light.range ?? 0,
    write: value => ({ range: value }),
  }),
  lightRow('width', 'Width', 'number', 'shape', ['area'], {
    unit: 'm', min: 0.001, max: 1e4, step: 0.1,
    read: light => light.width,
    write: value => ({ width: value }),
  }),
  lightRow('height', 'Height', 'number', 'shape', ['area'], {
    unit: 'm', min: 0.001, max: 1e4, step: 0.1,
    read: light => light.height,
    write: value => ({ height: value }),
  }),
  lightRow('angle', 'Angle', 'slider', 'shape', ['spot'], {
    name: 'Angle °', unit: '°', min: 1, max: 89, step: 1,
    read: light => Math.round(((light.angle ?? Math.PI / 4) * 180) / Math.PI),
    write: value => ({ angle: (value * Math.PI) / 180 }),
  }),
  lightRow('penumbra', 'Penumbra', 'slider', 'shape', ['spot'], {
    min: 0, max: 1, step: 0.01,
    read: light => light.penumbra ?? 0.15,
    write: value => ({ penumbra: value }),
  }),
  lightRow('castShadow', 'Shadow', 'toggle', 'shadow', LIGHT_KINDS, {
    read: light => light.castShadow === true,
    write: value => ({ castShadow: value }),
  }),
  lightRow('softFalloff', 'Soft falloff', 'toggle', 'shadow', LIGHT_KINDS_WITH_RADIUS, {
    read: light => light.softFalloff === true,
    write: value => ({ softFalloff: value }),
  }),
  lightRow('portal', 'Portal', 'toggle', 'shadow', ['area'], {
    read: light => light.portal === true,
    write: value => ({ portal: value }),
  }),
  lightRow('position', 'Position', 'vector', 'transform', LIGHT_KINDS, {
    name: 'Light position',
    unit: 'm', min: -POSITION_LIMIT, max: POSITION_LIMIT, step: 0.05,
    read: light => light.position,
    write: value => ({ position: value }),
  }),
  lightRow('direction', 'Direction', 'vector', 'transform', LIGHT_KINDS_WITH_DIRECTION, {
    name: 'Light direction',
    min: -POSITION_LIMIT, max: POSITION_LIMIT, step: 0.05,
    read: light => light.direction,
    write: value => ({ direction: value }),
  }),
];

const SUN_ROWS = [
  {
    id: 'direction', label: 'Direction', name: 'Sun direction', control: 'sunpad', section: 'sun', appliesTo: ['sun'],
    read: environment => environment.lightDirection ?? [0, 1, 0],
  },
  {
    id: 'keyIntensity', label: 'Strength', name: 'Sun strength', control: 'slider', section: 'sun', appliesTo: ['sun'],
    min: 0, max: 8, step: 0.1, motionProperty: 'intensity',
    read: environment => environment.keyIntensity ?? 1.5,
    write: value => ({ keyIntensity: value }),
  },
  {
    id: 'keyColor', label: 'Color', name: 'Sun color', control: 'colour', section: 'sun', appliesTo: ['sun'],
    motionProperty: 'color',
    read: environment => environment.keyColor ?? DEFAULT_LIGHT_COLOR,
    write: value => ({ keyColor: value }),
  },
  {
    id: 'sunAngularRadius', label: 'Size', name: 'Sun size', control: 'number', section: 'sun', appliesTo: ['sun'],
    unit: '°', displayScale: RADIANS_TO_DEGREES, displayStep: 0.05, min: 0.0005, max: 0.2, step: 0.0005,
    read: environment => environment.sunAngularRadius ?? DEFAULT_SUN_ANGULAR_RADIUS,
    write: value => ({ sunAngularRadius: value }),
  },
];

const CAMERA_ROWS = [
  {
    id: 'projection', label: 'Orthographic', name: 'Ortho', control: 'toggle', section: 'lens', appliesTo: ['camera'],
    read: camera => camera.projection === 'orthographic',
    write: value => ({ projection: value ? 'orthographic' : 'perspective' }),
  },
  {
    id: 'focalLength', label: 'Focal length', name: 'Focal length mm', control: 'number', section: 'lens', appliesTo: ['camera'],
    unit: 'mm', min: 1, max: 10000, step: 1, visibleWhen: isPerspective,
    read: focalLengthOf,
    write: (value, camera) => ({ focalLength: value, sensorWidth: camera.sensorWidth ?? DEFAULT_SENSOR_WIDTH }),
  },
  {
    id: 'sensorWidth', label: 'Sensor width', name: 'Sensor width mm', control: 'number', section: 'lens', appliesTo: ['camera'],
    unit: 'mm', min: 1, max: 1000, step: 1, visibleWhen: isPerspective,
    read: camera => camera.sensorWidth ?? DEFAULT_SENSOR_WIDTH,
    write: (value, camera, context) => ({ focalLength: focalLengthOf(camera, context), sensorWidth: value }),
  },
  {
    id: 'fov', label: 'Field of view', control: 'slider', section: 'lens', appliesTo: ['camera'],
    unit: '°', min: 15, max: 110, step: 1, visibleWhen: isPerspective,
    read: (camera, context) => Math.round(cameraFieldOfView(camera, context.aspect)),
    write: value => ({ fov: value }),
  },
  {
    id: 'orthoScale', label: 'Size', name: 'Orthographic size', control: 'slider', section: 'lens', appliesTo: ['camera'],
    unit: 'm', min: 1, max: 40, step: 0.5, visibleWhen: camera => !isPerspective(camera),
    read: camera => camera.orthoScale ?? 6,
    write: value => ({ projection: 'orthographic', orthoScale: value }),
  },
  {
    id: 'near', label: 'Clip start', control: 'number', section: 'lens', appliesTo: ['camera'],
    unit: 'm', min: 0.0001, max: 1e6, step: 0.01,
    read: camera => camera.near ?? 0.1,
    write: value => ({ near: value }),
  },
  {
    id: 'far', label: 'Clip end', control: 'number', section: 'lens', appliesTo: ['camera'],
    unit: 'm', min: 0.001, max: 1e7, step: 1,
    read: camera => camera.far ?? 1000,
    write: value => ({ far: value }),
  },
  {
    id: 'shift', label: 'Shift', control: 'vector', section: 'lens', appliesTo: ['camera'],
    axes: 2, min: -1, max: 1, step: 0.01,
    read: camera => camera.shift ?? [0, 0],
    write: value => ({ shift: value }),
  },
  {
    // Off clears the f-stop and the focus distance together, as an emptied f-stop field always did; on writes the last f-stop shown, else the default.
    id: 'depthOfFieldOn', label: 'Depth of field', control: 'toggle', section: 'depthOfField', appliesTo: ['camera'],
    read: camera => camera.fStop !== undefined,
    write: (value, camera, context) => (value ? { fStop: context?.lastValueOf?.('fStop') ?? DEFAULT_F_STOP } : { fStop: undefined, focusDistance: undefined }),
  },
  {
    id: 'fStop', label: 'F-stop', control: 'number', section: 'depthOfField', appliesTo: ['camera'],
    min: 0.7, max: 64, step: 0.1, clearable: true, offValue: DEFAULT_F_STOP,
    enabledWhen: camera => camera.fStop !== undefined,
    read: camera => camera.fStop ?? null,
    write: value => (value === null ? { fStop: undefined, focusDistance: undefined } : { fStop: value }),
  },
  {
    id: 'focusDistance', label: 'Focus distance', control: 'number', section: 'depthOfField', appliesTo: ['camera'],
    unit: 'm', min: 0.001, max: 1e6, step: 0.1, enabledWhen: camera => camera.fStop !== undefined,
    read: camera => camera.focusDistance ?? distanceBetween(camera.eye, camera.target),
    write: value => ({ focusDistance: value }),
  },
  {
    id: 'eye', label: 'Eye', control: 'vector', section: 'transform', appliesTo: ['camera'],
    unit: 'm', min: -POSITION_LIMIT, max: POSITION_LIMIT, step: 0.05,
    read: camera => camera.eye,
    write: value => ({ eye: value }),
  },
  {
    id: 'target', label: 'Target', control: 'vector', section: 'transform', appliesTo: ['camera'],
    unit: 'm', min: -POSITION_LIMIT, max: POSITION_LIMIT, step: 0.05,
    read: camera => camera.target,
    write: value => ({ target: value }),
  },
];

// A row of the environment (kind world or quality): `field` is the environment field it reads and writes.
function environmentRow(field, label, control, kind, section, extra = {}) {
  return { id: field, label, control, section, appliesTo: [kind], write: value => ({ [field]: value }), ...extra };
}

function volumeFogRow(field, label, control, extra = {}) {
  return {
    id: `volumeFog.${field}`, label, control, section: 'atmosphere', appliesTo: ['world'],
    write: value => ({ volumeFog: { [field]: value } }),
    ...extra,
  };
}

function volumeFogOf(environment) {
  return environment.volumeFog ?? {};
}

const WORLD_ROWS = [
  environmentRow('hdri', 'HDRI', 'select', 'world', 'world', {
    choices: HDRI_CHOICES, read: environment => environment.hdri ?? null, preparation: value => ({ environment: { hdri: value } }),
  }),
  environmentRow('world', 'Show sky', 'toggle', 'world', 'world', { read: environment => environment.world === true }),
  environmentRow('ground', 'Ground', 'toggle', 'world', 'world', { read: environment => environment.ground !== false }),
  environmentRow('environmentIntensity', 'Strength', 'number', 'world', 'world', {
    name: 'HDRI strength', min: 0, max: 100, step: 0.05, read: environment => environment.environmentIntensity ?? 1,
  }),
  environmentRow('environmentRotation', 'Rotation', 'number', 'world', 'world', {
    name: 'HDRI rotation', unit: '°', displayScale: RADIANS_TO_DEGREES, displayStep: 1, min: -100, max: 100, step: 0.05, read: environment => environment.environmentRotation ?? 0,
  }),
  environmentRow('skyTop', 'Sky top', 'colour', 'world', 'world', { read: environment => environment.skyTop ?? DEFAULT_LIGHT_COLOR }),
  environmentRow('skyBottom', 'Sky bottom', 'colour', 'world', 'world', { read: environment => environment.skyBottom ?? DEFAULT_LIGHT_COLOR }),
  environmentRow('daylight', 'Daylight', 'number', 'world', 'world', { min: 0, max: 100, step: 0.05, read: environment => environment.daylight ?? 1 }),
  environmentRow('fillIntensity', 'Fill', 'number', 'world', 'world', { name: 'Fill strength', min: 0, max: 100, step: 0.05, read: environment => environment.fillIntensity ?? 0 }),
  environmentRow('ambientIntensity', 'Ambient', 'number', 'world', 'world', { name: 'Ambient strength', min: 0, max: 100, step: 0.05, read: environment => environment.ambientIntensity ?? 0 }),
  environmentRow('fogDensity', 'Density', 'slider', 'world', 'atmosphere', {
    name: 'Fog density', min: 0, max: 0.1, step: 0.002, read: environment => environment.fogDensity ?? 0 }),
  environmentRow('fogColor', 'Color', 'colour', 'world', 'atmosphere', {
    name: 'Fog color', read: environment => environment.fogColor ?? DEFAULT_LIGHT_COLOR }),
  volumeFogRow('density', 'Volume density', 'number', {
    min: 0, max: 10, step: 0.01, motionProperty: 'volumeFogDensity', read: environment => volumeFogOf(environment).density ?? 0,
  }),
  volumeFogRow('color', 'Volume color', 'colour', { read: environment => volumeFogOf(environment).color ?? DEFAULT_LIGHT_COLOR }),
  volumeFogRow('anisotropy', 'Anisotropy', 'slider', { min: -0.9, max: 0.9, step: 0.05, read: environment => volumeFogOf(environment).anisotropy ?? 0.3 }),
  volumeFogRow('steps', 'Steps', 'number', { name: 'Volume steps', min: 8, max: 48, step: 1, read: environment => volumeFogOf(environment).steps ?? 16 }),
  volumeFogRow('noiseAmount', 'Noise amount', 'slider', { min: 0, max: 1, step: 0.05, read: environment => volumeFogOf(environment).noiseAmount ?? 0.5 }),
  volumeFogRow('noiseScale', 'Noise scale', 'number', { unit: 'm', min: 0.001, max: 100, step: 0.05, read: environment => volumeFogOf(environment).noiseScale ?? 0.3 }),
  volumeFogRow('maxDistance', 'Volume distance', 'number', { unit: 'm', min: 0.01, max: 1e4, step: 1, read: environment => volumeFogOf(environment).maxDistance ?? 100 }),
];

const QUALITY_ROWS = [
  environmentRow('objectReflections', 'Object reflections', 'toggle', 'quality', 'quality', { read: environment => environment.objectReflections !== false }),
  environmentRow('floorSkyTrace', 'Floor sky trace', 'toggle', 'quality', 'quality', { read: environment => environment.floorSkyTrace !== false }),
  environmentRow('resolveCoplanar', 'Resolve coplanar', 'toggle', 'quality', 'quality', {
    read: environment => environment.resolveCoplanar !== false,
    write: value => ({ resolveCoplanar: value ? 'offset' : false }),
  }),
  environmentRow('shadowCascades', 'Shadow cascades', 'number', 'quality', 'quality', { min: 0, max: 4, step: 1, read: environment => environment.shadowCascades ?? 0 }),
  environmentRow('sunBounce', 'Sun bounce', 'number', 'quality', 'quality', { min: 0, max: 100, step: 0.1, read: environment => environment.sunBounce ?? DEFAULT_SUN_BOUNCE }),
  environmentRow('specularAntiAliasing', 'Specular AA', 'number', 'quality', 'quality', {
    min: 0, max: MAXIMUM_SPECULAR_ANTI_ALIASING, step: 0.1, read: environment => environment.specularAntiAliasing ?? DEFAULT_SPECULAR_ANTI_ALIASING,
  }),
];

function effectRow(field, label, control, section, extra = {}) {
  return { id: field, label, control, section, appliesTo: ['effects'], write: value => ({ [field]: value }), ...extra };
}

// A patch replaces the depth of field and motion blur groups whole, so their rows write the group with the one field changed.
function effectGroupRow(group, field, label, control, extra = {}) {
  return {
    id: `${group}.${field}`, label, control, section: 'effects', appliesTo: ['effects'],
    write: (value, effects) => ({ [group]: { ...effects[group], [field]: value } }),
    ...extra,
  };
}

const EFFECT_ROWS = [
  effectRow('exposure', 'Exposure', 'slider', 'film', { min: 0.2, max: 3, step: 0.05, read: effects => effects.exposure ?? 1 }),
  effectRow('contrast', 'Contrast', 'slider', 'film', { min: 0.4, max: 1.8, step: 0.02, read: effects => effects.contrast ?? 1 }),
  effectRow('saturation', 'Saturation', 'slider', 'film', { min: 0, max: 2, step: 0.02, read: effects => effects.saturation ?? 1 }),
  effectRow('temperature', 'Temperature', 'slider', 'film', { min: -1, max: 1, step: 0.01, read: effects => effects.temperature ?? 0 }),
  effectRow('vignette', 'Vignette', 'slider', 'film', { min: 0, max: 1, step: 0.01, read: effects => effects.vignette ?? 0 }),
  effectRow('grain', 'Grain', 'slider', 'film', { min: 0, max: 0.1, step: 0.002, read: effects => effects.grain ?? 0 }),
  effectRow('ambientOcclusion', 'Ambient occlusion', 'slider', 'effects', { min: 0, max: 1, step: 0.02, read: effects => effects.ambientOcclusion ?? 0 }),
  effectRow('ambientOcclusionRadius', 'AO radius', 'number', 'effects', { unit: 'm', min: 0.01, max: 100, step: 0.05, read: effects => effects.ambientOcclusionRadius ?? 0.5 }),
  effectGroupRow('bloom', 'strength', 'Bloom', 'slider', { min: 0, max: 8, step: 0.02, read: effects => effects.bloom?.strength ?? 0 }),
  effectGroupRow('bloom', 'threshold', 'Bloom threshold', 'number', { min: 0, max: 10, step: 0.05, read: effects => effects.bloom?.threshold ?? 1 }),
  effectGroupRow('bloom', 'radius', 'Bloom radius', 'number', { min: 0.1, max: 16, step: 0.05, read: effects => effects.bloom?.radius ?? 1 }),
  effectGroupRow('depthOfField', 'blur', 'DoF blur', 'slider', { min: 0, max: 1, step: 0.02, read: effects => effects.depthOfField?.blur ?? 0 }),
  effectGroupRow('depthOfField', 'focusDistance', 'DoF focus', 'number', {
    unit: 'm', min: 0.01, max: 1e5, step: 0.1, motionProperty: 'focusDistance', read: effects => effects.depthOfField?.focusDistance ?? 5,
  }),
  effectGroupRow('motionBlur', 'shutter', 'Shutter', 'slider', { min: 0, max: 0.5, step: 0.01, read: effects => effects.motionBlur?.shutter ?? 0 }),
  effectGroupRow('motionBlur', 'objects', 'Object blur', 'slider', { min: 0, max: 1, step: 0.02, read: effects => effects.motionBlur?.objects ?? 0 }),
];

function shadowRow(field, label, control, extra = {}) {
  return { id: field, label, control, section: 'sceneShadow', appliesTo: ['shadow'], write: value => ({ [field]: value }), ...extra };
}

const SHADOW_ROWS = [
  shadowRow('target', 'Target', 'vector', { name: 'Shadow target', unit: 'm', min: -POSITION_LIMIT, max: POSITION_LIMIT, step: 0.05, read: shadow => shadow.target ?? [0, 1, 0] }),
  shadowRow('extent', 'Extent', 'number', { name: 'Shadow extent', unit: 'm', min: 0.01, max: 1e5, step: 0.1, read: shadow => shadow.extent ?? 3.5 }),
  shadowRow('distance', 'Distance', 'number', { name: 'Shadow distance', unit: 'm', min: 0.01, max: 1e6, step: 0.1, read: shadow => shadow.distance ?? 8 }),
  shadowRow('near', 'Clip start', 'number', { name: 'Shadow clip start', unit: 'm', min: 0.001, max: 1e6, step: 0.01, read: shadow => shadow.near ?? 0.1 }),
  shadowRow('far', 'Clip end', 'number', { name: 'Shadow clip end', unit: 'm', min: 0.001, max: 1e6, step: 0.5, read: shadow => shadow.far ?? 15 }),
];

export const PROPERTY_FIELDS = Object.freeze([
  ...CAMERA_ROWS, ...SUN_ROWS, ...LIGHT_ROWS, ...WORLD_ROWS, ...EFFECT_ROWS, ...QUALITY_ROWS, ...SHADOW_ROWS,
].map(row => Object.freeze(row)));

/** The rows that apply to one kind of scene object, in the order the panel shows them. */
export function propertyFieldsFor(kind) {
  return PROPERTY_FIELDS.filter(field => field.appliesTo.includes(kind));
}

/** The rows of a kind grouped under their section titles, in panel order. */
export function propertySectionsFor(kind) {
  const sections = [];
  for (const field of propertyFieldsFor(kind)) {
    const title = PROPERTY_SECTIONS[field.section];
    let section = sections.find(candidate => candidate.title === title);
    if (!section) {
      section = { id: field.section, title, fields: [] };
      sections.push(section);
    }
    section.fields.push(field);
  }
  return sections;
}

/** The name a motion track or driver gives this field. */
export function motionPropertyOf(field) {
  return field.motionProperty ?? field.id;
}

/** Whether a row can be edited now: a row that names `enabledWhen` stays on screen, dimmed, while its condition fails. */
export function propertyIsEnabled(field, source) {
  return field.enabledWhen ? field.enabledWhen(source) : true;
}

export function propertyIsVisible(field, source) {
  return field.visibleWhen ? field.visibleWhen(source) : true;
}

export const MIXED_PROPERTY_LABEL = 'Mixed';

/** Summarizes a list of field values across a selection as `{ value, mixed }`. */
export function summarizeSharedPropertyValues(values, isEqual = Object.is) {
  if (!Array.isArray(values) || values.length === 0) {
    return { value: undefined, mixed: false };
  }
  const first = values[0];
  const mixed = values.slice(1).some(candidate => !isEqual(first, candidate));
  return { value: first, mixed };
}
