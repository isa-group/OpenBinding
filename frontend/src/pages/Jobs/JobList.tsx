import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, RefreshCw } from 'lucide-react';
import { runsApi } from '../../api/runs';
import type { Job, Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { DataTable } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { FilterPills } from '../../components/ui/FilterPills';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { problemPath } from '../../routes/paths/problems';
import { launchPath, runPath } from '../../routes/paths/runs';
import { runLabel } from '../../shared/lib/identity';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { problemAccess } from '../Cases/useRouteProblem';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { refusalOf, type Refusal } from './jobErrors';
import { STATUS_FILTERS, canRetryState, formatTook, isActive, normalizeStatus, statusCounts, tookOf, tookPercent, type StatusFilter } from './jobsModel';
import { JobFrame, OutcomeChip, RefusalNotice, StatusChip } from './parts';

const PAGE = 20;
const REFRESH_MS = 8000;
/** How many of the organization's runs the list reads (the newest); the filters and pages work on these. */
const READ = 200;

interface ListData {
  rows: Job[];
  /** How many runs the organization has, read or not. */
  total: number;
}

type Outcome = { tone: 'success'; text: string; follow?: string } | { tone: 'error'; refusal: Refusal };

function JobListBody({ organization, canLaunch }: { organization: Organization; canLaunch: boolean }) {
  const { user } = useAuth();
  const org = organization.slug;
  const jobs = useResource<ListData>(`runs:${org}`, async () => {
    const { runs, total } = await runsApi.list(org, { limit: READ });
    return { rows: runs, total };
  });
  const [status, setStatus] = useState<StatusFilter>('');
  const [engine, setEngine] = useState('');
  const [page, setPage] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const data = jobs.data ?? jobs.stale;
  const rows = data?.rows ?? [];
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

  const retry = async (job: Job) => {
    setRetrying(job.id);
    setOutcome(null);
    try {
      const made = await runsApi.retry(org, job.id);
      setOutcome({ tone: 'success', text: 'Retry queued.', follow: runPath(org, made.id) });
      reload();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: refusalOf(caught, 'retry') });
    } finally {
      setRetrying(null);
    }
  };

  const loadingFirst = jobs.status === 'loading' && !data;

  return (
    <JobFrame organization={organization} trail={[{ label: 'Runs' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Runs</h1>
          <p>Every run in {organization.name}. Every member opens them; launching, cancelling and retrying need MEMBER.</p>
        </div>
        <div className="proj-actions">
          {canLaunch && <Action to={launchPath(org)} variant="primary"><Play aria-hidden="true" className="job-icon" />New run</Action>}
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
      </div>

      {outcome?.tone === 'success' && (
        <Notice tone="success" action={outcome.follow ? <Action to={outcome.follow} variant="link" size="sm">Follow the new run</Action> : undefined}>{outcome.text}</Notice>
      )}
      {outcome?.tone === 'error' && <RefusalNotice refusal={outcome.refusal} usageTo />}

      {loadingFirst && <div role="status" aria-busy="true"><span className="sr-only">Loading the runs…</span><Skeleton variant="panel" /></div>}
      {failure && !data && (
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={reload}>Retry</Action>}>
          {failure.status === 403
            ? <>This credential can’t read runs{marker(failure)}. Use a session, or a key with <code>jobs:read</code>.</>
            : `Runs can’t be loaded right now${marker(failure)}.`}
        </Notice>
      )}

      {data && rows.length === 0 && (
        <EmptyState
          icon={<Play />}
          title="No runs yet"
          dashed
          action={canLaunch ? <Action to={launchPath(org)} variant="primary">Start a run</Action> : undefined}
        >
          Pick a problem version and an engine to run it.
        </EmptyState>
      )}

      {data && rows.length > 0 && (
        <>
          {filtered.length === 0 && <EmptyState icon={<Play />} title="No runs match these filters">Try another status or engine.</EmptyState>}
          {filtered.length > 0 && (
            <DataTable label="Runs of the organization" minWidth={960}>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Problem</th>
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
                  const own = Boolean(user && job.created_by?.id === user.id);
                  const took = tookOf(job);
                  return (
                    <tr key={job.id}>
                      <td><StatusChip status={state} /></td>
                      <td>
                        {job.problem
                          ? <Link to={problemPath(org, job.problem.slug)} viewTransition>{job.problem.name}</Link>
                          : <span className="org-muted">—</span>}
                        {job.revision && <small className="org-muted">version {job.revision.revision}</small>}
                      </td>
                      <td>
                        <strong className="job-engine">{job.engine_id}</strong>
                        {job.retry_of_id && <small className="org-muted">Retry of an earlier run</small>}
                      </td>
                      <td>{state === 'completed' ? <OutcomeChip termination={job.termination} /> : <span className="org-muted">—</span>}</td>
                      <td>
                        <span className="job-took">
                          <span className="job-took-bar" aria-hidden="true"><i style={{ width: `${tookPercent(took)}%` }} /></span>
                          {took !== null ? formatTook(took) : isActive(state) ? (state === 'running' ? 'running' : 'waiting') : '—'}
                        </span>
                      </td>
                      <td>
                        {own ? 'You' : job.created_by?.username ?? 'Another member'}
                        <small className="org-muted">{formatDateTime(job.created_at) ?? '—'}</small>
                      </td>
                      <td className="job-actions-cell">
                        <span className="job-row-actions">
                          <Link to={runPath(org, job.id)} viewTransition aria-label={`Open ${runLabel({ engine: { name: job.engine_id }, createdAt: job.created_at })}`}>Open</Link>
                          {canLaunch && canRetryState(state) && (
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
            <nav className="job-pager" aria-label="Pages of runs">
              <Action variant="secondary" size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</Action>
              <span aria-live="polite">Showing {current * PAGE + 1}–{Math.min(filtered.length, (current + 1) * PAGE)} of {filtered.length}</span>
              <Action variant="secondary" size="sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next</Action>
            </nav>
          )}
        </>
      )}

      {data && (
        <p className="org-muted job-footnote">
          Only summaries load here; results load when a run is opened. <Chip>{data.total} in this organization</Chip>
        </p>
      )}
    </JobFrame>
  );
}

/** The runs of an organization (`job-list`, `/app/:org/runs`): every member reads them; MEMBER and above launch and retry. */
export function JobList() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} />;
  return <JobListBody key={organization.slug} organization={organization} canLaunch={problemAccess(organization).canCreate} />;
}
