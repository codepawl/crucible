// Imports Roblox-style scenes exported from Roblox Studio (the XML place and model files, .rbxlx and .rbxmx) into a Crucible scene recipe.
//   importRoblox(xmlText, options)  XML text -> { recipe, warnings, ignored, assets, stats }
// It imports no Crucible module and no dependency, reads no file and never touches the network: meshes and textures that a part
// names by asset id are looked up in `options.assets`, a table the caller built from a local folder (see node.mjs).
// Units: 1 stud = 0.28 m. Roblox and Crucible are both right-handed with Y up and a camera that looks down its local -Z, so an
// axis needs no flip. The camera field of view is vertical in both.

export const STUD_METERS = 0.28;

const DEFAULT_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxParts: 20000, maxItems: 200000, maxDepth: 128 });
const HARD_LIMITS = Object.freeze({ maxBytes: 256 * 1024 * 1024, maxParts: 100000, maxItems: 1000000, maxDepth: 512 });
const MAX_PART_STUDS = 100000;
const ROTATION_TOLERANCE = 1e-3;
const CAMERA_TARGET_METERS = 10;
const CAMERA_NEAR_METERS = 0.05;
const CAMERA_FAR_METERS = 2000;
const DECIMALS = 1e7;
const CYLINDER_SEGMENTS = 48;
const SPHERE_SEGMENTS = 48;
const SPHERE_RINGS = 24;

// Crucible limits that the renderer enforces; lights past them are dropped with a warning.
const MAX_POINT_LIGHTS = 16;
const MAX_SPOT_LIGHTS = 8;
const MAX_AREA_LIGHTS = 7;

// Candela of a Crucible light per unit of Roblox Brightness. The Roblox documentation gives Brightness no photometric unit
// (a PointLight of Brightness 1 and Range 16 is its own example), so this one number is a calibration. At 12 candela the lights
// over-drove a scene and a Brightness 6 spot blew a white part out to 255. At 4 a Brightness 1 point light lifts a grey card one
// metre below it by 1.63 times in linear luma and does not clip a white card (scripts/measure-roblox-light.mjs; an
// approximation, since Roblox Brightness has no physical unit).
export const CANDELA_PER_BRIGHTNESS = 4;
const SPOT_PENUMBRA = 0.3;
const MAX_SPOT_HALF_ANGLE = 1.5;

const PART_SHAPES = Object.freeze({ 0: 'ball', 1: 'block', 2: 'cylinder', 3: 'wedge' });

// Roblox Enum.Material value -> a Crucible material built from fields every recipe has. Presets with patterns wait for #3234.
const MATERIALS = Object.freeze({
  256: { name: 'Plastic', roughness: 0.55 },
  272: { name: 'SmoothPlastic', roughness: 0.25 },
  288: { name: 'Neon', roughness: 0.4, glow: 2 },
  512: { name: 'Wood', roughness: 0.75 },
  528: { name: 'WoodPlanks', roughness: 0.75 },
  784: { name: 'Marble', roughness: 0.2 },
  788: { name: 'Basalt', roughness: 0.9 },
  800: { name: 'Slate', roughness: 0.8 },
  804: { name: 'CrackedLava', roughness: 0.8, glow: 0.6 },
  816: { name: 'Concrete', roughness: 0.9 },
  820: { name: 'Limestone', roughness: 0.9 },
  832: { name: 'Granite', roughness: 0.6 },
  836: { name: 'Pavement', roughness: 0.9 },
  848: { name: 'Brick', roughness: 0.85 },
  864: { name: 'Pebble', roughness: 0.9 },
  880: { name: 'Cobblestone', roughness: 0.85 },
  896: { name: 'Rock', roughness: 0.9 },
  912: { name: 'Sandstone', roughness: 0.95 },
  1040: { name: 'CorrodedMetal', roughness: 0.7, metallic: 0.8 },
  1056: { name: 'DiamondPlate', roughness: 0.4, metallic: 1 },
  1072: { name: 'Foil', roughness: 0.15, metallic: 1 },
  1088: { name: 'Metal', roughness: 0.35, metallic: 1 },
  1280: { name: 'Grass', roughness: 0.95 },
  1284: { name: 'LeafyGrass', roughness: 0.95 },
  1296: { name: 'Sand', roughness: 1 },
  1312: { name: 'Fabric', roughness: 1 },
  1328: { name: 'Snow', roughness: 0.9 },
  1344: { name: 'Mud', roughness: 0.95 },
  1360: { name: 'Ground', roughness: 1 },
  1376: { name: 'Asphalt', roughness: 0.9 },
  1392: { name: 'Salt', roughness: 0.9 },
  1536: { name: 'Ice', roughness: 0.1, minimumOpacity: 0.85 },
  1552: { name: 'Glacier', roughness: 0.15 },
  1568: { name: 'Glass', roughness: 0.05, maximumOpacity: 0.35 },
  1584: { name: 'ForceField', roughness: 0.3, glow: 1, maximumOpacity: 0.5 },
  1792: { name: 'Air', roughness: 1 },
  2048: { name: 'Water', roughness: 0.05, maximumOpacity: 0.6 },
  2064: { name: 'Cardboard', roughness: 1 },
  2080: { name: 'Carpet', roughness: 1 },
  2096: { name: 'CeramicTiles', roughness: 0.25 },
  2112: { name: 'ClayRoofTiles', roughness: 0.8 },
  2128: { name: 'RoofShingles', roughness: 0.9 },
  2144: { name: 'Leather', roughness: 0.6 },
  2160: { name: 'Plaster', roughness: 0.9 },
  2176: { name: 'Rubber', roughness: 0.95 },
});
const DEFAULT_MATERIAL = 256;

