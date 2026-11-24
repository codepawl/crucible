// Measures how close a normal map draws to the high-poly mesh it was baked from, with and without mesh tangents (#2988).
//
//   node scripts/measure-normal-map-tangents.mjs [--out <folder>] [--scan-folder <folder>] [--resolution <texels>]
//
// Two assets, each a low-poly mesh with a normal map baked from a high-poly source in the tangent basis glTF requires:
//   sphere  a 16 x 8 UV sphere baked from a 192 x 96 one.
//   scan    a photogrammetry rock decimated to 2 percent of its triangles, unwrapped, baked from the full scan.
//           Source: Poly Haven "Boulder 01" by Rico Cilliers, CC0 1.0 (https://polyhaven.com/a/boulder_01). Only the
//           geometry (boulder_01_8k.gltf and boulder_01.bin) is downloaded, checked against the hashes below.
// Each low-poly mesh is drawn three ways: with no normal map (the baseline), with the map and no tangents (the screen
// derivative frame) and with the map and generated tangents (the glTF path). The reference is the high-poly mesh's
// normal pass from the same camera. The error is the angle between the two normal passes where both draw the object.
// It needs a GPU and Chrome: run it as a light GPU job (node scripts/measure-normal-map-tangents.mjs).
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { decimateMesh } from '../src/mesh-decimate.js';
import { generateTangents } from '../src/gltf-tangents.js';
import { createMeshData } from '../src/mesh-data.js';
import { extractRender } from '../src/mesh-render.js';
import { unwrapUv } from '../src/mesh-uv.js';
import { bakeTangentSpaceNormalMap } from './normal-map-bake.mjs';
import { erodeMask, pixelAngles, angleStatistics, sharedCoverage, meetsTangentGate, TANGENT_GATE_MEAN_DEGREES } from './normal-map-angle.mjs';
import { oraclePass, pixelsAwayFromIslandBorders } from './normal-map-oracle.mjs';

const SCAN_SOURCE = Object.freeze({
  name: 'Boulder 01 (Poly Haven)',
  author: 'Rico Cilliers',
  license: 'CC0 1.0',
  page: 'https://polyhaven.com/a/boulder_01',
  files: Object.freeze([
    { name: 'boulder_01_8k.gltf', url: 'https://dl.polyhaven.org/file/ph-assets/Models/gltf/8k/boulder_01/boulder_01_8k.gltf', sha256: 'bb9ab25f9f547d27cd6847409133718e16e5eb612138396c750c9e3d8e0d80e7' },
    { name: 'boulder_01.bin', url: 'https://dl.polyhaven.org/file/ph-assets/Models/gltf/8k/boulder_01/boulder_01.bin', sha256: '7f5b06503d62bd95bfe9c6b8a354a5cc8ff04a4d271a8cf87a3e3125db4232d7' },
  ]),
});
const RECIPE = Object.freeze({
  imageSize: 640,
  fieldOfViewDegrees: 35,
  edgeBandPixels: 4,
  borderTexels: 2,
  material: { tag: 'surface', color: [0.8, 0.75, 0.7], metallic: 0, roughness: 0.45 },
  renderer: { ground: false, world: true, samples: 1, pixelRatio: 1 },
  backend: 'ANGLE d3d11 (GPU), headless Chrome',
});

function readOptions(argumentsList) {
  const options = { out: 'artifacts/2988-tangent-measure', scanFolder: null, resolution: 1024 };
  for (let position = 0; position < argumentsList.length; position += 2) {
    const [flag, value] = [argumentsList[position], argumentsList[position + 1]];
    if (flag === '--out') options.out = value;
    else if (flag === '--scan-folder') options.scanFolder = value;
    else if (flag === '--resolution') options.resolution = Number(value);
    else throw new Error(`Unknown option ${flag}. Pass --out <folder>, --scan-folder <folder> or --resolution <texels>.`);
  }
  options.out = resolve(options.out);
  options.scanFolder = resolve(options.scanFolder ?? join(options.out, 'scan-cache'));
  return options;
}

