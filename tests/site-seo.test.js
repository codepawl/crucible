import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const homePage = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const sitemap = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the home page publishes Schema.org JSON-LD and canonical Open Graph metadata for Crucible', () => {
  assert.match(homePage, /<meta property="og:site_name" content="Crucible" \/>/);
  assert.match(homePage, /<meta name="twitter:site" content="@anxuanng" \/>/);
  assert.match(homePage, /<link rel="canonical" href="https:\/\/crucible\.codepawl\.com\/" \/>/);

  const structuredDataMatch = homePage.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(structuredDataMatch, 'site/index.html needs an application/ld+json block');

  const structuredData = JSON.parse(structuredDataMatch[1]);
  assert.equal(structuredData['@context'], 'https://schema.org');
  const graph = structuredData['@graph'];
  assert.ok(Array.isArray(graph), 'JSON-LD @graph must be an array');

  const software = graph.find((node) => node['@id'] === 'https://crucible.codepawl.com/#software');
  assert.ok(software, 'Crucible SoftwareApplication/SoftwareSourceCode node is missing');
  assert.equal(software.name, 'Crucible');
  assert.equal(software.description, 'Cook crisp 3D with your AI. Stop prompting 3D blind. Shape live worlds with your AI.');
  assert.equal(software.codeRepository, 'https://github.com/codepawl/crucible');
  assert.equal(software.publisher?.['@id'], 'https://codepawl.com/#organization');
  assert.ok(software.sameAs?.includes('https://www.npmjs.com/package/@codepawlhq/crucible'));
  assert.match(homePage, /<p>Stop prompting 3D blind\. Shape live worlds with your AI<\/p>/);
});

test('sitemap.xml includes the home URL and a lastmod timestamp on every entry', () => {
  const urlEntries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1]);
  assert.ok(urlEntries.length > 0, 'sitemap.xml has no url entries');
  assert.ok(urlEntries.some((entry) => entry.includes('<loc>https://crucible.codepawl.com/</loc>')));
  for (const entry of urlEntries) {
    assert.match(entry, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  }
});

test('package.json includes MCP Registry verification name and discovery keywords', () => {
  assert.equal(packageMetadata.mcpName, 'io.github.codepawl/crucible');
  for (const keyword of ['crucible', '3d-engine', 'mcp-server']) {
    assert.ok(packageMetadata.keywords.includes(keyword), `missing keyword: ${keyword}`);
  }
});
