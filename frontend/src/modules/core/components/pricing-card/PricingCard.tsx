import { lazy, Suspense, useId } from 'react';
import type { Provenance } from '../../utils/composition/document';

// The drawing loads pricing-renderer, so it comes in its own chunk, and only when there is a document to draw.
const PricingPlan = lazy(() => import('./PricingPlan'));

interface PricingCardProps {
  /** The SPHERE plan a candidate comes from, as the composition writes it (`binding.<task>.from`). */
  reference: Provenance;
  /** The Pricing2Yaml document of that pricing at that version, when OpenBinding holds one; without it the card shows the reference. */
  yaml?: string;
}

/**
 * An upstream plan: the plan of a SPHERE pricing that a candidate comes from. Given the pricing's YAML, pricing-renderer draws
 * the plan; without it the card is a reference face (owner/name, plan, pinned version, registry and add-ons), which is all a
 * composition carries until OpenBinding keeps copies of the pricings.
 *
 * The reference face has no link. SPHERE (revision 73779a8a) addresses a pricing as `/pricings/:organizationId/:slug`, by the
 * organization's id and a slug that changes when the pricing is renamed, or as `/p/:pricingId` by its permanent id; a
 * reference names the pricing's owner and name, and a version id, none of which forms one of those addresses. A registry
 * alias names an on-premise SPHERE whose address only the gateway knows.
 */
export function PricingCard({ reference, yaml }: PricingCardProps) {
  const title = useId();
  const { sphere, registry, version, plan, addons = [] } = reference;
  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-xl border border-tp-hairline bg-tp-canvas p-3"
      aria-labelledby={title}
    >
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3
          id={title}
          className="m-0 text-[15px] font-semibold [overflow-wrap:anywhere] text-tp-ink"
        >
          Plan {plan}
        </h3>
        <span className="font-mono text-[13px] [overflow-wrap:anywhere] text-tp-slate">
          {sphere}
        </span>
      </header>
      <dl className="m-0 flex flex-col gap-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:[overflow-wrap:anywhere] [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere] [&_dd]:text-tp-ink [&_dt]:min-w-16 [&_dt]:text-tp-steel [&>div]:flex [&>div]:min-w-0 [&>div]:flex-wrap [&>div]:gap-x-2 [&>div]:gap-y-1 [&>div]:text-[13px]">
        <div>
          <dt>Version</dt>
          <dd>
            <code>{version}</code>
          </dd>
        </div>
        <div>
          <dt>SPHERE</dt>
          <dd>
            {registry ? (
              <>
                Registry <code>{registry}</code>
              </>
            ) : (
              'This installation’s'
            )}
          </dd>
        </div>
        <div>
          <dt>Add-ons</dt>
          <dd>{addons.length ? addons.join(', ') : 'None'}</dd>
        </div>
      </dl>
      {yaml !== undefined ? (
        <Suspense
          fallback={
            <p className="m-0 text-xs text-tp-steel" role="status">
              Drawing the plan…
            </p>
          }
        >
          <PricingPlan yaml={yaml} plan={plan} />
        </Suspense>
      ) : (
        <p className="m-0 text-xs text-tp-steel">
          A reference to a SPHERE plan: its prices and limits are kept in SPHERE.
        </p>
      )}
    </article>
  );
}