async function fetchScan(folder) {
  mkdirSync(folder, { recursive: true });
  for (const file of SCAN_SOURCE.files) {
    const path = join(folder, file.name);
    if (!existsSync(path)) writeFileSync(path, Buffer.from(await (await fetch(file.url)).arrayBuffer()));
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (hash !== file.sha256) throw new Error(`${path} has sha256 ${hash}, expected ${file.sha256}. Delete it and run again, or pass --scan-folder with the original Poly Haven files.`);
  }
  return join(folder, SCAN_SOURCE.files[0].name);
}

function readScanGeometry(gltfPath) {
  const gltf = JSON.parse(readFileSync(gltfPath, 'utf8'));
  const binary = readFileSync(join(gltfPath, '..', gltf.buffers[0].uri));
  const primitive = gltf.meshes[0].primitives[0];
  const read = (accessorIndex, ArrayType) => {
    const accessor = gltf.accessors[accessorIndex];
    const view = gltf.bufferViews[accessor.bufferView];
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3 }[accessor.type];
    const bytes = binary.buffer.slice(binary.byteOffset + view.byteOffset, binary.byteOffset + view.byteOffset + accessor.count * width * ArrayType.BYTES_PER_ELEMENT);
    return new ArrayType(bytes);
  };
  return {
    positions: read(primitive.attributes.POSITION, Float32Array),
    normals: read(primitive.attributes.NORMAL, Float32Array),
    indices: read(primitive.indices, Uint32Array),
  };
}

function weldedTriangleMesh({ positions, indices }) {
  const vertexOfKey = new Map();
  const weldedPositions = [];
  const remap = new Uint32Array(positions.length / 3);
  for (let vertex = 0; vertex < remap.length; vertex++) {
    const point = [positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]];
    const key = point.join(',');
    if (!vertexOfKey.has(key)) {
      vertexOfKey.set(key, weldedPositions.length / 3);
      weldedPositions.push(...point);
    }
    remap[vertex] = vertexOfKey.get(key);
  }
  const faceOffsets = Uint32Array.from({ length: indices.length / 3 + 1 }, (_, face) => face * 3);
  return createMeshData({ positions: Float32Array.from(weldedPositions), faceOffsets, cornerVertices: indices.map(vertex => remap[vertex]) });
}

function uvSphere(columns, rows) {
  const positions = [];
  const uvs = [];
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const azimuth = column / columns * Math.PI * 2;
      const polar = row / rows * Math.PI;
      positions.push(Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth));
      uvs.push(column / columns, row / rows);
    }
  }
  const indices = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const first = row * (columns + 1) + column;
      const second = first + columns + 1;
      indices.push(first, first + 1, second, first + 1, second + 1, second);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

function boundsOf(positions) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis], positions[vertex * 3 + axis]);
      high[axis] = Math.max(high[axis], positions[vertex * 3 + axis]);
    }
  }
  return { low, high, center: low.map((value, axis) => (value + high[axis]) / 2), diagonal: Math.hypot(...low.map((value, axis) => high[axis] - value)) };
}

function cameraFitting(positions, direction) {
  const { center, diagonal } = boundsOf(positions);
  const length = Math.hypot(...direction);
  const distance = diagonal / 2 / Math.sin(RECIPE.fieldOfViewDegrees * Math.PI / 360) * 1.15;
  return { eye: center.map((value, axis) => value + direction[axis] / length * distance), target: center, fov: RECIPE.fieldOfViewDegrees, up: [0, 1, 0] };
}

const BUMP_HEIGHT = 0.06;

function bumpedSurfacePoint(azimuth, polar) {
  const bump = 1 + BUMP_HEIGHT * Math.sin(6 * azimuth) * Math.sin(polar) ** 2 * Math.sin(4 * polar);
  return [bump * Math.sin(polar) * Math.cos(azimuth), bump * Math.cos(polar), bump * Math.sin(polar) * Math.sin(azimuth)];
}

