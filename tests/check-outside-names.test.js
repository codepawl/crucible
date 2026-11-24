import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedLinesFromPatch,
  commentTextOf,
  findOutsideNames,
  findOutsideNamesInBody,
  isScannedPath,
} from '../scripts/check-outside-names.mjs';
import { checkPullRequest } from '../scripts/pr-metadata-check.mjs';
import { planChecks } from '../scripts/preflight.mjs';

function added(path, text, line = 1) {
  return [{ path, line, text }];
}

for (const path of ['docs/guide.md', 'changes/12.md', 'README.md', 'skills/build-crucible-scene/SKILL.md']) {
  test(`an added line in ${path} that names outside software fails with file, line, word and fix`, () => {
    const [finding] = findOutsideNames(added(path, 'The pivot works like Blender does.', 7));
    assert.equal(finding.word, 'Blender');
    assert.equal(finding.line, 7);
    assert.match(finding.message, new RegExp(`${path.replace('.', '\\.')}:7: "Blender"`));
    assert.match(finding.message, /Describe the behaviour instead of naming the tool/);
  });
}

test('in src/ only a comment is scanned', () => {
  assert.equal(findOutsideNames(added('src/mesh.js', "const label = 'Blender';")).length, 0);
  assert.equal(findOutsideNames(added('src/mesh.js', 'const spacing = 2; // same as Houdini')).length, 1);
  assert.equal(findOutsideNames(added('src/mesh.js', '// matches Maya here')).length, 1);
  assert.equal(findOutsideNames(added('src/mesh.js', ' * the Unreal way')).length, 1);
  assert.equal(findOutsideNames(added('src/mesh.js', "const url = 'https://example.com/blender';")).length, 0);
});

test('commentTextOf keeps a comment line and a trailing comment, and drops code', () => {
  assert.equal(commentTextOf('const a = 1;'), '');
  assert.equal(commentTextOf('const a = 1; // note'), ' // note');
  assert.equal(commentTextOf('  /* note */'), '/* note */');
});

test('the description is scanned and the template comments are not', () => {
  const findings = findOutsideNamesInBody('Closes #1\n<!-- like Blender -->\nIt is faster than Cinema 4D.');
  assert.deepEqual(findings.map(finding => [finding.line, finding.word]), [[3, 'Cinema 4D']]);
  assert.match(findings[0].message, /The pull request description, line 3/);
});

test('a keymap preset label passes, the same word in prose fails', () => {
  assert.equal(findOutsideNames(added('docs/studio.md', 'Pick the Maya preset in Settings.')).length, 0);
  assert.equal(findOutsideNames(added('docs/studio.md', 'The keymap offers Cinema 4D and Maya.')).length, 0);
  assert.equal(findOutsideNames(added('docs/studio.md', 'The gizmo is modelled on Maya.')).length, 1);
  assert.equal(findOutsideNamesInBody('The Cinema 4D preset is new.').length, 0);
});

test('an import file format passes, the same tool in prose fails', () => {
  assert.equal(findOutsideNames(added('docs/import.md', 'Open a Blender `.blend` file to import it.')).length, 0);
  assert.equal(findOutsideNames(added('docs/import.md', 'A 3ds Max .max file is read as a file format.')).length, 0);
  assert.equal(findOutsideNames(added('docs/import.md', 'The importer is as good as Blender.')).length, 1);
});

test('the compatibility docs are not scanned', () => {
  assert.equal(isScannedPath('docs/studio-blender-parity.md'), false);
  assert.equal(findOutsideNames(added('docs/studio-blender-parity.md', 'Blender has a Grab tool.')).length, 0);
  assert.equal(isScannedPath('docs/other.md'), true);
});

test('plain English words and paths are not tool names', () => {
  const lines = [
    'Unity of style, the substance of it, many cycles, modo.',
    'See [the add-on](blender-addon.md) and packages/blender-addon/.',
    'Cycles of the day.',
  ];
  assert.equal(findOutsideNames(lines.map((text, index) => ({ path: 'docs/a.md', line: index + 1, text }))).length, 0);
  assert.equal(findOutsideNames(added('docs/a.md', 'Compared with Cycles renderer output.')).length, 1);
});

test('files that are not public text are not scanned', () => {
  assert.equal(isScannedPath('tests/a.test.js'), false);
  assert.equal(isScannedPath('scripts/a.mjs'), false);
  assert.equal(isScannedPath('docs/pic.jpg'), false);
  assert.equal(isScannedPath('src/a.js'), true);
});

test('addedLinesFromPatch numbers only the added lines of the new file', () => {
  const patch = '@@ -1,2 +10,3 @@\n context\n+first\n-removed\n+second\n@@ -50 +60 @@\n+third';
  assert.deepEqual(addedLinesFromPatch('docs/a.md', patch).map(({ line, text }) => [line, text]), [[11, 'first'], [12, 'second'], [60, 'third']]);
});

function metadataInput({ body, files }) {
  return {
    pr: { body, title: 'x (#1)', author: 'someone', authorAssociation: 'NONE', labels: [], milestone: null, draft: false },
    files,
  };
}

test('the PR metadata check fails a description and an added line that name outside software', () => {
  const docsFile = { filename: 'docs/a.md', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+Behaves like Houdini.' };
  const fromBody = checkPullRequest(metadataInput({ body: 'Closes #1\nSame as Blender.', files: [{ ...docsFile, patch: '@@ -0,0 +1 @@\n+Fine.' }] }));
  const fromPatch = checkPullRequest(metadataInput({ body: 'Closes #1', files: [docsFile] }));
  for (const result of [fromBody, fromPatch]) {
    const fix = result.contributorFixes.find(item => item.id === 'outside-names');
    assert.ok(fix, 'an outside-names fix is expected');
    assert.match(fix.message, /Describe the behaviour instead of naming the tool/);
  }
  assert.match(fromBody.contributorFixes.find(item => item.id === 'outside-names').message, /description, line 2: "Blender"/);
  assert.match(fromPatch.contributorFixes.find(item => item.id === 'outside-names').message, /docs\/a\.md:1: "Houdini"/);
  const clean = checkPullRequest(metadataInput({ body: 'Closes #1', files: [{ ...docsFile, patch: '@@ -0,0 +1 @@\n+Fine.' }] }));
  assert.equal(clean.contributorFixes.some(item => item.id === 'outside-names'), false);
});

test('preflight plans the check for public text and skips it otherwise', () => {
  const planned = planChecks(['docs/a.md'], { skipTests: true, baseRef: 'origin/main' }).find(check => check.name === 'outside names');
  assert.equal(planned.skipped, null);
  assert.deepEqual(planned.command, ['node', 'scripts/check-outside-names.mjs', '--base', 'origin/main']);
  const skipped = planChecks(['scripts/a.mjs'], { skipTests: true }).find(check => check.name === 'outside names');
  assert.match(skipped.skipped, /no public text file changed/);
});
