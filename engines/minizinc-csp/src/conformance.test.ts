import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { DznBuilder } from './dzn_builder';
import { buildServer } from './index';
import { MiniZincRunner, MiniZincRunResult } from './minizinc_runner';
import { Solver } from './solver';

function metric(scope = 'invocation') {
  return {
    type: 'number', unit: '1', domain: { kind: 'real' }, direction: 'minimize', scope,
    neutral: 0,
    aggregation: {
      sequence: 'sum', parallel: 'sum', exclusive: 'weightedSum',
      repeat: 'scale', selection: 'sum',
    },
  };
}

function ref(resource: string, id: string) { return { resource, id }; }

function candidate(resource: string, cost: number, latency: number) {
  return {
    ref: ref(resource, 'same-id'), provider: ref(resource, 'provider'),
    provides: [{ type: 'compute', properties: {} }], properties: {},
    features: { price: cost, response: latency },
    metrics: { price: cost, response: latency },
  };
}

function catalog(resource: string, cost: number, latency: number) {
  return {
    providers: { provider: { properties: {} } },
    featureBindings: { price: ref('app', 'cost'), response: ref('app', 'latency') },
    metricBindings: { price: ref('app', 'cost'), response: ref('app', 'latency') },
    candidates: { 'same-id': candidate(resource, cost, latency) },
  };
}

function problem(): any {
  const appFeatures = { cost: metric(), latency: metric() };
  const reqFeatures = ['cost', 'latency'];
  const taskReqFeatures = {};
  return {
    apiVersion: 'bim/v1', kind: 'BindingProblem', metadata: { name: 'mini' },
    spec: {
      profile: {
        namespace: 'bim.builtin', id: 'qos-binding/v1', version: '1.0.0',
        output: { apiVersion: 'bim/v1', kind: 'BindingProblem', schemaDigest: digest('schema') },
        deterministic: true, digest: digest('profile'),
        adapter: { id: 'qos-binding-profile', version: '1.0.0', digest: digest('adapter') },
      },
      dialects: [{
        namespace: 'bim.builtin', id: 'qos-binding/v1', version: '1.0.0',
        digest: digest('dialect'), irFeatures: [],
        adapter: { id: 'bim-core', version: '1.0.0', digest: digest('dialect-adapter') },
      }],
      instance: {
        digest: digest('instance'),
        resources: {
          app: identity('application', 'Application', 'application.json'),
          'catalog-a': identity('candidates', 'CandidateCatalog', 'catalog-a.json'),
          'catalog-b': identity('candidates', 'CandidateCatalog', 'catalog-b.json'),
          optimization: identity('optimization', 'Optimization', 'optimization.json'),
        },
      },
      application: {
        resource: 'app',
        tasks: { t: { kind: 'service', requires: { type: 'compute' } } },
        features: appFeatures,
        metrics: appFeatures,
        requiredFeatures: reqFeatures,
        requiredMetrics: reqFeatures,
        taskRequiredFeatures: taskReqFeatures,
        taskRequiredMetrics: taskReqFeatures,
        workflow: { kind: 'task', task: ref('app', 't') },
      },
      candidates: {
        'catalog-a': catalog('catalog-a', 1, 10),
        'catalog-b': catalog('catalog-b', 9, 1),
      },
      eligibility: { t: [ref('catalog-a', 'same-id'), ref('catalog-b', 'same-id')] },
      routing: [], constraints: [], placement: [],
      optimization: {
        resource: 'optimization', type: 'SINGLE',
        criteria: [{ id: 'cost-criterion', feature: ref('app', 'cost'), direction: 'minimize' }],
        penalties: [],
      },
      extensions: {}, sourceMap: {},
    },
  };
}

function execution(): any {
  return { type: 'SINGLE', scalarization: 'weighted-sum', weights: [{ criteria: 'cost-criterion', value: 1 }] };
}

function build(value: any, _options: any = {}): any {
  return new DznBuilder().build(value, {}, execution());
}

function envelope(value: any = problem(), options: any = {}) {
  return { apiVersion: 'bim/v1', kind: 'BindingProblemRequest', protocol: 'bim-engine/v1',
    problem: value, options, optimization: execution() };
}

function digest(seed: string): string {
  return `sha256-${seed.charCodeAt(0).toString(16).repeat(64).slice(0, 64)}`;
}

function identity(role: string, kind: string, path: string): any {
  return { role, apiVersion: 'qos-binding/v1', kind, path, digest: digest(path) };
}

function placedProblem(): any {
  const value = problem();
  value.spec.dialects.push({
    namespace: 'bim.builtin', id: 'qos-binding-placement/v1', version: '1.0.0',
    digest: digest('placement'),
    irFeatures: [
      { dimension: 'placement', value: 'placement' },
      { dimension: 'irExtensions', value: 'qos-binding-placement/v1' },
    ],
    adapter: { id: 'placement-dialect', version: '1.0.0', digest: digest('placement-adapter') },
  });
  value.spec.placement = [{
    resource: 'placement',
    pools: {
      edge: { ref: ref('placement', 'edge'), kind: 'edge', capacity: { memory: 1 }, properties: {} },
      cloud: { ref: ref('placement', 'cloud'), kind: 'cloud', capacity: { memory: 1 }, properties: {} },
    },
    demands: [
      { candidate: ref('catalog-a', 'same-id'), pool: ref('placement', 'edge'), resources: { memory: 1 } },
      { candidate: ref('catalog-b', 'same-id'), pool: ref('placement', 'cloud'), resources: { memory: 1 } },
    ],
    network: [
      { from: ref('placement', 'edge'), to: ref('placement', 'edge'), latency: 0 },
      { from: ref('placement', 'edge'), to: ref('placement', 'cloud'), latency: 10 },
      { from: ref('placement', 'cloud'), to: ref('placement', 'edge'), latency: 10 },
      { from: ref('placement', 'cloud'), to: ref('placement', 'cloud'), latency: 0 },
    ],
    events: {
      ingress: {
        ref: ref('placement', 'ingress'), pool: ref('placement', 'edge'),
        latency: [
          { pool: ref('placement', 'edge'), latency: 0 },
          { pool: ref('placement', 'cloud'), latency: 10 },
        ],
      },
    },
    transitions: [{
      ref: ref('placement', 'ingress-to-t'), from: ref('placement', 'ingress'), to: ref('app', 't'),
      feature: ref('app', 'latency'), metric: ref('app', 'latency'), maximum: 5, enforcement: 'hard',
    }],
    globalLatency: {
      feature: ref('app', 'latency'), metric: ref('app', 'latency'), includeExecution: true, exclusive: 'routing', parallel: 'max',
    },
    capacityRules: [{ ref: ref('placement', 'capacityRules/0'), resources: ['memory'], scope: 'selectedCandidate' }],
  }];
  return value;
}


