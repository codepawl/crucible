import test from 'node:test';
import assert from 'node:assert/strict';
import { BLEND_FACTORS, blendedFragment, compositeBlended } from '../src/blend-output.js';
import { probeEnabledState } from '../src/probe-glsl.js';
import { liquidProbeSupport } from '../src/shader-registry.js';
import { createFragmentShader, liquidFragmentSource } from '../src/shaders.js';
import '../src/liquid-shader.js';
import { probeResourcesOf } from '../src/reflection-probes.js';
import { box } from '../src/geometry.js';
import { createEnvironmentMap } from '../src/environment.js';
import { traceProbes } from '../src/probe-trace.js';

// Issue #1385: glass reflects the room a probe was traced in, and a blended dielectric keeps its specular at full strength.

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('a blended fragment fades the diffuse share only: the reflection is the same at opacity 0.3 and 1', () => {
  const displayedDiffuse = [0.2, 0.3, 0.25];
  const specular = [0.4, 0.4, 0.45];
  const displayed = displayedDiffuse.map((value, index) => value + specular[index]);
  const background = [0.1, 0.5, 0.1];
  const opaque = compositeBlended(background, blendedFragment(displayed, displayedDiffuse, 1));
  const faint = compositeBlended(background, blendedFragment(displayed, displayedDiffuse, 0.3));
  // The part of the frame that is not the diffuse body or the background is the reflection.
  const faintReflection = faint.map((value, index) => value - 0.3 * displayedDiffuse[index] - 0.7 * background[index]);
  specular.forEach((value, index) => close(faintReflection[index], value));
  close(opaque[0], displayed[0]);
});

test('a texel the texture leaves transparent shows no reflection, while a uniformly translucent material keeps it (#3110)', () => {
  const displayedDiffuse = [0.2, 0.3, 0.25];
  const specular = [0.4, 0.4, 0.45];
  const displayed = displayedDiffuse.map((value, index) => value + specular[index]);
  const background = [0.1, 0.5, 0.1];
  const cutOutTexel = compositeBlended(background, blendedFragment(displayed, displayedDiffuse, 0, 0));
  cutOutTexel.forEach((value, index) => close(value, background[index]));
  const halfCovered = blendedFragment(displayed, displayedDiffuse, 0.5, 0.5);
  halfCovered.slice(0, 3).forEach((value, index) => close(value, 0.5 * displayedDiffuse[index] + 0.5 * specular[index]));
  const glass = blendedFragment(displayed, displayedDiffuse, 0.3, 1);
  glass.slice(0, 3).forEach((value, index) => close(value, 0.3 * displayedDiffuse[index] + specular[index]));
});

test('opacity 1 and a part without specular composite exactly as the old SRC_ALPHA blend did', () => {
  const colour = [0.3, 0.6, 0.2];
  const background = [0.5, 0.4, 0.3];
  const alpha = 0.4;
  const old = colour.map((value, index) => value * alpha + background[index] * (1 - alpha));
  const next = compositeBlended(background, blendedFragment(colour, colour, alpha));
  next.forEach((value, index) => close(value, old[index]));
});

test('a blended part draws with premultiplied factors', () => {
  assert.deepEqual(BLEND_FACTORS, { sourceColor: 'ONE', destinationColor: 'ONE_MINUS_SRC_ALPHA', sourceAlpha: 'ONE', destinationAlpha: 'ONE_MINUS_SRC_ALPHA' });
});

