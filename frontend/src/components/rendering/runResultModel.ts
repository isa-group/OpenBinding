import type { BindingProblemShape } from './bindingTableModel';
import type { ObjectiveProblem } from './objectiveModel';

export interface RunResultData { termination?: unknown; solutions?: unknown; logs?: unknown }
/** What readBindingProblem(document) returns fits as it is. */
export type RunProblem = BindingProblemShape & ObjectiveProblem;
export interface RunReport { remote?: unknown }

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (object: unknown, key: string): unknown => (isPlain(object) && Object.hasOwn(object, key) ? object[key] : undefined);

/** The termination as the badge shows it: a non-empty string, else UNKNOWN. */
// [impl->req~frontend-rendering-run-result-verdict~1]
export function verdictOf(termination: unknown): string {
  return typeof termination === 'string' && termination !== '' ? termination : 'UNKNOWN';
}

/** The plain-object entries of `result.solutions`, in order. */
// [impl->req~frontend-rendering-run-result-canonical-shape~1]
export function solutionsOf(result: RunResultData): Record<string, unknown>[] {
  const solutions = own(result, 'solutions');
  return Array.isArray(solutions) ? solutions.filter(isPlain) : [];
}

/** The finite numbers of `features`, else of `metrics`; `objectives.mode` is never read. */
// [impl->req~frontend-rendering-run-result-canonical-shape~1]
export function figuresOf(solution: Record<string, unknown>): Array<[string, number]> {
  const features = own(solution, 'features');
  const source = isPlain(features) ? features : own(solution, 'metrics');
  if (!isPlain(source)) return [];
  const figures: Array<[string, number]> = [];
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value)) figures.push([name, value]);
  }
  return figures;
}

/** `objectives.type` of the first solution that has a non-empty one. */
// [impl->req~frontend-rendering-run-result-canonical-shape~1]
export function optimizationTypeOf(solutions: Record<string, unknown>[]): string | null {
  for (const solution of solutions) {
    const type = own(own(solution, 'objectives'), 'type');
    if (typeof type === 'string' && type !== '') return type;
  }
  return null;
}

/** Feature name -> unit of the problem; `{}` without one. */
// [impl->req~frontend-rendering-run-result-canonical-shape~1]
export function unitsOf(problem: RunProblem | null | undefined): Record<string, string | null> {
  const units: Record<string, string | null> = {};
  if (!problem) return units;
  for (const [name, feature] of Object.entries(problem.features)) units[name] = feature.unit;
  return units;
}

/** The string items of `report.remote.divergence.notes`. */
// [impl->req~frontend-rendering-run-result-claimed-values~1]
export function notesOf(report: RunReport | null | undefined): string[] {
  const notes = own(own(own(report, 'remote'), 'divergence'), 'notes');
  return Array.isArray(notes) ? notes.filter((note): note is string => typeof note === 'string') : [];
}

/** `report.remote` when it is an object with at least one own key. */
// [impl->req~frontend-rendering-run-result-source~1]
export function remoteOf(report: RunReport | null | undefined): Record<string, unknown> | null {
  const remote = own(report, 'remote');
  return isPlain(remote) && Object.keys(remote).length > 0 ? remote : null;
}
