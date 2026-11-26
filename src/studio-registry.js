const STUDIO_MENU_NAMES = new Set(['edit', 'view', 'help', 'object']);

const registeredTabsById = new Map();
const registeredMenusByName = new Map();
const registeredStyleBlocks = [];

function compareOrderedEntries(first, second) {
  if (first.order !== second.order) return first.order - second.order;
  const firstKey = first.id ?? first.label ?? '';
  const secondKey = second.id ?? second.label ?? '';
  return firstKey.localeCompare(secondKey);
}

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }
}

function assertFiniteOrder(value, fieldName) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number.`);
  }
}

/** Registers an inspector tab and its panel builder so Studio adds it in `order` without editing studio.js. */
export function registerStudioTab(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError('registerStudioTab requires a tab definition object.');
  }
  assertNonEmptyString(definition.id, 'Studio tab id');
  assertNonEmptyString(definition.label, `Studio tab "${definition.id}" label`);
  assertFiniteOrder(definition.order, `Studio tab "${definition.id}" order`);
  if (!Array.isArray(definition.workspaces) || definition.workspaces.length === 0) {
    throw new TypeError(`Studio tab "${definition.id}" workspaces must be a non-empty array.`);
  }
  if (typeof definition.createPanel !== 'function') {
    throw new TypeError(`Studio tab "${definition.id}" createPanel must be a function.`);
  }
  if (registeredTabsById.has(definition.id)) {
    throw new RangeError(`Studio tab "${definition.id}" is already registered.`);
  }
  const workspaces = Object.freeze(definition.workspaces.map((entry, index) => {
    if (typeof entry === 'string') {
      assertNonEmptyString(entry, `Studio tab "${definition.id}" workspaces[${index}]`);
      return Object.freeze({ id: entry, order: definition.order });
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`Studio tab "${definition.id}" workspaces[${index}] must be a workspace ID or { id, order }.`);
    }
    assertNonEmptyString(entry.id, `Studio tab "${definition.id}" workspaces[${index}].id`);
    const workspaceOrder = entry.order ?? definition.order;
    assertFiniteOrder(workspaceOrder, `Studio tab "${definition.id}" workspaces[${index}].order`);
    return Object.freeze({ id: entry.id, order: workspaceOrder });
  }));
  const record = Object.freeze({
    id: definition.id,
    label: definition.label,
    icon: definition.icon ?? definition.id,
    order: definition.order,
    workspaces,
    bodyClassName: definition.bodyClassName ?? null,
    createPanel: definition.createPanel,
  });
  registeredTabsById.set(record.id, record);
  return record;
}

/** True when a Studio inspector tab with `id` is registered. */
export function hasStudioTab(id) {
  return registeredTabsById.has(id);
}

/** Registered Studio inspector tabs sorted by their `order` (then `id`). */
export function registeredStudioTabs() {
  return [...registeredTabsById.values()].sort(compareOrderedEntries);
}

/** Frozen list of registered Studio tab IDs in display order. */
export function registeredStudioTabIds() {
  return Object.freeze(registeredStudioTabs().map(tab => tab.id));
}

/** Attaches registered tabs to each base workspace in workspace-specific order. */
export function registeredStudioWorkspaces(baseWorkspaces) {
  const tabs = registeredStudioTabs();
  return Object.freeze(baseWorkspaces.map(workspace => {
    const entries = [];
    for (const tab of tabs) {
      const membership = tab.workspaces.find(candidate => candidate.id === workspace.id);
      if (membership) entries.push({ id: tab.id, order: membership.order });
    }
    entries.sort(compareOrderedEntries);
    return Object.freeze({
      ...workspace,
      tabs: Object.freeze(entries.map(entry => entry.id)),
    });
  }));
}

/** Registers an entry in one of Studio's menus (`edit`, `view`, `help`, `object`). */
export function registerStudioMenuEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('registerStudioMenuEntry requires a menu entry object.');
  }
  if (!STUDIO_MENU_NAMES.has(entry.menu)) {
    throw new RangeError(`Unknown Studio menu "${String(entry.menu)}". Use one of ${[...STUDIO_MENU_NAMES].join(', ')}.`);
  }
  assertNonEmptyString(entry.label, 'Studio menu entry label');
  assertFiniteOrder(entry.order, `Studio menu entry "${entry.label}" order`);
  const kind = entry.kind ?? 'item';
  if (kind !== 'item' && kind !== 'toggle') {
    throw new RangeError(`Studio menu entry "${entry.label}" kind must be "item" or "toggle".`);
  }
  if (typeof entry.onChoose !== 'function') {
    throw new TypeError(`Studio menu entry "${entry.label}" onChoose must be a function.`);
  }
  if (kind === 'toggle' && typeof entry.isOn !== 'function') {
    throw new TypeError(`Studio menu toggle "${entry.label}" isOn must be a function.`);
  }
  if (entry.isVisible !== undefined && typeof entry.isVisible !== 'function') {
    throw new TypeError(`Studio menu entry "${entry.label}" isVisible must be a function when provided.`);
  }
  const record = Object.freeze({
    menu: entry.menu,
    label: entry.label,
    actionId: entry.actionId ?? '',
    icon: entry.icon ?? null,
    order: entry.order,
    kind,
    onChoose: entry.onChoose,
    isOn: entry.isOn ?? null,
    lockInShot: Boolean(entry.lockInShot),
    isVisible: entry.isVisible ?? null,
  });
  const list = registeredMenusByName.get(record.menu) ?? [];
  list.push(record);
  registeredMenusByName.set(record.menu, list);
  return record;
}

/** Registered menu entries for `menu`, sorted by `order` (then `label`). */
export function registeredStudioMenuEntries(menu) {
  if (!STUDIO_MENU_NAMES.has(menu)) {
    throw new RangeError(`Unknown Studio menu "${String(menu)}". Use one of ${[...STUDIO_MENU_NAMES].join(', ')}.`);
  }
  return [...(registeredMenusByName.get(menu) ?? [])].sort(compareOrderedEntries);
}

/** Registers CSS text contributed by a self-contained Studio feature module. */
export function registerStudioStyle(css) {
  if (typeof css !== 'string') {
    throw new TypeError('registerStudioStyle requires a CSS string.');
  }
  if (css.length > 0 && !registeredStyleBlocks.includes(css)) {
    registeredStyleBlocks.push(css);
  }
}

/** Combined CSS text registered by Studio feature modules. */
export function registeredStudioStyles() {
  return registeredStyleBlocks.join('\n');
}
