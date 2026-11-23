import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { primitiveUvs } from '../src/agent-scene-assets.js';
import { box, cone, cylinder } from '../src/geometry.js';
import { exportGlb } from '../src/export.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

await loadAllAgentSceneModules();

const COLOR_IMAGE = 'a'.repeat(64);
const IMAGES = new Map([[COLOR_IMAGE, { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(200) }]]);

function uvsOf(definition, builtGeometry) {
  return primitiveUvs(definition, builtGeometry);
}

function assertWellFormed(definition, builtGeometry, label) {
  const uvs = uvsOf(definition, builtGeometry);
  assert.equal(uvs.length, builtGeometry.positions.length / 3 * 2, `${label}: one UV pair per vertex`);
  for (const value of uvs) {
    assert.ok(value >= -1e-6 && value <= 1 + 1e-6, `${label}: ${value} is within 0..1`);
  }
  return uvs;
}

test('box, cylinder and cone UVs match their vertex counts and stay within 0..1 across parameters', () => {
  const boxes = [{}, { bevel: 0 }, { bevel: 0.2, subdivisions: 3 }, { bevel: 0.05, subdivisions: 12 }];
  for (const parameters of boxes) {
    assertWellFormed({ type: 'box', ...parameters }, box(parameters.bevel, parameters.subdivisions), `box ${JSON.stringify(parameters)}`);
  }
  const cylinders = [{}, { bevel: 0 }, { segments: 12, bevel: 0.2, bevelSegments: 3 }, { segments: 5, bevelSegments: 1 }];
  for (const parameters of cylinders) {
    assertWellFormed({ type: 'cylinder', ...parameters }, cylinder(parameters.segments, parameters.bevel, parameters.bevelSegments), `cylinder ${JSON.stringify(parameters)}`);
  }
  const cones = [{}, { radiusTop: 0.5 }, { radiusTop: 0.3, radiusBottom: 1.2, segments: 9 }, { radiusTop: 1, radiusBottom: 0 }];
  for (const parameters of cones) {
    assertWellFormed({ type: 'cone', ...parameters }, cone(parameters.radiusTop, parameters.radiusBottom, parameters.segments), `cone ${JSON.stringify(parameters)}`);
  }
});

test('every box face fills the image, upright and not mirrored from outside', () => {
  const geometry = box(0);
  const uvs = uvsOf({ type: 'box', bevel: 0 }, geometry);
  const faceVertices = 4;
  const bevelled = box(0.1, 4);
  const bevelledUvs = uvsOf({ type: 'box', bevel: 0.1, subdivisions: 4 }, bevelled);
  for (const [vertices, coordinates, count] of [[geometry, uvs, faceVertices], [bevelled, bevelledUvs, bevelled.positions.length / 3 / 6]]) {
    for (let face = 0; face < 6; face++) {
      let minimumU = Infinity;
      let maximumU = -Infinity;
      let minimumV = Infinity;
      let maximumV = -Infinity;
      for (let vertex = face * count; vertex < (face + 1) * count; vertex++) {
        minimumU = Math.min(minimumU, coordinates[vertex * 2]);
        maximumU = Math.max(maximumU, coordinates[vertex * 2]);
        minimumV = Math.min(minimumV, coordinates[vertex * 2 + 1]);
        maximumV = Math.max(maximumV, coordinates[vertex * 2 + 1]);
      }
      assert.ok(vertices.positions.length > 0);
      assert.deepEqual([minimumU, maximumU, minimumV, maximumV].map(value => Math.round(value * 1e5) / 1e5), [0, 1, 0, 1], `face ${face} fills 0..1`);
    }
  }
  // Face 5 is +z: seen from +z, +x is right and +y is up, so the top right corner is u 1, v 0.
  const positions = geometry.positions;
  for (let vertex = 5 * faceVertices; vertex < 6 * faceVertices; vertex++) {
    const expected = [positions[vertex * 3] > 0 ? 1 : 0, positions[vertex * 3 + 1] > 0 ? 0 : 1];
    assert.deepEqual([uvs[vertex * 2], uvs[vertex * 2 + 1]], expected, `+z face vertex ${vertex}`);
  }
  // Face 1 is +x: seen from +x, -z is right.
  for (let vertex = 1 * faceVertices; vertex < 2 * faceVertices; vertex++) {
    const expected = [positions[vertex * 3 + 2] < 0 ? 1 : 0, positions[vertex * 3 + 1] > 0 ? 0 : 1];
    assert.deepEqual([uvs[vertex * 2], uvs[vertex * 2 + 1]], expected, `+x face vertex ${vertex}`);
  }
});

