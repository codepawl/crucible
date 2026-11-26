// A Blender demo's analytic sky reaches its scene file as the baked HDRI plus the view transform's exposure (#2761).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyBlenderWorld, exposureFromStops, readBlenderWorld, sunAngularRadiusFromWorld } from '../scripts/blender-world-sky.mjs';

const MONK_WORLD = { viewTransform: 'Filmic', look: 'Medium Contrast', exposureStops: -2, gamma: 1, sky: { type: 'SINGLE_SCATTERING', sunDisc: true } };
const AIRPORT_DESCRIPTION = {
  id: 'monk', glb: 'scene.glb', hdri: 'airport-sky.hdr', hdriOptions: { intensity: 0.5, showBackground: true },
  exposure: 1, frame: { fov: 50, exposure: 1, effects: { contrast: 1.05 } },
};

test('exposure in stops becomes the multiplier Crucible applies before its tone map', () => {
  assert.equal(exposureFromStops('Filmic', -2), 0.25);
  assert.equal(exposureFromStops('Standard', 0), 1);
  assert.equal(exposureFromStops('AgX', 1), 2);
});

test('a bad exposure or view transform fails with what to pass instead', () => {
  assert.throws(() => exposureFromStops('Filmic', 'dark'), /finite number of stops/);
  assert.throws(() => exposureFromStops('Cinematic', 0), /not one Blender offers: Standard, Filmic/);
});

test('a world sets the baked sky at intensity 1 and the exposure on the scene and the frame, and keeps the rest', () => {
  const described = applyBlenderWorld(AIRPORT_DESCRIPTION, MONK_WORLD);
  assert.equal(described.hdri, 'sky.hdr');
  assert.equal(described.hdriOptions.intensity, 1);
  assert.equal(described.hdriOptions.showBackground, true);
  assert.equal(described.exposure, 0.25);
  assert.equal(described.frame.exposure, 0.25);
  assert.deepEqual(described.frame.effects, { contrast: 1.05 });
  assert.equal(AIRPORT_DESCRIPTION.exposure, 1, 'the description passed in is not changed');
});

test('a scene with no world is returned as it is', () => {
  assert.equal(applyBlenderWorld(AIRPORT_DESCRIPTION, null), AIRPORT_DESCRIPTION);
});

test('readBlenderWorld needs both world.json and the baked sky.hdr', () => {
  const folder = mkdtempSync(join(tmpdir(), 'blender-world-'));
  try {
    assert.equal(readBlenderWorld(folder), null);
    writeFileSync(join(folder, 'world.json'), JSON.stringify(MONK_WORLD));
    assert.equal(readBlenderWorld(folder), null, 'no sky.hdr beside it');
    writeFileSync(join(folder, 'sky.hdr'), 'x');
    assert.deepEqual(readBlenderWorld(folder), MONK_WORLD);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the sky sun size, a diameter, becomes the half-angle on the scene environment and keeps the renderer options', () => {
  const oneDegree = Math.PI / 180;
  const world = { ...MONK_WORLD, sky: { ...MONK_WORLD.sky, sunSizeRadians: oneDegree } };
  const described = applyBlenderWorld({ ...AIRPORT_DESCRIPTION, renderer: { samples: 8, environment: { fillIntensity: 0 } } }, world);
  assert.equal(described.renderer.environment.sunAngularRadius, oneDegree / 2);
  assert.equal(described.renderer.environment.fillIntensity, 0);
  assert.equal(described.renderer.samples, 8);
  const overridden = applyBlenderWorld({ ...AIRPORT_DESCRIPTION, renderer: { environment: { sunAngularRadius: 0.03 } } }, world);
  assert.equal(overridden.renderer.environment.sunAngularRadius, 0.03, 'an explicit scene sunAngularRadius wins over world.json');
  assert.equal(sunAngularRadiusFromWorld(MONK_WORLD), undefined);
  assert.equal(sunAngularRadiusFromWorld({ ...world, sky: { ...world.sky, sunDisc: false } }), undefined);
  assert.equal(sunAngularRadiusFromWorld({ ...world, sky: { ...world.sky, sunSizeRadians: 0.5 } }), undefined);
  assert.equal('renderer' in applyBlenderWorld(AIRPORT_DESCRIPTION, MONK_WORLD), false, 'a world with no sun size adds no renderer');
});
