import { createSlicer } from './cooperative.js';
import { createEnvironmentMap, MAXIMUM_ENVIRONMENT_SIZE } from './environment.js';
import { alignEnvironmentRows } from './environment-orientation.js';
import { DEFAULT_SUN_ANGULAR_RADIUS } from './environment-shading.js';

const MAXIMUM_FILE_BYTES = 256 * 1024 ** 2;
const MINIMUM_RUN_LENGTH_WIDTH = 8;
const MAXIMUM_RUN_LENGTH_WIDTH = 32767;

function readLine(bytes, start) {
  let end = start;
  while (end < bytes.length && bytes[end] !== 0x0a) end++;
  if (end >= bytes.length) throw new Error('Radiance HDR header is truncated.');
  const text = String.fromCharCode(...bytes.subarray(start, Math.min(end, start + 256)));
  return { text: text.replace(/\r$/, ''), next: end + 1 };
}

function parseHeader(bytes) {
  let line = readLine(bytes, 0);
  if (!line.text.startsWith('#?')) throw new Error('Not a Radiance HDR file: missing #? signature.');
  let formatFound = false;
  let position = line.next;
  for (;;) {
    line = readLine(bytes, position);
    position = line.next;
    if (line.text === '') break;
    if (line.text.startsWith('FORMAT=')) {
      if (line.text !== 'FORMAT=32-bit_rle_rgbe') throw new Error(`Unsupported Radiance HDR format: ${line.text}.`);
      formatFound = true;
    }
  }
  if (!formatFound) throw new Error('Radiance HDR header has no FORMAT=32-bit_rle_rgbe line.');
  line = readLine(bytes, position);
  const resolution = /^-Y (\d+) \+X (\d+)$/.exec(line.text);
  if (!resolution) throw new Error('Unsupported Radiance HDR orientation. Only "-Y height +X width" is supported.');
  const height = Number(resolution[1]);
  const width = Number(resolution[2]);
  if (width < 1 || height < 1 || width > MAXIMUM_ENVIRONMENT_SIZE || height > MAXIMUM_ENVIRONMENT_SIZE) throw new RangeError('Radiance HDR dimensions are outside the supported range.');
  return { width, height, dataStart: line.next };
}

