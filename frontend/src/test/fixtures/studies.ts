import type { Analytics, Study, StudyCell, StudyRun } from '../../api/platform';
import type { Problem, ProblemRevision } from '../../api/problems';
import type { ParetoFront } from '../../modules/core/api/types';

// Shared by the tests of the study screens and the S7a browser spec: the "Engines × seeds" study of the design prototype,
// 2 case revisions × 2 engines × 1 setting × 2 seeds = 8 cells, six completed, one failed, one cancelled.

export const digestOf = (char: string): string => `sha256-${char.repeat(64)}`;

export const RANDOM_SEARCH = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: digestOf('b'), mode: 'sampling' };
export const EVOLUTIONARY = { namespace: 'bim.builtin', name: 'evolutionary', version: '1.0.0', digest: digestOf('c'), mode: 'genetic' };

export const CHECKOUT: Problem = {
  id: 'case-checkout-flow', organization_id: 'org-isa-demo', slug: 'checkout-flow', name: 'Checkout flow', description: 'Payments with authentication, stock and shipping in parallel.',
  created_by_id: 'user-admin', created_at: '2026-04-02T00:00:00Z', updated_at: '2026-04-02T00:00:00Z',
};

export function revisionFixture(n: number, over: Partial<ProblemRevision> = {}): ProblemRevision {
  return {
    id: `rev-checkout-${n}`, problem_id: CHECKOUT.id, revision: n, package_digest: digestOf(String(n)), package_size: 4096, created_by_id: 'user-admin',
    created_at: n === 1 ? '2026-08-01T10:00:00Z' : '2026-08-20T10:05:00Z', ...over,
  };
}

export const REVISION_1 = revisionFixture(1);
export const REVISION_2 = revisionFixture(2);

export const STUDY_ID = 'study-engines-vs-seeds';
export const COMPILATION_1 = 'compilation-checkout-1';
export const COMPILATION_2 = 'compilation-checkout-2';

export function studyFixture(over: Partial<Study> = {}): Study {
  return {
    archived: false,
    id: STUDY_ID,
    organization_id: 'org-isa-demo',
    slug: 'engines-vs-seeds',
    name: 'Engines × seeds',
    description: '',
    definition: {
      revision_ids: [REVISION_1.id, REVISION_2.id],
      engines: [RANDOM_SEARCH, EVOLUTIONARY],
      parameter_sets: [{}],
      seeds: [1, 2],
    },
    definition_digest: digestOf('e'),
    state: 'ready',
    created_by_id: 'user-admin',
    created_at: '2026-09-20T08:00:00Z',
    ...over,
  };
}

export const RUN_ID = '00000000-0000-4000-8000-000000000101';

/** What the run froze: the study's definition, with the compilation each problem version runs. */
export function frozenFixture(): StudyRun['definition'] {
  return {
    apiVersion: 'openbinding/study-run/v1',
    problems: [REVISION_1, REVISION_2].map((revision, position) => ({
      revisionId: revision.id, problemId: CHECKOUT.id, revision: revision.revision, packageDigest: revision.package_digest,
      compilationId: position === 0 ? COMPILATION_1 : COMPILATION_2, compilationDigest: digestOf(position === 0 ? '7' : '8'), irDigest: digestOf(position === 0 ? '5' : '6'),
    })),
    engines: [RANDOM_SEARCH, EVOLUTIONARY],
    parameterSets: [{}],
    seeds: [1, 2],
  };
}

export function runFixture(over: Partial<StudyRun> = {}): StudyRun {
  return {
    id: RUN_ID, study_id: STUDY_ID, run_number: 1, state: 'partial', matrix_digest: digestOf('d'), cells: 8, summary: {},
    definition: frozenFixture(), definition_digest: digestOf('9'),
    created_at: '2026-09-20T09:00:00Z', finished_at: '2026-09-20T09:20:00Z', ...over,
  };
}

interface Result {
  cost: number;
  latency: number;
  took: number;
}

function completed(engine: typeof RANDOM_SEARCH, seed: number, result: Result): Record<string, unknown> {
  return {
    status: 'completed', feasible: true, termination: 'FEASIBLE', objectives: { cost: result.cost, latency: result.latency }, runtimeSeconds: result.took,
    engine: `${engine.namespace}/${engine.name}@${engine.version}`, seed,
  };
}

export function cellFixture(ordinal: number, revision: ProblemRevision, engine: typeof RANDOM_SEARCH, seed: number, state: StudyCell['state'], metrics: Record<string, unknown> = {}, over: Partial<StudyCell> = {}): StudyCell {
  return {
    id: `00000000-0000-4000-8000-0000000002${String(ordinal).padStart(2, '0')}`,
    study_run_id: RUN_ID,
    ordinal,
    binding_case_revision_id: revision.id,
    compilation_id: revision.id === REVISION_1.id ? COMPILATION_1 : COMPILATION_2,
    engine_ref: engine,
    parameters: {},
    seed,
    fingerprint: `sha256-${String(ordinal).repeat(64)}`.slice(0, 71),
    job_id: state === 'completed' || state === 'failed' ? `00000000-0000-4000-8000-0000000003${String(ordinal).padStart(2, '0')}` : null,
    state,
    metrics,
    ...over,
  };
}

