import './toon-shader.js';
import { backendFor } from './glaze-backend.js';
export { normalizeToonRim, normalizeToonBase, copyToon } from './toon-shader.js';

// gl-program.js is not imported directly for fullscreenVertex so the scene entry keeps its own copy.
const fullscreenVertex = `#version 300 es
precision highp float;
out vec2 textureCoordinate;
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  textureCoordinate = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

// Outlines, toon light and screen-width lines as one addon. Nothing here is in the core renderer: installLineArt adds a
// post stage and wraps render, and a frame draws lines only when it carries `frame.lines` (the resolved
// `environment.lines` of a recipe). Without that field render runs untouched, so a scene without lines is unchanged.
//
// Outlines come from three guides: the object ID pass (part boundaries and silhouettes), the normal pass (creases) and
// the depth of the frame (one surface in front of another). The ID and normal guides are drawn by render passes
// (render-passes.js, installed first) just before the frame, which costs two extra draws of the opaque geometry.
// The line width is in output pixels, so a 4K still and a preview carry lines of the same thickness.

export const LINE_ART_DEFAULTS = Object.freeze({
  width: 1.5,
  color: Object.freeze([0.02, 0.02, 0.02]),
  boundaries: true,
  creaseAngle: 35,
  depthJump: 0.08,
  toon: 0,
  colorMode: 'solid',
  darkenFactor: 0.54,
  silhouetteSide: 'both',
  convexHighlight: 0,
});

export const LINE_ART_LIMITS = Object.freeze({
  width: Object.freeze([0.25, 16]),
  color: Object.freeze([0, 4]),
  creaseAngle: Object.freeze([0, 180]),
  depthJump: Object.freeze([0, 10]),
  toon: Object.freeze([0, 8]),
  darkenFactor: Object.freeze([0, 1]),
  convexHighlight: Object.freeze([0, 4]),
  maxPolylines: 64,
  minPolylinePoints: 2,
  maxPolylinePoints: 256,
  maxPolylineSegments: 4096,
  dashLength: Object.freeze([0.5, 256]),
  gapLength: Object.freeze([0.5, 256]),
  dashOffset: Object.freeze([-1e5, 1e5]),
  coordinate: 1e6,
  maxNodes: 64,
  nodeNameLength: 256,
});

export const LINE_COLOR_MODES = Object.freeze(['solid', 'darken']);
export const LINE_SILHOUETTE_SIDES = Object.freeze(['both', 'front']);
export const POLYLINE_STYLES = Object.freeze(['solid', 'dashed', 'dotted', 'double']);
const POLYLINE_STYLE_CODE = Object.freeze({ solid: 0, dashed: 1, dotted: 2, double: 3 });
// A boundary between two parts is flat, not a silhouette, when the two surfaces sit within this relative depth of each
// other and their normals agree within about 5 degrees (a road beside a pavement).
const COPLANAR_DEPTH = 0.02;
const COPLANAR_NORMAL_COSINE = 0.996;
// A surface is nearer than another only by more than this relative depth, so depth buffer noise on a flat wall draws nothing.
const NEARER_DEPTH_MARGIN = 0.005;

const LINE_ART_FIELDS = [...Object.keys(LINE_ART_DEFAULTS), 'polylines', 'nodes'];
const POLYLINE_FIELDS = ['points', 'color', 'width', 'depthTest', 'closed', 'style', 'dashLength', 'gapLength', 'dashOffset'];
const NODE_LINE_FIELDS = ['lines', 'silhouetteOnly', 'color'];
// How the outline shader reads a node: the mode and the node's index share one float (mode + 4 * index).
const NODE_MODE = Object.freeze({ normal: 0, off: 1, silhouette: 2 });
const NODE_TABLE_WIDTH = 1024;
const OUTLINE_RING_LIMIT = Math.ceil(LINE_ART_LIMITS.width[1] / 2);
// A 45-degree chamfer bevel turns twice in the same direction across a narrow strip; collapse strips up to this many steps
// into one centred outline while keeping wider architectural 45-degree planes as separate creases.
const MAX_BEVEL_SPAN = 10;
const BEVEL_MONOTONIC_MARGIN = 0.05;

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be a JSON object.`);
}

function onlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) throw new RangeError(`${label} has unknown ${unknown.length === 1 ? 'field' : 'fields'}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`);
}

function numberWithin(value, [minimum, maximum], label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be true or false.`);
  return value;
}

function choiceValue(value, choices, label) {
  if (!choices.includes(value)) {
    const listed = choices.map(choice => `"${choice}"`).join(' or ');
    throw new RangeError(`${label} must be ${listed}.`);
  }
  return value;
}

function colorValue(value, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} must be three linear RGB numbers [red, green, blue].`);
  return value.map((component, index) => numberWithin(component, LINE_ART_LIMITS.color, `${label}[${index}]`));
}