function readRunLengthScanline(bytes, startPosition, width, scanline) {
  let position = startPosition + 4;
  for (let channel = 0; channel < 4; channel++) {
    let column = 0;
    while (column < width) {
      if (position >= bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
      const count = bytes[position++];
      const isRun = count > 128;
      const length = isRun ? count - 128 : count;
      if (length === 0 || column + length > width) throw new Error('Radiance HDR run length is invalid.');
      if (isRun) {
        if (position >= bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
        const value = bytes[position++];
        for (let index = 0; index < length; index++) scanline[(column + index) * 4 + channel] = value;
      } else {
        if (position + length > bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
        for (let index = 0; index < length; index++) scanline[(column + index) * 4 + channel] = bytes[position + index];
        position += length;
      }
      column += length;
    }
  }
  return position;
}

// Flat scanlines may use the pre-1991 run form: a pixel of 1,1,1 repeats the previous pixel by its exponent byte,
// and each further repeat in a row shifts the count up by 8 bits.
function readFlatScanline(bytes, startPosition, width, scanline) {
  let position = startPosition;
  let repeatShift = 0;
  let column = 0;
  while (column < width) {
    if (position + 4 > bytes.length) throw new Error('Radiance HDR pixel data is truncated.');
    const isRepeat = bytes[position] === 1 && bytes[position + 1] === 1 && bytes[position + 2] === 1;
    if (!isRepeat) {
      scanline.set(bytes.subarray(position, position + 4), column * 4);
      position += 4;
      column++;
      repeatShift = 0;
      continue;
    }
    const length = bytes[position + 3] << repeatShift;
    if (column === 0 || length === 0 || column + length > width) throw new Error('Radiance HDR repeat run is invalid.');
    for (let index = 0; index < length; index++) scanline.copyWithin((column + index) * 4, (column - 1) * 4, column * 4);
    position += 4;
    column += length;
    repeatShift += 8;
  }
  return position;
}

function startsRunLengthScanline(bytes, position, width) {
  return width >= MINIMUM_RUN_LENGTH_WIDTH && width <= MAXIMUM_RUN_LENGTH_WIDTH
    && bytes[position] === 2 && bytes[position + 1] === 2
    && ((bytes[position + 2] << 8) | bytes[position + 3]) === width;
}

// Old-format rows are the smallest: one pixel and at most two repeat pixels (255 and 65280 pixels each), and a
// run-length row never costs less than that, so this bound holds for both.
function allocatePixels(availableBytes, width, height) {
  const repeatPixels = Math.min(2, Math.ceil(Math.log(width) / Math.log(256)));
  if (availableBytes < height * 4 * (1 + repeatPixels)) {
    throw new RangeError(`Radiance HDR pixel data is truncated: the header says ${width}x${height} but the file holds ${availableBytes} bytes; pass the whole file.`);
  }
  return new Float32Array(width * height * 3);
}

function requireBytes(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  throw new TypeError('parseRadianceHdr needs an ArrayBuffer or Uint8Array.');
}

// Decodes one scanline per step, so a caller can run it to the end at once or hand the thread back between rows.
function* decodeRadianceRows(buffer) {
  const bytes = requireBytes(buffer);
  if (bytes.length > MAXIMUM_FILE_BYTES) throw new RangeError('Radiance HDR file is larger than 256 MiB.');
  const { width, height, dataStart } = parseHeader(bytes);
  let data;
  const scanline = new Uint8Array(width * 4);
  let position = dataStart;
  for (let row = 0; row < height; row++) {
    if (startsRunLengthScanline(bytes, position, width)) {
      position = readRunLengthScanline(bytes, position, width, scanline);
    } else {
      position = readFlatScanline(bytes, position, width, scanline);
    }
    data ??= allocatePixels(bytes.length - dataStart, width, height);
    for (let column = 0; column < width; column++) {
      const exponent = scanline[column * 4 + 3];
      const target = (row * width + column) * 3;
      if (exponent === 0) continue;
      const scale = 2 ** (exponent - 136);
      data[target] = scanline[column * 4] * scale;
      data[target + 1] = scanline[column * 4 + 1] * scale;
      data[target + 2] = scanline[column * 4 + 2] * scale;
    }
    yield row;
  }
  return { width, height, data };
}

// Parses Radiance RGBE (.hdr) data into linear RGB floats, top row first.
export function parseRadianceHdr(buffer) {
  const rows = decodeRadianceRows(buffer);
  let step = rows.next();
  while (!step.done) step = rows.next();
  return step.value;
}

// The same result as parseRadianceHdr, with `checkpoint()` awaited between rows so a large map does not block the page.
export async function parseRadianceHdrInSlices(buffer, checkpoint) {
  const rows = decodeRadianceRows(buffer);
  let step = rows.next();
  while (!step.done) {
    await checkpoint();
    step = rows.next();
  }
  return step.value;
}

// Fetches a .hdr file (for example a 1k or 2k Poly Haven HDRI) and returns an environment map descriptor.
export async function loadHdri(url, { intensity, rotation, showBackground, backgroundBlur, signal, fetchImplementation = globalThis.fetch } = {}) {
  const response = await fetchImplementation(url, { signal });
  if (!response.ok) throw new Error(`HDRI download failed: HTTP ${response.status}.`);
  const parsed = await parseRadianceHdrInSlices(await response.arrayBuffer(), createSlicer());
  return createEnvironmentMap({ ...alignEnvironmentRows(parsed), intensity, rotation, showBackground, backgroundBlur });
}

export { createEnvironmentMap };

const SUN_PEAK_TO_MEAN_RATIO = 20;
const SUN_SEARCH_RADIUS = Math.PI / 18;

function luminanceAt(data, offset) {
  return 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
}

// Equirect pixel to a direction in the map's own frame (the inverse of the shader lookup, before `rotation`).
function mapDirection(column, row, width, height) {
  const azimuth = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
  const polar = ((row + 0.5) / height) * Math.PI;
  return [Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), -Math.sin(polar) * Math.cos(azimuth)];
}

// The shader turns a world direction into the map frame with a turn about +Y; this is the inverse.
function worldFromMapDirection([x, y, z], rotation) {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return [cosine * x + sine * z, y, -sine * x + cosine * z];
}

/**
 * Finds the sun in an HDR environment map: the brightest 3 by 3 block, then the luminance-weighted centre of the pixels
 * within 10 degrees of it that reach half its brightness, so a single hot pixel does not move it.
 * Returns `{ lightDirection, keyColor, keyIntensity }` (world direction toward the sun with `rotation` applied, colour
 * with its largest channel at 1, and `irradiance / PI` of the sun disc scaled by the map intensity), or `null` when the
 * peak is under 20 times the mean luminance, as on an overcast sky.
 */
export function sunFromEnvironmentMap(map) {
  const { width, height, channels, data } = map;
  const rowWeights = Float64Array.from({ length: height }, (_, row) => Math.sin(((row + 0.5) / height) * Math.PI));
  const luminance = new Float32Array(width * height);
  let weightedTotal = 0;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const value = luminanceAt(data, (row * width + column) * channels);
      luminance[row * width + column] = value;
      weightedTotal += value * rowWeights[row];
    }
  }
  const meanLuminance = weightedTotal / (rowWeights.reduce((sum, weight) => sum + weight, 0) * width);

  let peakValue = 0;
  let peakColumn = 0;
  let peakRow = 0;
  for (let row = 1; row < height - 1; row++) {
    for (let column = 0; column < width; column++) {
      let blockSum = 0;
      for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
          blockSum += luminance[(row + rowOffset) * width + ((column + columnOffset + width) % width)];
        }
      }
      if (blockSum / 9 > peakValue) {
        peakValue = blockSum / 9;
        peakColumn = column;
        peakRow = row;
      }
    }
  }
  if (!(peakValue > SUN_PEAK_TO_MEAN_RATIO * meanLuminance)) return null;

  const peakDirection = mapDirection(peakColumn, peakRow, width, height);
  const minimumCosine = Math.cos(SUN_SEARCH_RADIUS);
  const pixelSolidAngle = ((2 * Math.PI) / width) * (Math.PI / height);
  const centre = [0, 0, 0];
  const colorSum = [0, 0, 0];
  let irradiance = 0;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const value = luminance[row * width + column];
      if (value < peakValue * 0.5) continue;
      const direction = mapDirection(column, row, width, height);
      const cosine = direction[0] * peakDirection[0] + direction[1] * peakDirection[1] + direction[2] * peakDirection[2];
      if (cosine < minimumCosine) continue;
      const weight = value * rowWeights[row];
      for (let axis = 0; axis < 3; axis++) {
        centre[axis] += direction[axis] * weight;
        colorSum[axis] += data[(row * width + column) * channels + axis] * weight;
      }
      irradiance += value * rowWeights[row] * pixelSolidAngle * Math.max(cosine, 0);
    }
  }
  const length = Math.hypot(...centre);
  const brightest = Math.max(...colorSum);
  return {
    lightDirection: worldFromMapDirection(centre.map((component) => component / length), map.rotation),
    keyColor: colorSum.map((component) => component / brightest),
    keyIntensity: (irradiance * map.intensity) / Math.PI,
  };
}

