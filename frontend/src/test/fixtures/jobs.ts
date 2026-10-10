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

export const SOLUTION = {
  decision: {
    kind: 'binding',
    binding: {
      authenticate: { resource: 'catalog', id: 'authz-eu' },
      'pay-card': { resource: 'catalog', id: 'payco-eu' },
      'pay-transfer': { resource: 'catalog', id: 'bankx' },
    },
  },
  metrics: { cost: 0.118, latency: 412 },
  objectives: { mode: 'weighted', components: [], penalty: 0, score: 0.2536 },
  penalties: [],
  violations: [],
};

export function detailOf(id: string, status: string, over: Partial<JobDetail> = {}): JobDetail {
  const finished = status === 'completed' || status === 'failed';
  return {
    id,
    status,
    provenance: provenanceOf(),
    result: status === 'completed' ? { termination: 'FEASIBLE', solutions: [SOLUTION] } : finished ? { error: 'The deployment didn’t answer within the budget (engine unreachable).' } : null,
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
  id: 'job-3',
  gatewayEvaluation: { termination: 'FEASIBLE', solutions: [SOLUTION] },
  remote: { termination: 'FEASIBLE', solutions: [{ cost: 0.118 }], divergence: { agrees: true, notes: [] } },
  provenance: provenanceOf(),
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
