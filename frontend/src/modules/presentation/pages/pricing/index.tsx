// Adapted from SPHERE frontend/src/modules/presentation/pages/pricing/index.tsx (feat/pricing-renderer, revision
// 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the pricing is the one the gateway serves (`GET /v1/plans/pricing`: the release label, its YAML for the renderer and
// its parsed document) instead of a YAML file of the site; the hero names OpenBinding's plans and the release; the
// development notice replaces SPHERE's tentative-pricing banner; the renderer marks the account's plan and add-ons and every
// plan offers the action of the comparison (the contact dialog for a plan by agreement), with no summary (nothing is bought); a 502 or
// 503 refusal is a BlockAlert with Retry; OpenBinding's comparison table, the gates,
// the account's features (the space-react-client gates), the add-ons, the limit outcomes and the RESEARCH plan follow as
// cards; SPHERE's silent load failure is said.

import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import type { IPricingLike } from 'pricing-renderer';
import { useSubscription } from 'space-react-client';
import { formatDate } from '../../../core/utils/format';
import { safeExternalHref } from '../../../core/utils/url';
import { useResource } from '../../../core/hooks/useResource';
import { useAuth } from '../../../auth/hooks/useAuth';
import { classifyAuthError } from '../../../core/api/errors';
import BlockAlert from '../../../core/components/block-alert';
import { Chip } from '../../../core/components/chip';
import { FilterPills } from '../../../core/components/filter-pills';
import { Skeleton } from '../../../core/components/skeleton';
import { pricingRendererSource } from '../../../core/components/pricing-renderer/source';
import {
  currentSelectionOf,
  readCatalog,
  withInfiniteLimits,
} from '../../../core/utils/pricing/pricingModel';
import { useUserSettingsApi } from '../../../settings/api/userSettingsApi';
import ContactModal from './components/contact-modal';
import Entitlements from './components/entitlements';
import PlanCta from './components/plan-cta';
import PlanMatrix from './components/plan-matrix';
import { AddOns, Gates, LimitOutcomes, ResearchCard } from './components/pricing-sections';

// The drawing loads pricing-renderer and its stylesheet, so it comes in its own chunk.
const SpherePricingRenderer = lazy(() => import('../../../core/components/pricing-renderer'));

/**
 * The page's own hero names the pricing, so the document's is not drawn again; nor is the summary, whose estimated total and
 * checkout have nothing to do on a page where nothing is bought.
 */
const HIDDEN_SECTIONS = ['hero', 'summary'] as const;

const NO_SUMMARY_ACTIONS = () => null;

/** What the document pins while scrolling stops below the sticky header. */
const RENDERER_STYLE = { '--pr-sticky-top': '6rem' };

const CARD = 'flex flex-col gap-3 rounded-xl border border-tp-hairline bg-tp-canvas p-5 sm:p-6';

function describeLoadFailure(error: unknown): string {
  const failure = classifyAuthError(error);
  if (failure.code === 'pricing_digest_mismatch' || failure.status === 502) {
    return 'The pricing document doesn’t match its recorded digest (502 · pricing_digest_mismatch), so it isn’t shown. Showing unverified plans could mislead you.';
  }
  if (failure.status === 503) {
    return 'Pricing can’t be loaded right now (503 · pricing_unavailable). The catalog is hidden rather than showing figures we can’t verify.';
  }
  if (failure.kind === 'network')
    return 'Pricing can’t be reached right now. Check your connection and try again.';
  return `Pricing couldn’t be loaded${failure.status ? ` (${failure.status})` : ''}. Try again in a moment.`;
}

