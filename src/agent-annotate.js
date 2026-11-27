// Marks a person leaves on a rendered view for scene_ask_user (issue #922): pure helpers shared by the preview page and the
// local annotate server. A pin is a pixel and a short note; the page turns each pixel into a ray and the scene query turns
// the ray into a part, a world point and a surface normal. A lasso is a closed outline and a note; the pick runs on a grid of
// pixels inside it and the answer lists the parts those pixels land on.
import { mat4, vec4 } from 'gl-matrix';
import { applyProjection } from './camera.js';

export const ANNOTATE_LIMITS = Object.freeze({
  maxMarks: 16,
  maxNoteLength: 280,
  maxPromptLength: 200,
  defaultTimeoutSeconds: 300,
  maxTimeoutSeconds: 900,
  maxImageBytes: 1024 * 1024,
  minLassoPoints: 3,
  maxLassoPoints: 64,
  lassoSamplesPerAxis: 24,
  edgeCoverage: 0.15,
  maxSharedMaterialParts: 8,
  minViewFov: 5,
  maxViewFov: 120,
  maxDeltaPosition: 1000,
  maxDeltaRotation: 360,
  maxScaleFactor: 100,
  maxMotionTime: 3600,
});

export const ASK_USER_CAPABILITY_NOTE = 'scene_ask_user opens the current view in their browser; they place up to maxMarks (16) marks (pin, lasso, color, view or transform), each with a note, and press Send. Ask when a change is hard to say in words ("warmer here", "this bit"), not for facts you can inspect. Each pin returns partId, point, normal, note, distance and material (null on sky), plus view.camera and a PNG with numbered pins. Apply the change the note names to that partId, then to similar parts (same material or name prefix) when the note says so. A mark with kind "lasso" is an outline around a region: apply the note to every part in its parts list (partId, coverage, material, most covered first), and skip a part with a tiny coverage that the note does not fit. A mark with kind "color" is a point plus a target colour (color linear [r,g,b] 0 to 1 and sRGB hex "#rrggbb"): recolour that partId (giving it its own material first when materialSharedWith is set). A mark with kind "view" is a saved camera framing (camera {eye, target, fov} and note): apply or review with those coordinates. A mark with kind "transform" is a point plus relative transform deltas (deltaPosition [dx,dy,dz], deltaRotation [rx,ry,rz] degrees, scaleFactor number or [sx,sy,sz]): apply those deltas to partId. A part with materialSharedWith has that material on parts outside the mark: give it its own material before you change it. A part with edge true only grazes the outline. outcome cancelled or timeout returns no marks: ask in text. For a film scene pass motionTime to mark one moment (view.motionTime names it), or any mark may carry time (0 to 3600 seconds) from the timeline scrubber. Edits made while they mark change revision; the result warns.';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function invalidMarks(detail) {
  return new TypeError(`The annotate marks are invalid: ${detail}`);
}

function roundedPixel(value) {
  return Math.round(value * 10) / 10;
}

function roundedColor(color) {
  return color.map(channel => Math.round(channel * 10000) / 10000);
}

function srgbChannelToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(channel) {
  const clamped = Math.max(0, Math.min(1, channel));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * (clamped ** (1 / 2.4)) - 0.055;
}

function normalizeHexColor(value, label) {
  if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value.trim())) {
    throw invalidMarks(`${label} must be a "#rrggbb" hex colour.`);
  }
  return value.trim().toLowerCase();
}

export function colorFromHex(hex) {
  const cleanHex = normalizeHexColor(hex, 'hex');
  return roundedColor([1, 3, 5].map(offset => srgbChannelToLinear(parseInt(cleanHex.slice(offset, offset + 2), 16) / 255)));
}

export function hexFromColor(color) {
  const channels = color.map(channel => Math.max(0, Math.min(255, Math.round(linearChannelToSrgb(channel) * 255)))
    .toString(16)
    .padStart(2, '0'));
  return `#${channels.join('')}`;
}