/** The cells in the order the gateway expands the matrix: case revision, then engine (evolutionary sorts first), then seed. */
export function cellsFixture(): StudyCell[] {
  return [
    cellFixture(0, REVISION_1, EVOLUTIONARY, 1, 'completed', completed(EVOLUTIONARY, 1, { cost: 0.112, latency: 440, took: 120 })),
    cellFixture(1, REVISION_1, EVOLUTIONARY, 2, 'failed', { status: 'failed', feasible: false, code: 'engine_unreachable', detail: 'timeout', engine: 'bim.builtin/evolutionary@1.0.0', seed: 2 }),
    cellFixture(2, REVISION_1, RANDOM_SEARCH, 1, 'completed', completed(RANDOM_SEARCH, 1, { cost: 0.121, latency: 430, took: 58 })),
    cellFixture(3, REVISION_1, RANDOM_SEARCH, 2, 'completed', completed(RANDOM_SEARCH, 2, { cost: 0.118, latency: 412, took: 59 })),
    cellFixture(4, REVISION_2, EVOLUTIONARY, 1, 'completed', completed(EVOLUTIONARY, 1, { cost: 0.104, latency: 420, took: 118 })),
    cellFixture(5, REVISION_2, EVOLUTIONARY, 2, 'cancelled'),
    cellFixture(6, REVISION_2, RANDOM_SEARCH, 1, 'completed', completed(RANDOM_SEARCH, 1, { cost: 0.109, latency: 398, took: 60 })),
    cellFixture(7, REVISION_2, RANDOM_SEARCH, 2, 'completed', completed(RANDOM_SEARCH, 2, { cost: 0.111, latency: 405, took: 60 })),
  ];
}

/** A point of a front: the cell `ordinal` of `cellsFixture()`, its run's first solution and its objectives. */
function frontPoint(ordinal: number, engine: typeof RANDOM_SEARCH, cost: number, latency: number): ParetoFront['points'][number] {
  const cell = String(ordinal).padStart(2, '0');
  return {
    cell_id: `00000000-0000-4000-8000-0000000002${cell}`, job_id: `00000000-0000-4000-8000-0000000003${cell}`, solution_index: 0,
    engine: `${engine.namespace}/${engine.name}@${engine.version}`, objectives: { cost, latency },
  };
}

/**
 * The gateway's front of each problem version of `cellsFixture()`: cells 0 and 3 of version 1 (cell 2 is dominated by 3), cells 4
 * and 6 of version 2 (cell 7 is dominated by 6), points in the gateway's order (by cost, then latency).
 */
export function frontsFixture(): ParetoFront[] {
  return [
    { revision_id: REVISION_1.id, problem: { slug: CHECKOUT.slug }, revision: 1, objectives: ['cost', 'latency'], points: [frontPoint(0, EVOLUTIONARY, 0.112, 440), frontPoint(3, RANDOM_SEARCH, 0.118, 412)] },
    { revision_id: REVISION_2.id, problem: { slug: CHECKOUT.slug }, revision: 2, objectives: ['cost', 'latency'], points: [frontPoint(4, EVOLUTIONARY, 0.104, 420), frontPoint(6, RANDOM_SEARCH, 0.109, 398)] },
  ];
}

export function analyticsFixture(over: Partial<Analytics> = {}): Analytics {
  return {
    cells: 8,
    completed: 7,
    failed: 1,
    feasible: 6,
    infeasible: 0,
    objective_distributions: { cost: [0.104, 0.109, 0.111, 0.112, 0.118, 0.121], latency: [398, 405, 412, 420, 430, 440] },
    runtimes_s: [58, 59, 60, 60, 118, 120],
    pareto: frontsFixture(),
    stability: {
      'bim.builtin/random-search@1.0.0': { samples: 4, distinct: 4, repeatability: 0.25 },
      'bim.builtin/evolutionary@1.0.0': { samples: 2, distinct: 2, repeatability: 0.5 },
    },
    binding_space: {
      cardinality: '125892', log10: 5.1, tasks: 6, breakdown: { authenticate: 4, inventory: 5, shipping: 3, 'pay-card': 8, 'pay-transfer': 4, notify: 1 },
      case_slug: 'checkout-flow', case_name: 'Checkout flow', revision: 2,
      cases: [
        { id: 'case-checkout-flow', slug: 'checkout-flow', name: 'Checkout flow', revision: 1, cardinality: '15849', log10: 4.2, tasks: 6, breakdown: { authenticate: 4 } },
        { id: 'case-checkout-flow', slug: 'checkout-flow', name: 'Checkout flow', revision: 2, cardinality: '125892', log10: 5.1, tasks: 6, breakdown: { authenticate: 4 } },
      ],
    },
    ...over,
  };
}
