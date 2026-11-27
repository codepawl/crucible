import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyChrome, CHROME_PAGES, FOOTERLESS_PAGES, renderFooter, renderHeader, THEME_COLOR_META } from '../scripts/site-chrome.mjs';

function readPage(pageName) {
  return readFileSync(new URL(`../site/${pageName}.html`, import.meta.url), 'utf8');
}

function region(source, part) {
  const match = source.match(new RegExp(`<!-- site-chrome:${part} -->\\n([\\s\\S]*?)\\n<!-- /site-chrome:${part} -->`));
  assert.ok(match, `the ${part} markers are missing`);
  return match[1];
}

test('every site page carries the shared top bar and footer, written by scripts/site-chrome.mjs', () => {
  for (const pageName of CHROME_PAGES) {
    const source = readPage(pageName);
    assert.equal(applyChrome(source, pageName), source, `site/${pageName}.html differs from the shared chrome: run node scripts/site-chrome.mjs`);
    if (FOOTERLESS_PAGES.has(pageName)) continue;
    assert.equal(region(source, 'footer'), renderFooter(), `${pageName} footer`);
  }
});

test('the top bar has the same links in the same order on every page', () => {
  const linkLists = CHROME_PAGES.map((pageName) => [...region(readPage(pageName), 'header').matchAll(/href="([^"]+)"/g)].map((match) => match[1].replace(/^\/#install$/, '#install')));
  for (const links of linkLists) assert.deepEqual(links, linkLists[0]);
});

test('the footer lists every page, since the phone top bar keeps only Docs, GitHub and Install', () => {
  const footer = renderFooter();
  for (const href of ['/docs.html', '/recipes.html', '/showcase.html', '/marketplace.html', '/benchmark.html', '/changelog.html']) {
    assert.ok(footer.includes(`<a href="${href}">`), `${href} is missing from the footer`);
  }
});

test('full-screen viewer pages carry the top bar and no footer', () => {
  assert.deepEqual([...FOOTERLESS_PAGES].sort(), ['assets', 'film', 'motion', 'nature', 'object', 'view2d']);
  for (const pageName of FOOTERLESS_PAGES) assert.ok(!readPage(pageName).includes('site-chrome:footer'), `${pageName} must not carry a footer`);
  const pageWithFooter = ['<!-- site-chrome:header -->', '<!-- /site-chrome:header -->', '<!-- site-chrome:footer -->', '<!-- /site-chrome:footer -->'].join('\n');
  assert.throws(() => applyChrome(pageWithFooter, 'film'), /carries no footer/);
});

test('every viewer page loads the shared chrome and viewer styles, wears the viewer class and keeps no top bar of its own', () => {
  const viewerScripts = { film: 'film-player', motion: 'motion-player', nature: 'nature-viewer', object: 'main', view2d: 'view2d', assets: 'asset-viewer' };
  const oldHeaders = ['class="navigation"', 'class="film-header', 'class="world-header"', 'class="motion-header', 'class="studio-nav"', 'class="site-footer"'];
  for (const [pageName, scriptName] of Object.entries(viewerScripts)) {
    const html = readPage(pageName);
    assert.match(html, /<body class="themed viewer/, `${pageName} body needs the themed and viewer classes`);
    for (const oldHeader of oldHeaders) assert.ok(!html.includes(oldHeader), `${pageName} still carries ${oldHeader}`);
    const script = readFileSync(new URL(`../src/${scriptName}.js`, import.meta.url), 'utf8');
    assert.ok(script.includes("import './site-chrome.js';"), `src/${scriptName}.js must load the shared chrome`);
  }
  for (const stylesheet of ['film-style', 'motion-style', 'nature-style', 'style', 'view2d']) {
    const css = readFileSync(new URL(`../src/${stylesheet}.css`, import.meta.url), 'utf8');
    assert.ok(css.startsWith("@import './viewer-chrome.css';"), `${stylesheet}.css must start with the shared viewer styles`);
  }
});

test('no page head still carries the unused color script', () => {
  for (const pageName of CHROME_PAGES) assert.ok(!readPage(pageName).includes('crucible-color'), pageName);
});

test('each page marks its own place in the top bar with aria-current', () => {
  const expected = { index: null, film: null, motion: null, modeling: null, nature: null, object: null, view2d: null, assets: null, docs: '/docs.html', changelog: '/changelog.html', recipes: '/recipes.html', 'recipe-dolly-zoom': '/recipes.html', marketplace: '/marketplace.html', benchmark: '/benchmark.html', showcase: '/showcase.html' };
  for (const [pageName, href] of Object.entries(expected)) {
    const marked = [...renderHeader(pageName).matchAll(/<a[^>]*href="([^"]+)" aria-current="page"/g)].map((match) => match[1]);
    assert.deepEqual(marked, href ? [href] : [], pageName);
  }
});

const SITE_NAV_ENTRIES = [
  { href: '/docs.html', label: 'Docs' },
  { href: '/recipes.html', label: 'Recipes' },
  { href: '/showcase.html', label: 'Showcase' },
  { href: '/marketplace.html', label: 'Marketplace' },
  { href: '/benchmark.html', label: 'Benchmark' },
  { href: '/changelog.html', label: 'Changelog' },
];

function navEntries(source) {
  const navMatch = source.match(/<nav class="nav-links" aria-label="Site">([\s\S]*?)<\/nav>/);
  assert.ok(navMatch, 'the Site nav is missing');
  const anchors = [...navMatch[1].matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  return anchors.map((anchor) => ({ href: anchor[1], label: textOutsideTags(anchor[2]) }));
}

// The label is compared with a fixed word and never written back into a page, so this only drops the icon markup around it.
function textOutsideTags(markup) {
  const pieces = markup.split(/<[^>]*>/);
  return pieces.join('').trim();
}

test('every site page shows Docs, Recipes, Showcase, Marketplace, Benchmark and Changelog in that order, with no Studio', () => {
  for (const pageName of CHROME_PAGES) {
    const entries = navEntries(readPage(pageName));
    const publicEntries = entries.filter((entry) => SITE_NAV_ENTRIES.some((expected) => expected.href === entry.href));
    assert.deepEqual(publicEntries, SITE_NAV_ENTRIES, `site/${pageName}.html nav entries or their order differ from the shared nav`);
    for (const entry of entries) assert.ok(!/studio/i.test(entry.href + entry.label), `site/${pageName}.html links Studio, which is not on the public web`);
  }
});

test('every real site page is covered by the shared chrome; only redirects and the render canvas are left out', () => {
  const redirectsAndCanvas = new Set(['downloads', 'getting-started', 'modeling', 'tiers', 'file']);
  const fileNames = readdirSync(new URL('../site/', import.meta.url)).filter((fileName) => fileName.endsWith('.html'));
  for (const fileName of fileNames) {
    const pageName = fileName.replace(/\.html$/, '');
    if (redirectsAndCanvas.has(pageName)) continue;
    assert.ok(CHROME_PAGES.includes(pageName), `site/${fileName} is not in CHROME_PAGES in scripts/site-chrome.mjs, so its nav can drift`);
  }
});

test('every site page head carries the same theme-color and font preload tags and the modeling redirect uses relative links', () => {
  for (const pageName of CHROME_PAGES) {
    const html = readPage(pageName);
    assert.ok(html.includes(THEME_COLOR_META), `site/${pageName}.html needs THEME_COLOR_META from scripts/site-chrome.mjs`);
    assert.ok(html.includes('rel="preload" href="/fonts/plus-jakarta-sans-latin-3.woff2"'), `site/${pageName}.html needs font preloads`);
  }
  assert.ok(!/(href|url)="?\/docs\.html/.test(readPage('modeling')), 'site/modeling.html must link ./docs.html, not an absolute path');
});

test('every page wears the shared theme class and loads the shared styles', () => {
  for (const pageName of CHROME_PAGES) {
    assert.match(readPage(pageName), /<body class="[^"]*\bthemed\b/, `${pageName} body needs the themed class`);
  }
  const scripts = ['landing', 'documentation', 'changelog', 'recipes', 'marketplace', 'showcase', 'tiers'];
  for (const name of scripts) {
    const source = readFileSync(new URL(`../src/${name}.js`, import.meta.url), 'utf8');
    assert.match(source, /site-chrome\.(css|js)'/, `src/${name}.js must load the shared chrome`);
  }
});

test('shared chrome uses the brand kit font stack and lowercase bold wordmark with no Pixelify Sans', () => {
  const chromeStyles = readFileSync(new URL('../src/site-chrome.css', import.meta.url), 'utf8');
  assert.match(chromeStyles, /--display:\s*'Plus Jakarta Sans'/);
  assert.match(chromeStyles, /--wordmark:\s*'Plus Jakarta Sans'/);
  assert.match(chromeStyles, /--body:\s*'Inter'/);
  assert.match(chromeStyles, /--mono:\s*'JetBrains Mono'/);
  assert.match(chromeStyles, /--round:\s*8px/);
  assert.match(chromeStyles, /\.themed\s+\.brand\s*\{[^}]*font:\s*700\s+22px\/1\s+var\(--wordmark\)[^}]*letter-spacing:\s*-0\.035em[^}]*text-transform:\s*lowercase/);
  assert.doesNotMatch(chromeStyles, /pixelify|pixel-icon/i);
});
