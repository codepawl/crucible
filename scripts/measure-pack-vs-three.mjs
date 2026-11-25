// Measures a packed `<crucible-scene>` page against the same scene built with three.js, in Chrome with the GPU:
//
//   npm run build:lib && node scripts/measure-pack-vs-three.mjs [--out <folder>] [--size 800x600]
//
// Both pages draw one light grey box (linear 0.8, sRGB 0xe7e7e7, metallic 0, roughness 0.5) lit by a studio light, from the same camera. The packed page is
// tests/fixtures/pack-lit-box.recipe.json through `crucible pack --no-poster`; the three.js page imports what the `lit-box`
// scene of scripts/measure-size.mjs imports, at the version in package.json. Every file each page downloads is read in Chrome
// and compressed with gzip -9, the way docs/pack.md measures. The folder gets both pages, results.json, a markdown table and
// a side-by-side still of the two draws.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RECIPE_PATH = join(repositoryRoot, 'tests/fixtures/pack-lit-box.recipe.json');
const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.pack': 'application/octet-stream', '.json': 'application/json' };
const CAMERA = { eye: [3, 3, 3], target: [0, 0, 0], fov: 45 };

export function parseArguments(argv) {
  const options = { out: join(repositoryRoot, 'artifacts/3436/measure'), width: 800, height: 600 };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--out') options.out = resolve(argv[++index]);
    else if (flag === '--size') [options.width, options.height] = argv[++index].split('x').map(Number);
    else throw new Error(`${flag}: unknown option; this script takes --out <folder> and --size <width>x<height>.`);
  }
  if (!(options.width >= 64 && options.height >= 64)) throw new Error('--size takes <width>x<height>, each at least 64, such as 800x600.');
  return options;
}

export function gzipBytes(contents) {
  return gzipSync(contents, { level: 9 }).length;
}

// Sorts what a page downloaded into the rows of the docs/pack.md tables. The page itself (HTML) has its own row.
export function summarizeDownloads(files) {
  const rows = { javascript: 0, data: 0, html: 0 };
  for (const file of files) {
    if (file.path.endsWith('.js')) rows.javascript += file.gzip;
    else if (file.path.endsWith('.html') || file.path === '/') rows.html += file.gzip;
    else rows.data += file.gzip;
  }
  return { ...rows, total: rows.javascript + rows.data + rows.html, files: files.length };
}

function packLitBox(folder) {
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'bin/crucible.mjs'), 'pack', RECIPE_PATH, '--out', folder, '--no-poster', '--runtime', join(repositoryRoot, 'build/crucible-scene.js')], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`crucible pack failed (run npm run build:lib first): ${result.stderr || result.stdout}`);
}

