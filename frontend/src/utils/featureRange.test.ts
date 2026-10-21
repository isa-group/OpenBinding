import { describe, expect, it } from 'vitest';
import {
  compareFeatures, compareOptionalFeatures, featureMidpoint, featureSortKey, formatFeature, hasRange, isFeatureSlot, isFeatureValue, isRange,
  parseFiniteNumber, parseRangeInput, rangeInputOf, toRange, toScalar, validateFeature,
} from './featureRange';

describe('isRange', () => {
  it('accepts exactly min and max, each a finite number or null', () => {
    expect(isRange({ min: 1, max: 2 })).toBe(true);
    expect(isRange({ min: null, max: 2 })).toBe(true);
    expect(isRange({ min: 1, max: null })).toBe(true);
    expect(isRange({ min: null, max: null })).toBe(true);
  });

  it('refuses extra, missing, misspelled and non-numeric ends', () => {
    expect(isRange({ min: 1 })).toBe(false);
    expect(isRange({ min: 1, max: 2, mid: 1 })).toBe(false);
    expect(isRange({ mni: 1, max: 2 })).toBe(false);
    expect(isRange({ min: '1', max: 2 })).toBe(false);
    expect(isRange({ min: Infinity, max: 2 })).toBe(false);
    expect(isRange({ min: NaN, max: 2 })).toBe(false);
    expect(isRange(5)).toBe(false);
    expect(isRange(null)).toBe(false);
    expect(isRange([1, 2])).toBe(false);
  });
});

describe('validateFeature', () => {
  it('accepts numbers and well-ordered ranges, open or not', () => {
    for (const value of [0, -3, 120, { min: 1, max: 1 }, { min: 1, max: 2 }, { min: null, max: 5 }, { min: 5, max: null }, { min: null, max: null }]) {
      expect(validateFeature(value)).toBeNull();
      expect(isFeatureValue(value)).toBe(true);
    }
  });

  it('orders only when both ends are finite', () => {
    expect(validateFeature({ min: 5, max: 2 })).toBe('Min can’t be greater than max.');
    expect(validateFeature({ min: 5, max: null })).toBeNull();
    expect(validateFeature({ min: null, max: -100 })).toBeNull();
  });

  it('explains what is wrong', () => {
    expect(validateFeature(null)).toMatch(/can’t be empty/);
    expect(validateFeature(undefined)).toMatch(/can’t be empty/);
    expect(validateFeature(Infinity)).toBe('The value must be a finite number.');
    expect(validateFeature(NaN)).toBe('The value must be a finite number.');
    expect(validateFeature('3')).toMatch(/number or a range/);
    expect(validateFeature({ min: 1 })).toMatch(/needs a max/);
    expect(validateFeature({ max: 1 })).toMatch(/needs a min/);
    expect(validateFeature({})).toMatch(/needs a min/);
    expect(validateFeature({ min: 1, max: 2, mid: 3 })).toMatch(/only a min and a max/);
    expect(validateFeature({ min: 'a', max: 2 })).toMatch(/Min must be a finite number/);
    expect(validateFeature({ min: 1, max: Infinity })).toMatch(/Max must be a finite number/);
  });
});

describe('isFeatureSlot', () => {
  it('lets a range that misses an end be edited, but nothing else', () => {
    expect(isFeatureSlot(3)).toBe(true);
    expect(isFeatureSlot({})).toBe(true);
    expect(isFeatureSlot({ min: 1 })).toBe(true);
    expect(isFeatureSlot({ min: null, max: 1 })).toBe(true);
    expect(isFeatureSlot(null)).toBe(false);
    expect(isFeatureSlot('3')).toBe(false);
    expect(isFeatureSlot({ min: 1, other: 2 })).toBe(false);
    expect(isFeatureSlot({ min: '1', max: 2 })).toBe(false);
  });
});

describe('parseFiniteNumber', () => {
  it('reads only complete numbers', () => {
    expect(parseFiniteNumber('0.5')).toBe(0.5);
    expect(parseFiniteNumber(' -3 ')).toBe(-3);
    expect(parseFiniteNumber('1e-4')).toBe(0.0001);
    expect(parseFiniteNumber('.5')).toBe(0.5);
    for (const text of ['', '-', '1e', 'abc', 'Infinity', 'NaN', '1e999', '1,5']) expect(parseFiniteNumber(text)).toBeUndefined();
  });
});

