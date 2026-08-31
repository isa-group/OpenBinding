import assert from 'node:assert/strict';
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
    metrics: { price: cost, response: latency },
  };
}

function catalog(resource: string, cost: number, latency: number) {
  return {
    providers: { provider: { properties: {} } },
    metricBindings: { price: ref('app', 'cost'), response: ref('app', 'latency') },
    candidates: { 'same-id': candidate(resource, cost, latency) },
  };
}

function problem(): any {
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
        metrics: { cost: metric(), latency: metric() },
        requiredMetrics: ['cost', 'latency'], taskRequiredMetrics: {},
        workflow: { kind: 'task', task: ref('app', 't') },
      },
      candidates: {
        'catalog-a': catalog('catalog-a', 1, 10),
        'catalog-b': catalog('catalog-b', 9, 1),
      },
      eligibility: { t: [ref('catalog-a', 'same-id'), ref('catalog-b', 'same-id')] },
      routing: [], constraints: [], placement: [],
      optimization: {
        resource: 'optimization', mode: 'weighted', type: 'MONO',
        terms: [{ metric: ref('app', 'cost'), direction: 'minimize', weight: 1 }],
        penalties: [],
      },
      extensions: {}, sourceMap: {},
    },
  };
}

function envelope(value: any = problem(), options: any = {}) {
  return { apiVersion: 'bim/v1', kind: 'BindingProblemRequest', protocol: 'bim-engine/v1', problem: value, options };
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
      metric: ref('app', 'latency'), maximum: 5, enforcement: 'hard',
    }],
    globalLatency: {
      metric: ref('app', 'latency'), includeExecution: true, exclusive: 'routing', parallel: 'max',
    },
    capacityRules: [{ ref: ref('placement', 'capacityRules/0'), resources: ['memory'], scope: 'selectedCandidate' }],
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
    const built = new DznBuilder().build(problem(), {});
    assert.deepEqual(built.candidates, [ref('catalog-a', 'same-id'), ref('catalog-b', 'same-id')]);
    assert.equal(parameter(built.dznContent, 'task_candidates'), '[| 1, 2 |]');
  });

  it('materializes changed objectives and hard constraints', () => {
    const objective = problem();
    objective.spec.optimization.terms[0].metric = ref('app', 'latency');
    assert.equal(parameter(new DznBuilder().build(objective, {}).dznContent, 'term_metric'), '[2]');
    objective.spec.optimization.terms[0].normalize = { min: 0, max: 5, clamp: false };
    assert.equal(parameter(new DznBuilder().build(objective, {}).dznContent, 'term_clamp'), '[false]');
    delete objective.spec.optimization.terms[0].normalize.clamp;
    assert.throws(() => new DznBuilder().build(objective, {}), /normalization bounds are invalid/);

    const constrained = problem();
    constrained.spec.constraints.push({
      ref: ref('constraints', 'fast'), when: { kind: 'literal', value: true },
      assert: {
        kind: 'compare', op: 'lte', left: { kind: 'path', segments: ['metrics', 'latency'] },
        right: { kind: 'literal', value: 5 },
      },
      enforcement: 'hard',
    });
    const dzn = new DznBuilder().build(constrained, {}).dznContent;
    assert.equal(parameter(dzn, 'constraint_left_kind'), '[1]');
    assert.equal(parameter(dzn, 'constraint_left_index'), '[2]');
    assert.equal(parameter(dzn, 'constraint_right_kind'), '[3]');
    assert.equal(parameter(dzn, 'constraint_right_value'), '[5]');
  });

  it('bounds every intermediate node even when an outer repeat executes zero times', () => {
    const value = problem();
    value.spec.application.workflow = {
      kind: 'repeat', count: 0,
      body: { kind: 'task', task: ref('app', 't') },
    };
    const built = new DznBuilder().build(value, {});
    assert.equal(parameter(built.dznContent, 'node_metric_bound'), '10');
  });

  it('accepts a weighted all-local problem and an empty binding domain', () => {
    const value = problem();
    value.spec.application.tasks = { local: { kind: 'local' } };
    value.spec.application.workflow = { kind: 'task', task: ref('app', 'local') };
    value.spec.eligibility = {};
    const built = new DznBuilder().build(value, {});
    assert.deepEqual(built.tasks, []);
    assert.equal(parameter(built.dznContent, 'n_tasks'), '0');
    assert.equal(parameter(built.dznContent, 'max_candidates_per_task'), '1');
  });

  it('keeps empty Placement vacuous and lowers a complete placement model', () => {
    const empty = new DznBuilder().build(problem(), {}).dznContent;
    assert.equal(parameter(empty, 'n_pool_slots'), '1');
    assert.equal(parameter(empty, 'n_capacity_checks'), '0');
    assert.equal(parameter(empty, 'n_transitions'), '0');
    assert.equal(parameter(empty, 'n_activities'), '0');

    const placed = new DznBuilder().build(placedProblem(), {}).dznContent;
    assert.equal(parameter(placed, 'n_pool_slots'), '3');
    assert.equal(parameter(placed, 'candidate_model'), '[1, 1]');
    assert.equal(parameter(placed, 'candidate_pool'), '[2, 3]');
    assert.equal(parameter(placed, 'n_capacity_checks'), '2');
    assert.equal(parameter(placed, 'n_transitions'), '1');
    assert.equal(parameter(placed, 'transition_hard'), '[true]');
    assert.equal(parameter(placed, 'global_metric_model'), '[0, 1]');
    assert.equal(parameter(placed, 'n_scenarios'), '1');
    assert.equal(parameter(placed, 'n_activities'), '1');
  });

  it('rejects every construct outside the declared exact-weighted mode', () => {
    const source = { apiVersion: 'bim/v1', kind: 'Instance', metadata: {}, spec: {} };
    assert.throws(() => new DznBuilder().build(source, {}), /only a canonical bim\/v1 BindingProblem/);

    const expected = problem();
    expected.spec.application.workflow = {
      kind: 'repeat', expectedCount: 1.5,
      body: { kind: 'task', task: ref('app', 't') },
    };
    assert.throws(() => new DznBuilder().build(expected, {}), /does not support expectedCount/);

    const soft = problem();
    soft.spec.constraints.push({
      ref: ref('constraints', 'soft'), when: { kind: 'literal', value: true },
      assert: { kind: 'literal', value: false }, enforcement: 'soft',
      penalty: { kind: 'literal', value: 1 },
    });
    assert.throws(() => new DznBuilder().build(soft, {}), /does not support soft constraint/);

    const selected = problem();
    selected.spec.application.metrics.cost.scope = 'selectedCandidate';
    assert.equal(parameter(new DznBuilder().build(selected, {}).dznContent, 'metric_scope'), '[2, 1]');

    const multi = problem();
    multi.spec.optimization.type = 'MULTI';
    assert.throws(() => new DznBuilder().build(multi, {}), /objective type MONO only/);

    assert.throws(() => new Solver().validate(problem(), { solver: 'chuffed' }), /must be gecode/);

    const implicitRouting = problem();
    implicitRouting.spec.routing = { branch: 1 };
    assert.throws(() => new DznBuilder().build(implicitRouting, {}), /canonical array/);

    const nonCanonicalWeights = problem();
    nonCanonicalWeights.spec.optimization.terms[0].weight = 2;
    assert.throws(() => new DznBuilder().build(nonCanonicalWeights, {}), /normalized to 1/);
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
    const dzn = new DznBuilder().build(value, {}).dznContent;
    assert.equal(parameter(dzn, 'metric_neutral'), '[0, 1]');
    assert.match(parameter(dzn, 'node_weights'), /0\.5/);

    value.spec.routing[0].target.resource = 'overlay';
    value.spec.routing[1].target.resource = 'overlay';
    assert.throws(() => new DznBuilder().build(value, {}), /Missing routing probability/);
  });
});

