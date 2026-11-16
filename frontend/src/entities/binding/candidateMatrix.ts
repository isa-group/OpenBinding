import type { FeatureRange } from '../../utils/featureRange';
import type { ProblemFacts, ProblemValueOrigin } from '../../shared/api/types';

/**
 * The candidate matrix view-model: for every task of a problem, the candidates it can take with their values, one column
 * per feature. Its input is a problem's facts (A5), so eligibility, written names, units and origins are the gateway's; the
 * matrix only places them. A candidate's key (`<resource>/<id>`) is opaque: it is compared, never parsed.
 */

/** Where a value comes from. F2 knows only the package it is written in; F3 adds priced, guarantee, limit, feature, manual and measured. */
export type ValueOrigin = ProblemValueOrigin;

export interface MatrixCell {
  feature: string;
  /** A number, a range whose ends may be open (`null` is no limit), or `null` when the candidate declares no value. */
  value: number | FeatureRange | null;
  /** The feature's unit as written (`"1"` for a bare number). */
  unit: string;
  origin: ValueOrigin | null;
}

export interface MatrixCandidate {
  /** `<resource>/<id>`, opaque. */
  key: string;
  /** The name the problem writes for it in this task (what a composition's `binding` writes). */
  written: string;
  provider: string | null;
  cells: MatrixCell[];
  selected: boolean;
}

export interface MatrixRow {
  task: string;
  kind: 'service' | 'local';
  candidates: MatrixCandidate[];
}

export interface MatrixFeature {
  id: string;
  unit: string;
  direction: 'min' | 'max' | null;
  required: boolean;
}

export interface CandidateMatrix {
  /** Required features first, each group in the problem's order. */
  features: MatrixFeature[];
  /** In the problem's task order (the order a depth-first walk of the workflow meets them). */
  rows: MatrixRow[];
}

/** The matrix of a problem's facts. `selection` (task → candidate key, as `EvaluationView.binding` has it) marks the chosen candidates. */
export function candidateMatrix(
  facts: ProblemFacts,
  options: { selection?: Record<string, string> } = {}
): CandidateMatrix {
  const features: MatrixFeature[] = [
    ...facts.features.filter(feature => feature.required),
    ...facts.features.filter(feature => !feature.required),
  ].map(feature => ({
    id: feature.id,
    unit: feature.unit,
    direction: feature.direction ?? null,
    required: feature.required,
  }));
  const byKey = new Map(facts.candidates.map(candidate => [candidate.key, candidate]));
  const selection = options.selection ?? {};

  const rows: MatrixRow[] = facts.tasks.map(task => ({
    task: task.id,
    kind: task.kind,
    candidates:
      task.kind === 'local'
        ? []
        : task.eligible.map(eligible => {
            const candidate = byKey.get(eligible.candidate);
            return {
              key: eligible.candidate,
              written: eligible.written,
              provider: candidate?.provider ?? null,
              cells: features.map(feature => ({
                feature: feature.id,
                value:
                  candidate && Object.hasOwn(candidate.values, feature.id)
                    ? candidate.values[feature.id]
                    : null,
                unit: feature.unit,
                origin: candidate?.origins[feature.id] ?? null,
              })),
              selected: selection[task.id] === eligible.candidate,
            };
          }),
  }));
  return { features, rows };
}
