import { isComparisonWord, type ComparisonWord } from '../../../entities/binding/comparison';
import type { CompositionViewModel } from '../../../entities/composition/viewModel';
import type { CompositionMove } from '../../../shared/api/types';
import type { WrittenBinding } from './analysis';

// The calculator's rows: the toolchain's one-task moves of a version's binding, as the gateway answered them. The model only places
// the gateway's fields, filters them by what a person types or picks, and orders them by task and then the gateway's own order. It
// never computes a delta, compares two numbers or ranks a move: the comparison word and every delta are the gateway's.

/** One change of the version's binding as it reaches the screen. */
export interface MoveRow {
  /** Where the gateway listed the move (its order is kept within a task). */
  index: number;
  task: string;
  /** The candidate the version binds the task to, as its document writes it; null when the document binds it to none. */
  from: string | null;
  /** The candidate the move binds instead, as the gateway names it for a document (`candidate`). */
  to: string;
  /** The provider of `to`, from the linked problem's facts; null when they do not say. */
  provider: string | null;
  comparison: ComparisonWord | null;
  /** The gateway's word as it sent it, for a word this frontend does not know. */
  comparisonSent: string;
  feasible: boolean;
  /** `componentDeltas` as returned: the change of each objective component's value and loss. */
  deltas: Array<{
    feature: string;
    value: number | null;
    loss: number | null;
    unit: string | null;
  }>;
  penaltyDelta: number;
  /** The rules the move breaks, as the gateway words them. */
  violations: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The version's binding as its document writes it: every task bound to a candidate (local tasks are bound on their own). */
export function writtenBinding(model: Pick<CompositionViewModel, 'tasks'>): WrittenBinding {
  return Object.fromEntries(
    model.tasks.flatMap(task =>
      task.local || task.candidate === null ? [] : [[task.id, task.candidate]]
    )
  );
}

/** The version's binding with one task bound otherwise. */
export function withMove(binding: WrittenBinding, task: string, candidate: string): WrittenBinding {
  return { ...binding, [task]: candidate };
}

/** The provider of a candidate a task can take, as the linked problem's facts name it (by its written name in that task). */
function providerOf(
  model: Pick<CompositionViewModel, 'matrix'>,
  task: string,
  written: string
): string | null {
  const row = model.matrix?.rows.find(item => item.task === task);
  return row?.candidates.find(candidate => candidate.written === written)?.provider ?? null;
}

/** A rule a move breaks, in the gateway's words: its message, else the rule it names. */
export function violationText(violation: Record<string, unknown>): string {
  if (typeof violation.message === 'string' && violation.message) return violation.message;
  const constraint = isRecord(violation.constraint) ? violation.constraint : {};
  const name = [constraint.resource, constraint.id]
    .filter(part => typeof part === 'string' && part)
    .join('/');
  return name ? `Breaks ${name}` : 'Breaks a rule';
}

/** The rows of a neighbourhood, in the gateway's order. */
export function moveRows(
  moves: readonly CompositionMove[],
  model: Pick<CompositionViewModel, 'tasks' | 'matrix'>
): MoveRow[] {
  const current = writtenBinding(model);
  const units = new Map((model.matrix?.features ?? []).map(feature => [feature.id, feature.unit]));
  return moves.map((move, index) => ({
    index,
    task: move.task,
    from: current[move.task] ?? null,
    to: move.candidate,
    provider: providerOf(model, move.task, move.candidate),
    comparison: isComparisonWord(move.comparison) ? move.comparison : null,
    comparisonSent: String(move.comparison),
    feasible: move.feasible,
    deltas: move.componentDeltas.filter(isRecord).map(delta => {
      const feature = typeof delta.feature === 'string' ? delta.feature : 'value';
      return {
        feature,
        value: finite(delta.value),
        loss: finite(delta.loss),
        unit: units.get(feature) ?? null,
      };
    }),
    penaltyDelta: move.penaltyDelta,
    violations: move.violations.filter(isRecord).map(violationText),
  }));
}

/** What a person narrows the moves to: a text found in a candidate or provider name, one task, one comparison word. */
export interface MoveFilter {
  query: string;
  task: string;
  comparison: string;
}

export const NO_FILTER: MoveFilter = { query: '', task: '', comparison: '' };

/** The rows the filter keeps, by task and then the gateway's order. */
export function visibleRows(rows: readonly MoveRow[], filter: MoveFilter): MoveRow[] {
  const needle = filter.query.trim().toLowerCase();
  const found = (text: string | null) => text !== null && text.toLowerCase().includes(needle);
  return rows
    .filter(row => !filter.task || row.task === filter.task)
    .filter(row => !filter.comparison || row.comparisonSent === filter.comparison)
    .filter(row => !needle || found(row.to) || found(row.from) || found(row.provider))
    .sort((a, b) => (a.task === b.task ? a.index - b.index : a.task < b.task ? -1 : 1));
}

/** The tasks and the comparison words the rows have, each once, in the order the rows meet them. */
export function rowChoices(rows: readonly MoveRow[]): { tasks: string[]; comparisons: string[] } {
  const ordered = visibleRows(rows, NO_FILTER);
  return {
    tasks: [...new Set(ordered.map(row => row.task))],
    comparisons: [...new Set(ordered.map(row => row.comparisonSent))],
  };
}

const SIGNED = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 6,
  signDisplay: 'exceptZero',
});

/** A delta the gateway computed, with its sign as written (`+20`, `−0.5`, `0`). */
export function signed(value: number): string {
  return SIGNED.format(value).replace('-', '−');
}
