import { describe, expect, it } from 'vitest';
import type { ApiKeyPermission, Notification, UsageView } from '../../api/auth';
import {
  ADMIN_ONLY, ALL_PERMISSIONS, ENGINE_LIMITED, PERMISSION_GROUPS, PRESETS, boundaryLabels, describeEngineAccess, expiryFor, needsEngines,
} from './keysModel';
import { contractChange, groupOf, unreadCount } from './notificationsModel';
import { usageRows } from './usageModel';

describe('API-key permissions', () => {
  it('offers every permission of the closed set exactly once', () => {
    const listed = PERMISSION_GROUPS.flatMap((group) => group.permissions.map((permission) => permission.id));
    expect(ALL_PERMISSIONS).toHaveLength(30);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('locks the five admin-only permissions and none of the presets uses one', () => {
    expect([...ADMIN_ONLY].sort()).toEqual(['admin:accounts:read', 'admin:accounts:write', 'engines:moderate', 'extensions:moderate', 'pricing:admin']);
    for (const permissions of Object.values(PRESETS)) {
      expect(permissions.some((permission) => ADMIN_ONLY.has(permission))).toBe(false);
    }
  });

  it('knows which permissions need an engine to be chosen', () => {
    expect(needsEngines(['account:read', 'keys:read'] as ApiKeyPermission[])).toBe(false);
    expect(needsEngines(['jobs:read'])).toBe(true);
    expect(needsEngines(['studies:write'])).toBe(true);
    expect(needsEngines(['instances:validate'])).toBe(true);
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
    expect(describeEngineAccess({ all: true, engines: [] })).toBe('All engines, including future ones');
    expect(describeEngineAccess({ all: false, engines: [] })).toBe('No engines');
    expect(describeEngineAccess({ all: false, engines: [{ namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest }] }))
      .toBe('Only bim.builtin/random-search@1.0.0 (sha256-b2c3…d4e5)');
  });

  it('turns a boundary into short labels, ignoring the nulls the API sends for what is not set', () => {
    expect(boundaryLabels(undefined)).toEqual([]);
    expect(boundaryLabels({ methods: null, organizations: null } as never)).toEqual([]);
    expect(boundaryLabels({ methods: ['GET'], organizations: ['isa-demo'], projects: ['qos-benchmarks'], resource_kinds: ['jobs', 'studies'], slugs: ['latency'] }))
      .toEqual(['GET only', 'org isa-demo', 'project qos-benchmarks', 'jobs, studies', 'slug latency']);
  });
});

describe('plan rows', () => {
  const usage: UsageView = {
    plan: 'PRO',
    contract_pending: false,
    features: { solve: true },
    capabilities: { federatedEngines: null, apiKeys: 25, maxTimeoutSeconds: 1800, organizations: 10, newThing: 5 },
  };
  const rows = usageRows(usage);
  const row = (id: string) => rows.find((item) => item.id === id)!;

  it('lists what the plan allows, in a stable order, with the unknown ones last', () => {
    expect(rows.map((item) => item.id)).toEqual(['federatedEngines', 'apiKeys', 'maxTimeoutSeconds', 'organizations', 'newThing']);
    expect(row('apiKeys')).toMatchObject({ limit: 25 });
    expect(row('maxTimeoutSeconds')).toMatchObject({ limit: 1800 });
  });

  it('reads a null capability as no limit', () => {
    expect(row('federatedEngines')).toMatchObject({ limit: null });
  });

  it('carries no consumption at all', () => {
    for (const item of rows) expect(Object.keys(item).sort()).toEqual(['id', 'info', 'limit']);
  });

  it('reads an answer without capabilities as no rows', () => {
    expect(usageRows({ plan: 'BASIC', contract_pending: true, features: {} } as UsageView)).toEqual([]);
  });
});

describe('notifications', () => {
  const notification = (kind: string, payload: Record<string, unknown> = {}, read_at: string | null = null): Notification => ({
    id: kind, kind, subject: kind, body: kind, payload, read_at, created_at: '2026-10-09T10:00:00Z',
  });

  it('groups a kind by its prefix', () => {
    expect(groupOf('contract.changed')).toBe('contract');
    expect(groupOf('job.finished')).toBe('job');
    expect(groupOf('organization.invitation')).toBe('invite');
    expect(groupOf('engine.deregistered')).toBe('other');
  });

  it('reads the before and after of a contract change', () => {
    const change = contractChange(notification('contract.changed', {
      reason: 'institutional_agreement',
      previous: { plan: 'BASIC', addOns: {} },
      current: { plan: 'ADVANCED', addOns: { COLLABORATION_PACK: 2, STORAGE_PACK: 1 } },
      pricingVersion: '0.1.0',
    }));
    expect(change).toEqual({
      before: { plan: 'BASIC', addOns: 'none' },
      after: { plan: 'ADVANCED', addOns: 'COLLABORATION_PACK ×2, STORAGE_PACK' },
      reason: 'institutional agreement',
      pricingVersion: '0.1.0',
    });
  });

  it('has no before and after for other notices or for a payload without them', () => {
    expect(contractChange(notification('job.finished', { previous: { plan: 'A' }, current: { plan: 'B' } }))).toBeNull();
    expect(contractChange(notification('contract.changed', {}))).toBeNull();
  });

  it('counts the unread', () => {
    expect(unreadCount([notification('a'), notification('b', {}, '2026-10-09T11:00:00Z'), notification('c')])).toBe(2);
  });
});
