// Adapted from SPHERE frontend/src/modules/pricing/components/stats/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the tiles of the card page (SPHERE's page draws Configurations, Min price, Max price and Versions inline) fed by
// a composition's version: its tasks, its providers, its global cost with the verified or declared mark, and the number of
// versions; a number the version does not have shows a dash.

import type { ShellStat } from '../../../core/components/resource-card-shell';
import { ValueBadge } from '../../../core/components/value-badge/ValueBadge';
import { formatCost } from '../composition-card/format';
import type { CompositionAnalytics } from '../composition-tree';

interface StatsInput {
  analytics: CompositionAnalytics | null | undefined;
  /** The version's `cost` value: a number, or a number with its unit. */
  cost: unknown;
  valuesStatus: 'verified' | 'declared' | null;
  versions: number;
}

const DASH = '—';

function costOf(value: unknown): { value: number; unit: string | null } | null {
  if (typeof value === 'number') return { value, unit: null };
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { value?: unknown }).value === 'number'
  )
    return {
      value: (value as { value: number }).value,
      unit: (value as { unit?: string }).unit ?? null,
    };
  return null;
}

/** The four tiles of a composition's page. */
export function compositionStats({
  analytics,
  cost,
  valuesStatus,
  versions,
}: StatsInput): ShellStat[] {
  const priced = costOf(cost);
  return [
    { label: 'Tasks', value: analytics?.tasks?.toLocaleString('en') ?? DASH },
    { label: 'Providers', value: analytics?.providers?.toLocaleString('en') ?? DASH },
    {
      label: 'Global cost',
      value: priced ? (
        <span className="flex flex-wrap items-center gap-2">
          {formatCost(priced.value, priced.unit)}
          {valuesStatus && <ValueBadge status={valuesStatus} />}
        </span>
      ) : (
        DASH
      ),
    },
    { label: 'Versions', value: String(versions) },
  ];
}
