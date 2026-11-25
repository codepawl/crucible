import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { loadAgentSceneModules } from '../src/agent-scene-modules.js';
import { fibonacciDirection, hitsFrontFace, partMatrixLookup, worldTriangles } from '../src/closed-room.js';
import { MAXIMUM_JOINED_BOX_NODES, roomJoinedBoxNodeIds } from '../src/room-box-joins.js';

const HALF_WIDTH = 4;
const HEIGHT = 3;
const HALF_DEPTH = 3;
const THICKNESS = 0.2;
const ESCAPE_DIRECTIONS = 600;
// Distance of a probe origin from the interior edge it sits on, along both wall normals.
const EDGE_INSET = 0.002;

async function sceneOf(recipe) {
  await loadAgentSceneModules(recipe);
  return createAgentScene(recipe);
}

// A rounded box has no vertex at a corner of its unit cube; a sharp one does (the light bake may add more vertices, never remove the corners).
function hasSharpCorners(part) {
  const { positions } = part.geometry;
  for (let index = 0; index < positions.length; index += 3) {
    if ([0, 1, 2].every(axis => Math.abs(Math.abs(positions[index + axis]) - 0.5) < 1e-6)) return true;
  }
  return false;
}

function boxNode(id, translation, scale) {
  return { id, geometry: 'block', material: 'plaster', translation, scale };
}

// Six boxes that touch along their edges: the closed room of #2298, with the default box bevel unless one is given.
function sixBoxRoom({ bevel, lamp = false } = {}) {
  const width = 2 * HALF_WIDTH + 2 * THICKNESS;
  const depth = 2 * HALF_DEPTH + 2 * THICKNESS;
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', ...(bevel === undefined ? {} : { bevel }) }],
    materials: [{ id: 'plaster', color: [0.75, 0.72, 0.66], roughness: 0.9 }],
    nodes: [
      boxNode('floor', [0, -THICKNESS / 2, 0], [width, THICKNESS, depth]),
      boxNode('ceiling', [0, HEIGHT + THICKNESS / 2, 0], [width, THICKNESS, depth]),
      boxNode('left', [-HALF_WIDTH - THICKNESS / 2, HEIGHT / 2, 0], [THICKNESS, HEIGHT, depth]),
      boxNode('right', [HALF_WIDTH + THICKNESS / 2, HEIGHT / 2, 0], [THICKNESS, HEIGHT, depth]),
      boxNode('back', [0, HEIGHT / 2, HALF_DEPTH + THICKNESS / 2], [2 * HALF_WIDTH, HEIGHT, THICKNESS]),
      boxNode('front', [0, HEIGHT / 2, -HALF_DEPTH - THICKNESS / 2], [2 * HALF_WIDTH, HEIGHT, THICKNESS]),
    ],
    environment: {
      sky: { type: 'physical', sunElevation: 33, sunRotation: 20 },
      ...(lamp ? { keyIntensity: 0, pointLights: [{ position: [0, 2.6, 0], color: [1, 0.85, 0.6], intensity: 30 }] } : {}),
    },
  };
}

// Origins just inside the room along each of its twelve interior edges: where a groove between two walls opens into the room.
function interiorEdgeOrigins() {
  const origins = [];
  const samples = 5;
  const insetX = HALF_WIDTH - EDGE_INSET;
  const insetZ = HALF_DEPTH - EDGE_INSET;
  const insetTop = HEIGHT - EDGE_INSET;
  for (let step = 0; step < samples; step++) {
    const fraction = step / (samples - 1);
    for (const signA of [-1, 1]) {
      for (const signB of [-1, 1]) {
        origins.push([(fraction * 2 - 1) * insetX, EDGE_INSET + (signA > 0 ? insetTop - EDGE_INSET : 0), signB * insetZ]);
        origins.push([signA * insetX, EDGE_INSET + fraction * (insetTop - EDGE_INSET), signB * insetZ]);
        origins.push([signA * insetX, EDGE_INSET + (signB > 0 ? insetTop - EDGE_INSET : 0), (fraction * 2 - 1) * insetZ]);
      }
    }
  }
  return origins;
}

