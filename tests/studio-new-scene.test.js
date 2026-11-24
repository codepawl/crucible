import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio, STUDIO_TEMPLATES } from '../src/studio.js';
import { chooserTemplateKeys } from '../src/studio-new-scene.js';
import { TEMPLATE_THUMBNAIL_URLS } from '../src/studio-template-thumbnails.js';
import {
  RECENT_COPY_CHARACTER_LIMIT,
  RECENT_SCENE_LIMIT,
  RECENT_INDEX_KEY,
  RecentScenePermissionNeeded,
  RecentSceneUnavailable,
  createRecentScenes,
} from '../src/studio-recent-scenes.js';
import { byDataset, byText, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

function memoryStorage() {
  const entries = new Map();
  return {
    entries,
    get length() { return entries.size; },
    key: position => [...entries.keys()][position] ?? null,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: key => entries.delete(key),
  };
}

function memoryHandleStore() {
  const handles = new Map();
  return {
    handles,
    put: async (id, handle) => { handles.set(id, handle); },
    get: async id => handles.get(id),
    delete: async id => { handles.delete(id); },
    clear: async () => handles.clear(),
  };
}

function recipeText(label = 'scene') {
  return JSON.stringify({ format: 'crucible.scene', schemaVersion: 1, label });
}

function sequentialIds() {
  let next = 0;
  return () => `id-${next += 1}`;
}

function fileHandle(name, { permission = 'granted', text = recipeText(name), fails = false, failure = null, dismissed = false } = {}) {
  return {
    name,
    isSameEntry: async other => other.name === name,
    queryPermission: async () => (dismissed ? 'prompt' : permission),
    requestPermission: async () => {
      if (dismissed) throw Object.assign(new Error('The request is not allowed by the user agent'), { name: 'NotAllowedError' });
      return permission;
    },
    getFile: async () => {
      if (failure) throw Object.assign(new Error('no such file'), { name: failure });
      if (fails) throw new Error('the file was moved');
      return { name, text: async () => text };
    },
  };
}

test('the recent list keeps the newest first, one entry per file, and at most eight', async () => {
  const recent = createRecentScenes({ storage: memoryStorage(), createId: sequentialIds() });
  for (let index = 1; index <= RECENT_SCENE_LIMIT + 3; index += 1) {
    assert.equal(await recent.remember({ name: `scene-${index}.json`, text: recipeText() }), 'remembered');
  }
  let names = (await recent.list()).map(entry => entry.name);
  assert.equal(names.length, RECENT_SCENE_LIMIT);
  assert.equal(names[0], 'scene-11.json');
  assert.equal(names.at(-1), 'scene-4.json');

  await recent.remember({ name: 'scene-5.json', text: recipeText('again') });
  names = (await recent.list()).map(entry => entry.name);
  assert.equal(names[0], 'scene-5.json');
  assert.equal(names.filter(name => name === 'scene-5.json').length, 1, 'a file is listed once');
  assert.equal(names.length, RECENT_SCENE_LIMIT);
});

test('the recent list survives a reload and drops the copies of entries that fell off the end', async () => {
  const storage = memoryStorage();
  const first = createRecentScenes({ storage, createId: sequentialIds() });
  for (let index = 1; index <= RECENT_SCENE_LIMIT + 1; index += 1) await first.remember({ name: `s${index}.json`, text: recipeText() });
  const reloaded = createRecentScenes({ storage });
  assert.deepEqual((await reloaded.list()).map(entry => entry.name)[0], `s${RECENT_SCENE_LIMIT + 1}.json`);
  const copyKeys = [...storage.entries.keys()].filter(key => key.startsWith('crucible.studio.recent.copy.'));
  assert.equal(copyKeys.length, RECENT_SCENE_LIMIT, 'the dropped entry left no copy behind');
  const opened = await reloaded.open((await reloaded.list())[0].id);
  assert.equal(opened.text, recipeText());
});

test('copies together never pass the character cap and the oldest go first', async () => {
  const storage = memoryStorage();
  const recent = createRecentScenes({ storage, createId: sequentialIds() });
  const big = 'x'.repeat(RECENT_COPY_CHARACTER_LIMIT * 0.4);
  await recent.remember({ name: 'a.json', text: big });
  await recent.remember({ name: 'b.json', text: big });
  await recent.remember({ name: 'c.json', text: big });
  assert.deepEqual((await recent.list()).map(entry => entry.name), ['c.json', 'b.json']);
  const stored = [...storage.entries].filter(([key]) => key.includes('.copy.')).reduce((sum, [, value]) => sum + value.length, 0);
  assert.ok(stored <= RECENT_COPY_CHARACTER_LIMIT);
  assert.equal(await recent.remember({ name: 'huge.json', text: 'y'.repeat(RECENT_COPY_CHARACTER_LIMIT + 1) }), 'too-large');
  assert.deepEqual((await recent.list()).map(entry => entry.name), ['c.json', 'b.json'], 'a scene over the cap is not listed');
});

test('a file handle is listed, deduplicated by file, and reopened through its permission', async () => {
  const handleStore = memoryHandleStore();
  const recent = createRecentScenes({ storage: memoryStorage(), handleStore, createId: sequentialIds() });
  await recent.remember({ name: 'a.json', handle: fileHandle('a.json') });
  await recent.remember({ name: 'b.json', handle: fileHandle('b.json') });
  await recent.remember({ name: 'a.json', handle: fileHandle('a.json') });
  const entries = await recent.list();
  assert.deepEqual(entries.map(entry => entry.name), ['a.json', 'b.json']);
  assert.equal(handleStore.handles.size, 2);
  const opened = await recent.open(entries[0].id);
  assert.equal(opened.fileName, 'a.json');
  assert.equal(opened.text, recipeText('a.json'));
});

test('an entry that can no longer be opened says so and is removed', async () => {
  const handleStore = memoryHandleStore();
  const storage = memoryStorage();
  const recent = createRecentScenes({ storage, handleStore, createId: sequentialIds() });
  await recent.remember({ name: 'moved.json', handle: fileHandle('moved.json', { fails: true }) });
  await recent.remember({ name: 'missing.json', handle: fileHandle('missing.json', { failure: 'NotFoundError' }) });
  await recent.remember({ name: 'copy.json', text: recipeText() });
  const [copyEntry, missingEntry, movedEntry] = await recent.list();
  await assert.rejects(recent.open(movedEntry.id), error => error instanceof RecentSceneUnavailable && /moved\.json can no longer be opened \(the file was moved\)/.test(error.message));
  await assert.rejects(recent.open(missingEntry.id), /missing\.json can no longer be opened \(no such file\)/);
  assert.deepEqual((await recent.list()).map(entry => entry.name), ['copy.json']);
  assert.equal(handleStore.handles.size, 0);
  storage.entries.delete(`crucible.studio.recent.copy.${copyEntry.id}`);
  await assert.rejects(recent.open(copyEntry.id), /the saved copy is gone/);
  assert.deepEqual(await recent.list(), []);
});

test('a refused or dismissed permission prompt keeps the entry and its handle and asks for permission', async () => {
  const handleStore = memoryHandleStore();
  const recent = createRecentScenes({ storage: memoryStorage(), handleStore, createId: sequentialIds() });
  await recent.remember({ name: 'denied.json', handle: fileHandle('denied.json', { permission: 'denied' }) });
  await recent.remember({ name: 'dismissed.json', handle: fileHandle('dismissed.json', { dismissed: true }) });
  await recent.remember({ name: 'blocked.json', handle: fileHandle('blocked.json', { failure: 'NotAllowedError' }) });
  for (const entry of await recent.list()) {
    await assert.rejects(recent.open(entry.id), error => error instanceof RecentScenePermissionNeeded && /^Permission is needed to open /.test(error.message), entry.name);
  }
  assert.deepEqual((await recent.list()).map(entry => entry.name), ['blocked.json', 'dismissed.json', 'denied.json']);
  assert.equal(handleStore.handles.size, 3);
});

test('a refused index write rolls the new copy or handle back and reports the refusal', async () => {
  const storage = memoryStorage();
  const handleStore = memoryHandleStore();
  const recent = createRecentScenes({ storage, handleStore, createId: sequentialIds() });
  assert.equal(await recent.remember({ name: 'kept.json', text: recipeText() }), 'remembered');
  const setItem = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === RECENT_INDEX_KEY) throw new Error('quota');
    return setItem(key, value);
  };
  assert.equal(await recent.remember({ name: 'copy.json', text: recipeText() }), 'storage-refused');
  assert.equal(await recent.remember({ name: 'handle.json', handle: fileHandle('handle.json') }), 'storage-refused');
  storage.setItem = setItem;
  assert.deepEqual((await recent.list()).map(entry => entry.name), ['kept.json']);
  assert.equal([...storage.entries.keys()].filter(key => key.includes('.copy.')).length, 1, 'no orphan copy');
  assert.equal(handleStore.handles.size, 0, 'no orphan handle');
});

