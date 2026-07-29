/**
 * Emission for candidates that serve several tasks at once.
 *
 * The model divides a shared feature by looking the quotient up in a table the
 * builder computes, so what is emitted here is what the model can enforce: a
 * wrong table, a missing market entry or a compile-time exclusion that should
 * have been left to the solver all come back as an OPTIMAL answer that the
 * gateway then scores differently.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DznBuilder } from './dzn_builder';

function instance(overrides: any = {}) {
  return {
    metadata: { id: 'sharing', name: 'Sharing', version: '1.0', created_at: '2026-01-01T00:00:00Z' },
    tasks: [{ id: 'T1', name: 'T1' }, { id: 'T2', name: 'T2' }],
    providers: [{ id: 'P1', name: 'P1' }],
    candidates: [
      { id: 'both', task_ids: ['T1', 'T2'], provider_id: 'P1', name: 'both', features: { cost: 10 } },
      { id: 'only_t1', task_ids: ['T1'], provider_id: 'P1', name: 'only_t1', features: { cost: 3 } },
      { id: 'only_t2', task_ids: ['T2'], provider_id: 'P1', name: 'only_t2', features: { cost: 3 } },
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
    features: [{
      id: 'cost', name: 'Cost', direction: 'MINIMIZE', unit: 'u', scale: 'RATIO',
      valid_range: { min: 0, max: 1000 }, sharing: 'DIVIDE',
    }],
    aggregation_policies: { cost: { neutral: 0, compose: { seq: { fn: 'SUM' } } } },
    objective: { type: 'MONO', targets: ['cost'], weights: { cost: 1.0 } },
    constraints: [],
    ...overrides,
  };
}

function dzn(overrides: any = {}): string {
  return new DznBuilder().build(instance(overrides), {}).dznContent;
}

/** Reads `name = <value>;` out of the generated DZN. */
function param(content: string, name: string): string {
  const match = content.match(new RegExp(`\\b${name}\\s*=\\s*([^;]*);`));
  assert.ok(match, `parameter ${name} missing from the generated DZN`);
  return match![1].trim();
}

describe('candidates that serve several tasks', () => {
  it('puts a shared candidate in the market of every task it serves', () => {
    const content = dzn();

    // Candidate 1 is "both": it heads T1's row and T2's alike.
    assert.equal(param(content, 'task_cands'), '[| 1, 2 | 1, 3 |]');
    assert.equal(param(content, 'n_task_cands'), '[2, 2]');
  });

  it('tabulates the value a shared feature takes for every possible share', () => {
    const content = dzn();

    assert.equal(param(content, 'n_shared_feats'), '1');
    assert.equal(param(content, 'n_share_levels'), '2');
    assert.equal(param(content, 'qos_share_slot'), '[1]');
    // Per candidate, the value divided by one task and by two: 10, 5, 3, 1.5, 3, 1.5
    assert.equal(
      param(content, 'shared_qos'),
      'array2d(1..3, 1..2, [10, 5, 3, 1.5, 3, 1.5])'
    );
  });

  it('collapses the table when nothing is shared', () => {
    const plain = instance();
    delete (plain.features[0] as any).sharing;
    const content = new DznBuilder().build(plain, {}).dznContent;

    assert.equal(param(content, 'n_shared_feats'), '0');
    assert.equal(param(content, 'qos_share_slot'), '[0]');
    assert.equal(param(content, 'n_share_levels'), '1');
  });

  it('leaves a bound on a shared feature for the model to decide', () => {
    // Whether "both" breaks a bound of 6 depends on how many tasks share it,
    // which the builder cannot know, so it must not rule the candidate out.
    const content = dzn({
      constraints: [{
        id: 'cheap', kind: 'ATTRIBUTE_BOUND', scope: 'LOCAL',
        candidates: ['both'], attribute_id: 'cost', op: '<=', value: 6, hard: true,
      }],
    });

    assert.equal(param(content, 'n_excluded_candidates'), '0');
    assert.equal(param(content, 'n_cand_bounds'), '2', 'one per task the candidate serves');
    assert.equal(param(content, 'cb_task'), '[1, 2]');
    assert.equal(param(content, 'cb_cand'), '[1, 1]');
    assert.equal(param(content, 'cb_val'), '[6]'.replace('[6]', '[6, 6]'));
  });

  it('still rules out a candidate whose value cannot change', () => {
    const plain = instance({
      constraints: [{
        id: 'cheap', kind: 'ATTRIBUTE_BOUND', scope: 'LOCAL',
        candidates: ['both'], attribute_id: 'cost', op: '<=', value: 6, hard: true,
      }],
    });
    delete (plain.features[0] as any).sharing;
    const content = new DznBuilder().build(plain, {}).dznContent;

    assert.equal(param(content, 'n_cand_bounds'), '0');
    assert.equal(param(content, 'n_excluded_candidates'), '2', 'once per task it serves');
    assert.equal(param(content, 'excluded_task'), '[1, 2]');
    assert.equal(param(content, 'excluded_cand'), '[1, 1]');
  });

  it('encodes the candidate dependencies with their own codes', () => {
    const same = dzn({
      constraints: [{
        id: 'together', kind: 'DEPENDENCY', type: 'SAME_CANDIDATE',
        tasks: ['T1', 'T2'], hard: true,
      }],
    });
    const different = dzn({
      constraints: [{
        id: 'apart', kind: 'DEPENDENCY', type: 'DIFFERENT_CANDIDATE',
        tasks: ['T1', 'T2'], hard: true,
      }],
    });

    assert.equal(param(same, 'dc_type'), '[5]');
    assert.equal(param(same, 'dc_t1'), '[1]');
    assert.equal(param(same, 'dc_t2'), '[2]');
    assert.equal(param(different, 'dc_type'), '[6]');
  });
});
