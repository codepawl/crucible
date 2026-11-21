// Round 8: the ship rides the sea. Motion tracks baked from the same ocean waves the sea mesh draws, plus a foam snippet tied to the hull outline at the waterline.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { oceanWaves } = await import(pathToFileURL(resolve('src/ocean-waves.js')).href);
const { seaHeightAt } = await import(pathToFileURL(resolve('src/physics-buoyancy.js')).href);

// Sea parameters of the galleon scene (the `ocean` op of the sea mesh) and the calm level of its box mesh (top face at y = 0.5).
const SEA = { windSpeed: 10, direction: 0, size: 70, seed: 23, resolution: 6, choppiness: 1.5 };
const CALM_LEVEL = 0.5;
const SHIP_MIDDLE_X = 3.3;
const SAMPLE_STEP = 0.1;
const SMOOTHING_SAMPLES = 5;
const GAIN = 1.0;
const MAXIMUM_TILT = (4 * Math.PI) / 180;

const waves = oceanWaves({ windSpeed: SEA.windSpeed, direction: SEA.direction, size: SEA.size, seed: SEA.seed, resolution: SEA.resolution });
const ocean = { waves, choppiness: SEA.choppiness, time: 0, level: 0 };
const heightAt = (x, z, time) => seaHeightAt(ocean, x, z, time);
export const seaSurfaceHeight = heightAt;

function smoothed(values) {
  const half = Math.floor(SMOOTHING_SAMPLES / 2);
  return values.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -half; offset <= half; offset++) {
      const neighbour = values[index + offset];
      if (neighbour !== undefined) {
        sum += neighbour;
        count++;
      }
    }
    return sum / count;
  });
}

