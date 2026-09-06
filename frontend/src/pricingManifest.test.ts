import { describe, expect, it } from 'vitest';
import { retrievePricingFromYaml } from 'pricing4ts';
import source from '../../space/pricing/openbinding.yml?raw';

describe('active iPricing drives the frontend model', () => {
  it('reflects plan, limit, feature and add-on changes without code changes', () => {
    const original = retrievePricingFromYaml(source);
    const planId = Object.keys(original.plans ?? {})[0];
    const limitId = Object.keys(original.usageLimits ?? {})[0];
    const addOnId = Object.keys(original.addOns ?? {})[0];
    expect(planId && limitId && addOnId).toBeTruthy();
    const renamedPlan = 'RENAMED_FROM_YAML';
    const addedFeature = 'featureAddedInYaml';

    let changed = source.replaceAll(planId, renamedPlan);
    changed = changed.replace(
      'features:\n',
      `features:\n  ${addedFeature}:\n    description: Added dynamically.\n    type: DOMAIN\n    valueType: BOOLEAN\n    defaultValue: true\n    expression: pricingContext['features']['${addedFeature}']\n`,
    );
    changed = changed.replace('maxQuantity: 10', 'maxQuantity: 9');
    const changedLimit = Number(original.usageLimits?.[limitId]?.defaultValue) + 1;
    const limitBlock = new RegExp(`(  ${limitId}:\\n(?:(?!  [A-Za-z]).*\\n)*?    defaultValue: )[^\\n]+`);
    changed = changed.replace(limitBlock, (_match: string, prefix: string) => `${prefix}${changedLimit}`);
    const pricing = retrievePricingFromYaml(changed);

    expect(pricing.plans?.[renamedPlan]).toBeDefined();
    expect(pricing.plans?.[planId]).toBeUndefined();
    expect(pricing.features[addedFeature]?.defaultValue).toBe(true);
    expect(pricing.usageLimits?.[limitId]?.defaultValue).toBe(changedLimit);
    expect(pricing.addOns?.[addOnId]?.subscriptionConstraints.maxQuantity).toBe(9);
  });

  it('contains no OpenBinding mapping layer', () => {
    const pricing = retrievePricingFromYaml(source);
    expect((pricing.custom as Record<string, unknown> | undefined)?.openbinding).toBeUndefined();
  });
});
