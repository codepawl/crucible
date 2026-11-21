// The top bar and the footer every site page shares. A page carries this markup between site-chrome markers; run
// `node scripts/site-chrome.mjs` to rewrite them and `--check` to fail when a page differs (tests/site-chrome.test.js does).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CHROME_PAGES = ['index', 'docs', 'changelog', 'recipes', 'recipe-dolly-zoom', 'recipe-hdri-lighting', 'recipe-view-transform', 'marketplace', 'showcase', 'tiers', 'film', 'motion', 'nature', 'object', 'view2d', 'assets'];

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
  marketplace: '/marketplace.html',
  showcase: '/showcase.html',
};

// The browser bar colours, the light and dark site background from src/site-tokens.css, written the same in every page head.
export const THEME_COLOR_META = '<meta name="theme-color" content="#f8f7f1" media="(prefers-color-scheme: light)" /><meta name="theme-color" content="#17161a" media="(prefers-color-scheme: dark)" />';

const ICON_PATHS = {
  docs: "M3 1h11v1h-11zM2 2h12v1h-12zM2 3h2v1h-2zM12 3h2v1h-2zM2 4h2v1h-2zM5 4h6v1h-6zM12 4h2v1h-2zM2 5h2v1h-2zM5 5h6v1h-6zM12 5h2v1h-2zM2 6h2v1h-2zM12 6h2v1h-2zM2 7h2v1h-2zM12 7h2v1h-2zM2 8h2v1h-2zM12 8h2v1h-2zM2 9h2v1h-2zM12 9h2v1h-2zM2 10h2v1h-2zM12 10h2v1h-2zM2 11h2v1h-2zM11 11h3v1h-3zM2 12h12v1h-12zM2 13h11v1h-11zM2 14h2v1h-2z",
  recipes: "M7 1h2v1h-2zM5 2h6v1h-6zM3 3h4v1h-4zM9 3h4v1h-4zM1 4h5v1h-5zM10 4h5v1h-5zM0 5h5v1h-5zM11 5h5v1h-5zM2 6h4v1h-4zM10 6h4v1h-4zM1 7h2v1h-2zM4 7h8v1h-8zM13 7h2v1h-2zM1 8h3v1h-3zM6 8h4v1h-4zM12 8h3v1h-3zM2 9h4v1h-4zM7 9h2v1h-2zM10 9h4v1h-4zM1 10h2v1h-2zM4 10h8v1h-8zM13 10h2v1h-2zM1 11h3v1h-3zM6 11h4v1h-4zM12 11h3v1h-3zM2 12h4v1h-4zM7 12h2v1h-2zM10 12h4v1h-4zM4 13h8v1h-8zM6 14h4v1h-4zM7 15h2v1h-2z",
  showcase: "M1 2h14v1h-14zM1 3h14v1h-14zM1 4h2v1h-2zM13 4h2v1h-2zM1 5h2v1h-2zM13 5h2v1h-2zM1 6h2v1h-2zM13 6h2v1h-2zM1 7h2v1h-2zM4 7h2v1h-2zM13 7h2v1h-2zM1 8h6v1h-6zM9 8h2v1h-2zM13 8h2v1h-2zM1 9h11v1h-11zM13 9h2v1h-2zM1 10h3v1h-3zM6 10h9v1h-9zM1 11h3v1h-3zM7 11h2v1h-2zM11 11h4v1h-4zM1 12h14v1h-14zM1 13h14v1h-14z",
  marketplace: "M2 2h12v1h-12zM2 3h12v1h-12zM2 4h2v1h-2zM6 4h4v1h-4zM12 4h2v1h-2zM2 5h2v1h-2zM5 5h6v1h-6zM12 5h2v1h-2zM2 6h12v1h-12zM2 7h5v1h-5zM9 7h5v1h-5zM2 8h5v1h-5zM9 8h5v1h-5zM2 9h12v1h-12zM2 10h2v1h-2zM5 10h6v1h-6zM12 10h2v1h-2zM2 11h2v1h-2zM6 11h4v1h-4zM12 11h2v1h-2zM2 12h12v1h-12zM2 13h12v1h-12z",
  changelog: "M2 3h12v1h-12zM2 4h12v1h-12zM2 7h12v1h-12zM2 8h12v1h-12zM2 11h12v1h-12zM2 12h12v1h-12z",
  github: "M6 0h4v1h-4zM4 1h8v1h-8zM2 2h12v1h-12zM1 3h14v1h-14zM1 4h3v1h-3zM12 4h3v1h-3zM0 5h4v1h-4zM12 5h4v1h-4zM0 6h3v1h-3zM13 6h3v1h-3zM0 7h3v1h-3zM13 7h3v1h-3zM0 8h3v1h-3zM13 8h3v1h-3zM0 9h3v1h-3zM13 9h3v1h-3zM0 10h4v1h-4zM12 10h4v1h-4zM1 11h5v1h-5zM10 11h5v1h-5zM1 12h2v1h-2zM4 12h2v1h-2zM10 12h5v1h-5zM2 13h2v1h-2zM10 13h4v1h-4zM3 14h3v1h-3zM10 14h3v1h-3zM5 15h1v1h-1zM10 15h1v1h-1z",
  npm: "M0 0h16v1h-16zM0 1h16v1h-16zM0 2h16v1h-16zM0 3h16v1h-16zM0 4h3v1h-3zM13 4h3v1h-3zM0 5h3v1h-3zM13 5h3v1h-3zM0 6h3v1h-3zM8 6h2v1h-2zM13 6h3v1h-3zM0 7h3v1h-3zM8 7h2v1h-2zM13 7h3v1h-3zM0 8h3v1h-3zM8 8h2v1h-2zM13 8h3v1h-3zM0 9h3v1h-3zM8 9h2v1h-2zM13 9h3v1h-3zM0 10h3v1h-3zM8 10h2v1h-2zM13 10h3v1h-3zM0 11h3v1h-3zM8 11h2v1h-2zM13 11h3v1h-3zM0 12h4v1h-4zM8 12h3v1h-3zM12 12h4v1h-4zM0 13h16v1h-16zM0 14h16v1h-16zM0 15h16v1h-16z",
};

function icon(name) {
  return `<svg class="pixel-icon" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`;
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

const BRAND ='<a class="brand" href="/" aria-label="Crucible home"><img src="/brand/crucible-mark.svg" alt="">Crucible</a>';

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
    '  </div>',
    '</footer>',
  ].join('\n');
}

const REGIONS = {
  header: { pattern: /<!-- site-chrome:header -->[\s\S]*?<!-- \/site-chrome:header -->/, render: renderHeader },
  footer: { pattern: /<!-- site-chrome:footer -->[\s\S]*?<!-- \/site-chrome:footer -->/, render: renderFooter },
};

// Returns the page source with its marked header and footer regions rewritten.
export function applyChrome(source, pageName) {
  let result = source;
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
