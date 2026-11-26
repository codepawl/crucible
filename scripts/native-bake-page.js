// The page side of the native tracer (Cook, @codepawlhq/cook), shared by the agent preview page and the bench harness. The
// tracer runs in the host process; the host exposes it on the page as `__crucibleNativeBake` (see the agent runtime), and
// everything here packs a scene into the tables it reads and unpacks its answer.
import { appendNativeGridVolumes, nativeGridVolumes, withoutLocalVolumes } from '../src/path-tracer-native-volumes.js';
import { withoutWaterMedia } from '../src/path-tracer-water-medium.js';

const LIGHT_RECORD_BYTES = 128;
const LIGHT_TYPE_OFFSET = 12;
const LIGHT_FLAGS_OFFSET = 28;
const LIGHT_TYPE_SUN = 4;
const LIGHT_FLAG_CAMERA_VISIBLE = 4;

// The v1 parameter block has no bit for sun.cameraVisible, so the v1-to-v2 upgrade of a flattened scene drops it.
function markFlattenedSunCameraVisible(input) {
  if (!input?.lights || !(input.lightCount > 0)) return;
  const view = new DataView(input.lights.buffer, input.lights.byteOffset, input.lights.byteLength);
  for (let index = 0; index < input.lightCount; index++) {
    const base = index * LIGHT_RECORD_BYTES;
    if (view.getUint32(base + LIGHT_TYPE_OFFSET, true) === LIGHT_TYPE_SUN) {
      view.setUint32(base + LIGHT_FLAGS_OFFSET, view.getUint32(base + LIGHT_FLAGS_OFFSET, true) | LIGHT_FLAG_CAMERA_VISIBLE, true);
    }
  }
}

function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function bytesFromBase64(data) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(data);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Each typed array of a packed native input as base64 bytes, keyed by table name. */
export function encodeNativeTables(input) {
  const tables = {};
  for (const [name, values] of Object.entries(input)) {
    if (ArrayBuffer.isView(values)) tables[name] = bytesToBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  }
  return tables;
}

/** Each typed array of a packed native input as its bytes (a view of the same memory, not a copy), keyed by table name. */
export function nativeTableBytes(input) {
  const tables = {};
  for (const [name, values] of Object.entries(input)) {
    if (ArrayBuffer.isView(values)) tables[name] = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  }
  return tables;
}

/**
 * A FORMAT-v2 input (an instanced scene) as the job export: the tables (base64 unless `tables` passes them in another form),
 * the array type of each table and the record counts, which is all the job runner needs to rebuild the input for the
 * "cycles" kernel.
 */
export function encodeNativeInputV2(input, tables = encodeNativeTables(input)) {
  const counts = {};
  const types = {};
  for (const [name, value] of Object.entries(input)) {
    if (ArrayBuffer.isView(value)) types[name] = value.constructor.name;
    else if (typeof value === 'number') counts[name] = value;
  }
  return { schemaVersion: input.schemaVersion, tables, types, counts };
}

// The triangle bound of a scene exported to the "cycles" kernel (see buildTraceScene's maximumTriangles); the legacy kernel and every
// other tracer keep the 400,000 of the CPU and WebGL paths.
export const NATIVE_JOB_MAXIMUM_TRIANGLES = 1_500_000;
// The instance bound of the same export (see buildTraceScene's maximumInstances).
export const NATIVE_JOB_MAXIMUM_INSTANCES = 1_000_000;
// The point, spot and area lights of the same export together (see buildTraceScene's maximumLights).
export const NATIVE_JOB_MAXIMUM_LIGHTS = 256;
// The parts of a flattened export, and the distinct geometries of an instanced one (see buildTraceScene's maximumParts).
export const NATIVE_JOB_MAXIMUM_PARTS = 1_000_000;
// The triangle bound of an export that travels in chunks (`transport: 'chunks'`) when the adapter capacity is not known: no
// single message bounds it. With the capacity, `chunkedTriangleBound` follows what the adapter holds.
export const NATIVE_CHUNKED_DEFAULT_TRIANGLES = 4_000_000;
// The most unique triangles a chunked export packs whatever the adapter reports (the bound buildTraceScene accepts for the native
// tracer): the page packs them in memory, so a bound is kept even for a card that reports room for more.
export const NATIVE_CHUNKED_MAXIMUM_TRIANGLES = 16_000_000;

