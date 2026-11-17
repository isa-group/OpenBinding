// Pattern only, after SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the Result tab of a run's card page, in SPHERE's hairline cards: the authoritative result the gateway
// re-evaluated (OpenBinding's run renderer), why no combination works when the run is infeasible, and the what-if swaps
// checked on request.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useRunsApi, type JobDetail, type JobSolution } from '../../api/runsApi';
import { RunResult } from '../rendering/RunResult';
import { SourceView } from '../rendering/SourceView';
import { Action } from '../../../core/components/action-button';
import { Chip } from '../../../core/components/chip';
import { Notice } from '../../../core/components/notice';
import { comparisonText } from '../../../core/utils/binding/comparison';
import { problemPath, problemEditorPath } from '../../../../routes/paths/problems';
import { classifyAuthError, marker } from '../../../core/api/errors';
import type { NeighborhoodResponse } from '../../../core/api/types';
import type { Origin } from '../../utils/runOrigin';
import { normalizeStatus, numberText, solutionsOfRun, violationsOf } from '../../utils/runsModel';
import { useRunProblem } from '../../hooks/useRunProblem';
import { RunCard } from '../run-facts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const providerText = (value: unknown): string => {
  if (!isRecord(value)) return '—';
  return (
    [value.resource, value.id].filter(part => typeof part === 'string' && part).join(' · ') || '—'
  );
};

const linkClass = 'cursor-pointer text-sm font-medium text-tp-accent hover:underline';

/** Why no combination works: the rules the best attempt still breaks, when the result names them. */
function Infeasible({
  solution,
  origin,
}: {
  solution: JobSolution | undefined;
  origin: Origin | null;
}) {
  const broken = violationsOf(solution);
  return (
    <RunCard id="run-infeasible" title="Why no combination works" tone="warning">
      <p className="text-sm text-tp-ink">
        No combination of providers meets every must-hold rule of this problem.
      </p>
      {broken.length > 0 && (
        <ul
          aria-label="Rules the best attempt breaks"
          className="flex list-disc flex-col gap-1 pl-5 text-sm text-tp-ink"
        >
          {broken.map((violation, index) => {
            const label = [
              isRecord(violation.constraint) ? violation.constraint.id : violation.constraint,
              violation.constraint_id,
              violation.id,
              violation.code,
            ].find(part => typeof part === 'string') as string | undefined;
            const message = typeof violation.message === 'string' ? violation.message : null;
            return (
              <li key={`${label ?? 'rule'}-${index}`} className="[overflow-wrap:anywhere]">
                <strong>{label ?? 'A rule'}</strong>
                {message ? ` · ${message}` : ''}
              </li>
            );
          })}
        </ul>
      )}
      {origin && (
        <span className="flex flex-wrap gap-4">
          <Link
            to={problemEditorPath(origin.org, {
              problem: origin.caseSlug,
              revision: origin.revision,
            })}
            className={linkClass}
          >
            Try faster providers
          </Link>
          <Link
            to={problemPath(origin.org, origin.caseSlug, undefined, { version: origin.revision })}
            className={linkClass}
          >
            See the rules
          </Link>
        </span>
      )}
    </RunCard>
  );
}

function moveLine(move: Record<string, unknown>): string {
  const deltas = Array.isArray(move.componentDeltas) ? move.componentDeltas.filter(isRecord) : [];
  return deltas
    .map(delta => {
      const value = typeof delta.value === 'number' ? delta.value : null;
      return value === null
        ? null
        : `${typeof delta.feature === 'string' ? delta.feature : 'value'} ${value > 0 ? '+' : '−'}${numberText(Math.abs(value))}`;
    })
    .filter(Boolean)
    .join(' · ');
}

