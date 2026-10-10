const DB_NAME = 'bim-v1-workspace';
const STORE = 'drafts';
const FALLBACK_KEY = 'bim-v1-draft:';

export type WorkspaceFiles = Record<string, string>;

function parseDraft(value: unknown): WorkspaceFiles | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!Object.values(parsed).every((entry) => typeof entry === 'string')) return null;
    return parsed as WorkspaceFiles;
  } catch {
    return null;
  }
}

function fallback(scope: string): WorkspaceFiles | null {
  try { return parseDraft(localStorage.getItem(FALLBACK_KEY + scope)); } catch { return null; }
}

export async function loadDraft(scope = 'anonymous:playground'): Promise<WorkspaceFiles | null> {
  if (typeof indexedDB === 'undefined') return fallback(scope);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => resolve(fallback(scope));
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(STORE, 'readonly');
      const get = transaction.objectStore(STORE).get(scope);
      get.onsuccess = () => resolve(parseDraft(get.result) || fallback(scope));
      get.onerror = () => resolve(fallback(scope));
      transaction.oncomplete = transaction.onabort = () => db.close();
    };
  });
}

/** Drafts made without a session belong to nobody in particular; every other scope starts with the id of the person who made it. */
const ANONYMOUS_SCOPE = 'anonymous:';

/**
 * Forget the workbench drafts of signed-in people (the localStorage copy and the IndexedDB one), so that whoever uses this
 * browser next does not find another person's package. Called when a session is closed on purpose.
 */
export async function clearUserDrafts(): Promise<void> {
  try {
    const keys = Array.from({ length: localStorage.length }, (_unused, index) => localStorage.key(index));
    for (const key of keys) {
      if (key?.startsWith(FALLBACK_KEY) && !key.startsWith(FALLBACK_KEY + ANONYMOUS_SCOPE)) localStorage.removeItem(key);
    }
  } catch { /* No localStorage: nothing was kept there. */ }
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => resolve();
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result) {
          if (typeof key === 'string' && !key.startsWith(ANONYMOUS_SCOPE)) store.delete(key);
        }
      };
      transaction.oncomplete = transaction.onabort = transaction.onerror = () => { db.close(); resolve(); };
    };
  });
}

export async function saveDraft(files: WorkspaceFiles, scope = 'anonymous:playground'): Promise<void> {
  const source = JSON.stringify(files);
  let fallbackSaved = false;
  try { localStorage.setItem(FALLBACK_KEY + scope, source); fallbackSaved = true; } catch { /* IndexedDB can still persist the draft. */ }
  if (typeof indexedDB === 'undefined') {
    if (!fallbackSaved) throw new Error('Browser storage could not save this draft. Export the package to keep your changes.');
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const fail = () => fallbackSaved ? resolve() : reject(new Error('Browser storage could not save this draft. Export the package to keep your changes.'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = fail;
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(source, scope);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = transaction.onerror = () => { db.close(); fail(); };
    };
  });
}
