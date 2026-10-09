import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRICING_TOKEN_UPDATED_EVENT } from '../api/client';
import { pricingTokenStatus, usePricingTokenStatus } from './pricingToken';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

/** A token shaped like the gateway's: three dot-separated parts, the middle one a base64 JSON payload. */
function token(claims: Record<string, unknown>): string {
  return ['header', btoa(JSON.stringify(claims)), 'signature'].join('.');
}

describe('pricingTokenStatus', () => {
  it('is missing when there is no token', () => {
    expect(pricingTokenStatus(null, NOW)).toBe('missing');
    expect(pricingTokenStatus(undefined, NOW)).toBe('missing');
    expect(pricingTokenStatus('', NOW)).toBe('missing');
  });

  it('is valid until it expires, and stale after', () => {
    expect(pricingTokenStatus(token({ exp: NOW / 1000 + 3600 }), NOW)).toBe('valid');
    expect(pricingTokenStatus(token({ exp: NOW / 1000 - 1 }), NOW)).toBe('stale');
  });

  it('treats a token without an expiry as valid, and one that cannot be read as stale', () => {
    expect(pricingTokenStatus(token({ sub: 'someone' }), NOW)).toBe('valid');
    expect(pricingTokenStatus('not-a-token', NOW)).toBe('stale');
    expect(pricingTokenStatus('a.%%%.c', NOW)).toBe('stale');
    expect(pricingTokenStatus(['a', btoa('"just a string"'), 'c'].join('.'), NOW)).toBe('stale');
  });
});

describe('usePricingTokenStatus', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('follows the stored token, and never returns the token itself', () => {
    const { result } = renderHook(() => usePricingTokenStatus());
    expect(result.current).toBe('missing');

    const fresh = token({ exp: Date.now() / 1000 + 3600 });
    act(() => {
      localStorage.setItem('pricingToken', fresh);
      window.dispatchEvent(new CustomEvent(PRICING_TOKEN_UPDATED_EVENT, { detail: fresh }));
    });
    expect(result.current).toBe('valid');
    expect(JSON.stringify(result.current)).not.toContain(fresh);
  });

  it('turns stale by itself when the token expires', () => {
    vi.useFakeTimers({ now: NOW });
    localStorage.setItem('pricingToken', token({ exp: NOW / 1000 + 60 }));
    const { result } = renderHook(() => usePricingTokenStatus());
    expect(result.current).toBe('valid');

    act(() => { vi.advanceTimersByTime(61_000); });
    expect(result.current).toBe('stale');
  });
});
