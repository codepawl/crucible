// Whole-frame GPU time of a stripes-behind-a-ball scene with and without transmissive glass (issue #3148, round 3).
// Native timer query around renderer.render, no readback. Run through gpu-lock: node scripts/.bench-glass-3148.mjs
import { constants, setPriority, loadavg, cpus } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const width = 1920;
const height = 1080;
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-webgl'] });
try {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route('**/bench.html', route => route.fulfill({ contentType: 'text/html', body: `<canvas style="width:${width}px;height:${height}px;display:block"></canvas>` }));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/bench.html`);
  const report = await page.evaluate(async () => {
    const { CrucibleRenderer } = await import('/src/renderer.js');
    await import('/src/liquid-shader.js');
    const { box, sphere } = await import('/src/geometry.js');
    const canvas = document.querySelector('canvas');
    const stripeColors = [[0.9, 0.1, 0.1], [0.95, 0.75, 0.1], [0.1, 0.65, 0.2], [0.1, 0.4, 0.9], [0.6, 0.15, 0.8], [0.95, 0.95, 0.95]];
    const matrix = (scale, x, y, z) => new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, x, y, z, 1]);
    const boxGeometry = box(0, 1);
    const ballGeometry = sphere(64, 40);
    const surface = color => ({ tag: 'surface', color, metallic: 0, roughness: 0.6 });
    const baseParts = [
      { name: 'floor', geometry: boxGeometry, matrix: matrix([8, 0.1, 6], 0, -0.05, 0), material: surface([0.55, 0.55, 0.58]) },
      ...stripeColors.map((color, index) => ({ name: `stripe${index}`, geometry: boxGeometry, matrix: matrix([0.5, 1.6, 0.1], -1.25 + index * 0.5, 0.8, -1.2), material: surface(color) })),
    ];
    const glass = (transmission, thickness) => ({ name: 'glass', geometry: ballGeometry, matrix: matrix([1, 1, 1], 0, 0.6, 0.2), material: { tag: 'surface', color: [1, 1, 1], metallic: 0, roughness: 0.05, transmission, ior: 1.5, thickness, attenuationColor: [0.8, 0.95, 1], attenuationDistance: 2 } });
    const opaqueBall = { ...glass(0, 0), material: { tag: 'surface', color: [0.8, 0.9, 1], metallic: 0, roughness: 0.05 } };
    const variants = {
      opaqueBall: [...baseParts, opaqueBall],
      glassThin: [...baseParts, glass(1, 0)],
      glassBall: [...baseParts, glass(1, 2)],
    };
    const frame = { eye: [0, 1.0, 5.2], target: [0, 0.7, 0], fov: 32, time: 1 };
    const renderers = Object.fromEntries(Object.entries(variants).map(([name, parts]) => [name, new CrucibleRenderer(canvas, parts, { hdr: true, pixelRatio: 1, samples: 4 })]));
    const context = Object.values(renderers)[0].context;
    const timer = context.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!timer) throw new Error('Native GPU timer unavailable');
    const timeFrame = async renderer => {
      const query = context.createQuery();
      context.beginQuery(timer.TIME_ELAPSED_EXT, query);
      renderer.render(frame);
      context.endQuery(timer.TIME_ELAPSED_EXT);
      context.flush();
      const started = performance.now();
      while (!context.getQueryParameter(query, context.QUERY_RESULT_AVAILABLE)) {
        if (performance.now() - started > 5000) throw new Error('GPU query timed out');
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      if (context.getParameter(timer.GPU_DISJOINT_EXT)) return NaN;
      const nanoseconds = context.getQueryParameter(query, context.QUERY_RESULT);
      context.deleteQuery(query);
      return nanoseconds / 1e6;
    };
    const samples = Object.fromEntries(Object.keys(variants).map(name => [name, []]));
    for (const renderer of Object.values(renderers)) for (let warm = 0; warm < 5; warm++) renderer.render(frame);
    for (let round = 0; round < 6; round++) {
      for (const [name, renderer] of Object.entries(renderers)) {
        for (let index = 0; index < 20; index++) samples[name].push(await timeFrame(renderer));
      }
    }
    const summary = {};
    for (const [name, values] of Object.entries(samples)) {
      const sorted = values.filter(Number.isFinite).sort((first, second) => first - second);
      summary[name] = { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1], count: sorted.length };
    }
    summary.batches = Object.fromEntries(Object.entries(renderers).map(([name, renderer]) => [name, renderer.batches.map(batch => `${batch.parts[0].name}:${batch.layerState?.[9]}`).filter(text => text.startsWith('glass'))]));
    summary.canvas = [canvas.width, canvas.height];
    return summary;
  });
  report.machine = { loadAverage: loadavg(), cpus: cpus().length };
  console.log(JSON.stringify(report, null, 1));
} finally {
  await browser.close();
  await server.close();
}
