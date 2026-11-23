// Far stills of the boulder_01 scan: LOD0 against each LOD at its switch distance, with RMSE (0 to 255, RGB), CPU (SwiftShader).
//   node artifacts/2985-tools/stills.mjs <outputFolder> <blendSeams: auto|never>
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const [folder, blendSeams = 'auto', stressRadii = 0] = process.argv.slice(2);
const scanId = process.env.SCAN ?? 'boulder_01';
const scanFolder = 'C:/Users/nxan2/Documents/crucible/artifacts/2985/scans/' + scanId + '/';
const modelFolder = scanId === 'boulder_01' ? 'C:/Users/nxan2/Documents/social/assets-lib/models/boulder_01/' : scanFolder;
const gltfName = scanId === 'boulder_01' ? 'boulder_01_2k.gltf' : scanId + '.gltf';
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('console', message => console.log('page:', message.text()));
  await page.route('**/stills.html', route => route.fulfill({ contentType: 'text/html', body: '<canvas style="width:960px;height:540px;display:block"></canvas>' }));
  await page.route('**/boulder/**', async route => {
    const name = new URL(route.request().url()).pathname.replace('/boulder/', '');
    await route.fulfill({ body: await readFile(modelFolder + decodeURIComponent(name)) });
  });
  await page.goto(`${serverUrl}/stills.html`);
  const result = await page.evaluate(async ({ blendSeams, stressRadii, gltfName }) => {
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { loadGltf } = await import('/src/gltf.js');
    const { generateGeometryLods } = await import('/src/mesh-lod.js');
    const canvas = document.querySelector('canvas');
    const loaded = await loadGltf('/boulder/' + gltfName);
    const part = [...(loaded.parts ?? loaded)].sort((x, y) => y.geometry.indices.length - x.geometry.indices.length)[0];
    const positions = part.geometry.positions;
    const matrix = part.matrix ? Array.from(part.matrix) : [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < positions.length; index += 3) {
      const [x, y, z] = [positions[index], positions[index + 1], positions[index + 2]];
      for (let axis = 0; axis < 3; axis++) {
        const world = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
        low[axis] = Math.min(low[axis], world);
        high[axis] = Math.max(high[axis], world);
      }
    }
    const target = low.map((value, axis) => (value + high[axis]) / 2);
    const radius = Math.hypot(...high.map((value, axis) => value - low[axis])) / 2;
    const levels = generateGeometryLods(part.geometry, { ratios: [0.5, 0.25, 0.1], blendSeams });
    const fov = 45;
    const lodPixelError = 0.5;
    const pixelsPerUnit = canvas.height / 2 / Math.tan(fov * Math.PI / 360);
    const direction = [0.6, 0.35, 1];
    const directionLength = Math.hypot(...direction);
    function draw(geometry, distance, drawFov = fov) {
      const eye = target.map((value, axis) => value + direction[axis] / directionLength * distance);
      const renderer = new CrucibleRenderer(canvas, [{ ...part, geometry }], { pixelRatio: 1, samples: 4, ground: false, hdr: false });
      const camera = { eye, target, fov: drawFov };
      renderer.render(camera);
      const url = canvas.toDataURL('image/png');
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      const gl = renderer.context;
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      renderer.dispose();
      return { url, pixels, camera };
    }
    const rows = [];
    const pictures = [];
    for (const level of levels.slice(1)) {
      const switchDistance = level.error * pixelsPerUnit / lodPixelError;
      const eye = target.map((value, axis) => value + direction[axis] / directionLength * switchDistance);
      const eyeInside = eye.every((value, axis) => value > low[axis] && value < high[axis]);
      if (eyeInside) {
        rows.push({ level: level.level, view: 'true', skipped: 'the camera at the switch distance sits inside the object bounds', switchDistance, radius, switchInRadii: switchDistance / radius, eye, low, high });
        continue;
      }
      for (const view of ['true', 'zoom']) {
        const drawFov = view === 'zoom' ? Math.min(fov, 2 * Math.atan(radius * 1.05 / switchDistance) * 180 / Math.PI) : fov;
        const base = draw(levels[0].geometry, switchDistance, drawFov);
        const reduced = draw(level.geometry, switchDistance, drawFov);
        let squared = 0;
        for (let index = 0; index < base.pixels.length; index += 4) for (let channel = 0; channel < 3; channel++) squared += (base.pixels[index + channel] - reduced.pixels[index + channel]) ** 2;
        const rmse = Math.sqrt(squared / (base.pixels.length / 4 * 3));
        rows.push({ level: level.level, view, ratio: level.ratio, path: level.path, triangles: level.triangles, target: level.targetTriangles, error: level.error, switchDistance, switchInRadii: switchDistance / radius, radius, rmse, camera: base.camera, size: [canvas.width, canvas.height], backend: 'swiftshader', samples: 4, lodPixelError, worldBounds: { low, high } });
        pictures.push({ level: level.level, view, lod0: base.url, lod: reduced.url });
      }
    }
    return { rows, pictures };
  }, { blendSeams, stressRadii: Number(stressRadii), gltfName });
  await mkdir(folder, { recursive: true });
  const suffix = picture => `${scanId}-level${picture.level}-${picture.view}`;
  for (const picture of result.pictures) {
    for (const [name, url] of [['lod0', picture.lod0], ['lod', picture.lod]]) {
      await writeFile(path.join(folder, `${suffix(picture)}-${name}-r4.png`), Buffer.from(url.split(',')[1], 'base64'));
    }
  }
  for (const row of result.rows) await writeFile(path.join(folder, `${scanId}-level${row.level}-${row.view}-r4.json`), JSON.stringify(row, null, 2));
  console.log(JSON.stringify(result.rows.map(({ camera, size, worldBounds, low, high, eye, ...rest }) => rest), null, 1));
} finally {
  await browser.close();
  await server.close();
}
