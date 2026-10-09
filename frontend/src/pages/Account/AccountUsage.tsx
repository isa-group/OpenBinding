import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import type { PricingCatalog, UsageView } from '../../api/auth';
import { QuotaBar } from '../../components/QuotaBar';
import { INSTITUTION_NAME, useInstitutionalBranding } from '../../components/InstitutionMark/institution';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { formatDate } from '../../utils/format';
import { describeLimit, formatCount, formatDuration, type LimitDefinition } from '../../utils/limits';
import { usePricingTokenStatus, type PricingTokenStatus } from '../../utils/pricingToken';
import { useResource } from '../../utils/useResource';
import { featureName, readCatalog, type PricingView } from '../Pricing/pricingModel';
import { classifyAuthError, fallbackMessage } from './accountErrors';
import { AccountLayout, LoadFailure, PermissionNotice } from './AccountLayout';
import { daysUntil, nextRenewal, usageRows, type UsageRow } from './usageModel';
import './AccountUsage.css';

const CAPACITY_NOTES: Record<string, { note: string; link?: { to: string; label: string } }> = {
  concurrentJobs: { note: 'Jobs running now' },
  federatedEngines: { note: 'Engine revisions in use', link: { to: '/app/engines/registrations', label: 'My engines' } },
  apiKeys: { note: 'Active keys', link: { to: '/app/account/keys', label: 'Manage keys' } },
};

const TOKEN_CHIP: Record<PricingTokenStatus, string> = {
  valid: 'From your usage',
  stale: 'Plan check expired · can’t confirm',
  missing: 'Can’t confirm features',
};

const TOKEN_BANNER: Partial<Record<PricingTokenStatus, string>> = {
  stale: 'Your plan check has expired, so features can’t be confirmed from it right now. Log in again or reload the page to renew it. Nothing is blocked because of this: the server decides what you can do.',
  missing: 'No plan check is available yet, so features can’t be confirmed. This usually settles on your next request. Nothing is blocked because of this: the server decides what you can do.',
};

function limitDefinitions(catalog: PricingCatalog | null | undefined): Record<string, LimitDefinition> {
  const limits = catalog?.usageLimits;
  return typeof limits === 'object' && limits !== null ? limits as Record<string, LimitDefinition> : {};
}

function valueText(row: UsageRow, value: number | null): string {
  return describeLimit(row.info.kind, value).text;
}

function priceLine(plan: string, view: PricingView | null): string | null {
  const column = view?.plans.find((item) => item.id === plan);
  if (!column) return null;
  if (column.byAgreement) return 'Institutional agreement';
  return column.unitLabel === 'with verified CAS' ? 'Free with verified CAS' : column.priceLabel;
}

function MonthlyCard({ row }: { row: UsageRow }) {
  if (row.tracked) {
    const format = row.info.kind === 'seconds' ? formatDuration : formatCount;
    return <QuotaBar variant="card" limit={row.tracked} label={row.info.label} format={format} stops={row.info.short} />;
  }
  return (
    <div className="usage-card">
      <div className="usage-card-head">
        <span>{row.info.label}</span>
        {row.unit && <span className="usage-card-unit">{row.unit}</span>}
      </div>
      <div className="usage-card-figures">
        <span>Used: not reported</span>
        <strong>{row.limit === null ? 'Unlimited' : `${valueText(row, row.limit)} limit`}</strong>
      </div>
    </div>
  );
}

