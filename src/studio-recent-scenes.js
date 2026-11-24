// The scenes Studio reopens from File > Open recent. A page cannot reopen a path, so each entry is kept the way the browser
// allows, and the entry says which: a file handle (where the File System Access API gave one, kept in IndexedDB and asked
// for permission again when needed), or a bounded copy of the recipe text (everywhere else). A host that owns the file
// system (a desktop shell) supplies its own list through `host`, and nothing is kept here.
//
// `host` is { list(): Promise<[{ id, name }]>, open(id): Promise<{ text, fileName, filePath? }>, remember?({ name, filePath }),
// remove?(id), clear?() }.

export const RECENT_SCENE_LIMIT = 8;
// The copies of all entries together stay under this many characters of recipe text, so the recent list never fills the
// few megabytes a page may store. One scene over the cap is not remembered; it is opened, not listed.
export const RECENT_COPY_CHARACTER_LIMIT = 1_000_000;
export const RECENT_INDEX_KEY = 'crucible.studio.recent';
const COPY_KEY_PREFIX = 'crucible.studio.recent.copy.';
const HANDLE_DATABASE_NAME = 'crucible-studio';
const HANDLE_STORE_NAME = 'recent-handles';

/** Thrown when an entry cannot be opened any more. The entry is already removed when this reaches the caller. */
export class RecentSceneUnavailable extends Error {
  constructor(name, reason) {
    super(`${name} can no longer be opened (${reason}), so it was removed from the recent list.`);
    this.name = 'RecentSceneUnavailable';
  }
}

/** Thrown when the browser did not give read access (the prompt was refused or dismissed). The entry stays in the list. */
export class RecentScenePermissionNeeded extends Error {
  constructor(name) {
    super(`Permission is needed to open ${name}. Choose it again and allow access.`);
    this.name = 'RecentScenePermissionNeeded';
  }
}

// A handle that throws one of these is not gone: the person, or the page, did not allow the read this time.
const PERMISSION_ERROR_NAMES = new Set(['NotAllowedError', 'SecurityError', 'AbortError']);

function readIndex(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(RECENT_INDEX_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(entry => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && (entry.kind === 'handle' || entry.kind === 'copy'))
      .slice(0, RECENT_SCENE_LIMIT);
  } catch {
    return [];
  }
}