/** What if one task used another provider? The bounded, single-task swaps the gateway can check without running the engine again. */
function NeighborhoodPanel({ org, jobId }: { org: string; jobId: string }) {
  const { neighborhood } = useRunsApi();
  const [result, setResult] = useState<NeighborhoodResponse | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [problem, setProblem] = useState('');

  const load = async () => {
    setState('busy');
    setProblem('');
    try {
      setResult(await neighborhood(org, jobId, 0, '', 128));
      setState('idle');
    } catch (caught) {
      const failure = classifyAuthError(caught);
      setProblem(
        failure.status === 429
          ? `The analysis service is busy${marker(failure)}. Try again in a few seconds.`
          : failure.status === 409
            ? `This run’s compiled problem isn’t available for analysis any more${marker(failure)}.`
            : `The swaps couldn’t be checked${marker(failure)}.`
      );
      setState('failed');
    }
  };

  const moves = (result?.moves ?? []).slice(0, 8);
  return (
    <RunCard
      id="run-swaps"
      title="What if one task used another provider?"
      aside={
        <Action variant="secondary" size="sm" busy={state === 'busy'} onClick={() => void load()}>
          {result ? 'Swaps checked' : 'Check single swaps'}
        </Action>
      }
    >
      {state === 'failed' && <Notice tone="error">{problem}</Notice>}
      {result && (
        <>
          <p className="text-sm text-tp-ink">{result.conclusion}</p>
          {moves.length > 0 && (
            <ul aria-label="Single-task swaps" className="flex flex-col gap-2">
              {moves.map((move, position) => {
                const comparison = comparisonText(move.comparison);
                return (
                  <li
                    key={`${String(move.task)}-${position}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-tp-hairline-soft p-3"
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                      <span className="min-w-0">
                        <small className="block text-[11px] text-tp-steel">
                          {String(move.task)} now
                        </small>
                        <b className="font-semibold [overflow-wrap:anywhere]">
                          {providerText(isRecord(move.from) ? move.from : null)}
                        </b>
                      </span>
                      <span aria-hidden="true" className="text-tp-steel">
                        ⇄
                      </span>
                      <span className="min-w-0">
                        <small className="block text-[11px] text-tp-steel">swap for</small>
                        <b className="font-semibold [overflow-wrap:anywhere] text-tp-accent">
                          {providerText(isRecord(move.to) ? move.to : null)}
                        </b>
                      </span>
                    </span>
                    <Chip tone={comparison.tone}>{comparison.label}</Chip>
                    {move.feasible === false && <Chip tone="warning">Breaks a rule</Chip>}
                    <span className="text-xs text-tp-steel">{moveLine(move)}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-tp-steel">
            Checked {result.coverage.evaluated} of {result.coverage.total} possible swaps (up to{' '}
            {result.coverage.limit}) without running the engine again.
            {result.coverage.complete ? '' : ' Coverage is incomplete.'} This isn’t a full
            robustness analysis.
          </p>
          <details className="rounded-lg border border-tp-hairline-soft">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-tp-slate">
              View source
            </summary>
            <div className="p-2">
              <SourceView source={result} label="Swaps source" />
            </div>
          </details>
        </>
      )}
      {!result && state !== 'failed' && (
        <p className="text-xs text-tp-steel">
          Up to 128 single-task swaps are checked without running the engine again.
        </p>
      )}
    </RunCard>
  );
}

interface ResultSectionProps {
  detail: JobDetail;
  /** The organization the run belongs to. */
  org: string;
  jobId: string;
  origin: Origin | null;
}

const EMPTY =
  'rounded-xl border border-dashed border-tp-hairline-strong bg-tp-canvas px-5 py-10 text-center text-sm text-tp-steel';

/** The authoritative result: what the gateway re-evaluated, in the shape of the state the run ended in. */
export function ResultSection({ detail, org, jobId, origin }: ResultSectionProps) {
  const state = normalizeStatus(detail.status);
  const result = detail.result ?? null;
  const solutions = solutionsOfRun(detail);
  const completed =
    state !== 'queued' && state !== 'running' && state !== 'cancelled' && state !== 'failed';
  const { problem, constraints } = useRunProblem(origin, completed);
  // What the engine said about itself comes with the run (`remote`), beside the gateway's re-evaluation.
  const report = completed && detail.remote ? { remote: detail.remote } : null;

  if (state === 'queued' || state === 'running') {
    return <div className={EMPTY}>No result yet. It appears here when the run finishes.</div>;
  }
  if (state === 'cancelled')
    return <div className={EMPTY}>Cancelled before producing a result.</div>;
  if (state === 'failed') {
    const why =
      (typeof result?.error === 'string' && result.error) ||
      detail.error ||
      'The engine did not say why.';
    return (
      <Notice tone="error" title="The run failed">
        {/[.!?]$/.test(why) ? why : `${why}.`} Retrying starts a new attempt.
      </Notice>
    );
  }
  const infeasible = result?.termination === 'INFEASIBLE';
  return (
    <div className="rounded-xl border border-tp-hairline bg-tp-canvas p-5">
      <RunResult
        result={detail.result ?? {}}
        problem={problem}
        constraints={constraints}
        report={report}
        notice={infeasible ? <Infeasible solution={solutions[0]} origin={origin} /> : undefined}
      >
        {solutions.length > 0 && !infeasible && (
          <>
            <p className="text-xs text-tp-steel">
              Numbers are OpenBinding’s own re-check of the engine’s answer.
            </p>
            <NeighborhoodPanel org={org} jobId={jobId} />
          </>
        )}
      </RunResult>
    </div>
  );
}