test('copies the index does not name are swept when the list is read, so they cannot escape the cap', async () => {
  const storage = memoryStorage();
  const recent = createRecentScenes({ storage, createId: sequentialIds() });
  await recent.remember({ name: 'a.json', text: recipeText() });
  storage.setItem('crucible.studio.recent.copy.stray', 'x'.repeat(5000));
  assert.deepEqual((await recent.list()).map(entry => entry.name), ['a.json']);
  assert.equal(storage.getItem('crucible.studio.recent.copy.stray'), null);
  assert.equal(storage.entries.size, 2, 'the index and the one named copy remain');
});

test('clear empties the handle store entirely, not only the listed handles', async () => {
  const handleStore = memoryHandleStore();
  handleStore.handles.set('stray', fileHandle('stray.json'));
  const recent = createRecentScenes({ storage: memoryStorage(), handleStore, createId: sequentialIds() });
  await recent.remember({ name: 'listed.json', handle: fileHandle('listed.json') });
  await recent.clear();
  assert.equal(handleStore.handles.size, 0);
});

test('a handle entry and a copy entry of the same file name are one entry, the newer winning', async () => {
  const storage = memoryStorage();
  const handleStore = memoryHandleStore();
  const recent = createRecentScenes({ storage, handleStore, createId: sequentialIds() });
  await recent.remember({ name: 'trip.json', text: recipeText() });
  await recent.remember({ name: 'trip.json', handle: fileHandle('trip.json') });
  assert.deepEqual(await recent.list(), [{ id: 'id-2', name: 'trip.json', kind: 'handle' }]);
  assert.equal([...storage.entries.keys()].filter(key => key.includes('.copy.')).length, 0, 'the older copy is gone');
  await recent.remember({ name: 'trip.json', text: recipeText('saved') });
  assert.deepEqual((await recent.list()).map(entry => entry.kind), ['copy']);
  assert.equal(handleStore.handles.size, 0, 'the older handle is gone');
});

