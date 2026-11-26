import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { solveRelations } from '../src/agent-relations.js';
import { isAllowedMediaUrl, isVideoUrl } from '../src/changelog-media.js';
import { partsForRendererOptions } from '../src/dense-lods.js';
import { FILM_SHOTS, sampleFilm } from '../src/film.js';
import { readFloatPixels } from '../src/float-output.js';
import { runInChunks } from '../src/gaussian-splat-chunks.js';
import { parseGaussianSplatSpzAsync } from '../src/gaussian-splat-spz.js';
import { compileProgram, setPreparing } from '../src/gl-program.js';
import { buildWithKernels, runKernel } from '../src/kernel-offload.js';
import { weldVertices } from '../src/mesh-convert.js';
import { createMeshData } from '../src/mesh-data.js';
import { withoutDegenerateTriangles } from '../src/mesh-query.js';
import { box } from '../src/geometry.js';
import { drawMeshVolumes } from '../src/mesh-volume-pass.js';
import { meshWireframe } from '../src/mesh-wireframe.js';
import { assertPackFilePath } from '../src/pack-manifest.js';
import { createGenerator, createParticleLaunches, particleStateAt } from '../src/particles.js';
import { boatControlsAt, normalizeBoat, resolveBoat } from '../src/physics-boat.js';
import { boundedNumber } from '../src/physics-values.js';
import { clipFromGltfAnimation } from '../src/skeleton-pose.js';
import { placeCellVertices } from '../src/surface-nets.js';
import { registerFont, text as buildTextGeometry } from '../src/text-geometry.js';
import { loadLeafTextures, loadTextureSet } from '../src/texture-set.js';
import { buildTriangleBvhSteps } from '../src/triangle-bvh.js';
import { triangulate } from '../src/triangulate.js';
import { pixelErrorScale } from '../src/vegetation-impostors.js';
import { createTree, resolveLeafTextures, scatterVegetation, selectLevels } from '../src/vegetation.js';
import { volumeGridFrameIndex } from '../src/volume-grid-sequence.js';
import { runAnnotateSession } from '../scripts/annotate-session.mjs';
import { buildPackIndex } from '../scripts/build-pack-index.mjs';
import { parseChangelogSections } from '../scripts/changelog-fragments.mjs';
import { parseArguments } from '../scripts/render-file-native-options.mjs';

test('1. boundedNumber rejects Symbol with RangeError naming label before relational comparison', () => {
  assert.throws(
    () => boundedNumber(Symbol('s'), 'speedLimit', 0, 10, 5, true),
    error => error instanceof RangeError && error.message.includes('speedLimit'),
  );
});

test('2. boatControlsAt rejects NaN time explicitly instead of crashing on keys[-2]', () => {
  const boat = resolveBoat(
    normalizeBoat({ controls: [{ time: 0, throttle: 0.2, rudder: 0 }, { time: 2, throttle: 1, rudder: 0 }] }, 'boat'),
    [-1, -1, -1],
    [1, 1, 1],
  );
  assert.throws(() => boatControlsAt(boat, NaN), RangeError);
});

test('3. sampleFilm rejects null options and extreme aspect on non-portrait shots', () => {
  assert.throws(() => sampleFilm(0, null), error => error instanceof TypeError && /Film options/.test(error.message));
  const nonPortrait = FILM_SHOTS.find(shot => shot.scene !== 'portrait');
  assert.throws(() => sampleFilm(nonPortrait.start, { aspect: 1e-4 }), error => error instanceof RangeError && /Film aspect/.test(error.message));
});

test('5. vegetation validates callbacks, selectLevels eye/scales, and unknown createTree/leafTextures keys', () => {
  const area = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  assert.throws(() => scatterVegetation({ area, terrainHeight: 'flat' }), /terrainHeight/);
  assert.throws(() => scatterVegetation({ area, exclusion: 'none' }), /exclusion/);
  assert.throws(() => selectLevels([], undefined), /eye/);
  assert.throws(() => selectLevels([], [NaN, 0, 0]), /eye/);
  assert.throws(() => selectLevels([], [0, 0, 0], { distanceScale: NaN }), /distanceScale/);
  assert.throws(() => selectLevels([], [0, 0, 0], { cullDistance: NaN }), /cullDistance/);
  assert.throws(() => createTree({ species: 'broadleaf', hieght: 5 }), /hieght/);
  assert.throws(() => resolveLeafTextures({ oak: { color: { image: { width: 1, height: 1 } } } }, 'broadleaf'), /oak/);
});

