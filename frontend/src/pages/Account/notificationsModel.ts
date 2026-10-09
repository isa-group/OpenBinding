import type { ContractChangePayload, Notification } from '../../api/auth';

export type NotificationGroup = 'contract' | 'job' | 'invite' | 'other';

/** The filters of the screen; `other` notices appear under All only. */
export const NOTIFICATION_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'contract', label: 'Contract changes' },
  { id: 'job', label: 'Jobs' },
  { id: 'invite', label: 'Invitations' },
] as const;

/** Notification kinds are free text from the API (`contract.changed`, `engine.deregistered`): group them by their prefix. */
export function groupOf(kind: string): NotificationGroup {
  const lower = kind.toLowerCase();
  if (lower.startsWith('contract')) return 'contract';
  if (lower.startsWith('job')) return 'job';
  if (lower.includes('invit')) return 'invite';
  return 'other';
}

export interface ContractSide {
  plan: string;
  addOns: string;
}

export interface ContractChange {
  before: ContractSide;
  after: ContractSide;
  reason: string | null;
  pricingVersion: string | null;
}

function side(value: ContractChangePayload['previous']): ContractSide | null {
  if (!value || typeof value.plan !== 'string') return null;
  const addOns = Object.entries(value.addOns ?? {}).map(([id, quantity]) => (quantity > 1 ? `${id} ×${quantity}` : id));
  return { plan: value.plan, addOns: addOns.length ? addOns.join(', ') : 'none' };
}

/** The before and after of a contract change, when the notification carries them. */
export function contractChange(notification: Notification): ContractChange | null {
  if (groupOf(notification.kind) !== 'contract') return null;
  const payload = notification.payload as ContractChangePayload;
  const before = side(payload.previous);
  const after = side(payload.current);
  if (!before || !after) return null;
  return {
    before,
    after,
    reason: typeof payload.reason === 'string' && payload.reason ? payload.reason.replace(/_/g, ' ') : null,
    pricingVersion: typeof payload.pricingVersion === 'string' ? payload.pricingVersion : null,
  };
}

export function unreadCount(items: Notification[]): number {
  return items.filter((item) => !item.read_at).length;
}