/** Three tasks, each with a cheap candidate in pool A and a dear one in pool B; A holds two units. */
function capacityProblem(constantDemand = true): any {
  const value = problem();
  value.spec.dialects.push({
    namespace: 'bim.builtin', id: 'qos-binding-placement/v1', version: '1.0.0',
    digest: digest('placement'),
    irFeatures: [{ dimension: 'placement', value: 'placement' }, { dimension: 'irExtensions', value: 'qos-binding-placement/v1' }],
    adapter: { id: 'placement-dialect', version: '1.0.0', digest: digest('placement-adapter') },
  });
  value.spec.application.tasks = {
    t1: { kind: 'service', requires: { type: 'compute' } },
    t2: { kind: 'service', requires: { type: 'compute' } },
    t3: { kind: 'service', requires: { type: 'compute' } },
  };
  value.spec.application.workflow = { kind: 'sequence', steps: ['t1', 't2', 't3'].map((task) => ({ kind: 'task', task: ref('app', task) })) };
  const candidates: Record<string, any> = {};
  const demands: any[] = [];
  const eligibility: Record<string, any[]> = {};
  for (const task of ['t1', 't2', 't3']) {
    eligibility[task] = [];
    for (const [pool, cost] of [['a', 1], ['b', 5]] as const) {
      const id = `${task}-${pool}`;
      candidates[id] = { ...candidate('catalog-a', cost, 1), ref: ref('catalog-a', id) };
      demands.push({ candidate: ref('catalog-a', id), pool: ref('placement', pool),
        resources: { units: constantDemand || pool === 'a' ? 1 : 0.5 } });
      eligibility[task].push(ref('catalog-a', id));
    }
  }
  value.spec.candidates = { 'catalog-a': { ...catalog('catalog-a', 0, 0), candidates } };
  value.spec.instance.resources = {
    app: identity('application', 'Application', 'application.json'),
    'catalog-a': identity('candidates', 'CandidateCatalog', 'catalog-a.json'),
    optimization: identity('optimization', 'Optimization', 'optimization.json'),
  };
  value.spec.eligibility = eligibility;
  value.spec.placement = [{
    resource: 'placement',
    pools: {
      a: { ref: ref('placement', 'a'), kind: 'edge', capacity: { units: 2 }, properties: {} },
      b: { ref: ref('placement', 'b'), kind: 'cloud', capacity: { units: 10 }, properties: {} },
    },
    demands, network: [], events: {}, transitions: [],
    capacityRules: [{ ref: ref('placement', 'capacityRules/0'), resources: ['units'], scope: 'selectedCandidate' }],
  }];
  return value;
}

function parameter(content: string, name: string): string {
  const match = content.match(new RegExp(`\\b${name}\\s*=\\s*([^;]*);`));
  assert.ok(match, `missing DZN parameter ${name}`);
  return match[1].trim();
}