/**
 * The unique triangle bound of a chunked export: what the adapter holds (`maxUniqueTriangles`, from Cook's readAdapterCapacity),
 * between the unchecked default bound of NATIVE_JOB_MAXIMUM_TRIANGLES and NATIVE_CHUNKED_MAXIMUM_TRIANGLES. Without a usable
 * limit it is NATIVE_CHUNKED_DEFAULT_TRIANGLES. A scene over the adapter limit but under the ceiling is refused with the exact
 * count and what to drop, so the bound never has to guess a margin: the engine already leaves one in the limit it reports.
 */
export function chunkedTriangleBound(adapterTriangleLimit) {
  if (!Number.isFinite(adapterTriangleLimit) || adapterTriangleLimit < 1) return NATIVE_CHUNKED_DEFAULT_TRIANGLES;
  return Math.min(NATIVE_CHUNKED_MAXIMUM_TRIANGLES, Math.max(NATIVE_JOB_MAXIMUM_TRIANGLES, Math.floor(adapterTriangleLimit)));
}
// The bytes of a table that one chunk carries. A multiple of 3, so every chunk but the last is base64 without padding.
export const NATIVE_EXPORT_CHUNK_BYTES = 48 * 1024 * 1024;

// Every table of the export travels as base64 inside one evaluate result, one JSON string, and V8 refuses a string above
// 536,870,888 characters. The bounds above are independent (about 299 characters per unique triangle, 214 per instance whose material record is shared
// and up to 555 per instance with a record of its own), so the export checks the sum of its real tables against this share of the limit; the rest is the JSON around the tables.
export const V8_MAXIMUM_STRING_LENGTH = 536_870_888;
export const NATIVE_EXPORT_MAXIMUM_CHARACTERS = Math.floor(V8_MAXIMUM_STRING_LENGTH * 0.95);

/** The base64 length of tables of these byte lengths: `4 * ceil(bytes / 3)` each, summed. */
export function encodedExportLength(byteLengths) {
  return byteLengths.reduce((total, bytes) => total + 4 * Math.ceil(bytes / 3), 0);
}

/**
 * Refuses tables, given as `[name, byteLength]` pairs, that would not fit one message. The error carries `exportTooLarge`, so the
 * export rethrows it (like `texturePoolFull`) and the job reports it instead of trying another packing of the same scene.
 */
export function requireTableSizesFit(tables) {
  const total = encodedExportLength(tables.map(([, bytes]) => bytes));
  if (total <= NATIVE_EXPORT_MAXIMUM_CHARACTERS) return;
  const largest = [...tables].sort((first, second) => second[1] - first[1]).slice(0, 3).map(([name, bytes]) => `${name} ${encodedExportLength([bytes])}`).join(', ');
  const error = new RangeError(`The native scene export is ${total} base64 characters in total (largest tables: ${largest}), over the ${NATIVE_EXPORT_MAXIMUM_CHARACTERS} one message can carry. Pass fewer parts (each instance takes about 214 characters, 555 when its material is not shared with another part), fewer unique triangles (about 299 each), or smaller textures.`);
  error.exportTooLarge = true;
  throw error;
}

/** `requireTableSizesFit` over the typed-array tables of a packed input. */
export function requireExportFits(input) {
  requireTableSizesFit(Object.entries(input).filter(([, values]) => ArrayBuffer.isView(values)).map(([name, values]) => [name, values.byteLength]));
}

const EXPORT_TRANSPORTS = ['message', 'chunks'];

// The tables of an export in the form its transport carries: base64 that fits one message, or the bytes for the chunk reader.
function tablesForTransport(input, transport) {
  if (transport === 'chunks') return nativeTableBytes(input);
  requireExportFits(input);
  return encodeNativeTables(input);
}

/**
 * Takes the byte tables out of an export made with `transport: 'chunks'`. `manifest` is the export with `chunks` in place of
 * `tables`: the byte length of every table and the chunk size, small enough for one message. `tables` are the bytes the
 * holder serves as one Blob until the reader has them all.
 */
export function splitExportForChunks(exported) {
  const { tables, ...rest } = exported;
  const byteLengths = {};
  for (const [name, bytes] of Object.entries(tables)) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(`splitExportForChunks: table "${name}" is not bytes. Export with transport "chunks" to get byte tables.`);
    }
    byteLengths[name] = bytes.byteLength;
  }
  return { manifest: { ...rest, chunks: { tables: byteLengths, chunkBytes: NATIVE_EXPORT_CHUNK_BYTES } }, tables };
}

