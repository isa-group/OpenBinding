import { describe, expect, it } from 'vitest';
import type { UsageView } from '../../api/auth';
import type { EngineCatalogEntry, EngineMode } from '../../api/client';
import type { CaseRevision } from '../../api/platform';
import {
  DEFAULT_POLICY, buildRequest, ceilingOf, forecastOf, initialChoice, modeChoices, modeOfCatalog, optionInputs, parseAmount, parseEngineParam, planCeilingsOf,
  planOptions, requestOptions, sourceChoices,
} from './launchModel';

const ENGINE = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-a' };
const REGISTRATION = { namespace: 'bim.builtin', name: 'random-search-deployment', version: '1', digest: 'sha256-r' };
const EDGE = { namespace: 'lucia-vega', name: 'edge-solver', version: '0.3.1', digest: 'sha256-e' };

const revision = (n: number, over: Partial<CaseRevision> = {}): CaseRevision => ({
  id: `rev-${n}`, binding_case_id: 'case-1', revision: n, digest: `sha256-${String(n).repeat(64)}`, document: {}, source_snapshot_id: `snap-${n}`, created_at: `2026-08-0${n}T00:00:00Z`, ...over,
});

const cases = [{ item: { id: 'case-1', project_id: 'p', slug: 'flujo', name: 'Flujo de checkout', description: '', created_by_id: 'u', created_at: '2026-08-01T00:00:00Z' }, revisions: [revision(1), revision(2)] }];

const usage = (over: Partial<UsageView> = {}): UsageView => ({
  plan: 'BASIC', contract_pending: false, features: {}, capabilities: { maxTimeoutSeconds: 60, maxIterations: 10_000, maxInstanceComplexityLog10: 9 }, limits: {}, ...over,
});

const mode = (id: string, properties: Record<string, Record<string, unknown>>): EngineMode => ({
  id, profile: 'qos-binding/v1', ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' }, algorithm: 'sampling',
  capabilities: {} as EngineMode['capabilities'], optionsSchema: { type: 'object', properties, additionalProperties: false },
  limits: {}, guarantees: { termination: ['FEASIBLE'], exact: false },
});

const catalog: EngineCatalogEntry[] = [{
  ...ENGINE, id: 'engine-1', ref: ENGINE,
  modes: [mode('sampling', { time_budget_ms: { type: 'integer', default: 30000 }, iterations: { type: 'integer', default: 100000 }, label: { type: 'string' } })],
}];

describe('what to solve', () => {
  it('offers the snapshot or revision the person came from first, then the latest revisions', () => {
    const choices = sourceChoices({ cases, caseSlug: null, revision: null, snapshot: 'snap-9' });
    expect(choices.map((choice) => choice.id)).toEqual(['snapshot:snap-9', 'revision:rev-2']);
    expect(choices[1]).toMatchObject({ label: 'Flujo de checkout · revision 2', latest: true, snapshotId: 'snap-2' });
    expect(choices[1].detail).toMatch(/^Latest · Sealed Aug 2, 2026 · sha256-2222…2222$/);
  });

  it('lists every revision of the case named by the address', () => {
    const choices = sourceChoices({ cases, caseSlug: 'flujo', revision: '1', snapshot: null });
    expect(choices.map((choice) => choice.label)).toEqual(['Flujo de checkout · revision 2', 'Flujo de checkout · revision 1']);
    expect(initialChoice(choices, '1', null)).toBe('revision:rev-1');
    expect(initialChoice(choices, null, null)).toBe('revision:rev-2');
    expect(initialChoice([], null, null)).toBe('');
  });

  it('keeps the revision asked for even when it is not the latest and no case is named', () => {
    const choices = sourceChoices({ cases, caseSlug: null, revision: '1', snapshot: null });
    expect(choices.map((choice) => choice.id)).toEqual(['revision:rev-1', 'revision:rev-2']);
  });
});

describe('engines', () => {
  const compatible = [
    { engine: EDGE, registration: { ...REGISTRATION, namespace: 'lucia-vega', name: 'edge-eu' }, mode: 'placement', compatible: false, diagnostics: [{ message: 'It cannot read a RoutingOverlay.' }] },
    { engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true },
    { nonsense: true },
  ];

  it('puts the modes that can run the problem first and says why the others cannot', () => {
    const modes = modeChoices(compatible, catalog);
    expect(modes.map((item) => [item.engine.name, item.compat, item.federated])).toEqual([['random-search', 'yes', false], ['edge-solver', 'no', true]]);
    expect(modes[1].reason).toBe('It cannot read a RoutingOverlay.');
  });

  it('falls back to the catalog, unchecked, when the gateway could not analyse the snapshot', () => {
    const modes = modeChoices(null, catalog);
    expect(modes).toHaveLength(1);
    expect(modes[0]).toMatchObject({ compat: 'unknown', registration: null, mode: 'sampling' });
  });

  it('reads the engine the address names', () => {
    expect(parseEngineParam('bim.builtin/random-search@1.0.0#sha256-a')).toEqual(ENGINE);
    expect(parseEngineParam('nonsense')).toBeNull();
    expect(parseEngineParam(null)).toBeNull();
  });

  it('finds the mode in the catalog by the engine it belongs to', () => {
    const [yes] = modeChoices(compatible, catalog);
    expect(modeOfCatalog(catalog, yes)?.id).toBe('sampling');
    expect(modeOfCatalog(catalog, null)).toBeUndefined();
  });
});

