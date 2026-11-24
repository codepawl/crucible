import assert from 'node:assert/strict';
import test from 'node:test';
import { angleStatistics, erodeMask, measureNormalPassAngle, meetsTangentGate, pixelAngles, sharedCoverage, TANGENT_GATE_MEAN_DEGREES, TANGENT_GATE_P99_DEGREES } from '../scripts/normal-map-angle.mjs';
import { normalReflectsAboveSurface, oraclePass, pixelsAwayFromIslandBorders } from '../scripts/normal-map-oracle.mjs';
import { bakeTangentSpaceNormalMap, barycentricWeights } from '../scripts/normal-map-bake.mjs';

// A normal pass stores n * 0.5 + 0.5 and zero where nothing is drawn.
function passOf(normals) {
  const pixels = new Float32Array(normals.length * 4);
  normals.forEach((normal, pixel) => {
    if (normal) pixels.set([normal[0] * 0.5 + 0.5, normal[1] * 0.5 + 0.5, normal[2] * 0.5 + 0.5, 1], pixel * 4);
    else pixels.set([0, 0, 0, 1], pixel * 4);
  });
  return pixels;
}

function turned(degrees) {
  const radians = degrees * Math.PI / 180;
  return [Math.sin(radians), 0, Math.cos(radians)];
}

test('identical passes are 0 degrees apart and a turned normal reads its exact angle', () => {
  const same = passOf([[0, 0, 1], [0, 1, 0]]);
  assert.deepEqual(measureNormalPassAngle(same, same, 2), { pixels: 2, meanDegrees: 0, p95Degrees: 0, p99Degrees: 0, maxDegrees: 0 });
  const measured = measureNormalPassAngle(passOf([[0, 0, 1]]), passOf([turned(12)]), 1);
  assert.ok(Math.abs(measured.meanDegrees - 12) < 1e-4, `mean ${measured.meanDegrees}`);
});

test('only pixels both passes draw are compared, and the mean and p95 come from those', () => {
  const first = passOf([[0, 0, 1], [0, 0, 1], null, [0, 0, 1]]);
  const second = passOf([turned(10), null, turned(80), turned(30)]);
  assert.deepEqual(Array.from(sharedCoverage(first, second, 4)), [1, 0, 0, 1]);
  const statistics = measureNormalPassAngle(first, second, 4);
  assert.equal(statistics.pixels, 2);
  assert.ok(Math.abs(statistics.meanDegrees - 20) < 1e-4);
  assert.ok(Math.abs(statistics.p95Degrees - 30) < 1e-4);
});

test('p95 is the nearest rank over the covered pixels, not the mean or the maximum of a small tail', () => {
  const angles = Float32Array.from({ length: 100 }, (_, pixel) => pixel + 1);
  const statistics = angleStatistics(angles, new Uint8Array(100).fill(1));
  assert.equal(statistics.p95Degrees, 95);
  assert.equal(statistics.p99Degrees, 99);
  assert.equal(statistics.maxDegrees, 100);
  assert.equal(statistics.meanDegrees, 50.5);
});

test('an empty mask is an error that says what to pass', () => {
  assert.throws(() => angleStatistics(new Float32Array(4), new Uint8Array(4)), /covers no pixel.*same object/);
  assert.throws(() => measureNormalPassAngle(passOf([null]), passOf([[0, 0, 1]]), 1), /covers no pixel/);
});

test('eroding the mask removes the silhouette band and the image edge', () => {
  const mask = new Uint8Array(25).fill(1);
  assert.deepEqual(Array.from(erodeMask(mask, 5, 5, 1)).reduce((total, value) => total + value, 0), 9);
  assert.equal(erodeMask(mask, 5, 5, 0).every(value => value === 1), true);
  assert.throws(() => erodeMask(mask, 5, 5, -1), /radius/);
});

test('pixelAngles leaves pixels outside the mask at zero', () => {
  const angles = pixelAngles(passOf([[0, 0, 1], [0, 0, 1]]), passOf([turned(40), turned(40)]), Uint8Array.of(1, 0));
  assert.ok(Math.abs(angles[0] - 40) < 1e-4);
  assert.equal(angles[1], 0);
});

test('barycentric weights work for 2D UV points as well as 3D points', () => {
  const weights = barycentricWeights([0.25, 0.25], [0, 0], [1, 0], [0, 1]);
  assert.deepEqual(weights.map(value => Math.round(value * 1000) / 1000), [0.5, 0.25, 0.25]);
  assert.equal(barycentricWeights([0, 0], [0, 0], [1, 1], [2, 2]), null);
});

function quad(height) {
  return {
    positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, height, 0, 1, height),
    normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1),
    uvs: Float32Array.of(0, 1, 1, 1, 1, 0, 0, 0),
    indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
  };
}