function writeIndex(storage, entries) {
  try {
    storage?.setItem(RECENT_INDEX_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

function removeQuietly(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {
    // A copy that cannot be removed is unreachable once the index stops naming it.
  }
}

function copyLength(storage, entry) {
  try {
    return storage?.getItem(COPY_KEY_PREFIX + entry.id)?.length ?? 0;
  } catch {
    return 0;
  }
}

function storedCopyKeys(storage) {
  const keys = [];
  try {
    for (let position = 0; position < (storage?.length ?? 0); position += 1) {
      const key = storage.key(position);
      if (key?.startsWith(COPY_KEY_PREFIX)) keys.push(key);
    }
  } catch {
    // A storage that cannot be listed has nothing to sweep.
  }
  return keys;
}

// A copy the index does not name was left by a refused write or another tab's removal; it would sit outside the cap for good.
function sweepOrphanCopies(storage, entries) {
  const named = new Set(entries.map(entry => COPY_KEY_PREFIX + entry.id));
  for (const key of storedCopyKeys(storage)) {
    if (!named.has(key)) removeQuietly(storage, key);
  }
}

/** The handles live in IndexedDB because a handle cannot be written as text. Returns null where IndexedDB is missing. */
export function createIndexedDbHandleStore(indexedDatabaseFactory = globalThis.indexedDB) {
  if (!indexedDatabaseFactory) return null;
  const openDatabase = () => new Promise((resolve, reject) => {
    const request = indexedDatabaseFactory.open(HANDLE_DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(HANDLE_STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (mode, action) => {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(HANDLE_STORE_NAME, mode);
        const request = action(transaction.objectStore(HANDLE_STORE_NAME));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  };
  return {
    put: (id, handle) => run('readwrite', store => store.put(handle, id)),
    get: id => run('readonly', store => store.get(id)),
    delete: id => run('readwrite', store => store.delete(id)),
    clear: () => run('readwrite', store => store.clear()),
  };
}

/**
 * The recent list. `storage` is the page's key-value storage (the one Studio keeps its preferences in), `handleStore` is
 * { put, get, delete, clear } over file handles or null, and `host` replaces both when a shell supplies the list.
 */
export function createRecentScenes({ storage, handleStore = null, host = null, createId = () => globalThis.crypto.randomUUID() } = {}) {
  async function dropEntry(entry) {
    removeQuietly(storage, COPY_KEY_PREFIX + entry.id);
    if (entry.kind === 'handle') await handleStore?.delete(entry.id).catch(() => {});
  }

  async function sameFile(entry, handle) {
    if (entry.kind !== 'handle' || !handleStore) return entry.name === handle.name;
    try {
      const stored = await handleStore.get(entry.id);
      if (stored && typeof stored.isSameEntry === 'function') return await stored.isSameEntry(handle);
    } catch {
      // Fall through to the name.
    }
    return entry.name === handle.name;
  }

  // A handle entry and a copy entry of one file name are one entry: the file was opened one way and saved the other.
  async function findDuplicates(entries, { name, handle }) {
    const duplicates = [];
    for (const entry of entries) {
      const isDuplicate = handle && entry.kind === 'handle' ? await sameFile(entry, handle) : entry.name === name;
      if (isDuplicate) duplicates.push(entry);
    }
    return duplicates;
  }

  // Oldest copies go first until the copies together fit; a handle costs no storage, so it is never dropped for size.
  function fitCopies(entries) {
    const kept = [...entries];
    let total = kept.reduce((sum, entry) => sum + copyLength(storage, entry), 0);
    for (let index = kept.length - 1; index >= 0 && total > RECENT_COPY_CHARACTER_LIMIT; index -= 1) {
      if (kept[index].kind !== 'copy') continue;
      total -= copyLength(storage, kept[index]);
      kept.splice(index, 1);
    }
    return kept;
  }

  async function readHandleEntry(entry) {
    const handle = await handleStore?.get(entry.id);
    if (!handle) throw new Error('the browser forgot the file');
    let granted = false;
    try {
      granted = (await handle.queryPermission?.({ mode: 'read' })) === 'granted'
        || (await handle.requestPermission?.({ mode: 'read' })) === 'granted';
    } catch (error) {
      if (!PERMISSION_ERROR_NAMES.has(error?.name)) throw error;
    }
    if (!granted) throw new RecentScenePermissionNeeded(entry.name);
    try {
      const file = await handle.getFile();
      return { text: await file.text(), fileName: file.name, handle };
    } catch (error) {
      if (PERMISSION_ERROR_NAMES.has(error?.name)) throw new RecentScenePermissionNeeded(entry.name);
      throw error;
    }
  }

  const local = {
    async list() {
      const entries = readIndex(storage);
      sweepOrphanCopies(storage, entries);
      return entries.map(({ id, name, kind }) => ({ id, name, kind }));
    },

    /** Puts a scene first. Give `handle` (a file handle) or `text` (the recipe JSON). Returns 'remembered' or the reason it was not. */
    async remember({ name, handle = null, text = null }) {
      if (handle && !handleStore) return 'no-handle-store';
      if (!handle && (typeof text !== 'string' || text.length > RECENT_COPY_CHARACTER_LIMIT)) return 'too-large';
      const duplicates = await findDuplicates(readIndex(storage), { name, handle });
      const entry = { id: createId(), name, kind: handle ? 'handle' : 'copy' };
      try {
        if (handle) await handleStore.put(entry.id, handle);
        else storage.setItem(COPY_KEY_PREFIX + entry.id, text);
      } catch {
        await dropEntry(entry);
        return 'storage-refused';
      }
      // From here nothing waits: the index is read again right before it is written, so another tab's entries are merged by
      // recency (this one first) instead of being overwritten by a list read before the handle was stored.
      const latest = readIndex(storage);
      const duplicateIds = new Set(duplicates.map(duplicate => duplicate.id));
      const others = latest.filter(item => !duplicateIds.has(item.id) && item.name !== name);
      const kept = fitCopies([entry, ...others].slice(0, RECENT_SCENE_LIMIT));
      if (!writeIndex(storage, kept)) {
        await dropEntry(entry);
        return 'storage-refused';
      }
      const keptIds = new Set(kept.map(item => item.id));
      for (const dropped of latest.filter(item => !keptIds.has(item.id))) await dropEntry(dropped);
      return 'remembered';
    },

    /** Resolves to { text, fileName, handle? }. An entry whose file is gone is removed and the error names it; a refused permission keeps it. */
    async open(id) {
      const entry = readIndex(storage).find(item => item.id === id);
      if (!entry) throw new RecentSceneUnavailable('This scene', 'it is not in the list');
      try {
        if (entry.kind === 'handle') return await readHandleEntry(entry);
        const text = storage.getItem(COPY_KEY_PREFIX + entry.id);
        if (typeof text !== 'string') throw new Error('the saved copy is gone');
        return { text, fileName: entry.name };
      } catch (error) {
        if (error instanceof RecentScenePermissionNeeded) throw error;
        await local.remove(id);
        throw new RecentSceneUnavailable(entry.name, error.message);
      }
    },

    async remove(id) {
      const index = readIndex(storage);
      writeIndex(storage, index.filter(item => item.id !== id));
      const entry = index.find(item => item.id === id);
      if (entry) await dropEntry(entry);
    },

    async clear() {
      const entries = readIndex(storage);
      writeIndex(storage, []);
      for (const entry of entries) await dropEntry(entry);
      sweepOrphanCopies(storage, []);
      await handleStore?.clear().catch(() => {});
    },
  };

  if (!host) return local;
  return {
    async list() {
      return (await host.list()).slice(0, RECENT_SCENE_LIMIT).map(({ id, name }) => ({ id: String(id), name, kind: 'host' }));
    },
    async remember({ name, filePath = null }) {
      await host.remember?.({ name, filePath });
      return 'remembered';
    },
    async open(id) {
      const name = (await host.list()).find(item => String(item.id) === id)?.name ?? 'This scene';
      try {
        const opened = await host.open(id);
        return { text: opened.text, fileName: opened.fileName ?? name, filePath: opened.filePath ?? null };
      } catch (error) {
        await host.remove?.(id);
        throw new RecentSceneUnavailable(name, error.message);
      }
    },
    remove: id => host.remove?.(id),
    clear: () => host.clear?.(),
  };
}