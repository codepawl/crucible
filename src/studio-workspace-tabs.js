import { registerStudioStyle } from './studio-registry.js';

export const STUDIO_SCENE_TABS_KEY = 'crucible.studio.sceneTabs';
const MAX_SAVED_SCENE_TABS = 32;

// The work runs left to right: build the scene, give it its look, set it in motion, then write it out. Each workspace
// defines a fixed set of panels (via studio-registry) and tools on the left rail. Mesh editing is a mode inside Build.
export const BASE_STUDIO_WORKSPACES = Object.freeze([
  Object.freeze({
    id: 'build',
    label: 'Build',
    icon: 'node',
    tools: Object.freeze(['select', 'translate', 'rotate', 'scale', 'snap', 'add', 'undo', 'redo', 'grid', 'seeThrough', 'panels']),
    allowsMeshEdit: true,
    showsOutliner: true,
    showsTimeline: false,
  }),
  Object.freeze({
    id: 'look',
    label: 'Look',
    icon: 'material',
    tools: Object.freeze(['select', 'translate', 'snap', 'add', 'undo', 'redo', 'grid', 'panels']),
    allowsMeshEdit: false,
    showsOutliner: true,
    showsTimeline: false,
  }),
  Object.freeze({
    id: 'animate',
    label: 'Animate',
    icon: 'play',
    tools: Object.freeze(['select', 'translate', 'rotate', 'scale', 'snap', 'add', 'undo', 'redo', 'grid', 'panels']),
    allowsMeshEdit: false,
    showsOutliner: true,
    showsTimeline: true,
  }),
  Object.freeze({
    id: 'export',
    label: 'Export',
    icon: 'export',
    tools: Object.freeze(['undo', 'redo', 'grid', 'panels']),
    allowsMeshEdit: false,
    showsOutliner: false,
    showsTimeline: false,
  }),
]);

registerStudioStyle(`
.crucible-studio-panel-empty {
  margin: 0;
  color: var(--studio-muted);
  font-size: 12.5px;
  line-height: 1.45;
}
.crucible-studio-panel-controls {
  display: grid;
  gap: 12px;
}
.crucible-studio-panel-empty[hidden],
.crucible-studio-panel-controls[hidden] {
  display: none;
}
`);

/** Updates left-rail tool visibility and shot-mode lock state for the active workspace. */
export function syncWorkspaceToolbar(workspace, controls) {
  if (!workspace || typeof workspace !== 'object' || !Array.isArray(workspace.tools)) {
    throw new TypeError('syncWorkspaceToolbar requires a workspace definition with a tools array.');
  }
  const allowedTools = new Set(workspace.tools);
  const inExport = workspace.id === 'export';
  for (const button of controls.toolButtons) {
    button.toggleAttribute('hidden', !allowedTools.has(button.dataset.tool));
  }
  controls.toolGroup.toggleAttribute('hidden', controls.toolButtons.every(button => button.hasAttribute('hidden')));
  const showSnap = allowedTools.has('snap');
  controls.snapToggleButton.toggleAttribute('hidden', !showSnap);
  controls.snapTargetButton.toggleAttribute('hidden', !showSnap);
  controls.snapGroup.toggleAttribute('hidden', !showSnap);
  controls.addMenuButton.toggleAttribute('hidden', !allowedTools.has('add'));
  controls.seeThroughButton.toggleAttribute('hidden', !allowedTools.has('seeThrough'));
  for (const control of [...controls.shotLockedControls, controls.gridButton]) {
    control.setAttribute('aria-disabled', inExport ? 'true' : 'false');
  }
}

/** Storage key for remembering a scene's last active workspace and inspector tab. */
export function sceneWorkspaceStorageKey({ filePath = null, fileName = '' } = {}) {
  if (typeof filePath === 'string' && filePath.trim().length > 0) {
    return `path:${filePath.trim()}`;
  }
  if (typeof fileName === 'string' && fileName.trim().length > 0) {
    return `name:${fileName.trim()}`;
  }
  return null;
}