describe('BIM Engine Protocol v1', () => {
  it('rejects source envelopes and missing protocol before queueing', async () => {
    const fake = {
      validate: (value: any, options: any) => new DznBuilder().build(value, options),
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
    const result = await new Solver(runner).solve(problem(), { time_budget_ms: 1234 });
    assert.equal(result.termination, 'OPTIMAL');
    assert.deepEqual(result.solutions[0].decision.binding.t, ref('catalog-b', 'same-id'));
    assert.equal(result.solutions[0].metrics.cost, 9);
    assert.equal(result.solutions[0].objectives.score, 9);
    assert.deepEqual(runner.extraArgs.slice(0, 2), ['--time-limit', '1234']);
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
    const solved = await new Solver(new PlacementRunner(1, 1)).solve(value, {});
    assert.deepEqual(solved.solutions[0].decision.binding.t, ref('catalog-a', 'same-id'));
    assert.equal(solved.solutions[0].metrics.latency, 10);
    assert.equal(solved.solutions[0].objectives.score, 1);

    await assert.rejects(
      () => new Solver(new PlacementRunner(2, 9)).solve(value, {}),
      /violates a hard placement constraint/,
    );
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
    value.spec.optimization.terms[0].direction = 'maximize';
    value.spec.optimization.terms[0].normalize = { min: 0, max: 5, clamp: false };
    let result = await new Solver(new NormalizedRunner(-0.8)).solve(value, {});
    assert.ok(Math.abs(result.solutions[0].objectives.score + 0.8) < 1e-12);

    value.spec.optimization.terms[0].normalize.clamp = true;
    result = await new Solver(new NormalizedRunner(0)).solve(value, {});
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
    maximize.spec.optimization.terms[0].direction = 'maximize';
    const solved = await new Solver(new StatusRunner(
      '{"selected_cand":[2],"objective_value":-9}\n----------\n==========\n')).solve(maximize, {});
    assert.equal(solved.solutions[0].objectives.score, -9);

    const proven = await new Solver(new StatusRunner('=====UNSATISFIABLE=====\n')).solve(problem(), {});
    assert.equal(proven.termination, 'INFEASIBLE');
    const unproven = await new Solver(new StatusRunner('')).solve(problem(), {});
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
    await assert.rejects(() => new Solver(new StatusRunner()).solve(ineligible, {}), /ineligible candidate/);

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
    await assert.rejects(() => new Solver(new StatusRunner()).solve(constrained, {}), /violates hard constraint/);
  });
});
