import assert from 'node:assert/strict';
import test from 'node:test';
import { fresnelSchlick } from '../src/material-layers.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { EMISSION_FRESNEL_SLOT, emissionFresnelFraction, packMaterials, textureFlags } from '../src/path-tracer-gpu-pack.js';
import { FRAGMENT_SOURCE, MATERIAL_TEXELS } from '../src/path-tracer-gpu-shader.js';
import { MEGAKERNEL_SOURCE, WAVEFRONT_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { box } from '../src/geometry.js';

// The GPU tracers scale emission by the same Schlick factor as the CPU tracer (#3282). The factor rides in the fraction of the
// emissive map flags, so the material record keeps its size and a material without the factor packs the bytes it always did.

function packedFloat(material) {
  const part = { name: 'pane', geometry: box(0, 1), material };
  const scene = buildTraceScene([part], {});
  return packMaterials(scene.materials, { placements: new Map() }, scene.shadowOnlyParts, scene.lampLightMasks).data[EMISSION_FRESNEL_SLOT];
}

// What the kernels do with the packed float: the fraction is the encoded reflectance at normal incidence, none when it is 0.
function kernelScale(packed, cosine) {
  const fraction = packed - Math.floor(packed);
  if (!(fraction > 0)) return 1;
  const normalIncidence = 2 * fraction - 1;
  return normalIncidence + (1 - normalIncidence) * (1 - Math.min(Math.max(cosine, 0), 1)) ** 5;
}

test('the packed factor gives the CPU tracer\'s Schlick value at every angle', () => {
  for (const ior of [1, 1.01, 1.5, 3]) {
    const packed = packedFloat({ color: [1, 1, 1], emission: 120, emissionFresnel: ior });
    for (const cosine of [0, 0.1, 0.5, 0.9, 1]) {
      assert.ok(Math.abs(kernelScale(packed, cosine) - fresnelSchlick(cosine, ior)) < 1e-5, `ior ${ior} cosine ${cosine}`);
    }
  }
});

test('a material without the factor packs the same bytes as before', () => {
  assert.equal(packedFloat({ color: [1, 1, 1], emission: 2 }), 0);
  assert.equal(packedFloat({ color: [1, 1, 1], emission: 2, emissionFresnel: 0 }), 0);
  assert.equal(emissionFresnelFraction(0), 0);
});

test('the factor leaves the whole part of the emissive map flags alone', () => {
  const flags = textureFlags({ repeat: true, colorLookup: true });
  const packed = flags + emissionFresnelFraction(1.5);
  assert.equal(Math.floor(packed), flags);
  assert.equal(Math.floor(packed / 2) % 2, 1);
  assert.equal(MATERIAL_TEXELS, 10);
});

test('every tracer kernel scales the emission of a hit by the factor, as the CPU tracer does', () => {
  const scaling = /fresnelFraction = fract\(flagsTwo\.x\);\s*if \(fresnelFraction > 0\.0\)\s*\{?\s*hitEmission \*= 2\.0 \* fresnelFraction - 1\.0 \+ \(2\.0 - 2\.0 \* fresnelFraction\) \* pow\(1\.0 - clamp\(abs\(dot\(direction, hitNormal\)\), 0\.0, 1\.0\), 5\.0\)/;
  assert.match(FRAGMENT_SOURCE, scaling);
  assert.match(MEGAKERNEL_SOURCE, scaling);
  assert.match(WAVEFRONT_SOURCE, scaling);
});