/** The plans, drawn from the same document the gateway serves and SPACE enforces. */
export default function PricingPage() {
  const { user } = useAuth();
  const { getPlansPricing } = useUserSettingsApi();
  const published = useResource('plans-pricing', getPlansPricing);
  const pricingDocument = published.data?.document ?? null;
  const [highlight, setHighlight] = useState('all');
  const [contactPlan, setContactPlan] = useState<string | null>(null);
  const subscription = useSubscription();

  const view = useMemo(
    () => (pricingDocument ? readCatalog(pricingDocument) : null),
    [pricingDocument]
  );
  const loading = published.status === 'loading';
  const failed = published.status === 'error' || (published.status === 'ready' && view === null);
  const plan = user?.plan ?? null;
  const released = view;

  const pills = useMemo(
    () => [
      { id: 'all', label: 'Compare all' },
      ...(view?.plans ?? []).map(item => ({ id: item.id, label: item.id })),
    ],
    [view]
  );

  // The drawn document marks what the account has, and offers on each plan the action the comparison offers.
  const service = view?.saasName.toLowerCase() ?? '';
  const mine = useMemo(
    () => currentSelectionOf(plan, subscription, service),
    [plan, subscription, service]
  );
  // The renderer reads the published YAML itself (it keeps the author's labels); the parsed document is the fallback.
  const source = useMemo(
    () =>
      pricingRendererSource(
        published.data?.yaml,
        pricingDocument ? (withInfiniteLimits(pricingDocument) as IPricingLike) : null
      ),
    [published.data, pricingDocument]
  );
  // Stable, so the renderer keeps the plan cards' actions mounted (and a closed dialog can give focus back to one).
  const renderPlanCta = useCallback(
    ({ planId }: { planId: string }) => {
      const column = view?.plans.find(item => item.id === planId);
      return column ? (
        <PlanCta
          plan={column}
          signedIn={plan !== null}
          current={plan === planId}
          onContact={setContactPlan}
        />
      ) : null;
    },
    [view, plan]
  );

  const retry = () => {
    published.reload();
  };
  const sphere = safeExternalHref(published.data?.permanentUrl);

  return (
    <>
      <Helmet>
        <title>OpenBinding - Pricing</title>
      </Helmet>
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-4xl font-extrabold tracking-tight text-tp-ink sm:text-5xl">
            Plans for every kind of binding work
          </h1>
          <p className="max-w-2xl text-lg text-tp-slate">
            Start free. Research accounts are free with a verified Universidad de Sevilla e-mail.
            Larger capacity is arranged by institutional agreement; there’s no checkout.
          </p>
          {released && (
            <div className="flex flex-wrap justify-center gap-1.5">
              <Chip>
                Pricing version <span className="font-mono">{released.version}</span>
              </Chip>
              {formatDate(released.createdAt) && (
                <Chip>Published {formatDate(released.createdAt)}</Chip>
              )}
              {released.currency && (
                <Chip>
                  {released.currency}
                  {released.periods ? ` · ${released.periods}` : ''}
                </Chip>
              )}
            </div>
          )}
        </div>

        {released?.developmentCopy && (
          <div className="rounded-lg border border-tp-severity-warning-border bg-tp-severity-warning-bg px-5 py-4 text-sm text-tp-warning-text">
            <p>
              <span className="font-bold">Development pricing.</span> These figures come from the{' '}
              {released.version} development copy and aren’t verified against the live pricing. If
              they differ, the live release applies.
            </p>
          </div>
        )}

        <div aria-live="polite" aria-busy={loading} className="flex flex-col gap-10">
          {loading && (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Skeleton variant="card" />
                <Skeleton variant="card" />
                <Skeleton variant="card" />
                <Skeleton variant="card" />
              </div>
              <Skeleton variant="panel" />
            </>
          )}

          {!loading && failed && (
            <BlockAlert
              variant="error"
              message={
                <span className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    {published.status === 'error'
                      ? describeLoadFailure(published.error)
                      : 'The pricing document has no plans to show.'}
                  </span>
                  <button
                    type="button"
                    onClick={retry}
                    className="cursor-pointer rounded-md border border-tp-severity-error-border bg-tp-canvas px-3 py-1 text-[13px] font-medium text-tp-error-strong hover:bg-tp-severity-error-bg"
                  >
                    Retry
                  </button>
                </span>
              }
            />
          )}

          {!loading && !failed && view && source && (
            <>
              <section aria-label="The pricing document" className="flex flex-col gap-2">
                <Suspense fallback={<Skeleton variant="panel" />}>
                  <SpherePricingRenderer
                    source={source}
                    preset="commercial"
                    hideSections={HIDDEN_SECTIONS}
                    currentSelection={mine}
                    defaultSelection={mine}
                    renderPlanCta={renderPlanCta}
                    renderSummaryActions={NO_SUMMARY_ACTIONS}
                    style={RENDERER_STYLE}
                  />
                </Suspense>
                <p className="text-[13px] text-tp-steel">
                  Drawn by <code className="font-mono">pricing-renderer</code> from the document the
                  gateway serves.
                  {sphere && (
                    <>
                      {' '}
                      Published in{' '}
                      <a
                        href={sphere}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cursor-pointer text-tp-accent hover:underline"
                      >
                        SPHERE
                      </a>
                      ; enforced by{' '}
                      <a
                        href="https://github.com/isa-group/space"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cursor-pointer text-tp-accent hover:underline"
                      >
                        SPACE
                      </a>
                      .
                    </>
                  )}
                </p>
              </section>

              <section aria-labelledby="pricing-compare" className={CARD}>
                <h2 id="pricing-compare" className="font-display text-2xl text-tp-ink">
                  Plans side by side
                </h2>
                <FilterPills
                  options={pills}
                  value={highlight}
                  onChange={setHighlight}
                  ariaLabel="Highlight a plan"
                />
                <PlanMatrix
                  view={view}
                  highlight={highlight}
                  plan={plan}
                  onContact={setContactPlan}
                />
                <p className="text-xs text-tp-steel">
                  Rounded figures show the exact value underneath. Monthly limits renew each month;
                  capacity limits are freed when work finishes; per-request ceilings apply to each
                  run. Every limit counts for the account that does the work.
                </p>
              </section>

              <Gates view={view} />
              {user && <Entitlements view={view} plan={user.plan} />}
              <AddOns view={view} plan={plan} />
              <LimitOutcomes />
              {view.researchDescription !== null && <ResearchCard signedIn={user !== null} />}
            </>
          )}
        </div>
      </div>
      {contactPlan && <ContactModal plan={contactPlan} onClose={() => setContactPlan(null)} />}
    </>
  );
}