test('6. pixelErrorScale rejects zero, negative, non-finite options and non-object argument', () => {
  assert.throws(() => pixelErrorScale(null), TypeError);
  assert.throws(() => pixelErrorScale({ pixels: 0 }), RangeError);
  assert.throws(() => pixelErrorScale({ pixels: -2 }), RangeError);
  assert.throws(() => pixelErrorScale({ pixels: NaN }), RangeError);
  assert.throws(() => pixelErrorScale({ height: 0 }), RangeError);
  assert.throws(() => pixelErrorScale({ fov: 180 }), RangeError);
});

test('7. changelog-media rejects null and non-string values safely', () => {
  assert.equal(isVideoUrl(null), false);
  assert.equal(isVideoUrl(undefined), false);
  assert.equal(isAllowedMediaUrl(null), false);
  assert.equal(isAllowedMediaUrl({ toString: () => 'https://example.com/clip.mp4' }), false);
});

test('8. buildTriangleBvhSteps validates index count, bounds, and finite positions', () => {
  assert.throws(() => buildTriangleBvhSteps(new Float32Array(9), [0, 1]), RangeError);
  assert.throws(() => buildTriangleBvhSteps(new Float32Array(9), [0, 1, 5]), RangeError);
  assert.throws(() => buildTriangleBvhSteps(new Float32Array([0, 0, 0, 1, 0, 0, NaN, 1, 0]), [0, 1, 2]), RangeError);
});

test('9. placeCellVertices rejects zero/small grid points and oversized grids', () => {
  assert.throws(() => placeCellVertices(new Float32Array(0), { points: [0, 2, 2], edge: 1 }, [0, 0, 0]), /grid\.points/);
  assert.throws(() => placeCellVertices(new Float32Array(0), { points: [1000, 1000, 1000], edge: 1 }, [0, 0, 0]), /limit/);
});

test('10. runInChunks calls onProgress(1) at total=0 and parseGaussianSplatSpzAsync checks chunkSize before inflating', async () => {
  const seen = [];
  await runInChunks(0, { onProgress: value => seen.push(value) }, 'test', () => {});
  assert.deepEqual(seen, [1]);
  await assert.rejects(
    () => parseGaussianSplatSpzAsync(new Uint8Array([0, 1, 2]), { chunkSize: 0 }),
    error => error instanceof RangeError && /chunkSize/.test(error.message),
  );
});

test('11. computeOnPage catches throwing kernel.accepts and falls back to inline', async () => {
  const value = await buildWithKernels(
    () => runKernel('pattern', [1], () => 'inline-ok'),
    {
      available: true,
      createWorker: () => ({ postMessage() { throw new Error('worker failed'); }, terminate() {} }),
      pageKernels: {
        pattern: {
          accepts() { throw new Error('accepts exploded'); },
          compute() { return 'never'; },
        },
      },
    },
  );
  assert.equal(value, 'inline-ok');
});

test('13. clipFromGltfAnimation caps resampled keyframes on huge track duration', () => {
  const fakeAnimation = {
    duration: 1e6,
    tracks: [{
      name: 'arm.position',
      times: new Float32Array([0, 1e6]),
      values: new Float32Array(18),
      getInterpolation: () => 2302,
      createInterpolant: () => ({ evaluate: () => [0, 0, 0] }),
    }],
  };
  assert.throws(() => clipFromGltfAnimation(fakeAnimation), /keyframes/);
});

test('14. readFloatPixels rejects NaN and fractional regions', () => {
  assert.throws(() => readFloatPixels({}, null, 4, 4, { x: NaN, y: 0, width: 1, height: 1 }), RangeError);
  assert.throws(() => readFloatPixels({}, null, 4, 4, { x: 0.5, y: 0, width: 1, height: 1 }), RangeError);
  assert.throws(() => readFloatPixels({}, null, 4, 4, null), RangeError);
});

