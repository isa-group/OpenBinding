import { useId, useMemo, useState } from 'react';
import { CandidateMatrix } from '../../../../core/components/candidate-matrix/CandidateMatrix';
import { Notice } from '../../../../core/components/notice';
import ProblemsPanel from '../../../../core/components/problems-panel';
import PricingChangeReview from '../../../../core/components/pricing-change-review';
import {
  compareProviderPlan,
  PROVIDER_PLAN_MESSAGES,
} from '../../../../core/components/pricing-change-review/compare';
import { candidateMatrix } from '../../../../core/utils/binding/candidateMatrix';
import type { SphereCandidate, SphereExpandView } from '../../../api/sphereApi';
import { locatedOf, manualCells, type ManualCell, type PlanReview } from '../model';
import { HEADING, INPUT, SECTION } from './styles';

const priceOf = (candidate: SphereCandidate, currency: string) =>
  candidate.price === null
    ? '—'
    : `${candidate.price.toLocaleString('en', { maximumFractionDigits: 2 })} ${currency}/month`;

interface Props {
  task: string;
  currency: string;
  expanded: SphereExpandView | null;
  loading: boolean;
  /** Why the preview could not be made (the request itself failed). */
  failure: string | null;
  onFill: (cell: ManualCell, value: number) => void;
  reviews: PlanReview[];
}

/**
 * Step 5: the gateway's preview of the recipe (`sphere/expand`): the findings, what changes against the base version, each
 * generated candidate with whether the task's requirements hold and why not, the matrix with where each value comes from, the
 * values left to set by hand and, for an update, each kept plan of a provider whose version changes, drawn before and after.
 */
