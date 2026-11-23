// Clip planes (#2996): fragments on the far side of a plane are discarded in the colour pass and in the shadow pass, and a
// renderer that sets no plane keeps its shaders. The browser tests draw in headless Chrome on the dev server; they skip where
// Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CLIP_PLANES, packClipPlanes } from '../src/clip-planes.js';
import { createDepthFragmentShader, createDepthVertexShader, createFragmentShader, createVertexShader, SHADER_FEATURES } from '../src/shaders.js';

// The vertex programs of skinned, morphed and crowd parts need their modules, which this test does not load.
const RIGID_FEATURES = SHADER_FEATURES.filter((feature) => !['skin', 'morph', 'crowd'].includes(feature));
import { withDevServerPage } from './helpers/dev-server-browser.js';

const scratch = new Float32Array(MAX_CLIP_PLANES * 4);

test('a plane is stored as a unit normal and a constant scaled with it', () => {
  assert.equal(packClipPlanes([{ normal: [0, 2, 0], constant: 4 }], scratch), 1);
  assert.deepEqual([...scratch.slice(0, 4)], [0, 1, 0, 2]);
});

test('clip planes refuse input that the shader could not use, and say what to pass', () => {
  assert.throws(() => packClipPlanes('x', scratch), /must be an array of planes.*Fix: pass \[\]/);
  const tooMany = Array.from({ length: MAX_CLIP_PLANES + 1 }, () => ({ normal: [0, 1, 0], constant: 0 }));
  assert.throws(() => packClipPlanes(tooMany, scratch), /5 planes and a draw takes at most 4/);
  assert.throws(() => packClipPlanes([{ normal: [0, 1], constant: 0 }], scratch), /plane 0 needs a normal of three finite numbers/);
  assert.throws(() => packClipPlanes([{ normal: [0, NaN, 0], constant: 0 }], scratch), /plane 0 needs a normal/);
  assert.throws(() => packClipPlanes([{ normal: [0, 0, 0], constant: 0 }], scratch), /normal of length 0/);
  assert.throws(() => packClipPlanes([{ normal: [0, 1, 0], constant: Infinity }], scratch, 'Part "wall" clipPlanes'), /Part "wall" clipPlanes plane 0 needs a finite constant/);
  assert.throws(() => packClipPlanes([null], scratch), /plane 0/);
});

test('shaders carry the plane code only when the clipPlanes feature is on', () => {
  for (const source of [createFragmentShader(), createVertexShader(RIGID_FEATURES), createDepthFragmentShader(RIGID_FEATURES), createDepthVertexShader(RIGID_FEATURES)]) {
    assert.ok(!/clipPlane|discardClipped|clippedPosition/.test(source), 'the default shaders keep their source');
  }
  const features = [...RIGID_FEATURES, 'clipPlanes'];
  const colour = createFragmentShader(features);
  assert.ok(colour.indexOf('discardClipped(worldPosition)') < colour.indexOf('renderPassValue(color'), 'the colour test comes before any early return');
  assert.match(createDepthVertexShader(features), /clippedPosition = world\.xyz/);
  const depth = createDepthFragmentShader(features);
  assert.ok(depth.indexOf('discardClipped(clippedPosition)') < depth.indexOf('alphaMasked < 0.5'), 'the shadow test comes before the early return');
  const tinted = createDepthFragmentShader([...features, 'tintedShadows']);
  assert.ok(tinted.indexOf('discardClipped(clippedPosition)') < tinted.indexOf('tintPass > 0.5'), 'a clipped caster tints nothing');
});

