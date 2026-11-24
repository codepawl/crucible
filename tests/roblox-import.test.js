import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentScene, loadAgentSceneModules } from '../src/agent-scene.js';
import { box } from '../src/geometry.js';
import { exportGlb } from '../src/export.js';
import { importRoblox, RobloxImportError, STUD_METERS, CANDELA_PER_BRIGHTNESS, matrixToQuaternion, robloxAssetKey } from '../packages/roblox-import/index.mjs';
import { importRobloxFile, glbBounds, readFileOnce } from '../packages/roblox-import/node.mjs';

const SAMPLE_PATH = new URL('./fixtures/roblox-sample.rbxlx', import.meta.url);
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const TOLERANCE = 1e-5;

function frame(position, rotation = IDENTITY) {
  const [x, y, z] = position;
  const names = ['R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'];
  const rotationXml = rotation.map((value, index) => `<${names[index]}>${value}</${names[index]}>`).join('');
  return `<CoordinateFrame name="CFrame"><X>${x}</X><Y>${y}</Y><Z>${z}</Z>${rotationXml}</CoordinateFrame>`;
}

function part({ cls = 'Part', name = 'P', size = [4, 1, 2], position = [0, 0, 0], rotation = IDENTITY, shape = 1, color = 4294967295, extra = '', children = '' } = {}) {
  return `<Item class="${cls}" referent="RBX${name}"><Properties><string name="Name">${name}</string><token name="shape">${shape}</token>`
    + `<Vector3 name="size"><X>${size[0]}</X><Y>${size[1]}</Y><Z>${size[2]}</Z></Vector3>${frame(position, rotation)}`
    + `<Color3uint8 name="Color3uint8">${color}</Color3uint8>${extra}</Properties>${children}</Item>`;
}

function place(...items) {
  return `<roblox version="4"><Item class="Workspace" referent="RBXW"><Properties><string name="Name">Workspace</string></Properties>${items.join('')}</Item></roblox>`;
}

function rotationY(degrees) {
  const [cosine, sine] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
  return [cosine, 0, sine, 0, 1, 0, -sine, 0, cosine];
}

function rotationX(degrees) {
  const [cosine, sine] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
  return [1, 0, 0, 0, cosine, -sine, 0, sine, cosine];
}

function rotationZ(degrees) {
  const [cosine, sine] = [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180)];
  return [cosine, -sine, 0, sine, cosine, 0, 0, 0, 1];
}

function multiply(left, right) {
  const product = new Array(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let k = 0; k < 3; k += 1) product[row * 3 + column] += left[row * 3 + k] * right[k * 3 + column];
    }
  }
  return product;
}

function apply(matrix, vector) {
  return [0, 1, 2].map(row => matrix[row * 3] * vector[0] + matrix[row * 3 + 1] * vector[1] + matrix[row * 3 + 2] * vector[2]);
}

function rotateByQuaternion([x, y, z, w], [vx, vy, vz]) {
  const crossX = y * vz - z * vy;
  const crossY = z * vx - x * vz;
  const crossZ = x * vy - y * vx;
  const doubleX = y * crossZ - z * crossY;
  const doubleY = z * crossX - x * crossZ;
  const doubleZ = x * crossY - y * crossX;
  return [vx + 2 * (w * crossX + doubleX), vy + 2 * (w * crossY + doubleY), vz + 2 * (w * crossZ + doubleZ)];
}

function close(actual, expected, message) {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < TOLERANCE, `${message}: got ${actual.map(entry => entry.toFixed(5))}, expected ${expected.map(entry => entry.toFixed(5))}`));
}

async function buildScene(recipe) {
  await loadAgentSceneModules(recipe);
  return createAgentScene(recipe);
}

// World-space box of a built part, from its vertices and its matrix (column-major).
function worldVertices(builtPart) {
  const { positions } = builtPart.geometry;
  const matrix = builtPart.matrix;
  const vertices = [];
  for (let offset = 0; offset < positions.length; offset += 3) {
    const [x, y, z] = [positions[offset], positions[offset + 1], positions[offset + 2]];
    vertices.push([
      matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
      matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
      matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ]);
  }
  return vertices;
}

function extent(vertices) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const vertex of vertices) {
    for (let axis = 0; axis < 3; axis += 1) {
      low[axis] = Math.min(low[axis], vertex[axis]);
      high[axis] = Math.max(high[axis], vertex[axis]);
    }
  }
  return { low, high, size: high.map((value, axis) => value - low[axis]), center: high.map((value, axis) => (value + low[axis]) / 2) };
}

