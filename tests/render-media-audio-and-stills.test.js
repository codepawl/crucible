import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioTrimArguments, createFrameEncoder, frameEncoderArguments } from '../scripts/frame-encoder.mjs';
import { DEFAULT_PAGE_ENCODER_QUANTIZER } from '../scripts/gpu-frame-reader.mjs';
import { audioInputArguments, measureStreamSeconds } from '../scripts/job-audio.mjs';
import { assertOutputHasAudio, parseRenderOptions, renderEncoderOptions, stillPath, stillPaths } from '../scripts/render-media.mjs';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0;
const SYNC_TOLERANCE_SECONDS = 0.05;

function runFfmpeg(argumentsValue) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argumentsValue]);
  assert.equal(result.status, 0, String(result.stderr));
}

async function makeInputs(directory, fps, frameCount) {
  const sound = join(directory, 'sound.wav');
  const annexB = join(directory, 'clip.h264');
  runFfmpeg(['-f', 'lavfi', '-i', 'sine=d=3:r=48000', sound]);
  runFfmpeg(['-f', 'lavfi', '-i', `testsrc=s=64x64:r=${fps}`, '-frames:v', String(frameCount), '-c:v', 'libx264', '-bf', '0', '-f', 'h264', annexB]);
  return { sound, clip: await readFile(annexB) };
}

async function encodeWithAudio(directory, { fps, frameCount, audioCodec }) {
  const { sound, clip } = await makeInputs(directory, fps, frameCount);
  const output = join(directory, `${audioCodec}-${fps}.mp4`);
  const encoder = createFrameEncoder({ output, fps, format: 'h264', audioCodec, frameCount,
    audioArguments: audioInputArguments(sound, 0) });
  encoder.writeChunk(clip);
  await encoder.finish();
  await encoder.close();
  return output;
}

test('the audio trim pads with silence and cuts at the picture length', () => {
  assert.deepEqual(audioTrimArguments('pcm', 1), ['-af', 'apad', '-c:a', 'pcm_s16le', '-t', '1.000000']);
  assert.deepEqual(audioTrimArguments('aac', 24 / 12).slice(-2), ['-t', '2.000000']);
});

test('an encoder with audio refuses to start without a frame count', () => {
  assert.throws(() => createFrameEncoder({ output: 'x.mp4', fps: 24, format: 'h264', audioArguments: ['-i', 'a.wav'] }), /frameCount/);
});

