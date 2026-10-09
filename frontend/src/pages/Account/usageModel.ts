import type { LimitUsage, UsageView } from '../../api/auth';
import { LIMIT_ORDER, limitInfo, type LimitDefinition, type LimitInfo } from '../../utils/limits';

/**
 * What `GET /v1/users/me/usage` says, arranged for the usage screen.
 *
 * The endpoint reports each allowance twice over: `limits` holds the finite ones with what has been used, and
 * `capabilities` holds every one of the plan, with `null` for an unlimited allowance. A row joins the two.
 */
export interface UsageRow {
  id: string;
  info: LimitInfo;
  /** `null`: no limit. */
  limit: number | null;
  /** `null`: the gateway does not count this one (a ceiling, or an unlimited allowance). */
  used: number | null;
  unit: string | null;
  renewsAt: string | null;
  /** The finite, counted allowance, for the bar. */
  tracked: LimitUsage | null;
}

function orderOf(id: string): number {
  const index = LIMIT_ORDER.indexOf(id);
  return index < 0 ? LIMIT_ORDER.length : index;
}

export function usageRows(usage: UsageView, definitions: Record<string, LimitDefinition> = {}): UsageRow[] {
  const ids = [...new Set([...Object.keys(usage.limits), ...Object.keys(usage.capabilities)])];
  return ids
    .map((id): UsageRow => {
      const info = limitInfo(id, definitions[id]);
      const reported = usage.limits[id] ?? null;
      const finite = reported !== null && Number.isFinite(reported.limit) ? reported : null;
      const capability = usage.capabilities[id];
      const counted = info.group !== 'ceiling' ? finite : null;
      return {
        id,
        info,
        limit: finite ? finite.limit : capability === undefined ? null : capability,
        used: counted ? Math.max(0, counted.used) : null,
        unit: reported?.unit ?? null,
        renewsAt: reported?.renews_at ?? null,
        tracked: counted,
      };
    })
    .sort((a, b) => orderOf(a.id) - orderOf(b.id));
}

/** The soonest renewal date among the monthly allowances, as an ISO string. */
export function nextRenewal(rows: UsageRow[]): string | null {
  const dates = rows
    .filter((row) => row.info.group === 'monthly' && row.renewsAt)
    .map((row) => row.renewsAt as string)
    .filter((value) => !Number.isNaN(new Date(value).getTime()))
    .sort();
  return dates[0] ?? null;
}

/** Whole days from `now` (ms) until `iso`, never negative. */
export function daysUntil(iso: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 86_400_000));
}
