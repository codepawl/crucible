import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportGlb } from '../src/export.js';
import { fromThreeObject, toThreeObject } from '../src/three-bridge.js';

const TOLERANCE = 1e-6;

function checkerTexture() {
  const data = new Uint8Array(4 * 4 * 4).fill(200);
  const texture = new THREE.Texture({ data, width: 4, height: 4 });
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  return texture;
}

function buildSourceGroup() {
  const group = new THREE.Group();
  group.name = 'source';
  group.position.set(1, 2, 3);
  group.rotation.set(0.1, 0.2, 0.3);

  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3), new THREE.MeshStandardMaterial({ color: 0x2f9e6b, roughness: 0.4, metalness: 0.6 }));
  box.name = 'box';
  box.position.set(-2, 0, 0);

  const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshPhysicalMaterial({
    color: 0xffaa33, roughness: 0.2, transmission: 0.7, ior: 1.3, thickness: 0.5, clearcoat: 0.4,
    emissive: 0x112233, emissiveIntensity: 2, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
  }));
  sphere.name = 'sphere';
  sphere.scale.set(1, 2, 0.5);
  sphere.position.set(2, 0, 1);

  const textured = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial({ map: checkerTexture(), normalMap: checkerTexture(), normalScale: new THREE.Vector2(0.5, 0.5) }));
  textured.name = 'textured';
  textured.rotation.x = -Math.PI / 2;

  const vertexColored = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ vertexColors: true }));
  vertexColored.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(24 * 3).fill(0.25), 3));
  vertexColored.name = 'colored';
  vertexColored.position.y = 3;

  group.add(box, sphere, textured, vertexColored);
  return group;
}

function maxDifference(left, right) {
  assert.equal(left.length, right.length);
  let largest = 0;
  for (let index = 0; index < left.length; index += 1) largest = Math.max(largest, Math.abs(left[index] - right[index]));
  return largest;
}

