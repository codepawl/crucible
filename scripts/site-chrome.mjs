// The top bar and the footer every site page shares. A page carries this markup between site-chrome markers; run
// `node scripts/site-chrome.mjs` to rewrite them and `--check` to fail when a page differs (tests/site-chrome.test.js does).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CHROME_PAGES = ['index', 'docs', 'changelog', 'recipes', 'recipe-dolly-zoom', 'recipe-hdri-lighting', 'recipe-view-transform', 'recipe-cumulus-towers', 'marketplace', 'showcase', 'tiers', 'film', 'motion', 'nature', 'object', 'view2d', 'assets'];

// Full-screen viewer pages have no scroll area to end in, so they carry the top bar and no footer. Modeling scrolls and keeps its footer.
export const FOOTERLESS_PAGES = new Set(['film', 'motion', 'nature', 'object', 'view2d', 'assets']);

// The nav link a page marks as current. The home page marks none; a recipe page marks Recipes.
const CURRENT_LINK = {
  docs: '/docs.html',
  changelog: '/changelog.html',
  recipes: '/recipes.html',
  'recipe-dolly-zoom': '/recipes.html',
  'recipe-hdri-lighting': '/recipes.html',
  'recipe-view-transform': '/recipes.html',
  'recipe-cumulus-towers': '/recipes.html',
  marketplace: '/marketplace.html',
  showcase: '/showcase.html',
};

// The browser bar colours, the light and dark site background from src/site-tokens.css, written the same in every page head.
export const THEME_COLOR_META = '<meta name="theme-color" content="#f8f7f1" media="(prefers-color-scheme: light)" /><meta name="theme-color" content="#17161a" media="(prefers-color-scheme: dark)" />';
export const FONT_PRELOAD_META = '<link rel="preload" href="/fonts/plus-jakarta-sans-latin-3.woff2" as="font" type="font/woff2" crossorigin /><link rel="preload" href="/fonts/inter-latin-6.woff2" as="font" type="font/woff2" crossorigin />';
export const ANALYTICS_SCRIPT_TAG = '<script defer src="/analytics.js" data-cf-site="d25c310f7f5c46049586a2ddc0e57b03"></script>';

