import { describe, expect, it } from 'vitest';
import { notificationLink, timeAgo } from './notification-link';

describe('notificationLink', () => {
  it('leads each kind to its page', () => {
    expect(
      notificationLink({ kind: 'OrganizationInvitation', payload: { invitation_code: 'abc' } })
    ).toBe('/orgs/join/abc');
    expect(
      notificationLink({
        kind: 'CompositionUpdated',
        payload: { organization_slug: 'isa-demo', composition_slug: 'fleet', version: '3' },
      })
    ).toBe('/compositions/isa-demo/fleet?version=3');
    expect(
      notificationLink({
        kind: 'RunFailed',
        payload: { organization_slug: 'isa-demo', run_id: 'r1' },
      })
    ).toBe('/app/isa-demo/runs/r1');
    expect(notificationLink({ kind: 'System', payload: { organization_slug: 'isa-demo' } })).toBe(
      '/orgs/isa-demo'
    );
    expect(notificationLink({ kind: 'System', payload: {} })).toBeNull();
  });

  it('says how long ago', () => {
    const now = new Date('2026-11-16T12:00:00Z');
    expect(timeAgo('2026-11-16T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-11-16T09:00:00Z', now)).toMatch(/hours ago$/);
  });
});
