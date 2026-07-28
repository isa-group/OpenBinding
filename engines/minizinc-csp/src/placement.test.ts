/**
 * Tests for the placement view the engine derives from an instance.
 *
 * The expected values here are the ones the gateway reference evaluator
 * produces for the same instances; the two implementations must agree, since
 * a divergence would show up as a mismatch between the objective the engine
 * optimizes and the one the gateway reports.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PlacementModel, buildScenarios, declaresNormalization } from './placement';

function task(id: string) {
  return { id: `n_${id}`, kind: 'TASK', task_id: id };
}

function seq(...children: any[]) {
  return { id: 'n_seq', kind: 'SEQ', children };
}

/** Two tasks in sequence, an XOR of two branches, then a final task. */
function branchingComposition() {
  return {
    root: seq(
      task('T1'),
      {
        id: 'n_xor',
        kind: 'XOR',
        branches: [
          { p: 0.7, child: task('T2') },
          { p: 0.3, child: task('T3') },
        ],
      },
      task('T4')
    ),
  };
}

function placementInstance() {
  return {
    tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }, { id: 'T4' }],
    candidates: [
      { id: 'c1', task_id: 'T1' },
      { id: 'c2', task_id: 'T2' },
    ],
    composition: branchingComposition(),
    objective: { type: 'MONO', targets: ['latency'], weights: { latency: 1 } },
    aggregation_policies: {
      latency: { neutral: 0, compose: { seq: { fn: 'SUM' } }, normalize: { type: 'minmax', bounds: { min: 0, max: 100 } } },
    },
    resource_model: {
      resources: ['cpu', 'mem'],
      pools: [
        { id: 'edge', name: 'Edge', kind: 'EDGE', capacity: { cpu: 4, mem: 1024 } },
        { id: 'cloud', name: 'Cloud', kind: 'CLOUD', capacity: { cpu: 64, mem: 65536 } },
      ],
      candidate_bindings: [
        { candidate_id: 'c1', pool_id: 'edge', demand: { cpu: 1, mem: 256 } },
        { candidate_id: 'c2', pool_id: 'cloud', demand: { cpu: 2, mem: 512 } },
      ],
      constraints: [
        { id: 'cap_edge', kind: 'DEPENDENCY', type: 'RESOURCE_CAPACITY', scope: 'POOL_KIND', pool_kinds: ['EDGE'], resources: ['cpu'], hard: true },
        { id: 'cap_all', kind: 'DEPENDENCY', type: 'RESOURCE_CAPACITY', scope: 'ALL_POOLS', resources: ['mem'], hard: true },
      ],
    },
    latency_model: {
      unit: 'ms',
      pool_latency_matrix_ms: { edge: { edge: 0, cloud: 20 }, cloud: { cloud: 0 } },
      event_generator_pools: { sensor: 'edge' },
      event_latency_matrix_ms: { sensor: { edge: 1 } },
      transition_constraints: [],
      global_latency: {
        attribute_id: 'latency',
        include_execution_latency_feature: true,
        xor_semantics: 'EXPECTED',
        and_semantics: 'MAX',
      },
    },
  };
}

describe('PlacementModel', () => {
  it('is empty for an instance that carries no placement blocks', () => {
    const model = new PlacementModel({ composition: { root: task('T1') } });

    assert.deepEqual(model.pools, []);
    assert.deepEqual(model.poolOfCandidate, {});
    assert.deepEqual(model.capacityConstraints, []);
    assert.deepEqual(model.transitions, []);
    assert.deepEqual(model.eventIds, []);
    assert.equal(model.globalLatency, null);
  });

  it('inverts candidate bindings into pool and demand lookups', () => {
    const model = new PlacementModel(placementInstance());

    assert.equal(model.poolOfCandidate['c1'], 'edge');
    assert.deepEqual(model.demandOfCandidate['c2'], { cpu: 2, mem: 512 });
    assert.deepEqual(
      model.pools.map((p) => p.id),
      ['edge', 'cloud']
    );
  });

  it('resolves constraint scope to explicit pools', () => {
    const model = new PlacementModel(placementInstance());
    const byId = Object.fromEntries(model.capacityConstraints.map((c) => [c.id, c]));

    assert.deepEqual(byId['cap_edge'].pools, ['edge'], 'POOL_KIND selects pools of that kind');
    assert.deepEqual(byId['cap_all'].pools, ['edge', 'cloud'], 'ALL_POOLS selects every pool');
  });

  it('drops constraints that are not capacity constraints, in either spelling', () => {
    const instance = placementInstance();
    instance.resource_model.constraints.push(
      { id: 'legacy', kind: 'RESOURCE_CAPACITY', scope: 'ALL_POOLS', resources: ['cpu'], hard: true } as any,
      { id: 'other', kind: 'DEPENDENCY', type: 'SOMETHING_ELSE', scope: 'ALL_POOLS', resources: ['cpu'], hard: true } as any
    );
    const model = new PlacementModel(instance);
    const ids = model.capacityConstraints.map((c) => c.id);

    assert.ok(ids.includes('legacy'), 'legacy spelling is still accepted');
    assert.ok(!ids.includes('other'), 'non-capacity dependencies are not capacity checks');
  });

  it('falls back to the transposed entry for a missing latency direction', () => {
    const model = new PlacementModel(placementInstance());

    assert.equal(model.poolLatency('edge', 'cloud'), 20);
    assert.equal(model.poolLatency('cloud', 'edge'), 20, 'transposed lookup');
    assert.equal(model.poolLatency('cloud', 'cloud'), 0);
  });

  it('falls back to the generator pool for a missing event latency', () => {
    const model = new PlacementModel(placementInstance());

    assert.equal(model.eventPoolLatency('sensor', 'edge'), 1, 'declared entry wins');
    assert.equal(model.eventPoolLatency('sensor', 'cloud'), 20, 'latency from the generator pool');
  });

  it('rejects and_semantics it does not implement', () => {
    const instance = placementInstance();
    instance.latency_model.global_latency.and_semantics = 'SUM';

    assert.throws(() => new PlacementModel(instance), /and_semantics/);
  });
});

