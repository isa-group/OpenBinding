import { describe, expect, it } from 'vitest';
import { decisionReceipt, shortId } from './archive';
import { clipPolygon } from './constraints';

describe('decision evidence presentation', () => {
  it('uses the hash, rather than the digest prefix, to identify alternatives', () => {
    expect(shortId('sha256-1234567890abcdef')).toBe('1234567890');
    expect(shortId('sha256:abcdef1234567890')).toBe('abcdef1234');
  });
  it('rejects editable reports that would be unsafe to reopen or render', () => {
    const snapshot = { kind: 'binding-decision', revision: 'revision', scope: 'stored only', query: { sources: ['job'] }, selected: [] };
    expect(decisionReceipt(snapshot)).not.toBeNull();
    for (const invalid of [null, {}, { ...snapshot, selected: [null] }, { ...snapshot, query: { sources: 'job' } },
      { ...snapshot, query: { sources: ['job'], requirements: [{ dimension: 'cost', value: 'invalid', space: 'raw' }] } }]) {
      expect(decisionReceipt(invalid)).toBeNull();
    }
  });
  it('clips only the displayed polygon to an authoritative half-plane', () => {
    expect(clipPolygon([[0, 0], [1, 0], [1, 1], [0, 1]], { a: 1, b: 0, c: .5 })).toEqual([[0, 0], [.5, 0], [.5, 1], [0, 1]]);
  });
});