test('two tabs: the index is read again right before it is written and merged by recency', async () => {
  const storage = memoryStorage();
  const handleStore = memoryHandleStore();
  let releaseFirstPut;
  const firstPutWaits = new Promise(resolve => { releaseFirstPut = resolve; });
  const slowPut = handleStore.put;
  handleStore.put = async (id, handle) => {
    await firstPutWaits;
    return slowPut(id, handle);
  };
  const firstTab = createRecentScenes({ storage, handleStore, createId: () => 'from-first-tab' });
  const secondTab = createRecentScenes({ storage, createId: () => 'from-second-tab' });
  const firstRemember = firstTab.remember({ name: 'first.json', handle: fileHandle('first.json') });
  await secondTab.remember({ name: 'second.json', text: recipeText() });
  releaseFirstPut();
  await firstRemember;
  assert.deepEqual((await firstTab.list()).map(entry => entry.name), ['first.json', 'second.json']);
  assert.equal(storage.getItem('crucible.studio.recent.copy.from-second-tab'), recipeText(), "the other tab's copy was not swept");
});

test('clear forgets every entry and its stored copy or handle', async () => {
  const storage = memoryStorage();
  const handleStore = memoryHandleStore();
  const recent = createRecentScenes({ storage, handleStore, createId: sequentialIds() });
  await recent.remember({ name: 'a.json', text: recipeText() });
  await recent.remember({ name: 'b.json', handle: fileHandle('b.json') });
  await recent.clear();
  assert.deepEqual(await recent.list(), []);
  assert.equal([...storage.entries.keys()].filter(key => key.includes('.copy.')).length, 0);
  assert.equal(handleStore.handles.size, 0);
});