/**
 * The scene of a native render job as the tables the job runner traces. With the "cycles" kernel (`kernel`) every scene is
 * exported as FORMAT-v2, so its materials reach the kernel whole; parts that share a geometry stay instances when
 * `instancing` is on. A scene the packer refuses (copies of an emissive mesh that emit different triangles, say) is
 * exported flattened, and a scene whose FORMAT-v2 materials cannot be built is exported as the v1 tables the legacy kernel
 * reads; each says why in `instancing` and `instancingReason`, or `materialsReason`. `wholeMaterials` tells whether the
 * kernel gets whole materials. `modules` holds buildTraceScene, resolveTexture, buildNativeInput, buildJobNativeInput,
 * buildFlattenedJobNativeInput, `pack` (src/path-tracer-gpu-pack.js) and `gridVolumeInput` (`@codepawlhq/cook/grid-volume-input`,
 * needed only when the scene has a grid local volume), which the page loads on demand. A grid local volume is drawn by the
 * "cycles" kernel; any other local volume is refused.
 * `transport` is "message" (the default: every table as base64, all of them within one message) or "chunks": the tables stay
 * bytes for `splitExportForChunks`, no message bounds them, and the triangle bound is NATIVE_CHUNKED_MAXIMUM_TRIANGLES.
 */
export function exportNativeSceneTables({ parts, environment, camera, options, kernel, instancing, modules, transport = 'message', maximumTriangles: chunkedMaximumTriangles }) {
  if (!EXPORT_TRANSPORTS.includes(transport)) {
    throw new RangeError(`exportNativeSceneTables: transport must be "message" or "chunks", got ${JSON.stringify(transport)}.`);
  }
  const { buildTraceScene, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack, gridVolumeInput } = modules;
  const wholeMaterials = kernel === 'cycles';
  const maximumTriangles = transport === 'chunks' ? (chunkedMaximumTriangles ?? NATIVE_CHUNKED_DEFAULT_TRIANGLES) : NATIVE_JOB_MAXIMUM_TRIANGLES;
  if (!Number.isInteger(maximumTriangles) || maximumTriangles < 1 || maximumTriangles > NATIVE_CHUNKED_MAXIMUM_TRIANGLES) {
    throw new RangeError(`exportNativeSceneTables: maximumTriangles must be an integer from 1 to ${NATIVE_CHUNKED_MAXIMUM_TRIANGLES}, got ${JSON.stringify(chunkedMaximumTriangles)}. Pass chunkedTriangleBound(capacity.maxUniqueTriangles).`);
  }
  const nativeLimits = wholeMaterials ? { maximumTriangles, maximumInstances: NATIVE_JOB_MAXIMUM_INSTANCES, maximumLights: NATIVE_JOB_MAXIMUM_LIGHTS, maximumParts: NATIVE_JOB_MAXIMUM_PARTS } : {};
  let traceScene = buildTraceScene(parts, environment, { instancing: wholeMaterials && instancing === true, instanceNormalMappedParts: wholeMaterials, ...nativeLimits });
  // The depth tint under thin water (#2294) is a grid only the "cycles" kernel draws; the legacy kernel draws the water clear.
  if (!wholeMaterials && traceScene.localVolumes) {
    const { localVolumes, ...withoutVolumes } = traceScene;
    traceScene = withoutWaterMedia(localVolumes) ? traceScene : withoutVolumes;
  }
  const authoredVolumeCount = (traceScene.localVolumes ?? []).filter(volume => volume.waterMedium !== true).length;
  // Cook draws grid local volumes. Its packers refuse `localVolumes`, so the grids go in after them; any other volume kind is refused here.
  const gridVolumes = nativeGridVolumes(traceScene.localVolumes);
  const withGrids = input => (gridVolumes ? appendNativeGridVolumes(input, gridVolumes, gridVolumeInput) : input);
  if (gridVolumes) traceScene = withoutLocalVolumes(traceScene);
  let flattenedBecause;
  if (traceScene.instances) {
    try {
      const input = withGrids(buildJobNativeInput(traceScene, camera, options, pack, resolveTexture));
      return { ...encodeNativeInputV2(input, tablesForTransport(input, transport)), triangleCount: input.triangleCount, triangles: input.triangleCount, instances: input.instanceCount, wholeMaterials };
    } catch (error) {
      // A scene over the texture pool stays over it flattened: the caller gets that refusal, not a v1 atlas one.
      if (!(error instanceof RangeError) || error.texturePoolFull || error.exportTooLarge) throw error;
      flattenedBecause = error.message;
      traceScene = flattenRefusedScene(buildTraceScene, parts, environment, nativeLimits, flattenedBecause);
      if (gridVolumes) traceScene = withoutLocalVolumes(traceScene);
    }
  }
  const instancingNote = flattenedBecause === undefined ? {} : { instancing: 'flattened', instancingReason: flattenedBecause };
  let materialsReason;
  if (wholeMaterials) {
    try {
      const input = withGrids(buildFlattenedJobNativeInput(traceScene, camera, options, pack, resolveTexture));
      if (traceScene.lights.sun?.cameraVisible === true) markFlattenedSunCameraVisible(input);
      return { ...encodeNativeInputV2(input, tablesForTransport(input, transport)), triangleCount: input.triangleCount, triangles: traceScene.indices.length / 3, wholeMaterials, ...instancingNote };
    } catch (error) {
      if (error.texturePoolFull || error.exportTooLarge) throw error;
      // The scene stays traceable: the v1 tables carry what the kernel read before, and the report says why they were used.
      materialsReason = error.message;
    }
  }
  if (authoredVolumeCount > 0) {
    throw new RangeError(`A grid local volume needs the "cycles" kernel with whole materials, and this scene could not be packed for it${materialsReason === undefined ? ' (the kernel is not "cycles")' : `: ${materialsReason}`}. Use backend "cpu" or remove the volume.`);
  }
  if (traceScene.partRayVisibility && !wholeMaterials) {
    throw new TypeError('A part sets rayVisibility to hide from a ray kind, which only the "cycles" kernel can carry. Use kernel "cycles", or drop the rayVisibility of the part.');
  }
  // The v1 tables of the "cycles" job fallback cannot carry visibility: the scene is drawn without it, and the report says so.
  const visibilityNote = traceScene.partRayVisibility ? { rayVisibility: 'ignored', rayVisibilityReason: materialsReason } : {};
  const input = buildNativeInputOrExplain(buildNativeInput, { ...traceScene, partRayVisibility: null }, camera, options, pack, materialsReason);
  return { tables: tablesForTransport(input, transport), triangleCount: input.triangleCount, triangles: traceScene.indices.length / 3, wholeMaterials: false,
    ...(materialsReason === undefined ? {} : { materialsReason }), ...visibilityNote, ...instancingNote };
}