test('the addon has no import statement and keeps three.js as a peer dependency only', async () => {
  const source = await readFile(new URL('../src/three-bridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  const core = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(core.exports['./addons/three-bridge'], './build/three-bridge.js');
  assert.ok(core.peerDependencies.three);
  assert.equal(core.peerDependenciesMeta?.three?.optional, true);
  assert.equal(core.dependencies?.three, undefined, 'the core takes no three.js runtime dependency');
});

test('a group is imported with vertex counts, index counts and world matrices', () => {
  const group = buildSourceGroup();
  const { parts, warnings } = fromThreeObject(group);
  assert.deepEqual(parts.map(part => part.name), ['box', 'sphere', 'textured', 'colored']);
  const expectedGeometries = [group.children[0], group.children[1], group.children[2], group.children[3]].map(mesh => mesh.geometry);
  parts.forEach((part, index) => {
    const geometry = expectedGeometries[index];
    assert.equal(part.geometry.positions.length / 3, geometry.attributes.position.count, `${part.name} vertices`);
    assert.equal(part.geometry.indices.length, geometry.index.count, `${part.name} indices`);
    assert.ok(maxDifference(part.matrix, group.children[index].matrixWorld.elements) < TOLERANCE, `${part.name} matrix`);
  });
  assert.equal(parts[2].geometry.uvs.length, 4 * 2);
  assert.equal(parts[3].geometry.colors.length, 24 * 3);
  assert.equal(parts[0].geometry.colors, undefined, 'colours import only when material.vertexColors is on');
  assert.deepEqual(warnings, [], 'a supported tree gives no warnings');
});

test('a mesh without a material throws a ThreeBridgeError that names the mesh, and skipUnsupported leaves it out', () => {
  for (const missing of [undefined, null]) {
    const bare = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    bare.name = 'bare';
    bare.material = missing;
    assert.throws(() => fromThreeObject(new THREE.Group().add(bare)), error => error.name === 'ThreeBridgeError' && /"bare".*material.*Assign a MeshStandardMaterial to mesh.material/.test(error.message));
    const { parts, warnings } = fromThreeObject(new THREE.Group().add(bare), { skipUnsupported: true });
    assert.equal(parts.length, 0);
    assert.match(warnings[0], /"bare".*(skipped)/);
  }
  const holes = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [new THREE.MeshStandardMaterial(), null]);
  holes.name = 'holes';
  holes.geometry.addGroup(0, 6, 1);
  assert.throws(() => fromThreeObject(holes), error => error.name === 'ThreeBridgeError' && /"holes".*materialIndex 1/.test(error.message));
});

test('material fields map to the Crucible material', () => {
  const { parts } = fromThreeObject(buildSourceGroup());
  const [box, sphere, textured] = parts.map(part => part.material);
  assert.ok(maxDifference(box.color, new THREE.Color(0x2f9e6b).toArray()) < TOLERANCE);
  assert.equal(box.roughness, 0.4);
  assert.equal(box.metallic, 0.6);
  assert.equal(sphere.transmission, 0.7);
  assert.equal(sphere.ior, 1.3);
  assert.equal(sphere.thickness, 0.5);
  assert.equal(sphere.clearcoat, 0.4);
  assert.equal(sphere.emission, 2);
  assert.equal(sphere.alphaMode, 'blend');
  assert.equal(sphere.opacity, 0.8);
  assert.equal(sphere.doubleSided, true);
  assert.equal(textured.map.colorSpace, 'srgb');
  assert.equal(textured.map.wrapS, 33071);
  assert.equal(textured.normalMap.colorSpace, 'linear');
  assert.equal(textured.normalScale, 0.5);
  assert.equal(box.map, undefined);
});

test('import is deterministic', () => {
  assert.deepEqual(fromThreeObject(buildSourceGroup()), fromThreeObject(buildSourceGroup()));
});

test('a round trip keeps positions, normals, indices, matrices and material fields', () => {
  const group = buildSourceGroup();
  const { parts } = fromThreeObject(group);
  const { object, warnings } = toThreeObject(parts, THREE);
  assert.deepEqual(warnings, []);
  assert.equal(object.children.length, parts.length);
  object.children.forEach((mesh, index) => {
    const source = group.children[index];
    assert.equal(mesh.name, source.name);
    assert.equal(maxDifference(mesh.geometry.attributes.position.array, source.geometry.attributes.position.array), 0);
    assert.equal(maxDifference(mesh.geometry.attributes.normal.array, source.geometry.attributes.normal.array), 0);
    assert.deepEqual(Array.from(mesh.geometry.index.array), Array.from(source.geometry.index.array));
    assert.ok(maxDifference(mesh.matrixWorld.elements, source.matrixWorld.elements) < TOLERANCE, `${mesh.name} world matrix`);
    assert.ok(mesh.material.isMeshStandardMaterial);
    for (const field of ['roughness', 'metalness', 'opacity', 'transparent', 'side', 'emissiveIntensity']) {
      assert.equal(mesh.material[field], source.material[field], `${mesh.name} ${field}`);
    }
    assert.ok(maxDifference(mesh.material.color.toArray(), source.material.color.toArray()) < TOLERANCE);
    assert.ok(maxDifference(mesh.material.emissive.toArray(), source.material.emissive.toArray()) < TOLERANCE);
  });
  const sphere = object.children[1].material;
  assert.ok(sphere.isMeshPhysicalMaterial);
  assert.deepEqual([sphere.transmission, sphere.ior, sphere.thickness, sphere.clearcoat], [0.7, 1.3, 0.5, 0.4]);
  const textured = object.children[2].material;
  assert.equal(textured.map.image, group.children[2].material.map.image);
  assert.equal(textured.map.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(textured.map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(textured.normalScale.x, 0.5);
  const again = fromThreeObject(object).parts;
  assert.deepEqual(again.map(part => Array.from(part.geometry.indices)), parts.map(part => Array.from(part.geometry.indices)));
  again.forEach((part, index) => assert.equal(maxDifference(part.geometry.positions, parts[index].geometry.positions), 0));
});

test('exportGlb of the bridged parts loads in GLTFLoader with matching transforms and counts', async () => {
  const group = buildSourceGroup();
  group.remove(group.children[2]);
  const { parts } = fromThreeObject(group);
  const gltf = await new GLTFLoader().parseAsync(exportGlb(parts), '');
  gltf.scene.updateMatrixWorld(true);
  const loaded = [];
  gltf.scene.traverse(node => { if (node.isMesh) loaded.push(node); });
  assert.equal(loaded.length, parts.length);
  loaded.forEach((mesh, index) => {
    const source = group.children[index];
    assert.equal(mesh.name, source.name);
    assert.equal(mesh.geometry.attributes.position.count, source.geometry.attributes.position.count);
    assert.equal(mesh.geometry.index.count, source.geometry.index.count);
    assert.ok(maxDifference(mesh.matrixWorld.elements, source.matrixWorld.elements) < TOLERANCE, `${mesh.name} node transform`);
  });
});

test('an InstancedMesh becomes one part per instance that all share one geometry', () => {
  const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 3);
  instanced.name = 'crate';
  for (let index = 0; index < 3; index += 1) {
    instanced.setMatrixAt(index, new THREE.Matrix4().makeTranslation(index * 2, 0, 0));
  }
  instanced.position.y = 1;
  const { parts } = fromThreeObject(instanced);
  assert.deepEqual(parts.map(part => part.name), ['crate', 'crate-1', 'crate-2']);
  assert.equal(new Set(parts.map(part => part.geometry)).size, 1);
  assert.deepEqual(parts.map(part => part.matrix[12]), [0, 2, 4]);
  assert.equal(parts[0].matrix[13], 1);
});

test('a non-indexed mesh without normals gets indices and computed normals, with a warning', () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  const { parts, warnings } = fromThreeObject(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
  assert.deepEqual(Array.from(parts[0].geometry.indices), [0, 1, 2]);
  assert.deepEqual(Array.from(parts[0].geometry.normals.slice(0, 3)), [0, 0, 1]);
  assert.match(warnings.join('\n'), /no normal attribute/);
  assert.doesNotThrow(() => exportGlb(parts));
});

test('a material array is split by geometry group', () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const materials = [new THREE.MeshStandardMaterial({ color: 0xff0000 }), new THREE.MeshStandardMaterial({ color: 0x0000ff })];
  geometry.clearGroups();
  geometry.addGroup(0, 18, 0);
  geometry.addGroup(18, 18, 1);
  const { parts } = fromThreeObject(new THREE.Mesh(geometry, materials));
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(part => part.geometry.indices.length), [18, 18]);
  assert.notDeepEqual(parts[0].material.color, parts[1].material.color);
});

