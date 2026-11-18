// SPHERE's feat/pricing-renderer branch (revision 694f292b03) ships selection-mapping.ts without a test; this one holds the
// copy to its contract over a recorded SPHERE pricing (set-B Mailgun, src/test/fixtures/sphere).

import { describe, expect, it } from 'vitest';
import { createDefaultSelection } from 'pricing-renderer';
import { parsePricingYaml } from 'pricing-renderer/yaml';
import mailgunYaml from '../../../../test/fixtures/sphere/6ade364540e55445692b0eda.6ade36454b2b5b01c587db3d.yml?raw';
import {
  ANALYSIS_ADDON_QUANTITY,
  completeSelectionForConfiguration,
  describeSelection,
  sameAsConfiguration,
  selectedAddOnIds,
  selectionForConfiguration,
} from './selection-mapping';

const parsed = parsePricingYaml(mailgunYaml);
const pricing = parsed.value!;

describe('selection-mapping', () => {
  it('reads the recorded pricing', () => {
    expect(parsed.ok).toBe(true);
    expect(pricing.addOns.map(addOn => addOn.id)).toContain('dedicatedIp');
  });

  it('names every add-on of the pricing, the ones left off included', () => {
    const selection = selectionForConfiguration(pricing, {
      selectedPlan: 'FOUNDATION',
      selectedAddons: ['dedicatedIp'],
    });
    expect(selection.planId).toBe('FOUNDATION');
    expect(Object.keys(selection.addOns ?? {}).sort()).toEqual(
      pricing.addOns.map(addOn => addOn.id).sort()
    );
    expect(selection.addOns?.dedicatedIp).toEqual({
      selected: true,
      quantity: ANALYSIS_ADDON_QUANTITY,
    });
  });

  it('lists the selected add-ons sorted, and compares a selection with a configuration by value', () => {
    const complete = completeSelectionForConfiguration(pricing, {
      selectedPlan: 'FOUNDATION',
      selectedAddons: ['dedicatedIp'],
    });
    expect(selectedAddOnIds(complete)).toEqual(['dedicatedIp']);
    expect(
      sameAsConfiguration(
        { selectedPlan: 'FOUNDATION', selectedAddons: ['dedicatedIp'] },
        'FOUNDATION',
        ['dedicatedIp']
      )
    ).toBe(true);
    expect(
      sameAsConfiguration({ selectedPlan: 'SCALE', selectedAddons: [] }, 'FOUNDATION', [])
    ).toBe(false);
    expect(selectedAddOnIds(undefined)).toEqual([]);
  });

  it('describes a selection by its plan and how many add-ons go with it', () => {
    const base = createDefaultSelection(pricing);
    expect(describeSelection({ ...base, planId: 'SCALE', addOns: {} })).toBe('SCALE');
    expect(
      describeSelection(
        completeSelectionForConfiguration(pricing, {
          selectedPlan: 'SCALE',
          selectedAddons: ['dedicatedIp'],
        })
      )
    ).toBe('SCALE + 1 add-on');
    expect(describeSelection({ ...base, planId: '', addOns: {} })).toBe('No plan');
  });
});