// The v1 tables are the fallback for a scene whose FORMAT-v2 materials failed; when they fail too, the error keeps the first reason.
function buildNativeInputOrExplain(buildNativeInput, traceScene, camera, options, pack, materialsReason) {
  try {
    return buildNativeInput(traceScene, camera, options, pack);
  } catch (error) {
    if (materialsReason === undefined || !(error instanceof RangeError)) throw error;
    throw new RangeError(`${error.message} The FORMAT-v2 export had already failed: ${materialsReason}`);
  }
}

// The flattened scene of parts the packer refused as instances. Every copy counts against the bound once flattened, so a scene
// that fitted as instances can be over it; the error then names the packer's refusal, since the geometry was already shared.
function flattenRefusedScene(buildTraceScene, parts, environment, nativeLimits, refusal) {
  try {
    return buildTraceScene(parts, environment, nativeLimits);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new RangeError(`The scene could not stay instanced (${refusal}) and is too large once every copy is flattened: ${error.message}`);
  }
}

function floatsFromBase64(data) {
  const bytes = bytesFromBase64(data);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

function floatsToBase64(values) {
  return bytesToBase64(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}

/**
 * The texel tracer of the light bake on the native backend: the packed scene and the texels go to the host, which traces
 * them with ray queries and answers with the light that reaches each texel. Same arguments and answer as `traceTexelsOnGpu`.
 */
export async function traceTexelsOnNative(scene, texels, options) {
  const [pack, { buildNativeTexelInput }] = await Promise.all([import('../src/path-tracer-gpu-pack.js'), import('@codepawlhq/cook/pack-input')]);
  const input = buildNativeTexelInput(scene, { texelCount: texels.count, samples: options.samples, bounces: options.bounces, seed: options.seed, fireflyClamp: options.fireflyClamp }, pack);
  const answer = await globalThis.__crucibleNativeBake({
    action: 'trace',
    tables: encodeNativeTables(input),
    triangleCount: input.triangleCount,
    samples: options.samples,
    texelCount: texels.count,
    points: floatsToBase64(texels.points.subarray(0, texels.count * 3)),
    normals: floatsToBase64(texels.normals.subarray(0, texels.count * 3)),
  });
  if (answer.error) throw new Error(answer.error);
  return { radiance: floatsFromBase64(answer.radiance), escaped: floatsFromBase64(answer.escaped), gpu: answer.adapter, compileSeconds: answer.compileSeconds };
}

/** `traceTexelsOnNative` when the host offers a tracer that can run here, otherwise undefined. */
export async function nativeTexelTracerIfAvailable() {
  if (typeof globalThis.__crucibleNativeBake !== 'function') return undefined;
  const status = await globalThis.__crucibleNativeBake({ action: 'probe' });
  return status.available ? traceTexelsOnNative : undefined;
}
