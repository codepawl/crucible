import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MAXIMUM_BATCH_SHOTS,
  MINIMUM_BATCH_SHOTS,
  parseBatchManifest,
  parseBatchOptions,
  parseRenderOptions,
  renderBatch,
  renderMedia,
  selectBatchEncoderBackends,
} from '../scripts/render-media.mjs';
import { writeSpinningBarScene } from './helpers/scene-file-frames.js';

const INSTALLED_CHROME = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const chromeMissing = !existsSync(INSTALLED_CHROME);

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('parseBatchManifest accepts an array manifest and validates every shot through shared rules', () => {
  const plans = parseBatchManifest([
    { scene: 'motion', kind: 'image', time: 1.5, output: 'out/shot-a.png' },
    { scene: 'object', kind: 'stills', width: 640, height: 360, output: 'out/shot-b/frame.png' },
  ]);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].scene, 'motion');
  assert.equal(plans[0].kind, 'image');
  assert.equal(plans[0].time, 1.5);
  assert.equal(plans[0].output, resolve('out/shot-a.png'));
  assert.equal(plans[1].scene, 'object');
  assert.equal(plans[1].kind, 'stills');
  assert.equal(plans[1].width, 640);
  assert.equal(plans[1].height, 360);
});

test('parseBatchManifest merges CLI defaults <- manifest defaults <- shot and supports kebab and camelCase keys', () => {
  const cliDefaults = {
    backend: 'cpu',
    width: '540',
    height: '960',
    'jpeg-quality': '80',
  };
  const manifest = {
    defaults: {
      scene: 'motion',
      kind: 'image',
      capture: 'jpeg',
      width: 720,
      jpegQuality: 88,
    },
    shots: [
      { output: 'out/first.jpg', time: 2 },
      { output: 'out/second.jpg', time: 4, width: 480, 'jpeg-quality': 92 },
    ],
  };
  const plans = parseBatchManifest(manifest, cliDefaults);
  assert.equal(plans[0].backend, 'cpu');
  assert.equal(plans[0].height, 960);
  assert.equal(plans[0].width, 720);
  assert.equal(plans[0].captureFormat, 'jpeg');
  assert.equal(plans[0].jpegQuality, 88);
  assert.equal(plans[1].width, 480);
  assert.equal(plans[1].jpegQuality, 92);
});

test('parseBatchManifest enforces bounds (1 to 500 shots), object shape, unknown keys, and distinct outputs', () => {
  assert.throws(() => parseBatchManifest([]), new RegExp(`between ${MINIMUM_BATCH_SHOTS} and ${MAXIMUM_BATCH_SHOTS}`));
  assert.throws(() => parseBatchManifest({ shots: [] }), new RegExp(`between ${MINIMUM_BATCH_SHOTS} and ${MAXIMUM_BATCH_SHOTS}`));

  const overLimit = Array.from({ length: MAXIMUM_BATCH_SHOTS + 1 }, (_, index) => ({
    scene: 'motion',
    output: `out/s-${index}.png`,
  }));
  assert.throws(() => parseBatchManifest(overLimit), new RegExp(`between ${MINIMUM_BATCH_SHOTS} and ${MAXIMUM_BATCH_SHOTS}`));

  const exactLimit = Array.from({ length: MAXIMUM_BATCH_SHOTS }, (_, index) => ({
    scene: 'motion',
    output: `out/s-${index}.png`,
  }));
  assert.equal(parseBatchManifest(exactLimit).length, MAXIMUM_BATCH_SHOTS);

  assert.throws(() => parseBatchManifest('invalid'), /array of shots or an object/);
  assert.throws(() => parseBatchManifest({ shots: [{ output: 'out/a.png' }], extra: true }), /Unknown batch manifest key "extra"/);
  assert.throws(() => parseBatchManifest({ defaults: 'bad', shots: [{ output: 'out/a.png' }] }), /"defaults" must be a plain object/);
  assert.throws(() => parseBatchManifest({ shots: 'bad' }), /must have a "shots" array/);
  assert.throws(() => parseBatchManifest(['not-an-object']), /shot 0 must be a plain object/);
  assert.throws(() => parseBatchManifest([{ output: 'out/a.png', unknownOption: 1 }]), /Unknown render option in shot 0: unknownOption/);
  assert.throws(() => parseBatchManifest({ defaults: { bogus: 1 }, shots: [{ output: 'out/a.png' }] }), /Unknown render option in manifest defaults: bogus/);
  assert.throws(() => parseBatchManifest([{ output: 'out/a.png', batch: 'other.json' }]), /Unknown render option in shot 0: batch/);
  assert.throws(() => parseBatchManifest([{ output: 'out/a.png', jpegQuality: 90, 'jpeg-quality': 90 }]), /both "jpeg-quality" and "jpegQuality"/);
  assert.throws(() => parseBatchManifest([{ scene: 'motion' }]), /must specify a non-empty string "output"/);
  assert.throws(() => parseBatchManifest([{ output: '  ' }]), /must specify a non-empty string "output"/);
  assert.throws(
    () => parseBatchManifest([
      { scene: 'motion', output: 'out/same.png' },
      { scene: 'motion', output: 'out/../out/same.png' },
    ]),
    /Duplicate output path/,
  );
  assert.throws(
    () => parseBatchManifest([
      { scene: 'motion', backend: 'gpu', output: 'out/gpu.png' },
      { scene: 'motion', backend: 'cpu', output: 'out/cpu.png' },
    ]),
    /same --backend/,
  );
});