test('15. volumeGridFrameIndex stays finite on 1e308 time', () => {
  const index = volumeGridFrameIndex(4, 24, 1e308, true);
  assert.ok(Number.isInteger(index) && index >= 0 && index < 4);
  assert.equal(volumeGridFrameIndex(4, 24, 1e308, false), 3);
});

test('16. loadTextureSet propagates decodeOne errors and loadLeafTextures rejects unsafe species names', async () => {
  await assert.rejects(
    () => loadTextureSet('/t', {
      fetchBlob: async () => ({}),
      decodeBlob: async () => { throw new Error('corrupt image'); },
    }),
    /corrupt image/,
  );
  await assert.rejects(
    () => loadLeafTextures('/t', {
      species: ['../secret'],
      fetchBlob: async () => ({}),
      decodeBlob: async () => ({}),
    }),
    TypeError,
  );
});

test('17. assertPackFilePath rejects all-dot and trailing-dot segments', () => {
  assert.throws(() => assertPackFilePath('.../model.glb', 'file'), /relative path/);
  assert.throws(() => assertPackFilePath('models/crate.', 'file'), /relative path/);
});

test('18. solveRelations blames NaN worldBounds instead of node translation', () => {
  const nodes = [
    { id: 'a', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], relations: [{ kind: 'place', side: 'top', to: 'b' }] },
    { id: 'b', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
  ];
  assert.throws(
    () => solveRelations(nodes, node => (node.id === 'b' ? { min: [NaN, 0, 0], max: [1, 1, 1] } : { min: [0, 0, 0], max: [1, 1, 1] })),
    error => /relations\[0\]\.to/.test(error.message) && !error.message.includes('translation'),
  );
});

test('19. registerFont clones font data so post-registration mutations do not affect stored glyphs', () => {
  const font = {
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: {
      A: [600, [0, 0, 1, 300, 700, 1, 600, 0, 1]],
    },
  };
  registerFont('TestCloneFont', font);
  font.unitsPerEm = 0;
  font.glyphs.A[1][0] = NaN;
  const mesh = buildTextGeometry('A', { font: 'TestCloneFont', depth: 0.1 });
  assert.ok(mesh.positions.length > 0 && mesh.positions.every(Number.isFinite));
});

test('20. weldVertices rejects negative tolerance and withoutDegenerateTriangles rejects out-of-range indices', () => {
  assert.throws(() => weldVertices(new Float32Array([0, 0, 0, 1, 0, 0]), -1), RangeError);
  assert.throws(
    () => withoutDegenerateTriangles({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 9]) }),
    RangeError,
  );
});

test('21. meshWireframe sets truncated=false when mesh has zero regular edges and only faults were dropped', () => {
  const mesh = createMeshData({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    faceOffsets: new Uint32Array([0, 4]),
    cornerVertices: new Uint32Array([0, 1, 2, 3]),
  });
  const wireframe = meshWireframe(mesh, { maximumSegments: 2 });
  assert.equal(wireframe.counts.regular, 0);
  assert.equal(wireframe.droppedFaults, 2);
  assert.equal(wireframe.truncated, false);
});

test('23. partsForRendererOptions rejects null options', () => {
  assert.throws(() => partsForRendererOptions([], { clientWidth: 100, clientHeight: 100 }, null), TypeError);
});

test('24. src/gl-program.js has no raw NUL byte and compileProgram still keys by vertex+fragment', () => {
  const raw = readFileSync(new URL('../src/gl-program.js', import.meta.url));
  assert.equal(raw.includes(0), false);
  let created = 0;
  const context = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    getExtension: () => null,
    isContextLost: () => false,
    createShader: type => ({ type }),
    shaderSource() {},
    compileShader() {},
    createProgram: () => ({ id: ++created }),
    attachShader() {},
    linkProgram() {},
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    deleteShader() {},
  };
  setPreparing(context, true);
  assert.doesNotThrow(() => compileProgram(context, 'v1', 'f1'));
  assert.equal(created, 1);
});

