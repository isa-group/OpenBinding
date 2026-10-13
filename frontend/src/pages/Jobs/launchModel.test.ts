import { describe, expect, it } from 'vitest';
import type { UsageView } from '../../api/auth';
import type { EngineCatalogEntry, EngineMode } from '../../api/client';
import type { CaseRevision } from '../../api/platform';
import { RANGE_REFUSAL } from '../../utils/featureRange';
import {
  acceptsIntervals, buildRequest, ceilingOf, criteriaCountOf, forecastOf, initialChoice, modeChoices, modeOfCatalog, optimizationFor, optionInputs, parseAmount,
  parseEngineParam, planCeilingsOf, planOptions, requestOptions, sourceChoices,
} from './launchModel';

const ENGINE = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: 'sha256-a' };
const REGISTRATION = { namespace: 'bim.builtin', name: 'random-search-deployment', version: '1', digest: 'sha256-r' };
const EDGE = { namespace: 'lucia-vega', name: 'edge-solver', version: '0.3.1', digest: 'sha256-e' };

const revision = (n: number, over: Partial<CaseRevision> = {}): CaseRevision => ({
  id: `rev-${n}`, binding_case_id: 'case-1', revision: n, digest: `sha256-${String(n).repeat(64)}`, document: {}, source_snapshot_id: `snap-${n}`, created_at: `2026-08-0${n}T00:00:00Z`, ...over,
});

const cases = [{ item: { id: 'case-1', project_id: 'p', slug: 'flujo', name: 'Flujo de checkout', description: '', created_by_id: 'u', created_at: '2026-08-01T00:00:00Z' }, revisions: [revision(1), revision(2)] }];