// Classes the importer draws or reads.
const PART_CLASSES = new Set(['Part', 'WedgePart', 'SpawnLocation', 'Seat', 'VehicleSeat']);
const CONTAINER_CLASSES = new Set(['Workspace', 'Model', 'Folder', 'Actor', 'WorldModel', 'Tool', 'Accessory', 'Hat', 'Configuration']);
const LIGHT_CLASSES = new Set(['PointLight', 'SpotLight', 'SurfaceLight']);

// Services outside the world: their subtrees are skipped whole.
const SKIPPED_SERVICES = new Set([
  'Lighting', 'StarterGui', 'StarterPack', 'StarterPlayer', 'Players', 'ReplicatedStorage', 'ReplicatedFirst', 'ServerStorage',
  'ServerScriptService', 'SoundService', 'Teams', 'Chat', 'TextChatService', 'LocalizationService', 'MaterialService', 'TestService',
  'HttpService', 'RunService', 'Debris', 'InsertService', 'MarketplaceService', 'CollectionService', 'ContentProvider',
]);

// Classes that carry no visible geometry; they are counted in `ignored` and need no warning.
const IGNORED_CLASSES = new Set([
  'Script', 'LocalScript', 'ModuleScript', 'Attachment', 'Weld', 'WeldConstraint', 'ManualWeld', 'Motor6D', 'Motor', 'Snap',
  'Humanoid', 'HumanoidDescription', 'Animator', 'Atmosphere', 'Sky', 'BloomEffect', 'SunRaysEffect', 'ColorCorrectionEffect',
  'BlurEffect', 'DepthOfFieldEffect', 'StringValue', 'NumberValue', 'BoolValue', 'IntValue', 'ObjectValue', 'Color3Value',
  'Vector3Value', 'CFrameValue', 'BodyColors', 'Shirt', 'Pants', 'ShirtGraphic', 'Sound', 'SoundGroup', 'ClickDetector',
  'ProximityPrompt', 'Constraint', 'HingeConstraint', 'BallSocketConstraint',
  'RodConstraint', 'RopeConstraint', 'SpringConstraint', 'PrismaticConstraint', 'NoCollisionConstraint', 'BodyVelocity',
  'BodyGyro', 'BodyPosition', 'Animation', 'AnimationController', 'ForceField', 'Explosion',
]);

// Classes that change how a scene looks but that Crucible cannot draw from the XML alone: skipped, with one warning per class.
const DROPPED_CLASSES = new Set([
  'Decal', 'Texture', 'SurfaceAppearance', 'SpecialMesh', 'Fire', 'Smoke', 'Sparkles', 'ParticleEmitter', 'Beam', 'Trail',
  'Highlight', 'BillboardGui', 'SurfaceGui', 'ScreenGui',
]);

// Classes that could be drawn but that this importer cannot yet; each says what to do in Roblox Studio.
const UNSUPPORTED_HINTS = Object.freeze({
  CornerWedgePart: 'Build it from WedgePart and Part shapes.',
  TrussPart: 'Replace it with Part blocks.',
  UnionOperation: 'In Roblox Studio, export the union as a mesh, map its asset id and use a MeshPart, or rebuild it from parts.',
  NegateOperation: 'Apply the negation in Roblox Studio first, so the result is a union or mesh.',
  IntersectOperation: 'Apply the intersection in Roblox Studio first, so the result is a union or mesh.',
  Terrain: 'Terrain voxels are not in the XML file. Rebuild the ground with Part blocks or a Crucible terrain.',
  Skin: 'Skinned meshes are not imported. Use a MeshPart per rigid piece.',
});

export class RobloxImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RobloxImportError';
  }
}

// ---------------------------------------------------------------- options

function resolveOptions(options) {
  const known = [...Object.keys(DEFAULT_LIMITS), 'skipUnsupported', 'assets'];
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) throw new RobloxImportError(`Unknown option "${key}". Pass ${known.join(', ')}.`);
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (options[key] === undefined) continue;
    if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > HARD_LIMITS[key]) {
      throw new RobloxImportError(`Option ${key} must be a whole number from 1 to ${HARD_LIMITS[key]}, not ${options[key]}.`);
    }
    limits[key] = options[key];
  }
  const assets = options.assets ?? {};
  if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) {
    throw new RobloxImportError('Option assets must be an object that maps a Roblox asset id to { id, kind }, such as the one importRobloxFile builds from an asset folder.');
  }
  return { ...limits, skipUnsupported: options.skipUnsupported === true, assets };
}

// ---------------------------------------------------------------- XML

