import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { closedRoom, freezeBakeClockForFile, lightmapBytes } from './support/agent-bake-rooms.mjs';

freezeBakeClockForFile();

// #2754: the light bake kept one lightmap texel for both faces of a two-sided part, so an opaque lampshade around a point
// light showed the light that falls on its inside on its outside too. Each face now bakes on its own.

const LAMP_POSITION = [0.9, 2.5, 0.6];
const SHADE_BASE = [LAMP_POSITION[0], LAMP_POSITION[1] - 0.15, LAMP_POSITION[2]];

function roomWithShade(doubleSided, baked = true) {
  const recipe = closedRoom();
  if (!baked) delete recipe.bake;
  recipe.environment.pointLights = [{ position: LAMP_POSITION, intensity: 14, radius: 0.05 }];
  recipe.nodes = recipe.nodes.filter(node => node.id !== 'bulb');
  recipe.geometries.push({ id: 'shade', type: 'lathe', profile: [[0.28, 0], [0.13, 0.3]], segments: 16 });
  recipe.materials.push({ id: 'shadeMaterial', color: [0.8, 0.8, 0.8], roughness: 0.9, doubleSided });
  recipe.nodes.push({ id: 'shade', geometry: 'shade', material: 'shadeMaterial', translation: SHADE_BASE });
  return recipe;
}

function shadePart(recipe) {
  return createAgentScene(recipe).parts.find(candidate => candidate.name === 'shade');
}

/** The lightmap value (0 to 255) at the centre of a triangle, read through the part's own UVs. */
function lightmapValueAt(part, bytes, triangle) {
  const { width, height } = part.material.emissiveMap.image;
  const channelsPerPixel = bytes.length / (width * height);
  let u = 0;
  let v = 0;
  for (let corner = 0; corner < 3; corner++) {
    const vertex = part.geometry.indices[triangle * 3 + corner];
    u += part.geometry.uvs[vertex * 2] / 3;
    v += part.geometry.uvs[vertex * 2 + 1] / 3;
  }
  const column = Math.min(Math.floor(u * width), width - 1);
  const row = Math.min(Math.floor(v * height), height - 1);
  return bytes[(row * width + column) * channelsPerPixel];
}

/** Mean lightmap value of the faces a viewer can see that look toward the lamp, and of those that look away from it. */
function shadeFaceLuminance(recipe) {
  const part = shadePart(recipe);
  const bytes = lightmapBytes(part);
  const { positions, normals, indices } = part.geometry;
  const sums = { towardLamp: 0, awayFromLamp: 0 };
  const counts = { towardLamp: 0, awayFromLamp: 0 };
  for (let triangle = 0; triangle < indices.length / 3; triangle++) {
    const firstVertex = indices[triangle * 3];
    let facing = 0;
    for (let axis = 0; axis < 3; axis++) {
      const lampDirection = LAMP_POSITION[axis] - (positions[firstVertex * 3 + axis] + SHADE_BASE[axis]);
      facing += normals[firstVertex * 3 + axis] * lampDirection;
    }
    const value = lightmapValueAt(part, bytes, triangle);
    const visibleSides = part.material.doubleSided ? [facing, -facing] : [facing];
    for (const sideFacing of visibleSides) {
      const side = sideFacing > 0 ? 'towardLamp' : 'awayFromLamp';
      sums[side] += value;
      counts[side]++;
    }
  }
  return { towardLamp: sums.towardLamp / counts.towardLamp, awayFromLamp: sums.awayFromLamp / counts.awayFromLamp };
}

test('an opaque two-sided shade bakes a lit inside and an outside that only the room lights', () => {
  const { towardLamp, awayFromLamp } = shadeFaceLuminance(roomWithShade(true));
  assert.ok(towardLamp > 100, `the face toward the lamp is lit (${towardLamp})`);
  assert.ok(awayFromLamp < towardLamp * 0.3, `the face away from the lamp is not lit by the lamp it hides: ${awayFromLamp} against ${towardLamp}`);
});

test('a two-sided part bakes into a front and a back triangle per face and is no longer drawn two-sided', () => {
  const source = shadePart(roomWithShade(true, false));
  const baked = shadePart(roomWithShade(true));
  assert.equal(source.material.doubleSided, true);
  assert.equal(baked.material.doubleSided, false);
  assert.equal(baked.geometry.indices.length, source.geometry.indices.length * 2);
});

test('a one-sided part keeps its triangles and its single face', () => {
  const source = shadePart(roomWithShade(false, false));
  const baked = shadePart(roomWithShade(false));
  assert.equal(baked.material.doubleSided, false);
  assert.equal(baked.geometry.indices.length, source.geometry.indices.length);
});