function validNote(note, index) {
  if (typeof note !== 'string' || note.length > ANNOTATE_LIMITS.maxNoteLength) {
    throw invalidMarks(`mark ${index + 1} note must be text of at most ${ANNOTATE_LIMITS.maxNoteLength} characters.`);
  }
  return note.trim();
}

function validatePixelCoordinates(mark, index, { width, height }) {
  const { x, y } = mark;
  if (!Number.isFinite(x) || x < 0 || x > width) throw invalidMarks(`mark ${index + 1} x must be a pixel from 0 to ${width}.`);
  if (!Number.isFinite(y) || y < 0 || y > height) throw invalidMarks(`mark ${index + 1} y must be a pixel from 0 to ${height}.`);
  return { x: roundedPixel(x), y: roundedPixel(y) };
}

function validateMarkTime(mark, index) {
  if (mark.time === undefined) return {};
  if (typeof mark.time !== 'number' || !Number.isFinite(mark.time) || mark.time < 0 || mark.time > ANNOTATE_LIMITS.maxMotionTime) {
    throw invalidMarks(`mark ${index + 1} time must be a number of seconds from 0 to ${ANNOTATE_LIMITS.maxMotionTime}.`);
  }
  return { time: Math.round(mark.time * 1000) / 1000 };
}

function validatePinMark(mark, index, bounds) {
  const { x, y } = validatePixelCoordinates(mark, index, bounds);
  return { x, y, note: validNote(mark.note ?? '', index), ...validateMarkTime(mark, index) };
}

function validateColorMark(mark, index, bounds) {
  const { x, y } = validatePixelCoordinates(mark, index, bounds);
  const { color, hex, note = '' } = mark;
  if (color === undefined && hex === undefined) {
    throw invalidMarks(`mark ${index + 1} color must be [r, g, b] of three numbers from 0 to 1, or a "#rrggbb" hex colour.`);
  }
  let cleanColor;
  let cleanHex;
  if (typeof color === 'string') {
    cleanHex = normalizeHexColor(color, `mark ${index + 1} color`);
    if (hex !== undefined && normalizeHexColor(hex, `mark ${index + 1} hex`) !== cleanHex) {
      throw invalidMarks(`mark ${index + 1} hex must match color.`);
    }
    cleanColor = colorFromHex(cleanHex);
  } else if (color !== undefined) {
    const valid = Array.isArray(color) && color.length === 3
      && color.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 1);
    if (!valid) {
      throw invalidMarks(`mark ${index + 1} color must be [r, g, b] of three numbers from 0 to 1, or a "#rrggbb" hex colour.`);
    }
    cleanColor = roundedColor(color);
    cleanHex = hex !== undefined ? normalizeHexColor(hex, `mark ${index + 1} hex`) : hexFromColor(cleanColor);
  } else {
    cleanHex = normalizeHexColor(hex, `mark ${index + 1} hex`);
    cleanColor = colorFromHex(cleanHex);
  }
  return { kind: 'color', x, y, color: cleanColor, hex: cleanHex, note: validNote(note, index), ...validateMarkTime(mark, index) };
}

function isFiniteVector3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(component => Number.isFinite(component));
}

function roundedScale(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded > 0 ? rounded : value;
}

function validateBoundedVector3(value, limit, label, unitHint) {
  if (!isFiniteVector3(value) || value.some(component => component < -limit || component > limit)) {
    throw invalidMarks(`${label} must be ${unitHint} of three finite numbers from -${limit} to ${limit}.`);
  }
  return roundedVector(value);
}