function pointValue(value, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} must be a point [x, y, z].`);
  const limit = LINE_ART_LIMITS.coordinate;
  return value.map((component, index) => numberWithin(component, [-limit, limit], `${label}[${index}]`));
}

function polylineStyleFields(input, style, width, label) {
  if (style === 'solid') {
    const extra = ['dashLength', 'gapLength', 'dashOffset'].find(field => input[field] !== undefined);
    if (extra) {
      throw new RangeError(`${label} sets ${extra} on a solid polyline. Fix: set style to "dashed", "dotted" or "double", or drop ${extra}.`);
    }
    return {};
  }
  if (style === 'dotted' && input.dashLength !== undefined) {
    throw new RangeError(`${label} sets dashLength with style "dotted". Fix: use width for dot size and gapLength for spacing, or set style to "dashed".`);
  }
  if (style === 'double') {
    const extra = ['dashLength', 'dashOffset'].find(field => input[field] !== undefined);
    if (extra) {
      throw new RangeError(`${label} sets ${extra} with style "double". Fix: use gapLength for the gap between rails, or set style to "dashed" or "dotted".`);
    }
    const defaultRailGap = Math.max(LINE_ART_LIMITS.gapLength[0], width * 1.5);
    return {
      style,
      gapLength: numberWithin(input.gapLength ?? defaultRailGap, LINE_ART_LIMITS.gapLength, `${label}.gapLength`),
    };
  }
  const defaultGap = Math.max(LINE_ART_LIMITS.gapLength[0], width * 2);
  const gapLength = numberWithin(input.gapLength ?? defaultGap, LINE_ART_LIMITS.gapLength, `${label}.gapLength`);
  const dashOffset = numberWithin(input.dashOffset ?? 0, LINE_ART_LIMITS.dashOffset, `${label}.dashOffset`);
  if (style === 'dotted') return { style, gapLength, dashOffset };
  const defaultDash = Math.max(LINE_ART_LIMITS.dashLength[0], width * 4);
  return {
    style,
    dashLength: numberWithin(input.dashLength ?? defaultDash, LINE_ART_LIMITS.dashLength, `${label}.dashLength`),
    gapLength,
    dashOffset,
  };
}

function polylineFrom(input, index, defaults) {
  const label = `lines.polylines[${index}]`;
  plainObject(input, label);
  onlyKeys(input, POLYLINE_FIELDS, label);
  const count = Array.isArray(input.points) ? input.points.length : 0;
  if (count < LINE_ART_LIMITS.minPolylinePoints || count > LINE_ART_LIMITS.maxPolylinePoints) {
    throw new RangeError(`${label}.points needs ${LINE_ART_LIMITS.minPolylinePoints} to ${LINE_ART_LIMITS.maxPolylinePoints} points.`);
  }
  const width = numberWithin(input.width ?? defaults.width, LINE_ART_LIMITS.width, `${label}.width`);
  const style = choiceValue(input.style ?? 'solid', POLYLINE_STYLES, `${label}.style`);
  return {
    points: input.points.map((point, pointIndex) => pointValue(point, `${label}.points[${pointIndex}]`)),
    color: colorValue(input.color ?? defaults.color, `${label}.color`),
    width,
    depthTest: booleanValue(input.depthTest ?? true, `${label}.depthTest`),
    closed: booleanValue(input.closed ?? false, `${label}.closed`),
    ...polylineStyleFields(input, style, width, label),
  };
}

function nodeLinesFrom(input, name, defaultColor) {
  const label = `lines.nodes["${name}"]`;
  plainObject(input, label);
  onlyKeys(input, NODE_LINE_FIELDS, label);
  const drawn = booleanValue(input.lines ?? true, `${label}.lines`);
  const silhouetteOnly = booleanValue(input.silhouetteOnly ?? false, `${label}.silhouetteOnly`);
  if (!drawn && (silhouetteOnly || input.color !== undefined)) {
    throw new RangeError(`${label} sets lines false together with ${silhouetteOnly ? 'silhouetteOnly' : 'color'}. Fix: drop lines:false, or drop the other field.`);
  }
  const color = colorValue(input.color ?? defaultColor, `${label}.color`);
  // A node with no lines has no colour, so the resolved form passes through this function again unchanged.
  return drawn ? { lines: true, silhouetteOnly, color } : { lines: false, silhouetteOnly: false };
}

function nodesFrom(input, defaultColor) {
  plainObject(input, 'lines.nodes');
  const names = Object.keys(input);
  if (names.length > LINE_ART_LIMITS.maxNodes) {
    throw new RangeError(`lines.nodes names ${names.length} nodes; the limit is ${LINE_ART_LIMITS.maxNodes}. Fix: list only the nodes that differ from the rest.`);
  }
  const empty = names.find(name => name.length === 0 || name.length > LINE_ART_LIMITS.nodeNameLength);
  if (empty !== undefined) throw new RangeError(`lines.nodes keys are node IDs of 1 to ${LINE_ART_LIMITS.nodeNameLength} characters, such as "basket".`);
  return Object.fromEntries(names.map(name => [name, nodeLinesFrom(input[name], name, defaultColor)]));
}

function segmentCount(polyline) {
  return polyline.points.length - 1 + (polyline.closed ? 1 : 0);
}

/**
 * Checks `environment.lines` and returns it with every default filled in, so the same input gives the same lines.
 * Throws a RangeError or TypeError that names the field.
 */
export function resolveLineArt(input = {}) {
  plainObject(input, 'lines');
  onlyKeys(input, LINE_ART_FIELDS, 'lines');
  const resolved = {
    width: numberWithin(input.width ?? LINE_ART_DEFAULTS.width, LINE_ART_LIMITS.width, 'lines.width'),
    color: colorValue(input.color ?? LINE_ART_DEFAULTS.color, 'lines.color'),
    boundaries: booleanValue(input.boundaries ?? LINE_ART_DEFAULTS.boundaries, 'lines.boundaries'),
    creaseAngle: numberWithin(input.creaseAngle ?? LINE_ART_DEFAULTS.creaseAngle, LINE_ART_LIMITS.creaseAngle, 'lines.creaseAngle'),
    depthJump: numberWithin(input.depthJump ?? LINE_ART_DEFAULTS.depthJump, LINE_ART_LIMITS.depthJump, 'lines.depthJump'),
    toon: numberWithin(input.toon ?? LINE_ART_DEFAULTS.toon, LINE_ART_LIMITS.toon, 'lines.toon'),
    colorMode: choiceValue(input.colorMode ?? LINE_ART_DEFAULTS.colorMode, LINE_COLOR_MODES, 'lines.colorMode'),
    darkenFactor: numberWithin(input.darkenFactor ?? LINE_ART_DEFAULTS.darkenFactor, LINE_ART_LIMITS.darkenFactor, 'lines.darkenFactor'),
    silhouetteSide: choiceValue(input.silhouetteSide ?? LINE_ART_DEFAULTS.silhouetteSide, LINE_SILHOUETTE_SIDES, 'lines.silhouetteSide'),
    convexHighlight: numberWithin(input.convexHighlight ?? LINE_ART_DEFAULTS.convexHighlight, LINE_ART_LIMITS.convexHighlight, 'lines.convexHighlight'),
  };
  if (input.polylines !== undefined) {
    if (!Array.isArray(input.polylines) || input.polylines.length > LINE_ART_LIMITS.maxPolylines) {
      throw new RangeError(`lines.polylines must be a list of at most ${LINE_ART_LIMITS.maxPolylines} polylines.`);
    }
    resolved.polylines = input.polylines.map((polyline, index) => polylineFrom(polyline, index, resolved));
    const segments = resolved.polylines.reduce((total, polyline) => total + segmentCount(polyline), 0);
    if (segments > LINE_ART_LIMITS.maxPolylineSegments) {
      throw new RangeError(`lines.polylines hold ${segments} segments; the limit is ${LINE_ART_LIMITS.maxPolylineSegments}.`);
    }
  }
  // null clears the per-node settings, the same as leaving the field out.
  if (input.nodes !== undefined && input.nodes !== null) resolved.nodes = nodesFrom(input.nodes, resolved.color);
  return resolved;
}

/**
 * The per-ID table the outline shader reads, one RGBA float texel per object ID (ID 0 is the background):
 * RGB is the line colour, A is the mode plus four times the index of the owning node. `groups` is
 * renderer.passSupport.objectNodes(), the IDs of each node; a node that `lines.nodes` does not name draws normally,
 * and a name that is not drawn in the frame is ignored. Returns { count: 0 } when the frame has no per-node settings.
 */
export function lineNodeTable(lines, groups) {
  if (!lines.nodes || Object.keys(lines.nodes).length === 0) return { count: 0, data: null, width: 0, height: 0 };
  const names = Object.keys(groups);
  let highestIdentifier = 0;
  for (const name of names) {
    for (const identifier of groups[name]) highestIdentifier = Math.max(highestIdentifier, identifier);
  }
  const count = highestIdentifier + 1;
  const height = Math.ceil(count / NODE_TABLE_WIDTH);
  const data = new Float32Array(NODE_TABLE_WIDTH * height * 4);
  names.forEach((name, nodeIndex) => {
    const setting = Object.hasOwn(lines.nodes, name) ? lines.nodes[name] : undefined;
    const mode = !setting ? NODE_MODE.normal : !setting.lines ? NODE_MODE.off : setting.silhouetteOnly ? NODE_MODE.silhouette : NODE_MODE.normal;
    const color = setting?.color ?? lines.color;
    for (const identifier of groups[name]) {
      data.set([...color, mode + 4 * (nodeIndex + 1)], identifier * 4);
    }
  });
  return { count, data, width: NODE_TABLE_WIDTH, height };
}

/** The names in `lines.nodes` that are not the ID of any node of the recipe, so a typo fails instead of doing nothing. */
export function unknownLineNodeNames(lines, recipeNodes) {
  if (!lines?.nodes) return [];
  const known = new Set((recipeNodes ?? []).map(node => node.id));
  return Object.keys(lines.nodes).filter(name => !known.has(name));
}

function drawsOutlines(lines) {
  return lines.boundaries || lines.creaseAngle > 0 || lines.depthJump > 0;
}

function needsNormalGuide(lines) {
  return lines.creaseAngle > 0 || (lines.silhouetteSide === 'front' && lines.boundaries);
}

// Both guides read the same texel as the frame, so every lookup is a texel fetch at an integer pixel.
const outlineFragment = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
uniform sampler2D sceneDepth;
uniform sampler2D partTexture;
uniform sampler2D normalTexture;
uniform vec3 projectionDepth;
uniform float halfWidth;
uniform vec3 lineColor;
uniform float useBoundaries;
uniform float creaseCosine;
uniform float depthJump;
uniform sampler2D nodeTexture;
uniform int nodeCount;
uniform float darkenFactor;
uniform float frontOnly;
uniform float convexLift;
uniform vec3 cameraRight;
uniform vec3 cameraUp;
out vec4 outputColor;
ivec2 lastPixel;
vec3 edgeColor;
bool edgeIsConvex;
float bevelCoverage;
bool bevelConvex;
vec3 partAt(ivec2 pixel) { return texelFetch(partTexture, clamp(pixel, ivec2(0), lastPixel), 0).rgb; }
vec3 normalAt(ivec2 pixel) { return normalize(texelFetch(normalTexture, clamp(pixel, ivec2(0), lastPixel), 0).rgb * 2.0 - 1.0); }
float depthAt(ivec2 pixel) {
  float ndc = texelFetch(sceneDepth, clamp(pixel, ivec2(0), lastPixel), 0).r * 2.0 - 1.0;
  return projectionDepth.z > 0.5 ? -(ndc - projectionDepth.y) / projectionDepth.x : projectionDepth.y / (ndc + projectionDepth.x);
}
bool hasPart(vec3 part) { return dot(part, vec3(1.0)) > 0.0; }
bool samePart(vec3 partA, vec3 partB) { return dot(abs(partA - partB), vec3(1.0)) <= 0.001; }
// Per-node settings: mode 0 draws as usual, 1 draws no line (a neighbour draws none for it either), 2 draws only where the node
// meets another node or the background.
struct NodeLine { float mode; float index; vec3 color; };
NodeLine nodeAt(vec3 part) {
  NodeLine node = NodeLine(0.0, 0.0, lineColor);
  if (nodeCount == 0 || !hasPart(part)) return node;
  int identifier = int(dot(floor(part * 255.0 + 0.5), vec3(1.0, 256.0, 65536.0)));
  if (identifier >= nodeCount) return node;
  vec4 texel = texelFetch(nodeTexture, ivec2(identifier & ${NODE_TABLE_WIDTH - 1}, identifier >> 10), 0);
  node.index = floor(texel.a / 4.0);
  node.mode = texel.a - node.index * 4.0;
  node.color = texel.rgb;
  return node;
}
// frontOnly: the line is drawn on the nearer surface only. A boundary between two surfaces at the same depth with parallel
// normals is flat ground, not a silhouette, and draws nothing. Both perspective and orthographic depths are positive eye distances.
bool drawsOnFrontSide(ivec2 other, vec3 otherPart, vec3 centerNormal, float centerDepth) {
  if (!hasPart(otherPart)) return true;
  float otherDepth = depthAt(other);
  bool centerIsNearer = centerDepth <= otherDepth;
  if (!centerIsNearer) return false;
  bool isFlat = abs(centerDepth - otherDepth) < ${COPLANAR_DEPTH} * abs(centerDepth) && dot(centerNormal, normalAt(other)) > ${COPLANAR_NORMAL_COSINE};
  return !isFlat;
}
int walkBevelSide(ivec2 start, ivec2 step, vec3 basePart, vec3 baseNormal, out vec3 sideNormal, out int flatRun) {
  int boundary = -1;
  flatRun = 0;
  for (int i = 1; i <= ${MAX_BEVEL_SPAN * 2}; i++) {
    ivec2 samplePixel = start + step * i;
    if (!samePart(partAt(samplePixel), basePart)) {
      if (boundary < 0) return -1;
      flatRun = ${MAX_BEVEL_SPAN};
      return boundary;
    }
    vec3 candidate = normalAt(samplePixel);
    if (boundary < 0) {
      if (i > ${MAX_BEVEL_SPAN}) return -1;
      if (dot(baseNormal, candidate) < creaseCosine) {
        sideNormal = candidate;
        boundary = i;
      }
    } else if (dot(sideNormal, candidate) < creaseCosine) {
      return boundary;
    } else {
      flatRun++;
    }
  }
  return boundary;
}
bool bevelAlongAxis(ivec2 bevelPixel, ivec2 axis, vec3 basePart, vec3 bevelNormal, out int minusSteps, out int plusSteps, out vec3 sideMinus, out vec3 sidePlus) {
  int flatMinus;
  int flatPlus;
  minusSteps = walkBevelSide(bevelPixel, -axis, basePart, bevelNormal, sideMinus, flatMinus);
  if (minusSteps < 0) return false;
  plusSteps = walkBevelSide(bevelPixel, axis, basePart, bevelNormal, sidePlus, flatPlus);
  int span = minusSteps + plusSteps - 1;
  if (plusSteps < 0 || span > ${MAX_BEVEL_SPAN} || flatMinus < span || flatPlus < span) return false;
  return dot(sideMinus, sidePlus) < min(dot(sideMinus, bevelNormal), dot(bevelNormal, sidePlus)) - ${BEVEL_MONOTONIC_MARGIN};
}
void recordBevelCoverage(float distSteps, ivec2 axis, vec3 sideMinus, vec3 sidePlus) {
  float cov = clamp(min(2.0 * halfWidth, halfWidth + 0.5 - distSteps * length(vec2(axis))), 0.0, 1.0);
  if (cov <= bevelCoverage) return;
  bevelCoverage = cov;
  bevelConvex = convexLift > 0.0 && dot(sidePlus - sideMinus, cameraRight * float(axis.x) + cameraUp * float(axis.y)) > 0.0;
}
bool bevelOnAnyAxis(ivec2 pixel, vec3 basePart, vec3 baseNormal, vec3 otherNormal, vec2 offsetToPixel, bool isCenter) {
  ivec2 axes[4] = ivec2[4](ivec2(1, 0), ivec2(0, 1), ivec2(1, 1), ivec2(1, -1));
  for (int i = 0; i < 4; i++) {
    ivec2 axis = axes[i];
    int minusSteps;
    int plusSteps;
    vec3 sideMinus;
    vec3 sidePlus;
    if (!bevelAlongAxis(pixel, axis, basePart, baseNormal, minusSteps, plusSteps, sideMinus, sidePlus)) continue;
    if (dot(otherNormal, sideMinus) < creaseCosine && dot(otherNormal, sidePlus) < creaseCosine) continue;
    float centerOffset = 0.5 * float(plusSteps - minusSteps);
    float distSteps = isCenter ? abs(centerOffset) : abs(dot(offsetToPixel, vec2(axis)) / dot(vec2(axis), vec2(axis)) + centerOffset);
    recordBevelCoverage(distSteps, axis, sideMinus, sidePlus);
    return true;
  }
  return false;
}
bool differs(ivec2 center, ivec2 other, vec3 centerPart, vec3 centerNormal, float centerDepth, NodeLine centerNode) {
  edgeIsConvex = false;
  vec3 otherPart = partAt(other);
  NodeLine otherNode = nodeAt(otherPart);
  bool centerDrawn = hasPart(centerPart);
  if (otherNode.mode == 1.0) return false;
  bool silhouetteOnly = centerDrawn && centerNode.mode == 2.0;
  if (useBoundaries > 0.5 && !samePart(otherPart, centerPart) && (!silhouetteOnly || otherNode.index != centerNode.index)) {
    if (frontOnly > 0.5 && (!centerDrawn || !drawsOnFrontSide(other, otherPart, centerNormal, centerDepth))) return false;
    edgeColor = centerDrawn ? centerNode.color : otherNode.color;
    return true;
  }
  if (!silhouetteOnly && creaseCosine > -1.5 && centerDrawn && hasPart(otherPart)) {
    vec3 otherNormal = normalAt(other);
    if (dot(centerNormal, otherNormal) >= creaseCosine) return false;
    vec2 delta = vec2(other - center);
    if (bevelOnAnyAxis(center, centerPart, centerNormal, otherNormal, delta, true)) return false;
    if (bevelOnAnyAxis(other, centerPart, otherNormal, centerNormal, delta, false)) return false;
    // Convex when the surface turns away from the viewer across the step from this pixel to the other one.
    edgeIsConvex = convexLift > 0.0 && dot(otherNormal - centerNormal, cameraRight * delta.x + cameraUp * delta.y) > 0.0;
    return true;
  }
  return false;
}
bool depthEdge(ivec2 center, ivec2 offset, float centerDepth) {
  float plusDepth = depthAt(center + offset);
  float minusDepth = depthAt(center - offset);
  // Perspective 1/depth is linear across a flat tilted plane, so compare against the harmonic mean to avoid false triggers at grazing angles.
  float expectedDepth = projectionDepth.z > 0.5
    ? 0.5 * (plusDepth + minusDepth)
    : (2.0 * plusDepth * minusDepth) / max(plusDepth + minusDepth, 1e-6);
  float jump = 2.0 * abs(expectedDepth - centerDepth);
  if (jump <= depthJump * abs(centerDepth)) return false;
  if (frontOnly < 0.5) return true;
  // frontOnly: a pixel at the far end of the step draws nothing.
  float farthestDepth = max(plusDepth, minusDepth);
  float nearerBy = farthestDepth - centerDepth;
  return nearerBy > ${NEARER_DEPTH_MARGIN} * abs(centerDepth);
}
void checkInteriorBevel(ivec2 pixel, vec3 centerPart, vec3 centerNormal) {
  ivec2 axes[4] = ivec2[4](ivec2(1, 0), ivec2(0, 1), ivec2(1, 1), ivec2(1, -1));
  for (int i = 0; i < 4; i++) {
    ivec2 axis = axes[i];
    bool nearChange = false;
    for (int probe = 3; probe <= 5; probe += 2) {
      for (int dir = -1; dir <= 1; dir += 2) {
        ivec2 samplePixel = pixel + axis * (probe * dir);
        if (samePart(partAt(samplePixel), centerPart) && dot(centerNormal, normalAt(samplePixel)) < creaseCosine) nearChange = true;
      }
    }
    if (!nearChange) continue;
    int minusSteps;
    int plusSteps;
    vec3 sideMinus;
    vec3 sidePlus;
    if (bevelAlongAxis(pixel, axis, centerPart, centerNormal, minusSteps, plusSteps, sideMinus, sidePlus)) {
      recordBevelCoverage(0.5 * abs(float(plusSteps - minusSteps)), axis, sideMinus, sidePlus);
    }
  }
}
bool ringHasEdge(ivec2 center, int ring, vec3 centerPart, vec3 centerNormal, float centerDepth, NodeLine centerNode) {
  int diagonal = max(1, int(round(float(ring) * 0.70710678)));
  ivec2 offsets[4] = ivec2[4](ivec2(ring, 0), ivec2(0, ring), ivec2(diagonal, diagonal), ivec2(diagonal, -diagonal));
  for (int index = 0; index < 4; index++) {
    ivec2 offset = offsets[index];
    if (differs(center, center + offset, centerPart, centerNormal, centerDepth, centerNode) || differs(center, center - offset, centerPart, centerNormal, centerDepth, centerNode)) return true;
    if (depthJump > 0.0 && centerNode.mode == 0.0 && (nodeCount == 0 || (nodeAt(partAt(center + offset)).mode != 1.0 && nodeAt(partAt(center - offset)).mode != 1.0)) && depthEdge(center, offset, centerDepth)) return true;
  }
  return false;
}
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  lastPixel = textureSize(sourceTexture, 0) - 1;
  vec4 source = texelFetch(sourceTexture, pixel, 0);
  vec3 centerPart = partAt(pixel);
  vec3 centerNormal = creaseCosine > -1.5 || (frontOnly > 0.5 && useBoundaries > 0.5) ? normalAt(pixel) : vec3(0.0);
  float centerDepth = depthAt(pixel);
  NodeLine centerNode = nodeAt(centerPart);
  edgeColor = centerNode.color;
  bevelCoverage = 0.0;
  bevelConvex = false;
  float fullRings = floor(halfWidth);
  float partial = halfWidth - fullRings;
  float coverage = 0.0;
  for (int ring = 1; ring <= ${OUTLINE_RING_LIMIT}; ring++) {
    if (float(ring) > ceil(halfWidth) || centerNode.mode == 1.0) break;
    if (ringHasEdge(pixel, ring, centerPart, centerNormal, centerDepth, centerNode)) {
      coverage = float(ring) <= fullRings ? 1.0 : partial;
      break;
    }
  }
  if (coverage < 1.0 && creaseCosine > -1.5 && hasPart(centerPart) && centerNode.mode == 0.0) {
    checkInteriorBevel(pixel, centerPart, centerNormal);
  }
  if (bevelCoverage > coverage) {
    coverage = bevelCoverage;
    edgeColor = centerNode.color;
    edgeIsConvex = bevelConvex;
  }
  vec3 ink = edgeColor;
  if (darkenFactor >= 0.0) ink = source.rgb * darkenFactor;
  if (edgeIsConvex) ink = source.rgb * (1.0 + convexLift);
  outputColor = vec4(source.rgb * (1.0 - coverage) + ink * coverage, source.a * (1.0 - coverage) + coverage);
}`;

