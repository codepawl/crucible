// Small meshes and the digests of what the flush search and the tangent generator make of them. A test passes the functions
// of the checkout under test; the digests it compares with were recorded by passing the same functions from origin/main at
// 757d822da, the commit before the first-load speed-up (issue #2842).
import { createHash } from 'node:crypto';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function placed(x, y, z, scale = 1) {
  const matrix = [...IDENTITY];
  matrix[0] = scale;
  matrix[5] = scale;
  matrix[10] = scale;
  matrix[12] = x;
  matrix[13] = y;
  matrix[14] = z;
  return new Float32Array(matrix);
}

// Quads on y = 0, split into two triangles each. `flipped` winds them the other way, so they face down.
function sheetGeometry(size, flipped = false) {
  const positions = [];
  const indices = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const base = positions.length / 3;
      positions.push(column, 0, row, column, 0, row + 1, column + 1, 0, row + 1, column + 1, 0, row);
      if (flipped) indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      else indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

// A sphere of unit diameter, in rings and segments. Neighbouring triangles lean away from each other only a little, so many
// of them pass the plane tests without sharing area.
function sphereGeometry(rings, segments) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let ring = 0; ring <= rings; ring++) {
    for (let segment = 0; segment <= segments; segment++) {
      const phi = Math.PI * ring / rings;
      const theta = 2 * Math.PI * segment / segments;
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);
      positions.push(x / 2, y / 2, z / 2);
      normals.push(x, y, z);
      uvs.push(segment / segments, ring / rings);
    }
  }
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const corner = ring * (segments + 1) + segment;
      const below = corner + segments + 1;
      indices.push(corner, below, corner + 1, below, below + 1, corner + 1);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

function flushParts() {
  const sheet = sheetGeometry(8);
  const flippedSheet = sheetGeometry(8, true);
  const patch = sheetGeometry(3);
  const sphere = sphereGeometry(24, 32);
  return {
    sheet: { name: 'sheet', geometry: sheet, matrix: placed(0, 0, 0), material: {} },
    overlay: { name: 'overlay', geometry: sheet, matrix: placed(0, 0.001, 0), material: {} },
    slightlyUp: { name: 'slightlyUp', geometry: patch, matrix: placed(2.5, 0.0013, 2.5), material: {} },
    farAbove: { name: 'farAbove', geometry: patch, matrix: placed(1, 0.6, 1), material: {} },
    underside: { name: 'underside', geometry: flippedSheet, matrix: placed(0, 0.0004, 0), material: { doubleSided: true } },
    culledUnderside: { name: 'culledUnderside', geometry: flippedSheet, matrix: placed(0, -0.0006, 0), material: {} },
    ball: { name: 'ball', geometry: sphere, matrix: placed(4, 1, 4, 3), material: {} },
    shell: { name: 'shell', geometry: sphere, matrix: placed(4, 1, 4, 3.003), material: {} },
  };
}

function digestOf(result) {
  const summary = {
    count: result.count,
    searched: result.searched,
    testedPairs: result.testedPairs,
    truncated: result.truncated,
    truncatedAt: result.truncatedAt ?? null,
    unchecked: result.unchecked.map(part => part.name),
    pairs: result.pairs.map(pair => [pair.first, pair.second, pair.gap, pair.area, pair.opposite, pair.flush]),
  };
  return createHash('sha256').update(JSON.stringify(summary)).digest('hex');
}

/**
 * The digests of the searches below, by name. `pairs` and `tested` say how many pairs and how many measured pairs a search
 * found, so a digest that pins nothing (no pairs at all) shows up in the test.
 */
export function flushSearchDigests({ findFlushPairs, forgetSearch }) {
  const parts = flushParts();
  const everything = [parts.sheet, parts.overlay, parts.slightlyUp, parts.farAbove, parts.underside, parts.culledUnderside, parts.ball, parts.shell];
  const searches = {};
  const record = (name, result) => {
    searches[name] = { digest: digestOf(result), pairs: result.pairs.length, tested: result.testedPairs };
  };
  forgetSearch();
  record('all parts', findFlushPairs(everything));
  forgetSearch();
  record('sheets only', findFlushPairs([parts.sheet, parts.overlay, parts.slightlyUp, parts.farAbove]));
  forgetSearch();
  record('a pair budget of 5', findFlushPairs(everything, { pairBudget: 5 }));
  forgetSearch();
  record('a tested-pair limit of 40', findFlushPairs(everything, { testedPairLimit: 40 }));
  forgetSearch();
  record('a triangle budget that leaves parts out', findFlushPairs(everything, { triangleBudget: 700 }));
  // The second search finds the first one remembered and searches only near the part that moved.
  forgetSearch();
  findFlushPairs(everything);
  const moved = { ...parts.slightlyUp, matrix: placed(2.5, 0.0009, 3) };
  record('a search after a part moved', findFlushPairs(everything.map(part => (part === parts.slightlyUp ? moved : part))));
  return searches;
}

function meshForTangents() {
  const sphere = sphereGeometry(18, 24);
  // A pole of repeated UVs gives triangles with no area; a zero normal and a stretched triangle cover the other early exits.
  for (let vertex = 0; vertex < 25; vertex++) {
    sphere.uvs[vertex * 2] = 0.5;
    sphere.uvs[vertex * 2 + 1] = 0;
  }
  sphere.normals.fill(0, 30 * 3, 33 * 3);
  sphere.positions[100 * 3] *= 1e-7;
  return sphere;
}

/** The digest of the tangents of a sphere with a few degenerate corners, and of a quad with a known answer. */
export function tangentDigests(generateTangents) {
  const sphere = meshForTangents();
  const tangents = generateTangents(sphere.positions, sphere.normals, sphere.uvs, sphere.indices);
  const quad = generateTangents(
    new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    new Uint16Array([0, 1, 2, 0, 2, 3]),
  );
  return {
    sphere: createHash('sha256').update(Buffer.from(tangents.buffer)).digest('hex'),
    quad: createHash('sha256').update(Buffer.from(quad.buffer)).digest('hex'),
    sphereVertices: tangents.length / 4,
  };
}
