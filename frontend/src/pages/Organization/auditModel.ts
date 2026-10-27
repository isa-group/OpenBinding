import type { OrganizationAuditEvent } from '../../api/platform';

/** The kinds the timeline groups events into, with the dot colour of each. */
export type AuditKind = 'organization' | 'members' | 'projects' | 'content' | 'other';

export const AUDIT_KINDS: Record<AuditKind, { label: string; colour: string }> = {
  organization: { label: 'Organization', colour: 'var(--tp-primary-deep)' },
  members: { label: 'Members', colour: 'var(--tp-primary)' },
  projects: { label: 'Projects', colour: 'var(--tp-severity-success)' },
  content: { label: 'Content', colour: 'var(--tp-severity-warning)' },
  other: { label: 'Other', colour: 'var(--tp-stone)' },
};

/**
 * The actions the gateway records for an organization (`_audit(...)` in its organizations routes). The list is
 * not part of the API contract, so any other action that arrives is still shown, and can still be filtered by.
 */
export const KNOWN_ACTIONS: ReadonlyArray<{ action: string; label: string }> = [
  { action: 'organization.created', label: 'Organization created' },
  { action: 'organization.updated', label: 'Organization updated' },
  { action: 'organization.members.batch_updated', label: 'Members changed together' },
  { action: 'organization.member.upserted', label: 'Member added or changed' },
  { action: 'organization.member.removed', label: 'Member removed' },
  { action: 'organization.invitation.created', label: 'Invitation created' },
  { action: 'organization.invitation.accepted', label: 'Invitation accepted' },
  { action: 'project.created', label: 'Project created' },
  { action: 'project.updated', label: 'Project updated' },
  { action: 'project.deleted', label: 'Project deleted' },
];

export function kindOf(action: string): AuditKind {
  if (/^organization\.(member|members|invitation)/.test(action)) return 'members';
  if (action.startsWith('organization.')) return 'organization';
  if (action.startsWith('project.')) return 'projects';
  if (/^(binding_case|project_resource|collection|study|report|publication|library|artifact)/.test(action)) return 'content';
  return 'other';
}

function humanize(action: string): string {
  const words = action.replace(/[._]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function actionLabel(action: string): string {
  return KNOWN_ACTIONS.find((item) => item.action === action)?.label ?? humanize(action);
}

interface Change {
  user_id?: unknown;
  role?: unknown;
}

/** `[{ user_id, role }]` as the batch event keeps it; anything else is ignored. */
export function changesOf(event: OrganizationAuditEvent): Array<{ userId: string; role: string | null }> {
  const raw = event.detail?.changes;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: Change) => (typeof item?.user_id === 'string' ? [{ userId: item.user_id, role: typeof item.role === 'string' ? item.role : null }] : []));
}

/** The sentence a row of the timeline reads as. */
export function describeEvent(event: OrganizationAuditEvent): string {
  switch (event.action) {
    case 'organization.members.batch_updated': {
      const count = changesOf(event).length;
      return count > 0 ? `${count} member change${count === 1 ? '' : 's'} applied together` : 'Member changes applied together';
    }
    case 'organization.member.upserted':
      return typeof event.detail?.role === 'string' ? `A member was added or set to ${event.detail.role}` : 'A member was added or changed';
    default:
      return actionLabel(event.action);
  }
}

/** A detail value ready to draw: text, a list or nested labelled rows. */
export type DetailValue =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: DetailValue[] }
  | { kind: 'fields'; rows: DetailRow[] };

export interface DetailRow {
  label: string;
  value: DetailValue;
}

/** `max_projects` and `maxProjects` both read “Max projects”. */
function sentenceCase(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.\s]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function detailValue(value: unknown): DetailValue {
  if (value === null || value === undefined) return { kind: 'text', text: 'none' };
  if (typeof value === 'string') return { kind: 'text', text: value };
  if (typeof value === 'boolean') return { kind: 'text', text: value ? 'Yes' : 'No' };
  if (typeof value === 'number') return { kind: 'text', text: value.toLocaleString('en-US') };
  if (Array.isArray(value)) return { kind: 'list', items: value.map(detailValue) };
  if (typeof value === 'object') return { kind: 'fields', rows: detailRows(value as Record<string, unknown>) };
  return { kind: 'text', text: String(value) };
}

/** The detail of an event as typed rows, so the page draws it without ever stringifying a value. */
// [impl->req~frontend-audit-detail-rendered~1]
export function detailRows(detail: Record<string, unknown> | null | undefined, skip: readonly string[] = []): DetailRow[] {
  return Object.entries(detail ?? {})
    .filter(([key]) => !skip.includes(key))
    .map(([key, value]) => ({ label: sentenceCase(key), value: detailValue(value) }));
}

function cell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The loaded events as CSV, for the export button. Plain text; nothing here is ever rendered as HTML. */
export function toCsv(events: readonly OrganizationAuditEvent[]): string {
  const head = ['id', 'createdAt', 'actorId', 'action', 'targetType', 'targetId', 'detail'];
  const lines = events.map((event) => [
    event.id, event.createdAt, event.actorId ?? '', event.action, event.targetType, event.targetId ?? '', JSON.stringify(event.detail ?? {}),
  ].map(cell).join(','));
  return [head.join(','), ...lines].join('\n');
}