test('1 stud is 0.28 m and Y stays up: a block keeps its size, position and handedness', () => {
  const { recipe } = importRoblox(place(part({ size: [4, 1, 2], position: [10, 5, -3] })));
  const [node] = recipe.nodes;
  assert.equal(STUD_METERS, 0.28);
  close(node.scale, [1.12, 0.28, 0.56], 'size in metres');
  close(node.translation, [2.8, 1.4, -0.84], 'position in metres, +Y up and +Z not flipped');
  assert.deepEqual(node.rotation, [0, 0, 0, 1]);
});

test('a CFrame rotation turns the part the way Roblox turns it, for rotations about each axis and a mix', async () => {
  const rotations = {
    'ninety degrees about Y': rotationY(90),
    'thirty about X': rotationX(30),
    'minus sixty about Z': rotationZ(-60),
    mixed: multiply(rotationY(35), multiply(rotationX(-20), rotationZ(70))),
    'half turn about Y': rotationY(180),
  };
  for (const [label, rotation] of Object.entries(rotations)) {
    const size = [4, 2, 6];
    const position = [3, 7, -5];
    const { recipe } = importRoblox(place(part({ size, position, rotation })));
    const scene = await buildScene(recipe);
    const world = worldVertices(scene.parts[0]);
    // Roblox: world = R * (local corner) + position, in studs, then metres.
    const expected = [];
    for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
      const local = [sx * size[0], sy * size[1], sz * size[2]];
      expected.push(apply(rotation, local).map((value, axis) => (value + position[axis]) * STUD_METERS));
    }
    const corners = world.filter(vertex => expected.some(corner => corner.every((value, axis) => Math.abs(value - vertex[axis]) < 1e-4)));
    assert.ok(corners.length >= 8, `${label}: the eight Roblox corners are vertices of the imported box`);
    const quaternion = recipe.nodes[0].rotation;
    close(rotateByQuaternion(quaternion, [1, 0, 0]), apply(rotation, [1, 0, 0]), `${label}: local X`);
    close(rotateByQuaternion(quaternion, [0, 1, 0]), apply(rotation, [0, 1, 0]), `${label}: local Y`);
    close(rotateByQuaternion(quaternion, [0, 0, 1]), apply(rotation, [0, 0, 1]), `${label}: local Z`);
  }
});

test('matrixToQuaternion covers all four branches and keeps w non-negative', () => {
  for (const rotation of [IDENTITY, rotationY(170), rotationX(170), rotationZ(170), rotationY(-170), multiply(rotationX(179), rotationY(10))]) {
    const quaternion = matrixToQuaternion(rotation);
    assert.ok(quaternion[3] >= 0);
    close(rotateByQuaternion(quaternion, [1, 2, 3]), apply(rotation, [1, 2, 3]), 'vector rotated');
  }
});

test('shapes: ball diameter, cylinder along local X, and a wedge whose tall side is local +Z', async () => {
  const ball = part({ name: 'ball', shape: 0, size: [6, 6, 6], position: [0, 3, 0] });
  const cylinderFlat = part({ name: 'cylinder', shape: 2, size: [8, 4, 4], position: [20, 2, 0] });
  const wedge = part({ cls: 'WedgePart', name: 'wedge', size: [2, 4, 6], position: [40, 2, 0] });
  const { recipe } = importRoblox(place(ball, cylinderFlat, wedge));
  const scene = await buildScene(recipe);
  const byName = name => scene.parts.find(entry => entry.name.startsWith(name));
  const ballBox = extent(worldVertices(byName('ball')));
  close(ballBox.size, [1.68, 1.68, 1.68], 'ball diameter 6 studs');
  close(ballBox.center, [0, 0.84, 0], 'ball centre');
  const cylinderBox = extent(worldVertices(byName('cylinder')));
  close(cylinderBox.size, [2.24, 1.12, 1.12], 'cylinder is 8 studs long along X and 4 across');
  close(cylinderBox.center, [5.6, 0.56, 0], 'cylinder centre');
  const wedgeVertices = worldVertices(byName('wedge'));
  const wedgeBox = extent(wedgeVertices);
  close(wedgeBox.size, [0.56, 1.12, 1.68], 'wedge box');
  close(wedgeBox.center, [11.2, 0.56, 0], 'wedge centre');
  const top = wedgeVertices.filter(vertex => vertex[1] > wedgeBox.high[1] - 1e-5);
  const bottom = wedgeVertices.filter(vertex => vertex[1] < wedgeBox.low[1] + 1e-5);
  assert.ok(top.every(vertex => Math.abs(vertex[2] - wedgeBox.high[2]) < 1e-5), 'the top edge is at the back (+Z)');
  assert.ok(bottom.some(vertex => Math.abs(vertex[2] - wedgeBox.low[2]) < 1e-5), 'the floor reaches the front (-Z)');
  assert.ok(!wedgeVertices.some(vertex => vertex[1] > wedgeBox.high[1] - 1e-5 && vertex[2] < wedgeBox.high[2] - 1e-5), 'nothing tall at the front');
});