describe('parseRangeInput', () => {
  const input = (over: Partial<Parameters<typeof parseRangeInput>[0]> = {}) => ({ min: '', max: '', minOpen: false, maxOpen: false, ...over });

  it('reads a closed range', () => {
    expect(parseRangeInput(input({ min: '120', max: '180' }))).toEqual({ value: { min: 120, max: 180 }, errors: {} });
  });

  it('reads null for an end with no limit, whatever is typed in it', () => {
    expect(parseRangeInput(input({ min: 'junk', minOpen: true, max: '200' })).value).toEqual({ min: null, max: 200 });
    expect(parseRangeInput(input({ min: '100', maxOpen: true })).value).toEqual({ min: 100, max: null });
    expect(parseRangeInput(input({ minOpen: true, maxOpen: true }))).toEqual({ value: { min: null, max: null }, errors: {} });
  });

  it('leaves an unreadable end out and says why', () => {
    const blank = parseRangeInput(input({ min: '1' }));
    expect(blank.value).toEqual({ min: 1 });
    expect(blank.errors.max).toMatch(/No upper limit/);
    const junk = parseRangeInput(input({ min: 'abc', max: '1' }));
    expect(junk.value).toEqual({ max: 1 });
    expect(junk.errors.min).toBe('Min must be a finite number.');
  });

  it('flags min above max when both are finite, and only then', () => {
    expect(parseRangeInput(input({ min: '9', max: '3' })).errors.range).toBe('Min can’t be greater than max.');
    expect(parseRangeInput(input({ min: '9', maxOpen: true })).errors).toEqual({});
    expect(parseRangeInput(input({ minOpen: true, max: '-9' })).errors).toEqual({});
  });
});

describe('rangeInputOf', () => {
  it('fills the fields from what the document holds', () => {
    expect(rangeInputOf(undefined)).toEqual({ min: '', max: '', minOpen: false, maxOpen: false });
    expect(rangeInputOf(120)).toEqual({ min: '120', max: '120', minOpen: false, maxOpen: false });
    expect(rangeInputOf({ min: null, max: 200 })).toEqual({ min: '', max: '200', minOpen: true, maxOpen: false });
    expect(rangeInputOf({ min: 100 })).toEqual({ min: '100', max: '', minOpen: false, maxOpen: false });
  });
});

describe('formatFeature', () => {
  it('writes a number, a range and the open forms', () => {
    expect(formatFeature(120)).toBe('120');
    expect(formatFeature(0.021)).toBe('0.021');
    expect(formatFeature({ min: 120, max: 180 })).toBe('120–180');
    expect(formatFeature({ min: null, max: 200 })).toBe('≤ 200');
    expect(formatFeature({ min: 100, max: null })).toBe('≥ 100');
    expect(formatFeature({ min: null, max: null })).toBe('unbounded');
  });

  it('keeps a point range distinct from a number', () => {
    expect(formatFeature({ min: 5, max: 5 })).toBe('5–5');
  });

  it('adds the unit and can be compact', () => {
    expect(formatFeature(120, { unit: 'ms' })).toBe('120 ms');
    expect(formatFeature({ min: 1, max: 2 }, { unit: 'EUR' })).toBe('1–2 EUR');
    expect(formatFeature({ min: null, max: 200 }, { compact: true })).toBe('≤200');
    expect(formatFeature({ min: 100, max: null }, { compact: true, unit: 'ms' })).toBe('≥100 ms');
  });

  it('uses interval notation with the infinity symbol in the long form', () => {
    expect(formatFeature({ min: null, max: 200 }, { long: true })).toBe('(−∞, 200]');
    expect(formatFeature({ min: 100, max: null }, { long: true })).toBe('[100, +∞)');
    expect(formatFeature({ min: null, max: null }, { long: true })).toBe('(−∞, +∞)');
    expect(formatFeature({ min: 120, max: 180 }, { long: true, unit: 'ms' })).toBe('[120, 180] ms');
  });

  it('never prints NaN or undefined', () => {
    expect(formatFeature(undefined)).toBe('—');
    expect(formatFeature(null)).toBe('—');
    expect(formatFeature(NaN)).toBe('—');
    expect(formatFeature({ min: 1 })).toBe('incomplete');
    expect(formatFeature({})).toBe('incomplete');
  });
});