function readSceneTabMap(storage) {
  if (!storage?.getItem) {
    return {};
  }
  try {
    const raw = storage.getItem(STUDIO_SCENE_TABS_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

/** Loads the saved `{ workspace, activeTab }` for `sceneKey`, or null when none is stored. */
export function loadSceneWorkspaceTab(storage, sceneKey) {
  if (!sceneKey || typeof sceneKey !== 'string') {
    return null;
  }
  const entry = readSceneTabMap(storage)[sceneKey];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  if (typeof entry.workspace !== 'string' || entry.workspace.length === 0) {
    return null;
  }
  const activeTab = typeof entry.activeTab === 'string' && entry.activeTab.length > 0 ? entry.activeTab : null;
  return { workspace: entry.workspace, activeTab };
}

/** Persists `{ workspace, activeTab }` under `sceneKey` in bounded browser storage. */
export function saveSceneWorkspaceTab(storage, sceneKey, state) {
  if (!storage?.setItem || !sceneKey || typeof sceneKey !== 'string') {
    return false;
  }
  if (!state || typeof state.workspace !== 'string' || state.workspace.length === 0) {
    return false;
  }
  const current = readSceneTabMap(storage);
  const nextEntries = Object.entries(current).filter(([key]) => key !== sceneKey);
  const record = { workspace: state.workspace };
  if (typeof state.activeTab === 'string' && state.activeTab.length > 0) {
    record.activeTab = state.activeTab;
  }
  nextEntries.push([sceneKey, record]);
  const trimmed = nextEntries.slice(-MAX_SAVED_SCENE_TABS);
  try {
    storage.setItem(STUDIO_SCENE_TABS_KEY, JSON.stringify(Object.fromEntries(trimmed)));
    return true;
  } catch {
    return false;
  }
}

/** Picks the initial workspace and tab for a scene, restoring its saved tab when valid or falling back to `startWorkspace`. */
export function resolveInitialWorkspaceState({ preferenceStorage, sceneKey, startWorkspace, workspaces }) {
  const saved = loadSceneWorkspaceTab(preferenceStorage, sceneKey);
  if (saved) {
    const workspace = workspaces.find(candidate => candidate.id === saved.workspace);
    if (workspace) {
      const activeTab = saved.activeTab && workspace.tabs.includes(saved.activeTab)
        ? saved.activeTab
        : workspace.tabs[0];
      return { workspace: workspace.id, activeTab, restored: true };
    }
  }
  return { workspace: startWorkspace, activeTab: null, restored: false };
}

/** Builds the top-bar workspace tab strip and binds selection and roving focus. */
export function createWorkspaceTabBar({ documentReference, createElement, createIcon, wireRovingFocusFallback, workspaces, onSelectWorkspace }) {
  const workspaceButtons = workspaces.map(workspace => createElement(
    documentReference,
    'button',
    { type: 'button', dataset: { workspace: workspace.id }, attributes: { role: 'tab', 'aria-selected': 'false', 'aria-label': workspace.label } },
    createIcon(documentReference, workspace.icon),
    createElement(documentReference, 'span', { className: 'crucible-studio-workspace-label', textContent: workspace.label }),
  ));
  const workspaceList = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-island crucible-studio-workspaces', attributes: { role: 'tablist', 'aria-label': 'Workspace' } },
    ...workspaceButtons,
  );
  workspaceButtons.forEach(button => {
    button.addEventListener('click', () => onSelectWorkspace(button.dataset.workspace));
  });
  wireRovingFocusFallback(workspaceList, workspaceButtons, {
    followFocus: true,
    onSelect: button => onSelectWorkspace(button.dataset.workspace),
  });
  return { workspaceButtons, workspaceList };
}

/** Manages active workspace and inspector tab switching, toolbar visibility, and per-scene tab persistence. */
export function createWorkspaceTabController({
  root,
  controller,
  workspaces,
  workspaceButtons,
  tabButtons,
  tabListElement,
  panelsByTab,
  outlinerDock,
  getExportPanel,
  getMeshEditor,
  leaveMeshEdit,
  showInspectorTitle,
  syncPropertyPanels,
  requestFrame,
  getToolbarControls,
  preferenceStorage,
  getFileContext,
}) {
  let persistenceReady = false;

  function persistCurrent() {
    if (!persistenceReady) {
      return;
    }
    const { filePath, fileName } = getFileContext();
    const key = sceneWorkspaceStorageKey({ filePath, fileName });
    saveSceneWorkspaceTab(preferenceStorage, key, { workspace: root.dataset.workspace, activeTab: controller.activeTab });
  }

  function showInspectorTab(nextTab) {
    controller.setActiveTab(nextTab);
    syncPropertyPanels();
    for (const button of tabButtons) {
      const selected = button.dataset.tab === nextTab;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.toggleAttribute('focusgroupstart', selected);
    }
    for (const [tab, panel] of Object.entries(panelsByTab)) {
      if (tab === nextTab) {
        panel.removeAttribute('hidden');
        panel.tabIndex = 0;
      } else {
        panel.setAttribute('hidden', 'until-found');
        panel.removeAttribute('tabindex');
      }
    }
    persistCurrent();
  }

  function selectWorkspace(nextWorkspace, preferredTab) {
    const workspace = workspaces.find(candidate => candidate.id === nextWorkspace);
    if (!workspace) {
      throw new RangeError(`Unknown Studio workspace "${String(nextWorkspace)}". Use one of ${workspaces.map(candidate => candidate.id).join(', ')}.`);
    }
    const workspaceWasOpen = root.dataset.workspace === workspace.id;
    const firstWorkspace = root.dataset.workspace === undefined;
    root.dataset.workspace = workspace.id;
    const inExport = workspace.id === 'export';
    if (!workspace.allowsMeshEdit && getMeshEditor()?.active) {
      leaveMeshEdit();
    }
    if (!inExport) {
      getExportPanel()?.clearResults();
    }
    outlinerDock.inert = inExport;
    syncWorkspaceToolbar(workspace, getToolbarControls());
    showInspectorTitle(inExport);
    if (!workspaceWasOpen && !firstWorkspace) {
      requestFrame();
    }
    for (const button of workspaceButtons) {
      button.setAttribute('aria-selected', button.dataset.workspace === workspace.id ? 'true' : 'false');
    }
    for (const button of tabButtons) {
      button.toggleAttribute('hidden', !workspace.tabs.includes(button.dataset.tab));
    }
    tabListElement.toggleAttribute('hidden', workspace.tabs.length < 2);
    const keptTab = workspaceWasOpen && workspace.tabs.includes(controller.activeTab) ? controller.activeTab : workspace.tabs[0];
    showInspectorTab(preferredTab ?? keptTab);
  }

  function selectInspectorTab(nextTab) {
    const holdsTab = workspace => workspace.tabs.includes(nextTab);
    const openWorkspace = workspaces.find(workspace => workspace.id === root.dataset.workspace);
    const owner = openWorkspace && holdsTab(openWorkspace) ? openWorkspace : workspaces.find(holdsTab) ?? workspaces[0];
    selectWorkspace(owner.id, nextTab);
  }

  function restoreForFile(filePath, fileName) {
    const saved = loadSceneWorkspaceTab(preferenceStorage, sceneWorkspaceStorageKey({ filePath, fileName }));
    if (!saved) {
      return false;
    }
    const workspace = workspaces.find(candidate => candidate.id === saved.workspace);
    if (!workspace) {
      return false;
    }
    const tab = saved.activeTab && workspace.tabs.includes(saved.activeTab) ? saved.activeTab : workspace.tabs[0];
    selectWorkspace(workspace.id, tab);
    return true;
  }

  function initialize(startWorkspace) {
    const { filePath, fileName } = getFileContext();
    const initial = resolveInitialWorkspaceState({
      preferenceStorage,
      sceneKey: sceneWorkspaceStorageKey({ filePath, fileName }),
      startWorkspace,
      workspaces,
    });
    if (initial.restored) {
      selectWorkspace(initial.workspace, initial.activeTab);
    } else if (initial.workspace !== 'build') {
      selectWorkspace(initial.workspace);
    } else {
      selectInspectorTab(controller.activeTab);
    }
    persistenceReady = true;
  }

  return {
    selectWorkspace,
    selectInspectorTab,
    persistCurrent,
    restoreForFile,
    initialize,
  };
}