describe('canonical BIM v1 lowering', () => {
  it('preserves catalog-qualified candidate identity', () => {
    const built = build(problem(), {});
    assert.deepEqual(built.candidates, [ref('catalog-a', 'same-id'), ref('catalog-b', 'same-id')]);
    assert.equal(parameter(built.dznContent, 'task_candidates'), '[| 1, 2 |]');
  });

  it('materializes changed objectives and hard constraints', () => {
    const objective = problem();
    objective.spec.optimization.criteria[0].feature = ref('app', 'latency');
    assert.equal(parameter(build(objective, {}).dznContent, 'term_metric'), '[2]');
    objective.spec.optimization.criteria[0].normalize = { min: 0, max: 5, clamp: false };
    assert.equal(parameter(build(objective, {}).dznContent, 'term_clamp'), '[false]');
    delete objective.spec.optimization.criteria[0].normalize.clamp;
    assert.throws(() => build(objective, {}), /normalization bounds are invalid/);

    const constrained = problem();
    constrained.spec.constraints.push({
      ref: ref('constraints', 'fast'), when: { kind: 'literal', value: true },
      assert: {
        kind: 'compare', op: 'lte', left: { kind: 'path', segments: ['metrics', 'latency'] },
        right: { kind: 'literal', value: 5 },
      },
      enforcement: 'hard',
    });
    const dzn = build(constrained, {}).dznContent;
    assert.equal(parameter(dzn, 'constraint_enforcement'), '[1]');
    assert.equal(parameter(dzn, 'atom_constraint'), '[1]');
    assert.equal(parameter(dzn, 'atom_left_kind'), '[1]');
    assert.equal(parameter(dzn, 'atom_left_index'), '[2]');
    assert.equal(parameter(dzn, 'atom_right_kind'), '[3]');
    // `latency <= 5` is posted as `latency <= 5 + slack` (numeric.ts): the solver reasons
    // about a relaxation, the exact evaluation of the returned decision is the arbiter.
    assert.equal(parameter(dzn, 'atom_right_value'), '[5.000000005]');
    assert.equal(build(constrained, {}).encoding.relaxedLiterals, 1);
  });

  it('moves comparison literals by the numeric slack only towards feasibility, and only for non-strict comparisons', () => {
    const lowered = (op: string, literalSide: 'left' | 'right', value: number): string => {
      const value_ = problem();
      const feature = { kind: 'path', segments: ['metrics', 'latency'] };
      const literal = { kind: 'literal', value };
      value_.spec.constraints.push({
        ref: ref('constraints', 'c'), when: { kind: 'literal', value: true },
        assert: { kind: 'compare', op, left: literalSide === 'left' ? literal : feature, right: literalSide === 'left' ? feature : literal },
        enforcement: 'hard',
      });
      const dzn = build(value_, {}).dznContent;
      return parameter(dzn, literalSide === 'left' ? 'atom_left_value' : 'atom_right_value');
    };
    assert.equal(lowered('lte', 'right', 5), '[5.000000005]'); // latency <= 5: raised
    assert.equal(lowered('gte', 'right', 5), '[4.999999995]'); // latency >= 5: lowered
    assert.equal(lowered('lte', 'left', 5), '[4.999999995]'); // 5 <= latency: lowered
    assert.equal(lowered('gte', 'left', 5), '[5.000000005]'); // 5 >= latency: raised
    assert.equal(lowered('lte', 'right', 0.25), '[0.250000001]'); // absolute floor below magnitude 1
    assert.equal(lowered('lt', 'right', 5), '[5.0]'); // strict comparisons keep their literal
    assert.equal(lowered('eq', 'right', 5), '[5.0]');
    assert.equal(lowered('ne', 'right', 5), '[5.0]');
    assert.equal(lowered('lte', 'right', 161.51470755605504), '[161.51470771756976]');
  });

  it('bounds every intermediate node even when an outer repeat executes zero times', () => {
    const value = problem();
    value.spec.application.workflow = {
      kind: 'repeat', count: 0,
      body: { kind: 'task', task: ref('app', 't') },
    };
    const built = build(value, {});
    assert.equal(parameter(built.dznContent, 'node_metric_bound'), '10.00000001');
  });

  it('prints every technical bound widened by the numeric slack', () => {
    // Regression for the first QACOBench campaign: `metric_bound` was printed tight
    // (161.51470755605504), left the flattener as `float_le(x, 161.514707556055)` and
    // excluded the binding whose latency attains the bound exactly (two false optima).
    const value = problem();
    value.spec.candidates['catalog-a'].candidates['same-id'].features.response = 161.51470755605504;
    value.spec.candidates['catalog-a'].candidates['same-id'].metrics.response = 161.51470755605504;
    const dzn = build(value, {}).dznContent;
    // cost: max(1, 9) = 9 -> 9.000000009; latency: 161.51470755605504 -> widened above it.
    assert.equal(parameter(dzn, 'metric_bound'), '[9.000000009, 161.51470771756976]');
    assert.equal(parameter(dzn, 'node_metric_bound'), '161.51470771756976');
    assert.equal(parameter(dzn, 'term_bound'), '[9.000000009]');
    assert.ok(Number(parameter(dzn, 'objective_bound')) > 9 + 1);
    assert.ok(Number(parameter(dzn, 'log_metric_bound')) > 1);
    assert.ok(Number(parameter(dzn, 'placement_time_bound')) > 1);
    assert.ok(Number(parameter(dzn, 'placement_penalty_bound')) > 1);
  });

  it('accepts a weighted all-local problem and an empty binding domain', () => {
    const value = problem();
    value.spec.application.tasks = { local: { kind: 'local' } };
    value.spec.application.workflow = { kind: 'task', task: ref('app', 'local') };
    value.spec.eligibility = {};
    const built = build(value, {});
    assert.deepEqual(built.tasks, []);
    assert.equal(parameter(built.dznContent, 'n_tasks'), '0');
    assert.equal(parameter(built.dznContent, 'max_candidates_per_task'), '1');
  });

  it('keeps empty Placement vacuous and lowers a complete placement model', () => {
    const empty = build(problem(), {}).dznContent;
    assert.equal(parameter(empty, 'n_pool_slots'), '1');
    assert.equal(parameter(empty, 'n_capacity_checks'), '0');
    assert.equal(parameter(empty, 'n_transitions'), '0');
    assert.equal(parameter(empty, 'n_activities'), '0');

    const placed = build(placedProblem(), {}).dznContent;
    assert.equal(parameter(placed, 'n_pool_slots'), '3');
    assert.equal(parameter(placed, 'candidate_model'), '[1, 1]');
    assert.equal(parameter(placed, 'candidate_pool'), '[2, 3]');
    assert.equal(parameter(placed, 'n_capacity_checks'), '2');
    assert.equal(parameter(placed, 'n_transitions'), '1');
    assert.equal(parameter(placed, 'transition_hard'), '[true]');
    assert.equal(parameter(placed, 'global_metric_model'), '[0, 1]');
    assert.equal(parameter(placed, 'n_scenarios'), '1');
    assert.equal(parameter(placed, 'n_activities'), '1');
    // Both candidates of the task demand one unit: the two capacity checks become one
    // native bin-packing column over the task pool variable (dummy pool unconstrained).
    assert.equal(parameter(placed, 'n_bin_columns'), '1');
    assert.equal(parameter(placed, 'bin_weight'), '[| 1 |]');
    assert.equal(parameter(placed, 'bin_capacity'), '[| 1, 1, 1 |]');
    assert.equal(parameter(placed, 'capacity_in_bin'), '[true, true]');
  });

  it('falls back to reified capacity sums when a task\'s demand depends on the candidate', () => {
    const value = placedProblem();
    value.spec.placement[0].demands[1].resources.memory = 0.5;
    const built = build(value, {});
    assert.equal(parameter(built.dznContent, 'n_bin_columns'), '0');
    assert.equal(parameter(built.dznContent, 'capacity_in_bin'), '[false, false]');
    assert.equal(built.encoding.binPackingChecks, 0);
    assert.equal(built.encoding.capacityChecks, 2);
  });

  it('rejects every construct outside the declared exact-weighted mode', () => {
    const source = { apiVersion: 'bim/v1', kind: 'Instance', metadata: {}, spec: {} };
    assert.throws(() => build(source, {}), /only a canonical bim\/v1 BindingProblem/);

    const expected = problem();
    expected.spec.application.workflow = {
      kind: 'repeat', expectedCount: 1.5,
      body: { kind: 'task', task: ref('app', 't') },
    };
    assert.equal(parameter(build(expected, {}).dznContent, 'node_repeat_count'), '[1.5, 0.0]');

    const conditional = problem();
    conditional.spec.constraints.push({
      ref: ref('constraints', 'conditional'), when: { kind: 'literal', value: false },
      assert: { kind: 'literal', value: false }, enforcement: 'hard',
    });
    assert.throws(() => build(conditional, {}), /conditional constraint/);

    const dynamicSoft = problem();
    dynamicSoft.spec.constraints.push({
      ref: ref('constraints', 'soft'), when: { kind: 'literal', value: true },
      assert: { kind: 'literal', value: false }, enforcement: 'soft',
      penalty: { kind: 'path', segments: ['features', 'cost'] },
    });
    assert.throws(() => build(dynamicSoft, {}), /constant non-negative soft penalties/);

    const selected = problem();
    selected.spec.application.metrics.cost.scope = 'selectedCandidate';
    assert.equal(parameter(build(selected, {}).dznContent, 'metric_scope'), '[2, 1]');

    const multi = execution();
    multi.type = 'MULTI';
    assert.throws(() => new DznBuilder().build(problem(), {}, multi), /objective type SINGLE only/);

    assert.throws(() => new Solver().validate(problem(), { solver: 'chuffed' }, execution()), /must be gecode/);

    const implicitRouting = problem();
    implicitRouting.spec.routing = { branch: 1 };
    assert.throws(() => build(implicitRouting, {}), /canonical array/);

    const nonCanonicalWeights = execution();
    nonCanonicalWeights.weights[0].value = 2;
    assert.throws(() => new DznBuilder().build(problem(), {}, nonCanonicalWeights), /normalized to 1/);
  });

  it('lowers full routing refs and metric neutrals', () => {
    const value = problem();
    value.spec.application.tasks.local = { kind: 'local' };
    value.spec.application.metrics.latency.neutral = 1;
    value.spec.application.workflow = {
      kind: 'exclusive', branches: [
        { id: 'local', flow: { kind: 'task', task: ref('app', 'local') } },
        { id: 'service', flow: { kind: 'task', task: ref('app', 't') } },
      ],
    };
    value.spec.routing = [
      { target: ref('app', 'local'), probability: 0.5 },
      { target: ref('app', 'service'), probability: 0.5 },
    ];
    const dzn = build(value, {}).dznContent;
    assert.equal(parameter(dzn, 'metric_neutral'), '[0.0, 1.0]');
    assert.match(parameter(dzn, 'node_weights'), /0\.5/);

    value.spec.routing[0].target.resource = 'overlay';
    value.spec.routing[1].target.resource = 'overlay';
    assert.throws(() => build(value, {}), /Missing routing probability/);
  });
});