/** A sphere with a ridged surface, its normals taken from the surface itself so they agree across the seam and at the poles. */
function bumpedSphere(columns, rows) {
  const step = 1e-4;
  const positions = [];
  const normals = [];
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const azimuth = column / columns * Math.PI * 2;
      const polar = row / rows * Math.PI;
      const point = bumpedSurfacePoint(azimuth, polar);
      const clampedPolar = Math.min(Math.PI - step, Math.max(step, polar));
      const base = bumpedSurfacePoint(azimuth, clampedPolar);
      const alongPolar = bumpedSurfacePoint(azimuth, clampedPolar + step).map((value, axis) => value - base[axis]);
      const alongAzimuth = bumpedSurfacePoint(azimuth + step, clampedPolar).map((value, axis) => value - base[axis]);
      const surfaceNormal = normalizedVector([alongPolar[1] * alongAzimuth[2] - alongPolar[2] * alongAzimuth[1], alongPolar[2] * alongAzimuth[0] - alongPolar[0] * alongAzimuth[2], alongPolar[0] * alongAzimuth[1] - alongPolar[1] * alongAzimuth[0]]);
      const outward = normalizedVector(point);
      const facing = surfaceNormal[0] * outward[0] + surfaceNormal[1] * outward[1] + surfaceNormal[2] * outward[2] < 0 ? -1 : 1;
      positions.push(...point);
      normals.push(...surfaceNormal.map(value => value * facing));
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: uvSphere(columns, rows).indices };
}

function normalizedVector(vector) {
  const length = Math.hypot(...vector);
  return vector.map(value => value / length);
}

function sphereAsset(columns, rows, resolution) {
  const low = uvSphere(columns, rows);
  low.tangents = generateTangents(low.positions, low.normals, low.uvs, low.indices);
  const high = bumpedSphere(192, 96);
  const bake = bakeTangentSpaceNormalMap(low, high, { resolution: Math.min(resolution, 512), cage: 0.3 });
  return { name: `sphere-${columns}x${rows}`, low, high, bake, camera: { eye: [2.2, 1.1, 2.6], target: [0, 0, 0], fov: RECIPE.fieldOfViewDegrees, up: [0, 1, 0] }, source: `generated: ${columns} x ${rows} UV sphere baked from a 192 x 96 sphere with a ridged surface (6 ridges around, 4 along, height 0.06)` };
}

function scanAsset(gltfPath, resolution, keptShare) {
  const scan = readScanGeometry(gltfPath);
  const welded = weldedTriangleMesh(scan);
  const decimated = decimateMesh(welded, { ratio: keptShare });
  const unwrapped = unwrapUv(decimated.mesh);
  const low = extractRender(unwrapped.mesh).geometry;
  low.tangents = generateTangents(low.positions, low.normals, low.uvs, low.indices);
  const { diagonal } = boundsOf(scan.positions);
  const bake = bakeTangentSpaceNormalMap(low, scan, { resolution, cage: diagonal * 0.1 });
  const high = { positions: scan.positions, normals: scan.normals, indices: scan.indices };
  const unwrapReport = { islands: unwrapped.islands, flipped: unwrapped.flipped, areaDistortion: unwrapped.areaDistortion };
  return { name: `scan-${Math.round(keptShare * 100)}pct`, low, high, bake, camera: cameraFitting(scan.positions, [0.6, 0.35, 0.72]), unwrapReport, triangles: { scan: scan.indices.length / 3, low: low.indices.length / 3 }, source: `${SCAN_SOURCE.name}, ${SCAN_SOURCE.license}, ${SCAN_SOURCE.page}` };
}

function encodeBase64(typedArray) {
  return Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength).toString('base64');
}

async function startServer(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start within 60 seconds.')), 60000);
    server.stdout.on('data', data => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    server.on('exit', code => reject(new Error(`The dev server exited with code ${code}.`)));
  });
  return server;
}

