import { mat3, mat4 } from 'gl-matrix';
import { HAIR_LIMITS, buildHairMesh, createStrandRoots } from './hair.js';
import { normalizeForceFields } from './force-fields.js';
import { PARTICLE_LIMITS, buildParticleMesh, createParticleLaunches } from './particles.js';
import { createCollisionSurface } from './particle-collision.js';
import { SPARK_DEFAULTS, SPARK_LIMITS, SPARK_VERTICES, buildSparkMesh } from './particle-sparks.js';
import { EMITTER_MESH_MODES, createMeshSource } from './particle-emitter-mesh.js';
import { colorChannelCurves, isColorStops, normalizeColorStops, normalizeCurve, normalizeFlipbook } from './particle-curves.js';
import { RIBBON_LIMITS, beamEndpoints, buildBeamMesh, buildTrailMesh } from './particle-ribbons.js';
import { grid } from './geometry.js';
import { invalidField } from './field-error.js';
import { bakingContext, boundedArray, finiteNumber, knownKeys, rootNodeWithGeometry, vectorOfThree } from './agent-recipe-checks.js';

const PARTICLES_FIELDS = ['gravity', 'wind', 'fields', 'systems'];
const SYSTEM_TYPES = ['emitter', 'hair', 'sparks', 'beam', 'trail'];
const EMITTER_SYSTEM_FIELDS = ['type', 'node', 'seed', 'count', 'rate', 'delay', 'start', 'stop', 'lifetime', 'speed', 'direction', 'spread', 'emitter', 'size', 'scale', 'drag', 'floor', 'bounce', 'friction', 'colliders', 'spin', 'color', 'alpha', 'fade', 'instances', 'orient', 'preset', 'flipbook', 'sizeOverLife', 'gravityScale', 'acceleration'];
const BEAM_FIELDS = ['type', 'node', 'from', 'to', 'width', 'segments', 'curve', 'scroll', 'repeat', 'color', 'alpha', 'fade'];
const TRAIL_FIELDS = ['type', 'node', 'follow', 'offset', 'lifetime', 'width', 'segments', 'repeat', 'color', 'alpha', 'fade'];
// Presets (#3240) fill the fields of an emitter system that the recipe leaves out; a field the recipe gives wins. Smoke and fire are
// camera-facing cards: draw them with a soft round texture (a plane node whose material has a map), smoke on an alphaMode "blend" material
// and fire on alphaMode "add". gravityScale 0 and a gentle acceleration lift them whatever the scene gravity is.
const PARTICLE_PRESETS = Object.freeze({
  smoke: Object.freeze({
    count: 480, rate: 100, lifetime: [2.5, 4], speed: [0.2, 0.6], size: [0.2, 0.4], spread: 25, drag: 0.6, orient: 'billboard', spin: [-45, 45],
    gravityScale: 0, acceleration: [0, 0.8, 0], emitter: { shape: 'disc', radius: 0.08 },
    sizeOverLife: [[0, 0.5], [1, 3.2]], alpha: [[0, 0], [0.1, 0.3], [0.6, 0.2], [1, 0]], color: [[0, [0.38, 0.38, 0.38]], [1, [0.12, 0.12, 0.12]]],
  }),
  fire: Object.freeze({
    count: 200, rate: 45, lifetime: [0.5, 0.9], speed: [0.3, 0.9], size: [0.18, 0.3], spread: 12, drag: 1, orient: 'billboard', spin: [-40, 40],
    gravityScale: 0, acceleration: [0, 2.5, 0], emitter: { shape: 'disc', radius: 0.1 },
    sizeOverLife: [[0, 0.5], [0.25, 1], [1, 0.1]], alpha: [[0, 0], [0.1, 0.22], [0.7, 0.1], [1, 0]],
    color: [[0, [1, 0.7, 0.15]], [0.35, [1, 0.3, 0.03]], [1, [0.22, 0.02, 0]]],
  }),
  sparkles: Object.freeze({
    count: 240, rate: 80, lifetime: [0.8, 1.6], speed: [0.1, 0.5], size: [0.06, 0.12], spread: 180, drag: 0.5, orient: 'billboard',
    gravityScale: 0, emitter: { shape: 'sphere', radius: 0.4 },
    sizeOverLife: [[0, 0], [0.15, 1], [0.3, 0.4], [0.45, 1], [0.6, 0.4], [0.75, 1], [1, 0]],
    alpha: [[0, 0], [0.15, 1], [0.3, 0.25], [0.45, 1], [0.6, 0.25], [0.75, 1], [1, 0]],
    color: [[0, [1, 1, 0.85]], [1, [1, 0.8, 0.35]]],
  }),
});
const SPARK_SYSTEM_FIELDS = ['type', 'preset', 'node', 'seed', 'count', 'delay', 'lifetime', 'speed', 'direction', 'spread', 'emitter', 'position', 'size', 'drag', 'floor', 'bounce', 'temperature', 'intensity', 'shutter'];
const SPARK_PRESETS = Object.freeze({
  // A blast: a few hundred sparks thrown in every direction from a small ball, fast, light enough for drag to pull them in, living 0.5 to 2 s.
  explosion: Object.freeze({ count: 800, speed: [6, 24], spread: 180, lifetime: [0.5, 2], size: [0.006, 0.014], drag: 0.9, emitter: Object.freeze({ shape: 'sphere', radius: 0.2 }) }),
});
const HAIR_FIELDS = ['type', 'node', 'surface', 'seed', 'count', 'length', 'segments', 'width', 'droop', 'lean', 'sway', 'swayRate'];
const EMITTER_FIELDS = ['shape', 'position', 'halfExtents', 'radius', 'mesh', 'from', 'group', 'sharpAngle', 'normalSpeed', 'velocityFrom', 'velocityScale', 'groupThreshold', 'region', 'follow'];
const EMITTER_SHAPES = ['point', 'box', 'sphere', 'disc', 'mesh'];
const ORIENT_MODES = ['none', 'random', 'normal', 'billboard'];
const FADE_MODES = ['darken', 'opacity'];
const SCALE_MODES = ['constant', 'shrink', 'grow'];
const DEFAULT_GRAVITY = Object.freeze([0, -9.81, 0]);
// Defaults that read as debris: a bounce keeps 30 percent of the speed (the first release of collision stuck at 0 without colliders and had no default with them), friction 0.5.
const DEBRIS_BOUNCE = 0.3;
const DEBRIS_FRICTION = 0.5;
const POSITION_LIMIT = 10000;
const MAX_SEED = 0xffffffff;

// A number stands for the range [value, value].
function rangeOf(value, path, minimum, maximum) {
  if (typeof value === 'number') {
    return [finiteNumber(value, path, minimum, maximum), value];
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalidField(path, value, `a number or [minimum, maximum] from ${minimum} to ${maximum}, such as [${Math.max(minimum, 0.5)}, ${Math.min(maximum, 1)}]`, TypeError);
  }
  const range = value.map((entry, index) => finiteNumber(entry, `${path}[${index}]`, minimum, maximum));
  if (range[0] > range[1]) {
    throw invalidField(path, value, `[minimum, maximum] with the minimum not above the maximum, such as [${range[1]}, ${range[0]}]`);
  }
  return range;
}

