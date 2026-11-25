import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createCommandArguments,
  evidenceMarkdown,
  insertEvidence,
  openPullRequest,
  parseArguments,
  validateBody,
} from '../scripts/open-pr.mjs';

const GOOD_BODY = [
  'Adds the script.',
  '',
  'Closes #1805',
  '',
  '## How I checked it',
  '',
  '`node --test tests/open-pr.test.js` passed.',
  '',
  '## Evidence',
  '',
  'Nothing to see or measure: a contributor script.',
  '',
].join('\n');

const LINKS = [
  { name: 'after.png', url: 'https://raw.example/after.png' },
  { name: 'demo.mp4', url: 'https://raw.example/demo.mp4' },
];

function makeServices({ body = GOOD_BODY, changed = 'scripts/open-pr.mjs\ntests/open-pr.test.js', storedBody, remoteHead = '', login = 'anxuanng' } = {}) {
  const calls = [];
  let sentBody = null;
  const services = {
    calls,
    git(args) {
      calls.push(['git', ...args]);
      if (args[0] === 'diff') return changed;
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return '1805-open-pr';
      if (args[0] === 'rev-parse') return 'abc123';
      if (args[0] === 'ls-remote') return remoteHead ? `${remoteHead}\trefs/heads/1805-open-pr` : '';
      return '';
    },
    gh(args) {
      calls.push(['gh', ...args]);
      if (args[1] === 'create') return 'https://github.com/codepawl/crucible/pull/42';
      if (args[1] === 'view') return JSON.stringify({ body: storedBody ?? sentBody ?? body });
      return '';
    },
    currentLogin: () => login,
    pushEvidence(options) {
      calls.push(['pushEvidence', options.prNumber, options.dryRun === true]);
      return { branch: 'evidence', links: LINKS, dryRun: options.dryRun === true };
    },
    writeTempBody(text) {
      sentBody = text;
      return 'temp-body.md';
    },
    readFile: () => body,
  };
  return services;
}

const baseOptions = { title: 'Do it (#1805)', bodyFile: 'body.md', labels: ['enhancement'], milestone: '0 Measure', base: 'main', evidence: [], dryRun: false };

describe('parseArguments', () => {
  test('reads every flag, including several evidence files', () => {
    const options = parseArguments(['--title', 'T (#1)', '--body-file', 'b.md', '--labels', 'bug, goal:ai', '--milestone', '0 Measure', '--base', 'dev', '--evidence', 'a.png', 'b.mp4', '--dry-run']);
    assert.deepEqual(options, { title: 'T (#1)', bodyFile: 'b.md', labels: ['bug', 'goal:ai'], milestone: '0 Measure', base: 'dev', evidence: ['a.png', 'b.mp4'], draft: false, dryRun: true });
  });

  test('--draft opens a draft, which CI skips until it is marked ready', () => {
    const options = parseArguments(['--title', 'T (#1)', '--body-file', 'b.md', '--draft']);
    assert.equal(options.draft, true);
    assert.equal(createCommandArguments(options).at(-1), '--draft');
    assert.equal(createCommandArguments(parseArguments(['--title', 'T', '--body-file', 'b.md'])).includes('--draft'), false);
  });

  test('defaults the base to main and requires a title and a body file', () => {
    assert.equal(parseArguments(['--title', 'T', '--body-file', 'b.md']).base, 'main');
    assert.throws(() => parseArguments(['--body-file', 'b.md']), /--title/);
    assert.throws(() => parseArguments(['--title', 'T']), /--body-file/);
  });

  test('rejects unknown flags and flags without a value', () => {
    assert.throws(() => parseArguments(['--title', 'T', '--body-file', 'b.md', '--nope']), /Unknown argument/);
    assert.throws(() => parseArguments(['--title', '--body-file', 'b.md']), /--title needs a value/);
    assert.throws(() => parseArguments(['--title', 'T', '--body-file', 'b.md', '--evidence']), /--evidence needs/);
  });
});

describe('validateBody', () => {
  test('refuses an empty body and a lone dash', () => {
    assert.throws(() => validateBody(''), /empty or "-"/);
    assert.throws(() => validateBody('  -\n'), /empty or "-"/);
    assert.doesNotThrow(() => validateBody(GOOD_BODY));
  });
});

