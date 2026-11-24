// node lake.mjs: pixel hash of one lake scene (water reflection, ripples, blur) drawn by origin/main and by the branch.
import { chromium } from 'playwright';
import { createServer } from 'vite';
const worktree = 'C:/Users/nxan2/Documents/crucible/.claude/worktrees/w-2874';
const server = await createServer({ root: worktree, server: { port: 0, fs: { strict: false } }, logLevel: 'error', resolve: { alias: { 'gl-matrix': `${worktree}/node_modules/gl-matrix` } } });
await server.listen();
const origin = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', error => console.error('pageerror', error.message));
await page.goto(`${origin}/bench/reference/harness.html`, { timeout: 120000 });
for (const [label, root] of [['origin/main', '/@fs/C:/Users/nxan2/Documents/crucible/artifacts/2874/r12/main/src'], ['branch', '/src']]) {
  const result = await page.evaluate(async ({ root }) => {
    const { CrucibleRenderer } = await import(/* @vite-ignore */ `${root}/renderer.js`);
    const { box } = await import(/* @vite-ignore */ `${root}/geometry.js`);
    const water = await import(/* @vite-ignore */ `${root}/water-reflection.js`);
    const cube = box(0, 1);
    const placed = (translation, scale, material) => ({ name: 'part', geometry: cube, matrix: new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]), material: { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.8, emission: 0, ...material } });
    const parts = [placed([0, -2, 0], [4000, 2, 4000]), placed([0, -1.5, 0], [900, 1, 900], { color: [0.02, 0.05, 0.08], roughness: 0.04 }), placed([30, 4, -80], [8, 8, 8]), placed([-40, 2, -60], [6, 4, 6], { color: [0.7, 0.2, 0.1] })];
    const marked = water.applyWaterReflection(parts);
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    canvas.style.cssText = 'width:960px;height:540px;position:fixed;left:0;top:0';
    document.body.append(canvas);
    const renderer = new CrucibleRenderer(canvas, marked.parts, { ground: false, hdr: true, depth: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 1024, world: true });
    renderer.resize();
    water.attachWaterReflection(renderer, marked.surface);
    const frame = { eye: [0, 6, 60], target: [0, 0, -60], up: [0, 1, 0], fov: 40, time: 0, wind: 0, exposure: 1, effects: {} };
    renderer.render(frame);
    renderer.render(frame);
    const flat = document.createElement('canvas');
    flat.width = 960;
    flat.height = 540;
    const context = flat.getContext('2d');
    context.drawImage(canvas, 0, 0);
    const raw = context.getImageData(0, 0, 960, 540).data;
    const digest = await crypto.subtle.digest('SHA-256', raw);
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
    let lit = 0;
    for (let index = 0; index < raw.length; index += 4) lit += raw[index] + raw[index + 1] + raw[index + 2];
    renderer.dispose?.();
    canvas.remove();
    return { hash, meanChannel: lit / (raw.length / 4 * 3), placed: marked.report.placed };
  }, { root });
  console.log(label, JSON.stringify(result));
}
await browser.close();
await server.close();
