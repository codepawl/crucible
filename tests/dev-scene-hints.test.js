import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { analyzeDevSceneHints, formatDevSceneHints, installDevSceneHints } from '../src/dev-scene-hints.js';
import { CrucibleRenderer } from '../src/renderer.js';

function translatedPart({ id, translation, normals = true, tag, ground = false }) {
  const geometry = box(0);
  if (!normals) delete geometry.normals;
  return {
    id,
    geometry,
    matrix: mat4.fromTranslation(mat4.create(), translation),
    material: { color: [0.5, 0.5, 0.5], roughness: 0.6, ...(tag ? { tag } : {}) },
    ground,
  };
}

test('analyzeDevSceneHints stays clean for well-grounded lit parts without coplanar overlaps', () => {
  const floor = translatedPart({ id: 'floor', translation: [0, -0.5, 0], ground: true });
  const boxOnFloor = translatedPart({ id: 'crate', translation: [0, 0.5, 0] });
  const report = analyzeDevSceneHints([floor, boxOnFloor], { shading: 'full', ground: true });
  assert.equal(report.ok, true);
  assert.deepEqual(report.hints, []);
  assert.equal(formatDevSceneHints(report), '');
});

test('analyzeDevSceneHints detects unlit shading, missing normals, coplanar overlap, and floating parts', () => {
  const floor = translatedPart({ id: 'floor', translation: [0, 0, 0], normals: false, ground: true });
  const plateOne = translatedPart({ id: 'plate-one', translation: [0, 0, 0], normals: false });
  const floatingProp = translatedPart({ id: 'floating-box', translation: [4, 2.5, 0], normals: false });

  const report = analyzeDevSceneHints([floor, plateOne, floatingProp], {
    shading: 'unlit',
    resolveCoplanar: false,
    groundY: 0.5,
  });
  assert.equal(report.ok, false);
  const codes = report.hints.map(hint => hint.code);
  assert.ok(codes.includes('PLAIN_UNLIT_GEOMETRY'));
  assert.ok(codes.includes('COPLANAR_OVERLAP'));
  assert.ok(codes.includes('FLOATING_PARTS'));
  assert.match(formatDevSceneHints(report), /Crucible devHints found/);

  const flatNormalsOnly = analyzeDevSceneHints([
    translatedPart({ id: 'plain-1', translation: [0, 0, 0], normals: false, ground: true }),
    translatedPart({ id: 'plain-2', translation: [3, 0, 0], normals: false, ground: true }),
  ]);
  assert.ok(flatNormalsOnly.hints.some(hint => hint.code === 'PLAIN_UNLIT_GEOMETRY'));
});

test('installDevSceneHints attaches devHealthReport and notifies callbacks on CrucibleRenderer', () => {
  const renderer = Object.create(CrucibleRenderer.prototype);
  const badParts = [
    translatedPart({ id: 'floor', translation: [0, -0.5, 0], ground: true }),
    translatedPart({ id: 'floating-mug', translation: [0, 2.0, 0] }),
  ];
  Object.assign(renderer, {
    sceneParts: badParts,
    shading: 'full',
    coplanarDiagnostics: null,
    groundPart: badParts[0],
  });

  const warnings = [];
  const warningReport = installDevSceneHints(renderer, { logger: text => warnings.push(text) });
  assert.equal(warningReport.ok, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /FLOATING_PARTS/);

  let reported;
  const callbackReport = installDevSceneHints(renderer, { onReport: value => { reported = value; } });
  assert.equal(renderer.devHealthReport, callbackReport);
  assert.equal(reported, callbackReport);
  assert.ok(callbackReport.hints.some(hint => hint.code === 'FLOATING_PARTS'));
});