// Draws a wall that spans the view, then a floor with a cube above it, and reads pixels. Rows of the reads run bottom to top.
async function drawWithPlanes(page) {
  const task = async () => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '96px';
    canvas.style.height = '96px';
    document.body.append(canvas);
    const scale = (x, y, z, moveX = 0, moveY = 0, moveZ = 0) => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, moveX, moveY, moveZ, 1]);
    const matte = (color) => ({ tag: 'surface', color, metallic: 0, roughness: 0.9, emission: 0 });
    const readPixel = (renderer, x, y) => {
      const pixel = new Uint8Array(4);
      renderer.context.readPixels(x, y, 1, 1, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixel);
      return Array.from(pixel);
    };
    const options = { samples: 1, pixelRatio: 1, ground: false, depth: true };
    const sky = [0.1, 0.1, 0.1];
    const environment = { skyTop: sky, skyBottom: sky, lightDirection: [0.2, 1, 0.3] };
    const result = {};

    // A red wall 8 wide and 8 tall facing the camera. The plane keeps x <= 0, so the right half of the picture shows the sky.
    const wall = { name: 'wall', geometry: box(0, 1), matrix: scale(8, 8, 0.5), material: matte([0.9, 0.05, 0.05]) };
    const wallRenderer = new CrucibleRenderer(canvas, [wall], { ...options, clipPlanes: [] });
    const wallFrame = { eye: [0, 0, 8], target: [0, 0, 0], fov: 40, environment };
    const wallPixels = () => ({ left: readPixel(wallRenderer, 24, 48), right: readPixel(wallRenderer, 72, 48) });
    wallRenderer.render(wallFrame);
    result.uncut = wallPixels();
    wallRenderer.setClipPlanes([{ normal: [-1, 0, 0], constant: 0 }]);
    wallRenderer.render(wallFrame);
    result.cut = wallPixels();
    wallRenderer.setClipPlanes([{ normal: [1, 0, 0], constant: 0 }]);
    wallRenderer.render(wallFrame);
    result.cutOtherSide = wallPixels();
    wallRenderer.setClipPlanes([]);
    wallRenderer.render(wallFrame);
    result.cleared = wallPixels();
    result.glError = wallRenderer.context.getError();
    let message = '';
    try {
      wallRenderer.setClipPlanes([{ normal: [0, 0, 0], constant: 0 }]);
    } catch (error) {
      message = error.message;
    }
    result.refused = message;
    wallRenderer.render(wallFrame);
    result.afterRefusal = wallPixels();

    const plain = new CrucibleRenderer(canvas, [wall], { ...options });
    try {
      plain.setClipPlanes([]);
    } catch (error) {
      result.withoutFeature = error.message;
    }

    // A floor with a cube above it. The cube's own planes cut it away completely, in place between two renders: its shadow goes too.
    const cubePlanes = [];
    const floor = { name: 'floor', geometry: box(0, 1), matrix: scale(12, 0.2, 12, 0, -0.1, 0), material: matte([0.8, 0.8, 0.8]), clipPlanes: [] };
    const cube = { name: 'cube', geometry: box(0, 1), matrix: scale(1.5, 1.5, 1.5, 0, 1.5, 0), material: matte([0.2, 0.2, 0.9]), clipPlanes: cubePlanes };
    const shadowRenderer = new CrucibleRenderer(canvas, [floor, cube], { ...options, shadowBounds: {} });
    const shadowFrame = { eye: [0, 7, 7], target: [0, 0, 0], fov: 40, environment: { ...environment, lightDirection: [-1, 1, 0.1] } };
    const floorPixels = () => Array.from({ length: 8 }, (_, index) => readPixel(shadowRenderer, 60 + index * 3, 48));
    shadowRenderer.render(shadowFrame);
    result.shadowed = floorPixels();
    cubePlanes.push({ normal: [0, -1, 0], constant: 0 });
    shadowRenderer.render(shadowFrame);
    result.unshadowed = floorPixels();
    cubePlanes.length = 0;
    shadowRenderer.render(shadowFrame);
    result.shadowedAgain = floorPixels();
    result.shadowGlError = shadowRenderer.context.getError();
    return result;
  };
  return page.evaluate(task);
}

const isRed = ([red, green]) => red - green > 80;
const brightness = (pixels) => pixels.reduce((total, [red, green, blue]) => total + red + green + blue, 0);

test('a plane discards the fragments on its far side in the colour pass and in the shadow pass, and moves between renders', async (context) => {
  await withDevServerPage(context, async (page) => {
    const result = await drawWithPlanes(page);
    assert.equal(result.glError, 0);
    assert.equal(result.shadowGlError, 0);
    assert.ok(isRed(result.uncut.left) && isRed(result.uncut.right), `without a plane the wall fills the view: ${JSON.stringify(result.uncut)}`);
    assert.ok(isRed(result.cut.left), 'the near side stays');
    assert.ok(!isRed(result.cut.right), 'the far side shows the sky');
    assert.ok(isRed(result.cutOtherSide.right) && !isRed(result.cutOtherSide.left), 'turning the plane around keeps the other side');
    assert.ok(isRed(result.cleared.left) && isRed(result.cleared.right), 'an empty list cuts nothing');
    assert.match(result.refused, /plane 0 has a normal of length 0/);
    assert.ok(isRed(result.afterRefusal.left) && isRed(result.afterRefusal.right), 'a refused list leaves the planes as they were');
    assert.match(result.withoutFeature, /pass clipPlanes: \[\] in the renderer options/);
    assert.ok(brightness(result.shadowed) < brightness(result.unshadowed) * 0.97, 'the cube casts a shadow on the floor');
    assert.ok(brightness(result.shadowedAgain) < brightness(result.unshadowed) * 0.97, 'the shadow returns when the planes are removed in place');
  });
});

