import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { MdAdd, MdCheck, MdRemove } from 'react-icons/md';
import type { IPricingLike } from 'pricing-renderer';
import type {
  AdminSubscriptionView,
  ContractChangeReason,
  PricingCatalog,
  PricingCurrentView,
} from '../../../../api/auth';
import { Action } from '../../../core/components/action-button';
import { DataTable } from '../../../core/components/data-table';
import { inInterfaceWords } from '../../../../components/ui/interfaceWords';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { useAuth } from '../../../auth/hooks/useAuth';
import { describeLimit, limitInfo } from '../../../../utils/limits';
import { formatDateTime } from '../../../../utils/format';
import { useResource } from '../../../../utils/useResource';
import { featureName, withInfiniteLimits } from '../../../core/utils/pricing/pricingModel';
import { useAdminApi } from '../../api/adminApi';
import {
  agreementIssues,
  compareLimits,
  contractSelection,
  describeAdminFailure,
  humanize,
  isCeiling,
  isOutdatedChange,
  limitsOf,
  type ContractCatalog,
  type Failure,
} from '../../utils/adminModel';
import { Card, FailureNotice, FIELD, INPUT, LABEL, Loading, MUTED, Tag } from '../admin-parts';

const AgreementReview = lazy(() => import('../agreement-review'));

const REASONS: ReadonlyArray<{ id: ContractChangeReason; label: string }> = [
  { id: 'institutional_agreement', label: 'Institutional agreement' },
  { id: 'administrative_decision', label: 'Administrative decision' },
  { id: 'new_feature', label: 'New feature' },
  { id: 'retirement_or_discount', label: 'Retirement or discount' },
];

const reasonLabel = (id: ContractChangeReason) =>
  REASONS.find(reason => reason.id === id)?.label.toLowerCase() ?? id;

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Each entry of one section of the document under a name: the one the document gives, or ours where it gives none. */
function named(
  section: unknown,
  nameOf: (id: string, entry: Dict) => string,
  unitOf?: (unit: string) => string
): unknown {
  if (!isDict(section)) return section;
  return Object.fromEntries(
    Object.entries(section).map(([id, entry]) => {
      if (!isDict(entry)) return [id, entry];
      // The renderer reads a name that is missing, blank or the id again as no name at all.
      const given = typeof entry.name === 'string' && entry.name.trim() !== '' && entry.name !== id;
      return [
        id,
        {
          ...entry,
          ...(given ? {} : { name: nameOf(id, entry) }),
          ...(unitOf && typeof entry.unit === 'string' ? { unit: unitOf(entry.unit) } : {}),
        },
      ];
    })
  );
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
    usageLimits: named(
      source.usageLimits,
      (id, limit) => inInterfaceWords(limitInfo(id, limit).label),
      inInterfaceWords
    ),
    addOns: named(source.addOns, id => humanize(id)),
  }) as IPricingLike;
}

const sameAddOns = (a: Record<string, number>, b: Record<string, number>) => {
  const clean = (value: Record<string, number>) =>
    JSON.stringify(
      Object.entries(value)
        .filter(([, quantity]) => quantity > 0)
        .sort(([x], [y]) => x.localeCompare(y))
    );
  return clean(a) === clean(b);
};

/** A refusal of a contract change in the words of this card, where the gateway's alone would leave an administrator guessing. */
function refusalInWords(refusal: Failure | null, username: string): Failure | null {
  if (refusal?.code === 'research_requires_us_cas') {
    return {
      ...refusal,
      title: 'RESEARCH needs a verified CAS identity (409 · research_requires_us_cas)',
      text: `${username} hasn’t linked a Universidad de Sevilla CAS identity. RESEARCH can only be assigned to accounts that have.`,
    };
  }
  if (refusal?.code === 'invalid_subscription') {
    return {
      ...refusal,
      title: 'That agreement isn’t valid (422 · invalid_subscription)',
      text: `${refusal.text} Nothing changed.`,
    };
  }
  if (refusal && isOutdatedChange(refusal)) {
    return {
      ...refusal,
      title: `The subscription changed meanwhile (${refusal.status}${refusal.code ? ` · ${refusal.code}` : ''})`,
      text: `${username}’s subscription changed after this review was drawn, so nothing was changed. The review is drawn again from the subscription as it is now: check it before you confirm again.`,
    };
  }
  return refusal;
}

