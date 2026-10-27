import type { ReactNode } from 'react';
import { DataTable } from '../ui/DataTable';
import {
  MAX_NOTES,
  MAX_ROWS,
  evaluationDiffOf,
  shortText,
  type DiffField,
  type DiffRow,
  type DiffValue,
  type RunValues,
} from './evaluationDiffModel';
import './EvaluationDiff.css';

export interface Downgrade {
  code: string;
  message: string;
  /** 0-based position in the engine's claimed solutions. */
  solution?: number;
}

interface EvaluationDiffProps {
  evaluated: RunValues;
  claimed?: RunValues | null;
  notes?: string[];
  downgrades?: Downgrade[];
  label?: string;
}

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Engine text: one text node in its own `bdi`, shortened. Never markup. */
const engineText = (text: string) => <bdi>{shortText(text)}</bdi>;

function cell(value: DiffValue, side: 'claimed' | 'evaluated', exact: boolean): ReactNode {
  const fmt = (n: number) => (exact ? String(n) : number.format(n));
  switch (value.kind) {
    case 'number':
      return fmt(value.value);
    case 'list':
      return value.values.map(fmt).join(', ');
    case 'text':
      return value.text === null ? 'no termination' : engineText(value.text);
    case 'absent':
      return side === 'claimed' ? 'not stated' : 'not evaluated';
    case 'invalid':
      return 'not a number';
  }
}

function fieldName(field: DiffField): ReactNode {
  switch (field.kind) {
    case 'termination':
      return 'Termination';
    case 'solutions':
      return 'Solutions';
    case 'feature':
      return engineText(field.name);
    case 'score':
      return field.component === null ? 'Score' : `Score, component ${field.component}`;
  }
}

/** Both sides are numbers that read the same at six decimals: show them unrounded so they stay apart. */
function needsExact({ claimed, evaluated }: DiffRow): boolean {
  return claimed.kind === 'number' && evaluated.kind === 'number' && number.format(claimed.value) === number.format(evaluated.value);
}

/** Engine-claimed against gateway-evaluated values, with the engine's notes and the gateway's downgrade reasons. */
// [impl->req~frontend-rendering-evaluation-diff~1]
export function EvaluationDiff({ evaluated, claimed, notes, downgrades, label = 'Claimed and evaluated values' }: EvaluationDiffProps) {
  const view = evaluationDiffOf(evaluated, claimed);
  const termination = view.evaluated.termination ?? 'no termination';
  const solutions = plural(view.evaluated.solutions, 'solution', 'solutions');
  const shown = view.rows.slice(0, MAX_ROWS);
  const hiddenRows = view.rows.length - shown.length;

  const noteItems = Array.isArray(notes) ? notes.filter((n) => typeof n === 'string' && n.trim() !== '') : [];
  const hiddenNotes = Math.max(0, noteItems.length - MAX_NOTES);
  const reasons = (Array.isArray(downgrades) ? downgrades : []).filter(
    (d) => typeof d === 'object' && d !== null && typeof d.message === 'string' && d.message !== '',
  );

  return (
    <section aria-label={label} className="evaluation-diff">
      <p>
        {view.status === 'no-claim' && `The values the engine claimed are not kept for this run. Gateway evaluation: ${termination}, ${solutions}.`}
        {view.status === 'agrees' && `The engine claim agrees with the gateway evaluation: ${termination}, ${solutions}.`}
        {view.status === 'differs' && `The engine claim differs from the gateway evaluation in ${plural(view.rows.length, 'value', 'values')}.`}
      </p>
      {view.claimed && !view.paired && (
        <p className="evaluation-diff__hint">Solutions are compared one by one only when both sides have the same number of solutions.</p>
      )}
      {shown.length > 0 && (
        <>
          <DataTable label="Differences" minWidth={480}>
            <thead>
              <tr>
                <th scope="col">Solution</th>
                <th scope="col">Value</th>
                <th scope="col">Engine claimed</th>
                <th scope="col">Gateway evaluated</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => {
                const exact = needsExact(row);
                return (
                  <tr key={i}>
                    <td>{row.solution === null ? 'Run' : row.solution}</td>
                    <td>{fieldName(row.field)}</td>
                    <td>{cell(row.claimed, 'claimed', exact)}</td>
                    <td>{cell(row.evaluated, 'evaluated', exact)}</td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          {hiddenRows > 0 && (
            <p className="evaluation-diff__more">{hiddenRows === 1 ? '1 more difference is not shown.' : `${hiddenRows} more differences are not shown.`}</p>
          )}
        </>
      )}
      {reasons.length > 0 && (
        <ul aria-label="Why the gateway changed the result" className="evaluation-diff__list">
          {reasons.map((d, i) => (
            <li key={i}>
              {Number.isInteger(d.solution) && (d.solution as number) >= 0 && (
                <>
                  <strong>{`Solution ${(d.solution as number) + 1}`}</strong>{' '}
                </>
              )}
              {engineText(d.message)}
              {typeof d.code === 'string' && d.code !== '' && (
                <>
                  {' '}
                  <bdi>
                    <code>{shortText(d.code)}</code>
                  </bdi>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {noteItems.length > 0 && (
        <>
          <ul aria-label="Engine notes" className="evaluation-diff__list">
            {noteItems.slice(0, MAX_NOTES).map((n, i) => (
              <li key={i}>{engineText(n)}</li>
            ))}
          </ul>
          {hiddenNotes > 0 && (
            <p className="evaluation-diff__more">{hiddenNotes === 1 ? '1 more note is not shown.' : `${hiddenNotes} more notes are not shown.`}</p>
          )}
        </>
      )}
    </section>
  );
}
