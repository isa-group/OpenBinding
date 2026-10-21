import type {
  AnalysisView, ArchiveResponse, ArchiveRow, ArchiveSource, BudgetMap, DecisionRule, Dimension, Geometry,
} from '../../analysis/archive';
import { shortDigest } from '../../utils/digest';

export const VIEWS: ReadonlyArray<{ id: AnalysisView; label: string }> = [
  { id: 'decision', label: 'Decision' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'pareto', label: 'Trade-off front' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'evidence', label: 'Evidence' },
];

export function viewOf(value: string | null): AnalysisView {
  return VIEWS.find((view) => view.id === value)?.id ?? 'decision';
}

export const RULES: Record<DecisionRule, string> = {
  balanced: 'Balanced compromise',
  weighted: 'Weighted sum',
  ideal: 'Distance to ideal',
  chebyshev: 'Worst weighted loss',
  reference: 'Distance to reference',
  topsis: 'TOPSIS',
  model: 'Original model ordering',
};

const TERMINAL = ['completed', 'failed', 'cancelled'];

/** A stored result can be analysed once its run is over, however it ended. */
export const isFinished = (source: Pick<ArchiveSource, 'state'>) => TERMINAL.includes(source.state);

export interface SourceGroup {
  key: string;
  irDigest: string | null;
  evaluatorDigest: string | null;
  sources: ArchiveSource[];
}

export interface GroupedSources {
  /** Finished results that name their model and checker: only those of one group can be ranked together. */
  groups: SourceGroup[];
  /** Finished results recorded before model and checker identities existed: they open alone. */
  legacy: ArchiveSource[];
  /** Results that are not stored yet. */
  unfinished: ArchiveSource[];
}

export function groupSources(items: readonly ArchiveSource[]): GroupedSources {
  const groups = new Map<string, SourceGroup>();
  const legacy: ArchiveSource[] = [];
  const unfinished: ArchiveSource[] = [];
  for (const source of items) {
    if (!isFinished(source)) unfinished.push(source);
    else if (source.legacy || !source.irDigest || !source.evaluatorDigest) legacy.push(source);
    else {
      const key = `${source.irDigest}|${source.evaluatorDigest}`;
      const group = groups.get(key) ?? { key, irDigest: source.irDigest, evaluatorDigest: source.evaluatorDigest, sources: [] };
      group.sources.push(source);
      groups.set(key, group);
    }
  }
  return { groups: [...groups.values()], legacy, unfinished };
}

/** `Model sha256-c3d4…e5f6 · checked by sha256-1a2b…3c4d`, the identity a group of results shares. */
export function groupTitle(group: Pick<SourceGroup, 'irDigest' | 'evaluatorDigest'>): string {
  return `Model ${group.irDigest ? shortDigest(group.irDigest) : 'unknown'} · checked by ${group.evaluatorDigest ? shortDigest(group.evaluatorDigest) : 'unknown'}`;
}

export const sourceName = (source: Pick<ArchiveSource, 'engine' | 'id'>) => `${source.engine} · job ${source.id.slice(0, 8)}…`;

export const searchOfSources = (ids: readonly string[]) => ids.map((id) => `job=${encodeURIComponent(id)}`).join('&');

export interface Target {
  jobs: string[];
  /** A saved decision to reopen: `organization/project/report`. */
  report: { org: string; project: string; slug: string } | null;
  /** Study evidence: a whole run, or one of its cells. `org` and `project` fall back to the workspace's current ones. */
  study: { org: string | null; project: string | null; study: string; run: string; cell: string | null } | null;
}

export function targetOf(params: URLSearchParams): Target {
  const [org, project, slug] = (params.get('report') ?? '').split('/');
  const study = params.get('study');
  const run = params.get('run');
  return {
    jobs: params.getAll('job').filter(Boolean),
    report: org && project && slug ? { org, project, slug } : null,
    study: study && run ? { org: params.get('org'), project: params.get('project'), study, run, cell: params.get('cell') } : null,
  };
}