describe('BIM Engine Protocol v1', () => {
  it('rejects source envelopes and missing protocol before queueing', async () => {
    const fake = {
      validate: (value: any, options: any) => build(value, options),
      solve: async () => ({ termination: 'UNKNOWN', solutions: [] }),
    };
    const app = buildServer(fake);
    const missing = await app.inject({ method: 'POST', url: '/internal/v1/binding-problems', payload: { ...envelope(), protocol: undefined } });
    assert.equal(missing.statusCode, 422);
    const source = await app.inject({ method: 'POST', url: '/internal/v1/binding-problems', payload: envelope({ apiVersion: 'bim/v1', kind: 'Instance', metadata: {}, spec: {} }) });
    assert.equal(source.statusCode, 422);
    const accepted = await app.inject({ method: 'POST', url: '/internal/v1/binding-problems', payload: envelope() });
    assert.equal(accepted.statusCode, 202);
    assert.equal(typeof accepted.json().id, 'string');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const job = await app.inject({ method: 'GET', url: `/internal/v1/jobs/${accepted.json().id}` });
    assert.equal(job.statusCode, 200);
    assert.equal(job.json().status, 'completed');
    assert.equal(job.json().result.termination, 'UNKNOWN');
    await app.close();
  });

  it('maps MiniZinc selection indices back to full refs and canonical result', async () => {
    class FakeRunner extends MiniZincRunner {
      extraArgs: string[] = [];
      override async run(_solver: string, _model: string, _dzn: string, _tmp: string, extra: string[]): Promise<MiniZincRunResult> {
        this.extraArgs = extra;
        return {
          code: 0, stderr: '', durationMs: 4, stdoutEvents: [],
          stdout: '{"selected_cand":[2],"objective_value":9}\n----------\n==========\n',
        };
      }
    }
    const runner = new FakeRunner();
    const result = await new Solver(runner).solve(problem(), { time_budget_ms: 1234 }, execution());
    assert.equal(result.termination, 'OPTIMAL');
    assert.deepEqual(Object.keys(result.solutions[0]).sort(),
      ['decision', 'features', 'objectives', 'penalties', 'violations']);
    assert.deepEqual(result.solutions[0].decision.binding.t, ref('catalog-b', 'same-id'));
    assert.equal(result.solutions[0].features.cost, 9);
    assert.equal(result.solutions[0].objectives.score, 9);
    assert.deepEqual(runner.extraArgs.slice(0, 2), ['--time-limit', '1234']);
  });

  it('reports the Gecode statistics in the provenance without changing the termination', async () => {
    class StatsRunner extends MiniZincRunner {
      constructor(private readonly statistics?: MiniZincRunResult['gecodeStatistics']) { super(); }
      override async run(): Promise<MiniZincRunResult> {
        return {
          code: 0, stderr: '', durationMs: 4, stdoutEvents: [], gecodeStatistics: this.statistics,
          stdout: '{"selected_cand":[2],"objective_value":9}\n----------\n==========\n',
        };
      }
    }
    const statistics = { values: { nodes: 12, failures: 3, peak_depth: 4 }, raw: ['%%  nodes:         12'] };
    const withStats = await new Solver(new StatsRunner(statistics)).solve(problem(), {}, execution());
    assert.equal(withStats.termination, 'OPTIMAL');
    assert.deepEqual(withStats.provenance.gecode_statistics, statistics.values);
    assert.deepEqual(withStats.provenance.gecode_statistics_raw, statistics.raw);
    const without = await new Solver(new StatsRunner()).solve(problem(), {}, execution());
    assert.equal(without.termination, 'OPTIMAL');
    assert.equal(without.provenance.gecode_statistics, null);
    assert.deepEqual(without.solutions, withStats.solutions);
  });

  it('post-checks Placement metrics and rejects a hard placement violation', async () => {
    class PlacementRunner extends MiniZincRunner {
      constructor(private readonly selection: number, private readonly objective: number) { super(); }
      override async run(): Promise<MiniZincRunResult> {
        return {
          code: 0, stderr: '', durationMs: 1, stdoutEvents: [],
          stdout: `{"selected_cand":[${this.selection}],"objective_value":${this.objective}}\n----------\n==========\n`,
        };
      }
    }
    const value = placedProblem();
    const solved = await new Solver(new PlacementRunner(1, 1)).solve(value, {}, execution());
    assert.deepEqual(solved.solutions[0].decision.binding.t, ref('catalog-a', 'same-id'));
    assert.equal(solved.solutions[0].features.latency, 10);
    assert.equal(solved.solutions[0].objectives.score, 1);

    // A decision that satisfies only the relaxed comparisons of the solver (numeric.ts)
    // is rejected by the exact post-check: with no earlier incumbent the result is UNKNOWN.
    const demoted = await new Solver(new PlacementRunner(2, 9)).solve(value, {}, execution());
    assert.equal(demoted.termination, 'UNKNOWN');
    assert.equal(demoted.solutions.length, 0);
    assert.match(demoted.provenance.relaxed_incumbents_rejected[0], /violates hard placement constraint/);
  });

  it('uses explicit unclamped and clamped normalized losses', async () => {
    class NormalizedRunner extends MiniZincRunner {
      constructor(private readonly objective: number) { super(); }
      override async run(): Promise<MiniZincRunResult> {
        return {
          code: 0, stderr: '', durationMs: 1, stdoutEvents: [],
          stdout: `{"selected_cand":[2],"objective_value":${this.objective}}\n----------\n==========\n`,
        };
      }
    }
    const value = problem();
    value.spec.optimization.criteria[0].direction = 'maximize';
    value.spec.optimization.criteria[0].normalize = { min: 0, max: 5, clamp: false };
    let result = await new Solver(new NormalizedRunner(-0.8)).solve(value, {}, execution());
    assert.ok(Math.abs(result.solutions[0].objectives.score + 0.8) < 1e-12);

    value.spec.optimization.criteria[0].normalize.clamp = true;
    result = await new Solver(new NormalizedRunner(0)).solve(value, {}, execution());
    assert.equal(result.solutions[0].objectives.score, 0);
  });

  it('uses negative raw loss for maximize and reports only solver-proven infeasibility', async () => {
    class StatusRunner extends MiniZincRunner {
      constructor(private readonly stdoutValue: string) { super(); }
      override async run(): Promise<MiniZincRunResult> {
        return { code: 0, stderr: '', durationMs: 1, stdoutEvents: [], stdout: this.stdoutValue };
      }
    }
    const maximize = problem();
    maximize.spec.optimization.criteria[0].direction = 'maximize';
    const solved = await new Solver(new StatusRunner(
      '{"selected_cand":[2],"objective_value":-9}\n----------\n==========\n')).solve(maximize, {}, execution());
    assert.equal(solved.solutions[0].objectives.score, -9);

    const proven = await new Solver(new StatusRunner('=====UNSATISFIABLE=====\n')).solve(problem(), {}, execution());
    assert.equal(proven.termination, 'INFEASIBLE');
    const unproven = await new Solver(new StatusRunner('')).solve(problem(), {}, execution());
    assert.equal(unproven.termination, 'UNKNOWN');
  });

  it('rejects a runner decision that is ineligible or violates a hard constraint', async () => {
    class StatusRunner extends MiniZincRunner {
      override async run(): Promise<MiniZincRunResult> {
        return {
          code: 0, stderr: '', durationMs: 1, stdoutEvents: [],
          stdout: '{"selected_cand":[2],"objective_value":9}\n----------\n==========\n',
        };
      }
    }
    const ineligible = problem();
    ineligible.spec.eligibility.t = [ref('catalog-a', 'same-id')];
    await assert.rejects(() => new Solver(new StatusRunner()).solve(ineligible, {}, execution()), /ineligible candidate/);

    const constrained = problem();
    constrained.spec.constraints.push({
      ref: ref('constraints', 'cost-limit'),
      when: { kind: 'literal', value: true },
      assert: {
        kind: 'compare', op: 'lte',
        left: { kind: 'path', segments: ['metrics', 'cost'] },
        right: { kind: 'literal', value: 5 },
      },
      enforcement: 'hard',
    });
    const demoted = await new Solver(new StatusRunner()).solve(constrained, {}, execution());
    assert.equal(demoted.termination, 'UNKNOWN');
    assert.equal(demoted.solutions.length, 0);
    assert.match(demoted.provenance.relaxed_incumbents_rejected[0], /violates hard constraint 'constraints:cost-limit'/);
  });

  it('falls back to the latest exactly feasible incumbent, as FEASIBLE, when the last one is rejected', async () => {
    class TwoIncumbentsRunner extends MiniZincRunner {
      override async run(): Promise<MiniZincRunResult> {
        return {
          code: 0, stderr: '', durationMs: 1, stdoutEvents: [],
          stdout: '{"selected_cand":[1],"objective_value":1}\n----------\n{"selected_cand":[2],"objective_value":9}\n----------\n==========\n',
        };
      }
    }
    const constrained = problem();
    constrained.spec.constraints.push({
      ref: ref('constraints', 'cost-limit'),
      when: { kind: 'literal', value: true },
      assert: {
        kind: 'compare', op: 'lte',
        left: { kind: 'path', segments: ['metrics', 'cost'] },
        right: { kind: 'literal', value: 5 },
      },
      enforcement: 'hard',
    });
    const result = await new Solver(new TwoIncumbentsRunner()).solve(constrained, {}, execution());
    assert.equal(result.termination, 'FEASIBLE', 'the proof covered the relaxed problem only');
    assert.deepEqual(result.solutions[0].decision.binding.t, ref('catalog-a', 'same-id'));
    assert.equal(result.solutions[0].objectives.score, 1);
    assert.equal(result.provenance.relaxed_incumbents_rejected.length, 1);
  });

  it('renders solution blocks whose outputs were fixed at flattening time through the .ozn pass', async () => {
    const { renderSolverOutputDetailed } = await import('./minizinc_runner');
    const complete = renderSolverOutputDetailed('objective_value = 1.5;\nselected_candidate = array1d(1..2, [1, 2]);\n----------\n==========\n');
    assert.equal(complete.incomplete, 0);
    assert.equal(complete.text, '{"selected_cand":[1,2],"objective_value":1.5}\n----------\n==========\n');
    const fixed = renderSolverOutputDetailed('----------\n==========\n');
    assert.equal(fixed.incomplete, 1);
    const partial = renderSolverOutputDetailed('selected_candidate = array1d(1..2, [1, 2]);\n----------\n==========\n');
    assert.equal(partial.incomplete, 1);
  });
});