function isPoint(point) {
  return Array.isArray(point) && point.length === 3 && point.every(Number.isFinite);
}

function requireBounds(bounds) {
  if (!isPoint(bounds?.min) || !isPoint(bounds?.max)) {
    throw new TypeError('keyLightFromHdri bounds must be { min, max } of three finite numbers each.');
  }
}

/**
 * Lights a scene from the HDRI sun. Spread the result into the renderer's `environment` and pass its `shadowBounds`:
 * `{ environment: { lightDirection, keyColor, keyIntensity }, shadowBounds }`. The shadow view looks at the middle of
 * `bounds` ({ min, max }) from the sun side and covers its bounding sphere. Without a distinct sun it returns `null`,
 * so the caller keeps its defaults.
 */
export function keyLightFromHdri(map, bounds) {
  requireBounds(bounds);
  const sun = sunFromEnvironmentMap(map);
  if (!sun) return null;
  const target = bounds.min.map((minimum, axis) => (minimum + bounds.max[axis]) / 2);
  const extent = Math.max(Math.hypot(...bounds.max.map((maximum, axis) => maximum - bounds.min[axis])) / 2, 1e-3);
  const eye = target.map((component, axis) => component + sun.lightDirection[axis] * extent * 2);
  const { lightDirection, keyColor, keyIntensity } = sun;
  return { environment: { lightDirection, keyColor, keyIntensity }, shadowBounds: { target, eye, extent, near: extent * 0.5, far: extent * 3.5 } };
}

// A pixel within the search radius belongs to the sun disc when it reaches this fraction of the peak. The glare around the
// disc is far below it, so it stays in the map as sky light and the background keeps its shape (#2875).
const SUN_DISC_FRACTION = 0.1;
// The colour that fills the disc is read from the pixels this far past its edge, or two pixels when the map is coarser.
const SUN_FILL_WIDTH = Math.PI / 180;

function angleFromCentre(map, column, row, centre) {
  const direction = mapDirection(column, row, map.width, map.height);
  return Math.acos(Math.min(1, direction[0] * centre[0] + direction[1] * centre[1] + direction[2] * centre[2]));
}

