import test from 'node:test';
import assert from 'node:assert/strict';
import { ADDON_AREAS, ADDON_CATALOG } from '../src/addon-catalog.js';
import { filterBuiltinAddons, parseFilterWords } from '../src/marketplace-filter.js';

test('parseFilterWords splits multiple spaces and trims whitespace', () => {
  assert.deepEqual(parseFilterWords('  mesh   query  '), ['mesh', 'query']);
  assert.deepEqual(parseFilterWords(''), []);
  assert.deepEqual(parseFilterWords(null), []);
});

test('filterBuiltinAddons matches multi-word queries across name, area, and summary', () => {
  const result = filterBuiltinAddons(ADDON_CATALOG, ADDON_AREAS, { query: 'mesh query' });
  assert.ok(result.shownCount >= 1);
  assert.ok(result.matching.some(addon => addon.name === 'mesh-query'));
  assert.equal(result.totalCount, ADDON_CATALOG.length);
  assert.equal(result.queryTotal, result.shownCount);
});

test('filterBuiltinAddons scopes matches by selected area while preserving query counts per area', () => {
  const result = filterBuiltinAddons(ADDON_CATALOG, ADDON_AREAS, { area: 'world', query: '' });
  assert.ok(result.shownCount > 0);
  assert.ok(result.matching.every(addon => addon.area === 'world'));
  assert.equal(result.queryTotal, ADDON_CATALOG.length);
  assert.equal(result.shownCount, result.queryCountsByArea.world);
});

test('filterBuiltinAddons returns zero matches when no addon matches', () => {
  const result = filterBuiltinAddons(ADDON_CATALOG, ADDON_AREAS, { area: 'all', query: 'definitely-nonexistent-addon' });
  assert.equal(result.shownCount, 0);
  assert.deepEqual(result.matching, []);
});
