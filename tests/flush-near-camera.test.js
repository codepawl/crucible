import test from 'node:test';
import assert from 'node:assert/strict';
import { FLUSH_MINIMUM_DISTANCE, vertexShader } from '../src/shaders.js';

// The vertex shader's depth rank (src/shaders.js, renderer applyDepthRank) modelled in plain numbers, for a camera looking down -z with a
// standard 24-bit projection. A face is drawn as clip-space vertices; the rasteriser interpolates clip z and w linearly, so the depth of a
// fragment is the weighted sum of the vertex z over the weighted sum of the vertex w.
const NEAR = 0.1;
const FAR = 1000;
const METRES_PER_RANK = 1e-4;
const RELATIVE_PER_RANK = 2 ** -19;
const CLIP_PER_RANK = 2 ** -22;
const DEPTH_PER_METRE = (FAR + NEAR) / (FAR - NEAR);

function clipOf(distanceAhead) {
  return { z: ((FAR + NEAR) / (NEAR - FAR)) * -distanceAhead + (2 * FAR * NEAR) / (NEAR - FAR), w: distanceAhead };
}

// The lift as the shader had it before the floor: exact at a distance, unbounded near the camera plane.
function liftedZLegacy(vertex, rank) {
  const metres = rank * (METRES_PER_RANK + RELATIVE_PER_RANK * vertex.w);
  const liftedZ = vertex.z - metres * DEPTH_PER_METRE;
  const liftedW = vertex.w - metres;
  return (liftedZ / liftedW - rank * CLIP_PER_RANK) * vertex.w;
}

function liftedZ(vertex, rank) {
  const liftDistance = Math.max(vertex.w, FLUSH_MINIMUM_DISTANCE);
  const metres = rank * (METRES_PER_RANK + RELATIVE_PER_RANK * liftDistance);
  const metricLift = (vertex.z - metres * DEPTH_PER_METRE) / (liftDistance - metres) - vertex.z / liftDistance;
  return vertex.z + metricLift * Math.max(vertex.w, 0) - rank * CLIP_PER_RANK * vertex.w;
}

// Fragments of a long face with one corner behind the camera plane (a wall the camera is passing the end of), as depth in -1..1.
// Returns the depth a rank-0 face and a rank-1 face (the decal) store at each fragment that is in front of the near plane.
function fragmentDepths(cornerDistances, lift) {
  const corners = cornerDistances.map(clipOf);
  const samples = [];
  for (let first = 0; first <= 20; first++) {
    for (let second = 0; first + second <= 20; second++) {
      const weights = [first / 20, second / 20, (20 - first - second) / 20];
      const w = weights.reduce((sum, weight, index) => sum + weight * corners[index].w, 0);
      if (w < NEAR) continue;
      const depthOf = z => weights.reduce((sum, weight, index) => sum + weight * z(corners[index]), 0) / w;
      samples.push({ plain: depthOf(vertex => vertex.z), ranked: depthOf(vertex => lift(vertex, 1)) });
    }
  }
  return samples;
}

// Distances ahead of the camera plane of the three corners: one behind it by 0.1 m to 3 m, two far along a 24 m wall.
const WALL_CORNERS = [-0.1, -0.29, -1, -3].map(behind => [behind, 24, 24]);

test('a decal stays in front of its wall when a corner of the wall is behind the camera plane', () => {
  for (const corners of WALL_CORNERS) {
    const samples = fragmentDepths(corners, liftedZ);
    assert.ok(samples.length > 20, `fragments exist for corners ${corners}`);
    for (const { plain, ranked } of samples) {
      assert.ok(ranked < plain, `the ranked face is nearer: ${ranked} against ${plain} for corners ${corners}`);
      assert.ok(plain - ranked < 1e-3, 'and not thrown far toward the eye');
    }
  }
});

test('the lift without the distance floor lost the decal behind a wall corner next to the camera plane', () => {
  const failures = WALL_CORNERS.flatMap(corners => fragmentDepths(corners, liftedZLegacy)).filter(({ plain, ranked }) => !(ranked < plain));
  assert.ok(failures.length > 0, 'the model reproduces the dip of frames 7 and 8 of the dolly clip');
});

test('the vertex shader floors the rank distance and ignores the metric lift of a vertex behind the camera plane', () => {
  assert.ok(vertexShader.includes(`float liftDistance = max(gl_Position.w, ${FLUSH_MINIMUM_DISTANCE.toFixed(1)});`));
  assert.ok(vertexShader.includes('metricLift * max(gl_Position.w, 0.0) + flushBias.z * gl_Position.w'));
  assert.ok(!vertexShader.includes('lifted.z / lifted.w + flushBias.z'), 'the unbounded lift is gone');
});