const ENTITIES = Object.freeze({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" });

function isSpace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

function isNameStart(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
}

function isNameCharacter(code) {
  return isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2e || code === 0x3a || code === 0x2d;
}

function decodeEntities(text) {
  let ampersand = text.indexOf('&');
  if (ampersand === -1) return text;
  let decoded = '';
  let copiedUpTo = 0;
  while (ampersand !== -1) {
    // The name or number between & and ; is at most 12 characters, so look only that far ahead.
    let semicolonAt = -1;
    for (let index = ampersand + 1; index <= ampersand + 13 && index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code === 0x3b) {
        semicolonAt = index;
        break;
      }
      if (code === 0x26) break;
    }
    const body = semicolonAt === -1 ? '' : text.slice(ampersand + 1, semicolonAt);
    let replacement = null;
    if (/^#x[0-9a-fA-F]+$/.test(body) || /^#[0-9]+$/.test(body)) {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) replacement = String.fromCodePoint(code);
    } else if (/^[a-z]+$/.test(body)) {
      replacement = ENTITIES[body] ?? null;
    }
    if (replacement === null) {
      ampersand = text.indexOf('&', ampersand + 1);
    } else {
      decoded += text.slice(copiedUpTo, ampersand) + replacement;
      copiedUpTo = semicolonAt + 1;
      ampersand = text.indexOf('&', copiedUpTo);
    }
  }
  return decoded + text.slice(copiedUpTo);
}

// Reads name="value" pairs in one pass over the text; every step moves forward, so the time is linear in the text.
function parseAttributes(source, tagName) {
  const attributes = {};
  const fail = () => new RobloxImportError(`The XML tag <${tagName}> has attributes that are not name="value" pairs. Export the place again from Roblox Studio as .rbxlx or .rbxmx.`);
  let position = 0;
  while (position < source.length) {
    while (position < source.length && isSpace(source.charCodeAt(position))) position += 1;
    if (position >= source.length) break;
    const nameStart = position;
    while (position < source.length && !isSpace(source.charCodeAt(position)) && source[position] !== '=') position += 1;
    const name = source.slice(nameStart, position);
    while (position < source.length && isSpace(source.charCodeAt(position))) position += 1;
    if (name === '' || source[position] !== '=') throw fail();
    position += 1;
    while (position < source.length && isSpace(source.charCodeAt(position))) position += 1;
    const quote = source[position];
    if (quote !== '"' && quote !== "'") throw fail();
    const valueEnd = source.indexOf(quote, position + 1);
    if (valueEnd === -1) throw fail();
    attributes[name] = decodeEntities(source.slice(position + 1, valueEnd));
    position = valueEnd + 1;
  }
  return attributes;
}

// A small non-recursive XML reader: elements, attributes, text, CDATA and entities, with the element count and depth bounded.
// It walks the text once with indexOf and character checks, never a backtracking pattern, so hostile input costs time in
// proportion to its length.
// The size of the text as UTF-8, counted without making a copy.
function utf8ByteLength(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function unterminated(what, end) {
  return new RobloxImportError(`The XML has ${what} that never ends with ${end}. The file is cut off or edited by hand; export it again from Roblox Studio.`);
}

// Reads one tag that starts at text[start] === '<'. Returns { closing, tag, attributeText, selfClosing, end } with end after '>'.
function readTag(text, start) {
  let position = start + 1;
  const closing = text[position] === '/';
  if (closing) position += 1;
  if (!isNameStart(text.charCodeAt(position))) {
    throw new RobloxImportError('The XML has a tag this reader cannot parse. Export the place again from Roblox Studio as .rbxlx or .rbxmx.');
  }
  const nameStart = position;
  while (position < text.length && isNameCharacter(text.charCodeAt(position))) position += 1;
  const tag = text.slice(nameStart, position);
  const attributesStart = position;
  while (position < text.length && text[position] !== '>') {
    if (text[position] === '"' || text[position] === "'") {
      const quoteEnd = text.indexOf(text[position], position + 1);
      if (quoteEnd === -1) throw unterminated(`a quoted value in <${tag}>`, 'a closing quote');
      position = quoteEnd + 1;
    } else {
      position += 1;
    }
  }
  if (position >= text.length) throw unterminated(`the tag <${tag}>`, '">"');
  const selfClosing = text[position - 1] === '/' && position - 1 >= attributesStart;
  const attributeText = text.slice(attributesStart, selfClosing ? position - 1 : position);
  return { closing, tag, attributeText, selfClosing, end: position + 1 };
}

function parseXml(text, limits) {
  const byteLength = utf8ByteLength(text);
  if (byteLength > limits.maxBytes) {
    throw new RobloxImportError(`The XML holds ${byteLength} bytes, above the limit of ${limits.maxBytes}. Raise maxBytes (up to ${HARD_LIMITS.maxBytes}) or export a smaller selection.`);
  }
  const root = { tag: '#document', attributes: {}, children: [], text: '' };
  const stack = [root];
  let elementCount = 0;
  let position = 0;
  while (position < text.length) {
    const current = stack[stack.length - 1];
    if (text[position] !== '<') {
      const next = text.indexOf('<', position);
      const end = next === -1 ? text.length : next;
      current.text += decodeEntities(text.slice(position, end));
      position = end;
    } else if (text.startsWith('<!--', position)) {
      const end = text.indexOf('-->', position + 4);
      if (end === -1) throw unterminated('a comment', '-->');
      position = end + 3;
    } else if (text.startsWith('<![CDATA[', position)) {
      const end = text.indexOf(']]>', position + 9);
      if (end === -1) throw unterminated('a CDATA section', ']]>');
      current.text += text.slice(position + 9, end);
      position = end + 3;
    } else if (text.startsWith('<?', position)) {
      const end = text.indexOf('?>', position + 2);
      if (end === -1) throw unterminated('a processing instruction', '?>');
      position = end + 2;
    } else if (text.startsWith('<!', position)) {
      const end = text.indexOf('>', position + 2);
      if (end === -1) throw unterminated('a declaration', '">"');
      position = end + 1;
    } else {
      const { closing, tag, attributeText, selfClosing, end } = readTag(text, position);
      position = end;
      if (closing) {
        if (stack.length < 2 || current.tag !== tag) {
          throw new RobloxImportError(`The XML closes </${tag}> where </${current.tag}> was expected. The file is cut off or edited by hand; export it again from Roblox Studio.`);
        }
        stack.pop();
        continue;
      }
      elementCount += 1;
      if (elementCount > limits.maxItems) {
        throw new RobloxImportError(`The XML holds more than ${limits.maxItems} elements. Raise maxItems (up to ${HARD_LIMITS.maxItems}) or export a smaller selection.`);
      }
      const element = { tag, attributes: parseAttributes(attributeText, tag), children: [], text: '' };
      current.children.push(element);
      if (!selfClosing) {
        if (stack.length > limits.maxDepth) {
          throw new RobloxImportError(`The XML nests deeper than ${limits.maxDepth} levels. Raise maxDepth (up to ${HARD_LIMITS.maxDepth}) or flatten the models in Roblox Studio.`);
        }
        stack.push(element);
      }
    }
  }
  if (stack.length !== 1) throw new RobloxImportError(`The XML ends inside <${stack[stack.length - 1].tag}>. The file is cut off; export it again from Roblox Studio.`);
  const roblox = root.children.find(child => child.tag === 'roblox');
  if (!roblox) {
    throw new RobloxImportError('The XML has no <roblox> root. Pass an .rbxlx place or an .rbxmx model exported from Roblox Studio (the binary .rbxl and .rbxm files are not read).');
  }
  return roblox;
}

// ---------------------------------------------------------------- Roblox values

function readItem(element) {
  const properties = new Map();
  const propertiesElement = element.children.find(child => child.tag === 'Properties');
  for (const property of propertiesElement?.children ?? []) {
    const name = property.attributes.name;
    if (name !== undefined) properties.set(name.toLowerCase(), property);
  }
  return {
    className: element.attributes.class ?? '',
    referent: element.attributes.referent ?? '',
    properties,
    children: element.children.filter(child => child.tag === 'Item').map(readItem),
  };
}

function textNumber(element, label) {
  const value = Number(element.text.trim());
  if (!Number.isFinite(value)) throw new RobloxImportError(`${label} is "${element.text.trim()}", not a number. Fix the value or export the file again.`);
  return value;
}

function numberProperty(item, names, fallback) {
  for (const name of names) {
    const property = item.properties.get(name.toLowerCase());
    if (property) return textNumber(property, `${item.className} property ${name}`);
  }
  return fallback;
}

function stringProperty(item, names, fallback = '') {
  for (const name of names) {
    const property = item.properties.get(name.toLowerCase());
    if (!property) continue;
    // A Content property holds its reference in a <url> child; older files write a plain string.
    const url = property.children.find(child => child.tag === 'url');
    return (url ?? property).text.trim();
  }
  return fallback;
}

function booleanProperty(item, name, fallback) {
  const property = item.properties.get(name.toLowerCase());
  return property ? property.text.trim() === 'true' : fallback;
}

function vectorChildren(element, names, label) {
  return names.map(name => {
    const child = element.children.find(candidate => candidate.tag === name);
    if (!child) throw new RobloxImportError(`${label} has no <${name}> value. Export the file again from Roblox Studio.`);
    return textNumber(child, `${label} ${name}`);
  });
}

function vectorProperty(item, names, fallback) {
  for (const name of names) {
    const property = item.properties.get(name.toLowerCase());
    if (property) return vectorChildren(property, ['X', 'Y', 'Z'], `${item.className} property ${name}`);
  }
  return fallback;
}

const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function frameProperty(item, name, label) {
  const property = item.properties.get(name.toLowerCase());
  if (!property) return { position: [0, 0, 0], rotation: [...IDENTITY] };
  const position = vectorChildren(property, ['X', 'Y', 'Z'], label);
  const rotation = property.children.some(child => child.tag === 'R00')
    ? vectorChildren(property, ['R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'], label)
    : [...IDENTITY];
  checkRotation(rotation, label);
  return { position, rotation };
}

// A CFrame must hold a pure rotation: orthonormal, determinant +1. A mirrored or scaled matrix would draw a part the wrong way round.
function checkRotation(matrix, label) {
  for (let first = 0; first < 3; first += 1) {
    for (let second = first; second < 3; second += 1) {
      const dot = matrix[first * 3] * matrix[second * 3] + matrix[first * 3 + 1] * matrix[second * 3 + 1] + matrix[first * 3 + 2] * matrix[second * 3 + 2];
      if (Math.abs(dot - (first === second ? 1 : 0)) > ROTATION_TOLERANCE) {
        throw new RobloxImportError(`${label} is not a rotation (its axes are not perpendicular unit vectors). Reset the part's scale or reflection in Roblox Studio.`);
      }
    }
  }
  const determinant = matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7])
    - matrix[1] * (matrix[3] * matrix[8] - matrix[5] * matrix[6])
    + matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6]);
  if (determinant < 0) throw new RobloxImportError(`${label} mirrors the part (determinant ${determinant.toFixed(3)}). Roblox CFrames never mirror; fix the file.`);
}

