import {
  compareSelections,
  createDefaultSelection,
  type PricingSelection,
  type SelectionComparison,
} from 'pricing-renderer';
import { parsePricingYaml } from 'pricing-renderer/yaml';
import { selectionForConfiguration } from '../../utils/sphere/selection-mapping';

/** The `String` expression function the gateway's normaliser allows, so expression prices draw on both sides. */
const EXPRESSION = { functions: { String: (value: unknown) => String(value) } };

/** A provider plan compared across two versions of its pricing, or why the drawing cannot be made. */
export type PlanComparison =
  { ok: true; comparison: SelectionComparison } | { ok: false; reason: string };

/**
 * One plan (with its add-ons) of a provider, in the pricing version it was pinned to and in the newer one: pricing-renderer's
 * own comparison over the two YAML documents, for drawing only. A plan missing from a side compares as no plan.
 */
export function compareProviderPlan(
  before: string,
  after: string,
  plan: string,
  addOns: readonly string[] = []
): PlanComparison {
  const older = parsePricingYaml(before);
  const newer = parsePricingYaml(after);
  if (!older.value || !newer.value) {
    const codes = [...older.diagnostics, ...newer.diagnostics]
      .filter(diagnostic => diagnostic.severity === 'error')
      .map(diagnostic => diagnostic.code);
    return {
      ok: false,
      reason: `a version can’t be read${codes.length ? ` (${[...new Set(codes)].join(', ')})` : ''}`,
    };
  }
  const side = (pricing: NonNullable<typeof older.value>): PricingSelection => ({
    ...createDefaultSelection(pricing),
    ...selectionForConfiguration(pricing, {
      selectedPlan: pricing.plans.some(entry => entry.id === plan) ? plan : undefined,
      selectedAddons: addOns.filter(id => pricing.addOns.some(entry => entry.id === id)),
    }),
  });
  return {
    ok: true,
    comparison: compareSelections({
      before: { pricing: older.value, selection: side(older.value) },
      after: { pricing: newer.value, selection: side(newer.value) },
      expression: EXPRESSION,
    }),
  };
}

/**
 * Neutral words for comparing a provider's plan across two versions of its pricing: nobody holds a subscription here, so the
 * review speaks of a plan before and after, not of "your" contract.
 */
export const PROVIDER_PLAN_MESSAGES: Readonly<Record<string, string>> = {
  'pricing.reviewPriceBefore': 'Before',
  'pricing.reviewPriceAfter': 'After',
  'pricing.reviewNoChanges': 'The plan is the same in both versions.',
  'pricing.reviewRemovedNotInVersion': 'Not offered in the newer version',
  'pricing.reviewNotices': 'Notes',
  'pricing.reviewLimitExceeded': 'The demand ({usage}) is above the new limit.',
};