test('unsupported features are listed in warnings, never dropped silently', () => {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ envMap: new THREE.Texture(), wireframe: true, side: THREE.BackSide }));
  mesh.name = 'shiny';
  const basic = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  hidden.visible = false;
  const light = new THREE.PointLight();
  const points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial());
  group.add(mesh, basic, hidden, light, points);
  const { parts, warnings } = fromThreeObject(group);
  assert.equal(parts.length, 2);
  const text = warnings.join('\n');
  for (const expected of ['envMap is not imported', 'wireframe is not imported', 'BackSide', 'MeshBasicMaterial has no roughness', 'invisible', 'PointLight', 'Points']) {
    assert.match(text, new RegExp(expected), expected);
  }
});

test('a shader material and a skinned mesh without bones throw errors that name the object and the fix', () => {
  const shader = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.ShaderMaterial());
  shader.name = 'glow';
  assert.throws(() => fromThreeObject(shader), /Mesh "glow" material "ShaderMaterial" is a ShaderMaterial.*MeshStandardMaterial/);
  const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  skinned.name = 'hero';
  assert.throws(() => fromThreeObject(skinned), /SkinnedMesh "hero" is a SkinnedMesh without skeleton\.bones/);
  const skipped = fromThreeObject(new THREE.Group().add(shader, skinned), { skipUnsupported: true });
  assert.equal(skipped.parts.length, 0);
  assert.equal(skipped.warnings.length, 2);
});

