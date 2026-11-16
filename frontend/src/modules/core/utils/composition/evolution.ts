import type { CompositionVersionView } from '../../api/types';
import { valueStatus, type ValueStatus } from './values';

/**
 * How a composition evolved, version by version, as the evolution charts draw it. The input is the gateway's light version
 * rows (`GET …/versions?include=analytics&order=oldest`, possibly filtered by date); every number is one the gateway stored
 * or evaluated, placed on a time axis (sealed at) and an ordinal axis. Nothing is filled in: a number the gateway did not
 * give is `null`, a gap in the chart, never 0, and a version without analytics has no structure point. A value whose unit
 * changes from one version to another becomes two charts, because two units never share an axis.
 */

/** The summary a version stores at seal (`analytics`): counts of its document, read as the gateway wrote them. */
export interface Analytics {
  tasks: number | null;
  boundTasks: number | null;
  localTasks: number | null;
  providers: number | null;
  upstreamPricings: number | null;
  workflow: { depth: number | null; and: number | null; xor: number | null; loop: number | null };
  hasOffering: boolean | null;
}

export type StructureMetric =
  | 'tasks'
  | 'boundTasks'
  | 'localTasks'
  | 'providers'
  | 'upstreamPricings'
  | 'workflow.depth'
  | 'workflow.and'
  | 'workflow.xor'
  | 'workflow.loop';

export const STRUCTURE_METRICS: readonly StructureMetric[] = [
  'tasks',
  'boundTasks',
  'localTasks',
  'providers',
  'upstreamPricings',
  'workflow.depth',
  'workflow.and',
  'workflow.xor',
  'workflow.loop',
];

/** One position on a chart: when the version was sealed (ms since the epoch), its ordinal, and the number or a gap. */
export interface Pt {
  t: number;
  ordinal: number;
  value: number | null;
}

export interface EvolutionPoint {
  id: string;
  label: string;
  ordinal: number;
  t: number;
  analytics: Analytics | null;
  values: Record<string, { value: number; unit: string; status: ValueStatus }>;
  /** The linked problem revision as `<slug>@<revision>`; null for a declared version. */
  problemKey: string | null;
  /** The linked compilation's semantic digest, else the current evaluation's; null when there is neither. */
  compilationKey: string | null;
}

export interface ValueSeries {
  name: string;
  unit: string;
  /** One position per version for each status; a version's value sits in exactly one of the three, the others are gaps. */
  verified: Pt[];
  declared: Pt[];
  unverified: Pt[];
}

export type MarkerKind = 'problem' | 'compilation' | 'linked' | 'unlinked';

export interface Marker {
  t: number;
  ordinal: number;
  kind: MarkerKind;
  label: string;
}

export interface EvolutionModel {
  points: EvolutionPoint[];
  structure: { metric: StructureMetric; points: Pt[] }[];
  /** Whether each version names an offering: a step row of markers, not a line. */
  hasOffering: { t: number; ordinal: number; value: boolean | null }[];
  /** One chart per value name and unit. */
  values: ValueSeries[];
  markers: Marker[];
}

/** What the model reads of a version row. */
export type EvolutionRow = Pick<
  CompositionVersionView,
  | 'id'
  | 'label'
  | 'ordinal'
  | 'created_at'
  | 'values'
  | 'values_status'
  | 'current_evaluation'
  | 'problem'
