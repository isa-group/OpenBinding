/** Set once a stale lazy chunk made the page reload itself, so a chunk that is really gone cannot loop. */
export const CHUNK_RELOAD_KEY = 'openbinding-chunk-reload';

/** A lazy screen whose file no longer exists on the server (a deploy replaced it while the tab was open). */
export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk [\w-]+ failed/i.test(text);
}

/** Whether this session has not reloaded yet for a chunk error; marks it when it has not. Storage may be blocked: then it never reloads. */
export function takeChunkReload(): boolean {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return false;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
    return true;
  } catch {
    return false;
  }
}