// ---------------------------------------------------------------------------
// Multiplicative aggregations: logarithmic linearisation + exact flat products.
// ---------------------------------------------------------------------------

function productMetric(direction = 'maximize') {
  return {
    type: 'number', unit: '1', domain: { kind: 'ratio', minimum: 0, maximum: 1 }, direction, scope: 'invocation',
    neutral: 1,
    aggregation: {
      sequence: 'product', parallel: 'product', exclusive: 'weightedProduct',
      repeat: 'power', selection: 'product',
    },
  };
}

/** Two sequential tasks, two candidates each, a reliability-like product feature plus an additive cost. */
function productProblem(reliabilities: number[][] = [[0.9, 0.5], [0.8, 0.95]], costs: number[][] = [[5, 1], [2, 9]]): any {
  const value = problem();
  const features = { cost: metric(), reliability: productMetric() };
  value.spec.application.features = features;
  value.spec.application.metrics = features;
  value.spec.application.requiredFeatures = ['cost', 'reliability'];
  value.spec.application.requiredMetrics = ['cost', 'reliability'];
  value.spec.application.tasks = {
    t1: { kind: 'service', requires: { type: 'compute' } },
    t2: { kind: 'service', requires: { type: 'compute' } },
  };
  value.spec.application.workflow = {
    kind: 'sequence', steps: [
      { kind: 'task', task: ref('app', 't1') },
      { kind: 'task', task: ref('app', 't2') },
    ],
  };
  const cat = (resource: string, task: number) => ({
    providers: { provider: { properties: {} } },
    featureBindings: { price: ref('app', 'cost'), rel: ref('app', 'reliability') },
    metricBindings: { price: ref('app', 'cost'), rel: ref('app', 'reliability') },
    candidates: Object.fromEntries([0, 1].map((option) => [`c${option}`, {
      ref: ref(resource, `c${option}`), provider: ref(resource, 'provider'),
      provides: [{ type: 'compute', properties: {} }], properties: {},
      features: { price: costs[task][option], rel: reliabilities[task][option] },
      metrics: { price: costs[task][option], rel: reliabilities[task][option] },
    }])),
  });
  value.spec.candidates = { 'catalog-1': cat('catalog-1', 0), 'catalog-2': cat('catalog-2', 1) };
  value.spec.eligibility = {
    t1: [ref('catalog-1', 'c0'), ref('catalog-1', 'c1')],
    t2: [ref('catalog-2', 'c0'), ref('catalog-2', 'c1')],
  };
  value.spec.instance.resources = {
    app: identity('application', 'Application', 'application.json'),
    'catalog-1': identity('candidates', 'CandidateCatalog', 'catalog-1.json'),
    'catalog-2': identity('candidates', 'CandidateCatalog', 'catalog-2.json'),
    optimization: identity('optimization', 'Optimization', 'optimization.json'),
  };
  value.spec.optimization.criteria = [{
    id: 'reliability-criterion', feature: ref('app', 'reliability'), direction: 'maximize',
    normalize: { min: 0, max: 1, clamp: false },
  }];
  return value;
}

