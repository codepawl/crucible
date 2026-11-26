// Camera-local falling rain streaks, ground splashes and optional wet-surface pairing (#3230).
// Kept out of the core bundle as `@codepawlhq/crucible/addons/rain` and purely deterministic for any time and camera.
import { compileProgram } from './gl-program.js';

export const RAIN_LIMITS = Object.freeze({
  minDensity: 100,
  maxDensity: 6000,
  minSplashCount: 0,
  maxSplashCount: 1200,
  minVolume: 2,
  maxVolume: 120,
  minSpeed: 2,
  maxSpeed: 40,
  minLength: 0.05,
  maxLength: 2,
  minWidth: 0.002,
  maxWidth: 0.06,
  maxWind: 20,
  maxColor: 2,
  maxCurveKeys: 64,
});

export const RAIN_DEFAULTS = Object.freeze({
  intensity: 0.6,
  density: 2400,
  volume: Object.freeze([24, 18, 28]),
  speed: 16,
  streakLength: 0.45,
  streakWidth: 0.014,
  wind: Object.freeze([1.2, 0.4]),
  color: Object.freeze([0.78, 0.85, 0.94]),
  opacity: 0.42,
  splashes: true,
  splashCount: 400,
  groundHeight: 0,
  wetness: null,
  seed: 1,
});

const RAIN_FIELDS = new Set([
  'intensity',
  'intensityCurve',
  'density',
  'volume',
  'speed',
  'streakLength',
  'streakWidth',
  'wind',
  'color',
  'opacity',
  'splashes',
  'splashCount',
  'groundHeight',
  'wetness',
  'seed',
]);

const QUAD_CORNERS = new Float32Array([-0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1]);
const SPLASH_CORNERS = new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 2, 1, 3]);

const STREAK_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 corner;
layout(location = 1) in vec4 instanceSeed;

uniform mat4 viewProjection;
uniform vec3 eye;
uniform vec3 anchor;
uniform vec3 volume;
uniform vec2 wind;
uniform float time;
uniform float speed;
uniform float streakLength;
uniform float streakWidth;

out vec2 quadUv;
out float streakAlpha;

void main() {
  vec3 velocity = vec3(wind.x, -speed, wind.y);
  vec3 wrapped = fract(instanceSeed.xyz + (velocity * time - anchor) / volume) - 0.5;
  vec3 baseWorld = anchor + wrapped * volume;

  vec3 fallDirection = normalize(velocity);
  vec3 toEye = eye - baseWorld;
  float eyeDistance = length(toEye);
  vec3 rawSide = cross(toEye, fallDirection);
  float sideLength = length(rawSide);
  vec3 sideDirection = sideLength > 1e-4 ? rawSide / sideLength : vec3(1.0, 0.0, 0.0);

  float dropLength = streakLength * mix(0.75, 1.3, instanceSeed.w);
  float dropWidth = streakWidth * mix(0.8, 1.25, instanceSeed.w);
  vec3 worldPosition = baseWorld + sideDirection * (corner.x * dropWidth) + fallDirection * (corner.y * dropLength);

  vec3 edgeDistance = 0.5 - abs(wrapped);
  float volumeFade = clamp(min(min(edgeDistance.x, edgeDistance.y), edgeDistance.z) * 6.0, 0.0, 1.0);
  float nearFade = smoothstep(0.65, 2.4, eyeDistance);

  quadUv = corner;
  streakAlpha = volumeFade * nearFade * mix(0.55, 1.0, instanceSeed.w);
  gl_Position = viewProjection * vec4(worldPosition, 1.0);
}`;

const STREAK_FRAGMENT = `#version 300 es
precision highp float;
in vec2 quadUv;
in float streakAlpha;

uniform vec3 rainColor;
uniform float opacity;

out vec4 fragmentColor;