describe('ordering', () => {
  it('sorts by middle, with open ranges after the numbers and unbounded last', () => {
    const values = [
      { min: null, max: null }, { min: 100, max: null }, 300, { min: null, max: 50 }, { min: 10, max: 30 }, 5, { min: 150, max: null },
    ];
    expect([...values].sort(compareFeatures)).toEqual([5, { min: 10, max: 30 }, 300, { min: null, max: 50 }, { min: 100, max: null }, { min: 150, max: null }, { min: null, max: null }]);
  });

  it('has a key that is never NaN', () => {
    for (const value of [1, { min: 1, max: 3 }, { min: null, max: 3 }, { min: 1, max: null }, { min: null, max: null }, {}, { min: 1 }, undefined, null]) {
      expect(Number.isNaN(featureSortKey(value as never))).toBe(false);
    }
    expect(featureSortKey({ min: 2, max: 4 })).toBe(3);
    expect(featureSortKey({ min: null, max: 4 })).toBe(Infinity);
  });

  it('is a total order: a before b exactly when b is after a', () => {
    const values = [1, { min: 1, max: 1 }, { min: 0, max: 2 }, { min: null, max: 1 }, { min: 1, max: null }, { min: null, max: null }, 2];
    for (const a of values) for (const b of values) {
      expect(Math.sign(compareFeatures(a, b))).toBe(-Math.sign(compareFeatures(b, a)) || 0);
    }
  });

  it('puts missing values last', () => {
    expect(compareOptionalFeatures(undefined, 3)).toBe(1);
    expect(compareOptionalFeatures(3, undefined)).toBe(-1);
    expect(compareOptionalFeatures(undefined, undefined)).toBe(0);
    expect(compareOptionalFeatures(1, 2)).toBeLessThan(0);
  });

  it('gives the middle only for a closed range or a number', () => {
    expect(featureMidpoint(4)).toBe(4);
    expect(featureMidpoint({ min: 2, max: 6 })).toBe(4);
    expect(featureMidpoint({ min: null, max: 6 })).toBeNull();
  });
});

describe('converting a cell between a single value and a range', () => {
  it('turns a number into a point range', () => {
    expect(toRange(120)).toEqual({ min: 120, max: 120 });
    expect(toRange({ min: null, max: 3 })).toEqual({ min: null, max: 3 });
  });

  it('turns a point range back into a number without asking', () => {
    expect(toScalar({ min: 7, max: 7 })).toEqual({ value: 7, lossy: false, dropped: null });
    expect(toScalar(7)).toEqual({ value: 7, lossy: false, dropped: null });
  });

  it('asks when something would be lost, and keeps the finite min (else the finite max)', () => {
    expect(toScalar({ min: 120, max: 180 })).toEqual({ value: 120, lossy: true, dropped: 'the upper limit (180)' });
    expect(toScalar({ min: 100, max: null })).toEqual({ value: 100, lossy: true, dropped: 'the upper limit (no limit)' });
    expect(toScalar({ min: null, max: 200 })).toEqual({ value: 200, lossy: true, dropped: 'the lower limit (no limit)' });
  });

  it('leaves the cell empty when there is no finite end', () => {
    expect(toScalar({ min: null, max: null })).toEqual({ value: null, lossy: true, dropped: 'both limits' });
    expect(toScalar({})).toMatchObject({ value: null, lossy: false });
  });

  it('round-trips a number through a range', () => {
    expect(toScalar(toRange(42) as { min: number; max: number }).value).toBe(42);
  });
});

describe('hasRange', () => {
  it('finds a range among the features of a candidate', () => {
    expect(hasRange({ a: 1, b: 2 })).toBe(false);
    expect(hasRange({ a: 1, b: { min: null, max: 2 } })).toBe(true);
    expect(hasRange(undefined)).toBe(false);
    expect(hasRange({})).toBe(false);
  });
});
