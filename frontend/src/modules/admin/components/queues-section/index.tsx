import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MdInbox, MdRefresh } from 'react-icons/md';
import { Action } from '../../../core/components/action-button';
import { EmptyState } from '../../../core/components/empty-state';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { formatDateTime } from '../../../../utils/format';
import { formatDuration } from '../../../../utils/limits';
import { useResource } from '../../../../utils/useResource';
import { adminPath, adminUserPath } from '../../../../routes/paths/admin';
import { useAdminApi } from '../../api/adminApi';
import { ageLabel, ageSeconds, count, describeAdminFailure, shortId } from '../../utils/adminModel';
import { Card, FailureNotice, Loading, Meter, MUTED, SectionHeader, Tag } from '../admin-parts';

const STATES = [
  { id: 'queued', label: 'Queued', tone: 'muted' },
  { id: 'running', label: 'Running', tone: 'info' },
  { id: 'completed', label: 'Completed', tone: 'success' },
  { id: 'failed', label: 'Failed', tone: 'error' },
  { id: 'cancelled', label: 'Cancelled', tone: 'muted' },
] as const;

const REFRESH_MS = 10_000;

/** The Queues section of `/admin`: jobs by state and the oldest ones still waiting or running. */
export default function QueuesSection() {
  const api = useAdminApi();
  const [live, setLive] = useState(false);
  const queues = useResource('admin-queues', async () => ({
    status: await api.adminQueues(),
    at: Date.now(),
  }));
  const reload = queues.reload;

  // Opt-in polling: a queue worth watching is one an administrator is looking at.
  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(reload, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [live, reload]);

  const data = queues.data ?? queues.stale;
  const failure =
    queues.status === 'error'
      ? describeAdminFailure(queues.error, 'Queue status couldn’t be loaded')
      : null;
  const status = data?.status;
  const now = data?.at ?? 0;

  const counts = status?.counts ?? {};
  const total = STATES.reduce((sum, state) => sum + (counts[state.id] ?? 0), 0);
  const inFlight = (counts.queued ?? 0) + (counts.running ?? 0);
  const jobs = status?.oldestInFlight ?? [];
  const overdue = jobs.filter(job => {
    const age = ageSeconds(job.createdAt, now);
    return age !== null && job.budgetSeconds > 0 && age > job.budgetSeconds;
  });

  return (
    <>
      <SectionHeader
        title="Queues"
        lede="Spot runs that are stuck before people notice."
        actions={
          <>
            <Action
              variant="secondary"
              onClick={reload}
              busy={queues.status === 'loading' && Boolean(data)}
            >
              <MdRefresh aria-hidden="true" />
              Refresh
            </Action>
            <Action variant="secondary" to={adminPath('maintenance')}>
              Go to maintenance
            </Action>
          </>
        }
      />
      <label className="flex cursor-pointer items-center gap-2 self-start text-sm text-tp-slate">
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer accent-tp-primary"
          checked={live}
          onChange={event => setLive(event.target.checked)}
        />
        Refresh every {REFRESH_MS / 1000} s
      </label>

      {failure && <FailureNotice failure={failure} onRetry={reload} />}
      {queues.status === 'loading' && !data && (
        <Loading label="Loading queue status">
          <Skeleton variant="panel" />
        </Loading>
      )}

      {status && total === 0 && (
        <EmptyState icon={<MdInbox />} title="Queues are empty" dashed>
          Nothing waiting, nothing running, and no finished runs on record.
        </EmptyState>
      )}

      {status && total > 0 && (
        <>
          <div
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
            role="list"
            aria-label="Runs by state"
          >
            {STATES.map(state => (
              <div
                key={state.id}
                className="flex flex-col gap-2 rounded-xl border border-tp-hairline bg-tp-canvas p-3"
                role="listitem"
              >
                <span className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-tp-slate">{state.label}</span>
                  <strong className="text-lg font-semibold text-tp-ink">
                    {count(counts[state.id] ?? 0)}
                  </strong>
                </span>
                <Meter
                  value={total === 0 ? 0 : ((counts[state.id] ?? 0) / total) * 100}
                  tone={state.tone}
                />
              </div>
            ))}
          </div>

          {overdue.length > 0 && (
            <Notice
              tone="warning"
              title={
                overdue.length === 1
                  ? 'One run has gone far past its time budget'
                  : `${overdue.length} runs have gone far past their time budget`
              }
              action={
                <Action size="sm" variant="primary" to={adminPath('maintenance')}>
                  Reconcile abandoned runs
                </Action>
              }
            >
              {overdue.length === 1
                ? `A ${overdue[0].engine} run asked for ${formatDuration(overdue[0].budgetSeconds)} and has been ${overdue[0].state} for ${ageLabel(overdue[0].createdAt, now)}. It may be abandoned.`
                : 'They may be abandoned. Reconciling settles the ones whose time budget and grace have passed.'}
            </Notice>
          )}

          <Card
            title="Waiting and running"
            aside={
              inFlight > jobs.length
                ? `The ${jobs.length} oldest of ${count(inFlight)}`
                : `${count(inFlight)} in flight`
            }
          >
            {jobs.length === 0 && <p className={MUTED}>Nothing waiting or running.</p>}
            <ul className="flex flex-col" aria-label="Runs in flight, oldest first">
              {jobs.map(job => {
                const age = ageSeconds(job.createdAt, now);
                const ratio =
                  age !== null && job.budgetSeconds > 0 ? (age / job.budgetSeconds) * 100 : 0;
                const late = ratio > 100;
                return (
                  <li
                    key={job.id}
                    aria-label={`${job.engine} ${job.state}`}
                    className="flex flex-col gap-2 border-t border-tp-hairline-soft py-3 first:border-t-0 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <span className="shrink-0">
                      <Tag tone={job.state === 'running' ? 'info' : 'plain'}>
                        {job.state === 'running' ? 'Running' : 'Queued'}
                      </Tag>
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                      <span>
                        <strong className="font-mono text-tp-ink">{job.engine}</strong>{' '}
                        <span className={MUTED}>
                          ·{' '}
                          {job.createdById ? (
                            <Link
                              to={adminUserPath(job.createdById)}
                              title={job.createdById}
                              className="cursor-pointer text-tp-accent hover:underline"
                            >
                              account {shortId(job.createdById)}
                            </Link>
                          ) : (
                            'no owner'
                          )}{' '}
                          · run <span className="font-mono">{shortId(job.id)}</span>
                        </span>
                      </span>
                      <span className={MUTED}>
                        Since {formatDateTime(job.createdAt) ?? job.createdAt} · budget{' '}
                        {job.budgetSeconds > 0 ? formatDuration(job.budgetSeconds) : 'plan default'}
                      </span>
                    </span>
                    <span className="flex w-full flex-col gap-1 sm:w-48">
                      <span
                        className={`text-xs ${late ? 'font-medium text-tp-error-text' : 'text-tp-steel'}`}
                      >
                        Age {ageLabel(job.createdAt, now)}
                        {late ? ' · past its budget' : ''}
                      </span>
                      <Meter value={Math.min(100, ratio)} tone={late ? 'error' : 'info'} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}

      {status && (
        <Card title="What this screen can’t do">
          <p className={MUTED}>
            The gateway exposes the queue read-only (<code>GET /v1/admin/queues</code>): counts by
            state and the 20 oldest runs in flight. There is no pause, resume or priority control,
            and an administrator can’t cancel another account’s run. The one corrective action is
            reconciling abandoned runs in maintenance. Study cells and analysis tasks have no queue
            of their own to show.
          </p>
        </Card>
      )}
    </>
  );
}