const polylineVertex = `#version 300 es
precision highp float;
uniform mat4 viewProjection;
uniform vec2 resolution;
uniform float lineWidth;
uniform float lineStyle;
uniform vec3 dashPattern;
in vec3 startPoint;
in vec3 endPoint;
in float startOffset;
out vec2 localPixel;
flat out float segmentLength;
flat out float segmentOffset;
const float NEAR_W = 0.001;
void main() {
  vec4 startClip = viewProjection * vec4(startPoint, 1.0);
  vec4 endClip = viewProjection * vec4(endPoint, 1.0);
  if (startClip.w < NEAR_W && endClip.w < NEAR_W) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    localPixel = vec2(0.0);
    segmentLength = 0.0;
    segmentOffset = 0.0;
    return;
  }
  if (startClip.w < NEAR_W) startClip = mix(startClip, endClip, (NEAR_W - startClip.w) / (endClip.w - startClip.w));
  if (endClip.w < NEAR_W) endClip = mix(endClip, startClip, (NEAR_W - endClip.w) / (startClip.w - endClip.w));
  vec2 startPixel = startClip.xy / startClip.w * resolution * 0.5;
  vec2 endPixel = endClip.xy / endClip.w * resolution * 0.5;
  float segmentPixels = distance(startPixel, endPixel);
  vec2 along = segmentPixels > 0.0001 ? (endPixel - startPixel) / segmentPixels : vec2(1.0, 0.0);
  vec2 across = vec2(-along.y, along.x);
  float halfWidth = lineWidth * 0.5;
  float railOffset = lineStyle > 2.5 ? (lineWidth + dashPattern.y) * 0.5 : 0.0;
  float endMargin = halfWidth + 1.0;
  float sideMargin = halfWidth + railOffset + 1.0;
  bool atEnd = gl_VertexID == 1 || gl_VertexID == 4 || gl_VertexID == 5;
  bool upper = gl_VertexID == 2 || gl_VertexID == 3 || gl_VertexID == 5;
  float lengthwise = atEnd ? segmentPixels + endMargin : -endMargin;
  float sideways = upper ? sideMargin : -sideMargin;
  vec4 anchor = atEnd ? endClip : startClip;
  vec2 pixel = (atEnd ? endPixel : startPixel) + along * (atEnd ? endMargin : -endMargin) + across * sideways;
  gl_Position = vec4(pixel / (resolution * 0.5) * anchor.w, anchor.z, anchor.w);
  localPixel = vec2(lengthwise, sideways);
  segmentLength = segmentPixels;
  segmentOffset = startOffset;
}`;