test('a host that supplies the recent list is used instead of local storage', async () => {
  const storage = memoryStorage();
  const calls = [];
  const host = {
    list: async () => [{ id: 7, name: 'host.scene.json' }],
    open: async id => ({ text: recipeText('host'), fileName: 'host.scene.json', filePath: `/projects/${id}.json` }),
    remember: async details => calls.push(details),
    remove: async id => calls.push(`remove ${id}`),
  };
  const recent = createRecentScenes({ storage, host });
  assert.deepEqual(await recent.list(), [{ id: '7', name: 'host.scene.json', kind: 'host' }]);
  await recent.remember({ name: 'x.json', text: 'ignored', filePath: '/x.json' });
  assert.deepEqual(calls, [{ name: 'x.json', filePath: '/x.json' }]);
  assert.equal((await recent.open('7')).filePath, '/projects/7.json');
  assert.equal(storage.entries.size, 0);
});

function makeRecipe() {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0.04 }],
    materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
    nodes: [{ id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] }],
    camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
    environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
  };
}

function mountNewSceneStudio(testContext, { sharedDom = null, ...options } = {}) {
  const dom = sharedDom ?? installStudioDom();
  const container = sharedDom ? dom.document.createElement('div') : dom.container;
  if (sharedDom) dom.document.body.append(container);
  const preferenceStorage = options.preferenceStorage ?? memoryStorage();
  const studio = createStudio(container, { recipe: makeRecipe(), renderer: createFakeRenderer(), preferenceStorage, ...options });
  testContext.after(() => {
    studio.dispose();
    if (!sharedDom) dom.uninstall();
  });
  const root = container.firstElementChild;
  const settle = async () => {
    for (let round = 0; round < 6; round += 1) await dom.settle();
  };
  return {
    dom,
    studio,
    root,
    settle,
    preferenceStorage,
    popover: root.querySelector('#crucible-studio-pop-new'),
    chooser: () => root.querySelector('.crucible-studio-new-dialog'),
    confirm: () => root.querySelector('.crucible-studio-confirm-dialog'),
    filePill: root.querySelector('.crucible-studio-filepill'),
    status: () => root.querySelector('.crucible-studio-status').textContent,
    card: key => byDataset(root, 'template', key),
  };
}

test('the File menu lists New scene, Open, Open recent, Save, Save as, Export, Recipe JSON and no template rows', testContext => {
  const ui = mountNewSceneStudio(testContext);
  const rows = ui.popover.querySelectorAll('button').map(button => button.textContent);
  assert.deepEqual(rows, ['New scene…', 'Open…', 'Open recent', 'Save', 'Save as…', 'Export PNG image', 'Export GLB model', 'Export web pack', 'Recipe JSON']);
  for (const spec of Object.values(STUDIO_TEMPLATES)) assert.ok(!rows.includes(spec.label), spec.label);
  const groupStarts = ui.popover.descendants().filter(item => item.dataset.groupStart === 'true').map(item => item.textContent);
  assert.deepEqual(groupStarts, ['Save', 'Export PNG image']);
  assert.equal(byText(ui.popover, 'New scene…').parentNode.dataset.shortcut ?? byText(ui.popover, 'New scene…').dataset?.shortcut, undefined, 'no key is claimed: the browser keeps Ctrl+N');
  assert.equal(byText(ui.popover, 'Open recent').parentNode.disabled, true, 'with no recent scene the row is disabled');
});

test('the chooser shows Blank first, then every ready scene, each with its picture', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  ui.studio.openNewScene();
  await ui.settle();
  const dialog = ui.chooser();
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('h2').textContent, 'New scene');
  const cards = dialog.querySelectorAll('.crucible-studio-new-card');
  assert.deepEqual(cards.map(card => card.dataset.template), chooserTemplateKeys());
  assert.equal(cards[0].textContent, 'Blank');
  assert.deepEqual(cards.map(card => card.textContent), ['Blank', 'Blockout', 'Gyro showcase', 'Product studio', 'Block courtyard']);
  for (const card of cards) {
    const picture = card.querySelector('img');
    assert.equal(picture.src, TEMPLATE_THUMBNAIL_URLS[card.dataset.template]);
    assert.match(picture.src, /studio-templates\/[a-z]+\.webp$/);
  }
  assert.equal(ui.root.ownerDocument.activeElement, cards[0], 'Blank has the focus');
});

