const DB_NAME = 'bim-v1-workspace';
const STORE = 'drafts';
const KEY = 'current';
const FALLBACK_KEY = 'bim-v1-draft';

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

export async function loadDraft(): Promise<WorkspaceFiles | null> {
  if (typeof indexedDB === 'undefined') return parseDraft(localStorage.getItem(FALLBACK_KEY));
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => resolve(parseDraft(localStorage.getItem(FALLBACK_KEY)));
    request.onsuccess = () => {
      const transaction = request.result.transaction(STORE, 'readonly');
      const get = transaction.objectStore(STORE).get(KEY);
      get.onsuccess = () => resolve(parseDraft(get.result));
      get.onerror = () => resolve(null);
    };
  });
}

export async function saveDraft(files: WorkspaceFiles): Promise<void> {
  const source = JSON.stringify(files);
  localStorage.setItem(FALLBACK_KEY, source);
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => resolve();
    request.onsuccess = () => {
      const transaction = request.result.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(source, KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    };
  });
}
