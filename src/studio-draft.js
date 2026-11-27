import { leadWithActionIcon, STUDIO_ACTION_ICONS } from './studio-icons.js';

// Studio keeps the scene being edited in the browser's storage, so a closed tab or a crash does not lose it. On the next
// start the person chooses between the draft and the scene that opened. The draft is one entry: the latest unsaved state.

export const STUDIO_DRAFT_KEY = 'crucible.studio.draft';

// A draft above this many characters is not kept: storage holds a few megabytes per site and a huge write blocks the page.
export const MAXIMUM_DRAFT_CHARACTERS = 2_000_000;

export const DRAFT_SAVE_DELAY_MILLISECONDS = 800;

function removeDraftEntry(storage) {
  try {
    storage?.removeItem?.(STUDIO_DRAFT_KEY);
  } catch {
    // Storage that refuses a removal has nothing more to give.
  }
}

/** Forgets the draft. */
export function clearStudioDraft(storage) {
  removeDraftEntry(storage);
}

/**
 * Keeps `recipe` as the draft and returns what happened: 'saved', 'too-large' (the recipe is over the limit, and the older
 * draft is dropped because it would restore a state the person has left) or 'unavailable' (storage refused the write).
 */
export function saveStudioDraft(storage, recipe, fileName, workspaceState = null) {
  if (!storage) {
    return 'unavailable';
  }
  const payload = { fileName, recipe };
  if (typeof workspaceState?.workspace === 'string' && workspaceState.workspace.length > 0) {
    payload.workspace = workspaceState.workspace;
  }
  if (typeof workspaceState?.activeTab === 'string' && workspaceState.activeTab.length > 0) {
    payload.activeTab = workspaceState.activeTab;
  }
  const text = JSON.stringify(payload);
  if (text.length > MAXIMUM_DRAFT_CHARACTERS) {
    removeDraftEntry(storage);
    return 'too-large';
  }
  try {
    storage.setItem(STUDIO_DRAFT_KEY, text);
    return 'saved';
  } catch {
    return 'unavailable';
  }
}

/** The saved draft as `{ fileName, recipe, workspace?, activeTab? }`, or null when there is none or the entry is damaged (which also drops it). */
export function loadStudioDraft(storage) {
  let saved = null;
  try {
    saved = storage?.getItem(STUDIO_DRAFT_KEY) ?? null;
  } catch {
    return null;
  }
  if (saved === null) {
    return null;
  }
  try {
    const draft = JSON.parse(saved);
    if (draft && typeof draft === 'object' && draft.recipe && typeof draft.recipe === 'object' && Array.isArray(draft.recipe.nodes)) {
      const result = { fileName: typeof draft.fileName === 'string' ? draft.fileName : '', recipe: draft.recipe };
      if (typeof draft.workspace === 'string' && draft.workspace.length > 0) {
        result.workspace = draft.workspace;
      }
      if (typeof draft.activeTab === 'string' && draft.activeTab.length > 0) {
        result.activeTab = draft.activeTab;
      }
      return result;
    }
  } catch {
    // A damaged entry falls through to be dropped.
  }
  removeDraftEntry(storage);
  return null;
}

/** Whether a draft is worth offering: it describes a scene other than the one that opened. */
export function draftDiffersFrom(draft, openedRecipe) {
  return JSON.stringify(draft.recipe) !== JSON.stringify(openedRecipe);
}

/**
 * The notice that offers the draft. It sits on the same surface as the paused picture notice, leads with an icon, is
 * announced politely and has two plain buttons.
 */
export function createDraftNotice({ documentReference, createIcon, onRestore, onDiscard }) {
  const message = documentReference.createElement('p');
  const restoreButton = documentReference.createElement('button');
  restoreButton.type = 'button';
  restoreButton.textContent = 'Restore';
  leadWithActionIcon(restoreButton, createIcon(STUDIO_ACTION_ICONS.restoreDraft), STUDIO_ACTION_ICONS.restoreDraft);
  restoreButton.addEventListener('click', onRestore);
  const discardButton = documentReference.createElement('button');
  discardButton.type = 'button';
  discardButton.textContent = 'Discard';
  leadWithActionIcon(discardButton, createIcon(STUDIO_ACTION_ICONS.discardDraft), STUDIO_ACTION_ICONS.discardDraft);
  discardButton.addEventListener('click', onDiscard);

  const element = documentReference.createElement('div');
  element.className = 'crucible-studio-island crucible-studio-draft';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.hidden = true;
  element.append(createIcon('undo'), message, restoreButton, discardButton);

  return {
    element,
    show(fileName) {
      message.textContent = fileName ? `Unsaved changes to ${fileName} were found.` : 'Unsaved changes were found.';
      element.hidden = false;
    },
    hide() {
      element.hidden = true;
    },
    get visible() {
      return !element.hidden;
    },
  };
}

/**
 * What the page does when it is about to go: the draft is always written, and the browser is asked to confirm only when
 * unsaved changes would be lost. A desktop host owns window close and already hears about unsaved changes, so there the
 * unload is never cancelled.
 */
export function decideBeforeUnload({ isDirty, hasDesktopShell }) {
  return { flushDraft: true, askToStay: Boolean(isDirty) && !hasDesktopShell };
}