function productExecution(): any {
  return { type: 'SINGLE', scalarization: 'weighted-sum', weights: [{ criteria: 'reliability-criterion', value: 1 }] };
}

function reliabilityConstraint(op: string, value: number, enforcement = 'hard', penalty?: number): any {
  return {
    ref: ref('constraints', `rel-${op}-${value}`), when: { kind: 'literal', value: true },
    assert: { kind: 'compare', op, left: { kind: 'path', segments: ['features', 'reliability'] }, right: { kind: 'literal', value } },
    enforcement, ...(penalty === undefined ? {} : { penalty: { kind: 'literal', value: penalty } }),
  };
}

describe('multiplicative aggregations', () => {
  it('flattens a pure product tree into per-task exponents and exposes log space', () => {
    const built = new DznBuilder().build(productProblem(), {}, productExecution());
    assert.equal(parameter(built.dznContent, 'n_flat'), '1');
    assert.equal(parameter(built.dznContent, 'flat_metric'), '[2]');
    assert.equal(parameter(built.dznContent, 'flat_exponent'), '[| 1.0, 1.0 |]');
    assert.equal(parameter(built.dznContent, 'node_flat'), '[| 0, 1 | 0, -1 | 0, -1 |]');
    assert.equal(parameter(built.dznContent, 'metric_log_available'), '[false, true]');
    assert.deepEqual(built.encoding.logSpaceMetrics, ['reliability']);
    // cost: 5 + 9 over the two tasks (widened by the numeric slack); reliability: 0.9 * 0.95 < 1.
    assert.equal(parameter(built.dznContent, 'node_metric_bound'), '14.000000014');
  });

  it('multiplies routing probabilities and repeat counts into the exponents', () => {
    const value = productProblem();
    value.spec.application.workflow = {
      kind: 'sequence', steps: [
        { kind: 'repeat', expectedCount: 2.5, body: { kind: 'task', task: ref('app', 't1') } },
        {
          kind: 'exclusive', branches: [
            { id: 'b1', flow: { kind: 'task', task: ref('app', 't2') } },
            { id: 'b2', flow: { kind: 'empty' } },
          ],
        },
      ],
    };
    value.spec.routing = [{ target: ref('app', 'b1'), probability: 0.25 }, { target: ref('app', 'b2'), probability: 0.75 }];
    const built = new DznBuilder().build(value, {}, productExecution());
    assert.equal(parameter(built.dznContent, 'flat_exponent'), '[| 2.5, 0.25 |]');
    assert.equal(parameter(built.dznContent, 'flat_constant'), '[1.0]');
    // The additive cost feature keeps its ordinary tree (scale by 2.5, weighted sum over XOR).
    assert.equal(parameter(built.dznContent, 'aggregation'), '[| 1, 1, 5, 6 | 2, 2, 7, 9 |]');
  });

  it('rewrites literal comparisons on product features into log space with exact zero handling', () => {
    const value = productProblem([[0.9, 0], [0.8, 0.95]]);
    value.spec.constraints = [
      reliabilityConstraint('gte', 0.5),
      reliabilityConstraint('gt', 0),
      reliabilityConstraint('lte', 0),
      reliabilityConstraint('gte', -1),
      reliabilityConstraint('lt', 1e-300),
    ];
    const built = new DznBuilder().build(value, {}, productExecution());
    assert.equal(built.encoding.logSpaceAtoms, 5);
    assert.equal(parameter(built.dznContent, 'atom_left_kind'), '[4, 4, 4, 3, 4]');
    const thresholds = parameter(built.dznContent, 'atom_right_value').slice(1, -1).split(',').map(Number);
    // `P >= 0.5` becomes `ln P >= ln 0.5 - slack` (the slack moves towards feasibility).
    assert.ok(Math.abs(thresholds[0] - (Math.log(0.5) - 1e-9)) < 1e-12);
    const threshold = Number(parameter(built.dznContent, 'metric_zero_log').slice(1, -1).split(',')[1]);
    assert.ok(threshold < thresholds[1] && thresholds[1] < Math.log(0.8 * 0.9));
    assert.equal(thresholds[1], thresholds[2]);
    assert.equal(parameter(built.dznContent, 'atom_operator'), '[2, 5, 4, 3, 4]');
    // 1e-300 is below every attainable positive product: "P < c" becomes "a zero factor is selected".
    assert.equal(thresholds[4], thresholds[1]);

    const real = new DznBuilder().build(value, { product_constraints: 'real' }, productExecution());
    assert.equal(real.encoding.logSpaceAtoms, 0);
    assert.equal(real.encoding.realSpaceProductAtoms, 5);
    assert.equal(parameter(real.dznContent, 'atom_left_kind'), '[1, 1, 1, 1, 1]');
  });

  it('keeps comparisons between product features and additive features in real space', () => {
    const value = productProblem();
    value.spec.constraints = [{
      ref: ref('constraints', 'mixed'), when: { kind: 'literal', value: true },
      assert: {
        kind: 'compare', op: 'lte', left: { kind: 'path', segments: ['features', 'cost'] },
        right: { kind: 'path', segments: ['features', 'reliability'] },
      },
      enforcement: 'hard',
    }];
    const built = new DznBuilder().build(value, {}, productExecution());
    assert.equal(built.encoding.logSpaceAtoms, 0);
    assert.equal(built.encoding.realSpaceProductAtoms, 1);
    assert.equal(parameter(built.dznContent, 'atom_left_kind'), '[1]');
    assert.equal(parameter(built.dznContent, 'atom_left_index'), '[2]');
    assert.equal(parameter(built.dznContent, 'atom_operator'), '[2]');
  });

  it('lowers soft constant penalties and conjunctions, and tolerates unused aggregation contexts', () => {
    const value = productProblem();
    value.spec.constraints = [
      reliabilityConstraint('gte', 0.99, 'soft', 2),
      {
        ref: ref('constraints', 'both'), when: { kind: 'literal', value: true },
        assert: {
          kind: 'and',
          left: reliabilityConstraint('gte', 0.1).assert,
          right: { kind: 'compare', op: 'lte', left: { kind: 'path', segments: ['features', 'cost'] }, right: { kind: 'literal', value: 100 } },
        },
        enforcement: 'hard',
      },
    ];
    value.spec.optimization.penalties = [{ constraint: ref('constraints', 'rel-gte-0.99'), weight: 1 }];
    const built = new DznBuilder().build(value, {}, productExecution());
    assert.equal(parameter(built.dznContent, 'constraint_enforcement'), '[2, 1]');
    assert.equal(parameter(built.dznContent, 'constraint_penalty'), '[2.0, 0.0]');
    assert.equal(parameter(built.dznContent, 'atom_constraint'), '[1, 2, 2]');
    assert.equal(built.encoding.softConstraints, 1);

    // A single-task workflow never executes sequence/parallel/XOR/repeat aggregations.
    const single = productProblem();
    single.spec.application.workflow = { kind: 'task', task: ref('app', 't1') };
    single.spec.application.tasks = { t1: { kind: 'service', requires: { type: 'compute' } } };
    single.spec.eligibility = { t1: [ref('catalog-1', 'c0'), ref('catalog-1', 'c1')] };
    (single.spec.application.features.reliability.aggregation as any).sequence = { expression: { op: 'sum', args: [] } };
    assert.equal(parameter(new DznBuilder().build(single, {}, productExecution()).dznContent, 'n_flat'), '0');
  });

  it('rejects multiplicative constructs that cannot be represented exactly', () => {
    const mixed = productProblem();
    mixed.spec.application.features.reliability.aggregation.sequence = 'sum';
    mixed.spec.application.workflow = {
      kind: 'exclusive', branches: [
        { id: 'b1', flow: { kind: 'sequence', steps: [{ kind: 'task', task: ref('app', 't1') }, { kind: 'task', task: ref('app', 't2') }] } },
        { id: 'b2', flow: { kind: 'empty' } },
      ],
    };
    mixed.spec.routing = [{ target: ref('app', 'b1'), probability: 0.5 }, { target: ref('app', 'b2'), probability: 0.5 }];
    assert.throws(() => new DznBuilder().build(mixed, {}, productExecution()), /weightedProduct to a branch that is not a pure product/);

    const negative = productProblem([[-0.5, 0.5], [0.8, 0.95]]);
    negative.spec.application.workflow = {
      kind: 'repeat', expectedCount: 1.5,
      body: { kind: 'sequence', steps: [{ kind: 'task', task: ref('app', 't1') }, { kind: 'task', task: ref('app', 't2') }] },
    };
    assert.throws(() => new DznBuilder().build(negative, {}, productExecution()), /negative candidate value .* fractional exponent/);
    assert.throws(() => new Solver().validate(productProblem(), { product_constraints: 'exp' }, productExecution()), /product_constraints/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end checks against a real MiniZinc/Gecode installation (skipped when absent).
// ---------------------------------------------------------------------------

const haveMiniZinc = spawnSync('minizinc', ['--version'], { encoding: 'utf8' }).status === 0;

describe('MiniZinc/Gecode integration', { skip: !haveMiniZinc && 'minizinc is not on PATH' }, () => {
  it('maximises a product feature exactly and reports the authoritative score', async () => {
    const result = await new Solver().solve(productProblem(), { time_budget_ms: 20000 }, productExecution());
    assert.equal(result.termination, 'OPTIMAL');
    const binding = result.solutions[0].decision.binding;
    assert.deepEqual(binding.t1, ref('catalog-1', 'c0'));
    assert.deepEqual(binding.t2, ref('catalog-2', 'c1'));
    assert.ok(Math.abs(result.solutions[0].features.reliability - 0.9 * 0.95) < 1e-9);
    assert.ok(Math.abs(result.solutions[0].objectives.score - (1 - 0.9 * 0.95)) < 1e-9);
    assert.deepEqual(result.provenance.encoding.logSpaceMetrics, ['reliability']);
  });

  it('enforces log-space constraints with the same outcome as real-space ones, including zeros', async () => {
    for (const productConstraints of ['log', 'real']) {
      const options = { time_budget_ms: 20000, product_constraints: productConstraints };
      // Cost-minimising objective; reliability only enters through constraints.
      const value = productProblem([[0.9, 0], [0.8, 0.95]]);
      value.spec.optimization.criteria = [{ id: 'cost-criterion', feature: ref('app', 'cost'), direction: 'minimize' }];
      value.spec.constraints = [reliabilityConstraint('gte', 0.8)];
      let result = await new Solver().solve(value, options, execution());
      assert.equal(result.termination, 'OPTIMAL', productConstraints);
      assert.deepEqual(result.solutions[0].decision.binding.t1, ref('catalog-1', 'c0'));
      assert.deepEqual(result.solutions[0].decision.binding.t2, ref('catalog-2', 'c1'));

      value.spec.constraints = [reliabilityConstraint('eq', 0)];
      result = await new Solver().solve(value, options, execution());
      assert.equal(result.termination, 'OPTIMAL', productConstraints);
      assert.deepEqual(result.solutions[0].decision.binding.t1, ref('catalog-1', 'c1'));
      assert.equal(result.solutions[0].features.reliability, 0);

      value.spec.constraints = [reliabilityConstraint('gt', 0.9)];
      result = await new Solver().solve(value, options, execution());
      assert.equal(result.termination, 'INFEASIBLE', productConstraints);
    }
  });

  it('respects pool capacities through the bin-packing column and the reified fallback alike', async () => {
    for (const constantDemand of [true, false]) {
      const result = await new Solver().solve(capacityProblem(constantDemand), { time_budget_ms: 20000 }, execution());
      assert.equal(result.termination, 'OPTIMAL');
      const binding = result.solutions[0].decision.binding;
      const inA = Object.values(binding).filter((item: any) => item.id.endsWith('-a')).length;
      assert.equal(inA, 2, 'exactly two tasks fit in pool a');
      assert.equal(result.solutions[0].features.cost, 1 + 1 + 5);
      assert.equal(result.solutions[0].violations.length, 0);
      assert.equal(result.provenance.encoding.binPackingColumns, constantDemand ? 1 : 0);
    }
  });

  it('returns the binding that attains a constraint limit exactly, even when the limit has 17 significant digits', async () => {
    // Regression for the first QACOBench campaign (qfbs_guaranteed_20_011 / _033): the
    // cheapest binding has the largest attainable latency, the limit equals that latency
    // exactly, and the lowering's own latency bound, printed by MiniZinc with 16
    // significant digits as `float_le(x, 161.514707556055)`, excluded that binding.
    const limit = 161.51470755605504;
    const value = problem();
    value.spec.candidates['catalog-a'].candidates['same-id'].features.response = limit;
    value.spec.candidates['catalog-a'].candidates['same-id'].metrics.response = limit;
    value.spec.constraints = [{
      ref: ref('constraints', 'latency-limit'), when: { kind: 'literal', value: true },
      assert: { kind: 'compare', op: 'lte', left: { kind: 'path', segments: ['metrics', 'latency'] }, right: { kind: 'literal', value: limit } },
      enforcement: 'hard',
    }];
    const result = await new Solver().solve(value, { time_budget_ms: 20000 }, execution());
    assert.equal(result.termination, 'OPTIMAL');
    assert.deepEqual(result.solutions[0].decision.binding.t, ref('catalog-a', 'same-id'));
    assert.equal(result.solutions[0].features.latency, limit);
    assert.equal(result.solutions[0].objectives.score, 1);
    assert.equal(result.solutions[0].violations.length, 0);
    assert.equal(result.provenance.relaxed_incumbents_rejected, undefined);

    // The mirrored case: a lower limit that equals the smallest attainable value exactly.
    const floor = 0.30000000000000004;
    const lower = problem();
    lower.spec.candidates['catalog-a'].candidates['same-id'].features.response = floor;
    lower.spec.candidates['catalog-a'].candidates['same-id'].metrics.response = floor;
    lower.spec.constraints = [{
      ref: ref('constraints', 'latency-floor'), when: { kind: 'literal', value: true },
      assert: { kind: 'compare', op: 'gte', left: { kind: 'path', segments: ['metrics', 'latency'] }, right: { kind: 'literal', value: floor } },
      enforcement: 'hard',
    }];
    const result2 = await new Solver().solve(lower, { time_budget_ms: 20000 }, execution());
    assert.equal(result2.termination, 'OPTIMAL');
    assert.deepEqual(result2.solutions[0].decision.binding.t, ref('catalog-a', 'same-id'));
    assert.equal(result2.solutions[0].features.latency, floor);
  });

  it('renders a solution whose binding was fixed at flattening time', async () => {
    // A single eligible candidate per task: every output is a constant for MiniZinc,
    // the solver prints an empty solution block and the .ozn pass renders it.
    const value = problem();
    value.spec.eligibility.t = [ref('catalog-b', 'same-id')];
    const result = await new Solver().solve(value, { time_budget_ms: 20000 }, execution());
    assert.equal(result.termination, 'OPTIMAL');
    assert.deepEqual(result.solutions[0].decision.binding.t, ref('catalog-b', 'same-id'));
    assert.equal(result.solutions[0].objectives.score, 9);
    assert.equal(result.provenance.ozn_rendered, true);
  });

  it('pays constant soft penalties and attains boundary normalised values', async () => {
    const value = productProblem();
    value.spec.constraints = [reliabilityConstraint('gte', 0.99, 'soft', 0.5)];
    value.spec.optimization.penalties = [{ constraint: ref('constraints', 'rel-gte-0.99'), weight: 1 }];
    value.spec.optimization.criteria[0].normalize = { min: 0.4, max: 0.9 * 0.95, clamp: true };
    const result = await new Solver().solve(value, { time_budget_ms: 20000 }, productExecution());
    assert.equal(result.termination, 'OPTIMAL');
    // Best reliability attains normalised 1 exactly (loss 0) and still pays the soft penalty.
    assert.ok(Math.abs(result.solutions[0].objectives.score - 0.5) < 1e-9);
    assert.equal(result.solutions[0].violations.length, 1);
    assert.equal(result.solutions[0].violations[0].enforcement, 'soft');
  });
});