test('a wedge turned half a turn about Y has its tall side at -Z', async () => {
  const { recipe } = importRoblox(place(part({ cls: 'WedgePart', size: [2, 4, 6], rotation: rotationY(180) })));
  const vertices = worldVertices((await buildScene(recipe)).parts[0]);
  const box3 = extent(vertices);
  const top = vertices.filter(vertex => vertex[1] > box3.high[1] - 1e-5);
  assert.ok(top.every(vertex => Math.abs(vertex[2] - box3.low[2]) < 1e-5));
});

test('colour is converted from sRGB to linear, packed or as floats, and material and transparency carry over', () => {
  const grey = (0xff << 24 | 0x80 << 16 | 0x80 << 8 | 0x80) >>> 0;
  const packed = importRoblox(place(part({ color: grey, extra: '<token name="Material">1088</token>' }))).recipe;
  close(packed.materials[0].color, [0.215861, 0.215861, 0.215861], 'sRGB 128 is 0.2159 linear');
  assert.equal(packed.materials[0].metallic, 1);
  const floats = importRoblox(`<roblox><Item class="Part" referent="a"><Properties><string name="Name">F</string><Color3 name="Color"><R>1</R><G>0</G><B>0.5</B></Color3>`
    + `<Vector3 name="size"><X>1</X><Y>1</Y><Z>1</Z></Vector3><float name="Transparency">0.25</float><token name="Material">288</token></Properties></Item></roblox>`).recipe;
  close(floats.materials[0].color, [1, 0, 0.214041], 'float colour');
  const orange = (0xff << 24 | 218 << 16 | 133 << 8 | 65) >>> 0;
  close(importRoblox(place(part({ color: orange }))).recipe.materials[0].color, [0.701102, 0.234551, 0.052861], 'sRGB 218,133,65 is the linear albedo the recipe holds');
  assert.equal(floats.materials[0].opacity, 0.75);
  assert.equal(floats.materials[0].alphaMode, 'blend');
  assert.ok(floats.materials[0].emission > 0, 'Neon glows');
});

test('materials with the same look share one recipe material, and a fully transparent part is skipped', () => {
  const result = importRoblox(place(
    part({ name: 'A' }), part({ name: 'B', position: [5, 0, 0] }),
    part({ name: 'C', extra: '<float name="Transparency">1</float>' }),
  ));
  assert.equal(result.recipe.materials.length, 1);
  assert.equal(result.recipe.nodes.length, 2);
  assert.equal(result.stats.invisible, 1);
});

test('the camera keeps its position, looks down local -Z with a vertical field of view, and CurrentCamera wins', () => {
  const turned = rotationY(90);
  const xml = `<roblox><Item class="Workspace" referent="W"><Properties><string name="Name">Workspace</string><Ref name="CurrentCamera">C2</Ref></Properties>`
    + `<Item class="Camera" referent="C1"><Properties><float name="FieldOfView">20</float>${frame([0, 0, 0])}</Properties></Item>`
    + `<Item class="Camera" referent="C2"><Properties><float name="FieldOfView">60</float>${frame([10, 20, 30], turned)}</Properties></Item>`
    + `${part({})}</Item></roblox>`;
  const { recipe } = importRoblox(xml);
  close(recipe.camera.eye, [2.8, 5.6, 8.4], 'eye in metres');
  const look = recipe.camera.target.map((value, axis) => value - recipe.camera.eye[axis]);
  close(look.map(value => value / 10), apply(turned, [0, 0, -1]), 'look direction is -Z of the CFrame');
  close(recipe.camera.up, [0, 1, 0], 'up');
  assert.equal(recipe.camera.fov, 60);
});

