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

/** The card reads a version; the renderer's storefront titles ("Choose a plan", "Extend your plan") ask to buy. */
const MESSAGES = {
  'pricing.plansTitle': 'Plans of this version',
  'pricing.addOnsTitle': 'Add-ons of this version',
};

/**
 * One plan of a Pricing2Yaml document, drawn by pricing-renderer through the bridge's `catalog` preset: read only, with that
 * plan (and the add-ons taken with it) marked and nothing to choose or buy. The plan is also the drawing's selection, or the
 * renderer would mark its own default (the first plan) beside it.
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
      defaultSelection={current}
      selectionEnabled={false}
      messages={MESSAGES}
      hideSections={key ? HIDDEN_WITH_ADDONS : HIDDEN_SECTIONS}
    />
  );
}
