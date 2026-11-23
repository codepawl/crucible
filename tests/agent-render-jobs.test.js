import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, link, unlink, open, rename as renameFile } from 'node:fs/promises';
import { watch, writeFileSync } from 'node:fs';
import { tmpdir, constants, setPriority } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createAgentRenderJobs, jobDeadlineMs, frameByteLimitFor, oversizeFrameBudgetError } from '../scripts/agent-render-jobs.mjs';
import { planRenderSize } from '../src/budget.js';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
// close() waits this long for an aborted job to settle. It is a liveness bound, not a speed target: under load the
// settle step (a few file writes) can take far longer than 100 ms. The test that proves the bound uses its own 10 ms.
const LIVENESS_BOUND_MILLISECONDS = 5000;
const limits = { maxOutputBytes: 1024, maxFrameBytes: 128, maxStoreBytes: 1024 ** 2, cleanupMs: LIVENESS_BOUND_MILLISECONDS };
const request = () => ({ sourceRevision: 7, snapshot: { recipe: { format: 'fixture', color: [1, 0, 0] } }, settings: { kind: 'image', width: 64, height: 64 } });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function temporary(context) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-render-controller-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A hung job fails through the test timeout instead of a wall-clock bound inside the poll loop.
// The bound is for liveness, not speed: CPU-heavy test files run in parallel and slow every job down.
const TEST_TIMEOUT_MILLISECONDS = 60000;
const test = (name, body) => nodeTest(name, { timeout: TEST_TIMEOUT_MILLISECONDS }, body);

async function terminal(controller, jobId) {
  while (!['completed', 'cancelled', 'failed', 'interrupted'].includes(controller.status(jobId).state)) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  return controller.status(jobId);
}

async function writeImage({ directory, progress }) {
  await writeFile(join(directory, 'render.png.partial'), Buffer.from('fixture PNG bytes'));
  await progress({ frames: 1, maximumPendingFrames: 1 });
  return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }], metrics: { maximumPendingFrames: 1 } };
}

test('motion job ranges use immutable recipe duration, loops and actual sample times across restart', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const input = request();
  input.snapshot.recipe = { format: 'crucible.scene', motion: { duration: 1, loop: false } };
  input.settings.motion = { start: 1 };
  const submitted = await controller.submit(input);
  await terminal(controller, submitted.jobId);
  assert.equal(controller.status(submitted.jobId).settings.motion.start, 1);
  input.settings = { kind: 'stills', width: 64, height: 64, duration: 1, motion: { start: 0.1 } };
  await assert.rejects(controller.submit(input), /Motion range/);
  input.snapshot.recipe.motion.loop = true;
  input.settings.motion.start = 3600;
  await assert.rejects(controller.submit(input), /motion.start 3600 plus the last sample at 1 s is 3601 s; the motion clock stops at 3600 s. Lower motion.start or duration./);
  input.settings.motion.start = null;
  await assert.rejects(controller.submit(input), /motion start/);
  input.snapshot.recipe = { format: 'crucible.asset', motion: { duration: 1 } };
  input.settings.motion.start = 0;
  await assert.rejects(controller.submit(input), /Asset snapshot bytes/);
  const assetBytes = Buffer.from('owned motion asset bytes');
  input.snapshot.assetBytes = assetBytes;
  input.snapshot.recipe.assetId = createHash('sha256').update(assetBytes).digest('hex');
  input.settings = { kind: 'image', width: 64, height: 64, motion: { start: 0.5 } };
  const assetSubmitted = await controller.submit(input);
  assert.equal((await terminal(controller, assetSubmitted.jobId)).state, 'completed');
  assert.equal(controller.status(assetSubmitted.jobId).settings.motion.start, 0.5);
  await controller.close();
  const reopened = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.equal(reopened.status(submitted.jobId).settings.motion.start, 1);
  assert.equal(reopened.status(assetSubmitted.jobId).settings.motion.start, 0.5);
  await reopened.release(submitted.jobId);
  await reopened.release(assetSubmitted.jobId);
  await reopened.close();
});

test('a scene that places a clip takes motion settings without authored motion, one that places a still asset does not', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const id = 'a'.repeat(64);
  const input = request();
  input.settings = { kind: 'image', width: 64, height: 64, motion: { start: 2 } };
  input.snapshot.recipe = { format: 'crucible.scene', nodes: [{ id: 'walker', asset: { id, clip: { index: 0 } } }] };
  const submitted = await controller.submit(input);
  assert.equal((await terminal(controller, submitted.jobId)).state, 'completed');
  assert.equal(controller.status(submitted.jobId).settings.motion.start, 2);
  input.snapshot.recipe = { format: 'crucible.scene', nodes: [{ id: 'prop', asset: { id } }] };
  await assert.rejects(controller.submit(input), /authored motion, physics .* a placed clip/);
  await controller.release(submitted.jobId);
  await controller.close();
});

test('a scene with physics takes motion settings, defaults the video to the bake length and stops at its end', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const input = request();
  input.snapshot.recipe = { format: 'crucible.scene', physics: { duration: 2, bodies: [] } };
  input.settings = { kind: 'video', width: 64, height: 64, fps: 10, motion: { start: 0 } };
  const submitted = await controller.submit(input);
  assert.equal(controller.status(submitted.jobId).settings.duration, 2);
  assert.equal(controller.status(submitted.jobId).settings.frameCount, 20);
  await terminal(controller, submitted.jobId);
  input.settings.duration = 3;
  await assert.rejects(controller.submit(input), /physics bake duration of 2 s/);
  input.snapshot.recipe = { format: 'crucible.scene', cloth: { duration: 1, sheets: [] } };
  input.settings = { kind: 'image', width: 64, height: 64, motion: { start: 0.5 } };
  const clothJob = await controller.submit(input);
  assert.equal(controller.status(clothJob.jobId).settings.motion.start, 0.5);
  await terminal(controller, clothJob.jobId);
  await controller.release(clothJob.jobId);
  await controller.release(submitted.jobId);
  await controller.close();
});

