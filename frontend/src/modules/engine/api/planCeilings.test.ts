import { describe, expect, it } from 'vitest';
import { optionFacts } from './enginesModel';
import { catalogFixture } from '../../../test/fixtures/pricingCatalog';
import { optionKind, planCeilings, previewOption } from './planCeilings';
import type { EngineMode } from '../../../api/client';

const ceilings = planCeilings(catalogFixture);
const plan = (name: string) => ceilings.plans.find(item => item.plan === name) ?? null;

function mode(
  properties: Record<string, Record<string, unknown>>,
  required: string[] = []
): EngineMode {
  const all = { selector: 'all' as const };
  return {
    id: 'm',
    profile: 'qos-binding/v1',
    ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' },
    algorithm: 'a',
    capabilities: {
      workflowNodes: all,
      metricScopes: all,
      aggregations: all,
      constraints: all,
      optimization: all,
      objectiveTypes: all,
      expressions: all,
      placement: all,
      irExtensions: all,
    },
    optionsSchema: { type: 'object', properties, required, additionalProperties: false },
    limits: {},
    guarantees: { termination: ['FEASIBLE'], exact: false },
  };
}

describe('plan ceilings read from the pricing document', () => {
  it('reads the run-time ceiling of every plan, as the gateway enforces it', () => {
    expect(ceilings.version).toBe('0.2.0');
    expect(ceilings.plans.map(item => item.plan).sort()).toEqual(['FREE', 'LAB', 'RESEARCH']);
    expect(plan('FREE')).toEqual({ plan: 'FREE', maxRunMinutes: 5 });
    expect(plan('RESEARCH')).toEqual({ plan: 'RESEARCH', maxRunMinutes: 30 });
    expect(plan('LAB')).toEqual({ plan: 'LAB', maxRunMinutes: 1440 });
  });

  it('maps only the options the gateway lowers: time to the plan, effort to the deployment', () => {
    expect(optionKind('time_budget_ms')).toBe('time');
    expect(optionKind('iterations')).toBe('effort');
    expect(optionKind('max_evaluations')).toBe('effort');
    expect(optionKind('population')).toBe('unmapped-by-plan');
  });

  it('previews OPTION_CLAMPED when a time default exceeds the plan, and leaves effort to the deployment', () => {
    const facts = optionFacts(
      mode({
        time_budget_ms: { type: 'integer', default: 600000, unit: 'ms' },
        iterations: { type: 'integer', default: 100000 },
        population: { type: 'integer', default: 64 },
      })
    );
    const free = facts.map(fact => previewOption(fact, plan('FREE')));
    expect(free[0]).toMatchObject({
      name: 'time_budget_ms',
      ceiling: '300,000 ms (5 min)',
      outcome: { kind: 'clamped', applied: '300,000' },
    });
    expect(free[1]).toMatchObject({
      name: 'iterations',
      unit: 'iteration',
      ceiling: 'Set by the deployment',
      outcome: { kind: 'none' },
    });
    expect(free[2]).toMatchObject({
      name: 'population',
      ceiling: 'Not reduced by plan',
      outcome: { kind: 'none', text: 'Applies as requested' },
    });

    const research = facts.map(fact => previewOption(fact, plan('RESEARCH')));
    expect(research[0].outcome.kind).toBe('fits');
  });

  it('says "Not mapped" when the document has no ceiling for a time budget', () => {
    const [fact] = optionFacts(mode({ time_budget_ms: { type: 'integer', default: 5 } }));
    expect(previewOption(fact, { plan: 'X', maxRunMinutes: null }).ceiling).toBe('Not mapped');
    expect(previewOption(fact, null).ceiling).toBe('Not mapped');
  });

  it('reads the catalog the gateway serves: JSON, with an unlimited allowance as null', () => {
    const catalog = JSON.parse(JSON.stringify(catalogFixture)) as Record<string, unknown>;
    expect(planCeilings(catalog).plans).toEqual(ceilings.plans);

    const unlimited = JSON.parse(JSON.stringify(catalog)) as {
      plans: Record<string, { usageLimits: Record<string, { value: number | null }> }>;
    };
    unlimited.plans.LAB.usageLimits.maxRunMinutes.value = null;
    // No ceiling to preview, rather than the document's default (5) for a plan that has none.
    expect(planCeilings(unlimited).plans.find(item => item.plan === 'LAB')).toEqual({
      plan: 'LAB',
      maxRunMinutes: null,
    });
  });

  it('reads nothing from a document that is not a pricing', () => {
    expect(planCeilings(null)).toEqual({ version: null, plans: [] });
    expect(planCeilings({ plans: 'no' })).toEqual({ version: null, plans: [] });
  });
});