function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function colorProperty(item, names, fallback) {
  for (const name of names) {
    const property = item.properties.get(name.toLowerCase());
    if (!property) continue;
    if (property.tag === 'Color3uint8' || property.children.length === 0) {
      const packed = textNumber(property, `${item.className} property ${name}`);
      return [(packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255].map(channel => channel / 255);
    }
    return vectorChildren(property, ['R', 'G', 'B'], `${item.className} property ${name}`);
  }
  return fallback;
}

// ---------------------------------------------------------------- math

function round(value) {
  const rounded = Math.round(value * DECIMALS) / DECIMALS;
  return rounded === 0 ? 0 : rounded;
}

function roundAll(values) {
  return values.map(round);
}

function multiplyMatrices(left, right) {
  const product = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let k = 0; k < 3; k += 1) product[row * 3 + column] += left[row * 3 + k] * right[k * 3 + column];
    }
  }
  return product;
}

function applyMatrix(matrix, vector) {
  return [0, 1, 2].map(row => matrix[row * 3] * vector[0] + matrix[row * 3 + 1] * vector[1] + matrix[row * 3 + 2] * vector[2]);
}

// Row-major rotation matrix -> XYZW quaternion with w >= 0, so the same rotation always writes the same numbers.
export function matrixToQuaternion(matrix) {
  const trace = matrix[0] + matrix[4] + matrix[8];
  let x;
  let y;
  let z;
  let w;
  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    w = scale / 4;
    x = (matrix[7] - matrix[5]) / scale;
    y = (matrix[2] - matrix[6]) / scale;
    z = (matrix[3] - matrix[1]) / scale;
  } else if (matrix[0] > matrix[4] && matrix[0] > matrix[8]) {
    const scale = Math.sqrt(1 + matrix[0] - matrix[4] - matrix[8]) * 2;
    w = (matrix[7] - matrix[5]) / scale;
    x = scale / 4;
    y = (matrix[1] + matrix[3]) / scale;
    z = (matrix[2] + matrix[6]) / scale;
  } else if (matrix[4] > matrix[8]) {
    const scale = Math.sqrt(1 + matrix[4] - matrix[0] - matrix[8]) * 2;
    w = (matrix[2] - matrix[6]) / scale;
    x = (matrix[1] + matrix[3]) / scale;
    y = scale / 4;
    z = (matrix[5] + matrix[7]) / scale;
  } else {
    const scale = Math.sqrt(1 + matrix[8] - matrix[0] - matrix[4]) * 2;
    w = (matrix[3] - matrix[1]) / scale;
    x = (matrix[2] + matrix[6]) / scale;
    y = (matrix[5] + matrix[7]) / scale;
    z = scale / 4;
  }
  const length = Math.hypot(x, y, z, w);
  const sign = w < 0 ? -1 : 1;
  return roundAll([x, y, z, w].map(value => (sign * value) / length));
}

