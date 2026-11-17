// How a study run or a cell stands, drawn in the theme's tokens: a state pill (a dot and a word, as SPHERE's pills) and the
// stacked bar of how the cells of a run ended, which the study cards, the runs and the Progress tab share.

import type { StudyCell } from '../../api/studiesApi';
import { breakdownText, countStates, stateWord } from '../../utils/studiesModel';

type Tone = ReturnType<typeof stateWord>['tone'];

const PILL: Record<Tone, string> = {
  running: 'border-tp-severity-info-border bg-tp-severity-info-bg text-tp-info-text',
  queued: 'border-tp-hairline bg-tp-surface text-tp-slate',
  ok: 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text',
  warn: 'border-tp-severity-warning-border bg-tp-severity-warning-bg text-tp-warning-text',
  bad: 'border-tp-severity-error-border bg-tp-severity-error-bg text-tp-error-text',
  off: 'border-tp-hairline bg-tp-surface text-tp-steel',
};

const DOT: Record<Tone, string> = {
  running: 'bg-tp-severity-info animate-pulse',
  queued: 'bg-tp-stone',
  ok: 'bg-tp-severity-success',
  warn: 'bg-tp-severity-warning',
  bad: 'bg-tp-severity-error',
  off: 'bg-tp-muted',
};

/** Where a run or a cell stands: a dot and a word, coloured by how it went. */
export function StateChip({ state, label }: { state: string; label?: string }) {
  const word = stateWord(state);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${PILL[word.tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[word.tone]}`} aria-hidden="true" />
      {label ?? word.label}
    </span>
  );
}

const SEGMENTS = [
  { id: 'completed', label: 'completed', fill: 'bg-tp-severity-success' },
  { id: 'failed', label: 'failed', fill: 'bg-tp-severity-error' },
  { id: 'cancelled', label: 'cancelled', fill: 'bg-tp-muted' },
  { id: 'pending', label: 'in progress', fill: 'bg-tp-severity-info' },
] as const;

function bucketed(counts: Record<string, number>): Record<(typeof SEGMENTS)[number]['id'], number> {
  return {
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    cancelled: counts.cancelled ?? 0,
    pending: (counts.queued ?? 0) + (counts.running ?? 0) + (counts.partial ?? 0),
  };
}

const HEIGHT = { sm: 'h-1.5', md: 'h-2.5', lg: 'h-3.5' } as const;

/** How the cells of a run ended, as one stacked bar. The words for assistive technology are the same figures. */
export function CellBar({
  cells,
  size = 'md',
  legend = false,
  note,
}: {
  cells: readonly StudyCell[];
  size?: 'sm' | 'md' | 'lg';
  legend?: boolean;
  note?: string;
}) {
  const buckets = bucketed(countStates(cells));
  const total = cells.length;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span
        className={`flex w-full overflow-hidden rounded-full bg-tp-hairline-soft ${HEIGHT[size]}`}
        role="img"
        aria-label={breakdownText(cells)}
      >
        {SEGMENTS.map(
          segment =>
            buckets[segment.id] > 0 && (
              <span
                key={segment.id}
                className={`h-full ${segment.fill}`}
                style={{ width: `${(buckets[segment.id] / total) * 100}%` }}
              />
            )
        )}
      </span>
      {legend && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tp-steel">
          {SEGMENTS.filter(segment => buckets[segment.id] > 0).map(segment => (
            <span key={segment.id} className="inline-flex items-center gap-1">
              <i className={`inline-block h-2 w-2 rounded-sm ${segment.fill}`} aria-hidden="true" />
              {buckets[segment.id].toLocaleString('en-US')} {segment.label}
            </span>
          ))}
          {note && <span>{note}</span>}
        </span>
      )}
    </div>
  );
}
