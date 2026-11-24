// Meshes a small voxel landscape and writes portrait stills of it:
//   node scripts/capture-voxel-terrain.mjs <folder>
// wide.png and slope.png show the whole landscape from two sides in a steep, map-like view (the landscape is 80 x 128 cells, longer than wide, so it can fill a tall frame) that fills at least half of
// the frame height, with at least 50 px of margin on every side. shore.png is a close-up of the lake edge. All are
// 1080x1920. The margins and the height share are measured on the pixels (against a render of the same view without the
// landscape) and printed per still.
//   The stills use edges: 'closed' (side walls and a base, like a diorama); EDGES=open cuts the landscape at the grid
//   bounds; SMOOTHING=<0 to 4> changes the blur.
import { mkdir, writeFile } from 'node:fs/promises';
import { constants, setPriority } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createVoxelTerrain } from '../src/voxel-terrain.js';
import { fitSteepView, projectPoint } from './voxel-camera.mjs';
import { makeLandscape } from './voxel-landscape.mjs';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
const folder = process.argv[2];
if (!folder) throw new Error('Give the output folder.');
const WIDTH = 1080;
const HEIGHT = 1920;
const MARGIN = 50;
const MINIMUM_HEIGHT_SHARE = 0.55;
const GRID = [80, 40, 128];
const SHORE_EYE = (process.env.SHORE_EYE ?? '154,47,157').split(',').map(Number);
const SHORE_TARGET = (process.env.SHORE_TARGET ?? '48,6,118').split(',').map(Number);
const silhouetteCrop = { left: 140, top: 620, right: 700, bottom: 1100 };
const PALETTE = ['grass', 'rock', 'sand', 'water'];
const CENTRE = [40, 10, 64];
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-audio-output'],
});
try {
  const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  await page.route('**/voxel.html', route => route.fulfill({ contentType: 'text/html', body: `<canvas width="${WIDTH}" height="${HEIGHT}" style="width:${WIDTH}px;height:${HEIGHT}px;display:block"></canvas>` }));
  await page.goto(`${serverUrl}/voxel.html`);
  const smoothing = Number(process.env.SMOOTHING ?? 1);
  const edges = process.env.EDGES ?? 'closed';
  const { occupancy, materials } = makeLandscape(GRID);
  const { parts } = createVoxelTerrain({ grid: GRID, cellSize: 1, palette: PALETTE, occupancy, materials, smoothing, edges });
  const fitOptions = { minimumHeightShare: MINIMUM_HEIGHT_SHARE };
  const views = {
    wide: fitSteepView(parts, 20, CENTRE, WIDTH, HEIGHT, MARGIN, fitOptions).view,
    slope: fitSteepView(parts, -25, CENTRE, WIDTH, HEIGHT, MARGIN, fitOptions).view,
    shore: { eye: SHORE_EYE, target: SHORE_TARGET },
  };
  const results = await page.evaluate(async ({ smoothing, edges, views, grid, palette, silhouetteCrop }) => {
    await import('/src/world-material-shader.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createVoxelTerrain } = await import('/src/voxel-terrain.js');
    const { makeLandscape } = await import('/scripts/voxel-landscape.mjs');
    const { occupancy, materials } = makeLandscape(grid);
    const terrain = createVoxelTerrain({ grid, cellSize: 1, palette, occupancy, materials, smoothing, edges });
    // The renderer tints any surface below the water level by the water's absorption, which would turn the lower side walls
    // teal. The stills switch the absorption off so a wall shows its own colour.
    for (const part of terrain.parts) if (part.material.tag === 'water') Object.assign(part.material, { absorption: [0, 0, 0], turbidity: 0 });
    const canvas = document.querySelector('canvas');
    // The sun comes from the side the camera looks from, so both side walls it can see are lit.
    const sunFor = name => (name === 'slope' ? [-3, 5, 4] : [3, 5, 4]);
    const environmentFor = name => ({ lightDirection: sunFor(name), daylight: 1, fogDensity: 0.0004 });
    const readPixels = () => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const context = copy.getContext('2d');
      context.drawImage(canvas, 0, 0);
      return context.getImageData(0, 0, copy.width, copy.height).data;
    };
    const pictures = {};
    const withLandscape = {};
    const renderer = new CrucibleRenderer(canvas, terrain.parts, { hdr: true, depth: true, world: true, ground: false, pixelRatio: 1, samples: 4 });
    for (const [name, view] of Object.entries(views)) {
      renderer.render({ ...view, time: 1, environment: environmentFor(name) });
      pictures[name] = canvas.toDataURL('image/png');
      withLandscape[name] = readPixels();
    }
    renderer.dispose();
    // The same views without the landscape: any pixel that differs belongs to it.
    const empty = new CrucibleRenderer(canvas, [], { hdr: true, depth: true, world: true, ground: false, pixelRatio: 1, samples: 4 });
    const boxes = {};
    for (const [name, view] of Object.entries(views)) {
      empty.render({ ...view, time: 1, environment: environmentFor(name) });
      const background = readPixels();
      const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      for (let pixel = 0; pixel < background.length / 4; pixel++) {
        const offset = pixel * 4;
        const difference = Math.abs(withLandscape[name][offset] - background[offset]) + Math.abs(withLandscape[name][offset + 1] - background[offset + 1]) + Math.abs(withLandscape[name][offset + 2] - background[offset + 2]);
        if (difference <= 24) continue;
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        box.left = Math.min(box.left, x);
        box.right = Math.max(box.right, x);
        box.top = Math.min(box.top, y);
        box.bottom = Math.max(box.bottom, y);
      }
      boxes[name] = box;
    }
    empty.dispose();
    // The wall faces are the pixels that change when the wall triangles (listed last in the index buffer) are left out.
    const [landPart, ...otherParts] = terrain.parts;
    const topIndices = landPart.geometry.indices.subarray(0, landPart.geometry.indices.length - terrain.stats.wallTriangles * 3);
    const topOnly = new CrucibleRenderer(canvas, [{ ...landPart, geometry: { ...landPart.geometry, indices: topIndices } }, ...otherParts], { hdr: true, depth: true, world: true, ground: false, pixelRatio: 1, samples: 4 });
    const walls = {};
    const distance = (first, firstOffset, second, secondOffset) => Math.abs(first[firstOffset] - second[secondOffset]) + Math.abs(first[firstOffset + 1] - second[secondOffset + 1]) + Math.abs(first[firstOffset + 2] - second[secondOffset + 2]);
    const toLab = ([red, green, blue]) => {
      const linear = [red, green, blue].map(value => { const unit = value / 255; return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4; });
      const x = (0.4124 * linear[0] + 0.3576 * linear[1] + 0.1805 * linear[2]) / 0.95047;
      const y = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      const z = (0.0193 * linear[0] + 0.1192 * linear[1] + 0.9505 * linear[2]) / 1.08883;
      const labCurve = value => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
      return { lightness: 116 * labCurve(y) - 16, a: 500 * (labCurve(x) - labCurve(y)), b: 200 * (labCurve(y) - labCurve(z)) };
    };
    for (const [name, view] of Object.entries(views)) {
      topOnly.render({ ...view, time: 1, environment: environmentFor(name) });
      const top = readPixels();
      const full = withLandscape[name];
      const sum = [0, 0, 0];
      let count = 0;
      const isWall = new Uint8Array(canvas.width * canvas.height);
      for (let pixel = 0; pixel < isWall.length; pixel++) {
        if (distance(full, pixel * 4, top, pixel * 4) > 24) isWall[pixel] = 1;
      }
      // The colour is averaged over the wall pixels that are 3 px or more inside the wall, so anti-aliased edges do not count.
      const inside = (x, y) => x >= 0 && y >= 0 && x < canvas.width && y < canvas.height && isWall[y * canvas.width + x] === 1;
      for (let pixel = 0; pixel < isWall.length; pixel++) {
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        if (!isWall[pixel] || ![[-3, 0], [3, 0], [0, -3], [0, 3]].every(([stepX, stepY]) => inside(x + stepX, y + stepY))) continue;
        for (let channel = 0; channel < 3; channel++) sum[channel] += full[pixel * 4 + channel];
        count++;
      }
      // Width of the change from top colour to wall colour, down every column where the wall starts under visible top surface.
      const widths = [];
      for (let x = 0; x < canvas.width; x++) {
        for (let y = 10; y < canvas.height - 10; y++) {
          const index = y * canvas.width + x;
          if (!isWall[index] || isWall[index - canvas.width]) continue;
          const above = ((y - 8) * canvas.width + x) * 4;
          const below = ((y + 8) * canvas.width + x) * 4;
          if (!isWall[(y + 8) * canvas.width + x] || isWall[(y - 8) * canvas.width + x]) continue;
          const span = [0, 1, 2].map(channel => full[below + channel] - full[above + channel]);
          const spanLength = Math.hypot(...span);
          if (spanLength < 40) continue;
          let width = 0;
          for (let row = y - 8; row <= y + 8; row++) {
            const offset = (row * canvas.width + x) * 4;
            const fraction = [0, 1, 2].reduce((total, channel) => total + (full[offset + channel] - full[above + channel]) * span[channel], 0) / (spanLength * spanLength);
            if (fraction > 0.1 && fraction < 0.9) width++;
          }
          widths.push(width);
          break;
        }
      }
      widths.sort((first, second) => first - second);
      const mean = sum.map(value => value / Math.max(1, count));
      // Steps in the wall's top silhouette inside the crop: the highest wall pixel of each column, and the largest change between neighbouring columns.
      let largestStep = null;
      let largestKink = null;
      if (name === 'shore') {
        const tops = [];
        for (let x = silhouetteCrop.left; x < silhouetteCrop.right; x++) {
          let columnTop = null;
          for (let y = silhouetteCrop.top; y < silhouetteCrop.bottom; y++) {
            if (isWall[y * canvas.width + x]) { columnTop = y; break; }
          }
          tops.push(columnTop);
        }
        largestStep = 0;
        largestKink = 0;
        for (let index = 1; index < tops.length - 1; index++) {
          if (tops[index] === null || tops[index - 1] === null || tops[index + 1] === null) continue;
          largestStep = Math.max(largestStep, Math.abs(tops[index + 1] - tops[index]));
          // How far a column's top sits off the straight line between its neighbours: a smooth edge, however steep, gives about 0.
          largestKink = Math.max(largestKink, Math.abs(tops[index] - (tops[index - 1] + tops[index + 1]) / 2));
        }
      }
      walls[name] = { largestStep, largestKink, pixels: count, mean, lab: toLab(mean), transitionWidth: widths.length ? widths[Math.floor(widths.length / 2)] : null, columns: widths.length };
    }
    topOnly.dispose();
    // The water outline: water pixels are the cyan ones. Along every row and every column, each run of water has two ends;
    // an end is followed from line to line (to the nearest end of the previous line within 6 px), and `kink` is how far
    // an end sits off the straight line between the ends on the lines before and after it. A smooth shore, however
    // curved or steep, gives a kink near 0, a stair step gives its height.
    const isWater = (pixels, pixel) => pixels[pixel * 4 + 1] - pixels[pixel * 4] > 35 && pixels[pixel * 4 + 2] - pixels[pixel * 4] > 35;
    const maskTests = {
      water: isWater,
      grass: (pixels, pixel) => pixels[pixel * 4 + 1] - pixels[pixel * 4] > 12 && pixels[pixel * 4 + 1] - pixels[pixel * 4 + 2] > 25 && !isWater(pixels, pixel),
      sand: (pixels, pixel) => pixels[pixel * 4] > 170 && pixels[pixel * 4] - pixels[pixel * 4 + 1] >= 0 && pixels[pixel * 4] - pixels[pixel * 4 + 1] < 25 && pixels[pixel * 4] - pixels[pixel * 4 + 2] > 30,
    };
    const outlines = {};
    for (const [name] of Object.entries(views)) for (const [maskName, isInside] of Object.entries(maskTests)) {
      const pixels = withLandscape[name];
      let worst = { kink: 0, at: [0, 0], direction: '' };
      for (const direction of ['rows', 'columns']) {
        const lines = direction === 'rows' ? canvas.height : canvas.width;
        const length = direction === 'rows' ? canvas.width : canvas.height;
        const endsOf = line => {
          const ends = [];
          let inside = false;
          for (let position = 0; position < length; position++) {
            const pixel = direction === 'rows' ? line * canvas.width + position : position * canvas.width + line;
            const water = isInside(pixels, pixel);
            if (water !== inside) { ends.push(position); inside = water; }
          }
          return ends;
        };
        const all = [];
        for (let line = 0; line < lines; line++) all.push(endsOf(line));
        const nearest = (ends, value) => ends.reduce((best, end) => (best === null || Math.abs(end - value) < Math.abs(best - value) ? end : best), null);
        for (let line = 1; line < lines - 1; line++) {
          for (const end of all[line]) {
            const before = nearest(all[line - 1], end);
            const after = nearest(all[line + 1], end);
            if (before === null || after === null || Math.abs(before - end) > 6 || Math.abs(after - end) > 6) continue;
            const kink = Math.abs(end - (before + after) / 2);
            if (kink > worst.kink) worst = { kink, at: direction === 'rows' ? [end, line] : [line, end], direction };
          }
        }
      }
      outlines[`${name} ${maskName}`] = worst;
    }
    return { pictures, boxes, walls, outlines };
  }, { smoothing, edges, views, grid: GRID, palette: PALETTE, silhouetteCrop });
  await mkdir(folder, { recursive: true });
  for (const [name, image] of Object.entries(results.pictures)) await writeFile(`${folder}/${name}.png`, Buffer.from(image.split(',')[1], 'base64'));
  for (const [name, box] of Object.entries(results.boxes)) {
    const share = (box.bottom - box.top + 1) / HEIGHT;
    console.log(`${name} (pixels): left ${box.left}, right ${WIDTH - 1 - box.right}, top ${box.top}, bottom ${HEIGHT - 1 - box.bottom}, height share ${(share * 100).toFixed(1)}%`);
  }
  const corners = [0, GRID[0]].flatMap(x => [0, GRID[2]].map(z => [x, 0, z]));
  const nearest = corners.reduce((best, corner) => (Math.hypot(...corner.map((value, axis) => value - views.shore.eye[axis])) < Math.hypot(...best.map((value, axis) => value - views.shore.eye[axis])) ? corner : best));
  const [cornerX, cornerY] = projectPoint(nearest, views.shore, WIDTH, HEIGHT);
  console.log(`shore near corner at pixel (${cornerX.toFixed(0)}, ${cornerY.toFixed(0)}): margins left ${cornerX.toFixed(0)}, right ${(WIDTH - cornerX).toFixed(0)}, bottom ${(HEIGHT - cornerY).toFixed(0)}`);
  for (const [name, wall] of Object.entries(results.walls)) {
    const [red, green, blue] = wall.mean.map(Math.round);
    console.log(`${name} wall: ${wall.pixels} px, mean RGB ${red} ${green} ${blue}, R-B ${red - blue}, Lab a* ${wall.lab.a.toFixed(1)}, L ${wall.lab.lightness.toFixed(0)}, top-to-wall change ${wall.transitionWidth} px (median of ${wall.columns} columns)${wall.largestStep === null ? '' : `, wall top silhouette in the crop: largest column-to-column change ${wall.largestStep} px, largest kink off the line between neighbours ${wall.largestKink} px`}`);
  }
  for (const [name, outline] of Object.entries(results.outlines)) {
    console.log(`${name} outline: largest kink off the line between neighbouring ${outline.direction} ${outline.kink.toFixed(1)} px at (${outline.at.join(', ')})`);
  }
  console.log('written', Object.keys(results.pictures).join(', '));
} finally {
  await browser.close();
  await server.close();
}