const ROTATION_Z_QUARTER = Object.freeze([0, -1, 0, 1, 0, 0, 0, 0, 1]);
const ROTATION_Y_MINUS_QUARTER = Object.freeze([0, 0, -1, 0, 1, 0, 1, 0, 0]);

// ---------------------------------------------------------------- names and ids

function slugOf(name) {
  // One pass: letters and digits stay, each run of other characters becomes one dash, and the ends carry no dash.
  let slug = '';
  let pendingDash = false;
  for (const character of name.toLowerCase()) {
    const alphanumeric = (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');
    if (!alphanumeric) {
      pendingDash = slug !== '';
      continue;
    }
    if (pendingDash) slug += '-';
    pendingDash = false;
    slug += character;
    if (slug.length >= 61) break;
  }
  slug = slug.slice(0, 60);
  return slug === '' ? 'item' : slug;
}

function labelOf(item) {
  return stringProperty(item, ['Name'], item.className).slice(0, 256) || item.className;
}

function describe(item) {
  return `${item.className} "${labelOf(item)}"${item.referent ? ` (${item.referent})` : ''}`;
}

// A Roblox asset reference: rbxassetid://123, the older asset URLs with ?id=123, or a bare number. The id is only a key into the
// caller's map, so no part of it is ever fetched.
export function robloxAssetKey(reference) {
  const text = String(reference ?? '').trim();
  if (text === '' || text === 'rbxasset://') return null;
  const match = /^rbxassetid:\/\/(\d+)$/.exec(text) ?? /[?&]id=(\d+)/i.exec(text) ?? /^(\d+)$/.exec(text);
  return match ? match[1] : text;
}

// ---------------------------------------------------------------- materials

class MaterialTable {
  constructor() {
    this.entries = [];
    this.byKey = new Map();
  }

  idFor(definition) {
    const key = JSON.stringify(definition);
    if (!this.byKey.has(key)) {
      const id = `roblox-material-${this.entries.length}`;
      this.byKey.set(key, id);
      this.entries.push({ id, ...definition });
    }
    return this.byKey.get(key);
  }
}

function materialDefinition(part, state) {
  const token = numberProperty(part, ['Material', 'material'], DEFAULT_MATERIAL);
  let preset = MATERIALS[token];
  if (!preset) {
    state.warnings.push(`${describe(part)}: Roblox material ${token} is not known, so it is drawn as Plastic.`);
    preset = MATERIALS[DEFAULT_MATERIAL];
  }
  const color = colorProperty(part, ['Color3uint8', 'Color'], [163 / 255, 162 / 255, 165 / 255]).map(srgbToLinear);
  const transparency = Math.min(1, Math.max(0, numberProperty(part, ['Transparency'], 0)));
  const reflectance = Math.min(1, Math.max(0, numberProperty(part, ['Reflectance'], 0)));
  let opacity = 1 - transparency;
  if (preset.maximumOpacity !== undefined && transparency === 0) opacity = preset.maximumOpacity;
  if (preset.minimumOpacity !== undefined && transparency === 0) opacity = preset.minimumOpacity;
  const definition = {
    color: roundAll(color),
    metallic: round(Math.max(preset.metallic ?? 0, reflectance * 0.5)),
    roughness: round(preset.roughness * (1 - 0.7 * reflectance)),
  };
  if (preset.glow) {
    definition.emission = preset.glow;
    definition.emissiveColor = roundAll(color);
  }
  if (opacity < 1) {
    definition.opacity = round(opacity);
    definition.alphaMode = 'blend';
  }
  return definition;
}

// ---------------------------------------------------------------- walk

function pushNode(state, node) {
  state.nodes.push(node);
}

function nextId(state, item) {
  const index = state.counter;
  state.counter += 1;
  return `${slugOf(labelOf(item))}-${index}`;
}

function addPart(item, state) {
  if (state.partCount >= state.limits.maxParts) {
    throw new RobloxImportError(`The scene holds more than ${state.limits.maxParts} parts. Raise maxParts (up to ${HARD_LIMITS.maxParts}) or export a smaller selection.`);
  }
  state.partCount += 1;
  const transparency = numberProperty(item, ['Transparency'], 0);
  const frame = frameProperty(item, 'CFrame', `${describe(item)} CFrame`);
  const size = vectorProperty(item, ['size', 'Size'], [4, 1.2, 2]);
  for (const value of size) {
    if (!(value > 0) || value > MAX_PART_STUDS) {
      throw new RobloxImportError(`${describe(item)} has size ${size.join(' x ')}, outside 0 to ${MAX_PART_STUDS} studs. Fix the part size.`);
    }
  }
  state.frames.set(item, { frame, size });
  if (transparency >= 1) {
    state.stats.invisible += 1;
    return;
  }
  const shapeToken = numberProperty(item, ['shape', 'Shape'], 1);
  const shape = item.className === 'WedgePart' ? 'wedge' : PART_SHAPES[shapeToken];
  if (!shape) {
    throw new RobloxImportError(`${describe(item)} has shape ${shapeToken}, which this importer does not know. Use Block, Ball, Cylinder or a WedgePart.`);
  }
  const id = nextId(state, item);
  const material = state.materials.idFor(materialDefinition(item, state));
  const position = roundAll(frame.position.map(value => value * STUD_METERS));
  const meters = size.map(value => value * STUD_METERS);
  const base = { id, label: labelOf(item) };
  state.stats.parts[shape] += 1;
  if (shape === 'block') {
    state.geometryUsed.block = true;
    pushNode(state, { ...base, geometry: 'roblox-block', material, translation: position, rotation: matrixToQuaternion(frame.rotation), scale: roundAll(meters) });
  } else if (shape === 'ball') {
    state.geometryUsed.ball = true;
    pushNode(state, { ...base, geometry: 'roblox-ball', material, translation: position, rotation: matrixToQuaternion(frame.rotation), scale: roundAll(meters.map(value => value / 2)) });
  } else if (shape === 'cylinder') {
    // Roblox cylinders run along local X with diameter Y and Z; the Crucible cylinder has radius 1 and height 1 along Y.
    state.geometryUsed.cylinder = true;
    const rotation = multiplyMatrices(frame.rotation, ROTATION_Z_QUARTER);
    pushNode(state, { ...base, geometry: 'roblox-cylinder', material, translation: position, rotation: matrixToQuaternion(rotation), scale: roundAll([meters[1] / 2, meters[0], meters[2] / 2]) });
  } else {
    // The wedge is a right triangle prism: its tall flat side is local +Z (back), its floor is -Y and its slope rises toward the back.
    state.geometryUsed.wedge = true;
    pushNode(state, { ...base, translation: position, rotation: matrixToQuaternion(frame.rotation) });
    pushNode(state, {
      id: `${id}.slope`,
      parent: id,
      geometry: 'roblox-wedge',
      material,
      translation: roundAll([meters[0] / 2, 0, 0]),
      rotation: matrixToQuaternion(ROTATION_Y_MINUS_QUARTER),
      scale: roundAll([meters[2], meters[1], meters[0]]),
    });
  }
}

function addMeshPart(item, state) {
  const reference = stringProperty(item, ['MeshId', 'MeshID']);
  const key = robloxAssetKey(reference);
  if (state.partCount >= state.limits.maxParts) {
    throw new RobloxImportError(`The scene holds more than ${state.limits.maxParts} parts. Raise maxParts (up to ${HARD_LIMITS.maxParts}) or export a smaller selection.`);
  }
  if (key === null) {
    throw new RobloxImportError(`${describe(item)} has no MeshId. Give the MeshPart a mesh in Roblox Studio, or delete it.`);
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(key) && !key.startsWith('rbxassetid://')) {
    throw new RobloxImportError(`${describe(item)} points at "${key}". The importer never fetches a URL: download the mesh yourself, put the file in the asset folder and list its id in asset-map.json.`);
  }
  const entry = state.limits.assets[key];
  if (!entry || entry.kind !== 'glb') {
    throw new RobloxImportError(`${describe(item)} uses mesh asset ${key}, which is not in the asset map. Put a GLB of it in the asset folder and add "${key}": "<file>.glb" to its asset-map.json, or pass skipUnsupported: true to leave the part out.`);
  }
  state.partCount += 1;
  const frame = frameProperty(item, 'CFrame', `${describe(item)} CFrame`);
  const size = vectorProperty(item, ['size', 'Size'], [4, 4, 4]);
  state.frames.set(item, { frame, size });
  const target = size.map(value => value * STUD_METERS);
  const bounds = entry.bounds;
  let scale = [1, 1, 1];
  let center = [0, 0, 0];
  if (bounds) {
    scale = target.map((value, axis) => (bounds.size[axis] > 1e-9 ? value / bounds.size[axis] : 1));
    center = bounds.center;
  } else {
    state.warnings.push(`${describe(item)}: the asset map gives no bounds for ${key}, so the mesh is placed at scale 1 instead of fitted to its Size.`);
  }
  const offset = applyMatrix(frame.rotation, center.map((value, axis) => value * scale[axis]));
  const position = frame.position.map((value, axis) => value * STUD_METERS - offset[axis]);
  const id = nextId(state, item);
  state.stats.parts.mesh += 1;
  pushNode(state, {
    id,
    label: labelOf(item),
    translation: roundAll(position),
    rotation: matrixToQuaternion(frame.rotation),
    scale: roundAll(scale),
    asset: { id: entry.id },
  });
  state.usedAssets.set(key, entry);
  const textureKey = robloxAssetKey(stringProperty(item, ['TextureID', 'TextureId']));
  if (textureKey !== null && textureKey !== '') {
    const texture = state.limits.assets[textureKey];
    if (texture) state.usedAssets.set(textureKey, texture);
    state.warnings.push(`${describe(item)}: the texture ${textureKey} is listed in assets but not drawn yet; the placed mesh keeps the materials of its GLB.`);
  }
}

// The point of a face of a part and the axes the Crucible light needs there.
const FACES = Object.freeze({
  0: { normal: [1, 0, 0], up: [0, 1, 0], widthAxis: 2, heightAxis: 1, depthAxis: 0 },
  1: { normal: [0, 1, 0], up: [0, 0, 1], widthAxis: 0, heightAxis: 2, depthAxis: 1 },
  2: { normal: [0, 0, 1], up: [0, 1, 0], widthAxis: 0, heightAxis: 1, depthAxis: 2 },
  3: { normal: [-1, 0, 0], up: [0, 1, 0], widthAxis: 2, heightAxis: 1, depthAxis: 0 },
  4: { normal: [0, -1, 0], up: [0, 0, 1], widthAxis: 0, heightAxis: 2, depthAxis: 1 },
  5: { normal: [0, 0, -1], up: [0, 1, 0], widthAxis: 0, heightAxis: 1, depthAxis: 2 },
});

function addLight(item, owner, state) {
  if (!booleanProperty(item, 'Enabled', true)) {
    state.stats.lightsOff += 1;
    return;
  }
  const ownerFrame = state.frames.get(owner);
  if (!ownerFrame) {
    state.warnings.push(`${describe(item)}: its parent ${describe(owner)} is not a part, so the light is skipped.`);
    return;
  }
  const brightness = Math.max(0, numberProperty(item, ['Brightness'], 1));
  const color = roundAll(colorProperty(item, ['Color', 'Color3uint8'], [1, 1, 1]).map(srgbToLinear));
  const intensity = round(brightness * CANDELA_PER_BRIGHTNESS);
  const { frame, size } = ownerFrame;
  const rangeStuds = numberProperty(item, ['Range'], item.className === 'PointLight' ? 8 : 16);
  const range = round(Math.max(0.001, rangeStuds * STUD_METERS));
  const castShadow = booleanProperty(item, 'Shadows', false);
  if (item.className === 'PointLight') {
    const light = { position: roundAll(frame.position.map(value => value * STUD_METERS)), color, intensity, range, radius: 0.1 };
    if (castShadow) light.castShadow = true;
    state.lights.point.push(light);
    return;
  }
  const faceToken = numberProperty(item, ['Face'], 5);
  const face = FACES[faceToken];
  if (!face) throw new RobloxImportError(`${describe(item)} has face ${faceToken}, outside 0 to 5. Fix the Face property.`);
  const direction = applyMatrix(frame.rotation, face.normal);
  const centerOffset = applyMatrix(frame.rotation, face.normal.map(component => (component * size[face.depthAxis]) / 2));
  const position = frame.position.map((value, axis) => (value + centerOffset[axis]) * STUD_METERS);
  if (item.className === 'SpotLight') {
    const halfAngle = Math.min(MAX_SPOT_HALF_ANGLE, Math.max(0.01, (numberProperty(item, ['Angle'], 90) * Math.PI) / 360));
    const light = { position: roundAll(position), direction: roundAll(direction), angle: round(halfAngle), penumbra: SPOT_PENUMBRA, color, intensity, range };
    if (castShadow) light.castShadow = true;
    state.lights.spot.push(light);
    return;
  }
  const light = {
    position: roundAll(position),
    direction: roundAll(direction),
    up: roundAll(applyMatrix(frame.rotation, face.up)),
    width: round(size[face.widthAxis] * STUD_METERS),
    height: round(size[face.heightAxis] * STUD_METERS),
    color,
    intensity,
  };
  if (castShadow) light.castShadow = true;
  state.lights.area.push(light);
}

function unsupported(item, state, message) {
  if (state.limits.skipUnsupported) {
    state.warnings.push(`${message} (skipped)`);
    state.stats.skipped += 1;
    return;
  }
  throw new RobloxImportError(message);
}

function unsupportedMessage(item) {
  const hint = UNSUPPORTED_HINTS[item.className] ?? 'Replace it with Part, WedgePart or MeshPart objects, or remove it.';
  return `Unsupported class ${describe(item)}: this importer reads Part, WedgePart, SpawnLocation, Seat, VehicleSeat and MeshPart objects with PointLight, SpotLight, SurfaceLight and Camera. ${hint} Pass skipUnsupported: true to leave it out with a warning.`;
}

function visit(item, parent, state) {
  const { className } = item;
  if (PART_CLASSES.has(className)) {
    try {
      addPart(item, state);
    } catch (error) {
      if (!(error instanceof RobloxImportError) || !state.limits.skipUnsupported) throw error;
      state.warnings.push(`${error.message} (skipped)`);
      state.stats.skipped += 1;
    }
    item.children.forEach(child => visit(child, item, state));
  } else if (className === 'MeshPart') {
    try {
      addMeshPart(item, state);
    } catch (error) {
      if (!(error instanceof RobloxImportError) || !state.limits.skipUnsupported) throw error;
      state.warnings.push(`${error.message} (skipped)`);
      state.stats.skipped += 1;
    }
    item.children.forEach(child => visit(child, item, state));
  } else if (LIGHT_CLASSES.has(className)) {
    if (!parent) {
      unsupported(item, state, `${describe(item)} has no parent part. Put the light inside a part in Roblox Studio.`);
      return;
    }
    addLight(item, parent, state);
  } else if (className === 'Camera') {
    state.cameras.push(item);
  } else if (className === 'Attachment') {
    state.ignored.add(className);
    const offset = frameProperty(item, 'CFrame', `${describe(item)} CFrame`);
    const owner = state.frames.get(parent);
    if (owner) {
      const rotation = multiplyMatrices(owner.frame.rotation, offset.rotation);
      const shift = applyMatrix(owner.frame.rotation, offset.position);
      state.frames.set(item, { frame: { position: owner.frame.position.map((value, axis) => value + shift[axis]), rotation }, size: [0, 0, 0] });
    }
    item.children.forEach(child => visit(child, item, state));
  } else if (CONTAINER_CLASSES.has(className)) {
    item.children.forEach(child => visit(child, parent, state));
  } else if (IGNORED_CLASSES.has(className)) {
    state.ignored.add(className);
  } else if (DROPPED_CLASSES.has(className)) {
    state.dropped.set(className, (state.dropped.get(className) ?? 0) + 1);
  } else {
    unsupported(item, state, unsupportedMessage(item));
  }
}

// ---------------------------------------------------------------- camera

function buildCamera(cameraItem, state) {
  const frame = frameProperty(cameraItem, 'CFrame', `${describe(cameraItem)} CFrame`);
  const fieldOfView = numberProperty(cameraItem, ['FieldOfView'], 70);
  if (!(fieldOfView > 0 && fieldOfView < 180)) {
    throw new RobloxImportError(`${describe(cameraItem)} has FieldOfView ${fieldOfView}; it must be above 0 and below 180 degrees.`);
  }
  if (numberProperty(cameraItem, ['FieldOfViewMode'], 0) !== 0) {
    state.warnings.push(`${describe(cameraItem)}: its FieldOfViewMode is not Vertical, but Crucible reads the field of view as vertical.`);
  }
  const eye = frame.position.map(value => value * STUD_METERS);
  const look = applyMatrix(frame.rotation, [0, 0, -1]);
  const up = applyMatrix(frame.rotation, [0, 1, 0]);
  return {
    eye: roundAll(eye),
    target: roundAll(eye.map((value, axis) => value + look[axis] * CAMERA_TARGET_METERS)),
    up: roundAll(up),
    fov: round(fieldOfView),
    near: CAMERA_NEAR_METERS,
    far: CAMERA_FAR_METERS,
  };
}

function chooseCamera(workspace, state) {
  if (state.cameras.length === 0) return null;
  const referent = workspace?.properties.get('currentcamera')?.text.trim();
  const current = state.cameras.find(camera => referent && camera.referent === referent);
  if (state.cameras.length > 1 && !current) state.warnings.push(`The file holds ${state.cameras.length} cameras and no CurrentCamera, so the first one is used.`);
  return buildCamera(current ?? state.cameras[0], state);
}

// ---------------------------------------------------------------- recipe

const GEOMETRIES = Object.freeze({
  block: { id: 'roblox-block', type: 'box', bevel: 0, subdivisions: 1 },
  ball: { id: 'roblox-ball', type: 'sphere', segments: SPHERE_SEGMENTS, rings: SPHERE_RINGS },
  cylinder: { id: 'roblox-cylinder', type: 'cylinder', segments: CYLINDER_SEGMENTS, bevel: 0, bevelSegments: 1 },
  // A right triangle in the XY plane, pushed along Z: x runs from the front (-0.5) to the back (0.5) of the wedge, y is its height.
  wedge: { id: 'roblox-wedge', type: 'extrude', contour: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5]], depth: 1 },
});

