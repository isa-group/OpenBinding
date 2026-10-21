import { useCallback, useEffect, useEffectEvent, useState } from 'react';

export interface Resource<T> {
  status: 'loading' | 'ready' | 'error';
  /** The value for the current key; `undefined` while loading or after an error. */
  data: T | undefined;
  /** The last value that arrived, for any key: lets a screen keep what it shows while the next page loads. */
  stale: T | undefined;
  error: unknown;
  /** Ask again for the same key. */
  reload: () => void;
}

interface Settled<T> {
  key: string;
  value?: T;
  error?: unknown;
  failed: boolean;
  previous?: T;
}

/**
 * Load something asynchronously for `key`. The state answers "which key does this belong to?",
 * so a change of key reads as loading without any state being set from inside the effect.
 */
export function useResource<T>(key: string, load: () => Promise<T>): Resource<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [nonce, setNonce] = useState(0);
  const fullKey = `${key}#${nonce}`;
  const run = useEffectEvent(load);

  useEffect(() => {
    let cancelled = false;
    run().then(
      (value) => {
        if (!cancelled) setSettled((current) => ({ key: fullKey, value, failed: false, previous: current?.value ?? current?.previous }));
      },
      (error: unknown) => {
        if (!cancelled) setSettled((current) => ({ key: fullKey, error, failed: true, previous: current?.value ?? current?.previous }));
      },
    );
    return () => { cancelled = true; };
  }, [fullKey]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const current = settled?.key === fullKey ? settled : null;
  return {
    status: !current ? 'loading' : current.failed ? 'error' : 'ready',
    data: current && !current.failed ? current.value : undefined,
    stale: current && !current.failed ? current.value : settled?.value ?? settled?.previous,
    error: current?.error,
    reload,
  };
}