void main() {
  float across = 1.0 - abs(quadUv.x * 2.0);
  float along = smoothstep(0.0, 0.25, quadUv.y) * smoothstep(1.0, 0.35, quadUv.y);
  float alpha = across * across * along * streakAlpha * opacity;
  if (alpha <= 0.002) discard;
  fragmentColor = vec4(rainColor, alpha);
}`;

const SPLASH_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 corner;
layout(location = 1) in vec3 splashSeed;

uniform mat4 viewProjection;
uniform vec2 anchorXz;
uniform vec2 volumeXz;
uniform float groundHeight;
uniform float time;

out vec2 splashUv;
out float splashPhase;

vec2 hashCycle(vec2 seedPair, float cycle) {
  float first = fract(sin(dot(seedPair + vec2(cycle * 0.137, cycle * 0.293), vec2(12.9898, 78.233))) * 43758.5453);
  float second = fract(sin(dot(seedPair + vec2(cycle * 0.419, cycle * 0.181), vec2(93.989, 67.345))) * 24634.6345);
  return vec2(first, second);
}

void main() {
  float timeline = time * 2.6 + splashSeed.z;
  float cycle = floor(timeline);
  float age = timeline - cycle;
  vec2 jitter = hashCycle(splashSeed.xy, cycle);
  vec2 wrapped = fract(mix(splashSeed.xy, jitter, 0.65) - anchorXz / volumeXz) - 0.5;
  vec2 worldXz = anchorXz + wrapped * volumeXz;

  float radius = mix(0.03, 0.19, age);
  vec3 worldPosition = vec3(worldXz.x + corner.x * radius * 2.0, groundHeight + 0.008, worldXz.y + corner.y * radius * 2.0);
  splashUv = corner * 2.0;
  splashPhase = age;
  gl_Position = viewProjection * vec4(worldPosition, 1.0);
}`;

const SPLASH_FRAGMENT = `#version 300 es
precision highp float;
in vec2 splashUv;
in float splashPhase;

uniform vec3 rainColor;
uniform float opacity;

out vec4 fragmentColor;

void main() {
  float radial = length(splashUv);
  if (radial > 1.0) discard;
  float ringTarget = mix(0.28, 0.85, splashPhase);
  float ring = exp(-pow((radial - ringTarget) * 10.0, 2.0));
  float envelope = sin(3.14159265 * splashPhase) * (1.0 - splashPhase * 0.6);
  float centerGlow = exp(-radial * radial * 9.0) * 0.25 * (1.0 - splashPhase);
  float alpha = (ring * 0.55 + centerGlow) * envelope * opacity;
  if (alpha <= 0.002) discard;
  fragmentColor = vec4(rainColor, alpha);
}`;

function requireRangeNumber(name, value, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a finite number from ${minimum} to ${maximum}, got ${value}.`);
  }
  return value;
}

function requireRangeInteger(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}, got ${value}.`);
  }
  return value;
}