test('choosing a card starts that scene in one step and closes the dialog', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  const opening = ui.studio.openNewScene();
  await ui.settle();
  ui.card('pedestal').click();
  await opening;
  assert.equal(ui.chooser().open, false);
  assert.equal(ui.filePill.textContent, 'pedestal.scene.json');
  assert.ok(ui.studio.exportRecipe().nodes.some(node => node.id === 'hero-sculpt'));
  assert.equal(ui.status(), 'New Product studio');
});

test('Blank is a ground plane and a light with no object on it', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  const opening = ui.studio.openNewScene();
  await ui.settle();
  ui.card('empty').click();
  await opening;
  assert.deepEqual(ui.studio.exportRecipe().nodes.map(node => node.id), ['stage-floor']);
  assert.equal(ui.status(), 'New Blank');
});

test('Escape and the close control cancel and leave the scene alone', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  let opening = ui.studio.openNewScene();
  await ui.settle();
  ui.chooser().close('');
  await opening;
  assert.equal(ui.filePill.textContent, 'untitled.scene.json');
  opening = ui.studio.openNewScene();
  await ui.settle();
  ui.chooser().querySelector('.crucible-studio-new-close').click();
  await opening;
  assert.equal(ui.chooser().open, false);
  assert.deepEqual(ui.studio.exportRecipe().nodes.map(node => node.id), ['hero']);
});

test('arrow keys, Home and End move between the cards and stop at the ends', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  ui.studio.openNewScene();
  await ui.settle();
  const cards = ui.chooser().querySelectorAll('.crucible-studio-new-card');
  const press = key => dispatch(ui.chooser().querySelector('.crucible-studio-new-cards'), 'keydown', { key });
  press('ArrowRight');
  assert.equal(ui.root.ownerDocument.activeElement, cards[1]);
  press('ArrowRight');
  press('ArrowLeft');
  assert.equal(ui.root.ownerDocument.activeElement, cards[1]);
  press('End');
  assert.equal(ui.root.ownerDocument.activeElement, cards.at(-1));
  press('ArrowRight');
  assert.equal(ui.root.ownerDocument.activeElement, cards.at(-1));
  press('Home');
  assert.equal(ui.root.ownerDocument.activeElement, cards[0]);
  press('ArrowUp');
  assert.equal(ui.root.ownerDocument.activeElement, cards[0]);
});

test('a plain key does not reach the scene behind an open chooser', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  ui.studio.selectNode('hero');
  ui.studio.openNewScene();
  await ui.settle();
  dispatch(ui.root.ownerDocument, 'keydown', { key: 'x' });
  assert.ok(ui.studio.exportRecipe().nodes.some(node => node.id === 'hero'));
});

function recentRow(ui) {
  return ui.popover.descendants().find(item => item.dataset.recentId !== undefined);
}

async function startUnsavedChoice(ui, templateKey = 'blockout') {
  ui.studio.controller.updateNodeTransform('hero', { translation: [2, 0.5, 0] });
  assert.equal(ui.studio.dirty, true);
  const opening = ui.studio.openNewScene();
  await ui.settle();
  ui.card(templateKey).click();
  await ui.settle();
  return { opening };
}

test('unsaved changes are asked about before a new scene replaces them: Cancel keeps the scene', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  const { opening } = await startUnsavedChoice(ui);
  assert.equal(ui.confirm().open, true);
  assert.match(ui.confirm().querySelector('.crucible-studio-confirm-message').textContent, /untitled\.scene\.json has changes that are not saved/);
  byText(ui.confirm(), 'Cancel').click();
  await opening;
  assert.equal(ui.studio.dirty, true);
  assert.equal(ui.filePill.textContent, 'untitled.scene.json');
  assert.deepEqual(ui.studio.exportRecipe().nodes.map(node => node.id), ['hero']);
});

test('Escape on the question counts as Cancel', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  const { opening } = await startUnsavedChoice(ui);
  ui.confirm().close('');
  await opening;
  assert.equal(ui.filePill.textContent, 'untitled.scene.json');
  assert.equal(ui.studio.dirty, true);
});

test('Discard replaces the scene, and the replacement is one undo step', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  const { opening } = await startUnsavedChoice(ui);
  byText(ui.confirm(), 'Discard').click();
  await opening;
  assert.equal(ui.filePill.textContent, 'blockout.scene.json');
  assert.equal(ui.studio.dirty, false);
  ui.studio.controller.undo();
  assert.deepEqual(ui.studio.exportRecipe().nodes.map(node => node.id), ['hero']);
});

