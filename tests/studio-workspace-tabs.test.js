import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio, STUDIO_TABS, STUDIO_TOOLS } from '../src/studio.js';
import { loadStudioDraft, saveStudioDraft } from '../src/studio-draft.js';
import { registeredStudioWorkspaces } from '../src/studio-registry.js';
import {
  BASE_STUDIO_WORKSPACES,
  loadSceneWorkspaceTab,
  resolveInitialWorkspaceState,
  saveSceneWorkspaceTab,
  sceneWorkspaceStorageKey,
  STUDIO_SCENE_TABS_KEY,
  syncWorkspaceToolbar,
} from '../src/studio-workspace-tabs.js';
import { byDataset, byLabel, byText, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

function makeRecipe({ withMaterials = true, withNodes = true } = {}) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: withMaterials ? [{ id: 'clay', color: [0.7, 0.3, 0.2], roughness: 0.5, metallic: 0 }] : [],
    nodes: withNodes ? [
      { id: 'hero', label: 'Hero', geometry: 'cube', ...(withMaterials ? { material: 'clay' } : {}), translation: [0, 0.5, 0] },
      { id: 'group', label: 'Group' },
    ] : [],
    environment: { setup: 'daylight', lightDirection: [-3, 6, 4] },
    camera: { eye: [2, 2, 4], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  };
}

function memoryStorage() {
  const entries = new Map();
  return {
    entries,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: key => entries.delete(key),
  };
}

function mount(testContext, options = {}) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, {
    recipe: options.recipe ?? makeRecipe(),
    renderer: createFakeRenderer(),
    ...options,
  });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  const root = dom.container.firstElementChild;
  return {
    dom,
    studio,
    controller: studio.controller,
    root,
    workspaceTab: id => byDataset(root, 'workspace', id),
    tab: id => byDataset(root, 'tab', id),
    panel: id => root.querySelector(`#crucible-studio-panel-${id}`),
    tool: id => byDataset(root, 'tool', id),
  };
}

test('workspace tabs stay ordered Build, Look, Animate, Export with distinct icons and fixed panels', () => {
  const workspaces = registeredStudioWorkspaces(BASE_STUDIO_WORKSPACES);
  assert.deepEqual(workspaces.map(workspace => workspace.id), ['build', 'look', 'animate', 'export']);
  assert.deepEqual(workspaces.map(workspace => workspace.label), ['Build', 'Look', 'Animate', 'Export']);
  const icons = workspaces.map(workspace => workspace.icon);
  assert.equal(new Set(icons).size, 4, 'all four workspace tabs use distinct icons');
  assert.deepEqual(icons, ['node', 'material', 'play', 'export']);
  assert.deepEqual(workspaces.map(workspace => [workspace.id, workspace.tabs]), [
    ['build', ['node', 'modifiers']],
    ['look', ['material', 'look']],
    ['animate', ['camera', 'node']],
    ['export', ['export']],
  ]);
  assert.deepEqual(workspaces.map(workspace => [workspace.id, workspace.allowsMeshEdit]), [
    ['build', true],
    ['look', false],
    ['animate', false],
    ['export', false],
  ]);
});

test('each workspace shows only its fixed set of panels and left-rail tools', testContext => {
  const ui = mount(testContext);
  const visiblePanels = () => STUDIO_TABS.filter(id => !ui.tab(id).hasAttribute('hidden'));
  const visibleTools = () => STUDIO_TOOLS.filter(id => !ui.tool(id).hasAttribute('hidden'));
  const snapVisible = () => !byDataset(ui.root, 'snapToggle', 'true').hasAttribute('hidden');
  const addVisible = () => !byLabel(ui.root, 'Add an object or a light').hasAttribute('hidden');
  const seeThroughVisible = () => !ui.root.querySelector('[data-icon="seeThrough"]')?.closest('button')
    ? !byLabel(ui.root, 'See through the surface (Alt+Z)').hasAttribute('hidden')
    : !ui.root.querySelector('[data-icon="seeThrough"]').hasAttribute('hidden');

  assert.equal(ui.studio.activeWorkspace, 'build');
  assert.deepEqual(visiblePanels(), ['node', 'modifiers']);
  assert.deepEqual(visibleTools(), ['select', 'translate', 'rotate', 'scale']);
  assert.equal(snapVisible(), true);
  assert.equal(addVisible(), true);
  assert.equal(seeThroughVisible(), true);

  ui.workspaceTab('look').click();
  assert.equal(ui.studio.activeWorkspace, 'look');
  assert.deepEqual(visiblePanels(), ['material', 'look']);
  assert.deepEqual(visibleTools(), ['select', 'translate']);
  assert.equal(snapVisible(), true);
  assert.equal(addVisible(), true);
  assert.equal(seeThroughVisible(), false);

  ui.workspaceTab('animate').click();
  assert.equal(ui.studio.activeWorkspace, 'animate');
  assert.deepEqual(visiblePanels(), ['node', 'camera']);
  assert.deepEqual(visibleTools(), ['select', 'translate', 'rotate', 'scale']);
  assert.equal(snapVisible(), true);
  assert.equal(addVisible(), true);
  assert.equal(seeThroughVisible(), false);

  ui.workspaceTab('export').click();
  assert.equal(ui.studio.activeWorkspace, 'export');
  assert.deepEqual(visiblePanels(), ['export']);
  assert.deepEqual(visibleTools(), []);
  assert.equal(snapVisible(), false);
  assert.equal(addVisible(), false);
  assert.equal(seeThroughVisible(), false);
  assert.equal(byLabel(ui.root, 'Transform tool').hasAttribute('hidden'), true);
  assert.equal(byLabel(ui.root, 'Snapping').hasAttribute('hidden'), true);
  assert.throws(() => syncWorkspaceToolbar(null, {}), TypeError);
});

