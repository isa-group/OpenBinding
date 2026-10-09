import { describe, expect, it } from 'vitest';
import type { ApiKeyPermission, Notification, UsageView } from '../../api/auth';
import {
  ADMIN_ONLY, ALL_PERMISSIONS, ENGINE_LIMITED, PERMISSION_GROUPS, PRESETS, boundaryLabels, describeEngineAccess, expiryFor, needsEngines,
  shortRevisionDigest,
} from './keysModel';
import { contractChange, groupOf, unreadCount } from './notificationsModel';
import { daysUntil, nextRenewal, usageRows } from './usageModel';

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
    expect(shortRevisionDigest(digest)).toBe('sha256-b2c3…d4e5');
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

describe('usage rows', () => {
  const usage: UsageView = {
    plan: 'PRO',
    contract_pending: false,
    features: { solve: true },
    capabilities: { taskStarts: null, solverSeconds: 180_000, apiKeys: 25, maxTimeoutSeconds: 1800, organizations: 10, newThing: 5 },
    limits: {
      solverSeconds: { limit_id: 'solverSeconds', limit: 180_000, used: 7_420, remaining: 172_580, unit: 'second/month', renews_at: '2026-11-01T00:00:00Z' },
      apiKeys: { limit_id: 'apiKeys', limit: 25, used: 2, remaining: 23, unit: 'key', renews_at: null },
      maxTimeoutSeconds: { limit_id: 'maxTimeoutSeconds', limit: 1800, used: 0, remaining: 1800, unit: 'second' },
      organizations: { limit_id: 'organizations', limit: 10, used: 2, remaining: 8 },
    },
  };
  const rows = usageRows(usage);
  const row = (id: string) => rows.find((item) => item.id === id)!;

  it('joins what is counted with what the plan allows, in a stable order', () => {
    expect(rows.map((item) => item.id)).toEqual(['taskStarts', 'solverSeconds', 'apiKeys', 'maxTimeoutSeconds', 'organizations', 'newThing']);
    expect(row('solverSeconds')).toMatchObject({ limit: 180_000, used: 7_420, unit: 'second/month', renewsAt: '2026-11-01T00:00:00Z' });
    expect(row('apiKeys')).toMatchObject({ limit: 25, used: 2 });
  });

  it('reads an unlimited allowance (null capability, not counted) as no limit', () => {
    expect(row('taskStarts')).toMatchObject({ limit: null, used: null, tracked: null });
  });

  it('does not count a per-request ceiling as used', () => {
    expect(row('maxTimeoutSeconds')).toMatchObject({ limit: 1800, used: null, tracked: null });
  });

  it('finds the soonest renewal among the monthly allowances', () => {
    expect(nextRenewal(rows)).toBe('2026-11-01T00:00:00Z');
    expect(nextRenewal(usageRows({ ...usage, limits: {} }))).toBeNull();
  });

  it('counts whole days to a date and never goes below zero', () => {
    const now = Date.UTC(2026, 9, 9, 12);
    expect(daysUntil('2026-11-01T00:00:00Z', now)).toBe(23);
    expect(daysUntil('2026-01-01T00:00:00Z', now)).toBe(0);
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
      current: { plan: 'ADVANCED', addOns: { COMPUTE_PACK: 2, STORAGE_PACK: 1 } },
      pricingVersion: '0.1.0',
    }));
    expect(change).toEqual({
      before: { plan: 'BASIC', addOns: 'none' },
      after: { plan: 'ADVANCED', addOns: 'COMPUTE_PACK ×2, STORAGE_PACK' },
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
