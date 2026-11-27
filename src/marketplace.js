import './site-chrome.js';
import './site.css';
import './marketplace.css';
import { ADDON_AREAS, ADDON_CATALOG, addonImportLine } from './addon-catalog.js';
import { filterBuiltinAddons } from './marketplace-filter.js';
import { addonPackages, firstPartyPackages, npmManifestPath } from './marketplace-npm.js';

const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search?text=keywords:crucible-addon&size=50';
const NPM_MANIFEST_URL = 'https://registry.npmjs.org/';
const FIRST_PARTY_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search?text=@codepawlhq&size=50';
const MAXIMUM_RANGE_LOOKUPS = 20;
const CONCURRENT_RANGE_LOOKUPS = 5;
const ADDONS_DOC_URL = 'https://github.com/codepawl/crucible/blob/main/docs/addons.md';
const REPOSITORY_URL = 'https://github.com/codepawl/crucible/blob/main';
const PACKAGE_PREFIX = '@codepawlhq/crucible/addons/';
const KIND_LABELS = {
  assets: ['model', 'models'],
  images: ['image', 'images'],
  looks: ['look', 'looks'],
  environments: ['HDRI', 'HDRIs'],
  materials: ['material', 'materials'],
  recipes: ['recipe', 'recipes'],
};
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
// One shape per state, so the state reads without the text: a ring, a magnifier, a warning triangle.
const STATE_ICONS = {
  loading: 'M12 3a9 9 0 1 0 9 9',
  empty: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm5 11.5L21 21M8 10.5h5',
  error: 'M12 3 2 20h20L12 3Zm0 6v5m0 3h.01',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(path, className = 'market-icon') {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(SVG_NAMESPACE, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

function link(text, href, className) {
  const anchor = element('a', className, text);
  anchor.href = href;
  return anchor;
}

function setJumpCount(id, count) {
  const badge = document.querySelector(`#${id}`);
  if (badge) badge.textContent = String(count);
}

function showState(container, state, message, ...links) {
  const notice = element('p', `market-state market-state-${state}`);
  notice.setAttribute('role', state === 'error' ? 'alert' : 'status');
  notice.append(icon(STATE_ICONS[state]), element('span', '', message), ...links);
  container.replaceChildren(notice);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countLabel(kind, count) {
  const [singular, plural] = KIND_LABELS[kind] ?? [kind, kind];
  return `${count} ${count === 1 ? singular : plural}`;
}

async function copyText(button, text, copiedLabel = 'Copied') {
  const originalChildren = [...button.childNodes];
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = copiedLabel;
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.replaceChildren(...originalChildren); }, 1800);
}

function copyButton(text, label = 'Copy', className = 'market-copy') {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', () => copyText(button, text));
  return button;
}

function checksumCopyButton(sha256) {
  const button = element('button', 'market-checksum-button');
  button.type = 'button';
  button.title = `Copy full SHA-256: ${sha256}`;
  button.setAttribute('aria-label', `Copy SHA-256 checksum starting with ${sha256.slice(0, 8)}`);
  button.append(element('span', '', 'SHA-256'), element('code', '', `${sha256.slice(0, 8)}...`));
  button.addEventListener('click', () => copyText(button, sha256, 'SHA-256 copied'));
  return button;
}

function packCard(pack) {
  const card = element('article', 'market-card pack-card');
  if (pack.preview) {
    const preview = element('img', 'pack-preview');
    preview.src = pack.preview;
    preview.alt = `Preview of ${pack.name}`;
    preview.loading = 'lazy';
    card.append(preview);
  } else {
    const placeholder = element('div', 'pack-preview pack-preview-empty');
    placeholder.append(icon('M3 7 12 2l9 5v10l-9 5-9-5V7Zm0 0 9 5 9-5M12 12v10'));
    card.append(placeholder);
  }
  const body = element('div', 'pack-body');
  const title = element('h3', '', pack.name);
  title.append(element('span', 'market-version', pack.version));
  const facts = element('ul', 'market-facts');
  const factTexts = [
    ...Object.entries(pack.items).map(([kind, count]) => countLabel(kind, count)),
    pack.license,
    `Crucible ${pack.engines}`,
    formatBytes(pack.bytes),
    `by ${pack.author}`,
  ];
  for (const text of factTexts) facts.append(element('li', '', text));
  const download = link('Download', pack.zip, 'market-button');
  download.setAttribute('download', '');
  download.prepend(icon('M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4', 'market-icon market-button-icon'));
  const actions = element('div', 'pack-actions');
  actions.append(download, checksumCopyButton(pack.sha256));
  body.append(title, element('p', 'market-description', pack.description), facts, actions);
  card.append(body);
  return card;
}

async function loadPacks(container) {
  showState(container, 'loading', 'Loading packs');
  try {
    const response = await fetch('/packs/index.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { packs } = await response.json();
    if (!Array.isArray(packs) || packs.length === 0) {
      setJumpCount('count-packs', 0);
      showState(container, 'empty', 'No packs are published yet.', link('How to make one', 'https://github.com/codepawl/crucible/blob/main/docs/packs.md'));
      return;
    }
    setJumpCount('count-packs', packs.length);
    container.replaceChildren(...packs.map(packCard));
  } catch {
    showState(container, 'error', 'The pack list did not load. Reload the page to try again.');
  }
}

function npmUrl(name) {
  return `https://www.npmjs.com/package/${name}`;
}

function npmLink(name) {
  const npm = link('npm', npmUrl(name), 'market-npm-link');
  const logo = element('span', 'package-logo package-logo-npm');
  logo.setAttribute('aria-hidden', 'true');
  npm.prepend(logo);
  npm.setAttribute('aria-label', `${name} on npm`);
  return npm;
}

function npmCardTitle(entry) {
  const title = element('h3', 'market-card-title');
  const name = element('span', 'market-card-name');
  name.append(link(entry.name, npmUrl(entry.name)), element('span', 'market-version', entry.version));
  title.append(name, npmLink(entry.name));
  return title;
}

function addonCard(addon) {
  const card = element('article', 'market-card addon-card');
  card.dataset.addon = addon.name;
  const title = npmCardTitle(addon);
  const body = element('div', 'addon-body');
  body.append(title);
  if (addon.description) body.append(element('p', 'market-description', addon.description));
  const facts = element('ul', 'market-facts');
  facts.append(element('li', '', addon.range ? `Crucible ${addon.range}` : 'Range not stated'));
  body.append(facts);
  card.append(body);
  return card;
}

async function fetchLatestRange(name) {
  const path = npmManifestPath(name);
  if (!path) return null;
  try {
    const response = await fetch(`${NPM_MANIFEST_URL}${path}`);
    if (!response.ok) return null;
    const manifest = await response.json();
    return typeof manifest['crucible']?.range === 'string' ? manifest['crucible'].range : null;
  } catch {
    return null;
  }
}

async function fillRanges(addons, container) {
  const queue = addons.slice(0, MAXIMUM_RANGE_LOOKUPS);
  const workers = Array.from({ length: Math.min(CONCURRENT_RANGE_LOOKUPS, queue.length) }, async () => {
    while (queue.length > 0) {
      const addon = queue.shift();
      addon.range = await fetchLatestRange(addon.name);
      const card = container.querySelector(`[data-addon="${CSS.escape(addon.name)}"]`);
      if (card) card.replaceWith(addonCard(addon));
    }
  });
  await Promise.all(workers);
}

async function loadAddons(container) {
  showState(container, 'loading', 'Searching npm for addons');
  try {
    const response = await fetch(NPM_SEARCH_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { objects } = await response.json();
    const addons = addonPackages(objects);
    setJumpCount('count-community', addons.length);
    if (addons.length === 0) {
      showState(container, 'empty', 'No third-party addons on npm yet.', link('Write an addon', ADDONS_DOC_URL));
      return;
    }
    container.replaceChildren(...addons.map(addonCard));
    await fillRanges(addons, container);
  } catch {
    showState(container, 'error', 'npm did not answer, so the addon list is missing. Search npm for crucible-addon instead.', link('Open the npm search', 'https://www.npmjs.com/search?q=keywords%3Acrucible-addon'));
  }
}

function packageCard(entry) {
  const card = element('article', 'market-card addon-card');
  const title = npmCardTitle(entry);
  const body = element('div', 'addon-body');
  body.append(title);
  if (entry.description) body.append(element('p', 'market-description', entry.description));
  const command = `npm install ${entry.name}`;
  const row = element('div', 'command-row');
  row.append(element('code', '', command), copyButton(command));
  body.append(row);
  card.append(body);
  return card;
}

async function loadFirstPartyPackages(container) {
  showState(container, 'loading', 'Searching npm for packages');
  try {
    const response = await fetch(FIRST_PARTY_SEARCH_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { objects } = await response.json();
    const packages = firstPartyPackages(objects);
    setJumpCount('count-packages', packages.length);
    if (packages.length === 0) {
      showState(container, 'empty', 'No companion packages are published yet.');
      return;
    }
    container.replaceChildren(...packages.map(packageCard));
  } catch {
    showState(container, 'error', 'npm did not answer, so the package list is missing.', link('Open the npm search', 'https://www.npmjs.com/search?q=%40codepawlhq%2Fcrucible-'));
  }
}

function builtinCard(addon) {
  const card = element('article', 'builtin-card');
  card.dataset.addonName = addon.name;
  const docUrl = addon.doc ? `${REPOSITORY_URL}/docs/${addon.name}.md` : `${REPOSITORY_URL}/src/${addon.name}.js`;

  const top = element('div', 'builtin-card-head');
  const heading = element('h4', 'builtin-name');
  heading.append(link(addon.name, docUrl));
  const importCopy = copyButton(addonImportLine(addon.name), 'Copy import', 'market-copy-import');
  importCopy.setAttribute('aria-label', `Copy import statement for ${addon.name}`);
  top.append(heading, importCopy);

  const specifier = element('code', 'builtin-specifier', `${PACKAGE_PREFIX}${addon.name}`);
  card.append(top, element('p', 'market-description', addon.summary), specifier);
  return card;
}

function builtinGroup(area, cardsByAddon) {
  const group = element('section', 'builtin-group');
  group.dataset.area = area.id;
  const addons = ADDON_CATALOG.filter(addon => addon.area === area.id);
  const heading = element('h3', 'builtin-area', area.label);
  const countBadge = element('span', 'market-version', String(addons.length));
  heading.append(countBadge);
  const grid = element('div', 'builtin-grid');
  grid.append(...addons.map(addon => {
    const card = builtinCard(addon);
    cardsByAddon.set(addon.name, card);
    return card;
  }));
  group.append(heading, grid);
  return group;
}

function areaButton(id, label, count, pressed) {
  const button = element('button', 'market-area-chip', label);
  button.type = 'button';
  button.dataset.area = id;
  button.setAttribute('aria-pressed', String(pressed));
  button.append(element('span', 'market-area-count', String(count)));
  return button;
}

function loadBuiltinAddons() {
  const listContainer = document.querySelector('#builtin-list');
  const areaControls = document.querySelector('#builtin-areas');
  const filterInput = document.querySelector('#builtin-filter');
  const countLabelNode = document.querySelector('#builtin-count');

  setJumpCount('count-builtin', ADDON_CATALOG.length);

  const cardsByAddon = new Map();
  const groups = ADDON_AREAS.map(area => builtinGroup(area, cardsByAddon));
  listContainer.replaceChildren(...groups);

  const areaButtons = [
    areaButton('all', 'All', ADDON_CATALOG.length, true),
    ...ADDON_AREAS.map(area => areaButton(area.id, area.label, ADDON_CATALOG.filter(entry => entry.area === area.id).length, false)),
  ];
  areaControls.replaceChildren(...areaButtons);

  let selectedArea = 'all';

  function refresh() {
    const query = filterInput.value;
    const filtered = filterBuiltinAddons(ADDON_CATALOG, ADDON_AREAS, { area: selectedArea, query });
    const visibleNames = new Set(filtered.matching.map(addon => addon.name));

    for (const [name, card] of cardsByAddon) {
      card.hidden = !visibleNames.has(name);
    }

    for (const group of groups) {
      const areaId = group.dataset.area;
      const areaMatches = filtered.matching.filter(addon => addon.area === areaId).length;
      group.hidden = areaMatches === 0;
      const groupBadge = group.querySelector('.market-version');
      if (groupBadge) groupBadge.textContent = String(areaMatches);
    }

    for (const button of areaButtons) {
      const areaId = button.dataset.area;
      button.setAttribute('aria-pressed', String(areaId === selectedArea));
      const areaCount = areaId === 'all' ? filtered.queryTotal : (filtered.queryCountsByArea[areaId] ?? 0);
      const countSpan = button.querySelector('.market-area-count');
      if (countSpan) countSpan.textContent = String(areaCount);
    }

    const activeQuery = query.trim();
    if (selectedArea === 'all' && !activeQuery) {
      countLabelNode.textContent = `${filtered.totalCount} addons`;
    } else {
      countLabelNode.textContent = `${filtered.shownCount} of ${filtered.totalCount} addons`;
    }

    listContainer.querySelector('.market-state')?.remove();
    if (filtered.shownCount === 0) {
      const reason = activeQuery ? `No built-in addon matches "${activeQuery}".` : 'No built-in addons in this area.';
      const notice = element('p', 'market-state market-state-empty');
      notice.setAttribute('role', 'status');
      notice.append(icon(STATE_ICONS.empty), element('span', '', reason));
      listContainer.append(notice);
    }
  }

  areaControls.addEventListener('click', event => {
    const button = event.target.closest('button[data-area]');
    if (!button) return;
    selectedArea = button.dataset.area;
    refresh();
  });
  filterInput.addEventListener('input', refresh);
  refresh();
}

document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', () => copyText(button, button.dataset.copy));
});
loadPacks(document.querySelector('#pack-list'));
loadFirstPartyPackages(document.querySelector('#package-list'));
loadBuiltinAddons();
loadAddons(document.querySelector('#addon-list'));
