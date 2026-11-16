import type { EvolutionModel, EvolutionPoint, Marker, StructureMetric, ValueSeries } from '../../entities/composition/evolution';
import type { ValueStatus } from '../../entities/composition/values';

/**
 * What the evolution charts draw, read off the evolution model (`entities/composition/evolution`): rows keyed by the horizontal
 * position, short marker words and the date range as the gateway's bounds. Nothing here computes a value: every number is the
 * model's, and a number the model does not have stays `null` (a gap).
 */

export type Axis = 'time' | 'version';

export const STATUSES: readonly ValueStatus[] = ['verified', 'declared', 'unverified'];

export const METRIC_TEXT: Record<StructureMetric, string> = {
  tasks: 'Tasks',
  boundTasks: 'Bound tasks',
  localTasks: 'Local tasks',
  providers: 'Providers',
  upstreamPricings: 'Upstream pricings',
  'workflow.depth': 'Workflow depth',
  'workflow.and': 'Parallel blocks',
  'workflow.xor': 'Choice blocks',
  'workflow.loop': 'Repeat blocks',
};

/** One version on a chart: where it sits on either axis, and what the tooltip and the table name it by. */
export interface RowBase {
  t: number;
  ordinal: number;
  label: string;
  /** Sealed at, as the gateway wrote it (ISO 8601). */
  sealed: string;
}

export interface StructureRow extends RowBase {
  value: number | null;
}

export interface ValueRow extends RowBase {
  verified: number | null;
  declared: number | null;
  unverified: number | null;
}

const byOrdinal = (points: readonly EvolutionPoint[]) => new Map(points.map((point) => [point.ordinal, point]));

const base = (point: EvolutionPoint): RowBase => ({ t: point.t, ordinal: point.ordinal, label: point.label, sealed: new Date(point.t).toISOString() });

/** A structure chart's rows: the versions with analytics only (a version without them has no point, not a 0). */
export function structureRows(model: EvolutionModel, metric: StructureMetric): StructureRow[] {
  const points = byOrdinal(model.points);
  const series = model.structure.find((item) => item.metric === metric);
  return (series?.points ?? []).flatMap((pt) => {
    const point = points.get(pt.ordinal);
    return point ? [{ ...base(point), value: pt.value }] : [];
  });
}

/** A value chart's rows: one per version, the value in the series of its status and gaps in the other two. */
export function valueRows(model: EvolutionModel, series: ValueSeries): ValueRow[] {
  return model.points.map((point, index) => ({
    ...base(point),
    verified: series.verified[index]?.value ?? null,
    declared: series.declared[index]?.value ?? null,
    unverified: series.unverified[index]?.value ?? null,
  }));
}

/** Whether a value chart has anything of a status to draw. */
export const hasStatus = (rows: readonly ValueRow[], status: ValueStatus) => rows.some((row) => row[status] !== null);

/** `<slug>@<revision>` split, to say a revision change in few words. */
function splitKey(key: string | null): { slug: string; revision: string } | null {
  if (!key) return null;
  const at = key.lastIndexOf('@');
  return at < 0 ? { slug: key, revision: '' } : { slug: key.slice(0, at), revision: key.slice(at + 1) };
}

/** The few words a marker carries on a chart: "problem r1 → r2", "compilation changed", "linked", "unlinked". */
export function markerShort(model: EvolutionModel, marker: Marker): string {
  if (marker.kind === 'compilation') return 'compilation changed';
  if (marker.kind === 'linked') return 'linked';
  if (marker.kind === 'unlinked') return 'unlinked';
  const index = model.points.findIndex((point) => point.ordinal === marker.ordinal);
  const before = splitKey(model.points[index - 1]?.problemKey ?? null);
  const after = splitKey(model.points[index]?.problemKey ?? null);
  if (before && after && before.slug === after.slug) return `problem r${before.revision} → r${after.revision}`;
  return `problem ${model.points[index - 1]?.problemKey ?? '?'} → ${model.points[index]?.problemKey ?? '?'}`;
}

/** The label of the version a marker sits on. */
export const markerVersion = (model: EvolutionModel, marker: Marker) => model.points.find((point) => point.ordinal === marker.ordinal)?.label ?? '';

/** A day of `<input type="date">` (`YYYY-MM-DD`), as the gateway's bounds: the start of that day and the start of the next, in UTC. */
export function dateBounds(from: string, to: string): { createdAfter?: string; createdBefore?: string } {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const bounds: { createdAfter?: string; createdBefore?: string } = {};
  if (day.test(from)) bounds.createdAfter = `${from}T00:00:00Z`;
  if (day.test(to)) {
    const next = new Date(`${to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    bounds.createdBefore = next.toISOString().replace('.000Z', 'Z');
  }
  return bounds;
}

/** Both days given and the first after the second: nothing can be in that range. */
export const rangeInverted = (from: string, to: string) => Boolean(from && to && from > to);

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });

/** SPHERE's compact axis numbers: `1.2K` from a thousand on, the number itself below. */
export const formatTick = (value: number): string => {
  if (!Number.isFinite(value)) return '';
  return Math.abs(value) >= 1000 ? compact.format(value) : plain.format(value);
};

const dayTick = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A tick of the time axis (`Sep 25`, UTC like every date of the interface). */
export const formatDay = (t: number): string => (Number.isFinite(t) ? dayTick.format(new Date(t)) : '');

/** Per-viewer choices: the horizontal axis and the statuses hidden from the value charts. Never needed; kept where storage allows. */
export interface Preferences {
  axis: Axis;
  hidden: ValueStatus[];
}

export const PREFERENCES_KEY = 'openbinding.evolution-charts';

export function readPreferences(): Preferences {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? '{}');
    const record = typeof stored === 'object' && stored !== null ? stored as Record<string, unknown> : {};
    return {
      axis: record.axis === 'version' ? 'version' : 'time',
      hidden: Array.isArray(record.hidden) ? STATUSES.filter((status) => (record.hidden as unknown[]).includes(status)) : [],
    };
  } catch {
    return { axis: 'time', hidden: [] };
  }
}

export function writePreferences(preferences: Preferences): void {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // A private window or a full storage: the choice holds until the page is left.
  }
}
