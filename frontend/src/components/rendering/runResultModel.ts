import type { BindingProblemShape } from './bindingTableModel';
import type { ObjectiveProblem } from './objectiveModel';

export interface RunResultData { termination?: unknown; solutions?: unknown; logs?: unknown }
/** What readBindingProblem(document) returns fits as it is. */
export type RunProblem = BindingProblemShape & ObjectiveProblem;
export interface RunReport { remote?: unknown }

export function verdictOf(_termination: unknown): string {
  return '';
}

export function solutionsOf(_result: RunResultData): Record<string, unknown>[] {
  return [];
}

export function figuresOf(_solution: Record<string, unknown>): Array<[string, number]> {
  return [];
}

export function optimizationTypeOf(_solutions: Record<string, unknown>[]): string | null {
  return null;
}

export function unitsOf(_problem: RunProblem | null | undefined): Record<string, string | null> {
  return {};
}

export function notesOf(_report: RunReport | null | undefined): string[] {
  return [];
}

export function remoteOf(_report: RunReport | null | undefined): Record<string, unknown> | null {
  return null;
}
