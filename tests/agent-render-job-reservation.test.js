// The render job store holds space for a job by that job's own estimated size, not by the output cap (#2286).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { artifactNames, createAgentRenderJobs, outputReservationBytes } from '../scripts/agent-render-jobs.mjs';

const MIB = 1024 ** 2;
const OUTPUT_CAP_BYTES = 64 * MIB;
const FRAME_LIMIT_BYTES = 12 * MIB;
const stillsSubmission = { sourceRevision: 1, snapshot: { recipe: { format: 'fixture' } }, settings: { kind: 'stills', width: 512, height: 512, stillCount: 8 } };
const imageSubmission = { sourceRevision: 1, snapshot: { recipe: { format: 'fixture' } }, settings: { kind: 'image', width: 64, height: 64 } };

/** Writes `bytesPerArtifact(jobNumber)` bytes into every artifact the job promises, then reports one frame of progress. */
function runnerWriting(bytesPerArtifact) {
  let jobNumber = 0;
  return async function run({ directory, settings, progress }) {
    jobNumber += 1;
    const names = artifactNames(settings.kind, settings.passes, settings.format, settings.multilayer, settings.frameCount, settings.mattes, settings);
    const artifacts = [];
    for (const filename of names) {
      await writeFile(join(directory, `${filename}.partial`), Buffer.alloc(bytesPerArtifact(jobNumber), 1));
      artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: filename.endsWith('.png') ? 'image/png' : 'application/octet-stream' });
    }
    await progress({ frames: 1, maximumPendingFrames: 1 });
    return { artifacts, metrics: {} };
  };
}

async function withController(context, { maxStoreBytes, run }) {
  const root = await mkdtemp(join(tmpdir(), 'crucible-render-reservation-'));
  const limits = { maxOutputBytes: OUTPUT_CAP_BYTES, maxFrameBytes: FRAME_LIMIT_BYTES, maxStoreBytes, cleanupMs: 100 };
  const controller = await createAgentRenderJobs({ root, limits, run });
  context.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return controller;
}

async function settle(controller, jobId) {
  while (!['completed', 'failed', 'cancelled'].includes(controller.status(jobId).state)) await new Promise(resolve => setTimeout(resolve, 2));
  return controller.status(jobId);
}

async function submitUntilRefused(controller, submission) {
  const admitted = [];
  for (;;) {
    let jobId;
    try {
      ({ jobId } = await controller.submit(submission));
    } catch (error) {
      return { admitted, refusal: error };
    }
    assert.equal((await settle(controller, jobId)).state, 'completed');
    admitted.push(jobId);
  }
}

test('the reservation grows with frames, pixels, passes and mattes and never passes the output cap', () => {
  const base = { kind: 'stills', width: 1080, height: 1080, frameCount: 8 };
  const reserved = settings => outputReservationBytes({ ...base, ...settings }, OUTPUT_CAP_BYTES);
  const wideCap = 128 * MIB;
  assert.ok(reserved({ frameCount: 16 }) > reserved({ frameCount: 8 }));
  assert.ok(reserved({ width: 1920, height: 1080 }) > reserved({}));
  assert.ok(reserved({ passes: ['depth'] }) > reserved({}));
  assert.ok(reserved({ mattes: ['a'] }) > reserved({}));
  assert.ok(reserved({ format: 'exr' }) > reserved({}));
  assert.ok(reserved({ kind: 'video', frameCount: 8 }) < reserved({}));
  assert.ok(outputReservationBytes({ ...base, frameCount: 72 }, wideCap) < wideCap, 'a 72 frame 1080x1080 stills job holds less than the 128 MiB cap');
  assert.equal(reserved({ frameCount: 5000, width: 4096, height: 4096 }), OUTPUT_CAP_BYTES);
  assert.ok(reserved({ kind: 'image', frameCount: 1 }) < 4 * MIB, 'one 1080p image holds a few MiB, not the 64 MiB cap');
});

test('a small job holds its own size, so many more unread jobs fit than under a fixed output reservation', async context => {
  const controller = await withController(context, { maxStoreBytes: 130 * MIB, run: runnerWriting(() => MIB / 2) });
  const { admitted } = await submitUntilRefused(controller, stillsSubmission);
  // Each job writes 4 MiB. A fixed 64 MiB reservation stops at 17 jobs; its own estimate (about 4.6 MiB) allows 31.
  assert.ok(admitted.length >= 28, `${admitted.length} jobs fit`);
});

test('a job that writes past its reservation still finishes while the store has room', async context => {
  const controller = await withController(context, { maxStoreBytes: 128 * MIB, run: runnerWriting(() => 12 * MIB) });
  const { jobId } = await controller.submit(imageSubmission);
  const record = await settle(controller, jobId);
  assert.equal(record.state, 'completed', record.reason);
});

test('a job that writes past its reservation stops when the store has no room for another frame', async context => {
  const controller = await withController(context, { maxStoreBytes: 20 * MIB, run: runnerWriting(() => 12 * MIB) });
  const { jobId } = await controller.submit(imageSubmission);
  const record = await settle(controller, jobId);
  assert.equal(record.state, 'failed');
  assert.match(record.reason, /passed the space held for it/);
  assert.ok(record.reason.includes('scene_render_release on ' + jobId), record.reason);
});

test('a full store names the largest finished jobs with their sizes and the two tools to use', async context => {
  const sizes = [0.5, 1.5, 1, 2, 1.25];
  const controller = await withController(context, { maxStoreBytes: 8 * MIB, run: runnerWriting(jobNumber => (sizes[jobNumber - 1] ?? 1) * MIB) });
  const jobIds = [];
  for (const [index] of sizes.entries()) {
    const { jobId } = await controller.submit(imageSubmission).catch(error => assert.fail(`job ${index} refused early: ${error.message}`));
    await settle(controller, jobId);
    jobIds.push(jobId);
  }
  const refusal = await controller.submit(imageSubmission).then(() => assert.fail('the store should be full'), error => error.message);
  assert.match(refusal, /scene_render_result/);
  assert.match(refusal, /scene_render_release/);
  const [largest, second, third, fourth] = [jobIds[3], jobIds[1], jobIds[4], jobIds[2]];
  assert.ok(refusal.indexOf(largest) < refusal.indexOf(second) && refusal.indexOf(second) < refusal.indexOf(third), refusal);
  assert.ok(refusal.includes(`${largest} (2 MiB)`), refusal);
  assert.ok(!refusal.includes(fourth), 'only the largest three are named');
  assert.ok(refusal.length < 500, `${refusal.length} characters`);
});