test('mesh editing stays a mode inside Build: entering switches to Build and leaving Build exits edit mode', async testContext => {
  const ui = mount(testContext);
  ui.controller.selectNode('hero');
  ui.workspaceTab('look').click();
  assert.equal(ui.studio.activeWorkspace, 'look');

  dispatch(ui.dom.document, 'keydown', { key: 'Tab' });
  await ui.dom.settle();
  assert.equal(ui.root.dataset.meshEdit, 'true');
  assert.equal(ui.studio.activeWorkspace, 'build', 'entering mesh edit mode brings Build forward');

  ui.workspaceTab('animate').click();
  assert.equal(ui.studio.activeWorkspace, 'animate');
  assert.equal(ui.root.dataset.meshEdit, 'false', 'leaving Build exits mesh edit mode');

  ui.workspaceTab('export').click();
  dispatch(ui.dom.document, 'keydown', { key: 'Tab' });
  await ui.dom.settle();
  assert.equal(ui.root.dataset.meshEdit, 'false', 'Export blocks mesh edit mode');
  assert.equal(ui.studio.activeWorkspace, 'export');
});

test('no tab ever opens onto an empty panel when nothing or a non-mesh/empty scene is selected', testContext => {
  const ui = mount(testContext, { recipe: makeRecipe({ withMaterials: false, withNodes: true }) });
  ui.controller.selectNode(null);

  // Build > Object with nothing selected shows empty prompt and hides dead controls.
  ui.studio.setWorkspace('build', 'node');
  const nodePanel = ui.panel('node');
  const nodePrompt = nodePanel.querySelector('.crucible-studio-panel-empty');
  const nodeControls = nodePanel.querySelector('.crucible-studio-panel-controls');
  assert.equal(nodePrompt.hidden, false);
  assert.match(nodePrompt.textContent, /Select an object/);
  assert.equal(nodeControls.hidden, true);

  // Selecting a light/camera also shows the prompt in Object.
  ui.controller.selectSceneObject('camera');
  ui.studio.setWorkspace('animate', 'node');
  assert.equal(nodePrompt.hidden, false);
  assert.equal(nodeControls.hidden, true);

  // Build > Modifiers with nothing selected shows prompt.
  ui.studio.setWorkspace('build', 'modifiers');
  const modPrompt = ui.panel('modifiers').querySelector('.crucible-studio-modifier-empty');
  assert.equal(modPrompt.hidden, false);
  assert.match(modPrompt.textContent, /Select a shape or a mesh/);

  // Look > Material in a scene with no materials shows prompt and hides disabled controls.
  const emptyContainer = ui.dom.document.createElement('div');
  ui.dom.document.body.append(emptyContainer);
  const emptyStudio = createStudio(emptyContainer, { recipe: makeRecipe({ withMaterials: false, withNodes: false }), renderer: createFakeRenderer() });
  try {
    emptyStudio.setWorkspace('look', 'material');
    const matPanel = emptyContainer.firstElementChild.querySelector('#crucible-studio-panel-material');
    const matEmptySlot = matPanel.querySelectorAll('.crucible-studio-empty-slot').find(slot => /No materials yet/.test(slot.textContent) && !slot.hidden);
    assert.ok(matEmptySlot, 'the Material panel shows the "No materials yet" slot');
    const matControls = matPanel.querySelector('.crucible-studio-panel-controls');
    assert.match(matEmptySlot.textContent, /No materials yet/);
    assert.match(matEmptySlot.textContent, /New material/);
    assert.equal(matControls.hidden, true);
  } finally {
    emptyStudio.dispose();
  }

  // Selecting a node shows Object controls and hides prompt.
  ui.controller.selectNode('hero');
  ui.studio.setWorkspace('build', 'node');
  assert.equal(nodePrompt.hidden, true);
  assert.equal(nodeControls.hidden, false);

  // Look > Look, Animate > Camera, Export > Export always contain controls.
  ui.studio.setWorkspace('look', 'look');
  assert.ok(ui.panel('look').querySelectorAll('button').length > 0);
  ui.studio.setWorkspace('animate', 'camera');
  assert.ok(ui.panel('camera').querySelectorAll('button').length > 0);
  ui.studio.setWorkspace('export', 'export');
  assert.equal(ui.panel('export').querySelectorAll('.crucible-studio-export-group').length, 3);
});