const usage = (over: Partial<UsageView> = {}): UsageView => ({
  plan: 'BASIC', contract_pending: false, features: {}, capabilities: { maxTimeoutSeconds: 60, maxIterations: 10_000, maxInstanceComplexityLog10: 9 }, ...over,
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

  describe('a package with ranges', () => {
    const withIntervals = (selector: 'all' | 'only' | 'none', values?: string[]): EngineCatalogEntry[] => [{
      ...ENGINE, id: 'engine-1', ref: ENGINE,
      modes: [{ ...mode('sampling', {}), capabilities: { featureValues: { selector, values } } as unknown as EngineMode['capabilities'] }],
    }];

    it('knows which mode declares interval values', () => {
      expect(acceptsIntervals(undefined)).toBeUndefined();
      expect(acceptsIntervals(catalog[0].modes[0])).toBe(false);
      expect(acceptsIntervals(withIntervals('all')[0].modes[0])).toBe(true);
      expect(acceptsIntervals(withIntervals('only', ['scalar', 'interval'])[0].modes[0])).toBe(true);
      expect(acceptsIntervals(withIntervals('only', ['scalar'])[0].modes[0])).toBe(false);
      expect(acceptsIntervals(withIntervals('none')[0].modes[0])).toBe(false);
    });

    it('turns the mode down with the reason when the gateway did and the manifest takes single values only', () => {
      const refused = [{ engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: false }];
      const modes = modeChoices(refused, withIntervals('only', ['scalar']), true);
      expect(modes[0]).toMatchObject({ compat: 'no', rangeRefusal: true, reason: RANGE_REFUSAL });
    });

    it('trusts the gateway’s code, and keeps a reason it gave about something else', () => {
      const code = [{ engine: ENGINE, registration: REGISTRATION, mode: 'sampling', compatible: false, diagnostics: [{ code: 'unsupported_capability_value', message: 'interval is not supported' }] }];
      expect(modeChoices(code, catalog)[0]).toMatchObject({ compat: 'no', rangeRefusal: true, reason: RANGE_REFUSAL });
      expect(modeChoices(compatible, catalog, true)[1]).toMatchObject({ compat: 'no', rangeRefusal: false, reason: 'It cannot read a RoutingOverlay.' });
    });

    it('never takes away a mode the gateway says can run it', () => {
      const modes = modeChoices(compatible, catalog, true);
      expect(modes[0]).toMatchObject({ engine: { name: 'random-search' }, compat: 'yes', rangeRefusal: false });
    });

    it('turns the catalog modes down itself when the gateway could not say, unless they declare interval', () => {
      expect(modeChoices(null, catalog, true)[0]).toMatchObject({ compat: 'no', rangeRefusal: true, reason: RANGE_REFUSAL });
      expect(modeChoices(null, withIntervals('all'), true)[0]).toMatchObject({ compat: 'unknown', rangeRefusal: false, reason: null });
    });

    it('changes nothing for a package without ranges', () => {
      expect(modeChoices(null, catalog, false)[0]).toMatchObject({ compat: 'unknown', rangeRefusal: false });
      expect(modeChoices(compatible, catalog)).toEqual(modeChoices(compatible, catalog, false));
    });

    it('does not offer a mode it turned down to be sent', () => {
      const [off] = modeChoices(null, catalog, true);
      expect(buildRequest({ snapshot: 'snap-1', settings: 'inline', configuration: null, mode: off, options: {} })).toBeNull();
    });
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
  const base = { snapshot: 'snap-2', settings: 'inline' as const, configuration: null, mode: yes, options: { iterations: 100 } };

  it('names the exact engine, deployment and mode', () => {
    expect(buildRequest(base)).toEqual({ snapshot: 'snap-2', engine: ENGINE, registration: REGISTRATION, mode: 'sampling', options: { iterations: 100 } });
  });

  it('leaves the deployment out when the catalog did not name one', () => {
    const [unchecked] = modeChoices(null, catalog);
    expect(buildRequest({ ...base, mode: unchecked })).toEqual({ snapshot: 'snap-2', engine: ENGINE, mode: 'sampling', options: { iterations: 100 } });
  });

  it('carries the optimization the gateway requires when one is known', () => {
    const optimization = { type: 'SINGLE' as const, scalarization: 'weighted-sum' };
    expect(buildRequest({ ...base, optimization })).toEqual({
      snapshot: 'snap-2', engine: ENGINE, registration: REGISTRATION, mode: 'sampling', options: { iterations: 100 }, optimization,
    });
    expect(buildRequest({ ...base, optimization: null })).not.toHaveProperty('optimization');
  });

  it('sends sealed settings alone: they carry their own engine, mode and options', () => {
    const configuration = { namespace: 'isa-demo', name: 'rs-60s', version: '1', versionDigest: 'sha256-v' };
    expect(buildRequest({ ...base, settings: 'saved', configuration, optimization: { type: 'SINGLE', scalarization: 'weighted-sum' } })).toEqual({ snapshot: 'snap-2', configuration });
    expect(buildRequest({ ...base, settings: 'saved' })).toBeNull();
  });

  it('does not build a request without a snapshot or with a mode that cannot run it', () => {
    expect(buildRequest({ ...base, snapshot: '' })).toBeNull();
    expect(buildRequest({ ...base, mode: null })).toBeNull();
    expect(buildRequest({ ...base, mode: { ...yes, compat: 'no' } })).toBeNull();
  });
});

describe('the optimization of a run', () => {
  const withScalarizations = (values: unknown[]): EngineMode => (
    { ...mode('sampling', {}), capabilities: { scalarizations: { selector: 'only', values } } as unknown as EngineMode['capabilities'] }
  );
  const weighted = { id: 'weighted-sum', objectiveTypes: ['SINGLE', 'MULTI'], weightPolicy: 'required' };
  const pareto = { id: 'pareto', objectiveTypes: ['MULTI', 'MANY'], weightPolicy: 'forbidden' };
  const feasibility = { id: 'feasibility', objectiveTypes: ['SINGLE'], weightPolicy: 'forbidden' };

  it('counts the criteria of the compiled problem, with or without the wrapper of the answer', () => {
    const document = { spec: { optimization: { criteria: [{ id: 'latency' }, { id: 'cost' }] } } };
    expect(criteriaCountOf(document)).toBe(2);
    expect(criteriaCountOf({ document })).toBe(2);
    expect(criteriaCountOf({ spec: {} })).toBe(0);
    expect(criteriaCountOf({ spec: { optimization: {} } })).toBe(0);
  });

  it('does not guess when the compiled form cannot be read', () => {
    expect(criteriaCountOf(null)).toBeNull();
    expect(criteriaCountOf('text')).toBeNull();
    expect(criteriaCountOf({})).toBeNull();
  });

  it('selects SINGLE for one criterion, MULTI for two or three and MANY beyond, with the first scalarization the mode declares for it', () => {
    const mode = withScalarizations([weighted, pareto]);
    expect(optimizationFor(mode, 1)).toEqual({ type: 'SINGLE', scalarization: 'weighted-sum' });
    expect(optimizationFor(mode, 2)).toEqual({ type: 'MULTI', scalarization: 'weighted-sum' });
    expect(optimizationFor(mode, 3)).toEqual({ type: 'MULTI', scalarization: 'weighted-sum' });
    expect(optimizationFor(mode, 4)).toEqual({ type: 'MANY', scalarization: 'pareto' });
  });

  it('asks for feasibility alone when the problem has no criterion', () => {
    expect(optimizationFor(withScalarizations([weighted, feasibility]), 0)).toEqual({ type: 'SINGLE', scalarization: 'feasibility' });
    expect(optimizationFor(withScalarizations([weighted]), 0)).toBeNull();
  });

  it('selects nothing when the mode declares no scalarization that fits, or nothing is known', () => {
    expect(optimizationFor(withScalarizations([pareto]), 1)).toBeNull();
    expect(optimizationFor(mode('sampling', {}), 1)).toBeNull();
    expect(optimizationFor(undefined, 1)).toBeNull();
    expect(optimizationFor(withScalarizations([weighted]), null)).toBeNull();
  });
});

describe('forecast', () => {
  it('measures the problem against the plan and adds nothing to a counter', () => {
    const bars = forecastOf({ ceilings: { seconds: 900, iterations: null, complexity: 20 }, bindingSpace: '1000', plan: 'RESEARCH' });
    expect(bars.map((bar) => bar.text)).toEqual(['≈ 10^3 of up to 10^20 on your RESEARCH plan']);
    expect(bars.every((bar) => bar.add === 0)).toBe(true);
  });

  it('does not invent a size that is not known', () => {
    const bars = forecastOf({ ceilings: { seconds: null, iterations: null, complexity: null }, bindingSpace: null, plan: undefined });
    expect(bars.map((bar) => bar.text)).toEqual(['The size of this problem isn’t known yet']);
  });
});
