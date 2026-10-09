import type { Analytics, BindingCase, CaseRevision, Study, StudyCell, StudyRun } from '../../api/platform';

// Shared by the tests of the study screens and the S7a browser spec: the "Engines × seeds" study of the design prototype,
// 2 case revisions × 2 engines × 1 setting × 2 seeds = 8 cells, six completed, one failed, one cancelled.

export const digestOf = (char: string): string => `sha256-${char.repeat(64)}`;

export const RANDOM_SEARCH = { namespace: 'bim.builtin', name: 'random-search', version: '1.0.0', digest: digestOf('b'), mode: 'sampling' };
export const EVOLUTIONARY = { namespace: 'bim.builtin', name: 'evolutionary', version: '1.0.0', digest: digestOf('c'), mode: 'genetic' };

export const FLUJO: BindingCase = {
  id: 'case-flujo-checkout', project_id: 'project-qos-benchmarks', slug: 'flujo-checkout', name: 'Flujo de checkout', description: 'Pagos con autenticación, stock y envío en paralelo.',
  created_by_id: 'user-lucia', created_at: '2026-04-02T00:00:00Z',
};

export function revisionFixture(n: number, over: Partial<CaseRevision> = {}): CaseRevision {
  return {
    id: `rev-checkout-${n}`, binding_case_id: FLUJO.id, revision: n, digest: digestOf(String(n)), document: {}, source_snapshot_id: `snapshot-${n}`,
    created_at: n === 1 ? '2026-08-01T10:00:00Z' : '2026-08-20T10:05:00Z', ...over,
  };
}

export const REVISION_1 = revisionFixture(1);
export const REVISION_2 = revisionFixture(2);

export const STUDY_ID = 'study-engines-vs-seeds';
export const VERSION_ID = 'version-engines-vs-seeds-1';

export function studyFixture(over: Partial<Study> = {}): Study {
  return {
    archived: false,
    id: STUDY_ID,
    definition_version_id: VERSION_ID,
    definition_artifact_id: 'artifact-engines-vs-seeds',
    project_id: 'project-qos-benchmarks',
    slug: 'engines-vs-seeds',
    name: 'Engines × semillas',
    description: '',
    definition: {
      case_revision_ids: [REVISION_1.id, REVISION_2.id],
      engines: [RANDOM_SEARCH, EVOLUTIONARY],
      parameter_sets: [{}],
      seeds: [1, 2],
    },
    state: 'ready',
    created_by_id: 'user-lucia',
    created_at: '2026-09-20T08:00:00Z',
    ...over,
  };
}

export const RUN_ID = '00000000-0000-4000-8000-000000000101';

export function runFixture(over: Partial<StudyRun> = {}): StudyRun {
  return {
    id: RUN_ID, definition_version_id: VERSION_ID, study_id: STUDY_ID, run_number: 1, state: 'partial', matrix_digest: digestOf('d'), cells: 8, summary: {},
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

export function cellFixture(ordinal: number, revision: CaseRevision, engine: typeof RANDOM_SEARCH, seed: number, state: StudyCell['state'], metrics: Record<string, unknown> = {}, over: Partial<StudyCell> = {}): StudyCell {
  return {
    id: `00000000-0000-4000-8000-0000000002${String(ordinal).padStart(2, '0')}`,
    study_run_id: RUN_ID,
    ordinal,
    binding_case_revision_id: revision.id,
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

export function analyticsFixture(over: Partial<Analytics> = {}): Analytics {
  return {
    cells: 8,
    completed: 7,
    failed: 1,
    feasible: 6,
    infeasible: 0,
    objective_distributions: { cost: [0.104, 0.109, 0.111, 0.112, 0.118, 0.121], latency: [398, 405, 412, 420, 430, 440] },
    runtimes_s: [58, 59, 60, 60, 118, 120],
    pareto: [],
    stability: {
      'bim.builtin/random-search@1.0.0': { samples: 4, distinct: 4, repeatability: 0.25 },
      'bim.builtin/evolutionary@1.0.0': { samples: 2, distinct: 2, repeatability: 0.5 },
    },
    binding_space: {
      cardinality: '125892', log10: 5.1, tasks: 6, breakdown: { autenticar: 4, inventario: 5, 'calcular-envio': 3, 'pago-tarjeta': 8, 'pago-transferencia': 4, notificar: 1 },
      case_slug: 'flujo-checkout', case_name: 'Flujo de checkout', revision: 2,
      cases: [
        { id: 'case-flujo-checkout', slug: 'flujo-checkout', name: 'Flujo de checkout', revision: 1, cardinality: '15849', log10: 4.2, tasks: 6, breakdown: { autenticar: 4 } },
        { id: 'case-flujo-checkout', slug: 'flujo-checkout', name: 'Flujo de checkout', revision: 2, cardinality: '125892', log10: 5.1, tasks: 6, breakdown: { autenticar: 4 } },
      ],
    },
    ...over,
  };
}