function normalizeMeshEmitter(input, emitter, context, path) {
  rootNodeWithGeometry(input.mesh, context.recipeNodes, new Set(), context.motionNodeIds, context.physicsNodeIds, `${path}.mesh`, 'particles');
  const from = input.from ?? 'surface';
  if (!EMITTER_MESH_MODES.includes(from)) {
    throw invalidField(`${path}.from`, from, `one of ${EMITTER_MESH_MODES.join(', ')}`);
  }
  emitter.mesh = input.mesh;
  emitter.from = from;
  if (input.group !== undefined) {
    if (typeof input.group !== 'string' || !input.group) {
      throw invalidField(`${path}.group`, input.group, 'the name of a vertex group on the emitter mesh, such as "edge"');
    }
    if (from === 'volume') {
      throw invalidField(`${path}.group`, input.group, `left out, because a vertex group weighs ${path}.from "surface", "vertices" or "edges", not "volume"`);
    }
    emitter.group = input.group;
  }
  if (input.sharpAngle !== undefined) {
    if (from !== 'edges') {
      throw invalidField(`${path}.sharpAngle`, input.sharpAngle, `left out unless ${path}.from is "edges"`);
    }
    emitter.sharpAngle = finiteNumber(input.sharpAngle, `${path}.sharpAngle`, 0, 180);
  }
  if (input.normalSpeed !== undefined) {
    emitter.normalSpeed = finiteNumber(input.normalSpeed, `${path}.normalSpeed`, -1000, 1000);
  }
  if (input.groupThreshold !== undefined) {
    if (!emitter.group) {
      throw invalidField(`${path}.groupThreshold`, input.groupThreshold, `left out unless ${path}.group names a vertex group, such as "spray"`);
    }
    emitter.groupThreshold = finiteNumber(input.groupThreshold, `${path}.groupThreshold`, 0, 1);
  }
  normalizeVelocitySource(input, emitter, from, path);
  if (input.region !== undefined) emitter.region = normalizeRegion(input.region, `${path}.region`);
}

// `region` is a box in world space: births come only from the part of the mesh inside it (#2823).
function normalizeRegion(input, path) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidField(path, input, 'an object { center: [x, y, z], halfExtents: [x, y, z] }, such as { "center": [0, 0, 0], "halfExtents": [10, 5, 10] }', TypeError);
  }
  knownKeys(input, ['center', 'halfExtents'], path);
  const center = vectorOfThree(input.center, `${path}.center`, POSITION_LIMIT);
  const halfExtents = vectorOfThree(input.halfExtents, `${path}.halfExtents`, POSITION_LIMIT);
  halfExtents.forEach((extent, axis) => {
    if (!(extent > 0)) {
      throw invalidField(`${path}.halfExtents[${axis}]`, extent, `a number above 0 and up to ${POSITION_LIMIT}, such as 10 (half the size of the box along that axis)`);
    }
  });
  return { center, halfExtents };
}

// `velocityFrom` names a "vector:<name>" point attribute of the emitter mesh (the ocean's `spray`): each particle also leaves with that velocity.
function normalizeVelocitySource(input, emitter, from, path) {
  if (input.velocityFrom === undefined) {
    if (input.velocityScale !== undefined) {
      throw invalidField(`${path}.velocityScale`, input.velocityScale, `left out unless ${path}.velocityFrom names a vector, such as "spray"`);
    }
    return;
  }
  if (typeof input.velocityFrom !== 'string' || !input.velocityFrom) {
    throw invalidField(`${path}.velocityFrom`, input.velocityFrom, 'the name of a vector on the emitter mesh, such as "spray" (an ocean edit with spray: true writes it)');
  }
  if (from !== 'surface' && from !== 'vertices') {
    throw invalidField(`${path}.velocityFrom`, input.velocityFrom, `left out, because a vector has a value at vertices and across faces, so ${path}.from is "surface" or "vertices", not "${from}"`);
  }
  emitter.velocityFrom = input.velocityFrom;
  emitter.velocityScale = input.velocityScale === undefined ? 1 : finiteNumber(input.velocityScale, `${path}.velocityScale`, -1000, 1000);
}

const DEFAULT_EMITTER_RADIUS = 0.5;

// Only a sphere and a disc are sized by a radius, so only they get the default. A box takes its size from halfExtents and
// rejects a radius, except the 0.5 earlier versions wrote into every box they stored: that one is dropped so the recipe still loads.
function assignEmitterRadius(input, emitter, shape, path) {
  if (shape === 'box') {
    if (input.radius !== undefined && input.radius !== DEFAULT_EMITTER_RADIUS) {
      throw invalidField(`${path}.radius`, input.radius, `left out on a box, sized by ${path}.halfExtents`);
    }
    return;
  }
  if (input.radius !== undefined) {
    emitter.radius = finiteNumber(input.radius, `${path}.radius`, 0, POSITION_LIMIT);
  } else if (shape === 'sphere' || shape === 'disc') {
    emitter.radius = DEFAULT_EMITTER_RADIUS;
  }
}

const FOLLOW_ID_LIST_LIMIT = 20;

// `follow` names the node whose animated or physics-baked transform carries the emitter (#2829).
function normalizeFollow(input, emitter, shape, context, path) {
  if (shape === 'mesh') {
    throw invalidField(`${path}.follow`, input.follow, `left out on a mesh emitter, which takes its points from ${path}.mesh; use a point, box, sphere or disc emitter`);
  }
  if (typeof input.follow !== 'string' || !context.recipeNodes.has(input.follow)) {
    const known = [...context.recipeNodes.keys()];
    const more = known.length > FOLLOW_ID_LIST_LIMIT ? `, and ${known.length - FOLLOW_ID_LIST_LIMIT} more` : '';
    throw invalidField(`${path}.follow`, input.follow, `the ID of a node in the recipe whose transform the emitter follows (known nodes: ${known.slice(0, FOLLOW_ID_LIST_LIMIT).join(', ') || 'none'}${more})`);
  }
  emitter.follow = input.follow;
}

function normalizeEmitter(input, context, path) {
  knownKeys(input, EMITTER_FIELDS, path);
  const shape = input.shape ?? 'point';
  if (!EMITTER_SHAPES.includes(shape)) {
    throw invalidField(`${path}.shape`, shape, `one of ${EMITTER_SHAPES.join(', ')}`);
  }
  const emitter = {
    shape,
    position: input.position === undefined ? [0, 0, 0] : vectorOfThree(input.position, `${path}.position`, POSITION_LIMIT),
    halfExtents: input.halfExtents === undefined ? [0.5, 0.5, 0.5] : vectorOfThree(input.halfExtents, `${path}.halfExtents`, POSITION_LIMIT).map(Math.abs),
  };
  assignEmitterRadius(input, emitter, shape, path);
  if (input.follow !== undefined) normalizeFollow(input, emitter, shape, context, path);
  if (shape === 'mesh') {
    normalizeMeshEmitter(input, emitter, context, path);
  } else {
    for (const field of ['mesh', 'from', 'group', 'sharpAngle', 'normalSpeed', 'velocityFrom', 'velocityScale', 'groupThreshold', 'region']) {
      if (input[field] !== undefined) throw invalidField(`${path}.${field}`, input[field], `left out unless ${path}.shape is "mesh"`);
    }
  }
  return emitter;
}

