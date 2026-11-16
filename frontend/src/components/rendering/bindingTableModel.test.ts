import { describe, expect, it } from 'vitest';
import type { ProblemFacts } from '../../modules/core/api/types';
import { runProblemOf } from './runProblem';
import { bindingFeaturesOf, bindingRowsOf, type BindingProblemShape } from './bindingTableModel';

const PROBLEM: BindingProblemShape = {
  features: { latency: { unit: 'ms' }, cost: { unit: 'EUR' }, availability: { unit: null } },
  tasks: [
    {
      id: 'pay',
      name: 'Payment',
      candidates: [
        {
          id: 'stripe',
          name: 'Stripe Payments',
          provider: 'Stripe',
          features: { latency: 120, cost: 0.3, availability: 0.999 },
        },
        { id: 'adyen', name: 'Adyen', provider: 'Adyen', features: { latency: 90, cost: 0.25 } },
      ],
    },
    {
      id: 'ship',
      name: 'Shipping',
      candidates: [
        {
          id: 'dhl',
          name: 'DHL Express',
          provider: 'DHL',
          features: { latency: { min: 200, max: 400 }, availability: 0.99 },
        },
      ],
    },
  ],
};

const BINDING = {
  ship: { resource: 'carriers', id: 'dhl' },
  pay: { resource: 'payments', id: 'stripe' },
};

/** The facts of a compilation with one task: what `runProblemOf` reads. */
const FACTS = {
  binding_space: '1',
  candidates: [
    {
      key: 'payments/stripe',
      resource: 'payments',
      id: 'stripe',
      provider: 'stripe-inc',
      values: { latency: 120 },
      origins: {
        latency: {
          kind: 'package',
          resource: 'payments',
          path: 'payments.json',
          pointer: '/spec/candidates/stripe/features/latency',
        },
      },
    },
  ],
  constraints: [],
  features: [{ id: 'latency', unit: 'ms', direction: 'min', required: true }],
  ir_digest: 'sha256-c',
  objectives: { criteria: [], penalties: [] },
  tasks: [
    { id: 'pay', kind: 'service', eligible: [{ candidate: 'payments/stripe', written: 'stripe' }] },
  ],
  workflow: 'pay',
} as ProblemFacts;

const NULLS = { latency: null, cost: null, availability: null };

describe('bindingRowsOf', () => {
  it('derives rows with the compiled problem, in the problem task order', () => {
    expect(bindingRowsOf(BINDING, PROBLEM)).toEqual([
      {
        task: 'pay',
        taskName: 'Payment',
        candidate: 'stripe',
        candidateName: 'Stripe Payments',
        provider: 'Stripe',
        values: { latency: 120, cost: 0.3, availability: 0.999 },
      },
      {
        task: 'ship',
        taskName: 'Shipping',
        candidate: 'dhl',
        candidateName: 'DHL Express',
        provider: 'DHL',
        values: { latency: { min: 200, max: 400 }, cost: null, availability: 0.99 },
      },
    ]);
  });

  it('derives rows without the problem, in binding order', () => {
    expect(bindingRowsOf(BINDING, null)).toEqual([
      {
        task: 'ship',
        taskName: 'ship',
        candidate: 'dhl',
        candidateName: 'dhl',
        provider: null,
        values: {},
      },
      {
        task: 'pay',
        taskName: 'pay',
        candidate: 'stripe',
        candidateName: 'stripe',
        provider: null,
        values: {},
      },
    ]);
  });

  it('puts a task the problem does not know after the known ones', () => {
    const rows = bindingRowsOf(
      { audit: { resource: 'tools', id: 'logger' }, pay: { resource: 'payments', id: 'stripe' } },
      PROBLEM
    );
    expect(rows.map(row => row.task)).toEqual(['pay', 'audit']);
    expect(rows[1]).toEqual({
      task: 'audit',
      taskName: 'audit',
      candidate: 'logger',
      candidateName: 'logger',
      provider: null,
      values: NULLS,
    });
  });

  it('keeps the id only for a candidate that is not eligible for its task', () => {
    expect(bindingRowsOf({ pay: { resource: 'payments', id: 'paypal' } }, PROBLEM)).toEqual([
      {
        task: 'pay',
        taskName: 'Payment',
        candidate: 'paypal',
        candidateName: 'paypal',
        provider: null,
        values: NULLS,
      },
    ]);
  });

  it('gives no guessed rows for malformed bindings and never throws', () => {
    for (const bad of [null, [], 'pay']) expect(bindingRowsOf(bad, PROBLEM)).toEqual([]);
    const rows = bindingRowsOf(
      {
        pay: 'stripe',
        tax: { resource: 'fiscal' },
        fee: { resource: 'fees', id: '' },
        ship: { resource: 'carriers', id: 'dhl' },
      },
      PROBLEM
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].task).toBe('ship');
  });

  it('reads the problem that runProblemOf makes of the facts: the written name and the provider id', () => {
    const problem = runProblemOf(FACTS);
    expect(bindingRowsOf({ pay: { resource: 'payments', id: 'stripe' } }, problem)).toEqual([
      {
        task: 'pay',
        taskName: 'pay',
        candidate: 'stripe',
        candidateName: 'stripe',
        provider: 'stripe-inc',
        values: { latency: 120 },
      },
    ]);
    expect(bindingFeaturesOf(problem)).toEqual([{ name: 'latency', unit: 'ms' }]);
  });
});

describe('bindingFeaturesOf', () => {
  it('lists the features with their units in declaration order, or none without a problem', () => {
    expect(bindingFeaturesOf(PROBLEM)).toEqual([
      { name: 'latency', unit: 'ms' },
      { name: 'cost', unit: 'EUR' },
      { name: 'availability', unit: null },
    ]);
    expect(bindingFeaturesOf(null)).toEqual([]);
  });
});