function validateScaleFactor(value, index) {
  const maxScale = ANNOTATE_LIMITS.maxScaleFactor;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || value > maxScale) {
      throw invalidMarks(`mark ${index + 1} scaleFactor must be a finite number greater than 0 and at most ${maxScale}, or [sx, sy, sz].`);
    }
    return roundedScale(value);
  }
  if (isFiniteVector3(value) && value.every(component => component > 0 && component <= maxScale)) {
    return value.map(roundedScale);
  }
  throw invalidMarks(`mark ${index + 1} scaleFactor must be a finite number greater than 0 and at most ${maxScale}, or [sx, sy, sz].`);
}

function validateTransformMark(mark, index, bounds) {
  const { x, y } = validatePixelCoordinates(mark, index, bounds);
  const deltaPosition = mark.deltaPosition !== undefined
    ? validateBoundedVector3(mark.deltaPosition, ANNOTATE_LIMITS.maxDeltaPosition, `mark ${index + 1} deltaPosition`, '[dx, dy, dz]')
    : undefined;
  const deltaRotation = mark.deltaRotation !== undefined
    ? validateBoundedVector3(mark.deltaRotation, ANNOTATE_LIMITS.maxDeltaRotation, `mark ${index + 1} deltaRotation`, '[rx, ry, rz] degrees')
    : undefined;
  const scaleFactor = mark.scaleFactor !== undefined ? validateScaleFactor(mark.scaleFactor, index) : undefined;
  if (deltaPosition === undefined && deltaRotation === undefined && scaleFactor === undefined) {
    throw invalidMarks(`mark ${index + 1} transform must include at least one of deltaPosition, deltaRotation or scaleFactor.`);
  }
  const hasPosition = deltaPosition !== undefined && deltaPosition.some(component => component !== 0);
  const hasRotation = deltaRotation !== undefined && deltaRotation.some(component => component !== 0);
  const hasScale = scaleFactor !== undefined && (Array.isArray(scaleFactor) ? scaleFactor.some(component => component !== 1) : scaleFactor !== 1);
  if (!hasPosition && !hasRotation && !hasScale) {
    throw invalidMarks(`mark ${index + 1} transform must change deltaPosition, deltaRotation or scaleFactor.`);
  }
  return {
    kind: 'transform',
    x,
    y,
    ...(deltaPosition !== undefined ? { deltaPosition } : {}),
    ...(deltaRotation !== undefined ? { deltaRotation } : {}),
    ...(scaleFactor !== undefined ? { scaleFactor } : {}),
    note: validNote(mark.note ?? '', index),
    ...validateMarkTime(mark, index),
  };
}

export function validateViewCamera(camera, label = 'camera') {
  if (!camera || typeof camera !== 'object' || Array.isArray(camera)) {
    throw invalidMarks(`${label} must be an object with eye, target and fov.`);
  }
  const { eye, target, fov, up } = camera;
  if (!isFiniteVector3(eye)) throw invalidMarks(`${label}.eye must be [x, y, z] of three finite numbers.`);
  if (!isFiniteVector3(target)) throw invalidMarks(`${label}.target must be [x, y, z] of three finite numbers.`);
  if (Math.hypot(eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]) < 1e-6) {
    throw invalidMarks(`${label}.eye and target must not be the same point.`);
  }
  if (!Number.isFinite(fov) || fov < ANNOTATE_LIMITS.minViewFov || fov > ANNOTATE_LIMITS.maxViewFov) {
    throw invalidMarks(`${label}.fov must be a number from ${ANNOTATE_LIMITS.minViewFov} to ${ANNOTATE_LIMITS.maxViewFov}.`);
  }
  if (up !== undefined && (!isFiniteVector3(up) || Math.hypot(up[0], up[1], up[2]) < 1e-6)) {
    throw invalidMarks(`${label}.up must be a non-zero [x, y, z] vector.`);
  }
  return {
    eye: roundedVector(eye),
    target: roundedVector(target),
    fov: Math.round(fov * 100) / 100,
  };
}

function validateViewMark(mark, index) {
  const camera = validateViewCamera(mark.camera, `mark ${index + 1} camera`);
  return { kind: 'view', camera, note: validNote(mark.note ?? '', index), ...validateMarkTime(mark, index) };
}