function normalizeInstances(input, system, context, path) {
  if (input.instances !== undefined) {
    const nodeIds = boundedArray(input.instances, PARTICLE_LIMITS.maxInstances, `${path}.instances`);
    if (!nodeIds.length) {
      throw invalidField(`${path}.instances`, nodeIds, 'at least one node ID, such as ["leaf"]; leave it out to repeat the system node');
    }
    // Instance nodes are only read, so several systems may share one.
    nodeIds.forEach((nodeId, index) => {
      rootNodeWithGeometry(nodeId, context.recipeNodes, new Set(), context.motionNodeIds, context.physicsNodeIds, `${path}.instances[${index}]`, 'particles');
    });
    system.instances = nodeIds;
  }
  const orient = input.orient ?? 'none';
  if (!ORIENT_MODES.includes(orient)) {
    throw invalidField(`${path}.orient`, orient, `one of ${ORIENT_MODES.join(', ')}`);
  }
  const source = system.emitter;
  if (orient === 'normal' && (source.shape !== 'mesh' || source.from === 'volume')) {
    throw invalidField(`${path}.orient`, orient, `"none" or "random", because a normal needs ${path}.emitter.shape "mesh" with from "surface", "vertices" or "edges"`);
  }
  if (source.normalSpeed && source.from === 'volume') {
    throw invalidField(`${path}.emitter.normalSpeed`, source.normalSpeed, 'left out when from is "volume", which has no surface normal');
  }
  if (orient !== 'none') system.orient = orient;
}

function normalizeCount(input, path) {
  const count = input.count ?? 100;
  if (!Number.isInteger(count) || count < 1 || count > PARTICLE_LIMITS.maxParticlesPerSystem) {
    throw invalidField(`${path}.count`, count, `a whole number from 1 to ${PARTICLE_LIMITS.maxParticlesPerSystem}, such as 100`);
  }
  return count;
}

function normalizeSeed(input, path) {
  const seed = input.seed ?? 1;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw invalidField(`${path}.seed`, seed, `a whole number from 0 to ${MAX_SEED}, such as 1`);
  }
  return seed;
}

function normalizeColors(value, path) {
  if (isColorStops(value)) return normalizeColorStops(value, path);
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalidField(path, value, '[start, end], each [r, g, b] from 0 to 1, such as [[1, 0.6, 0.1], [0.3, 0, 0]]', TypeError);
  }
  return value.map((color, index) => vectorOfThree(color, `${path}[${index}]`, 1000).map((channel, channelIndex) => finiteNumber(channel, `${path}[${index}][${channelIndex}]`, 0, 1000)));
}

// [start, end] over the life, in either direction; a number holds one value.
function normalizeAlpha(value, path) {
  if (Array.isArray(value) && value.some(Array.isArray)) return normalizeCurve(value, path, 0, 1);
  if (typeof value === 'number') {
    return [finiteNumber(value, path, 0, 1), value];
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalidField(path, value, 'a number or [start, end] from 0 to 1, such as [1, 0]', TypeError);
  }
  return value.map((entry, index) => finiteNumber(entry, `${path}[${index}]`, 0, 1));
}

function normalizeColliders(value, context, path) {
  const nodeIds = boundedArray(value, PARTICLE_LIMITS.maxColliders, path);
  // Colliders are only read, so several systems may share one.
  nodeIds.forEach((nodeId, index) => {
    rootNodeWithGeometry(nodeId, context.recipeNodes, new Set(), context.motionNodeIds, context.physicsNodeIds, `${path}[${index}]`, 'particles');
  });
  return nodeIds;
}

function normalizeEmitterSystem(input, context, path) {
  knownKeys(input, EMITTER_SYSTEM_FIELDS, path);
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, `${path}.node`, 'particles');
  const system = {
    type: 'emitter', node: input.node, seed: normalizeSeed(input, path), count: normalizeCount(input, path),
    lifetime: rangeOf(input.lifetime ?? 1, `${path}.lifetime`, 0.01, PARTICLE_LIMITS.maxLifetime),
    speed: rangeOf(input.speed ?? 1, `${path}.speed`, 0, 1000),
    size: rangeOf(input.size ?? 0.05, `${path}.size`, 0.0001, 100),
    direction: input.direction === undefined ? [0, 1, 0] : vectorOfThree(input.direction, `${path}.direction`, 1000),
    spread: input.spread === undefined ? 30 : finiteNumber(input.spread, `${path}.spread`, 0, 180),
    emitter: normalizeEmitter(input.emitter ?? {}, context, `${path}.emitter`),
    scale: input.scale ?? 'constant',
    drag: input.drag === undefined ? 0 : finiteNumber(input.drag, `${path}.drag`, 0, 100),
  };
  if (Math.hypot(...system.direction) === 0) {
    throw invalidField(`${path}.direction`, system.direction, 'a direction that is not the zero vector, such as [0, 1, 0]');
  }
  if (!SCALE_MODES.includes(system.scale)) {
    throw invalidField(`${path}.scale`, system.scale, `one of ${SCALE_MODES.join(', ')}`);
  }
  if (input.rate !== undefined) system.rate = finiteNumber(input.rate, `${path}.rate`, 0.01, PARTICLE_LIMITS.maxParticlesPerSystem * 100);
  applyEmissionWindow(input, system, path);
  if (input.bounce !== undefined) system.bounce = finiteNumber(input.bounce, `${path}.bounce`, 0, 1);
  if (input.friction !== undefined) system.friction = finiteNumber(input.friction, `${path}.friction`, 0, 1);
  if (input.spin !== undefined) system.spin = rangeOf(input.spin, `${path}.spin`, -100000, 100000);
  if (input.color !== undefined) system.color = normalizeColors(input.color, `${path}.color`);
  if (input.alpha !== undefined) system.alpha = normalizeAlpha(input.alpha, `${path}.alpha`);
  if (input.fade !== undefined) {
    if (!FADE_MODES.includes(input.fade)) throw invalidField(`${path}.fade`, input.fade, `one of ${FADE_MODES.join(', ')}`);
    if (input.fade === 'opacity' && !system.alpha) {
      throw invalidField(`${path}.fade`, input.fade, `"darken", or "opacity" together with ${path}.alpha, such as alpha [1, 0], because the fade needs the opacity to go from and to`);
    }
    if (input.fade === 'opacity') system.fade = 'opacity';
  }
  if (input.colliders !== undefined) {
    system.colliders = normalizeColliders(input.colliders, context, `${path}.colliders`);
    if (system.colliders.includes(system.node)) {
      throw invalidField(`${path}.colliders`, system.colliders, `node IDs other than the system's own node "${system.node}"`);
    }
  }
  normalizeInstances(input, system, context, path);
  if (input.floor !== undefined) system.floor = finiteNumber(input.floor, `${path}.floor`, -POSITION_LIMIT, POSITION_LIMIT);
  if (input.sizeOverLife !== undefined) system.sizeOverLife = normalizeCurve(input.sizeOverLife, `${path}.sizeOverLife`, 0, 100);
  if (input.gravityScale !== undefined) system.gravityScale = finiteNumber(input.gravityScale, `${path}.gravityScale`, -10, 10);
  if (input.acceleration !== undefined) system.acceleration = vectorOfThree(input.acceleration, `${path}.acceleration`, 1000);
  if (input.flipbook !== undefined) system.flipbook = normalizeFlipbook(input.flipbook, `${path}.flipbook`);
  if (input.preset !== undefined) system.preset = input.preset;
  return system;
}

function normalizeSparkTemperature(value, path) {
  const example = '[start, end] kelvin, such as [2500, 800]';
  if (!Array.isArray(value) || value.length !== 2) throw invalidField(path, value, example, TypeError);
  const [start, end] = value.map((entry, index) => finiteNumber(entry, `${path}[${index}]`, SPARK_LIMITS.minKelvin, SPARK_LIMITS.maxKelvin));
  if (end > start) throw invalidField(path, value, `a spark that cools, with the start at or above the end, such as [${end}, ${start}]`);
  return [start, end];
}

