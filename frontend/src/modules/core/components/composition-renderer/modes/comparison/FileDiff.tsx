// Design follows SPHERE frontend/src/modules/pricing/components/pricing-version-diff/file-diff-view.tsx (revision 73779a8a); no code copied
import { Fragment, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronsDown, ChevronsUp, Ellipsis } from 'lucide-react';
import {
  diffText,
  foldUnchanged,
  type DiffCell,
  type DiffRow,
} from '../../../../utils/sphere/text-diff';

/**
 * Two texts of a composition, line by line: side by side from 640 px, one unified column below, with the lines that differ marked
 * in text (`−` and `+` in the unified column, "removed" and "added" for assistive technology beside them) and the words that
 * differ highlighted. Long unchanged stretches fold away and open on request. The text sits in table cells, never in `<pre>`.
 */

const NARROW = '(max-width: 640px)';

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

type Side = 'left' | 'right';

const marked = (row: DiffRow, side: Side) =>
  row.kind === 'change' || (side === 'left' ? row.kind === 'remove' : row.kind === 'add');

function Text({ cell }: { cell: DiffCell }) {
  if (!cell.segments) return <>{cell.text || ' '}</>;
  return (
    <>
      {cell.segments.map((segment, index) =>
        segment.changed ? (
          <mark key={index}>{segment.text}</mark>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  );
}

function SideCells({ row, side }: { row: DiffRow; side: Side }) {
  const cell = side === 'left' ? row.left : row.right;
  const highlighted = cell !== null && marked(row, side);
  const tone = highlighted
    ? side === 'left'
      ? ' is-removed'
      : ' is-added'
    : cell
      ? ''
      : ' is-empty';
  return (
    <>
      <td className={`fd-number${tone}`}>{cell?.lineNumber ?? ''}</td>
      <td className={`fd-text${tone}${side === 'left' ? '' : ' is-after'}`}>
        {highlighted && (
          <span className="sr-only">{side === 'left' ? 'removed: ' : 'added: '}</span>
        )}
        {cell && <Text cell={cell} />}
      </td>
    </>
  );
}

/** The lines of one row in the unified column: an unchanged line once, an edited line as its removed and its added line. */
function unifiedLines(row: DiffRow): Array<{
  key: string;
  sign: '−' | '+' | '';
  before: number | null;
  after: number | null;
  cell: DiffCell;
}> {
  if (row.kind === 'equal' && row.left && row.right)
    return [
      {
        key: 'equal',
        sign: '',
        before: row.left.lineNumber,
        after: row.right.lineNumber,
        cell: row.right,
      },
    ];
  const lines: ReturnType<typeof unifiedLines> = [];
  if (row.left)
    lines.push({
      key: 'removed',
      sign: '−',
      before: row.left.lineNumber,
      after: null,
      cell: row.left,
    });
  if (row.right)
    lines.push({
      key: 'added',
      sign: '+',
      before: null,
      after: row.right.lineNumber,
      cell: row.right,
    });
  return lines;
}

function UnifiedRows({ row }: { row: DiffRow }) {
  return (
    <>
      {unifiedLines(row).map(line => {
        const tone = line.sign === '−' ? ' is-removed' : line.sign === '+' ? ' is-added' : '';
        return (
          <tr key={line.key} className={`fd-row${tone}`}>
            <td className={`fd-number${tone}`}>{line.before ?? ''}</td>
            <td className={`fd-number${tone}`}>{line.after ?? ''}</td>
            <td className={`fd-sign${tone}`}>
              {line.sign}
              {line.sign && (
                <span className="sr-only">{line.sign === '−' ? ' removed' : ' added'}</span>
              )}
            </td>
            <td className={`fd-text${tone}`}>
              <Text cell={line.cell} />
            </td>
          </tr>
        );
      })}
    </>
  );
}

interface FileDiffProps {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  /** Fold the unchanged stretches at first (the comparison mode's `onlyDifferences`); otherwise every line shows. */
  foldAtFirst?: boolean;
}

export function FileDiff({
  before,
  after,
  beforeLabel,
  afterLabel,
  foldAtFirst = true,
}: FileDiffProps) {
  const narrow = useNarrow();
  const diff = useMemo(() => diffText(before, after), [before, after]);
  const blocks = useMemo(() => foldUnchanged(diff.rows), [diff.rows]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [expandAll, setExpandAll] = useState(!foldAtFirst);
  const hasFolds = blocks.some(block => block.type === 'collapsed');

  if (diff.additions === 0 && diff.removals === 0) {
    return (
      <div className="fd-identical">
        <p>
          <strong>The two files are identical.</strong> Every line matches.
        </p>
      </div>
    );
  }

  const columns = 4;
  const rowsOf = (rows: DiffRow[], prefix: string): ReactNode =>
    rows.map((row, index) =>
      narrow ? (
        <UnifiedRows key={`${prefix}-${index}`} row={row} />
      ) : (
        <tr key={`${prefix}-${index}`} className={`fd-row is-${row.kind}`}>
          <SideCells row={row} side="left" />
          <SideCells row={row} side="right" />
        </tr>
      )
    );

  return (
    <div className="fd">
      <div className="fd-toolbar">
        <span className="fd-count is-removed">
          {diff.removals} {diff.removals === 1 ? 'line' : 'lines'} removed
        </span>
        <span className="fd-count is-added">
          {diff.additions} {diff.additions === 1 ? 'line' : 'lines'} added
        </span>
        {hasFolds && (
          <button
            type="button"
            className="fd-toggle"
            aria-pressed={expandAll}
            onClick={() => setExpandAll(current => !current)}
          >
            {expandAll ? <ChevronsUp aria-hidden="true" /> : <ChevronsDown aria-hidden="true" />}
            {expandAll ? 'Hide unchanged lines' : 'Show unchanged lines'}
          </button>
        )}
      </div>
      <div
        className="fd-scroll"
        tabIndex={0}
        role="region"
        aria-label={`The text of ${beforeLabel} and ${afterLabel}`}
      >
        <table className={`fd-table${narrow ? ' is-unified' : ''}`}>
          <caption className="sr-only">{`Lines of ${beforeLabel} against ${afterLabel}`}</caption>
          <thead>
            {narrow ? (
              <tr>
                <th scope="col">{beforeLabel}</th>
                <th scope="col">{afterLabel}</th>
                <th scope="col">
                  <span className="sr-only">Change</span>
                </th>
                <th scope="col">Line</th>
              </tr>
            ) : (
              <tr>
                <th scope="colgroup" colSpan={2}>
                  {beforeLabel}
                </th>
                <th scope="colgroup" colSpan={2} className="is-after">
                  {afterLabel}
                </th>
              </tr>
            )}
          </thead>
          <tbody>
            {blocks.map((block, index) => {
              if (block.type === 'rows')
                return <Fragment key={index}>{rowsOf(block.rows, String(index))}</Fragment>;
              if (expandAll || expanded.has(block.id))
                return <Fragment key={index}>{rowsOf(block.rows, String(index))}</Fragment>;
              return (
                <tr key={index} className="fd-fold">
                  <td colSpan={columns}>
                    <button
                      type="button"
                      onClick={() => setExpanded(current => new Set(current).add(block.id))}
                    >
                      <Ellipsis aria-hidden="true" />
                      Show {block.rows.length} unchanged lines
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
