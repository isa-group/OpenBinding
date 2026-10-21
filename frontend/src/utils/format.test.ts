import { describe, expect, it } from 'vitest';
import { formatByteSize, formatBytes, formatMonthDay, formatNumber } from './format';

describe('numbers and sizes', () => {
  it('writes numbers in English, whatever the browser language is', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(0.123456)).toBe('0.12');
    expect(formatNumber(0.123456, 5)).toBe('0.12346');
  });

  it('abbreviates sizes in binary units with one decimal at most', () => {
    expect(formatByteSize(512)).toBe('512 bytes');
    expect(formatByteSize(1536)).toBe('1.5 KiB');
    expect(formatByteSize(8 * 1024 ** 2)).toBe('8 MiB');
    expect(formatByteSize(5 * 1024 ** 3)).toBe('5 GiB');
  });

  it('adds the exact bytes to a size from one KiB up, and leaves anything that is not a size out', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1536)).toBe('1.5 KiB (1,536 bytes)');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5 MiB (5,242,880 bytes)');
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('dates', () => {
  it('writes a month and day in English and in UTC', () => {
    expect(formatMonthDay('2026-11-01T00:00:00Z')).toBe('Nov 1');
    expect(formatMonthDay('2026-10-31T23:30:00-05:00')).toBe('Nov 1');
    expect(formatMonthDay('not a date')).toBeNull();
    expect(formatMonthDay(null)).toBeNull();
  });
});