// A renderer built with no clip plane, then given a part with clipPlanes through replaceParts: the shadow program is compiled again.
async function drawWithPlanesAddedLater(page) {
  const task = async () => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    await import('/src/liquid-shader.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '96px';
    canvas.style.height = '96px';
    document.body.append(canvas);
    const scale = (x, y, z, moveX = 0, moveY = 0, moveZ = 0) => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, moveX, moveY, moveZ, 1]);
    const matte = (color) => ({ tag: 'surface', color, metallic: 0, roughness: 0.9, emission: 0 });
    const readPixel = (renderer, x, y) => {
      const pixel = new Uint8Array(4);
      renderer.context.readPixels(x, y, 1, 1, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixel);
      return Array.from(pixel);
    };
    const options = { samples: 1, pixelRatio: 1, ground: false, depth: true };
    const sky = [0.1, 0.1, 0.1];
    const environment = { skyTop: sky, skyBottom: sky, lightDirection: [0.2, 1, 0.3] };
    const result = {};

    const floor = { name: 'floor', geometry: box(0, 1), matrix: scale(12, 0.2, 12, 0, -0.1, 0), material: matte([0.8, 0.8, 0.8]) };
    const cubePlanes = [{ normal: [0, -1, 0], constant: 0 }];
    const cube = { name: 'cube', geometry: box(0, 1), matrix: scale(1.5, 1.5, 1.5, 0, 1.5, 0), material: matte([0.2, 0.2, 0.9]), clipPlanes: cubePlanes };
    const renderer = new CrucibleRenderer(canvas, [floor], { ...options, shadowBounds: {} });
    const frame = { eye: [0, 7, 7], target: [0, 0, 0], fov: 40, environment: { ...environment, lightDirection: [-1, 1, 0.1] } };
    const floorPixels = () => Array.from({ length: 8 }, (_, index) => readPixel(renderer, 60 + index * 3, 48));
    renderer.render(frame);
    try {
      renderer.replaceParts([floor, cube]);
      renderer.render(frame);
      result.unshadowed = floorPixels();
      cubePlanes.length = 0;
      renderer.render(frame);
      result.shadowed = floorPixels();
    } catch (error) {
      result.error = error.message;
    }
    result.glError = renderer.context.getError();

    const wall = { name: 'wall', geometry: box(0, 1), matrix: scale(8, 8, 0.5), material: matte([0.9, 0.05, 0.05]) };
    const wallRenderer = new CrucibleRenderer(canvas, [floor], options);
    const wallFrame = { eye: [0, 0, 8], target: [0, 0, 0], fov: 40, environment };
    try {
      wallRenderer.replaceParts([{ ...wall, clipPlanes: [{ normal: [-1, 0, 0], constant: 0 }] }]);
      wallRenderer.render(wallFrame);
      result.wall = { left: readPixel(wallRenderer, 24, 48), right: readPixel(wallRenderer, 72, 48) };
    } catch (error) {
      result.wallError = error.message;
    }

    // A liquid part has its own program: it is cut by the same planes, edited in place between renders.
    const liquidPlanes = [];
    const liquidRenderer = new CrucibleRenderer(canvas, [floor], options);
    try {
      liquidRenderer.replaceParts([{ ...wall, material: { ...matte([0.9, 0.9, 0.9]), transmission: 1 }, clipPlanes: liquidPlanes }]);
      const liquidPixels = () => ({ left: readPixel(liquidRenderer, 24, 48), right: readPixel(liquidRenderer, 72, 48) });
      liquidRenderer.render(wallFrame);
      result.liquidUncut = liquidPixels();
      liquidPlanes.push({ normal: [-1, 0, 0], constant: 0 });
      liquidRenderer.render(wallFrame);
      result.liquidCut = liquidPixels();
      result.liquidGlError = liquidRenderer.context.getError();
    } catch (error) {
      result.liquidError = error.message;
    }
    return result;
  };
  return page.evaluate(task);
}

test('a part given clipPlanes through replaceParts after construction is cut in the colour and the shadow pass', async (context) => {
  await withDevServerPage(context, async (page) => {
    const result = await drawWithPlanesAddedLater(page);
    assert.equal(result.error, undefined);
    assert.equal(result.wallError, undefined);
    assert.equal(result.glError, 0);
    assert.ok(brightness(result.shadowed) < brightness(result.unshadowed) * 0.97, 'the cube casts no shadow while its planes cut it away, and one once they are removed');
    assert.ok(isRed(result.wall.left) && !isRed(result.wall.right), `the wall is cut at the plane: ${JSON.stringify(result.wall)}`);
    assert.equal(result.liquidError, undefined);
    assert.equal(result.liquidGlError, 0);
    const distance = (first, second) => Math.abs(first[0] - second[0]) + Math.abs(first[1] - second[1]) + Math.abs(first[2] - second[2]);
    assert.ok(distance(result.liquidUncut.right, result.liquidCut.right) > 30, `the liquid's far side is cut: ${JSON.stringify([result.liquidUncut, result.liquidCut])}`);
    assert.ok(distance(result.liquidUncut.left, result.liquidCut.left) < 6, 'the liquid keeps its near side');
  });
});
