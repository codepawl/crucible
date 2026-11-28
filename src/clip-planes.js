// Clip planes: world-space planes that cut away the part of a model on their far side, in the colour pass and in the shadow
// pass, so a section stays lit and shadowed as the cut part. docs/clip-planes.md has the guide.
import { asGlazeBackend, backendFor } from './glaze-backend.js';
import { registerShaderFeatureCode } from './shader-registry.js';

export const CLIP_PLANES_FEATURE = 'clipPlanes';

/** The most planes one draw applies. The shader's plane array has this length. */
export const MAX_CLIP_PLANES = 4;

const FLOATS_PER_PLANE = 4;
const CLIP_UNIFORM_NAMES = Object.freeze(['clipPlanes[0]', 'clipPlaneCount']);

const PLANE_DECLARATIONS = `uniform vec4 clipPlanes[${MAX_CLIP_PLANES}];
uniform int clipPlaneCount;
void discardClipped(vec3 position) {
  for (int index = 0; index < ${MAX_CLIP_PLANES}; index++) {
    if (index >= clipPlaneCount) break;
    if (dot(clipPlanes[index].xyz, position) + clipPlanes[index].w < 0.0) discard;
  }
}
`;

const DISCARD_CALL = (position) => `  discardClipped(${position});\n`;

/** Adds the world position and the plane test to the shadow shaders: the vertex shader passes the position on, the fragment shader discards. */
function addToShadowShader(source) {
  if (source.includes('lightProjection * world')) {
    return source
      .replace('out vec2 textureUV;', () => 'out vec2 textureUV;\nout vec3 clippedPosition;')
      .replace('textureUV = uv;', () => 'textureUV = uv;\n  clippedPosition = world.xyz;');
  }
  return source
    .replace('precision highp float;', () => `precision highp float;\nin vec3 clippedPosition;\n${PLANE_DECLARATIONS}`)
    .replace(/void main\(\) \{\n/, (start) => `${start}${DISCARD_CALL('clippedPosition')}`);
}

registerShaderFeatureCode(CLIP_PLANES_FEATURE, Object.freeze({
  declarations: PLANE_DECLARATIONS,
  mainStart: DISCARD_CALL('worldPosition'),
  depth: addToShadowShader,
}));

/** Adds the plane test to the liquid and foam fragment shader, which has its own program and a worldPosition input. */
export function addClipPlanesToLiquidShader(source) {
  return source
    .replace('precision highp float;\n', () => `precision highp float;\n${PLANE_DECLARATIONS}`)
    .replace('void main() {\n', (start) => `${start}${DISCARD_CALL('worldPosition')}`);
}

function planeError(label, index, problem) {
  return new Error(`${label} plane ${index} ${problem}. Fix: pass { normal: [x, y, z], constant } with finite numbers; a point p stays when dot(normal, p) + constant is 0 or more.`);
}

/**
 * Checks `planes` (an array of { normal: [x, y, z], constant }, at most MAX_CLIP_PLANES) and writes them to `target` as one
 * vec4 each: the unit normal and the constant scaled with it. Returns the number of planes written.
 */
export function packClipPlanes(planes, target, label = 'clipPlanes') {
  if (!Array.isArray(planes)) throw new TypeError(`${label} must be an array of planes. Fix: pass [] for none, or [{ normal: [0, 1, 0], constant: -1 }].`);
  if (planes.length > MAX_CLIP_PLANES) throw new RangeError(`${label} has ${planes.length} planes and a draw takes at most ${MAX_CLIP_PLANES}. Fix: pass ${MAX_CLIP_PLANES} or fewer.`);
  planes.forEach((plane, index) => {
    const { normal, constant } = plane ?? {};
    if (!Array.isArray(normal) || normal.length !== 3 || !normal.every(Number.isFinite)) throw planeError(label, index, 'needs a normal of three finite numbers');
    if (!Number.isFinite(constant)) throw planeError(label, index, 'needs a finite constant');
    const length = Math.hypot(...normal);
    if (length === 0) throw planeError(label, index, 'has a normal of length 0');
    const offset = index * FLOATS_PER_PLANE;
    target[offset] = normal[0] / length;
    target[offset + 1] = normal[1] / length;
    target[offset + 2] = normal[2] / length;
    target[offset + 3] = constant / length;
  });
  return planes.length;
}

const partPlaneValues = new Float32Array(MAX_CLIP_PLANES * FLOATS_PER_PLANE);

/** The uniform locations of the clip planes in `program`. The same names serve the colour and the shadow program. */
export function clipPlaneLocations(contextOrBackend, program) {
  const backend = asGlazeBackend(contextOrBackend);
  return Object.fromEntries(CLIP_UNIFORM_NAMES.map((name) => [name, backend.uniformLocation(program, name)]));
}

/** Sets the planes of `batch` on the program in use: the planes of its first part when it has any, else the renderer's. */
export function bindClipPlanes(renderer, batch, locations) {
  const own = batch.parts[0].clipPlanes;
  let values = renderer.clipPlaneValues;
  let count = renderer.clipPlaneCount;
  if (own !== undefined) {
    count = packClipPlanes(own, partPlaneValues, `Part "${batch.parts[0].name}" clipPlanes`);
    values = partPlaneValues;
  }
  const backend = backendFor(renderer);
  backend.uniform4fv(locations['clipPlanes[0]'], values);
  backend.uniform1i(locations.clipPlaneCount, count);
}

/**
 * True when the planes that cut any draw differ from the last call. The shadow map is redrawn only when its casters change, so
 * the renderer asks this before each frame: a plane that moved changes what the map holds.
 */
export function clipPlanesChanged(renderer) {
  const parts = [`${renderer.clipPlaneCount}:${renderer.clipPlaneValues.slice(0, renderer.clipPlaneCount * FLOATS_PER_PLANE).join(',')}`];
  for (const batch of renderer.batches) {
    if (batch.parts[0].clipPlanes !== undefined && batch.castShadow) parts.push(JSON.stringify(batch.parts[0].clipPlanes));
  }
  const signature = parts.join('|');
  const changed = signature !== renderer.clipPlaneSignature;
  renderer.clipPlaneSignature = signature;
  return changed;
}
