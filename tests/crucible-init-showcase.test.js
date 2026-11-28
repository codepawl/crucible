import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  initUsageText,
  parseInitArguments,
  sanitizePackageName,
  scaffoldTemplate,
} from '../bin/crucible-init.mjs';
import { usageText } from '../bin/crucible.mjs';
import {
  SHOWCASE_THEMES,
  buildCrucibleMarkSvg,
  buildShowcaseViews,
  createCadGridFloor,
  createShowcaseLighting,
  measurePartsBounds,
} from '../src/showcase-viewer.js';

const packageRoot = resolve(import.meta.dirname, '..');
const crucibleCliPath = join(packageRoot, 'bin', 'crucible.mjs');

test('parseInitArguments and sanitizePackageName validate flags and defaults', () => {
  assert.deepEqual(parseInitArguments([]), {
    template: 'showcase',
    outDir: 'crucible-showcase',
    packageName: null,
    force: false,
  });
  assert.deepEqual(parseInitArguments(['my-app', '--template', 'addon', '--name', 'Audio Box', '--force']), {
    template: 'addon',
    outDir: 'my-app',
    packageName: 'Audio Box',
    force: true,
  });
  assert.equal(sanitizePackageName('Field Synth 01!'), 'field-synth-01');
  assert.throws(() => parseInitArguments(['--unknown']), TypeError);
  assert.throws(() => parseInitArguments(['--template', 'missing']), RangeError);
  assert.throws(() => parseInitArguments(['first', 'second']), TypeError);
  assert.match(initUsageText(), /crucible init/);
  assert.match(usageText({ noPromo: true }), /crucible init/);
});

test('scaffoldTemplate copies showcase template, updates package.json, and guards existing directories', () => {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'crucible-init-'));
  try {
    const destination = join(scratchRoot, 'Hardware Showcase');
    const rootPackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const result = scaffoldTemplate({
      packageRoot,
      template: 'showcase',
      outDir: destination,
    });

    assert.equal(result.template, 'showcase');
    assert.equal(result.packageName, 'hardware-showcase');
    assert.ok(result.files.includes('index.html'));
    assert.ok(result.files.includes('package.json'));
    assert.ok(result.files.includes('favicon.svg'));
    assert.ok(result.files.includes('src/demo-assembly.js'));
    assert.ok(result.files.includes('src/main.js'));

    const createdPackage = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
    assert.equal(createdPackage.name, 'hardware-showcase');
    assert.equal(createdPackage.dependencies['@codepawlhq/crucible'], `^${rootPackage.version}`);

    assert.throws(() => scaffoldTemplate({ packageRoot, outDir: destination }), /already exists/);

    writeFileSync(join(destination, 'index.html'), 'stale');
    scaffoldTemplate({ packageRoot, outDir: destination, force: true, packageName: 'custom-name' });
    const overwrittenPackage = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
    assert.equal(overwrittenPackage.name, 'custom-name');
    assert.match(readFileSync(join(destination, 'index.html'), 'utf8'), /Field synthesizer/);

    const cliOut = join(scratchRoot, 'cli-showcase');
    const cliResult = spawnSync(process.execPath, [crucibleCliPath, 'init', cliOut], { encoding: 'utf8' });
    assert.equal(cliResult.status, 0);
    assert.ok(existsSync(join(cliOut, 'src', 'main.js')));

    const addonOut = join(scratchRoot, 'cli-addon');
    const addonResult = spawnSync(process.execPath, [crucibleCliPath, 'init', addonOut, '--template', 'addon'], { encoding: 'utf8' });
    assert.equal(addonResult.status, 0);
    assert.ok(existsSync(join(addonOut, 'package.json')));
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('showcase viewer theme, CAD grid floor, lighting, bounds, views, and mark SVG helpers', () => {
  assert.equal(SHOWCASE_THEMES.prototype.background, '#f8f7f1');
  assert.equal(SHOWCASE_THEMES.prototype.accent, '#df5829');
  assert.equal(SHOWCASE_THEMES.studio.background, '#17161a');
  assert.equal(SHOWCASE_THEMES.studio.accent, '#fc9132');

  const floor = createCadGridFloor({ radius: 4, height: -0.01, theme: 'prototype', textureSize: 64 });
  const floorAgain = createCadGridFloor({ radius: 4, height: -0.01, theme: 'prototype', textureSize: 64 });
  assert.equal(floor.material.alphaMode, 'blend');
  assert.equal(floor.material.map.image.width, 64);
  assert.deepEqual(floor.material.map.image.data, floorAgain.material.map.image.data);
  assert.equal(floor.material.map.image.data[3], 0);

  const studioLighting = createShowcaseLighting({ theme: 'studio' });
  assert.equal(studioLighting.effects.viewTransform, 'agx');
  assert.equal(studioLighting.environment.fogDensity, 0);
  assert.ok(studioLighting.environment.map);

  const bounds = measurePartsBounds([
    {
      geometry: { positions: new Float32Array([-1, 0, -0.5, 1, 2, 0.5]) },
      matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    },
  ]);
  assert.deepEqual(bounds, { minimum: [-1, 0, -0.5], maximum: [1, 2, 0.5] });

  const { presets, target } = buildShowcaseViews(bounds);
  assert.deepEqual(target, [0, 1, 0]);
  assert.ok(presets.hero.distance > 1);
  assert.equal(presets.front.yaw, 0);
  assert.equal(presets.side.yaw, Math.PI / 2);
  assert.ok(presets.top.pitch > 1.4);

  const svg = buildCrucibleMarkSvg(16);
  assert.match(svg, /<svg/);
  assert.match(svg, /#393842/);
  assert.match(svg, /#df5829/);
});