test('the lit program writes blend parts premultiplied and keeps the specular of every light and the environment apart', () => {
  const source = createFragmentShader(['alphaMode']);
  assert.match(source, /vec4 blendedOutput\(vec3 displayed, vec3 displayedDiffuse, float alpha, float coverage\)/);
  assert.match(source, /displayedDiffuse \* alpha \+ \(displayed - displayedDiffuse\) \* coverage/);
  assert.match(source, /vec4 blendedOutput\(/);
  assert.match(source, /outputColor = blendedOutput\(displayedColor, displayedDiffuse, alpha, clamp\(textureAlpha, 0\.0, 1\.0\)\)/);
  assert.match(source, /blendSpecular \+= specular \* radiance \* normalLight/);
  assert.match(source, /blendSpecular \+= environmentLighting\(/);
  assert.match(source, /#define USES_ALPHA_MODE \(alphaMode > 0\.5\)/);
  assert.match(createFragmentShader([]), /#define USES_ALPHA_MODE false/);
  // Shaders without a blend part keep the plain three-argument form, so their source is the one they had before #3110.
  assert.match(createFragmentShader([]), /vec4 blendedOutput\(vec3 displayed, vec3 displayedDiffuse, float alpha\) \{/);
  assert.doesNotMatch(createFragmentShader([]), /float coverage\)/);
});

test('probeEnabledState is 0 without a probe, 1 with one and 2 when the probe knows its floor', () => {
  assert.equal(probeEnabledState(null), 0);
  assert.equal(probeEnabledState({ data: new Float32Array(3) }), 1);
  assert.equal(probeEnabledState({ data: new Float32Array(3), parallax: [0, 1, 0, 0] }), 2);
});

test('the liquid shader reflects the probe when one is bound', () => {
  const source = liquidFragmentSource();
  assert.match(source, /uniform float probeEnabled;/);
  assert.match(source, /if \(probeEnabled > 0\.5\) return environmentRadiance\(probeSampleDirection\(direction, worldPosition\)/);
});

// A recording stand-in for the renderer: enough to see which texture and uniforms a liquid batch is given.
function fakeRenderer() {
  const calls = [];
  const uniforms = Object.fromEntries(['probeEnabled', 'probeFloor', 'environmentIntensity', 'environmentRotation', 'environmentLevelMax'].map(name => [name, name]));
  const context = {
    uniform1f: (name, value) => calls.push(['uniform1f', name, value]),
    uniform2f: (name, ...values) => calls.push(['uniform2f', name, ...values]),
    uniform4fv: (name, value) => calls.push(['uniform4fv', name, [...value]]),
    getUniformLocation: (_program, name) => name,
    getParameter: () => null,
    activeTexture() {},
    bindTexture() {},
    bindFramebuffer() {},
    useProgram() {},
    bindVertexArray() {},
    viewport() {},
    enable() {},
    disable() {},
    isEnabled: () => false,
    deleteTexture() {},
  };
  const renderer = {
    context,
    program: {},
    activeMap: null,
    textures: new Map(),
    whiteTexture: 'white',
    environmentResources: null,
    bound: [],
    bindEnvironmentTextures(specular) {
      this.bound.push(specular);
    },
    activateEnvironment(map) {
      this.bound.push(map ? 'global' : 'white');
    },
    applyEnvironmentUniforms: () => calls.push(['applyEnvironmentUniforms']),
  };
  return { renderer, uniforms, calls };
}

test('the liquid pass binds nothing for a batch without a probe', () => {
  const { renderer, uniforms, calls } = fakeRenderer();
  liquidProbeSupport.bind(renderer, uniforms, { mapState: [] });
  liquidProbeSupport.finish(renderer, uniforms);
  assert.deepEqual(calls, []);
  assert.deepEqual(renderer.bound, []);
});

test('the liquid pass turns the probe on for its batch and hands the global environment back after it', () => {
  const { renderer, uniforms, calls } = fakeRenderer();
  const probeMap = { data: new Float32Array(3), rotation: 0, parallax: [1, 2, 3, 0] };
  probeResourcesOf(renderer).set(probeMap.data, { specularTexture: 'probe-specular', levelCount: 5 });
  renderer.activeMap = { intensity: 1 };
  liquidProbeSupport.bind(renderer, uniforms, { mapState: Object.assign([], { 19: probeMap }) });
  assert.deepEqual(renderer.bound, ['probe-specular']);
  assert.deepEqual(calls.filter(call => call[1] === 'probeEnabled'), [['uniform1f', 'probeEnabled', 2]]);
  assert.deepEqual(calls.find(call => call[1] === 'probeFloor'), ['uniform4fv', 'probeFloor', [1, 2, 3, 0]]);
  assert.deepEqual(calls.find(call => call[1] === 'environmentLevelMax'), ['uniform1f', 'environmentLevelMax', 4]);
  liquidProbeSupport.bind(renderer, uniforms, { mapState: [] });
  assert.deepEqual(renderer.bound, ['probe-specular', 'global']);
  assert.deepEqual(calls.filter(call => call[1] === 'probeEnabled').at(-1), ['uniform1f', 'probeEnabled', 0]);
  liquidProbeSupport.finish(renderer, uniforms);
  assert.deepEqual(renderer.bound, ['probe-specular', 'global']);
});

test('the pass leaves the global environment bound when its last batch had a probe', () => {
  const { renderer, uniforms } = fakeRenderer();
  const probeMap = { data: new Float32Array(3), rotation: 0 };
  probeResourcesOf(renderer).set(probeMap.data, { specularTexture: 'probe-specular', levelCount: 3 });
  liquidProbeSupport.bind(renderer, uniforms, { mapState: Object.assign([], { 19: probeMap }) });
  liquidProbeSupport.finish(renderer, uniforms);
  assert.deepEqual(renderer.bound, ['probe-specular', 'white']);
});

function wallPlacement(translation, scale, name, color) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: box(0, 1), matrix, material: { tag: 'surface', color, metallic: 0, roughness: 0.8, emission: 0 } };
}

const greySky = () => createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(1) });

// The map is equirectangular around -z: a ray along -x sits a quarter of the way across, on the equator.
function radianceAlongMinusX(probe) {
  const offset = (Math.floor(probe.height / 2) * probe.width + Math.floor(probe.width * 0.25)) * 3;
  return [probe.data[offset], probe.data[offset + 1], probe.data[offset + 2]];
}

test('a probe placed by hand sees a wall lit by the environment map, not a black one (#1385)', () => {
  const wall = wallPlacement([-4, 1.5, 0], [0.2, 6, 6], 'red wall', [0.8, 0.1, 0.1]);
  const trace = traceProbes([wall], { keyColor: [0, 0, 0] }, [{ position: [0, 1.5, 0], radius: 10 }], { environmentMap: greySky() });
  const radiance = radianceAlongMinusX(trace.traced[0]);
  assert.ok(radiance[0] > 0.3, `the red channel of the wall is ${radiance[0]}`);
  assert.ok(radiance[0] > radiance[1] * 4, 'the wall keeps its red colour');
});

test('the automatic room probe leaves the walls of an enclosed room unlit by the sky', () => {
  const grey = [0.7, 0.7, 0.7];
  const room = [
    wallPlacement([0, -0.05, 0], [6, 0.1, 6], 'floor', grey), wallPlacement([0, 3.05, 0], [6, 0.1, 6], 'ceiling', grey),
    wallPlacement([0, 1.5, -3.05], [6, 3.2, 0.1], 'back', grey), wallPlacement([0, 1.5, 3.05], [6, 3.2, 0.1], 'front', grey),
    wallPlacement([-3.05, 1.5, 0], [0.1, 3.2, 6], 'left', grey), wallPlacement([3.05, 1.5, 0], [0.1, 3.2, 6], 'right', grey),
  ];
  const [probe] = traceProbes(room, { keyColor: [0, 0, 0] }, 'room', { environmentMap: greySky() }).traced;
  assert.ok(probe, 'the closed room gets its probe');
  assert.ok(Math.max(...probe.data) < 1e-6, 'nothing in the closed room is lit');
});
