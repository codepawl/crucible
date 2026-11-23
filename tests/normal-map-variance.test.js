// #3142: the spread of the normals each normal-map mip level averages is drawn into the alpha of every level by a small GPU pass when
// the map is uploaded, because the 8-bit RGB of a mip cannot show it. The shader fades the direct specular by it.
// The pass runs in headless Chrome (SwiftShader on CI, whatever GL Chrome gets on a developer machine) and is compared with the CPU
// reference in tests/helpers. It skips where Chrome cannot start on a developer machine and fails on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFragmentShader } from '../src/shaders.js';
import { withDevServerPage } from './helpers/dev-server-browser.js';
import { buildNormalVarianceLevels, decodeSpread, encodeSpread } from './helpers/normal-variance-reference.js';

// Bytes of a unit normal in tangent space: x and y tilt by `tilt` radians toward `direction` along x.
function encodedNormal(tilt, direction) {
  const normal = [Math.sin(tilt) * direction, 0, Math.cos(tilt)];
  return normal.map(component => Math.round((component * 0.5 + 0.5) * 255));
}

function mapOf(width, height, texelAt) {
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const [red, green, blue] = texelAt(column, row);
      rgba.set([red, green, blue, 255], (row * width + column) * 4);
    }
  }
  return rgba;
}

// Normals that wander smoothly with a bevel ring and some noise, so every level has a different spread (a fixed seed, no Math.random).
function wanderingMap(width, height) {
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  return mapOf(width, height, (column, row) => {
    const x = column / width - 0.5;
    const y = row / height - 0.5;
    const ring = Math.abs(Math.hypot(x, y) - 0.35) < 0.02 ? 1.2 : 0;
    const normal = [Math.sin(6 * x) * 0.3 + ring * x * 2 + noise() * 0.25, Math.cos(5 * y) * 0.3 + ring * y * 2 + noise() * 0.25, 1];
    const length = Math.hypot(...normal);
    return normal.map(component => Math.round((component / length * 0.5 + 0.5) * 255));
  });
}

const CASES = {
  flat: { width: 16, height: 16, rgba: mapOf(16, 16, () => [128, 128, 255]) },
  alternating: { width: 8, height: 8, rgba: mapOf(8, 8, column => encodedNormal(Math.PI / 6, column % 2 === 0 ? 1 : -1)) },
  uniformTilt: { width: 8, height: 8, rgba: mapOf(8, 8, () => encodedNormal(1.0, 1)) },
  halfMixed: { width: 4, height: 4, rgba: mapOf(4, 4, column => (column < 2 ? [128, 128, 255] : encodedNormal(Math.PI / 3, column === 2 ? 1 : -1))) },
  wide: { width: 4, height: 2, rgba: mapOf(4, 2, () => [128, 128, 255]) },
  odd: { width: 5, height: 3, rgba: mapOf(5, 3, () => [128, 128, 255]) },
  wandering: { width: 64, height: 37, rgba: wanderingMap(64, 37) },
  wanderingSquare: { width: 128, height: 128, rgba: wanderingMap(128, 128) },
};

// Uploads each map as a linear RGBA8 texture with an alpha of 255 like a PNG, bakes it twice and reads every level back. Also reports whether the pass left the
// framebuffer, viewport, colour mask, program and sampler levels as it found them.
async function bakeInPage(page) {
  const cases = Object.entries(CASES).map(([name, { width, height, rgba }]) => ({ name, width, height, rgba: Array.from(rgba) }));
  return page.evaluate(async (inputs) => {
    const { bakeNormalMapVariance } = await import('/src/normal-map-variance.js');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2');
    const readLevels = (texture, width, height) => {
      const framebuffer = context.createFramebuffer();
      context.bindFramebuffer(context.FRAMEBUFFER, framebuffer);
      const levels = [];
      for (let level = 0, levelWidth = width, levelHeight = height; ; level++) {
        context.framebufferTexture2D(context.FRAMEBUFFER, context.COLOR_ATTACHMENT0, context.TEXTURE_2D, texture, level);
        const data = new Uint8Array(levelWidth * levelHeight * 4);
        context.readPixels(0, 0, levelWidth, levelHeight, context.RGBA, context.UNSIGNED_BYTE, data);
        levels.push({ width: levelWidth, height: levelHeight, data: Array.from(data) });
        if (levelWidth === 1 && levelHeight === 1) break;
        levelWidth = Math.max(1, levelWidth >> 1);
        levelHeight = Math.max(1, levelHeight >> 1);
      }
      context.bindFramebuffer(context.FRAMEBUFFER, null);
      context.deleteFramebuffer(framebuffer);
      return levels;
    };
    const results = {};
    for (const { name, width, height, rgba } of inputs) {
      const texture = context.createTexture();
      context.bindTexture(context.TEXTURE_2D, texture);
      context.texImage2D(context.TEXTURE_2D, 0, context.RGBA8, width, height, 0, context.RGBA, context.UNSIGNED_BYTE, new Uint8Array(rgba));
      context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR_MIPMAP_LINEAR);
      context.viewport(3, 4, 5, 6);
      context.colorMask(true, false, true, false);
      const before = JSON.stringify([Array.from(context.getParameter(context.VIEWPORT)), Array.from(context.getParameter(context.COLOR_WRITEMASK)), context.getParameter(context.FRAMEBUFFER_BINDING) === null]);
      const baked = bakeNormalMapVariance(context, texture, width, height);
      const after = JSON.stringify([Array.from(context.getParameter(context.VIEWPORT)), Array.from(context.getParameter(context.COLOR_WRITEMASK)), context.getParameter(context.FRAMEBUFFER_BINDING) === null]);
      context.colorMask(true, true, true, true);
      const sampler = [context.getTexParameter(context.TEXTURE_2D, context.TEXTURE_BASE_LEVEL), context.getTexParameter(context.TEXTURE_2D, context.TEXTURE_MAX_LEVEL)];
      const first = readLevels(texture, width, height);
      bakeNormalMapVariance(context, texture, width, height);
      const second = readLevels(texture, width, height);
      const complete = context.getError() === 0;
      results[name] = { baked, restored: before === after, sampler, first, repeatable: JSON.stringify(first) === JSON.stringify(second), complete };
    }
    return results;
  }, cases);
}

