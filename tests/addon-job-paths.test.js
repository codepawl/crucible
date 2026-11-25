// The Cook addon job runs only for pull requests that reach native code (#1796, #3415).
// pull_request.paths skips docs-only PRs without starting a runner, and the `paths` job checks changed files dynamically
// against the live import graph so adding a new src/ file needs no workflow edit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { addonTestFiles, changedFilesFromGit, shouldRunAddonJob, traceAddonFiles } from '../scripts/addon-job-paths.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowText = readFileSync(join(repositoryRoot, '.github/workflows/cook-addon.yml'), 'utf8').replace(/\r\n/g, '\n');
const workflowLines = workflowText.split('\n');

/** The quoted entries of `on.<trigger>.paths`, read without a YAML dependency. */
function triggerPaths(trigger) {
  const triggerIndex = workflowLines.findIndex((line) => line === `  ${trigger}:`);
  assert.notEqual(triggerIndex, -1, `cook-addon.yml has no ${trigger} trigger`);
  const entries = [];
  let insidePaths = false;
  for (const line of workflowLines.slice(triggerIndex + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    if (/^ {4}paths:/.test(line)) {
      insidePaths = true;
    } else if (insidePaths) {
      const entry = /^ {6}- '([^']+)'$/.exec(line);
      if (entry === null) break;
      entries.push(entry[1]);
    }
  }
  return entries;
}