test('a map baked from the mesh itself is flat blue, and one baked from a tilted copy follows tangent and w', () => {
  const low = { ...quad(0), tangents: Float32Array.of(1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1) };
  const flat = bakeTangentSpaceNormalMap(low, { positions: low.positions, normals: low.normals, indices: low.indices }, { resolution: 8, cage: 0.2 });
  assert.equal(flat.hitTexels, flat.coveredTexels);
  assert.deepEqual(Array.from(flat.data.subarray(0, 4)), [128, 128, 255, 255]);
  // The high surface leans toward +x: its normal in the tangent frame is (sin, 0, cos) with sin = 0.6.
  const lean = [0.6, 0, 0.8];
  const tilted = bakeTangentSpaceNormalMap(low, { positions: low.positions, normals: Float32Array.from([...lean, ...lean, ...lean, ...lean]), indices: low.indices }, { resolution: 8, cage: 0.2 });
  assert.deepEqual(Array.from(tilted.data.subarray(0, 3)), [204, 128, 229]);
  // Handedness -1 flips the bitangent, so a normal leaning toward +y reads green below 128 instead of above.
  const mirrored = { ...low, tangents: Float32Array.of(1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1) };
  const leanUp = [0, 0.6, 0.8];
  const bakedMirrored = bakeTangentSpaceNormalMap(mirrored, { positions: low.positions, normals: Float32Array.from([...leanUp, ...leanUp, ...leanUp, ...leanUp]), indices: low.indices }, { resolution: 8, cage: 0.2 });
  const bakedPlain = bakeTangentSpaceNormalMap(low, { positions: low.positions, normals: Float32Array.from([...leanUp, ...leanUp, ...leanUp, ...leanUp]), indices: low.indices }, { resolution: 8, cage: 0.2 });
  assert.deepEqual(Array.from(bakedPlain.data.subarray(0, 3)), [128, 204, 229]);
  assert.deepEqual(Array.from(bakedMirrored.data.subarray(0, 3)), [128, 51, 229]);
});

test('the baker names what to pass for a bad resolution, cage or tangent array', () => {
  const low = { ...quad(0), tangents: new Float32Array(16) };
  const high = { positions: low.positions, normals: low.normals, indices: low.indices };
  assert.throws(() => bakeTangentSpaceNormalMap(low, high, { resolution: 0, cage: 1 }), /resolution/);
  assert.throws(() => bakeTangentSpaceNormalMap(low, high, { resolution: 8 }), /cage/);
  assert.throws(() => bakeTangentSpaceNormalMap({ ...low, tangents: new Float32Array(3) }, high, { resolution: 8, cage: 1 }), /four values per vertex/);
});

// The GPU half of the tangent gate (the renderer's generated-tangent pass against the spec pass, 0.5 degrees on four
// meshes) needs Chrome and a GPU, so `node scripts/measure-normal-map-tangents.mjs` runs it and exits 1 when it fails.
// What CI can pin is everything the gate stands on: the threshold, the spec pass reading back the baked normal in the
// glTF basis for both handedness signs, and the masks that make the comparison fair.

test('the tangent gate is 0.5 mean degrees and 2 degrees at p99, and counts equal as a pass', () => {
  assert.equal(TANGENT_GATE_MEAN_DEGREES, 0.5);
  assert.equal(TANGENT_GATE_P99_DEGREES, 2);
  assert.equal(meetsTangentGate({ meanDegrees: 0.5, p99Degrees: 2 }), true);
  assert.equal(meetsTangentGate({ meanDegrees: 0.57, p99Degrees: 1 }), false);
  assert.equal(meetsTangentGate({ meanDegrees: 0.1, p99Degrees: 2.5 }), false, 'a thin tail fails even when the mean is small');
});

test('the spec pass reads a baked normal back as the high-poly normal, within the gate, for both handedness signs', () => {
  const camera = { eye: [0.5, 0.5, 3], target: [0.5, 0.5, 0], up: [0, 1, 0], fov: 20 };
  for (const handedness of [1, -1]) {
    const low = { ...quad(0), tangents: Float32Array.of(1, 0, 0, handedness, 1, 0, 0, handedness, 1, 0, 0, handedness, 1, 0, 0, handedness) };
    const lean = [0.3, 0.5, Math.sqrt(1 - 0.09 - 0.25)];
    const high = { positions: low.positions, normals: Float32Array.from([...lean, ...lean, ...lean, ...lean]), indices: low.indices };
    const map = bakeTangentSpaceNormalMap(low, high, { resolution: 64, cage: 0.2 });
    const { pixels, texelOfPixel } = oraclePass(low, map, camera, 16, 10);
    const expected = passOf(Array.from({ length: 256 }, () => lean));
    const covered = Uint8Array.from(texelOfPixel, texel => (texel >= 0 ? 1 : 0));
    assert.ok(covered.reduce((total, value) => total + value, 0) > 100, 'the quad covers most of the frame');
    const statistics = angleStatistics(pixelAngles(pixels, expected, covered), covered);
    assert.ok(meetsTangentGate(statistics), `handedness ${handedness}: mean ${statistics.meanDegrees}, p99 ${statistics.p99Degrees}`);
  }
});

test('the fair-pixel masks drop island borders and normals the renderer bends', () => {
  const resolution = 8;
  const coverage = new Uint8Array(64).fill(1);
  for (let row = 0; row < resolution; row++) coverage[row * resolution + 7] = 0;
  const texelOfPixel = Int32Array.of(3 * resolution + 3, 3 * resolution + 6, -1);
  assert.deepEqual(Array.from(pixelsAwayFromIslandBorders(texelOfPixel, coverage, resolution, 1)), [1, 0, 0]);
  assert.deepEqual(Array.from(pixelsAwayFromIslandBorders(texelOfPixel, coverage, resolution, 0)), [1, 1, 0]);
  const geometric = [0, 0, 1];
  const view = [0, 0, 1];
  assert.equal(normalReflectsAboveSurface([0, 0, 1], geometric, view), true);
  assert.equal(normalReflectsAboveSurface([0.99, 0, 0.14], geometric, view), false, 'tilted so far that the reflection dips below the surface');
  assert.equal(normalReflectsAboveSurface([0, 0, -1], geometric, view), false, 'pointing into the surface');
});
