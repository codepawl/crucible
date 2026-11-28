import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeNodePorts, normalizeRelations, solveRelations } from '../src/agent-relations.js';

function approx(actual, expected, tolerance = 1e-4, label = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);
}

function rotateVectorByQuat(vector, quaternion) {
  const [vx, vy, vz] = vector;
  const [qx, qy, qz, qw] = quaternion;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

test('connect relation aligns opposing port normals, handles offset and roll, and avoids 180-degree flip', () => {
  const scene = createAgentScene({
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box' }],
    materials: [{ id: 'steel', color: [0.6, 0.65, 0.7] }],
    nodes: [
      {
        id: 'manifold',
        geometry: 'cube',
        material: 'steel',
        translation: [2, 1, -1],
        ports: {
          outlet: { position: [0.5, 0, 0], normal: [1, 0, 0], up: [0, 1, 0], category: 'flange' },
        },
      },
      {
        id: 'pipe',
        geometry: 'cube',
        material: 'steel',
        ports: {
          inlet: { position: [0, -0.5, 0], normal: [0, -1, 0], up: [0, 0, 1], category: 'flange' },
        },
        relations: [{ kind: 'connect', to: 'manifold', fromPort: 'inlet', toPort: 'outlet', offset: 0.05, roll: 90 }],
      },
    ],
  });

  const exported = scene.exportRecipe();
  const pipe = exported.nodes.find(node => node.id === 'pipe');
  const worldNormal = rotateVectorByQuat([0, -1, 0], pipe.rotation);
  // Mated normal must point opposite manifold outlet (+X -> -X).
  approx(worldNormal[0], -1, 1e-4, 'worldNormal.x');
  approx(worldNormal[1], 0, 1e-4, 'worldNormal.y');
  approx(worldNormal[2], 0, 1e-4, 'worldNormal.z');

  const rotatedOffset = rotateVectorByQuat([0, -0.5, 0], pipe.rotation);
  const worldPortPos = [
    pipe.translation[0] + rotatedOffset[0],
    pipe.translation[1] + rotatedOffset[1],
    pipe.translation[2] + rotatedOffset[2],
  ];
  // manifold outlet at [2.55, 1, -1].
  approx(worldPortPos[0], 2.55, 1e-4, 'worldPortPos.x');
  approx(worldPortPos[1], 1.0, 1e-4, 'worldPortPos.y');
  approx(worldPortPos[2], -1.0, 1e-4, 'worldPortPos.z');
});

test('connect relation works on group nodes under rotated parents and chains A -> B -> C', () => {
  const halfTurnY = [0, 0.7071068, 0, 0.7071068];
  const nodes = normalizeNodePorts([
    {
      id: 'parentRig',
      parent: null,
      translation: [1, 0, 0],
      rotation: halfTurnY,
      scale: [1, 1, 1],
    },
    {
      id: 'anchor',
      parent: 'parentRig',
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      ports: { out: { position: [0, 0, 1], normal: [0, 0, 1] } },
    },
    {
      id: 'segmentOne',
      parent: null,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      ports: {
        in: { position: [0, 0, -0.5], normal: [0, 0, -1] },
        out: { position: [0, 0, 0.5], normal: [0, 0, 1] },
      },
      relations: [{ kind: 'connect', to: 'anchor', fromPort: 'in', toPort: 'out' }],
    },
    {
      id: 'segmentTwo',
      parent: null,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      ports: { in: { position: [0, 0, -0.5], normal: [0, 0, -1] } },
      relations: [{ kind: 'connect', to: 'segmentOne', fromPort: 'in', toPort: 'out' }],
    },
  ]);

  const normalized = normalizeRelations(nodes);
  const solved = solveRelations(normalized, () => ({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }));
  const seg1 = solved.find(node => node.id === 'segmentOne');
  const seg2 = solved.find(node => node.id === 'segmentTwo');
  // anchor out in world space is along +X at [2, 0, 0] after +90 deg Y parent rotation.
  approx(seg1.translation[0], 2.5, 1e-4, 'seg1.x');
  approx(seg1.translation[2], 0, 1e-4, 'seg1.z');
  approx(seg2.translation[0], 3.5, 1e-4, 'seg2.x');
  approx(seg2.translation[2], 0, 1e-4, 'seg2.z');
});

test('normalizeRelations rejects port category mismatch, missing ports, and supports >256 related nodes fast', () => {
  assert.throws(() => normalizeRelations([
    { id: 'a', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null, ports: { out: { position: [0, 0, 0], normal: [1, 0, 0], category: 'power' } } },
    { id: 'b', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null, ports: { in: { position: [0, 0, 0], normal: [-1, 0, 0], category: 'water' } }, relations: [{ kind: 'connect', to: 'a', fromPort: 'in', toPort: 'out' }] },
  ]), /compatible port category/);

  assert.throws(() => normalizeRelations([
    { id: 'a', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null, ports: { out: { position: [0, 0, 0], normal: [1, 0, 0] } } },
    { id: 'b', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null, ports: { in: { position: [0, 0, 0], normal: [-1, 0, 0] } }, relations: [{ kind: 'connect', to: 'a', fromPort: 'missing', toPort: 'out' }] },
  ]), /available: in/);

  const count = 400;
  const chain = [{
    id: 'n-0', parent: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    ports: { out: { position: [0.5, 0, 0], normal: [1, 0, 0] } },
  }];
  for (let index = 1; index < count; index++) {
    chain.push({
      id: `n-${index}`,
      parent: null,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      ports: {
        in: { position: [-0.5, 0, 0], normal: [-1, 0, 0] },
        out: { position: [0.5, 0, 0], normal: [1, 0, 0] },
      },
      relations: [{ kind: 'connect', to: `n-${index - 1}`, fromPort: 'in', toPort: 'out' }],
    });
  }
  const solved = solveRelations(normalizeRelations(chain), () => ({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] }));
  approx(solved[count - 1].translation[0], count - 1, 1e-3, 'chain tail x');
});
