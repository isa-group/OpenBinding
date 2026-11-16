import { describe, expect, it } from 'vitest';
import { pickVersion } from './versionRef';

// Newest first, as the versions route lists them by default.
const versions = [
  {
    id: '0B5E7A10-0000-4000-8000-000000000003',
    label: '2.0.0',
    ordinal: 3,
    values_status: 'verified',
  },
  {
    id: '0b5e7a10-0000-4000-8000-000000000002',
    label: '1.1.0',
    ordinal: 2,
    values_status: 'declared',
  },
  {
    id: '0b5e7a10-0000-4000-8000-000000000001',
    label: '1.0.0',
    ordinal: 1,
    values_status: 'declared',
  },
];

describe('pickVersion', () => {
  it('names a version by ordinal when the request is all digits', () => {
    expect(pickVersion(versions, '2')).toBe(versions[1]);
    expect(pickVersion(versions, '1')).toBe(versions[2]);
  });

  it('names a version by id in any letter case, then by its exact label', () => {
    expect(pickVersion(versions, '0b5e7a10-0000-4000-8000-000000000003')).toBe(versions[0]);
    expect(pickVersion(versions, '1.1.0')).toBe(versions[1]);
  });

  it('gives the version itself, not a copy', () => {
    const picked = pickVersion(versions, '1.0.0');
    expect(picked).toBe(versions[2]);
    expect(picked).not.toHaveProperty('version');
  });

  it('falls back to the first listed version, without saying why, for a hidden or unknown version', () => {
    expect(pickVersion(versions, '9')).toBe(versions[0]);
    expect(pickVersion(versions, '3.0.0')).toBe(versions[0]);
    expect(pickVersion(versions, null)).toBe(versions[0]);
    expect(pickVersion([], '1')).toBeNull();
  });
});