function requireVector(name, value, length, minimum, maximum) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${name} must be an array of ${length} numbers.`);
  }
  return Object.freeze(value.map((component, index) => requireRangeNumber(`${name}[${index}]`, component, minimum, maximum)));
}

function resolveIntensityCurve(curve) {
  if (curve === undefined || curve === null) return null;
  if (!Array.isArray(curve) || curve.length < 2 || curve.length > RAIN_LIMITS.maxCurveKeys) {
    throw new RangeError(`rain.intensityCurve must contain 2 to ${RAIN_LIMITS.maxCurveKeys} keyframes.`);
  }
  let previousTime = -Infinity;
  return Object.freeze(curve.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`rain.intensityCurve[${index}] must be an object with time and value.`);
    }
    const time = requireRangeNumber(`rain.intensityCurve[${index}].time`, entry.time, 0, 1e6);
    if (time < previousTime) {
      throw new RangeError(`rain.intensityCurve[${index}].time (${time}) must not decrease before ${previousTime}.`);
    }
    previousTime = time;
    const value = requireRangeNumber(`rain.intensityCurve[${index}].value`, entry.value, 0, 1);
    return Object.freeze({ time, value });
  }));
}

/**
 * Validates and freezes a camera-local rain configuration.
 * All defaults come from `RAIN_DEFAULTS`. Throws explicit errors on out-of-range fields.
 */
export function resolveRain(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('rain must be a plain configuration object.');
  }
  for (const key of Object.keys(input)) {
    if (!RAIN_FIELDS.has(key)) {
      throw new TypeError(`Unknown rain field "${key}". Allowed fields: ${[...RAIN_FIELDS].join(', ')}.`);
    }
  }
  const splashes = input.splashes ?? RAIN_DEFAULTS.splashes;
  if (typeof splashes !== 'boolean') {
    throw new TypeError(`rain.splashes must be true or false, got ${JSON.stringify(splashes)}.`);
  }
  const wetness = input.wetness === undefined || input.wetness === null
    ? null
    : requireRangeNumber('rain.wetness', input.wetness, 0, 1);

  return Object.freeze({
    intensity: requireRangeNumber('rain.intensity', input.intensity ?? RAIN_DEFAULTS.intensity, 0, 1),
    intensityCurve: resolveIntensityCurve(input.intensityCurve),
    density: requireRangeInteger('rain.density', input.density ?? RAIN_DEFAULTS.density, RAIN_LIMITS.minDensity, RAIN_LIMITS.maxDensity),
    volume: input.volume === undefined ? RAIN_DEFAULTS.volume : requireVector('rain.volume', input.volume, 3, RAIN_LIMITS.minVolume, RAIN_LIMITS.maxVolume),
    speed: requireRangeNumber('rain.speed', input.speed ?? RAIN_DEFAULTS.speed, RAIN_LIMITS.minSpeed, RAIN_LIMITS.maxSpeed),
    streakLength: requireRangeNumber('rain.streakLength', input.streakLength ?? RAIN_DEFAULTS.streakLength, RAIN_LIMITS.minLength, RAIN_LIMITS.maxLength),
    streakWidth: requireRangeNumber('rain.streakWidth', input.streakWidth ?? RAIN_DEFAULTS.streakWidth, RAIN_LIMITS.minWidth, RAIN_LIMITS.maxWidth),
    wind: input.wind === undefined ? RAIN_DEFAULTS.wind : requireVector('rain.wind', input.wind, 2, -RAIN_LIMITS.maxWind, RAIN_LIMITS.maxWind),
    color: input.color === undefined ? RAIN_DEFAULTS.color : requireVector('rain.color', input.color, 3, 0, RAIN_LIMITS.maxColor),
    opacity: requireRangeNumber('rain.opacity', input.opacity ?? RAIN_DEFAULTS.opacity, 0, 1),
    splashes,
    splashCount: requireRangeInteger('rain.splashCount', input.splashCount ?? RAIN_DEFAULTS.splashCount, RAIN_LIMITS.minSplashCount, RAIN_LIMITS.maxSplashCount),
    groundHeight: requireRangeNumber('rain.groundHeight', input.groundHeight ?? RAIN_DEFAULTS.groundHeight, -1e4, 1e4),
    wetness,
    seed: requireRangeInteger('rain.seed', input.seed ?? RAIN_DEFAULTS.seed, -2147483647, 2147483647),
  });
}

/** Evaluates rain intensity cleanly at any time, including backward time seeks. */
export function sampleRainIntensity(rain, time = 0) {
  const curve = rain.intensityCurve;
  if (!curve) return rain.intensity;
  const safeTime = Number.isFinite(time) ? time : 0;
  if (safeTime <= curve[0].time) return curve[0].value;
  const last = curve[curve.length - 1];
  if (safeTime >= last.time) return last.value;
  for (let index = 1; index < curve.length; index++) {
    const previous = curve[index - 1];
    const current = curve[index];
    if (safeTime <= current.time) {
      const span = current.time - previous.time;
      const fraction = span > 0 ? (safeTime - previous.time) / span : 0;
      return previous.value + (current.value - previous.value) * fraction;
    }
  }
  return last.value;
}

function nextSeededRandom(state) {
  let mixed = (state + 0x6d2b79f5) | 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
  mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
}

/** Deterministic seeded streak buffer (`density * 4` floats in `[0, 1)`). */
export function generateRainSeedData(density, seed) {
  const values = new Float32Array(density * 4);
  let state = (seed | 0) ^ 0x9e3779b9;
  for (let index = 0; index < values.length; index++) {
    state = (state + 0x6d2b79f5) | 0;
    values[index] = nextSeededRandom(state);
  }
  return values;
}

/** Deterministic seeded ground splash buffer (`splashCount * 3` floats in `[0, 1)`). */
export function generateSplashSeedData(splashCount, seed) {
  const values = new Float32Array(splashCount * 3);
  let state = ((seed | 0) + 17) ^ 0x85ebca6b;
  for (let index = 0; index < values.length; index++) {
    state = (state + 0x6d2b79f5) | 0;
    values[index] = nextSeededRandom(state);
  }
  return values;
}

function resolvedFrameRain(frame) {
  const raw = frame?.rain ?? frame?.environment?.rain;
  if (!raw) return null;
  return Object.isFrozen(raw) && typeof raw.streakLength === 'number' ? raw : resolveRain(raw);
}

/**
 * Installs deterministic camera-local rain streaks and ground splashes on a `CrucibleRenderer`.
 * Pairs `rain.wetness` with `environment.wetness` when provided and not overridden by the caller.
 */
export function installRain(renderer) {
  if (!renderer || typeof renderer.render !== 'function' || typeof renderer.drawBlendBatches !== 'function') {
    throw new TypeError('installRain expects a CrucibleRenderer instance.');
  }
  if (renderer.rainSupport) return renderer;

  const context = renderer.context;
  const originalRender = renderer.render.bind(renderer);
  const originalDrawBlendBatches = renderer.drawBlendBatches.bind(renderer);
  const originalDispose = renderer.dispose.bind(renderer);

  let streakProgram = null;
  let streakUniforms = null;
  let streakVao = null;
  let streakQuadBuffer = null;
  let streakIndexBuffer = null;
  let streakInstanceBuffer = null;
  let uploadedDensity = -1;
  let uploadedSeed = null;

  let splashProgram = null;
  let splashUniforms = null;
  let splashVao = null;
  let splashQuadBuffer = null;
  let splashInstanceBuffer = null;
  let uploadedSplashCount = -1;
  let uploadedSplashSeed = null;

  let currentRain = null;
  let currentIntensity = 0;

  function ensureSharedIndexBuffer() {
    if (streakIndexBuffer) return streakIndexBuffer;
    streakIndexBuffer = context.createBuffer();
    context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, streakIndexBuffer);
    context.bufferData(context.ELEMENT_ARRAY_BUFFER, QUAD_INDICES, context.STATIC_DRAW);
    return streakIndexBuffer;
  }

  function ensureStreakResources(density, seed) {
    if (!streakProgram) {
      streakProgram = compileProgram(context, STREAK_VERTEX, STREAK_FRAGMENT);
      streakUniforms = {
        viewProjection: context.getUniformLocation(streakProgram, 'viewProjection'),
        eye: context.getUniformLocation(streakProgram, 'eye'),
        anchor: context.getUniformLocation(streakProgram, 'anchor'),
        volume: context.getUniformLocation(streakProgram, 'volume'),
        wind: context.getUniformLocation(streakProgram, 'wind'),
        time: context.getUniformLocation(streakProgram, 'time'),
        speed: context.getUniformLocation(streakProgram, 'speed'),
        streakLength: context.getUniformLocation(streakProgram, 'streakLength'),
        streakWidth: context.getUniformLocation(streakProgram, 'streakWidth'),
        rainColor: context.getUniformLocation(streakProgram, 'rainColor'),
        opacity: context.getUniformLocation(streakProgram, 'opacity'),
      };
      streakVao = context.createVertexArray();
      context.bindVertexArray(streakVao);

      streakQuadBuffer = context.createBuffer();
      context.bindBuffer(context.ARRAY_BUFFER, streakQuadBuffer);
      context.bufferData(context.ARRAY_BUFFER, QUAD_CORNERS, context.STATIC_DRAW);
      context.enableVertexAttribArray(0);
      context.vertexAttribPointer(0, 2, context.FLOAT, false, 0, 0);

      ensureSharedIndexBuffer();
      context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, streakIndexBuffer);

      streakInstanceBuffer = context.createBuffer();
      context.bindBuffer(context.ARRAY_BUFFER, streakInstanceBuffer);
      context.enableVertexAttribArray(1);
      context.vertexAttribPointer(1, 4, context.FLOAT, false, 0, 0);
      context.vertexAttribDivisor(1, 1);
      context.bindVertexArray(null);
    }

    if (uploadedDensity !== density || uploadedSeed !== seed) {
      context.bindBuffer(context.ARRAY_BUFFER, streakInstanceBuffer);
      context.bufferData(context.ARRAY_BUFFER, generateRainSeedData(density, seed), context.STATIC_DRAW);
      uploadedDensity = density;
      uploadedSeed = seed;
    }
  }

  function ensureSplashResources(splashCount, seed) {
    if (!splashProgram) {
      splashProgram = compileProgram(context, SPLASH_VERTEX, SPLASH_FRAGMENT);
      splashUniforms = {
        viewProjection: context.getUniformLocation(splashProgram, 'viewProjection'),
        anchorXz: context.getUniformLocation(splashProgram, 'anchorXz'),
        volumeXz: context.getUniformLocation(splashProgram, 'volumeXz'),
        groundHeight: context.getUniformLocation(splashProgram, 'groundHeight'),
        time: context.getUniformLocation(splashProgram, 'time'),
        rainColor: context.getUniformLocation(splashProgram, 'rainColor'),
        opacity: context.getUniformLocation(splashProgram, 'opacity'),
      };
      splashVao = context.createVertexArray();
      context.bindVertexArray(splashVao);

      splashQuadBuffer = context.createBuffer();
      context.bindBuffer(context.ARRAY_BUFFER, splashQuadBuffer);
      context.bufferData(context.ARRAY_BUFFER, SPLASH_CORNERS, context.STATIC_DRAW);
      context.enableVertexAttribArray(0);
      context.vertexAttribPointer(0, 2, context.FLOAT, false, 0, 0);

      ensureSharedIndexBuffer();
      context.bindBuffer(context.ELEMENT_ARRAY_BUFFER, streakIndexBuffer);

      splashInstanceBuffer = context.createBuffer();
      context.bindBuffer(context.ARRAY_BUFFER, splashInstanceBuffer);
      context.enableVertexAttribArray(1);
      context.vertexAttribPointer(1, 3, context.FLOAT, false, 0, 0);
      context.vertexAttribDivisor(1, 1);
      context.bindVertexArray(null);
    }

    if (uploadedSplashCount !== splashCount || uploadedSplashSeed !== seed) {
      context.bindBuffer(context.ARRAY_BUFFER, splashInstanceBuffer);
      context.bufferData(context.ARRAY_BUFFER, generateSplashSeedData(splashCount, seed), context.STATIC_DRAW);
      uploadedSplashCount = splashCount;
      uploadedSplashSeed = seed;
    }
  }

  function drawRainForFrame(frame) {
    if (!currentRain || !(currentIntensity > 0)) return;
    const rain = currentRain;
    const time = frame.time ?? 0;
    const eye = frame.eye ?? [0, 1.5, 5];
    const forward = renderer.viewForward ?? [0, 0, -1];
    const anchor = [
      eye[0] + forward[0] * (rain.volume[2] * 0.42),
      eye[1] + forward[1] * (rain.volume[2] * 0.15),
      eye[2] + forward[2] * (rain.volume[2] * 0.42),
    ];

    const lighting = renderer.lighting;
    const key = lighting?.keyColor ?? [1, 1, 1];
    const ambient = lighting?.ambientColor ?? [0.3, 0.35, 0.4];
    const lightTint = [
      Math.min(1.5, 0.25 + (key[0] + ambient[0]) * 0.35),
      Math.min(1.5, 0.25 + (key[1] + ambient[1]) * 0.35),
      Math.min(1.5, 0.25 + (key[2] + ambient[2]) * 0.35),
    ];
    const rainColor = [rain.color[0] * lightTint[0], rain.color[1] * lightTint[1], rain.color[2] * lightTint[2]];

    context.enable(context.DEPTH_TEST);
    context.enable(context.BLEND);
    context.blendFuncSeparate(context.SRC_ALPHA, context.ONE_MINUS_SRC_ALPHA, context.ONE, context.ONE_MINUS_SRC_ALPHA);
    context.depthMask(false);
    context.disable(context.CULL_FACE);

    const streakCount = Math.round(rain.density * currentIntensity);
    if (streakCount > 0) {
      ensureStreakResources(rain.density, rain.seed);
      context.useProgram(streakProgram);
      context.bindVertexArray(streakVao);
      context.uniformMatrix4fv(streakUniforms.viewProjection, false, renderer.viewProjection);
      context.uniform3fv(streakUniforms.eye, eye);
      context.uniform3fv(streakUniforms.anchor, anchor);
      context.uniform3fv(streakUniforms.volume, rain.volume);
      context.uniform2fv(streakUniforms.wind, rain.wind);
      context.uniform1f(streakUniforms.time, time);
      context.uniform1f(streakUniforms.speed, rain.speed);
      context.uniform1f(streakUniforms.streakLength, rain.streakLength);
      context.uniform1f(streakUniforms.streakWidth, rain.streakWidth);
      context.uniform3fv(streakUniforms.rainColor, rainColor);
      context.uniform1f(streakUniforms.opacity, rain.opacity * Math.min(1, 0.35 + currentIntensity * 0.65));
      context.drawElementsInstanced(context.TRIANGLES, 6, context.UNSIGNED_SHORT, 0, streakCount);
    }

    const splashInstanceCount = rain.splashes ? Math.round(rain.splashCount * currentIntensity) : 0;
    if (splashInstanceCount > 0) {
      ensureSplashResources(rain.splashCount, rain.seed);
      context.useProgram(splashProgram);
      context.bindVertexArray(splashVao);
      context.uniformMatrix4fv(splashUniforms.viewProjection, false, renderer.viewProjection);
      context.uniform2f(splashUniforms.anchorXz, anchor[0], anchor[2]);
      context.uniform2f(splashUniforms.volumeXz, rain.volume[0], rain.volume[2]);
      context.uniform1f(splashUniforms.groundHeight, rain.groundHeight);
      context.uniform1f(splashUniforms.time, time);
      context.uniform3fv(splashUniforms.rainColor, rainColor);
      context.uniform1f(splashUniforms.opacity, rain.opacity);
      context.drawElementsInstanced(context.TRIANGLES, 6, context.UNSIGNED_SHORT, 0, splashInstanceCount);
    }

    context.depthMask(true);
    context.disable(context.BLEND);
    context.enable(context.CULL_FACE);
    context.bindVertexArray(null);
  }

  function releaseResources() {
    if (streakProgram) context.deleteProgram(streakProgram);
    if (streakVao) context.deleteVertexArray(streakVao);
    if (streakQuadBuffer) context.deleteBuffer(streakQuadBuffer);
    if (streakIndexBuffer) context.deleteBuffer(streakIndexBuffer);
    if (streakInstanceBuffer) context.deleteBuffer(streakInstanceBuffer);
    if (splashProgram) context.deleteProgram(splashProgram);
    if (splashVao) context.deleteVertexArray(splashVao);
    if (splashQuadBuffer) context.deleteBuffer(splashQuadBuffer);
    if (splashInstanceBuffer) context.deleteBuffer(splashInstanceBuffer);
    streakProgram = null;
    splashProgram = null;
    streakVao = null;
    splashVao = null;
    streakIndexBuffer = null;
  }

  renderer.render = function renderWithRain(frame) {
    const previousRain = currentRain;
    const previousIntensity = currentIntensity;
    const rain = resolvedFrameRain(frame);
    const intensity = rain ? sampleRainIntensity(rain, frame?.time ?? 0) : 0;
    currentRain = rain;
    currentIntensity = intensity;
    let passedFrame = frame;
    if (rain && rain.wetness !== null && frame?.environment?.wetness === undefined) {
      passedFrame = {
        ...frame,
        environment: {
          ...frame.environment,
          wetness: Math.max(0, Math.min(1, rain.wetness * intensity)),
        },
      };
    }
    try {
      return originalRender(passedFrame);
    } finally {
      currentRain = previousRain;
      currentIntensity = previousIntensity;
    }
  };

  renderer.drawBlendBatches = function drawBlendBatchesWithRain(frame) {
    originalDrawBlendBatches(frame);
    if (!frame?.reflectionTarget && !renderer.renderingPass && !renderer.benchmark) {
      drawRainForFrame(frame);
    }
  };

  renderer.dispose = function disposeWithRain() {
    releaseResources();
    renderer.render = originalRender;
    renderer.drawBlendBatches = originalDrawBlendBatches;
    renderer.dispose = originalDispose;
    return originalDispose();
  };

  renderer.rainSupport = { resolve: resolveRain, sampleIntensity: sampleRainIntensity };
  return renderer;
}
