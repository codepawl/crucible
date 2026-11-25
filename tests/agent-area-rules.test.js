// The area rules in .claude/rules/ load only when an agent reads a file their paths filter matches.
// A filter that matches nothing means the rule never loads, so each one must match a tracked file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rulesFolder = join(repositoryRoot, '.claude', 'rules');

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: repositoryRoot, encoding: 'utf8' }).split('\n').filter(Boolean);
}

export function readPathsFilter(source) {
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) return [];
  return [...frontmatter[1].matchAll(/^\s+-\s+"([^"]+)"$/gm)].map(match => match[1]);
}

function escapeForRegex(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

export function globToRegex(glob) {
  const pattern = glob
    .split('**')
    .map(part => part.split('*').map(escapeForRegex).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${pattern}$`);
}

const ruleFiles = readdirSync(rulesFolder).filter(name => name.endsWith('.md'));

test('there are area rules to check', () => {
  assert.ok(ruleFiles.length >= 3, `expected at least 3 rule files in .claude/rules, found ${ruleFiles.length}`);
});

test('the glob matcher keeps a single star inside one folder', () => {
  assert.ok(globToRegex('src/studio*').test('src/studio-panel.js'));
  assert.ok(!globToRegex('src/*light*').test('src/sub/light.js'));
  assert.ok(globToRegex('skills/**').test('skills/build-crucible-scene/SKILL.md'));
});

const files = trackedFiles();

for (const ruleFile of ruleFiles) {
  test(`${ruleFile} has a paths filter whose every pattern matches a tracked file`, () => {
    const patterns = readPathsFilter(readFileSync(join(rulesFolder, ruleFile), 'utf8').replace(/\r\n/g, '\n'));
    assert.ok(patterns.length > 0, `${ruleFile} needs a "paths:" list in its frontmatter, or it loads on every turn like AGENTS.md`);
    for (const pattern of patterns) {
      const matcher = globToRegex(pattern);
      assert.ok(files.some(file => matcher.test(file)), `${ruleFile}: "${pattern}" matches no tracked file; fix the pattern or remove it`);
    }
  });
}
