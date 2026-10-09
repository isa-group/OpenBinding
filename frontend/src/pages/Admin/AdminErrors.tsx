import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Smile } from 'lucide-react';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { EmptyState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { ViewSource } from '../Engines/EngineParts';
import { AdminFrame, AdminOnly, FailureNotice, Meter, Pager, Tag } from './AdminChrome';
import { describeAdminFailure, errorMeaning, groupErrors, readErrorEvent, shortId, statusTone, UUID, type ErrorGroup, type ErrorRow } from './adminModel';
import type { AdminErrorOverview } from './types';

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

function barTone(status: number): 'error' | 'warning' | 'info' {
  return status >= 500 ? 'error' : status === 402 || status === 429 ? 'warning' : 'info';
}

function Summary({ overview }: { overview: AdminErrorOverview }) {
  const byCategory = Object.entries(overview.by_category_24h).sort(([, a], [, b]) => b - a);
  const byStatus = Object.entries(overview.by_status_code_24h).map(([code, total]) => [Number(code), total] as const).sort(([a], [b]) => a - b);
  const maxStatus = Math.max(1, ...byStatus.map(([, total]) => total));
  const maxHour = Math.max(1, ...overview.timeline.map((point) => SERIES.reduce((sum, series) => sum + (point[series.key] || 0), 0)));
  return (
    <section className="adm-card adm-summary" aria-labelledby="adm-errors-summary">
      <div className="adm-card-head">
        <h2 id="adm-errors-summary">Last 24 hours</h2>
        <span className="adm-muted">{overview.total_errors_24h.toLocaleString('en-US')} error events</span>
      </div>
      <div className="adm-summary-grid">
        <div className="adm-summary-block">
          <h3>By category</h3>
          {byCategory.length === 0 && <span className="adm-muted">No errors recorded.</span>}
          {byCategory.map(([id, total]) => (
            <div key={id} className="adm-barrow">
              <span>{categoryLabel(id)}</span>
              <Meter value={(total / Math.max(1, overview.total_errors_24h)) * 100} tone={id === 'system_bug' || id === 'solver_failure' ? 'error' : id === 'pricing_quota' || id === 'concurrency' ? 'warning' : 'info'} />
              <strong>{total}</strong>
            </div>
          ))}
        </div>
        <div className="adm-summary-block">
          <h3>By status</h3>
          {byStatus.length === 0 ? <span className="adm-muted">No errors recorded.</span> : (
            <div className="adm-columns" role="img" aria-label={`Errors by status: ${byStatus.map(([code, total]) => `${code}: ${total}`).join(', ')}`}>
              {byStatus.map(([code, total]) => (
                <span key={code} className="adm-column">
                  <strong>{total}</strong>
                  <span className={`adm-column-bar is-${barTone(code)}`} style={{ height: `${Math.max(4, Math.round((total / maxStatus) * 72))}px` }} />
                  <small>{code}</small>
                </span>
              ))}
            </div>
          )}
          <span className="adm-muted">402 means a quota ran out (expected); 503 means a dependency was down (worth a look).</span>
        </div>
        <div className="adm-summary-block adm-summary-wide">
          <h3>By hour</h3>
          <div className="adm-hours" role="img" aria-label={`Error events per hour over the last 24 hours, at most ${maxHour} in one hour`}>
            {overview.timeline.map((point) => (
              <span key={point.timestamp} className="adm-hour" title={`${formatDateTime(point.timestamp) ?? point.timestamp}`}>
                {SERIES.map((series) => (point[series.key] ? (
                  <span key={series.key} className={`is-${series.tone}`} style={{ height: `${(point[series.key] / maxHour) * 100}%` }} />
                ) : null))}
              </span>
            ))}
          </div>
          <ul className="adm-legend" aria-label="Series">
            {SERIES.map((series) => <li key={series.key}><i className={`is-${series.tone}`} aria-hidden="true" />{series.label}</li>)}
          </ul>
        </div>
      </div>

      {overview.top_users_quota.length > 0 && (
        <div className="adm-chips-row">
          <span className="adm-label">Accounts that hit quota or concurrency limits</span>
          <ul>
            {overview.top_users_quota.map((entry) => (
              <li key={entry.userId}>
                <Link to={`/app/admin/users/${entry.userId}`} viewTransition>{entry.email ?? shortId(entry.userId)}</Link>
                <Tag tone="warning">{entry.errorCount} refusals</Tag>
              </li>
            ))}
          </ul>
        </div>
      )}
      {overview.top_solvers_failed.length > 0 && (
        <div className="adm-chips-row">
          <span className="adm-label">Endpoints with solver failures</span>
          <ul>
            {overview.top_solvers_failed.map((entry) => (
              <li key={entry.engine}><code>{entry.engine}</code><Tag tone="error">{entry.failureCount} failures</Tag></li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function EventDetail({ group, event }: { group: ErrorGroup; event: ErrorRow }) {
  const quota = event.detail.quota as { limit_id?: string; used?: number; limit?: number; unit?: string; renews_at?: string } | undefined;
  const ratio = quota && typeof quota.used === 'number' && typeof quota.limit === 'number' && quota.limit > 0 ? (quota.used / quota.limit) * 100 : null;
  return (
    <div className="adm-event-detail">
      <dl className="adm-detail">
        <div><dt>Route</dt><dd className="is-mono">{event.method} {event.endpoint}</dd></div>
        <div>
          <dt>Account</dt>
          <dd>
            {event.userId
              ? <Link to={`/app/admin/users/${event.userId}`}>{event.userEmail ?? shortId(event.userId)}</Link>
              : 'Not signed in'}
          </dd>
        </div>
        {event.organizationId && <div><dt>Organization</dt><dd className="is-mono" title={event.organizationId}>{shortId(event.organizationId)}</dd></div>}
        <div><dt>When</dt><dd>{formatDateTime(event.createdAt) ?? event.createdAt}</dd></div>
        <div><dt>Category</dt><dd>{categoryLabel(group.category)}</dd></div>
        <div><dt>Reference</dt><dd className="is-mono">err-{shortId(event.id)}</dd></div>
      </dl>
      {quota && ratio !== null && (
        <div className="adm-quota" aria-label="Quota at the time">
          <span className="adm-usage-line"><span>{quota.limit_id ?? 'Quota'}</span><strong>{quota.used} of {quota.limit} {quota.unit ?? ''}</strong></span>
          <Meter value={ratio} tone="error" />
          {quota.renews_at && <small className="adm-muted">Renews {formatDateTime(quota.renews_at) ?? quota.renews_at}</small>}
        </div>
      )}
      <ViewSource value={event.detail} label="View source" />
    </div>
  );
}

function ErrorsScreen() {
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
  const overview = useResource('admin-errors-overview', () => apiClient.adminErrorOverview());
  const list = useResource(`admin-errors:${category}:${status}:${accountInvalid ? '' : accountId}:${from}:${to}:${search}:${offset}`, () => apiClient.adminListErrors({
    category: category || undefined,
    status_code: status ? Number(status) : undefined,
    user_id: accountInvalid ? undefined : accountId || undefined,
    search: search || undefined,
    from_date: from ? `${from}T00:00:00Z` : undefined,
    to_date: to ? `${to}T23:59:59Z` : undefined,
    limit: PAGE,
    offset,
  }));

  const summary = overview.data ?? overview.stale;
  const page = list.data ?? list.stale;
  const overviewFailure = overview.status === 'error' ? describeAdminFailure(overview.error, 'The summary couldn’t be loaded') : null;
  const listFailure = list.status === 'error' ? describeAdminFailure(list.error, 'Error events couldn’t be loaded') : null;
  const rows = useMemo(() => (page?.items ?? []).map(readErrorEvent), [page]);
  const groups = useMemo(() => groupErrors(rows), [rows]);
  const group = groups.find((item) => item.key === groupKey) ?? groups[0];
  const event = group ? group.events.find((item) => item.id === eventId) ?? group.events[0] : undefined;
  const filtering = Boolean(category || status || accountId || from || to || search);
  const categories = [...new Set([...Object.keys(CATEGORIES), ...Object.keys(summary?.by_category_24h ?? {})])];
  const statuses = [...new Set([...STATUSES, ...Object.keys(summary?.by_status_code_24h ?? {}).map(Number)])].sort((a, b) => a - b);

  const reset = (apply: () => void) => {
    apply();
    setOffset(0);
    setGroupKey('');
    setEventId('');
  };

  const clear = () => reset(() => { setCategory(''); setStatus(''); setAccount(''); setFrom(''); setTo(''); setDraft(''); setSearch(''); });
  const loading = list.status === 'loading' && !page;
  const none = page && page.total === 0 && !filtering;

  return (
    <AdminFrame
      section="errors"
      trail={[{ label: 'Administration', to: '/app/admin' }, { label: 'Errors' }]}
      title="Errors"
      lede="What’s failing, where and how often. Details are shown without request bodies."
    >
      {overviewFailure && <FailureNotice failure={overviewFailure} onRetry={overview.reload} />}
      {overview.status === 'loading' && !summary && <div aria-busy="true"><span className="sr-only">Loading the summary</span><Skeleton variant="panel" /></div>}
      {summary && <Summary overview={summary} />}

      <form className="adm-filters" role="search" onSubmit={(submitted) => submitted.preventDefault()}>
        <label className="adm-select">
          <span>Category</span>
          <select value={category} onChange={(changed) => reset(() => setCategory(changed.target.value))}>
            <option value="">Any</option>
            {categories.map((id) => <option key={id} value={id}>{categoryLabel(id)}</option>)}
          </select>
        </label>
        <label className="adm-select">
          <span>Status</span>
          <select value={status} onChange={(changed) => reset(() => setStatus(changed.target.value))}>
            <option value="">Any</option>
            {statuses.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </label>
        <label className="adm-select">
          <span>Account id</span>
          <input value={account} onChange={(changed) => reset(() => setAccount(changed.target.value))} placeholder="Any account" autoComplete="off" spellCheck={false} aria-invalid={accountInvalid || undefined} />
        </label>
        <label className="adm-select">
          <span>From</span>
          <input type="date" value={from} max={to || undefined} onChange={(changed) => reset(() => setFrom(changed.target.value))} />
        </label>
        <label className="adm-select">
          <span>To</span>
          <input type="date" value={to} min={from || undefined} onChange={(changed) => reset(() => setTo(changed.target.value))} />
        </label>
        <label className="adm-select adm-grow">
          <span>Search</span>
          <input value={draft} onChange={(changed) => setDraft(changed.target.value)} placeholder="Code or route" autoComplete="off" spellCheck={false} />
        </label>
        {filtering && <Action size="sm" variant="secondary" onClick={clear}>Clear filters</Action>}
      </form>
      {accountInvalid && <span className="adm-muted">An account id is a UUID; the filter waits until it is one.</span>}

      {listFailure && <FailureNotice failure={listFailure} onRetry={list.reload} />}
      {loading && <div aria-busy="true" className="adm-skeleton"><span className="sr-only">Loading error events</span><Skeleton variant="panel" /></div>}

      {none && <EmptyState icon={<Smile />} title="No errors in the retention window" dashed>Good news: the gateway has recorded no error events.</EmptyState>}
      {page && !none && rows.length === 0 && (
        <EmptyState icon={<Smile />} title="No events match these filters" action={<Action size="sm" variant="secondary" onClick={clear}>Clear filters</Action>}>
          Widen the dates or remove a filter.
        </EmptyState>
      )}

      {page && rows.length > 0 && group && event && (
        <>
          <div className="adm-split">
            <ul className="adm-groups" aria-label="Errors grouped by code">
              {groups.map((item) => {
                const on = item.key === group.key;
                const latest = item.events[0];
                return (
                  <li key={item.key}>
                    <button type="button" aria-pressed={on} className={`adm-group${on ? ' is-on' : ''}`} onClick={() => { setGroupKey(item.key); setEventId(''); }}>
                      <Tag tone={statusTone(item.status)}>{item.status}</Tag>
                      <span className="adm-group-code">{item.code}</span>
                      <span className="adm-group-route">{latest.method} {latest.endpoint}</span>
                      <span className="adm-group-count">×{item.events.length}</span>
                      <span className="adm-muted">{formatDateTime(item.lastSeen) ?? item.lastSeen}</span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <aside className="adm-aside" aria-label="Error detail">
              <strong>{group.status} · {group.code}</strong>
              <span className="adm-muted">{errorMeaning(group.code, group.status)}</span>
              <dl className="adm-detail">
                <div><dt>Times on this page</dt><dd>{group.events.length}</dd></div>
                <div><dt>Last seen</dt><dd>{formatDateTime(group.lastSeen) ?? group.lastSeen}</dd></div>
                <div><dt>Category</dt><dd>{categoryLabel(group.category)}</dd></div>
              </dl>
              {group.events.length > 1 && (
                <ul className="adm-occurrences" aria-label="Occurrences">
                  {group.events.slice(0, 8).map((item) => (
                    <li key={item.id}>
                      <button type="button" aria-pressed={item.id === event.id} className={item.id === event.id ? 'is-on' : undefined} onClick={() => setEventId(item.id)}>
                        <span className="is-mono">{item.endpoint}</span>
                        <span className="adm-muted">{item.userEmail ?? (item.userId ? shortId(item.userId) : 'not signed in')} · {formatDateTime(item.createdAt) ?? item.createdAt}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <EventDetail group={group} event={event} />
              <Action size="sm" variant="link" onClick={() => void copy(`${group.status} ${group.code} ${event.method} ${event.endpoint}`, 'summary')}>
                {copied('summary') === 'copied' ? 'Copied' : copied('summary') === 'failed' ? 'Couldn’t copy' : 'Copy summary'}
              </Action>
            </aside>
          </div>
          <Pager offset={page.offset} limit={page.limit} total={page.total} shown={page.items.length} onPage={(next) => { setOffset(next); setGroupKey(''); setEventId(''); }} noun="events" />
          <span className="adm-muted">
            Events are grouped by status and code on the page you are looking at. The gateway keeps no “resolved” state for them: they age out when expired data is purged (90 days by default).
          </span>
        </>
      )}
    </AdminFrame>
  );
}

/** admin-errors: what is failing on the platform, grouped by code, with the events behind each group. */
export function AdminErrors() {
  return <AdminOnly><ErrorsScreen /></AdminOnly>;
}
