import { useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { DataTable } from '../data-table';
import { formatFeature, type FeatureValue } from '../../../../utils/featureRange';
import type {
  CandidateMatrix as Matrix,
  MatrixCandidate,
  MatrixCell,
  MatrixFeature,
  MatrixRow,
} from '../../utils/binding/candidateMatrix';
import { ValueBadge } from '../value-badge/ValueBadge';
import './CandidateMatrix.css';

interface CandidateMatrixProps {
  matrix: Matrix;
  /** `view` reads; `select` makes each task a radio group; `edit` hands every cell to `renderCell`. */
  mode: 'view' | 'select' | 'edit';
  onSelect?: (task: string, candidate: string) => void;
  /** What a cell shows instead of its value (an editor's input, in `edit` mode). */
  renderCell?: (cell: MatrixCell, candidate: MatrixCandidate, row: MatrixRow) => ReactNode;
  /** What a candidate's name shows instead of its written name (an editor's button that opens the candidate, in `edit` mode). */
  renderName?: (candidate: MatrixCandidate, row: MatrixRow) => ReactNode;
  /** The accessible name of the matrix. */
  label: string;
  /** Short words beside a candidate's name (the versions that chose it, when two are compared). */
  tags?: (task: string, candidate: string) => readonly string[];
}

const NARROW = '(max-width: 640px)';
const COLUMNS_KEY = 'openbinding.candidate-matrix.more-features';

/** Below 640 px each candidate is a card. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    notify => {
      const list = typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null;
      list?.addEventListener?.('change', notify);
      return () => list?.removeEventListener?.('change', notify);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(NARROW).matches : false),
    () => false
  );
}

/** The features beyond the required ones this viewer chose to see; nothing is kept where storage is unavailable. */
function readShown(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(COLUMNS_KEY) ?? '[]');
    return Array.isArray(stored)
      ? stored.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeShown(shown: string[]): void {
  try {
    window.localStorage.setItem(COLUMNS_KEY, JSON.stringify(shown));
  } catch {
    // A private window or a full storage: the choice holds until the page is left.
  }
}

/** A unit as a header suffix; `"1"` is a bare number and shows none. */
const unitOf = (unit: string): string | null => (unit && unit !== '1' ? unit : null);
const headerOf = (feature: MatrixFeature) =>
  unitOf(feature.unit) ? `${feature.id} (${feature.unit})` : feature.id;

/** The finite ends of a value, which the bars of a column are drawn against. */
const finiteEnds = (value: FeatureValue | null): number[] => {
  if (value === null) return [];
  return (typeof value === 'number' ? [value] : [value.min, value.max]).filter(
    (end): end is number => end !== null
  );
};

/** A value as a bar: how far a number reaches, or the stretch a range covers (an open end runs off the bar, faded, with an arrow). */
function FeatureBar({ value, maximum }: { value: FeatureValue; maximum: number }) {
  const at = (end: number) => (maximum ? Math.min(1, Math.abs(end) / maximum) : 0);
  if (typeof value === 'number') {
    return (
      <span className="cm-bar" aria-hidden="true">
        <i style={{ width: `${Math.round(at(value) * 100)}%` }} />
      </span>
    );
  }
  const low = value.min === null ? 0 : at(value.min);
  const high = value.max === null ? 1 : at(value.max);
  const [from, to] = low <= high ? [low, high] : [high, low];
  const classes = [
    value.min === null ? 'is-open-low' : '',
    value.max === null ? 'is-open-high' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className="cm-bar is-interval" aria-hidden="true">
      <i
        className={classes || undefined}
        style={{ left: `${Math.round(from * 100)}%`, width: `${Math.round((to - from) * 100)}%` }}
      />
    </span>
  );
}

function Value({ cell, maximum }: { cell: MatrixCell; maximum: number }) {
  if (cell.value === null) return <span className="cm-none">not declared</span>;
  const unit = unitOf(cell.unit);
  const range = typeof cell.value !== 'number';
  return (
    <span className="cm-cell">
      <FeatureBar value={cell.value} maximum={maximum} />
      <span
        className={range ? 'cm-range' : undefined}
        title={range ? formatFeature(cell.value, { long: true, unit }) : undefined}
      >
        {formatFeature(cell.value, { unit })}
      </span>
      <ValueBadge origin={cell.origin} compact />
    </span>
  );
}

interface TaskProps {
  row: MatrixRow;
  features: Array<{ feature: MatrixFeature; index: number }>;
  mode: CandidateMatrixProps['mode'];
  onSelect?: CandidateMatrixProps['onSelect'];
  renderCell?: CandidateMatrixProps['renderCell'];
  renderName?: CandidateMatrixProps['renderName'];
  tags?: CandidateMatrixProps['tags'];
  narrow: boolean;
  group: string;
}

function TaskCandidates({
  row,
  features,
  mode,
  onSelect,
  renderCell,
  renderName,
  tags,
  narrow,
  group,
}: TaskProps) {
  const maxima = features.map(({ index }) =>
    Math.max(
      0,
      ...row.candidates.flatMap(candidate => finiteEnds(candidate.cells[index].value).map(Math.abs))
    )
  );
  const content = (candidate: MatrixCandidate, column: number, index: number) => {
    const cell = candidate.cells[index];
    return mode === 'edit' && renderCell ? (
      renderCell(cell, candidate, row)
    ) : (
      <Value cell={cell} maximum={maxima[column]} />
    );
  };
  const name = (candidate: MatrixCandidate) =>
    mode === 'edit' && renderName ? renderName(candidate, row) : <code>{candidate.written}</code>;
  const radio = (candidate: MatrixCandidate) => (
    <input
      type="radio"
      name={`${group}-${row.task}`}
      checked={candidate.selected}
      onChange={() => onSelect?.(row.task, candidate.key)}
      aria-label={`${candidate.written} for ${row.task}`}
    />
  );
  const count = row.candidates.length === 1 ? '1 candidate' : `${row.candidates.length} candidates`;
  const tagsOf = (candidate: MatrixCandidate) =>
    (tags?.(row.task, candidate.key) ?? []).map(tag => (
      <span key={tag} className="cm-tag">
        {tag}
      </span>
    ));

  const body = narrow ? (
    <ul className="cm-cards" aria-label={`Candidates for ${row.task}`}>
      {row.candidates.map(candidate => (
        <li
          key={candidate.key}
          className={`cm-card${candidate.selected ? ' is-selected' : ''}`}
          aria-current={candidate.selected ? 'true' : undefined}
        >
          <div className="cm-card-head">
            {mode === 'select' && radio(candidate)}
            {name(candidate)}
            {candidate.selected && <span className="cm-selected">Selected</span>}
            {tagsOf(candidate)}
          </div>
          <dl>
            <div>
              <dt>Provider</dt>
              <dd>{candidate.provider ?? '—'}</dd>
            </div>
            {features.map(({ feature, index }, column) => (
              <div key={feature.id}>
                <dt>{headerOf(feature)}</dt>
                <dd>{content(candidate, column, index)}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  ) : (
    <DataTable
      label={`Candidates for ${row.task}`}
      caption={
        <>
          Task <code>{row.task}</code> · {count}
        </>
      }
      minWidth={Math.min(640, 280 + features.length * 120)}
    >
      <thead>
        <tr>
          {mode === 'select' && (
            <th scope="col">
              <span className="sr-only">Choose</span>
            </th>
          )}
          <th scope="col">Candidate</th>
          <th scope="col">Provider</th>
          {features.map(({ feature }) => (
            <th scope="col" key={feature.id}>
              {headerOf(feature)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {row.candidates.map(candidate => (
          <tr
            key={candidate.key}
            className={candidate.selected ? 'cm-row is-selected' : 'cm-row'}
            aria-current={candidate.selected ? 'true' : undefined}
          >
            {mode === 'select' && <td>{radio(candidate)}</td>}
            <th scope="row">
              {name(candidate)}
              {candidate.selected && <span className="cm-selected">Selected</span>}
              {tagsOf(candidate)}
            </th>
            <td>{candidate.provider ?? '—'}</td>
            {features.map(({ feature, index }, column) => (
              <td key={feature.id}>{content(candidate, column, index)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </DataTable>
  );

  return mode === 'select' ? (
    <div className="cm-task" role="radiogroup" aria-label={`Candidate for ${row.task}`}>
      {body}
    </div>
  ) : (
    <div className="cm-task">{body}</div>
  );
}

/** The candidates of every task: one table per task (a card per candidate on a phone), required features first. */
export function CandidateMatrix({
  matrix,
  mode,
  onSelect,
  renderCell,
  renderName,
  label,
  tags,
}: CandidateMatrixProps) {
  const narrow = useNarrow();
  const group = useId();
  const [shown, setShown] = useState<string[]>(readShown);
  const extras = matrix.features.filter(feature => !feature.required);
  const features = matrix.features
    .map((feature, index) => ({ feature, index }))
    .filter(({ feature }) => feature.required || shown.includes(feature.id));
  const toggle = (id: string) => {
    const next = shown.includes(id) ? shown.filter(item => item !== id) : [...shown, id];
    setShown(next);
    writeShown(next);
  };

  return (
    <section className="cm" aria-label={label}>
      {extras.length > 0 && (
        <details className="cm-more">
          <summary>More features ({extras.length})</summary>
          <fieldset>
            <legend className="sr-only">Features to show besides the required ones</legend>
            {extras.map(feature => (
              <label key={feature.id}>
                <input
                  type="checkbox"
                  checked={shown.includes(feature.id)}
                  onChange={() => toggle(feature.id)}
                />
                {headerOf(feature)}
              </label>
            ))}
          </fieldset>
        </details>
      )}
      {matrix.rows.map(row => {
        if (row.kind === 'local') {
          return (
            <p key={row.task} className="cm-local">
              <code>{row.task}</code> is a local task: it gets no candidate.
            </p>
          );
        }
        if (row.candidates.length === 0) {
          return (
            <p key={row.task} className="cm-local">
              <code>{row.task}</code> has no candidate that can serve it.
            </p>
          );
        }
        return (
          <TaskCandidates
            key={row.task}
            row={row}
            features={features}
            mode={mode}
            onSelect={onSelect}
            renderCell={renderCell}
            renderName={renderName}
            tags={tags}
            narrow={narrow}
            group={group}
          />
        );
      })}
    </section>
  );
}