test('active workspace and inspector tab persist and restore per scene and with drafts without changing the recipe', async testContext => {
  const storage = memoryStorage();
  assert.equal(sceneWorkspaceStorageKey({ filePath: 'C:/scenes/a.scene.json', fileName: 'a.scene.json' }), 'path:C:/scenes/a.scene.json');
  assert.equal(sceneWorkspaceStorageKey({ filePath: null, fileName: 'b.scene.json' }), 'name:b.scene.json');
  assert.equal(sceneWorkspaceStorageKey({}), null);
  assert.equal(saveSceneWorkspaceTab(storage, 'name:a.scene.json', { workspace: 'look', activeTab: 'look' }), true);
  assert.deepEqual(loadSceneWorkspaceTab(storage, 'name:a.scene.json'), { workspace: 'look', activeTab: 'look' });
  const initial = resolveInitialWorkspaceState({
    preferenceStorage: storage,
    sceneKey: 'name:a.scene.json',
    startWorkspace: 'build',
    workspaces: registeredStudioWorkspaces(BASE_STUDIO_WORKSPACES),
  });
  assert.deepEqual(initial, { workspace: 'look', activeTab: 'look', restored: true });

  const sceneStorage = memoryStorage();
  const first = mount(testContext, { preferenceStorage: sceneStorage, fileName: 'castle.scene.json' });
  const recipeBefore = JSON.stringify(first.studio.exportRecipe());
  first.studio.setWorkspace('look', 'look');
  assert.equal(JSON.stringify(first.studio.exportRecipe()), recipeBefore, 'workspace tab stays out of the recipe');
  assert.equal(first.controller.canUndo, false, 'workspace tab stays out of undo');
  assert.ok(sceneStorage.entries.has(STUDIO_SCENE_TABS_KEY));

  // Reopening the same scene restores Look > look.
  const reopened = mount(testContext, { preferenceStorage: sceneStorage, fileName: 'castle.scene.json' });
  assert.equal(reopened.studio.activeWorkspace, 'look');
  assert.equal(reopened.controller.activeTab, 'look');

  // Opening a different scene without a saved tab uses startWorkspace ('animate' when set).
  const untouched = mount(testContext, {
    preferenceStorage: sceneStorage,
    fileName: 'fresh.scene.json',
    preferences: { startWorkspace: 'animate' },
  });
  assert.equal(untouched.studio.activeWorkspace, 'animate');
  assert.equal(untouched.controller.activeTab, 'camera');

  // Draft save & restore preserves workspace and activeTab.
  const draftStorage = memoryStorage();
  const drafted = mount(testContext, { preferenceStorage: draftStorage, fileName: 'drafted.scene.json' });
  drafted.studio.setWorkspace('animate', 'node');
  drafted.controller.updateNodeTransform('hero', { translation: [2, 0.5, 0] });
  drafted.dom.runTimers();
  const savedDraft = loadStudioDraft(draftStorage);
  assert.equal(savedDraft.workspace, 'animate');
  assert.equal(savedDraft.activeTab, 'node');

  // Even if startWorkspace prefers build and sceneTabs is cleared, restoring the draft restores Animate > node.
  draftStorage.removeItem(STUDIO_SCENE_TABS_KEY);
  const restoredStudio = mount(testContext, { preferenceStorage: draftStorage, fileName: 'drafted.scene.json' });
  await restoredStudio.studio.ready;
  assert.equal(restoredStudio.studio.activeWorkspace, 'build');
  byText(restoredStudio.root, 'Restore').click();
  await restoredStudio.dom.settle();
  assert.equal(restoredStudio.studio.activeWorkspace, 'animate');
  assert.equal(restoredStudio.controller.activeTab, 'node');

  // Calling saveStudioDraft without workspaceState keeps legacy draft shape.
  const legacyStorage = memoryStorage();
  assert.equal(saveStudioDraft(legacyStorage, makeRecipe(), 'legacy.scene.json'), 'saved');
  assert.deepEqual(loadStudioDraft(legacyStorage), { fileName: 'legacy.scene.json', recipe: makeRecipe() });
});