// How many rays from the interior edges reach the outside without hitting the inner face of a wall: light that shines through a groove.
function escapedRayCount(parts) {
  const triangles = worldTriangles(parts, partMatrixLookup(parts));
  const direction = [0, 0, 0];
  let escaped = 0;
  for (const origin of interiorEdgeOrigins()) {
    for (let ray = 0; ray < ESCAPE_DIRECTIONS; ray++) {
      fibonacciDirection(ray, ESCAPE_DIRECTIONS, direction);
      let blocked = false;
      for (let triangle = 0; triangle < triangles.triangleCount && !blocked; triangle++) {
        blocked = hitsFrontFace(triangles.corners, triangle * 9, origin, direction);
      }
      if (!blocked) escaped++;
    }
  }
  return escaped;
}

test('a sealed six-box room at the default bevel lets no sun or sky ray in along its edges', async () => {
  assert.equal(escapedRayCount((await sceneOf(sixBoxRoom())).parts), 0);
});

test('a lamp-lit six-box room at the default bevel has no groove for the sky to shine through at its corners', async () => {
  assert.equal(escapedRayCount((await sceneOf(sixBoxRoom({ lamp: true }))).parts), 0);
});

test('a room with an explicit bevel is drawn sharp at its joins too, and a bevel of zero stays sharp', async () => {
  assert.ok((await sceneOf(sixBoxRoom({ bevel: 0.03 }))).parts.every(hasSharpCorners));
  const sharpRoom = await sceneOf(sixBoxRoom({ bevel: 0 }));
  assert.ok(sharpRoom.parts.every(hasSharpCorners));
});

test('boxes outside a room keep their rounded edges', async () => {
  const props = {
    ...sixBoxRoom(),
    nodes: [boxNode('table', [0, 0.5, 0], [2, 0.1, 1]), boxNode('leg', [0.8, 0.2, 0], [0.1, 0.4, 0.1]), boxNode('far', [9, 0, 0], [1, 1, 1])],
  };
  const parts = (await sceneOf(props)).parts;
  for (const part of parts) assert.ok(!hasSharpCorners(part), `${part.name} lost its bevel`);
});

test('only the nodes that touch another box lose their bevel in a room with a prop', async () => {
  const recipe = sixBoxRoom();
  recipe.nodes.push(boxNode('crate', [0, 1, 0], [0.4, 0.4, 0.4]));
  const parts = Object.fromEntries((await sceneOf(recipe)).parts.map(part => [part.name, part]));
  assert.ok(hasSharpCorners(parts.floor), 'a wall that meets another keeps no bevel');
  assert.ok(!hasSharpCorners(parts.crate), 'a prop that touches nothing keeps its rounded edges');
});

test('roomJoinedBoxNodeIds needs four touching pairs, skips rotated and parented nodes and bevel-free boxes', () => {
  const room = sixBoxRoom();
  assert.equal(roomJoinedBoxNodeIds(room).size, 6);
  assert.equal(roomJoinedBoxNodeIds({ ...room, nodes: room.nodes.slice(0, 2) }).size, 0);
  assert.equal(roomJoinedBoxNodeIds(sixBoxRoom({ bevel: 0 })).size, 0);
  const tilted = { ...room, nodes: room.nodes.map(node => ({ ...node, rotation: [0.2588, 0, 0, 0.9659] })) };
  assert.equal(roomJoinedBoxNodeIds(tilted).size, 0);
  const parented = { ...room, nodes: room.nodes.map(node => ({ ...node, parent: 'root' })) };
  assert.equal(roomJoinedBoxNodeIds(parented).size, 0);
  assert.equal(roomJoinedBoxNodeIds({ geometries: [{ id: 'block', type: 'sphere' }], nodes: room.nodes }).size, 0);
});

test('a scene with more rounded boxes than the limit keeps them all rounded',  () => {
  const room = sixBoxRoom();
  const crowd = Array.from({ length: MAXIMUM_JOINED_BOX_NODES }, (_, index) => boxNode(`filler-${index}`, [100 + index * 3, 0, 0], [1, 1, 1]));
  assert.equal(roomJoinedBoxNodeIds({ ...room, nodes: [...room.nodes, ...crowd] }).size, 0);
});

