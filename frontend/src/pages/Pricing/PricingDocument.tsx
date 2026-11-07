import { useMemo, type ReactNode } from 'react';
import type { PricingSelection } from 'pricing-renderer';
import { PricingRenderer } from 'pricing-renderer/react';
import 'pricing-renderer/styles.css';
import type { PricingCatalog } from '../../api/auth';
import { withInfiniteLimits } from './pricingModel';

/** The page around the document already shows its title, version and description. */
const HIDDEN_SECTIONS = ['hero'] as const;

/**
 * The pricing document drawn by `pricing-renderer`, the same package every Pricing2Yaml consumer can use.
 * It is the long form of the comparison above, loaded only when someone opens it.
 *
 * The page decides what a visitor can do. Every plan card offers the action the comparison offers for that plan
 * (`planAction`), and the summary offers none, because nothing is bought here. The renderer's own calls to action
 * would read "Upgrade" or "Downgrade" against `current` by the order in which the document declares its plans,
 * and these plans are not a ladder. `current` marks the account's plan and add-ons, and starts selected.
 */
export default function PricingDocument({ catalog, current, planAction }: {
  catalog: PricingCatalog;
  current?: Partial<PricingSelection>;
  planAction: (planId: string) => ReactNode;
}) {
  const pricing = useMemo(() => withInfiniteLimits(catalog) as PricingCatalog, [catalog]);
  return (
    <div className="pricing-renderer-shell">
      <PricingRenderer
        pricing={pricing}
        theme="light"
        hideSections={HIDDEN_SECTIONS}
        currentSelection={current}
        defaultSelection={current}
        renderPlanCta={({ planId }) => planAction(planId)}
        renderSummaryActions={() => null}
      />
    </div>
  );
}
