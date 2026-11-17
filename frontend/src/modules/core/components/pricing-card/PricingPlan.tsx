import SpherePricingRenderer from '../pricing-renderer';

/** The card already names the plan, the pricing and the version; only the plan's features and limits are drawn. */
const HIDDEN_SECTIONS = ['hero', 'billing', 'variables', 'summary', 'addOns'] as const;

/**
 * One plan of a Pricing2Yaml document, drawn by pricing-renderer through the bridge's `catalog` preset: read only, with that
 * plan marked and nothing to choose or buy.
 */
export default function PricingPlan({ yaml, plan }: { yaml: string; plan: string }) {
  return (
    <SpherePricingRenderer
      source={{ yaml }}
      preset="catalog"
      currentSelection={{ planId: plan }}
      selectionEnabled={false}
      hideSections={HIDDEN_SECTIONS}
    />
  );
}
