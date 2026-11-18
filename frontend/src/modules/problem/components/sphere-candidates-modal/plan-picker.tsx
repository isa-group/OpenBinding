// Adapted from SPHERE frontend/src/modules/pricing/components/configuration-space-view/configuration-picker.tsx
// (feat/pricing-renderer, revision 694f292b03), https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García
// Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the picker chooses a set of plans to import (each becomes a candidate), not one configuration: a checklist beside
// the drawn pricing includes or excludes each plan, lists each add-on that can be taken with them as a variant, and disables
// the plans the gateway's summary marks private or without a readable price, with its reason; add-ons charged per use are
// listed apart and never imported. The drawing and the checklist are one choice in two views, as SPHERE's are: picking a
// plan in the drawing points at its row, and "Show" draws a row in the drawing (selection-mapping). The configuration-space
// parts (Quick Browse position, capture for comparison, the solver's space) are dropped: they are F8's.

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { NormalizedPricing, PricingSelection } from 'pricing-renderer';
import type {
  PricingReadyEvent,
  PricingRendererElement,
  PricingSelectionChangeEvent,
} from 'pricing-renderer/react';

import SpherePricingRenderer from '../../../core/components/pricing-renderer';
import { selectionForConfiguration } from '../../../core/utils/sphere/selection-mapping';
import { planRefusal, priceText, type SummaryAddOn, type VersionSummary } from './summary';

/**
 * Sections the picker does not draw: the wizard's header already names the pricing and its version, the checklist is the
 * comparison, and billing and variables are the recipe's (the billing period is chosen in the wizard, and a variable never
 * changes what the gateway generates).
 */
const PICKER_HIDDEN_SECTIONS = [
  'saasName',
  'description',
  'metadata',
  'billing',
  'variables',
  'comparison',
  'summary',
] as const;

/** The plans and add-on variants chosen from one pricing, by the names the pricing gives them. */
export interface PlanChoice {
  plans: string[];
  addons: string[];
}

export interface PlanPickerProps {
  /** The version's YAML (its stored snapshot), which the drawing reads. */
  yaml: string;
  /** The gateway's summary of the same version: prices, privacy and add-ons. */
  summary: VersionSummary;
  value: PlanChoice;
  onChange: (value: PlanChoice) => void;
}

/** The add-ons that can be taken with at least one of the chosen plans (variants), public ones only. */
function variantsFor(summary: VersionSummary, plans: string[]): SummaryAddOn[] {
  return summary.addOns.filter(
    addOn =>
      !addOn.private &&
      (addOn.availableFor.length === 0 || addOn.availableFor.some(plan => plans.includes(plan)))
  );
}

/**
 * The plans of one pricing to import as candidates, drawn by pricing-renderer beside a checklist. Nothing here decides a price
 * or an eligibility: the summary says which plans cannot be imported and why, and the preview says which candidates the
 * problem's requirements keep.
 */
