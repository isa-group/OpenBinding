import { describe, expect, it } from 'vitest';
import { retrievePricingFromYaml } from 'pricing4ts';
import source from '../../../../space/pricing/openbinding.yml?raw';
import { optionFacts } from '../Engines/enginesModel';
import { optionKind, planCeilings, previewOption } from './planCeilings';
import type { EngineMode } from '../../api/client';

const ceilings = planCeilings(retrievePricingFromYaml(source));
const plan = (name: string) => ceilings.plans.find((item) => item.plan === name) ?? null;

function mode(properties: Record<string, Record<string, unknown>>, required: string[] = []): EngineMode {
  const all = { selector: 'all' as const };
  return {
    id: 'm', profile: 'qos-binding/v1', ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' }, algorithm: 'a',
    capabilities: { workflowNodes: all, metricScopes: all, aggregations: all, constraints: all, optimization: all, objectiveTypes: all, expressions: all, placement: all, irExtensions: all },
    optionsSchema: { type: 'object', properties, required, additionalProperties: false },
    limits: {}, guarantees: { termination: ['FEASIBLE'], exact: false },
  };
}

describe('plan ceilings read from the pricing document', () => {
  it('reads the timeout and iteration ceilings of every plan, as the gateway enforces them', () => {
    expect(ceilings.version).toBe('0.1.0');
    expect(ceilings.plans.map((item) => item.plan).sort()).toEqual(['ADVANCED', 'BASIC', 'PRO', 'RESEARCH']);
    expect(plan('BASIC')).toMatchObject({ maxTimeoutSeconds: 60, maxIterations: 10_000 });
    expect(plan('ADVANCED')).toMatchObject({ maxTimeoutSeconds: 600, maxIterations: 500_000 });
    expect(plan('RESEARCH')).toMatchObject({ maxTimeoutSeconds: 900, maxIterations: 1_000_000 });
    expect(plan('PRO')).toMatchObject({ maxTimeoutSeconds: 1800, maxIterations: 10_000_000 });
  });

  it('maps only the options the gateway lowers: time to seconds, effort to iterations', () => {
    expect(optionKind('time_budget_ms')).toBe('time');
    expect(optionKind('iterations')).toBe('effort');
    expect(optionKind('max_evaluations')).toBe('effort');
    expect(optionKind('population')).toBe('unmapped-by-plan');
  });

  it('previews OPTION_CLAMPED when a default exceeds the plan, and leaves shape options alone', () => {
    const facts = optionFacts(mode({
      time_budget_ms: { type: 'integer', default: 30000, unit: 'ms' },
      iterations: { type: 'integer', default: 100000 },
      max_evaluations: { type: 'integer', default: 50000 },
      population: { type: 'integer', default: 64 },
    }));
    const basic = facts.map((fact) => previewOption(fact, plan('BASIC')));
    expect(basic[0]).toMatchObject({ name: 'time_budget_ms', ceiling: '60,000 ms (60 s)', outcome: { kind: 'fits' } });
    expect(basic[1]).toMatchObject({ name: 'iterations', unit: 'iteration', ceiling: '10,000 iterations', outcome: { kind: 'clamped', applied: '10,000' } });
    expect(basic[2]).toMatchObject({ name: 'max_evaluations', unit: 'evaluation', outcome: { kind: 'clamped', applied: '10,000' } });
    expect(basic[3]).toMatchObject({ name: 'population', ceiling: 'Not reduced by plan', outcome: { kind: 'none', text: 'Applies as requested' } });

    const research = facts.map((fact) => previewOption(fact, plan('RESEARCH')));
    expect(research[1].outcome.kind).toBe('fits');
    expect(research[2].outcome.kind).toBe('fits');
  });

  it('says "Not mapped" when the document has no ceiling for a limit it should', () => {
    const [fact] = optionFacts(mode({ iterations: { type: 'integer', default: 5 } }));
    expect(previewOption(fact, { plan: 'X', maxTimeoutSeconds: 10, maxIterations: null }).ceiling).toBe('Not mapped');
    expect(previewOption(fact, null).ceiling).toBe('Not mapped');
  });

  it('reads the catalog the gateway serves: JSON, with an unlimited allowance as null', () => {
    const catalog = JSON.parse(JSON.stringify(retrievePricingFromYaml(source))) as Record<string, unknown>;
    expect(planCeilings(catalog).plans).toEqual(ceilings.plans);

    const unlimited = JSON.parse(JSON.stringify(catalog)) as { plans: Record<string, { usageLimits: Record<string, { value: number | null }> }> };
    unlimited.plans.PRO.usageLimits.maxIterations.value = null;
    // No ceiling to preview, rather than the document's default (10,000) for a plan that has none.
    expect(planCeilings(unlimited).plans.find((item) => item.plan === 'PRO')).toMatchObject({ maxTimeoutSeconds: 1800, maxIterations: null });
  });

  it('reads nothing from a document that is not a pricing', () => {
    expect(planCeilings(null)).toEqual({ version: null, plans: [] });
    expect(planCeilings({ plans: 'no' })).toEqual({ version: null, plans: [] });
  });
});
