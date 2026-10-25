import { describe, expect, it } from 'vitest';
import { shortId } from './archive';
import { clipPolygon } from './constraints';

describe('decision evidence presentation', () => {
  it('uses the hash, rather than the digest prefix, to identify alternatives', () => {
    expect(shortId('sha256-1234567890abcdef')).toBe('1234567890');
    expect(shortId('sha256:abcdef1234567890')).toBe('abcdef1234');
  });
  it('clips only the displayed polygon to an authoritative half-plane', () => {
    expect(clipPolygon([[0, 0], [1, 0], [1, 1], [0, 1]], { a: 1, b: 0, c: .5 })).toEqual([[0, 0], [.5, 0], [.5, 1], [0, 1]]);
  });
});