test('real files publish after success with copied snapshots, hashes and restart persistence', async context => {
  const root = await temporary(context);
  const started = deferred();
  const finish = deferred();
  let observed;
  const controller = await createAgentRenderJobs({ root, limits, async run(argumentsValue) {
    observed = argumentsValue.snapshot;
    started.resolve();
    await finish.promise;
    return writeImage(argumentsValue);
  } });
  const input = request();
  input.snapshot.assetBytes = Buffer.from('owned bytes');
  const submitting = controller.submit(input);
  input.sourceRevision = 99;
  const submitted = await submitting;
  assert.equal(submitted.sourceRevision, 7);
  assert.equal(submitted.state, 'queued');
  await started.promise;
  input.snapshot.recipe.color[0] = 0;
  input.snapshot.assetBytes.fill(0);
  assert.deepEqual(observed.recipe.color, [1, 0, 0]);
  assert.equal(observed.assetBytes.toString(), 'owned bytes');
  assert.throws(() => controller.result(submitted.jobId), /No completed result/);
  await assert.rejects(controller.submit(request()), /already active/);
  finish.resolve();
  assert.equal((await terminal(controller, submitted.jobId)).state, 'completed');
  const result = controller.result(submitted.jobId);
  const bytes = await readFile(join(root, submitted.jobId, 'render.png'));
  assert.equal(result.artifacts[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.artifacts[0].bytes, bytes.length);
  assert.equal(Object.hasOwn(result.artifacts[0], 'path'), false);
  assert.equal((await readdir(join(root, submitted.jobId))).includes('render.png.partial'), false);
  result.artifacts[0].filename = '../foreign';
  assert.equal(controller.result(submitted.jobId).artifacts[0].filename, 'render.png');
  await controller.close();
  const recovered = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.equal(recovered.status(submitted.jobId).state, 'completed');
  assert.deepEqual(recovered.result(submitted.jobId).metrics, { maximumPendingFrames: 1 });
  await recovered.release(submitted.jobId);
  assert.throws(() => recovered.status(submitted.jobId), /Unknown/);
  await recovered.close();
});

test('cancel acknowledges immediately and blocks output publication after runner writes a partial', async context => {
  const root = await temporary(context);
  const started = deferred();
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory, signal }) {
    await writeFile(join(directory, 'render.png.partial'), 'partial bytes');
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }] };
  } });
  const { jobId } = await controller.submit(request());
  await started.promise;
  assert.equal(controller.cancel(jobId).state, 'cancelling');
  await assert.rejects(controller.release(jobId), /settle/);
  assert.equal((await terminal(controller, jobId)).state, 'cancelled');
  assert.equal((await readdir(join(root, jobId))).includes('render.png'), false);
  assert.throws(() => controller.result(jobId), /cancelled/);
  await controller.close();
});

test('deadline aborts a cooperative callback and close detects an uncooperative callback without releasing its lock', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits: { ...limits, deadlineMs: 10 }, async run({ signal, startRenderClock }) {
    startRenderClock();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  } });
  const { jobId } = await controller.submit(request());
  const failed = await terminal(controller, jobId);
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /deadline/);
  assert.match(failed.reason, /submit the job again/);
  await controller.close();
  const started = deferred();
  const finish = deferred();
  const hung = await createAgentRenderJobs({ root, limits: { ...limits, cleanupMs: 10 }, async run(argumentsValue) {
    started.resolve();
    await finish.promise;
    return writeImage(argumentsValue);
  } });
  const hungJob = await hung.submit(request());
  await started.promise;
  await assert.rejects(hung.close(), /did not settle/);
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), /live process.*own --jobs folder/);
  finish.resolve();
  assert.equal((await terminal(hung, hungJob.jobId)).state, 'cancelled');
  await hung.close();
});

test('1920x1080 and 1080x1920 jobs are admitted', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  for (const [width, height] of [[1920, 1080], [1080, 1920]]) {
    const { jobId } = await controller.submit({ ...request(), settings: { kind: 'image', width, height } });
    assert.equal((await terminal(controller, jobId)).settings.width, width);
  }
  await controller.close();
});

test('an image job takes up to 3840x2160 and the frame byte limit grows with its pixels', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  for (const [width, height] of [[2880, 1620], [3840, 2160], [2160, 3840]]) {
    const { jobId } = await controller.submit({ ...request(), settings: { kind: 'image', width, height } });
    assert.equal((await terminal(controller, jobId)).settings.height, height);
  }
  await assert.rejects(controller.submit({ ...request(), settings: { kind: 'video', width: 1920, height: 1081 } }), /1920x1080 \(only an image job goes up to 3840x2160; a square frame fits up to 1440x1440\)/);
  assert.equal(frameByteLimitFor(1920, 1080, 12), 12);
  assert.equal(frameByteLimitFor(2880, 1620, 12), 36);
  assert.equal(frameByteLimitFor(3840, 2160, 12), 48);
  await controller.close();
});

const MEBIBYTE = 1024 ** 2;

function planFor({ width, height, memoryBudgetMiB, hdr, depth, textureBytes = 20 * MEBIBYTE, geometryBytes = 3 * MEBIBYTE }) {
  return planRenderSize({ width, height, samples: 4, memoryBudgetMiB, geometryBytes, textureBytes, hdr, bloom: true, depth });
}

test('a frame over 1920x1080 that the memory budget shrinks is refused with a --memory that really renders it', () => {
  const requested = { width: 2880, height: 1620 };
  const maximumMemoryMiB = 384;
  for (const { hdr, depth, expectedMiB } of [
    { hdr: false, depth: false, expectedMiB: 280 }, { hdr: true, depth: false, expectedMiB: 378 }, { hdr: true, depth: true, expectedMiB: 395 },
  ]) {
    const plan = planFor({ ...requested, memoryBudgetMiB: 192, hdr, depth });
    assert.ok(plan.reduced);
    const error = oversizeFrameBudgetError({ requested, rendered: plan, plan, memoryMiB: 192, maximumMemoryMiB: 1024 });
    const neededMiB = Number(/--memory ([0-9]+) or more/.exec(error.message)[1]);
    assert.equal(neededMiB, expectedMiB);
    assert.equal(planFor({ ...requested, memoryBudgetMiB: neededMiB, hdr, depth }).reduced, false, 'the named --memory renders the full size at once');
    assert.equal(planFor({ ...requested, memoryBudgetMiB: neededMiB - 1, hdr, depth }).reduced, true, 'and one MiB less does not');
  }
  const withDepth = planFor({ ...requested, memoryBudgetMiB: 192, hdr: true, depth: true });
  const overCeiling = oversizeFrameBudgetError({ requested, rendered: withDepth, plan: withDepth, memoryMiB: 192, maximumMemoryMiB });
  assert.match(overCeiling.message, /needs about 395 MiB, over the 384 MiB ceiling.*smaller size/);
});

test('a frame rendered at the size asked for, and a 1080p-class frame that was reduced, raise no oversize error', () => {
  const requested = { width: 2880, height: 1620 };
  const roomy = planFor({ ...requested, memoryBudgetMiB: 384, hdr: false, depth: false });
  assert.equal(oversizeFrameBudgetError({ requested, rendered: roomy, plan: roomy, memoryMiB: 384, maximumMemoryMiB: 384 }), undefined);
  const small = planFor({ width: 1920, height: 1080, memoryBudgetMiB: 96, hdr: false, depth: false, textureBytes: 0 });
  assert.ok(small.reduced);
  assert.equal(oversizeFrameBudgetError({ requested: { width: 1920, height: 1080 }, rendered: small, plan: small, memoryMiB: 96, maximumMemoryMiB: 384 }), undefined);
});