function freePort() {
  return new Promise(resolvePort => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** Draws the reference and the three low-poly variants of one asset in the page and returns their normal passes. */
async function drawNormalPasses(page, asset) {
  const geometryPayload = (geometry, extra = []) => Object.fromEntries(['positions', 'normals', 'uvs', 'indices', ...extra].filter(name => geometry[name]).map(name => [name, { type: geometry[name].constructor.name, base64: encodeBase64(geometry[name]) }]));
  const payload = {
    recipe: RECIPE,
    camera: asset.camera,
    low: geometryPayload(asset.low, ['tangents']),
    high: geometryPayload({ positions: asset.high.positions, normals: asset.high.normals, indices: asset.high.indices }),
    map: { width: asset.bake.width, height: asset.bake.height, base64: encodeBase64(asset.bake.data) },
  };
  const result = await page.evaluate(async input => {
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { installRenderPasses } = await import('/src/render-passes.js');
    const { readFloatPixels } = await import('/src/float-output.js');
    const decode = field => {
      const bytes = Uint8Array.from(atob(field.base64), character => character.charCodeAt(0));
      const ArrayType = { Float32Array, Uint32Array }[field.type];
      return new ArrayType(bytes.buffer);
    };
    const geometryFrom = fields => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, decode(field)]));
    const mapBytes = Uint8Array.from(atob(input.map.base64), character => character.charCodeAt(0));
    const mapCanvas = document.createElement('canvas');
    mapCanvas.width = input.map.width;
    mapCanvas.height = input.map.height;
    mapCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(mapBytes.buffer), input.map.width, input.map.height), 0, 0);
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const size = input.recipe.imageSize;
    const toBase64 = floats => {
      const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
      let text = '';
      for (let start = 0; start < bytes.length; start += 0x8000) text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
      return btoa(text);
    };
    const normalPass = (name, geometry, material) => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      document.body.append(canvas);
      const renderer = installRenderPasses(new CrucibleRenderer(canvas, [{ name, geometry, matrix: identity, material: { ...input.recipe.material, id: name, ...material } }], input.recipe.renderer));
      renderer.resize();
      renderer.render({ ...input.camera, pass: 'normal', passFloat: true });
      const pixels = readFloatPixels(renderer.context, renderer.passSupport.framebuffer, size, size);
      const features = renderer.shaderFeatures ? [...renderer.shaderFeatures] : [];
      const tangentsReachedGeometry = geometry.tangents ? geometry.tangents.length === geometry.positions.length / 3 * 4 : false;
      return { width: renderer.canvas.width, height: renderer.canvas.height, base64: toBase64(pixels), features, tangentsReachedGeometry };
    };
    const low = geometryFrom(input.low);
    const { tangents, ...lowWithoutTangents } = low;
    const normalMap = { image: mapCanvas, colorSpace: 'linear' };
    const nearestNormalMap = { image: mapCanvas, colorSpace: 'linear', minFilter: 9728, magFilter: 9728 };
    return {
      reference: normalPass('reference', geometryFrom(input.high), {}),
      noMap: normalPass('no-map', lowWithoutTangents, {}),
      derivative: normalPass('derivative', lowWithoutTangents, { normalMap }),
      generated: normalPass('generated', { ...lowWithoutTangents, tangents }, { normalMap }),
      generatedNearest: normalPass('generated-nearest', { ...lowWithoutTangents, tangents }, { normalMap: nearestNormalMap }),
    };
  }, payload);
  const toFloats = field => new Float32Array(Uint8Array.from(Buffer.from(field.base64, 'base64')).buffer);
  return Object.fromEntries(Object.entries(result).map(([name, pass]) => [name, { ...pass, pixels: toFloats(pass) }]));
}

/** Angle of `variant` to `reference` where both draw, optionally only where `restrictTo` is 1, as every statistic of the table. */
function measureVariant(variant, reference, restrictTo = null) {
  const pixelCount = reference.width * reference.height;
  const shared = sharedCoverage(variant.pixels, reference.pixels, pixelCount);
  const interior = erodeMask(shared, reference.width, reference.height, RECIPE.edgeBandPixels);
  if (restrictTo) {
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      shared[pixel] &= restrictTo[pixel];
      interior[pixel] &= restrictTo[pixel];
    }
  }
  const angles = pixelAngles(variant.pixels, reference.pixels, shared);
  return { angles, mask: shared, inside: angleStatistics(angles, shared), interior: angleStatistics(angles, interior), shaderFeatures: variant.features, tangentsReachedGeometry: variant.tangentsReachedGeometry };
}

/**
 * How far the generated-tangent path is from the spec pass, one change at a time: the map's default linear filter on the
 * whole object, nearest texel (what the spec pass reads) on the whole object, then both on the pixels where the
 * comparison is fair. Fair means the renderer leaves the mapped normal alone (it bends one whose reflection would dip
 * below the surface, which the spec decode does not do) and the texel sits RECIPE.borderTexels from any island border,
 * padding or seam. The last step is the gate; the derivative path is measured under the same mask for comparison.
 */