async function buildThreePage(folder, { width, height }) {
  const source = `
    import { Scene, PerspectiveCamera, WebGLRenderer, Mesh, BoxGeometry, MeshStandardMaterial, DirectionalLight, AmbientLight } from 'three';
    const canvas = document.querySelector('canvas');
    const scene = new Scene();
    const renderer = new WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(${width}, ${height}, false);
    const light = new DirectionalLight(0xffffff, 3);
    light.position.set(2, 4, 3);
    scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ color: 0xe7e7e7, metalness: 0, roughness: 0.5 })), light, new AmbientLight(0xffffff, 0.6));
    const camera = new PerspectiveCamera(${CAMERA.fov}, ${width} / ${height}, 0.1, 100);
    camera.position.set(${CAMERA.eye.join(', ')});
    camera.lookAt(${CAMERA.target.join(', ')});
    renderer.render(scene, camera);
    window.__threeDrawn = true;`;
  await build({ stdin: { contents: source, resolveDir: repositoryRoot, loader: 'js' }, bundle: true, minify: true, format: 'esm', outfile: join(folder, 'main.js'), target: 'es2022', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } });
  await writeFile(join(folder, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#111}canvas{display:block;width:${width}px;height:${height}px}</style></head><body><canvas></canvas><script type="module" src="./main.js"></script></body></html>`);
}

function serve(folderByPrefix) {
  const server = createServer(async (request, response) => {
    const [, prefix, ...rest] = new URL(request.url, 'http://x').pathname.split('/');
    const folder = folderByPrefix[prefix];
    try {
      const path = join(folder, rest.join('/') || 'index.html');
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream' }).end(await readFile(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise(resolveServer => server.listen(0, '127.0.0.1', () => resolveServer(server)));
}

async function measurePage(browser, url, readyScript, size) {
  const page = await browser.newPage({ viewport: size });
  const files = [];
  const pending = [];
  page.on('response', response => pending.push(response.body().then(body => files.push({ path: new URL(response.url()).pathname.split('/').slice(2).join('/') || '/', bytes: body.length, gzip: gzipBytes(body) }))));
  await page.goto(url);
  await page.waitForFunction(readyScript, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  await Promise.all(pending);
  const png = await page.screenshot();
  await page.close();
  files.sort((first, second) => second.gzip - first.gzip);
  return { ...summarizeDownloads(files), rawBytes: files.reduce((sum, file) => sum + file.bytes, 0), downloaded: files, png };
}

async function sideBySide(browser, packedPng, threePng, size) {
  const page = await browser.newPage({ viewport: { width: size.width * 2 + 12, height: size.height + 48 } });
  const image = png => `data:image/png;base64,${png.toString('base64')}`;
  await page.setContent(`<body style="margin:0;background:#f8f7f1;font:600 20px system-ui;display:flex;gap:12px"><div><div style="padding:12px 0 8px">Packed crucible-scene</div><img src="${image(packedPng)}"></div><div><div style="padding:12px 0 8px">three.js</div><img src="${image(threePng)}"></div></body>`);
  await page.waitForFunction(() => [...document.images].every(picture => picture.complete));
  const still = await page.screenshot();
  await page.close();
  return still;
}

export function formatTable(results, date, threeVersion) {
  const kilobyte = bytes => `${bytes.toLocaleString('en-US')} B`;
  const row = (label, key) => `| ${label} | ${kilobyte(results.packed[key])} | ${kilobyte(results.three[key])} |`;
  return [
    `Measured ${date} in GPU Chrome, ${results.size}, three.js ${threeVersion}, gzip -9 of each file the page downloaded:`,
    '',
    '| | Packed bundle | three.js |',
    '| --- | --- | --- |',
    row('JavaScript', 'javascript'),
    row('Data', 'data'),
    row('Page (HTML)', 'html'),
    row('Total', 'total'),
  ].join('\n');
}

async function launchChrome() {
  const { chromium } = await import('playwright-core');
  const args = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-audio-output'];
  return chromium.launch(process.env.CHROME_PATH ? { headless: true, args, executablePath: process.env.CHROME_PATH } : { headless: true, args, channel: 'chrome' });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const size = { width: options.width, height: options.height };
  await rm(options.out, { recursive: true, force: true });
  await mkdir(join(options.out, 'three'), { recursive: true });
  const packedFolder = join(options.out, 'packed');
  packLitBox(packedFolder);
  await buildThreePage(join(options.out, 'three'), size);
  const server = await serve({ packed: packedFolder, three: join(options.out, 'three') });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchChrome();
  try {
    const packed = await measurePage(browser, `${origin}/packed/index.html`, () => document.querySelector('crucible-scene')?.getAttribute('state') === 'live', size);
    const three = await measurePage(browser, `${origin}/three/index.html`, () => window.__threeDrawn === true, size);
    const still = await sideBySide(browser, packed.png, three.png, size);
    await writeFile(join(options.out, 'side-by-side.png'), still);
    const threeVersion = JSON.parse(await readFile(join(repositoryRoot, 'node_modules/three/package.json'), 'utf8')).version;
    const date = new Date().toISOString().slice(0, 10);
    const results = { date, threeVersion, size: `${size.width} by ${size.height}`, camera: CAMERA, recipe: 'tests/fixtures/pack-lit-box.recipe.json', packed: { ...packed, png: undefined }, three: { ...three, png: undefined } };
    await writeFile(join(options.out, 'results.json'), JSON.stringify(results, null, 2));
    const table = formatTable(results, date, threeVersion);
    await writeFile(join(options.out, 'table.md'), table);
    console.log(table);
    for (const [name, page] of [['packed', packed], ['three', three]]) console.log(`\n${name}: ${page.files} files\n${page.downloaded.map(file => `  ${String(file.gzip).padStart(8)} B gzip  ${file.path}`).join('\n')}`);
  } finally {
    await browser.close();
    server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