function globToExpression(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped.replace(/\u0000/g, '.*')}$`);
}

function isCovered(file, globs) {
  return globs.some((glob) => globToExpression(glob).test(file));
}

test('the traced addon set includes the addon tests, their helper and the source they load', () => {
  const traced = traceAddonFiles();
  assert.ok(addonTestFiles().length > 20, 'expected the addon test files to be found with git grep');
  assert.ok(traced.includes('tests/support/cook.js'));
  assert.ok(traced.includes('tests/native-session.test.js'));
  assert.ok(traced.some((file) => file.startsWith('src/')));
});

test('every file the addon tests reach is covered by the broad pull_request paths of cook-addon.yml', () => {
  const globs = triggerPaths('pull_request');
  const uncovered = traceAddonFiles().filter((file) => !isCovered(file, globs));
  assert.deepEqual(uncovered, [], `cook-addon.yml pull_request.paths missed: ${uncovered.join(', ')}`);
});

test('a new src/ file reached by a Cook test triggers run=true with zero cook-addon.yml edits', () => {
  const virtualFiles = {
    'tests/simulated-cook.test.js': "import { runCook } from './support/cook.js';\nimport { computeFeature } from '../src/new-cook-module.js';\n",
    'tests/support/cook.js': "export function runCook() {}\n",
    'src/new-cook-module.js': "import { helper } from './new-cook-helper.js';\nexport function computeFeature() { return helper(); }\n",
    'src/new-cook-helper.js': "export function helper() { return 1; }\n",
  };
  const traced = traceAddonFiles(['tests/simulated-cook.test.js', 'tests/support/cook.js'], {
    fileExists: (file) => Object.hasOwn(virtualFiles, file),
    readSource: (file) => virtualFiles[file],
  });
  assert.ok(traced.includes('src/new-cook-module.js'));
  assert.ok(traced.includes('src/new-cook-helper.js'));

  const decision = shouldRunAddonJob(['src/new-cook-helper.js'], traced);
  assert.equal(decision.run, true);
  assert.deepEqual(decision.matches, ['src/new-cook-helper.js']);
  assert.equal(isCovered('src/new-cook-helper.js', triggerPaths('pull_request')), true);
});

test('docs-only changes and unrelated src/ files produce run=false', () => {
  const traced = traceAddonFiles();
  const tracedSet = new Set(traced);
  const allSource = execFileSync('git', ['ls-files', 'src'], { cwd: repositoryRoot, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const unrelatedSource = allSource.find((file) => !tracedSet.has(file));
  assert.ok(unrelatedSource, 'expected at least one src/ file not reached by Cook addon tests');

  const unrelatedDecision = shouldRunAddonJob([unrelatedSource, 'src/untraced-new-module.js'], traced);
  assert.equal(unrelatedDecision.run, false);
  assert.deepEqual(unrelatedDecision.matches, []);

  const docsDecision = shouldRunAddonJob(['docs/goal.md', 'README.md', 'changes/3415.md'], traced);
  assert.equal(docsDecision.run, false);
  assert.deepEqual(docsDecision.matches, []);
  assert.ok(!isCovered('docs/goal.md', triggerPaths('pull_request')), 'documentation must not start the workflow');
});

test('always-run infrastructure paths trigger run=true and empty changed lists fail safe', () => {
  const globs = triggerPaths('pull_request');
  const requiredPaths = [
    'package.json',
    'package-lock.json',
    '.github/workflows/cook-addon.yml',
    '.github/actions/setup/action.yml',
    'bin/crucible-mcp.mjs',
    'scripts/check-first-native-job.mjs',
    'scripts/addon-job-paths.mjs',
    'scripts/import-specifiers.mjs',
    'tests/addon-job-paths.test.js',
    'packages/denoise-oidn/fetch-oidn.mjs',
  ];
  for (const requiredPath of requiredPaths) {
    assert.ok(isCovered(requiredPath, globs), `${requiredPath} must be covered by pull_request.paths`);
    const decision = shouldRunAddonJob([requiredPath], []);
    assert.equal(decision.run, true, `${requiredPath} must trigger the addon job`);
  }
  assert.equal(shouldRunAddonJob([], []).run, true);
});

test('addon tests are found by their imports, not by a mention of the helper in text', () => {
  const sources = {
    'tests/imports.test.js': "import { x } from './support/cook.js';",
    'tests/side-effect.test.js': "import './support/cook.js';",
    'tests/reexport.test.js': "export { x } from './support/cook.js';",
    'tests/dynamic.test.js': "const helper = await import('./support/cook.js');",
    'tests/required.test.js': "const helper = require('./support/cook.js');",
    'tests/string.test.js': "const note = './support/cook.js'; const other = \"import './support/cook.js'\";",
    'tests/comment.test.js': "// import './support/cook.js'\n/* import './support/cook.js' */",
    'tests/other-helper.test.js': "import { x } from './support/scene.js';",
  };
  const found = addonTestFiles(Object.keys(sources), (file) => sources[file]);
  assert.deepEqual(found, ['tests/dynamic.test.js', 'tests/imports.test.js', 'tests/reexport.test.js', 'tests/required.test.js', 'tests/side-effect.test.js']);
});

test('changedFilesFromGit handles merge commits, shallow base fetches and unreadable diffs cleanly', () => {
  const mergeChanged = changedFilesFromGit({
    runGit: (args) => {
      if (args[0] === 'rev-list') return { status: 0, stdout: 'headsha basesha prheadsha\n' };
      if (args[0] === 'diff') {
        assert.deepEqual(args, ['diff', '--name-only', '--no-renames', 'basesha', 'HEAD']);
        return { status: 0, stdout: 'src/path-tracer.js\ndocs/goal.md\n' };
      }
      return { status: 1, stdout: '' };
    },
  });
  assert.deepEqual(mergeChanged, ['src/path-tracer.js', 'docs/goal.md']);

  const commands = [];
  const tempFolder = mkdtempSync(join(tmpdir(), 'cook-event-'));
  try {
    const eventPath = join(tempFolder, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: 'shallowbase' } } }));
    let fetchedBase = false;
    const shallowChanged = changedFilesFromGit({
      eventPath,
      runGit: (args) => {
        commands.push(args.join(' '));
        if (args[0] === 'rev-list') return { status: 0, stdout: 'headsha parentsha\n' };
        if (args[0] === 'rev-parse' && args.at(-1) === 'shallowbase^{commit}') {
          return { status: fetchedBase ? 0 : 1, stdout: '' };
        }
        if (args[0] === 'fetch') {
          fetchedBase = true;
          return { status: 0, stdout: '' };
        }
        if (args[0] === 'diff') {
          assert.deepEqual(args, ['diff', '--name-only', '--no-renames', 'shallowbase', 'HEAD']);
          return { status: 0, stdout: 'README.md\n' };
        }
        return { status: 1, stdout: '' };
      },
    });
    assert.deepEqual(shallowChanged, ['README.md']);
    assert.ok(commands.includes('fetch --no-tags --depth=1 origin shallowbase'));
  } finally {
    rmSync(tempFolder, { recursive: true, force: true });
  }

  const unreadable = changedFilesFromGit({
    eventPath: null,
    runGit: () => ({ status: 1, stdout: '' }),
  });
  assert.equal(unreadable, null);
});

test('cook-addon.yml checks paths dynamically and preserves nightly, push and manual runs', () => {
  assert.ok(!workflowText.includes('\t'), 'cook-addon.yml must not contain tabs');
  assert.match(workflowText, /^name: Cook addon$/m);
  assert.match(workflowText, /^ {2}schedule:\n {4}- cron: '[^']+'$/m);
  assert.match(workflowText, /^ {2}workflow_dispatch:$/m);
  assert.match(workflowText, /^ {2}push:\n {4}branches: \[main\]$/m);
  assert.match(workflowText, /^ {2}paths:\n/m);
  assert.match(workflowText, /fetch-depth: 2/);
  assert.match(workflowText, /node scripts\/addon-job-paths\.mjs --should-run/);
  assert.match(workflowText, /^ {2}addon:\n {4}needs: paths\n {4}if: \$\{\{ needs\.paths\.outputs\.run == 'true' && !github\.event\.pull_request\.draft \}\}/m);

  const globs = triggerPaths('pull_request');
  for (const directoryGlob of ['src/**', 'scripts/**', 'tests/**', 'packages/**', 'bench/**']) {
    assert.ok(globs.includes(directoryGlob), `expected ${directoryGlob} in pull_request.paths`);
  }
});

test('addon-job-paths CLI --should-run and --check-changed print run=true/false lines', () => {
  const skipOutput = execFileSync(process.execPath, ['scripts/addon-job-paths.mjs', '--should-run', 'docs/goal.md'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.match(skipOutput, /^run=false$/m);

  const runOutput = execFileSync(process.execPath, ['scripts/addon-job-paths.mjs', '--check-changed', 'package.json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.match(runOutput, /^run=true$/m);
});