test('batch shot validation matches single-shot parseRenderOptions error messages', () => {
  const oddVideoArgs = ['--scene', 'motion', '--kind', 'video', '--width', '101', '--height', '100', '--output', 'out/a.mp4'];
  let singleShotMessage;
  try {
    parseRenderOptions(oddVideoArgs);
  } catch (error) {
    singleShotMessage = error.message;
  }
  assert.throws(
    () => parseBatchManifest([{ scene: 'motion', kind: 'video', width: 101, height: 100, output: 'out/a.mp4' }]),
    error => error.message === singleShotMessage,
  );

  const missingConfigArgs = ['--scene', 'file', '--output', 'out/a.png'];
  let missingConfigMessage;
  try {
    parseRenderOptions(missingConfigArgs);
  } catch (error) {
    missingConfigMessage = error.message;
  }
  assert.throws(
    () => parseBatchManifest([{ scene: 'file', output: 'out/a.png' }]),
    error => error.message === missingConfigMessage,
  );

  assert.throws(
    () => parseBatchManifest([{ scene: 'motion', kind: 'stills', frames: '0-3', start: 1, output: 'out/a.png' }]),
    /drop --start, --time and --duration/,
  );
  assert.throws(
    () => parseBatchManifest([{ scene: 'motion', width: null, output: 'out/a.png' }]),
    /width must be between 64 and 4096/,
  );
});