export interface AgreementResult {
  /** `true` when the contract’s values changed, which is what sends the notification. */
  changed: boolean;
  plan: string;
  reason: string;
}

interface AgreementProps {
  view: AdminSubscriptionView;
  /** The revision of `view` (its `ETag`), sent with a change decided on it; `null` when the gateway gave none. */
  revision: string | null;
  /** The subscription is being read again, so what the card shows may be outdated and nothing can be confirmed. */
  reading: boolean;
  catalog: ContractCatalog | null;
  /** The pricing document the catalog was read from, as the gateway serves it: the change review is drawn from it. */
  pricing: PricingCatalog | null;
  catalogFailure: Failure | null;
  catalogLoading: boolean;
  current: PricingCurrentView | null;
  onApplied: (result: AgreementResult) => void;
  /** A change was refused because the subscription had moved since it was read. Nothing was written: it is to be read again. */
  onOutdated: () => void;
}

/** The two requests of this card: the whole agreement, or the plan alone with the add-ons the account already has. */
type Change = 'apply' | 'plan';

/**
 * The plan and add-ons of one account, what changing them does to its limits, and the audited way to apply the change. Nothing is
 * sent from the form: either button opens the review of the change, side by side, and the request leaves from there, with the
 * revision of the subscription the review was drawn from. One that has moved since is refused: the card says so, the subscription is
 * read again, and the review is drawn again from it for the administrator to confirm or not. Nothing is sent again on their behalf.
 */
