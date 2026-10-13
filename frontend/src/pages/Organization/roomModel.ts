import type { PricingCatalog, UsageView } from '../../api/auth';
import { describeLimit, limitInfo, type LimitDefinition, type LimitKind } from '../../utils/limits';

/**
 * The sponsor’s room: how much of the plan’s size limits (organizations, members, projects, storage…) the
 * organizations it sponsors already take. The limits come from the sponsor’s plan, never from the person looking.
 */
export const ROOM_IDS = ['organizations', 'members', 'projects', 'privateProjects', 'collections', 'studies', 'storageBytes'] as const;

export interface RoomRow {
  id: string;
  label: string;
  /** `null`: the allowance is unlimited. */
  limit: number | null;
  /** `null`: the gateway does not report how much is used. */
  used: number | null;
  /** What creating the organization (or accepting the invitation) would add. */
  added: number;
  kind: LimitKind;
}

function row(id: string, limit: number | null, used: number | null, added: number, definition?: LimitDefinition): RoomRow {
  const info = limitInfo(id, definition);
  return { id, label: id === 'members' ? 'Unique members' : info.label, limit, used, added, kind: info.kind };
}

/** The room as the signed-in sponsor’s own usage reports it (`GET /v1/users/me/usage`). */
export function roomFromUsage(usage: UsageView, ids: readonly string[] = ROOM_IDS, added: Record<string, number> = {}): RoomRow[] {
  return ids.filter((id) => id in usage.capabilities).map((id) => {
    const capability = usage.capabilities[id];
    return row(id, capability === undefined || !Number.isFinite(capability) ? null : capability, null, added[id] ?? 0);
  });
}

type Dict = Record<string, unknown>;
const dict = (value: unknown): Dict => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Dict : {});

/** The ceilings of a plan in the pricing catalog, for a sponsor whose own usage is not visible. */
export function roomFromCatalog(catalog: PricingCatalog, plan: string, ids: readonly string[] = ROOM_IDS, added: Record<string, number> = {}): RoomRow[] {
  const definitions = dict(catalog.usageLimits);
  const planLimits = dict(dict(dict(catalog.plans)[plan]).usageLimits);
  return ids.filter((id) => id in definitions).map((id) => {
    const definition = dict(definitions[id]);
    const own = dict(planLimits[id]);
    const raw = 'value' in own ? own.value : definition.defaultValue;
    const limit = typeof raw === 'number' ? raw : null;
    return row(id, limit, null, added[id] ?? 0, definition);
  });
}

export function roomText(item: RoomRow): string {
  const limit = describeLimit(item.kind, item.limit).text;
  if (item.used === null) return item.limit === null ? 'Unlimited' : `Up to ${limit}`;
  const total = item.used + item.added;
  return item.limit === null ? `${describeLimit(item.kind, total).text} · unlimited` : `${describeLimit(item.kind, total).text} of ${limit}`;
}

export function roomTone(item: RoomRow): 'ok' | 'full' | 'over' {
  if (item.limit === null || item.used === null) return 'ok';
  const total = item.used + item.added;
  return total > item.limit ? 'over' : total === item.limit ? 'full' : 'ok';
}
