import { Link } from 'react-router-dom';
import { apiClient } from '../../api/client';
import type { PricingCatalog, UsageView } from '../../api/auth';
import { INSTITUTION_NAME, useInstitutionalBranding } from '../../components/InstitutionMark/institution';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { DataTable } from '../../components/ui/DataTable';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { config } from '../../config';
import { useAuth } from '../../contexts/auth';
import { describeLimit, formatCount, type LimitDefinition } from '../../utils/limits';
import { usePricingTokenStatus, type PricingTokenStatus } from '../../utils/pricingToken';
import { useResource } from '../../utils/useResource';
import { featureName, readCatalog, type PricingView } from '../Pricing/pricingModel';
import { classifyAuthError, fallbackMessage } from './accountErrors';
import { AccountLayout, LoadFailure, PermissionNotice } from './AccountLayout';
import { NO_LIMIT_TEXT, exactValueText, usageRows, type UsageRow } from './usageModel';
import './AccountUsage.css';

const ALLOWANCE_NOTES: Record<string, { note: string; link?: { to: string; label: string } }> = {
  concurrentJobs: { note: 'Jobs that may run at once' },
  federatedEngines: { note: 'Engine revisions you may register', link: { to: '/app/engines/registrations', label: 'My engines' } },
  apiKeys: { note: 'Active keys', link: { to: '/app/account/keys', label: 'Manage keys' } },
};