test('a floor with many boxes standing on it is not a room, and neither is a set missing its ceiling and a wall', () => {
  const room = sixBoxRoom();
  const terrain = boxNode('terrain', [0, 2, 0], [100, 4, 100]);
  const trees = Array.from({ length: 10 }, (_, index) => boxNode(`tree-${index}`, [index * 4 - 18, 3.9 + 1, 0], [0.5, 2, 0.5]));
  assert.equal(roomJoinedBoxNodeIds({ ...room, nodes: [terrain, ...trees] }).size, 0);
  const fourSides = { ...room, nodes: room.nodes.filter(node => node.id !== 'ceiling' && node.id !== 'front') };
  assert.equal(roomJoinedBoxNodeIds(fourSides).size, 0);
});

// #3433: a set open on one side (floor, three walls and a ceiling) leaves the same groove at its joins; the five-box set of that issue.
function openFiveBoxSet({ bevel } = {}) {
  const recipe = sixBoxRoom({ bevel });
  recipe.nodes = recipe.nodes.filter(node => node.id !== 'front');
  return recipe;
}

test('a set open on one side is drawn with sharp edges at its joins, vertex for vertex like the same set at bevel 0', async () => {
  const recipe = openFiveBoxSet();
  assert.equal(roomJoinedBoxNodeIds(recipe).size, 5);
  const rounded = await sceneOf(recipe);
  assert.ok(rounded.parts.every(hasSharpCorners));
  const sharp = await sceneOf(openFiveBoxSet({ bevel: 0 }));
  for (const part of rounded.parts) {
    const sharpPart = sharp.parts.find(candidate => candidate.name === part.name);
    assert.deepEqual(Array.from(part.geometry.positions), Array.from(sharpPart.geometry.positions), `${part.name} has the geometry of a bevel 0 box`);
  }
});

// Furniture is thin boxes that touch too, and none of it is a room: legs and posts span no face, and a bookcase is too small to stand in.
test('a table, a pergola and a bookcase keep their rounded boxes', () => {
  const table = [boxNode('top', [0, 0.75, 0], [1.6, 0.05, 0.9]), ...[[-0.75, -0.4], [0.75, -0.4], [-0.75, 0.4], [0.75, 0.4]].map(([x, z], index) => boxNode(`leg-${index}`, [x, 0.36, z], [0.1, 0.72, 0.1]))];
  const pergola = [boxNode('floor', [0, -0.05, 0], [6, 0.1, 6]), ...[[-2.9, -2.9], [2.9, -2.9], [-2.9, 2.9], [2.9, 2.9]].map(([x, z], index) => boxNode(`post-${index}`, [x, 1.25, z], [0.1, 2.5, 0.1]))];
  const bookcase = [
    boxNode('side-left', [-0.45, 0.9, 0], [0.03, 1.8, 0.3]), boxNode('side-right', [0.45, 0.9, 0], [0.03, 1.8, 0.3]),
    boxNode('top', [0, 1.815, 0], [0.93, 0.03, 0.3]), boxNode('bottom', [0, 0.015, 0], [0.93, 0.03, 0.3]), boxNode('back', [0, 0.9, -0.15], [0.93, 1.8, 0.02]),
  ];
  for (const [name, nodes] of [['table', table], ['pergola', pergola], ['bookcase', bookcase]]) {
    assert.equal(roomJoinedBoxNodeIds({ ...sixBoxRoom(), nodes }).size, 0, `the ${name} is not a room`);
  }
});

test('boxes that touch in fewer than four pairs keep the default box geometry, byte for byte', async () => {
  const recipe = sixBoxRoom();
  recipe.nodes = [boxNode('floor', [0, 0, 0], [8, 0.2, 6]), boxNode('stool', [0, 0.6, 0], [0.5, 1, 0.5]), boxNode('crate', [3, 0.6, 2], [1, 1, 1])];
  assert.equal(roomJoinedBoxNodeIds(recipe).size, 0);
  const { parts } = await sceneOf(recipe);
  assert.ok(parts.every(part => !hasSharpCorners(part)));
  const aloneRecipe = { ...recipe, nodes: [boxNode('crate', [3, 0.6, 2], [1, 1, 1])] };
  const crateAlone = (await sceneOf(aloneRecipe)).parts[0];
  assert.deepEqual(Array.from(parts.find(part => part.name === 'crate').geometry.positions), Array.from(crateAlone.geometry.positions));
});
