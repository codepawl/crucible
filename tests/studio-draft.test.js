import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearStudioDraft,
  decideBeforeUnload,
  draftDiffersFrom,
  loadStudioDraft,
  MAXIMUM_DRAFT_CHARACTERS,
  saveStudioDraft,
  STUDIO_DRAFT_KEY,
} from '../src/studio-draft.js';

function memoryStorage() {
  const entries = new Map();
  return {
    entries,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
    removeItem: key => entries.delete(key),
  };
}

const smallRecipe = { format: 'crucible.scene', nodes: [{ id: 'a' }] };

test('a saved draft loads back with its file name and clears', () => {
  const storage = memoryStorage();
  assert.equal(saveStudioDraft(storage, smallRecipe, 'room.scene.json'), 'saved');
  assert.deepEqual(loadStudioDraft(storage), { fileName: 'room.scene.json', recipe: smallRecipe });
  clearStudioDraft(storage);
  assert.equal(loadStudioDraft(storage), null);
});

test('a recipe above the size limit is not kept and drops the older draft', () => {
  const storage = memoryStorage();
  saveStudioDraft(storage, smallRecipe, 'a.scene.json');
  const hugeRecipe = { nodes: [{ id: 'x'.repeat(MAXIMUM_DRAFT_CHARACTERS) }] };
  assert.equal(saveStudioDraft(storage, hugeRecipe, 'a.scene.json'), 'too-large');
  assert.equal(storage.entries.has(STUDIO_DRAFT_KEY), false, 'a stale draft would restore a state the person left');
});

test('blocked storage and damaged entries give no draft and never throw', () => {
  assert.equal(saveStudioDraft(null, smallRecipe, 'a'), 'unavailable');
  const refusing = { setItem() { throw new Error('quota'); }, getItem() { throw new Error('blocked'); } };
  assert.equal(saveStudioDraft(refusing, smallRecipe, 'a'), 'unavailable');
  assert.equal(loadStudioDraft(refusing), null);
  clearStudioDraft(refusing);

  for (const damaged of ['{not json', '"text"', '{"recipe":{"nodes":"no"}}', '{"fileName":"a"}']) {
    const storage = memoryStorage();
    storage.entries.set(STUDIO_DRAFT_KEY, damaged);
    assert.equal(loadStudioDraft(storage), null, damaged);
    assert.equal(storage.entries.has(STUDIO_DRAFT_KEY), false, 'a damaged entry is dropped');
  }
});

test('a draft differs from the opened scene only when the recipes differ', () => {
  const draft = { fileName: '', recipe: smallRecipe };
  assert.equal(draftDiffersFrom(draft, { ...smallRecipe }), false);
  assert.equal(draftDiffersFrom(draft, { ...smallRecipe, nodes: [] }), true);
});

test('leaving the page writes the waiting draft and asks to stay only in a browser with unsaved changes', () => {
  assert.deepEqual(
    decideBeforeUnload({ isDirty: true, hasDesktopShell: false }),
    { flushDraft: true, askToStay: true },
  );
  assert.deepEqual(
    decideBeforeUnload({ isDirty: false, hasDesktopShell: false }),
    { flushDraft: true, askToStay: false },
    'a saved scene leaves without a prompt',
  );
  assert.deepEqual(
    decideBeforeUnload({ isDirty: true, hasDesktopShell: true }),
    { flushDraft: true, askToStay: false },
    'a desktop host owns window close, so the unload is never cancelled',
  );
});
