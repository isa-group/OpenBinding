import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import type { AdminModerationOverview } from '../../api/auth';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { config } from '../../config';
import { formatDateTime } from '../../utils/format';
import { useResource, type Resource } from '../../utils/useResource';
import { AdminFrame, AdminOnly, Meter, Tag } from './AdminChrome';
import { ageLabel, count, describeAdminFailure, shortId, statusTone } from './adminModel';

const PLAN_ORDER = ['BASIC', 'ADVANCED', 'RESEARCH', 'PRO'];
const PLAN_TONES: Array<'muted' | 'info' | 'success' | 'warning'> = ['muted', 'info', 'success', 'warning'];

const QUEUE_STATES = [
  { id: 'queued', label: 'Queued', tone: 'muted' },
  { id: 'running', label: 'Running', tone: 'info' },
  { id: 'completed', label: 'Done', tone: 'success' },
  { id: 'failed', label: 'Failed', tone: 'error' },
  { id: 'cancelled', label: 'Cancelled', tone: 'muted' },
] as const;

/** One block of the overview: it loads on its own, so one that fails says so and the rest carry on. */
function Block({ title, to, linkLabel = 'Open', resource, className = '', children }: {
  title: string;
  to?: string;
  linkLabel?: string;
  resource: Resource<unknown>;
  className?: string;
  children: ReactNode;
}) {
  const failed = resource.status === 'error' && resource.stale === undefined;
  const loading = resource.status === 'loading' && resource.stale === undefined;
  const failure = failed ? describeAdminFailure(resource.error, 'This block couldn’t load') : null;
  return (
    <section className={`adm-block ${className}`.trim()} aria-label={title}>
      <header>
        <h2>{title}</h2>
        {to && <Link to={to} viewTransition>{linkLabel}</Link>}
      </header>
      {loading && <div aria-busy="true"><span className="sr-only">Loading {title.toLowerCase()}</span><Skeleton variant="tile" /></div>}
      {failure && (
        <Notice tone={failure.tone} title={failure.status === 403 ? failure.title : 'This block couldn’t load'} action={failure.status === 403 ? undefined : <Action size="sm" variant="secondary" onClick={resource.reload}>Retry this block</Action>}>
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
    dialects: waiting(moderation?.dialects),
  };
}

function OverviewScreen() {
  const overview = useResource('admin-overview', () => apiClient.adminOverview());
  const queues = useResource('admin-overview-queues', async () => ({ status: await apiClient.adminQueues(), at: Date.now() }));
  const moderation = useResource('admin-overview-moderation', () => apiClient.adminModeration());
  const errors = useResource('admin-overview-errors', () => apiClient.adminErrorOverview());
  const pricing = useResource('admin-overview-pricing', async () => ({ live: (await apiClient.getCurrentPricing()).version }));

  const reloadAll = () => [overview, queues, moderation, errors, pricing].forEach((resource) => resource.reload());
  const refreshing = [overview, queues, moderation, errors, pricing].some((resource) => resource.status === 'loading' && resource.stale !== undefined);

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
  const queueMax = Math.max(1, ...QUEUE_STATES.map((state) => queueCounts[state.id] ?? 0));
  const oldest = queue?.status.oldestInFlight[0];

  const pending = pendingOf(moderation.data ?? moderation.stale);
  const waiting = pending.engines + pending.registrations + pending.dialects;

  const errorOverview = errors.data ?? errors.stale;
  const byStatus = Object.entries(errorOverview?.by_status_code_24h ?? {}).map(([code, total]) => [Number(code), total] as const).sort(([, a], [, b]) => b - a).slice(0, 4);

  const pricingView = pricing.data ?? pricing.stale;
  const live = pricingView?.live ?? null;

  const tools: Array<[string, string, string]> = [
    ['Accounts', 'Search accounts, activate or deactivate, change global role.', '/app/admin/users'],
    ['Account agreement', 'Plan, add-ons, plan limits and keys of one account: open it from Accounts.', '/app/admin/users'],
    ['Audit log', 'Every contract, pricing and maintenance change.', '/app/admin/audit'],
    ['Errors', 'Error codes, routes and trends, without request bodies.', '/app/admin/errors'],
    ['Queues', 'Jobs by state and the oldest ones waiting.', '/app/admin/queues'],
    ['Moderation', 'Review engine publication requests, and approve dialects and resources.', '/app/admin/moderation'],
    ['Maintenance', 'Preview, then purge expired data or reconcile abandoned jobs.', '/app/admin/maintenance'],
  ];

  return (
    <AdminFrame
      section="overview"
      trail={[{ label: 'Administration' }]}
      title="Administration"
      lede="How the platform is doing, and where to act. Contract, pricing and maintenance changes are recorded in the audit log."
      actions={<Action variant="secondary" onClick={reloadAll} busy={refreshing}><RefreshCw aria-hidden="true" />Refresh</Action>}
    >
      <div className="adm-blocks">
        <Block title="Accounts" to="/app/admin/users" resource={overview}>
          <strong className="adm-big">{count(accounts)}</strong>
          {plans.length > 0 && (
            <span className="adm-stack-bar" role="img" aria-label={`Accounts by plan: ${plans.map(([plan, total]) => `${plan} ${total}`).join(', ')}`}>
              {plans.map(([plan, total], index) => (
                <span key={plan} className={`is-${PLAN_TONES[index % PLAN_TONES.length]}`} style={{ flexGrow: total }} />
              ))}
            </span>
          )}
          <span className="adm-chip-row">
            {plans.map(([plan, total]) => <Tag key={plan} tone="plain">{total} {plan}</Tag>)}
            {plans.length === 0 && <span className="adm-muted">No accounts yet</span>}
          </span>
          <span className="adm-muted">{count(counts.apiKeys)} API keys · {count(counts.identities)} linked identities</span>
        </Block>

        <Block title="Job queue" to="/app/admin/queues" resource={queues}>
          <div className="adm-queue-bars" role="img" aria-label={QUEUE_STATES.map((state) => `${state.label}: ${queueCounts[state.id] ?? 0}`).join(', ')}>
            {QUEUE_STATES.map((state) => (
              <span key={state.id} className="adm-queue-bar">
                <strong>{queueCounts[state.id] ?? 0}</strong>
                <span className={`is-${state.tone}`} style={{ height: `${Math.max(3, Math.round(((queueCounts[state.id] ?? 0) / queueMax) * 52))}px` }} />
                <small>{state.label}</small>
              </span>
            ))}
          </div>
          <span className="adm-muted">
            {oldest ? `Oldest waiting: ${oldest.engine} job, ${oldest.state} for ${ageLabel(oldest.createdAt, queue?.at ?? 0)}` : 'Nothing waiting or running.'}
          </span>
        </Block>

        <Block title="Moderation" to="/app/admin/moderation" resource={moderation} className={waiting > 0 ? 'is-attention' : ''}>
          <strong className="adm-big">{waiting}</strong>
          <ul className="adm-lines" aria-label="Waiting for review">
            <li><span>Engine publication requests</span><strong>{pending.registrations}</strong></li>
            <li><span>Engine revisions</span><strong>{pending.engines}</strong></li>
            <li><span>Dialects</span><strong>{pending.dialects}</strong></li>
          </ul>
        </Block>

        <Block title="Errors, last 24 h" to="/app/admin/errors" linkLabel="Diagnose errors" resource={errors}>
          {byStatus.length === 0 && <span className="adm-muted">No errors recorded in the last 24 hours.</span>}
          {byStatus.map(([code, total]) => (
            <div key={code} className="adm-barrow is-narrow">
              <Tag tone={statusTone(code)}>{code}</Tag>
              <Meter value={(total / Math.max(1, byStatus[0][1])) * 100} tone={code >= 500 ? 'error' : code === 402 || code === 429 ? 'warning' : 'info'} />
              <strong>{total}</strong>
            </div>
          ))}
          {errorOverview && <span className="adm-muted">{count(errorOverview.total_errors_24h)} events in total</span>}
        </Block>

        <Block title="Pricing" resource={pricing}>
          <span className="adm-livever"><span className="adm-muted">LIVE</span><strong className="adm-big">{live ?? 'none'}</strong></span>
          <span className="adm-chip-row">
            <a href={config.spaceFrontendUrl} target="_blank" rel="noopener noreferrer">Open SPACE console</a>
            <a href={config.sphereUrl} target="_blank" rel="noopener noreferrer">Open SPHERE console</a>
          </span>
          <span className="adm-muted">
            {live ? (/^0\./.test(live) ? 'A 0.x release is a development copy. ' : '') : 'No release is live. '}
            Pricings, versions, plans and contracts are administered in their own consoles.
          </span>
        </Block>

        <Block title="Recent changes" to="/app/admin/audit" linkLabel="Audit log" resource={overview}>
          {(summary?.recentAudit.length ?? 0) === 0 && <span className="adm-muted">No platform events recorded yet.</span>}
          <ul className="adm-recent" aria-label="Recent audit events">
            {summary?.recentAudit.slice(0, 5).map((event) => (
              <li key={event.id}><code>{event.action}</code><small>{formatDateTime(event.createdAt) ?? event.createdAt}{event.actorId ? ` · ${shortId(event.actorId)}` : ''}</small></li>
            ))}
          </ul>
        </Block>
      </div>

      <section className="adm-numbers" aria-label="The platform in numbers">
        {([['Organizations', counts.organizations], ['Projects', counts.projects], ['Binding cases', counts.cases], ['Studies', counts.studies], ['Study runs', counts.studyRuns], ['Stored artifacts', counts.artifacts]] as const).map(([label, value]) => (
          <div key={label}><strong>{count(value)}</strong><span>{label}</span></div>
        ))}
      </section>

      <section aria-labelledby="adm-tools-title" className="adm-tools">
        <h2 id="adm-tools-title">Tools</h2>
        <div className="adm-tools-grid">
          {tools.map(([label, description, to]) => (
            <Link key={label} className="adm-tool" to={to} viewTransition>
              <span className="adm-tool-title">{label}</span>
              <span>{description}</span>
            </Link>
          ))}
        </div>
      </section>

    </AdminFrame>
  );
}

// [impl->req~frontend-retire-sponsorship-entry-points-removed~1]
/** admin-overview: how the platform is doing, and a way into every administration screen. */
export function AdminOverview() {
  return <AdminOnly><OverviewScreen /></AdminOnly>;
}
