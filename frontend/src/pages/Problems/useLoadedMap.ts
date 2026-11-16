import { useEffect, useEffectEvent, useRef, useState } from 'react';

export interface Loaded<T> {
  status: 'loading' | 'ready' | 'error';
  value?: T;
  error?: unknown;
}

/**
 * Load one value per key, once each, as the keys appear. The answer for a key arrives in a promise callback, so nothing is
 * set synchronously from the effect. A key that was asked for is never asked again.
 */
export function useLoadedMap<T>(keys: readonly string[], load: (key: string) => Promise<T>): Record<string, Loaded<T>> {
  const [loaded, setLoaded] = useState<Record<string, Loaded<T>>>({});
  const asked = useRef(new Set<string>());
  const run = useEffectEvent(load);
  const signature = [...new Set(keys)].sort().join('\n');

  useEffect(() => {
    for (const key of signature ? signature.split('\n') : []) {
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      run(key).then(
        (value) => setLoaded((current) => ({ ...current, [key]: { status: 'ready', value } })),
        (error: unknown) => setLoaded((current) => ({ ...current, [key]: { status: 'error', error } })),
      );
    }
  }, [signature]);

  return loaded;
}
