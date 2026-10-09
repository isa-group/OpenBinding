import type { ArchiveResponse, ArchiveRow, ArchiveSource, CandidateDetail, Dimension } from '../../analysis/archive';

/** Two stored bindings of one checkout case, ranked under cost and latency: the data every analysis test and capture reads. */
export const MODEL = `sha256-${'c3d4'.repeat(16)}`;
export const EVALUATOR = `sha256-${'1a2b'.repeat(16)}`;
export const ID_PAYCO = `sha256-${'a1'.repeat(32)}`;
export const ID_FASTPAY = `sha256-${'b2'.repeat(32)}`;
export const JOB_DONE = 'f1a1b2c3-0000-4000-8000-000000000001';
export const JOB_SECOND = 'f2a1b2c3-0000-4000-8000-000000000002';
export const JOB_OLD = 'f7a1b2c3-0000-4000-8000-000000000007';
export const JOB_RUNNING = 'f3a1b2c3-0000-4000-8000-000000000003';

export function sourceOf(id: string, engine: string, over: Partial<ArchiveSource> = {}): ArchiveSource {
  return {
    id, engine, state: 'completed', projectId: 'project-qos-benchmarks', createdAt: '2026-09-30T09:00:00Z', irDigest: MODEL, evaluatorDigest: EVALUATOR,
    resultDigest: `sha256-${'e5f6'.repeat(16)}`, resultDigestKind: 'stored-json', legacy: false, compatible: null, diagnostic: false, ...over,
  };
}

export const SOURCES: ArchiveSource[] = [
  sourceOf(JOB_DONE, 'random-search'),
  sourceOf(JOB_SECOND, 'evolutionary', { createdAt: '2026-10-01T09:00:00Z' }),
  sourceOf(JOB_OLD, 'random-search', { legacy: true, irDigest: null, evaluatorDigest: null, createdAt: '2026-08-01T09:00:00Z' }),
  sourceOf(JOB_RUNNING, 'minizinc', { state: 'running', createdAt: '2026-10-08T08:00:00Z' }),
];

const dimensions: Dimension[] = [
  { key: 'cost', label: 'Cost', direction: 'minimize', kind: 'objective', unit: 'EUR/request', minimum: 0.1, maximum: 0.14, rawMinimum: 0.1, rawMaximum: 0.14, constant: false },
  { key: 'latency', label: 'Latency', direction: 'minimize', kind: 'objective', unit: 'ms', minimum: 300, maximum: 450, rawMinimum: 300, rawMaximum: 450, constant: false },
];

const payco: ArchiveRow = {
  id: ID_PAYCO, feasible: true, eligible: true, reasons: [], losses: [0.22, 0.35], values: [0.118, 412], normalized: [0.22, 0.35], score: [0.285],
  modelScore: 0.5, rank: 1, scoreGroup: 1, paretoRank: null, occurrences: 1,
};
const fastpay: ArchiveRow = {
  id: ID_FASTPAY, feasible: true, eligible: true, reasons: [], losses: [0.41, 0.12], values: [0.131, 327], normalized: [0.41, 0.12], score: [0.265],
  modelScore: 0.4, rank: 2, scoreGroup: 2, paretoRank: null, occurrences: 1,
};

/** What the gateway answers to `POST /v1/analysis/query` for the two bindings; `over` swaps any part. */
export function archiveOf(over: Partial<ArchiveResponse> = {}): ArchiveResponse {
  return {
    version: 'binding-archive/v1', revision: `sha256-${'9f'.repeat(32)}`, sources: [SOURCES[0]], dimensions, counts: { unique: 2, stored: 2, eligible: 2, infeasible: 0, unknown: 0 },
    rule: 'balanced', formula: 'Smallest worst weighted loss; ties are broken by the total weighted loss.', modelOrderingAvailable: true, weights: { cost: 0.5, latency: 0.5 }, warnings: ['Unexplored space remains unknown.'],
    winners: [payco], winnerCount: 1, next: [fastpay], nextCount: 1, rows: [payco, fastpay], total: 2, page: 0, pageSize: 25,
    pareto: { state: 'uncomputed', scope: 'archive', count: 2, frontCount: null, meaning: 'Pareto not computed.', hypervolume: null },
    plot: { axes: [0, 1], points: [], bins: [], count: 2, bounds: [0.1, 300, 0.14, 450], aggregated: false },
    geometry: null, budgets: null, trajectory: [],
    ...over,
  };
}

/** The inspector's answer for the binding in focus. */
export function detailOf(row: ArchiveRow = payco, over: Partial<CandidateDetail> = {}): CandidateDetail {
  return {
    revision: archiveOf().revision, row, binding: { 'pago-tarjeta': { resource: 'candidate', id: row.id === ID_PAYCO ? 'payco-eu' : 'fastpay' }, autenticar: { resource: 'candidate', id: 'auth0' } },
    violations: [], metrics: {}, evaluation: { feasible: true, metrics: { cost: row.values?.[0] } },
    occurrences: [{ jobId: JOB_DONE, solutionIndex: 0 }],
    explanation: {
      formula: 'score = max(weighted losses)', rule: 'balanced', score: row.score, summary: 'It has the smallest worst weighted loss among the 2 eligible bindings.', eligibility: [],
      nextScore: [0.3], nearTieTolerance: 1e-9, nearTie: false, normalizationScope: 'These results only',
      components: [
        { key: 'cost', value: row.values?.[0] ?? null, loss: 0.01, normalized: row.normalized?.[0] ?? null, weight: 0.5, weightedLoss: 0.11, minimum: 0.1, maximum: 0.14, direction: 'minimize' },
        { key: 'latency', value: row.values?.[1] ?? null, loss: 112, normalized: row.normalized?.[1] ?? null, weight: 0.5, weightedLoss: 0.175, minimum: 300, maximum: 450, direction: 'minimize' },
      ],
    },
    comparison: [], dominance: { scope: 'archive', computed: true, eligibleForFront: true, dominatorCount: 0, dominators: [] },
    neighbors: [{ id: ID_FASTPAY, distance: 0.31, metric: 'euclidean' }],
    ...over,
  };
}

export const ROWS = { payco, fastpay };
