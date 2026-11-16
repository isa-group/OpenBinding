import { PricingRenderer } from 'pricing-renderer/react';
import 'pricing-renderer/styles.css';

/** The card already names the plan, the pricing and the version; only the plan's features and limits are drawn. */
const HIDDEN_SECTIONS = ['hero', 'billing', 'variables', 'summary', 'addOns'] as const;

/**
 * One plan of a Pricing2Yaml document, drawn by pricing-renderer in its `catalog` mode: read only, with that plan marked and
 * nothing to choose or buy.
 */
export default function PricingPlan({ yaml, plan }: { yaml: string; plan: string }) {
  return (
    <div className="pricing-renderer-shell">
      <PricingRenderer
        yaml={yaml}
        mode="catalog"
        theme="light"
        currentSelection={{ planId: plan }}
        selectionEnabled={false}
        ctaEnabled={false}
        hideSections={HIDDEN_SECTIONS}
      />
    </div>
  );
}