// The material must be unlit: an unlit surface outputs colour times vertex colour, and the vertex colour is the spark's blackbody radiance.
function checkSparkMaterial(system, recipe, path) {
  const node = recipe.nodes.find(candidate => candidate.id === system.node);
  const material = recipe.materials?.find(candidate => candidate.id === node.material);
  if (material && material.tag !== 'unlit') {
    throw invalidField(`${path}.node`, `${system.node} (material "${material.id}" has tag "${material.tag}")`, 'a node with an unlit material of colour [1, 1, 1] (tag "unlit"), whose colour times vertex colour carries the spark radiance');
  }
}

function sparkEmitterInput(input, preset, path) {
  const emitterInput = { ...(preset?.emitter ?? { shape: 'point' }), ...input.emitter };
  if (input.position !== undefined) {
    if (input.emitter?.position !== undefined) {
      throw invalidField(`${path}.position`, input.position, `left out when ${path}.emitter.position is set; give the blast point once`);
    }
    emitterInput.position = input.position;
  }
  return emitterInput;
}

function normalizeSparkSystem(input, context, path, recipe) {
  knownKeys(input, SPARK_SYSTEM_FIELDS, path);
  const presetName = input.preset;
  if (presetName !== undefined && !SPARK_PRESETS[presetName]) {
    throw invalidField(`${path}.preset`, presetName, `one of ${Object.keys(SPARK_PRESETS).join(', ')}, or left out`);
  }
  const preset = SPARK_PRESETS[presetName];
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, `${path}.node`, 'particles');
  const count = input.count ?? preset?.count ?? 200;
  if (!Number.isInteger(count) || count < 1 || count > SPARK_LIMITS.maxCount) {
    throw invalidField(`${path}.count`, count, `a whole number from 1 to ${SPARK_LIMITS.maxCount}, such as 800`);
  }
  const emitter = normalizeEmitter(sparkEmitterInput(input, preset, path), context, `${path}.emitter`);
  const system = {
    type: 'sparks', node: input.node, seed: normalizeSeed(input, path), count,
    lifetime: rangeOf(input.lifetime ?? preset?.lifetime ?? [0.5, 2], `${path}.lifetime`, SPARK_LIMITS.minLifetime, SPARK_LIMITS.maxLifetime),
    speed: rangeOf(input.speed ?? preset?.speed ?? [4, 12], `${path}.speed`, 0, SPARK_LIMITS.maxSpeed),
    size: rangeOf(input.size ?? preset?.size ?? 0.01, `${path}.size`, SPARK_LIMITS.minRadius, SPARK_LIMITS.maxRadius),
    direction: input.direction === undefined ? [0, 1, 0] : vectorOfThree(input.direction, `${path}.direction`, 1000),
    spread: finiteNumber(input.spread ?? preset?.spread ?? 180, `${path}.spread`, 0, 180),
    emitter,
    drag: finiteNumber(input.drag ?? preset?.drag ?? 0.5, `${path}.drag`, 0, 100),
    temperature: normalizeSparkTemperature(input.temperature ?? SPARK_DEFAULTS.temperature, `${path}.temperature`),
    intensity: finiteNumber(input.intensity ?? SPARK_DEFAULTS.intensity, `${path}.intensity`, 0, SPARK_LIMITS.maxIntensity),
    shutter: finiteNumber(input.shutter ?? SPARK_DEFAULTS.shutter, `${path}.shutter`, 0, SPARK_LIMITS.maxShutter),
  };
  if (Math.hypot(...system.direction) === 0) {
    throw invalidField(`${path}.direction`, system.direction, 'a direction that is not the zero vector, such as [0, 1, 0]');
  }
  if (input.floor !== undefined) system.floor = finiteNumber(input.floor, `${path}.floor`, -POSITION_LIMIT, POSITION_LIMIT);
  if (input.bounce !== undefined) system.bounce = finiteNumber(input.bounce, `${path}.bounce`, 0, 1);
  if (input.delay !== undefined) system.delay = finiteNumber(input.delay, `${path}.delay`, 0, 3600);
  checkSparkMaterial(system, recipe, path);
  return system;
}

function normalizeHairSystem(input, context, path) {
  knownKeys(input, HAIR_FIELDS, path);
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, `${path}.node`, 'particles');
  // The surface is only read, so several systems may grow from one node.
  rootNodeWithGeometry(input.surface, context.recipeNodes, new Set(), context.motionNodeIds, context.physicsNodeIds, `${path}.surface`, 'particles');
  if (input.surface === input.node) {
    throw invalidField(`${path}.surface`, input.surface, 'a node other than the hair node, such as the head mesh');
  }
  const segments = input.segments ?? 4;
  if (!Number.isInteger(segments) || segments < 1 || segments > HAIR_LIMITS.maxSegments) {
    throw invalidField(`${path}.segments`, segments, `a whole number from 1 to ${HAIR_LIMITS.maxSegments}, such as 4`);
  }
  const system = {
    type: 'hair', node: input.node, surface: input.surface, seed: normalizeSeed(input, path), count: normalizeCount(input, path), segments,
    length: rangeOf(input.length ?? 0.1, `${path}.length`, 0.001, 100),
    width: finiteNumber(input.width ?? 0.004, `${path}.width`, 0.0001, 10),
    droop: finiteNumber(input.droop ?? 0.5, `${path}.droop`, 0, 10),
    lean: finiteNumber(input.lean ?? 0.2, `${path}.lean`, 0, 2),
  };
  if (input.sway === undefined && input.swayRate !== undefined) {
    throw invalidField(`${path}.swayRate`, input.swayRate, `left out unless ${path}.sway is set`);
  }
  if (input.sway !== undefined) {
    system.sway = finiteNumber(input.sway, `${path}.sway`, 0, 10);
    system.swayRate = finiteNumber(input.swayRate ?? 0.5, `${path}.swayRate`, 0.01, 20);
  }
  return system;
}

function applyPreset(input, path) {
  if (input?.preset === undefined || input.type === 'sparks') return input;
  const preset = PARTICLE_PRESETS[input.preset];
  if (!preset || (input.type ?? 'emitter') !== 'emitter') {
    throw invalidField(`${path}.preset`, input.preset, `one of ${Object.keys(PARTICLE_PRESETS).join(', ')} on an emitter system, or left out`);
  }
  return { ...preset, ...input, emitter: { ...preset.emitter, ...input.emitter } };
}

function nodeIdOf(value, context, path, system) {
  if (typeof value !== 'string' || !context.recipeNodes.has(value)) {
    const known = [...context.recipeNodes.keys()];
    throw invalidField(path, value, `the ID of a node in the recipe (known nodes: ${known.slice(0, 8).join(', ') || 'none'}${known.length > 8 ? ', ...' : ''})`);
  }
  if (value === system.node) {
    throw invalidField(path, value, 'another node than the system node, which is replaced by the strip; use a node that marks the point');
  }
  return value;
}

function normalizeBeamEnd(value, context, path, system) {
  const entry = typeof value === 'string' ? { node: value } : value;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw invalidField(path, value, 'a node ID or { node, offset: [x, y, z] }, such as "muzzle"', TypeError);
  }
  knownKeys(entry, ['node', 'offset'], path);
  return { node: nodeIdOf(entry.node, context, `${path}.node`, system), offset: entry.offset === undefined ? [0, 0, 0] : vectorOfThree(entry.offset, `${path}.offset`, 1000) };
}