test('light strength is pinned: Brightness 1 is ${CANDELA_PER_BRIGHTNESS} candela and the documented default ranges convert from studs', () => {
  const lamp = part({ children: '<Item class="PointLight" referent="a"><Properties/></Item><Item class="SpotLight" referent="b"><Properties/></Item>' });
  const { recipe } = importRoblox(place(lamp));
  assert.equal(CANDELA_PER_BRIGHTNESS, 4);
  assert.equal(recipe.environment.pointLights[0].intensity, 4);
  assert.equal(recipe.environment.pointLights[0].range, 2.24);
  assert.equal(recipe.environment.spotLights[0].intensity, 4);
  assert.equal(recipe.environment.spotLights[0].range, 4.48);
  assert.ok(Math.abs(recipe.environment.spotLights[0].angle - Math.PI / 4) < 1e-6, 'the default Angle of 90 degrees is a half angle of 45');
});

test('lights: point, spot and surface keep their position, face, range and cone', () => {
  const lamp = part({
    name: 'lamp', size: [2, 2, 2], position: [10, 4, 0], rotation: rotationY(90),
    children: '<Item class="PointLight" referent="L1"><Properties><float name="Brightness">2</float><float name="Range">20</float><Color3 name="Color"><R>1</R><G>1</G><B>1</B></Color3></Properties></Item>'
      + '<Item class="SpotLight" referent="L2"><Properties><float name="Brightness">4</float><float name="Range">50</float><float name="Angle">60</float><token name="Face">4</token></Properties></Item>'
      + '<Item class="SurfaceLight" referent="L3"><Properties><float name="Brightness">1</float><token name="Face">5</token></Properties></Item>'
      + '<Item class="PointLight" referent="L4"><Properties><bool name="Enabled">false</bool></Properties></Item>',
  });
  const { recipe, stats } = importRoblox(place(lamp));
  const [point] = recipe.environment.pointLights;
  close(point.position, [2.8, 1.12, 0], 'point light at the part');
  assert.equal(point.range, 5.6);
  assert.equal(recipe.environment.pointLights.length, 1);
  assert.equal(stats.lightsOff, 1);
  const [spot] = recipe.environment.spotLights;
  close(spot.direction, [0, -1, 0], 'face Bottom points down');
  close(spot.position, [2.8, 0.84, 0], 'spot sits on the bottom face');
  assert.ok(Math.abs(spot.angle - Math.PI / 6) < 1e-6, 'Angle is the full cone, Crucible takes the half angle');
  const [area] = recipe.environment.areaLights;
  close(area.direction, [-1, 0, 0], 'face Front is local -Z, turned by the part');
  close(area.position, [2.52, 1.12, 0], 'area light on the front face, one stud from the centre along the turned -Z');
  assert.equal(area.width, 0.56);
  assert.equal(area.height, 0.56);
});

test('unsupported classes stop the import with the class, the name and what to pass', () => {
  const xml = place('<Item class="UnionOperation" referent="U1"><Properties><string name="Name">Door</string></Properties></Item>');
  assert.throws(() => importRoblox(xml), error => {
    assert.ok(error instanceof RobloxImportError);
    assert.match(error.message, /UnionOperation "Door"/);
    assert.match(error.message, /skipUnsupported: true/);
    assert.match(error.message, /MeshPart/);
    return true;
  });
  const skipped = importRoblox(place(part({}), '<Item class="UnionOperation" referent="U1"><Properties><string name="Name">Door</string></Properties></Item>'), { skipUnsupported: true });
  assert.equal(skipped.recipe.nodes.length, 1);
  assert.match(skipped.warnings[0], /UnionOperation "Door".*skipped/);
  assert.throws(() => importRoblox(place('<Item class="Mystery" referent="M"><Properties><string name="Name">X</string></Properties></Item>')), /Unsupported class Mystery "X"/);
});

test('decals and particle emitters are dropped with one warning per class, and scripts and services are ignored', () => {
  const decal = '<Item class="Decal" referent="D"><Properties><string name="Name">D</string></Properties></Item>';
  const script = '<Item class="Script" referent="S"><Properties><string name="Name">S</string></Properties></Item>';
  const result = importRoblox(place(part({ children: decal + decal + script })).replace('</roblox>', '<Item class="StarterGui" referent="G"><Properties/></Item></roblox>'));
  assert.deepEqual(result.warnings, ['2 Decal objects are not drawn: Crucible cannot read it from the XML.']);
  assert.deepEqual(result.ignored, ['Script']);
  assert.deepEqual(result.stats.skippedServices, ['StarterGui']);
});

