import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { History } from 'lucide-react';
import type { JobSummary } from '../../api/client';
import { apiClient } from '../../api/client';
import { jobsApi } from '../../api/jobs';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { Action } from '../../components/ui/Action';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { ProjectPicker } from '../../components/ui/ProjectPicker';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { refusalOf, type Refusal } from './jobErrors';
import { loadProjectIndex, retentionBars, type ProjectRef } from './jobsData';
import { STATUS_FILTERS, canRetryState, formatTook, isActive, normalizeStatus, outcomeOf, secondsBetween, statusCounts, type StatusFilter } from './jobsModel';
import { AccountFrame, RefusalNotice, StatusChip } from './parts';

const STEP = 50;

type Outcome = { tone: 'success'; text: string; follow?: string } | { tone: 'error'; refusal: Refusal };

interface HistoryData {
  jobs: JobSummary[];
  total: number;
  retention: number | null;
  /** The project each run belongs to, by the run's id; empty when the runs carry none or the projects could not be read. */
  projectOf: Map<string, ProjectRef>;
}

async function loadHistory(limit: number): Promise<HistoryData> {
  const [page, own, index] = await Promise.all([
    jobsApi.history({ limit }),
    jobsApi.mine().catch(() => []),
    loadProjectIndex(),
  ]);
  const projectOf = new Map<string, ProjectRef>();
  for (const job of own) {
    const project = job.project_id ? index.get(job.project_id) : undefined;
    if (project) projectOf.set(job.id, project);
  }
  return { jobs: page.jobs, total: page.total, retention: typeof page.retention_days === 'number' ? page.retention_days : null, projectOf };
}

