// A browser test (headless Chrome): the default frame path of a textured, normal-mapped glTF raises no WebGL error (#3150).
// It is not a fast test: it starts Chrome, so it stays out of scripts/fast-tests.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDevServerPage } from './helpers/dev-server-browser.js';
import { installGlErrorTrace } from './helpers/gl-error-trace.js';

const FRAME_COUNT = 4;

async function drawFramesAndCollectErrors(page) {
  const task = async ({ traceSource, frameCount }) => {
    const installTrace = new Function(`return (${traceSource})`)();
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createSharedTextures, loadGltf } = await import('/src/gltf.js');
    const model = await fetch('/sample-model.glb').then((response) => response.blob());
    const asset = await loadGltf(model, { baseUrl: location.origin + '/', sharedTextures: createSharedTextures() });
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    document.body.append(canvas);
    const renderer = new CrucibleRenderer(canvas, asset.parts, { hdr: true, samples: 4, pixelRatio: 1 });
    const trace = installTrace(renderer.context);
    const frame = { eye: [2.5, 1.5, 3], target: [0, 0.5, 0], fov: 40, exposure: 1 };
    for (let index = 0; index < frameCount; index++) {
      renderer.render({ ...frame, time: index / 60 });
    }
    const pendingError = renderer.context.getError();
    return { first: trace.first, errors: trace.errors.length, callCount: trace.callCount, pendingError, partCount: asset.parts.length };
  };
  return page.evaluate(task, { traceSource: installGlErrorTrace.toString(), frameCount: FRAME_COUNT });
}

test('the default renderer raises no WebGL error drawing a textured, normal-mapped glTF', async (context) => {
  await withDevServerPage(context, async (page) => {
    const result = await drawFramesAndCollectErrors(page);
    assert.ok(result.partCount > 0, 'the model has parts');
    assert.equal(result.first, null, `the first failing call: ${JSON.stringify(result.first)}`);
    assert.equal(result.pendingError, 0);
  });
});

test('creating a second renderer on a disposed canvas raises no WebGL error when baking normal maps', async (context) => {
  await withDevServerPage(context, async (page) => {
    const result = await page.evaluate(async ({ traceSource, frameCount }) => {
      const installTrace = new Function(`return (${traceSource})`)();
      const { CrucibleRenderer } = await import('/src/renderer.js');
      const { createSharedTextures, loadGltf } = await import('/src/gltf.js');
      const model = await fetch('/sample-model.glb').then((response) => response.blob());
      const asset = await loadGltf(model, { baseUrl: location.origin + '/', sharedTextures: createSharedTextures() });
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      document.body.append(canvas);
      const frame = { eye: [2.5, 1.5, 3], target: [0, 0.5, 0], fov: 40, exposure: 1 };

      const firstRenderer = new CrucibleRenderer(canvas, asset.parts, { hdr: true, samples: 4, pixelRatio: 1 });
      firstRenderer.render(frame);
      const sharedContext = firstRenderer.context;
      firstRenderer.dispose();

      const trace = installTrace(sharedContext);
      const secondRenderer = new CrucibleRenderer(canvas, asset.parts, { hdr: true, samples: 4, pixelRatio: 1 });
      for (let index = 0; index < frameCount; index++) {
        secondRenderer.render({ ...frame, time: index / 60 });
      }
      const pendingError = sharedContext.getError();
      secondRenderer.dispose();
      return {
        first: trace.first,
        errors: trace.errors.length,
        pendingError,
      };
    }, { traceSource: installGlErrorTrace.toString(), frameCount: FRAME_COUNT });

    assert.equal(result.first, null, `the first failing call: ${JSON.stringify(result.first)}`);
    assert.equal(result.errors, 0);
    assert.equal(result.pendingError, 0);
  });
});
