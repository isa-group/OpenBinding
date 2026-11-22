// The deep links of SPHERE's notification item (frontend/src/modules/notification/components/notification-item, revision
// 73779a8a), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full
// text is in THIRD_PARTY_NOTICES.md. Adapted: OpenBinding's kinds and payload (an invitation opens its join page, a new
// version its composition at that version, an adoption the composition's Operation tab on that environment, a finished or
// failed run the run, an upstream change the composition's Operation tab on that event); the icon of each kind; an
// adoption's and an upstream change's line said from its payload; the time as date-fns says it
// (SPHERE's two copies of `timeAgo` are gone).

import { formatDistanceStrict } from 'date-fns';
import { compositionPath } from '../../../routes/paths/compositions';
import { runPath } from '../../../routes/paths/runs';
import type { Notification } from '../api/notificationsApi';

export const KIND_ICONS: Record<string, string> = {
  OrganizationInvitation: 'mdi:account-plus',
  System: 'mdi:information',
  CompositionUpdated: 'mdi:file-replace',
  RunFinished: 'mdi:check-circle-outline',
  RunFailed: 'mdi:close',
  CompositionAdopted: 'mdi:check',
  UpstreamEvent: 'mdi:update',
};

export const KIND_LABELS: Record<string, string> = {
  OrganizationInvitation: 'Invitations',
  System: 'System',
  CompositionUpdated: 'Composition updates',
  RunFinished: 'Runs finished',
  RunFailed: 'Runs failed',
  CompositionAdopted: 'Adoptions',
  UpstreamEvent: 'Upstream changes',
};

const text = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** Where a notification leads, or null when it is only to be read. */
export function notificationLink(
  notification: Pick<Notification, 'kind' | 'payload'>
): string | null {
  const payload = notification.payload ?? {};
  const org = text(payload.organization_slug);
  switch (notification.kind) {
    case 'OrganizationInvitation': {
      const code = text(payload.invitation_code);
      return code ? `/orgs/join/${encodeURIComponent(code)}` : null;
    }
    case 'CompositionUpdated': {
      const composition = text(payload.composition_slug);
      const version = text(payload.version);
      return org && composition
        ? compositionPath(org, composition, undefined, version ? { version } : {})
        : null;
    }
    case 'CompositionAdopted': {
      // The composition's Operation tab, on the environment adopted in.
      const adoptedOrg = text(payload.organization);
      const composition = text(payload.composition);
      const environment = text(payload.environment) ?? undefined;
      return adoptedOrg && composition
        ? compositionPath(adoptedOrg, composition, 'operation', { environment })
        : null;
    }
    case 'UpstreamEvent': {
      // The composition's Operation tab, open on the most severe event the notification tells.
      const eventOrg = text(payload.organization);
      const composition = text(payload.composition);
      const event = text(payload.event) ?? undefined;
      return eventOrg && composition
        ? compositionPath(eventOrg, composition, 'operation', { event })
        : null;
    }
    case 'RunFinished':
    case 'RunFailed': {
      const run = text(payload.run_id);
      return org && run ? runPath(org, run) : null;
    }
    default:
      return org ? `/orgs/${encodeURIComponent(org)}` : null;
  }
}

const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * An upstream event's line, from its payload: "brevo 2026-11 changes tomatometer 1.0.0 (in effect in production)", or, for
 * one a newer version already resolved, "… already resolved in 1.2.0, not adopted in production".
 */
function upstreamBody(payload: Record<string, unknown>): string | null {
  const pricing = (payload.pricing ?? {}) as Record<string, unknown>;
  const name = text(pricing.title) ?? text(pricing.sphere) ?? text(pricing.url);
  const label = text(payload.newVersion);
  const composition = text(payload.composition);
  const versions = texts(payload.versions);
  if (!name || !composition) return null;
  const environments = texts(payload.environments);
  const where = environments.length ? environments.join(', ') : null;
  const resolved = text(((payload.resolvedBy ?? {}) as Record<string, unknown>).version);
  const head = `${name}${label ? ` ${label}` : ''} changes ${composition}${versions.length ? ` ${versions.join(', ')}` : ''}`;
  if (resolved)
    return `${head}: already resolved in ${resolved}${where ? `, not adopted in ${where}` : ''}`;
  return `${head}${where ? ` (in effect in ${where})` : ''}`;
}

/**
 * The line under a notification's subject: an adoption says who adopted what where, an upstream event what changed where;
 * any other kind, the gateway's body.
 */
export function notificationBody(
  notification: Pick<Notification, 'kind' | 'payload' | 'body'>
): string {
  const payload = notification.payload ?? {};
  if (notification.kind === 'UpstreamEvent') return upstreamBody(payload) ?? notification.body;
  if (notification.kind === 'CompositionAdopted') {
    const actor = text(payload.actor);
    const version = text(payload.version);
    const environment = text(payload.environment);
    if (actor && version && environment) return `${actor} adopted ${version} in ${environment}`;
  }
  return notification.body;
}

/** "5 minutes ago", "just now" under a minute. */
export function timeAgo(dateString: string, now = new Date()): string {
  const date = new Date(dateString);
  if (now.getTime() - date.getTime() < 60_000) return 'just now';
  return `${formatDistanceStrict(date, now)} ago`;
}
