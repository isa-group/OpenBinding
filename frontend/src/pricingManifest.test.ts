import { describe, expect, it } from 'vitest';
import { retrievePricingFromYaml } from 'pricing4ts';

// TEST FIXTURE, NOT A REAL PRICING: a minimal synthetic document with functional limits only. The real pricings live in the SPACE and
// SPHERE consoles; this only proves that the parser the frontend relies on follows whatever document it is given.
const source = `syntaxVersion: '3.1'
saasName: synthetic-test-pricing
version: 0.1.0
createdAt: '2026-09-01'
currency: EUR
billing:
  monthly: 1
tags: [Solving, Collaboration]

features:
  solve:
    description: Run engines.
    tag: Solving
    type: DOMAIN
    valueType: BOOLEAN
    defaultValue: true
    expression: pricingContext['features']['solve'] && subscriptionContext['concurrentJobs'] < pricingContext['usageLimits']['concurrentJobs']
  apiAccess:
    description: Use API keys.
    tag: Collaboration
    type: INTEGRATION
    integrationType: API
    valueType: BOOLEAN
    defaultValue: true
    expression: pricingContext['features']['apiAccess']

usageLimits:
  concurrentJobs:
    description: Jobs running at the same time for one actor.
    tag: Solving
    type: NON_RENEWABLE
    trackable: true
    valueType: NUMERIC
    defaultValue: 1
    unit: job
    linkedFeatures: [solve]
  apiKeys:
    description: Active API keys owned by one actor.
    tag: Collaboration
    type: NON_RENEWABLE
    trackable: true
    valueType: NUMERIC
    defaultValue: 1
    unit: key
    linkedFeatures: [apiAccess]

plans:
  BASIC:
    description: Free default plan.
    price: 0.0
    unit: user/month
    features:
      solve: { value: true }
      apiAccess: { value: true }
    usageLimits:
      concurrentJobs: { value: 1 }
      apiKeys: { value: 1 }
  PRO:
    description: Contact us / Institutional agreement.
    price: Contact us / Institutional agreement
    unit: user/month
    features:
      solve: { value: true }
      apiAccess: { value: true }
    usageLimits:
      concurrentJobs: { value: 8 }
      apiKeys: { value: 25 }

addOns:
  CONCURRENCY_PACK:
    description: Adds one concurrent job.
    availableFor: [PRO]
    price: Contact us
    unit: pack/month
    subscriptionConstraints: { minQuantity: 1, maxQuantity: 10, quantityStep: 1 }
    usageLimitsExtensions:
      concurrentJobs: { value: 1 }
`;

describe('a pricing document drives the frontend model', () => {
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
