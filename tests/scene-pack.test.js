import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { encodePack, decodePack } from '../src/scene-pack-format.js';
import { compileRecipeToPack, validatePackRecipe, packRecipeFile, indexHtml } from '../src/scene-pack.js';
import { parsePackArguments } from '../bin/crucible.mjs';

const RECIPE = Object.freeze({
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box', bevel: 0 }, { id: 'ball', type: 'sphere' }],
  materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }, { id: 'red', color: [0.8, 0.1, 0.1], roughness: 0.2 }],
  nodes: [
    { id: 'cube', geometry: 'cube', material: 'blue' },
    { id: 'ball', geometry: 'ball', material: 'red', translation: [1.5, 0.5, 0] },
  ],
});

function temporaryFolder() {
  return mkdtempSync(join(tmpdir(), 'crucible-pack-'));
}

test('a packed scene holds the same geometry bytes as compiling the recipe directly', async () => {
  await loadAllAgentSceneModules();
  const direct = createAgentScene(structuredClone(RECIPE));
  const packed = decodePack(await compileRecipeToPack(structuredClone(RECIPE)));
  assert.equal(packed.parts.length, direct.parts.length);
  direct.parts.forEach((part, index) => {
    const unpacked = packed.parts[index];
    assert.equal(unpacked.name, part.name);
    assert.deepEqual(unpacked.material, JSON.parse(JSON.stringify(part.material)));
    assert.deepEqual([...unpacked.matrix], [...part.matrix]);
    for (const [attribute, array] of Object.entries(part.geometry)) {
      assert.ok(unpacked.geometry[attribute] instanceof array.constructor, `${attribute} keeps its typed array type`);
      assert.deepEqual(Buffer.from(unpacked.geometry[attribute].buffer, unpacked.geometry[attribute].byteOffset, unpacked.geometry[attribute].byteLength),
        Buffer.from(array.buffer, array.byteOffset, array.byteLength), `${attribute} bytes of ${part.name}`);
    }
  });
  assert.deepEqual(packed.camera, direct.camera);
  assert.equal(packed.environment.setup, direct.environment.setup);
});

test('packing the same recipe twice gives the same bytes', async () => {
  const first = await compileRecipeToPack(structuredClone(RECIPE));
  const second = await compileRecipeToPack(structuredClone(RECIPE));
  assert.deepEqual(Buffer.from(first), Buffer.from(second));
});

test('the pack format keeps typed arrays aligned and rejects what JSON cannot hold', () => {
  const bytes = encodePack({ values: new Float32Array([1, 2, 3]), small: new Uint8Array([7]), more: new Uint32Array([9, 8]), label: 'x' });
  const decoded = decodePack(bytes);
  assert.deepEqual([...decoded.values], [1, 2, 3]);
  assert.deepEqual([...decoded.more], [9, 8]);
  assert.equal(decoded.label, 'x');
  const shifted = new Uint8Array(bytes.length + 1);
  shifted.set(bytes, 1);
  assert.deepEqual([...decodePack(shifted.subarray(1)).values], [1, 2, 3]);
  assert.throws(() => encodePack({ bad: Number.NaN }), /scene\.bad: got NaN; expected a finite number/);
  assert.throws(() => encodePack({ bad: new Map() }), /scene\.bad: got a Map; expected plain data/);
  assert.throws(() => encodePack({ bad: () => 1 }), /scene\.bad: got function/);
  assert.throws(() => encodePack(null), /pass the scene object to pack/);
  assert.throws(() => decodePack(new Uint8Array(16)), /not a crucible pack/);
  assert.throws(() => decodePack(bytes.subarray(0, 12)), /cut short/);
  assert.throws(() => decodePack('text'), /as an ArrayBuffer or Uint8Array/);
});

test('a recipe that crucible pack cannot write yet is refused with what to change', () => {
  assert.throws(() => validatePackRecipe([]), /not an object/);
  assert.throws(() => validatePackRecipe({ format: 'gltf' }), /expected "crucible.scene"/);
  assert.throws(() => validatePackRecipe({ ...RECIPE, motion: {} }), /recipe\.motion: .*remove "motion"/);
  assert.throws(() => validatePackRecipe({ ...RECIPE, environment: { sky: { sunElevation: 30 } } }), /environment\.sky: .*set environment\.setup/);
  assert.doesNotThrow(() => validatePackRecipe(RECIPE));
});