const ICON_PATHS = {
  docs: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
  recipes: '<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  showcase: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="15.5" cy="9.5" r="1.2"/>',
  marketplace: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  changelog: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  npm: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 9v6M12 9v6M16 9v6M8 9h8"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

const NAV_LINKS = [
  { name: 'docs', href: '/docs.html', label: 'Docs', wide: false },
  { name: 'recipes', href: '/recipes.html', label: 'Recipes', wide: true },
  { name: 'showcase', href: '/showcase.html', label: 'Showcase', wide: true },
  { name: 'marketplace', href: '/marketplace.html', label: 'Marketplace', wide: true },
  { name: 'changelog', href: '/changelog.html', label: 'Changelog', wide: true },
];

// The footer lists every page, because the top bar keeps only Docs, GitHub and Install on a phone.
const FOOTER_PAGE_LINKS = [
  { href: '/docs.html', label: 'Docs' },
  { href: '/recipes.html', label: 'Recipes' },
  { href: '/showcase.html', label: 'Showcase' },
  { href: '/marketplace.html', label: 'Marketplace' },
  { href: '/tiers.html', label: 'Tiers' },
  { href: '/changelog.html', label: 'Changelog' },
];

const BRAND = '<a class="brand" href="/" aria-label="Crucible home"><picture><source media="(prefers-color-scheme: dark)" srcset="/brand/crucible-mark-64-dark.webp"><img src="/brand/crucible-mark-64.webp" alt="" width="28" height="28" decoding="async"></picture>Crucible</a>';

export function renderHeader(pageName) {
  const current = CURRENT_LINK[pageName];
  const installHref = pageName === 'index' ? '#install' : '/#install';
  const links = NAV_LINKS.map((link) => {
    const classAttribute = link.wide ? ' class="wide"' : '';
    const currentAttribute = link.href === current ? ' aria-current="page"' : '';
    return `    <a${classAttribute} href="${link.href}"${currentAttribute}>${icon(link.name)}${link.label}</a>`;
  });
  return [
    '<header class="nav">',
    `  ${BRAND}`,
    '  <span class="version" data-release-version>Loading release</span>',
    '  <nav class="nav-links" aria-label="Site">',
    ...links,
    `    <a href="https://github.com/codepawl/crucible" aria-label="GitHub">${icon('github')}<span class="wide">GitHub</span></a>`,
    `    <a class="button" href="${installHref}">Install</a>`,
    '  </nav>',
    '</header>',
  ].join('\n');
}

export function renderFooter() {
  return [
    '<footer class="footer">',
    '  <div class="inner">',
    `    <p>${BRAND}</p>`,
    '    <p>by <a href="https://codepawl.com">CodePawl</a>, formerly 67js</p>',
    '    <nav aria-label="Site pages">',
    ...FOOTER_PAGE_LINKS.map((link) => `      <a href="${link.href}">${link.label}</a>`),
    '    </nav>',
    '    <nav aria-label="Project links">',
    `      <a href="https://github.com/codepawl/crucible">${icon('github')}GitHub</a>`,
    `      <a href="https://www.npmjs.com/package/@codepawlhq/crucible">${icon('npm')}npm</a>`,
    '      <a data-release-commit href="https://github.com/codepawl/crucible">Release commit</a>',
    '      <a href="/license.txt">MIT license</a>',
      '      <a href="/logo.svg" download>Logo SVG</a>',
      '      <a href="https://github.com/sponsors/codepawl">Sponsor</a>',
      '    </nav>',
      '    <nav aria-label="Social links">',
      '      <a href="https://x.com/anxuanng">X (@anxuanng)</a>',
      '      <a href="https://x.com/codepawl">X (@codepawl)</a>',
      '      <a href="https://www.threads.com/@codepawl">Threads</a>',
      '      <a href="https://www.youtube.com/@codepawlhq">YouTube</a>',
      '      <a href="https://huggingface.co/codepawl">Hugging Face</a>',
      '    </nav>',
      '  </div>',
      '</footer>',
  ].join('\n');
}

const REGIONS = {
  header: { pattern: /<!-- site-chrome:header -->[\s\S]*?<!-- \/site-chrome:header -->/, render: renderHeader },
  footer: { pattern: /<!-- site-chrome:footer -->[\s\S]*?<!-- \/site-chrome:footer -->/, render: renderFooter },
};

// Returns the page source with its marked header and footer regions, font preloads and analytics script rewritten.
export function applyChrome(source, pageName) {
  let result = source;
  if (result.includes(THEME_COLOR_META) && !result.includes(FONT_PRELOAD_META)) {
    result = result.replace(THEME_COLOR_META, `${THEME_COLOR_META}\n    ${FONT_PRELOAD_META}`);
  }
  result = result.replace(/\n?[ \t]*<script defer src="\/analytics\.js"[^>]*><\/script>/g, '');
  if (result.includes('</head>')) {
    result = result.replace('</head>', `  ${ANALYTICS_SCRIPT_TAG}\n  </head>`);
  }
  for (const [part, { pattern, render }] of Object.entries(REGIONS)) {
    if (part === 'footer' && FOOTERLESS_PAGES.has(pageName)) {
      if (pattern.test(result)) throw new Error(`${pageName}.html is a full-screen viewer and carries no footer. Remove its site-chrome:footer markers.`);
      continue;
    }
    if (!pattern.test(result)) {
      throw new Error(`${pageName}.html has no site-chrome:${part} markers. Wrap its ${part} in <!-- site-chrome:${part} --> and <!-- /site-chrome:${part} -->.`);
    }
    result = result.replace(pattern, () => `<!-- site-chrome:${part} -->\n${render(pageName)}\n<!-- /site-chrome:${part} -->`);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const checkOnly = process.argv.includes('--check');
  let stale = 0;
  for (const pageName of CHROME_PAGES) {
    const file = new URL(`../site/${pageName}.html`, import.meta.url);
    const before = readFileSync(file, 'utf8');
    const after = applyChrome(before, pageName);
    if (before === after) continue;
    stale += 1;
    if (checkOnly) console.error(`site/${pageName}.html differs from the shared top bar or footer. Run: node scripts/site-chrome.mjs`);
    else writeFileSync(file, after);
  }
  if (checkOnly && stale) process.exit(1);
  console.log(checkOnly ? 'site chrome clean' : `site chrome written to ${stale} page(s)`);
}
