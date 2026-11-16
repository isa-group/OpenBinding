import { describe, expect, it } from 'vitest';

import { pickRequestedVersion } from './requested-version';

// Callers pass versions as `{...version, version: version.label}`.
const versions = [
  { id: 'c0ffee02', version: '1.1.0' },
  { id: 'C0FFEE01', version: '1.0.0' },
  { id: 'c0ffee00', version: 'c0ffee02' },
];

describe('pickRequestedVersion', () => {
  it('matches an id in any letter case', () => {
    expect(pickRequestedVersion(versions, 'c0ffee01')).toBe(versions[1]);
    expect(pickRequestedVersion(versions, 'C0FFEE02')).toBe(versions[0]);
  });

  it('matches a label exactly, after the ids', () => {
    expect(pickRequestedVersion(versions, '1.0.0')).toBe(versions[1]);
    // An id wins over a label that reads the same.
    expect(pickRequestedVersion(versions, 'c0ffee02')).toBe(versions[0]);
    // Labels are not matched loosely.
    expect(pickRequestedVersion(versions, '1.0')).toBe(versions[0]);
    expect(pickRequestedVersion([{ id: 'a1', version: 'Beta' }, { id: 'a2', version: 'beta' }], 'beta')?.id).toBe('a2');
  });

  it('falls back to the first version when none is requested or none matches', () => {
    expect(pickRequestedVersion(versions, null)).toBe(versions[0]);
    expect(pickRequestedVersion(versions, '')).toBe(versions[0]);
    expect(pickRequestedVersion(versions, '9.9.9')).toBe(versions[0]);
    expect(pickRequestedVersion([], '1.0.0')).toBeNull();
  });
});