test('cylinder and cone caps are discs and walls wrap once with v 0 at the top', () => {
  const segments = 8;
  const tube = cylinder(segments, 0, 1);
  const tubeUvs = uvsOf({ type: 'cylinder', segments, bevel: 0, bevelSegments: 1 }, tube);
  const wallVertices = (segments + 1) * 4;
  const capVertices = segments + 2;
  const topCapCenter = wallVertices + capVertices;
  assert.deepEqual([tubeUvs[topCapCenter * 2], tubeUvs[topCapCenter * 2 + 1]], [0.5, 0.5]);
  assert.ok(Math.abs(tubeUvs[(topCapCenter + 1) * 2] - 1) < 1e-6, 'the top cap ring vertex at +x has u 1');
  assert.ok(Math.abs(tubeUvs[(topCapCenter + 1) * 2 + 1] - 0.5) < 1e-6);
  const topWallVertex = (segments + 1) * 3;
  assert.equal(tube.positions[topWallVertex * 3 + 1], 0.5);
  assert.equal(tubeUvs[topWallVertex * 2 + 1], 0);
  assert.equal(tubeUvs[0], 1);
  assert.equal(tubeUvs[segments * 2], 0);

  const pointed = cone(0, 1, segments);
  const pointedUvs = uvsOf({ type: 'cone', segments }, pointed);
  assert.equal(pointed.positions.length / 3, (segments + 1) * 2 + capVertices, 'a zero top radius has one cap');
  assert.deepEqual([pointedUvs[(segments + 1) * 2 * 2], pointedUvs[(segments + 1) * 2 * 2 + 1]], [0.5, 0.5]);
});

test('a layout that does not match the definition throws instead of writing wrong UVs', () => {
  assert.throws(() => primitiveUvs({ type: 'box', bevel: 0 }, box(0.08, 6)), /Cannot compute UVs for this box/);
  assert.throws(() => primitiveUvs({ type: 'cylinder', segments: 10 }, cylinder(12)), /Cannot compute UVs for this cylinder/);
  assert.throws(() => primitiveUvs({ type: 'cone', radiusTop: 0.5 }, cone(0, 1)), /Cannot compute UVs for this cone/);
});

function sceneWith({ geometries, nodes, material = { colorMap: COLOR_IMAGE } }) {
  return createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries,
    materials: [{ id: 'skin', ...material }, { id: 'plain' }],
    nodes,
    camera: { eye: [0, 3, 3], target: [0, 0, 0], fov: 45 },
  }, {}, { sequenceFrames: IMAGES });
}

const THREE_PRIMITIVES = [{ id: 'crate', type: 'box' }, { id: 'drum', type: 'cylinder' }, { id: 'spike', type: 'cone' }];
const THREE_NODES = materialId => THREE_PRIMITIVES.map(definition => ({ id: `${definition.id}-node`, geometry: definition.id, material: materialId }));

test('a colour map on a box, cylinder or cone gives its geometry UVs, and without the map there are none', () => {
  const textured = sceneWith({ geometries: THREE_PRIMITIVES, nodes: THREE_NODES('skin') });
  assert.equal(textured.parts.length, 3);
  for (const part of textured.parts) {
    assert.equal(part.geometry.uvs.length, part.geometry.positions.length / 3 * 2);
  }
  const untextured = sceneWith({ geometries: THREE_PRIMITIVES, nodes: THREE_NODES('plain') });
  for (const part of untextured.parts) {
    assert.equal(part.geometry.uvs, undefined);
  }
});

test('a map sequence gives a box UVs too', () => {
  const frames = [COLOR_IMAGE, COLOR_IMAGE];
  const scene = sceneWith({ geometries: [THREE_PRIMITIVES[0]], nodes: [THREE_NODES('skin')[0]], material: { map: { sequence: { frames, fps: 1 } } } });
  assert.equal(scene.parts[0].geometry.uvs.length, scene.parts[0].geometry.positions.length / 3 * 2);
});

test('one geometry shared by a textured and an untextured node carries UVs for both', () => {
  const scene = sceneWith({
    geometries: [THREE_PRIMITIVES[0]],
    nodes: [{ id: 'a', geometry: 'crate', material: 'skin' }, { id: 'b', geometry: 'crate', material: 'plain' }],
  });
  assert.equal(scene.parts.length, 2);
  assert.ok(scene.parts[0].geometry.uvs);
  assert.equal(scene.parts[0].geometry, scene.parts[1].geometry);
});

test('an edit that adds a colour map gives an existing box UVs, and replacing the material by one without a map drops them', () => {
  const scene = sceneWith({ geometries: [THREE_PRIMITIVES[0]], nodes: [THREE_NODES('skin')[0]], material: {} });
  assert.equal(scene.parts[0].geometry.uvs, undefined);
  scene.apply([{ type: 'set-material', id: 'skin', colorMap: COLOR_IMAGE }], { expectedRevision: scene.inspect().revision });
  assert.equal(scene.parts[0].geometry.uvs.length, scene.parts[0].geometry.positions.length / 3 * 2);
  scene.apply([{ type: 'remove-material', id: 'skin' }, { type: 'add-material', material: { id: 'skin' } }], { expectedRevision: scene.inspect().revision });
  assert.equal(scene.parts[0].geometry.uvs, undefined);
});

