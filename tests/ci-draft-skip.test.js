import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// A draft pull request runs no CI job, so the rounds a worker pushes to a draft take no runner slot (#3267).
// Marking it ready (ready_for_review) starts the full run.
const draftGuard = '!github.event.pull_request.draft';

function readWorkflow(name) {
  return readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

function jobBlocks(workflowText) {
  const jobsText = workflowText.slice(workflowText.indexOf('\njobs:\n'));
  return [...jobsText.matchAll(/\n {2}([a-z0-9-]+):\n((?: {4}.*\n|\s*\n)*)/g)].map(match => ({ name: match[1], body: match[2] }));
}

function jobCondition(jobBody) {
  const condition = /^ {4}if: (.*)$/m.exec(jobBody);
  if (!condition) return undefined;
  return condition[1].replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();
}

// The guard must hold on its own: the whole condition, or the last term after `&&` with no `||` that could bypass it.
function hasDraftGuard(jobBody) {
  const condition = jobCondition(jobBody);
  if (condition === undefined) return false;
  return condition === draftGuard || (condition.endsWith(`&& ${draftGuard}`) && !condition.includes('||'));
}

function neededJobs(jobBody) {
  const needsLine = /^ {4}needs: (.*)$/m.exec(jobBody);
  if (!needsLine) return [];
  return needsLine[1].replace(/[[\]]/g, '').split(',').map(name => name.trim()).filter(Boolean);
}

for (const workflowName of ['test.yml', 'cook-addon.yml']) {
  test(`${workflowName} runs again when a draft is marked ready`, () => {
    assert.match(readWorkflow(workflowName), /pull_request:\n {4}(?:#.*\n {4})?types: \[opened, synchronize, reopened, ready_for_review\]/);
  });

  test(`every job in ${workflowName} skips a draft pull request`, () => {
    const jobs = jobBlocks(readWorkflow(workflowName));
    assert.ok(jobs.length > 0, `no jobs found in ${workflowName}`);
    const guardedJobs = new Set(jobs.filter(job => hasDraftGuard(job.body)).map(job => job.name));
    for (const job of jobs) {
      const needed = neededJobs(job.body);
      const followsGuardedJobs = jobCondition(job.body) === undefined && needed.length > 0 && needed.every(name => guardedJobs.has(name));
      assert.ok(
        guardedJobs.has(job.name) || followsGuardedJobs,
        `job ${job.name} in ${workflowName} must have "if: \${{ ${draftGuard} }}" (or end its condition in "&& ${draftGuard}"), or have no if and need only guarded jobs`,
      );
    }
  });
}

test('the guard check refuses a condition that an || can bypass', () => {
  assert.equal(hasDraftGuard(`    if: \${{ ${draftGuard} }}\n`), true);
  assert.equal(hasDraftGuard(`    if: always() && ${draftGuard}\n`), true);
  assert.equal(hasDraftGuard(`    if: always() || ${draftGuard}\n`), false);
  assert.equal(hasDraftGuard('    if: always()\n'), false);
});
