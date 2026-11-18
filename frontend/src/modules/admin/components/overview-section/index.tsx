import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MdRefresh } from 'react-icons/md';
import type { AdminModerationOverview } from '../../../core/api/account';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { config } from '../../../../config';
import { formatDateTime } from '../../../core/utils/format';
import { useResource, type Resource } from '../../../core/hooks/useResource';
import { adminPath } from '../../../../routes/paths/admin';
import { useAdminApi } from '../../api/adminApi';
import { FILL, Meter, MUTED, SectionHeader, Tag, type MeterTone } from '../admin-parts';
import { ageLabel, count, describeAdminFailure, shortId, statusTone } from '../../utils/adminModel';

const PLAN_ORDER = ['FREE', 'RESEARCH', 'LAB'];
const PLAN_TONES: MeterTone[] = ['muted', 'info', 'success', 'warning'];

const QUEUE_STATES = [
  { id: 'queued', label: 'Queued', tone: 'muted' },
  { id: 'running', label: 'Running', tone: 'info' },
  { id: 'completed', label: 'Done', tone: 'success' },
  { id: 'failed', label: 'Failed', tone: 'error' },
  { id: 'cancelled', label: 'Cancelled', tone: 'muted' },
] as const;

const LINK = 'cursor-pointer text-[13px] font-medium text-tp-accent hover:underline';
const BIG = 'font-display text-3xl leading-none text-tp-ink';

/** One block of the overview: it loads on its own, so one that fails says so and the rest carry on. */
function Block({
  title,
  to,
  linkLabel = 'Open',
  resource,
  attention = false,
  children,
}: {
  title: string;
  to?: string;
  linkLabel?: string;
  resource: Resource<unknown>;
  attention?: boolean;
  children: ReactNode;
}) {
  const failed = resource.status === 'error' && resource.stale === undefined;
  const loading = resource.status === 'loading' && resource.stale === undefined;
  const failure = failed ? describeAdminFailure(resource.error, 'This block couldn’t load') : null;
  return (
    <section
      className={`flex min-w-0 flex-col gap-3 rounded-xl border bg-tp-canvas p-5 ${
        attention ? 'border-tp-severity-warning-border' : 'border-tp-hairline'
      }`}
      aria-label={title}
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-tp-ink">{title}</h3>
        {to && (
          <Link to={to} className={LINK}>
            {linkLabel}
          </Link>
        )}
      </header>
      {loading && (
        <div aria-busy="true">
          <span className="sr-only">Loading {title.toLowerCase()}</span>
          <Skeleton variant="tile" />
        </div>
      )}
      {failure && (
        <Notice
          tone={failure.tone}
          title={failure.status === 403 ? failure.title : 'This block couldn’t load'}
          action={
            failure.status === 403 ? undefined : (
              <Action size="sm" variant="secondary" onClick={resource.reload}>
                Retry this block
              </Action>
            )
          }
        >
          {failure.status === 403 ? failure.text : 'The rest of the page is fine.'}
        </Notice>
      )}
      {!loading && !failure && children}
    </section>
  );
}

function pendingOf(moderation: AdminModerationOverview | undefined) {
  const waiting = (map: Record<string, number> | undefined) => map?.pending_review ?? 0;
  return {
    engines: waiting(moderation?.engines),
    registrations: waiting(moderation?.registrations),
  };
}

