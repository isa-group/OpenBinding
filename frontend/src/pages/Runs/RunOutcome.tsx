import { useState } from 'react';
import { Link } from 'react-router-dom';
import { runsApi, type JobDetail, type JobSolution } from '../../api/runs';
import { RunResult } from '../../components/rendering/RunResult';
import { SourceView } from '../../components/rendering/SourceView';
import { Action } from '../../modules/core/components/action-button';
import { Chip } from '../../modules/core/components/chip';
import { Notice } from '../../modules/core/components/notice';
import { comparisonText } from '../../modules/core/utils/binding/comparison';
import { DeriveCompositionDialog } from '../../modules/run/components/derive/DeriveCompositionDialog';
import { problemPath, problemEditorPath } from '../../routes/paths/problems';
import { classifyAuthError, marker } from '../../modules/core/api/errors';
import { normalizeStatus, numberText, violationsOf } from './runsModel';
import { useRunProblem } from './useRunProblem';
import type { NeighborhoodResponse } from '../../modules/core/api/types';

/** What a run is of: the organization and problem it names, the version and the compilation it ran. */
export interface Origin {
  org: string;
  caseSlug: string;
  caseName: string;
  revision: number;
  compilationId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const providerText = (value: unknown): string => {
  if (!isRecord(value)) return '—';
  return (
    [value.resource, value.id].filter(part => typeof part === 'string' && part).join(' · ') || '—'
  );
};

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
    <section className="job-card is-warning" aria-labelledby="job-infeasible">
      <h2 id="job-infeasible">Why no combination works</h2>
      <p>No combination of providers meets every must-hold rule of this problem.</p>
      {broken.length > 0 && (
        <ul className="job-violations" aria-label="Rules the best attempt breaks">
          {broken.map((violation, index) => {
            const label = [
              isRecord(violation.constraint) ? violation.constraint.id : violation.constraint,
              violation.constraint_id,
              violation.id,
              violation.code,
            ].find(part => typeof part === 'string') as string | undefined;
            const message = typeof violation.message === 'string' ? violation.message : null;
            return (
              <li key={`${label ?? 'rule'}-${index}`}>
                <strong>{label ?? 'A rule'}</strong>
                {message ? ` · ${message}` : ''}
              </li>
            );
          })}
        </ul>
      )}
      {origin && (
        <span className="job-links">
          <Link
            to={problemEditorPath(origin.org, {
              problem: origin.caseSlug,
              revision: origin.revision,
            })}
            viewTransition
          >
            Try faster providers
          </Link>
          <Link
            to={problemPath(origin.org, origin.caseSlug, undefined, { version: origin.revision })}
            viewTransition
          >
            See the rules
          </Link>
        </span>
      )}
    </section>
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
  const [result, setResult] = useState<NeighborhoodResponse | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [problem, setProblem] = useState('');

  const load = async () => {
    setState('busy');
    setProblem('');
    try {
      setResult(await runsApi.neighborhood(org, jobId, 0, '', 128));
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
    <section className="job-card" aria-labelledby="job-swaps">
      <div className="job-card-head">
        <h2 id="job-swaps">What if one task used another provider?</h2>
        <Action variant="secondary" size="sm" busy={state === 'busy'} onClick={() => void load()}>
          {result ? 'Swaps checked' : 'Check single swaps'}
        </Action>
      </div>
      {state === 'failed' && <Notice tone="error">{problem}</Notice>}
      {result && (
        <>
          <p>{result.conclusion}</p>
          {moves.length > 0 && (
            <ul className="job-swaps" aria-label="Single-task swaps">
              {moves.map((move, position) => {
                const comparison = comparisonText(move.comparison);
                return (
                  <li key={`${String(move.task)}-${position}`}>
                    <span className="job-swap-pair">
                      <span>
                        <small>{String(move.task)} now</small>
                        <b>{providerText(isRecord(move.from) ? move.from : null)}</b>
                      </span>
                      <span aria-hidden="true">⇄</span>
                      <span className="is-to">
                        <small>swap for</small>
                        <b>{providerText(isRecord(move.to) ? move.to : null)}</b>
                      </span>
                    </span>
                    <Chip tone={comparison.tone}>{comparison.label}</Chip>
                    {move.feasible === false && <Chip tone="warning">Breaks a rule</Chip>}
                    <span className="org-muted">{moveLine(move)}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="org-muted">
            Checked {result.coverage.evaluated} of {result.coverage.total} possible swaps (up to{' '}
            {result.coverage.limit}) without running the engine again.
            {result.coverage.complete ? '' : ' Coverage is incomplete.'} This isn’t a full
            robustness analysis.
          </p>
          <details className="job-source">
            <summary>View source</summary>
            <SourceView source={result} label="Swaps source" />
          </details>
        </>
      )}
      {!result && state !== 'failed' && (
        <p className="org-muted">
          Up to 128 single-task swaps are checked without running the engine again.
        </p>
      )}
    </section>
  );
}

/** Keep a solution of the run as a version of a composition (MEMBER): the derive dialog. */
function DerivePanel({
  org,
  jobId,
  solutions,
}: {
  org: string;
  jobId: string;
  solutions: JobSolution[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="job-card" aria-labelledby="job-derive">
      <div className="job-card-head">
        <h2 id="job-derive">Keep it as a composition</h2>
        <Action variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Derive composition
        </Action>
      </div>
      <p className="org-muted">
        The gateway writes the Composition2Yaml document of a solution of this run, with the values
        it computes, and seals it as a version of a composition. You see it before it is sealed.
      </p>
      {open && (
        <DeriveCompositionDialog
          org={org}
          source={{ run: jobId, solutions }}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

interface ResultSectionProps {
  detail: JobDetail;
  /** The organization the run belongs to. */
  org: string;
  jobId: string;
  origin: Origin | null;
  /** MEMBER: may derive a composition from the run. */
  canDerive: boolean;
}

/** The authoritative result: what the gateway re-evaluated, in the shape of the state the run ended in. */
export function ResultSection({ detail, org, jobId, origin, canDerive }: ResultSectionProps) {
  const state = normalizeStatus(detail.status);
  const result = detail.result ?? null;
  const listed = Array.isArray(result?.solutions) ? (result.solutions as unknown[]) : [];
  const solutions = listed.filter(isRecord) as JobSolution[];
  const completed =
    state !== 'queued' && state !== 'running' && state !== 'cancelled' && state !== 'failed';
  const { problem, constraints } = useRunProblem(origin, completed);
  // What the engine said about itself comes with the run (`remote`), beside the gateway's re-evaluation.
  const report = completed && detail.remote ? { remote: detail.remote } : null;

  if (state === 'queued' || state === 'running') {
    return <div className="job-empty">No result yet. It appears here when the run finishes.</div>;
  }
  if (state === 'cancelled')
    return <div className="job-empty">Cancelled before producing a result.</div>;
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
    <RunResult
      result={detail.result ?? {}}
      problem={problem}
      constraints={constraints}
      report={report}
      notice={infeasible ? <Infeasible solution={solutions[0]} origin={origin} /> : undefined}
    >
      {solutions.length > 0 && !infeasible && (
        <>
          <p className="org-muted job-footnote">
            Numbers are OpenBinding’s own re-check of the engine’s answer.
          </p>
          <NeighborhoodPanel org={org} jobId={jobId} />
          {canDerive && state === 'completed' && (
            <DerivePanel org={org} jobId={jobId} solutions={listed as JobSolution[]} />
          )}
        </>
      )}
    </RunResult>
  );
}
