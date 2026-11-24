import test from 'node:test';
import assert from 'node:assert/strict';
import { ballLensExit, curvatureRadius, refractDirection, SCENE_REACH_PER_THICKNESS } from '../src/glass-ball-lens.js';
import { derivedGlassThickness, isClosedSurface, materialWithDerivedThickness } from '../src/glass-thickness.js';
import { materialAlphaState, renderPass } from '../src/renderer.js';
import { createFragmentShader, liquidFragmentSource } from '../src/shaders.js';
import '../src/liquid-shader.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);
const closeVector = (actual, expected, tolerance = 1e-9) => expected.forEach((value, axis) => close(actual[axis], value, tolerance));
const dot = (first, second) => first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
const subtract = (first, second) => first.map((value, axis) => value - second[axis]);
const unit = vector => vector.map(value => value / Math.hypot(...vector));

// An independent reference: trace a ray through a real sphere, intersecting it at both interfaces.
function exactSphereTrace({ center, radius, entryPoint, incident, indexOfRefraction }) {
  const entryNormal = unit(subtract(entryPoint, center));
  const inside = refractDirection(incident, entryNormal, 1 / indexOfRefraction);
  const toCenter = subtract(entryPoint, center);
  const halfB = dot(toCenter, inside);
  const farDistance = -halfB + Math.sqrt(halfB * halfB - (dot(toCenter, toCenter) - radius * radius));
  const exitPoint = entryPoint.map((value, axis) => value + inside[axis] * farDistance);
  const exitNormal = unit(subtract(exitPoint, center));
  const outgoing = refractDirection(inside, exitNormal.map(value => -value), indexOfRefraction);
  return { exitPoint, outgoing };
}

function sphereCase(offsetX) {
  const center = [0, 0, 0];
  const entryPoint = [offsetX, 0, Math.sqrt(1 - offsetX * offsetX)];
  return { center, radius: 1, entryPoint, normal: unit(subtract(entryPoint, center)), viewDirection: [0, 0, 1], incident: [0, 0, -1] };
}

test('the two-interface offset equals an exact trace through a glass sphere, off axis and on axis', () => {
  for (const offsetX of [0, 0.2, 0.45, 0.7]) {
    const { center, radius, entryPoint, normal, viewDirection, incident } = sphereCase(offsetX);
    const exact = exactSphereTrace({ center, radius, entryPoint, incident, indexOfRefraction: 1.5 });
    const model = ballLensExit({ position: entryPoint, normal, viewDirection, indexOfRefraction: 1.5, radius, thickness: 2 * radius });
    closeVector(model.exitPosition, exact.exitPoint);
    closeVector(model.direction, exact.outgoing);
    closeVector(model.samplePosition, exact.exitPoint.map((value, axis) => value + exact.outgoing[axis] * 2 * SCENE_REACH_PER_THICKNESS));
  }
});

test('a ball lens turns an off-axis ray across the axis, so the picture behind magnifies and flips instead of shifting', () => {
  const { entryPoint, normal, viewDirection } = sphereCase(0.5);
  const model = ballLensExit({ position: entryPoint, normal, viewDirection, indexOfRefraction: 1.5, radius: 1, thickness: 2 });
  assert.ok(model.direction[0] < -0.1, `the ray leaves toward the axis: ${model.direction[0]}`);
});

test('a thin-walled surface leaves the ray where it was, and a flat pane only shifts it sideways', () => {
  const viewDirection = unit([0.3, 0, 1]);
  const thin = ballLensExit({ position: [0, 0, 0], normal: [0, 0, 1], viewDirection, indexOfRefraction: 1.5, radius: 1e6, thickness: 1e-9 });
  closeVector(thin.samplePosition, viewDirection.map(value => -value * 1e-9 * (1 + SCENE_REACH_PER_THICKNESS)), 1e-8);
  const pane = ballLensExit({ position: [0, 0, 0], normal: [0, 0, 1], viewDirection, indexOfRefraction: 1.5, radius: 1e6, thickness: 0.1 });
  closeVector(pane.direction, viewDirection.map(value => -value), 1e-6);
  assert.ok(Math.abs(pane.exitPosition[0]) > 0.01, 'the pane offsets the ray sideways');
});

