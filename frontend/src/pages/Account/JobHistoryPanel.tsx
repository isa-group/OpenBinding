import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cpu, FileDown } from 'lucide-react';
import { BindingAnalysis } from '../../components/BindingAnalysis/BindingAnalysis';
import { apiClient } from '../../api/client';
import type { JobHistory, JobStatus } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, fallbackMessage } from './accountErrors';
import './JobHistoryPanel.css';

function download(contents: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(contents, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** A finished solve, as the reference evaluator scored it. */
function SolutionPanel({ job, onDownload }: { job: JobStatus; onDownload: () => void }) {
  const solution = job.result?.solutions?.[0];
  const binding = solution?.decision.binding ?? null;
  const objective = solution?.objectives.score;
  const metrics = solution?.metrics;

  if (!solution) {
    return (
      <p className="history-solution-empty">
        This solve finished without producing a binding
        {job.result?.termination === 'INFEASIBLE' ? ': no assignment satisfies every declared constraint.' : '.'}
      </p>
    );
  }

  return (
    <div className="history-solution">
      <BindingAnalysis result={job.result} jobId={job.id} />
      <header className="history-solution-head">
        <div className="history-solution-meta">
          {job.result?.termination && (
            <Chip tone={job.result.termination === 'OPTIMAL' || job.result.termination === 'FEASIBLE' ? 'success' : job.result.termination === 'INFEASIBLE' ? 'plain' : 'warning'}>
              {job.result.termination}
            </Chip>
          )}
          {objective != null && (
            <span>
              objective{' '}
              <strong>
                {typeof objective === 'number'
                  ? objective.toLocaleString('en-GB', { maximumFractionDigits: 4 })
                  : `[${objective.map((value) => value.toLocaleString('en-GB', { maximumFractionDigits: 4 })).join(', ')}]`}
              </strong>
            </span>
          )}
        </div>
        <Action variant="secondary" size="sm" onClick={onDownload}><FileDown aria-hidden="true" className="history-icon" />Download JSON</Action>
      </header>

      {metrics && Object.keys(metrics).length > 0 && (
        <div className="history-metrics">
          {Object.entries(metrics).map(([name, value]) => (
            <span key={name} className="history-metric">
              <span>{name}</span>
              <strong>{typeof value === 'number' ? value.toLocaleString('en-GB', { maximumFractionDigits: 4 }) : String(value)}</strong>
            </span>
          ))}
        </div>
      )}

      {binding && Object.keys(binding).length > 0 ? (
        <div className="history-binding">
          <table>
            <thead><tr><th scope="col">Task</th><th scope="col">Candidate binding</th></tr></thead>
            <tbody>
              {Object.entries(binding).map(([task, candidate]) => (
                <tr key={task}>
                  <td><code>{task}</code></td>
                  <td><code>{candidate.resource}:{candidate.id}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="history-solution-empty">The solution carries no binding assignment.</p>
      )}

      {(job.result?.solutions?.length ?? 0) > 1 && (
        <p className="history-solution-empty">
          Showing the first of {job.result!.solutions!.length} evaluated solutions; all variants are available in the linked analysis above and the downloaded document.
        </p>
      )}
    </div>
  );
}

interface JobHistoryPanelProps {
  /** How many solves to ask for. */
  limit?: number;
  /** The heading level of the panel's own title; the screen that hosts it decides. */
  headingLevel?: 2 | 3;
}

/**
 * The solves of this account as far back as its plan keeps them, each openable to the binding it produced.
 *
 * It loads its own data and renders no page title, so any screen can host it: it was the “Execution history”
 * tab of the old Account page and is meant for the job-history screen (`/app/jobs`).
 */
export function JobHistoryPanel({ limit = 20, headingLevel = 2 }: JobHistoryPanelProps) {
  const history = useResource<JobHistory>(`job-history:${limit}`, () => apiClient.listOwnJobs({ limit }));
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [solutions, setSolutions] = useState<Record<string, JobStatus>>({});
  const [loadingSolution, setLoadingSolution] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const Heading = `h${headingLevel}` as 'h2' | 'h3';

  const toggleSolution = async (jobId: string) => {
    if (openJob === jobId) {
      setOpenJob(null);
      return;
    }
    setOpenJob(jobId);
    setProblem(null);
    if (solutions[jobId]) return;
    setLoadingSolution(jobId);
    try {
      const job = await apiClient.getJobStatus(jobId);
      setSolutions((current) => ({ ...current, [jobId]: job }));
    } catch {
      setOpenJob(null);
      setProblem('That solve could not be retrieved. It may have aged out of the window your plan keeps, or the gateway is not reachable.');
    } finally {
      setLoadingSolution(null);
    }
  };

  const failure = history.status === 'error' ? classifyAuthError(history.error) : null;
  const data = history.data;

  return (
    <section className="history-panel" aria-labelledby="history-title" aria-busy={history.status === 'loading'}>
      <header className="history-head">
        <div>
          <Heading id="history-title">Execution history &amp; solves</Heading>
          <p>
            {data
              ? `Showing ${data.jobs.length} of ${data.total} solve${data.total === 1 ? '' : 's'}, retained for ${data.retention_days} days under your plan.`
              : 'Verifiable record of binding problems evaluated across all accessible Engines.'}
          </p>
        </div>
        {data && <Chip tone="accent">{data.retention_days} days retention</Chip>}
      </header>

      {problem && <Notice tone="error">{problem}</Notice>}
      {history.status === 'loading' && <Skeleton variant="panel" />}
      {failure && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={history.reload}>Try again</Action>}>
          {failure.status === 403 ? 'This request was refused (403): reading jobs needs jobs:read or a browser session.' : fallbackMessage(failure, 'loaded')}
        </Notice>
      )}

      {data && data.jobs.length === 0 && (
        <EmptyState icon={<Cpu />} title="No solve executions recorded yet" dashed>
          Launch an optimization run in the <Link to="/workbench" viewTransition>Workbench</Link> to see evaluated bindings here.
        </EmptyState>
      )}

      {data && data.jobs.length > 0 && (
        <DataTable label="Solve history" minWidth={640}>
          <thead>
            <tr>
              <th scope="col">Engine</th>
              <th scope="col">Status</th>
              <th scope="col">Termination &amp; solutions</th>
              <th scope="col">Executed</th>
              <th scope="col"><span className="sr-only">Inspect</span></th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((job) => (
              <Fragment key={job.id}>
                <tr>
                  <td><code className="history-engine">{job.engine_id}</code></td>
                  <td><Chip tone={job.status === 'completed' ? 'success' : job.status === 'failed' ? 'warning' : 'plain'}>{job.status}</Chip></td>
                  <td>
                    {job.termination
                      ? <span><strong className="history-termination">{job.termination}</strong>{job.solutions != null && ` · ${job.solutions} solution${job.solutions === 1 ? '' : 's'}`}</span>
                      : <span className="acct-muted">—</span>}
                  </td>
                  <td>{formatDateTime(job.created_at) ?? '—'}</td>
                  <td>
                    <Action
                      variant="ghost"
                      size="sm"
                      disabled={job.status !== 'completed' || loadingSolution === job.id}
                      aria-expanded={openJob === job.id}
                      onClick={() => void toggleSolution(job.id)}
                    >
                      {loadingSolution === job.id ? 'Loading…' : openJob === job.id ? 'Hide' : 'Solution'}
                    </Action>
                  </td>
                </tr>
                {openJob === job.id && solutions[job.id] && (
                  <tr className="history-solution-row">
                    <td colSpan={5}>
                      <SolutionPanel
                        job={solutions[job.id]}
                        onDownload={() => download(solutions[job.id].result, `${job.engine_id}-${job.id.slice(0, 8)}.solution.json`)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </DataTable>
      )}
    </section>
  );
}
