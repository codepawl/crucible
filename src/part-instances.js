// One part that draws many copies: `part.instances = { matrices, colors?, opacities?, version }`.
// The renderer expands the list into one internal stand-in per copy, so batching, per-instance culling, shadows and
// levels of detail work as they do for separate parts, while the caller keeps one part object and one typed array.
import { mat3 } from 'gl-matrix';
import { MaterialSnapshot } from './material-snapshot.js';

/** The most copies one part may draw; the same cap as EXT_mesh_gpu_instancing nodes in src/gltf.js. */
export const MAX_PART_INSTANCES = 65_536;

const normalScratch = mat3.create();

function describeLength(array) {
  return array?.length ?? 'missing';
}

function requireFloatArray(part, field, array, expectedLength, advice) {
  if (!(array instanceof Float32Array) || array.length !== expectedLength) {
    throw new TypeError(`instances.${field} of ${part.name} must be a Float32Array of ${expectedLength} numbers (${advice}), got ${array instanceof Float32Array ? `${describeLength(array)} numbers` : typeof array}.`);
  }
  // Every float is in range, so the array is finite exactly when 0 * value is 0 and not NaN for all of them.
  let zeroSum = 0;
  for (let index = 0; index < expectedLength; index++) zeroSum += array[index] * 0;
  if (zeroSum !== 0) throw new RangeError(`instances.${field} of ${part.name} holds NaN or Infinity. Pass finite numbers.`);
}

/** Checks `part.instances` and returns how many copies it holds. Throws an error that says what to pass instead. */
export function validatePartInstances(part) {
  const instances = part.instances;
  if (instances === null || typeof instances !== 'object') {
    throw new TypeError(`instances of ${part.name} must be an object { matrices: Float32Array of 16 numbers per copy, version: 0 }.`);
  }
  const matrices = instances.matrices;
  if (!(matrices instanceof Float32Array) || matrices.length < 16 || matrices.length % 16 !== 0) {
    throw new TypeError(`instances.matrices of ${part.name} must be a Float32Array of 4x4 column-major matrices (a multiple of 16 numbers, at least 16), got ${matrices instanceof Float32Array ? `${matrices.length} numbers` : typeof matrices}.`);
  }
  const count = matrices.length / 16;
  if (count > MAX_PART_INSTANCES) throw new RangeError(`instances of ${part.name} hold ${count} copies, above the limit of ${MAX_PART_INSTANCES}. Split them over several parts.`);
  requireFloatArray(part, 'matrices', matrices, count * 16, 'a multiple of 16');
  if (instances.colors !== undefined) requireFloatArray(part, 'colors', instances.colors, count * 3, 'red, green and blue per copy');
  if (instances.opacities !== undefined) {
    requireFloatArray(part, 'opacities', instances.opacities, count, 'one per copy');
    const alphaMode = part.material?.alphaMode ?? 'opaque';
    if (alphaMode !== 'blend' && alphaMode !== 'add') throw new TypeError(`instances.opacities of ${part.name} need a material with alphaMode 'blend' or 'add', got '${alphaMode}'. Remove opacities, or set the alpha mode.`);
  }
  if (instances.version !== undefined && !Number.isInteger(instances.version)) throw new TypeError(`instances.version of ${part.name} must be an integer that you raise after editing the arrays in place.`);
  if (part.skin || part.morph) throw new TypeError(`${part.name} is skinned or morphed, which cannot draw an instance list yet. Draw separate parts, or use a crowd.`);
  return count;
}

/** Writes a copy's own colour and opacity over what the material packed. Called by the renderer for every stand-in. */
export function applyInstanceStyle(data, offset, style, material, opacityOffset) {
  const instances = style.instances;
  const colors = instances.colors;
  if (colors) {
    const source = style.index * 3;
    data[offset + 25] = colors[source];
    data[offset + 26] = colors[source + 1];
    data[offset + 27] = colors[source + 2];
    if (!material.emissiveColor) {
      data[offset + 38] = colors[source];
      data[offset + 39] = colors[source + 1];
      data[offset + 40] = colors[source + 2];
    }
  }
  if (instances.opacities) data[offset + opacityOffset] *= instances.opacities[style.index];
}

