import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveEffects } from '../src/effects.js';
import { CrucibleRenderer } from '../src/renderer.js';
import { registeredFeatureCode, registerShaderFeatureCode } from '../src/shader-registry.js';
import {
  hasStudioTab,
  registeredStudioMenuEntries,
  registeredStudioTabIds,
  registeredStudioTabs,
  registeredStudioWorkspaces,
  registerStudioMenuEntry,
  registerStudioStyle,
  registerStudioTab,
} from '../src/studio-registry.js';
import { STUDIO_TABS } from '../src/studio.js';

const ROOT_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..');

function extractArrayItems(source, declarationPattern) {
  const match = source.match(declarationPattern);
  assert.ok(match, `Missing declaration matching ${declarationPattern}`);
  const lines = match[1]
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('//'));
  const literalLines = lines.filter(line => !line.startsWith('...'));
  for (const line of lines) {
    assert.equal(line.endsWith(','), true, `Expected trailing comma on item line: ${line}`);
    assert.equal(line.split(',').filter(Boolean).length, 1, `Expected one item per line: ${line}`);
  }
  return literalLines.map(line => line.slice(0, -1).replace(/^['"]|['"]$/g, ''));
}

function assertSortedUnique(items, label) {
  const unique = new Set(items);
  assert.equal(unique.size, items.length, `${label} must not contain duplicate entries`);
  const sorted = [...items].sort((first, second) => first.localeCompare(second));
  assert.deepEqual(items, sorted, `${label} must be sorted alphabetically`);
}

test('studio-registry validates inputs and keeps built-in tabs and workspaces ordered', () => {
  assert.deepEqual(STUDIO_TABS, ['node', 'looks', 'modifiers', 'material', 'look', 'camera', 'export']);
  assert.deepEqual(registeredStudioTabIds(), STUDIO_TABS);
  assert.equal(hasStudioTab('modifiers'), true);
  assert.equal(hasStudioTab('export'), true);

  const workspaces = registeredStudioWorkspaces([
    { id: 'build', label: 'Build', icon: 'node' },
    { id: 'look', label: 'Look', icon: 'material' },
    { id: 'animate', label: 'Animate', icon: 'play' },
    { id: 'export', label: 'Export', icon: 'export' },
  ]);
  assert.deepEqual(workspaces.map(workspace => [workspace.id, workspace.tabs]), [
    ['build', ['node', 'modifiers']],
    ['look', ['looks', 'material', 'look']],
    ['animate', ['camera', 'node']],
    ['export', ['export']],
  ]);

  assert.throws(() => registerStudioTab(null), TypeError);
  assert.throws(() => registerStudioTab({ id: '', label: 'X', order: 1, workspaces: ['build'], createPanel: () => ({}) }), TypeError);
  assert.throws(() => registerStudioTab({ id: 'node', label: 'Dup', order: 1, workspaces: ['build'], createPanel: () => ({}) }), RangeError);
  assert.throws(() => registerStudioTab({ id: 'x', label: 'X', order: NaN, workspaces: ['build'], createPanel: () => ({}) }), TypeError);
  assert.throws(() => registerStudioTab({ id: 'x', label: 'X', order: 1, workspaces: [], createPanel: () => ({}) }), TypeError);
  assert.throws(() => registerStudioTab({ id: 'x', label: 'X', order: 1, workspaces: ['build'], createPanel: null }), TypeError);

  assert.throws(() => registerStudioMenuEntry({ menu: 'unknown', label: 'X', order: 1, onChoose: () => {} }), RangeError);
  assert.throws(() => registerStudioMenuEntry({ menu: 'view', label: 'X', order: 1, kind: 'toggle', onChoose: () => {} }), TypeError);
  assert.throws(() => registeredStudioMenuEntries('unknown'), RangeError);
  assert.throws(() => registerStudioStyle(123), TypeError);

  const tabs = registeredStudioTabs();
  assert.equal(tabs.find(tab => tab.id === 'modifiers').bodyClassName, 'crucible-studio-panel-body crucible-studio-modifier-body');
});

test('a module registering a Studio tab, menu entry, and style mounts cleanly without editing studio.js', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { registerStudioMenuEntry, registerStudioStyle, registerStudioTab } from './src/studio-registry.js';
    import { createStudio } from './src/studio.js';
    import { createFakeRenderer, installStudioDom } from './tests/support/studio-dom.mjs';

    let synced = 0;
    let menuClicked = 0;
    registerStudioStyle('.crucible-studio-sample-panel { color: inherit; }');
    registerStudioTab({
      id: 'sample',
      label: 'Sample',
      icon: 'settings',
      order: 25,
      workspaces: ['build'],
      createPanel: ({ documentReference }) => {
        const element = documentReference.createElement('div');
        element.className = 'crucible-studio-sample-panel';
        return { element, sync: () => { synced += 1; } };
      },
    });
    registerStudioMenuEntry({
      menu: 'view',
      order: 105,
      kind: 'item',
      label: 'Sample View Action',
      icon: 'settings',
      onChoose: () => { menuClicked += 1; },
    });

    const environment = installStudioDom();
    try {
      const studio = createStudio(environment.container, {
        documentReference: environment.document,
        createRenderer: (canvas, parts, options) => createFakeRenderer(canvas, parts, options),
      });
      const sampleTab = environment.document.getElementById('crucible-studio-tab-sample');
      const samplePanel = environment.document.getElementById('crucible-studio-panel-sample');
      assert.ok(sampleTab, 'custom tab button should mount');
      assert.ok(samplePanel, 'custom tab panel should mount');
      assert.equal(sampleTab.hasAttribute('hidden'), false, 'build workspace should show custom tab');
      sampleTab.click();
      assert.equal(synced > 0, true, 'selecting custom tab should call panel.sync');
      const viewMenu = environment.document.getElementById('crucible-studio-pop-view');
      const menuItem = viewMenu.querySelectorAll('button').find(button => button.textContent.includes('Sample View Action'));
      assert.ok(menuItem, 'custom menu item should mount into view menu');
      menuItem.click();
      assert.equal(menuClicked, 1, 'clicking custom menu item should invoke onChoose');
      const styleTag = environment.document.getElementById('crucible-studio-styles');
      assert.equal(styleTag.textContent.includes('.crucible-studio-sample-panel'), true, 'registered style should inject');
      studio.dispose();
    } finally {
      environment.uninstall();
    }
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: ROOT_FOLDER,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
});

test('studio-features.js keeps imports sorted one per line', () => {
  const source = readFileSync(join(ROOT_FOLDER, 'src/studio-features.js'), 'utf8');
  const imports = [...source.matchAll(/^import\s+'([^']+)';$/gm)].map(match => match[1]);
  assert.ok(imports.length >= 2, 'studio-features.js should list feature module imports');
  assertSortedUnique(imports, 'studio-features.js imports');
});

test('agent-scene.js and material-patterns.js keep field lists one item per line with sorted extension lists', () => {
  const agentSceneSource = readFileSync(join(ROOT_FOLDER, 'src/agent-scene.js'), 'utf8');
  const patternSource = readFileSync(join(ROOT_FOLDER, 'src/material-patterns.js'), 'utf8');

  const nodeFields = extractArrayItems(agentSceneSource, /const NODE_FIELDS = \[([\s\S]*?)\];/);
  assert.equal(new Set(nodeFields).size, nodeFields.length, 'agent-scene.js NODE_FIELDS must not contain duplicate entries');

  const materialFields = extractArrayItems(agentSceneSource, /const MATERIAL_FIELDS = \[([\s\S]*?)\];/);
  assert.equal(new Set(materialFields).size, materialFields.length, 'agent-scene.js MATERIAL_FIELDS must not contain duplicate entries');
  assert.equal(agentSceneSource.includes('MATERIAL_FIELDS.push('), false, 'material fields belong in MATERIAL_FIELDS or EXTRA_MATERIAL_FIELDS');
  const extraMaterialFields = extractArrayItems(agentSceneSource, /const EXTRA_MATERIAL_FIELDS = \[([\s\S]*?)\];/);
  assertSortedUnique(extraMaterialFields, 'agent-scene.js EXTRA_MATERIAL_FIELDS');

  const patternFields = extractArrayItems(agentSceneSource, /const PATTERN_TEXTURE_FIELDS = \[([\s\S]*?)\];/);
  assert.equal(new Set(patternFields).size, patternFields.length, 'agent-scene.js PATTERN_TEXTURE_FIELDS must not contain duplicates');

  const duplicatedPatternFields = extractArrayItems(patternSource, /const PATTERN_TEXTURE_FIELDS = \[([\s\S]*?)\];/);
  assert.deepEqual(duplicatedPatternFields, patternFields);

  const renderFlags = extractArrayItems(agentSceneSource, /const RENDER_FLAG_FIELDS = \[([\s\S]*?)\];/);
  assert.equal(renderFlags[0], 'visible', 'visible must stay first in RENDER_FLAG_FIELDS for slice(1)');
  assert.equal(new Set(renderFlags).size, renderFlags.length, 'agent-scene.js RENDER_FLAG_FIELDS must not contain duplicates');

  const geometryBlock = agentSceneSource.match(/const GEOMETRY_FIELDS = \{([\s\S]*?)\n\};/);
  assert.ok(geometryBlock, 'GEOMETRY_FIELDS missing from src/agent-scene.js');
  const geometryNames = [...geometryBlock[1].matchAll(/^\s{2}(\w+): \[/gm)].map(match => match[1]);
  assert.equal(new Set(geometryNames).size, geometryNames.length, 'agent-scene.js GEOMETRY_FIELDS keys must not contain duplicates');
  assert.equal(geometryNames.length >= 22, true);
});

test('renderer.js keeps feature lists sorted one item per line and dispatches registered postStep hooks', () => {
  const rendererSource = readFileSync(join(ROOT_FOLDER, 'src/renderer.js'), 'utf8');

  const presentFeatures = extractArrayItems(rendererSource, /const PRESENT_SHADER_FEATURES = \[([\s\S]*?)\];/);
  assertSortedUnique(presentFeatures, 'renderer.js PRESENT_SHADER_FEATURES');

  const positiveFeatures = extractArrayItems(rendererSource, /const POSITIVE_SHADER_FEATURES = \[([\s\S]*?)\];/);
  assertSortedUnique(positiveFeatures, 'renderer.js POSITIVE_SHADER_FEATURES');

  const tagFeatures = extractArrayItems(rendererSource, /const TAG_SHADER_FEATURES = new Set\(\[([\s\S]*?)\]\);/);
  assertSortedUnique(tagFeatures, 'renderer.js TAG_SHADER_FEATURES');

  const postUniforms = extractArrayItems(rendererSource, /const POST_UNIFORMS = \[([\s\S]*?)\];/);
  assert.equal(new Set(postUniforms).size, postUniforms.length, 'renderer.js POST_UNIFORMS must have no duplicates');

  const featureName = '__testPostStepHook';
  registerShaderFeatureCode(featureName, {
    postStep: (renderer, frame) => (frame.customStep ? 'customStep' : null),
  });
  try {
    const stepsWithout = CrucibleRenderer.prototype.postStepsOf.call({ transparent: false }, {}, resolveEffects({}), { density: 0 }, false, null, false);
    assert.equal(stepsWithout.includes('customStep'), false);
    const stepsWith = CrucibleRenderer.prototype.postStepsOf.call({ transparent: false }, { customStep: true }, resolveEffects({}), { density: 0 }, false, null, false);
    assert.equal(stepsWith.includes('customStep'), true);
  } finally {
    registeredFeatureCode.delete(featureName);
  }
});