for (const [audioCodec, fps, frameCount] of [['aac', 24, 24], ['pcm', 24, 24], ['pcm', 12, 24], ['pcm', 24, 12]]) {
  test(`${audioCodec} audio on the page-encoded H.264 copy path keeps the picture length (${frameCount} frames at ${fps} fps)`, { skip: !ffmpegAvailable }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crucible-1284-'));
    try {
      const output = await encodeWithAudio(directory, { fps, frameCount, audioCodec });
      const audioSeconds = await measureStreamSeconds('ffmpeg', output, 'audio');
      const videoSeconds = await measureStreamSeconds('ffmpeg', output, 'video');
      assert.ok(Math.abs(audioSeconds - frameCount / fps) <= 0.011, `audio ${audioSeconds}`);
      assert.ok(Math.abs(audioSeconds - videoSeconds) <= SYNC_TOLERANCE_SECONDS, `audio ${audioSeconds} video ${videoSeconds}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('a rendered video without an audio stream fails the render', { skip: !ffmpegAvailable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-1284-'));
  try {
    const silent = join(directory, 'silent.mp4');
    runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=s=64x64:r=24', '-frames:v', '24', '-pix_fmt', 'yuv420p', silent]);
    await assert.rejects(assertOutputHasAudio('ffmpeg', silent), /no audio stream/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [format, backend] of [['h264', 'cpu'], ['jpeg', 'cpu'], ['rawvideo', 'cpu'], ['jpeg', 'gpu']]) {
  test(`the ${format} encoder (${backend}) pads the sound and cuts at the picture length without -shortest, with no ffmpeg needed`, () => {
    const encoderArguments = frameEncoderArguments({ output: 'o.mp4', fps: 24, format, backend, audioArguments: ['-i', 'a.wav'],
      audioCodec: 'aac', frameCount: 12, width: 64, height: 64 });
    assert.ok(!encoderArguments.includes('-shortest'));
    const padIndex = encoderArguments.indexOf('-af');
    assert.equal(encoderArguments[padIndex + 1], 'apad');
    assert.equal(encoderArguments[encoderArguments.indexOf('-t') + 1], '0.500000');
  });
}

test('render-media hands the frame count to the encoder, which an audio render requires', () => {
  const options = renderEncoderOptions({ ffmpeg: 'ffmpeg', output: 'o.mp4', fps: 24, captureFormat: 'webcodecs', width: 64, height: 64,
    encoderBackend: 'cpu', audioArguments: ['-i', 'a.wav'], frameCount: 24 });
  assert.equal(options.frameCount, 24);
  assert.equal(options.format, 'h264');
  assert.doesNotThrow(() => frameEncoderArguments({ ...options, audioCodec: 'aac' }));
});

test('a rendered audio length that differs from the picture fails the render', { skip: !ffmpegAvailable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-1284-'));
  try {
    const video = join(directory, 'long-audio.mp4');
    runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=s=64x64:r=24', '-f', 'lavfi', '-i', 'sine=d=1:r=48000', '-frames:v', '24', '-pix_fmt', 'yuv420p', '-t', '1', video]);
    await assertOutputHasAudio('ffmpeg', video, 1);
    await assert.rejects(assertOutputHasAudio('ffmpeg', video, 2), /must match within 50 ms/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a page-encoded H.264 clip longer than 50 frames keeps its length and evenly spaced frame times (#2759)', { skip: !ffmpegAvailable }, async () => {
  const frameCount = 72;
  const fps = 24;
  const directory = await mkdtemp(join(tmpdir(), 'crucible-2759-'));
  try {
    const output = join(directory, 'long.mp4');
    const encoder = createFrameEncoder({ output, fps, format: 'h264', frameCount });
    encoder.writeChunk(await readFile(new URL('./fixtures/page-encoder-72-frames-24fps.h264', import.meta.url)));
    await encoder.finish();
    await encoder.close();
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', output]);
    const times = String(probe.stdout).trim().split(/\r?\n/).map(Number);
    assert.equal(times.length, frameCount);
    times.forEach((time, index) => assert.ok(Math.abs(time - index / fps) < 0.001, `frame ${index} is at ${time}`));
    assert.ok(Math.abs(await measureStreamSeconds('ffmpeg', output, 'video') - frameCount / fps) < 0.01);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stills are distinct files frame-0 to frame-7 beside --output, however short the duration', () => {
  const names = stillPaths(join('out', 's.png'), 8, 'png');
  assert.equal(new Set(names).size, 8);
  assert.match(names[0], /frame-0\.png$/);
  assert.match(names[7], /frame-7\.png$/);
  assert.match(stillPath(join('out', 's.jpg'), 3, 'jpeg'), /frame-3\.jpg$/);
});

test('a derived video dimension is rounded to even and a passed odd one is still refused', () => {
  const derived = parseRenderOptions(['--kind', 'video', '--width', '1000']);
  assert.deepEqual([derived.width, derived.height], [1000, 562]);
  const portrait = parseRenderOptions(['--kind', 'video', '--width', '1000', '--aspect', 'portrait']);
  assert.deepEqual([portrait.width, portrait.height], [1000, 1778]);
  assert.throws(() => parseRenderOptions(['--kind', 'video', '--width', '1001', '--height', '564']), /even/);
  assert.equal(parseRenderOptions(['--kind', 'image', '--width', '1000']).height, 563);
});

test('the in-page encoder keeps the sharp quantizer 16 chosen from PSNR against lossless frames (#3366)', () => {
  assert.equal(DEFAULT_PAGE_ENCODER_QUANTIZER, 16);
});

test('the page-encoded H.264 copy path marks its full-range BT.709 picture, and no other path does (#3366)', () => {
  const common = { output: 'o.mp4', fps: 24, audioArguments: [], audioCodec: 'aac', frameCount: 12, width: 64, height: 64, backend: 'cpu' };
  const copied = frameEncoderArguments({ ...common, format: 'h264' });
  const filter = copied[copied.indexOf('-bsf:v') + 1];
  assert.match(filter, /^h264_metadata=video_full_range_flag=1:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1,setts=/);
  assert.equal(copied[copied.indexOf('-color_range') + 1], 'pc');
  for (const format of ['jpeg', 'png', 'rawvideo']) {
    const encoded = frameEncoderArguments({ ...common, format });
    assert.ok(!encoded.includes('-color_range'), `${format} frames are converted by ffmpeg and keep its own range`);
    assert.ok(!encoded.join(' ').includes('h264_metadata'));
  }
});

test('a page-encoded clip reads back as full range, so players do not stretch its contrast (#3366)', { skip: !ffmpegAvailable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-3366-'));
  try {
    const output = join(directory, 'range.mp4');
    const encoder = createFrameEncoder({ output, fps: 24, format: 'h264', frameCount: 72 });
    encoder.writeChunk(await readFile(new URL('./fixtures/page-encoder-72-frames-24fps.h264', import.meta.url)));
    await encoder.finish();
    await encoder.close();
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_range,color_space', '-of', 'csv=p=0', output]);
    assert.equal(String(probe.stdout).trim(), 'pc,bt709');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