/** The Overview section of `/admin`: how the platform is doing, and a way into every administration tool. */
export default function OverviewSection() {
  const api = useAdminApi();
  const overview = useResource('admin-overview', () => api.adminOverview());
  const queues = useResource('admin-overview-queues', async () => ({
    status: await api.adminQueues(),
    at: Date.now(),
  }));
  const moderation = useResource('admin-overview-moderation', () => api.adminModeration());
  const errors = useResource('admin-overview-errors', () => api.adminErrorOverview());
  const pricing = useResource('admin-overview-pricing', async () => ({
    live: (await api.getPlansPricing()).version,
  }));

  const reloadAll = () =>
    [overview, queues, moderation, errors, pricing].forEach(resource => resource.reload());
  const refreshing = [overview, queues, moderation, errors, pricing].some(
    resource => resource.status === 'loading' && resource.stale !== undefined
  );

  const summary = overview.data ?? overview.stale;
  const counts = summary?.counts ?? {};
  const plans = Object.entries(summary?.contracts ?? {}).sort(([a], [b]) => {
    const ia = PLAN_ORDER.indexOf(a);
    const ib = PLAN_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const accounts = counts.users ?? plans.reduce((sum, [, total]) => sum + total, 0);

  const queue = queues.data ?? queues.stale;
  const queueCounts = queue?.status.counts ?? {};
  const queueMax = Math.max(1, ...QUEUE_STATES.map(state => queueCounts[state.id] ?? 0));
  const oldest = queue?.status.oldestInFlight[0];

  const pending = pendingOf(moderation.data ?? moderation.stale);
  const waiting = pending.engines + pending.registrations;

  const errorOverview = errors.data ?? errors.stale;
  const byStatus = Object.entries(errorOverview?.by_status_code_24h ?? {})
    .map(([code, total]) => [Number(code), total] as const)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4);

  const pricingView = pricing.data ?? pricing.stale;
  const live = pricingView?.live ?? null;

  const tools: Array<[string, string, string]> = [
    [
      'Accounts',
      'Search accounts, activate or deactivate, change global role.',
      adminPath('users'),
    ],
    [
      'Account agreement',
      'Plan, add-ons, plan limits and keys of one account: open it from Accounts.',
      adminPath('users'),
    ],
    ['Audit log', 'Every contract, pricing and maintenance change.', adminPath('audit')],
    ['Errors', 'Error codes, routes and trends, without request bodies.', adminPath('errors')],
    ['Queues', 'Runs by state and the oldest ones waiting.', adminPath('queues')],
    ['Moderation', 'Review engine catalogue requests.', adminPath('moderation')],
    [
      'Maintenance',
      'Preview, then purge expired data or reconcile abandoned runs.',
      adminPath('maintenance'),
    ],
  ];

  return (
    <>
      <SectionHeader
        title="Overview"
        lede="The platform at a glance: each block loads on its own and leads to the tool that acts on it."
        actions={
          <Action variant="secondary" onClick={reloadAll} busy={refreshing}>
            <MdRefresh aria-hidden="true" />
            Refresh
          </Action>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Block title="Accounts" to={adminPath('users')} resource={overview}>
          <strong className={BIG}>{count(accounts)}</strong>
          {plans.length > 0 && (
            <span
              className="flex h-2 w-full overflow-hidden rounded-full bg-tp-hairline-soft"
              role="img"
              aria-label={`Accounts by plan: ${plans.map(([plan, total]) => `${plan} ${total}`).join(', ')}`}
            >
              {plans.map(([plan, total], index) => (
                <span
                  key={plan}
                  className={`h-full ${FILL[PLAN_TONES[index % PLAN_TONES.length]]}`}
                  style={{ flexGrow: total }}
                />
              ))}
            </span>
          )}
          <span className="flex flex-wrap gap-1.5">
            {plans.map(([plan, total]) => (
              <Tag key={plan} tone="plain">
                {total} {plan}
              </Tag>
            ))}
            {plans.length === 0 && <span className={MUTED}>No accounts yet</span>}
          </span>
          <span className={MUTED}>
            {count(counts.apiKeys)} API keys · {count(counts.identities)} linked identities
          </span>
        </Block>

        <Block title="Run queue" to={adminPath('queues')} resource={queues}>
          <div
            className="flex items-end gap-3"
            role="img"
            aria-label={QUEUE_STATES.map(
              state => `${state.label}: ${queueCounts[state.id] ?? 0}`
            ).join(', ')}
          >
            {QUEUE_STATES.map(state => (
              <span key={state.id} className="flex flex-1 flex-col items-center gap-1">
                <strong className="text-sm text-tp-ink">{queueCounts[state.id] ?? 0}</strong>
                <span
                  className={`w-full max-w-8 rounded-t ${FILL[state.tone]}`}
                  style={{
                    height: `${Math.max(3, Math.round(((queueCounts[state.id] ?? 0) / queueMax) * 52))}px`,
                  }}
                />
                <small className="text-[11px] text-tp-steel">{state.label}</small>
              </span>
            ))}
          </div>
          <span className={MUTED}>
            {oldest
              ? `Oldest waiting: ${oldest.engine} run, ${oldest.state} for ${ageLabel(oldest.createdAt, queue?.at ?? 0)}`
              : 'Nothing waiting or running.'}
          </span>
        </Block>

        <Block
          title="Moderation"
          to={adminPath('moderation')}
          resource={moderation}
          attention={waiting > 0}
        >
          <strong className={BIG}>{waiting}</strong>
          <ul className="flex flex-col gap-1 text-sm" aria-label="Waiting for review">
            <li className="flex justify-between gap-2">
              <span className="text-tp-slate">Engine catalogue requests</span>
              <strong className="text-tp-ink">{pending.registrations}</strong>
            </li>
            <li className="flex justify-between gap-2">
              <span className="text-tp-slate">Engine revisions</span>
              <strong className="text-tp-ink">{pending.engines}</strong>
            </li>
          </ul>
        </Block>

        <Block
          title="Errors, last 24 h"
          to={adminPath('errors')}
          linkLabel="Diagnose errors"
          resource={errors}
        >
          {byStatus.length === 0 && (
            <span className={MUTED}>No errors recorded in the last 24 hours.</span>
          )}
          {byStatus.map(([code, total]) => (
            <div key={code} className="grid grid-cols-[3.5rem_1fr_2.5rem] items-center gap-2">
              <Tag tone={statusTone(code)}>{code}</Tag>
              <Meter
                value={(total / Math.max(1, byStatus[0][1])) * 100}
                tone={code >= 500 ? 'error' : code === 402 || code === 429 ? 'warning' : 'info'}
              />
              <strong className="text-right text-sm text-tp-ink">{total}</strong>
            </div>
          ))}
          {errorOverview && (
            <span className={MUTED}>{count(errorOverview.total_errors_24h)} events in total</span>
          )}
        </Block>

        <Block title="Pricing" resource={pricing}>
          <span className="flex items-baseline gap-2">
            <span className={MUTED}>LIVE</span>
            <strong className={BIG}>{live ?? 'none'}</strong>
          </span>
          <span className="flex flex-wrap gap-3">
            <a
              href={config.spaceFrontendUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK}
            >
              Open SPACE console
            </a>
            <a href={config.sphereUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
              Open SPHERE console
            </a>
          </span>
          <span className={MUTED}>
            {live
              ? /^0\./.test(live)
                ? 'A 0.x release is a development copy. '
                : ''
              : 'No release is live. '}
            Pricings, versions, plans and contracts are administered in their own consoles.
          </span>
        </Block>

        <Block
          title="Recent changes"
          to={adminPath('audit')}
          linkLabel="Audit log"
          resource={overview}
        >
          {(summary?.recentAudit.length ?? 0) === 0 && (
            <span className={MUTED}>No platform events recorded yet.</span>
          )}
          <ul className="flex flex-col gap-2" aria-label="Recent audit events">
            {summary?.recentAudit.slice(0, 5).map(event => (
              <li key={event.id} className="flex flex-col">
                <code className="font-mono text-xs [overflow-wrap:anywhere] text-tp-ink">
                  {event.action}
                </code>
                <small className="text-xs text-tp-steel">
                  {formatDateTime(event.createdAt) ?? event.createdAt}
                  {event.actorId ? ` · ${shortId(event.actorId)}` : ''}
                </small>
              </li>
            ))}
          </ul>
        </Block>
      </div>

      <section
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        aria-label="The platform in numbers"
      >
        {(
          [
            ['Organizations', counts.organizations],
            ['Problems', counts.problems],
            ['Problem versions', counts.problemRevisions],
            ['Runs', counts.runs],
            ['Studies', counts.studies],
            ['Study runs', counts.studyRuns],
          ] as const
        ).map(([label, value]) => (
          <div
            key={label}
            className="flex flex-col rounded-xl border border-tp-hairline bg-tp-canvas p-3"
          >
            <strong className="text-lg font-semibold text-tp-ink">{count(value)}</strong>
            <span className="text-[11px] text-tp-steel">{label}</span>
          </div>
        ))}
      </section>

      <section aria-labelledby="adm-tools-title" className="flex flex-col gap-3">
        <h3 id="adm-tools-title" className="text-base font-semibold text-tp-ink">
          Tools
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {tools.map(([label, description, to]) => (
            <Link
              key={label}
              to={to}
              className="flex cursor-pointer flex-col gap-1 rounded-xl border border-tp-hairline bg-tp-canvas p-4 transition-colors hover:border-tp-stone hover:bg-tp-surface"
            >
              <span className="text-sm font-semibold text-tp-ink">{label}</span>
              <span className="text-[13px] text-tp-steel">{description}</span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