function gapToSpecSteps(passes, spec, bake) {
  const fair = pixelsAwayFromIslandBorders(spec.texelOfPixel, bake.coverage, bake.width, RECIPE.borderTexels);
  for (let pixel = 0; pixel < fair.length; pixel++) fair[pixel] &= spec.reflectsAboveSurface[pixel];
  const step = (name, pass, restrictTo, isGate = false) => ({ step: name, statistics: measureVariant(passes[pass], passes.oracle, restrictTo).inside, isGate });
  return [
    step('generated, linear filter, whole object', 'generated', null),
    step('generated, nearest texel, whole object', 'generatedNearest', null),
    step('generated, linear filter, fair pixels', 'generated', fair),
    step('generated, nearest texel, fair pixels', 'generatedNearest', fair, true),
    step('derivative, linear filter, fair pixels', 'derivative', fair),
  ];
}

// ---- stills ----
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function chunk(type, body) {
  const bytes = Buffer.concat([Buffer.from(type), body]);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, bytes, checksum]);
}

function encodePng(width, height, rgb) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) Buffer.from(rgb.buffer, rgb.byteOffset + row * width * 3, width * 3).copy(rows, row * (width * 3 + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function normalTile(pass) {
  const tile = new Uint8Array(pass.width * pass.height * 3);
  for (let row = 0; row < pass.height; row++) {
    for (let column = 0; column < pass.width; column++) {
      const source = ((pass.height - 1 - row) * pass.width + column) * 4;
      for (let channel = 0; channel < 3; channel++) tile[(row * pass.width + column) * 3 + channel] = Math.round(Math.min(1, Math.max(0, pass.pixels[source + channel])) * 255);
    }
  }
  return tile;
}

// Black at 0 degrees, through blue and yellow, to red at 10 degrees and more; grey where the object is not drawn.
function errorTile(measured, width, height) {
  const tile = new Uint8Array(width * height * 3).fill(40);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const source = (height - 1 - row) * width + column;
      if (!measured.mask[source]) continue;
      const share = Math.min(1, measured.angles[source] / 10);
      const color = share < 0.5 ? [0, 0, share * 2 * 255] : [(share - 0.5) * 2 * 255, share < 0.75 ? (share - 0.5) * 4 * 200 : 200 * (1 - (share - 0.75) * 4), 255 * (1 - (share - 0.5) * 2)];
      tile.set(color.map(Math.round), (row * width + column) * 3);
    }
  }
  return tile;
}

function composeRows(tiles, width, height) {
  const sheet = new Uint8Array(tiles.length * width * height * 3);
  tiles.forEach((tile, position) => {
    for (let row = 0; row < height; row++) sheet.set(tile.subarray(row * width * 3, (row + 1) * width * 3), (row * tiles.length + position) * width * 3);
  });
  return sheet;
}

function writeStills(outFolder, asset, passes, measured) {
  const { width, height } = passes.reference;
  const normals = ['reference', 'noMap', 'derivative', 'generated'].map(name => normalTile(passes[name]));
  const errors = ['oracle', 'noMap', 'derivative', 'generated'].map(name => errorTile(measured[name], width, height));
  writeFileSync(join(outFolder, `${asset.name}-normal-passes.png`), encodePng(width * 4, height, composeRows(normals, width, height)));
  writeFileSync(join(outFolder, `${asset.name}-angle-error.png`), encodePng(width * 4, height, composeRows(errors, width, height)));
}

function commitLabel() {
  const run = (...gitArguments) => execFileSync('git', gitArguments, { encoding: 'utf8' }).trim();
  return { head: run('rev-parse', 'HEAD'), base: run('rev-parse', 'origin/main'), dirty: run('status', '--porcelain', '--untracked-files=no') !== '' };
}