test('the stored frame limit scales with the pixels: a 2880x1620 job admits a frame that a 1920x1080 job refuses', async context => {
  const root = await temporary(context);
  const writeFrameOfBytes = frameBytes => async ({ directory, progress }) => {
    await writeFile(join(directory, 'render.png.partial'), Buffer.alloc(frameBytes));
    await progress({ frames: 1, maximumPendingFrames: 1 });
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }], metrics: { maximumPendingFrames: 1 } };
  };
  const bytesBetweenOneAndThreeTimesTheLimit = limits.maxFrameBytes * 2;
  const large = await createAgentRenderJobs({ root, limits, run: writeFrameOfBytes(bytesBetweenOneAndThreeTimesTheLimit) });
  const admitted = await terminal(large, (await large.submit({ ...request(), settings: { kind: 'image', width: 2880, height: 1620 } })).jobId);
  assert.equal(admitted.state, 'completed');
  assert.equal(admitted.artifacts[0].bytes, bytesBetweenOneAndThreeTimesTheLimit);
  await large.close();
  const standardRoot = await temporary(context);
  const standard = await createAgentRenderJobs({ root: standardRoot, limits, run: writeFrameOfBytes(bytesBetweenOneAndThreeTimesTheLimit) });
  const refused = await terminal(standard, (await standard.submit({ ...request(), settings: { kind: 'image', width: 1920, height: 1080 } })).jobId);
  assert.equal(refused.state, 'failed');
  await standard.close();
});

test('validation enforces range, geometry-independent storage limits and one pending frame', async context => {
  const root = await temporary(context);
  let calls = 0;
  const controller = await createAgentRenderJobs({ root, limits, async run(argumentsValue) {
    calls++;
    await argumentsValue.progress({ frames: 1, maximumPendingFrames: 2 });
    return writeImage(argumentsValue);
  } });
  for (const settings of [
    { kind: 'video', width: 65, height: 64 },
    { kind: 'image', width: 3841, height: 64 },
    { kind: 'image', width: 3840, height: 2161 },
    { kind: 'image', width: 3840, height: 3840 },
    { kind: 'stills', width: 1921, height: 64 },
    { kind: 'stills', width: 1920, height: 1081 },
    { kind: 'video', width: 2880, height: 1620 },
    { kind: 'video', width: 64, height: 64, fps: 61 },
    { kind: 'video', width: 64, height: 64, duration: 61 },
  ]) await assert.rejects(controller.submit({ ...request(), settings }));
  await assert.rejects(controller.submit({ ...request(), snapshot: { recipe: {}, clips: [{ duration: 1 }] }, settings: { kind: 'video', width: 64, height: 64, duration: 1, animation: { clip: 0, start: 0.1 } } }), /clip duration/);
  await assert.rejects(controller.submit({ ...request(), snapshot: { recipe: { sparse: Array(2) } } }), /dense/);
  assert.equal(calls, 0);
  const { jobId } = await controller.submit(request());
  const failed = await terminal(controller, jobId);
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /pending frames/);
  await controller.close();
});

test('runner traversal and oversized outputs fail without final artifacts', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory }) {
    await writeFile(join(directory, 'render.png.partial'), Buffer.alloc(129));
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }] };
  } });
  const oversized = await controller.submit(request());
  assert.match((await terminal(controller, oversized.jobId)).reason, /byte budget/);
  await controller.close();
  const traversal = await createAgentRenderJobs({ root, limits, async run() {
    return { artifacts: [{ temporary: '../outside', filename: 'render.png', mimeType: 'image/png' }] };
  } });
  const submitted = await traversal.submit(request());
  assert.match((await terminal(traversal, submitted.jobId)).reason, /fixed filename/);
  assert.equal((await readdir(join(root, submitted.jobId))).includes('render.png'), false);
  await traversal.close();
});

test('a lock owned by a live process or written by something else is refused and left in place', async context => {
  const root = await temporary(context);
  const liveLock = JSON.stringify({ schemaVersion: 1, pid: process.pid, token: randomUUID() });
  await writeFile(join(root, 'store.lock'), liveLock);
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), /live process/);
  assert.equal(await readFile(join(root, 'store.lock'), 'utf8'), liveLock);
  const foreignLock = JSON.stringify({ schemaVersion: 2, pid: 2147483647, token: 'not-a-token' });
  await writeFile(join(root, 'store.lock'), foreignLock);
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), /Unrecognized job store lock/);
  assert.equal(await readFile(join(root, 'store.lock'), 'utf8'), foreignLock);
});

test('two takeovers of one dead lock at the same time leave exactly one owner and no raw file error', async context => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const root = await temporary(context);
    await writeFile(join(root, 'store.lock'), JSON.stringify({ schemaVersion: 1, pid: 2147483647, token: randomUUID() }));
    const outcomes = await Promise.allSettled([
      createAgentRenderJobs({ root, limits, run: writeImage }),
      createAgentRenderJobs({ root, limits, run: writeImage }),
    ]);
    const owners = outcomes.filter(outcome => outcome.status === 'fulfilled');
    const refusals = outcomes.filter(outcome => outcome.status === 'rejected');
    assert.equal(owners.length, 1, `attempt ${attempt}: exactly one controller holds the lock`);
    assert.equal(refusals.length, 1);
    assert.match(refusals[0].reason.message, /live process/);
    assert.equal(refusals[0].reason.code, undefined, 'a lost race is a clean refusal, not a raw file error');
    assert.equal(JSON.parse(await readFile(join(root, 'store.lock'), 'utf8')).pid, process.pid);
    await owners[0].value.close();
    assert.deepEqual((await readdir(root)).filter(name => name.includes('.claim-') || name.includes('.tmp-')), [], 'no takeover claim or temporary file is left behind');
  }
});

test('two slow readers of a dead lock and a fresh starter leave exactly the one controller that took it over', async context => {
  const root = await temporary(context);
  const deadToken = randomUUID();
  await writeFile(join(root, 'store.lock'), JSON.stringify({ schemaVersion: 1, pid: 2147483647, token: deadToken }));
  let openGate;
  const gate = new Promise(resolveGate => { openGate = resolveGate; });
  const pausedReaders = () => createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { beforeLockClaim: () => gate } });
  const firstReader = pausedReaders();
  const secondReader = pausedReaders();
  // The readers have both judged the lock dead and wait before claiming it, while a third controller takes the store over.
  const owner = await createAgentRenderJobs({ root, limits, run: writeImage });
  const ownedLock = await readFile(join(root, 'store.lock'), 'utf8');
  assert.notEqual(JSON.parse(ownedLock).token, deadToken);
  openGate();
  const outcomes = await Promise.allSettled([firstReader, secondReader, createAgentRenderJobs({ root, limits, run: writeImage })]);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected', 'only the controller that took the lock first owns it');
    assert.match(outcome.reason.message, /live process/);
  }
  assert.equal(await readFile(join(root, 'store.lock'), 'utf8'), ownedLock, 'the owner lock is neither replaced nor stranded');
  assert.deepEqual((await readdir(root)).filter(name => name.includes('.claim-')), []);
  await owner.close();
  assert.equal((await readdir(root)).includes('store.lock'), false);
});