const TOKEN_CHIP: Record<PricingTokenStatus, string> = {
  valid: 'Confirmed by your plan check',
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

function valueText(row: UsageRow): string {
  return describeLimit(row.info.kind, row.limit).text;
}

function priceLine(plan: string, view: PricingView | null): string | null {
  const column = view?.plans.find((item) => item.id === plan);
  if (!column) return null;
  if (column.byAgreement) return 'Institutional agreement';
  return column.unitLabel === 'with verified CAS' ? 'Free with verified CAS' : column.priceLabel;
}

/** The addresses of the native consoles, where pricings, plans and contracts are managed. This screen only links to them. */
function ConsoleLinks() {
  return (
    <section className="acct-section" aria-labelledby="usage-consoles">
      <div>
        <h2 id="usage-consoles">Plans, prices and contracts</h2>
        <p className="acct-muted">
          OpenBinding shows your plan and what it lets you do. Prices, pricing versions and contracts are managed in the native
          SPACE and SPHERE consoles, not here.
        </p>
      </div>
      <p className="usage-consoles">
        <a href={config.spaceFrontendUrl} target="_blank" rel="noopener noreferrer">Open SPACE console</a>
        <a href={config.sphereUrl} target="_blank" rel="noopener noreferrer">Open SPHERE console</a>
        <Link to="/pricing" viewTransition>See the published plans</Link>
      </p>
    </section>
  );
}

function UsageBody({ usage, catalog, release, token }: {
  usage: UsageView;
  catalog: PricingCatalog | null | undefined;
  release: { version: string } | null | undefined;
  token: PricingTokenStatus;
}) {
  const institutional = useInstitutionalBranding();
  const { user } = useAuth();
  const rows = usageRows(usage, limitDefinitions(catalog));
  const inGroup = (...groups: Array<UsageRow['info']['group']>) => rows.filter((row) => groups.includes(row.info.group));
  const allowances = inGroup('monthly', 'capacity');
  const ceilings = inGroup('ceiling');
  const sponsored = inGroup('sponsored');
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
        {usage.plan && <span className="usage-plan-tile" aria-hidden="true">{usage.plan.charAt(0)}</span>}
        <div className="usage-plan-body">
          <div className="usage-plan-name">
            <strong>{usage.plan || 'No remote plan (local demo)'}</strong>
            {price && <Chip>{price}</Chip>}
            {institutional && <span className="acct-us-pill">{INSTITUTION_NAME}</span>}
          </div>
          <span className="usage-plan-line">
            {release ? `Published pricing ${release.version}` : 'Published pricing'}
            {' · A new pricing version applies when your contract is renewed in SPACE'}
          </span>
        </div>
        <div className="usage-plan-actions">
          <Action to="/pricing" variant="secondary" size="md">See plans</Action>
        </div>
      </section>

      <ConsoleLinks />

      <section className="acct-section" aria-labelledby="usage-permissions">
        <div>
          <h2 id="usage-permissions">Your permissions</h2>
          <p className="acct-muted">
            Your platform role is <strong>{user?.role ?? 'user'}</strong>. Your plan decides which features you have; your role in each
            organization decides what you can change there, and an API key can never exceed your account.
          </p>
        </div>
        <p className="usage-consoles">
          <Link to="/app" viewTransition>Your organizations and roles</Link>
          <Link to="/app/account/keys" viewTransition>Your API keys</Link>
        </p>
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
        <p className="usage-empty">Your plan declares no limits.</p>
      )}

      {!pending && allowances.length > 0 && (
        <section className="acct-section" aria-labelledby="usage-allowances">
          <div>
            <h2 id="usage-allowances">What your plan allows</h2>
            <p className="acct-muted">The most your plan permits at a time. Nothing is metered or charged per request.</p>
          </div>
          <div className="usage-grid">
            {allowances.map((row) => {
              const extra = ALLOWANCE_NOTES[row.id];
              return (
                <div key={row.id} className="usage-card">
                  <span className="usage-card-name">{row.info.label}</span>
                  <span className="usage-card-big">{row.limit === null ? 'Unlimited' : formatCount(row.limit)}</span>
                  {extra && <span className="acct-muted">{extra.note}</span>}
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
          <DataTable label="Ceilings table" minWidth={480}>
            <thead>
              <tr><th scope="col">Ceiling</th><th scope="col">Your limit</th><th scope="col">Exact value</th></tr>
            </thead>
            <tbody>
              {ceilings.map((row) => (
                <tr key={row.id}>
                  <th scope="row" className="usage-ceiling">{row.info.label}</th>
                  <td><strong>{valueText(row)}</strong></td>
                  <td className="usage-exact">{exactValueText(row)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {retention && retention.limit !== null && (
            <p className="usage-retention">
              Finished jobs are kept for {valueText(retention)}. <Link to="/app/jobs" viewTransition>Open job history</Link>
            </p>
          )}
        </section>
      )}

      {!pending && sponsored.length > 0 && (
        <section className="acct-section" aria-labelledby="usage-sponsored">
          <div>
            <h2 id="usage-sponsored">Organizations you sponsor</h2>
            <p className="acct-muted">
              Limits across every organization you sponsor. Sponsoring pays for the plan only; it doesn’t give you any role in those organizations.
            </p>
          </div>
          <div className="usage-grid">
            {sponsored.map((row) => (
              <div key={row.id} className="usage-card usage-card-small">
                <div className="usage-card-head">
                  <span>{row.info.label}</span>
                  <span>Up to {valueText(row)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <details className="usage-all">
        <summary>All entitlement values</summary>
        <p className="acct-muted">Every limit of your plan as the gateway reports it, by its technical name. Nothing here is secret: it is the contract, not a credential.</p>
        <dl>
          {rows.map((row) => (
            <div key={row.id}>
              <dt><code>{row.id}</code></dt>
              <dd>{row.limit === null || !Number.isFinite(row.limit) ? NO_LIMIT_TEXT : formatCount(row.limit)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}

/** Plan & permissions (`acct-usage`, `/app/account/usage`: the address is kept). */
export function AccountUsage() {
  const { user } = useAuth();
  const token = usePricingTokenStatus();
  const usage = useResource(`plan:${user?.id ?? ''}`, () => apiClient.getOwnUsage());
  // The plan's wording and the published release are context; the page works without them.
  const catalog = useResource('plan-catalog', () => apiClient.getPricingCatalog().catch(() => null));
  const release = useResource('plan-release', () => apiClient.getCurrentPricing().catch(() => null));

  const failure = usage.status === 'error' ? classifyAuthError(usage.error) : null;
  const refresh = () => { usage.reload(); catalog.reload(); release.reload(); };

  return (
    <AccountLayout
      section="usage"
      title="Plan & permissions"
      lede="What your plan includes, what it lets you do, and where it is managed."
      actions={<Action variant="secondary" size="sm" onClick={refresh}>Refresh plan</Action>}
    >
      {usage.status === 'loading' && (
        <div aria-busy="true" className="usage-skeleton">
          <Skeleton variant="card" /><Skeleton variant="panel" /><Skeleton variant="panel" />
        </div>
      )}

      {failure?.status === 403 && <PermissionNotice permissions={['account:read']} action="see your plan" />}
      {failure && failure.status !== 403 && (
        <>
          <LoadFailure onRetry={refresh}>
            {failure.status === 503
              ? <><strong>We can’t read your plan right now (503 · pricing_unavailable).</strong> We don’t show old figures as your current plan, and this doesn’t mean your plan has changed.</>
              : fallbackMessage(failure, 'loaded')}
          </LoadFailure>
          <ConsoleLinks />
        </>
      )}

      {usage.data && (
        <UsageBody
          usage={usage.data}
          catalog={catalog.data}
          release={release.data}
          token={token}
        />
      )}
    </AccountLayout>
  );
}