const polylineFragment = `#version 300 es
precision highp float;
uniform sampler2D sceneDepth;
uniform vec3 projectionDepth;
uniform float lineWidth;
uniform vec3 lineColor;
uniform float depthTest;
uniform float lineStyle;
uniform vec3 dashPattern;
in vec2 localPixel;
flat in float segmentLength;
flat in float segmentOffset;
out vec4 outputColor;
float eyeDepth(float depth) {
  float ndc = depth * 2.0 - 1.0;
  return projectionDepth.z > 0.5 ? -(ndc - projectionDepth.y) / projectionDepth.x : projectionDepth.y / (ndc + projectionDepth.x);
}
void main() {
  float halfWidth = lineWidth * 0.5;
  float endDistance = localPixel.x - clamp(localPixel.x, 0.0, segmentLength);
  float alpha = 0.0;
  if (lineStyle < 0.5) {
    float distanceToSegment = length(vec2(endDistance, localPixel.y));
    alpha = clamp(halfWidth - distanceToSegment + 0.5, 0.0, 1.0);
  } else if (lineStyle > 2.5) {
    float railOffset = (lineWidth + dashPattern.y) * 0.5;
    float distanceToSegment = length(vec2(endDistance, abs(localPixel.y) - railOffset));
    alpha = clamp(halfWidth - distanceToSegment + 0.5, 0.0, 1.0);
  } else if (lineStyle < 1.5) {
    float dashLength = dashPattern.x;
    float period = dashLength + dashPattern.y;
    float fromDashCenter = mod(segmentOffset + localPixel.x + dashPattern.z - dashLength * 0.5 + period * 0.5, period) - period * 0.5;
    float dashAlpha = clamp(dashLength * 0.5 - abs(fromDashCenter) + 0.5, 0.0, 1.0);
    float endAlpha = clamp(halfWidth - length(vec2(endDistance, localPixel.y)) + 0.5, 0.0, 1.0);
    alpha = min(endAlpha, dashAlpha);
  } else {
    float period = lineWidth + dashPattern.y;
    float fromDotCenter = mod(segmentOffset + localPixel.x + dashPattern.z + period * 0.5, period) - period * 0.5;
    float dotAlpha = clamp(halfWidth - length(vec2(fromDotCenter, localPixel.y)) + 0.5, 0.0, 1.0);
    float endAlpha = clamp(halfWidth - length(vec2(endDistance, localPixel.y)) + 0.5, 0.0, 1.0);
    alpha = min(endAlpha, dotAlpha);
  }
  if (alpha <= 0.0) discard;
  if (depthTest > 0.5) {
    float sceneDistance = eyeDepth(texelFetch(sceneDepth, ivec2(gl_FragCoord.xy), 0).r);
    if (eyeDepth(gl_FragCoord.z) > sceneDistance * 1.005 + 0.002) discard;
  }
  outputColor = vec4(lineColor * alpha, alpha);
}`;

