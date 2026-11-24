// node render.mjs <variants.mjs>: renders each {name, dir, recipe, root: 'branch'|'base', width, height, label, mirrorScale} to <dir>/<name>.png and .json.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { texturePayload, skyClouds, pageSetup } from './scene-assets.mjs';

const worktree = 'C:/Users/nxan2/Documents/crucible/.claude/worktrees/w-2874';
const baseRoot = process.env.BASE_SRC ?? '/@fs/C:/Users/nxan2/Documents/crucible/artifacts/2874/r13/base/src';
const { variants } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
// COMPONENT=reflection keeps only the mirror term of the water line, COMPONENT=bed only the bed (the lit surface without its sky reflection).
const component = process.env.COMPONENT ?? '';
const componentPlugin = {
  name: 'puddle-component',
  transform(code, id) {
    if (!component || !id.includes('water-reflection.js')) return null;
    const mirrorTerm = 'mirrored * ${REFLECTION_GAIN} * fresnelWeight';
    const bedTerm = 'max(radiance - skyLight * max(mirrorWeight, waterEdgeCover), vec3(0.0))';
    if (!code.includes(mirrorTerm) || !code.includes(bedTerm)) throw new Error('water line changed: update patch1');
    return code.replace(component === 'reflection' ? bedTerm : mirrorTerm, 'vec3(0.0)');
  },
};
const server = await createServer({ plugins: [componentPlugin],  root: worktree, server: { port: 0, fs: { strict: false } }, logLevel: 'error', resolve: { alias: { 'gl-matrix': `${worktree}/node_modules/gl-matrix` } } });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', error => console.error('pageerror', error.message));
await page.goto(`${origin}/bench/reference/harness.html`, { timeout: 120000 });
for (const variant of variants) {
  const width = variant.width ?? 960;
  const height = variant.height ?? 540;
  const root = variant.root === 'base' ? baseRoot : '/src';
  const result = await page.evaluate(async ({ root, payload, hdr, setup, recipeJson, label, width, height, mirrorScale, noMirror, timing }) => {
    const recipe = JSON.parse(recipeJson);
    const { createAgentScene, loadAllAgentSceneModules } = await import(/* @vite-ignore */ `${root}/agent-scene.js`);
    const { agentEnvironmentMap } = await import(/* @vite-ignore */ `${root}/agent-look.js`);
    const { CrucibleRenderer } = await import(/* @vite-ignore */ `${root}/renderer.js`);
    await loadAllAgentSceneModules();
    const pool = await new Function('return ' + setup)()(payload, hdr, root);
    const scene = createAgentScene(recipe, {}, { sequenceFrames: pool });
    const environment = { ...scene.environment, map: agentEnvironmentMap(scene.environment) };
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.style.cssText = `width:${width}px;height:${height}px;position:fixed;left:0;top:0`;
    document.body.append(canvas);
    const renderer = new CrucibleRenderer(canvas, scene.parts, { ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, world: true, environment, shadowBounds: scene.shadow });
    renderer.resize();
    const water = await import(/* @vite-ignore */ `${root}/water-reflection.js`);
    if (recipe.environment.wetness > 0 && !noMirror) {
      if (water.attachWetMirror && !mirrorScale) water.attachWetMirror(renderer, scene.parts); else water.attachWaterReflection(renderer, water.wetMirrorSurface(scene.parts), mirrorScale ? { scale: mirrorScale } : undefined);
    }
    const frame = { ...scene.camera, environment, time: 0, wind: 0, exposure: 1, effects: {} };
    renderer.render(frame);
    renderer.render(frame);
    const flat = document.createElement('canvas');
    flat.width = width;
    flat.height = height;
    const context = flat.getContext('2d');
    context.drawImage(canvas, 0, 0);
    const raw = context.getImageData(0, 0, width, height).data;
    if (label) {
      context.font = 'bold 26px sans-serif';
      context.fillStyle = 'rgba(0,0,0,0.6)';
      context.fillRect(0, 0, width, 40);
      context.fillStyle = '#fff';
      context.fillText(label, 14, 29);
    }
    const gl = renderer.context;
    const timings = [];
    if (timing) {
      for (let repeat = 0; repeat < 15; repeat++) {
        gl.finish();
        const started = performance.now();
        for (let index = 0; index < 120; index++) renderer.render({ ...frame, eye: [frame.eye[0] + (repeat * 60 + index + 1) * 0.0007, frame.eye[1], frame.eye[2]] });
        gl.finish();
        timings.push((performance.now() - started) / 120);
      }
    }
    const digest = await crypto.subtle.digest('SHA-256', raw);
    const output = { image: flat.toDataURL('image/png').split(',')[1], pixelHash: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''), features: [...renderer.shaderFeatures].sort(), glError: gl.getError(), timings };
    renderer.dispose?.();
    canvas.remove();
    return output;
  }, { root, payload: texturePayload, hdr: skyClouds, setup: pageSetup, recipeJson: JSON.stringify(variant.recipe), label: variant.label ?? '', width, height, mirrorScale: variant.mirrorScale ?? null, noMirror: variant.noMirror ?? false, timing: variant.timing ?? false });
  const { image, ...summary } = result;
  writeFileSync(`${variant.dir}/${variant.name}.png`, Buffer.from(image, 'base64'));
  writeFileSync(`${variant.dir}/${variant.name}.json`, JSON.stringify({ size: [width, height], samples: 4, backend: 'chrome d3d11', root: variant.root ?? 'branch', camera: variant.recipe.camera, environment: variant.recipe.environment, recipe: variant.recipe, ...summary }, null, 1));
  console.log(variant.name, summary.pixelHash.slice(0, 16), summary.glError, summary.features.includes('wetness') ? 'wet' : 'dry');
}
await browser.close();
await server.close();
