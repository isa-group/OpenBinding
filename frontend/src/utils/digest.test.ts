import { describe, expect, it } from 'vitest';
import { digestPrefix, isDigest, normalizeDigest, shortDigest } from './digest';

const HEX = 'e5f60718'.repeat(8);

describe('digests', () => {
  it('spells a digest the way the resolver does', () => {
    expect(normalizeDigest(`  SHA256-${HEX.toUpperCase()}  `)).toBe(`sha256-${HEX}`);
    expect(normalizeDigest(`sha256:${HEX}`)).toBe(`sha256-${HEX}`);
    expect(normalizeDigest(HEX)).toBe(`sha256-${HEX}`);
  });

  it('leaves what it cannot read alone, for isDigest to refuse', () => {
    expect(normalizeDigest('Not A Digest')).toBe('not a digest');
    expect(isDigest(normalizeDigest('Not A Digest'))).toBe(false);
    expect(isDigest(`sha256-${HEX}`)).toBe(true);
    expect(isDigest(`sha256-${HEX.slice(1)}`)).toBe(false);
    expect(isDigest(`sha256-${HEX}0`)).toBe(false);
    expect(isDigest(`sha1-${HEX}`)).toBe(false);
    expect(isDigest(`sha256-${'g'.repeat(64)}`)).toBe(false);
  });

  it('abbreviates only what is long enough to abbreviate', () => {
    expect(shortDigest(`sha256-${HEX}`)).toBe('sha256-e5f6…0718');
    expect(shortDigest('sha256-abc')).toBe('sha256-abc');
    expect(shortDigest(HEX)).toBe('sha256-e5f6…0718');
  });

  it('keeps the prefix and twelve characters where an ellipsis would not do', () => {
    expect(digestPrefix(`sha256-${HEX}`)).toBe('sha256-e5f60718e5f6');
    expect(digestPrefix(`sha256-${HEX}`, 4)).toBe('sha256-e5f6');
    expect(digestPrefix('sha256-abc')).toBe('sha256-abc');
  });
});
