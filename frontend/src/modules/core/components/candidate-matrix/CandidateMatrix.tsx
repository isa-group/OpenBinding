import { useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { MdOpenInNew } from 'react-icons/md';
import { DataTable } from '../data-table';
import { formatFeature, type FeatureValue } from '../../utils/featureRange';
import type {
  CandidateMatrix as Matrix,
  MatrixCandidate,
  MatrixCell,
  MatrixFeature,
  MatrixRow,
  PropertyCell,
} from '../../utils/binding/candidateMatrix';
import { planText } from '../value-badge/originText';
import { ValueBadge } from '../value-badge/ValueBadge';

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

const BAR = 'inline-block h-1.5 w-14 flex-none rounded-full bg-tp-hairline-soft align-middle';
const ARROW_LOW =
  "before:absolute before:-top-0.5 before:-left-[7px] before:text-[10px] before:leading-[10px] before:text-tp-primary before:content-['◂']";
const ARROW_HIGH =
  "after:absolute after:-top-0.5 after:-right-[7px] after:text-[10px] after:leading-[10px] after:text-tp-primary after:content-['▸']";
const SELECTED =
  'ml-2 inline-block rounded-full border border-tp-status-verified px-1.5 text-[11px] font-semibold text-tp-ink-tint';
const CARD_ROW = 'flex flex-wrap justify-between gap-x-3 gap-y-1';

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
      <span className={`${BAR} overflow-hidden`} aria-hidden="true">
        <i
          className="block h-full rounded-full bg-tp-primary"
          style={{ width: `${Math.round(at(value) * 100)}%` }}
        />
      </span>
    );
  }
  const low = value.min === null ? 0 : at(value.min);
  const high = value.max === null ? 1 : at(value.max);
  const [from, to] = low <= high ? [low, high] : [high, low];
  const openLow = value.min === null;
  const openHigh = value.max === null;
  const open = openLow && openHigh ? 'both' : openLow ? 'low' : openHigh ? 'high' : undefined;
  const fill =
    open === 'both'
      ? 'bg-[repeating-linear-gradient(to_right,var(--color-tp-primary)_0_4px,transparent_4px_7px)]'
      : open === 'low'
        ? 'rounded-l-none bg-linear-to-r from-transparent to-tp-primary'
        : open === 'high'
          ? 'rounded-r-none bg-linear-to-l from-transparent to-tp-primary'
          : 'bg-tp-primary';
  const arrows = `${openLow ? ARROW_LOW : ''} ${openHigh ? ARROW_HIGH : ''}`;
  return (
    <span className={`${BAR} relative`} data-cm-bar="interval" aria-hidden="true">
      <i
        data-open={open}
        className={`absolute top-0 block h-full min-w-[3px] rounded-full ${fill} ${arrows}`}
        style={{ left: `${Math.round(from * 100)}%`, width: `${Math.round((to - from) * 100)}%` }}
      />
    </span>
  );
}

function Value({ cell, maximum }: { cell: MatrixCell; maximum: number }) {
  if (cell.value === null) return <span className="text-xs text-tp-stone">not declared</span>;
  const unit = unitOf(cell.unit);
  const range = typeof cell.value !== 'number';
  const shown = formatFeature(cell.value, { unit });
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <FeatureBar value={cell.value} maximum={maximum} />
      <span
        className={range ? 'tabular-nums' : undefined}
        title={range ? formatFeature(cell.value, { long: true, unit }) : undefined}
      >
        {shown}
      </span>
      <ValueBadge origin={cell.origin} compact shown={shown} />
    </span>
  );
}

/** pricing4ts's sentinel for an unlimited limit (`1e8`), which a SPHERE import writes for one. */
const UNLIMITED = 1e8;

/** A property as words: `yes`/`no`, a number, `unlimited` for the sentinel, or the text. */
function propertyText(value: PropertyCell['value']): string {
  if (value === null) return 'not declared';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number')
    return value >= UNLIMITED
      ? 'unlimited'
      : value.toLocaleString('en', { maximumFractionDigits: 6 });
  return value;
}

function Property({ cell }: { cell: PropertyCell }) {
  if (cell.value === null) return <span className="text-xs text-tp-stone">not declared</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="tabular-nums">{propertyText(cell.value)}</span>
      <ValueBadge origin={cell.origin} compact />
    </span>
  );
}

/** Which upstream plan a SPHERE import read a candidate from, with SPHERE's page for that version. */
function Provenance({ candidate }: { candidate: MatrixCandidate }) {
  const from = candidate.provenance;
  if (!from) return null;
  const words = `From ${planText({
    sphere: from.sphere,
    plan: from.plan,
    addOns: from.addons ?? [],
    versionLabel: from.versionLabel,
    registry: from.registry ?? null,
    pricingId: from.pricingId,
    versionId: from.version,
    permanentUrl: from.permanentUrl,
  })}`;
  return (
    <span className="cm-provenance mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] font-normal text-tp-steel">
      <span className="[overflow-wrap:anywhere]">{words}</span>
      {from.permanentUrl && /^https:\/\//.test(from.permanentUrl) && (
        <a
          href={from.permanentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-tp-link underline"
        >
          Open in SPHERE
          <MdOpenInNew aria-hidden="true" className="h-3 w-3" />
        </a>
      )}
    </span>
  );
}

