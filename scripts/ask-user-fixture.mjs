// A test-only stand-in for the person who answers scene_ask_user (#1956). The agent bench runs the real MCP server through
// `claude -p`, and the browser page waits for Send, so a bench task could never finish. Whoever starts the server may set
// CRUCIBLE_ASK_USER_FIXTURE to an absolute path of a small JSON file; scene_ask_user then answers from its marks instead of opening
// a browser. The variable is read once at start, never appears in a tool schema or the flag list, and no tool call can set it.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';
import { ANNOTATE_LIMITS, validateMarks } from '../src/agent-annotate.js';

export const ASK_USER_FIXTURE_VARIABLE = 'CRUCIBLE_ASK_USER_FIXTURE';
export const ASK_USER_FIXTURE_LIMITS = Object.freeze({ maxBytes: 64 * 1024, maxPixel: 1024, maxMotionTime: 3600 });

function fixtureError(detail) {
  return new Error(`${ASK_USER_FIXTURE_VARIABLE} ${detail}`);
}

function readFixtureText(filePath) {
  if (!isAbsolute(filePath)) throw fixtureError(`must be an absolute path to a .json file, got "${filePath}". Pass the full path.`);
  if (extname(filePath).toLowerCase() !== '.json') throw fixtureError(`must point to a .json file, got "${basename(filePath)}". Rename the file or point to another one.`);
  let descriptor;
  try {
    descriptor = openSync(filePath, 'r');
  } catch (error) {
    throw fixtureError(`cannot read ${basename(filePath)}: ${error.code ?? error.message}. Point it to an existing file.`);
  }
  // Size check and read go through one open descriptor, so the file cannot be swapped between them.
  try {
    const size = fstatSync(descriptor).size;
    if (size > ASK_USER_FIXTURE_LIMITS.maxBytes) {
      throw fixtureError(`file ${basename(filePath)} is ${size} bytes, over the ${ASK_USER_FIXTURE_LIMITS.maxBytes} byte limit. Keep only the marks.`);
    }
    const buffer = Buffer.alloc(ASK_USER_FIXTURE_LIMITS.maxBytes + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > ASK_USER_FIXTURE_LIMITS.maxBytes) {
      throw fixtureError(`file ${basename(filePath)} grew past the ${ASK_USER_FIXTURE_LIMITS.maxBytes} byte limit while it was read. Keep only the marks.`);
    }
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function isPixelPair(value) {
  return Array.isArray(value) && value.length === 2
    && value.every(coordinate => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= ASK_USER_FIXTURE_LIMITS.maxPixel);
}

function validatePixel(pixel, where) {
  if (!isPixelPair(pixel)) throw fixtureError(`${where} pixel must be [x, y], two numbers from 0 to ${ASK_USER_FIXTURE_LIMITS.maxPixel}. Or give lasso [[x, y], ...] instead.`);
}

function validateLassoPoints(lasso, where) {
  const { minLassoPoints, maxLassoPoints } = ANNOTATE_LIMITS;
  if (!Array.isArray(lasso) || lasso.length < minLassoPoints || lasso.length > maxLassoPoints) {
    throw fixtureError(`${where} lasso must be an array of ${minLassoPoints} to ${maxLassoPoints} [x, y] points.`);
  }
  const badIndex = lasso.findIndex(point => !isPixelPair(point));
  if (badIndex >= 0) throw fixtureError(`${where} lasso point ${badIndex + 1} must be [x, y], two numbers from 0 to ${ASK_USER_FIXTURE_LIMITS.maxPixel}.`);
}

function validateViaMarks(candidate, where) {
  try {
    const [validated] = validateMarks([candidate], { width: ASK_USER_FIXTURE_LIMITS.maxPixel, height: ASK_USER_FIXTURE_LIMITS.maxPixel });
    return validated;
  } catch (error) {
    throw fixtureError(`${where} ${error.message.replace(/^The annotate marks are invalid: mark 1 /, '')}`);
  }
}

function validateFixtureMark(mark, index, name) {
  const where = `${name} mark ${index + 1}`;
  if (!mark || typeof mark !== 'object' || Array.isArray(mark)) throw fixtureError(`${where} must be an object with pixel and note.`);
  const { pixel, lasso, color, hex, view, deltaPosition, deltaRotation, scaleFactor, note = '', motionTime, time } = mark;
  const hasColor = color !== undefined || hex !== undefined;
  const hasTransform = deltaPosition !== undefined || deltaRotation !== undefined || scaleFactor !== undefined;
  if (view !== undefined && (pixel !== undefined || lasso !== undefined || hasColor || hasTransform)) {
    throw fixtureError(`${where} cannot combine view with pixel, lasso, color or transform.`);
  }
  if (pixel !== undefined && lasso !== undefined) throw fixtureError(`${where} has both pixel and lasso. Keep one of them.`);
  if (lasso !== undefined && (hasColor || hasTransform)) throw fixtureError(`${where} cannot combine lasso with color or transform.`);
  if (hasColor && hasTransform) throw fixtureError(`${where} cannot combine color with transform.`);
  if (typeof note !== 'string' || note.length > ANNOTATE_LIMITS.maxNoteLength) {
    throw fixtureError(`${where} note must be text of at most ${ANNOTATE_LIMITS.maxNoteLength} characters.`);
  }
  if (motionTime !== undefined && !(Number.isFinite(motionTime) && motionTime >= 0 && motionTime <= ASK_USER_FIXTURE_LIMITS.maxMotionTime)) {
    throw fixtureError(`${where} motionTime must be a number of seconds from 0 to ${ASK_USER_FIXTURE_LIMITS.maxMotionTime}.`);
  }
  const timeField = time !== undefined ? { time } : {};
  if (view !== undefined) {
    return validateViaMarks({ kind: 'view', camera: view, note, ...timeField }, where);
  }
  if (lasso !== undefined) {
    validateLassoPoints(lasso, where);
    return time !== undefined ? validateViaMarks({ kind: 'lasso', points: lasso, note, time }, where) : { kind: 'lasso', points: lasso, note };
  }
  validatePixel(pixel, where);
  if (hasColor) {
    return validateViaMarks({ kind: 'color', x: pixel[0], y: pixel[1], ...(color !== undefined ? { color } : {}), ...(hex !== undefined ? { hex } : {}), note, ...timeField }, where);
  }
  if (hasTransform) {
    return validateViaMarks({
      kind: 'transform',
      x: pixel[0],
      y: pixel[1],
      ...(deltaPosition !== undefined ? { deltaPosition } : {}),
      ...(deltaRotation !== undefined ? { deltaRotation } : {}),
      ...(scaleFactor !== undefined ? { scaleFactor } : {}),
      note,
      ...timeField,
    }, where);
  }
  // Marks of the browser flow are { x, y, note }, { kind: 'lasso', points, note }, { kind: 'color', x, y, color, hex, note }, { kind: 'view', camera, note } or { kind: 'transform', x, y, ..., note } (with optional time); motionTime is checked and then ignored, the pick is of the still frame.
  return time !== undefined ? validateViaMarks({ x: pixel[0], y: pixel[1], note, time }, where) : { x: pixel[0], y: pixel[1], note };
}

/**
 * The fixture named by the environment, or undefined when the variable is unset or empty.
 * Returns { name, marks } with marks as { x, y, note }, the shape the annotate page sends. Throws an Error that names the variable.
 */
export function loadAskUserFixture(environment = process.env) {
  const filePath = environment[ASK_USER_FIXTURE_VARIABLE];
  if (filePath === undefined || filePath === '') return undefined;
  const name = basename(filePath);
  let parsed;
  try {
    parsed = JSON.parse(readFixtureText(filePath));
  } catch (error) {
    if (error instanceof SyntaxError) throw fixtureError(`file ${name} is not valid JSON: ${error.message}.`);
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.marks)) {
    throw fixtureError(`file ${name} must be an object like {"marks":[{"pixel":[384,256],"note":"make this red"}]}.`);
  }
  if (parsed.marks.length < 1 || parsed.marks.length > ANNOTATE_LIMITS.maxMarks) {
    throw fixtureError(`file ${name} needs 1 to ${ANNOTATE_LIMITS.maxMarks} marks, got ${parsed.marks.length}.`);
  }
  return { name, marks: parsed.marks.map((mark, index) => validateFixtureMark(mark, index, name)) };
}

export function describeAskUserFixture(fixture) {
  return `Crucible: scene_ask_user answers come from the fixture ${fixture.name}`;
}