export default function PreviewStep({
  task,
  currency,
  expanded,
  loading,
  failure,
  onFill,
  reviews,
}: Props) {
  const id = useId();
  const matrix = useMemo(() => {
    if (!expanded?.facts) return null;
    const full = candidateMatrix(expanded.facts);
    return { ...full, rows: full.rows.filter(row => row.task === task) };
  }, [expanded, task]);
  const cells = useMemo(() => (expanded ? manualCells(expanded) : []), [expanded]);
  const candidates = expanded?.candidates.filter(candidate => candidate.task === task) ?? [];

  if (failure) return <Notice tone="error">{failure}</Notice>;
  if (!expanded)
    return (
      <p role="status" className="text-sm text-tp-steel">
        Asking the gateway for the preview…
      </p>
    );

  const changes = expanded.changes;
  return (
    <div className="flex min-w-0 flex-col gap-4" aria-busy={loading || undefined}>
      {loading && (
        <p role="status" className="text-xs text-tp-steel">
          Updating the preview…
        </p>
      )}
      {expanded.valid ? (
        <Notice tone="success">
          {`The generated version compiles: ${candidates.filter(c => c.eligible).length} of ${candidates.length} candidates meet the requirements.`}
        </Notice>
      ) : (
        <Notice tone="error">The recipe can’t generate a version yet: fix the errors below.</Notice>
      )}
      <ProblemsPanel
        diagnostics={expanded.diagnostics.map(locatedOf)}
        tone="light"
        title="Findings of the preview"
      />

      {cells.length > 0 && (
        <section className={SECTION} aria-labelledby={`${id}-manual`}>
          <h3 id={`${id}-manual`} className={HEADING}>
            Values to set by hand
          </h3>
          {cells.map(cell => (
            <ManualCellField key={`${cell.candidate}-${cell.target}`} cell={cell} onFill={onFill} />
          ))}
        </section>
      )}

      <section className={SECTION} aria-labelledby={`${id}-changes`}>
        <h3 id={`${id}-changes`} className={HEADING}>
          Changes
        </h3>
        <p className="text-xs text-tp-steel">
          {`${changes.added.length} added, ${changes.removed.length} removed, ${changes.changed.length} changed against the base version.`}
        </p>
        {(['added', 'removed'] as const).map(kind =>
          changes[kind].length > 0 ? (
            <details key={kind}>
              <summary className="cursor-pointer text-xs font-medium text-tp-link">
                {kind === 'added' ? 'Added' : 'Removed'} ({changes[kind].length})
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs [overflow-wrap:anywhere] text-tp-ink">
                {changes[kind].map(key => (
                  <li key={key}>{key.split('/').pop()}</li>
                ))}
              </ul>
            </details>
          ) : null
        )}
        {changes.changed.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs font-medium text-tp-link">
              Changed ({changes.changed.length})
            </summary>
            <ul className="mt-1 flex flex-col gap-1 text-xs text-tp-ink">
              {changes.changed.map(change => (
                <li key={change.key} className="[overflow-wrap:anywhere]">
                  <code className="font-mono">{change.key.split('/').pop()}</code>:{' '}
                  {Object.entries({ ...change.values, ...change.properties })
                    .map(([name, pair]) => `${name} ${String(pair.before)} → ${String(pair.after)}`)
                    .join(', ')}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {reviews.length > 0 && (
        <section className={SECTION} aria-labelledby={`${id}-reviews`}>
          <h3 id={`${id}-reviews`} className={HEADING}>
            Plans whose pricing version changes
          </h3>
          {reviews.map(review => (
            <PlanChange key={`${review.provider}-${review.plan}`} review={review} />
          ))}
        </section>
      )}

      <section className={SECTION} aria-labelledby={`${id}-candidates`}>
        <h3 id={`${id}-candidates`} className={HEADING}>
          Generated candidates
        </h3>
        <ul className="flex flex-col gap-1.5">
          {candidates.map(candidate => (
            <li
              key={candidate.key}
              className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border border-tp-hairline px-3 py-2 text-xs"
            >
              <code className="font-mono text-[13px] font-semibold [overflow-wrap:anywhere] text-tp-ink">
                {candidate.id}
              </code>
              <span className="text-tp-steel">{priceOf(candidate, currency)}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${candidate.eligible ? 'bg-emerald-50 text-emerald-800' : 'bg-tp-severity-warning-bg text-tp-warning-text'}`}
              >
                {candidate.eligible ? 'Eligible' : 'Ineligible'}
              </span>
              {!candidate.eligible && (
                <span className="basis-full text-tp-steel">
                  {candidate.requirements
                    .filter(term => !term.satisfied)
                    .map(term => term.text)
                    .join('; ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {matrix && (
        <section className={SECTION} aria-labelledby={`${id}-matrix`}>
          <h3 id={`${id}-matrix`} className={HEADING}>
            Values and where they come from
          </h3>
          <div
            className="max-h-[28rem] min-w-0 overflow-auto"
            role="region"
            aria-label="Candidate values"
            tabIndex={0}
          >
            <CandidateMatrix matrix={matrix} mode="view" label={`Candidates of ${task}`} />
          </div>
        </section>
      )}
    </div>
  );
}

function ManualCellField({ cell, onFill }: { cell: ManualCell; onFill: PreviewProps['onFill'] }) {
  const [value, setValue] = useState('');
  const number = Number(value);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={event => {
        event.preventDefault();
        if (value.trim() !== '' && Number.isFinite(number)) onFill(cell, number);
      }}
    >
      <label className="min-w-0 flex-1">
        <span className="mb-1 block text-xs text-tp-slate">
          {`${cell.target} for ${cell.candidate.split('/').pop()}`}
        </span>
        <input
          className={INPUT}
          type="number"
          value={value}
          onChange={event => setValue(event.target.value)}
        />
      </label>
      <button
        type="submit"
        disabled={value.trim() === '' || !Number.isFinite(number)}
        className="mb-0.5 h-10 cursor-pointer rounded-lg border border-tp-hairline-strong px-3 text-xs font-medium text-tp-ink hover:bg-tp-surface disabled:cursor-not-allowed disabled:opacity-50"
      >
        Set and preview again
      </button>
    </form>
  );
}

type PreviewProps = Props;

function PlanChange({ review }: { review: PlanReview }) {
  const compared = useMemo(
    () => compareProviderPlan(review.before, review.after, review.plan, review.addOns),
    [review]
  );
  const title = `${review.title} ${review.plan}: version ${review.beforeLabel} → ${review.afterLabel}`;
  if (!compared.ok)
    return (
      <Notice tone="warning">{`${title}: the change can’t be drawn, ${compared.reason}.`}</Notice>
    );
  return (
    <PricingChangeReview
      comparison={compared.comparison}
      title={title}
      messages={PROVIDER_PLAN_MESSAGES}
      readOnly
    />
  );
}