function normalizeRibbonLook(input, system, path) {
  system.width = normalizeCurve(input.width ?? (system.type === 'trail' ? [0.2, 0] : 0.2), `${path}.width`, 0, RIBBON_LIMITS.maxWidth);
  system.alpha = normalizeCurve(input.alpha ?? (system.type === 'trail' ? [1, 0] : 1), `${path}.alpha`, 0, 1);
  if (input.color !== undefined) system.color = normalizeColors(input.color, `${path}.color`);
  system.repeat = finiteNumber(input.repeat ?? 1, `${path}.repeat`, 0.01, 1000);
  if (input.fade !== undefined) {
    if (!FADE_MODES.includes(input.fade)) throw invalidField(`${path}.fade`, input.fade, `one of ${FADE_MODES.join(', ')}`);
    system.fade = input.fade;
  }
}

function normalizeSegments(input, fallback, maximum, path) {
  const segments = input ?? fallback;
  if (!Number.isInteger(segments) || segments < 1 || segments > maximum) {
    throw invalidField(`${path}.segments`, segments, `a whole number from 1 to ${maximum}, such as ${fallback}`);
  }
  return segments;
}

function normalizeBeamSystem(input, context, path) {
  knownKeys(input, BEAM_FIELDS, path);
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, `${path}.node`, 'particles');
  const system = { type: 'beam', node: input.node };
  system.from = normalizeBeamEnd(input.from, context, `${path}.from`, system);
  system.to = normalizeBeamEnd(input.to, context, `${path}.to`, system);
  system.segments = normalizeSegments(input.segments, 8, RIBBON_LIMITS.maxBeamSegments, path);
  system.curve = input.curve === undefined ? [0, 0, 0] : vectorOfThree(input.curve, `${path}.curve`, 1000);
  system.scroll = finiteNumber(input.scroll ?? 0, `${path}.scroll`, -1000, 1000);
  normalizeRibbonLook(input, system, path);
  return system;
}

function normalizeTrailSystem(input, context, path) {
  knownKeys(input, TRAIL_FIELDS, path);
  rootNodeWithGeometry(input.node, context.recipeNodes, context.claimedNodes, context.motionNodeIds, context.physicsNodeIds, `${path}.node`, 'particles');
  const system = { type: 'trail', node: input.node };
  system.follow = nodeIdOf(input.follow, context, `${path}.follow`, system);
  system.offset = input.offset === undefined ? [0, 0, 0] : vectorOfThree(input.offset, `${path}.offset`, 1000);
  system.lifetime = finiteNumber(input.lifetime ?? 0.5, `${path}.lifetime`, RIBBON_LIMITS.minTrailLifetime, RIBBON_LIMITS.maxTrailLifetime);
  system.segments = normalizeSegments(input.segments, 24, RIBBON_LIMITS.maxTrailSegments, path);
  normalizeRibbonLook(input, system, path);
  return system;
}

function normalizeSystem(rawInput, context, path, recipe) {
  const input = applyPreset(rawInput, path);
  const type = input?.type ?? 'emitter';
  if (!SYSTEM_TYPES.includes(type)) {
    throw invalidField(`${path}.type`, type, `one of ${SYSTEM_TYPES.join(', ')}`);
  }
  if (type === 'sparks') return normalizeSparkSystem(input, context, path, recipe);
  if (type === 'beam') return normalizeBeamSystem(input, context, path);
  if (type === 'trail') return normalizeTrailSystem(input, context, path);
  return type === 'hair' ? normalizeHairSystem(input, context, path) : normalizeEmitterSystem(input, context, path);
}

/** Validate a recipe particles section against its nodes. Returns the plain, bounded form stored in the recipe. */
export function normalizeAgentParticles(input, recipe) {
  if (input === null || input === undefined) {
    return null;
  }
  knownKeys(input, PARTICLES_FIELDS, 'particles');
  const context = bakingContext(recipe, ['cloth']);
  const result = {};
  result.systems = boundedArray(input.systems, PARTICLE_LIMITS.maxSystems, 'particles.systems').map((system, index) => normalizeSystem(system, context, `particles.systems[${index}]`, recipe));
  if (!result.systems.length) {
    throw invalidField('particles.systems', result.systems, 'at least one system, such as [{ "node": "sparks" }]; use particles: null to clear it');
  }
  const systemNodes = new Set(result.systems.map(system => system.node));
  for (const system of result.systems) {
    const clash = system.colliders?.find(nodeId => systemNodes.has(nodeId));
    if (clash) {
      throw invalidField('particles.systems', clash, 'colliders that are not particle system nodes, because a system replaces its own geometry with particles');
    }
  }
  const sparkTotal = result.systems.reduce((sum, system) => sum + (system.type === 'sparks' ? system.count : 0), 0);
  if (sparkTotal > SPARK_LIMITS.maxCount) {
    throw invalidField('particles.systems', `${sparkTotal} sparks in total`, `spark counts that add up to at most ${SPARK_LIMITS.maxCount}, such as a lower count in each system`);
  }
  const total = result.systems.reduce((sum, system) => sum + (system.type === 'sparks' ? 0 : system.count ?? 0), 0);
  if (total > PARTICLE_LIMITS.maxParticles) {
    throw invalidField('particles.systems', `${total} particles in total`, `counts that add up to at most ${PARTICLE_LIMITS.maxParticles}, such as a lower count in each system`);
  }
  if (input.gravity !== undefined) result.gravity = vectorOfThree(input.gravity, 'particles.gravity', 1000);
  if (input.wind !== undefined) result.wind = vectorOfThree(input.wind, 'particles.wind', 100);
  if (input.fields !== undefined) result.fields = normalizeForceFields(input.fields, 'Particle force field');
  return result;
}

function nodeMatrix(node) {
  return mat4.fromRotationTranslationScale(mat4.create(), node.rotation, node.translation, node.scale);
}

// The mesh is built in world space; the part draws it through the node's own matrix, so undo that matrix here.
function worldToNodeLocal(geometry, matrix) {
  const inverse = mat4.invert(mat4.create(), matrix);
  const positions = new Float32Array(geometry.positions.length);
  const normals = new Float32Array(geometry.normals.length);
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = geometry.positions[offset];
    const y = geometry.positions[offset + 1];
    const z = geometry.positions[offset + 2];
    for (let axis = 0; axis < 3; axis++) {
      positions[offset + axis] = inverse[axis] * x + inverse[4 + axis] * y + inverse[8 + axis] * z + inverse[12 + axis];
      normals[offset + axis] = matrix[axis * 4] * geometry.normals[offset] + matrix[axis * 4 + 1] * geometry.normals[offset + 1] + matrix[axis * 4 + 2] * geometry.normals[offset + 2];
    }
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) normals[offset + axis] /= length;
  }
  return Object.freeze({ ...geometry, positions, normals });
}

// `start` is a second name for `delay` (seconds before the first birth); `stop` ends the window, so a system with a `rate`
// emits only inside it.
function applyEmissionWindow(input, system, path) {
  if (input.start !== undefined && input.delay !== undefined) {
    throw invalidField(`${path}.start`, input.start, 'either start or delay, which mean the same thing (seconds before the first birth), not both');
  }
  const startField = input.start === undefined ? 'delay' : 'start';
  const startInput = input.start ?? input.delay;
  if (startInput !== undefined) system.delay = finiteNumber(startInput, `${path}.${startField}`, 0, 3600);
  if (input.stop === undefined) return;
  const stop = finiteNumber(input.stop, `${path}.stop`, 0, 3600);
  const start = system.delay ?? 0;
  if (stop <= start) {
    throw invalidField(`${path}.stop`, input.stop, `an absolute scene time in seconds, above start (${start}), such as ${start + 2} (stop is not a duration after start)`);
  }
  system.stop = stop;
}