test('a takeover claim left by a dead process is reported with the file to delete', async context => {
  const root = await temporary(context);
  const deadToken = randomUUID();
  const lockText = JSON.stringify({ schemaVersion: 1, pid: 2147483647, token: deadToken });
  const claimName = `store.lock.claim-${deadToken}`;
  await writeFile(join(root, 'store.lock'), lockText);
  await writeFile(join(root, claimName), JSON.stringify({ pid: 2147483647, token: randomUUID() }));
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), error => error.message.includes(claimName) && /delete/.test(error.message));
  assert.equal(await readFile(join(root, 'store.lock'), 'utf8'), lockText);
  await unlink(join(root, claimName));
  const recovered = await createAgentRenderJobs({ root, limits, run: writeImage });
  await recovered.close();
});

test('an empty or unreadable takeover claim is reported with the file to delete', async context => {
  const root = await temporary(context);
  const deadToken = randomUUID();
  const claimName = `store.lock.claim-${deadToken}`;
  await writeFile(join(root, 'store.lock'), JSON.stringify({ schemaVersion: 1, pid: 2147483647, token: deadToken }));
  for (const claimText of ['', '{"pid":']) {
    await writeFile(join(root, claimName), claimText);
    await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), error => error.message.includes(claimName) && /delete/.test(error.message));
  }
});

test('a lock that does not parse yet is refused as owned by a live starter, not as a raw syntax error', async context => {
  const root = await temporary(context);
  await writeFile(join(root, 'store.lock'), '');
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), /live process/);
  assert.equal(await readFile(join(root, 'store.lock'), 'utf8'), '');
});

test('a lock is published whole: absent while the temporary file is written, complete the moment it exists', async context => {
  const root = await temporary(context);
  const seen = [];
  const lockText = () => readFile(join(root, 'store.lock'), 'utf8').catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  const controller = await createAgentRenderJobs({
    root,
    limits,
    run: writeImage,
    lockTakeoverHooks: {
      beforeLockLink: async () => { seen.push(['before', await lockText()]); },
      afterLockLink: async () => { seen.push(['after', await lockText()]); },
    },
  });
  assert.equal(seen[0][0], 'before');
  assert.equal(seen[0][1], null, 'no lock file exists while its content is being written');
  assert.equal(seen[1][0], 'after');
  assert.equal(JSON.parse(seen[1][1]).schemaVersion, 1, 'the lock is complete as soon as it exists');
  assert.deepEqual((await readdir(root)).filter(name => name.includes('.tmp-')), [], 'no temporary file is left behind');
  await controller.close();
});

test('an unparseable lock is refused by naming the file to delete, and is not deleted', async context => {
  const root = await temporary(context);
  await writeFile(join(root, 'store.lock'), '{"schemaVersion":');
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), error => error.message.includes(join(root, 'store.lock')) && /delete/.test(error.message));
  assert.equal(await readFile(join(root, 'store.lock'), 'utf8'), '{"schemaVersion":');
});

test('when the temporary name of a new lock cannot be removed, no lock is kept and the error says so', async context => {
  const root = await temporary(context);
  const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
  const fileOperations = { unlink: async path => { if (path.includes('.tmp-')) throw busy; return unlink(path); } };
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { fileOperations } }), /Could not finish writing store\.lock.*not kept/);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('store.lock')), [], 'neither the lock nor a temporary file is left');
});

test('a failed write of the temporary file leaves no temporary file', async context => {
  const root = await temporary(context);
  const fileOperations = {
    writeFile: async (path, ...rest) => {
      await writeFile(path, 'partial', { flag: 'wx' });
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    },
  };
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { fileOperations } }), /no space left/);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('store.lock')), []);
});

test('when hard links are unsupported and the fallback write fails, the half-made lock is removed', async context => {
  const root = await temporary(context);
  const fileOperations = {
    link: async () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); },
    open: async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      return { writeFile: async () => { throw new Error('no space left on device'); }, close: () => handle.close() };
    },
  };
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { fileOperations } }), /no space left/);
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith('store.lock')), []);
  const recovered = await createAgentRenderJobs({ root, limits, run: writeImage });
  await recovered.close();
});

test('a starter whose dead lock was replaced by another dead lock starts again and takes that one over',async context => {
  const root = await temporary(context);
  await writeFile(join(root, 'store.lock'), JSON.stringify({ schemaVersion: 1, pid: 2147483647, token: randomUUID() }));
  let signalReached;
  const reached = new Promise(resolveReached => { signalReached = resolveReached; });
  let openGate;
  const gate = new Promise(resolveGate => { openGate = resolveGate; });
  const slowReader = createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { beforeLockClaim: async () => { signalReached(); await gate; } } });
  await reached;
  // A starter took the first dead lock over and then died as well, leaving a second dead lock.
  await writeFile(join(root, 'store.lock'), JSON.stringify({ schemaVersion: 1, pid: 2147483647, token: randomUUID() }));
  openGate();
  const controller = await slowReader;
  assert.equal(JSON.parse(await readFile(join(root, 'store.lock'), 'utf8')).pid, process.pid);
  assert.deepEqual((await readdir(root)).filter(name => name.includes('.claim-') || name.includes('.tmp-')), []);
  await controller.close();
});

test('restart marks unfinished records interrupted and rejects forged artifact paths', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const { jobId } = await controller.submit(request());
  await terminal(controller, jobId);
  await controller.close();
  const statusPath = join(root, jobId, 'status.json');
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  status.state = 'running';
  status.artifacts = [];
  await writeFile(statusPath, JSON.stringify(status));
  await writeFile(join(root, 'store.lock'), JSON.stringify({ schemaVersion: 1, pid: 2147483647, token: randomUUID() }));
  // The lock names a dead process, so the next controller takes it over without a manual repair.
  const recovered = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.equal(recovered.status(jobId).state, 'interrupted');
  await recovered.close();
  status.state = 'completed';
  status.artifacts = [{ filename: '../outside', mimeType: 'image/png', bytes: 1, sha256: '0'.repeat(64) }];
  await writeFile(statusPath, JSON.stringify(status));
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), /artifact name/);
});