function Retention({ retention, plan }: { retention: number | null; plan: string | undefined }) {
  const catalog = useResource('job-history-pricing', () => apiClient.getPricingCatalog().catch(() => null));
  const bars = retentionBars(catalog.data ?? null);
  const longest = bars.length ? bars[bars.length - 1].days : null;
  const tallest = Math.max(1, ...bars.map((bar) => bar.days));
  const title = retention === null
    ? 'Retention can’t be confirmed right now'
    : `Finished jobs are kept ${retention.toLocaleString('en-US')} days${plan ? ` on your ${plan} plan` : ''}`;
  const note = retention === null
    ? 'Your list still loads; only the retention figure is missing.'
    : longest !== null && retention >= longest
      ? 'This is the longest retention available.'
      : 'Longer retention comes with larger plans, arranged by agreement.';
  return (
    <section className={`job-retention-card${retention === null ? ' is-unknown' : ''}`} aria-label="How long runs are kept">
      <div>
        <strong>{title}</strong>
        <span>{note}</span>
      </div>
      {bars.length > 0 && (
        <div className="job-retention-bars" aria-hidden="true">
          {bars.map((bar) => (
            <span key={bar.plan}>
              <i className={bar.days === retention ? 'is-current' : undefined} style={{ height: `${Math.max(4, Math.round((bar.days / tallest) * 44))}px` }} />
              <small>{bar.short}</small>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function HistoryBody() {
  const { user } = useAuth();
  const context = useOutletContext<PlatformOutletContext | null>();
  const [limit, setLimit] = useState(STEP);
  const history = useResource<HistoryData>(`job-history:${limit}`, () => loadHistory(limit));
  const [status, setStatus] = useState<StatusFilter>('');
  const [engine, setEngine] = useState('');
  const [notice, setNotice] = useState<Outcome | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const data = history.data ?? history.stale;
  const rows = data?.jobs ?? [];
  const failure = history.status === 'error' ? classifyAuthError(history.error) : null;
  const counts = statusCounts(rows);
  const engines = [...new Set(rows.map((row) => row.engine_id))].sort();
  const shown = rows.filter((row) => (!status || normalizeStatus(row.status) === status) && (!engine || row.engine_id === engine));
  const refused = failure !== null && (failure.status === 401 || failure.status === 403);
  const fallback = context?.organization && context.project ? `/app/${context.organization.slug}/${context.project.slug}` : null;

  const hrefOf = (job: JobSummary): string | null => {
    const project = data?.projectOf.get(job.id);
    if (project) return `/app/${project.org}/${project.slug}/jobs/${job.id}`;
    return fallback ? `${fallback}/jobs/${job.id}` : null;
  };

  const act = async (job: JobSummary, kind: 'cancel' | 'retry') => {
    setActing(job.id);
    setNotice(null);
    try {
      if (kind === 'cancel') {
        await jobsApi.cancel(job.id);
        setNotice({ tone: 'success', text: 'Cancellation requested.' });
      } else {
        const made = await jobsApi.retry(job.id);
        const project = data?.projectOf.get(job.id);
        const base = project ? `/app/${project.org}/${project.slug}` : fallback;
        setNotice({ tone: 'success', text: 'Retry queued.', follow: base ? `${base}/jobs/${made.id}` : undefined });
      }
      history.reload();
    } catch (caught) {
      setNotice({ tone: 'error', refusal: refusalOf(caught, kind) });
    } finally {
      setActing(null);
    }
  };

  return (
    <AccountFrame trail={[{ label: 'My jobs' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>My jobs</h1>
          <p>Everything you’ve run, across projects.</p>
        </div>
        <div className="proj-actions">
          <ProjectPicker label="See a project’s jobs instead" destination={(org, project) => `/app/${org}/${project}/jobs`} />
        </div>
      </header>

      {failure?.status === 401 && <Notice tone="warning">Your session ended{marker(failure)}. Log in again to see your jobs.</Notice>}
      {failure?.status === 403 && <Notice tone="warning">This API key doesn’t include “read jobs”{marker(failure)}. Use a browser session, or a key with jobs:read.</Notice>}
      {failure && !refused && !data && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={history.reload}>Try again</Action>}>
          Your jobs can’t be loaded right now{marker(failure)}.
        </Notice>
      )}

      {!refused && (
        <>
          {data && <Retention retention={data.retention} plan={user?.plan} />}
          <div className="job-toolbar">
            <FilterPills ariaLabel="Status" value={status} onChange={(id) => setStatus(id as StatusFilter)} options={STATUS_FILTERS.map((filter) => ({ id: filter.id, label: `${filter.label} (${counts[filter.id] ?? 0})` }))} />
            <label className="job-select">
              <span>Engine</span>
              <select aria-label="Engine" value={engine} onChange={(event) => setEngine(event.target.value)}>
                <option value="">Any</option>
                {engines.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            {data && <span className="job-total">{data.total.toLocaleString('en-US')} in total</span>}
          </div>

          {notice?.tone === 'success' && (
            <Notice tone="success" action={notice.follow ? <Action to={notice.follow} variant="link" size="sm">Follow the new run</Action> : undefined}>{notice.text}</Notice>
          )}
          {notice?.tone === 'error' && <RefusalNotice refusal={notice.refusal} usageTo />}

          {history.status === 'loading' && !data && <div role="status" aria-busy="true"><span className="sr-only">Loading your jobs…</span><Skeleton variant="panel" /></div>}

          {data && data.jobs.length === 0 && (
            <EmptyState icon={<History />} title="Nothing within your retention window" dashed action={<ProjectPicker label="Start a run" variant="primary" destination={(org, project) => `/app/${org}/${project}/jobs/new`} />}>
              No runs within your retention window.
            </EmptyState>
          )}
          {data && data.jobs.length > 0 && shown.length === 0 && <EmptyState icon={<History />} title="No runs match these filters">Try another status or engine.</EmptyState>}

          {shown.length > 0 && (
            <ul className="job-history-list" aria-label="Your jobs">
              {shown.map((job) => {
                const state = normalizeStatus(job.status);
                const project = data?.projectOf.get(job.id);
                const href = hrefOf(job);
                const outcome = outcomeOf(job.termination);
                const took = secondsBetween(job.created_at, job.finished_at);
                const busy = acting === job.id;
                return (
                  <li key={job.id} className="job-history-row">
                    <StatusChip status={state} />
                    <span className="job-history-main">
                      {href
                        ? <Link to={href} viewTransition>{job.engine_id}{project ? ` on ${project.name}` : ''}</Link>
                        : <strong>{job.engine_id}{project ? ` on ${project.name}` : ''}</strong>}
                      <small>
                        {formatDateTime(job.created_at) ?? '—'} · {took !== null ? formatTook(took) : isActive(state) ? (state === 'running' ? 'running' : 'waiting') : '—'} · {outcome ? outcome.label.toLowerCase() : 'no result yet'}
                        {job.solutions != null && state === 'completed' ? ` · ${job.solutions} solution${job.solutions === 1 ? '' : 's'}` : ''}
                      </small>
                    </span>
                    <span className="job-history-actions">
                      {isActive(state) && <button type="button" className="job-link-button is-danger" disabled={busy} onClick={() => void act(job, 'cancel')}>{busy ? 'Cancelling…' : 'Cancel'}</button>}
                      {canRetryState(state) && <button type="button" className="job-link-button" disabled={busy} onClick={() => void act(job, 'retry')}>{busy ? 'Retrying…' : 'Retry'}</button>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {data && data.total > rows.length && (
            <div className="job-pager">
              <span>Showing {rows.length.toLocaleString('en-US')} of {data.total.toLocaleString('en-US')}</span>
              <Action variant="secondary" size="sm" busy={history.status === 'loading'} onClick={() => setLimit(rows.length + STEP)}>Show more</Action>
            </div>
          )}
        </>
      )}
    </AccountFrame>
  );
}

/** Your own runs across projects (`job-history`, `/app/jobs`), as far back as your plan keeps them. */
export function JobHistory() {
  return <HistoryBody />;
}
