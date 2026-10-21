import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Inbox, RefreshCw } from 'lucide-react';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { EmptyState } from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { formatDateTime } from '../../utils/format';
import { formatDuration } from '../../utils/limits';
import { useResource } from '../../utils/useResource';
import { AdminFrame, AdminOnly, FailureNotice, Meter, Tag } from './AdminChrome';
import { ageLabel, ageSeconds, count, describeAdminFailure, shortId } from './adminModel';

const STATES = [
  { id: 'queued', label: 'Queued', tone: 'muted' },
  { id: 'running', label: 'Running', tone: 'info' },
  { id: 'completed', label: 'Completed', tone: 'success' },
  { id: 'failed', label: 'Failed', tone: 'error' },
  { id: 'cancelled', label: 'Cancelled', tone: 'muted' },
] as const;

const REFRESH_MS = 10_000;

function QueuesScreen() {
  const [live, setLive] = useState(false);
  const queues = useResource('admin-queues', async () => ({ status: await apiClient.adminQueues(), at: Date.now() }));
  const reload = queues.reload;

  // Opt-in polling: a queue worth watching is one an administrator is looking at.
  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [live, reload]);

  const data = queues.data ?? queues.stale;
  const failure = queues.status === 'error' ? describeAdminFailure(queues.error, 'Queue status couldn’t be loaded') : null;
  const status = data?.status;
  const now = data?.at ?? 0;

  const counts = status?.counts ?? {};
  const total = STATES.reduce((sum, state) => sum + (counts[state.id] ?? 0), 0);
  const inFlight = (counts.queued ?? 0) + (counts.running ?? 0);
  const jobs = status?.oldestInFlight ?? [];
  const overdue = jobs.filter((job) => {
    const age = ageSeconds(job.createdAt, now);
    return age !== null && job.budgetSeconds > 0 && age > job.budgetSeconds;
  });

  return (
    <AdminFrame
      section="queues"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Queues' }]}
      title="Queues"
      lede="Spot jobs that are stuck before people notice."
      actions={(
        <>
          <Action variant="secondary" onClick={reload} busy={queues.status === 'loading' && Boolean(data)}><RefreshCw aria-hidden="true" />Refresh</Action>
          <Action variant="secondary" to="/app/admin/maintenance">Go to maintenance</Action>
        </>
      )}
    >
      <label className="adm-check adm-live">
        <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
        Refresh every {REFRESH_MS / 1000} s
      </label>

      {failure && <FailureNotice failure={failure} onRetry={reload} />}
      {queues.status === 'loading' && !data && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading queue status</span><Skeleton variant="panel" /></div>}

      {status && total === 0 && (
        <EmptyState icon={<Inbox />} title="Queues are empty" dashed>Nothing waiting, nothing running, and no finished jobs on record.</EmptyState>
      )}

      {status && total > 0 && (
        <>
          <div className="adm-states" role="list" aria-label="Jobs by state">
            {STATES.map((state) => (
              <div key={state.id} className="adm-state" role="listitem">
                <span className="adm-state-line"><span>{state.label}</span><strong>{count(counts[state.id] ?? 0)}</strong></span>
                <Meter value={total === 0 ? 0 : ((counts[state.id] ?? 0) / total) * 100} tone={state.tone} />
              </div>
            ))}
          </div>

          {overdue.length > 0 && (
            <Notice
              tone="warning"
              title={overdue.length === 1 ? 'One job has run far past its time budget' : `${overdue.length} jobs have run far past their time budget`}
              action={<Action size="sm" variant="primary" to="/app/admin/maintenance">Reconcile abandoned jobs</Action>}
            >
              {overdue.length === 1
                ? `A ${overdue[0].engine} job asked for ${formatDuration(overdue[0].budgetSeconds)} and has been ${overdue[0].state} for ${ageLabel(overdue[0].createdAt, now)}. It may be abandoned.`
                : 'They may be abandoned. Reconciling settles the ones whose time budget and grace have passed.'}
            </Notice>
          )}

          <section className="adm-card" aria-labelledby="adm-wait-title">
            <div className="adm-card-head">
              <h2 id="adm-wait-title">Waiting and running</h2>
              <span className="adm-muted">{inFlight > jobs.length ? `The ${jobs.length} oldest of ${count(inFlight)}` : `${count(inFlight)} in flight`}</span>
            </div>
            {jobs.length === 0 && <p className="adm-muted">Nothing waiting or running.</p>}
            <ul className="adm-jobs" aria-label="Jobs in flight, oldest first">
              {jobs.map((job) => {
                const age = ageSeconds(job.createdAt, now);
                const ratio = age !== null && job.budgetSeconds > 0 ? (age / job.budgetSeconds) * 100 : 0;
                const late = ratio > 100;
                return (
                  <li key={job.id} aria-label={`${job.engine} ${job.state}`}>
                    <Tag tone={job.state === 'running' ? 'info' : 'plain'}>{job.state === 'running' ? 'Running' : 'Queued'}</Tag>
                    <span className="adm-job-copy">
                      <span><strong className="is-mono">{job.engine}</strong>{' '}
                        <span className="adm-muted">· {job.ownerId ? <Link to={`/app/admin/users/${job.ownerId}`} title={job.ownerId}>account {shortId(job.ownerId)}</Link> : 'no owner'} · job <span className="is-mono">{shortId(job.id)}</span></span>
                      </span>
                      <span className="adm-muted">Since {formatDateTime(job.createdAt) ?? job.createdAt} · budget {job.budgetSeconds > 0 ? formatDuration(job.budgetSeconds) : 'plan default'}</span>
                    </span>
                    <span className="adm-job-age">
                      <span className={late ? 'is-late' : undefined}>Age {ageLabel(job.createdAt, now)}{late ? ' · past its budget' : ''}</span>
                      <Meter value={Math.min(100, ratio)} tone={late ? 'error' : 'info'} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      {status && (
        <section className="adm-card" aria-labelledby="adm-queue-limits">
          <h2 id="adm-queue-limits">What this screen can’t do</h2>
          <p className="adm-muted">
            The gateway exposes the queue read-only (<code>GET /v1/admin/queues</code>): counts by state and the 20 oldest jobs in flight. There is no
            pause, resume or priority control, and an administrator can’t cancel another account’s job. The one corrective action is reconciling
            abandoned jobs in maintenance. Study cells and analysis tasks have no queue of their own to show.
          </p>
        </section>
      )}
    </AdminFrame>
  );
}

/** admin-queues: jobs by state and the oldest ones still waiting or running. */
export function AdminQueues() {
  return <AdminOnly><QueuesScreen /></AdminOnly>;
}