function validateLassoMark(mark, index, { width, height }) {
  const { points, note = '' } = mark;
  const { minLassoPoints, maxLassoPoints } = ANNOTATE_LIMITS;
  if (!Array.isArray(points) || points.length < minLassoPoints || points.length > maxLassoPoints) {
    const got = Array.isArray(points) ? `${points.length} points` : typeof points;
    throw invalidMarks(`mark ${index + 1} points must be an array of ${minLassoPoints} to ${maxLassoPoints} [x, y] pixels, got ${got}.`);
  }
  const clean = points.map((point, pointIndex) => {
    const valid = Array.isArray(point) && point.length === 2
      && Number.isFinite(point[0]) && point[0] >= 0 && point[0] <= width
      && Number.isFinite(point[1]) && point[1] >= 0 && point[1] <= height;
    if (!valid) throw invalidMarks(`mark ${index + 1} points[${pointIndex}] must be [x, y] with x from 0 to ${width} and y from 0 to ${height}.`);
    return [roundedPixel(point[0]), roundedPixel(point[1])];
  });
  if (polygonArea(clean) < 1) throw invalidMarks(`mark ${index + 1} points must outline an area of at least 1 square pixel, not a line or a dot.`);
  return { kind: 'lasso', points: clean, note: validNote(note, index), ...validateMarkTime(mark, index) };
}

/**
 * Checks marks sent by the annotate page. Returns clean records: { x, y, note } for a pin, { kind: 'lasso', points, note } for
 * a lasso, { kind: 'color', x, y, color, hex, note } for a colour pick, { kind: 'view', camera, note } for a saved view, and
 * { kind: 'transform', x, y, ...deltas, note } for a transform mark (each kind optionally carries time in seconds).
 * Throws a TypeError that says which mark failed, so a broken page cannot slip unbounded data to the agent.
 */
export function validateMarks(marks, { width, height, maxMarks = ANNOTATE_LIMITS.maxMarks }) {
  if (!Array.isArray(marks)) throw invalidMarks('marks must be an array.');
  if (marks.length > maxMarks) throw invalidMarks(`at most ${maxMarks} marks, got ${marks.length}.`);
  return marks.map((mark, index) => {
    if (!mark || typeof mark !== 'object' || Array.isArray(mark)) throw invalidMarks(`mark ${index + 1} must be an object.`);
    if (mark.kind === 'lasso') return validateLassoMark(mark, index, { width, height });
    if (mark.kind === 'color') return validateColorMark(mark, index, { width, height });
    if (mark.kind === 'view') return validateViewMark(mark, index);
    if (mark.kind === 'transform') return validateTransformMark(mark, index, { width, height });
    if (mark.kind !== undefined && mark.kind !== 'pin') {
      throw invalidMarks(`mark ${index + 1} kind must be "pin", "lasso", "color", "view" or "transform", got ${JSON.stringify(mark.kind)}.`);
    }
    return validatePinMark(mark, index, { width, height });
  });
}

/** Area of a polygon of [x, y] points, by the shoelace formula. */
export function polygonArea(points) {
  let twiceArea = 0;
  points.forEach(([x, y], index) => {
    const [nextX, nextY] = points[(index + 1) % points.length];
    twiceArea += x * nextY - nextX * y;
  });
  return Math.abs(twiceArea) / 2;
}

/** True when the pixel lies inside the polygon (even-odd rule: a loop the outline crosses itself into counts as outside). */
export function pointInPolygon(points, x, y) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const [currentX, currentY] = points[index];
    const [previousX, previousY] = points[previous];
    const crosses = (currentY > y) !== (previousY > y)
      && x < (previousX - currentX) * (y - currentY) / (previousY - currentY) + currentX;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** True when the base64 text is a PNG within the image budget. */