/** The part of the address that names the evidence, not how it is looked at: a change in it rebuilds the analysis. */
export function evidenceKey(params: URLSearchParams): string {
  const copy = new URLSearchParams(params);
  copy.delete('view');
  return copy.toString();
}

export const percent = (value: number) => `${(value * 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}%`;

export function activeDimensions(dimensions: readonly Dimension[]): Dimension[] {
  return dimensions.filter((dimension) => !dimension.constant);
}

/** The colour of each objective in the priority bars: the brand scale, light to deep, then greys. */
/** One colour per objective, from the design tokens (they are written as `var()` because they end up in inline styles). */
export const OBJECTIVE_COLOURS = [
  'var(--tp-primary)', 'var(--tp-sunshine-500)', 'var(--tp-primary-deep)', 'var(--tp-yellow-saturated)', 'var(--tp-sunshine-800)', 'var(--tp-muted)',
];

/** One row's weighted losses as shares of the longest bar on the page, so a short bar reads as "close to ideal". */
export function lossSegments(row: ArchiveRow, data: ArchiveResponse, longest: number): Array<{ key: string; width: number; colour: string }> {
  if (!row.normalized) return [];
  return data.dimensions.flatMap((dimension, index) => {
    if (dimension.constant) return [];
    const loss = (row.normalized?.[index] ?? 0) * (data.weights[dimension.key] ?? 0);
    return loss > 0 ? [{ key: dimension.key, width: Math.min(100, (loss / longest) * 100), colour: OBJECTIVE_COLOURS[index % OBJECTIVE_COLOURS.length] }] : [];
  });
}

export function longestLoss(rows: readonly ArchiveRow[], data: ArchiveResponse): number {
  let longest = 0;
  for (const row of rows) {
    const total = data.dimensions.reduce((sum, dimension, index) => sum + (dimension.constant ? 0 : (row.normalized?.[index] ?? 0) * (data.weights[dimension.key] ?? 0)), 0);
    longest = Math.max(longest, total);
  }
  return longest || 1;
}

export interface Rung {
  id: string;
  budget: number;
  achieved: number;
  /** How far along the budget axis the rung sits, 0–100. */
  position: number;
}

/** The stairs of the budget map as rungs: for each budget on the first axis, the best value of the second that some binding reaches. */
export function budgetRungs(budgets: BudgetMap): Rung[] {
  const [low, , high] = budgets.bounds;
  const span = high - low || 1;
  return budgets.corners.map((corner) => ({
    id: corner.id,
    budget: corner.x * budgets.signs[0],
    achieved: corner.y * budgets.signs[1],
    position: Math.max(0, Math.min(100, ((corner.x - low) / span) * 100)),
  }));
}

export interface Stretch {
  from: number;
  to: number;
  winner: string | null;
  count: number;
}

/**
 * Where each binding wins as the priority shifts from none to all on one objective: the sampled scenarios, each covering the
 * span halfway to its neighbours, neighbours with the same first winner merged. Ties keep the first winner and say how many tied.
 */
export function stretchesOf(geometry: Geometry | null | undefined): Stretch[] {
  const scenarios = [...(geometry?.scenarios ?? [])].sort((a, b) => a.t - b.t);
  const out: Stretch[] = [];
  scenarios.forEach((scenario, index) => {
    const from = index === 0 ? 0 : (scenarios[index - 1].t + scenario.t) / 2;
    const to = index === scenarios.length - 1 ? 1 : (scenario.t + scenarios[index + 1].t) / 2;
    const winner = scenario.winners[0] ?? null;
    const last = out.at(-1);
    if (last && last.winner === winner) {
      last.to = to;
      last.count = Math.max(last.count, scenario.winnerCount);
    } else out.push({ from, to, winner, count: scenario.winnerCount });
  });
  return out;
}

export const counted = (value: number | undefined) => (value ?? 0).toLocaleString('en-US');
