// Small curves and flipbooks for particles, beams and trails (#3240). A curve is a list of [time, value] stops with the time as a
// share of the life (0 at birth, 1 at death); the value between two stops is linear. Everything here is a pure function of its input.

import { invalidField } from './field-error.js';
import { finiteNumber } from './agent-recipe-checks.js';

export const CURVE_LIMITS = Object.freeze({ maxStops: 8, maxFlipbookCells: 256, maxFlipbookFps: 240 });

function stopTime(stop, path, previous) {
  const time = finiteNumber(stop?.[0], `${path}[0]`, 0, 1);
  if (time <= previous) {
    throw invalidField(path, stop, 'stops whose times rise from 0 to 1, such as [[0, 0], [0.2, 1], [1, 0]]');
  }
  return time;
}

/**
 * A curve of numbers: a number holds one value, `[start, end]` is a straight line over the life, and a list of `[time, value]`
 * stops shapes it. Returns the stops, at least two, with the first at time 0 and the last at time 1.
 */
export function normalizeCurve(input, path, minimum, maximum) {
  const example = 'a number, [start, end] or stops such as [[0, 0], [0.2, 1], [1, 0]]';
  if (typeof input === 'number') {
    const value = finiteNumber(input, path, minimum, maximum);
    return [[0, value], [1, value]];
  }
  if (!Array.isArray(input) || input.length < 2 || input.length > CURVE_LIMITS.maxStops) {
    throw invalidField(path, input, `${example}, with 2 to ${CURVE_LIMITS.maxStops} entries`, TypeError);
  }
  if (input.every(entry => typeof entry === 'number')) {
    if (input.length !== 2) throw invalidField(path, input, `${example}: plain numbers are [start, end] only`, TypeError);
    return [[0, finiteNumber(input[0], `${path}[0]`, minimum, maximum)], [1, finiteNumber(input[1], `${path}[1]`, minimum, maximum)]];
  }
  let previous = -1;
  const stops = input.map((stop, index) => {
    if (!Array.isArray(stop) || stop.length !== 2) throw invalidField(`${path}[${index}]`, stop, example, TypeError);
    previous = stopTime(stop, `${path}[${index}]`, previous);
    return [previous, finiteNumber(stop[1], `${path}[${index}][1]`, minimum, maximum)];
  });
  if (stops[0][0] !== 0 || stops[stops.length - 1][0] !== 1) {
    throw invalidField(path, input, 'stops that start at time 0 and end at time 1, such as [[0, 0], [0.2, 1], [1, 0]]');
  }
  return stops;
}

/** The value of a curve at `fraction` of the life, clamped to 0 to 1. */
export function curveAt(stops, fraction) {
  const position = Math.min(Math.max(fraction, 0), 1);
  for (let index = 1; index < stops.length; index++) {
    if (position <= stops[index][0]) {
      const [fromTime, fromValue] = stops[index - 1];
      const [toTime, toValue] = stops[index];
      return fromValue + (toValue - fromValue) * ((position - fromTime) / (toTime - fromTime));
    }
  }
  return stops[stops.length - 1][1];
}

export function isColorStops(value) {
  return Array.isArray(value) && value.length >= 2 && value.every(entry => Array.isArray(entry) && entry.length === 2 && Array.isArray(entry[1]));
}

/** Colour stops `[[time, [r, g, b]], ...]` over the life or the length, times rising from 0 to 1. Returns the same shape, checked. */
export function normalizeColorStops(input, path) {
  const example = 'stops such as [[0, [1, 1, 0.6]], [0.4, [1, 0.45, 0.1]], [1, [0.3, 0, 0]]]';
  if (!isColorStops(input) || input.length > CURVE_LIMITS.maxStops) {
    throw invalidField(path, input, `${example}, with 2 to ${CURVE_LIMITS.maxStops} entries`, TypeError);
  }
  const channels = [0, 1, 2].map(channel => normalizeCurve(input.map((stop, index) => {
    if (stop[1].length !== 3) throw invalidField(`${path}[${index}][1]`, stop[1], '[r, g, b], such as [1, 0.5, 0.1]', TypeError);
    return [stop[0], stop[1][channel]];
  }), path, 0, 1000));
  return channels[0].map(([time], index) => [time, [channels[0][index][1], channels[1][index][1], channels[2][index][1]]]);
}

/** Three channel curves from colour stops, for `colorCurveAt`. */
export function colorChannelCurves(stops) {
  return [0, 1, 2].map(channel => stops.map(([time, color]) => [time, color[channel]]));
}

export function colorCurveAt(channelCurves, fraction, target) {
  for (let channel = 0; channel < 3; channel++) target[channel] = curveAt(channelCurves[channel], fraction);
  return target;
}

/**
 * A flipbook cuts a texture into `columns` by `rows` cells read left to right, then down (cell 0 is the top left). `fps` plays it at a
 * fixed rate from birth; left out, the whole sheet plays once across the particle's life. `loop` repeats it (true by default with fps, always
 * false across the life); `frames` plays only the first cells of a sheet that is not full.
 */
export function normalizeFlipbook(input, path) {
  const example = '{ rows: 4, columns: 4, fps: 24 }';
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalidField(path, input, example, TypeError);
  const allowed = ['rows', 'columns', 'frames', 'fps', 'loop'];
  const unknown = Object.keys(input).find(key => !allowed.includes(key));
  if (unknown) throw invalidField(`${path}.${unknown}`, input[unknown], `one of ${allowed.join(', ')}`);
  const cut = field => {
    const value = input[field];
    if (!Number.isInteger(value) || value < 1 || value > 16) throw invalidField(`${path}.${field}`, value, `a whole number from 1 to 16, such as 4 (${example})`);
    return value;
  };
  const rows = cut('rows');
  const columns = cut('columns');
  const cells = rows * columns;
  const frames = input.frames ?? cells;
  if (!Number.isInteger(frames) || frames < 1 || frames > cells) throw invalidField(`${path}.frames`, input.frames, `a whole number from 1 to ${cells} (rows times columns), or left out to play every cell`);
  const flipbook = { rows, columns, frames };
  if (input.fps !== undefined) flipbook.fps = finiteNumber(input.fps, `${path}.fps`, 0.01, CURVE_LIMITS.maxFlipbookFps);
  if (input.loop !== undefined) {
    if (typeof input.loop !== 'boolean') throw invalidField(`${path}.loop`, input.loop, 'true or false');
    flipbook.loop = input.loop;
  }
  return flipbook;
}

/** The cell shown `age` seconds after birth, `fraction` through a life. Pure: the same age gives the same cell. */
export function flipbookFrame(flipbook, age, fraction) {
  if (flipbook.fps === undefined) return Math.min(Math.floor(fraction * flipbook.frames), flipbook.frames - 1);
  const step = Math.floor(Math.max(age, 0) * flipbook.fps);
  return flipbook.loop === false ? Math.min(step, flipbook.frames - 1) : step % flipbook.frames;
}

/** Maps a UV in 0 to 1 into the cell `frame` of the sheet, with `v` counted down from the top row, as the renderer reads images. */
export function flipbookUv(flipbook, frame, u, v, target, offset) {
  const column = frame % flipbook.columns;
  const row = Math.floor(frame / flipbook.columns);
  target[offset] = (column + u) / flipbook.columns;
  target[offset + 1] = (row + v) / flipbook.rows;
}