test('bad input says what failed and what to pass', () => {
  assert.throws(() => importRoblox(''), /needs the text of an .rbxlx or .rbxmx/);
  assert.throws(() => importRoblox('<html></html>'), /no <roblox> root/);
  assert.throws(() => importRoblox('<roblox><Item class="Part"></roblox>'), /closes <\/roblox>/);
  assert.throws(() => importRoblox('<roblox><Item class="Part">'), /ends inside/);
  assert.throws(() => importRoblox(place(part({ rotation: [-1, 0, 0, 0, 1, 0, 0, 0, 1] }))), /mirrors the part/);
  assert.throws(() => importRoblox(place(part({ rotation: [2, 0, 0, 0, 1, 0, 0, 0, 1] }))), /not a rotation/);
  assert.throws(() => importRoblox(place(part({ size: [0, 1, 1] }))), /outside 0 to 100000 studs/);
  assert.throws(() => importRoblox(place(part({ shape: 9 }))), /shape 9/);
  assert.throws(() => importRoblox(place('<Item class="Model" referent="m"><Properties/></Item>')), /no parts to draw/);
  assert.throws(() => importRoblox(place(part({})), { maxPart: 3 }), /Unknown option "maxPart"/);
  assert.throws(() => importRoblox(place(part({})), { maxParts: 0 }), /maxParts must be a whole number/);
});

test('counts and sizes are bounded', () => {
  const many = place(...Array.from({ length: 5 }, (_, index) => part({ name: `p${index}`, position: [index, 0, 0] })));
  assert.throws(() => importRoblox(many, { maxParts: 4 }), /more than 4 parts.*Raise maxParts/);
  assert.throws(() => importRoblox(many, { maxItems: 10 }), /more than 10 elements/);
  assert.throws(() => importRoblox(many, { maxBytes: 100 }), /above the limit of 100/);
  // maxBytes counts bytes, not characters: forty euro signs are 40 characters and 120 bytes.
  const multibyte = `<roblox>${'€'.repeat(40)}</roblox>`;
  assert.ok(multibyte.length < 100);
  assert.throws(() => importRoblox(multibyte, { maxBytes: 100 }), /holds 137 bytes, above the limit of 100/);
  assert.throws(() => importRoblox(`<roblox>${'😀'.repeat(30)}</roblox>`, { maxBytes: 100 }), /holds 137 bytes/);
  const deep = `<roblox>${'<Item class="Model" referent="m">'.repeat(40)}</roblox>`;
  assert.throws(() => importRoblox(deep, { maxDepth: 8 }), /nests deeper than 8/);
  const lights = place(part({ children: Array.from({ length: 20 }, () => '<Item class="PointLight" referent="l"><Properties/></Item>').join('') }));
  const result = importRoblox(lights);
  assert.equal(result.recipe.environment.pointLights.length, 16);
  assert.match(result.warnings[0], /20 point lights.*at most 16/);
});

// Hostile inputs. Each case has its own size `count`, chosen so the current parser takes 25 to 65 ms at that size on the machine that
// calibrated it; the test fails if a case runs under 5 ms at `count`, because then the timing says nothing (raise the count).
// A reader with a backtracking pattern takes time in proportion to count squared, so four times the input takes about 16 times as long;
// a linear reader about 4 times. The test compares the two timings, which a slow or loaded machine scales equally, instead of a
// fixed number of milliseconds. A quadratic parser would need minutes at these sizes, so a first timing at count / 16 stops it early.
const HOSTILE_INPUTS = {
  bangs: { count: 16000000, build: count => '!'.repeat(count) },
  bangsInsideTag: { count: 8000000, build: count => `<roblox ${'!'.repeat(count)}` },
  bangsInsideAttributes: { count: 3600000, build: count => `<roblox ${'! '.repeat(count)}>` },
  comments: { count: 2000000, build: count => '<!--'.repeat(count) },
  cdata: { count: 1600000, build: count => '<![CDATA[a'.repeat(count) },
  instructions: { count: 4000000, build: count => '<?'.repeat(count) },
  doctypes: { count: 1600000, build: count => '<!DOCTYPE'.repeat(count) },
  ampersands: { count: 560000, build: count => `<roblox>${'&a'.repeat(count)}</roblox>` },
  longEntity: { count: 640000, build: count => `<roblox>${'&'.repeat(count)}${'a'.repeat(count)}</roblox>` },
  // count quoted values in one open tag: readTag's quote-skip loop runs once per value and the tag never closes
  quotes: { count: 1000000, build: count => `<roblox ${'a="" '.repeat(count)}` },
  dashedName: { count: 16000000, build: count => `<roblox><Item class="Part"><Properties><string name="Name">${'-'.repeat(count)}x</string></Properties></Item></roblox>` },
};
const MINIMUM_MILLISECONDS = 5;
const MAXIMUM_RATIO = 6;
// Stops repeating a measurement that is already far too slow. It is not a pass mark: coverage runs are several times slower than a
// plain run, and the ratio and the count / 16 probe carry the linear-time check.
const STOP_REPEATING_MILLISECONDS = 2000;