const options = readOptions(process.argv.slice(2));
mkdirSync(options.out, { recursive: true });
const gltfPath = await fetchScan(options.scanFolder);
const assets = [sphereAsset(16, 8, options.resolution), sphereAsset(32, 16, options.resolution), scanAsset(gltfPath, options.resolution, 0.02), scanAsset(gltfPath, options.resolution, 0.1)];
const port = await freePort();
const server = await startServer(port);
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-audio-output'] });
try {
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  const address = `http://127.0.0.1:${port}/__test-page.html`;
  await page.route(address, route => route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' }, body: '<!doctype html><title>Normal map measurement</title>' }));
  await page.goto(address);
  const table = [];
  const gateRows = [];
  const gateFailures = [];
  for (const asset of assets) {
    const passes = await drawNormalPasses(page, asset);
    if (passes.reference.width !== RECIPE.imageSize) throw new Error(`The renderer drew ${passes.reference.width} px, not ${RECIPE.imageSize}; the oracle needs the same size.`);
    const spec = oraclePass(asset.low, asset.bake, asset.camera, RECIPE.imageSize, boundsOf(asset.high.positions).diagonal * 4);
    const oracle = { width: passes.reference.width, height: passes.reference.height, pixels: spec.pixels, features: [], tangentsReachedGeometry: true };
    passes.oracle = oracle;
    const measured = Object.fromEntries(['noMap', 'derivative', 'generated', 'oracle'].map(name => [name, measureVariant(passes[name], passes.reference)]));
    const againstOracle = Object.fromEntries(['noMap', 'derivative', 'generated'].map(name => [name, measureVariant(passes[name], passes.oracle)]));
    const gapToSpec = gapToSpecSteps(passes, spec, asset.bake);
    const gate = gapToSpec.find(step => step.isGate);
    if (!meetsTangentGate(gate.statistics)) gateFailures.push(asset.name);
    writeStills(options.out, asset, passes, measured);
    const summary = Object.fromEntries(Object.entries(measured).map(([name, value]) => [name, { insideMask: value.inside, interior: value.interior, shaderFeatures: value.shaderFeatures, tangentsReachedGeometry: value.tangentsReachedGeometry, againstOracle: againstOracle[name]?.inside }]));
    writeFileSync(join(options.out, `${asset.name}.json`), JSON.stringify({ asset: asset.name, source: asset.source, commit: commitLabel(), recipe: RECIPE, camera: asset.camera, mapResolution: asset.bake.width, bake: { coveredTexels: asset.bake.coveredTexels, hitTexels: asset.bake.hitTexels }, triangles: asset.triangles, unwrapReport: asset.unwrapReport, gateMeanDegrees: TANGENT_GATE_MEAN_DEGREES, gapToSpec, gatePassed: meetsTangentGate(gate.statistics), scanFiles: asset.name.startsWith('scan') ? SCAN_SOURCE.files.map(({ name, sha256, url }) => ({ name, sha256, url })) : undefined, results: summary }, null, 2));
    gateRows.push({ asset: asset.name, gapToSpec });
    for (const [name, value] of Object.entries(summary)) table.push({ asset: asset.name, path: name, mean: value.insideMask.meanDegrees.toFixed(2), p95: value.insideMask.p95Degrees.toFixed(2), interiorMean: value.interior.meanDegrees.toFixed(2), interiorP95: value.interior.p95Degrees.toFixed(2), pixels: value.insideMask.pixels, oracleMean: value.againstOracle?.meanDegrees.toFixed(2), oracleP95: value.againstOracle?.p95Degrees.toFixed(2) });
  }
  console.table(table);
  console.table(gateRows.flatMap(({ asset, gapToSpec }) => gapToSpec.map(step => ({ asset, step: step.step, mean: step.statistics.meanDegrees.toFixed(3), p95: step.statistics.p95Degrees.toFixed(3), pixels: step.statistics.pixels, gate: step.isGate ? (meetsTangentGate(step.statistics) ? `PASS (<= ${TANGENT_GATE_MEAN_DEGREES})` : `FAIL (> ${TANGENT_GATE_MEAN_DEGREES})`) : '' }))));
  console.log(JSON.stringify(table));
  if (gateFailures.length) {
    console.error(`Tangent gate failed for ${gateFailures.join(', ')}: the generated path differs from the spec pass by more than ${TANGENT_GATE_MEAN_DEGREES} degrees.`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  server.kill();
}