test('Save writes the scene first, then starts the new one', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  const { opening } = await startUnsavedChoice(ui, 'courtyard');
  byText(ui.confirm(), 'Save').click();
  await opening;
  assert.equal(ui.dom.document.downloads.at(-1)?.filename, 'untitled.scene.json');
  assert.equal(ui.filePill.textContent, 'courtyard.scene.json');
});

test('a save the host cancels keeps the scene and starts nothing', async testContext => {
  const desktop = { saveFile: async () => ({ canceled: true }), saveFileAs: async () => ({ canceled: true }) };
  const ui = mountNewSceneStudio(testContext, { desktop });
  const { opening } = await startUnsavedChoice(ui);
  byText(ui.confirm(), 'Save').click();
  await opening;
  assert.equal(ui.studio.dirty, true);
  assert.equal(ui.filePill.textContent, 'untitled.scene.json');
});

test('a clean scene is replaced without a question', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  const opening = ui.studio.openNewScene();
  await ui.settle();
  ui.card('showcase').click();
  await opening;
  assert.equal(ui.confirm()?.open ?? false, false);
  assert.equal(ui.filePill.textContent, 'showcase.scene.json');
});

test('Open asks before replacing unsaved changes with a file', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  ui.studio.controller.updateNodeTransform('hero', { translation: [2, 0.5, 0] });
  const fileInput = ui.root.descendants().find(element => element.type === 'file');
  fileInput.files = [{ name: 'other.scene.json', text: async () => JSON.stringify({ ...makeRecipe(), nodes: [] }) }];
  dispatch(fileInput, 'change');
  await ui.settle();
  assert.equal(ui.confirm().open, true);
  byText(ui.confirm(), 'Cancel').click();
  await ui.settle();
  assert.equal(ui.filePill.textContent, 'untitled.scene.json');
});

test('a scene opened or saved shows in Open recent, survives a reload and reopens', async testContext => {
  const storage = memoryStorage();
  const sharedDom = installStudioDom();
  const first = mountNewSceneStudio(testContext, { preferenceStorage: storage, sharedDom });
  const fileInput = first.root.descendants().find(element => element.type === 'file');
  fileInput.files = [{ name: 'trip.scene.json', text: async () => JSON.stringify({ ...makeRecipe(), nodes: [] }) }];
  dispatch(fileInput, 'change');
  await first.settle();
  first.studio.dispose();

  const second = mountNewSceneStudio(testContext, { preferenceStorage: storage, sharedDom });
  testContext.after(() => sharedDom.uninstall());
  second.root.querySelector('.crucible-studio-menus').children[0].click();
  await second.settle();
  const toggle = byText(second.popover, 'Open recent').parentNode;
  assert.equal(toggle.disabled, false);
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(second.popover.popoverOpen, true, 'opening the list keeps the menu open');
  const rows = second.popover.querySelectorAll('.crucible-studio-recent-list button').map(row => row.textContent);
  assert.deepEqual(rows, ['trip.scene.json', 'Clear recent']);
  recentRow(second).click();
  await second.settle();
  assert.equal(second.filePill.textContent, 'trip.scene.json');
  assert.equal(second.status(), 'Opened trip.scene.json');
});

test('a recent scene that is gone says so and leaves the list', async testContext => {
  const storage = memoryStorage();
  const ui = mountNewSceneStudio(testContext, { preferenceStorage: storage });
  const recent = createRecentScenes({ storage, createId: () => 'gone' });
  await recent.remember({ name: 'gone.scene.json', text: recipeText() });
  storage.entries.delete('crucible.studio.recent.copy.gone');
  ui.root.querySelector('.crucible-studio-menus').children[0].click();
  await ui.settle();
  recentRow(ui).click();
  await ui.settle();
  assert.match(ui.status(), /gone\.scene\.json can no longer be opened/);
  assert.equal(byText(ui.popover, 'Open recent').parentNode.disabled, true);
});

test('Clear recent empties the list', async testContext => {
  const storage = memoryStorage();
  const ui = mountNewSceneStudio(testContext, { preferenceStorage: storage });
  await createRecentScenes({ storage }).remember({ name: 'a.scene.json', text: recipeText() });
  ui.root.querySelector('.crucible-studio-menus').children[0].click();
  await ui.settle();
  ui.popover.descendants().find(item => item.dataset.clearRecent === 'true').click();
  await ui.settle();
  assert.deepEqual(await createRecentScenes({ storage }).list(), []);
  assert.equal(byText(ui.popover, 'Open recent').parentNode.disabled, true);
});