/** Multiplies the part matrix by one copy's matrix (read at `offset` of `copies`) into `out`; column major. */
function multiplyAt(out, parent, copies, offset) {
  for (let column = 0; column < 4; column++) {
    const base = offset + column * 4;
    const b0 = copies[base];
    const b1 = copies[base + 1];
    const b2 = copies[base + 2];
    const b3 = copies[base + 3];
    out[column * 4] = parent[0] * b0 + parent[4] * b1 + parent[8] * b2 + parent[12] * b3;
    out[column * 4 + 1] = parent[1] * b0 + parent[5] * b1 + parent[9] * b2 + parent[13] * b3;
    out[column * 4 + 2] = parent[2] * b0 + parent[6] * b1 + parent[10] * b2 + parent[14] * b3;
    out[column * 4 + 3] = parent[3] * b0 + parent[7] * b1 + parent[11] * b2 + parent[15] * b3;
  }
}

/**
 * The stand-ins of one instanced part. A stand-in inherits every field of the part (geometry, material, lods) and owns its
 * world matrix and its slot in the instance list. A copy whose matrix cannot be inverted (a zero scale) is hidden.
 */
export class InstanceGroup {
  constructor(part) {
    this.part = part;
    this.instances = part.instances;
    this.count = validatePartInstances(part);
    this.proxies = Array.from({ length: this.count }, (unused, index) => {
      const proxy = Object.create(part);
      proxy.name = `${part.name}[${index}]`;
      proxy.instances = undefined;
      proxy.matrix = new Float32Array(16);
      proxy.instanceStyle = { instances: part.instances, index };
      return proxy;
    });
    this.matrixSnapshot = new Float32Array(16);
    this.refreshMatrices();
  }

  /** Recomputes every stand-in's world matrix and hidden flag, and remembers what it was computed from. */
  refreshMatrices() {
    const { part, proxies } = this;
    const copies = part.instances.matrices;
    for (let index = 0; index < proxies.length; index++) {
      const proxy = proxies[index];
      multiplyAt(proxy.matrix, part.matrix, copies, index * 16);
      const invertible = mat3.normalFromMat4(normalScratch, proxy.matrix) !== null;
      if (invertible) delete proxy.visible;
      else proxy.visible = false;
    }
    this.matrixSnapshot.set(part.matrix);
    this.version = part.instances.version ?? 0;
    this.hidden = part.visible === false || part.visibility?.visible === false;
    this.opacityScale = part.opacityScale?.value;
    this.materialSnapshot = MaterialSnapshot.of(part.material);
  }

  /** True when the part's matrix, visibility, fade or version differs from the last refresh. */
  isStale() {
    const { part } = this;
    if ((part.instances.version ?? 0) !== this.version || part.opacityScale?.value !== this.opacityScale) return true;
    if (this.hidden !== (part.visible === false || part.visibility?.visible === false)) return true;
    for (let index = 0; index < 16; index++) if (part.matrix[index] !== this.matrixSnapshot[index]) return true;
    return false;
  }

  /** True when the material changed in a way that the batch must check again. */
  materialChanged() {
    return !this.materialSnapshot || !this.materialSnapshot.matches(this.part.material);
  }
}

/**
 * Replaces each part with an instance list by its stand-ins. `previousGroups` keeps the stand-ins (and so the batches) of
 * a part whose list did not change shape. Returns the parts to render and the groups by owning part.
 */
export function expandInstancedParts(parts, previousGroups) {
  let groups = null;
  let expanded = null;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part.instances === undefined) {
      expanded?.push(part);
      continue;
    }
    if (!expanded) expanded = parts.slice(0, index);
    groups ??= new Map();
    const previous = previousGroups?.get(part);
    const reusable = previous && previous.instances === part.instances && previous.count === validatePartInstances(part);
    const group = reusable ? previous : new InstanceGroup(part);
    if (reusable) group.refreshMatrices();
    groups.set(part, group);
    for (const proxy of group.proxies) expanded.push(proxy);
  }
  return { parts: expanded ?? parts, groups };
}
