import { describe, expect, it } from 'vitest';
import type { components } from '../../core/api/openapi';
import {
  ADMIN_ONLY,
  ALL_PERMISSIONS,
  ENGINE_LIMITED,
  PERMISSION_GROUPS,
  PRESETS,
  boundaryLabels,
  describeEngineAccess,
  expiryFor,
  needsEngines,
} from './keysModel';

type ApiKeyPermission = components['schemas']['ApiKeyPermission'];

describe('API-key permissions', () => {
  it('offers every permission of the closed set exactly once', () => {
    const listed = PERMISSION_GROUPS.flatMap(group =>
      group.permissions.map(permission => permission.id)
    );
    expect(ALL_PERMISSIONS).toHaveLength(21);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('locks the three admin-only permissions and none of the presets uses one', () => {
    expect([...ADMIN_ONLY].sort()).toEqual([
      'admin:accounts:read',
      'admin:accounts:write',
      'engines:moderate',
    ]);
    for (const permissions of Object.values(PRESETS)) {
      expect(permissions.some(permission => ADMIN_ONLY.has(permission))).toBe(false);
    }
  });

  it('knows which permissions need an engine to be chosen', () => {
    expect(needsEngines(['account:read', 'keys:read'] as ApiKeyPermission[])).toBe(false);
    expect(needsEngines(['jobs:read'])).toBe(true);
    expect(needsEngines(['studies:write'])).toBe(true);
    expect(needsEngines(['problems:read'])).toBe(false);
    expect([...ENGINE_LIMITED]).toContain('engines:execute');
    expect(needsEngines(PRESETS.run)).toBe(true);
  });

  it('counts an expiry from the moment of creation, or none', () => {
    const now = Date.UTC(2026, 9, 9);
    expect(expiryFor('30', now)).toBe('2026-11-08T00:00:00.000Z');
    expect(expiryFor('365', now)).toBe('2027-10-09T00:00:00.000Z');
    expect(expiryFor('never', now)).toBeNull();
  });

  it('describes what a key may reach', () => {
    const digest = `sha256-${'b2c3d4e5'.repeat(8)}`;
    expect(describeEngineAccess({ all: true, engines: [] })).toBe(
      'All engines, including future ones'
    );
    expect(describeEngineAccess({ all: false, engines: [] })).toBe('No engines');
    expect(
      describeEngineAccess({
        all: false,
        engines: [{ namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest }],
      })
    ).toBe('Only bim.builtin/random-search@1.0.0');
  });

  it('turns a boundary into short labels, ignoring the nulls the API sends for what is not set', () => {
    expect(boundaryLabels(undefined)).toEqual([]);
    expect(boundaryLabels({ methods: null, organizations: null } as never)).toEqual([]);
    expect(
      boundaryLabels({
        methods: ['GET'],
        organizations: ['isa-demo'],
        resource_kinds: ['runs', 'studies'],
        slugs: ['latency'],
      })
    ).toEqual(['GET only', 'org isa-demo', 'runs, studies', 'slug latency']);
  });
});