const alphaOf = (level, texel = 0) => level.data[texel * 4 + 3];
const sizesOf = levels => levels.map(({ width, height }) => `${width}x${height}`);

test('the bake draws every level of the chain into the texture and puts the GL state back', async (context) => {
  await withDevServerPage(context, async (page) => {
    const results = await bakeInPage(page);
    for (const [name, result] of Object.entries(results)) {
      assert.equal(result.baked, true, `${name}: the pass returned false`);
      assert.equal(result.restored, true, `${name}: the pass changed the viewport, colour mask or framebuffer binding`);
      assert.deepEqual(result.sampler, [0, 1000], `${name}: the sampler's base and maximum level were left changed`);
      assert.equal(result.complete, true, `${name}: a GL error was raised`);
    }
    assert.deepEqual(sizesOf(results.wide.first), ['4x2', '2x1', '1x1']);
    assert.deepEqual(sizesOf(results.odd.first), ['5x3', '2x1', '1x1']);
  });
});

test('baking the same map twice gives the same bytes at every level', async (context) => {
  await withDevServerPage(context, async (page) => {
    const results = await bakeInPage(page);
    for (const [name, result] of Object.entries(results)) assert.equal(result.repeatable, true, `${name}: two bakes differ`);
  });
});

test('a flat map has no spread at any level and keeps its direction', async (context) => {
  await withDevServerPage(context, async (page) => {
    const { flat } = await bakeInPage(page);
    for (const level of flat.first) {
      for (let texel = 0; texel < level.width * level.height; texel++) assert.equal(alphaOf(level, texel), 0, `${level.width}x${level.height} texel ${texel}`);
    }
    assert.deepEqual(flat.first.at(-1).data.slice(0, 3), [128, 128, 255]);
  });
});

test('alternating tilted normals leave a spread of one minus the cosine of the tilt from level 1 down', async (context) => {
  await withDevServerPage(context, async (page) => {
    const { alternating } = await bakeInPage(page);
    assert.equal(alphaOf(alternating.first[0]), 0, 'level 0 holds single texels, so it has no spread');
    const expected = 1 - Math.cos(Math.PI / 6);
    for (const level of alternating.first.slice(1)) {
      for (let texel = 0; texel < level.width * level.height; texel++) {
        const measured = decodeSpread(alphaOf(level, texel));
        assert.ok(Math.abs(measured - expected) < 0.01, `${level.width}x${level.height}: spread ${measured.toFixed(4)}, expected ${expected.toFixed(4)}`);
      }
      assert.deepEqual(level.data.slice(0, 3), [128, 128, 255], 'the mean direction of opposite tilts is straight up');
    }
  });
});

test('a uniform tilt has no spread however far it is tilted, so a bevel that is one smooth facet stays sharp', async (context) => {
  await withDevServerPage(context, async (page) => {
    const { uniformTilt } = await bakeInPage(page);
    for (const level of uniformTilt.first) assert.equal(alphaOf(level), 0);
  });
});

