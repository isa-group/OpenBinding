import { useMemo } from 'react';
import SpherePricingRenderer from '../pricing-renderer';

/** The card already names the plan, the pricing and the version; only the plan's features and limits (and add-ons) are drawn. */
const HIDDEN_SECTIONS = ['hero', 'billing', 'variables', 'summary', 'addOns'] as const;
const HIDDEN_WITH_ADDONS = ['hero', 'billing', 'variables', 'summary'] as const;

/**
 * One plan of a Pricing2Yaml document, drawn by pricing-renderer through the bridge's `catalog` preset: read only, with that
 * plan (and the add-ons taken with it) marked and nothing to choose or buy.
 */
export default function PricingPlan({
  yaml,
  plan,
  addOns = [],
}: {
  yaml: string;
  plan: string;
  addOns?: readonly string[];
}) {
  const source = useMemo(() => ({ yaml }), [yaml]);
  const key = addOns.join('\u0000');
  const current = useMemo(
    () => ({
      planId: plan,
      ...(key
        ? {
            addOns: Object.fromEntries(
              key.split('\u0000').map(id => [id, { selected: true, quantity: 1 }])
            ),
          }
        : {}),
    }),
    [plan, key]
  );
  return (
    <SpherePricingRenderer
      source={source}
      preset="catalog"
      currentSelection={current}
      selectionEnabled={false}
      hideSections={key ? HIDDEN_WITH_ADDONS : HIDDEN_SECTIONS}
    />
  );
}