function UsageBody({ usage, loadedAt, catalog, release, token }: {
  usage: UsageView;
  loadedAt: number;
  catalog: PricingCatalog | null | undefined;
  release: { version: string } | null | undefined;
  token: PricingTokenStatus;
}) {
  const institutional = useInstitutionalBranding();
  const rows = usageRows(usage, limitDefinitions(catalog));
  const inGroup = (group: UsageRow['info']['group']) => rows.filter((row) => row.info.group === group);
  const monthly = inGroup('monthly');
  const capacity = inGroup('capacity');
  const ceilings = inGroup('ceiling');
  const sponsored = inGroup('sponsored');
  const renewal = nextRenewal(rows);
  const retention = ceilings.find((row) => row.id === 'jobHistoryDays');
  const pending = usage.contract_pending;
  const view = catalog ? readCatalog(catalog) : null;
  const price = priceLine(usage.plan, view);
  const features = view && view.features.length > 0
    ? view.features
    : Object.keys(usage.features).map((id) => ({ id, name: featureName(id) }));
  const confirmed = !pending && token === 'valid';

  return (
    <>
      {pending && (
        <Notice tone="info" title="Your contract is pending.">
          Pricing wasn’t reachable when you signed up. It’s settled on your next request; until then no feature or limit can be
          confirmed, and nothing here is shown as allowed or blocked.
        </Notice>
      )}

      <section className="usage-plan" aria-label="Your plan">
        <span className="usage-plan-tile" aria-hidden="true">{usage.plan.charAt(0)}</span>
        <div className="usage-plan-body">
          <div className="usage-plan-name">
            <strong>{usage.plan}</strong>
            {price && <Chip>{price}</Chip>}
            {institutional && <span className="acct-us-pill">{INSTITUTION_NAME}</span>}
          </div>
          <span className="usage-plan-line">
            {release ? `Live pricing ${release.version}` : 'Live pricing'}
            {renewal && ` · Monthly allowances renew ${formatDate(renewal)}`}
            {' · New pricing versions apply when your contract renews'}
          </span>
        </div>
        <div className="usage-plan-actions">
          <Action to="/pricing" variant="secondary" size="md">See plans</Action>
          <Action to="/pricing" variant="primary" size="md">Request a change</Action>
        </div>
      </section>

      <section className="acct-section" aria-labelledby="usage-features">
        <div className="usage-features-head">
          <h2 id="usage-features">Features</h2>
          <Chip tone={token === 'valid' && !pending ? 'success' : 'warning'}>{pending ? 'Contract pending' : TOKEN_CHIP[token]}</Chip>
        </div>
        {!pending && token !== 'valid' && <Notice tone="warning">{TOKEN_BANNER[token]}</Notice>}
        <ul className="usage-features">
          {features.map((feature) => {
            const on = usage.features[feature.id] === true;
            return (
              <li key={feature.id}>
                <span>{feature.name}</span>
                <span className={`usage-state${confirmed ? (on ? ' is-on' : '') : ' is-unknown'}`}>
                  {confirmed ? (on ? 'Enabled' : 'Not in plan') : 'Can’t confirm'}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {rows.length === 0 && !pending && (
        <p className="usage-empty">Your plan declares no usage limits, so there’s nothing to track here.</p>
      )}

      {!pending && monthly.length > 0 && (
        <section className="acct-section" aria-labelledby="usage-month">
          <div>
            <h2 id="usage-month">This month</h2>
            <p className="acct-muted">
              {renewal ? `Renews ${formatDate(renewal)} (in ${daysUntil(renewal, loadedAt)} days).` : 'Monthly allowances renew each month.'}
            </p>
          </div>
          <div className="usage-grid usage-grid-wide">
            {monthly.map((row) => <MonthlyCard key={row.id} row={row} />)}
          </div>
        </section>
      )}

      {!pending && capacity.length > 0 && (
        <section className="acct-section" aria-labelledby="usage-capacity">
          <div>
            <h2 id="usage-capacity">Capacity in use</h2>
            <p className="acct-muted">Freed when work finishes or keys are revoked; no renewal date.</p>
          </div>
          <div className="usage-grid">
            {capacity.map((row) => {
              const extra = CAPACITY_NOTES[row.id];
              return (
                <div key={row.id} className="usage-card">
                  <span className="usage-card-name">{row.info.label}</span>
                  <span className="usage-card-big">{row.used === null ? '–' : formatCount(row.used)} / {row.limit === null ? '∞' : formatCount(row.limit)}</span>
                  <span className="acct-muted">{extra?.note ?? 'In use'}{row.used === null ? ' · used not reported' : ''}</span>
                  {extra?.link && <Link to={extra.link.to} viewTransition>{extra.link.label}</Link>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {!pending && ceilings.length > 0 && (
        <section className="acct-section" aria-labelledby="usage-ceilings">
          <div>
            <h2 id="usage-ceilings">Per-request ceilings</h2>
            <p className="acct-muted">Budgets above these are reduced with an OPTION_CLAMPED note; bigger problems are rejected.</p>
          </div>
          <div className="usage-table-wrap" role="region" aria-label="Ceilings table" tabIndex={0}>
            <table className="usage-table">
              <thead>
                <tr><th scope="col">Ceiling</th><th scope="col">Your limit</th><th scope="col">Exact value</th></tr>
              </thead>
              <tbody>
                {ceilings.map((row) => {
                  const described = describeLimit(row.info.kind, row.limit);
                  return (
                    <tr key={row.id}>
                      <th scope="row">{row.info.label}</th>
                      <td><strong>{described.text}</strong></td>
                      <td className="usage-exact">{described.exact ?? (row.limit === null ? '.inf' : formatCount(row.limit))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {retention && retention.limit !== null && (
            <p className="usage-retention">
              Finished jobs are kept for {valueText(retention, retention.limit)}. <Link to="/app/jobs" viewTransition>Open job history</Link>
            </p>
          )}
        </section>
      )}

      {!pending && sponsored.length > 0 && (
        <section className="acct-section" aria-labelledby="usage-sponsored">
          <div>
            <h2 id="usage-sponsored">Organizations you sponsor</h2>
            <p className="acct-muted">
              Counted across every organization you sponsor. Sponsoring pays for usage only; it doesn’t give you any role in those organizations.
            </p>
          </div>
          <div className="usage-grid">
            {sponsored.map((row) => {
              const share = row.used !== null && row.limit ? Math.min(100, Math.round((row.used / row.limit) * 100)) : 0;
              return (
                <div key={row.id} className="usage-card usage-card-small">
                  <div className="usage-card-head">
                    <span>{row.info.label}</span>
                    <span>{row.used === null ? '' : `${valueText(row, row.used)} / `}{valueText(row, row.limit)}</span>
                  </div>
                  <div className="usage-mini-track" role="meter" aria-label={row.info.label} aria-valuemin={0} aria-valuemax={row.limit ?? 0} aria-valuenow={row.used ?? 0}>
                    <div style={{ width: `${share}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <details className="usage-all">
        <summary>All entitlement values</summary>
        <p className="acct-muted">Every allowance and ceiling of your plan as the gateway reports it. Nothing here is secret: it is the contract, not a credential.</p>
        <dl>
          {rows.map((row) => (
            <div key={row.id}>
              <dt><code>{row.id}</code></dt>
              <dd>{row.limit === null ? 'Unlimited' : formatCount(row.limit)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}

/** Usage & plan (`acct-usage`, `/app/account/usage`). */
export function AccountUsage() {
  const { user } = useAuth();
  const token = usePricingTokenStatus();
  const usage = useResource(`usage:${user?.id ?? ''}`, async () => ({ value: await apiClient.getOwnUsage(), loadedAt: Date.now() }));
  // The plan's wording and the live release are context; the page works without them.
  const catalog = useResource('usage-catalog', () => apiClient.getPricingCatalog().catch(() => null));
  const release = useResource('usage-release', () => apiClient.getCurrentPricing().catch(() => null));

  const failure = usage.status === 'error' ? classifyAuthError(usage.error) : null;
  const refresh = () => { usage.reload(); catalog.reload(); release.reload(); };

  return (
    <AccountLayout
      section="usage"
      title="Usage & plan"
      lede="What your plan allows and how much is left this month."
      actions={<Action variant="secondary" size="sm" onClick={refresh}>Refresh usage</Action>}
    >
      {usage.status === 'loading' && (
        <div aria-busy="true" className="usage-skeleton">
          <Skeleton variant="card" /><Skeleton variant="panel" /><Skeleton variant="panel" />
        </div>
      )}

      {failure?.status === 403 && <PermissionNotice permissions={['account:read']} action="see usage" />}
      {failure && failure.status !== 403 && (
        <LoadFailure onRetry={refresh}>
          {failure.status === 503
            ? <><strong>We can’t read your usage right now (503 · pricing_unavailable).</strong> We don’t show old figures as your current balance, and this doesn’t mean you’re out of quota.</>
            : fallbackMessage(failure, 'loaded')}
        </LoadFailure>
      )}

      {usage.data && (
        <UsageBody
          usage={usage.data.value}
          loadedAt={usage.data.loadedAt}
          catalog={catalog.data}
          release={release.data}
          token={token}
        />
      )}
    </AccountLayout>
  );
}
