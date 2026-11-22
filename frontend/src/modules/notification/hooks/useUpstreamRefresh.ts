// A count that grows each time an upstream event (F6) about a composition arrives on the live notification stream: a page
// adds it to the key of what it reads, so its badges and lists are read again. Outside the notifications provider (a test,
// a page without a session) it stays at zero.

import { useContext, useEffect, useState } from 'react';
import { NotificationsContext } from '../contexts/notificationsContext';

/**
 * How many `UpstreamEvent` notifications arrived for the composition `org/composition` (any composition of `org` without
 * one; any composition at all without either) since the page mounted.
 */
export function useUpstreamRefresh(org?: string, composition?: string): number {
  const context = useContext(NotificationsContext);
  const subscribe = context?.subscribe;
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!subscribe) return undefined;
    return subscribe('UpstreamEvent', notification => {
      const payload = notification.payload ?? {};
      if (org && payload.organization !== org) return;
      if (composition && payload.composition !== composition) return;
      setCount(value => value + 1);
    });
  }, [subscribe, org, composition]);
  return count;
}
