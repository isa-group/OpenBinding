import type { StudyCell } from '../../api/platform';
import {
  RUNTIME, describeParameters, engineKeyOf, enginesOf, measureLabel, measureValue, metricsOf, parametersKey, revisionLabel, type RevisionInfo,
} from './studiesModel';

export interface Spread {
  min: number;
  max: number;
  q1: number;
  median: number;
  q3: number;
  mean: number;
}

/** Quantile of sorted values by linear interpolation. */
function quantile(sorted: readonly number[], share: number): number {
  if (sorted.length === 1) return sorted[0];
  const at = share * (sorted.length - 1);
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

export function spreadOf(values: readonly number[]): Spread | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    q1: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    q3: quantile(sorted, 0.75),
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
  };
}

export interface EngineRow {
  key: string;
  label: string;
  /** Position among the engines, for the colour. */
  position: number;
  cells: StudyCell[];
  completed: StudyCell[];
  feasible: number;
  /** The measure of each completed cell that has one. */
  values: Array<{ cell: StudyCell; value: number }>;
  spread: Spread | null;
  meanSeconds: number | null;
}

/** One row per engine: how many cells it ran, how many completed and were feasible, and where its values fall. */
export function engineRows(cells: readonly StudyCell[], measure: string): EngineRow[] {
  return enginesOf(cells).map((engine, position) => {
    const own = cells.filter((cell) => engineKeyOf(cell.engine_ref) === engine.key);
    const completed = own.filter((cell) => cell.state === 'completed');
    const values = completed.flatMap((cell) => {
      const value = measureValue(cell, measure);
      return value === null ? [] : [{ cell, value }];
    });
    const seconds = completed.flatMap((cell) => {
      const took = metricsOf(cell).runtimeSeconds;
      return took === undefined ? [] : [took];
    });
    return {
      key: engine.key,
      label: engine.label,
      position,
      cells: own,
      completed,
      feasible: completed.filter((cell) => metricsOf(cell).feasible === true).length,
      values,
      spread: spreadOf(values.map((item) => item.value)),
      meanSeconds: seconds.length ? seconds.reduce((total, value) => total + value, 0) / seconds.length : null,
    };
  });
}

/** Engines with values, best (lowest mean) first. An engine with nothing to rank goes last. */
export function rankEngines(rows: readonly EngineRow[]): EngineRow[] {
  return [...rows].sort((a, b) => {
    if (a.spread === null && b.spread === null) return a.position - b.position;
    if (a.spread === null) return 1;
    if (b.spread === null) return -1;
    return a.spread.mean - b.spread.mean;
  });
}

/** A palette in the tokens of the design, one colour per engine. */
const PALETTE = ['var(--tp-primary)', 'var(--tp-sunshine-500)', 'var(--tp-primary-deep)', 'var(--tp-severity-warning)', 'var(--tp-severity-success)', 'var(--tp-stone)'];
export const engineColor = (position: number): string => PALETTE[position % PALETTE.length];

/** Where `value` falls between `low` and `high`, as a percentage; the middle when they are the same. */
export function percentOf(value: number, low: number, high: number): number {
  if (high <= low) return 50;
  return Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100));
}

export interface Axis {
  low: number;
  high: number;
}

/** The range of a set of values, widened by a margin so the extreme dots don't sit on the edge. */
export function axisOf(values: readonly number[]): Axis {
  if (values.length === 0) return { low: 0, high: 1 };
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (high === low) return { low: low - Math.abs(low) * 0.05 - 0.5, high: high + Math.abs(high) * 0.05 + 0.5 };
  const margin = (high - low) * 0.06;
  return { low: low - margin, high: high + margin };
}

export interface Point {
  cell: StudyCell;
  x: number;
  y: number;
  /** Nobody beats it on both measures. */
  front: boolean;
}

/**
 * The completed cells of one case revision plotted by two measures, with the ones nobody beats on both marked (both lower-is-better).
 * Different case revisions are never pooled into one front: they are different problems.
 */
export function scatterOf(cells: readonly StudyCell[], caseRevisionId: string, xMeasure: string, yMeasure: string): Point[] {
  const points = cells
    .filter((cell) => cell.binding_case_revision_id === caseRevisionId)
    .flatMap((cell) => {
      const x = measureValue(cell, xMeasure);
      const y = measureValue(cell, yMeasure);
      return x === null || y === null ? [] : [{ cell, x, y }];
    });
  return points.map((point) => ({
    ...point,
    front: !points.some((other) => other !== point && other.x <= point.x && other.y <= point.y && (other.x < point.x || other.y < point.y)),
  }));
}

export interface SeedGroup {
  key: string;
  caseId: string;
  label: string;
  setting: string;
  seeds: Array<{ seed: number; value: number | null; cell: StudyCell }>;
  /** Highest minus lowest value across seeds; `null` when fewer than two seeds have one. */
  spread: number | null;
}

/** Same case, engine and setting, different seed: how much the result moves with the seed alone. */
export function seedGroups(cells: readonly StudyCell[], measure: string, index: ReadonlyMap<string, RevisionInfo>): SeedGroup[] {
  const engines = new Map(enginesOf(cells).map((engine) => [engine.key, engine.label]));
  const groups = new Map<string, SeedGroup>();
  for (const cell of [...cells].sort((a, b) => a.ordinal - b.ordinal)) {
    const engine = engineKeyOf(cell.engine_ref);
    const setting = parametersKey(cell.parameters);
    const key = `${cell.binding_case_revision_id}|${engine}|${setting}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, caseId: cell.binding_case_revision_id, label: `${revisionLabel(index, cell.binding_case_revision_id, true)} · ${engines.get(engine) ?? engine}`, setting: describeParameters(cell.parameters), seeds: [], spread: null };
      groups.set(key, group);
    }
    group.seeds.push({ seed: cell.seed, value: measureValue(cell, measure), cell });
  }
  return [...groups.values()].map((group) => {
    const values = group.seeds.flatMap((item) => (item.value === null ? [] : [item.value]));
    return { ...group, seeds: group.seeds.sort((a, b) => a.seed - b.seed), spread: values.length >= 2 ? Math.max(...values) - Math.min(...values) : null };
  });
}

const quote = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The cells of a run as a CSV file: one row per cell, one column per measure, for a spreadsheet or a notebook. */
export function cellsCsv(cells: readonly StudyCell[], measures: readonly string[], index: ReadonlyMap<string, RevisionInfo>): string {
  const objectives = measures.filter((name) => name !== RUNTIME);
  const header = ['cell', 'case_revision', 'engine', 'engine_version', 'mode', 'setting', 'seed', 'state', 'feasible', ...objectives, 'runtime_seconds', 'job_id', 'fingerprint'];
  const rows = [...cells].sort((a, b) => a.ordinal - b.ordinal).map((cell) => {
    const metrics = metricsOf(cell);
    return [
      cell.ordinal, revisionLabel(index, cell.binding_case_revision_id), cell.engine_ref.name, cell.engine_ref.version, cell.engine_ref.mode ?? '', describeParameters(cell.parameters),
      cell.seed, cell.state, metrics.feasible ?? '', ...objectives.map((name) => metrics.objectives[name] ?? ''), metrics.runtimeSeconds ?? '', cell.job_id ?? '', cell.fingerprint,
    ].map(quote).join(',');
  });
  return [header.join(','), ...rows].join('\n');
}

export const measureTitle = (measure: string): string => (measure === RUNTIME ? 'Time taken' : `${measureLabel(measure)} found`);
