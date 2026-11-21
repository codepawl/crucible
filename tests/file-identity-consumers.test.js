import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Keep the filesystem override in a child so other tests use the real builtin bindings.
const worker = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, rename, link, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mat4 } from 'gl-matrix';
import { box } from './src/geometry.js';
import { exportGlb } from './src/export.js';

const { CONSUMER: consumer, CASE: scenario } = process.env;
const directory = await mkdtemp(join(tmpdir(), 'crucible-identity-consumer-'));
const promises = fs.promises;
const originalLstat = promises.lstat;
const originalOpen = promises.open;
let target;
let intercepted = false;
let replaced = false;
let controller;
promises.lstat = async function(path, ...options) {
  const details = await originalLstat.call(promises, path, ...options);
  if (String(path) !== target) return details;
  intercepted = true;
  if (scenario === 'device' || scenario === 'inode') {
    const field = scenario === 'device' ? 'dev' : 'ino';
    // Preserve Stats methods while representing a different reported identity.
    return new Proxy(details, { get(object, key) {
      return key === field ? (object[field] === 1 ? 2 : 1) : Reflect.get(object, key, object);
    } });
  }
  return details;
};
promises.open = async function(path, ...options) {
  if (String(path) === target && scenario === 'replacement' && !replaced) {
    replaced = true;
    const before = await originalLstat(path);
    const bytes = await promises.readFile(path);
    await rename(path, join(directory, 'original.bin'));
    await writeFile(path, bytes);
    assert.notEqual((await originalLstat(path)).ino, before.ino);
  }
  return originalOpen.call(promises, path, ...options);
};
syncBuiltinESMExports();
try {
  if (consumer === 'catalog') {
    const { readCatalogFile } = await import('./scripts/agent-asset-catalog.mjs');
    target = join(directory, 'cube.glb');
    const bytes = Buffer.from(exportGlb([{ name: 'Cube', geometry: box(0), matrix: mat4.create(), material: { color: [0.2, 0.5, 0.7], roughness: 0.5, metallic: 0 } }]));
    if (scenario === 'directory') await mkdir(target);
    else await writeFile(target, bytes);
    if (scenario === 'unchanged') {
      assert.deepEqual((await readCatalogFile(directory, 'cube.glb')).bytes, bytes);
    } else {
      const expected = scenario === 'directory' ? /regular files, without links/ : /changed during opening/;
      await assert.rejects(readCatalogFile(directory, 'cube.glb'), expected);
    }
  } else {
    const { createAgentRenderJobs } = await import('./scripts/agent-render-jobs.mjs');
    controller = await createAgentRenderJobs({ root: join(directory, 'jobs'), limits: { maxOutputBytes: 1024, maxFrameBytes: 128, maxStoreBytes: 1024 ** 2 }, async run({ directory: output }) {
      target = join(output, 'render.png.partial');
      if (scenario === 'directory') await mkdir(target);
      else await writeFile(target, 'fixture PNG bytes');
      if (scenario === 'hardlink') await link(target, join(directory, 'alias.png'));
      return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }] };
    }});
    const { jobId } = await controller.submit({ sourceRevision: 1, snapshot: { recipe: { format: 'fixture' } }, settings: { kind: 'image', width: 64, height: 64 } });
    const deadline = Date.now() + 45000;
    let status = controller.status(jobId);
    while (!['failed', 'completed'].includes(status.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
      status = controller.status(jobId);
    }
    assert.equal(status.state, scenario === 'unchanged' ? 'completed' : 'failed', JSON.stringify(status));
    if (scenario !== 'unchanged') {
      const expected = ['directory', 'hardlink'].includes(scenario) ? /regular files without links or aliases/ : /changed while opening/;
      assert.match(status.reason, expected);
    }
  }
  assert.equal(intercepted, true, 'the consumer checked the intended file');
} finally {
  promises.lstat = originalLstat;
  promises.open = originalOpen;
  syncBuiltinESMExports();
  if (controller) await controller.close();
  await rm(directory, { recursive: true, force: true });
}
`;

for (const consumer of ['catalog', 'render job']) {
  const scenarios = ['unchanged', 'replacement', 'device', 'inode', 'directory'];
  if (consumer === 'render job') scenarios.push('hardlink');
  for (const scenario of scenarios) {
    test(`${consumer}: ${scenario} preserves the file identity boundary`, () => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', worker], {
        cwd: root,
        env: { ...process.env, CONSUMER: consumer, CASE: scenario },
        encoding: 'utf8',
        timeout: 60000,
      });
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    });
  }
}