function limitLights(kind, lights, maximum, state) {
  if (lights.length > maximum) {
    state.warnings.push(`The scene has ${lights.length} ${kind} lights and Crucible draws at most ${maximum}, so the first ${maximum} are kept.`);
  }
  return lights.slice(0, maximum);
}

/**
 * Reads the text of an .rbxlx place or an .rbxmx model and returns `{ recipe, warnings, ignored, assets, stats }`.
 * `recipe` is a `crucible.scene` recipe (pass it to scene_create or createAgentScene). `assets` lists the mapped meshes and
 * textures the recipe uses, `ignored` the class names that carry no geometry. Options: `maxBytes`, `maxParts`, `maxItems`,
 * `maxDepth`, `skipUnsupported`, and `assets`, a table from the Roblox asset id to `{ id, kind, bounds }` built from a local folder.
 */
export function importRoblox(xmlText, options = {}) {
  if (typeof xmlText !== 'string' || xmlText.trim() === '') {
    throw new RobloxImportError('importRoblox needs the text of an .rbxlx or .rbxmx file. Read the file as UTF-8 and pass the string.');
  }
  const limits = resolveOptions(options);
  const document = parseXml(xmlText, limits);
  const state = {
    limits,
    nodes: [],
    warnings: [],
    ignored: new Set(),
    dropped: new Map(),
    cameras: [],
    frames: new Map(),
    lights: { point: [], spot: [], area: [] },
    materials: new MaterialTable(),
    geometryUsed: {},
    usedAssets: new Map(),
    counter: 0,
    partCount: 0,
    stats: { parts: { block: 0, ball: 0, cylinder: 0, wedge: 0, mesh: 0 }, invisible: 0, skipped: 0, lightsOff: 0, skippedServices: [] },
  };
  let workspace = null;
  const roots = document.children.filter(child => child.tag === 'Item').map(readItem);
  const visitRoot = root => {
    if (SKIPPED_SERVICES.has(root.className)) {
      state.stats.skippedServices.push(root.className);
      return;
    }
    if (root.className === 'Workspace') workspace = root;
    visit(root, null, state);
  };
  roots.forEach(visitRoot);
  if (state.nodes.length === 0 && state.cameras.length === 0) {
    throw new RobloxImportError('The file holds no parts to draw. Export a place or a model that contains Part, WedgePart or MeshPart objects.');
  }
  for (const [className, count] of [...state.dropped.entries()].sort(([first], [second]) => first.localeCompare(second))) {
    state.warnings.push(`${count} ${className} object${count === 1 ? ' is' : 's are'} not drawn: Crucible cannot read it from the XML.`);
  }
  const geometries = Object.keys(GEOMETRIES).filter(kind => state.geometryUsed[kind]).map(kind => ({ ...GEOMETRIES[kind] }));
  const recipe = {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries,
    materials: state.materials.entries,
    nodes: state.nodes,
  };
  const camera = chooseCamera(workspace, state);
  if (camera) recipe.camera = camera;
  const pointLights = limitLights('point', state.lights.point, MAX_POINT_LIGHTS, state);
  const spotLights = limitLights('spot', state.lights.spot, MAX_SPOT_LIGHTS, state);
  const areaLights = limitLights('surface', state.lights.area, MAX_AREA_LIGHTS, state);
  const environment = {};
  if (pointLights.length > 0) environment.pointLights = pointLights;
  if (spotLights.length > 0) environment.spotLights = spotLights;
  if (areaLights.length > 0) environment.areaLights = areaLights;
  if (Object.keys(environment).length > 0) recipe.environment = environment;
  const assets = [...state.usedAssets.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([robloxId, entry]) => ({ robloxId, id: entry.id, kind: entry.kind, file: entry.file }));
  return { recipe, warnings: state.warnings, ignored: [...state.ignored].sort(), assets, stats: state.stats };
}