function uniformLocations(backend, program, names) {
  return Object.fromEntries(names.map(name => [name, backend.uniformLocation(program, name)]));
}

function createColorTarget(backend, width, height, hdr, linear) {
  const target = backend.createFramebufferTarget({ width, height, hdr, linear, clamp: true });
  if (!target.complete) {
    backend.deleteFramebuffer(target.framebuffer);
    backend.deleteTexture(target.colorTexture);
    throw new Error('Line art framebuffer allocation failed. Choose a lower quality preset.');
  }
  return { texture: target.colorTexture, framebuffer: target.framebuffer };
}

function projectClipPoint(point, viewProjection) {
  const [pointX, pointY, pointZ] = point;
  return [
    viewProjection[0] * pointX + viewProjection[4] * pointY + viewProjection[8] * pointZ + viewProjection[12],
    viewProjection[1] * pointX + viewProjection[5] * pointY + viewProjection[9] * pointZ + viewProjection[13],
    viewProjection[2] * pointX + viewProjection[6] * pointY + viewProjection[10] * pointZ + viewProjection[14],
    viewProjection[3] * pointX + viewProjection[7] * pointY + viewProjection[11] * pointZ + viewProjection[15],
  ];
}

function segmentScreenPixels(startClip, endClip, viewportWidth, viewportHeight) {
  const nearW = 0.001;
  if (startClip[3] < nearW && endClip[3] < nearW) return 0;
  let clippedStart = startClip;
  let clippedEnd = endClip;
  if (startClip[3] < nearW) {
    const ratio = (nearW - startClip[3]) / (endClip[3] - startClip[3]);
    clippedStart = startClip.map((component, index) => component + (endClip[index] - component) * ratio);
  }
  if (endClip[3] < nearW) {
    const ratio = (nearW - endClip[3]) / (startClip[3] - endClip[3]);
    clippedEnd = endClip.map((component, index) => component + (startClip[index] - component) * ratio);
  }
  const halfWidth = viewportWidth * 0.5;
  const halfHeight = viewportHeight * 0.5;
  const deltaX = clippedEnd[0] / clippedEnd[3] * halfWidth - clippedStart[0] / clippedStart[3] * halfWidth;
  const deltaY = clippedEnd[1] / clippedEnd[3] * halfHeight - clippedStart[1] / clippedStart[3] * halfHeight;
  return Math.hypot(deltaX, deltaY);
}