export function isBoundedPng(base64) {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false;
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length <= ANNOTATE_LIMITS.maxImageBytes && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/** The world ray through a pixel of a camera: { origin, direction } with a unit direction. */
export function pixelRay(camera, pixelX, pixelY, width, height) {
  const view = mat4.lookAt(mat4.create(), camera.eye, camera.target, camera.up);
  const combined = mat4.multiply(mat4.create(), applyProjection(mat4.create(), camera, width / height), view);
  const inverse = mat4.invert(mat4.create(), combined);
  if (!inverse) throw new RangeError('The camera matrix cannot be inverted.');
  const ndcX = pixelX / width * 2 - 1;
  const ndcY = 1 - pixelY / height * 2;
  const unproject = ndcZ => {
    const point = vec4.transformMat4(vec4.create(), [ndcX, ndcY, ndcZ, 1], inverse);
    return [point[0] / point[3], point[1] / point[3], point[2] / point[3]];
  };
  const near = unproject(-1);
  const far = unproject(1);
  const direction = [0, 1, 2].map(axis => far[axis] - near[axis]);
  const length = Math.hypot(...direction);
  return { origin: near, direction: direction.map(value => value / length) };
}

function roundedVector(vector) {
  return Array.from(vector, value => Math.round(value * 1000) / 1000);
}

function hitFields(hit) {
  return {
    partId: hit ? hit.id : null,
    point: hit ? roundedVector(hit.point) : null,
    normal: hit ? roundedVector(hit.normal) : null,
    distance: hit ? Math.round(hit.distance * 1000) / 1000 : null,
    material: hit?.material ?? null,
  };
}

function polygonCentre(points) {
  const sum = points.reduce((total, [x, y]) => [total[0] + x, total[1] + y], [0, 0]);
  return [roundedPixel(sum[0] / points.length), roundedPixel(sum[1] / points.length)];
}

/**
 * The pixels a lasso is picked at: the centres of a grid over its bounding box that fall inside the outline, plus the outline's
 * centre when that is inside too. The grid is fixed, so the same outline always picks the same pixels.
 */
export function lassoSamplePixels(points) {
  const [left, right] = [Math.min(...points.map(point => point[0])), Math.max(...points.map(point => point[0]))];
  const [top, bottom] = [Math.min(...points.map(point => point[1])), Math.max(...points.map(point => point[1]))];
  const perAxis = ANNOTATE_LIMITS.lassoSamplesPerAxis;
  const samples = [];
  for (let row = 0; row < perAxis; row++) {
    for (let column = 0; column < perAxis; column++) {
      const pixel = [left + (column + 0.5) / perAxis * (right - left), top + (row + 0.5) / perAxis * (bottom - top)];
      if (pointInPolygon(points, pixel[0], pixel[1])) samples.push(pixel);
    }
  }
  const centre = polygonCentre(points);
  if (pointInPolygon(points, centre[0], centre[1])) samples.push(centre);
  return samples;
}

// The other parts, outside the mark, that use the same material: recolouring that material would change them too.
function sharedMaterialFields(material, markedIds, partMaterials, ownId) {
  if (material === null || !partMaterials) return {};
  const others = Object.keys(partMaterials).filter(id => partMaterials[id] === material && id !== ownId && !markedIds.has(id)).sort();
  if (others.length === 0) return {};
  const cap = ANNOTATE_LIMITS.maxSharedMaterialParts;
  return { materialSharedWith: others.slice(0, cap), ...(others.length > cap ? { materialSharedWithMore: others.length - cap } : {}) };
}

// The parts under a lasso, most covered first. Each carries its share of the picked pixels; the lasso's own hit fields are the
// most covered part's hit nearest the outline's centre.
function describeLasso(mark, index, camera, { width, height, raycast, partMaterials }) {
  const centre = polygonCentre(mark.points);
  const samples = lassoSamplePixels(mark.points);
  const groups = new Map();
  for (const [pixelX, pixelY] of samples) {
    const hit = raycast(pixelRay(camera, pixelX, pixelY, width, height), mark);
    if (!hit) continue;
    const offset = Math.hypot(pixelX - centre[0], pixelY - centre[1]);
    const group = groups.get(hit.id) ?? { count: 0, hit, offset };
    group.count += 1;
    if (offset < group.offset) Object.assign(group, { hit, offset });
    groups.set(hit.id, group);
  }
  const ranked = [...groups.entries()].sort(([firstId, first], [secondId, second]) => second.count - first.count || (firstId < secondId ? -1 : 1));
  const measured = ranked.map(([partId, group]) => ({
    partId, samples: group.count, coverage: Math.round(group.count / samples.length * 100) / 100, material: group.hit.material ?? null,
  }));
  // A grazed edge part is listed but not meant by the outline, so its material still counts as shared with it.
  const markedIds = new Set(measured.filter(part => part.coverage >= ANNOTATE_LIMITS.edgeCoverage).map(part => part.partId));
  const parts = measured.map(part => ({
    ...part,
    ...(markedIds.has(part.partId) ? {} : { edge: true }),
    ...sharedMaterialFields(part.material, markedIds, partMaterials, part.partId),
  }));
  const timeField = mark.time !== undefined ? { time: mark.time } : {};
  return { number: index + 1, kind: 'lasso', pixel: centre, points: mark.points, note: mark.note, ...timeField, ...hitFields(ranked[0]?.[1].hit), parts };
}

/**
 * Numbers the marks and attaches what each one points at: part ID, world point, normal and distance, or null on empty sky.
 * A lasso also returns kind, points and parts (the parts under its outline); its partId and point are the most covered part's.
 * A colour mark returns kind 'color', color (linear RGB) and hex ('#rrggbb') beside the hit fields. A view mark returns kind
 * 'view', camera ({ eye, target, fov }) and note without raycasting. A transform mark returns kind 'transform' with
 * deltaPosition, deltaRotation and/or scaleFactor beside the hit fields. Any mark may carry time in seconds.
 * partMaterials ({ partId: material }, optional) lets each lasso part, and the part a pin, colour or transform mark lands on,
 * list materialSharedWith: the unmarked parts on its material.
 * A part covering under ANNOTATE_LIMITS.edgeCoverage of the picked pixels is marked edge: true and stays listed.
 */
export function describeMarks(marks, camera, { width, height, raycast, partMaterials }) {
  return marks.map((mark, index) => {
    const timeField = mark.time !== undefined ? { time: mark.time } : {};
    if (mark.kind === 'lasso') return describeLasso(mark, index, camera, { width, height, raycast, partMaterials });
    if (mark.kind === 'view') return { number: index + 1, kind: 'view', camera: mark.camera, note: mark.note, ...timeField };
    const hit = raycast(pixelRay(camera, mark.x, mark.y, width, height), mark);
    const shared = hit ? sharedMaterialFields(hit.material ?? null, new Set([hit.id]), partMaterials, hit.id) : {};
    if (mark.kind === 'color') {
      return { number: index + 1, kind: 'color', pixel: [mark.x, mark.y], color: mark.color, hex: mark.hex, note: mark.note, ...timeField, ...hitFields(hit), ...shared };
    }
    if (mark.kind === 'transform') {
      return {
        number: index + 1,
        kind: 'transform',
        pixel: [mark.x, mark.y],
        ...(mark.deltaPosition !== undefined ? { deltaPosition: mark.deltaPosition } : {}),
        ...(mark.deltaRotation !== undefined ? { deltaRotation: mark.deltaRotation } : {}),
        ...(mark.scaleFactor !== undefined ? { scaleFactor: mark.scaleFactor } : {}),
        note: mark.note,
        ...timeField,
        ...hitFields(hit),
        ...shared,
      };
    }
    return { number: index + 1, pixel: [mark.x, mark.y], note: mark.note, ...timeField, ...hitFields(hit), ...shared };
  });
}
