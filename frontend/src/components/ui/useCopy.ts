import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyStatus = 'idle' | 'copied' | 'failed';

/**
 * Copy text to the clipboard and say so for a moment. `status(key)` is per key, so one screen can show
 * several copy buttons and only the one that was pressed reports. A clipboard that refuses reports `failed`
 * rather than pretending.
 */
export function useCopy(resetAfterMs = 2000) {
  const [last, setLast] = useState<{ key: string; ok: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string, key = 'default') => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      /* no clipboard permission, or an insecure context */
    }
    setLast({ key, ok });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLast(null), resetAfterMs);
    return ok;
  }, [resetAfterMs]);

  const status = useCallback((key = 'default'): CopyStatus => {
    if (last?.key !== key) return 'idle';
    return last.ok ? 'copied' : 'failed';
  }, [last]);

  return { copy, status };
}