/**
 * Cumulative screen-pixel distance at the start of each polyline segment so dashes and dots flow around corners.
 */
export function polylineSegmentOffsets(polyline, viewProjection, viewportWidth, viewportHeight) {
  const count = segmentCount(polyline);
  const offsets = new Float32Array(count);
  const style = polyline.style ?? 'solid';
  if (style !== 'dashed' && style !== 'dotted') return offsets;
  const points = polyline.points;
  const projected = points.map(point => projectClipPoint(point, viewProjection));
  let cumulative = 0;
  for (let index = 0; index < count; index++) {
    offsets[index] = cumulative;
    cumulative += segmentScreenPixels(projected[index], projected[(index + 1) % points.length], viewportWidth, viewportHeight);
  }
  return offsets;
}

function polylineSegments(polyline) {
  const points = polyline.points;
  const segments = new Float32Array(segmentCount(polyline) * 6);
  for (let index = 0; index < segmentCount(polyline); index++) {
    segments.set(points[index], index * 6);
    segments.set(points[(index + 1) % points.length], index * 6 + 3);
  }
  return segments;
}

function createLineArtStage(state, backend) {
  let outlineProgram = null;
  let outlineUniforms = null;
  let polylineProgram = null;
  let polylineUniforms = null;
  let vertexArray = null;
  let offsetBuffer = null;
  let outputTarget = null;
  let nodeTexture = null;
  let nodeTextureIsEmpty = false;
  let cachedNodeState = null;
  const guideTargets = new Map();
  const segmentBuffers = new Map();

  function guideTarget(renderer, name) {
    if (!guideTargets.has(name)) {
      guideTargets.set(name, createColorTarget(backend, renderer.canvas.width, renderer.canvas.height, false, false));
    }
    return guideTargets.get(name);
  }

  // The pass target is reused by the next pass, so each guide is copied out of it into a texture of its own.
  function captureGuide(renderer, name) {
    const { canvas } = renderer;
    const target = guideTarget(renderer, name);
    backend.blitTarget(renderer.passSupport.framebuffer, target.framebuffer, canvas.width, canvas.height, 'color');
  }

  function releaseTargets() {
    if (outputTarget) {
      backend.deleteTexture(outputTarget.texture);
      backend.deleteFramebuffer(outputTarget.framebuffer);
      outputTarget = null;
    }
    for (const target of guideTargets.values()) {
      backend.deleteTexture(target.texture);
      backend.deleteFramebuffer(target.framebuffer);
    }
    guideTargets.clear();
    if (nodeTexture) {
      backend.deleteTexture(nodeTexture);
      nodeTexture = null;
      nodeTextureIsEmpty = false;
    }
    cachedNodeState = null;
  }

  // Uploads the per-ID table. A frame without per-node settings gets a one-texel table, made once and not rebuilt.
  // The texture is bound on its own unit: binding first would replace the guide of whichever unit was active.
  function bindNodeTable(renderer, lines, unit) {
    const hasNodes = Boolean(lines.nodes) && Object.keys(lines.nodes).length > 0;
    if (!hasNodes) {
      cachedNodeState = null;
      if (!nodeTexture) {
        nodeTexture = backend.createDataTexture2D({
          width: 1,
          height: 1,
          format: 'rgba32f',
          linear: false,
          clamp: false,
          unit,
          data: new Float32Array(4),
        });
        nodeTextureIsEmpty = true;
      } else {
        backend.bindTextureUnit(unit, nodeTexture);
        if (!nodeTextureIsEmpty) {
          backend.uploadDataTexture2D(nodeTexture, { width: 1, height: 1, format: 'rgba32f', data: new Float32Array(4), reallocate: true, unit });
          nodeTextureIsEmpty = true;
        }
      }
      return 0;
    }
    const groups = Array.isArray(renderer.batches) ? null : renderer.passSupport.objectNodes();
    const key = JSON.stringify([lines.color, lines.nodes, groups ?? renderer.batches.length]);
    if (nodeTexture && cachedNodeState?.key === key && cachedNodeState.batches === renderer.batches) {
      backend.bindTextureUnit(unit, nodeTexture);
      return cachedNodeState.count;
    }
    const table = lineNodeTable(lines, groups ?? renderer.passSupport.objectNodes());
    if (!nodeTexture) {
      nodeTexture = backend.createDataTexture2D({
        width: table.width,
        height: table.height,
        format: 'rgba32f',
        linear: false,
        clamp: false,
        unit,
        data: table.data,
      });
    } else {
      backend.uploadDataTexture2D(nodeTexture, { width: table.width, height: table.height, format: 'rgba32f', data: table.data, reallocate: true, unit });
    }
    nodeTextureIsEmpty = false;
    cachedNodeState = { key, batches: renderer.batches, count: table.count };
    return table.count;
  }

  function releaseSegmentBuffers(keep = new Set()) {
    for (const [key, entry] of segmentBuffers) {
      if (keep.has(key)) continue;
      backend.deleteBuffer(entry.buffer);
      segmentBuffers.delete(key);
    }
  }

  function dispose() {
    releaseTargets();
    releaseSegmentBuffers();
    if (offsetBuffer) backend.deleteBuffer(offsetBuffer);
    if (outlineProgram) backend.deleteProgram(outlineProgram);
    if (polylineProgram) backend.deleteProgram(polylineProgram);
    if (vertexArray) backend.deleteVertexArray(vertexArray);
    offsetBuffer = null;
    outlineProgram = null;
    polylineProgram = null;
    vertexArray = null;
  }

  function projectionDepth(renderer) {
    const projection = renderer.projection;
    const orthographic = projection[15] === 1;
    return [projection[10], projection[14], orthographic ? 1 : 0];
  }

  function drawOutlines(renderer, lines, sourceTexture) {
    if (!outlineProgram) {
      outlineProgram = backend.compileProgram(fullscreenVertex, outlineFragment);
      outlineUniforms = uniformLocations(backend, outlineProgram, ['sourceTexture', 'sceneDepth', 'partTexture', 'normalTexture',
        'projectionDepth', 'halfWidth', 'lineColor', 'useBoundaries', 'creaseCosine', 'depthJump', 'nodeTexture', 'nodeCount',
        'darkenFactor', 'frontOnly', 'convexLift', 'cameraRight', 'cameraUp']);
    }
    backend.useProgram(outlineProgram);
    const partTexture = guideTarget(renderer, 'part').texture;
    const normalTexture = needsNormalGuide(lines) ? guideTarget(renderer, 'normal').texture : partTexture;
    const bindings = [[sourceTexture, 'sourceTexture'], [renderer.depthTexture, 'sceneDepth'], [partTexture, 'partTexture'], [normalTexture, 'normalTexture']];
    bindings.forEach(([texture, uniform], unit) => {
      backend.bindTextureUnit(unit, texture);
      backend.uniform1i(outlineUniforms[uniform], unit);
    });
    backend.uniform1i(outlineUniforms.nodeTexture, bindings.length);
    backend.uniform1i(outlineUniforms.nodeCount, bindNodeTable(renderer, lines, bindings.length));
    backend.uniform3fv(outlineUniforms.projectionDepth, projectionDepth(renderer));
    backend.uniform1f(outlineUniforms.halfWidth, lines.width / 2);
    backend.uniform3fv(outlineUniforms.lineColor, lines.color);
    backend.uniform1f(outlineUniforms.useBoundaries, lines.boundaries ? 1 : 0);
    backend.uniform1f(outlineUniforms.creaseCosine, lines.creaseAngle > 0 ? Math.cos(lines.creaseAngle * Math.PI / 180) : -2);
    backend.uniform1f(outlineUniforms.depthJump, lines.depthJump);
    // A darkenFactor below zero is the shader's "solid ink" switch.
    backend.uniform1f(outlineUniforms.darkenFactor, lines.colorMode === 'darken' ? lines.darkenFactor : -1);
    backend.uniform1f(outlineUniforms.frontOnly, lines.silhouetteSide === 'front' ? 1 : 0);
    backend.uniform1f(outlineUniforms.convexLift, lines.convexHighlight);
    const { view } = renderer;
    backend.uniform3f(outlineUniforms.cameraRight, view[0], view[4], view[8]);
    backend.uniform3f(outlineUniforms.cameraUp, view[1], view[5], view[9]);
    backend.drawFullscreenTriangles();
  }

  function segmentBufferFor(polyline) {
    const key = JSON.stringify([polyline.points, polyline.closed]);
    let entry = segmentBuffers.get(key);
    if (!entry) {
      const segments = polylineSegments(polyline);
      const buffer = backend.createBuffer();
      backend.uploadBuffer('array', buffer, segments, 'static');
      entry = { buffer, count: segments.length / 6 };
      segmentBuffers.set(key, entry);
    }
    return { key, ...entry };
  }

  function drawPolylines(renderer, polylines) {
    const { canvas } = renderer;
    if (!polylineProgram) {
      polylineProgram = backend.compileProgram(polylineVertex, polylineFragment);
      polylineUniforms = uniformLocations(backend, polylineProgram, ['viewProjection', 'resolution', 'lineWidth', 'sceneDepth',
        'projectionDepth', 'lineColor', 'depthTest', 'lineStyle', 'dashPattern']);
      vertexArray = backend.createVertexArray([]);
    }
    backend.useProgram(polylineProgram);
    backend.bindVertexArray(vertexArray);
    backend.setRenderState({ blend: true, blendMode: 'premultiplied' });
    backend.bindTextureUnit(0, renderer.depthTexture);
    backend.uniform1i(polylineUniforms.sceneDepth, 0);
    backend.uniformMatrix4fv(polylineUniforms.viewProjection, renderer.viewProjection);
    backend.uniform2f(polylineUniforms.resolution, canvas.width, canvas.height);
    backend.uniform3fv(polylineUniforms.projectionDepth, projectionDepth(renderer));
    const startLocation = backend.attribLocation(polylineProgram, 'startPoint');
    const endLocation = backend.attribLocation(polylineProgram, 'endPoint');
    const offsetLocation = backend.attribLocation(polylineProgram, 'startOffset');
    const used = new Set();
    for (const polyline of polylines) {
      const { key, buffer, count } = segmentBufferFor(polyline);
      used.add(key);
      backend.bindVertexAttributes(buffer, [
        { location: startLocation, size: 3, stride: 24, offset: 0, divisor: 1 },
        { location: endLocation, size: 3, stride: 24, offset: 12, divisor: 1 },
      ]);
      const style = polyline.style ?? 'solid';
      if (offsetLocation >= 0) {
        if (style === 'dashed' || style === 'dotted') {
          offsetBuffer ??= backend.createBuffer();
          const offsets = polylineSegmentOffsets(polyline, renderer.viewProjection, canvas.width, canvas.height);
          backend.uploadBuffer('array', offsetBuffer, offsets, 'dynamic');
          backend.bindVertexAttributes(offsetBuffer, [{ location: offsetLocation, size: 1, divisor: 1 }]);
        } else {
          backend.setConstantAttribute1f(offsetLocation, 0);
        }
      }
      backend.uniform1f(polylineUniforms.lineWidth, polyline.width);
      backend.uniform3fv(polylineUniforms.lineColor, polyline.color);
      backend.uniform1f(polylineUniforms.depthTest, polyline.depthTest ? 1 : 0);
      backend.uniform1f(polylineUniforms.lineStyle, POLYLINE_STYLE_CODE[style]);
      backend.uniform3f(polylineUniforms.dashPattern, polyline.dashLength ?? 0, polyline.gapLength ?? 0, polyline.dashOffset ?? 0);
      backend.drawInstancedTriangles(6, count);
    }
    releaseSegmentBuffers(used);
    backend.setRenderState({ blend: false });
    backend.bindVertexArray(null);
  }

  // Draws the outlines, then the polylines, into a target of its own; null leaves the frame as it is.
  function apply(renderer, frame, effects, sourceTexture) {
    const lines = state.lines;
    if (!lines) return null;
    const outlines = drawsOutlines(lines);
    const polylines = lines.polylines?.length > 0;
    if (!outlines && !polylines) return null;
    if (!renderer.depthTexture) throw new Error('Line art requires depth:true on the renderer.');
    const { canvas } = renderer;
    outputTarget ??= createColorTarget(backend, canvas.width, canvas.height, Boolean(renderer.hdr), true);
    backend.beginFullscreenPass(outputTarget.framebuffer, canvas.width, canvas.height);
    if (outlines) {
      drawOutlines(renderer, lines, sourceTexture);
    } else {
      copyTexture(sourceTexture);
    }
    if (polylines) drawPolylines(renderer, lines.polylines);
    return outputTarget.texture;
  }

  const copyFragment = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
out vec4 outputColor;
void main() { outputColor = texelFetch(sourceTexture, ivec2(gl_FragCoord.xy), 0); }`;
  let copyProgram = null;
  let copyUniform = null;

  function copyTexture(sourceTexture) {
    if (!copyProgram) {
      copyProgram = backend.compileProgram(fullscreenVertex, copyFragment);
      copyUniform = backend.uniformLocation(copyProgram, 'sourceTexture');
    }
    backend.useProgram(copyProgram);
    backend.bindTextureUnit(0, sourceTexture);
    backend.uniform1i(copyUniform, 0);
    backend.drawFullscreenTriangles();
  }

  return {
    name: 'Line art',
    apply,
    captureGuide,
    releaseTargets,
    dispose() {
      dispose();
      if (copyProgram) backend.deleteProgram(copyProgram);
      copyProgram = null;
    },
  };
}

/**
 * Adds outlines, toon light and polylines to a renderer. The renderer needs `depth: true` and installRenderPasses first.
 * A frame turns them on with `frame.lines`, an object from resolveLineArt (a recipe's `environment.lines`); a frame
 * without it draws exactly as before. Outlines draw the opaque and cutout geometry only, like render passes.
 */
export function installLineArt(renderer) {
  if (renderer.lineArt) return renderer;
  if (!renderer.passSupport) throw new Error('Line art needs installRenderPasses(renderer) from crucible/addons/render-passes first.');
  const backend = backendFor(renderer);
  const state = { lines: null };
  const stage = createLineArtStage(state, backend);
  renderer.postStages.push(stage);
  const drawFrame = renderer.render.bind(renderer);
  let toonBands = 0;

  // The toon uniforms are not in the core renderer's list, so the addon finds them itself after each program build.
  function locateToonUniforms() {
    for (const name of ['materialToon', 'toonDefault']) {
      renderer.uniforms[name] = backend.uniformLocation(renderer.program, name);
    }
  }

  // The default bands reach the main program as a uniform, and a rebuilt program starts again at zero.
  function pushDefaultToon() {
    if (!renderer.shaderFeatures?.has('toon')) return;
    backend.useProgram(renderer.program);
    backend.uniform1f(renderer.uniforms.toonDefault, toonBands);
  }

  const rebuildMainProgram = renderer.rebuildMainProgram.bind(renderer);
  renderer.rebuildMainProgram = () => {
    rebuildMainProgram();
    locateToonUniforms();
    pushDefaultToon();
  };

  function applyDefaultToon(bands) {
    toonBands = bands;
    if (bands > 0) renderer.requireFeatureNames(['toon']);
    pushDefaultToon();
  }

  function drawGuides(frame, lines) {
    const passes = needsNormalGuide(lines) ? [['normal', 'normal'], ['objectId', 'part']] : [['objectId', 'part']];
    for (const [pass, name] of passes) {
      drawFrame({ ...frame, pass });
      stage.captureGuide(renderer, name);
    }
  }

  renderer.render = frame => {
    const lines = frame.lines && frame.pass === undefined && !frame.reflectionTarget && !renderer.benchmark ? frame.lines : null;
    applyDefaultToon(lines?.toon ?? 0);
    state.lines = lines;
    if (lines && drawsOutlines(lines)) drawGuides(frame, lines);
    try {
      drawFrame(frame);
    } finally {
      state.lines = null;
    }
  };
  if (renderer.program) locateToonUniforms();
  renderer.lineArt = { resolve: resolveLineArt };
  return renderer;
}