export default function PlanPicker({ yaml, summary, value, onChange }: PlanPickerProps) {
  const ref = useRef<PricingRendererElement>(null);
  const [pricing, setPricing] = useState<NormalizedPricing>();
  const [shown, setShown] = useState<string | null>(null);
  const plansId = useId();
  const addOnsId = useId();
  const source = useMemo(() => ({ yaml }), [yaml]);

  // State comes from the element's own props, wired when it is created, so the first `pricing-ready` is never missed.
  const handleReady = useCallback((event: PricingReadyEvent) => {
    setPricing(event.detail.pricing);
    setShown(event.detail.selection.planId ?? null);
  }, []);
  const handleSelectionChange = useCallback((event: PricingSelectionChangeEvent) => {
    const selection: PricingSelection = event.detail.selection;
    setShown(selection.planId ?? null);
  }, []);

  const show = (plan: string) => {
    if (!pricing) return;
    // applySelection raises no event, so the plan it drew is followed here.
    const result = ref.current?.applySelection(
      selectionForConfiguration(pricing, { selectedPlan: plan, selectedAddons: [] })
    );
    if (result?.applied) setShown(plan);
  };

  const toggle = (list: 'plans' | 'addons', id: string) => {
    const current = value[list];
    const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id];
    const plans = list === 'plans' ? next : value.plans;
    const offered = new Set(variantsFor(summary, plans).map(addOn => addOn.id));
    onChange({
      plans,
      addons: (list === 'addons' ? next : value.addons).filter(addOn => offered.has(addOn)),
    });
  };

  const variants = variantsFor(summary, value.plans);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={plansId}>
          <legend className="text-sm font-medium text-tp-ink">Plans to import</legend>
          <p id={plansId} className="text-xs text-tp-steel">
            Each plan becomes a candidate. The preview says which ones meet the requirements.
          </p>
          {summary.plans.map(plan => {
            const refusal = planRefusal(plan);
            const checked = value.plans.includes(plan.id);
            return (
              <div
                key={plan.id}
                className={`flex min-w-0 items-start gap-2 rounded-lg border px-2.5 py-2 ${shown === plan.id ? 'border-tp-primary bg-tp-primary/5' : 'border-tp-hairline bg-tp-canvas'}`}
                data-shown={shown === plan.id || undefined}
              >
                <input
                  id={`${plansId}-${plan.id}`}
                  type="checkbox"
                  className="mt-0.5"
                  checked={checked && !refusal}
                  disabled={refusal !== null}
                  onChange={() => toggle('plans', plan.id)}
                  aria-describedby={refusal ? `${plansId}-${plan.id}-why` : undefined}
                />
                <label htmlFor={`${plansId}-${plan.id}`} className="min-w-0 flex-1 cursor-pointer">
                  <span className="block text-sm font-semibold [overflow-wrap:anywhere] text-tp-ink">
                    {plan.name}
                  </span>
                  <span className="block text-xs text-tp-steel">
                    {priceText(plan.price, summary.currency, plan.period)}
                    {plan.perSeat ? ' per seat' : ''}
                  </span>
                  {refusal && (
                    <span
                      id={`${plansId}-${plan.id}-why`}
                      className="mt-0.5 block text-xs text-tp-warning-text"
                    >
                      {refusal}
                    </span>
                  )}
                </label>
                <button
                  type="button"
                  className="cursor-pointer rounded-md px-1.5 py-0.5 text-xs font-medium text-tp-link hover:bg-tp-surface disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => show(plan.id)}
                  disabled={!pricing}
                  aria-label={`Show ${plan.name} in the drawing`}
                >
                  Show
                </button>
              </div>
            );
          })}
        </fieldset>

        {summary.addOns.length > 0 && (
          <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={addOnsId}>
            <legend className="text-sm font-medium text-tp-ink">Add-on variants</legend>
            <p id={addOnsId} className="text-xs text-tp-steel">
              A chosen add-on adds one candidate per plan it can be taken with.
            </p>
            {variants.length === 0 ? (
              <p className="text-xs text-tp-steel">No add-on goes with the chosen plans.</p>
            ) : (
              variants.map(addOn => (
                <label
                  key={addOn.id}
                  className="flex min-w-0 cursor-pointer items-start gap-2 text-sm text-tp-ink"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={value.addons.includes(addOn.id)}
                    onChange={() => toggle('addons', addOn.id)}
                  />
                  <span className="min-w-0">
                    <span className="[overflow-wrap:anywhere]">{addOn.name}</span>
                    <span className="block text-xs text-tp-steel">
                      {priceText(addOn.price, summary.currency, addOn.period)}
                      {addOn.availableFor.length > 0 &&
                        ` · with ${addOn.availableFor.filter(plan => value.plans.includes(plan)).join(', ')}`}
                    </span>
                  </span>
                </label>
              ))
            )}
          </fieldset>
        )}

        {summary.meteredAddOns.length > 0 && (
          <section aria-label="Charged per use" className="flex flex-col gap-1">
            <h4 className="text-sm font-medium text-tp-ink">Charged per use, not imported</h4>
            <ul className="flex flex-col gap-0.5 text-xs text-tp-steel">
              {summary.meteredAddOns.map(addOn => (
                <li key={addOn.id} className="[overflow-wrap:anywhere]">
                  {addOn.name}: {priceText(addOn.price, summary.currency)}
                  {addOn.unit ? ` per ${addOn.unit}` : ''}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="min-w-0">
        <SpherePricingRenderer
          ref={ref}
          source={source}
          preset="catalog"
          hideSections={PICKER_HIDDEN_SECTIONS}
          variablesEnabled={false}
          onReady={handleReady}
          onSelectionChange={handleSelectionChange}
        />
      </div>
    </div>
  );
}
