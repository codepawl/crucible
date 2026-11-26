import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { describeIgnoredFeatures, renderPathTracedImage } from '../src/path-tracer.js';
import {
  MAX_DISPLACED_TRIANGLES_PER_PART, MAX_DISPLACEMENT_SUBDIVISIONS,
  heightFadeAtDistance, subdivisionLevelForCap,
} from '../src/path-tracer-displacement.js';

function quadGeometry(halfWidth = 1, halfDepth = 1) {
  return {
    positions: new Float32Array([
      -halfWidth, 0, halfDepth,
      halfWidth, 0, halfDepth,
      halfWidth, 0, -halfDepth,
      -halfWidth, 0, -halfDepth,
    ]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function cubeGeometry(half = 0.5) {
  const faces = [
    { normal: [0, 1, 0], corners: [[-half, half, half], [half, half, half], [half, half, -half], [-half, half, -half]] },
    { normal: [0, -1, 0], corners: [[-half, -half, -half], [half, -half, -half], [half, -half, half], [-half, -half, half]] },
    { normal: [0, 0, 1], corners: [[-half, -half, half], [half, -half, half], [half, half, half], [-half, half, half]] },
    { normal: [0, 0, -1], corners: [[half, -half, -half], [-half, -half, -half], [-half, half, -half], [half, half, -half]] },
    { normal: [1, 0, 0], corners: [[half, -half, half], [half, -half, -half], [half, half, -half], [half, half, half]] },
    { normal: [-1, 0, 0], corners: [[-half, -half, -half], [-half, -half, half], [-half, half, half], [-half, half, -half]] },
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  faces.forEach((face, faceIndex) => {
    const base = faceIndex * 4;
    for (const corner of face.corners) {
      positions.push(...corner);
      normals.push(...face.normal);
    }
    uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

function makeHeightMap(width, height, pixelFn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const value = Math.max(0, Math.min(255, Math.round(pixelFn(column, row, width, height) * 255)));
      const offset = (row * width + column) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { image: { width, height, data }, colorSpace: 'linear' };
}

function digestSceneGeometry(scene) {
  const hash = createHash('sha256');
  for (const array of [scene.positions, scene.normals, scene.uvs, scene.indices]) {
    hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  return hash.digest('hex');
}

test('heightMap with heightScale > 0 subdivides and displaces silhouette vertices vs flat without heightMap', async () => {
  // Border height 0 (sunken by heightScale), interior ridge at height 1 (at y = 0).
  const ridgeMap = makeHeightMap(16, 16, (column, row, width, height) => {
    const dx = (column + 0.5) / width - 0.5;
    const dz = (row + 0.5) / height - 0.5;
    return Math.hypot(dx, dz) < 0.28 ? 1 : 0;
  });
  const baseGeometry = quadGeometry(1, 1);
  const flatPart = { name: 'ground', geometry: baseGeometry, material: { color: [0.6, 0.6, 0.6], roughness: 0.8 } };
  const displacedPart = {
    name: 'ground',
    geometry: baseGeometry,
    material: { color: [0.6, 0.6, 0.6], roughness: 0.8, heightMap: ridgeMap, heightScale: 0.25 },
  };
  const flatScene = buildTraceScene([flatPart], {});
  const zeroScaleScene = buildTraceScene([{ ...displacedPart, material: { ...displacedPart.material, heightScale: 0 } }], {});
  const displacedScene = buildTraceScene([displacedPart], {});

  assert.equal(flatScene.indices.length / 3, 2);
  assert.equal(digestSceneGeometry(zeroScaleScene), digestSceneGeometry(flatScene), 'heightScale 0 leaves geometry byte-identical');
  assert.ok(displacedScene.indices.length / 3 > 100, 'subdivides coarse quad');

  let minY = Infinity;
  let maxY = -Infinity;
  let tiltedNormalFound = false;
  for (let vertex = 0; vertex < displacedScene.positions.length / 3; vertex++) {
    const y = displacedScene.positions[vertex * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (displacedScene.normals[vertex * 3 + 1] < 0.99) tiltedNormalFound = true;
  }
  assert.ok(minY < -0.20, `troughs sink toward -0.25 m, got ${minY}`);
  assert.ok(maxY <= 1e-6 && maxY > -0.02, `crests stay near 0 m, got ${maxY}`);
  assert.ok(tiltedNormalFound, 'displaced slopes recalculate tilted vertex normals');

  // Grazing camera at y = -0.10 looking across the sunken border (y = -0.25) toward the central ridge (y = 0).
  // Without displacement the flat y = 0 quad is entirely above the view ray (sky only); with displacement the sunken
  // trough exposes the raised central bump silhouette against the sky.
  const camera = { eye: [0, -0.08, 2.5], target: [0, -0.08, 0], fov: 35 };
  const environment = { keyColor: [3, 3, 3], lightDirection: [0.4, 1, 0.3], world: false };
  const renderOpts = { width: 48, height: 32, samples: 4, bounces: 2, denoise: false, threads: 1 };
  const flatRender = await renderPathTracedImage({ parts: [flatPart], environment, camera }, renderOpts);
  const displacedRender = await renderPathTracedImage({ parts: [displacedPart], environment, camera }, renderOpts);

  let diffPixels = 0;
  for (let pixel = 0; pixel < 48 * 32; pixel++) {
    const delta = Math.abs(flatRender.linear[pixel * 3] - displacedRender.linear[pixel * 3]);
    if (delta > 0.05) diffPixels++;
  }
  assert.ok(diffPixels > 20, `grazing silhouette differs significantly from flat plane (${diffPixels} pixels)`);
  assert.ok(!displacedRender.report.ignored.some(note => note.includes('heightMap')));
});

test('parts without heightMap remain byte-identical beside displaced parts', () => {
  const heightMap = makeHeightMap(4, 4, () => 0);
  const plain = { name: 'plain', geometry: quadGeometry(1, 1), material: { color: [0.5, 0.5, 0.5] } };
  const displaced = {
    name: 'bumpy',
    geometry: quadGeometry(1, 1),
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
    material: { color: [0.5, 0.5, 0.5], heightMap, heightScale: 0.1 },
  };
  const plainOnly = buildTraceScene([plain], {});
  const mixed = buildTraceScene([plain, displaced], {});
  assert.deepEqual(mixed.positions.slice(0, plainOnly.positions.length), plainOnly.positions);
  assert.deepEqual(mixed.normals.slice(0, plainOnly.normals.length), plainOnly.normals);
  assert.deepEqual(mixed.indices.slice(0, plainOnly.indices.length), plainOnly.indices);
});

test('welded normals displace cube corners watertight with zero seam cracks', () => {
  const heightMap = makeHeightMap(4, 4, (column, row) => ((column + row) % 2 === 0 ? 0.2 : 0.9));
  const part = {
    name: 'cube',
    geometry: cubeGeometry(0.5),
    material: { color: [0.7, 0.7, 0.7], heightMap, heightScale: 0.1 },
  };
  const scene = buildTraceScene([part], {});
  // Every vertex sharing a corner on the original cube must stay watertight at one displaced position.
  const corners = new Set();
  for (let vertex = 0; vertex < scene.positions.length / 3; vertex++) {
    const x = scene.positions[vertex * 3];
    const y = scene.positions[vertex * 3 + 1];
    const z = scene.positions[vertex * 3 + 2];
    if (Math.abs(Math.abs(x) - Math.abs(y)) < 1e-4 && Math.abs(Math.abs(y) - Math.abs(z)) < 1e-4 && Math.abs(x) > 0.3) {
      corners.add(`${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`);
    }
  }
  assert.equal(corners.size, 8, `cube corners weld cleanly into 8 unique displaced points, got ${corners.size}`);
});

test('subdivision strictly obeys bounded triangle and level caps', () => {
  assert.equal(subdivisionLevelForCap(2, MAX_DISPLACED_TRIANGLES_PER_PART), MAX_DISPLACEMENT_SUBDIVISIONS);
  assert.equal(subdivisionLevelForCap(20_000, MAX_DISPLACED_TRIANGLES_PER_PART), 0);
  assert.equal(subdivisionLevelForCap(4_000, MAX_DISPLACED_TRIANGLES_PER_PART), 2);

  // A 128x128 grid (32,768 triangles) cannot subdivide 4x without exceeding 65,536, so it stays at 32,768.
  const side = 128;
  const positions = new Float32Array((side + 1) * (side + 1) * 3);
  const normals = new Float32Array((side + 1) * (side + 1) * 3);
  const uvs = new Float32Array((side + 1) * (side + 1) * 2);
  for (let row = 0; row <= side; row++) {
    for (let column = 0; column <= side; column++) {
      const vertex = row * (side + 1) + column;
      positions[vertex * 3] = column / side;
      positions[vertex * 3 + 2] = row / side;
      normals[vertex * 3 + 1] = 1;
      uvs[vertex * 2] = column / side;
      uvs[vertex * 2 + 1] = row / side;
    }
  }
  const indices = new Uint32Array(side * side * 6);
  let cursor = 0;
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const topLeft = row * (side + 1) + column;
      const bottomLeft = topLeft + side + 1;
      indices[cursor++] = topLeft;
      indices[cursor++] = bottomLeft;
      indices[cursor++] = bottomLeft + 1;
      indices[cursor++] = topLeft;
      indices[cursor++] = bottomLeft + 1;
      indices[cursor++] = topLeft + 1;
    }
  }
  const heightMap = makeHeightMap(4, 4, () => 0.5);
  const scene = buildTraceScene([{
    name: 'dense',
    geometry: { positions, normals, uvs, indices },
    material: { color: [0.5, 0.5, 0.5], heightMap, heightScale: 0.2 },
  }], {});
  assert.equal(scene.indices.length / 3, side * side * 2, 'dense mesh stays within cap without subdividing');
  assert.ok(Math.abs(scene.positions[1] - (128 / 255 - 1) * 0.2) < 1e-5, `existing vertices still displace when subdivision level is 0, got ${scene.positions[1]}`);
});

test('heightFade attenuates displacement from 0.5 * heightFade to heightFade from camera eye', () => {
  assert.equal(heightFadeAtDistance(2, 10), 1);
  assert.equal(heightFadeAtDistance(5, 10), 1);
  assert.equal(heightFadeAtDistance(7.5, 10), 0.5);
  assert.equal(heightFadeAtDistance(10, 10), 0);
  assert.equal(heightFadeAtDistance(20, 10), 0);

  const heightMap = makeHeightMap(4, 4, () => 0);
  const part = {
    name: 'tile',
    geometry: quadGeometry(0.5, 0.5),
    material: { color: [0.5, 0.5, 0.5], heightMap, heightScale: 0.2, heightFade: 10 },
  };
  const near = buildTraceScene([part], {}, { eye: [0, 4, 0] });
  const mid = buildTraceScene([part], {}, { eye: [0, 7.5, 0] });
  const far = buildTraceScene([part], {}, { eye: [0, 15, 0] });

  assert.ok(Math.abs(near.positions[1] + 0.2) < 1e-5, `within 0.5 * heightFade gets full -0.2 m, got ${near.positions[1]}`);
  assert.ok(mid.positions[1] < -0.05 && mid.positions[1] > -0.15, `at 7.5 m gets half attenuation, got ${mid.positions[1]}`);
  assert.equal(far.indices.length / 3, 2, 'beyond heightFade skips subdivision');
  assert.equal(far.positions[1], 0, 'beyond heightFade leaves vertices undisplaced');
});

test('displacement is deterministic across repeated builds', () => {
  const heightMap = makeHeightMap(8, 8, (column, row) => Math.sin(column * 0.9) * 0.5 + Math.cos(row * 0.7) * 0.5);
  const part = {
    name: 'cobble',
    geometry: quadGeometry(2, 2),
    matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 1, 0.5, -1, 1],
    material: { color: [0.5, 0.5, 0.5], heightMap, heightScale: 0.08, heightFade: 12 },
  };
  const first = digestSceneGeometry(buildTraceScene([part], {}, { eye: [0, 3, 3] }));
  const second = digestSceneGeometry(buildTraceScene([part], {}, { eye: [0, 3, 3] }));
  assert.equal(first, second);
});

test('describeIgnoredFeatures omits heightMap when active and flags invalid boundaries cleanly', () => {
  const heightMap = makeHeightMap(2, 2, () => 0.5);
  const active = [{ name: 'rock', material: { tag: 'surface', heightMap, heightScale: 0.04 } }];
  assert.ok(!describeIgnoredFeatures(active, {}, 'cpu').some(note => note.includes('heightMap')));

  const noScale = [{ name: 'rock', material: { tag: 'surface', heightMap } }];
  assert.ok(describeIgnoredFeatures(noScale, {}, 'cpu').includes('heightMap is ignored.'));

  const liquid = [{ name: 'rock', material: { tag: 'liquid', heightMap, heightScale: 0.04 } }];
  assert.ok(describeIgnoredFeatures(liquid, {}, 'cpu').includes('heightMap is ignored.'));

  assert.throws(
    () => buildTraceScene([{ name: 'bad', geometry: quadGeometry(), material: { heightMap, heightScale: 0.9 } }], {}),
    /heightScale.*0 to 0\.5/,
  );
  assert.throws(
    () => buildTraceScene([{ name: 'bad', geometry: quadGeometry(), material: { heightMap, heightScale: 0.1, heightFade: 0 } }], {}),
    /heightFade.*0\.1 to 1000/,
  );
  assert.throws(
    () => buildTraceScene([{ name: 'bad', geometry: quadGeometry(), material: {} }], {}, { eye: [0, NaN, 0] }),
    /eye must be three finite numbers/,
  );
});
