// Adapted from SPHERE frontend/src/modules/settings/components/PaymentsSection.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding sells no plan here (plans are sold through SPACE), so SPHERE's subscription, payment history and payment
// method cards became the plan card, the links to the SPACE and SPHERE consoles, your permissions, the plan's features and
// what it allows (`GET /v1/users/me/usage`, worded as OpenBinding's former plan screen did); a failed read is said.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FiCreditCard, FiExternalLink, FiLoader } from 'react-icons/fi';
import type { PricingDocument } from '../../core/api/account';
import {
  INSTITUTION_NAME,
  useInstitutionalBranding,
} from '../../auth/components/institution-mark/institution';
import { config } from '../../../config';
import { featureName, readCatalog, type PricingView } from '../../core/utils/pricing/pricingModel';
import { describeLimit, formatCount, LIMIT, type LimitDefinition } from '../../core/utils/limits';
import { usePricingTokenStatus, type PricingTokenStatus } from '../../core/utils/pricingToken';
import { useAuth } from '../../auth/hooks/useAuth';
import { classifyAuthError, type AuthFailure } from '../../core/api/errors';
import BlockAlert from '../../core/components/block-alert';
import { Chip } from '../../core/components/chip';
import { DataTable } from '../../core/components/data-table';
import { useUserSettingsApi, type UsageView } from '../api/userSettingsApi';
import { fallbackMessage } from '../../core/utils/account-errors';
import { NO_LIMIT_TEXT, exactValueText, usageRows, type UsageRow } from '../utils/usageModel';

const ALLOWANCE_NOTES: Record<string, { note: string; link?: { to: string; label: string } }> = {
  [LIMIT.maxConcurrentRuns]: { note: 'Runs that may run at once' },
  [LIMIT.maxFederatedEngines]: {
    note: 'Federated engines you may have active',
    link: { to: '/me/engines', label: 'My engines' },
  },
  [LIMIT.maxApiKeys]: { note: 'Active keys', link: { to: '/me/api-keys', label: 'Manage keys' } },
  [LIMIT.maxProblems]: { note: 'Problems you own' },
  [LIMIT.maxRepositoryStorage]: { note: 'Stored size of your problem revisions' },
};

const TOKEN_CHIP: Record<PricingTokenStatus, string> = {
  valid: 'Confirmed by your plan check',
  stale: 'Plan check expired · can’t confirm',
  missing: 'Can’t confirm features',
};

const TOKEN_BANNER: Partial<Record<PricingTokenStatus, string>> = {
  stale:
    'Your plan check has expired, so features can’t be confirmed from it right now. Sign in again or reload the page to renew it. Nothing is blocked because of this: the server decides what you can do.',
  missing:
    'No plan check is available yet, so features can’t be confirmed. This usually settles on your next request. Nothing is blocked because of this: the server decides what you can do.',
};

const LINK =
  'inline-flex min-h-6 cursor-pointer items-center gap-1 text-sm font-medium text-tp-link hover:underline';

function limitDefinitions(
  catalog: PricingDocument | null | undefined
): Record<string, LimitDefinition> {
  const limits = catalog?.usageLimits;
  return typeof limits === 'object' && limits !== null
    ? (limits as Record<string, LimitDefinition>)
    : {};
}

function priceLine(plan: string, view: PricingView | null): string | null {
  const column = view?.plans.find(item => item.id === plan);
  if (!column) return null;
  if (column.byAgreement) return 'Institutional agreement';
  return column.unitLabel === 'with verified CAS' ? 'Free with verified CAS' : column.priceLabel;
}

function Card({ title, lede, children }: { title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[12px] border border-tp-hairline bg-tp-canvas" aria-label={title}>
      <div className="border-b border-tp-hairline px-6 py-4">
        <h3 className="text-sm font-medium text-tp-ink">{title}</h3>
        {lede && <p className="mt-1 text-xs text-tp-steel">{lede}</p>}
      </div>
      <div className="px-6 py-4">{children}</div>
    </section>
  );
}

/** The addresses of the native consoles, where pricings, plans and contracts are managed. This section only links to them. */
function ConsoleLinks() {
  return (
    <Card
      title="Plans, prices and contracts"
      lede="OpenBinding shows your plan and what it lets you do. Prices, pricing versions and contracts are managed in the native SPACE and SPHERE consoles, not here."
    >
      <p className="flex flex-wrap gap-x-5 gap-y-2">
        <a
          href={config.spaceFrontendUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK}
        >
          Open SPACE console <FiExternalLink className="inline h-3.5 w-3.5" aria-hidden="true" />
        </a>
        <a href={config.sphereUrl} target="_blank" rel="noopener noreferrer" className={LINK}>
          Open SPHERE console <FiExternalLink className="inline h-3.5 w-3.5" aria-hidden="true" />
        </a>
        <Link to="/pricing" className={LINK}>
          See the published plans
        </Link>
      </p>
    </Card>
  );
}