test('limits are bounded and errors say what to pass', () => {
  const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 20);
  assert.throws(() => fromThreeObject(instanced, { maxParts: 10 }), /Raise maxParts/);
  assert.throws(() => fromThreeObject(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 16)), { maxVertices: 50 }), /above the limit of 50/);
  assert.throws(() => fromThreeObject(instanced, { maxParts: 1e9 }), /whole number from 1 to 100000/);
  assert.throws(() => fromThreeObject(instanced, { maxPart: 5 }), /Unknown option "maxPart"/);
  assert.throws(() => fromThreeObject({}), /needs a three\.js Object3D/);
  assert.throws(() => toThreeObject([], THREE), /nonempty array of Crucible parts/);
  assert.throws(() => toThreeObject([{ name: 'a' }], THREE), /parts\[0\] "a" needs geometry\.positions/);
  assert.throws(() => toThreeObject(fromThreeObject(buildSourceGroup()).parts, {}), /needs the three\.js namespace.*Group/);
  const { parts } = fromThreeObject(buildSourceGroup());
  assert.throws(() => toThreeObject(parts, THREE, { maxParts: 2 }), /4 parts is above the limit of 2/);
  assert.throws(() => toThreeObject([{ ...parts[0], matrix: [1] }], THREE), /matrix of 16 finite numbers/);
});

function trianglePart(geometryChanges) {
  const geometry = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    ...geometryChanges,
  };
  const matrix = new THREE.Matrix4().toArray();
  return { name: 'triangle', geometry, matrix, material: { color: [1, 1, 1], metallic: 0, roughness: 1 } };
}

test('toThreeObject refuses attribute arrays that do not match the vertex count and indices past the last vertex', () => {
  assert.ok(toThreeObject([trianglePart({})], THREE).object);
  assert.throws(() => toThreeObject([trianglePart({ normals: new Float32Array(6) })], THREE), /6 values in geometry\.normals.*3 vertices need 9/);
  assert.throws(() => toThreeObject([trianglePart({ uvs: new Float32Array(4) })], THREE), /4 values in geometry\.uvs.*3 vertices need 6/);
  assert.throws(() => toThreeObject([trianglePart({ colors: new Float32Array(12) })], THREE), /12 values in geometry\.colors.*3 vertices need 9/);
  assert.throws(() => toThreeObject([trianglePart({ indices: new Uint32Array([0, 1, 3]) })], THREE), /indices entry 3.*0 to 2/);
});

test('toThreeObject turns vertexColors on only for parts that carry colours, even when they share a material', () => {
  const sharedMaterial = { color: [1, 1, 1], metallic: 0, roughness: 1 };
  const colored = trianglePart({ colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) });
  const plain = trianglePart({});
  colored.material = sharedMaterial;
  plain.material = sharedMaterial;
  const { object } = toThreeObject([colored, plain, { ...colored }], THREE);
  const [coloredMesh, plainMesh, secondColoredMesh] = object.children;
  assert.equal(coloredMesh.material.vertexColors, true);
  assert.equal(plainMesh.material.vertexColors, false);
  assert.equal(secondColoredMesh.material, coloredMesh.material, 'parts with colours share one material');
  assert.ok(coloredMesh.geometry.attributes.color);
});

test('a vertex coloured box survives fromThreeObject then toThreeObject with vertexColors on', () => {
  const source = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ vertexColors: true }));
  source.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(24 * 3).fill(0.5), 3));
  const root = new THREE.Group();
  root.add(source);
  const { object } = toThreeObject(fromThreeObject(root).parts, THREE);
  assert.equal(object.children[0].material.vertexColors, true);
});

test('an InstancedMesh count above its matrix array is clamped with a warning, not NaN', () => {
  const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), 3);
  instanced.count = 5;
  const { parts, warnings } = fromThreeObject(instanced);
  assert.equal(parts.length, 3, 'one part per matrix in the array');
  for (const part of parts) assert.ok(part.matrix.every(Number.isFinite), 'every matrix is finite');
  assert.ok(warnings.some(warning => /count 5 is above the 3 matrices instanceMatrix holds/.test(warning)), 'the clamp is reported');
});