export function AgreementCard({
  view,
  revision,
  reading,
  catalog,
  pricing,
  catalogFailure,
  catalogLoading,
  current,
  onApplied,
  onOutdated,
}: AgreementProps) {
  const api = useAdminApi();
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

  const available = useMemo(
    () => catalog?.addOns.filter(addOn => addOn.plans.includes(plan)) ?? [],
    [catalog, plan]
  );
  const selected = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(addOns).filter(
          ([id, quantity]) => quantity > 0 && available.some(addOn => addOn.id === id)
        )
      ),
    [addOns, available]
  );
  const issues = useMemo(
    () => (catalog ? agreementIssues(catalog, plan, selected) : []),
    [catalog, plan, selected]
  );
  // “Plan only” keeps the add-ons the account has, so the new plan has to offer them: SPACE refuses the change otherwise.
  const keptIssues = useMemo(
    () => (catalog ? agreementIssues(catalog, plan, subscription.add_ons) : []),
    [catalog, plan, subscription.add_ons]
  );
  const changed = plan !== subscription.plan || !sameAddOns(selected, subscription.add_ons);
  const comparison = useMemo(
    () =>
      catalog
        ? compareLimits(
            catalog,
            limitsOf(catalog, subscription.plan, subscription.add_ons),
            limitsOf(catalog, plan, selected)
          )
        : [],
    [catalog, subscription.plan, subscription.add_ons, plan, selected]
  );
  const shown = showAll ? comparison : comparison.filter(row => row.direction !== 'same');

  // The review's sides, as `pricing-renderer` selections. They keep their identity while the change does not change.
  const reviewPricing = useMemo(() => (pricing ? reviewPricingOf(pricing) : null), [pricing]);
  const before = useMemo(
    () => contractSelection(subscription.plan, subscription.add_ons),
    [subscription.plan, subscription.add_ons]
  );
  const after = useMemo(
    () => contractSelection(plan, review === 'plan' ? subscription.add_ons : selected),
    [plan, review, subscription.add_ons, selected]
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
      sentences.push(
        `Both sides are read from pricing ${catalog.version}, the active pricing. The contract is pinned to ${subscription.pricing_version}, so what it allows today can differ.`
      );
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
    const addOn = catalog?.addOns.find(item => item.id === id);
    if (!addOn) return;
    const quantity = addOns[id] ?? 0;
    const next =
      direction === 1
        ? quantity === 0
          ? addOn.min
          : Math.min(addOn.max, quantity + addOn.step)
        : quantity <= addOn.min
          ? 0
          : quantity - addOn.step;
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
    if (!kind || busy || reading) return;
    setBusy(true);
    setRefusal(null);
    try {
      // The request carries the revision of the subscription this review was drawn from.
      let left: { changed: boolean; plan: string; addOns: Record<string, number> };
      if (kind === 'apply') {
        const { value } = await api.adminUpdateSubscription(
          user.id,
          {
            plan,
            add_ons: selected,
            reason,
            ...(detail.trim() ? { detail: detail.trim() } : {}),
          },
          revision
        );
        left = {
          changed: value.changed,
          plan: value.subscription.plan,
          addOns: value.subscription.add_ons,
        };
      } else {
        await api.adminChangePlan(user.id, plan, revision);
        left = { changed: plan !== subscription.plan, plan, addOns: subscription.add_ons };
      }
      // An administrator who changes their own contract needs the new entitlements in their browser too.
      if (user.id === self?.id) await api.getPricingToken().catch(() => undefined);
      // The form starts again from the contract the change left. The screen reads the subscription again, and with it the revision
      // that the next change carries.
      setPlan(left.plan);
      setAddOns(left.addOns);
      setReason('institutional_agreement');
      setDetail('');
      setReview(null);
      onApplied({
        changed: left.changed,
        plan,
        reason: kind === 'apply' ? reasonLabel(reason) : 'administrative decision',
      });
    } catch (error: unknown) {
      // The review stays open with the refusal, so the change can be sent again or taken back to the form.
      const failure = describeAdminFailure(error, 'The agreement couldn’t be applied');
      setRefusal(failure);
      // Decided on a subscription that has moved since: once it is read again, the review is drawn again from it.
      if (isOutdatedChange(failure)) onOutdated();
    } finally {
      setBusy(false);
    }
  };

  const shownRefusal = refusalInWords(refusal, user.username);
  // A review drawn again takes the focus on its heading, a long way from where a refusal is said, so the heading says it as well.
  const reviewTitle =
    refusal && isOutdatedChange(refusal)
      ? `Review the change for ${user.username} again: the subscription changed meanwhile, so nothing was changed`
      : `Review the change for ${user.username}`;

  const renews = subscription.renews_at ? formatDateTime(subscription.renews_at) : null;

  return (
    <Card
      title="Agreement"
      aside={`Pinned to pricing ${subscription.pricing_version} · renews ${renews ?? 'on demand'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={MUTED}>Now</span>
        <Tag tone="dark">{subscription.plan}</Tag>
        {Object.entries(subscription.add_ons)
          .filter(([, quantity]) => quantity > 0)
          .map(([id, quantity]) => (
            <Tag key={id} tone="info">
              {(catalog?.addOns.find(item => item.id === id)?.name ?? id).toLowerCase()} ×{quantity}
            </Tag>
          ))}
        {Object.values(subscription.add_ons).every(quantity => !quantity) && (
          <span className={MUTED}>No add-ons</span>
        )}
      </div>

      {catalogLoading && (
        <Loading label="Reading the active pricing">
          <Skeleton variant="panel" />
        </Loading>
      )}
      {catalogFailure && (
        <Notice tone="warning" title="The active pricing couldn’t be read">
          Plans and add-ons come from the pricing the gateway serves, so the agreement can’t be
          edited from here right now. {catalogFailure.text}
        </Notice>
      )}
      {!catalogLoading && !catalogFailure && !catalog && (
        <Notice tone="warning" title="The active pricing has no plans">
          There is nothing to choose from until a pricing with plans is live.
        </Notice>
      )}

      {catalog && review && (
        <Suspense
          fallback={
            <Loading label="Preparing the review of the change">
              <Skeleton variant="panel" />
            </Loading>
          }
        >
          <AgreementReview
            pricing={reviewPricing}
            before={before}
            after={after}
            title={reviewTitle}
            confirmLabel={review === 'apply' ? 'Apply agreement' : 'Change plan'}
            notices={notices}
            pending={busy ? 'applying' : reading ? 'reading' : null}
            error={shownRefusal ? `${shownRefusal.title}. ${shownRefusal.text}` : undefined}
            onConfirm={() => void run()}
            onBack={back}
          />
        </Suspense>
      )}

      {catalog && !review && (
        <>
          <div className={FIELD}>
            <span className={LABEL} id="adm-plan-label">
              New plan
            </span>
            <div
              role="radiogroup"
              aria-labelledby="adm-plan-label"
              className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-2"
            >
              {catalog.plans.map(option => {
                const isCurrent = option.id === subscription.plan;
                const needsCas = option.id === 'RESEARCH' && !user.cas_verified;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={plan === option.id}
                    className="flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-tp-hairline bg-tp-canvas px-3 py-2.5 text-left transition-colors hover:border-tp-stone aria-checked:border-tp-primary aria-checked:bg-tp-primary/5 aria-checked:ring-1 aria-checked:ring-tp-primary"
                    onClick={() => choosePlan(option.id)}
                  >
                    <strong className="text-sm font-semibold text-tp-ink">
                      {option.id}
                      {isCurrent ? ' · current' : ''}
                    </strong>
                    <span className="text-xs text-tp-steel">
                      {option.byAgreement
                        ? 'By agreement'
                        : option.id === 'RESEARCH'
                          ? 'Free with verified CAS'
                          : 'Free'}
                    </span>
                    {needsCas && (
                      <small className="text-[11px] text-tp-warning-text">
                        Needs a verified CAS identity
                      </small>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={FIELD}>
            <span className={LABEL}>Add-ons for {plan}</span>
            {available.length === 0 && <span className={MUTED}>{plan} has no add-ons.</span>}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-2">
              {available.map(addOn => {
                const quantity = addOns[addOn.id] ?? 0;
                return (
                  <div
                    key={addOn.id}
                    className="flex items-center gap-3 rounded-lg border border-tp-hairline-soft px-3 py-2.5"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <strong className="text-[13px] text-tp-ink">{addOn.name}</strong>
                      <span className="text-xs text-tp-steel">
                        {addOn.description} · up to {addOn.max}
                      </span>
                    </span>
                    <span className="inline-flex items-center rounded-md border border-tp-input-border">
                      <button
                        type="button"
                        className="inline-flex h-8 w-8 cursor-pointer items-center justify-center text-tp-ink disabled:cursor-not-allowed disabled:opacity-35"
                        aria-label={`Fewer ${addOn.name.toLowerCase()}`}
                        disabled={quantity === 0}
                        onClick={() => step(addOn.id, -1)}
                      >
                        <MdRemove className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <output
                        className="min-w-6 text-center text-sm font-semibold text-tp-ink"
                        aria-live="polite"
                        aria-label={`${addOn.name} quantity`}
                      >
                        {quantity}
                      </output>
                      <button
                        type="button"
                        className="inline-flex h-8 w-8 cursor-pointer items-center justify-center text-tp-ink disabled:cursor-not-allowed disabled:opacity-35"
                        aria-label={`More ${addOn.name.toLowerCase()}`}
                        disabled={quantity >= addOn.max}
                        onClick={() => step(addOn.id, 1)}
                      >
                        <MdAdd className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className={FIELD}>
              <span className={LABEL}>Reason (required)</span>
              <select
                className={INPUT}
                value={reason}
                onChange={event => setReason(event.target.value as ContractChangeReason)}
              >
                {REASONS.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={FIELD}>
              <span className={LABEL}>
                Detail (optional, kept in the audit log and sent to the account)
              </span>
              <input
                className={INPUT}
                value={detail}
                maxLength={1000}
                onChange={event => setDetail(event.target.value)}
                placeholder="e.g. agreement reference"
              />
            </label>
          </div>

          <section className="flex flex-col gap-2" aria-label="Limits before and after">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm text-tp-ink">What changes</strong>
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-tp-slate">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-tp-primary"
                  checked={showAll}
                  onChange={event => setShowAll(event.target.checked)}
                />
                Show unchanged limits
              </label>
            </div>
            {shown.length === 0 ? (
              <p className={MUTED}>
                {changed
                  ? 'No limit changes: only the plan name or features differ.'
                  : 'Nothing is selected yet. Choose another plan or add-ons to see how the limits move.'}
              </p>
            ) : (
              <DataTable label="Limits before and after" minWidth={420}>
                <thead>
                  <tr>
                    <th scope="col">Limit</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(row => (
                    <tr key={row.id}>
                      <td>{row.label}</td>
                      <td className="text-tp-steel" title={row.before.exact}>
                        {row.before.text}
                      </td>
                      <td
                        className={
                          row.direction === 'up'
                            ? 'font-semibold text-tp-success-text'
                            : row.direction === 'down'
                              ? 'font-semibold text-tp-error-text'
                              : undefined
                        }
                        title={row.after.exact}
                      >
                        {row.after.text}
                        {row.direction === 'up' && <span aria-label="increases"> ▲</span>}
                        {row.direction === 'down' && <span aria-label="decreases"> ▼</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
            <span className={MUTED}>
              Limits from pricing {catalog.version}
              {/^0\./.test(catalog.version) ? ' (development copy)' : ''}
              {current && current.version !== subscription.pricing_version
                ? `. LIVE is ${current.version}; this account stays on ${subscription.pricing_version} until renewal or a change here`
                : ''}
              . There’s no checkout: this records an agreement made elsewhere.
            </span>
          </section>

          {issues.length > 0 && (
            <Notice tone="warning" title="This agreement isn’t valid yet">
              {issues.join(' ')}
            </Notice>
          )}
          {shownRefusal && <FailureNotice failure={shownRefusal} />}

          <div className="flex flex-wrap items-center gap-3">
            <Action
              id={applyId}
              variant="primary"
              disabled={!changed || issues.length > 0 || busy}
              onClick={() => open('apply')}
            >
              Apply agreement
            </Action>
            <Action
              id={planOnlyId}
              variant="secondary"
              disabled={plan === subscription.plan || keptIssues.length > 0 || busy}
              onClick={() => open('plan')}
            >
              Change plan only, keep add-ons
            </Action>
            <span className={MUTED}>
              {plan !== subscription.plan && keptIssues.length > 0
                ? `“Plan only” keeps the current add-ons: ${keptIssues.join(' ')}`
                : '“Plan only” records the reason as administrative decision.'}
            </span>
          </div>
        </>
      )}
    </Card>
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
  const api = useAdminApi();
  const usage = useResource(`admin-usage:${userId}:${version}`, () =>
    api.adminGetUserUsage(userId)
  );
  const view = usage.data ?? usage.stale;
  const failure =
    usage.status === 'error'
      ? describeAdminFailure(usage.error, 'The plan limits couldn’t be read')
      : null;

  const limits = Object.entries(view?.capabilities ?? {}).map(([limitId, limit]) => ({
    limitId,
    limit,
  }));
  const allowances = limits.filter(
    ({ limitId }) => !isCeiling(limitId, catalog?.limitDefinitions[limitId])
  );
  const ceilings = limits.filter(({ limitId }) =>
    isCeiling(limitId, catalog?.limitDefinitions[limitId])
  );
  const features = Object.entries(view?.features ?? {});
  const listOf = (rows: typeof limits) =>
    rows.map(({ limitId, limit }) => {
      const info = limitInfo(limitId, catalog?.limitDefinitions[limitId]);
      return (
        <li
          key={limitId}
          className="inline-flex gap-2 rounded-lg border border-tp-hairline-soft px-2.5 py-1 text-xs"
        >
          <span className="text-tp-steel">{info.label}</span>
          <strong className="text-tp-ink">{describeLimit(info.kind, limit).text}</strong>
        </li>
      );
    });

  const LIST = 'mt-1 flex flex-wrap gap-1.5';
  return (
    <Card title="Plan limits" aside="Same view the account holder sees">
      {usage.status === 'loading' && !view && (
        <Loading label="Reading the plan limits">
          <Skeleton variant="panel" />
        </Loading>
      )}
      {failure && <FailureNotice failure={failure} onRetry={usage.reload} />}
      {view?.contract_pending && (
        <Notice tone="warning" title="Contract pending">
          The account has no contract yet; it settles on its next authenticated request, so there
          are no limits to show.
        </Notice>
      )}

      {view && !view.contract_pending && allowances.length === 0 && (
        <p className={MUTED}>No allowances are declared on this contract.</p>
      )}
      {allowances.length > 0 && (
        <div role="group" aria-label="Allowances">
          <span className={LABEL}>Allowances</span>
          <ul className={LIST}>{listOf(allowances)}</ul>
        </div>
      )}

      {ceilings.length > 0 && (
        <div role="group" aria-label="Ceilings for each request">
          <span className={LABEL}>Ceilings for each request</span>
          <ul className={LIST}>{listOf(ceilings)}</ul>
        </div>
      )}

      {features.length > 0 && (
        <div role="group" aria-label="Features">
          <span className={LABEL}>Features</span>
          <ul className={LIST}>
            {features.map(([id, on]) => (
              <li
                key={id}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${
                  on
                    ? 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text'
                    : 'border-tp-hairline-soft text-tp-steel'
                }`}
              >
                {on ? (
                  <MdCheck className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <MdRemove className="h-3 w-3" aria-hidden="true" />
                )}
                {featureName(id)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
