import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import type { IPricingLike } from 'pricing-renderer';
import type { AdminSubscriptionView, ContractChangeReason, PricingCatalog, PricingCurrentView } from '../../api/auth';
import { apiClient } from '../../api/client';
import { Action } from '../../components/ui/Action';
import { DataTable } from '../../components/ui/DataTable';
import { inInterfaceWords } from '../../components/ui/interfaceWords';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { describeLimit, limitInfo } from '../../utils/limits';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { featureName, withInfiniteLimits } from '../Pricing/pricingModel';
import { FailureNotice, Tag } from './AdminChrome';
import {
  agreementIssues, compareLimits, contractSelection, describeAdminFailure, humanize, isCeiling, limitsOf,
  type ContractCatalog, type Failure,
} from './adminModel';

const AgreementReview = lazy(() => import('./AgreementReview'));

const REASONS: ReadonlyArray<{ id: ContractChangeReason; label: string }> = [
  { id: 'institutional_agreement', label: 'Institutional agreement' },
  { id: 'administrative_decision', label: 'Administrative decision' },
  { id: 'new_feature', label: 'New feature' },
  { id: 'retirement_or_discount', label: 'Retirement or discount' },
];

const reasonLabel = (id: ContractChangeReason) => REASONS.find((reason) => reason.id === id)?.label.toLowerCase() ?? id;

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Each entry of one section of the document under a name: the one the document gives, or ours where it gives none. */
function named(section: unknown, nameOf: (id: string, entry: Dict) => string, unitOf?: (unit: string) => string): unknown {
  if (!isDict(section)) return section;
  return Object.fromEntries(Object.entries(section).map(([id, entry]) => {
    if (!isDict(entry)) return [id, entry];
    // The renderer reads a name that is missing, blank or the id again as no name at all.
    const given = typeof entry.name === 'string' && entry.name.trim() !== '' && entry.name !== id;
    return [id, {
      ...entry,
      ...(given ? {} : { name: nameOf(id, entry) }),
      ...(unitOf && typeof entry.unit === 'string' ? { unit: unitOf(entry.unit) } : {}),
    }];
  }));
}

/**
 * The pricing document as the change review reads it. The gateway serves `.inf` as `null`, which the review would show as a dash,
 * so it becomes the number it stands for. What the document doesn't name is shown under the name this screen gives it, so the review
 * and the form above it speak of the same limits and add-ons, and units are in the words of the interface (a run, never a job).
 * No value changes.
 */
function reviewPricingOf(source: PricingCatalog): IPricingLike {
  return withInfiniteLimits({
    ...source,
    features: named(source.features, (id, feature) => featureName(id, feature)),
    usageLimits: named(source.usageLimits, (id, limit) => inInterfaceWords(limitInfo(id, limit).label), inInterfaceWords),
    addOns: named(source.addOns, (id) => humanize(id)),
  }) as IPricingLike;
}

const sameAddOns = (a: Record<string, number>, b: Record<string, number>) => {
  const clean = (value: Record<string, number>) => JSON.stringify(Object.entries(value).filter(([, quantity]) => quantity > 0).sort(([x], [y]) => x.localeCompare(y)));
  return clean(a) === clean(b);
};

export interface AgreementResult {
  /** `true` when the contract’s values changed, which is what sends the notification. */
  changed: boolean;
  plan: string;
  reason: string;
}

interface AgreementProps {
  view: AdminSubscriptionView;
  catalog: ContractCatalog | null;
  /** The pricing document the catalog was read from, as the gateway serves it: the change review is drawn from it. */
  pricing: PricingCatalog | null;
  catalogFailure: Failure | null;
  catalogLoading: boolean;
  current: PricingCurrentView | null;
  onApplied: (result: AgreementResult) => void;
}

/** The two requests of this card: the whole agreement, or the plan alone with the add-ons the account already has. */
type Change = 'apply' | 'plan';

/**
 * The plan and add-ons of one account, what changing them does to its limits, and the audited way to apply the change. Nothing is
 * sent from the form: either button opens the review of the change, side by side, and the request leaves from there.
 */
