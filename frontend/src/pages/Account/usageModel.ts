import type { UsageView } from '../../api/auth';
import { LIMIT_ORDER, describeLimit, formatCount, limitInfo, type LimitDefinition, type LimitInfo } from '../../utils/limits';

/**
 * What `GET /v1/users/me/usage` says, arranged for the plan screen.
 *
 * The endpoint reports what the plan allows and nothing about consumption: `capabilities` holds every functional
 * limit of the plan, with `null` for an unlimited one. Nothing is counted per account.
 */
export interface UsageRow {
  id: string;
  info: LimitInfo;
  /** `null`: no limit. */
  limit: number | null;
}

function orderOf(id: string): number {
  const index = LIMIT_ORDER.indexOf(id);
  return index < 0 ? LIMIT_ORDER.length : index;
}

export function usageRows(usage: UsageView, definitions: Record<string, LimitDefinition> = {}): UsageRow[] {
  return Object.entries(usage.capabilities ?? {})
    .map(([id, limit]): UsageRow => ({ id, info: limitInfo(id, definitions[id]), limit }))
    .sort((a, b) => orderOf(a.id) - orderOf(b.id));
}

/** What the "Exact value" column says for a limit that has no ceiling. The YAML's `.inf` is a file artefact, never shown. */
export const NO_LIMIT_TEXT = 'No limit';

/** The exact figure of a limit in words: `60 s`, `8,388,608 bytes`, `No limit`. Never the raw `.inf`/`null`/`Infinity`. */
export function exactValueText(row: UsageRow): string {
  if (row.limit === null || !Number.isFinite(row.limit)) return NO_LIMIT_TEXT;
  return describeLimit(row.info.kind, row.limit).exact ?? formatCount(row.limit);
}