test('25. mesh-volume-pass handles double dispose and re-creation without double-disposing or double-wrapping', () => {
  let deletedPrograms = 0;
  let baseDisposes = 0;
  const renderer = {
    canvas: { width: 10, height: 10 },
    depthTexture: {},
    viewProjection: new Float32Array(16),
    inverseViewProjection: new Float32Array(16),
    renderTargets: { record() {}, release() {} },
    localVolumeBuffers: { meshParts: [{ label: 'box', part: { geometry: box(0, 1) } }] },
    context: {
      RG32F: 1, RG: 2, FLOAT: 3, TEXTURE_2D: 4, TEXTURE_MIN_FILTER: 5, TEXTURE_MAG_FILTER: 6,
      TEXTURE_WRAP_S: 7, TEXTURE_WRAP_T: 8, NEAREST: 9, CLAMP_TO_EDGE: 10, FRAMEBUFFER: 11,
      COLOR_ATTACHMENT0: 12, FRAMEBUFFER_COMPLETE: 13, MAX_TEXTURE_SIZE: 14, BLEND: 15,
      FUNC_ADD: 16, MIN: 17, VERTEX_SHADER: 18, FRAGMENT_SHADER: 19, COMPILE_STATUS: 20, LINK_STATUS: 21,
      ONE: 22, DEPTH_TEST: 23, CULL_FACE: 24, TEXTURE1: 25, ARRAY_BUFFER: 26, ELEMENT_ARRAY_BUFFER: 27,
      STATIC_DRAW: 28, UNSIGNED_SHORT: 29, UNSIGNED_INT: 30, TRIANGLES: 31, CW: 32, CCW: 33, COLOR: 34,
      isEnabled: () => false,
      getExtension: () => ({}),
      getParameter: param => (param === 14 ? 4096 : false),
      createShader: () => ({}),
      shaderSource() {},
      compileShader() {},
      createProgram: () => ({}),
      attachShader() {},
      linkProgram() {},
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      getUniformLocation: () => ({}),
      deleteShader() {},
      deleteProgram() { deletedPrograms++; },
      createVertexArray: () => ({}),
      bindVertexArray() {},
      deleteVertexArray() {},
      createBuffer: () => ({}),
      bindBuffer() {},
      bufferData() {},
      deleteBuffer() {},
      enableVertexAttribArray() {},
      vertexAttribPointer() {},
      createTexture: () => ({}),
      bindTexture() {},
      activeTexture() {},
      texImage2D() {},
      texParameteri() {},
      deleteTexture() {},
      createFramebuffer: () => ({}),
      bindFramebuffer() {},
      framebufferTexture2D() {},
      checkFramebufferStatus: () => 13,
      deleteFramebuffer() {},
      viewport() {},
      clearBufferfv() {},
      enable() {},
      disable() {},
      useProgram() {},
      uniformMatrix4fv() {},
      uniform1i() {},
      uniform1f() {},
      uniform2f() {},
      uniform3fv() {},
      blendFunc() {},
      blendEquation() {},
      colorMask() {},
      frontFace() {},
      drawElements() {},
    },
    dispose() { baseDisposes++; },
  };
  const frame = { eye: [0, 0, 5], projection: 'perspective', outputFramebuffer: null };
  drawMeshVolumes(renderer, frame);
  const wrappedOnce = renderer.dispose;
  renderer.dispose();
  renderer.dispose();
  assert.equal(deletedPrograms, 1);
  assert.equal(baseDisposes, 2);
  drawMeshVolumes(renderer, frame);
  assert.equal(renderer.dispose, wrappedOnce);
  renderer.dispose();
  assert.equal(deletedPrograms, 2);
  assert.equal(baseDisposes, 3);
});

test('26. triangulate rejects empty holes', () => {
  assert.throws(() => triangulate([[0, 0], [4, 0], [4, 4], [0, 4]], [[]]), /hole 0/);
});

