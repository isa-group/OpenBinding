import type { JobDetail, JobInstanceView, JobReport } from '../../api/jobs';
import type { Job } from '../../api/platform';

/** Shared by the tests of the job screens and by the browser spec that mocks the same API. */

export const digestOf = (char: string): string => `sha256-${char.repeat(64)}`;

export const ENGINE = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: digestOf('a') };
export const REGISTRATION = { namespace: 'bim.builtin', name: 'random-search-deployment', version: '1.0.0+builtin.a', digest: digestOf('b') };

export function jobOf(id: string, engine: string, status: string, termination: Job['termination'], createdAt: string, finishedAt: string | null, over: Partial<Job> = {}): Job {
  return {
    id, engine_id: engine, status, cancellation_requested: false, retry_of_id: null, organization_id: 'org-isa-demo', project_id: 'project-qos-benchmarks',
    created_at: createdAt, finished_at: finishedAt, termination, options: null, ...over,
  };
}

/** The provenance of a run that asked for 600 s on a plan that allows 60 s. */
export function provenanceOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: ENGINE,
    registration: REGISTRATION,
    mode: 'sampling',
    algorithm: 'random-search',
    irDigest: digestOf('c'),
    instanceDigest: digestOf('d'),
    packageDigest: digestOf('e'),
    evaluator: 'bim-reference-evaluator/v1',
    requestedOptions: { time_budget_ms: 600000, iterations: 100000 },
    options: { time_budget_ms: 60000, iterations: 100000 },
    warnings: [{
      code: 'OPTION_CLAMPED',
      message: "'time_budget_ms' was reduced from 600000 to 60000 milliseconds, which is what this plan allows.",
      details: { option: 'time_budget_ms', requested: 600000, applied: 60000, unit: 'milliseconds' },
    }],
    limits: { effectiveTimeoutSeconds: 60 },
    ...over,
  };
}

const at = (id: string) => ({ resource: 'catalog', id });

/** The canonical solutions of a run: `features`, and `objectives.{type, scalarization, components, penalty, score}`. */
export const S1 = {
  decision: { kind: 'binding', binding: { t1: at('c1'), t2: at('c3'), t3: at('c4') } },
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
  decision: { kind: 'binding', binding: { t1: at('c2'), t2: at('c3'), t3: at('c4') } },
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

/** Kept for the browser specs that import it: the first solution. */
export const SOLUTION = S1;

export const RESULT = { termination: 'FEASIBLE', logs: 'solve started\nsolve finished\n', solutions: [S1, S2] };

const candidate = (name: string, provider: string, latency: number, cost: number) => ({ name, provider: { resource: 'catalog', id: provider }, features: { latency, cost } });

/** The compiled document `jobsApi.ir` returns: a BindingProblem that `readBindingProblem` reads. */
export const CONSTRAINTS = [
  { ref: { resource: 'rules', id: 'max-latency' }, enforcement: 'hard', assert: { kind: 'compare', op: 'lte', left: { kind: 'path', segments: ['features', 'latency'] }, right: { kind: 'literal', value: 600 } } },
  { ref: { resource: 'rules', id: 'prefer-eu' }, enforcement: 'soft', assert: { kind: 'compare', op: 'eq', left: { kind: 'path', segments: ['features', 'region'] }, right: { kind: 'literal', value: 'eu' } } },
];

export const PROBLEM = {
  apiVersion: 'bim/v1',
  kind: 'BindingProblem',
  spec: {
    application: {
      tasks: {
        t1: { name: 'Payment', requires: { type: 'payment' } },
        t2: { name: 'Shipping', requires: { type: 'shipping' } },
        t3: { name: 'Notify', requires: { type: 'notify' } },
      },
      features: { latency: { unit: 'ms', direction: 'minimize' }, cost: { unit: 'EUR', direction: 'minimize' } },
    },
    candidates: {
      catalog: {
        providers: { stripe: { name: 'Stripe' }, adyen: { name: 'Adyen' }, dhl: { name: 'DHL' }, twilio: { name: 'Twilio' } },
        candidates: {
          c1: candidate('Stripe EU', 'stripe', 120, 4),
          c2: candidate('Adyen', 'adyen', 90, 5),
          c3: candidate('DHL', 'dhl', 200, 3),
          c4: candidate('Twilio', 'twilio', 100, 2.5),
        },
      },
    },
    eligibility: { t1: [at('c1'), at('c2')], t2: [at('c3')], t3: [at('c4')] },
    constraints: CONSTRAINTS,
    optimization: {
      criteria: [
        { id: 'cost', feature: { id: 'cost' }, direction: 'minimize' },
        { id: 'latency', feature: { id: 'latency' }, direction: 'minimize' },
      ],
    },
  },
};

export function detailOf(id: string, status: string, over: Partial<JobDetail> = {}): JobDetail {
  const finished = status === 'completed' || status === 'failed';
  return {
    id,
    status,
    provenance: provenanceOf(),
    result: status === 'completed' ? RESULT : finished ? { error: 'The deployment didn’t answer within the budget (engine unreachable).' } : null,
    ...over,
  };
}

export const INSTANCE: JobInstanceView = {
  id: 'snapshot-2',
  instanceDigest: digestOf('d'),
  packageDigest: digestOf('e'),
  fileDigests: { 'instance.json': digestOf('f') },
  resourceDigests: {},
  instance: { apiVersion: 'bim/v1', kind: 'Instance' },
};

export const REPORT: JobReport = {
  id: 'job-1',
  gatewayEvaluation: { termination: 'FEASIBLE', solutions: [] },
  remote: { engine: 'demo-solver', divergence: { agrees: true, notes: ['Solved with presolve'] } },
  provenance: {},
};

export const NEIGHBORHOOD = {
  jobId: 'job-3',
  solutionIndex: 0,
  kind: 'canonical-one-task-counterfactuals',
  irDigest: digestOf('c'),
  scope: 'all-service-tasks',
  task: null,
  base: {},
  moves: [{
    task: 'pay-card', from: { resource: 'catalog', id: 'payco-eu' }, to: { resource: 'catalog', id: 'fastpay' }, feasible: true, comparison: 'better',
    componentDeltas: [{ feature: 'cost', value: 0.013, loss: 0 }, { feature: 'latency', value: -85, loss: 0 }],
  }],
  failures: [],
  coverage: { total: 3, attempted: 3, evaluated: 1, complete: true, limit: 128, stopReason: null, perTask: { 'pay-card': 3 } },
  conclusion: 'Found 1 feasible canonical improvements or feasibility repairs. Every eligible one-task move in this scope was evaluated.',
  semantics: 'Re-evaluated with the current canonical evaluator.',
};