// Most particles alive at once and the time the last one dies, counted from the launch values alone.
function lifeSummary(launches) {
  const events = [];
  for (let index = 0; index < launches.count; index++) {
    if (launches.birth[index] >= launches.stop) continue;
    events.push([launches.birth[index], 1], [launches.birth[index] + launches.life[index], -1]);
  }
  events.sort((first, second) => first[0] - second[0] || first[1] - second[1]);
  let alive = 0;
  let peak = 0;
  for (const [, change] of events) {
    alive += change;
    peak = Math.max(peak, alive);
  }
  return { maxAlive: peak, endsAt: Number(events.at(-1)[0].toFixed(4)) };
}

function surfaceInWorld(geometry, matrix) {
  const positions = new Float64Array(geometry.positions.length);
  const normals = new Float64Array(geometry.normals.length);
  const normalMatrix = mat3.normalFromMat4(mat3.create(), matrix);
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      positions[offset + axis] = matrix[axis] * geometry.positions[offset] + matrix[4 + axis] * geometry.positions[offset + 1] + matrix[8 + axis] * geometry.positions[offset + 2] + matrix[12 + axis];
      normals[offset + axis] = normalMatrix[axis] * geometry.normals[offset] + normalMatrix[3 + axis] * geometry.normals[offset + 1] + normalMatrix[6 + axis] * geometry.normals[offset + 2];
    }
    // A scaled node shrinks or stretches the inverse-transpose normal; callers need unit normals for speeds and orientation.
    const length = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) normals[offset + axis] /= length;
  }
  return { positions, normals };
}

// What to change when the drawn vertices pass the limit: a default box has a bevel, so each particle is 1176 vertices, not 24.
function bevelledBoxAdvice(nodeId, recipe) {
  const node = recipe.nodes.find(candidate => candidate.id === nodeId);
  const definition = (recipe.geometries ?? []).find(candidate => candidate.id === node?.geometry);
  const base = definition?.type === 'mesh' ? definition.base : definition;
  return base?.type === 'box' && base.bevel !== 0 ? '; the shape is a box with a bevel, so pass "bevel": 0 on it to make it 24 vertices' : '';
}

function checkVertexBudget(verticesPerItem, count, totalVertices, nodeId, recipe) {
  const vertices = verticesPerItem * count;
  if (vertices > PARTICLE_LIMITS.maxVertices || totalVertices > PARTICLE_LIMITS.maxVertices) {
    throw invalidField('particles.systems', `${totalVertices} vertices`, `at most ${PARTICLE_LIMITS.maxVertices} vertices drawn in total; node ${nodeId} draws ${verticesPerItem} vertices per particle times count ${count}, so use a shape with fewer vertices or a lower count${bevelledBoxAdvice(nodeId, recipe)}`);
  }
}

// The geometries a particle can be: the listed instance nodes, or else the system node's own.
// A preset draws camera-facing cards, so a plane or grid node whose geometry names no `segments` is drawn as one quad (4 vertices) instead of the
// default 17 by 17 grid: the preset counts of hundreds of cards then fit the vertex budget with no extra setting. A `segments` the recipe gives wins.
function templateOf(system, node, recipe, geometries) {
  const definition = recipe.geometries.find(entry => entry.id === node.geometry);
  const isDefaultPlane = (definition?.type === 'plane' || definition?.type === 'grid') && definition.segments === undefined;
  return system.preset && isDefaultPlane ? grid(1) : geometries.get(node.geometry);
}

function templateNodeIds(system) {
  return system.instances ?? [system.node];
}

function horizontalDirection(wind) {
  const length = Math.hypot(wind[0], wind[2]);
  return length > 1e-6 ? [wind[0] / length, 0, wind[2] / length] : [1, 0, 0];
}

function collisionSurfaceOf(system, nodes, geometries) {
  if (!system.colliders) return undefined;
  const meshes = system.colliders.map(nodeId => {
    const collider = nodes.get(nodeId);
    const geometry = geometries.get(collider.geometry);
    return { positions: surfaceInWorld(geometry, nodeMatrix(collider)).positions, indices: geometry.indices };
  });
  const surface = createCollisionSurface(meshes);
  if (surface.triangleCount > PARTICLE_LIMITS.maxColliderTriangles) {
    throw invalidField('particles.systems', `${surface.triangleCount} collider triangles for node ${system.node}`, `colliders with at most ${PARTICLE_LIMITS.maxColliderTriangles} triangles in total, such as a simpler collider mesh`);
  }
  return surface;
}

// The emitter group's weight per render vertex. A name the mesh lacks is an error that lists the groups it has.
function vertexGroupOf(emitter, geometry, emitterPath) {
  const weights = geometry.vertexGroups?.[emitter.group];
  if (!weights) {
    const known = Object.keys(geometry.vertexGroups ?? {});
    throw invalidField(`${emitterPath}.group`, emitter.group, `a vertex group of node ${emitter.mesh} (known groups: ${known.join(', ') || 'none'}); make one with a vertex_group mesh edit`);
  }
  return weights;
}

// The emitter's vector in world space, scaled by velocityScale. A name the mesh lacks is an error that lists the vectors it has.
function velocityVectorOf(emitter, geometry, matrix, emitterPath) {
  const vectors = geometry.vertexVectors?.[emitter.velocityFrom];
  if (!vectors) {
    const known = Object.keys(geometry.vertexVectors ?? {});
    throw invalidField(`${emitterPath}.velocityFrom`, emitter.velocityFrom, `a vector of node ${emitter.mesh} (known vectors: ${known.join(', ') || 'none'}); an ocean edit with spray: true writes "spray"`);
  }
  const world = new Float64Array(vectors.length);
  for (let offset = 0; offset < vectors.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      world[offset + axis] = emitter.velocityScale * (matrix[axis] * vectors[offset] + matrix[4 + axis] * vectors[offset + 1] + matrix[8 + axis] * vectors[offset + 2]);
    }
  }
  return world;
}

// A sea whose oceanTime a motion track drives is sampled at the ocean time of each particle's birth, rounded to this step (seconds of ocean time).
const OCEAN_TIME_STEP = 1 / 24;
// A clip of this many ocean-time steps (5 s) is what the sea bake budget is sized for.
const OCEAN_BAKE_REFERENCE_STEPS = 120;
// Vertex-steps (sea vertices times ocean times built) one emitter may spend; each costs about 0.1 ms, so this stays near 10 s (#2823).
export const OCEAN_BAKE_VERTEX_STEPS = 3_000_000;
// How many steps either side of a birth to look when the sea has no spray at that moment.
const OCEAN_TIME_SEARCH_STEPS = 96;

function meshSourceFrom(emitter, geometry, sourceNode, emitterPath) {
  const world = surfaceInWorld(geometry, nodeMatrix(sourceNode));
  const weights = emitter.group ? vertexGroupOf(emitter, geometry, emitterPath) : null;
  const sharpAngle = emitter.sharpAngle ?? null;
  const vectors = emitter.velocityFrom ? velocityVectorOf(emitter, geometry, nodeMatrix(sourceNode), emitterPath) : null;
  const source = createMeshSource(world.positions, world.normals, geometry.indices, emitter.from, weights, sharpAngle, vectors, emitter.groupThreshold ?? 0, emitter.region ?? null);
  // A vertices emitter keeps no per-triangle records, so the geometry's own vertex limit is the bound there (#2823).
  if (source && emitter.from !== 'vertices' && source.triangleCount > PARTICLE_LIMITS.maxEmitterTriangles) {
    throw invalidField(`${emitterPath}.mesh`, `${source.triangleCount} triangles on node ${emitter.mesh}`, `a mesh with at most ${PARTICLE_LIMITS.maxEmitterTriangles} triangles, such as a simpler proxy mesh`);
  }
  return source;
}

