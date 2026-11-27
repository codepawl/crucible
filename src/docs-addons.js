import { ADDON_AREAS, ADDON_CATALOG, addonImportLine } from './addon-catalog.js';
import { filterBuiltinAddons } from './marketplace-filter.js';

const REPOSITORY_URL = 'https://github.com/codepawl/crucible/blob/main';
const PACKAGE_PREFIX = '@codepawlhq/crucible/addons/';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addonCard(addon) {
  const card = element('article', 'docs-addon-card');
  card.dataset.addonName = addon.name;
  const docUrl = addon.doc ? `${REPOSITORY_URL}/docs/${addon.name}.md` : `${REPOSITORY_URL}/src/${addon.name}.js`;

  const header = element('div', 'docs-addon-head');
  const title = element('h4', 'docs-addon-name');
  const link = element('a', '', addon.name);
  link.href = docUrl;
  title.append(link);

  const copyButton = element('button', 'docs-addon-copy', 'Copy import');
  copyButton.type = 'button';
  copyButton.dataset.copy = addonImportLine(addon.name);
  copyButton.setAttribute('aria-label', `Copy import statement for ${addon.name}`);
  header.append(title, copyButton);

  const summary = element('p', 'docs-addon-summary', addon.summary);
  const specifier = element('code', 'docs-addon-specifier', `${PACKAGE_PREFIX}${addon.name}`);
  specifier.dataset.noHighlight = '1';
  card.append(header, summary, specifier);
  return card;
}

function addonGroup(area, cardsByAddon) {
  const group = element('section', 'docs-addon-group');
  group.dataset.area = area.id;
  const addons = ADDON_CATALOG.filter(addon => addon.area === area.id);
  const heading = element('h3', 'docs-addon-area', area.label);
  const badge = element('span', 'docs-addon-area-count', String(addons.length));
  heading.append(badge);
  const grid = element('div', 'docs-addon-grid');
  grid.append(...addons.map(addon => {
    const card = addonCard(addon);
    cardsByAddon.set(addon.name, card);
    return card;
  }));
  group.append(heading, grid);
  return group;
}

function areaButton(id, label, count, pressed) {
  const button = element('button', 'docs-addon-chip', label);
  button.type = 'button';
  button.dataset.area = id;
  button.setAttribute('aria-pressed', String(pressed));
  button.append(element('span', 'docs-addon-chip-count', String(count)));
  return button;
}

/** Creates the interactive built-in addons browser embedded in Docs under Addons and limits. */
export function createBuiltinAddonsBrowser() {
  const container = element('div', 'docs-addons');
  const toolbar = element('div', 'docs-addons-toolbar');
  const areaControls = element('div', 'docs-addon-areas');
  areaControls.setAttribute('role', 'group');
  areaControls.setAttribute('aria-label', 'Filter built-in addons by area');

  const filterInput = element('input', 'docs-addon-filter');
  filterInput.type = 'search';
  filterInput.placeholder = 'Search built-in addons';
  filterInput.setAttribute('aria-label', 'Search built-in addons');
  filterInput.autocomplete = 'off';

  const countLabel = element('p', 'docs-addons-count');
  countLabel.setAttribute('role', 'status');
  countLabel.setAttribute('aria-live', 'polite');

  const listContainer = element('div', 'docs-addon-list');
  toolbar.append(areaControls, filterInput);
  container.append(toolbar, countLabel, listContainer);

  const cardsByAddon = new Map();
  const groups = ADDON_AREAS.map(area => addonGroup(area, cardsByAddon));
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
      const badge = group.querySelector('.docs-addon-area-count');
      if (badge) badge.textContent = String(areaMatches);
    }

    for (const button of areaButtons) {
      const areaId = button.dataset.area;
      button.setAttribute('aria-pressed', String(areaId === selectedArea));
      const areaCount = areaId === 'all' ? filtered.queryTotal : (filtered.queryCountsByArea[areaId] ?? 0);
      const countSpan = button.querySelector('.docs-addon-chip-count');
      if (countSpan) countSpan.textContent = String(areaCount);
    }

    const activeQuery = query.trim();
    countLabel.textContent = selectedArea === 'all' && !activeQuery
      ? `${filtered.totalCount} built-in addons ready to import from @codepawlhq/crucible/addons/*`
      : `${filtered.shownCount} of ${filtered.totalCount} built-in addons`;

    listContainer.querySelector('.docs-addon-empty')?.remove();
    if (filtered.shownCount === 0) {
      const reason = activeQuery ? `No built-in addon matches "${activeQuery}".` : 'No built-in addons in this area.';
      const empty = element('p', 'docs-addon-empty', reason);
      empty.setAttribute('role', 'status');
      listContainer.append(empty);
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

  return container;
}