// The mean colour of the pixels between two angles from the centre, weighted by their solid angle.
function colorBetween(map, centre, innerAngle, outerAngle) {
  const { width, height, channels, data } = map;
  const sum = [0, 0, 0];
  let weight = 0;
  for (let row = 0; row < height; row++) {
    const rowWeight = Math.sin(((row + 0.5) / height) * Math.PI);
    for (let column = 0; column < width; column++) {
      const angle = angleFromCentre(map, column, row, centre);
      if (angle <= innerAngle || angle > outerAngle) continue;
      const offset = (row * width + column) * channels;
      for (let axis = 0; axis < 3; axis++) sum[axis] += data[offset + axis] * rowWeight;
      weight += rowWeight;
    }
  }
  return weight > 0 ? sum.map(component => component / weight) : null;
}

// The pixels of the sun disc: those near the centre that reach a tenth of the brightest one, and the angle the farthest one is at.
function sunDiscPixels(map, centre) {
  const { width, height, channels, data } = map;
  let peak = 0;
  const candidates = [];
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      if (angleFromCentre(map, column, row, centre) > SUN_SEARCH_RADIUS) continue;
      const value = luminanceAt(data, (row * width + column) * channels);
      candidates.push({ column, row, value });
      peak = Math.max(peak, value);
    }
  }
  const pixels = candidates.filter(candidate => candidate.value >= peak * SUN_DISC_FRACTION);
  const radius = Math.max(...pixels.map(pixel => angleFromCentre(map, pixel.column, pixel.row, centre)));
  return { pixels, radius };
}

/**
 * Takes the sun out of an HDR environment map so it can light the scene as a shadowed key light instead of reaching
 * every point through the unshadowed sky term (#2761). The pixels of the sun disc (those within 10 degrees of the sun
 * that reach a tenth of its peak) are set to the colour of the sky just past the disc's edge, so the glare around the sun
 * stays in the map and the background shows no patch (#2875). The energy taken out comes back as `environment`
 * (`{ lightDirection, keyColor, keyIntensity }`, the same convention as sunFromEnvironmentMap), and as the map's
 * `sunDisc`, so the background still shows the sun. Returns `{ map, environment }`, or `null` when the sky has no
 * distinct sun. The map passed in is not changed.
 */
export function splitHdriSun(map) {
  const sun = sunFromEnvironmentMap(map);
  if (!sun) return null;
  const { width, height, channels } = map;
  const centre = worldFromMapDirection(sun.lightDirection, -map.rotation);
  const disc = sunDiscPixels(map, centre);
  const ring = colorBetween(map, centre, disc.radius, disc.radius + Math.max(SUN_FILL_WIDTH, (4 * Math.PI) / width));
  if (!ring) return null;
  const ringLuminance = luminanceAt(ring, 0);
  const data = Float32Array.from(map.data);
  const pixelSolidAngle = ((2 * Math.PI) / width) * (Math.PI / height);
  const removed = [0, 0, 0];
  let irradiance = 0;
  for (const { column, row } of disc.pixels) {
    const rowSolidAngle = Math.sin(((row + 0.5) / height) * Math.PI) * pixelSolidAngle;
    const direction = mapDirection(column, row, width, height);
    const cosine = direction[0] * centre[0] + direction[1] * centre[1] + direction[2] * centre[2];
    const offset = (row * width + column) * channels;
    const value = luminanceAt(data, offset);
    if (!(value > ringLuminance)) continue;
    for (let axis = 0; axis < 3; axis++) {
      removed[axis] += Math.max(data[offset + axis] - ring[axis], 0) * rowSolidAngle;
      data[offset + axis] = ring[axis];
    }
    irradiance += (value - ringLuminance) * rowSolidAngle * cosine;
  }
  const brightest = Math.max(...removed);
  if (!(brightest > 0)) return null;
  const discSolidAngle = Math.PI * DEFAULT_SUN_ANGULAR_RADIUS ** 2;
  const sunDisc = { direction: centre, radiance: removed.map(component => component / discSolidAngle) };
  const { intensity, rotation, showBackground, backgroundBlur } = map;
  return {
    map: createEnvironmentMap({ width, height, data, intensity, rotation, showBackground, backgroundBlur, sunDisc }),
    environment: {
      lightDirection: sun.lightDirection,
      keyColor: removed.map(component => component / brightest),
      keyIntensity: (irradiance * intensity) / Math.PI,
    },
  };
}