test('incomplete admissions remain quarantined while completed jobs reopen and storage stays bounded', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const completed = await controller.submit(request());
  await terminal(controller, completed.jobId);
  await controller.close();
  const { storeId } = JSON.parse(await readFile(join(root, 'store.json'), 'utf8'));
  const staging = join(root, `.pending-${storeId}-${randomUUID()}`);
  const empty = join(root, `.pending-${storeId}-${randomUUID()}`);
  await mkdir(staging);
  await mkdir(empty);
  await writeFile(join(staging, 'owner.json'), '{');
  await writeFile(join(staging, 'snapshot.json'), '{"recipe":');
  await writeFile(join(staging, 'foreign.txt'), 'preserve me');
  const reopened = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.equal(reopened.result(completed.jobId).artifacts.length, 1);
  assert.equal(reopened.list().length, 1);
  assert.equal(await readFile(join(staging, 'foreign.txt'), 'utf8'), 'preserve me');
  assert.equal((await readdir(root)).includes(empty.split(/[\\/]/).at(-1)), false);
  await writeFile(join(staging, 'asset.glb'), Buffer.alloc(limits.maxStoreBytes));
  await assert.rejects(reopened.submit(request()), /total byte budget/);
  await reopened.close();
});

test('a real initial status write failure publishes no job and leaves admission available', async context => {
  const root = await temporary(context);
  let calls = 0;
  const controller = await createAgentRenderJobs({ root, limits, async run(argumentsValue) {
    calls++;
    return writeImage(argumentsValue);
  } });
  let staging;
  const watcher = watch(root, (event, name) => {
    if (!staging && String(name).startsWith('.pending-')) {
      staging = join(root, String(name));
      writeFileSync(join(staging, 'status.json'), 'preserve conflicting file', { flag: 'wx' });
      watcher.close();
    }
  });
  try { await assert.rejects(controller.submit(request()), /EEXIST/); }
  finally { watcher.close(); }
  assert.ok(staging);
  assert.equal(controller.list().length, 0);
  assert.equal(calls, 0);
  assert.equal(await readFile(join(staging, 'status.json'), 'utf8'), 'preserve conflicting file');
  const completed = await controller.submit(request());
  assert.equal((await terminal(controller, completed.jobId)).state, 'completed');
  assert.equal(calls, 1);
  await controller.close();
  const reopened = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.equal(reopened.result(completed.jobId).artifacts.length, 1);
  assert.equal(reopened.list().length, 1);
  await reopened.close();
});

test('release rejects aliases and foreign files before deleting owned entries', async context => {
  const parent = await temporary(context);
  const root = join(parent, 'jobs');
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const { jobId } = await controller.submit(request());
  await terminal(controller, jobId);
  const outside = join(parent, 'outside.txt');
  await writeFile(outside, 'preserve me');
  await link(outside, join(root, jobId, 'frame-0.png.partial'));
  await assert.rejects(controller.release(jobId), /aliases/);
  assert.equal(await readFile(outside, 'utf8'), 'preserve me');
  assert.ok((await readdir(join(root, jobId))).includes('status.json'));
  await controller.close();
  const foreignRoot = join(parent, 'foreign');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(foreignRoot);
  await writeFile(join(foreignRoot, 'keep.txt'), 'untouched');
  await assert.rejects(createAgentRenderJobs({ root: foreignRoot, limits, run: writeImage }), /foreign/);
  assert.equal(await readFile(join(foreignRoot, 'keep.txt'), 'utf8'), 'untouched');
});

test('record quota requires explicit release and completed artifact integrity survives reopening', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits: { ...limits, maxRecords: 1 }, run: writeImage });
  const { jobId } = await controller.submit(request());
  await terminal(controller, jobId);
  await assert.rejects(controller.submit(request()), /record budget/);
  await controller.close();
  await writeFile(join(root, jobId, 'render.png'), 'corrupted');
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), /integrity/);
});

test('asset digests bind immutable bytes and still/video settings produce only their fixed artifacts', async context => {
  const root = await temporary(context);
  const assetBytes = Buffer.from('bounded embedded GLB fixture');
  const assetId = createHash('sha256').update(assetBytes).digest('hex');
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory, settings, snapshot, progress }) {
    assert.equal(snapshot.recipe.assetId, createHash('sha256').update(snapshot.assetBytes).digest('hex'));
    const filenames = settings.kind === 'stills' ? Array.from({ length: 8 }, (_, index) => `frame-${index}.png`) : ['render.mp4'];
    const artifacts = [];
    for (const filename of filenames) {
      await writeFile(join(directory, `${filename}.partial`), Buffer.alloc(32, 1));
      artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: settings.kind === 'video' ? 'video/mp4' : 'image/png' });
    }
    await progress({ frames: settings.frameCount, maximumPendingFrames: 1 });
    return { artifacts, metrics: { frameCount: settings.frameCount } };
  } });
  const snapshot = { recipe: { format: 'crucible.asset', assetId }, assetBytes, clips: [{ duration: 5 }] };
  await assert.rejects(controller.submit({ sourceRevision: 1, snapshot: { ...snapshot, assetBytes: Buffer.from('changed') }, settings: { kind: 'image', width: 64, height: 64 } }), /SHA256/);
  for (const kind of ['stills', 'video']) {
    const { jobId } = await controller.submit({ sourceRevision: 1, snapshot, settings: { kind, width: 64, height: 64, duration: 1, fps: 12, animation: { clip: 0, start: 2 }, rendererTime: { start: 3, rate: -1 } } });
    assert.equal((await terminal(controller, jobId)).state, 'completed');
    const result = controller.result(jobId);
    assert.equal(result.artifacts.length, kind === 'stills' ? 8 : 1);
    assert.equal(result.metrics.frameCount, kind === 'stills' ? 8 : 12);
    assert.deepEqual(controller.status(jobId).settings.rendererTime, { start: 3, rate: -1 });
  }
  await controller.close();
});

test('a path tracer job names its denoiser, and oidn defaults to 16 samples instead of 64', async context => {
  const root = await temporary(context);
  const assetBytes = Buffer.from('bounded embedded GLB fixture');
  const assetId = createHash('sha256').update(assetBytes).digest('hex');
  const snapshot = { recipe: { format: 'crucible.asset', assetId }, assetBytes, clips: [{ duration: 5 }] };
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory }) {
    await writeFile(join(directory, 'render.png.partial'), Buffer.alloc(32, 1));
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }], metrics: {} };
  } });
  const submitWith = renderer => controller.submit({ sourceRevision: 1, snapshot, settings: { kind: 'image', width: 64, height: 64, renderer: { type: 'pathTracer', ...renderer } } });
  const expectations = [[{}, true, 64], [{ denoise: 'oidn' }, 'oidn', 16], [{ denoise: 'oidn', samples: 8 }, 'oidn', 8], [{ denoise: 'wavelet' }, 'wavelet', 64], [{ denoise: false }, false, 64]];
  for (const [renderer, denoise, samples] of expectations) {
    const job = await submitWith(renderer);
    await terminal(controller, job.jobId);
    const settings = controller.status(job.jobId).settings.renderer;
    assert.equal(settings.denoise, denoise);
    assert.equal(settings.samples, samples);
  }
  await assert.rejects(submitWith({ denoise: 'bm3d' }), /denoise must be/);
  await controller.close();
});

