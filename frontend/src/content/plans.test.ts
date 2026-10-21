import { describe, expect, it } from 'vitest';
import { catalogFixture } from '../pages/Pricing/pricingFixture';
import { PRICING_VERSION, planSummaries } from './plans';

// The home page's plan strip is typed by hand. This keeps it honest: it is read against the synthetic pricing fixture it was copied from.

const pricing = catalogFixture as unknown as {
  version: string;
  plans: Record<string, { price: unknown; usageLimits: Record<string, { value: number | null }> }>;
};

function limitOf(plan: string, limit: string): number | null {
  const value = pricing.plans[plan]?.usageLimits?.[limit]?.value;
  expect(value, `${plan}.${limit}`).toBeDefined();
  return value as number | null;
}

const count = (value: number) => value.toLocaleString('en-US');
const plural = (value: number, noun: string) => `${count(value)} ${noun}${value === 1 ? '' : 's'}`;

describe('the plan summaries of the home page', () => {
  it('name the version of the pricing document they were copied from', () => {
    expect(PRICING_VERSION).toBe(pricing.version);
  });

  it('are exactly the plans of the document', () => {
    const ids = Object.keys(pricing.plans);
    expect(planSummaries.map((plan) => plan.name.toUpperCase()).sort()).toEqual([...ids].sort());
  });

  it.each(planSummaries.map((plan) => [plan.name, plan] as const))('%s repeats the limits and the price of the document', (_name, plan) => {
    const id = plan.name.toUpperCase();
    const keys = limitOf(id, 'apiKeys');
    const jobs = limitOf(id, 'concurrentJobs') ?? 0;

    expect(plan.chips).toEqual([
      keys === null ? 'Unlimited API keys' : plural(keys, 'API key'),
      plural(jobs, 'concurrent job'),
    ]);

    const price = pricing.plans[id]?.price;
    if (price === 0) expect(plan.price).toMatch(/^Free/);
    else expect(plan.price).toBe('Contact us');
  });
});
