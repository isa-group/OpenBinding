import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, RefreshCw } from 'lucide-react';
import { jobsApi } from '../../api/jobs';
import { platformApi, type Job, type Organization, type Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import { useRouteProject } from '../Project/useRouteProject';
import { refusalOf, type Refusal } from './jobErrors';
import { STATUS_FILTERS, canRetryState, formatTook, isActive, normalizeStatus, statusCounts, tookOf, tookPercent, type StatusFilter } from './jobsModel';
import { JobFrame, OutcomeChip, RefusalNotice, StatusChip } from './parts';

const PAGE = 20;
const REFRESH_MS = 8000;

interface ListData {
  rows: Job[];
  /** The ids of the runs this account launched; `null` when its own list could not be read. */
  mine: Set<string> | null;
  /** How many days finished runs are kept on the launcher's plan; `null` when it could not be read. */
  retention: number | null;
}

type Outcome = { tone: 'success'; text: string; follow?: string } | { tone: 'error'; refusal: Refusal };

function JobListBody({ organization, project, canLaunch }: { organization: Organization; project: Project; canLaunch: boolean }) {
  const { isAdmin, user } = useAuth();
  const org = organization.slug;
  const slug = project.slug;
  const root = `/app/${org}/${slug}`;
  const jobs = useResource<ListData>(`jobs:${org}/${slug}`, async () => {
    const [rows, mine, retention] = await Promise.all([
      platformApi.projectJobs(org, slug),
      jobsApi.mine().then((own) => new Set(own.map((job) => job.id)), () => null),
      jobsApi.history({ limit: 1 }).then((page) => (typeof page.retention_days === 'number' ? page.retention_days : null), () => null),
    ]);
    return { rows, mine, retention };
  });
  const [status, setStatus] = useState<StatusFilter>('');
  const [engine, setEngine] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const data = jobs.data ?? jobs.stale;
  const rows = data?.rows ?? [];
  const mine = data?.mine ?? null;
  const reload = jobs.reload;
  const anyActive = rows.some((row) => isActive(normalizeStatus(row.status)));

  // Runs that are still moving are asked about again, quietly; the list keeps what it shows meanwhile.
  useEffect(() => {
    if (!anyActive) return undefined;
    const timer = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [anyActive, reload]);

  const counts = statusCounts(rows);
  const engines = [...new Set(rows.map((row) => row.engine_id))].sort();
  const filtered = rows.filter((row) => (!status || normalizeStatus(row.status) === status) && (!engine || row.engine_id === engine));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * PAGE, (current + 1) * PAGE);
  const failure = jobs.status === 'error' ? classifyAuthError(jobs.error) : null;

  // A run is the launcher's: its owner opens it. When the account's own list could not be read the detail screen decides.
  const isOwn = (job: Job) => mine === null || mine.has(job.id);
  const canOpen = (job: Job) => isAdmin || isOwn(job);
  const selectable = (job: Job) => normalizeStatus(job.status) === 'completed' && mine !== null && mine.has(job.id);
  const chosen = selected.filter((id) => rows.some((row) => row.id === id));

  const toggle = (id: string) => setSelected((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));

  const retry = async (job: Job) => {
    setRetrying(job.id);
    setOutcome(null);
    try {
      const made = await jobsApi.retry(job.id);
      setOutcome({ tone: 'success', text: 'Retry queued. It counts as a new solve.', follow: `${root}/jobs/${made.id}` });
      reload();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: refusalOf(caught, 'retry') });
    } finally {
      setRetrying(null);
    }
  };

  const analyseHref = `/app/analysis/workspace?${chosen.map((id) => `job=${encodeURIComponent(id)}`).join('&')}`;
  const loadingFirst = jobs.status === 'loading' && !data;

  return (
    <JobFrame organization={organization} project={project} trail={[{ label: 'Jobs' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Jobs</h1>
          <p>Every run in {project.name}. Anyone in the project sees the summary; opening, cancelling or retrying a job is for whoever launched it.</p>
        </div>
        <div className="proj-actions">
          {chosen.length > 0
            ? <Action to={analyseHref} variant="secondary">Analyze {chosen.length} selected</Action>
            : <Action variant="secondary" disabled>Analyze 0 selected</Action>}
          {canLaunch && <Action to={`${root}/jobs/new`} variant="primary"><Play aria-hidden="true" className="job-icon" />New run</Action>}
        </div>
      </header>

      <div className="job-toolbar">
        <FilterPills ariaLabel="Status" value={status} onChange={(id) => { setStatus(id as StatusFilter); setPage(0); }} options={STATUS_FILTERS.map((filter) => ({ id: filter.id, label: `${filter.label} (${counts[filter.id] ?? 0})` }))} />
        <label className="job-select">
          <span>Engine</span>
          <select aria-label="Engine" value={engine} onChange={(event) => { setEngine(event.target.value); setPage(0); }}>
            <option value="">Any</option>
            {engines.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <Action variant="ghost" size="sm" onClick={reload} busy={jobs.status === 'loading' && Boolean(data)}><RefreshCw aria-hidden="true" className="job-icon" />Refresh</Action>
        {data?.retention != null && (
          <span className="job-retention" title="Retention depends on the launcher’s plan">
            Kept for {data.retention.toLocaleString('en-US')} days{user?.plan ? ` on your ${user.plan} plan` : ''}
          </span>
        )}
      </div>

      {outcome?.tone === 'success' && (
        <Notice tone="success" action={outcome.follow ? <Action to={outcome.follow} variant="link" size="sm">Follow the new run</Action> : undefined}>{outcome.text}</Notice>
      )}
      {outcome?.tone === 'error' && <RefusalNotice refusal={outcome.refusal} usageTo />}

      {loadingFirst && <div role="status" aria-busy="true"><span className="sr-only">Loading the jobs…</span><Skeleton variant="panel" /></div>}
      {failure && !data && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={reload}>Retry</Action>}>
          {failure.status === 403
            ? `This credential can’t read jobs${marker(failure)}. Use a session, or a key with jobs:read.`
            : `Jobs can’t be loaded right now${marker(failure)}.`}
        </Notice>
      )}

      {data && rows.length === 0 && (
        <EmptyState
          icon={<Play />}
          title="No runs yet"
          dashed
          action={canLaunch ? <Action to={`${root}/jobs/new`} variant="primary">Start a run</Action> : undefined}
        >
          Pick a case revision and an engine to run it.
        </EmptyState>
      )}

      {data && rows.length > 0 && (
        <>
          {filtered.length === 0 && <EmptyState icon={<Play />} title="No runs match these filters">Try another status or engine.</EmptyState>}
          {filtered.length > 0 && (
            <DataTable label="Jobs of the project" minWidth={860}>
              <thead>
                <tr>
                  <th scope="col"><span className="sr-only">Select</span></th>
                  <th scope="col">Status</th>
                  <th scope="col">Engine</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Took</th>
                  <th scope="col">Launched by</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((job) => {
                  const state = normalizeStatus(job.status);
                  const own = mine !== null && mine.has(job.id);
                  const took = tookOf(job);
                  return (
                    <tr key={job.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={chosen.includes(job.id)}
                          disabled={!selectable(job)}
                          onChange={() => toggle(job.id)}
                          aria-label={`Select job ${job.id.slice(0, 8)}`}
                        />
                      </td>
                      <td><StatusChip status={state} /></td>
                      <td>
                        <strong className="job-engine">{job.engine_id}</strong>
                        {job.retry_of_id && <small className="org-muted">Retry of {job.retry_of_id.slice(0, 8)}…</small>}
                      </td>
                      <td>{state === 'completed' ? <OutcomeChip termination={job.termination} /> : <span className="org-muted">—</span>}</td>
                      <td>
                        <span className="job-took">
                          <span className="job-took-bar" aria-hidden="true"><i style={{ width: `${tookPercent(took)}%` }} /></span>
                          {took !== null ? formatTook(took) : isActive(state) ? (state === 'running' ? 'running' : 'waiting') : '—'}
                        </span>
                      </td>
                      <td>
                        {own ? 'You' : mine === null ? 'Unknown' : 'Another member'}
                        <small className="org-muted">{formatDateTime(job.created_at) ?? '—'}</small>
                      </td>
                      <td className="job-actions-cell">
                        <span className="job-row-actions">
                          {canOpen(job)
                            ? <Link to={`${root}/jobs/${job.id}`} viewTransition aria-label={`Open job ${job.id.slice(0, 8)}`}>Open</Link>
                            : <small className="proj-owner-only" title="Jobs open only for whoever launched them">Owner only</small>}
                          {own && canRetryState(state) && (
                            <button type="button" className="job-link-button" onClick={() => void retry(job)} disabled={retrying === job.id}>
                              {retrying === job.id ? 'Retrying…' : 'Retry'}
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
          {filtered.length > PAGE && (
            <nav className="job-pager" aria-label="Pages of jobs">
              <Action variant="secondary" size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Action>
              <span aria-live="polite">Showing {current * PAGE + 1}–{Math.min(filtered.length, (current + 1) * PAGE)} of {filtered.length}</span>
              <Action variant="secondary" size="sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</Action>
            </nav>
          )}
        </>
      )}

      {data && (
        <p className="org-muted job-footnote">
          Only summaries load here; results load when a job is opened. A run you start from a revision or a snapshot belongs to your account
          and is also listed in <Link to="/app/jobs" viewTransition>My jobs</Link>. <Chip>{rows.length} in this project</Chip>
        </p>
      )}
    </JobFrame>
  );
}

/** The runs of a project (`job-list`, `/app/:org/:project/jobs`): summaries for every member, the actions for whoever launched each run. */
export function JobList() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <JobListBody key={`${organization.slug}/${project.slug}`} organization={organization} project={project} canLaunch={access.canCreate} />;
}
