import { useSyncExternalStore } from 'react';
import { getStoredPricingToken, PRICING_TOKEN_UPDATED_EVENT } from '../api/client';

/**
 * Whether the browser holds a pricing token it can still trust. The token is internal: this module reads it
 * to answer that one question and never hands it, or any part of it, to a screen.
 *
 * - `missing`: there is none (the gateway could not mint one, or the contract is still pending).
 * - `stale`: there is one, but it has expired or is not a token at all, so features cannot be confirmed from it.
 * - `valid`: there is one and it has not expired.
 */
export type PricingTokenStatus = 'missing' | 'stale' | 'valid';

function expiryOf(token: string): number | null | 'unreadable' {
  const payload = token.split('.')[1];
  if (!payload) return 'unreadable';
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const claims: unknown = JSON.parse(atob(padded));
    if (typeof claims !== 'object' || claims === null) return 'unreadable';
    const exp = (claims as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return 'unreadable';
  }
}

/** The status of a token at `now` (ms). A token without an expiry claim does not expire. */
export function pricingTokenStatus(token: string | null | undefined, now: number): PricingTokenStatus {
  if (!token) return 'missing';
  const expiry = expiryOf(token);
  if (expiry === 'unreadable') return 'stale';
  if (expiry === null) return 'valid';
  return expiry > now ? 'valid' : 'stale';
}

/** Milliseconds until the stored token expires, or `null` when it never does or there is none. */
function untilExpiry(token: string | null, now: number): number | null {
  if (!token) return null;
  const expiry = expiryOf(token);
  return typeof expiry === 'number' && expiry > now ? expiry - now : null;
}

function snapshot(): PricingTokenStatus {
  return pricingTokenStatus(getStoredPricingToken(), Date.now());
}

/** Tells the subscriber when a new token arrives, another tab changes it, or the current one expires. */
function subscribe(notify: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    const wait = untilExpiry(getStoredPricingToken(), Date.now());
    // A timer cannot wait longer than ~24.8 days; a later expiry is re-checked when this one fires.
    if (wait !== null) timer = setTimeout(changed, Math.min(wait + 50, 2_000_000_000));
  };
  function changed() {
    notify();
    arm();
  }
  window.addEventListener(PRICING_TOKEN_UPDATED_EVENT, changed);
  window.addEventListener('storage', changed);
  arm();
  return () => {
    clearTimeout(timer);
    window.removeEventListener(PRICING_TOKEN_UPDATED_EVENT, changed);
    window.removeEventListener('storage', changed);
  };
}

/** The status of the stored token, kept current as the token changes or expires. */
export function usePricingTokenStatus(): PricingTokenStatus {
  return useSyncExternalStore(subscribe, snapshot, () => 'missing');
}
