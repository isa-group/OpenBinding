import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MdSentimentSatisfied } from 'react-icons/md';
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Action } from '../../../core/components/action-button';
import { EmptyState } from '../../../core/components/empty-state';
import { Skeleton } from '../../../core/components/skeleton';
import { useCopy } from '../../../core/hooks/useCopy';
import { formatDateTime } from '../../../core/utils/format';
import { useResource } from '../../../core/hooks/useResource';
import { ViewSource } from '../../../engine/components/engine-parts';
import { adminUserPath } from '../../../../routes/paths/admin';
import { useAdminApi } from '../../api/adminApi';
import type { AdminErrorOverview } from '../../api/types';
import {
  describeAdminFailure,
  errorMeaning,
  groupErrors,
  readErrorEvent,
  shortId,
  statusTone,
  UUID,
  type ErrorGroup,
  type ErrorRow,
} from '../../utils/adminModel';
import {
  Card,
  FACTS,
  FailureNotice,
  FIELD,
  FILL,
  INPUT,
  LABEL,
  Loading,
  Meter,
  MUTED,
  Pager,
  PICK,
  SectionHeader,
  Tag,
  TOOLBAR,
} from '../admin-parts';

const PAGE = 50;

const CATEGORIES: Record<string, string> = {
  pricing_quota: 'Quota (402)',
  concurrency: 'Concurrency (429)',
  solver_failure: 'Solver failures',
  system_bug: 'Platform faults',
  validation: 'Validation (422)',
  auth: 'Credentials',
};

const categoryLabel = (id: string) => CATEGORIES[id] ?? id.replace(/_/g, ' ');

const STATUSES = [401, 402, 403, 404, 409, 422, 429, 500, 503];

/** The colours of the hourly chart, one per series the overview counts. */
const SERIES = [
  { key: 'quota', label: 'Quota', tone: 'warning' },
  { key: 'concurrency', label: 'Concurrency', tone: 'info' },
  { key: 'solver', label: 'Solver', tone: 'error' },
  { key: 'system', label: 'Platform', tone: 'dark' },
  { key: 'validation', label: 'Validation', tone: 'muted' },
] as const;

/** The colour of each tone in a chart: the severity tokens, ink and stone. */
const CHART: Record<'error' | 'warning' | 'info' | 'dark' | 'muted', string> = {
  error: 'var(--color-tp-severity-error)',
  warning: 'var(--color-tp-severity-warning)',
  info: 'var(--color-tp-severity-info)',
  dark: 'var(--color-tp-ink)',
  muted: 'var(--color-tp-stone)',
};

const TICK = { fontSize: 11, fill: 'var(--color-tp-slate)' };

function barTone(status: number): 'error' | 'warning' | 'info' {
  return status >= 500 ? 'error' : status === 402 || status === 429 ? 'warning' : 'info';
}

const hourOf = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : `${String(date.getUTCHours()).padStart(2, '0')}:00`;
};

const LINK = 'cursor-pointer text-tp-accent hover:underline';
const SUBHEAD = 'text-[13px] font-semibold text-tp-ink';

