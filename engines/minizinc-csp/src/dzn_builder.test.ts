/**
 * Constraint emission tests.
 *
 * The model can only enforce what the builder emits, so a constraint that is
 * dropped here comes back as an OPTIMAL answer that breaks it. These cover the
 * cases that used to be dropped.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DznBuilder } from './dzn_builder';

function instanceWith(constraints: any[]) {
  return {
    metadata: { id: 'dzn', name: 'DZN', version: '1.0', created_at: '2026-01-01T00:00:00Z' },
    tasks: [{ id: 'T1', name: 'T1' }, { id: 'T2', name: 'T2' }],
    providers: [{ id: 'P1', name: 'P1' }],
    candidates: [
      { id: 'A1', task_ids: ['T1'], provider_id: 'P1', name: 'A1', features: { cost: 1 } },
      { id: 'A2', task_ids: ['T1'], provider_id: 'P1', name: 'A2', features: { cost: 50 } },
      { id: 'B1', task_ids: ['T2'], provider_id: 'P1', name: 'B1', features: { cost: 1 } },
      { id: 'B2', task_ids: ['T2'], provider_id: 'P1', name: 'B2', features: { cost: 50 } },
    ],
    composition: {
      type: 'STRUCTURED',
      root: {
        id: 's', kind: 'SEQ', children: [
          { id: 'n1', kind: 'TASK', task_id: 'T1' },
          { id: 'n2', kind: 'TASK', task_id: 'T2' },
        ],
      },
    },
    features: [{ id: 'cost', name: 'Cost', direction: 'MINIMIZE', unit: 'u', scale: 'RATIO', valid_range: { min: 0, max: 1000 } }],
    aggregation_policies: { cost: { neutral: 0, compose: { seq: { fn: 'SUM' } } } },
    objective: { type: 'MONO', targets: ['cost'], weights: { cost: 1.0 } },
    constraints,
  };
}

function dzn(constraints: any[]): string {
  return new DznBuilder().build(instanceWith(constraints), {}).dznContent;
}

/** Reads `name = <value>;` out of the generated DZN. */
function param(content: string, name: string): string {
  const match = content.match(new RegExp(`\\b${name}\\s*=\\s*([^;]*);`));
  assert.ok(match, `parameter ${name} missing from the generated DZN`);
  return match![1].trim();
}

const localBound = (extra: any) => ({
  id: 'c_local', kind: 'ATTRIBUTE_BOUND', scope: 'LOCAL',
  attribute_id: 'cost', op: '<=', value: 10, hard: true, ...extra,
});

describe('attribute bound emission', () => {
  it('binds every task a local constraint lists, not just the first', () => {
    const content = dzn([localBound({ tasks: ['T1', 'T2'] })]);

    assert.equal(param(content, 'n_local_constraints'), '2');
    assert.equal(param(content, 'lc_task'), '[1, 2]');
  });

  it('expands IN_RANGE into a lower and an upper bound', () => {
    const content = dzn([{
      id: 'c_range', kind: 'ATTRIBUTE_BOUND', scope: 'GLOBAL',
      attribute_id: 'cost', op: 'IN_RANGE', value: { min: 5, max: 10 }, hard: true,
    }]);

    assert.equal(param(content, 'n_global_constraints'), '2');
    assert.equal(param(content, 'gc_op'), '[2, 1]', '>= then <=');
    assert.equal(param(content, 'gc_val'), '[5, 10]');
  });

  it('emits the != operator instead of discarding the constraint', () => {
    const content = dzn([{
      id: 'c_ne', kind: 'ATTRIBUTE_BOUND', scope: 'GLOBAL',
      attribute_id: 'cost', op: '!=', value: 2, hard: true,
    }]);

    assert.equal(param(content, 'n_global_constraints'), '1');
    assert.equal(param(content, 'gc_op'), '[6]');
  });

  it('rules out candidates a candidate-scoped constraint forbids', () => {
    const content = dzn([localBound({ candidates: ['A2', 'B1'] })]);

    // A2 costs 50 and breaks `<= 10`; B1 costs 1 and does not.
    assert.equal(param(content, 'n_excluded_candidates'), '1');
    assert.equal(param(content, 'excluded_cand'), '[2]');
    assert.equal(param(content, 'excluded_task'), '[1]');
  });

  it('emits nothing for a candidate scope that no candidate breaks', () => {
    const content = dzn([localBound({ candidates: ['A1', 'B1'] })]);

    assert.equal(param(content, 'n_excluded_candidates'), '0');
  });

  it('refuses an operator it cannot enforce rather than ignoring it', () => {
    assert.throws(
      () => dzn([{
        id: 'c_bad', kind: 'ATTRIBUTE_BOUND', scope: 'GLOBAL',
        attribute_id: 'cost', op: '<>', value: 2, hard: true,
      }]),
      /Unsupported attribute bound operator/
    );
  });

  it('refuses a bound on a feature it does not know', () => {
    assert.throws(
      () => dzn([{
        id: 'c_unknown', kind: 'ATTRIBUTE_BOUND', scope: 'GLOBAL',
        attribute_id: 'nope', op: '<=', value: 2, hard: true,
      }]),
      /unknown feature/
    );
  });

  it('leaves soft constraints to the gateway', () => {
    const content = dzn([localBound({ tasks: ['T1', 'T2'], hard: false })]);

    assert.equal(param(content, 'n_local_constraints'), '0');
  });
});

describe('placement arrays without placement blocks', () => {
  it('emits empty arrays so the placement constraints stay vacuous', () => {
    const content = dzn([]);

    assert.equal(param(content, 'n_pools'), '0');
    assert.equal(param(content, 'n_resources'), '0');
    assert.equal(param(content, 'n_cap_checks'), '0');
    assert.equal(param(content, 'n_transitions'), '0');
    assert.equal(param(content, 'n_scenarios'), '0');
    assert.equal(param(content, 'lat_feature_idx'), '0');
    assert.equal(param(content, 'use_canonical'), 'false', 'no normalization declared');
  });
});
