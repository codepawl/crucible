// What the site serves, #1249: llms.txt and the published guides link only to guides the build copies, the install guide
// carries no release URL that the site stops serving, and the docs do not tell users to install packages that are not on npm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMissingReleaseLinks, findUnpublishedLinks } from '../scripts/check-published-site.mjs';
import { publishedDocuments } from '../scripts/published-documents.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const SITE_ORIGIN = 'https://crucible.codepawl.com/';
// Written by prepare-release.mjs from other sources than docs/<name>.
const generatedGuides = new Set(['guide.md', 'gltf.md', 'changelog.md']);

function readText(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function served(name) {
  return publishedDocuments.includes(name) || generatedGuides.has(name);
}

function withFixture(files, run) {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-published-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(folder, name)), { recursive: true });
      writeFileSync(join(folder, name), text);
    }
    run(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('every guide that llms.txt links to by absolute URL is one the build publishes', () => {
  const urls = [...readText('public/llms.txt').matchAll(/https:\/\/[^\s)<>"'`\]]+/g)].map(match => new URL(match[0]));
  const names = urls
    .filter(url => url.hostname === 'crucible.codepawl.com')
    .map(url => url.pathname.slice(1))
    .filter(name => /^[\w-]+\.md$/.test(name));
  assert.ok(names.length > 10);
  assert.deepEqual([...new Set(names)].filter(name => !served(name)), []);
});

test('every markdown guide that a published guide links to by a plain relative link is published', () => {
  const missing = [];
  for (const name of publishedDocuments.filter(document => document.endsWith('.md'))) {
    const text = readText(`docs/${name}`).replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(/\]\((?:\.\/|\/)?([\w-]+\.md)(?:#[^)]*)?\)/g)) {
      if (!served(match[1])) missing.push(`${name} -> ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every guide in the publish list exists under docs/', () => {
  for (const name of publishedDocuments) assert.doesNotThrow(() => readText(`docs/${name}`), name);
});

test('the link check reports a link to a file the site does not serve and accepts one it does', () => {
  withFixture({
    'public/release.json': '{}',
    'public/llms.txt': `[a](${SITE_ORIGIN}game.md) [b](${SITE_ORIGIN}mcp.md) [c](${SITE_ORIGIN}release.json)`,
    'public/mcp.md': 'See [the guide](guide.md) and [the docs page](docs.html).',
    'public/guide.md': '```html\n<script src="/src/main.js"></script>\n```\n',
    'site/docs.html': '<html></html>',
  }, folder => {
    const problems = findUnpublishedLinks(folder);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /llms\.txt -> https:\/\/crucible\.codepawl\.com\/game\.md$/);
  });
});

test('a link to a host that only starts with the site address leaves the site', () => {
  withFixture({
    'public/release.json': '{}',
    'public/llms.txt': '[a](https://crucible.codepawl.com.other.host/missing.md) [b](https://crucible.codepawl.com)',
  }, folder => {
    assert.deepEqual(findUnpublishedLinks(folder), []);
  });
});

test('the release link check fails on a /releases/<x.y.z>/ link that public/releases lacks', () => {
  withFixture({
    'public/release.json': '{}',
    'public/releases/0.20.0/crucible.module.js': '',
    'public/llms.txt': 'Import /releases/0.20.0/crucible.module.js or /releases/0.15.0/crucible.module.js.',
  }, folder => {
    const problems = findMissingReleaseLinks(folder);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /0\.15\.0/);
  });
});

test('the learn pages carry no release URL that the site stops serving', () => {
  for (const page of ['install.md', 'connect-mcp.md', 'agent-workflows.md']) {
    assert.doesNotMatch(readText(`docs/learn/${page}`), /\/releases\/\d+\.\d+\.\d+\//, page);
  }
  assert.match(readText('docs/learn/install.md'), /releases\/<version>\/crucible\.module\.js/);
});

test('the docs say three-compat is not on npm, three-bridge installs from npm, and each package names its repository folder', () => {
  const notes = [
    ['docs/learn/if-you-know-three-js.md', 'not on npm yet'],
    ['public/llms.txt', 'not on npm yet'],
    ['docs/three-bridge.md', 'npm install @codepawlhq/crucible-three-bridge three'],
    ['packages/three-bridge/README.md', 'npm install @codepawlhq/crucible-three-bridge three'],
    ['packages/three-compat/README.md', 'not on npm yet'],
  ];
  for (const [file, phrase] of notes) assert.ok(readText(file).includes(phrase), file);
  for (const file of ['docs/three-bridge.md', 'packages/three-bridge/README.md']) assert.ok(!readText(file).includes('not on npm'), file);
  for (const name of ['denoise-oidn', 'roblox-import', 'three-bridge', 'three-compat']) {
    const pack = JSON.parse(readText(`packages/${name}/package.json`));
    assert.equal(pack.repository.directory, `packages/${name}`);
  }
  const denoise = JSON.parse(readText('packages/denoise-oidn/package.json'));
  assert.equal(denoise.peerDependenciesMeta['@codepawlhq/cook'].optional, true);
});

test('an empty public folder is reported as missing files, not as zero problems', async () => {
  const { findMissingPublishedFiles } = await import('../scripts/check-published-site.mjs');
  withFixture({ 'public/release.json': '{}' }, (folder) => {
    const missing = findMissingPublishedFiles(folder);
    assert.ok(missing.some((line) => line.startsWith('public/llms.txt is missing')), missing.join('\n'));
    assert.ok(missing.some((line) => line.startsWith('public/guide.md is missing')));
    assert.ok(missing.some((line) => line.includes('prepare:release')));
  });
});

test('a complete public folder reports no missing files', async () => {
  const { findMissingPublishedFiles } = await import('../scripts/check-published-site.mjs');
  const files = { 'public/release.json': '{}', 'public/llms.txt': '', 'public/guide.md': '', 'public/gltf.md': '' };
  for (const name of publishedDocuments.filter((document) => document.endsWith('.md'))) files[`public/${name}`] = '';
  withFixture(files, (folder) => assert.deepEqual(findMissingPublishedFiles(folder), []));
});