> & { analytics?: CompositionVersionView['analytics'] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The stored analytics, each count as the gateway wrote it and `null` where it wrote none. */
export function readAnalytics(raw: unknown): Analytics | null {
  if (!isRecord(raw)) return null;
  const workflow = isRecord(raw.workflow) ? raw.workflow : {};
  return {
    tasks: count(raw.tasks),
    boundTasks: count(raw.boundTasks),
    localTasks: count(raw.localTasks),
    providers: count(raw.providers),
    upstreamPricings: count(raw.upstreamPricings),
    workflow: {
      depth: count(workflow.depth),
      and: count(workflow.and),
      xor: count(workflow.xor),
      loop: count(workflow.loop),
    },
    hasOffering: typeof raw.hasOffering === 'boolean' ? raw.hasOffering : null,
  };
}

function metricOf(analytics: Analytics, metric: StructureMetric): number | null {
  switch (metric) {
    case 'workflow.depth':
      return analytics.workflow.depth;
    case 'workflow.and':
      return analytics.workflow.and;
    case 'workflow.xor':
      return analytics.workflow.xor;
    case 'workflow.loop':
      return analytics.workflow.loop;
    default:
      return analytics[metric];
  }
}

function point(row: EvolutionRow): EvolutionPoint {
  const status = valueStatus(row);
  return {
    id: row.id,
    label: row.label,
    ordinal: row.ordinal,
    t: Date.parse(row.created_at),
    analytics: readAnalytics(row.analytics),
    values: Object.fromEntries(
      Object.entries(row.values).map(([name, { value, unit }]) => [name, { value, unit, status }])
    ),
    problemKey: row.problem ? `${row.problem.problem.slug}@${row.problem.revision.revision}` : null,
    compilationKey:
      row.problem?.linked_compilation.semantic_digest ??
      row.current_evaluation?.compilation?.semantic_digest ??
      null,
  };
}

function markersOf(points: EvolutionPoint[]): Marker[] {
  const markers: Marker[] = [];
  points.forEach((current, index) => {
    if (index === 0) return;
    const previous = points[index - 1];
    const at = { t: current.t, ordinal: current.ordinal };
    if (previous.problemKey === null && current.problemKey !== null) {
      markers.push({ ...at, kind: 'linked', label: `Linked to ${current.problemKey}` });
    } else if (previous.problemKey !== null && current.problemKey === null) {
      markers.push({
        ...at,
        kind: 'unlinked',
        label: `No longer linked to ${previous.problemKey}`,
      });
    } else if (previous.problemKey !== current.problemKey) {
      markers.push({
        ...at,
        kind: 'problem',
        label: `Problem ${previous.problemKey} to ${current.problemKey}`,
      });
    } else if (
      previous.compilationKey !== null &&
      current.compilationKey !== null &&
      previous.compilationKey !== current.compilationKey
    ) {
      markers.push({ ...at, kind: 'compilation', label: 'Compilation changed' });
    }
  });
  return markers;
}

/** A separator no property id or unit can hold, to key a chart by name and unit. */
const KEY = '\u0000';

function valueSeries(points: EvolutionPoint[]): ValueSeries[] {
  const charts = new Map<string, { name: string; unit: string }>();
  for (const { values } of points) {
    for (const [name, { unit }] of Object.entries(values)) {
      const key = `${name}${KEY}${unit}`;
      if (!charts.has(key)) charts.set(key, { name, unit });
    }
  }
  return [...charts.values()].map(({ name, unit }) => {
    const series: ValueSeries = { name, unit, verified: [], declared: [], unverified: [] };
    for (const current of points) {
      const value = current.values[name];
      const here = value && value.unit === unit ? value : null;
      for (const status of ['verified', 'declared', 'unverified'] as const) {
        series[status].push({
          t: current.t,
          ordinal: current.ordinal,
          value: here && here.status === status ? here.value : null,
        });
      }
    }
    return series;
  });
}

/** The evolution of a composition from its version rows, in any order; points come out oldest first (by ordinal). */
export function evolutionModel(rows: readonly EvolutionRow[]): EvolutionModel {
  const points = [...rows].sort((one, other) => one.ordinal - other.ordinal).map(point);
  const analysed = points.filter(
    (current): current is EvolutionPoint & { analytics: Analytics } => current.analytics !== null
  );
  return {
    points,
    structure: STRUCTURE_METRICS.map(metric => ({
      metric,
      points: analysed.map(current => ({
        t: current.t,
        ordinal: current.ordinal,
        value: metricOf(current.analytics, metric),
      })),
    })),
    hasOffering: analysed.map(current => ({
      t: current.t,
      ordinal: current.ordinal,
      value: current.analytics.hasOffering,
    })),
    values: valueSeries(points),
    markers: markersOf(points),
  };
}