describe('settings against the plan', () => {
  it('prefers what the account reports, then the pricing document', () => {
    expect(ceilingOf(usage(), null, 'BASIC', 'maxTimeoutSeconds')).toBe(60);
    expect(ceilingOf(null, { plans: { BASIC: { usageLimits: { maxTimeoutSeconds: { value: 45 } } } } }, 'BASIC', 'maxTimeoutSeconds')).toBe(45);
    expect(ceilingOf(null, null, 'BASIC', 'maxTimeoutSeconds')).toBeNull();
    expect(planCeilingsOf(usage(), null, 'BASIC')).toEqual({ seconds: 60, iterations: 10_000, complexity: 9 });
  });

  it('asks for the numbers a mode declares, with seconds for time', () => {
    const inputs = optionInputs(modeOfCatalog(catalog, modeChoices(null, catalog)[0]), planCeilingsOf(usage(), null, 'BASIC'));
    expect(inputs.map((input) => [input.name, input.unit, input.default, input.ceiling])).toEqual([
      ['time_budget_ms', 's', 30, 60],
      ['iterations', 'iterations', 100000, 10_000],
    ]);
  });

  it('reduces what is above the ceiling and says so, without calling it an error', () => {
    const inputs = optionInputs(modeOfCatalog(catalog, modeChoices(null, catalog)[0]), planCeilingsOf(usage(), null, 'BASIC'));
    const plans = planOptions(inputs, { time_budget_ms: '600', iterations: '5,000' });
    expect(plans.map((plan) => [plan.asked, plan.effective, plan.reduced, plan.invalid])).toEqual([[600, 60, true, false], [5000, 5000, false, false]]);
    // The request carries what was asked, in milliseconds; the gateway reduces it and records that.
    expect(requestOptions(plans)).toEqual({ time_budget_ms: 600000, iterations: 5000 });
  });

  it('marks a field that is not a positive number, and leaves an empty one to the engine', () => {
    const inputs = optionInputs(modeOfCatalog(catalog, modeChoices(null, catalog)[0]), planCeilingsOf(usage(), null, 'BASIC'));
    const plans = planOptions(inputs, { time_budget_ms: 'soon', iterations: '' });
    expect(plans.map((plan) => [plan.invalid, plan.asked])).toEqual([[true, null], [false, null]]);
    expect(requestOptions(plans)).toEqual({});
    expect(parseAmount('0')).toBe('invalid');
    expect(parseAmount(' 1,200 ')).toBe(1200);
    expect(parseAmount('')).toBeNull();
  });
});

describe('the request', () => {
  const [yes] = modeChoices([{ engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: true }], catalog);
  const base = { snapshot: 'snap-2', settings: 'inline' as const, configuration: null, auto: false, policy: DEFAULT_POLICY, mode: yes, options: { iterations: 100 } };

  it('names the exact engine, deployment and mode', () => {
    expect(buildRequest(base)).toEqual({ snapshot: 'snap-2', engine: ENGINE, registration: REGISTRATION, mode: 'sampling', options: { iterations: 100 } });
  });

  it('leaves the deployment out when the catalog did not name one', () => {
    const [unchecked] = modeChoices(null, catalog);
    expect(buildRequest({ ...base, mode: unchecked })).toEqual({ snapshot: 'snap-2', engine: ENGINE, mode: 'sampling', options: { iterations: 100 } });
  });

  it('sends the AutoRouter policy under routing', () => {
    expect(buildRequest({ ...base, auto: true, mode: null, policy: { ...DEFAULT_POLICY, profile: 'cost_first', requireExact: true } })).toEqual({
      snapshot: 'snap-2', engine: 'auto',
      options: {
        iterations: 100,
        routing: {
          strategy: 'auto', profile: 'cost_first',
          hardConstraints: { maxCredits: 40, minQuality: 0.85, maxFailureRisk: 0.3, requireExact: true },
          adaptation: { allowFallback: true },
        },
      },
    });
  });

  it('sends sealed settings alone: they carry their own engine, mode and options', () => {
    const configuration = { namespace: 'isa-demo', name: 'rs-60s', version: '1', versionDigest: 'sha256-v' };
    expect(buildRequest({ ...base, settings: 'saved', configuration })).toEqual({ snapshot: 'snap-2', configuration });
    expect(buildRequest({ ...base, settings: 'saved' })).toBeNull();
  });

  it('does not build a request without a snapshot or with a mode that cannot run it', () => {
    expect(buildRequest({ ...base, snapshot: '' })).toBeNull();
    expect(buildRequest({ ...base, mode: null })).toBeNull();
    expect(buildRequest({ ...base, mode: { ...yes, compat: 'no' } })).toBeNull();
  });
});

describe('forecast', () => {
  it('adds this run to the month and measures the problem against the plan', () => {
    const bars = forecastOf({
      usage: usage({ plan: 'RESEARCH', limits: { taskStarts: { limit_id: 'taskStarts', limit: 50, used: 18, remaining: 32 }, solverSeconds: { limit_id: 'solverSeconds', limit: 30_000, used: 7_420, remaining: 22_580 }, concurrentJobs: { limit_id: 'concurrentJobs', limit: 3, used: 1, remaining: 2 } } }),
      ceilings: { seconds: 900, iterations: null, complexity: 20 }, seconds: 600, bindingSpace: '1000', plan: 'RESEARCH',
    });
    expect(bars.map((bar) => bar.text)).toEqual([
      '18 used + up to 1 = 19 of 50',
      '7,420 used + up to 600 = 8,020 of 30,000 s',
      '1 used + up to 1 = 2 of 3',
      '≈ 10^3 of up to 10^20 on your RESEARCH plan',
    ]);
  });

  it('does not invent usage that could not be read', () => {
    const bars = forecastOf({ usage: null, ceilings: { seconds: null, iterations: null, complexity: null }, seconds: 0, bindingSpace: null, plan: undefined });
    expect(bars[0].text).toBe('No limit on your plan');
    expect(bars[3].text).toBe('The size of this problem isn’t known yet');
  });
});
