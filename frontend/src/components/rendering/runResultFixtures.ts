// Test-only fixtures of m23-run-result (design.md §5).
import type { RunProblem } from './runResultModel';

const problem = {
  features: {
    latency: { unit: 'ms', direction: 'minimize' as const },
    cost: { unit: 'EUR', direction: 'minimize' as const },
  },
  criteria: [
    { id: 'cost', feature: 'cost', direction: 'minimize' as const, range: null },
    { id: 'latency', feature: 'latency', direction: 'minimize' as const, range: null },
  ],
  tasks: [
    {
      id: 't1',
      name: 'Payment',
      candidates: [
        { id: 'c1', name: 'Stripe EU', provider: 'Stripe', features: { latency: 120, cost: 4 } },
        { id: 'c2', name: 'Adyen', provider: 'Adyen', features: { latency: 90, cost: 5 } },
      ],
    },
    { id: 't2', name: 'Shipping', candidates: [{ id: 'c3', name: 'DHL', provider: 'DHL', features: { latency: 200, cost: 3 } }] },
    { id: 't3', name: 'Notify', candidates: [{ id: 'c4', name: 'Twilio', provider: 'Twilio', features: { latency: 100, cost: 2.5 } }] },
  ],
};

export const PROBLEM: RunProblem = problem;

export const CONSTRAINTS: unknown[] = [
  {
    ref: { resource: 'rules', id: 'max-latency' },
    enforcement: 'hard',
    assert: {
      kind: 'compare',
      op: 'lte',
      left: { kind: 'path', segments: ['features', 'latency'] },
      right: { kind: 'literal', value: 600 },
    },
  },
  {
    ref: { resource: 'rules', id: 'prefer-eu' },
    enforcement: 'soft',
    assert: {
      kind: 'compare',
      op: 'eq',
      left: { kind: 'path', segments: ['features', 'region'] },
      right: { kind: 'literal', value: 'eu' },
    },
  },
];

const ref = (id: string) => ({ resource: 'catalog', id });

export const S1 = {
  decision: { kind: 'binding', binding: { t1: ref('c1'), t2: ref('c3'), t3: ref('c4') } },
  features: { latency: 420, cost: 9.5 },
  objectives: {
    type: 'MULTI',
    scalarization: 'pareto',
    components: [
      { criteria: 'cost', feature: 'cost', value: 9.5, loss: 0.3, weight: 1 },
      { criteria: 'latency', feature: 'latency', value: 420, loss: 0.4, weight: 1 },
    ],
    penalty: 2,
    score: [0.3, 0.4],
  },
  violations: [{ constraint: { resource: 'rules', id: 'prefer-eu' }, enforcement: 'soft', penalty: 2, message: 'Prefer EU providers' }],
};

export const S2 = {
  decision: { kind: 'binding', binding: { t1: ref('c2'), t2: ref('c3'), t3: ref('c4') } },
  features: { latency: 560, cost: 7 },
  objectives: {
    type: 'MULTI',
    scalarization: 'pareto',
    components: [
      { criteria: 'cost', feature: 'cost', value: 7, loss: 0.2, weight: 1 },
      { criteria: 'latency', feature: 'latency', value: 560, loss: 0.55, weight: 1 },
    ],
    penalty: 0,
    score: [0.2, 0.55],
  },
  violations: [],
};

export const RESULT = {
  termination: 'FEASIBLE',
  logs: 'solve started\nsolve finished\n',
  solutions: [S1, S2],
};

export const REPORT = {
  id: 'job-1',
  gatewayEvaluation: { termination: 'FEASIBLE', solutions: [] },
  remote: { engine: 'demo-solver', divergence: { agrees: true, notes: ['Solved with presolve'] } },
  provenance: {},
};
