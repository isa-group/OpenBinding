import { describe, expect, it } from 'vitest';
import { retrievePricingFromYaml } from 'pricing4ts';
import source from '../../../space/pricing/openbinding.yml?raw';
import { PRICING_VERSION, planSummaries } from './plans';

// The home page's plan strip is typed by hand. This keeps it honest: it is read against the pricing document it was copied from.

const pricing = retrievePricingFromYaml(source);

function limitOf(plan: string, limit: string): number {
  const value = pricing.plans?.[plan]?.usageLimits?.[limit]?.value;
  expect(value, `${plan}.${limit}`).toBeDefined();
  return Number(value);
}

const count = (value: number) => value.toLocaleString('en-US');
// The document writes “no limit” as `.inf`, which pricing4ts reads as an enormous number rather than Infinity.
const unlimited = (value: number) => !Number.isFinite(value) || value >= 100_000_000;

describe('the plan summaries of the home page', () => {
  it('name the version of the pricing document they were copied from', () => {
    expect(PRICING_VERSION).toBe(pricing.version);
  });

  it('are exactly the plans of the document', () => {
    const ids = Object.keys(pricing.plans ?? {});
    expect(planSummaries.map((plan) => plan.name.toUpperCase()).sort()).toEqual([...ids].sort());
  });

  it.each(planSummaries.map((plan) => [plan.name, plan] as const))('%s repeats the limits and the price of the document', (_name, plan) => {
    const id = plan.name.toUpperCase();
    const solves = limitOf(id, 'taskStarts');
    const jobs = limitOf(id, 'concurrentJobs');
    const runs = limitOf(id, 'studyRuns');

    expect(plan.chips).toEqual([
      unlimited(solves) ? 'Unlimited solves' : `${count(solves)} solves / month`,
      `${count(jobs)} concurrent ${jobs === 1 ? 'job' : 'jobs'}`,
      `${count(runs)} study runs / month`,
    ]);

    const price = pricing.plans?.[id]?.price;
    if (price === 0) expect(plan.price).toMatch(/^Free/);
    else expect(plan.price).toBe('Contact us');
  });
});