test('a path tracer job draws every sample unless it passes a noise threshold, which stays within 0 to 0.1', async context => {
  const root = await temporary(context);
  const assetBytes = Buffer.from('bounded embedded GLB fixture');
  const assetId = createHash('sha256').update(assetBytes).digest('hex');
  const snapshot = { recipe: { format: 'crucible.asset', assetId }, assetBytes, clips: [{ duration: 5 }] };
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory }) {
    await writeFile(join(directory, 'render.png.partial'), Buffer.alloc(32, 1));
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }], metrics: {} };
  } });
  const submitWith = renderer => controller.submit({ sourceRevision: 1, snapshot, settings: { kind: 'image', width: 64, height: 64, renderer: { type: 'pathTracer', ...renderer } } });
  const defaulted = await submitWith({});
  await terminal(controller, defaulted.jobId);
  assert.equal(controller.status(defaulted.jobId).settings.renderer.noiseThreshold, 0);
  const adaptive = await submitWith({ noiseThreshold: 0.03 });
  await terminal(controller, adaptive.jobId);
  assert.equal(controller.status(adaptive.jobId).settings.renderer.noiseThreshold, 0.03);
  for (const noiseThreshold of [-0.01, 0.11, Number.NaN]) await assert.rejects(submitWith({ noiseThreshold }), /noiseThreshold/);
  await controller.close();
});

test('a path tracer job runs on the cpu unless it asks for the gpu, and film jobs may trace every frame', async context => {
  const root = await temporary(context);
  const assetBytes = Buffer.from('bounded embedded GLB fixture');
  const assetId = createHash('sha256').update(assetBytes).digest('hex');
  const snapshot = { recipe: { format: 'crucible.asset', assetId }, assetBytes, clips: [{ duration: 5 }] };
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory }) {
    await writeFile(join(directory, 'render.png.partial'), Buffer.alloc(32, 1));
    return { artifacts: [{ temporary: 'render.png.partial', filename: 'render.png', mimeType: 'image/png' }], metrics: {} };
  } });
  const submitWith = (renderer, kind = 'image') => controller.submit({ sourceRevision: 1, snapshot, settings: { kind, width: 64, height: 64, ...(kind === 'image' ? {} : { duration: 1, fps: 2 }), renderer: { type: 'pathTracer', ...renderer } } });
  const defaulted = await submitWith({});
  await terminal(controller, defaulted.jobId);
  assert.equal(controller.status(defaulted.jobId).settings.renderer.backend, 'cpu');
  const onGpu = await submitWith({ backend: 'gpu' });
  await terminal(controller, onGpu.jobId);
  assert.equal(controller.status(onGpu.jobId).settings.renderer.backend, 'gpu');
  const onNative = await submitWith({ backend: 'native' });
  await terminal(controller, onNative.jobId);
  assert.equal(controller.status(onNative.jobId).settings.renderer.backend, 'native');
  await assert.rejects(submitWith({ backend: 'metal' }), /backend must be cpu, gpu or native/);
  const film = await submitWith({ backend: 'gpu', samples: 16 }, 'video');
  assert.equal(controller.status(film.jobId).settings.renderer.samples, 16);
  await terminal(controller, film.jobId);
  await controller.close();
});

test('the elapsed deadline starts when rendering starts, so queue wait does not count against it (#1256)', async context => {
  const root = await temporary(context);
  // Mocked timers make the clocks deterministic: no wall-clock stall on a shared runner can expire the deadline.
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const queueWaitedPastDeadline = deferred();
  const controller = await createAgentRenderJobs({ root, limits: { ...limits, deadlineMs: 100, queueWaitMs: 2000 }, async run(argumentsValue) {
    await queueWaitedPastDeadline.promise;
    argumentsValue.startRenderClock();
    return writeImage(argumentsValue);
  } });
  const { jobId } = await controller.submit(request());
  const settle = () => new Promise(resolve => setImmediate(resolve));
  while (controller.status(jobId).state !== 'running') await settle();
  context.mock.timers.tick(300);
  assert.equal(controller.status(jobId).state, 'running', 'queue wait past the deadline must not fail the job');
  queueWaitedPastDeadline.resolve();
  while (!['completed', 'failed'].includes(controller.status(jobId).state)) await settle();
  assert.equal(controller.status(jobId).state, 'completed');
  context.mock.timers.reset();
  await controller.close();
});

test('the queue wait must be a finite whole number of milliseconds within the bound (#1256)', async context => {
  const root = await temporary(context);
  for (const queueWaitMs of [Number.NaN, -1, 0, 1.5, 5 * 60 * 1000 + 1]) {
    await assert.rejects(createAgentRenderJobs({ root, limits: { ...limits, queueWaitMs }, async run() {} }), /queueWaitMs must be within 1 and 300000/);
  }
});

test('a job that waits past the queue bound fails with its own message (#1256)', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits: { ...limits, deadlineMs: 5000, queueWaitMs: 30 }, async run({ signal }) {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  } });
  const { jobId } = await controller.submit(request());
  const failed = await terminal(controller, jobId);
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /queue wait deadline/);
  await controller.close();
});

test('rendering that outlasts the elapsed deadline after the clock started still fails (#1256)', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits: { ...limits, deadlineMs: 40, queueWaitMs: 2000 }, async run({ signal, startRenderClock }) {
    startRenderClock();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  } });
  const { jobId } = await controller.submit(request());
  const failed = await terminal(controller, jobId);
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /elapsed deadline/);
  await controller.close();
});

test('the deadline of a traced film covers every frame', () => {
  const renderer = { type: 'pathTracer', maxSeconds: 10 };
  const single = jobDeadlineMs({ frameCount: 1, width: 64, height: 64, renderer });
  const film = jobDeadlineMs({ frameCount: 5, width: 64, height: 64, renderer });
  assert.equal(film - single, 4 * 10 * 1000);
});

test('a job runs against the scene it was submitted for', async context => {
  const root = await temporary(context);
  const scenesSeen = [];
  const controller = await createAgentRenderJobs({ root, limits, run: async input => {
    scenesSeen.push(input.sessionId);
    return writeImage(input);
  } });
  const submitted = await controller.submit({ ...request(), sessionId: 'scene-a' });
  await terminal(controller, submitted.jobId);
  assert.deepEqual(scenesSeen, ['scene-a']);
  await controller.close();
});

async function completedJob(controller) {
  const { jobId } = await controller.submit(request());
  assert.equal((await terminal(controller, jobId)).state, 'completed');
  return jobId;
}