function bestMilliseconds(text, label, runs = 5) {
  let best = Infinity;
  for (let run = 0; run < runs; run++) {
    const started = process.hrtime.bigint();
    try {
      importRoblox(text, { maxBytes: 256 * 1024 * 1024 });
    } catch (error) {
      assert.ok(error instanceof RobloxImportError, `${label} fails with a RobloxImportError, not ${error}`);
    }
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    if (best > STOP_REPEATING_MILLISECONDS) break;
  }
  return best;
}

test('hostile text is read in linear time: four times the input takes less than 6 times as long', () => {
  const report = [];
  for (const [label, { count, build }] of Object.entries(HOSTILE_INPUTS)) {
    bestMilliseconds(build(count / 100), label, 1);
    const probe = bestMilliseconds(build(count / 16), label, 1);
    assert.ok(probe < 100, `${label}: ${probe.toFixed(0)} ms for count / 16 is far above linear; the parser is super-linear on this input`);
    // Another process can slow every run of one measurement. A linear parser fails the ratio only by that bad luck, so a case is
    // measured up to three times and passes when any round stays under the limit; a quadratic parser gives about 16 in every round.
    let small = 0;
    let large = 0;
    let ratio = Infinity;
    const smallText = build(count);
    const largeText = build(count * 4);
    for (let round = 0; round < 3 && ratio >= MAXIMUM_RATIO; round++) {
      small = bestMilliseconds(smallText, label);
      assert.ok(small >= MINIMUM_MILLISECONDS, `${label}: only ${small.toFixed(1)} ms at count ${count}, too fast to compare; raise its count in HOSTILE_INPUTS`);
      large = bestMilliseconds(largeText, label);
      ratio = large / small;
    }
    report.push(`${label} n=${count} ${small.toFixed(1)} ms, 4n ${large.toFixed(1)} ms, ratio ${ratio.toFixed(2)}`);
    assert.ok(ratio < MAXIMUM_RATIO, `${label}: ${large.toFixed(1)} ms at 4n against ${small.toFixed(1)} ms at n is a ratio of ${ratio.toFixed(1)}, not linear`);
  }
  if (process.env.HOSTILE_REPORT) console.log(report.join(String.fromCharCode(10)));
});

test('the import is deterministic: the same text gives the same recipe, byte for byte, and names follow the document order', async () => {
  const text = await readFile(SAMPLE_PATH, 'utf8');
  const first = JSON.stringify(importRoblox(text));
  const second = JSON.stringify(importRoblox(text));
  assert.equal(first, second);
  assert.match(createHash('sha256').update(first).digest('hex'), /^[0-9a-f]{64}$/);
  const ids = importRoblox(text).recipe.nodes.map(node => node.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual(ids.slice(0, 3), ['ground-0', 'red-block-turned-30-degrees-1', 'blue-ball-2']);
});

test('the sample place builds into a Crucible scene with every part, a camera and the three lights', async () => {
  const result = importRoblox(await readFile(SAMPLE_PATH, 'utf8'));
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.stats.parts, { block: 5, ball: 2, cylinder: 1, wedge: 2, mesh: 0 });
  assert.equal(result.recipe.environment.pointLights.length, 1);
  assert.equal(result.recipe.environment.spotLights.length, 1);
  assert.equal(result.recipe.environment.areaLights.length, 1);
  const scene = await buildScene(result.recipe);
  assert.equal(scene.parts.length, 10);
  assert.equal(result.recipe.camera.fov, 65);
});

