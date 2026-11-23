import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMaterialSnippet } from '../src/material-snippet.js';
import { layerTextureSupport } from '../src/shader-registry.js';

const SHARED_FRAGMENT = 'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) { color *= tint * radius; }';
const puff = (radius, tint) => normalizeMaterialSnippet({ fragment: SHARED_FRAGMENT, uniforms: { radius, tint } });

function recordUniformsOfDraw(feature, material) {
  const recorded = {};
  const context = {
    getUniformLocation: (program, name) => name,
    uniform1f: (location, value) => { recorded[location] = value; },
    uniform3fv: (location, value) => { recorded[location] = value; },
  };
  const renderer = { context, program: {}, uniforms: {}, shaderFeatures: new Set([feature]) };
  layerTextureSupport.bind(renderer, null, null, { parts: [{ material }] });
  return recorded;
}

test('materials with identical fragment text keep their own uniform values', () => {
  const small = puff(0.5, [1, 0, 0]);
  const large = puff(2, [0, 0, 1]);
  assert.equal(small.feature, large.feature, 'the compiled function is shared');
  const prefix = `u67_${small.feature}_`;
  const smallDraw = recordUniformsOfDraw(small.feature, { snippet: small });
  const largeDraw = recordUniformsOfDraw(large.feature, { snippet: large });
  assert.equal(smallDraw[`${prefix}radius`], 0.5);
  assert.deepEqual(smallDraw[`${prefix}tint`], [1, 0, 0]);
  assert.equal(largeDraw[`${prefix}radius`], 2);
  assert.deepEqual(largeDraw[`${prefix}tint`], [0, 0, 1]);
});
