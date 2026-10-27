/** One solution of the run, as plotted. */
export interface TradeOffPoint {
  /** Stable React key, `solution-<n>`. */
  id: string;
  /** Shown text, `Solution <n>`. */
  label: string;
  /** Criterion id -> component `value` (shown on axes and in the table). */
  values: Record<string, number>;
  /** Criterion id -> component `loss` (dominance only; lower is better). */
  losses: Record<string, number>;
}

export interface TradeOffChartProps {
  points: readonly TradeOffPoint[];
  /** Criterion ids in display order; the component needs at least two. */
  objectives: readonly string[];
  /** Name of the region. */
  label?: string;
}

/** Structural input of the model: the canonical solution, only the fields read here. */
export interface TradeOffSolution {
  objectives?: {
    components?: ReadonlyArray<{ criteria?: unknown; value?: unknown; loss?: unknown }> | null;
  } | null;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Reads the canonical `objectives.components` of each solution; a solution without a counted component gives no point. */
// [impl->req~frontend-rendering-trade-off-chart~1]
export function tradeOffPointsOf(solutions: readonly TradeOffSolution[]): TradeOffPoint[] {
  const points: TradeOffPoint[] = [];
  solutions.forEach((solution, index) => {
    const components = solution?.objectives?.components;
    if (!Array.isArray(components)) return;
    const values: Record<string, number> = {};
    const losses: Record<string, number> = {};
    for (const c of components) {
      if (!c || typeof c.criteria !== 'string' || c.criteria === '') continue;
      if (!isFiniteNumber(c.value) || !isFiniteNumber(c.loss)) continue;
      if (Object.prototype.hasOwnProperty.call(values, c.criteria)) continue;
      values[c.criteria] = c.value;
      losses[c.criteria] = c.loss;
    }
    if (Object.keys(values).length === 0) return;
    points.push({ id: `solution-${index + 1}`, label: `Solution ${index + 1}`, values, losses });
  });
  return points;
}

/** The criteria every point carries, in the order of the first point. */
// [impl->req~frontend-rendering-trade-off-chart~1]
export function tradeOffObjectivesOf(points: readonly TradeOffPoint[]): string[] {
  if (points.length === 0) return [];
  return Object.keys(points[0].values).filter((o) =>
    points.every((p) => Object.prototype.hasOwnProperty.call(p.values, o) && Object.prototype.hasOwnProperty.call(p.losses, o)));
}

function dominates(a: TradeOffPoint, b: TradeOffPoint, objectives: readonly string[]): boolean {
  let strictly = false;
  for (const o of objectives) {
    if (a.losses[o] > b.losses[o]) return false;
    if (a.losses[o] < b.losses[o]) strictly = true;
  }
  return strictly;
}

/** The points no other point dominates by `loss` (lower is better), in input order. */
// [impl->req~frontend-rendering-trade-off-chart~1]
export function nonDominated(points: readonly TradeOffPoint[], objectives?: readonly string[]): TradeOffPoint[] {
  const keys = objectives ?? tradeOffObjectivesOf(points);
  return points.filter((p) => !points.some((q) => q !== p && dominates(q, p, keys)));
}