test('crucible pack arguments name the flag that is wrong', () => {
  assert.deepEqual(parsePackArguments(['scene.json', '--out', 'dist', '--poster', 'p.webp']), { recipePath: 'scene.json', out: 'dist', poster: 'p.webp' });
  assert.throws(() => parsePackArguments(['a.json', 'b.json']), /only one scene\.json/);
  assert.throws(() => parsePackArguments(['a.json', '--out']), /--out: pass a value/);
  assert.throws(() => parsePackArguments(['--minify']), /--minify: unknown option/);
});

test('packRecipeFile writes the pack, the runtime, the poster and an index.html that uses the runtime only', async () => {
  const folder = temporaryFolder();
  try {
    const recipePath = join(folder, 'scene.json');
    const runtimePath = join(folder, 'runtime.js');
    const posterPath = join(folder, 'shot.webp');
    writeFileSync(recipePath, JSON.stringify(RECIPE));
    writeFileSync(runtimePath, 'import "./chunk.js";\nexport const runtime = true;\nexport const hint = "add import \'./not-a-chunk.js\'";\n');
    writeFileSync(join(folder, 'chunk.js'), 'export const chunk = true;\n');
    writeFileSync(posterPath, 'poster');
    const outDir = join(folder, 'out');
    const result = await packRecipeFile({ recipePath, outDir, posterPath, runtimePath, packageRoot: folder });
    assert.deepEqual(result.files.sort(), ['chunk.js', 'crucible-scene.js', 'index.html', 'poster.webp', 'scene.pack']);
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    assert.match(html, /<crucible-scene src="\.\/scene\.pack" poster="\.\/poster\.webp">/);
    assert.match(html, /src="\.\/crucible-scene\.js"/);
    assert.ok(!html.includes('agent-scene'));
    assert.equal(decodePack(readFileSync(join(outDir, 'scene.pack'))).parts.length, 2);
    assert.ok(!indexHtml({ title: 't', posterName: null }).includes('poster='));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('packRecipeFile checks its inputs before it writes anything', async () => {
  const folder = temporaryFolder();
  try {
    const recipePath = join(folder, 'scene.json');
    writeFileSync(recipePath, JSON.stringify(RECIPE));
    const runtimePath = join(folder, 'runtime.js');
    writeFileSync(runtimePath, 'export {};');
    const outDir = join(folder, 'out');
    await assert.rejects(packRecipeFile({ recipePath: join(folder, 'none.json'), outDir, runtimePath }), /<scene\.json>: .*is not a file/);
    writeFileSync(join(folder, 'broken.json'), '{');
    await assert.rejects(packRecipeFile({ recipePath: join(folder, 'broken.json'), outDir, runtimePath }), /not valid JSON/);
    await assert.rejects(packRecipeFile({ recipePath, runtimePath }), /--out: pass the folder/);
    writeFileSync(join(folder, 'poster.bmp'), 'x');
    await assert.rejects(packRecipeFile({ recipePath, outDir, runtimePath, posterPath: join(folder, 'poster.bmp') }), /--poster: .*pass a WebP, PNG or JPEG/);
    await assert.rejects(packRecipeFile({ recipePath, outDir, packageRoot: folder }), /--runtime: .*does not exist; run npm run build/);
    assert.ok(!existsSync(outDir), 'nothing is written when an input is wrong');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the <crucible-scene> runtime imports no agent-scene compiler code or capability lists', async () => {
  const result = await build({ entryPoints: ['src/crucible-scene.js'], bundle: true, write: false, metafile: true, format: 'esm', splitting: true, outdir: 'out', logLevel: 'error' });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.includes('src/renderer.js'), 'the runtime reaches the renderer');
  const compilerModules = inputs.filter(path => /src\/(agent-scene|agent-look|agent-apply|scene-pack\.js)/.test(path));
  assert.deepEqual(compilerModules, []);
});

test('the crucible-scene module imports in Node without a DOM, as the package smoke does', async () => {
  assert.equal(typeof globalThis.HTMLElement, 'undefined');
  const module = await import('../src/crucible-scene.js');
  assert.equal(typeof module.CrucibleSceneElement, 'function');
});