export function AgreementCard({ view, catalog, pricing, catalogFailure, catalogLoading, current, onApplied }: AgreementProps) {
  const { user: self } = useAuth();
  const { user, subscription } = view;
  const [plan, setPlan] = useState(subscription.plan);
  const [addOns, setAddOns] = useState<Record<string, number>>(subscription.add_ons);
  const [reason, setReason] = useState<ContractChangeReason>('institutional_agreement');
  const [detail, setDetail] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [review, setReview] = useState<Change | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Failure | null>(null);
  const applyId = useId();
  const planOnlyId = useId();
  /** The button the review was opened from, which takes the focus back when the review closes with Back. */
  const returnTo = useRef<string | null>(null);

  const available = useMemo(() => catalog?.addOns.filter((addOn) => addOn.plans.includes(plan)) ?? [], [catalog, plan]);
  const selected = useMemo(() => Object.fromEntries(
    Object.entries(addOns).filter(([id, quantity]) => quantity > 0 && available.some((addOn) => addOn.id === id)),
  ), [addOns, available]);
  const issues = useMemo(() => (catalog ? agreementIssues(catalog, plan, selected) : []), [catalog, plan, selected]);
  // “Plan only” keeps the add-ons the account has, so the new plan has to offer them: SPACE refuses the change otherwise.
  const keptIssues = useMemo(() => (catalog ? agreementIssues(catalog, plan, subscription.add_ons) : []), [catalog, plan, subscription.add_ons]);
  const changed = plan !== subscription.plan || !sameAddOns(selected, subscription.add_ons);
  const comparison = useMemo(() => (catalog
    ? compareLimits(catalog, limitsOf(catalog, subscription.plan, subscription.add_ons), limitsOf(catalog, plan, selected))
    : []), [catalog, subscription.plan, subscription.add_ons, plan, selected]);
  const shown = showAll ? comparison : comparison.filter((row) => row.direction !== 'same');

  // The review's sides, as `pricing-renderer` selections. They keep their identity while the change does not change.
  const reviewPricing = useMemo(() => (pricing ? reviewPricingOf(pricing) : null), [pricing]);
  const before = useMemo(() => contractSelection(subscription.plan, subscription.add_ons), [subscription.plan, subscription.add_ons]);
  const after = useMemo(
    () => contractSelection(plan, review === 'plan' ? subscription.add_ons : selected),
    [plan, review, subscription.add_ons, selected],
  );
  const notices = useMemo(() => {
    if (!review) return [];
    const sentences = [
      review === 'apply'
        ? `Reason: ${reasonLabel(reason)}.${detail.trim() ? ` Detail: “${detail.trim()}”.` : ''}`
        : 'Reason: administrative decision. The add-ons stay as they are.',
      `${user.username} is notified, and the change is recorded in the audit log with your name. Nothing is charged: this records an agreement made elsewhere.`,
    ];
    if (catalog?.version && catalog.version !== subscription.pricing_version) {
      sentences.push(`Both sides are read from pricing ${catalog.version}, the active pricing. The contract is pinned to ${subscription.pricing_version}, so what it allows today can differ.`);
    }
    return sentences;
  }, [review, reason, detail, user.username, catalog, subscription.pricing_version]);

  useEffect(() => {
    if (review !== null || returnTo.current === null) return;
    document.getElementById(returnTo.current)?.focus();
    returnTo.current = null;
  }, [review]);

  const choosePlan = (id: string) => {
    setPlan(id);
    setRefusal(null);
  };

  const step = (id: string, direction: 1 | -1) => {
    const addOn = catalog?.addOns.find((item) => item.id === id);
    if (!addOn) return;
    const quantity = addOns[id] ?? 0;
    const next = direction === 1
      ? (quantity === 0 ? addOn.min : Math.min(addOn.max, quantity + addOn.step))
      : (quantity <= addOn.min ? 0 : quantity - addOn.step);
    setAddOns({ ...addOns, [id]: next });
    setRefusal(null);
  };

  const open = (kind: Change) => {
    // A new review starts without the refusal of the last attempt, which the form has already shown.
    setRefusal(null);
    setReview(kind);
  };

  const back = () => {
    returnTo.current = review === 'plan' ? planOnlyId : applyId;
    setReview(null);
  };

  const run = async () => {
    const kind = review;
    if (!kind || busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      let didChange: boolean;
      if (kind === 'apply') {
        const result = await apiClient.adminUpdateSubscription(user.id, {
          plan, add_ons: selected, reason, ...(detail.trim() ? { detail: detail.trim() } : {}),
        });
        didChange = result.changed;
      } else {
        await apiClient.adminChangePlan(user.id, plan);
        didChange = plan !== subscription.plan;
      }
      // An administrator who changes their own contract needs the new entitlements in their browser too.
      if (user.id === self?.id) await apiClient.getPricingToken().catch(() => undefined);
      setReview(null);
      onApplied({ changed: didChange, plan, reason: kind === 'apply' ? reasonLabel(reason) : 'administrative decision' });
    } catch (error: unknown) {
      // The review stays open with the refusal, so the change can be sent again or taken back to the form.
      setRefusal(describeAdminFailure(error, 'The agreement couldn’t be applied'));
    } finally {
      setBusy(false);
    }
  };

  const shownRefusal: Failure | null = refusal?.code === 'research_requires_us_cas'
    ? { ...refusal, title: 'RESEARCH needs a verified CAS identity (409 · research_requires_us_cas)', text: `${user.username} hasn’t linked a Universidad de Sevilla CAS identity. RESEARCH can only be assigned to accounts that have.` }
    : refusal?.code === 'invalid_subscription'
      ? { ...refusal, title: 'That agreement isn’t valid (422 · invalid_subscription)', text: `${refusal.text} Nothing changed.` }
      : refusal;

  const renews = subscription.renews_at ? formatDateTime(subscription.renews_at) : null;

  return (
    <section className="adm-card" aria-labelledby="adm-agreement-title">
      <div className="adm-card-head">
        <h2 id="adm-agreement-title">Agreement</h2>
        <span className="adm-muted">Pinned to pricing {subscription.pricing_version} · renews {renews ?? 'on demand'}</span>
      </div>

      <div className="adm-now">
        <span className="adm-muted">Now</span>
        <Tag tone="dark">{subscription.plan}</Tag>
        {Object.entries(subscription.add_ons).filter(([, quantity]) => quantity > 0).map(([id, quantity]) => (
          <Tag key={id} tone="info">{(catalog?.addOns.find((item) => item.id === id)?.name ?? id).toLowerCase()} ×{quantity}</Tag>
        ))}
        {Object.values(subscription.add_ons).every((quantity) => !quantity) && <span className="adm-muted">No add-ons</span>}
      </div>

      {catalogLoading && <div aria-busy="true"><span className="sr-only">Reading the active pricing</span><Skeleton variant="panel" /></div>}
      {catalogFailure && (
        <Notice tone="warning" title="The active pricing couldn’t be read">
          Plans and add-ons come from the pricing the gateway serves, so the agreement can’t be edited from here right now. {catalogFailure.text}
        </Notice>
      )}
      {!catalogLoading && !catalogFailure && !catalog && (
        <Notice tone="warning" title="The active pricing has no plans">There is nothing to choose from until a pricing with plans is live.</Notice>
      )}

      {catalog && review && (
        <Suspense fallback={<div aria-busy="true"><span className="sr-only">Preparing the review of the change</span><Skeleton variant="panel" /></div>}>
          <AgreementReview
            pricing={reviewPricing}
            before={before}
            after={after}
            title={`Review the change for ${user.username}`}
            confirmLabel={review === 'apply' ? 'Apply agreement' : 'Change plan'}
            notices={notices}
            pending={busy}
            error={shownRefusal ? `${shownRefusal.title}. ${shownRefusal.text}` : undefined}
            onConfirm={() => void run()}
            onBack={back}
          />
        </Suspense>
      )}

      {catalog && !review && (
        <>
          <div className="adm-field">
            <span className="adm-label" id="adm-plan-label">New plan</span>
            <div role="radiogroup" aria-labelledby="adm-plan-label" className="adm-plans">
              {catalog.plans.map((option) => {
                const isCurrent = option.id === subscription.plan;
                const needsCas = option.id === 'RESEARCH' && !user.cas_verified;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={plan === option.id}
                    className={`adm-choice${plan === option.id ? ' is-on' : ''}`}
                    onClick={() => choosePlan(option.id)}
                  >
                    <strong>{option.id}{isCurrent ? ' · current' : ''}</strong>
                    <span>{option.byAgreement ? 'By agreement' : option.id === 'RESEARCH' ? 'Free with verified CAS' : 'Free'}</span>
                    {needsCas && <small>Needs a verified CAS identity</small>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="adm-field">
            <span className="adm-label">Add-ons for {plan}</span>
            {available.length === 0 && <span className="adm-muted">{plan} has no add-ons.</span>}
            <div className="adm-addons">
              {available.map((addOn) => {
                const quantity = addOns[addOn.id] ?? 0;
                return (
                  <div key={addOn.id} className="adm-addon">
                    <span className="adm-addon-copy">
                      <strong>{addOn.name}</strong>
                      <span>{addOn.description} · up to {addOn.max}</span>
                    </span>
                    <span className="adm-stepper">
                      <button type="button" aria-label={`Fewer ${addOn.name.toLowerCase()}`} disabled={quantity === 0} onClick={() => step(addOn.id, -1)}><Minus aria-hidden="true" /></button>
                      <output aria-live="polite" aria-label={`${addOn.name} quantity`}>{quantity}</output>
                      <button type="button" aria-label={`More ${addOn.name.toLowerCase()}`} disabled={quantity >= addOn.max} onClick={() => step(addOn.id, 1)}><Plus aria-hidden="true" /></button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="adm-form-grid">
            <label className="adm-field">
              <span className="adm-label">Reason (required)</span>
              <select value={reason} onChange={(event) => setReason(event.target.value as ContractChangeReason)}>
                {REASONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label className="adm-field">
              <span className="adm-label">Detail (optional, kept in the audit log and sent to the account)</span>
              <input value={detail} maxLength={1000} onChange={(event) => setDetail(event.target.value)} placeholder="e.g. agreement reference" />
            </label>
          </div>

          <section className="adm-compare" aria-label="Limits before and after">
            <div className="adm-compare-head">
              <strong>What changes</strong>
              <label className="adm-check">
                <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
                Show unchanged limits
              </label>
            </div>
            {shown.length === 0 ? (
              <p className="adm-muted">{changed ? 'No limit changes: only the plan name or features differ.' : 'Nothing is selected yet. Choose another plan or add-ons to see how the limits move.'}</p>
            ) : (
              <DataTable label="Limits before and after" minWidth={420}>
                <thead><tr><th scope="col">Limit</th><th scope="col">Before</th><th scope="col">After</th></tr></thead>
                <tbody>
                  {shown.map((row) => (
                    <tr key={row.id} className={row.direction === 'same' ? undefined : `is-${row.direction}`}>
                      <td>{row.label}</td>
                      <td className="adm-muted" title={row.before.exact}>{row.before.text}</td>
                      <td className="adm-after" title={row.after.exact}>
                        {row.after.text}
                        {row.direction === 'up' && <span aria-label="increases"> ▲</span>}
                        {row.direction === 'down' && <span aria-label="decreases"> ▼</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
            <span className="adm-muted">
              Limits from pricing {catalog.version}{/^0\./.test(catalog.version) ? ' (development copy)' : ''}
              {current && current.version !== subscription.pricing_version ? `. LIVE is ${current.version}; this account stays on ${subscription.pricing_version} until renewal or a change here` : ''}.
              There’s no checkout: this records an agreement made elsewhere.
            </span>
          </section>

          {issues.length > 0 && (
            <Notice tone="warning" title="This agreement isn’t valid yet">
              {issues.join(' ')}
            </Notice>
          )}
          {shownRefusal && <FailureNotice failure={shownRefusal} />}

          <div className="adm-buttons">
            <Action id={applyId} variant="primary" disabled={!changed || issues.length > 0 || busy} onClick={() => open('apply')}>Apply agreement</Action>
            <Action id={planOnlyId} variant="secondary" disabled={plan === subscription.plan || keptIssues.length > 0 || busy} onClick={() => open('plan')}>Change plan only, keep add-ons</Action>
            <span className="adm-muted">
              {plan !== subscription.plan && keptIssues.length > 0
                ? `“Plan only” keeps the current add-ons: ${keptIssues.join(' ')}`
                : '“Plan only” records the reason as administrative decision.'}
            </span>
          </div>
        </>
      )}
    </section>
  );
}

interface UsageProps {
  userId: string;
  catalog: ContractCatalog | null;
  /** Changes when the contract does, so the figures are read again. */
  version: string;
}

/** What an account's plan allows, as its holder sees it. Nothing is counted per account, so there is no consumption here. */
export function UsageCard({ userId, catalog, version }: UsageProps) {
  const usage = useResource(`admin-usage:${userId}:${version}`, () => apiClient.adminGetUserUsage(userId));
  const view = usage.data ?? usage.stale;
  const failure = usage.status === 'error' ? describeAdminFailure(usage.error, 'The plan limits couldn’t be read') : null;

  const limits = Object.entries(view?.capabilities ?? {}).map(([limitId, limit]) => ({ limitId, limit }));
  const groupOf = (limitId: string) => limitInfo(limitId, catalog?.limitDefinitions[limitId]).group;
  // Sponsored limits cap everything under the organizations an account sponsors.
  const sponsored = limits.filter(({ limitId }) => groupOf(limitId) === 'sponsored');
  const allowances = limits.filter(({ limitId }) => groupOf(limitId) !== 'sponsored' && !isCeiling(limitId, catalog?.limitDefinitions[limitId]));
  const ceilings = limits.filter(({ limitId }) => isCeiling(limitId, catalog?.limitDefinitions[limitId]));
  const features = Object.entries(view?.features ?? {});
  const listOf = (rows: typeof limits) => rows.map(({ limitId, limit }) => {
    const info = limitInfo(limitId, catalog?.limitDefinitions[limitId]);
    return <li key={limitId}><span>{info.label}</span><strong>{describeLimit(info.kind, limit).text}</strong></li>;
  });

  return (
    <section className="adm-card" aria-labelledby="adm-usage-title">
      <div className="adm-card-head">
        <h2 id="adm-usage-title">Plan limits</h2>
        <span className="adm-muted">Same view the account holder sees</span>
      </div>

      {usage.status === 'loading' && !view && <div aria-busy="true"><span className="sr-only">Reading the plan limits</span><Skeleton variant="panel" /></div>}
      {failure && <FailureNotice failure={failure} onRetry={usage.reload} />}
      {view?.contract_pending && <Notice tone="warning" title="Contract pending">The account has no contract yet; it settles on its next authenticated request, so there are no limits to show.</Notice>}

      {view && !view.contract_pending && allowances.length === 0 && <p className="adm-muted">No allowances are declared on this contract.</p>}
      {allowances.length > 0 && (
        <div className="adm-ceilings" role="group" aria-label="Allowances">
          <span className="adm-label">Allowances</span>
          <ul>{listOf(allowances)}</ul>
        </div>
      )}

      {ceilings.length > 0 && (
        <div className="adm-ceilings" role="group" aria-label="Ceilings for each request">
          <span className="adm-label">Ceilings for each request</span>
          <ul>{listOf(ceilings)}</ul>
        </div>
      )}

      {sponsored.length > 0 && (
        <div className="adm-ceilings" role="group" aria-label="Limits across sponsored organizations">
          <span className="adm-label">Limits across the organizations this account sponsors</span>
          <ul>{listOf(sponsored)}</ul>
        </div>
      )}

      {features.length > 0 && (
        <div className="adm-features" role="group" aria-label="Features">
          <span className="adm-label">Features</span>
          <ul>
            {features.map(([id, on]) => (
              <li key={id} className={on ? 'is-on' : undefined}>{on ? <Check aria-hidden="true" /> : <Minus aria-hidden="true" />}{featureName(id)}</li>
            ))}
          </ul>
        </div>
      )}

    </section>
  );
}
