import type { StudyCell } from '../api/studiesApi';
import type { FrontPoint } from '../../run/components/derive/deriveModel';
import { pointSlug } from '../../run/components/derive/deriveModel';
import type { ParetoFront, ParetoPoint } from '../../core/api/types';
import { formatMeasure, measureLabel } from './studiesModel';

// The study front as tables: the gateway's fronts (`analytics.pareto`), each point named `P<n>` and matched to its cell for the seed.
// Which points are on a front, and their order, are the gateway's; nothing here compares two values.

export interface FrontRow {
  /** `<revision>|<cell>|<solution>`: unique in a run. */
  key: string;
  /** `P<n>`: the point's number among the points of its problem, across that problem's fronts, in the gateway's order. */
  label: string;
  n: number;
  problem: string;
  revision: number;
  point: ParetoPoint;
  /** The cell the point came from, when the run's cells name it. */
  cell: StudyCell | null;
  /** The engine's name (from the cell), else the gateway's engine reference. */
  engine: string;
}

export interface FrontTable {
  /** `checkout-flow · version 1`, with the objective names when a version has more than one front. */
  title: string;
  objectives: string[];
  rows: FrontRow[];
}

const keyOf = (front: ParetoFront, point: ParetoPoint) =>
  `${front.revision_id}|${point.cell_id}|${point.solution_index}`;

/** One table per front, in the gateway's order; the points keep the gateway's order too. */
export function frontTables(
  fronts: readonly ParetoFront[],
  cells: readonly StudyCell[]
): FrontTable[] {
  const byId = new Map(cells.map(cell => [cell.id, cell]));
  const counts = new Map<string, number>();
  const perRevision = new Map<string, number>();
  for (const front of fronts)
    perRevision.set(front.revision_id, (perRevision.get(front.revision_id) ?? 0) + 1);
  return fronts.map(front => {
    const several = (perRevision.get(front.revision_id) ?? 0) > 1;
    const title = `${front.problem.slug} · version ${front.revision}${several ? ` · ${front.objectives.map(measureLabel).join(', ')}` : ''}`;
    const rows = front.points.map(point => {
      const n = (counts.get(front.problem.slug) ?? 0) + 1;
      counts.set(front.problem.slug, n);
      const cell = byId.get(point.cell_id) ?? null;
      return {
        key: keyOf(front, point),
        label: `P${n}`,
        n,
        problem: front.problem.slug,
        revision: front.revision,
        point,
        cell,
        engine: cell?.engine_ref.name ?? point.engine,
      };
    });
    return { title, objectives: front.objectives, rows };
  });
}

/** The point's objectives as text, in the front's order: `cost 0.112, latency 440`. */
export function objectivesText(row: FrontRow, objectives: readonly string[]): string {
  return objectives
    .map(name => `${measureLabel(name).toLowerCase()} ${formatMeasure(row.point.objectives[name])}`)
    .join(', ');
}

/** Whether every word of the search is in the point's label, problem, cell, engine, seed or objective values. */
export function matchesSearch(
  row: FrontRow,
  objectives: readonly string[],
  query: string
): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [
    row.label,
    row.problem,
    `version ${row.revision}`,
    row.engine,
    row.point.engine,
    row.cell ? `cell ${row.cell.ordinal} seed ${row.cell.seed}` : '',
    objectivesText(row, objectives),
  ]
    .join(' ')
    .toLowerCase();
  return words.every(word => text.includes(word));
}

/** What the derive dialog's batch mode is given for a point: its run and solution, and the default address `<problem>-p<n>`. */
export function frontPointOf(row: FrontRow, objectives: readonly string[]): FrontPoint {
  const where = row.cell ? ` · cell ${row.cell.ordinal}` : '';
  return {
    key: row.key,
    label: row.label,
    detail: `${row.problem} version ${row.revision}${where} · ${row.engine} · ${objectivesText(row, objectives)}`,
    run: row.point.job_id,
    point: row.point.solution_index,
    slug: pointSlug(row.problem, row.n),
    name: `${row.problem} ${row.label}`,
  };
}