test('the spread only reaches the texels whose block mixes normals', async (context) => {
  await withDevServerPage(context, async (page) => {
    const { halfMixed } = await bakeInPage(page);
    const firstLevel = halfMixed.first[1];
    assert.equal(alphaOf(firstLevel, 0), 0);
    assert.equal(alphaOf(firstLevel, 2), 0);
    assert.ok(decodeSpread(alphaOf(firstLevel, 1)) > 0.45, 'opposite 60 degree tilts average to a half-length normal');
  });
});

// The GPU pass keeps the means in 8-bit levels, the reference in floats, so a few steps of the sqrt code are allowed; the spread in the maps below is
// small, where one step of the code is only a few thousandths of the spread.
const MAXIMUM_DIRECTION_ERROR = 3;
const MAXIMUM_ALPHA_ERROR = 3;

test('the GPU levels match the CPU reference within the 8-bit chain, on odd sizes too', async (context) => {
  await withDevServerPage(context, async (page) => {
    const results = await bakeInPage(page);
    for (const name of ['wandering', 'wanderingSquare', 'alternating', 'halfMixed', 'odd']) {
      const { width, height, rgba } = CASES[name];
      const reference = buildNormalVarianceLevels(rgba, width, height);
      const measured = results[name].first;
      assert.deepEqual(sizesOf(measured), sizesOf(reference), `${name}: level sizes`);
      measured.forEach((level, index) => {
        let worstDirection = 0;
        let worstAlpha = 0;
        for (let texel = 0; texel < level.width * level.height; texel++) {
          const alphaError = Math.abs(level.data[texel * 4 + 3] - reference[index].data[texel * 4 + 3]);
          worstAlpha = Math.max(worstAlpha, alphaError);
          // A direction is only meaningful where the mean has length: skip texels whose normals cancel almost completely.
          if (decodeSpread(reference[index].data[texel * 4 + 3]) > 0.9) continue;
          for (let channel = 0; channel < 3; channel++) worstDirection = Math.max(worstDirection, Math.abs(level.data[texel * 4 + channel] - reference[index].data[texel * 4 + channel]));
        }
        assert.ok(worstDirection <= MAXIMUM_DIRECTION_ERROR, `${name} level ${index}: direction off by ${worstDirection}`);
        assert.ok(worstAlpha <= MAXIMUM_ALPHA_ERROR, `${name} level ${index}: spread code off by ${worstAlpha}`);
      });
    }
  });
});

test('the stored spread round-trips and never reads as an unbaked texture', () => {
  for (const spread of [0, 0.001, 0.05, 0.5]) assert.ok(Math.abs(decodeSpread(encodeSpread(spread)) - spread) < 0.01);
  assert.equal(encodeSpread(1), 254);
  assert.equal(encodeSpread(5), 254);
  assert.equal(encodeSpread(-1), 0);
});

test('a map that is not width x height RGBA bytes is refused by the reference with what to pass', () => {
  assert.throws(() => buildNormalVarianceLevels(new Uint8Array(12), 2, 2), /width x height x 4 RGBA bytes/);
  assert.throws(() => buildNormalVarianceLevels(new Uint8Array(16), 0, 2), /whole width and height/);
});

test('the specular fade of a shader with a normal map reads the baked spread', () => {
  assert.match(createFragmentShader(['normalMap']), /normalMapSpread/);
});

test('bakeNormalMapVariance skips restoring a bound program already flagged for deletion', async (context) => {
  await withDevServerPage(context, async (page) => {
    const result = await page.evaluate(async () => {
      const { bakeNormalMapVariance } = await import('/src/normal-map-variance.js');
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
      };
      const dummyProgram = gl.createProgram();
      const vertexShader = compile(gl.VERTEX_SHADER, '#version 300 es\nvoid main(){gl_Position=vec4(0.0,0.0,0.0,1.0);}');
      const fragmentShader = compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float;out vec4 o;void main(){o=vec4(1.0);}');
      gl.attachShader(dummyProgram, vertexShader);
      gl.attachShader(dummyProgram, fragmentShader);
      gl.linkProgram(dummyProgram);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.useProgram(dummyProgram);
      gl.deleteProgram(dummyProgram);
      gl.getError();

      const normalTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, normalTexture);
      const texels = new Uint8Array(8 * 8 * 4).fill(255);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, texels);
      const baked = bakeNormalMapVariance(gl, normalTexture, 8, 8);
      const glError = gl.getError();
      const currentProgram = gl.getParameter(gl.CURRENT_PROGRAM);
      gl.deleteTexture(normalTexture);
      return { baked, glError, hasCurrentProgram: currentProgram !== null };
    });
    assert.equal(result.baked, true);
    assert.equal(result.glError, 0);
    assert.equal(result.hasCurrentProgram, false);
  });
});
