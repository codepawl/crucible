/** Splits a search query into trimmed lowercase terms on whitespace. */
export function parseFilterWords(query) {
  return String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Filters built-in addon entries by selected area and search words.
 * Returns matching entries, shown and total counts, and per-area totals matching the query.
 */
export function filterBuiltinAddons(addons, areas, { area = 'all', query = '' } = {}) {
  const words = parseFilterWords(query);
  const queryCountsByArea = Object.fromEntries(areas.map(entry => [entry.id, 0]));
  const matching = [];
  let queryTotal = 0;

  for (const addon of addons) {
    const haystack = `${addon.name} ${addon.area} ${addon.summary}`.toLowerCase();
    if (!words.every(word => haystack.includes(word))) continue;
    queryTotal += 1;
    if (addon.area in queryCountsByArea) queryCountsByArea[addon.area] += 1;
    if (area === 'all' || addon.area === area) matching.push(addon);
  }

  return {
    matching,
    shownCount: matching.length,
    totalCount: addons.length,
    queryTotal,
    queryCountsByArea,
  };
}
