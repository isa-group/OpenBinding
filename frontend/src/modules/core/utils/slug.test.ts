import { describe, expect, it } from 'vitest';
import { SLUG_PATTERN, slugFromName } from './slug';

describe('the address of a new item', () => {
  it('derives a slug from a name and accepts only what the gateway accepts', () => {
    expect(slugFromName('QoS Benchmarks 2026')).toMatch(SLUG_PATTERN);
    expect(SLUG_PATTERN.test('qos-benchmarks')).toBe(true);
    expect(SLUG_PATTERN.test('-qos')).toBe(false);
  });
});
