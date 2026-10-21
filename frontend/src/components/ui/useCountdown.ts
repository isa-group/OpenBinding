import { useCallback, useEffect, useState } from 'react';

/**
 * Seconds left until a retry is worth making (a 429's Retry-After). Counts down once per second and
 * stops at zero; `restart` starts over from the same length.
 */
export function useCountdown(seconds: number): { left: number; done: boolean; restart: () => void } {
  const total = Math.max(0, Math.ceil(seconds));
  const [run, setRun] = useState({ id: 0, left: total });

  useEffect(() => {
    if (run.left <= 0) return undefined;
    const timer = window.setTimeout(() => setRun((current) => ({ ...current, left: current.left - 1 })), 1000);
    return () => window.clearTimeout(timer);
  }, [run]);

  const restart = useCallback(() => setRun((current) => ({ id: current.id + 1, left: total })), [total]);
  return { left: run.left, done: run.left <= 0, restart };
}
