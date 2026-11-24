import { createEnvironmentMap } from './environment.js';

// environment.skybox: six face images folded into the equirectangular environment map every other sky uses, so the same map is the
// background, the diffuse light and the reflections. The faces are upright images as a viewer inside the cube sees them: front looks toward -Z
// (the way the default camera looks), right is +X, left is -X, back is +Z, and the up and down faces are the top and bottom of a cross laid
// out around the front face, so the bottom edge of up and the top edge of down touch the front face.

export const SKYBOX_FACES = Object.freeze(['front', 'back', 'left', 'right', 'up', 'down']);
const ASSET_ID = /^[a-f0-9]{64}$/;
const MAP_WIDTH = 2048;
const MAP_HEIGHT = 1024;

const registeredFaces = new Map();
const builtMaps = new Map();

/** Validates a recipe's skybox: every face named once, each the 64-character ID of an image in scene_asset_catalog. `fail(path, value, accepted)` builds the error. */
export function resolveSkybox(input, fail) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw fail('environment.skybox', input, `an object with the faces ${SKYBOX_FACES.join(', ')}, each the 64-character ID of an image from scene_asset_catalog`);
  }
  const unknown = Object.keys(input).find(key => !SKYBOX_FACES.includes(key));
  if (unknown !== undefined) {
    throw fail(`environment.skybox.${unknown}`, input[unknown], `one of the faces ${SKYBOX_FACES.join(', ')}`);
  }
  const resolved = {};
  for (const face of SKYBOX_FACES) {
    const id = typeof input[face] === 'string' ? input[face].toLowerCase() : input[face];
    if (!ASSET_ID.test(id ?? '')) {
      throw fail(`environment.skybox.${face}`, input[face], 'the 64-character ID of an image in scene_asset_catalog (local scene assets only, no URLs); all six faces are needed');
    }
    resolved[face] = id;
  }
  return resolved;
}

/** Registers a decoded face ({ width, height, data: RGBA bytes }) under its catalog ID. */
export function registerSkyboxFace(id, decoded) {
  registeredFaces.set(id, decoded);
  builtMaps.clear();
}

function srgbToLinear(byte) {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** The face a direction leaves through and where on it; u runs left to right and v top to bottom of the image as a viewer inside sees it. */
export function skyboxFaceLookup(x, y, z) {
  const absoluteX = Math.abs(x);
  const absoluteY = Math.abs(y);
  const absoluteZ = Math.abs(z);
  let face;
  let sideways;
  let downward;
  let major;
  if (absoluteX >= absoluteY && absoluteX >= absoluteZ) {
    [face, sideways, downward, major] = x > 0 ? ['right', z, -y, absoluteX] : ['left', -z, -y, absoluteX];
  } else if (absoluteY >= absoluteZ) {
    [face, sideways, downward, major] = y > 0 ? ['up', x, -z, absoluteY] : ['down', x, z, absoluteY];
  } else {
    [face, sideways, downward, major] = z > 0 ? ['back', -x, -y, absoluteZ] : ['front', x, -y, absoluteZ];
  }
  return { face, u: (sideways / major + 1) / 2, v: (downward / major + 1) / 2 };
}

// Bilinear in linear light, clamped to the face's own edge texels. Nearest sampling left stair-steps along every edge of a face.
function sampleFace(image, u, v, target, offset) {
  const x = Math.min(image.width - 1, Math.max(0, u * image.width - 0.5));
  const y = Math.min(image.height - 1, Math.max(0, v * image.height - 0.5));
  const column = Math.min(image.width - 2, Math.floor(x));
  const row = Math.min(image.height - 2, Math.floor(y));
  const nextColumn = image.width > 1 ? column + 1 : column;
  const nextRow = image.height > 1 ? row + 1 : row;
  const shareX = x - column;
  const shareY = y - row;
  for (let channel = 0; channel < 3; channel++) {
    const topLeft = srgbToLinear(image.data[(row * image.width + column) * 4 + channel]);
    const topRight = srgbToLinear(image.data[(row * image.width + nextColumn) * 4 + channel]);
    const bottomLeft = srgbToLinear(image.data[(nextRow * image.width + column) * 4 + channel]);
    const bottomRight = srgbToLinear(image.data[(nextRow * image.width + nextColumn) * 4 + channel]);
    target[offset + channel] = (topLeft * (1 - shareX) + topRight * shareX) * (1 - shareY) + (bottomLeft * (1 - shareX) + bottomRight * shareX) * shareY;
  }
}

/** The equirectangular map of a skybox's registered faces. The same object returns while the faces and the settings hold. */
export function createSkyboxMap(environment) {
  const imagesByFace = {};
  for (const face of SKYBOX_FACES) {
    const image = registeredFaces.get(environment.skybox[face]);
    if (!image) {
      throw new Error(`environment.skybox.${face} (${environment.skybox[face].slice(0, 16)}) is not loaded: the host decodes the image and registers it with registerSkyboxFace (the MCP preview does this from scene_asset_catalog images).`);
    }
    imagesByFace[face] = image;
  }
  const key = `${SKYBOX_FACES.map(face => environment.skybox[face]).join(',')}|${environment.environmentIntensity}|${environment.environmentRotation}`;
  if (builtMaps.has(key)) return builtMaps.get(key);
  const data = new Float32Array(MAP_WIDTH * MAP_HEIGHT * 3);
  for (let row = 0; row < MAP_HEIGHT; row++) {
    const polar = (row + 0.5) / MAP_HEIGHT * Math.PI;
    for (let column = 0; column < MAP_WIDTH; column++) {
      const azimuth = ((column + 0.5) / MAP_WIDTH - 0.5) * 2 * Math.PI;
      const lookup = skyboxFaceLookup(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), -Math.sin(polar) * Math.cos(azimuth));
      sampleFace(imagesByFace[lookup.face], lookup.u, lookup.v, data, (row * MAP_WIDTH + column) * 3);
    }
  }
  const map = createEnvironmentMap({ width: MAP_WIDTH, height: MAP_HEIGHT, data, intensity: environment.environmentIntensity, rotation: environment.environmentRotation, showBackground: true });
  builtMaps.set(key, map);
  return map;
}
