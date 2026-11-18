import { useMemo } from 'react';
import SpherePricingRenderer from '../pricing-renderer';

/**
 * The card already names the plan, the pricing and the version; only the plans (that one marked) and, when the plan is taken
 * with add-ons, the add-ons are drawn. The whole pricing's comparison table is SPHERE's to show ("Open in SPHERE"): drawn in a
 * card it runs to every feature of every plan.
 */
const HIDDEN_SECTIONS = [
  'hero',
  'saasName',
  'description',
  'metadata',
  'billing',
  'variables',
  'summary',
  'addOns',
  'comparison',
] as const;
const HIDDEN_WITH_ADDONS = HIDDEN_SECTIONS.filter(section => section !== 'addOns');

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
