import { useEffect } from 'react';

/** How often the page of a run that has not finished asks about it again. The gateway offers no stream for studies. */
export const POLL_MS = 3000;

/** Asks again every `ms` while `active`, so a run that is moving keeps showing where it is. */
export function usePolling(active: boolean, tick: () => void, ms: number = POLL_MS) {
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(tick, ms);
    return () => window.clearInterval(timer);
  }, [active, tick, ms]);
}
