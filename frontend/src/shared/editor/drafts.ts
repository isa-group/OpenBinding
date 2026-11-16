/**
 * Drafts the editors keep in this browser: the files of an unsaved edit, by scope.
 *
 * They live in IndexedDB only. Where IndexedDB is unavailable, drafts are not kept at all: `draftsAvailable()` says so, saves do
 * nothing, loads give nothing, and the editors tell the person. There is no second copy anywhere else.
 */

/** The files of a draft, by path: one `composition.yaml`, or the files of a package. */
export type DraftFiles = Record<string, string>;

/** What an editor edits: a composition or a problem. */
export type DraftKind = 'composition' | 'problem';

const DB_NAME = 'openbinding-drafts';
const STORE = 'drafts';

/**
 * Where a draft is kept: per person, per editor, per organization, per thing edited and per version it started from. The person
 * comes first, so `clearUserDrafts` can forget everything one person kept.
 */
export function draftScope({ user, kind, org, entity, base }: {
  user: string | null | undefined; kind: DraftKind; org: string; entity: string; base: string;
}): string {
  return `${user || 'anonymous'}:${kind}:${org}:${entity}:${base}`;
}

/** Whether this browser can keep drafts. */
export function draftsAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function readDraft(value: unknown): DraftFiles | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Object.values(value).every((entry) => typeof entry === 'string')) return null;
  return { ...(value as DraftFiles) };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error ?? new Error('The drafts of this browser could not be opened.'));
    request.onblocked = () => reject(new Error('The drafts of this browser are blocked by another tab.'));
    request.onsuccess = () => resolve(request.result);
  });
}

/** Run one transaction on the store, and settle when it has committed (or failed). */
async function transact<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest | void, read?: (result: unknown) => T): Promise<T | undefined> {
  const db = await open();
  return new Promise<T | undefined>((resolve, reject) => {
    let value: T | undefined;
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(STORE, mode);
    } catch (reason: unknown) {
      db.close();
      reject(reason);
      return;
    }
    const request = work(transaction.objectStore(STORE));
    if (request && read) request.onsuccess = () => { value = read(request.result); };
    transaction.oncomplete = () => { db.close(); resolve(value); };
    transaction.onabort = transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error('The drafts of this browser could not be changed.'));
    };
  });
}

const NOT_SAVED = 'This draft could not be kept in the browser. Export or save it to keep your changes.';

/** Keep the files of a scope. Nothing happens where drafts cannot be kept; a failure to write rejects. */
export async function saveDraft(scope: string, files: DraftFiles): Promise<void> {
  if (!draftsAvailable()) return;
  try {
    await transact('readwrite', (store) => store.put({ ...files }, scope));
  } catch {
    throw new Error(NOT_SAVED);
  }
}

/** The files kept for a scope, or `null` when there are none (or drafts cannot be kept or read). */
export async function loadDraft(scope: string): Promise<DraftFiles | null> {
  if (!draftsAvailable()) return null;
  try {
    return (await transact('readonly', (store) => store.get(scope), readDraft)) ?? null;
  } catch {
    return null;
  }
}

/** Forget the draft of a scope. */
export async function clearDraft(scope: string): Promise<void> {
  if (!draftsAvailable()) return;
  try {
    await transact('readwrite', (store) => store.delete(scope));
  } catch { /* Nothing kept can be forgotten. */ }
}

/**
 * Forget every draft one person kept in this browser, so that whoever uses it next does not find their work. Called when they close
 * their session on purpose.
 */
export async function clearUserDrafts(userId: string): Promise<void> {
  if (!draftsAvailable() || !userId) return;
  const prefix = `${userId}:`;
  try {
    await transact('readwrite', (store) => {
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result) {
          if (typeof key === 'string' && key.startsWith(prefix)) store.delete(key);
        }
      };
    });
  } catch { /* Nothing kept can be forgotten. */ }
}