test('meshMap on a box still refuses, since a box has no UVs of its own', () => {
  const pattern = { type: 'graph', mapping: 'uv', resolution: 256, graph: { color: { mul: [[1, 1, 1], { meshMap: { name: 'curvature' } }] } } };
  assert.throws(() => sceneWith({
    geometries: [{ id: 'crate', type: 'box' }],
    nodes: [{ id: 'crate-node', geometry: 'crate', material: 'skin' }],
    material: { pattern },
  }), /meshMap.*a mesh with UVs/);
});

test('a textured box exports to GLB with TEXCOORD_0 and builds a path traced scene with its UVs', () => {
  const scene = sceneWith({ geometries: [THREE_PRIMITIVES[0]], nodes: [THREE_NODES('skin')[0]] });
  const binary = Buffer.from(exportGlb(scene.parts));
  const jsonLength = binary.readUInt32LE(12);
  const document = JSON.parse(binary.subarray(20, 20 + jsonLength).toString('utf8'));
  assert.ok(document.meshes[0].primitives[0].attributes.TEXCOORD_0 !== undefined);
  const traced = buildTraceScene(scene.parts, scene.environment);
  assert.ok(traced.uvs.some(value => value !== 0), 'the packed trace world carries the box UVs');
});

test('the UV table in docs/agent-scene.md matches what each geometry type builds', () => {
  const documentation = readFileSync(new URL('../docs/agent-scene.md', import.meta.url), 'utf8');
  const namesAfter = prefix => {
    const line = documentation.split('\n').find(candidate => candidate.startsWith(prefix));
    assert.ok(line, `docs/agent-scene.md has a "${prefix}" line`);
    return [...line.slice(prefix.length).split('. ')[0].matchAll(/`(\w+)`/g)].map(match => match[1]).sort();
  };
  const documented = {
    always: namesAfter('- UVs always: '),
    onDemand: namesAfter('- UVs when an image map is on them: '),
    none: namesAfter('- No UVs: ').filter(name => name !== 'uv_unwrap'),
  };
  const extras = {
    line: { from: [0, 0, 0], to: [0, 2, 0], radius: 0.05 },
    lathe: { profile: [[0.5, 0], [0.5, 1]] },
    extrude: { contour: [[0, 0], [4, 0], [4, 4], [0, 4]] },
    tube: { path: [[0, 0, 0], [1, 0, 0]] },
    curve: { shape: { type: 'star' }, radius: 0.02 },
    sdf: { root: { shape: 'sphere', radius: 1, position: [0, 0, 0] }, resolution: 16 },
    text: { text: 'A' },
    terrain: { size: 20, resolution: 16 },
    cloud: { seed: 1, puffs: 5, resolution: 16 },
    floorPlan: { part: 'floor', walls: [{ from: [0, 0], to: [4, 0] }, { from: [4, 0], to: [4, 3] }, { from: [4, 3], to: [0, 3] }, { from: [0, 3], to: [0, 0] }] },
    mesh: { base: { type: 'box', bevel: 0 } },
    fragment: { source: 'base', cells: 4, index: 0 },
    dented: { source: 'base', stiffness: 1000, maxDepth: 0.2, radius: 0.5, impacts: [{ point: [0, 0, 1], direction: [0, 0, -1], impulse: 100 }] },
  };
  const types = [...documented.always, ...documented.onDemand, ...documented.none];
  const measure = (type, material) => {
    const scene = sceneWith({
      geometries: [{ id: 'base', type: 'box' }, { id: 'subject', type, ...extras[type] }],
      nodes: [{ id: 'subject-node', geometry: 'subject', material }],
    });
    const geometry = scene.parts[0].geometry;
    return geometry.uvs?.length === geometry.positions.length / 3 * 2;
  };
  const measured = { always: [], onDemand: [], none: [] };
  for (const type of types) {
    const plain = measure(type, 'plain');
    const textured = measure(type, 'skin');
    if (plain && textured) measured.always.push(type);
    else if (!plain && textured) measured.onDemand.push(type);
    else if (!plain && !textured) measured.none.push(type);
    else assert.fail(`${type} has UVs only without a map`);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(measured).map(([key, names]) => [key, names.sort()])), documented);
  const accepted = [...types].sort();
  const capabilities = readFileSync(new URL('../src/agent-scene-capabilities.js', import.meta.url), 'utf8').match(/geometryTypes: Object\.freeze\(\[(.*?)\]\)/)[1];
  assert.deepEqual([...capabilities.matchAll(/'(\w+)'/g)].map(match => match[1]).sort(), accepted, 'the doc table covers every geometry type the recipe accepts');
});