function Summary({ overview }: { overview: AdminErrorOverview }) {
  const byCategory = Object.entries(overview.by_category_24h).sort(([, a], [, b]) => b - a);
  const byStatus = Object.entries(overview.by_status_code_24h)
    .map(([code, total]) => [Number(code), total] as const)
    .sort(([a], [b]) => a - b);
  const maxHour = Math.max(
    1,
    ...overview.timeline.map(point =>
      SERIES.reduce((sum, series) => sum + (point[series.key] || 0), 0)
    )
  );
  const statusRows = byStatus.map(([code, total]) => ({ code: String(code), total, status: code }));
  const hourRows = overview.timeline.map(point => ({ ...point, hour: hourOf(point.timestamp) }));
  return (
    <Card
      title="Last 24 hours"
      aside={`${overview.total_errors_24h.toLocaleString('en-US')} error events`}
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <h4 className={SUBHEAD}>By category</h4>
          {byCategory.length === 0 && <span className={MUTED}>No errors recorded.</span>}
          {byCategory.map(([id, total]) => (
            <div
              key={id}
              className="grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-2 text-sm"
            >
              <span className="text-tp-slate">{categoryLabel(id)}</span>
              <Meter
                value={(total / Math.max(1, overview.total_errors_24h)) * 100}
                tone={
                  id === 'system_bug' || id === 'solver_failure'
                    ? 'error'
                    : id === 'pricing_quota' || id === 'concurrency'
                      ? 'warning'
                      : 'info'
                }
              />
              <strong className="text-right text-tp-ink">{total}</strong>
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <h4 className={SUBHEAD}>By status</h4>
          {byStatus.length === 0 ? (
            <span className={MUTED}>No errors recorded.</span>
          ) : (
            <div
              className="h-40 w-full"
              role="img"
              aria-label={`Errors by status: ${byStatus.map(([code, total]) => `${code}: ${total}`).join(', ')}`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={statusRows} margin={{ top: 16, right: 8, bottom: 0, left: -16 }}>
                  <XAxis dataKey="code" tick={TICK} stroke="var(--color-tp-hairline)" />
                  <YAxis allowDecimals={false} tick={TICK} stroke="var(--color-tp-hairline)" />
                  <Tooltip cursor={{ fill: 'var(--color-tp-surface)' }} />
                  <Bar
                    dataKey="total"
                    name="Errors"
                    radius={[3, 3, 0, 0]}
                    label={{ position: 'top', ...TICK }}
                  >
                    {statusRows.map(row => (
                      <Cell key={row.code} fill={CHART[barTone(row.status)]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <span className={MUTED}>
            402 means a quota ran out (expected); 503 means a dependency was down (worth a look).
          </span>
          <span className={MUTED}>
            The quota category also holds limits the gateway could not state or measure — a plan
            with no size limit declared, a size that could not be measured, a usage counter that
            could not be read. Those are a configuration or service fault, not something the user
            did.
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-2 lg:col-span-2">
          <h4 className={SUBHEAD}>By hour</h4>
          <div
            className="h-36 w-full"
            role="img"
            aria-label={`Error events per hour over the last 24 hours, at most ${maxHour} in one hour`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourRows} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                <XAxis
                  dataKey="hour"
                  tick={TICK}
                  stroke="var(--color-tp-hairline)"
                  minTickGap={16}
                />
                <YAxis allowDecimals={false} tick={TICK} stroke="var(--color-tp-hairline)" />
                <Tooltip cursor={{ fill: 'var(--color-tp-surface)' }} />
                {SERIES.map(series => (
                  <Bar
                    key={series.key}
                    dataKey={series.key}
                    name={series.label}
                    stackId="hour"
                    fill={CHART[series.tone]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-tp-slate" aria-label="Series">
            {SERIES.map(series => (
              <li key={series.key} className="flex items-center gap-1.5">
                <i className={`h-2.5 w-2.5 rounded-sm ${FILL[series.tone]}`} aria-hidden="true" />
                {series.label}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {overview.top_users_quota.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className={LABEL}>Accounts that hit quota or concurrency limits</span>
          <ul className="flex flex-wrap gap-3 text-sm">
            {overview.top_users_quota.map(entry => (
              <li key={entry.userId} className="flex items-center gap-2">
                <Link to={adminUserPath(entry.userId)} className={LINK}>
                  {entry.email ?? shortId(entry.userId)}
                </Link>
                <Tag tone="warning">{entry.errorCount} refusals</Tag>
              </li>
            ))}
          </ul>
        </div>
      )}
      {overview.top_solvers_failed.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className={LABEL}>Endpoints with solver failures</span>
          <ul className="flex flex-wrap gap-3 text-sm">
            {overview.top_solvers_failed.map(entry => (
              <li key={entry.engine} className="flex items-center gap-2">
                <code className="font-mono text-xs text-tp-ink">{entry.engine}</code>
                <Tag tone="error">{entry.failureCount} failures</Tag>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function EventDetail({ group, event }: { group: ErrorGroup; event: ErrorRow }) {
  const quota = event.detail.quota as
    | { limit_id?: string; used?: number; limit?: number; unit?: string; renews_at?: string }
    | undefined;
  const ratio =
    quota && typeof quota.used === 'number' && typeof quota.limit === 'number' && quota.limit > 0
      ? (quota.used / quota.limit) * 100
      : null;
  return (
    <div className="flex w-full flex-col gap-3">
      <dl className={`${FACTS} sm:grid-cols-1`}>
        <div>
          <dt>Route</dt>
          <dd className="font-mono">
            {event.method} {event.endpoint}
          </dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>
            {event.userId ? (
              <Link to={adminUserPath(event.userId)} className={LINK}>
                {event.userEmail ?? shortId(event.userId)}
              </Link>
            ) : (
              'Not signed in'
            )}
          </dd>
        </div>
        {event.organizationId && (
          <div>
            <dt>Organization</dt>
            <dd className="font-mono" title={event.organizationId}>
              {shortId(event.organizationId)}
            </dd>
          </div>
        )}
        <div>
          <dt>When</dt>
          <dd>{formatDateTime(event.createdAt) ?? event.createdAt}</dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd>{categoryLabel(group.category)}</dd>
        </div>
        <div>
          <dt>Reference</dt>
          <dd className="font-mono">err-{shortId(event.id)}</dd>
        </div>
      </dl>
      {quota && ratio !== null && (
        <div
          className="flex flex-col gap-1.5 rounded-lg bg-tp-surface p-3"
          aria-label="Quota at the time"
        >
          <span className="flex justify-between gap-2 text-sm">
            <span className="text-tp-slate">{quota.limit_id ?? 'Quota'}</span>
            <strong className="text-tp-ink">
              {quota.used} of {quota.limit} {quota.unit ?? ''}
            </strong>
          </span>
          <Meter value={ratio} tone="error" />
          {quota.renews_at && (
            <small className="text-xs text-tp-steel">
              Renews {formatDateTime(quota.renews_at) ?? quota.renews_at}
            </small>
          )}
        </div>
      )}
      <ViewSource value={event.detail} label="View source" />
    </div>
  );
}

/** The Errors section of `/admin`: what is failing on the platform, grouped by code, with the events behind each group. */
export default function ErrorsSection() {
  const api = useAdminApi();
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [account, setAccount] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [groupKey, setGroupKey] = useState('');
  const [eventId, setEventId] = useState('');
  const { copy, status: copied } = useCopy();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(draft.trim());
      setOffset(0);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const accountId = account.trim();
  const accountInvalid = accountId !== '' && !UUID.test(accountId);
  const overview = useResource('admin-errors-overview', () => api.adminErrorOverview());
  const list = useResource(
    `admin-errors:${category}:${status}:${accountInvalid ? '' : accountId}:${from}:${to}:${search}:${offset}`,
    () =>
      api.adminListErrors({
        category: category || undefined,
        status_code: status ? Number(status) : undefined,
        user_id: accountInvalid ? undefined : accountId || undefined,
        search: search || undefined,
        from_date: from ? `${from}T00:00:00Z` : undefined,
        to_date: to ? `${to}T23:59:59Z` : undefined,
        limit: PAGE,
        offset,
      })
  );

  const summary = overview.data ?? overview.stale;
  const page = list.data ?? list.stale;
  const overviewFailure =
    overview.status === 'error'
      ? describeAdminFailure(overview.error, 'The summary couldn’t be loaded')
      : null;
  const listFailure =
    list.status === 'error'
      ? describeAdminFailure(list.error, 'Error events couldn’t be loaded')
      : null;
  const rows = useMemo(() => (page?.items ?? []).map(readErrorEvent), [page]);
  const groups = useMemo(() => groupErrors(rows), [rows]);
  const group = groups.find(item => item.key === groupKey) ?? groups[0];
  const event = group
    ? (group.events.find(item => item.id === eventId) ?? group.events[0])
    : undefined;
  const filtering = Boolean(category || status || accountId || from || to || search);
  const categories = [
    ...new Set([...Object.keys(CATEGORIES), ...Object.keys(summary?.by_category_24h ?? {})]),
  ];
  const statuses = [
    ...new Set([...STATUSES, ...Object.keys(summary?.by_status_code_24h ?? {}).map(Number)]),
  ].sort((a, b) => a - b);

  const reset = (apply: () => void) => {
    apply();
    setOffset(0);
    setGroupKey('');
    setEventId('');
  };

  const clear = () =>
    reset(() => {
      setCategory('');
      setStatus('');
      setAccount('');
      setFrom('');
      setTo('');
      setDraft('');
      setSearch('');
    });
  const loading = list.status === 'loading' && !page;
  const none = page && page.total === 0 && !filtering;

  return (
    <>
      <SectionHeader
        title="Errors"
        lede="What’s failing, where and how often. Details are shown without request bodies."
      />
      {overviewFailure && <FailureNotice failure={overviewFailure} onRetry={overview.reload} />}
      {overview.status === 'loading' && !summary && (
        <Loading label="Loading the summary">
          <Skeleton variant="panel" />
        </Loading>
      )}
      {summary && <Summary overview={summary} />}

      <form className={TOOLBAR} role="search" onSubmit={submitted => submitted.preventDefault()}>
        <label className={FIELD}>
          <span className={LABEL}>Category</span>
          <select
            className={INPUT}
            value={category}
            onChange={changed => reset(() => setCategory(changed.target.value))}
          >
            <option value="">Any</option>
            {categories.map(id => (
              <option key={id} value={id}>
                {categoryLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label className={FIELD}>
          <span className={LABEL}>Status</span>
          <select
            className={INPUT}
            value={status}
            onChange={changed => reset(() => setStatus(changed.target.value))}
          >
            <option value="">Any</option>
            {statuses.map(code => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label className={FIELD}>
          <span className={LABEL}>Account id</span>
          <input
            className={INPUT}
            value={account}
            onChange={changed => reset(() => setAccount(changed.target.value))}
            placeholder="Any account"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={accountInvalid || undefined}
          />
        </label>
        <label className={FIELD}>
          <span className={LABEL}>From</span>
          <input
            type="date"
            className={INPUT}
            value={from}
            max={to || undefined}
            onChange={changed => reset(() => setFrom(changed.target.value))}
          />
        </label>
        <label className={FIELD}>
          <span className={LABEL}>To</span>
          <input
            type="date"
            className={INPUT}
            value={to}
            min={from || undefined}
            onChange={changed => reset(() => setTo(changed.target.value))}
          />
        </label>
        <label className={`${FIELD} flex-[1_1_12rem]`}>
          <span className={LABEL}>Search</span>
          <input
            className={INPUT}
            value={draft}
            onChange={changed => setDraft(changed.target.value)}
            placeholder="Code or route"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {filtering && (
          <Action size="sm" variant="secondary" onClick={clear}>
            Clear filters
          </Action>
        )}
      </form>
      {accountInvalid && (
        <span className={MUTED}>An account id is a UUID; the filter waits until it is one.</span>
      )}

      {listFailure && <FailureNotice failure={listFailure} onRetry={list.reload} />}
      {loading && (
        <Loading label="Loading error events">
          <Skeleton variant="panel" />
        </Loading>
      )}

      {none && (
        <EmptyState
          icon={<MdSentimentSatisfied />}
          title="No errors in the retention window"
          dashed
        >
          Good news: the gateway has recorded no error events.
        </EmptyState>
      )}
      {page && !none && rows.length === 0 && (
        <EmptyState
          icon={<MdSentimentSatisfied />}
          title="No events match these filters"
          action={
            <Action size="sm" variant="secondary" onClick={clear}>
              Clear filters
            </Action>
          }
        >
          Widen the dates or remove a filter.
        </EmptyState>
      )}

      {page && rows.length > 0 && group && event && (
        <>
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
            <ul className="flex min-w-0 flex-col gap-2" aria-label="Errors grouped by code">
              {groups.map(item => {
                const on = item.key === group.key;
                const latest = item.events[0];
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      aria-pressed={on}
                      className={`${PICK} sm:grid sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-x-3`}
                      onClick={() => {
                        setGroupKey(item.key);
                        setEventId('');
                      }}
                    >
                      <Tag tone={statusTone(item.status)}>{item.status}</Tag>
                      <span className="font-mono text-[13px] font-medium [overflow-wrap:anywhere] text-tp-ink">
                        {item.code}
                      </span>
                      <span className="font-semibold text-tp-ink">×{item.events.length}</span>
                      <span className="font-mono text-xs [overflow-wrap:anywhere] text-tp-slate sm:col-span-2 sm:col-start-2">
                        {latest.method} {latest.endpoint}
                      </span>
                      <span className={`${MUTED} sm:col-start-3 sm:row-start-2`}>
                        {formatDateTime(item.lastSeen) ?? item.lastSeen}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <aside
              className="flex min-w-0 flex-col items-start gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-5 lg:sticky lg:top-24"
              aria-label="Error detail"
            >
              <strong className="text-sm text-tp-ink">
                {group.status} · {group.code}
              </strong>
              <span className={MUTED}>{errorMeaning(group.code, group.status)}</span>
              <dl className={`${FACTS} w-full sm:grid-cols-1`}>
                <div>
                  <dt>Times on this page</dt>
                  <dd>{group.events.length}</dd>
                </div>
                <div>
                  <dt>Last seen</dt>
                  <dd>{formatDateTime(group.lastSeen) ?? group.lastSeen}</dd>
                </div>
                <div>
                  <dt>Category</dt>
                  <dd>{categoryLabel(group.category)}</dd>
                </div>
              </dl>
              {group.events.length > 1 && (
                <ul className="flex w-full flex-col gap-1.5" aria-label="Occurrences">
                  {group.events.slice(0, 8).map(item => (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-pressed={item.id === event.id}
                        className={PICK}
                        onClick={() => setEventId(item.id)}
                      >
                        <span className="font-mono text-xs [overflow-wrap:anywhere]">
                          {item.endpoint}
                        </span>
                        <span className={MUTED}>
                          {item.userEmail ?? (item.userId ? shortId(item.userId) : 'not signed in')}{' '}
                          · {formatDateTime(item.createdAt) ?? item.createdAt}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <EventDetail group={group} event={event} />
              <Action
                size="sm"
                variant="link"
                onClick={() =>
                  void copy(
                    `${group.status} ${group.code} ${event.method} ${event.endpoint}`,
                    'summary'
                  )
                }
              >
                {copied('summary') === 'copied'
                  ? 'Copied'
                  : copied('summary') === 'failed'
                    ? 'Couldn’t copy'
                    : 'Copy summary'}
              </Action>
            </aside>
          </div>
          <Pager
            offset={page.offset}
            limit={page.limit}
            total={page.total}
            shown={page.items.length}
            onPage={next => {
              setOffset(next);
              setGroupKey('');
              setEventId('');
            }}
            noun="events"
          />
          <span className={MUTED}>
            Events are grouped by status and code on the page you are looking at. The gateway keeps
            no “resolved” state for them: they age out when expired data is purged (90 days by
            default).
          </span>
        </>
      )}
    </>
  );
}
