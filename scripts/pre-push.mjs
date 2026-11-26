// Git pre-push hook body. Runs `npm run preflight -- --skip-tests` so a branch that would fail the fast gates of the
// `Test` workflow (protected files, change note, links, tool schemas, size, tool cost) or its affected unit tests
// (`scripts/test-affected.mjs`) stops on this machine instead of on CI. The full suite stays on CI and in `npm run preflight`.
// Git passes one line per pushed ref on stdin: "<local ref> <local sha> <remote ref> <remote sha>".
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const deletedSha = /^0+$/;

// Decides whether a push needs the preflight. Pure, so tests can call it without git.
export function shouldRunPreflight(pushedRefsText, environment = {}) {
  if (environment.SKIP_PREFLIGHT === '1') {
    return { run: false, reason: 'SKIP_PREFLIGHT=1' };
  }
  const pushedBranches = pushedRefsText
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length === 4)
    // The remote ref decides: `git push origin HEAD` reports the local ref as "HEAD", not refs/heads/<name>.
    .filter(([, localSha, remoteRef]) => remoteRef.startsWith('refs/heads/') && !deletedSha.test(localSha));
  if (pushedBranches.length === 0) {
    return { run: false, reason: 'no branch commits pushed (tags or deletions only)' };
  }
  return { run: true, reason: null };
}

// Git runs the hook with variables that point at this repository (GIT_DIR, GIT_INDEX_FILE and others). A test that runs
// git in a temporary folder would inherit them and act on this repository instead: one ran `git init --bare` and set
// core.bare=true on the real repository, which broke every worktree (#1837). The preflight finds the repository from
// its working folder, so it needs none of them.
const repositoryLocationVariables = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  'GIT_NAMESPACE',
]);

// Returns a copy of the environment without git's repository location variables. Pure, so tests can call it.
export function preflightEnvironment(environment) {
  const kept = Object.entries(environment).filter(([name]) => !repositoryLocationVariables.has(name.toUpperCase()));
  return Object.fromEntries(kept);
}

function main() {
  const pushedRefsText = readFileSync(0, 'utf8');
  const decision = shouldRunPreflight(pushedRefsText, process.env);
  if (!decision.run) {
    console.log(`pre-push: preflight skipped, ${decision.reason}.`);
    return 0;
  }
  console.log('pre-push: running npm run preflight -- --skip-tests. Skip once with SKIP_PREFLIGHT=1 git push.');
  const result = spawnSync('node', ['scripts/preflight.mjs', '--skip-tests'], { cwd: root, stdio: 'inherit', env: preflightEnvironment(process.env) });
  if (result.status !== 0) {
    console.error('pre-push: push stopped. Fix the checks above, or push anyway with SKIP_PREFLIGHT=1 git push.');
  }
  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  process.exit(main());
}
