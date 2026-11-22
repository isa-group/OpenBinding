import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import Iconify from '../../core/components/iconify';
import { NOTIFICATION_KINDS } from '../api/notificationsApi';
import { KIND_ICONS, notificationBody, notificationLink, timeAgo } from './notification-link';
import upstream from '../../../test/fixtures/core/upstream.notifications.json';

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
    ).toBe('/runs/isa-demo/r1');
    expect(
      notificationLink({
        kind: 'CompositionAdopted',
        payload: {
          organization: 'lab-main',
          composition: 'tomatometer',
          environment: 'production',
        },
      })
    ).toBe('/compositions/lab-main/tomatometer/operation?environment=production');
    expect(notificationLink({ kind: 'CompositionAdopted', payload: {} })).toBeNull();
    expect(
      notificationLink({
        kind: 'UpstreamEvent',
        payload: { organization: 'lab-main', composition: 'tomatometer', event: 'e1' },
      })
    ).toBe('/compositions/lab-main/tomatometer/operation?event=e1');
    expect(
      notificationLink({
        kind: 'UpstreamEvent',
        payload: { organization: 'lab-main', composition: 'tomatometer' },
      })
    ).toBe('/compositions/lab-main/tomatometer/operation');
    expect(notificationLink({ kind: 'UpstreamEvent', payload: {} })).toBeNull();
    expect(notificationLink({ kind: 'System', payload: { organization_slug: 'isa-demo' } })).toBe(
      '/orgs/isa-demo'
    );
    expect(notificationLink({ kind: 'System', payload: {} })).toBeNull();
  });

  it('says who adopted which version in which environment, and the gateway’s body otherwise', () => {
    expect(
      notificationBody({
        kind: 'CompositionAdopted',
        body: '@lab-owner adopted version 1.1.0 of "TomatoMeter" in Production (it was 1.0.0).',
        payload: { actor: 'lab-owner', version: '1.1.0', environment: 'production' },
      })
    ).toBe('lab-owner adopted 1.1.0 in production');
    expect(notificationBody({ kind: 'CompositionAdopted', body: 'as sent', payload: {} })).toBe(
      'as sent'
    );
    expect(notificationBody({ kind: 'RunFinished', body: 'Run done.', payload: {} })).toBe(
      'Run done.'
    );
  });

  it('says an upstream change from its payload: the pricing, the composition, where it is in effect', () => {
    const [told] = upstream;
    expect(notificationBody(told)).toBe(
      'brevo 2026-11 changes tomatometer 1.0.0 (in effect in production)'
    );
    expect(
      notificationBody({
        ...told,
        payload: { ...told.payload, resolvedBy: { version: '1.2.0' } },
      })
    ).toBe(
      'brevo 2026-11 changes tomatometer 1.0.0: already resolved in 1.2.0, not adopted in production'
    );
    expect(notificationBody({ kind: 'UpstreamEvent', body: 'as sent', payload: {} })).toBe(
      'as sent'
    );
  });

  it('draws an icon for every kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const { container, unmount } = render(createElement(Iconify, { icon: KIND_ICONS[kind] }));
      expect(container.querySelector('svg'), kind).not.toBeNull();
      unmount();
    }
  });

  it('says how long ago', () => {
    const now = new Date('2026-11-16T12:00:00Z');
    expect(timeAgo('2026-11-16T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-11-16T09:00:00Z', now)).toMatch(/hours ago$/);
  });
});