test('curvature radius follows the position over normal step and is clamped to the thickness range', () => {
  close(curvatureRadius(0.02, 0.02, 2), 1);
  close(curvatureRadius(0.001, 0.02, 2), 1);
  close(curvatureRadius(0.02, 0, 2), 2000);
  close(curvatureRadius(5, 0.02, 2), 250);
  close(curvatureRadius(1000, 0.02, 2), 2000);
});

test('the liquid program carries the ball lens and the coverage; the default program does not', () => {
  const liquid = liquidFragmentSource();
  assert.match(liquid, /ballLensRay/);
  assert.match(liquid, /glassCoverage/);
  assert.doesNotMatch(createFragmentShader(new Set()), /ballLensRay|glassCoverage/);
});

const boxPositions = new Float32Array([0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0, 0, 0, 0.5, 2, 0, 0.5, 2, 1, 0.5, 0, 1, 0.5]);
const boxIndices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
const planePositions = new Float32Array([0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0]);
const planeIndices = new Uint32Array([0, 1, 2, 0, 2, 3]);
const capPositions = new Float32Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 1, 1, 0.5]);
const capIndices = new Uint32Array([0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4]);

test('a closed shell takes its smallest extent, a bulging open cap too, and a flat open sheet stays thin-walled', () => {
  assert.equal(isClosedSurface(boxPositions, boxIndices), true);
  assert.equal(isClosedSurface(planePositions, planeIndices), false);
  assert.equal(isClosedSurface(capPositions, capIndices), false);
  close(derivedGlassThickness(boxPositions, boxIndices), 0.5);
  assert.equal(derivedGlassThickness(planePositions, planeIndices), 0);
  close(derivedGlassThickness(capPositions, capIndices), 1);
});

test('an explicit KHR_materials_volume thickness, zero included, is kept and an opaque material is untouched', () => {
  const glass = { transmission: 1, thickness: 0 };
  const geometry = { positions: boxPositions, indices: boxIndices };
  const cache = new Map();
  assert.equal(materialWithDerivedThickness(glass, { extensions: { KHR_materials_volume: { thicknessFactor: 0 } } }, geometry, cache), glass);
  assert.equal(materialWithDerivedThickness({ transmission: 0 }, {}, geometry, cache).thickness, undefined);
  const derived = materialWithDerivedThickness(glass, { extensions: { KHR_materials_transmission: { transmissionFactor: 1 } } }, geometry, cache);
  close(derived.thickness, 0.5);
  assert.equal(derived.mediumContinues, false, 'a closed shell has a back face');
  const cap = materialWithDerivedThickness(glass, {}, { positions: capPositions, indices: capIndices }, cache);
  assert.equal(cap.mediumContinues, true, 'an open cap has none');
  assert.equal(materialWithDerivedThickness(glass, {}, geometry, cache), derived, 'meshes of one size share one material copy');
  assert.equal(glass.thickness, 0, 'the shared material is not changed');
});

test('an explicit thickness always wins over the derived one, on a closed shell and on an open cap', () => {
  const volume = { extensions: { KHR_materials_volume: { thicknessFactor: 0.3 } } };
  const glass = { transmission: 1, thickness: 0.3 };
  const cache = new Map();
  const shell = materialWithDerivedThickness(glass, volume, { positions: boxPositions, indices: boxIndices }, cache);
  const cap = materialWithDerivedThickness(glass, volume, { positions: capPositions, indices: capIndices }, cache);
  assert.equal(shell.thickness, 0.3, 'the derived value for this shell would be 0.5');
  assert.equal(cap.thickness, 0.3, 'the derived value for this cap would be 1');
  assert.equal(shell.mediumContinues, undefined, 'an explicit thickness leaves the medium flag alone');
  assert.equal(shell, glass, 'the material is not copied');
});

test('transmission wins over alpha blend: the part draws in the liquid pass and its alpha becomes coverage', () => {
  const blendedGlass = { transmission: 1, alphaMode: 'blend', opacity: 0.25 };
  assert.equal(renderPass(blendedGlass), 'liquid');
  assert.equal(materialAlphaState(blendedGlass)[2], 0.25);
  assert.equal(materialAlphaState({ alphaMode: 'blend', opacity: 0.25 })[2], 1, 'a blended part without transmission keeps its alpha in the shader');
  assert.equal(materialAlphaState({ transmission: 1, alphaMode: 'opaque', opacity: 0.25 })[2], 1);
});