interface TaskProps {
  row: MatrixRow;
  features: Array<{ feature: MatrixFeature; index: number }>;
  /** The read-only property columns (names of `CandidateMatrix.properties`); empty hides the group. */
  properties: string[];
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
  properties,
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
  const name = (candidate: MatrixCandidate) => (
    <>
      {mode === 'edit' && renderName ? (
        renderName(candidate, row)
      ) : (
        <code className="font-mono font-semibold [overflow-wrap:anywhere]">
          {candidate.written}
        </code>
      )}
      <Provenance candidate={candidate} />
    </>
  );
  const propertyCells = (candidate: MatrixCandidate) =>
    candidate.properties.filter(cell => properties.includes(cell.name));
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
      <span
        key={tag}
        className="ml-2 inline-block rounded-full border border-dashed border-tp-hairline-strong px-1.5 text-[11px] font-semibold text-tp-ink-tint"
      >
        {tag}
      </span>
    ));

  const body = narrow ? (
    <ul className="flex flex-col gap-2" aria-label={`Candidates for ${row.task}`}>
      {row.candidates.map(candidate => (
        <li
          key={candidate.key}
          className={`flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 ${candidate.selected ? 'border-tp-status-verified bg-tp-surface-cream' : 'border-tp-hairline bg-tp-canvas'}`}
          aria-current={candidate.selected ? 'true' : undefined}
        >
          <div className="flex flex-wrap items-center gap-2">
            {mode === 'select' && radio(candidate)}
            <span className="flex min-w-0 flex-col">{name(candidate)}</span>
            {candidate.selected && <span className={SELECTED}>Selected</span>}
            {tagsOf(candidate)}
          </div>
          <dl className="grid grid-cols-1 gap-1">
            <div className={CARD_ROW}>
              <dt className="text-xs text-tp-steel">Provider</dt>
              <dd className="text-[13px]">{candidate.provider ?? '—'}</dd>
            </div>
            {features.map(({ feature, index }, column) => (
              <div key={feature.id} className={CARD_ROW}>
                <dt className="text-xs text-tp-steel">{headerOf(feature)}</dt>
                <dd className="text-[13px]">{content(candidate, column, index)}</dd>
              </div>
            ))}
          </dl>
          {properties.length > 0 && (
            <details className="cm-properties">
              <summary className="cursor-pointer text-xs font-medium text-tp-link">
                Properties ({properties.length})
              </summary>
              <dl className="mt-1 grid grid-cols-1 gap-1">
                {propertyCells(candidate).map(cell => (
                  <div key={cell.name} className={CARD_ROW}>
                    <dt className="font-mono text-xs text-tp-steel">{cell.name}</dt>
                    <dd className="text-[13px]">
                      <Property cell={cell} />
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </li>
      ))}
    </ul>
  ) : (
    <DataTable
      label={`Candidates for ${row.task}`}
      caption={
        <>
          Task <code className="font-mono">{row.task}</code> · {count}
        </>
      }
      minWidth={Math.min(
        640 + properties.length * 120,
        280 + (features.length + properties.length) * 120
      )}
    >
      <thead>
        {properties.length > 0 && (
          <tr className="cm-groups">
            <td colSpan={(mode === 'select' ? 3 : 2) + features.length} />
            <th
              scope="colgroup"
              colSpan={properties.length}
              className="border-l border-tp-hairline text-[11px] font-semibold tracking-wider text-tp-steel uppercase"
            >
              Properties
            </th>
          </tr>
        )}
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
          {properties.map((property, index) => (
            <th
              scope="col"
              key={`property-${property}`}
              className={index === 0 ? 'border-l border-tp-hairline' : undefined}
            >
              <span className="font-mono">{property}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {row.candidates.map(candidate => (
          <tr
            key={candidate.key}
            className={candidate.selected ? 'bg-tp-surface-cream' : undefined}
            aria-current={candidate.selected ? 'true' : undefined}
          >
            {mode === 'select' && <td>{radio(candidate)}</td>}
            <th scope="row">
              {name(candidate)}
              {candidate.selected && <span className={SELECTED}>Selected</span>}
              {tagsOf(candidate)}
            </th>
            <td>{candidate.provider ?? '—'}</td>
            {features.map(({ feature, index }, column) => (
              <td key={feature.id}>{content(candidate, column, index)}</td>
            ))}
            {propertyCells(candidate).map((cell, index) => (
              <td
                key={`property-${cell.name}`}
                className={index === 0 ? 'border-l border-tp-hairline' : undefined}
              >
                <Property cell={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </DataTable>
  );

  return mode === 'select' ? (
    <div className="min-w-0" role="radiogroup" aria-label={`Candidate for ${row.task}`}>
      {body}
    </div>
  ) : (
    <div className="min-w-0">{body}</div>
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
    <section className="flex min-w-0 flex-col gap-3" aria-label={label}>
      {extras.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[13px] font-medium text-tp-link">
            More features ({extras.length})
          </summary>
          <fieldset className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]">
            <legend className="sr-only">Features to show besides the required ones</legend>
            {extras.map(feature => (
              <label key={feature.id} className="inline-flex cursor-pointer items-center gap-1.5">
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
            <p key={row.task} className="text-[13px] text-tp-slate">
              <code className="font-mono">{row.task}</code> is a local task: it gets no candidate.
            </p>
          );
        }
        if (row.candidates.length === 0) {
          return (
            <p key={row.task} className="text-[13px] text-tp-slate">
              <code className="font-mono">{row.task}</code> has no candidate that can serve it.
            </p>
          );
        }
        return (
          <TaskCandidates
            key={row.task}
            row={row}
            features={features}
            properties={matrix.properties}
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