function emptySourceError(emitter, emitterPath, detail) {
  if (emitter.region) {
    detail += `; emitter.region (center ${emitter.region.center.join(', ')}, halfExtents ${emitter.region.halfExtents.join(', ')}) holds no part of the mesh: move ${emitterPath}.region.center onto the mesh or raise its halfExtents`;
  }
  const groupNote = emitter.group ? ` and some weight in vertex group "${emitter.group}"` : '';
  return invalidField(`${emitterPath}.mesh`, emitter.mesh, `a node whose mesh has triangles with some area${groupNote}, because emitter.from is "${emitter.from}"${detail}`);
}

// The source of a sea that an oceanTime track moves: each particle takes its point from the sea as it is when the particle is born.
/** Whole ocean-time steps between two built seas: 1 up to a sea of about 25,000 vertices, more for a bigger one so a 5 s clip stays inside OCEAN_BAKE_VERTEX_STEPS. */
export function oceanBakeStride(vertexCount) {
  return Math.max(1, Math.ceil(vertexCount * OCEAN_BAKE_REFERENCE_STEPS / OCEAN_BAKE_VERTEX_STEPS));
}

function followingSeaSource(emitter, sourceNode, sea, emitterPath) {
  const frames = new Map();
  let stride = null;
  const sourceAt = step => {
    if (!frames.has(step)) {
      const geometry = sea.geometryAt(sourceNode.geometry, step * OCEAN_TIME_STEP);
      stride ??= oceanBakeStride(geometry.positions.length / 3);
      frames.set(step, meshSourceFrom(emitter, geometry, sourceNode, emitterPath));
    }
    return frames.get(step);
  };
  const nearestSource = rawStep => {
    // The first sea built tells the stride; every step after it is a multiple of it, so a big sea is built at fewer ocean times.
    if (stride === null) sourceAt(rawStep);
    const step = Math.round(rawStep / stride) * stride;
    for (let distance = 0; distance <= OCEAN_TIME_SEARCH_STEPS; distance += stride) {
      const source = sourceAt(step + distance) ?? sourceAt(step - distance);
      if (source) return source;
    }
    throw emptySourceError(emitter, emitterPath, `; the sea of node ${emitter.mesh} has no weight in that group at any ocean time its oceanTime track gives near the births; raise the ocean windSpeed or choppiness, lower groupThreshold, or change ocean.time and the oceanTime track`);
  };
  return Object.freeze({
    mode: emitter.from,
    triangleCount: 0,
    sample: (random, birth) => nearestSource(Math.round(sea.oceanTimeAt(sourceNode.geometry, birth) / OCEAN_TIME_STEP)).sample(random),
  });
}

// A followed emitter reads the node's world matrix at each particle's birth time (#2829).
function followedEmitter(system, emitter, follow, emitterPath) {
  if (emitter.follow === system.node) {
    throw invalidField(`${emitterPath}.follow`, emitter.follow, 'another node than the system node, whose own transform does not move its particles; follow the moving node and keep the system node at rest');
  }
  return { ...emitter, pose: time => follow.matrixAt(emitter.follow, time) };
}

function meshSourceOf(system, nodes, geometries, systemIndex, sea, follow) {
  const emitterPath = `particles.systems[${systemIndex}].emitter`;
  const emitter = system.emitter;
  if (emitter.follow) return followedEmitter(system, emitter, follow, emitterPath);
  if (emitter.shape !== 'mesh') return emitter;
  const sourceNode = nodes.get(emitter.mesh);
  const followsSea = sea?.oceanTimeAt(sourceNode.geometry, 0) != null;
  if (followsSea) return { ...emitter, source: followingSeaSource(emitter, sourceNode, sea, emitterPath) };
  const source = meshSourceFrom(emitter, geometries.get(sourceNode.geometry), sourceNode, emitterPath);
  if (!source) {
    throw emptySourceError(emitter, emitterPath, emitter.group ? '; an ocean edit with spray: true has spray only on crests that rise, and that depends on its time, size, resolution and windSpeed: change them, lower groupThreshold, or animate the sea with an oceanTime track' : '');
  }
  return { ...emitter, source };
}

// `fade: "opacity"` writes the alpha curve to a per-vertex opacity, which only a blend material draws as see-through.
function checkOpacityFade(system, node, recipe, systemIndex) {
  if (system.fade !== 'opacity') return;
  const material = recipe.materials.find(entry => entry.id === node.material);
  if (material?.alphaMode !== 'blend') {
    throw invalidField(`particles.systems[${systemIndex}].fade`, system.fade, `"darken", or give the material "${node.material}" of node "${system.node}" alphaMode "blend" (it is "${material?.alphaMode ?? 'opaque'}"), because opacity only fades a blend material`);
  }
}

// Colours as three channel curves: a [start, end] pair and colour stops both become stops.
function colorCurveOf(color) {
  if (!color) return undefined;
  return colorChannelCurves(isColorStops(color) ? color : [[0, color[0]], [1, color[1]]]);
}

// Smoke fades by opacity when its material blends, and darkens otherwise, so the preset works on any material with nothing set.
function withPresetFade(system, node, recipe) {
  if (system.preset !== 'smoke' || system.fade) return system;
  const material = recipe.materials.find(entry => entry.id === node.material);
  return material?.alphaMode === 'blend' ? { ...system, fade: 'opacity' } : system;
}

function prepareBeam(system, node, follow) {
  const ribbon = { ...system, colorCurve: colorCurveOf(system.color) };
  return {
    node,
    report: () => ({ node: system.node, type: 'beam', from: system.from.node, to: system.to.node, segments: system.segments, vertices: (system.segments + 1) * 2 }),
    build: (time, camera) => {
      const [start, end] = beamEndpoints(system, follow.matrixAt, time);
      return buildBeamMesh(ribbon, start, end, time, camera);
    },
  };
}

function prepareTrail(system, node, follow) {
  const ribbon = { ...system, colorCurve: colorCurveOf(system.color) };
  return {
    node,
    report: () => ({ node: system.node, type: 'trail', follow: system.follow, lifetime: system.lifetime, segments: system.segments, vertices: (system.segments + 1) * 2 }),
    build: (time, camera) => buildTrailMesh(ribbon, follow.matrixAt, time, camera),
  };
}

function emitterLook(system) {
  const look = { ...system };
  if (isColorStops(system.color)) {
    look.colorCurve = colorChannelCurves(system.color);
    delete look.color;
  }
  if (system.alpha && Array.isArray(system.alpha[0])) {
    look.alphaCurve = system.alpha;
    delete look.alpha;
  }
  return look;
}

function prepareEmitter(system, node, templates, forces, colliders, emitter) {
  if (system.flipbook && !templates.every(template => template.uvs)) {
    throw invalidField('particles.systems[].flipbook', system.node, 'a system node whose geometry has UVs, such as a plane, because each particle shows one cell of the sheet through them');
  }
  const gravity = forces.gravity.map((component, axis) => component * (system.gravityScale ?? 1) + (system.acceleration?.[axis] ?? 0));
  const systemForces = { ...forces, gravity, drag: system.drag, floor: system.floor, bounce: system.bounce ?? (colliders ? DEBRIS_BOUNCE : 0), friction: system.friction ?? DEBRIS_FRICTION, colliders };
  const launches = createParticleLaunches({ ...system, sizeCurve: system.sizeOverLife, emitter, instanceCount: templates.length, spreadRadians: system.spread * Math.PI / 180, forces: systemForces });
  const look = emitterLook(system);
  return {
    node,
    report: () => ({ node: system.node, type: 'emitter', particles: system.count, verticesPerParticle: Math.max(...templates.map(template => template.positions.length / 3)), ...lifeSummary(launches) }),
    build: (time, camera) => buildParticleMesh(templates, launches, systemForces, system.scale, time, look, camera),
  };
}

