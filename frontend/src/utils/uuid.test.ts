import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUUID', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the browser’s own generator where it exists', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-2222-4333-8444-555555555555' });
    expect(randomUUID()).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('builds a version-4 UUID from getRandomValues in a context without randomUUID (plain http)', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes.fill(255); return bytes; });
    vi.stubGlobal('crypto', { getRandomValues });
    const made = randomUUID();
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(made).toMatch(V4);
    expect(made).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it('still makes distinct v4 identifiers when there is no Web Crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    const first = randomUUID();
    const second = randomUUID();
    expect(first).toMatch(V4);
    expect(second).toMatch(V4);
    expect(first).not.toBe(second);
  });

  it('gives distinct identifiers with the real generator', () => {
    expect(randomUUID()).toMatch(V4);
    expect(randomUUID()).not.toBe(randomUUID());
  });
});
