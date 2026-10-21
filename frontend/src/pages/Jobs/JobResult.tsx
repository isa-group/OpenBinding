import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { jobsApi, type JobDetail, type JobReport, type JobSolution } from '../../api/jobs';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { bindingRows, metricEntries, normalizeStatus, numberText, scoreText, violationsOf } from './jobsModel';
import type { Neighborhood } from '../../analysis/neighborhood';

export interface Origin {
  caseSlug: string;
  caseName: string;
  revision: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const providerText = (value: unknown): string => {
  if (!isRecord(value)) return '—';
  return [value.resource, value.id].filter((part) => typeof part === 'string' && part).join(' · ') || '—';
};

function SourceView({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="job-source">
      <summary>View source</summary>
      <pre aria-label={label}>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

/** Why no combination works: the rules the best attempt still breaks, when the result names them. */
function Infeasible({ solution, root, origin }: { solution: JobSolution | undefined; root: string; origin: Origin | null }) {
  const broken = violationsOf(solution);
  return (
    <section className="job-card is-warning" aria-labelledby="job-infeasible">
      <h2 id="job-infeasible">Why no combination works</h2>
      <p>No combination of providers meets every must-hold rule of this problem.</p>
      {broken.length > 0 && (
        <ul className="job-violations" aria-label="Rules the best attempt breaks">
          {broken.map((violation, index) => {
            const label = [violation.constraint, violation.constraint_id, violation.id, violation.code].find((part) => typeof part === 'string') as string | undefined;
            const message = typeof violation.message === 'string' ? violation.message : null;
            return <li key={`${label ?? 'rule'}-${index}`}><strong>{label ?? 'A rule'}</strong>{message ? ` · ${message}` : ''}</li>;
          })}
        </ul>
      )}
      {origin && (
        <span className="job-links">
          <Link to={`${root}/cases/${encodeURIComponent(origin.caseSlug)}/compose`} viewTransition>Try faster providers</Link>
          <Link to={`${root}/cases/${encodeURIComponent(origin.caseSlug)}/revisions/${origin.revision}`} viewTransition>See the rules</Link>
        </span>
      )}
    </section>
  );
}

function Solutions({ solutions }: { solutions: JobSolution[] }) {
  const [chosen, setChosen] = useState(0);
  const index = Math.min(chosen, solutions.length - 1);
  const solution = solutions[index];
  const rows = bindingRows(solution);
  const metrics = metricEntries(solution);
  const score = scoreText(solution);
  const penalty = typeof solution.objectives?.penalty === 'number' ? solution.objectives.penalty : null;
  return (
    <section className="job-solutions" aria-labelledby="job-best">
      <div className="job-card-head">
        <h2 id="job-best">{solutions.length > 1 ? `Solution ${index + 1} of ${solutions.length}` : 'Best combination found'}</h2>
        {solutions.length > 1 && (
          <label className="job-select">
            <span>Show</span>
            <select aria-label="Show solution" value={index} onChange={(event) => setChosen(Number(event.target.value))}>
              {solutions.map((_, position) => <option key={position} value={position}>Solution {position + 1}</option>)}
            </select>
          </label>
        )}
      </div>
      <ul className="job-figures" aria-label="Quality of this combination">
        {score !== null && <li><span>Objective</span><b>{score}</b><small>{solution.objectives?.mode ? `${solution.objectives.mode} · lower is better` : 'as the model scores it'}</small></li>}
        {metrics.map(([name, amount]) => <li key={name}><span>{name}</span><b>{numberText(amount)}</b></li>)}
        {penalty !== null && <li><span>Nice-to-have rules</span><b>{numberText(penalty)}</b><small>penalty</small></li>}
      </ul>
      {rows.length > 0 ? (
        <div className="job-binding" role="region" aria-label="Chosen providers" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Task</th><th scope="col">Chosen provider</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.task}>
                  <td><code>{row.task}</code></td>
                  <td><Chip tone="accent">{row.candidate}</Chip>{row.resource && <small className="org-muted"> {row.resource}</small>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="org-muted">This solution carries no binding assignment.</p>}
      <SourceView label={`Solution ${index + 1} source`} value={solution} />
    </section>
  );
}

/** What the engine said about its own answer, beside what OpenBinding computed. */
function EngineReport({ jobId }: { jobId: string }) {
  const [report, setReport] = useState<JobReport | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [problem, setProblem] = useState('');

  const load = async () => {
    setState('busy');
    setProblem('');
    try {
      setReport(await jobsApi.report(jobId));
      setState('idle');
    } catch (caught) {
      const failure = classifyAuthError(caught);
      setProblem(failure.kind === 'not-found'
        ? `The report isn’t available any more${marker(failure)}.`
        : `The engine’s own report couldn’t be read${marker(failure)}.`);
      setState('failed');
    }
  };

  const remote = report?.remote ?? {};
  const remoteSolutions = Array.isArray(remote.solutions) ? remote.solutions.length : null;
  const remoteTermination = typeof remote.termination === 'string' ? remote.termination : null;
  const divergence = isRecord(remote.divergence) ? remote.divergence : null;

  return (
    <section className="job-card" aria-labelledby="job-engine-report">
      <div className="job-card-head">
        <h2 id="job-engine-report">The engine’s own report</h2>
        {!report && <Action variant="secondary" size="sm" busy={state === 'busy'} onClick={() => void load()}>Compare with the engine</Action>}
      </div>
      {!report && state !== 'failed' && <p className="org-muted">The numbers above are OpenBinding’s re-check. Compare them with what the engine said about itself.</p>}
      {state === 'failed' && <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={() => void load()}>Try again</Action>}>{problem}</Notice>}
      {report && (
        <>
          <dl className="job-facts">
            <div><dt>OpenBinding’s re-check</dt><dd>{report.gatewayEvaluation.termination ?? 'No conclusion'} · {report.gatewayEvaluation.solutions.length} solution{report.gatewayEvaluation.solutions.length === 1 ? '' : 's'}</dd></div>
            <div><dt>The engine said</dt><dd>{remoteTermination ?? (Object.keys(remote).length ? 'No termination stated' : 'Nothing')}{remoteSolutions !== null ? ` · ${remoteSolutions} solution${remoteSolutions === 1 ? '' : 's'}` : ''}</dd></div>
            {divergence && (
              <div>
                <dt>Do they agree?</dt>
                <dd>{divergence.agrees === true ? 'Yes, they agree.' : 'They differ.'}{Array.isArray(divergence.notes) && divergence.notes.length > 0 ? ` ${divergence.notes.join(' ')}` : ''}</dd>
              </div>
            )}
          </dl>
          <SourceView label="The engine’s report source" value={report.remote} />
        </>
      )}
    </section>
  );
}

function moveLine(move: Record<string, unknown>): string {
  const deltas = Array.isArray(move.componentDeltas) ? move.componentDeltas.filter(isRecord) : [];
  return deltas
    .map((delta) => {
      const value = typeof delta.value === 'number' ? delta.value : null;
      return value === null ? null : `${typeof delta.feature === 'string' ? delta.feature : 'value'} ${value > 0 ? '+' : '−'}${numberText(Math.abs(value))}`;
    })
    .filter(Boolean)
    .join(' · ');
}

const COMPARISON: Record<string, { label: string; tone: 'success' | 'warning' | 'plain' }> = {
  better: { label: 'Better', tone: 'success' },
  'repairs-feasibility': { label: 'Repairs a broken rule', tone: 'success' },
  worse: { label: 'Worse', tone: 'warning' },
  equal: { label: 'Same quality', tone: 'plain' },
  incomparable: { label: 'Trade-off', tone: 'plain' },
};

/** What if one task used another provider? The bounded, single-task swaps the gateway can check without running the engine again. */
function NeighborhoodPanel({ jobId }: { jobId: string }) {
  const [result, setResult] = useState<Neighborhood | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [problem, setProblem] = useState('');

  const load = async () => {
    setState('busy');
    setProblem('');
    try {
      setResult(await apiClient.getBindingNeighborhood(jobId, 0, '', 128));
      setState('idle');
    } catch (caught) {
      const failure = classifyAuthError(caught);
      setProblem(failure.status === 429
        ? `The analysis service is busy${marker(failure)}. Try again in a few seconds.`
        : failure.status === 409
          ? `This run’s compiled problem isn’t available for analysis any more${marker(failure)}.`
          : `The swaps couldn’t be checked${marker(failure)}.`);
      setState('failed');
    }
  };

  const moves = (result?.moves ?? []).slice(0, 8);
  return (
    <section className="job-card" aria-labelledby="job-swaps">
      <div className="job-card-head">
        <h2 id="job-swaps">What if one task used another provider?</h2>
        <Action variant="secondary" size="sm" busy={state === 'busy'} onClick={() => void load()}>{result ? 'Swaps checked' : 'Check single swaps'}</Action>
      </div>
      {state === 'failed' && <Notice tone="error">{problem}</Notice>}
      {result && (
        <>
          <p>{result.conclusion}</p>
          {moves.length > 0 && (
            <ul className="job-swaps" aria-label="Single-task swaps">
              {moves.map((move, position) => {
                const comparison = COMPARISON[typeof move.comparison === 'string' ? move.comparison : ''] ?? { label: 'Checked', tone: 'plain' as const };
                return (
                  <li key={`${String(move.task)}-${position}`}>
                    <span className="job-swap-pair">
                      <span><small>{String(move.task)} now</small><b>{providerText(isRecord(move.from) ? move.from : null)}</b></span>
                      <span aria-hidden="true">⇄</span>
                      <span className="is-to"><small>swap for</small><b>{providerText(isRecord(move.to) ? move.to : null)}</b></span>
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
            Checked {result.coverage.evaluated} of {result.coverage.total} possible swaps (up to {result.coverage.limit}) without running the engine again.
            {result.coverage.complete ? '' : ' Coverage is incomplete.'} This isn’t a full robustness analysis.
          </p>
          <SourceView label="Swaps source" value={result} />
        </>
      )}
      {!result && state !== 'failed' && <p className="org-muted">Up to 128 single-task swaps are checked without running the engine again.</p>}
    </section>
  );
}

interface ResultSectionProps {
  detail: JobDetail;
  jobId: string;
  root: string;
  origin: Origin | null;
}

/** The authoritative result: what the gateway re-evaluated, in the shape of the state the run ended in. */
export function ResultSection({ detail, jobId, root, origin }: ResultSectionProps) {
  const state = normalizeStatus(detail.status);
  const result = detail.result ?? null;
  const solutions = Array.isArray(result?.solutions) ? result.solutions.filter(isRecord) as JobSolution[] : [];

  if (state === 'queued' || state === 'running') {
    return <div className="job-empty">No result yet. It appears here when the run finishes.</div>;
  }
  if (state === 'cancelled') return <div className="job-empty">Cancelled before producing a result.</div>;
  if (state === 'failed') {
    const why = (typeof result?.error === 'string' && result.error) || detail.error || 'The engine did not say why.';
    return (
      <Notice tone="error" title="The run failed">
        {/[.!?]$/.test(why) ? why : `${why}.`} Retrying starts a new attempt.
      </Notice>
    );
  }
  const infeasible = result?.termination === 'INFEASIBLE';
  return (
    <>
      {infeasible && <Infeasible solution={solutions[0]} root={root} origin={origin} />}
      {!infeasible && solutions.length === 0 && <div className="job-empty">This run finished without producing a binding.</div>}
      {solutions.length > 0 && !infeasible && (
        <>
          <Solutions solutions={solutions} />
          <p className="org-muted job-footnote">Numbers are OpenBinding’s own re-check of the engine’s answer.</p>
        </>
      )}
      {solutions.length > 0 && !infeasible && <NeighborhoodPanel jobId={jobId} />}
      <EngineReport jobId={jobId} />
      {typeof result?.logs === 'string' && result.logs && (
        <details className="job-source">
          <summary>Engine log</summary>
          <pre aria-label="Engine log">{result.logs}</pre>
        </details>
      )}
    </>
  );
}
