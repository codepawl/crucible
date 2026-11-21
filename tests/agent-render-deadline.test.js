import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRenderJobs, deadlineFailureMessage, measuredDeadlineMs } from '../scripts/agent-render-jobs.mjs';

const limits = { maxOutputBytes: 1024, maxFrameBytes: 128, maxStoreBytes: 1024 ** 2, cleanupMs: 5000 };

async function temporaryDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-render-deadline-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('measuredDeadlineMs follows the measured frame cost and stays inside the ceiling (#2809)', () => {
  const fixedDeadlineMs = 300000;
  assert.equal(measuredDeadlineMs({ fixedDeadlineMs, elapsedMs: 0, framesDone: 0, frameCount: 120 }), fixedDeadlineMs, 'no frame yet: the fixed deadline');
  assert.equal(measuredDeadlineMs({ fixedDeadlineMs, elapsedMs: 1000, framesDone: 1, frameCount: 120 }), fixedDeadlineMs, 'a cheap frame never shortens it');
  assert.equal(measuredDeadlineMs({ fixedDeadlineMs, elapsedMs: 4700 * 10, framesDone: 10, frameCount: 120 }), 4700 * 120 * 1.5);
  assert.equal(measuredDeadlineMs({ fixedDeadlineMs, elapsedMs: 60000, framesDone: 1, frameCount: 120 }, 1800000), 1800000, 'capped by the ceiling');
});

test('the deadline failure says how far the job got and how long a frame took (#2809)', () => {
  assert.match(deadlineFailureMessage({ elapsedMs: 296000, framesDone: 63, frameCount: 120 }), /after 63 of 120 frames in 296 s \(about 4\.7 s a frame\)/);
  assert.match(deadlineFailureMessage({ elapsedMs: 61000, framesDone: 0, frameCount: 120 }), /before the first of 120 frames finished/);
});

test('a video slower than 2 s a frame is not failed while it keeps finishing frames, and a stall still is (#2809)', async context => {
  const root = await temporaryDirectory(context);
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let reachedFrame100;
  const framesRendered = new Promise(resolve => { reachedFrame100 = resolve; });
  const controller = await createAgentRenderJobs({ root, limits, async run({ progress, startRenderClock, signal }) {
    startRenderClock();
    for (let frames = 1; frames <= 100; frames += 1) {
      context.mock.timers.tick(5000);
      await progress({ frames, maximumPendingFrames: 0 });
    }
    reachedFrame100();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  } });
  const { jobId } = await controller.submit({
    sourceRevision: 7,
    snapshot: { recipe: { format: 'fixture', color: [1, 0, 0] } },
    settings: { kind: 'video', width: 64, height: 64, fps: 10, duration: 12 },
  });
  await framesRendered;
  assert.equal(controller.status(jobId).state, 'running', '100 frames at 5 s pass the fixed 300 s deadline of 120 frames');
  context.mock.timers.tick(500000);
  while (!['completed', 'failed', 'cancelled'].includes(controller.status(jobId).state)) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const failed = controller.status(jobId);
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /after 100 of 120 frames/);
  context.mock.timers.reset();
  await controller.close();
});
