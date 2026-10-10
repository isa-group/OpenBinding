import { describe, expect, it } from 'vitest';
import { formatByteSize } from './format';
import { describeLimit, formatDuration, formatPowerOfTen, limitInfo } from './limits';

describe('describeLimit', () => {
  it('rounds durations and keeps the exact seconds underneath', () => {
    expect(describeLimit('seconds', 900)).toEqual({ text: '15 min', exact: '900 s' });
    expect(describeLimit('seconds', 18_000)).toEqual({ text: '5 h', exact: '18,000 s' });
    expect(describeLimit('seconds', 30_000)).toEqual({ text: '8.3 h', exact: '30,000 s' });
    expect(describeLimit('seconds', 60)).toEqual({ text: '1 min', exact: '60 s' });
    // Nothing to add when the figure is already exact.
    expect(describeLimit('seconds', 45)).toEqual({ text: '45 s' });
  });

  it('writes sizes in binary units with the exact bytes underneath', () => {
    expect(describeLimit('bytes', 8_388_608)).toEqual({ text: '8 MiB', exact: '8,388,608 bytes' });
    expect(describeLimit('bytes', 104_857_600)).toEqual({ text: '100 MiB', exact: '104,857,600 bytes' });
    expect(describeLimit('bytes', 5_368_709_120)).toEqual({ text: '5 GiB', exact: '5,368,709,120 bytes' });
    expect(formatByteSize(512)).toBe('512 bytes');
  });

  it('writes the size of a binding space as a power of ten', () => {
    expect(describeLimit('log10', 9)).toEqual({ text: '10⁹', exact: 'log10 9' });
    expect(formatPowerOfTen(15)).toBe('10¹⁵');
    expect(formatPowerOfTen(20)).toBe('10²⁰');
  });

  it('counts days and plain amounts', () => {
    expect(describeLimit('days', 7)).toEqual({ text: '7 days' });
    expect(describeLimit('days', 1)).toEqual({ text: '1 day' });
    expect(describeLimit('count', 100_000)).toEqual({ text: '100,000' });
    expect(describeLimit('capacity', 1_000_000)).toEqual({ text: '1,000,000' });
  });

  it('reads both ways an unlimited allowance arrives, and says when it is not known', () => {
    expect(describeLimit('count', null)).toEqual({ text: 'Unlimited' });
    expect(describeLimit('seconds', Number.POSITIVE_INFINITY)).toEqual({ text: 'Unlimited' });
    expect(describeLimit('count', undefined)).toEqual({ text: '—' });
  });

  it('shortens a duration', () => {
    expect(formatDuration(7_200)).toBe('2 h');
  });
});

describe('limitInfo', () => {
  it('knows the limits of the OpenBinding pricing', () => {
    expect(limitInfo('taskStarts')).toMatchObject({ label: 'Solves', group: 'monthly', kind: 'count' });
    expect(limitInfo('apiKeys')).toMatchObject({ label: 'API keys', group: 'capacity' });
    expect(limitInfo('maxPayloadBytes')).toMatchObject({ label: 'Max package size', group: 'ceiling', kind: 'bytes' });
    expect(limitInfo('storageBytes')).toMatchObject({ label: 'Storage', group: 'sponsored', kind: 'bytes' });
  });

  it('places a limit it has never seen by its type and unit, so a new one needs no code', () => {
    expect(limitInfo('reportExports', { type: 'RENEWABLE', unit: 'export/month' })).toEqual({
      label: 'Report exports', short: 'report exports', group: 'monthly', kind: 'count',
    });
    expect(limitInfo('gpuSeconds', { type: 'RENEWABLE', unit: 'second/month' })).toMatchObject({ group: 'monthly', kind: 'seconds' });
    expect(limitInfo('seats', { type: 'NON_RENEWABLE', trackable: true, unit: 'seat' })).toMatchObject({ group: 'capacity' });
    expect(limitInfo('maxRows', { type: 'NON_RENEWABLE', trackable: false, unit: 'row' })).toMatchObject({ group: 'ceiling' });
    expect(limitInfo('mystery')).toMatchObject({ group: 'ceiling', kind: 'count' });
  });
});