test('a release that stopped halfway is finished by a retry, and a new submit and a restart still work (#1246)', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const jobId = await completedJob(controller);
  // The state a failed release leaves when every file is gone but the folder could not be removed: an empty folder with no owner file.
  for (const filename of await readdir(join(root, jobId))) await unlink(join(root, jobId, filename));
  const next = await controller.submit(request());
  assert.equal((await terminal(controller, next.jobId)).state, 'completed');
  assert.deepEqual(await controller.release(jobId), { jobId, released: true });
  assert.equal((await readdir(root)).includes(jobId), false);
  await controller.close();
  const reopened = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.deepEqual(reopened.list().map(record => record.jobId), [next.jobId]);
  await reopened.close();
});

test('a half-deleted job folder is cleaned on restart instead of failing the store (#1246)', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const keptId = await completedJob(controller);
  const halfId = await completedJob(controller);
  const emptyId = await completedJob(controller);
  await controller.close();
  await unlink(join(root, halfId, 'status.json'));
  for (const filename of await readdir(join(root, emptyId))) await unlink(join(root, emptyId, filename));
  const reopened = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.deepEqual(reopened.list().map(record => record.jobId), [keptId]);
  const names = await readdir(root);
  assert.equal(names.includes(halfId), false);
  assert.equal(names.includes(emptyId), false);
  await reopened.close();
});

test('a failed status write does not poison later writes, release or close, and the lock is given back (#1246)', async context => {
  const root = await temporary(context);
  let failedProgress;
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory, progress, ...rest }) {
    const obstruction = join(directory, 'status.json.pending');
    await mkdir(obstruction);
    failedProgress = await progress({ frames: 1, maximumPendingFrames: 0 }).then(() => undefined, error => error);
    await rm(obstruction, { recursive: true });
    return writeImage({ directory, progress, ...rest });
  } });
  const jobId = await completedJob(controller);
  assert.ok(failedProgress, 'the injected write failure must reach the runner');
  assert.deepEqual(await controller.release(jobId), { jobId, released: true });
  await controller.close();
  assert.equal((await readdir(root)).includes('store.lock'), false);
});

test('close gives the lock back even when the last status write of an active job failed (#1246)', async context => {
  const root = await temporary(context);
  const started = deferred();
  const controller = await createAgentRenderJobs({ root, limits, async run({ directory, signal }) {
    await mkdir(join(directory, 'status.json.pending'));
    started.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  } });
  await controller.submit(request());
  await started.promise;
  await controller.close();
  assert.equal((await readdir(root)).includes('store.lock'), false);
});

function fileInUse(path) {
  return Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: 'EBUSY' });
}

test('a release that fails midway keeps the owner file, and the store keeps working while a file stays held (#1246)', async context => {
  const root = await temporary(context);
  let heldFilename = 'render.png';
  const removeJobFile = async path => {
    if (heldFilename && path.endsWith(heldFilename)) throw fileInUse(path);
    await unlink(path);
  };
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { removeJobFile } });
  const jobId = await completedJob(controller);
  await assert.rejects(controller.release(jobId), error => {
    assert.match(error.message, new RegExp(jobId));
    assert.match(error.message, /open in another program/);
    return true;
  });
  // The folder lost its status first and keeps owner.json last, so it still proves it is ours.
  const leftover = await readdir(join(root, jobId));
  assert.ok(leftover.includes('owner.json'));
  assert.equal(leftover.includes('status.json'), false);
  // The file is still held: a new job and a second release attempt must not fail with the raw filesystem error.
  const next = await controller.submit(request());
  assert.equal((await terminal(controller, next.jobId)).state, 'completed');
  await assert.rejects(controller.release(jobId), /open in another program/);
  await controller.close();
  const whileHeld = await createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { removeJobFile } });
  assert.deepEqual(whileHeld.list().map(record => record.jobId), [next.jobId]);
  await whileHeld.close();
  // The other program lets go: the next start finishes the release.
  heldFilename = undefined;
  const reopened = await createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { removeJobFile } });
  assert.equal((await readdir(root)).includes(jobId), false);
  assert.deepEqual(reopened.list().map(record => record.jobId), [next.jobId]);
  await reopened.close();
});

test('a failed release can be retried to completion once the file is free (#1246)', async context => {
  const root = await temporary(context);
  let failuresLeft = 1;
  const removeJobFile = async path => {
    if (failuresLeft && path.endsWith('snapshot.json')) {
      failuresLeft -= 1;
      throw fileInUse(path);
    }
    await unlink(path);
  };
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { removeJobFile } });
  const jobId = await completedJob(controller);
  await assert.rejects(controller.release(jobId), /open in another program/);
  assert.ok((await readdir(join(root, jobId))).includes('owner.json'));
  assert.deepEqual(await controller.release(jobId), { jobId, released: true });
  assert.equal((await readdir(root)).includes(jobId), false);
  await controller.close();
  const reopened = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.deepEqual(reopened.list(), []);
  await reopened.close();
});

test('a job folder that lost only its owner file is healed on restart, and an unproven one is named in the error (#1246)', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage });
  const keptId = await completedJob(controller);
  const brokenId = await completedJob(controller);
  await controller.close();
  // The state the 0.20.0 release left behind.
  await unlink(join(root, brokenId, 'owner.json'));
  const reopened = await createAgentRenderJobs({ root, limits, run: writeImage });
  assert.deepEqual(reopened.list().map(record => record.jobId), [keptId]);
  assert.equal((await readdir(root)).includes(brokenId), false);
  await reopened.close();

  const strayId = randomUUID();
  await mkdir(join(root, strayId));
  await writeFile(join(root, strayId, 'render.png'), 'not ours');
  await assert.rejects(createAgentRenderJobs({ root, limits, run: writeImage }), error => {
    assert.ok(error.message.includes(join(root, strayId)));
    assert.match(error.message, /Delete that folder by hand/);
    return true;
  });
});

test('a job waits for the GPU queue as queued, and the elapsed deadline starts only once the card is granted', async context => {
  const root = await temporary(context);
  const events = [];
  const granted = deferred();
  const controller = await createAgentRenderJobs({ root, limits: { ...limits, deadlineMs: 150 },
    async acquireGpu() {
      events.push('wait');
      await granted.promise;
      events.push('granted');
      return () => events.push('released');
    },
    async run(argumentsValue) {
      events.push('run');
      return writeImage(argumentsValue);
    } });
  const { jobId } = await controller.submit(request());
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(controller.status(jobId).state, 'queued');
  assert.deepEqual(events, ['wait']);
  granted.resolve();
  assert.equal((await terminal(controller, jobId)).state, 'completed');
  assert.deepEqual(events, ['wait', 'granted', 'run', 'released']);
  await controller.close();
});

test('cancelling a job that waits for the GPU queue ends it cancelled without running it', async context => {
  const root = await temporary(context);
  const events = [];
  const controller = await createAgentRenderJobs({ root, limits,
    acquireGpu: signal => new Promise((resolve, reject) => {
      events.push('wait');
      signal.addEventListener('abort', () => reject(new Error('The GPU queue wait was cancelled.')), { once: true });
    }),
    async run() { events.push('run'); } });
  const { jobId } = await controller.submit(request());
  assert.equal(controller.cancel(jobId).state, 'cancelling');
  assert.equal((await terminal(controller, jobId)).state, 'cancelled');
  assert.deepEqual(events, ['wait']);
  await controller.close();
});

