import type { CandidateMatrix } from '../../../entities/binding/candidateMatrix';
import type { CompositionViewModel } from '../../../entities/composition/viewModel';
import type { EvaluateResult } from '../../../shared/api/types';
import type { WrittenBinding } from './analysis';
import { writtenBinding } from './calculatorModel';

// The configurator's choices: which candidate each task takes, as candidate keys of the linked problem's facts (compared, never
// parsed), and what the gateway is asked to evaluate, as a document writes the candidates. Nothing here computes a value.

/** Task → candidate key (`<resource>/<id>`), as `EvaluationView.binding` and the matrix have them. */
export type Selection = Record<string, string>;

/** The selection a configurator starts from: the version's, with the tasks `start` names bound to the candidate it writes. */
export function startSelection(
  matrix: CandidateMatrix,
  base: Selection,
  start?: WrittenBinding
): Selection {
  const selection = { ...base };
  for (const [task, written] of Object.entries(start ?? {})) {
    const key = matrix.rows
      .find(row => row.task === task)
      ?.candidates.find(candidate => candidate.written === written)?.key;
    if (key) selection[task] = key;
  }
  return selection;
}

/** The matrix with `selection` marked. */
export function selectedMatrix(matrix: CandidateMatrix, selection: Selection): CandidateMatrix {
  return {
    ...matrix,
    rows: matrix.rows.map(row => ({
      ...row,
      candidates: row.candidates.map(candidate => ({
        ...candidate,
        selected: selection[row.task] === candidate.key,
      })),
    })),
  };
}

/** The tasks the selection binds otherwise than the version, each to its candidate as written: the body of `evaluate`. */
export function changedBinding(
  matrix: CandidateMatrix,
  base: Selection,
  selection: Selection
): WrittenBinding {
  const changed: WrittenBinding = {};
  for (const row of matrix.rows) {
    const key = selection[row.task];
    if (!key || key === base[row.task]) continue;
    const written = row.candidates.find(candidate => candidate.key === key)?.written;
    if (written) changed[row.task] = written;
  }
  return changed;
}

/** The whole binding of the selection as a document writes it: the version's, with the changed tasks bound otherwise. */
export function fullBinding(
  model: Pick<CompositionViewModel, 'tasks'>,
  changed: WrittenBinding
): WrittenBinding {
  return { ...writtenBinding(model), ...changed };
}

/** A version's values and an evaluated binding's, side by side by name: the version's in its order, then the others. Never subtracted. */
export function sideBySide(
  version: ReadonlyArray<{ name: string; value: number; unit: string }>,
  evaluated: EvaluateResult['values']
): Array<{
  name: string;
  version: { value: number; unit: string } | null;
  evaluated: { value: number; unit: string } | null;
}> {
  const names = [
    ...version.map(item => item.name),
    ...Object.keys(evaluated).filter(name => !version.some(item => item.name === name)),
  ];
  return names.map(name => {
    const mine = version.find(item => item.name === name);
    const theirs = Object.hasOwn(evaluated, name) ? evaluated[name] : undefined;
    return {
      name,
      version: mine ? { value: mine.value, unit: mine.unit } : null,
      evaluated: theirs ? { value: theirs.value, unit: theirs.unit } : null,
    };
  });
}