describe('buildScenarios', () => {
  it('yields a single scenario when there is no XOR', () => {
    const scenarios = buildScenarios(seq(task('T1'), task('T2')), []);

    assert.equal(scenarios.length, 1);
    assert.equal(scenarios[0].prob, 1);
    assert.deepEqual(scenarios[0].order, ['T1', 'T2']);
    assert.deepEqual(scenarios[0].preds['T1'], []);
    assert.deepEqual(scenarios[0].preds['T2'], [['task', 'T1']]);
    assert.deepEqual(scenarios[0].sinks, ['T2']);
  });

  it('enumerates one scenario per XOR branch, with its probability', () => {
    const scenarios = buildScenarios(branchingComposition().root, []);

    assert.equal(scenarios.length, 2);
    assert.deepEqual(
      scenarios.map((s) => s.prob).sort(),
      [0.3, 0.7]
    );
    assert.deepEqual(scenarios[0].order, ['T1', 'T2', 'T4'], 'first branch active');
    assert.deepEqual(scenarios[1].order, ['T1', 'T3', 'T4'], 'second branch active');
    assert.deepEqual(scenarios[0].preds['T4'], [['task', 'T2']]);
    assert.deepEqual(scenarios[1].preds['T4'], [['task', 'T3']]);
  });

  it('makes an AND join wait for every branch', () => {
    const root = seq(
      task('T1'),
      { id: 'n_and', kind: 'AND', children: [task('T2'), task('T3')] },
      task('T4')
    );
    const scenarios = buildScenarios(root, []);

    assert.equal(scenarios.length, 1);
    assert.deepEqual(scenarios[0].preds['T2'], [['task', 'T1']]);
    assert.deepEqual(scenarios[0].preds['T3'], [['task', 'T1']]);
    assert.deepEqual(scenarios[0].preds['T4'], [
      ['task', 'T2'],
      ['task', 'T3'],
    ]);
  });

  it('threads event generators in as the entry points', () => {
    const scenarios = buildScenarios(seq(task('T1'), task('T2')), ['sensor']);

    assert.deepEqual(scenarios[0].preds['T1'], [['event', 'sensor']]);
  });

  it('multiplies out nested XOR nodes', () => {
    const root = seq(
      {
        id: 'n_xor_a',
        kind: 'XOR',
        branches: [
          { p: 0.5, child: task('A1') },
          { p: 0.5, child: task('A2') },
        ],
      },
      {
        id: 'n_xor_b',
        kind: 'XOR',
        branches: [
          { p: 0.5, child: task('B1') },
          { p: 0.5, child: task('B2') },
        ],
      }
    );
    const scenarios = buildScenarios(root, []);

    assert.equal(scenarios.length, 4);
    assert.equal(
      scenarios.reduce((total, s) => total + s.prob, 0),
      1
    );
  });

  it('rejects the composition shapes the latency model cannot read as a DAG', () => {
    assert.throws(
      () => buildScenarios({ id: 'n_loop', kind: 'LOOP', body: task('T1') }, []),
      /LOOP/
    );
    assert.throws(() => buildScenarios(seq(task('T1'), task('T1')), []), /more than once/);
  });
});

describe('declaresNormalization', () => {
  it('is true only when every objective target declares bounds', () => {
    const instance = placementInstance();
    assert.equal(declaresNormalization(instance), true);

    instance.objective.targets = ['latency', 'cost'];
    assert.equal(declaresNormalization(instance), false, 'cost declares none');

    assert.equal(declaresNormalization({ objective: { targets: [] } }), false);
    assert.equal(declaresNormalization({}), false);
  });
});