test('a GPU queue that fails the wait fails the job with the queue message', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({ root, limits,
    acquireGpu: async () => { throw new Error('The GPU queue command did not grant the card within 1 seconds.'); },
    async run() { throw new Error('must not run'); } });
  const { jobId } = await controller.submit(request());
  const failed = await terminal(controller, jobId);
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /GPU queue command did not grant/);
  await controller.close();
});

test('a sequence that passes its combined output budget late keeps its leading complete frames readable via result (#2199)', async context => {
  const root = await temporary(context);
  const sequenceLimits = { ...limits, maxOutputBytes: 1000, maxFrameBytes: 400 };
  const controller = await createAgentRenderJobs({
    root,
    limits: sequenceLimits,
    async run({ directory }) {
      const artifacts = [];
      for (let frame = 0; frame < 4; frame += 1) {
        const filename = `frame-${frame}.png`;
        await writeFile(join(directory, `${filename}.partial`), Buffer.alloc(300, frame + 1));
        artifacts.push({ temporary: `${filename}.partial`, filename, mimeType: 'image/png' });
      }
      return { artifacts, metrics: { maximumPendingFrames: 1 } };
    },
  });
  const { jobId } = await controller.submit({
    sourceRevision: 1,
    snapshot: { recipe: { format: 'crucible.scene' } },
    settings: { kind: 'stills', width: 64, height: 64, fps: 10, stillCount: 4 },
  });
  const failed = await terminal(controller, jobId);
  assert.equal(failed.state, 'failed');
  assert.match(failed.reason, /combined output byte budget/);
  assert.match(failed.reason, /kept 3 of 4 artifacts/);
  assert.deepEqual(failed.artifacts.map(item => item.filename), ['frame-0.png', 'frame-1.png', 'frame-2.png']);
  const folderFiles = await readdir(join(root, jobId));
  assert.equal(folderFiles.includes('frame-3.png.partial'), false);
  assert.equal(folderFiles.includes('frame-3.png'), false);

  const partialResult = controller.result(jobId);
  assert.equal(partialResult.state, 'failed');
  assert.equal(partialResult.artifacts.length, 3);
  await controller.close();

  const recovered = await createAgentRenderJobs({ root, limits: sequenceLimits, run: writeImage });
  assert.equal(recovered.status(jobId).state, 'failed');
  assert.equal(recovered.result(jobId).artifacts.length, 3);
  await recovered.release(jobId);
  await recovered.close();
});

test('late output overflow keeps or drops all artifacts of a frame together when passes are enabled (#2199)', async context => {
  const root = await temporary(context);
  const controller = await createAgentRenderJobs({
    root,
    limits: { ...limits, maxOutputBytes: 900, maxFrameBytes: 400 },
    async run({ directory }) {
      const artifacts = [];
      for (const name of ['frame-0.png', 'frame-0-depth.png', 'frame-1.png', 'frame-1-depth.png']) {
        await writeFile(join(directory, `${name}.partial`), Buffer.alloc(260, 7));
        artifacts.push({ temporary: `${name}.partial`, filename: name, mimeType: 'image/png' });
      }
      return { artifacts, metrics: {} };
    },
  });
  const { jobId } = await controller.submit({
    sourceRevision: 2,
    snapshot: { recipe: { format: 'crucible.scene' } },
    settings: { kind: 'stills', width: 64, height: 64, fps: 10, stillCount: 2, passes: ['depth'] },
  });
  const failed = await terminal(controller, jobId);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.artifacts.map(item => item.filename), ['frame-0.png', 'frame-0-depth.png']);
  await controller.release(jobId);
  await controller.close();
});

function blockedRename(failuresBeforeSuccess, code) {
  const counter = { failures: 0 };
  const rename = async (from, to) => {
    if (to.endsWith('status.json') && counter.failures < failuresBeforeSuccess) {
      counter.failures += 1;
      throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
    }
    return renameFile(from, to);
  };
  return { counter, rename };
}

test('a job survives a status.json rename that another reader blocks a few times', async context => {
  const root = await temporary(context);
  const { counter, rename } = blockedRename(3, 'EPERM');
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { fileOperations: { rename } } });
  const submitted = await controller.submit(request());
  const finished = await terminal(controller, submitted.jobId);
  assert.equal(finished.state, 'completed');
  assert.equal(counter.failures, 3);
  const onDisk = JSON.parse(await readFile(join(root, submitted.jobId, 'status.json'), 'utf8'));
  assert.equal(onDisk.state, 'completed');
});

test('a status.json rename that stays blocked keeps the last good status and does not fail the job', async context => {
  const root = await temporary(context);
  const { rename } = blockedRename(Infinity, 'EBUSY');
  const warnings = [];
  const onWarning = warning => warnings.push(warning.code);
  process.on('warning', onWarning);
  context.after(() => process.off('warning', onWarning));
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { fileOperations: { rename } } });
  const submitted = await controller.submit(request());
  const finished = await terminal(controller, submitted.jobId);
  assert.equal(finished.state, 'completed');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(warnings.includes('CRUCIBLE_STATUS_BLOCKED'));
  const onDisk = JSON.parse(await readFile(join(root, submitted.jobId, 'status.json'), 'utf8'));
  assert.equal(onDisk.jobId, submitted.jobId);
  assert.ok(!(await readdir(join(root, submitted.jobId))).includes('status.json.pending'));
});

test('a status.json rename that fails for another reason still fails the write', async context => {
  const root = await temporary(context);
  const { rename } = blockedRename(Infinity, 'ENOSPC');
  const controller = await createAgentRenderJobs({ root, limits, run: writeImage, lockTakeoverHooks: { fileOperations: { rename } } });
  const submitted = await controller.submit(request());
  const finished = await terminal(controller, submitted.jobId);
  assert.equal(finished.state, 'failed');
});

test('a job whose callback throws something without message text still says why it failed', async context => {
  const root = await temporary(context);
  const thrown = [new Error(''), undefined, '', { code: 'EPIPE' }, new TypeError('')];
  let index = 0;
  const controller = await createAgentRenderJobs({ root, limits, async run() { throw thrown[index++]; } });
  for (let attempt = 0; attempt < thrown.length; attempt += 1) {
    const { jobId } = await controller.submit(request());
    const failed = await terminal(controller, jobId);
    assert.equal(failed.state, 'failed');
    assert.match(failed.reason, /^Render job failed: .+scene_render_submit/s, `thrown value ${attempt}`);
    await controller.release(jobId);
  }
  await controller.close();
});