test('parseBatchOptions refuses conflicting single-shot CLI flags and accepts shared CLI defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'batch-cli-'));
  try {
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({
      defaults: { kind: 'stills', frames: '0-1' },
      shots: [{ config: join(directory, 'scene.json'), output: join(directory, 'out/a.png') }],
    }));
    await writeFile(join(directory, 'scene.json'), JSON.stringify({ glb: 'bar.glb', renderer: { memoryBudgetMiB: 256 } }));

    for (const [flag, value] of [
      ['--output', 'out/x.png'],
      ['--config', 'scene.json'],
      ['--camera', 'cam.json'],
      ['--asset', 'model.glb'],
      ['--time', '1'],
      ['--frames', '0-3'],
      ['--start', '0'],
      ['--duration', '2'],
      ['--audio', 'sound.wav'],
    ]) {
      assert.throws(
        () => parseBatchOptions(['--batch', manifestPath, flag, value]),
        new RegExp(`--batch cannot be combined with ${flag}`),
      );
    }

    assert.throws(() => parseRenderOptions(['--batch', manifestPath]), /--batch defines multiple shots/);
    assert.throws(() => parseBatchOptions(['--batch', '']), /--batch requires a path/);
    assert.throws(() => parseBatchOptions(['--batch', join(directory, 'missing.json')]), /not found or unreadable/);

    const badJsonPath = join(directory, 'bad.json');
    await writeFile(badJsonPath, '{not json');
    assert.throws(() => parseBatchOptions(['--batch', badJsonPath]), /not valid JSON/);

    const parsed = parseBatchOptions([
      '--batch', manifestPath,
      '--backend', 'cpu',
      '--preset', 'cpu',
      '--scene', 'file',
      '--width', '270',
      '--height', '480',
      '--fps', '30',
      '--aspect', 'portrait',
      '--memory', '384',
      '--encoder', 'cpu',
      '--capture', 'png',
      '--jpeg-quality', '90',
      '--root', directory,
    ]);
    assert.equal(parsed.plans.length, 1);
    assert.equal(parsed.plans[0].scene, 'file');
    assert.equal(parsed.plans[0].backend, 'cpu');
    assert.equal(parsed.plans[0].width, 270);
    assert.equal(parsed.plans[0].height, 480);
    assert.equal(parsed.plans[0].fps, 30);
    assert.equal(parsed.plans[0].memory, 384);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('selectBatchEncoderBackends probes NVENC at most once across video shots', async () => {
  const imagePlans = parseBatchManifest([
    { scene: 'motion', kind: 'image', output: 'out/1.png' },
    { scene: 'motion', kind: 'stills', output: 'out/2.png' },
  ]);
  let probeCalls = 0;
  const countingAvailableProbe = async () => {
    probeCalls += 1;
    return { available: true };
  };
  assert.deepEqual(await selectBatchEncoderBackends(imagePlans, countingAvailableProbe), [null, null]);
  assert.equal(probeCalls, 0);

  const cpuVideoPlans = parseBatchManifest([
    { scene: 'motion', kind: 'video', encoder: 'cpu', output: 'out/1.mp4' },
    { scene: 'motion', kind: 'video', encoder: 'cpu', output: 'out/2.mp4' },
  ]);
  assert.deepEqual(await selectBatchEncoderBackends(cpuVideoPlans, countingAvailableProbe), ['cpu', 'cpu']);
  assert.equal(probeCalls, 0);

  const mixedVideoPlans = parseBatchManifest([
    { scene: 'motion', kind: 'image', output: 'out/0.png' },
    { scene: 'motion', kind: 'video', encoder: 'cpu', output: 'out/1.mp4' },
    { scene: 'motion', kind: 'video', encoder: 'auto', output: 'out/2.mp4' },
    { scene: 'motion', kind: 'video', encoder: 'gpu', output: 'out/3.mp4' },
  ]);
  assert.deepEqual(await selectBatchEncoderBackends(mixedVideoPlans, countingAvailableProbe), [null, 'cpu', 'gpu', 'gpu']);
  assert.equal(probeCalls, 1);

  let unavailableCalls = 0;
  const countingUnavailableProbe = async () => {
    unavailableCalls += 1;
    return { available: false, reason: 'no hardware encoder' };
  };
  await assert.rejects(
    () => selectBatchEncoderBackends(mixedVideoPlans, countingUnavailableProbe),
    /NVENC is unavailable: no hardware encoder/,
  );
  assert.equal(unavailableCalls, 1);
});

test(
  'renderBatch renders multiple file-scene shots with one Vite + Chromium session and matches single-shot PNG bytes',
  { skip: chromeMissing && 'needs Google Chrome installed where scripts/render-media.mjs looks for it', timeout: 300000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'render-batch-chrome-'));
    try {
      const sharpScene = await writeSpinningBarScene(join(directory, 'scene-sharp'), { name: 'sharp' });
      const blurredScene = await writeSpinningBarScene(join(directory, 'scene-blurred'), {
        name: 'blurred',
        motionBlur: { shutter: 0.1, objects: 1 },
      });

      const shot1Output = join(directory, 'batch-out', 'shot-1', 'shot.png');
      const shot2Output = join(directory, 'batch-out', 'shot-2', 'shot.png');
      const shot3Output = join(directory, 'batch-out', 'shot-3', 'single.png');
      await mkdir(join(directory, 'batch-out'), { recursive: true });

      const manifestPath = join(directory, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify({
        defaults: {
          scene: 'file',
          width: 270,
          height: 480,
          fps: 30,
        },
        shots: [
          { kind: 'stills', frames: '0-1', config: sharpScene.config, camera: sharpScene.camera, output: shot1Output },
          { kind: 'stills', frames: '0-1', config: blurredScene.config, camera: blurredScene.camera, output: shot2Output },
          { kind: 'image', time: 0.5, config: sharpScene.config, camera: sharpScene.camera, output: shot3Output },
        ],
      }));

      const cliSummaryResult = spawnSync(
        process.execPath,
        ['scripts/render-media.mjs', '--batch', manifestPath, '--backend', 'cpu'],
        { encoding: 'utf8', env: { ...process.env, COOK_DISABLE: '1' } },
      );
      assert.equal(cliSummaryResult.status, 0, `${cliSummaryResult.stdout}\n${cliSummaryResult.stderr}`);
      const batchSummary = JSON.parse(cliSummaryResult.stdout);
      assert.equal(batchSummary.batch, true);
      assert.equal(batchSummary.totalShots, 3);
      assert.ok(Number.isFinite(batchSummary.startupSeconds) && batchSummary.startupSeconds > 0);
      assert.ok(Number.isFinite(batchSummary.elapsedSeconds) && batchSummary.elapsedSeconds >= batchSummary.startupSeconds);
      assert.equal(batchSummary.shots.length, 3);

      const shot1Report = JSON.parse(await readFile(`${shot1Output}.json`, 'utf8'));
      const shot2Report = JSON.parse(await readFile(`${shot2Output}.json`, 'utf8'));
      const shot3Report = JSON.parse(await readFile(`${shot3Output}.json`, 'utf8'));
      assert.deepEqual(shot1Report, batchSummary.shots[0]);
      assert.deepEqual(shot2Report, batchSummary.shots[1]);
      assert.deepEqual(shot3Report, batchSummary.shots[2]);
      assert.equal(shot1Report.capturedFrames, 2);
      assert.equal(shot2Report.capturedFrames, 2);
      assert.equal(shot3Report.capturedFrames, 1);

      const singleShotOutput = join(directory, 'single-out', 'shot.png');
      const previousCookDisable = process.env.COOK_DISABLE;
      process.env.COOK_DISABLE = '1';
      try {
        await renderMedia([
          '--scene', 'file',
          '--kind', 'stills',
          '--backend', 'cpu',
          '--width', '270',
          '--height', '480',
          '--fps', '30',
          '--frames', '0-1',
          '--config', blurredScene.config,
          '--camera', blurredScene.camera,
          '--output', singleShotOutput,
        ]);
      } finally {
        if (previousCookDisable === undefined) delete process.env.COOK_DISABLE;
        else process.env.COOK_DISABLE = previousCookDisable;
      }

      const batchFrame1 = await readFile(join(directory, 'batch-out', 'shot-2', 'frame-0001.png'));
      const singleFrame1 = await readFile(join(directory, 'single-out', 'frame-0001.png'));
      assert.equal(sha256Of(batchFrame1), sha256Of(singleFrame1));

      const sharpFrame1 = await readFile(join(directory, 'batch-out', 'shot-1', 'frame-0001.png'));
      assert.notEqual(sha256Of(batchFrame1), sha256Of(sharpFrame1));

      const shot3Bytes = await readFile(shot3Output);
      assert.ok(shot3Bytes.byteLength > 100);

      const programmaticManifest = join(directory, 'programmatic.json');
      await writeFile(programmaticManifest, JSON.stringify([
        { scene: 'file', kind: 'image', time: 0.25, width: 270, height: 480, config: sharpScene.config, camera: sharpScene.camera, output: join(directory, 'prog-out', 'a.png') },
        { scene: 'file', kind: 'image', time: 0.75, width: 270, height: 480, config: sharpScene.config, camera: sharpScene.camera, output: join(directory, 'prog-out', 'b.png') },
      ]));
      process.env.COOK_DISABLE = '1';
      let programmaticSummary;
      try {
        programmaticSummary = await renderBatch(['--batch', programmaticManifest, '--backend', 'cpu']);
      } finally {
        if (previousCookDisable === undefined) delete process.env.COOK_DISABLE;
        else process.env.COOK_DISABLE = previousCookDisable;
      }
      assert.equal(programmaticSummary.batch, true);
      assert.equal(programmaticSummary.totalShots, 2);
      assert.equal(programmaticSummary.shots.length, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