describe('evidence markdown', () => {
  test('embeds pictures and links clips', () => {
    assert.equal(evidenceMarkdown(LINKS), '![after.png](https://raw.example/after.png)\n- [demo.mp4](https://raw.example/demo.mp4)');
  });

  test('adds an Evidence section when the body has none', () => {
    const result = insertEvidence('Closes #1\n', '![a](u)');
    assert.equal(result, 'Closes #1\n\n## Evidence\n\n![a](u)\n');
  });

  test('appends to an existing Evidence section and keeps the sections after it', () => {
    const result = insertEvidence('## Evidence\n\nNothing else.\n\n## Notes\n\nlater\n', '![a](u)');
    assert.equal(result, '## Evidence\n\nNothing else.\n\n![a](u)\n\n## Notes\n\nlater\n');
  });
});

describe('openPullRequest', () => {
  const lookBody = GOOD_BODY.replace('Nothing to see or measure: a contributor script.', 'The look is unchanged.');
  const lookFiles = 'src/post-mask.js\nchanges/1.md\ntests/open-pr.test.js';

  test('lets the owner say the look is unchanged on a look file', () => {
    const services = makeServices({ body: lookBody, changed: lookFiles, login: 'anxuanng' });
    assert.equal(openPullRequest(baseOptions, services).url, 'https://github.com/codepawl/crucible/pull/42');
  });

  test('still asks for pictures when the login is empty or not the owner', () => {
    for (const login of ['', 'someone-else']) {
      const services = makeServices({ body: lookBody, changed: lookFiles, login });
      assert.throws(() => openPullRequest(baseOptions, services), /look-without-image/);
    }
  });

  test('stops with every finding listed and creates nothing when the checks fail', () => {
    const services = makeServices({ body: `Just some words.\n${['C:', 'Users', 'someone', 'file'].join('\\')}` });
    assert.throws(() => openPullRequest(baseOptions, services), (error) => {
      assert.match(error.message, /local-path/);
      assert.match(error.message, /missing-issue-link/);
      assert.match(error.message, /empty-how-checked/);
      return true;
    });
    assert.equal(services.calls.some(call => call[0] === 'gh'), false);
    assert.equal(services.calls.some(call => call[1] === 'push'), false);
  });

  test('refuses a "-" body before any git or gh call', () => {
    const services = makeServices({ body: '-' });
    assert.throws(() => openPullRequest(baseOptions, services), /empty or "-"/);
    assert.deepEqual(services.calls, []);
  });

  test('pushes the branch, runs one gh pr create and verifies the body', () => {
    const services = makeServices();
    const result = openPullRequest(baseOptions, services);
    assert.equal(result.url, 'https://github.com/codepawl/crucible/pull/42');
    assert.ok(services.calls.some(call => call[0] === 'git' && call[1] === 'push' && call[2] === '-u'));
    const creates = services.calls.filter(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'create');
    assert.equal(creates.length, 1);
  });

  test('skips the push when the remote already has this commit', () => {
    const services = makeServices({ remoteHead: 'abc123' });
    openPullRequest(baseOptions, services);
    assert.equal(services.calls.some(call => call[0] === 'git' && call[1] === 'push'), false);
  });

  test('inserts the evidence Markdown and edits the body with the new number', () => {
    const services = makeServices();
    const result = openPullRequest({ ...baseOptions, evidence: ['after.png', 'demo.mp4'] }, services);
    assert.ok(services.calls.some(call => call[0] === 'pushEvidence' && call[1] === 42 && call[2] === false));
    assert.ok(services.calls.some(call => call[0] === 'gh' && call[2] === 'edit'));
    assert.match(result.finalBody, /!\[after\.png\]\(https:\/\/raw\.example\/after\.png\)/);
    assert.match(result.finalBody, /\[demo\.mp4\]\(https:\/\/raw\.example\/demo\.mp4\)/);
  });

  test('detects a stored body that differs from what was sent', () => {
    const services = makeServices({ storedBody: '-' });
    assert.throws(() => openPullRequest(baseOptions, services), /does not match/);
  });

  test('a dry run writes nothing and returns the final body', () => {
    const services = makeServices();
    const result = openPullRequest({ ...baseOptions, dryRun: true, evidence: ['after.png'] }, services);
    assert.equal(result.dryRun, true);
    assert.equal(services.calls.some(call => call[0] === 'gh'), false);
    assert.equal(services.calls.some(call => call[0] === 'git' && call[1] === 'push'), false);
    assert.match(result.finalBody, /## Evidence/);
    assert.ok(result.log.some(line => line.startsWith('gh pr create')));
  });
});

describe('createCommandArguments', () => {
  test('passes title, body, base, labels and milestone to one gh pr create', () => {
    assert.deepEqual(createCommandArguments(baseOptions), ['pr', 'create', '--title', 'Do it (#1805)', '--body-file', 'body.md', '--base', 'main', '--label', 'enhancement', '--milestone', '0 Measure']);
  });
});