test('27. particles fixes seed mixing, zero normal orientation, floor-below-spawn, and post-bounce collision', () => {
  assert.notEqual(createGenerator(1, 0)(), createGenerator(2 ** 32 + 1, 0)());
  assert.notEqual(createGenerator(1.5, 0)(), createGenerator(1.2, 0)());

  const launches = createParticleLaunches({
    count: 1,
    seed: 1,
    emitter: { shape: 'mesh', position: [0, 0, 0], source: { sample: () => ({ point: [0, 0, 0], normal: [0, 0, 0] }) } },
    orient: 'normal',
    lifetime: [2, 2],
    speed: [0, 0],
    direction: [0, 1, 0],
    spreadRadians: 0,
    size: [1, 1],
    forces: { gravity: [0, -9.81, 0], wind: [0, 0, 0], fields: [], drag: 0 },
  });
  assert.deepEqual(Array.from(launches.orientation), [1, 0, 0, 0, 1, 0, 0, 0, 1]);

  const forcesBelow = { gravity: [0, -9.81, 0], wind: [0, 0, 0], fields: [], drag: 0, floor: 0, bounce: 0.5, friction: 0 };
  const below = createParticleLaunches({
    count: 1,
    seed: 1,
    emitter: { shape: 'point', position: [0, -1, 0], halfExtents: [0, 0, 0], radius: 0 },
    lifetime: [2, 2],
    speed: [0, 0],
    direction: [0, -1, 0],
    spreadRadians: 0,
    size: [1, 1],
    forces: forcesBelow,
  });
  const state = { position: [0, 0, 0], scale: 0 };
  particleStateAt(below, 0, forcesBelow, 'constant', 0.2, state);
  assert.ok(state.position[1] < -1);

  // Corner bounce: particle moves downward-right, bounces off floor y=0 and hits vertical wall at x=0.1 within the same step.
  const wall = {
    triangles: Float64Array.from([0.1, 0, -1, 0, 2, 0, 0, 0, 2]),
    groups: [{ first: 0, end: 1, bounds: [0.1, 0, -1, 0.1, 2, 1] }],
    triangleCount: 1,
  };
  const cornerForces = { gravity: [0, -9.81, 0], wind: [0, 0, 0], fields: [], drag: 0, floor: 0, bounce: 0.8, friction: 0, colliders: wall };
  const corner = createParticleLaunches({
    count: 1,
    seed: 1,
    emitter: { shape: 'point', position: [0, 0.05, 0], halfExtents: [0, 0, 0], radius: 0 },
    lifetime: [2, 2],
    speed: [50, 50],
    direction: [0.8, -0.6, 0],
    spreadRadians: 0,
    size: [1, 1],
    forces: cornerForces,
  });
  particleStateAt(corner, 0, cornerForces, 'constant', 1 / 120, state);
  assert.ok(state.position[0] <= 0.1 + 1e-4, `particle crossed wall to x=${state.position[0]}`);
});

test('28. scripts handle dot-folders, missing paths, dated changelog headings, null annotate body, and empty/hex numeric flags', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'crucible-scripts-2403-'));
  try {
    const packsDir = join(tempDir, 'packs');
    const outDir = join(tempDir, 'out');
    mkdirSync(join(packsDir, '.hidden'), { recursive: true });
    writeFileSync(join(packsDir, '.hidden', 'junk.txt'), 'x');
    const built = await buildPackIndex({ packsDirectory: packsDir, outputDirectory: outDir });
    assert.deepEqual(built, []);

    const packCheck = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/pack-check.mjs', import.meta.url)), join(tempDir, 'missing-pack')], { encoding: 'utf8' });
    assert.equal(packCheck.status, 1);
    assert.match(packCheck.stderr, /Pack folder not found/);

    const covGate = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/coverage-gate.mjs', import.meta.url)), join(tempDir, 'missing.info')], { encoding: 'utf8' });
    assert.notEqual(covGate.status, 0);
    assert.match(covGate.stderr, /Coverage file or folder not found/);

    const sections = parseChangelogSections('## 0.21.0 - 2026-11-15\n\n- added thing\n');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].version, '0.21.0');

    let sendStatus = 0;
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
    const controller = new AbortController();
    await runAnnotateSession({
      png,
      width: 1,
      height: 1,
      signal: controller.signal,
      open: async url => {
        const response = await fetch(`${url}send`, { method: 'POST', body: 'null' });
        sendStatus = response.status;
        controller.abort();
      },
    });
    assert.equal(sendStatus, 400);

    const requiredArguments = ['--config', 'scene.json', '--out', 'out/frame'];
    assert.throws(() => parseArguments([...requiredArguments, '--seed', '']), RangeError);
    assert.throws(() => parseArguments([...requiredArguments, '--seed', '0x10']), RangeError);
    assert.throws(() => parseArguments([...requiredArguments, '--time', '']), RangeError);
    assert.throws(() => parseArguments([...requiredArguments, '--time', '0x10']), RangeError);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