/**
 * The seeded launches, the forces and the look of a normalized spark system. The agent scene draws from this, and so do the reference
 * renders (`scripts/make-spark-spec.mjs`), so every renderer shows the same sparks. `forces` is `{ gravity, wind, fields }`.
 */
export function sparkSystemSetup(system, forces, emitter = system.emitter) {
  const systemForces = { ...forces, drag: system.drag, floor: system.floor, bounce: system.bounce ?? 0, friction: DEBRIS_FRICTION };
  const launches = createParticleLaunches({ ...system, emitter, instanceCount: 1, spreadRadians: system.spread * Math.PI / 180, forces: systemForces });
  const look = { shutter: system.shutter, temperature: system.temperature, intensity: system.intensity };
  return { launches, forces: systemForces, look };
}

function prepareSparks(system, node, forces, emitter) {
  const { launches, forces: systemForces, look } = sparkSystemSetup(system, forces, emitter);
  return {
    node,
    report: () => ({ node: system.node, type: 'sparks', particles: system.count, verticesPerParticle: SPARK_VERTICES, temperature: [...system.temperature], shutter: system.shutter, ...lifeSummary(launches) }),
    build: time => buildSparkMesh(launches, systemForces, time, look),
  };
}

function prepareHair(system, node, surfaceNode, surfaceGeometry, forces) {
  const world = surfaceInWorld(surfaceGeometry, nodeMatrix(surfaceNode));
  const strands = createStrandRoots({ ...system, spread: system.lean }, world.positions, world.normals, surfaceGeometry.indices);
  const settings = {
    segments: system.segments, width: system.width, droop: system.droop,
    fields: forces.fields,
    sway: system.sway ? { amplitude: system.sway, rate: system.swayRate, direction: horizontalDirection(forces.wind) } : undefined,
  };
  const verticesPerStrand = (system.segments + 1) * HAIR_LIMITS.ringSides;
  let staticMesh = null;
  return {
    node,
    report: () => ({ node: system.node, type: 'hair', surface: system.surface, strands: system.count, segments: system.segments, verticesPerStrand }),
    // Without sway a strand never moves, so one build serves every time.
    build: time => {
      if (settings.sway || settings.fields.some(field => field.type === 'turbulence')) return buildHairMesh(strands, settings, time);
      staticMesh ??= buildHairMesh(strands, settings, 0);
      return staticMesh;
    },
  };
}

/**
 * Prepare the particles section. The result is a pure function of time: `sample(t)` returns the geometry of each
 * system node with every particle or strand placed from its seeded values, so a seek never replays earlier times.
 */
function isOrigin(vector) {
  return !vector || vector.every(component => component === 0);
}

/**
 * A system node's own transform does not move its particles, only emitter.position does, so a node placed at the spark point
 * with a translation and no emitter.position births its particles at the world origin (#2053). A mesh emitter takes its place
 * from the mesh node, so it has nothing to ignore.
 */
function nodeTransformProblems(particles, recipe) {
  const nodesById = new Map(recipe.nodes.map(node => [node.id, node]));
  const reported = new Set();
  const problems = [];
  for (const system of particles.systems) {
    const node = nodesById.get(system.node);
    if (!node || reported.has(node.id) || system.type === 'beam' || system.type === 'trail' || isOrigin(node.translation) || system.emitter?.shape === 'mesh' || !isOrigin(system.emitter?.position)) continue;
    reported.add(node.id);
    const translation = Array.from(node.translation).map(component => Math.round(component * 1000) / 1000).join(', ');
    problems.push({
      kind: 'particle-node-transform-ignored', severity: 'warning', target: node.id,
      message: `Particle system node ${node.id} is translated to [${translation}], but a system node's transform does not move its particles, so they are born at the world origin.`,
      fix: `Set emitter.position to [${translation}] on the system with scene_apply set-particles, and leave the node translation at [0, 0, 0].`,
    });
  }
  return problems;
}

/** `follow` is `{ matrixAt(nodeId, time) }`: the world matrix of a node at a scene time, for an emitter with `follow` (#2829). `sea` is `{ oceanTimeAt(geometryId, time), geometryAt(geometryId, oceanTime) }`: an emitter on a geometry that an oceanTime track drives follows that sea. */
export function bakeAgentParticles(particles, recipe, geometries, sea, follow) {
  const nodes = new Map(recipe.nodes.map(node => [node.id, node]));
  const forces = { gravity: particles.gravity ?? DEFAULT_GRAVITY, wind: particles.wind ?? [0, 0, 0], fields: particles.fields ?? [] };
  let totalVertices = 0;
  const prepared = particles.systems.map((system, systemIndex) => {
    const node = nodes.get(system.node);
    const verticesPerItem = system.type === 'beam' || system.type === 'trail' ? (system.segments + 1) * 2 : system.type === 'sparks' ? SPARK_VERTICES : system.type === 'hair' ? (system.segments + 1) * HAIR_LIMITS.ringSides : Math.max(...templateNodeIds(system).map(nodeId => templateOf(system, nodes.get(nodeId), recipe, geometries).positions.length / 3));
    const itemCount = system.count ?? 1;
    totalVertices += verticesPerItem * itemCount;
    checkVertexBudget(verticesPerItem, itemCount, totalVertices, system.node, recipe);
    if (system.type === 'beam' || system.type === 'trail') {
      checkOpacityFade(system, node, recipe, systemIndex);
      return system.type === 'beam' ? prepareBeam(system, node, follow) : prepareTrail(system, node, follow);
    }
    if (system.type === 'hair') {
      const surfaceNode = nodes.get(system.surface);
      return prepareHair(system, node, surfaceNode, geometries.get(surfaceNode.geometry), forces);
    }
    if (system.type === 'sparks') return prepareSparks(system, node, forces, meshSourceOf(system, nodes, geometries, systemIndex, sea, follow));
    const templates = templateNodeIds(system).map(nodeId => templateOf(system, nodes.get(nodeId), recipe, geometries));
    checkOpacityFade(system, node, recipe, systemIndex);
    return prepareEmitter(withPresetFade(system, node, recipe), node, templates, forces, collisionSurfaceOf(system, nodes, geometries), meshSourceOf(system, nodes, geometries, systemIndex, sea, follow));
  });
  return Object.freeze({
    /** Warnings for a recipe that loads but does not do what its author likely meant. */
    diagnostics() {
      return nodeTransformProblems(particles, recipe);
    },
    /** `camera` is `{ eye, up }` at `time`: a billboard system turns each card toward its eye. */
    sample(time, camera) {
      return new Map(prepared.map(({ node, build }) => [node.id, worldToNodeLocal(build(time, camera), nodeMatrix(node))]));
    },
    /** Counts, vertices drawn and, for emitters, when each system peaks and ends: numbers an agent can read without a picture. */
    report() {
      return { gravity: [...forces.gravity], wind: [...forces.wind], fields: forces.fields.map(field => ({ ...field })), vertices: totalVertices, systems: prepared.map(entry => entry.report()) };
    },
  });
}
