// A count that grows each time an upstream event (F6) about a composition arrives on the live notification stream: a page
// adds it to the key of what it reads, so its badges and lists are read again. Outside the notifications provider (a test,
// a page without a session) it stays at zero.

import { useContext, useEffect, useState } from 'react';
import { NotificationsContext } from '../contexts/notificationsContext';

/** One upstream change notifies once per composition it touches: a burst within this window reads the page once more. */
export const UPSTREAM_REFRESH_WINDOW_MS = 1000;

/**
 * Grows when `UpstreamEvent` notifications arrive for the composition `org/composition` (any composition of `org` without
 * one; any composition at all without either): at once for the first, then at most once per window for the rest of a burst.
 */
export function useUpstreamRefresh(org?: string, composition?: string): number {
  const context = useContext(NotificationsContext);
  const subscribe = context?.subscribe;
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!subscribe) return undefined;
    let timer: number | undefined;
    let pending = false;
    const bump = () => setCount(value => value + 1);
    const tick = () => {
      if (pending) {
        pending = false;
        bump();
        timer = window.setTimeout(tick, UPSTREAM_REFRESH_WINDOW_MS);
      } else timer = undefined;
    };
    const stop = subscribe('UpstreamEvent', notification => {
      const payload = notification.payload ?? {};
      if (org && payload.organization !== org) return;
      if (composition && payload.composition !== composition) return;
      if (timer !== undefined) {
        pending = true;
        return;
      }
      bump();
      timer = window.setTimeout(tick, UPSTREAM_REFRESH_WINDOW_MS);
    });
    return () => {
      stop();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [subscribe, org, composition]);
  return count;
}