test('robloxAssetKey reads the three reference forms and never needs the network', () => {
  assert.equal(robloxAssetKey('rbxassetid://123'), '123');
  assert.equal(robloxAssetKey('http://www.roblox.com/asset/?id=456'), '456');
  assert.equal(robloxAssetKey('789'), '789');
  assert.equal(robloxAssetKey(''), null);
});

// ------------------------------------------------------------ assets and the network

function meshPartXml(meshId, extra = '') {
  return `<Item class="MeshPart" referent="M"><Properties><string name="Name">Tree</string><Content name="MeshId"><url>${meshId}</url></Content>`
    + `<Vector3 name="size"><X>10</X><Y>20</Y><Z>10</Z></Vector3>${frame([5, 10, 5])}${extra}</Properties></Item>`;
}

async function withAssetFolder(callback) {
  const folder = await mkdtemp(join(tmpdir(), 'roblox-assets-'));
  try {
    const source = { name: 'tree', geometry: box(0, 1), matrix: [2, 0, 0, 0, 0, 4, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1], material: { color: [0.2, 0.6, 0.2], metallic: 0, roughness: 1 } };
    await writeFile(join(folder, 'tree.glb'), Buffer.from(exportGlb([source])));
    await writeFile(join(folder, 'bark.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    await writeFile(join(folder, 'asset-map.json'), JSON.stringify({ 'rbxassetid://111': 'tree.glb', 'http://www.roblox.com/asset/?id=222': 'bark.png' }));
    await callback(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('a mesh named by asset id comes from the local folder map, fitted to its Size, and the asset id is the file hash', async () => {
  await withAssetFolder(async folder => {
    const file = join(folder, 'place.rbxlx');
    await writeFile(file, place(meshPartXml('rbxassetid://111', '<Content name="TextureID"><url>rbxassetid://222</url></Content>')));
    const result = await importRobloxFile(file, { assetFolder: folder });
    const bytes = await readFile(join(folder, 'tree.glb'));
    const expectedId = createHash('sha256').update(bytes).digest('hex');
    const [node] = result.recipe.nodes;
    assert.equal(node.asset.id, expectedId);
    const bounds = glbBounds(bytes);
    close(bounds.size, [2, 4, 2], 'GLB bounds read from the accessors');
    close(bounds.center, [1, 2, 3], 'GLB bounds centre');
    close(node.scale, [2.8 / 2, 5.6 / 4, 2.8 / 2], 'mesh fitted to the part Size in metres');
    close(node.translation, [1.4 - 1 * node.scale[0], 2.8 - 2 * node.scale[1], 1.4 - 3 * node.scale[2]], 'bounds centre lands on the part centre');
    assert.deepEqual(result.assets.map(asset => [asset.robloxId, asset.kind, asset.file]), [['111', 'glb', 'tree.glb'], ['222', 'image', 'bark.png']]);
    assert.match(result.warnings[0], /texture 222 is listed in assets but not drawn/);
  });
});

test('a mesh that is not in the map is an error that names the id and the fix, and a URL is never fetched', async () => {
  assert.throws(() => importRoblox(place(meshPartXml('rbxassetid://999'))), /mesh asset 999, which is not in the asset map.*asset-map.json/);
  assert.throws(() => importRoblox(place(meshPartXml('https://example.com/tree.mesh'))), /never fetches a URL/);
  assert.throws(() => importRoblox(place(meshPartXml(''))), /no MeshId/);
  const skipped = importRoblox(place(part({}), meshPartXml('rbxassetid://999')), { skipUnsupported: true });
  assert.equal(skipped.recipe.nodes.length, 1);
});

test('the asset folder is checked: a missing map, a file outside the folder and an unknown type are refused', async () => {
  await withAssetFolder(async folder => {
    await writeFile(join(folder, 'place.rbxlx'), place(part({})));
    await writeFile(join(folder, 'asset-map.json'), JSON.stringify({ 1: '../escape.glb' }));
    await assert.rejects(importRobloxFile(join(folder, 'place.rbxlx'), { assetFolder: folder }), /not in the asset folder|outside the asset folder/);
    await writeFile(join(folder, 'notes.txt'), 'x');
    await writeFile(join(folder, 'asset-map.json'), JSON.stringify({ 1: 'notes.txt' }));
    await assert.rejects(importRobloxFile(join(folder, 'place.rbxlx'), { assetFolder: folder }), /Only .glb meshes/);
    await rm(join(folder, 'asset-map.json'));
    await assert.rejects(importRobloxFile(join(folder, 'place.rbxlx'), { assetFolder: folder }), /no asset-map.json/);
    await assert.rejects(importRobloxFile(join(folder, 'place.rbxl')), /binary Roblox file/);
  });
});

test('no remote fetches: network calls throw while the sample and a mapped mesh import, and the sources carry no network code', async () => {
  const originals = { fetch: globalThis.fetch, httpRequest: http.request, httpsRequest: https.request, connect: net.connect };
  const forbidden = () => { throw new Error('The importer reached for the network.'); };
  globalThis.fetch = forbidden;
  http.request = forbidden;
  https.request = forbidden;
  net.connect = forbidden;
  try {
    const result = importRoblox(await readFile(SAMPLE_PATH, 'utf8'));
    assert.equal(result.recipe.nodes.length, 12);
    await withAssetFolder(async folder => {
      await writeFile(join(folder, 'place.rbxlx'), place(meshPartXml('http://www.roblox.com/asset/?id=111')));
      const mapped = await importRobloxFile(join(folder, 'place.rbxlx'), { assetFolder: folder });
      assert.equal(mapped.assets.length, 1);
    });
    assert.throws(() => importRoblox(place(meshPartXml('http://www.roblox.com/asset/?id=5'))), /not in the asset map/);
  } finally {
    globalThis.fetch = originals.fetch;
    http.request = originals.httpRequest;
    https.request = originals.httpsRequest;
    net.connect = originals.connect;
  }
  for (const name of ['index.mjs', 'node.mjs']) {
    const source = await readFile(new URL(`../packages/roblox-import/${name}`, import.meta.url), 'utf8');
    assert.ok(!/\bfetch\s*\(|node:https?|node:net|node:dgram|XMLHttpRequest|WebSocket|child_process/.test(source), `${name} has no network or process code`);
  }
});

test('a real file outside the asset folder and an asset-map.json link that leaves it are refused', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'roblox-contain-'));
  try {
    const folder = join(parent, 'assets');
    await mkdir(folder);
    await writeFile(join(parent, 'secret.png'), Buffer.alloc(8));
    await writeFile(join(parent, 'place.rbxlx'), place(part({})));
    await writeFile(join(folder, 'asset-map.json'), JSON.stringify({ 1: '../secret.png' }));
    await assert.rejects(importRobloxFile(join(parent, 'place.rbxlx'), { assetFolder: folder }), /outside the asset folder/);
    await rm(join(folder, 'asset-map.json'));
    await writeFile(join(parent, 'map-outside.json'), JSON.stringify({}));
    try {
      await symlink(join(parent, 'map-outside.json'), join(folder, 'asset-map.json'));
    } catch {
      return;
    }
    await assert.rejects(importRobloxFile(join(parent, 'place.rbxlx'), { assetFolder: folder }), /asset-map.json resolves outside the asset folder/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('files are opened once: size and type come from the open handle, and a swapped link is refused', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'roblox-once-'));
  try {
    await writeFile(join(folder, 'big.bin'), Buffer.alloc(64));
    const options = { maxBytes: 32, tooLarge: 'too large', notFile: 'not a file' };
    await assert.rejects(readFileOnce(join(folder, 'big.bin'), options), /too large/);
    assert.equal((await readFileOnce(join(folder, 'big.bin'), { ...options, maxBytes: 64 })).bytes.length, 64);
    await assert.rejects(importRobloxFile(join(folder, 'big.bin'), { maxBytes: 32 }), /too large|larger than the maxBytes/);
    await assert.rejects(readFileOnce(folder, options), error => error.code === 'EISDIR' || /not a file/.test(error.message));
    const inside = join(folder, 'big.bin');
    const contained = await readFileOnce(inside, { ...options, maxBytes: 64, root: await realpath(folder), outside: 'outside' });
    assert.equal(contained.bytes.length, 64);
    const otherRoot = await mkdtemp(join(tmpdir(), 'roblox-root-'));
    try {
      await assert.rejects(readFileOnce(inside, { ...options, maxBytes: 64, root: await realpath(otherRoot), outside: 'outside' }), /outside/);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
