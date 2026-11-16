import { lazy, Suspense, useId } from 'react';
import type { Provenance } from '../../entities/composition/document';
import './PricingCard.css';

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
    <article className="pc" aria-labelledby={title}>
      <header className="pc-head">
        <h3 id={title}>Plan {plan}</h3>
        <span className="pc-pricing">{sphere}</span>
      </header>
      <dl className="pc-facts">
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
            <p className="pc-note" role="status">
              Drawing the plan…
            </p>
          }
        >
          <PricingPlan yaml={yaml} plan={plan} />
        </Suspense>
      ) : (
        <p className="pc-note">
          A reference to a SPHERE plan: its prices and limits are kept in SPHERE.
        </p>
      )}
    </article>
  );
}