test('a host that supplies recents is asked for them and opens them', async testContext => {
  const opened = [];
  const desktop = {
    recentScenes: {
      list: async () => [{ id: 'h1', name: 'host.scene.json' }],
      open: async id => {
        opened.push(id);
        return { text: JSON.stringify({ ...makeRecipe(), nodes: [] }), fileName: 'host.scene.json', filePath: 'C:/projects/host.scene.json' };
      },
    },
  };
  const ui = mountNewSceneStudio(testContext, { desktop });
  ui.root.querySelector('.crucible-studio-menus').children[0].click();
  await ui.settle();
  recentRow(ui).click();
  await ui.settle();
  assert.deepEqual(opened, ['h1']);
  assert.equal(ui.filePill.title, 'C:/projects/host.scene.json');
});

test('the unsaved question leads with a warning mark and orders Discard, Cancel and Save, Save being the one filled primary button', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  const { opening } = await startUnsavedChoice(ui);
  const buttons = ui.confirm().querySelectorAll('.crucible-studio-dialog-actions button');
  assert.deepEqual(buttons.map(button => button.textContent), ['Discard', 'Cancel', 'Save']);
  assert.match(buttons[2].className, /crucible-studio-setup-primary/, 'Save uses the primary class the setup dialog uses for Next and Done');
  assert.equal(buttons.filter(button => /primary/.test(button.className)).length, 1, 'one primary button');
  const heading = ui.confirm().querySelector('h2');
  assert.ok(heading.querySelector('.crucible-studio-icon'), 'a mark beside the title');
  assert.equal(heading.textContent, 'Unsaved changes');
  assert.equal(ui.dom.document.activeElement, buttons[2], 'focus starts on Save');
  byText(ui.confirm(), 'Cancel').click();
  await opening;
});

test('asking for a new scene twice while the chooser is open is one chooser and one answer', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  const first = ui.studio.openNewScene();
  const second = ui.studio.openNewScene();
  assert.equal(first, second);
  await ui.settle();
  ui.card('showcase').click();
  await first;
  assert.equal(ui.filePill.textContent, 'showcase.scene.json');
  assert.equal(ui.studio.controller.canUndo, true);
  ui.studio.controller.undo();
  assert.deepEqual(ui.studio.exportRecipe().nodes.map(node => node.id), ['hero'], 'one replacement, not two');
});

test('Apply on the recipe dialog replaces the scene without a question and marks it changed', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  assert.equal(ui.studio.dirty, false);
  const menuButton = ui.popover.querySelectorAll('button').find(button => button.textContent === 'Recipe JSON');
  menuButton.click();
  await ui.settle();
  ui.root.querySelector('textarea').value = JSON.stringify({ ...makeRecipe(), nodes: [] });
  ui.root.querySelectorAll('button').find(button => button.textContent === 'Apply JSON').click();
  await ui.settle();
  assert.equal(ui.status(), 'Recipe applied');
  assert.deepEqual(ui.studio.exportRecipe().nodes, []);
  assert.equal(ui.studio.dirty, true);
  assert.equal(ui.filePill.dataset.dirty, 'true');
});

test('a watched-file reload over unsaved edits keeps those edits one undo step away and says so', async testContext => {
  const ui = mountNewSceneStudio(testContext);
  ui.studio.controller.updateNodeTransform('hero', { translation: [2, 0.5, 0] });
  assert.equal(ui.studio.dirty, true);
  await ui.studio.loadExternalTextFile(JSON.stringify({ ...makeRecipe(), nodes: [] }), { filePath: 'C:/projects/watched.scene.json', fileName: 'watched.scene.json', agent: true });
  assert.equal(ui.studio.dirty, false);
  assert.deepEqual(ui.studio.exportRecipe().nodes, []);
  assert.match(ui.status(), /Replaced unsaved changes\. Undo brings them back/);
  ui.studio.controller.undo();
  assert.deepEqual(ui.studio.exportRecipe().nodes.find(node => node.id === 'hero').translation, [2, 0.5, 0]);
});