function Permissions() {
  const { user } = useAuth();
  return (
    <Card
      title="Your permissions"
      lede={
        <>
          Your platform role is <strong>{user?.role ?? 'user'}</strong>. Your plan decides which
          features you have; your role in each organization decides what you can change there, and
          an API key can never exceed your account.
        </>
      }
    >
      <p className="flex flex-wrap gap-x-5 gap-y-2">
        <Link to="/me/orgs" className={LINK}>
          Your organizations and roles
        </Link>
        <Link to="/me/api-keys" className={LINK}>
          Your API keys
        </Link>
      </p>
    </Card>
  );
}

function UsageBody({
  usage,
  catalog,
  release,
  token,
}: {
  usage: UsageView;
  catalog: PricingDocument | null;
  release: { version: string } | null;
  token: PricingTokenStatus;
}) {
  const institutional = useInstitutionalBranding();
  const rows = usageRows(usage, limitDefinitions(catalog));
  const inGroup = (...groups: Array<UsageRow['info']['group']>) =>
    rows.filter(row => groups.includes(row.info.group));
  const allowances = inGroup('monthly', 'capacity');
  const ceilings = inGroup('ceiling');
  const pending = usage.contract_pending;
  const view = catalog ? readCatalog(catalog) : null;
  const price = priceLine(usage.plan, view);
  const features =
    view && view.features.length > 0
      ? view.features
      : Object.keys(usage.features ?? {}).map(id => ({ id, name: featureName(id) }));
  const confirmed = !pending && token === 'valid';

  return (
    <>
      {pending && (
        <BlockAlert variant="info">
          <strong>Your contract is pending.</strong> Pricing wasn’t reachable when you signed up.
          It’s settled on your next request; until then no feature or limit can be confirmed, and
          nothing here is shown as allowed or blocked.
        </BlockAlert>
      )}

      <section
        className="rounded-[12px] border border-tp-hairline bg-tp-canvas p-6"
        aria-label="Your plan"
      >
        <h3 className="text-sm font-medium text-tp-ink">Current plan</h3>
        <div className="mt-4 flex flex-wrap items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-[12px] bg-tp-primary/10">
            <FiCreditCard className="h-6 w-6 text-tp-accent" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-base text-tp-ink">
                {usage.plan || 'No remote plan (local demo)'}
              </strong>
              {price && <Chip>{price}</Chip>}
              {institutional && <Chip tone="success">{INSTITUTION_NAME}</Chip>}
            </div>
            <p className="mt-2 text-sm text-tp-steel">
              {release ? `Published pricing ${release.version}` : 'Published pricing'}
              {' · A new pricing version applies when your contract is renewed in SPACE'}
            </p>
          </div>
          <Link
            to="/pricing"
            className="flex cursor-pointer items-center gap-2 rounded-[8px] border border-tp-hairline-strong bg-tp-canvas px-4 py-2.5 text-sm font-medium text-tp-ink transition-colors hover:bg-tp-surface"
          >
            See plans
          </Link>
        </div>
      </section>

      <ConsoleLinks />
      <Permissions />

      <section
        className="rounded-[12px] border border-tp-hairline bg-tp-canvas"
        aria-label="Features"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-tp-hairline px-6 py-4">
          <h3 className="text-sm font-medium text-tp-ink">Features</h3>
          <Chip tone={confirmed ? 'success' : 'warning'}>
            {pending ? 'Contract pending' : TOKEN_CHIP[token]}
          </Chip>
        </div>
        {!pending && token !== 'valid' && (
          <div className="px-6 pt-4">
            <BlockAlert variant="warning" message={TOKEN_BANNER[token]} />
          </div>
        )}
        <ul className="divide-y divide-tp-hairline">
          {features.map(feature => {
            const on = usage.features?.[feature.id] === true;
            return (
              <li key={feature.id} className="flex items-center justify-between gap-3 px-6 py-3">
                <span className="text-sm text-tp-ink">{feature.name}</span>
                <span
                  className={`text-xs font-medium ${
                    confirmed ? (on ? 'text-green-700' : 'text-tp-steel') : 'text-amber-700'
                  }`}
                >
                  {confirmed ? (on ? 'Enabled' : 'Not in plan') : 'Can’t confirm'}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {rows.length === 0 && !pending && (
        <p className="text-sm text-tp-steel">Your plan declares no limits.</p>
      )}

      {!pending && allowances.length > 0 && (
        <Card
          title="What your plan allows"
          lede="The most your plan permits at a time. Nothing is metered or charged per request."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {allowances.map(row => {
              const extra = ALLOWANCE_NOTES[row.id];
              return (
                <div
                  key={row.id}
                  className="flex flex-col gap-1 rounded-[10px] border border-tp-hairline bg-tp-surface p-4"
                >
                  <span className="text-xs font-medium text-tp-steel">{row.info.label}</span>
                  <span className="font-display text-2xl text-tp-ink">
                    {row.limit === null ? 'Unlimited' : formatCount(row.limit)}
                  </span>
                  {extra && <span className="text-xs text-tp-steel">{extra.note}</span>}
                  {extra?.link && (
                    <Link
                      to={extra.link.to}
                      className="cursor-pointer text-xs text-tp-link hover:underline"
                    >
                      {extra.link.label}
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {!pending && ceilings.length > 0 && (
        <Card
          title="Per-request ceilings"
          lede="Budgets above these are reduced with an OPTION_CLAMPED note; bigger problems are rejected."
        >
          <DataTable label="Ceilings table" minWidth={480}>
            <thead>
              <tr>
                <th scope="col">Ceiling</th>
                <th scope="col">Your limit</th>
                <th scope="col">Exact value</th>
              </tr>
            </thead>
            <tbody>
              {ceilings.map(row => (
                <tr key={row.id}>
                  <th scope="row">{row.info.label}</th>
                  <td>
                    <strong>{describeLimit(row.info.kind, row.limit).text}</strong>
                  </td>
                  <td>{exactValueText(row)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>
      )}

      <details className="rounded-[12px] border border-tp-hairline bg-tp-canvas px-6 py-4">
        <summary className="cursor-pointer text-sm font-medium text-tp-ink">
          All entitlement values
        </summary>
        <p className="mt-2 text-xs text-tp-steel">
          Every limit of your plan as the gateway reports it, by its technical name. Nothing here is
          secret: it is the contract, not a credential.
        </p>
        <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {rows.map(row => (
            <div key={row.id} className="flex justify-between gap-3 text-xs">
              <dt>
                <code className="break-all">{row.id}</code>
              </dt>
              <dd className="text-tp-ink">
                {row.limit === null || !Number.isFinite(row.limit)
                  ? NO_LIMIT_TEXT
                  : formatCount(row.limit)}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}

function failureText(failure: AuthFailure): ReactNode {
  if (failure.status === 403)
    return 'This request was refused (403). To see your plan, a request needs account:read or a browser session.';
  if (failure.status === 503)
    return (
      <>
        <strong>We can’t read your plan right now (503 · pricing_unavailable).</strong> We don’t
        show old figures as your current plan, and this doesn’t mean your plan has changed.
      </>
    );
  return fallbackMessage(failure, 'loaded');
}

export default function PlanSection() {
  const api = useUserSettingsApi();
  const token = usePricingTokenStatus();
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  // The plan's wording and the published release are context; the section works without them.
  const [catalog, setCatalog] = useState<PricingDocument | null>(null);
  const [release, setRelease] = useState<{ version: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    api
      .getUsage()
      .then(answer => {
        if (!current) return;
        setUsage(answer);
        setFailure(null);
      })
      .catch((caught: unknown) => {
        if (current) setFailure(classifyAuthError(caught));
      });
    api
      .getPlansPricing()
      .then(answer => {
        if (!current) return;
        setCatalog(answer.document);
        setRelease({ version: answer.version });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [api, attempt]);

  const refresh = useCallback(() => {
    setFailure(null);
    setUsage(null);
    setAttempt(value => value + 1);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-tp-ink">Plan & permissions</h2>
          <p className="mt-0.5 text-sm text-tp-steel">
            What your plan includes, what it lets you do, and where it is managed
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="cursor-pointer rounded-[8px] border border-tp-hairline-strong bg-tp-canvas px-3.5 py-2 text-xs font-medium text-tp-ink transition-colors hover:bg-tp-surface"
        >
          Refresh plan
        </button>
      </div>

      {!usage && !failure && (
        <div
          className="flex items-center justify-center gap-2 rounded-[12px] border border-tp-hairline bg-tp-canvas px-6 py-12 text-sm text-tp-steel"
          aria-busy="true"
        >
          <FiLoader className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading your plan…
        </div>
      )}

      {failure && (
        <>
          <BlockAlert variant="error">{failureText(failure)}</BlockAlert>
          <ConsoleLinks />
        </>
      )}

      {usage && <UsageBody usage={usage} catalog={catalog} release={release} token={token} />}
    </div>
  );
}