function quaternion(roll, pitch) {
  const halfRoll = roll / 2;
  const halfPitch = pitch / 2;
  const [ax, ay, az, aw] = [0, 0, Math.sin(halfPitch), Math.cos(halfPitch)];
  const [bx, by, bz, bw] = [Math.sin(halfRoll), 0, 0, Math.cos(halfRoll)];
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** Sea height under the hull (mean of bow, middle, stern) and the pitch and roll that follow its slope, per sample time. Returns the numbers for the report as well. */
export function seaFollow(clipDuration, waterlineAboveKeel) {
  const times = [];
  for (let time = 0; time <= clipDuration + 1e-9; time += SAMPLE_STEP) times.push(time);
  const heave = smoothed(times.map(time => (heightAt(12, 0, time) + heightAt(0, 0, time) + heightAt(-12, 0, time)) / 3));
  const pitch = smoothed(times.map(time => Math.atan((heightAt(12, 0, time) - heightAt(-12, 0, time)) / 24) * GAIN));
  const roll = smoothed(times.map(time => Math.atan((heightAt(0, -4, time) - heightAt(0, 4, time)) / 8) * GAIN));
  const clamp = value => Math.max(-MAXIMUM_TILT, Math.min(MAXIMUM_TILT, value));
  const translationKeys = times.map((time, index) => ({ time, value: [-SHIP_MIDDLE_X, CALM_LEVEL + heave[index] - waterlineAboveKeel, 0] }));
  const rotationKeys = times.map((time, index) => ({ time, value: quaternion(clamp(roll[index]), clamp(pitch[index])) }));
  const tracks = [
    { kind: 'node', id: 'ship', property: 'translation', interpolation: 'SMOOTH', keyframes: translationKeys },
    { kind: 'node', id: 'ship', property: 'rotation', interpolation: 'SMOOTH', keyframes: rotationKeys },
  ];
  return { tracks, heaveRange: [Math.min(...heave), Math.max(...heave)], pitchDegrees: Math.max(...pitch.map(Math.abs)) * 180 / Math.PI, rollDegrees: Math.max(...roll.map(Math.abs)) * 180 / Math.PI };
}

// Half width of the hull at the waterline, [x along the ship from its middle, half width in metres], read from the GLB hull between 2.2 and 3.0 m above the keel.
const OUTLINE = [[-14.4, 0.0], [-14, 0.28], [-12, 3.03], [-10, 3.72], [-8, 4.07], [-6, 4.19], [-4, 4.26], [-2, 4.28], [0, 4.26], [2, 4.1], [4, 3.92], [6, 3.61], [8, 2.54], [10.2, 0.0]];

/**
 * Foam hugging the hull outline: narrow along the sides, wider at the bow and stern, its outer edge broken by fixed noise, with a thin dark band
 * where the hull meets the water. Reads the water point's world position and has no time term.
 */
export function hullFoamSnippet({ sideWidth = 0.55, endWidth = 1.3, opacity = 0.6, darkWidth = 0.35 } = {}) {
  const outlineX = OUTLINE.map(([x]) => x.toFixed(2)).join(', ');
  const outlineWidth = OUTLINE.map(([, width]) => width.toFixed(2)).join(', ');
  const count = OUTLINE.length;
  return [
    `const float OUTLINE_X[${count}] = float[${count}](${outlineX});`,
    `const float OUTLINE_WIDTH[${count}] = float[${count}](${outlineWidth});`,
    `const float SIDE_WIDTH = ${sideWidth.toFixed(2)};`,
    `const float END_WIDTH = ${endWidth.toFixed(2)};`,
    `const float FOAM_OPACITY = ${opacity.toFixed(2)};`,
    `const float DARK_WIDTH = ${darkWidth.toFixed(2)};`,
    'float hullFoamHash(vec2 cell) { return fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453); }',
    'float hullFoamCells(vec2 point) {',
    '  vec2 cell = floor(point);',
    '  float nearest = 2.0;',
    '  for (int rowIndex = 0; rowIndex < 3; rowIndex++) {',
    '    for (int columnIndex = 0; columnIndex < 3; columnIndex++) {',
    '      vec2 neighbour = cell + vec2(float(columnIndex) - 1.0, float(rowIndex) - 1.0);',
    '      vec2 centre = neighbour + vec2(hullFoamHash(neighbour), hullFoamHash(neighbour + 7.3));',
    '      nearest = min(nearest, length(point - centre));',
    '    }',
    '  }',
    '  return nearest;',
    '}',
    'float outlineHalfWidth(float along) {',
    `  float result = 0.0;`,
    `  for (int index = 0; index < ${count - 1}; index++) {`,
    '    float t = clamp((along - OUTLINE_X[index]) / (OUTLINE_X[index + 1] - OUTLINE_X[index]), 0.0, 1.0);',
    '    if (along >= OUTLINE_X[index] && along <= OUTLINE_X[index + 1]) result = mix(OUTLINE_WIDTH[index], OUTLINE_WIDTH[index + 1], t);',
    '  }',
    '  return result;',
    '}',
    'vec3 hullPoint = vec3(0.0);',
    'void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) { hullPoint = worldPosition; }',
    'void waterHook(inout vec3 color, WaterInputs water) {',
    '  float along = hullPoint.x;',
    `  float clampedAlong = clamp(along, ${OUTLINE[0][0].toFixed(2)}, ${OUTLINE[count - 1][0].toFixed(2)});`,
    '  float halfWidth = outlineHalfWidth(clampedAlong);',
    '  float sideways = abs(hullPoint.z) - halfWidth;',
    '  float outside = sideways > 0.0 ? length(vec2(along - clampedAlong, sideways)) : sideways;',
    '  float endShare = max(smoothstep(5.0, 9.5, along), smoothstep(-9.0, -13.5, along));',
    '  float reach = mix(SIDE_WIDTH, END_WIDTH, endShare);',
    '  float cells = hullFoamCells(vec2(along, hullPoint.z) * 1.6);',
    '  float edge = reach * (0.55 + 0.9 * smoothstep(0.15, 0.85, cells));',
    '  float foam = (1.0 - smoothstep(edge * 0.3, edge, outside)) * smoothstep(-0.2, 0.05, outside);',
    '  float dark = (1.0 - smoothstep(0.0, DARK_WIDTH, outside)) * smoothstep(-0.3, 0.0, outside);',
    '  color *= 1.0 - 0.55 * dark;',
    '  vec3 foamColor = vec3(0.74, 0.78, 0.8);',
    '  color = mix(color, foamColor, foam * FOAM_OPACITY * (1.0 - dark * 0.6));',
    '}',
  ].join('\n');
}
